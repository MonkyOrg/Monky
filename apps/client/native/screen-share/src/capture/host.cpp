#include <Windows.h>
#include <Dbt.h>
#include <TlHelp32.h>
#include <bcrypt.h>
#include <d3d11.h>
#include <dxgi.h>
#include <objbase.h>
#include <wrl/client.h>

#include "abi.h"
#include "contract.h"
#include "platformContract.h"
#include "nvencProbe.h"
#include "amfProbe.h"
#include "softwareAv1.h"
#include "../rtc/inputs/abi/monky_av1.h"
#include <runtime-pins.h>
#include "liveNative.h"

#include <atomic>
#include <cstdio>
#include <cstring>
#include <memory>
#include <mutex>
#include <thread>

#include "win32.h"
#include "target.h"
#include "runtimeIntegrity.h"

namespace {
using namespace monky::screen_capture;
namespace win = monky::win;
using Microsoft::WRL::ComPtr;

struct DataRef {
  abi::Api& api;
  abi::Data* value;
  ~DataRef() { if (value) api.obs_data_release(value); }
  DataRef(const DataRef&) = delete;
  DataRef& operator=(const DataRef&) = delete;
  DataRef(abi::Api& functions, abi::Data* data) : api(functions), value(data) {
    Require(value != nullptr, "Stock settings allocation failed", "ERR_SCREEN_CAPTURE_SETTINGS");
  }
};

struct PropertiesRef {
  abi::Api& api;
  abi::Properties* value;
  ~PropertiesRef() { if (value) api.obs_properties_destroy(value); }
  PropertiesRef(const PropertiesRef&) = delete;
  PropertiesRef& operator=(const PropertiesRef&) = delete;
  PropertiesRef(abi::Api& functions, abi::Properties* properties) : api(functions), value(properties) {
    Require(value != nullptr, "Required stock properties are unavailable", "ERR_SCREEN_CAPTURE_SETTINGS");
  }
};

struct GraphicsScope {
  explicit GraphicsScope(abi::Api& functions) : api(functions) { api.obs_enter_graphics(); }
  ~GraphicsScope() { api.obs_leave_graphics(); }
  GraphicsScope(const GraphicsScope&) = delete;
  GraphicsScope& operator=(const GraphicsScope&) = delete;
  abi::Api& api;
};

using Failure = NativeFailure;
class Host;
Host* callbackHost = nullptr;

class Host {
 public:
  Host(Arguments arguments, Parent parent, std::unique_ptr<OwnedRun> run)
      : arguments_(std::move(arguments)), parent_(std::move(parent)), run_(std::move(run)),
        buffer_(arguments_.video, IsAv1(arguments_.encoder)), processStarted_(GetTickCount64()) {
    if (arguments_.encoder != EncoderKind::Auto) capability_.encoder = arguments_.encoder;
    common_ = {arguments_.runId, GetCurrentProcessId(), arguments_.processId, arguments_.hwnd,
        arguments_.expectedCreation, Qpc(), QpcFrequency()};
    input_ = GetStdHandle(STD_INPUT_HANDLE); outputPipe_ = GetStdHandle(STD_OUTPUT_HANDLE); errorPipe_ = GetStdHandle(STD_ERROR_HANDLE);
    Require(input_ && outputPipe_ && errorPipe_ && GetFileType(input_) == FILE_TYPE_PIPE &&
        GetFileType(outputPipe_) == FILE_TYPE_PIPE && GetFileType(errorPipe_) == FILE_TYPE_PIPE,
        "Host must be owned through three redirected pipes", "ERR_SCREEN_CAPTURE_PARENT");
    progress_.store(processStarted_);
    if (!arguments_.encoderProbe) {
      live_ = std::make_unique<live::Output>(arguments_.runId,
          [this](const char* code, const char* message) { Fail(code, message); });
      live_->Bitrate(arguments_.video.bitrateKbps);
    }
  }

  int Execute() noexcept {
    try {
      watchdog_ = std::thread([this] { Watchdog(); });
      if (!arguments_.encoderProbe) {
        target_ = BindTarget(arguments_);
        common_.processCreationTime100ns = target_.creation;
        targetBound_ = true;
        if (target_.kind == CaptureKind::Monitor) displayChanges_.Start();
      }
      Prepare();
      while (life_.phase != Phase::Stopping) {
        Tick();
        PollInput();
        if (life_.phase == Phase::Stopping) break;
        if (life_.phase == Phase::Starting) {
          if (!source_) { BeginStage(NativeStage::SourceStart); StartSource(); EndStage(); }
          ObserveSource();
          if (SourceReadyForEncoder(life_.phase, observation_) && !output_) {
            BeginStage(NativeStage::EncoderStart); StartEncoderOutput(); EndStage();
          }
          Snapshot();
          if (SourceReadyForEncoder(life_.phase, observation_) && observation_.outputPackets > 0) {
            target_.VerifyUnique();
            ObserveSource();
            if (life_.Ready(SourceReadyForEncoder(life_.phase, observation_), observation_.outputPackets > 0)) {
              observation_.state = ObservationState::Running;
              Sync();
              Emit("ready", life_.startSequence);
              BeginStage(NativeStage::Capture);
            }
          }
        } else if (life_.phase == Phase::Running) {
          ObserveSource();
          Require(api().obs_output_active(output_), "Encoded output stopped without STOP", "ERR_SCREEN_CAPTURE_OUTPUT_STOPPED");
        }
        PumpMessages();
        FlushLogs();
        Sleep(5);
      }
    } catch (const ContractError& error) { Fail(error.code, error.what()); }
    catch (const std::exception& error) { Fail("ERR_SCREEN_CAPTURE_NATIVE", error.what()); }
    catch (...) { Fail("ERR_SCREEN_CAPTURE_NATIVE", "Unknown native preparation/capture exception"); }

    life_.Fail(GetTickCount64());
    if (!failed_.load()) life_.failed = false;
    Sync();
    try { BeginStage(NativeStage::Retirement); Retire(); }
    catch (const ContractError& error) { Fail(error.code, error.what()); }
    catch (const std::exception& error) { Fail("ERR_SCREEN_CAPTURE_RETIREMENT", error.what()); }
    catch (...) { Fail("ERR_SCREEN_CAPTURE_RETIREMENT", "Unknown retirement exception"); }

    int result = 1;
    try {
      BeginStage(NativeStage::Terminal);
      try { CheckParent(); PollInput(); }
      catch (const ContractError& error) { Fail(error.code, error.what()); }
      Snapshot();
      if (failed_.load()) {
        life_.failed = true;
        observation_.state = ObservationState::Failed;
        const auto failure = FirstFailure();
        if (arguments_.encoderProbe)
          WriteEnvelope(SerializeEncoderProbeEvent(arguments_, AtNow(), capability_, "error", life_.lastSequence,
              sourcePlatformVerified_, encoderInitialized_, &retirement_, &failure));
        else if (!targetBound_) {
          Require(!obsStarted_ && !source_ && !scene_ && !encoder_ && !output_,
                  "Source admission failure retained initialized capture", "ERR_SCREEN_CAPTURE_RETIREMENT");
          WriteEnvelope(SerializeAdmissionFailure(arguments_, AtNow(), life_.lastSequence,
              observation_, retirement_, failure));
        }
        else WriteEnvelope(SerializePlatformEvent(arguments_, AtNow(), capability_, "error", life_.lastSequence,
            observation_, target_.key, hooked_, &retirement_, &failure));
      } else {
        Require(RetirementComplete(retirement_), "Retirement did not complete", "ERR_SCREEN_CAPTURE_RETIREMENT");
        life_.Stopped(); Sync();
        observation_.state = ObservationState::Stopped;
        Emit("stopped", life_.stopSequence);
        result = 0;
      }
      EndStage();
      if (result == 0) CheckFailure();
      FlushLogs();
    } catch (const std::exception& error) {
      result = 1;
      EmergencyDiagnostic(error.what());
    } catch (...) {
      result = 1;
      EmergencyDiagnostic("Unknown terminal serialization failure");
    }
    watchdogQuit_.store(true);
    if (watchdog_.joinable()) watchdog_.join();
    return result;
  }

  void Fail(std::string_view code, std::string_view message) noexcept {
    try {
      std::lock_guard lock(failureMutex_);
      if (!failure_) {
        const auto text = message.substr(0, 1024);
        failure_ = Failure{std::string(code.substr(0, 96)),
            ValidUtf8(text) ? std::string(text) : "Native diagnostic is not bounded UTF-8; inspect retained stderr",
            nativeStage_.load()};
      }
    } catch (...) { emergencyFailure_.store(true); }
    failed_.store(true);
  }

  static void __cdecl Log(int level, const char* format, va_list arguments, void* parameter) noexcept {
    auto& host = *static_cast<Host*>(parameter);
    try {
      std::array<char, 2048> text{};
      const int length = std::vsnprintf(text.data(), text.size(), format ? format : "Missing OBS log format", arguments);
      if (length < 0 || static_cast<std::size_t>(length) >= text.size()) {
        host.Fail("ERR_SCREEN_CAPTURE_STOCK_LOG_LIMIT", "Stock diagnostic exceeded bounded formatter");
        return;
      }
      const std::string_view message(text.data(), static_cast<std::size_t>(length));
      if (host.strictEncoderWarnings_.load() && message.find("[obs-nvenc]") != std::string_view::npos &&
          (message.find("falling back") != std::string_view::npos || message.find("non_texture encoder") != std::string_view::npos))
        host.Fail("ERR_SCREEN_CAPTURE_ENCODER_REROUTE", "NVENC texture fallback is forbidden");
      if (FatalStockLog(level, host.strictEncoderWarnings_.load()))
        host.Fail(StockFailureCode(host.phase_.load(), host.nativeStage_.load()), message);
      host.AppendLog(message);
    } catch (...) { host.Fail("ERR_SCREEN_CAPTURE_LOG_CALLBACK", "Exception contained inside stock logging callback"); }
  }

  static const char* __cdecl OutputName(void*) noexcept { return "Monky H264 screen output"; }
  static void* __cdecl OutputCreate(abi::Data*, abi::Output* output) noexcept {
    if (!callbackHost || callbackHost->callbackOutput_) return nullptr;
    callbackHost->callbackOutput_ = output;
    callbackHost->outputDestroyed_.store(false);
    return callbackHost;
  }
  static void __cdecl OutputDestroy(void* parameter) noexcept {
    auto& host = *static_cast<Host*>(parameter);
    host.callbackOutput_ = nullptr;
    host.outputDestroyed_.store(true);
  }
  static bool __cdecl OutputStart(void* parameter) noexcept {
    auto& host = *static_cast<Host*>(parameter);
    try {
      Require(!host.arguments_.encoderProbe, "Encoder probing cannot start data capture", "ERR_SCREEN_CAPTURE_PROBE_ISOLATION");
      host.InitializeEncoder();
      const bool started = host.api().obs_output_begin_data_capture(host.callbackOutput_, abi::kVideoEncoded);
      Require(started, "Encoded output begin failed", "ERR_SCREEN_CAPTURE_ENCODER_INITIALIZATION");
      return true;
    } catch (const ContractError& error) { host.Fail(error.code, error.what()); }
    catch (const std::exception& error) { host.Fail("ERR_SCREEN_CAPTURE_OUTPUT_CALLBACK", error.what()); }
    catch (...) { host.Fail("ERR_SCREEN_CAPTURE_OUTPUT_CALLBACK", "Unknown output initialization exception"); }
    return false;
  }
  static void __cdecl OutputStop(void* parameter, std::uint64_t) noexcept {
    auto& host = *static_cast<Host*>(parameter);
    try { host.api().obs_output_end_data_capture(host.callbackOutput_); }
    catch (...) { host.Fail("ERR_SCREEN_CAPTURE_OUTPUT_CALLBACK", "Exception contained in encoded output stop callback"); }
  }
  static void __cdecl EncodedPacket(void* parameter, abi::EncoderPacket* packet) noexcept {
    auto& host = *static_cast<Host*>(parameter);
    host.callbacks_.fetch_add(1);
    try {
      Require(!host.arguments_.encoderProbe && host.live_, "Encoder probing cannot emit video packets",
              "ERR_SCREEN_CAPTURE_PROBE_ISOLATION");
      Require(packet && packet->data && packet->size > 0 && packet->size <= kMaxPacketBytes &&
          packet->type == abi::EncoderType::Video && packet->encoder == host.encoder_ &&
          packet->timebase_num > 0 && packet->timebase_den > 0,
          "Invalid video-only encoded callback packet", "ERR_SCREEN_CAPTURE_ENCODER_PACKET");
      auto delivered = *packet;
      auto normalizedPacket = NormalizeAmfBt709({packet->data, packet->size}, host.arguments_.video,
          host.capability_.encoder, host.amfColorNormalizationAllowed_);
      if (!normalizedPacket.bytes.empty()) {
        delivered.data = normalizedPacket.bytes.data();
        delivered.size = normalizedPacket.bytes.size();
      }
      std::vector<std::uint8_t> independentKeyframe;
      std::vector<std::uint8_t> av1Sequence;
      AmfColorNormalization normalizedParameters;
      std::span<const std::uint8_t> parameterSets;
      if (packet->keyframe) {
        std::uint8_t* extra = nullptr;
        std::size_t size = 0;
        Require(host.api().obs_encoder_get_extra_data(host.encoder_, &extra, &size) &&
                extra && size > 0 && size <= kMaxPacketBytes,
                "Hardware encoder did not expose its current H264 parameter sets", "ERR_SCREEN_CAPTURE_H264");
        parameterSets = {extra, size};
        normalizedParameters = NormalizeAmfBt709(parameterSets, host.arguments_.video,
            host.capability_.encoder, host.amfColorNormalizationAllowed_);
        if (!normalizedParameters.bytes.empty()) parameterSets = normalizedParameters.bytes;
        // Preview may have consumed the first headers before a viewer joins.
        if (IsAv1(host.capability_.encoder)) {
          auto keyframe = CompleteAv1Keyframe({delivered.data, delivered.size}, parameterSets,
              [&](std::span<const std::uint8_t> sequence) {
            char error[512]{};
            const bool validated = host.libraries_.validateAv1 &&
                host.libraries_.validateAv1(sequence.data(), sequence.size(),
                    host.arguments_.video.width, host.arguments_.video.height, error, sizeof(error));
            Require(validated, (std::string(error[0] ? error : "AV1 sequence validation is unavailable") +
                "; encoder=" + EncoderId(host.capability_.encoder) +
                " bitrateKbps=" + std::to_string(host.live_->Bitrate()) +
                " ceilingKbps=" + std::to_string(host.arguments_.bitrateCeilingKbps)).c_str(), "ERR_SCREEN_CAPTURE_AV1");
          });
          av1Sequence = std::move(keyframe.sequenceHeader);
          parameterSets = av1Sequence;
          independentKeyframe = std::move(keyframe.bytes);
        } else {
          independentKeyframe = CompleteH264Keyframe({delivered.data, delivered.size}, parameterSets, host.arguments_.video);
        }
        delivered.data = independentKeyframe.data();
        delivered.size = independentKeyframe.size();
      }
      const auto qpc = Qpc();
      {
        std::lock_guard lock(host.bufferMutex_);
        // NVENC exposes SPS/PPS only after producing its first packet.
        if (host.buffer_.Count() == 0) host.buffer_.SetPrefix(parameterSets);
        host.buffer_.Add({{delivered.data, delivered.size}, delivered.pts, delivered.dts,
            static_cast<std::uint32_t>(delivered.timebase_num), static_cast<std::uint32_t>(delivered.timebase_den),
            delivered.keyframe, qpc});
      }
      if ((normalizedPacket.parameterSets || normalizedParameters.parameterSets) &&
          !host.amfColorNormalizationLogged_.exchange(true))
        host.AppendLog("{\"kind\":\"amf-color-normalization\",\"encoder\":\"h264_texture_amf\","
            "\"input\":\"NV12-BT709-limited\",\"originalPrimaries\":0,\"primaries\":1,"
            "\"transfer\":1,\"matrix\":1,\"fullRange\":false,\"maximumReportsPerHost\":1}");
      host.live_->Packet(delivered, qpc);
    } catch (const ContractError& error) { host.Fail(error.code, error.what()); }
    catch (const std::exception& error) { host.Fail("ERR_SCREEN_CAPTURE_ENCODER_PACKET", error.what()); }
    catch (...) { host.Fail("ERR_SCREEN_CAPTURE_ENCODER_PACKET", "Exception contained in encoded packet callback"); }
    host.callbacks_.fetch_sub(1);
  }

 private:
  abi::Api& api() { return libraries_.api; }
  const char* SelectedEncoder() const { return EncoderId(capability_.encoder); }
  Common AtNow() const { auto result = common_; result.qpc = Qpc(); return result; }
  Failure FirstFailure() {
    std::lock_guard lock(failureMutex_);
    if (failure_) return *failure_;
    return {"ERR_SCREEN_CAPTURE_FAILURE_RECORD", emergencyFailure_.load() ?
        "Could not allocate the native failure record" : "Native failure detail is unavailable", nativeStage_.load()};
  }
  void CheckFailure() {
    if (failed_.load()) { const auto value = FirstFailure(); throw ContractError(value.code, value.message); }
  }
  void Sync() {
    captureStarted_.store(life_.captureStartedMs); stopStarted_.store(life_.stopStartedMs);
    phase_.store(life_.phase); progress_.store(GetTickCount64());
  }
  void TraceStage(bool returned) noexcept {
    try {
      const auto now = GetTickCount64();
      std::optional<Failure> failure;
      if (failed_.load()) failure = FirstFailure();
      auto line = SerializeNativeDiagnostic(AtNow(), nativeStage_.load(), returned, life_.phase,
          now - processStarted_, failure ? &*failure : nullptr);
      line.pop_back();
      AppendLog(line);
      FlushLogs();
    } catch (const ContractError& error) { Fail(error.code, error.what()); }
    catch (const std::exception& error) { Fail("ERR_SCREEN_CAPTURE_DIAGNOSTIC", error.what()); }
    catch (...) { Fail("ERR_SCREEN_CAPTURE_DIAGNOSTIC", "Unknown native stage diagnostic failure"); }
  }
  void BeginStage(NativeStage stage) {
    nativeStage_.store(stage);
    progress_.store(GetTickCount64());
    TraceStage(false);
    if (life_.phase != Phase::Stopping) CheckFailure();
  }
  void EndStage() {
    TraceStage(true);
    if (life_.phase != Phase::Stopping && life_.phase != Phase::Stopped) CheckFailure();
  }
  void Watchdog() noexcept {
    while (!watchdogQuit_.load()) {
      const auto now = GetTickCount64();
      const auto phase = phase_.load();
      const auto start = phase == Phase::Preparing ? processStarted_ :
          phase == Phase::Stopping ? stopStarted_.load() : captureStarted_.load();
      const auto limit = phase == Phase::Preparing ? kPrepareTimeoutMs :
          phase == Phase::Starting && !startupPaused_.load() ? kFirstAuTimeoutMs :
          phase == Phase::Stopping ? kRetirementTimeoutMs : UINT64_MAX;
      const bool deadline = limit != UINT64_MAX && now >= start && now - start >= limit + kWatchdogGraceMs;
      const auto progress = progress_.load();
      const bool stalled = HeartbeatStalled(now, progress);
      if (deadline || stalled) {
        // Never block on a full diagnostic pipe and never target a game/parent
        // process. Exit124 is invalid, with or without an earlier STOP ACK.
        TerminateProcess(GetCurrentProcess(), 124);
        return;
      }
      Sleep(10);
    }
  }
  void CheckParent() const {
    Require(WaitForSingleObject(parent_.process.Get(), 0) == WAIT_TIMEOUT &&
        ProcessCreation(parent_.process.Get()) == parent_.creation, "Owned helper parent exited",
        "ERR_SCREEN_CAPTURE_PARENT_LOST");
  }
  void Tick() {
    progress_.store(GetTickCount64());
    CheckFailure();
    CheckParent();
    if (arguments_.encoderProbe) CheckProbeIsolation();
    else target_.Verify();
    const auto now = GetTickCount64();
    const bool paused = !arguments_.encoderProbe && target_.Paused();
    life_.ObserveStartupAvailability(now, paused);
    captureStarted_.store(life_.captureStartedMs);
    startupPaused_.store(paused);
    const auto deadline = ExpiredDeadline(life_.phase, now, processStarted_,
        life_.captureStartedMs, life_.stopStartedMs);
    if (deadline != Deadline::None) {
      if (deadline == Deadline::FirstAu && arguments_.kind == CaptureKind::Game)
        throw ContractError("ERR_SCREEN_CAPTURE_GAME_UNAVAILABLE",
            "The explicitly selected game did not supply frames. Game protections/Trusted Mode may reject OBS hooks; "
            "leave those protections enabled and explicitly select the same window using WGC instead.");
      const auto message = deadline == Deadline::Preparation ? "Preparation exceeded15s" : deadline == Deadline::FirstAu ?
          "Source attachment and first H264 AU exceeded10s" : "Retirement exceeded10s";
      throw ContractError("ERR_SCREEN_CAPTURE_TIMEOUT", std::string(message) + " at " + NativeStageName(nativeStage_.load()));
    }
  }
  void PollInput() {
    if (live_ && life_.phase != Phase::Stopping && life_.phase != Phase::Stopped && encoderSettings_)
      PollLiveFeedback();
    if (eof_) return;
    DWORD available = 0;
    if (!PeekNamedPipe(input_, nullptr, 0, nullptr, &available, nullptr)) {
      const DWORD error = GetLastError();
      Require(error == ERROR_BROKEN_PIPE || error == ERROR_PIPE_NOT_CONNECTED,
          "Cannot inspect command pipe", "ERR_SCREEN_CAPTURE_STDIN");
      eof_ = true; framer_.Finish();
      Require(life_.EofIsClean(), "stdin EOF before explicit STOP invalidates the run", "ERR_SCREEN_CAPTURE_STDIN_EOF");
      return;
    }
    if (available == 0) return;
    std::array<std::uint8_t, 1024> bytes{};
    DWORD read = 0;
    CheckWin(ReadFile(input_, bytes.data(), (std::min)(available, static_cast<DWORD>(bytes.size())), &read, nullptr),
        "ERR_SCREEN_CAPTURE_STDIN", "Cannot read available command bytes");
    Require(read > 0, "Command pipe returned empty read", "ERR_SCREEN_CAPTURE_STDIN");
    for (DWORD i = 0; i < read; ++i) {
      Require(life_.stopSequence == 0, "Command bytes follow the accepted STOP", "ERR_SCREEN_CAPTURE_PROTOCOL");
      const auto command = framer_.Push(bytes[i]);
      if (!command) continue;
      ValidateCommandMode(arguments_, *command);
      life_.Accept(*command, GetTickCount64());
      Sync();
      if (command->verb == Verb::Stats) {
        if (life_.phase == Phase::Running) ObserveSource();
        Snapshot();
        Emit("stats", command->sequence);
      }
    }
  }
  bool PreparationStep() {
    Tick(); PollInput(); FlushLogs();
    return life_.phase != Phase::Stopping;
  }
  void AppendLog(std::string_view text) {
    std::lock_guard lock(logMutex_);
    if (text.size() + 1 > logBytes_.size() - logUsed_) {
      Fail("ERR_SCREEN_CAPTURE_STDERR_LIMIT", "Pending stock diagnostics exceeded the64KiB buffer");
      return;
    }
    std::memcpy(logBytes_.data() + logUsed_, text.data(), text.size());
    logUsed_ += text.size(); logBytes_[logUsed_++] = '\n';
  }
  void FlushLogs() {
    std::string pending;
    {
      std::lock_guard lock(logMutex_);
      pending.assign(logBytes_.data(), logUsed_);
      logUsed_ = 0;
    }
    if (!pending.empty()) WriteText(errorPipe_, pending, "ERR_SCREEN_CAPTURE_STDERR");
  }
  void EmergencyDiagnostic(std::string_view text) noexcept {
    try {
      const auto limited = text.substr(0, 900);
      if (emergencyWritten_ + limited.size() + 1 > 1024) return;
      emergencyWritten_ += limited.size() + 1;
      WriteText(errorPipe_, std::string(limited) + "\n", "ERR_SCREEN_CAPTURE_STDERR");
    } catch (...) {
      // A broken/blocked output channel is already a nonzero process result;
      // the independent own-process watchdog bounds blocked synchronous I/O.
    }
  }
  void WriteEnvelope(const std::string& line) {
    budget_.Add(line.size());
    WriteText(outputPipe_, line, "ERR_SCREEN_CAPTURE_STDOUT");
  }
  void Emit(std::string_view type, std::uint64_t sequence) {
    if (arguments_.encoderProbe) {
      CheckProbeIsolation();
      WriteEnvelope(SerializeEncoderProbeEvent(arguments_, AtNow(), capability_, type, sequence,
          sourcePlatformVerified_, encoderInitialized_, type == "stopped" ? &retirement_ : nullptr));
    } else WriteEnvelope(SerializePlatformEvent(arguments_, AtNow(), capability_, type, sequence, observation_, target_.key, hooked_,
        type == "stopped" ? &retirement_ : nullptr));
  }
  void PumpMessages() {
    MSG message{};
    for (unsigned count = 0; count < 128 && PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE); ++count) {
      Require(message.message != WM_QUIT, "Main STA received WM_QUIT", "ERR_SCREEN_CAPTURE_STA");
      TranslateMessage(&message); DispatchMessageW(&message);
    }
  }
  void SelectDevice() {
    ComPtr<IDXGIFactory1> factory;
    Require(SUCCEEDED(CreateDXGIFactory1(IID_PPV_ARGS(&factory))), "Cannot enumerate native encoding adapters",
            "ERR_SCREEN_CAPTURE_DEVICE");
    // Both admitted stock Windows texture paths create their encode device on
    // adapter 0. Selecting another core adapter would falsely promise GPU sharing.
    for (UINT index = 0; index < 1; ++index) {
      ComPtr<IDXGIAdapter1> adapter;
      const auto result = factory->EnumAdapters1(index, &adapter);
      if (result == DXGI_ERROR_NOT_FOUND) break;
      Require(SUCCEEDED(result), "DXGI adapter enumeration failed", "ERR_SCREEN_CAPTURE_DEVICE");
      DXGI_ADAPTER_DESC1 description{};
      Require(SUCCEEDED(adapter->GetDesc1(&description)), "Cannot inspect DXGI adapter", "ERR_SCREEN_CAPTURE_DEVICE");
      if (description.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) continue;
      const auto kind = IsSoftware(arguments_.encoder) ? arguments_.encoder :
          description.VendorId == 0x1002 ? (IsAv1(arguments_.encoder) ? EncoderKind::AmfAv1 : EncoderKind::Amf) :
          description.VendorId == 0x10de ? (IsAv1(arguments_.encoder) ? EncoderKind::NvencAv1 : EncoderKind::Nvenc) : EncoderKind::Auto;
      if (kind == EncoderKind::Auto || (arguments_.encoder != EncoderKind::Auto && arguments_.encoder != kind)) continue;
      capability_.encoder = kind;
      capability_.adapterIndex = index;
      capability_.vendorId = description.VendorId;
      capability_.deviceId = description.DeviceId;
      capability_.adapterLuid = (static_cast<std::uint64_t>(static_cast<std::uint32_t>(description.AdapterLuid.HighPart)) << 32) |
          description.AdapterLuid.LowPart;
      return;
    }
    throw ContractError(IsSoftware(arguments_.encoder) ? "ERR_SCREEN_CAPTURE_DEVICE" : "ERR_SCREEN_CAPTURE_ENCODER_UNSUPPORTED",
        "The selected encoder is not supported on capture adapter 0; cross-adapter or unrequested software fallback is forbidden");
  }
  void CheckDevice() {
    GraphicsScope graphics(api());
    auto* device = static_cast<ID3D11Device*>(api().gs_get_device_obj());
    Require(device != nullptr, "OBS core did not expose its D3D11 device", "ERR_SCREEN_CAPTURE_DEVICE");
    Require(SUCCEEDED(device->GetDeviceRemovedReason()), "OBS D3D11 device was removed", "ERR_SCREEN_CAPTURE_DEVICE");
    ComPtr<IDXGIDevice> dxgi;
    Require(SUCCEEDED(device->QueryInterface(IID_PPV_ARGS(&dxgi))), "Cannot identify OBS D3D11 device", "ERR_SCREEN_CAPTURE_DEVICE");
    ComPtr<IDXGIAdapter> adapter;
    Require(SUCCEEDED(dxgi->GetAdapter(&adapter)), "Cannot identify OBS adapter", "ERR_SCREEN_CAPTURE_DEVICE");
    DXGI_ADAPTER_DESC description{};
    Require(SUCCEEDED(adapter->GetDesc(&description)), "Cannot query OBS adapter description", "ERR_SCREEN_CAPTURE_DEVICE");
    const auto luid = (static_cast<std::uint64_t>(static_cast<std::uint32_t>(description.AdapterLuid.HighPart)) << 32) |
        description.AdapterLuid.LowPart;
    matchingDevice_ = capability_.vendorId == description.VendorId && capability_.deviceId == description.DeviceId &&
        capability_.adapterLuid == luid;
    Require(matchingDevice_, "OBS selected a different D3D11 device; adapter/software fallback is forbidden",
            "ERR_SCREEN_CAPTURE_DEVICE");
    if (IsNvenc(capability_.encoder)) {
      ProbeNvencDevice(device, arguments_.video, {}, IsAv1(capability_.encoder));
      nvencProbeVerified_ = true;
    } else if (IsAmf(capability_.encoder)) {
      AppendLog(ProbeAmfDevice(device, arguments_.video, IsAv1(capability_.encoder)));
    }
    AppendLog("{\"schemaVersion\":1,\"kind\":\"screen-capture-device\",\"encoderId\":" + JsonString(SelectedEncoder()) +
        ",\"adapterIndex\":" + std::to_string(capability_.adapterIndex) + ",\"vendorId\":" + std::to_string(description.VendorId) +
        ",\"deviceId\":" + std::to_string(description.DeviceId) +
        ",\"description\":" + JsonString(Utf8(description.Description)) +
        ",\"adapterLuid\":" + JsonString(std::to_string(luid)) +
        ",\"encoderDeviceIndependentlyObserved\":false,\"sourceFramesAvailable\":false,"
        "\"actualBackendHwnd\":null,\"hardwareQualified\":false}");
  }
  abi::Property* Property(abi::Properties* properties, const char* name, abi::PropertyType type) {
    auto* value = api().obs_properties_get(properties, name);
    Require(value && api().obs_property_get_type(value) == type && api().obs_property_enabled(value),
        "Required setting name/type/support is absent in pinned module properties", "ERR_SCREEN_CAPTURE_SETTINGS");
    return value;
  }
  void SetString(abi::Properties* properties, abi::Data* settings, const char* name, const std::string& value) {
    auto* property = Property(properties, name, abi::PropertyType::List);
    Require(api().obs_property_list_format(property) == abi::ComboFormat::String,
        "Required string setting has wrong combo format", "ERR_SCREEN_CAPTURE_SETTINGS");
    const auto count = api().obs_property_list_item_count(property);
    Require(count <= kMaxWindowCandidates, "Property list exceeds bound", "ERR_SCREEN_CAPTURE_SETTINGS");
    std::size_t matching = 0;
    for (std::size_t i = 0; i < count; ++i) {
      if (!api().obs_property_list_item_disabled(property, i) &&
          BoundedString(api().obs_property_list_item_string(property, i), 4096) == value) ++matching;
    }
    Require(matching == 1, "Required explicit setting value is absent, disabled or ambiguous", "ERR_SCREEN_CAPTURE_SETTINGS");
    api().obs_data_set_string(settings, name, value.c_str());
    Require(BoundedString(api().obs_data_get_string(settings, name), 4096) == value,
        "Stock string setting readback differs", "ERR_SCREEN_CAPTURE_SETTINGS");
  }
  void SetInteger(abi::Properties* properties, abi::Data* settings, const char* name, long long value, bool list = false) {
    auto* property = Property(properties, name, list ? abi::PropertyType::List : abi::PropertyType::Integer);
    if (list) {
      Require(api().obs_property_list_format(property) == abi::ComboFormat::Integer,
          "Required integer setting has wrong combo format", "ERR_SCREEN_CAPTURE_SETTINGS");
      const auto count = api().obs_property_list_item_count(property);
      Require(count <= kMaxWindowCandidates, "Property list exceeds bound", "ERR_SCREEN_CAPTURE_SETTINGS");
      std::size_t matching = 0;
      for (std::size_t i = 0; i < count; ++i)
        if (api().obs_property_list_item_int(property, i) == value && !api().obs_property_list_item_disabled(property, i)) ++matching;
      Require(matching == 1, "Required integer choice is absent or disabled; fallback is forbidden", "ERR_SCREEN_CAPTURE_SETTINGS");
    } else {
      const auto minimum = api().obs_property_int_min(property), maximum = api().obs_property_int_max(property);
      const auto step = api().obs_property_int_step(property);
      if (std::strcmp(name, "bitrate") == 0) ValidateEncoderBitrateRange(value, minimum, maximum, step);
      else Require(step > 0 && value >= minimum && value <= maximum && (value - minimum) % step == 0,
          "Required integer setting is outside supported range/step", "ERR_SCREEN_CAPTURE_SETTINGS");
    }
    api().obs_data_set_int(settings, name, value);
    Require(api().obs_data_get_int(settings, name) == value, "Stock integer setting readback differs", "ERR_SCREEN_CAPTURE_SETTINGS");
  }
  void SetBoolean(abi::Properties* properties, abi::Data* settings, const char* name, bool value) {
    Property(properties, name, abi::PropertyType::Boolean);
    api().obs_data_set_bool(settings, name, value);
    Require(api().obs_data_get_bool(settings, name) == value, "Stock boolean setting readback differs", "ERR_SCREEN_CAPTURE_SETTINGS");
  }
  std::string WindowSetting(abi::Properties* properties) {
    auto* property = Property(properties, "window", abi::PropertyType::List);
    Require(api().obs_property_list_format(property) == abi::ComboFormat::String,
        "Window property has unexpected format", "ERR_SCREEN_CAPTURE_SOURCE_IDENTITY");
    const auto count = api().obs_property_list_item_count(property);
    Require(count <= kMaxWindowCandidates, "Window property exceeds bound", "ERR_SCREEN_CAPTURE_SOURCE_IDENTITY");
    std::optional<std::string> liveTitle;
    try {
      liveTitle = WindowTitle(target_.window);
    } catch (const ContractError&) {}
    std::vector<WindowListEntry> entries;
    entries.reserve(count);
    for (std::size_t i = 0; i < count; ++i) {
      if (api().obs_property_list_item_disabled(property, i)) continue;
      auto encoded = OptionalString(api().obs_property_list_item_string(property, i), kMaxWindowSetting);
      if (!encoded || encoded->empty()) continue;
      char* className = nullptr; char* title = nullptr; char* executable = nullptr;
      api().ms_build_window_strings(encoded->c_str(), &className, &title, &executable);
      WindowListEntry entry{std::move(*encoded)};
      try {
        entry.key = WindowEntryKey(title, className, executable);
      } catch (...) {
        api().bfree(className); api().bfree(title); api().bfree(executable); throw;
      }
      api().bfree(className); api().bfree(title); api().bfree(executable);
      entries.push_back(std::move(entry));
    }
    return SelectWindowSetting(entries, target_.key, liveTitle);
  }
  void SourceSettings() {
    Require(!arguments_.encoderProbe, "Encoder probing cannot enumerate source settings", "ERR_SCREEN_CAPTURE_PROBE_ISOLATION");
    PropertiesRef properties(api(), api().obs_get_source_properties(SourceId(arguments_.kind)));
    sourceSettings_ = api().obs_data_create();
    Require(sourceSettings_, "Cannot allocate source settings", "ERR_SCREEN_CAPTURE_SETTINGS");
    if (arguments_.kind == CaptureKind::Monitor) {
      SetInteger(properties.value, sourceSettings_, "method", 2, true);
      SetString(properties.value, sourceSettings_, "monitor_id", Utf8(arguments_.monitor.deviceId));
      SetBoolean(properties.value, sourceSettings_, "capture_cursor", true);
      SetBoolean(properties.value, sourceSettings_, "force_sdr", false);
    } else {
      const auto selected = WindowSetting(properties.value);
      // This tuple configures the source; the bound HWND, not its title, selects the captured window.
      api().obs_data_set_string(sourceSettings_, "window", selected.c_str());
      Require(BoundedString(api().obs_data_get_string(sourceSettings_, "window"), kMaxWindowSetting) == selected,
          "Bound window setting readback differs", "ERR_SCREEN_CAPTURE_SETTINGS");
      SetInteger(properties.value, sourceSettings_, "priority", 1, true);
      if (api().obs_properties_get(properties.value, "capture_audio"))
        SetBoolean(properties.value, sourceSettings_, "capture_audio", false);
      if (arguments_.kind == CaptureKind::Game) {
        SetString(properties.value, sourceSettings_, "capture_mode", "window");
        SetBoolean(properties.value, sourceSettings_, "anti_cheat_hook", true);
        SetBoolean(properties.value, sourceSettings_, "capture_cursor", true);
        SetBoolean(properties.value, sourceSettings_, "sli_compatibility", false);
        SetBoolean(properties.value, sourceSettings_, "allow_transparency", false);
        SetBoolean(properties.value, sourceSettings_, "premultiplied_alpha", false);
        SetBoolean(properties.value, sourceSettings_, "limit_framerate", true);
        SetBoolean(properties.value, sourceSettings_, "capture_overlays", false);
        SetInteger(properties.value, sourceSettings_, "hook_rate", 1, true);
        SetString(properties.value, sourceSettings_, "rgb10a2_space", "srgb");
      } else {
        SetInteger(properties.value, sourceSettings_, "method", 2, true);
        SetBoolean(properties.value, sourceSettings_, "cursor", true);
        SetBoolean(properties.value, sourceSettings_, "client_area", true);
        SetBoolean(properties.value, sourceSettings_, "compatibility", false);
        SetBoolean(properties.value, sourceSettings_, "force_sdr", false);
      }
    }
    target_.VerifyUnique();
  }
  void PollLiveFeedback() {
    for (const auto& feedback : live_->Poll()) {
      if (feedback.keyframe) {
        live_->Notice("{\"kind\":\"idr-request\",\"sequence\":" + std::to_string(feedback.sequence) +
            ",\"mode\":\"next-real-idr\",\"maximumWaitMs\":1500,\"keyframeConfirmed\":false}");
        continue;
      }
      PropertiesRef properties(api(), api().obs_get_encoder_properties(SelectedEncoder()));
      Require(feedback.bitrateKbps <= arguments_.bitrateCeilingKbps,
              "Live bitrate exceeds the configured capture ceiling", "ERR_SCREEN_CAPTURE_BITRATE");
      SetInteger(properties.value, encoderSettings_, "bitrate", feedback.bitrateKbps);
      if (encoder_) {
        api().obs_encoder_update(encoder_, encoderSettings_);
        DataRef settings(api(), api().obs_encoder_get_settings(encoder_));
        Require(api().obs_data_get_int(settings.value, "bitrate") == feedback.bitrateKbps,
            "OBS rejected requested live bitrate", "ERR_SCREEN_CAPTURE_BITRATE");
        CheckFailure();
      }
      live_->Bitrate(feedback.bitrateKbps);
      live_->Notice("{\"kind\":\"bitrate-settings\",\"sequence\":" + std::to_string(feedback.sequence) +
          ",\"bitrateKbps\":" + std::to_string(feedback.bitrateKbps) +
          ",\"settingsAccepted\":true,\"hardwareApplicationConfirmed\":false,\"fpsApplied\":null}");
    }
  }
  void EncoderSettings() {
    const auto* codec = api().obs_get_encoder_codec(SelectedEncoder());
    Require(codec || IsSoftware(capability_.encoder), "The selected hardware codec is not registered for this GPU",
            "ERR_SCREEN_CAPTURE_ENCODER_UNSUPPORTED");
    ValidateEncoderAdmission(codec && std::strcmp(codec, EncoderCodec(capability_.encoder)) == 0 &&
        api().obs_get_encoder_type(SelectedEncoder()) == abi::EncoderType::Video,
        (api().obs_get_encoder_caps(SelectedEncoder()) & abi::kPassTexture) != 0, matchingDevice_, api().obs_nv12_tex_active(),
        failed_.load(), false, capability_.encoder, !IsNvenc(capability_.encoder) || nvencProbeVerified_);
    Require((api().obs_get_encoder_caps(SelectedEncoder()) & abi::kDynamicBitrate) != 0,
            "Hardware encoder registration does not support live bitrate feedback", "ERR_SCREEN_CAPTURE_SETTINGS");
    encoderSettings_ = api().obs_encoder_defaults(SelectedEncoder());
    Require(encoderSettings_, "Cannot obtain pinned hardware encoder defaults", "ERR_SCREEN_CAPTURE_SETTINGS");
    PropertiesRef properties(api(), api().obs_get_encoder_properties(SelectedEncoder()));
    SetString(properties.value, encoderSettings_, "rate_control", EncoderRateControl(capability_.encoder));
    SetInteger(properties.value, encoderSettings_, "bitrate", arguments_.video.bitrateKbps);
    SetInteger(properties.value, encoderSettings_, "keyint_sec", 1);
    if (IsSoftware(capability_.encoder)) {
      if (capability_.encoder == EncoderKind::X264) {
        SetString(properties.value, encoderSettings_, "profile", "main");
        SetString(properties.value, encoderSettings_, "preset", "veryfast");
        SetString(properties.value, encoderSettings_, "tune", "zerolatency");
        const auto level = (std::max)(51u, RequiredCaptureH264Level(arguments_.video));
        const auto options = "bframes=0 scenecut=0 open-gop=0 level=" +
            std::to_string(level / 10) + "." + std::to_string(level % 10);
        Property(properties.value, "x264opts", abi::PropertyType::Text);
        api().obs_data_set_string(encoderSettings_, "x264opts", options.c_str());
      }
      api().obs_properties_apply_settings(properties.value, encoderSettings_);
      capability_.verified = true;
      return;
    }
    if (api().obs_properties_get(properties.value, "profile"))
      SetString(properties.value, encoderSettings_, "profile", "main");
    SetString(properties.value, encoderSettings_, "preset", IsNvenc(capability_.encoder) ? "p4" : "balanced");
    if (api().obs_properties_get(properties.value, "bf")) SetInteger(properties.value, encoderSettings_, "bf", 0);
    else Require((IsNvenc(capability_.encoder) || IsAv1(capability_.encoder)) && api().obs_data_get_int(encoderSettings_, "bf") == 0,
                 "Missing B-frame control did not explicitly default to zero", "ERR_SCREEN_CAPTURE_SETTINGS");
    SetInteger(properties.value, encoderSettings_, "keyint_sec", 1);
    if (IsNvenc(capability_.encoder)) {
      SetString(properties.value, encoderSettings_, "tune", "ull");
      SetString(properties.value, encoderSettings_, "multipass", "disabled");
      SetBoolean(properties.value, encoderSettings_, "lookahead", false);
      SetBoolean(properties.value, encoderSettings_, "adaptive_quantization", false);
      SetBoolean(properties.value, encoderSettings_, "repeat_headers", true);
      SetBoolean(properties.value, encoderSettings_, "force_cuda_tex", false);
      SetBoolean(properties.value, encoderSettings_, "disable_scenecut", true);
      if (api().obs_properties_get(properties.value, "device")) SetInteger(properties.value, encoderSettings_, "device", -1);
      else Require(api().obs_data_get_int(encoderSettings_, "device") == -1,
                   "NVENC did not select the current texture device", "ERR_SCREEN_CAPTURE_SETTINGS");
      Property(properties.value, "opts", abi::PropertyType::Text);
      const auto options = EncoderProfileOptions(capability_.encoder, arguments_.video, arguments_.bitrateCeilingKbps);
      api().obs_data_set_string(encoderSettings_, "opts", options.c_str());
    } else {
      SetBoolean(properties.value, encoderSettings_, "pre_analysis", false);
      Property(properties.value, "ffmpeg_opts", abi::PropertyType::Text);
      const auto options = EncoderProfileOptions(capability_.encoder, arguments_.video);
      api().obs_data_set_string(encoderSettings_, "ffmpeg_opts", options.c_str());
    }
    api().obs_properties_apply_settings(properties.value, encoderSettings_);
    capability_.verified = true;
  }
  void CheckEncoderSettings() {
    DataRef settings(api(), api().obs_encoder_get_settings(encoder_));
    if (IsSoftware(capability_.encoder)) {
      Require(BoundedString(api().obs_data_get_string(settings.value, "rate_control"), 32) == "CBR" &&
          api().obs_data_get_int(settings.value, "bitrate") == (live_ ? live_->Bitrate() : arguments_.video.bitrateKbps) &&
          api().obs_data_get_int(settings.value, "keyint_sec") == 1,
          "Encoder changed the selected real-time rate settings", "ERR_SCREEN_CAPTURE_ENCODER_INITIALIZATION");
      if (capability_.encoder == EncoderKind::X264)
        Require(BoundedString(api().obs_data_get_string(settings.value, "profile"), 32) == "main" &&
            BoundedString(api().obs_data_get_string(settings.value, "preset"), 32) == "veryfast" &&
            BoundedString(api().obs_data_get_string(settings.value, "tune"), 32) == "zerolatency",
            "Software H264 changed its selected latency settings", "ERR_SCREEN_CAPTURE_ENCODER_INITIALIZATION");
      return;
    }
    const bool nvenc = IsNvenc(capability_.encoder);
    Require(BoundedString(api().obs_data_get_string(settings.value, "rate_control"), 32) == EncoderRateControl(capability_.encoder) &&
        BoundedString(api().obs_data_get_string(settings.value, "profile"), 32) == "main" &&
        BoundedString(api().obs_data_get_string(settings.value, "preset"), 32) == (nvenc ? "p4" : "balanced") &&
        BoundedString(api().obs_data_get_string(settings.value, nvenc ? "opts" : "ffmpeg_opts"), 512) ==
            EncoderProfileOptions(capability_.encoder, arguments_.video, arguments_.bitrateCeilingKbps) &&
        api().obs_data_get_int(settings.value, "bitrate") == (live_ ? live_->Bitrate() : arguments_.video.bitrateKbps) &&
        api().obs_data_get_int(settings.value, "bf") == 0 &&
        api().obs_data_get_int(settings.value, "keyint_sec") == 1,
        "Hardware initialization changed or rejected the selected codec settings", "ERR_SCREEN_CAPTURE_ENCODER_INITIALIZATION");
    if (nvenc) {
      Require(BoundedString(api().obs_data_get_string(settings.value, "tune"), 32) == "ull" &&
              BoundedString(api().obs_data_get_string(settings.value, "multipass"), 32) == "disabled" &&
              api().obs_data_get_int(settings.value, "device") == -1 &&
              !api().obs_data_get_bool(settings.value, "lookahead") &&
              !api().obs_data_get_bool(settings.value, "adaptive_quantization") &&
              !api().obs_data_get_bool(settings.value, "force_cuda_tex") &&
              api().obs_data_get_bool(settings.value, "repeat_headers") &&
              api().obs_data_get_bool(settings.value, "disable_scenecut"),
              "NVENC changed the admitted low-latency texture settings", "ERR_SCREEN_CAPTURE_ENCODER_INITIALIZATION");
    } else Require(!api().obs_data_get_bool(settings.value, "pre_analysis"),
                   "AMF changed the admitted low-latency settings", "ERR_SCREEN_CAPTURE_ENCODER_INITIALIZATION");
  }
  std::wstring CaptureModulePath() {
    const auto image = HostImagePath();
    const auto separator = image.find_last_of(L'\\');
    Require(separator != std::wstring::npos, "Capture host path is not absolute", "ERR_SCREEN_CAPTURE_MODULE_PATH");
    return image.substr(0, separator) + L"\\obs-plugins\\64bit\\win-capture.dll";
  }
  void VerifyCaptureModule() {
    auto input = OpenRegular(CaptureModulePath());
    Sha256 hash;
    Require(hash.File(input.Get(), kCaptureModule.bytes) == kCaptureModule.sha256,
        "Capture module differs from its compiled pin", "ERR_SCREEN_CAPTURE_RUNTIME_INTEGRITY");
    libraries_.inputs.push_back(std::move(input));
  }
  void LoadCaptureModule(const std::wstring& binaryPath) {
    const auto image = LoadLibraryExW(binaryPath.c_str(), nullptr,
        LOAD_LIBRARY_SEARCH_SYSTEM32 | LOAD_LIBRARY_SEARCH_USER_DIRS);
    Require(image != nullptr, "Cannot load the pinned capture module", "ERR_SCREEN_CAPTURE_LIBRARY_LOAD");
    libraries_.images.push_back(image);
    using Configure = bool (*)(bool);
    const bool gameHooks = !arguments_.encoderProbe && arguments_.kind == CaptureKind::Game;
    Require(Symbol<Configure>(image, "monky_configure_capture_startup")(gameHooks),
        "Capture module refused the explicit startup mode", "ERR_SCREEN_CAPTURE_STARTUP_MODE");
    if (!arguments_.encoderProbe && arguments_.kind != CaptureKind::Monitor) {
      using Bind = bool (*)(std::uint64_t, std::uint32_t, std::uint64_t);
      Require(Symbol<Bind>(image, "monky_bind_window_target")(arguments_.hwnd, arguments_.processId, target_.creation),
              "Capture could not hold the exact selected HWND/PID/creation/thread identity",
              "ERR_SCREEN_CAPTURE_SOURCE_IDENTITY");
    } else if (!arguments_.encoderProbe && arguments_.kind == CaptureKind::Monitor) {
      using Bind = bool (*)(std::uint64_t, const char*, const char*, std::int32_t, std::int32_t, std::uint32_t, std::uint32_t);
      const auto& monitor = arguments_.monitor;
      Require(Symbol<Bind>(image, "monky_bind_monitor_target")(reinterpret_cast<std::uintptr_t>(target_.Monitor()),
          Utf8(monitor.deviceId).c_str(), Utf8(monitor.deviceName).c_str(), monitor.x, monitor.y, monitor.width, monitor.height),
          "Monitor capture could not bind the selected physical display", "ERR_SCREEN_CAPTURE_MONITOR_IDENTITY");
      invalidateMonitorIdentity_ = Symbol<void (*)()>(image, "monky_invalidate_monitor_identity");
    }
    const auto stamp = AtNow();
    AppendLog("{\"schemaVersion\":1,\"kind\":\"screen-capture-module\",\"runId\":" + JsonString(arguments_.runId) +
        ",\"helperProcessId\":" + std::to_string(stamp.helperProcessId) + ",\"qpc\":" + JsonString(std::to_string(stamp.qpc)) +
        ",\"qpcFrequency\":" + JsonString(std::to_string(stamp.qpcFrequency)) +
        ",\"gameHooksEnabled\":" + Boolean(gameHooks) +
        ",\"compatibilityUpdater\":false,\"moduleSha256\":" + JsonString(kCaptureModule.sha256) + "}");
    FlushLogs();
  }
  void LoadModule(std::string_view name) {
    const bool captureModule = name == "win-capture";
    const bool nvenc = name == "obs-nvenc";
    const auto* binary = captureModule ? L"obs-plugins\\64bit\\win-capture.dll" :
        nvenc ? L"obs-plugins\\64bit\\obs-nvenc.dll" :
        name == "obs-x264" ? L"obs-plugins\\64bit\\obs-x264.dll" : L"obs-plugins\\64bit\\obs-ffmpeg.dll";
    const auto* data = captureModule ? L"data\\obs-plugins\\win-capture" :
        nvenc ? L"data\\obs-plugins\\obs-nvenc" :
        name == "obs-x264" ? L"data\\obs-plugins\\obs-x264" : L"data\\obs-plugins\\obs-ffmpeg";
    const auto binaryPath = captureModule ? CaptureModulePath() : arguments_.runtime + L"\\" + binary;
    const auto dataPath = (captureModule ? libraries_.captureDataDirectory : run_->directory) + L"\\" + data;
    const auto configRoot = run_->directory + L"\\config";
    Require(SafeAbsolutePath(binaryPath) && SafeAbsolutePath(dataPath) && SafeAbsolutePath(configRoot),
        "Module API paths must retain admitted Windows filesystem identities", "ERR_SCREEN_CAPTURE_MODULE_PATH");
    const auto expected = ExpectedModuleIdentity(name, Utf8(binaryPath), Utf8(dataPath), Utf8(configRoot),
        captureModule ? kCaptureDataDigest : "");
    BeginStage(captureModule ? NativeStage::WinCaptureImage : nvenc ? NativeStage::NvencImage : NativeStage::FfmpegImage);
    if (captureModule) LoadCaptureModule(binaryPath);
    else libraries_.LoadImage(arguments_, binary);
    EndStage();
    abi::Module* module = nullptr;
    BeginStage(captureModule ? NativeStage::WinCaptureOpen : nvenc ? NativeStage::NvencOpen : NativeStage::FfmpegOpen);
    const int opened = api().obs_open_module(&module, expected.binaryPath.c_str(), expected.dataPath.c_str());
    EndStage();
    if (opened != 0 || !module)
      throw ContractError("ERR_SCREEN_CAPTURE_MODULE_OPEN", expected.moduleName + " obs_open_module returned " +
          std::to_string(opened) + (module ? "" : " without a module"));
    BeginStage(captureModule ? NativeStage::WinCaptureIdentity : nvenc ? NativeStage::NvencIdentity : NativeStage::FfmpegIdentity);
    {
      std::unique_ptr<char, decltype(api().bfree)> config(api().obs_module_get_config_path(module, ""), api().bfree);
      ValidateModuleIdentity(expected, BoundedString(api().obs_get_module_file_name(module), 960),
          BoundedString(api().obs_get_module_binary_path(module), 960),
          BoundedString(api().obs_get_module_data_path(module), 960), BoundedString(config.get(), 1024),
          api().obs_get_module(expected.moduleName.c_str()) == module);
    }
    run_->Verify();
    run_->CreatePrivateDirectory(captureModule ? L"config\\win-capture" : nvenc ? L"config\\obs-nvenc" : L"config\\obs-ffmpeg");
    EndStage();
    if (!PreparationStep()) return;
    BeginStage(captureModule ? NativeStage::WinCaptureInit : nvenc ? NativeStage::NvencInit : NativeStage::FfmpegInit);
    const bool initialized = api().obs_init_module(module);
    EndStage();
    if (!initialized)
      throw ContractError("ERR_SCREEN_CAPTURE_MODULE_INIT", expected.moduleName + " obs_init_module returned false");
    CheckFailure();
  }
  void Prepare() {
    VerifyCaptureModule();
    if (!PreparationStep()) return;
    BeginStage(NativeStage::RuntimeVerification);
    run_->Verify();
    libraries_.VerifyAndCopy(arguments_, *run_);
    EndStage();
    if (!PreparationStep()) return;
    BeginStage(NativeStage::StaInitialization);
    const auto com = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    Require(SUCCEEDED(com), "Core startup requires the main STA", "ERR_SCREEN_CAPTURE_STA");
    comInitialized_ = true;
    EndStage();
    if (!arguments_.encoderProbe) target_.VerifyUnique();
    CheckParent();
    BeginStage(NativeStage::CoreLoad);
    CheckWin(SetCurrentDirectoryW((arguments_.runtime + L"\\bin\\64bit").c_str()),
        "ERR_SCREEN_CAPTURE_RUNTIME_PATH", "Cannot set verified private stock working directory");
    libraries_.LoadCore(arguments_);
    api().base_set_log_handler(Log, this);
    Require(BoundedString(api().obs_get_version_string(), 64) == "32.1.1", "Stock core version differs from ABI pin",
        "ERR_SCREEN_CAPTURE_ABI");
    EndStage();
    const auto configPath = ObsPath(run_->directory + L"\\config");
    BeginStage(NativeStage::CoreStartup);
    obsStarted_ = api().obs_startup("en-US", configPath.c_str(), nullptr);
    EndStage();
    Require(obsStarted_, "libobs core startup failed", "ERR_SCREEN_CAPTURE_CORE");
    BeginStage(NativeStage::CoreDataPath);
    api().obs_add_data_path(ObsPath(run_->directory + L"\\data\\libobs").c_str());
    EndStage();
    if (!PreparationStep()) return;
    graphicsModulePath_ = ObsPath(arguments_.runtime + L"\\bin\\64bit\\libobs-d3d11.dll");
    const auto& selected = arguments_.video;
    SelectDevice();
    abi::VideoInfo video{graphicsModulePath_.c_str(), selected.fps, 1,
        selected.width, selected.height, selected.width, selected.height,
        abi::VideoFormat::Nv12, capability_.adapterIndex, true, abi::ColorSpace::Bt709, abi::Range::Partial, abi::Scale::Bicubic};
    BeginStage(NativeStage::VideoReset);
    const int videoResult = api().obs_reset_video(&video);
    videoStarted_ = videoResult == 0;
    EndStage();
    Require(videoStarted_, "obs_reset_video failed for the selected NV12 BT709 rendition", "ERR_SCREEN_CAPTURE_VIDEO");
    BeginStage(NativeStage::VideoVerification);
    abi::VideoInfo actual{};
    Require(api().obs_get_video_info(&actual) && ExactVideoConfiguration(actual, selected, capability_.adapterIndex),
        "OBS core did not accept the exact video pipeline configuration", "ERR_SCREEN_CAPTURE_VIDEO");
    CheckDevice();
    EndStage();
    if (!PreparationStep()) return;
    LoadModule("win-capture");
    if (!PreparationStep()) return;
    if (arguments_.encoderProbe) {
      for (const auto* id : {"window_capture", "monitor_capture"}) {
        const auto* name = api().obs_source_get_display_name(id);
        Require(name && *name, "The source-free probe did not confirm registered WGC source support",
                "ERR_SCREEN_CAPTURE_SOURCE");
      }
      sourcePlatformVerified_ = true;
    }
    if (capability_.encoder == EncoderKind::AomAv1) {
      const auto image = HostImagePath();
      const auto path = image.substr(0, image.find_last_of(L'\\') + 1) + L"monky_av1.dll";
      RegisterSoftwareAv1(GetModuleHandleW(L"obs.dll"), GetModuleHandleW(path.c_str()));
    } else LoadModule(capability_.encoder == EncoderKind::X264 ? "obs-x264" :
        IsNvenc(capability_.encoder) ? "obs-nvenc" : "obs-ffmpeg");
    if (!PreparationStep()) return;
    BeginStage(NativeStage::ModulesPostLoad);
    api().obs_post_load_modules();
    EndStage();
    if (!PreparationStep()) return;
    if (!arguments_.encoderProbe) { BeginStage(NativeStage::SourceSettings); SourceSettings(); EndStage(); }
    BeginStage(NativeStage::EncoderSettings); EncoderSettings(); EndStage();
    abi::OutputInfo info{};
    info.id = "monky_screen_h264_pipe";
    info.flags = abi::kVideoEncoded;
    info.get_name = OutputName; info.create = OutputCreate; info.destroy = OutputDestroy;
    info.start = OutputStart; info.stop = OutputStop; info.encoded_packet = EncodedPacket;
    info.encoded_video_codecs = EncoderCodec(capability_.encoder);
    BeginStage(NativeStage::OutputRegistration);
    api().obs_register_output_s(&info, sizeof(info));
    EndStage();
    if (!PreparationStep()) return;
    if (arguments_.encoderProbe) {
      BeginStage(NativeStage::EncoderProbe);
      BindMainCanvas();
      CreateEncoderOutput();
      InitializeEncoder();
      CheckProbeIsolation();
      EndStage();
      if (!PreparationStep()) return;
    }
    if (life_.Prepared()) {
      Sync(); Snapshot();
      BeginStage(NativeStage::Prepared);
      Emit("prepared", 0);
      EndStage();
    }
  }
  void BindMainCanvas() {
    Require(!mainCanvas_, "Main canvas is already bound", "ERR_SCREEN_CAPTURE_CANVAS");
    mainCanvas_ = api().obs_get_main_canvas();
    Require(mainCanvas_, "Core main canvas is unavailable", "ERR_SCREEN_CAPTURE_CANVAS");
    abi::VideoInfo canvasInfo{};
    Require(api().obs_canvas_get_video_info(mainCanvas_, &canvasInfo), "Main canvas has no configured video",
        "ERR_SCREEN_CAPTURE_CANVAS");
    canvasVideo_ = api().obs_canvas_get_video(mainCanvas_);
    ValidateMainCanvasVideo((api().obs_canvas_get_flags(mainCanvas_) & abi::kMainCanvas) != 0,
        canvasVideo_ && canvasVideo_ == api().obs_get_video(), canvasInfo, arguments_.video, capability_.adapterIndex);
  }
  void StartSource() {
    Require(!arguments_.encoderProbe, "Encoder probing cannot create a capture source", "ERR_SCREEN_CAPTURE_PROBE_ISOLATION");
    target_.VerifyUnique(); CheckParent(); CheckFailure(); run_->Verify();
    strictEncoderWarnings_.store(true);
    BindMainCanvas();
    const auto canvasUuid = BoundedString(api().obs_canvas_get_uuid(mainCanvas_), 36);
    std::string seed;
    {
      std::unique_ptr<abi::Canvas, decltype(api().obs_canvas_release)> resolved(
          api().obs_get_canvas_by_uuid(canvasUuid.c_str()), api().obs_canvas_release);
      seed = PrivateSceneSeed(canvasUuid, resolved.get() == mainCanvas_);
    }
    DataRef sceneData(api(), api().obs_data_create_from_json(seed.c_str()));
    auto* sceneSource = api().obs_load_private_source(sceneData.value);
    Require(sceneSource, "Cannot create private scene from explicit canvas data", "ERR_SCREEN_CAPTURE_SOURCE_INITIALIZATION");
    scene_ = api().obs_scene_from_source(sceneSource);
    if (!scene_) {
      api().obs_source_release(sceneSource);
      throw ContractError("ERR_SCREEN_CAPTURE_SOURCE_INITIALIZATION", "Private source did not create a scene");
    }
    // scene_ now owns the loader's source reference; scene_release balances it.
    ValidatePrivateScene(api().obs_obj_is_private(sceneSource), api().obs_scene_get_source(scene_) == sceneSource,
        api().obs_source_get_width(sceneSource), api().obs_source_get_height(sceneSource), arguments_.video);
    CheckFailure();
    source_ = api().obs_source_create_private(SourceId(arguments_.kind),
        "Monky explicitly selected source", sourceSettings_);
    Require(source_, "Cannot create selected stock source", "ERR_SCREEN_CAPTURE_SOURCE");
    Require(api().obs_obj_is_private(source_), "Selected capture source is not private", "ERR_SCREEN_CAPTURE_SOURCE_INITIALIZATION");
    CheckFailure();
    auto* item = api().obs_scene_add(scene_, source_);
    Require(item && api().obs_sceneitem_get_source(item) == source_,
        "Private scene item does not reference the selected source", "ERR_SCREEN_CAPTURE_SOURCE_INITIALIZATION");
    const abi::Vec2 bounds{static_cast<float>(arguments_.video.width), static_cast<float>(arguments_.video.height)};
    const abi::Vec2 center{bounds.x / 2.0f, bounds.y / 2.0f};
    api().obs_sceneitem_set_bounds_type(item,
        arguments_.video.scaleMode == ScaleMode::Fit ? abi::Bounds::ScaleInner : abi::Bounds::Stretch);
    api().obs_sceneitem_set_bounds_alignment(item, 0);
    api().obs_sceneitem_set_bounds(item, &bounds);
    api().obs_sceneitem_set_alignment(item, 0);
    api().obs_sceneitem_set_pos(item, &center);
    CheckFailure(); target_.Verify();
    api().obs_canvas_set_channel(mainCanvas_, 0, sceneSource);
    CheckSceneOutput();
  }
  void CheckSceneOutput() {
    Require(mainCanvas_ && scene_, "Explicit scene/canvas binding is unavailable", "ERR_SCREEN_CAPTURE_CANVAS");
    std::unique_ptr<abi::Source, decltype(api().obs_source_release)> channel(
        api().obs_canvas_get_channel(mainCanvas_, 0), api().obs_source_release);
    Require(channel.get() == api().obs_scene_get_source(scene_),
        "Main canvas output channel does not reference the private scene", "ERR_SCREEN_CAPTURE_SOURCE_INITIALIZATION");
    Require(canvasVideo_ && canvasVideo_ == api().obs_canvas_get_video(mainCanvas_) && canvasVideo_ == api().obs_get_video(),
        "Explicit canvas output lost its admitted core video identity", "ERR_SCREEN_CAPTURE_CANVAS");
  }
  void CreateEncoderOutput() {
    Require(!encoder_ && !output_ && mainCanvas_ && canvasVideo_, "Encoder requires one explicit canvas binding",
            "ERR_SCREEN_CAPTURE_ENCODER_INITIALIZATION");
    encoder_ = api().obs_video_encoder_create(SelectedEncoder(), "Monky explicitly selected screen encoder", encoderSettings_, nullptr);
    Require(encoder_, "Cannot create pinned screen encoder object", "ERR_SCREEN_CAPTURE_ENCODER_INITIALIZATION");
    api().obs_encoder_set_video(encoder_, canvasVideo_);
    Require(api().obs_encoder_video(encoder_) == canvasVideo_, "Encoder rejected the explicit main canvas video",
        "ERR_SCREEN_CAPTURE_ENCODER_INITIALIZATION");
    output_ = api().obs_output_create("monky_screen_h264_pipe", "Monky compressed in-memory output", nullptr, nullptr);
    Require(output_, "Cannot create video-only custom output", "ERR_SCREEN_CAPTURE_OUTPUT");
    api().obs_output_set_video_encoder(output_, encoder_);
    Require(api().obs_output_get_video_encoder(output_) == encoder_, "Output did not bind the selected encoder",
        "ERR_SCREEN_CAPTURE_ENCODER_INITIALIZATION");
  }
  void InitializeEncoder() {
    Require(output_ && output_ == callbackOutput_ && encoder_ &&
            api().obs_output_can_begin_data_capture(output_, abi::kVideoEncoded),
            "Custom output cannot initialize encoded video", "ERR_SCREEN_CAPTURE_ENCODER_INITIALIZATION");
    strictEncoderWarnings_.store(true);
    const auto refusal = std::string(SelectedEncoder()) + " refused " + std::to_string(arguments_.video.width) + "x" +
        std::to_string(arguments_.video.height) + "@" + std::to_string(arguments_.video.fps) +
        " at " + std::to_string(arguments_.video.bitrateKbps) + " Kbps" +
        (IsAv1(capability_.encoder) ? "; AV1 Main 8-bit L1T1" :
            "; required H264 Main level_idc=" + std::to_string(RequiredCaptureH264Level(arguments_.video))) +
        ". Select a lower capture profile or check the selected encoder and driver.";
    Require(api().obs_output_initialize_encoders(output_, abi::kVideoEncoded),
            refusal.c_str(), "ERR_SCREEN_CAPTURE_ENCODER_INITIALIZATION");
    CheckFailure();
    const auto* encoderError = api().obs_encoder_get_last_error(encoder_);
    Require(!encoderError || !*encoderError, "Encoder initialization reported an error or reroute",
            "ERR_SCREEN_CAPTURE_ENCODER_INITIALIZATION");
    CheckEncoderSettings();
    // Pinned AMF skips its first update; consume it before any capture/feedback.
    if (capability_.encoder == EncoderKind::Amf) api().obs_encoder_update(encoder_, encoderSettings_);
    CheckFailure();
    ValidateEncoderAdmission(true, !IsSoftware(capability_.encoder), matchingDevice_, api().obs_nv12_tex_active(), failed_.load(), false,
        capability_.encoder, capability_.verified);
    Require(BoundedString(api().obs_encoder_get_id(encoder_), 128) == SelectedEncoder(),
            "Configured hardware encoder registration identity changed", "ERR_SCREEN_CAPTURE_ENCODER_INITIALIZATION");
    CheckFailure();
    Require(api().obs_encoder_video(encoder_) == canvasVideo_ && api().obs_output_get_video_encoder(output_) == encoder_,
            "Initialization changed the admitted canvas/encoder binding", "ERR_SCREEN_CAPTURE_ENCODER_INITIALIZATION");
    if (capability_.encoder == EncoderKind::Amf) {
      abi::VideoInfo canvasInfo{};
      Require(api().obs_canvas_get_video_info(mainCanvas_, &canvasInfo) &&
              ExactVideoConfiguration(canvasInfo, arguments_.video, capability_.adapterIndex),
              "Initialized encoder lost its NV12 BT709 limited-range video", "ERR_SCREEN_CAPTURE_VIDEO");
      amfColorNormalizationAllowed_ = true;
    }
    encoderInitialized_ = true;
  }
  void CheckProbeIsolation() {
    Require(arguments_.encoderProbe, "Unexpected source-free probe isolation check");
    std::lock_guard lock(bufferMutex_);
    ValidateEncoderProbeIsolation(target_.window || target_.Monitor() || target_.process,
        source_ != nullptr, scene_ != nullptr, live_ != nullptr,
        encoder_ && api().obs_encoder_active(encoder_), output_ && api().obs_output_active(output_),
        observation_.outputPackets);
  }
  void StartEncoderOutput() {
    Require(!arguments_.encoderProbe, "Encoder probing cannot start video output", "ERR_SCREEN_CAPTURE_PROBE_ISOLATION");
    PollInput();
    if (life_.phase == Phase::Stopping) return;
    Tick(); target_.VerifyUnique();
    Require(SourceReadyForEncoder(life_.phase, observation_), "Encoder requires attached source with positive dimensions",
        "ERR_SCREEN_CAPTURE_SOURCE");
    CheckSceneOutput();
    CreateEncoderOutput();
    const bool started = api().obs_output_start(output_);
    CheckFailure();
    Require(started, "Encoded screen output failed to start", "ERR_SCREEN_CAPTURE_ENCODER_INITIALIZATION");
    Require(api().obs_encoder_video(encoder_) == canvasVideo_ && api().obs_output_get_video_encoder(output_) == encoder_,
        "Output initialization changed the admitted canvas/encoder binding", "ERR_SCREEN_CAPTURE_ENCODER_INITIALIZATION");
  }
  void ObserveSource() {
    target_.Verify();
    if (target_.Paused()) {
      observation_.sourceAttached = false;
      CheckFailure();
      return;
    }
    const auto now = GetTickCount64();
    if (target_.kind == CaptureKind::Monitor && now - lastDisplayCheck_ >= 100) {
      lastDisplayCheck_ = now;
      if (displayChanges_.Changed()) {
        if (invalidateMonitorIdentity_) invalidateMonitorIdentity_();
        target_.VerifyUnique();
      }
    }
    abi::CallData data{};
    bool attached = false;
    std::optional<SourceKey> observed;
    std::uint32_t width = 0, height = 0;
    {
      GraphicsScope graphics(api());
      try {
        auto* procedure = api().obs_source_get_proc_handler(source_);
        Require(procedure && api().proc_handler_call(procedure, "get_hooked", &data) &&
            api().calldata_get_data(&data, "hooked", &attached, sizeof(attached)),
            "Stock source cannot expose get_hooked attachment evidence", "ERR_SCREEN_CAPTURE_HOOK_IDENTITY");
        if (attached) {
          bool identity = false;
          Require(api().calldata_get_data(&data, "identity_valid", &identity, sizeof(identity)) && identity,
                  "The capture backend did not bind the exact selected native identity", "ERR_SCREEN_CAPTURE_HOOK_IDENTITY");
          if (arguments_.kind != CaptureKind::Monitor) {
            const char* className = nullptr; const char* executable = nullptr;
            Require(api().calldata_get_string(&data, "class", &className) &&
                api().calldata_get_string(&data, "executable", &executable), "Stock hooked tuple is incomplete",
                "ERR_SCREEN_CAPTURE_HOOK_IDENTITY");
            // The live title may be renamed, empty or longer than the selection bound; it keeps the selected label.
            observed = SourceKey{target_.key.title, BoundedString(className, 256), BoundedString(executable, 260)};
          }
          if (arguments_.kind != CaptureKind::Monitor) {
            std::int64_t hwnd = 0, pid = 0, creation = 0;
            Require(api().calldata_get_data(&data, "hwnd", &hwnd, sizeof(hwnd)) &&
                    api().calldata_get_data(&data, "process_id", &pid, sizeof(pid)) &&
                    api().calldata_get_data(&data, "process_creation", &creation, sizeof(creation)) &&
                    hwnd > 0 && static_cast<std::uint64_t>(hwnd) == arguments_.hwnd &&
                    pid == arguments_.processId && static_cast<std::uint64_t>(creation) == target_.creation,
                    "Capture reported a different HWND/PID/process creation identity", "ERR_SCREEN_CAPTURE_HOOK_IDENTITY");
          }
          width = api().obs_source_get_width(source_); height = api().obs_source_get_height(source_);
          if (arguments_.kind == CaptureKind::Monitor && width && height)
            Require(width == arguments_.monitor.width && height == arguments_.monitor.height,
                    "Captured monitor dimensions differ from the selected physical display; reselect explicitly",
                    "ERR_SCREEN_CAPTURE_MONITOR_CHANGED");
        }
        auto* device = static_cast<ID3D11Device*>(api().gs_get_device_obj());
        Require(device && SUCCEEDED(device->GetDeviceRemovedReason()), "OBS graphics device was removed", "ERR_SCREEN_CAPTURE_DEVICE");
      } catch (...) { api().bfree(data.stack); throw; }
      api().bfree(data.stack);
    }
    if (observed) {
      hooked_ = *observed;
      ValidateHookEvidence(target_.key, *observed);
    }
    if (attached && width && height) UpdateSourceDimensions(observation_, life_.phase, width, height);
    // WGC can temporarily detach or report zero dimensions across minimize,
    // resize and exclusive-fullscreen transitions. HWND/PID/creation and the
    // backend binding above still identify the only permitted source.
    observation_.sourceAttached = attached && width > 0 && height > 0;
    target_.Verify();
    CheckFailure();
  }
  void Snapshot() {
    {
      std::lock_guard lock(bufferMutex_);
      ObservePackets(observation_, buffer_);
    }
    SnapshotCoreFrames(observation_, obsStarted_ && videoStarted_, [this] {
      return CoreFrameCounters{api().obs_get_total_frames(), api().obs_get_lagged_frames()};
    });
  }
  struct BarrierState { std::atomic<bool> returned{false}; };
  static void __cdecl BarrierReturned(void* parameter) noexcept {
    static_cast<BarrierState*>(parameter)->returned.store(true);
  }
  void CoreBarrier(abi::TaskType type) {
    Require(barrierCount_ < barriers_.size(), "Unexpected extra core retirement barrier", "ERR_SCREEN_CAPTURE_RETIREMENT");
    auto& state = barriers_[barrierCount_++];
    api().obs_queue_task(type, BarrierReturned, &state, false);
    while (!state.returned.load()) {
      progress_.store(GetTickCount64());
      Require(GetTickCount64() - life_.stopStartedMs < kRetirementTimeoutMs,
          "Core source retirement barrier exceeded10s", "ERR_SCREEN_CAPTURE_RETIREMENT");
      try { CheckParent(); PollInput(); }
      catch (const ContractError& error) { Fail(error.code, error.what()); }
      PumpMessages(); Sleep(1);
    }
  }
  void Retire() {
    BeginStage(NativeStage::OutputStop);
    if (source_) api().obs_source_set_enabled(source_, false);
    if (mainCanvas_) api().obs_canvas_set_channel(mainCanvas_, 0, nullptr);
    observation_.sourceAttached = false;
    if (output_) {
      api().obs_output_force_stop(output_);
      while (api().obs_output_active(output_) || callbacks_.load() != 0) {
        progress_.store(GetTickCount64());
        Require(GetTickCount64() - life_.stopStartedMs < kRetirementTimeoutMs,
            "Output retirement exceeded10s", "ERR_SCREEN_CAPTURE_RETIREMENT");
        try { CheckParent(); PollInput(); }
        catch (const ContractError& error) { Fail(error.code, error.what()); }
        PumpMessages(); Sleep(5);
      }
      api().obs_output_release(output_); output_ = nullptr;
      Require(outputDestroyed_.load() && callbacks_.load() == 0,
          "Custom output release did not quiesce callbacks", "ERR_SCREEN_CAPTURE_RETIREMENT");
    }
    if (live_) live_->Stop(failed_.load() ? std::optional<Failure>{FirstFailure()} : std::nullopt);
    retirement_.outputStopped = true; retirement_.callbacksQuiesced = true;
    Snapshot();
    EndStage();
    BeginStage(NativeStage::SourceRelease);
    if (scene_ || source_) {
      // WGC merely stops ticking when hidden; wc_destroy then queues its real
      // destruction on GRAPHICS. Drain explicit queues without the stock
      // obs_wait_for_destroy_queue helper, which requires initialized audio.
      CoreBarrier(abi::TaskType::Graphics);
      if (scene_) { api().obs_scene_release(scene_); scene_ = nullptr; }
      CoreBarrier(abi::TaskType::Destroy);
      if (source_) { api().obs_source_release(source_); source_ = nullptr; }
      CoreBarrier(abi::TaskType::Destroy);
      CoreBarrier(abi::TaskType::Graphics);
    }
    retirement_.sourceReleased = true;
    EndStage();
    BeginStage(NativeStage::EncoderRelease);
    if (encoder_) { api().obs_encoder_release(encoder_); encoder_ = nullptr; }
    retirement_.encoderReleased = true;
    if (sourceSettings_) { api().obs_data_release(sourceSettings_); sourceSettings_ = nullptr; }
    if (encoderSettings_) { api().obs_data_release(encoderSettings_); encoderSettings_ = nullptr; }
    if (mainCanvas_) { api().obs_canvas_release(mainCanvas_); mainCanvas_ = nullptr; }
    canvasVideo_ = nullptr;
    EndStage();
    BeginStage(NativeStage::ObsShutdown);
    if (obsStarted_) { api().obs_shutdown(); obsStarted_ = false; videoStarted_ = false; }
    retirement_.obsShutdownReturned = true;
    EndStage();
    BeginStage(NativeStage::ComShutdown);
    if (comInitialized_) { CoUninitialize(); comInitialized_ = false; }
    EndStage();
    FlushLogs();
  }

  Arguments arguments_;
  Target target_;
  Parent parent_;
  std::unique_ptr<OwnedRun> run_;
  Libraries libraries_;
  std::string graphicsModulePath_;
  Common common_;
  EncoderCapability capability_;
  Lifecycle life_;
  Observation observation_;
  Retirement retirement_;
  std::optional<SourceKey> hooked_;
  HANDLE input_ = nullptr, outputPipe_ = nullptr, errorPipe_ = nullptr;
  abi::Source* source_ = nullptr;
  abi::Scene* scene_ = nullptr;
  abi::Canvas* mainCanvas_ = nullptr;
  abi::Video* canvasVideo_ = nullptr;
  abi::Encoder* encoder_ = nullptr;
  abi::Output* output_ = nullptr;
  abi::Output* callbackOutput_ = nullptr;
  abi::Data* sourceSettings_ = nullptr;
  abi::Data* encoderSettings_ = nullptr;
  std::unique_ptr<live::Output> live_;
  PacketStatistics buffer_;
  CommandFramer framer_;
  OutputBudget budget_;
  std::mutex bufferMutex_, failureMutex_, logMutex_;
  std::optional<Failure> failure_;
  std::array<char, kMaxStderrBytes - 1024> logBytes_{};
  std::size_t logUsed_ = 0, emergencyWritten_ = 0;
  std::atomic<bool> failed_{false}, emergencyFailure_{false}, strictEncoderWarnings_{false};
  std::atomic<bool> outputDestroyed_{true}, watchdogQuit_{false};
  std::atomic<bool> startupPaused_{false};
  std::atomic<unsigned> callbacks_{0};
  std::array<BarrierState, 4> barriers_{};
  std::size_t barrierCount_ = 0;
  std::atomic<Phase> phase_{Phase::Preparing};
  std::atomic<NativeStage> nativeStage_{NativeStage::Admission};
  std::atomic<std::uint64_t> captureStarted_{0}, stopStarted_{0}, progress_{0};
  std::thread watchdog_;
  const std::uint64_t processStarted_;
  DisplayChanges displayChanges_;
  void (*invalidateMonitorIdentity_)() = nullptr;
  std::uint64_t lastDisplayCheck_ = 0;
  bool eof_ = false, obsStarted_ = false, videoStarted_ = false, comInitialized_ = false;
  bool targetBound_ = false;
  bool matchingDevice_ = false, nvencProbeVerified_ = false, sourcePlatformVerified_ = false, encoderInitialized_ = false;
  bool amfColorNormalizationAllowed_ = false;
  std::atomic<bool> amfColorNormalizationLogged_{false};
};
}  // namespace

int wmain(int argc, wchar_t** argv) {
  try {
    live::FaultDiagnostics faultDiagnostics;
    std::vector<std::wstring_view> input;
    for (int i = 1; i < argc; ++i) input.emplace_back(argv[i]);
    auto arguments = ParseArguments(input);
    CheckWin(SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2),
        "ERR_SCREEN_CAPTURE_MONITOR_IDENTITY", "Physical pixel DPI awareness is required");
    auto parent = BindParent();
    Handle job(CreateJobObjectW(nullptr, nullptr));
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    Require(job && SetInformationJobObject(job.Get(), JobObjectExtendedLimitInformation, &limits, sizeof(limits)) &&
            AssignProcessToJobObject(job.Get(), GetCurrentProcess()),
            "Cannot own capture probe/helper descendants", "ERR_SCREEN_CAPTURE_PARENT");
    // This self-containing job has process lifetime. Closing it early would kill
    // the host before its retirement evidence reaches the parent.
    job.Take();
    auto run = std::make_unique<OwnedRun>(arguments, parent.pid);
    auto host = std::make_unique<Host>(std::move(arguments), std::move(parent), std::move(run));
    callbackHost = host.get();
    const auto result = host->Execute();
    faultDiagnostics.Close();
    // Callbacks and image references have process lifetime, including after
    // obs_shutdown. Avoid destructing their storage before actual process exit.
    host.release();
    return result;
  } catch (const ContractError& error) {
    std::fprintf(stderr, "%s: %.1024s\n", error.code.c_str(), error.what());
    return 1;
  } catch (const std::exception& error) {
    std::fprintf(stderr, "ERR_SCREEN_CAPTURE_NATIVE: %.1024s\n", error.what());
    return 1;
  } catch (...) {
    std::fprintf(stderr, "ERR_SCREEN_CAPTURE_NATIVE: unknown pre-initialization failure\n");
    return 1;
  }
}
