#include "engine_shared.h"
#include "capture_clock.h"

#include "api\make_ref_counted.h"
#include "api\video\color_space.h"
#include "media\base\video_broadcaster.h"
#include "modules\video_coding\include\video_error_codes.h"
#include "pc\video_track_source.h"

#include <dxgi1_4.h>

#include <algorithm>
#include <array>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <exception>
#include <limits>
#include <mutex>
#include <optional>
#include <thread>
#include <utility>

namespace monky::native_rtc::engine {
namespace {

namespace sv = ::monky::screen_video;
constexpr std::size_t kMaximumPool = 16;

struct SourceOptions {
  UINT width = 0, height = 0, fps = 0;
  std::size_t pool_size = 4;
  LUID adapter{};
  std::string sync_group;
  bool enabled = false;
};

std::int64_t Integer(const Json& object, const char* key,
                     std::int64_t minimum, std::int64_t maximum) {
  if (!object.is_object() || !object.contains(key) ||
      !object.at(key).is_number_integer()) {
    throw Error("ERR_RTC_ARGUMENT", std::string("Expected integer: ") + key,
                MONKY_ENGINE_INVALID);
  }
  const auto& number = object.at(key);
  if (number.is_number_unsigned()) {
    const auto value = number.get<std::uint64_t>();
    if (value <= static_cast<std::uint64_t>(maximum) &&
        (minimum <= 0 || value >= static_cast<std::uint64_t>(minimum))) {
      return static_cast<std::int64_t>(value);
    }
  } else {
    const auto value = number.get<std::int64_t>();
    if (value >= minimum && value <= maximum) return value;
  }
  throw Error("ERR_RTC_ARGUMENT", std::string("Integer outside source bounds: ") + key,
              MONKY_ENGINE_INVALID);
}

SourceOptions ParseOptions(const Json& options) {
  if (!options.is_object()) {
    throw Error("ERR_RTC_ARGUMENT", "Source options must be an object", MONKY_ENGINE_INVALID);
  }
  for (const auto& item : options.items()) {
    const auto& key = item.key();
    if (key != "width" && key != "height" && key != "fps" && key != "poolSize" &&
        key != "adapter" && key != "syncGroup" && key != "enabled") {
      throw Error("ERR_RTC_ARGUMENT",
                  "Unknown source option; only immutable BT.709-limited NV12 is supported",
                  MONKY_ENGINE_INVALID);
    }
  }
  SourceOptions result;
  result.width = static_cast<UINT>(Integer(options, "width", 16, 4096));
  result.height = static_cast<UINT>(Integer(options, "height", 16, 4096));
  result.fps = static_cast<UINT>(Integer(options, "fps", 1, 240));
  if ((result.width | result.height) & 1) {
    throw Error("ERR_RTC_ARGUMENT", "NV12 source dimensions must both be even",
                MONKY_ENGINE_INVALID);
  }
  if (options.contains("poolSize")) {
    result.pool_size = static_cast<std::size_t>(Integer(options, "poolSize", 2, kMaximumPool));
  }
  if (!options.contains("adapter") || !options.at("adapter").is_object()) {
    throw Error("ERR_RTC_ARGUMENT", "An explicit source adapter LUID is required",
                MONKY_ENGINE_INVALID);
  }
  const auto& adapter = options.at("adapter");
  for (const auto& item : adapter.items()) {
    if (item.key() != "luidLow" && item.key() != "luidHigh") {
      throw Error("ERR_RTC_ARGUMENT", "Unknown adapter option", MONKY_ENGINE_INVALID);
    }
  }
  result.adapter.LowPart = static_cast<DWORD>(
      Integer(adapter, "luidLow", 0, (std::numeric_limits<std::uint32_t>::max)()));
  result.adapter.HighPart = static_cast<LONG>(
      Integer(adapter, "luidHigh", (std::numeric_limits<std::int32_t>::min)(),
              (std::numeric_limits<std::int32_t>::max)()));
  result.sync_group = SyncGroup(options);
  result.enabled = Boolean(options, "enabled");
  return result;
}

struct Failure {
  std::array<char, 80> code{};
  std::array<char, 512> message{};
  MonkyEngineStatus status = MONKY_ENGINE_FAILURE;
  HRESULT hr = S_OK;
  bool terminal = false;
};

Failure MakeFailure(const char* code, const char* message,
                    MonkyEngineStatus status = MONKY_ENGINE_FAILURE, HRESULT hr = S_OK) noexcept {
  Failure result;
  std::snprintf(result.code.data(), result.code.size(), "%s", code);
  std::snprintf(result.message.data(), result.message.size(), "%s", message);
  result.status = status;
  result.hr = hr;
  return result;
}

class WorkerFailure final : public std::exception {
 public:
  explicit WorkerFailure(Failure failure) noexcept : failure(std::move(failure)) {}
  const char* what() const noexcept override { return failure.message.data(); }
  const Failure failure;
};

[[noreturn]] void Fail(const char* code, const char* message,
                       MonkyEngineStatus status = MONKY_ENGINE_FAILURE, HRESULT hr = S_OK) {
  throw WorkerFailure(MakeFailure(code, message, status, hr));
}

void RequireHr(HRESULT hr, const char* code, const char* message) {
  if (FAILED(hr)) Fail(code, message, MONKY_ENGINE_FAILURE, hr);
}

Failure CurrentFailure() noexcept {
  try {
    throw;
  } catch (const WorkerFailure& error) {
    return error.failure;
  } catch (const Error& error) {
    return MakeFailure(error.code.c_str(), error.what(), error.status, error.hr);
  } catch (const sv::EncoderError& error) {
    return MakeFailure(error.code.c_str(), error.what(), MONKY_ENGINE_FAILURE, error.hresult);
  } catch (const sv::DecoderError& error) {
    return MakeFailure(error.code.c_str(), error.what(), MONKY_ENGINE_FAILURE, error.hresult);
  } catch (const winrt::hresult_error& error) {
    return MakeFailure("ERR_RTC_SOURCE_COM", "A source COM operation failed",
                       MONKY_ENGINE_FAILURE, error.code());
  } catch (const std::bad_alloc& error) {
    return MakeFailure("ERR_RTC_MEMORY", error.what(), MONKY_ENGINE_FAILURE, E_OUTOFMEMORY);
  } catch (const std::exception& error) {
    // An opaque adapter exception need not have an HRESULT. Its detailed
    // diagnostics remain in the Host's shared MF context, not a second factory.
    return MakeFailure("ERR_RTC_SOURCE_EXCEPTION", error.what());
  } catch (...) {
    return MakeFailure("ERR_RTC_SOURCE_EXCEPTION", "An unknown source worker exception occurred");
  }
}

Failure ClosedFailure() noexcept {
  return MakeFailure("ERR_RTC_SOURCE_CLOSED", "Source stopped before this frame was published",
                     MONKY_ENGINE_CLOSED);
}

Failure DisabledFailure() noexcept {
  return MakeFailure("ERR_RTC_SOURCE_DISABLED", "Source was disabled before publication",
                     MONKY_ENGINE_BUSY);
}

Json FailureJson(const Failure& failure) {
  return {{"code", failure.code.data()}, {"message", failure.message.data()},
          {"status", static_cast<Json::number_integer_t>(failure.status)},
          {"hresult", static_cast<Json::number_integer_t>(failure.hr)}};
}

template <typename Function>
void OnSignaling(webrtc::Thread* signaling, Function&& function) {
  std::exception_ptr error;
  auto invoke = [&] {
    try {
      function();
    } catch (...) {
      error = std::current_exception();
    }
  };
  if (signaling->IsCurrent()) invoke();
  else signaling->BlockingCall(invoke);
  if (error) std::rethrow_exception(error);
}

class ImportedTrackSource : public webrtc::VideoTrackSource {
 public:
  ImportedTrackSource(UINT width, UINT height)
      : webrtc::VideoTrackSource(false), width_(width), height_(height) {}

  bool is_screencast() const override { return true; }
  std::optional<bool> needs_denoising() const override { return false; }
  bool GetStats(Stats* stats) override {
    if (!stats || !observed_frame_.load()) return false;
    stats->input_width = static_cast<int>(width_);
    stats->input_height = static_cast<int>(height_);
    return true;
  }
  void AddOrUpdateSink(webrtc::VideoSinkInterface<webrtc::VideoFrame>* sink,
                       const webrtc::VideoSinkWants& wants) override {
    std::lock_guard lock(sinks_mutex_);
    // VideoTrack::set_enabled(false) requests black frames. Removing that sink
    // preserves its mute without letting VideoBroadcaster fabricate I420 pixels.
    if (wants.black_frames) broadcaster_.RemoveSink(sink);
    else broadcaster_.AddOrUpdateSink(sink, wants);
  }
  void RemoveSink(webrtc::VideoSinkInterface<webrtc::VideoFrame>* sink) override {
    std::lock_guard lock(sinks_mutex_);
    broadcaster_.RemoveSink(sink);
  }
  void ProcessConstraints(const webrtc::VideoTrackSourceConstraints& constraints) override {
    std::lock_guard lock(sinks_mutex_);
    broadcaster_.ProcessConstraints(constraints);
  }
  bool Publish(const webrtc::VideoFrame& frame) {
    std::lock_guard lock(sinks_mutex_);
    if (!broadcaster_.frame_wanted()) return false;
    broadcaster_.OnFrame(frame);
    observed_frame_.store(true);
    return true;
  }
  bool HasEnabledSinks() {
    std::lock_guard lock(sinks_mutex_);
    return broadcaster_.frame_wanted();
  }

 protected:
  webrtc::VideoSourceInterface<webrtc::VideoFrame>* source() override { return &broadcaster_; }

 private:
  const UINT width_, height_;
  std::atomic<bool> observed_frame_{false};
  std::mutex sinks_mutex_;
  webrtc::VideoBroadcaster broadcaster_;
};

class FrameLease;
using FrameBatch = std::array<std::shared_ptr<FrameLease>, kMaximumPool>;

struct Counters {
  std::uint64_t admitted = 0, imported = 0, published = 0, no_sink_drops = 0, clock_drops = 0;
  std::uint64_t early_waits = 0, early_wait_us = 0, cancelled_drops = 0;
  std::uint64_t early_frames = 0;
  std::int64_t max_early_lead_us = 0;
  std::uint64_t readers_retired = 0, released = 0, dropped = 0, release_errors = 0;
  std::uint64_t rejected_closed = 0, rejected_disabled = 0, rejected_full = 0;
  std::uint64_t rejected_duplicate = 0, rejected_invalid = 0;
  std::uint64_t errors = 0, event_failures = 0, pending_release_events = 0;
  std::size_t retained = 0, peak_retained = 0;
};

struct SourceState {
  SourceState(Host& host, std::uint64_t id, SourceOptions options,
              std::shared_ptr<mf::NativeRtcContext> context,
              std::shared_ptr<CaptureClock> capture_clock)
      : host(host), id(id), options(std::move(options)), mf_context(std::move(context)),
        capture_clock(std::move(capture_clock)) {}

  void Report(const Failure& failure, bool terminal = false) noexcept {
    {
      std::lock_guard lock(mutex);
      ++counts.errors;
      last_error = failure;
      if (terminal) {
        failed = true;
        stopping.store(true);
        enabled.store(false);
      }
    }
    wake.notify_all();
    try {
      auto data = FailureJson(failure);
      data["terminal"] = terminal;
      if (host.Emit("error", id, std::move(data))) return;
    } catch (...) {
    }
    std::lock_guard lock(mutex);
    ++counts.event_failures;
  }

  // Called with mutex held. Destruction/Host callbacks always happen outside it.
  void TakeQueued(FrameBatch& removed) noexcept {
    queue.swap(removed);
    queue_head = queue_size = 0;
  }

  void Retire(std::size_t slot, bool published, Json event) noexcept {
    {
      std::lock_guard lock(mutex);
      // Actual readers are already retired. Free the native reservation before
      // its notice permits the producer to submit another frame or reuse an ID.
      live_ids[slot] = 0;
      --counts.retained;
      ++counts.readers_retired;
      if (!published) ++counts.dropped;
      if (!event.at("ok").get<Json::boolean_t>()) ++counts.release_errors;
    }
    const bool emitted = host.Emit("source.frameReleased", id, std::move(event));
    {
      std::lock_guard lock(mutex);
      if (emitted) ++counts.released;
      else {
        // The Host's input ledger still owns the producer obligation. Stop
        // admission, but never overwrite a slot reused during notice delivery.
        ++counts.event_failures;
        ++counts.pending_release_events;
        stopping.store(true);
        enabled.store(false);
      }
    }
    wake.notify_all();
    if (!emitted) {
      Report(MakeFailure("ERR_RTC_SOURCE_RELEASE_EVENT",
                         "Producer release event was rejected; host ownership remains pinned until engine close",
                         MONKY_ENGINE_QUEUE_FULL), true);
    }
  }

  Host& host;
  const std::uint64_t id;
  const SourceOptions options;
  const std::shared_ptr<mf::NativeRtcContext> mf_context;
  const std::shared_ptr<CaptureClock> capture_clock;
  CaptureClockSourceState capture_order;
  mutable std::mutex mutex;
  std::mutex publication_mutex;
  std::condition_variable wake;
  webrtc::scoped_refptr<ImportedTrackSource> track;
  FrameBatch queue;
  std::array<std::uint64_t, kMaximumPool> live_ids{};
  std::size_t queue_head = 0, queue_size = 0;
  std::uint64_t generation = 0;
  Counters counts;
  std::atomic<std::uint64_t> rejected_busy{0};
  std::atomic<bool> stopping{false}, enabled{false};
  std::atomic<DWORD> worker_thread_id{0};
  bool start_finished = false, initialized = false, failed = false, joined = false;
  std::optional<Failure> start_error, last_error;
  std::optional<std::int32_t> native_close_status;
};

struct DeviceResources {
  winrt::com_ptr<IDXGIFactory4> factory;
  winrt::com_ptr<IDXGIAdapter1> adapter;
  winrt::com_ptr<ID3D11Device> device;
  winrt::com_ptr<ID3D11Device1> importer;
  winrt::com_ptr<ID3D11Device5> device5;
  winrt::com_ptr<ID3D11DeviceContext4> context;
  winrt::com_ptr<ID3D11Fence> fence;
  std::uint64_t fence_value = 0;  // Written only by this source's import worker.
};

enum class FrameDrop { NoSinks, Clock, Cancelled };

class FrameLease {
 public:
  FrameLease(std::shared_ptr<SourceState> state, std::shared_ptr<InputFrame> input)
      : state(std::move(state)), input(std::move(input)), id(this->input->id),
        ntp_time_ms(this->input->ntp_time_ms),
        event_{{"sourceId", this->state->id}, {"frameId", id}, {"ok", false},
               {"error", FailureJson(MakeFailure(
                   "ERR_RTC_SOURCE_NOT_PUBLISHED", "Admitted source frame was not published"))}} {
    frame.timestampUs = this->input->timestamp_us;
    frame.durationUs = this->input->duration_us;
    auto& error = event_.at("error");
    error.at("code").get_ref<Json::string_t&>().reserve(80);
    error.at("message").get_ref<Json::string_t&>().reserve(512);
  }
  ~FrameLease() {
    if (!admitted) return;
    // The alias passed to WrapFrame owns this entire holder. Qualified MF
    // encoding/readback retain that alias until their actual GPU readers retire.
    frame.texture = nullptr;
    frame.readyFence = nullptr;
    keyed_mutex = nullptr;
    devices.reset();
    input.reset();
    state->Retire(slot, published_, std::move(event_));
  }
  FrameLease(const FrameLease&) = delete;
  FrameLease& operator=(const FrameLease&) = delete;

  void SetFailure(const Failure& failure) noexcept {
    // Storage is reserved before admission so the final release does not need
    // to allocate a JSON payload on an encoder/readback retirement thread.
    auto& error = event_.at("error");
    error.at("code").get_ref<Json::string_t&>().assign(failure.code.data());
    error.at("message").get_ref<Json::string_t&>().assign(failure.message.data());
    error.at("status").get_ref<Json::number_integer_t&>() = failure.status;
    error.at("hresult").get_ref<Json::number_integer_t&>() = failure.hr;
  }
  void SetPublished() noexcept {
    published_ = true;
    event_.at("ok").get_ref<Json::boolean_t&>() = true;
    event_.erase("error");
  }
  void SetDropped(FrameDrop reason) {
    event_.at("ok").get_ref<Json::boolean_t&>() = true;
    event_.erase("error");
    std::lock_guard lock(state->mutex);
    if (reason == FrameDrop::NoSinks) ++state->counts.no_sink_drops;
    else if (reason == FrameDrop::Clock) ++state->counts.clock_drops;
    else ++state->counts.cancelled_drops;
  }

  const std::shared_ptr<SourceState> state;
  std::shared_ptr<InputFrame> input;
  const std::uint64_t id;
  const std::int64_t ntp_time_ms;
  std::uint64_t generation = 0;
  std::size_t slot = 0;
  bool admitted = false;
  std::shared_ptr<DeviceResources> devices;
  winrt::com_ptr<IDXGIKeyedMutex> keyed_mutex;
  sv::GpuNv12Frame frame;

 private:
  bool published_ = false;
  Json event_;
};

void CancelBatch(FrameBatch& batch, const Failure& failure) noexcept {
  for (auto& frame : batch) {
    if (frame) {
      frame->SetFailure(failure);
      frame.reset();
    }
  }
}

void RequestStop(const std::shared_ptr<SourceState>& state) noexcept {
  FrameBatch cancelled;
  {
    std::lock_guard lock(state->mutex);
    state->stopping.store(true);
    state->enabled.store(false);
    state->TakeQueued(cancelled);
  }
  state->wake.notify_all();
  CancelBatch(cancelled, ClosedFailure());
}

void CheckStarting(const SourceState& state, const std::shared_ptr<Cancellation>& cancellation) {
  if (state.stopping.load()) throw WorkerFailure(ClosedFailure());
  if (cancellation) cancellation->Check();
}

void CheckPublication(const FrameLease& lease) {
  std::lock_guard lock(lease.state->mutex);
  if (lease.state->stopping.load()) throw WorkerFailure(ClosedFailure());
  if (!lease.state->enabled.load() || lease.generation != lease.state->generation) {
    throw WorkerFailure(DisabledFailure());
  }
}

std::shared_ptr<DeviceResources> CreateDevice(
    const SourceState& state, const std::shared_ptr<Cancellation>& cancellation) {
  CheckStarting(state, cancellation);
  auto result = std::make_shared<DeviceResources>();
  RequireHr(CreateDXGIFactory2(0, __uuidof(IDXGIFactory4), result->factory.put_void()),
            "ERR_RTC_SOURCE_DXGI", "Cannot create the source DXGI factory");
  CheckStarting(state, cancellation);
  RequireHr(result->factory->EnumAdapterByLuid(
                state.options.adapter, __uuidof(IDXGIAdapter1), result->adapter.put_void()),
            "ERR_RTC_SOURCE_ADAPTER", "Cannot open the explicitly selected source adapter");
  DXGI_ADAPTER_DESC1 description{};
  RequireHr(result->adapter->GetDesc1(&description),
            "ERR_RTC_SOURCE_ADAPTER", "Cannot inspect the selected source adapter");
  if (description.AdapterLuid.LowPart != state.options.adapter.LowPart ||
      description.AdapterLuid.HighPart != state.options.adapter.HighPart ||
      (description.Flags & DXGI_ADAPTER_FLAG_SOFTWARE)) {
    Fail("ERR_RTC_SOURCE_ADAPTER", "The selected adapter is not the requested GPU adapter",
         MONKY_ENGINE_UNSUPPORTED);
  }
  CheckStarting(state, cancellation);
  const D3D_FEATURE_LEVEL levels[]{D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0};
  const UINT flags = D3D11_CREATE_DEVICE_VIDEO_SUPPORT | D3D11_CREATE_DEVICE_BGRA_SUPPORT;
  winrt::com_ptr<ID3D11DeviceContext> immediate;
  auto hr = D3D11CreateDevice(
      result->adapter.get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr, flags, levels, 2,
      D3D11_SDK_VERSION, result->device.put(), nullptr, immediate.put());
  if (hr == E_INVALIDARG) {
    CheckStarting(state, cancellation);
    immediate = nullptr;
    result->device = nullptr;
    hr = D3D11CreateDevice(
        result->adapter.get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr, flags, levels + 1, 1,
        D3D11_SDK_VERSION, result->device.put(), nullptr, immediate.put());
  }
  RequireHr(hr, "ERR_RTC_SOURCE_DEVICE", "Cannot create D3D11 on the requested source adapter");
  CheckStarting(state, cancellation);
  RequireHr(result->device->QueryInterface(__uuidof(ID3D11Device1), result->importer.put_void()),
            "ERR_RTC_SOURCE_DEVICE", "Source device cannot import NT texture handles");
  RequireHr(result->device->QueryInterface(__uuidof(ID3D11Device5), result->device5.put_void()),
            "ERR_RTC_SOURCE_DEVICE", "Source device does not support D3D11 fences");
  RequireHr(immediate->QueryInterface(__uuidof(ID3D11DeviceContext4), result->context.put_void()),
            "ERR_RTC_SOURCE_CONTEXT", "Source context does not support D3D11 fences");
  if (result->context->GetType() != D3D11_DEVICE_CONTEXT_IMMEDIATE) {
    Fail("ERR_RTC_SOURCE_CONTEXT", "An immediate source context is required",
         MONKY_ENGINE_UNSUPPORTED);
  }
  winrt::com_ptr<ID3D11Multithread> multithread;
  RequireHr(immediate->QueryInterface(__uuidof(ID3D11Multithread), multithread.put_void()),
            "ERR_RTC_SOURCE_MULTITHREAD", "Cannot protect the shared source context");
  multithread->SetMultithreadProtected(TRUE);
  if (!multithread->GetMultithreadProtected()) {
    Fail("ERR_RTC_SOURCE_MULTITHREAD", "Source context multithread protection was not enabled");
  }
  RequireHr(result->device5->CreateFence(
                0, D3D11_FENCE_FLAG_NONE, __uuidof(ID3D11Fence), result->fence.put_void()),
            "ERR_RTC_SOURCE_FENCE", "Cannot create the source readiness fence");
  CheckStarting(state, cancellation);
  return result;
}

void ImportFrame(const std::shared_ptr<DeviceResources>& devices, FrameLease& lease) {
  CheckPublication(lease);
  lease.devices = devices;
  RequireHr(devices->importer->OpenSharedResource1(
                lease.input->texture, __uuidof(ID3D11Texture2D), lease.frame.texture.put_void()),
            "ERR_RTC_SOURCE_IMPORT", "Cannot import the producer NT texture on this source device");
  D3D11_TEXTURE2D_DESC description{};
  lease.frame.texture->GetDesc(&description);
  const auto& options = lease.state->options;
  if (description.Format != DXGI_FORMAT_NV12 || description.Width != options.width ||
      description.Height != options.height || description.Usage != D3D11_USAGE_DEFAULT ||
      description.CPUAccessFlags != 0 || description.MipLevels != 1 ||
      description.ArraySize != 1 || description.SampleDesc.Count != 1 ||
      description.SampleDesc.Quality != 0 ||
      !(description.MiscFlags & D3D11_RESOURCE_MISC_SHARED_NTHANDLE) ||
      !(description.MiscFlags & D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX)) {
    Fail("ERR_RTC_SOURCE_TEXTURE", "Producer must lease an exact, single-subresource keyed NT NV12 texture",
         MONKY_ENGINE_INVALID);
  }
  RequireHr(lease.frame.texture->QueryInterface(
                __uuidof(IDXGIKeyedMutex), lease.keyed_mutex.put_void()),
            "ERR_RTC_SOURCE_MUTEX", "Producer texture has no keyed mutex");
  if (devices->fence_value >= (std::numeric_limits<std::uint64_t>::max)() - 1) {
    Fail("ERR_RTC_SOURCE_FENCE_EXHAUSTED", "Source readiness fence sequence is exhausted");
  }
  CheckPublication(lease);
  const auto acquired = lease.keyed_mutex->AcquireSync(0, 0);
  // WAIT_TIMEOUT and WAIT_ABANDONED are nonnegative, but neither grants a lease.
  if (acquired != S_OK) {
    Fail("ERR_RTC_SOURCE_NOT_READY", "Producer keyed mutex key 0 is not available",
         acquired == static_cast<HRESULT>(WAIT_TIMEOUT) ? MONKY_ENGINE_BUSY : MONKY_ENGINE_FAILURE,
         acquired);
  }
  // No GPU reads/copies or throwing operations occur while this lock is held.
  // The producer's immutable lease, not this transient mutex acquisition, keeps
  // the imported bytes stable for all subsequently qualified native consumers.
  const auto released = lease.keyed_mutex->ReleaseSync(0);
  if (released != S_OK) {
    Fail("ERR_RTC_SOURCE_MUTEX", "Cannot release producer keyed mutex key 0",
         MONKY_ENGINE_FAILURE, released);
  }
  lease.frame.subresource = 0;
  lease.frame.readyFence = devices->fence;
  lease.frame.readyValue = ++devices->fence_value;
  const auto signal = devices->context->Signal(devices->fence.get(), lease.frame.readyValue);
  devices->context->Flush();
  RequireHr(signal, "ERR_RTC_SOURCE_FENCE", "Cannot signal the local source readiness fence");
  RequireHr(devices->device->GetDeviceRemovedReason(),
            "ERR_RTC_SOURCE_DEVICE_LOST", "The source device was lost during import");
  std::lock_guard lock(lease.state->mutex);
  ++lease.state->counts.imported;
}

std::uint32_t RtpTimestamp(std::int64_t timestamp_us) noexcept {
  const auto timestamp = static_cast<std::uint64_t>(timestamp_us);
  // Compute 90 kHz from the original microseconds, without an overflowing
  // multiply, a replacement wall clock, or a frame-ID-derived timestamp.
  return static_cast<std::uint32_t>(
      (timestamp / 1000000) * 90000 + ((timestamp % 1000000) * 90000) / 1000000);
}

void PublishFrame(const std::shared_ptr<DeviceResources>& devices,
                  const std::shared_ptr<mf::NativeGpuSource>& native,
                  ImportedTrackSource& track, const std::shared_ptr<FrameLease>& lease) {
  // Before Watch, disabled publications deliberately expose no video sinks.
  // This is an unused lease retirement, not a capture failure or RTP delivery.
  if (!track.HasEnabledSinks()) {
    lease->SetDropped(FrameDrop::NoSinks);
    return;
  }
  ImportFrame(devices, *lease);
  CheckPublication(*lease);
  // This shared_ptr and its control block never cross the DLL's C ABI.
  const std::shared_ptr<const sv::GpuNv12Frame> frame(lease, &lease->frame);
  auto buffer = native->WrapFrame(frame);
  if (!buffer) {
    Fail("ERR_RTC_SOURCE_WRAP", "Native MF source rejected the lease; consult shared MF diagnostics");
  }
  const auto actual = lease->state->mf_context->GetGpuFrame(buffer);
  if (buffer->type() != webrtc::VideoFrameBuffer::Type::kNative || !actual ||
      actual.get() != frame.get() || buffer->width() != static_cast<int>(lease->state->options.width) ||
      buffer->height() != static_cast<int>(lease->state->options.height)) {
    Fail("ERR_RTC_SOURCE_BUFFER", "MF source did not return this real native GPU lease");
  }
  const webrtc::ColorSpace color(
      webrtc::ColorSpace::PrimaryID::kBT709, webrtc::ColorSpace::TransferID::kBT709,
      webrtc::ColorSpace::MatrixID::kBT709, webrtc::ColorSpace::RangeID::kLimited);
  auto capture_time = lease->state->capture_clock->Map(
      lease->frame.timestampUs, lease->state->capture_order);
  if (capture_time.status == CaptureClockStatus::kFutureCapture) {
    std::lock_guard lock(lease->state->mutex);
    ++lease->state->counts.early_frames;
    lease->state->counts.max_early_lead_us = (std::max)(lease->state->counts.max_early_lead_us,
        capture_time.capture_timestamp_us - capture_time.paired_qpc_us);
  }
  if (const auto wait_us = CaptureClockEarlyWaitUs(capture_time, 1000000 / lease->state->options.fps)) {
    // WGC can deliver a compositor timestamp slightly ahead of local QPC.
    // Wait once for that real deadline on this worker; never rewrite the PTS.
    const auto began = std::chrono::steady_clock::now();
    bool cancelled;
    {
      std::unique_lock lock(lease->state->mutex);
      cancelled = lease->state->wake.wait_for(lock, std::chrono::microseconds(wait_us), [&] {
        return lease->state->stopping.load() || !lease->state->enabled.load() ||
               lease->generation != lease->state->generation;
      });
      ++lease->state->counts.early_waits;
      lease->state->counts.early_wait_us += std::chrono::duration_cast<std::chrono::microseconds>(
          std::chrono::steady_clock::now() - began).count();
    }
    if (cancelled) {
      lease->SetDropped(FrameDrop::Cancelled);
      return;
    }
    capture_time = lease->state->capture_clock->Map(
        lease->frame.timestampUs, lease->state->capture_order);
  }
  if (capture_time.status != CaptureClockStatus::kOk) {
    if (!CaptureClockRequiresReset(capture_time.status)) {
      // Per-frame clock rejection is accounted by the mapper and drop counters.
      // Retire its real GPU readers without retiming it or stopping other frames.
      lease->SetDropped(FrameDrop::Clock);
      return;
    }
    auto failure = MakeFailure(CaptureClockErrorCode(capture_time.status),
                               CaptureClockErrorMessage(capture_time.status));
    std::snprintf(failure.message.data(), failure.message.size(),
                  "%s (captureUs=%lld, pairedQpcUs=%lld, pairedRtcUs=%lld)",
                  CaptureClockErrorMessage(capture_time.status),
                  static_cast<long long>(lease->frame.timestampUs),
                  static_cast<long long>(capture_time.paired_qpc_us),
                  static_cast<long long>(capture_time.paired_rtc_us));
    failure.terminal = CaptureClockRequiresReset(capture_time.status);
    throw WorkerFailure(failure);
  }
  const auto video = webrtc::VideoFrame::Builder()
                         .set_video_frame_buffer(buffer)
                         .set_timestamp_us(capture_time.timestamp_us)
                         .set_rtp_timestamp(RtpTimestamp(lease->frame.timestampUs))
                         .set_ntp_time_ms(lease->ntp_time_ms)
                         .set_rotation(webrtc::kVideoRotation_0)
                         .set_color_space(&color)
                         .build();
  // Submit never takes this gate. SetEnabled(false) synchronizes with actual
  // delivery, while a generation change also invalidates already dequeued work.
  std::lock_guard publication(lease->state->publication_mutex);
  CheckPublication(*lease);
  if (!track.Publish(video)) {
    lease->SetDropped(FrameDrop::NoSinks);
    return;
  }
  {
    std::lock_guard lock(lease->state->mutex);
    ++lease->state->counts.published;
  }
  lease->SetPublished();
}

struct Apartment {
  ~Apartment() { if (initialized) CoUninitialize(); }
  bool initialized = false;
};

void RunSource(const std::shared_ptr<SourceState>& state,
               const webrtc::scoped_refptr<ImportedTrackSource>& track,
               webrtc::Thread* signaling, const std::shared_ptr<Cancellation>& cancellation) noexcept {
  state->worker_thread_id.store(GetCurrentThreadId());
  Apartment apartment;
  std::shared_ptr<DeviceResources> devices;
  std::shared_ptr<mf::NativeGpuSource> native;
  bool started = false;
  try {
    CheckStarting(*state, cancellation);
    RequireHr(CoInitializeEx(nullptr, COINIT_MULTITHREADED),
              "ERR_RTC_SOURCE_MTA", "Cannot initialize the source worker MTA");
    apartment.initialized = true;
    devices = CreateDevice(*state, cancellation);
    native = state->mf_context->CreateSource(devices->device.get(), devices->context.get());
    if (!native) Fail("ERR_RTC_SOURCE_NATIVE", "Shared MF context did not create a native source");
    CheckStarting(*state, cancellation);
    {
      std::lock_guard lock(state->mutex);
      state->initialized = state->start_finished = true;
      state->enabled.store(state->options.enabled);
    }
    started = true;
    state->wake.notify_all();
    for (;;) {
      std::shared_ptr<FrameLease> frame;
      {
        std::unique_lock lock(state->mutex);
        state->wake.wait(lock, [&] { return state->stopping.load() || state->queue_size != 0; });
        if (state->stopping.load()) break;
        frame = std::move(state->queue[state->queue_head]);
        state->queue_head = (state->queue_head + 1) % state->options.pool_size;
        --state->queue_size;
      }
      try {
        PublishFrame(devices, native, *track, frame);
      } catch (...) {
        const auto failure = CurrentFailure();
        frame->SetFailure(failure);
        const bool device_lost = failure.hr == DXGI_ERROR_DEVICE_REMOVED ||
                                 failure.hr == DXGI_ERROR_DEVICE_RESET ||
                                 failure.hr == DXGI_ERROR_DEVICE_HUNG ||
                                 failure.hr == DXGI_ERROR_DRIVER_INTERNAL_ERROR;
        state->Report(failure, device_lost || failure.terminal);
      }
      // Destruction here is NOT necessarily producer release: published native
      // buffers/encoder input-copy fences/readback jobs own the alias independently.
      frame.reset();
    }
  } catch (...) {
    const auto failure = CurrentFailure();
    state->Report(failure, true);
    if (!started) {
      std::lock_guard lock(state->mutex);
      state->start_error = failure;
    }
  }
  RequestStop(state);
  {
    std::lock_guard lock(state->mutex);
    state->start_finished = true;
  }
  state->wake.notify_all();
  if (native) {
    try {
      const auto status = native->Close();
      {
        std::lock_guard lock(state->mutex);
        state->native_close_status = status;
      }
      if (status != WEBRTC_VIDEO_CODEC_OK) {
        state->Report(MakeFailure(
            "ERR_RTC_SOURCE_NATIVE_CLOSE", "Native source stop is not complete; its MF owner remains retained",
            status == WEBRTC_VIDEO_CODEC_TIMEOUT ? MONKY_ENGINE_TIMEOUT : MONKY_ENGINE_FAILURE));
      }
    } catch (...) {
      state->Report(CurrentFailure(), true);
    }
    native.reset();
  }
  devices.reset();
  try {
    // Never synchronously call signaling from this worker: Close may be joining
    // us there. A queued task must not keep a Host/track alive past source Close.
    signaling->PostTask([weak_state = std::weak_ptr<SourceState>(state)] {
      const auto state = weak_state.lock();
      if (!state) return;
      try {
        webrtc::scoped_refptr<ImportedTrackSource> track;
        {
          std::lock_guard lock(state->mutex);
          track = state->track;
        }
        if (!track) return;
        track->SetState(webrtc::MediaSourceInterface::kEnded);
      } catch (...) {
        state->Report(CurrentFailure(), true);
      }
    });
  } catch (...) {
    state->Report(CurrentFailure(), true);
  }
  state->worker_thread_id.store(0);
}

class ExternalGpuSource final : public VideoSource {
 public:
  ExternalGpuSource(Host& host, std::uint64_t id, SourceOptions options,
                    std::shared_ptr<mf::NativeRtcContext> context,
                    std::shared_ptr<CaptureClock> capture_clock)
      : state_(std::make_shared<SourceState>(host, id, std::move(options), std::move(context),
                                            std::move(capture_clock))),
        signaling_(host.SignalingThread()) {}

  ~ExternalGpuSource() override { Close(); }

  void Start(const std::shared_ptr<Cancellation>& cancellation) {
    CheckStarting(*state_, cancellation);
    OnSignaling(signaling_, [&] {
      auto track = webrtc::make_ref_counted<ImportedTrackSource>(
          state_->options.width, state_->options.height);
      std::lock_guard lock(state_->mutex);
      state_->track = std::move(track);
    });
    CheckStarting(*state_, cancellation);
    const auto state = state_;
    webrtc::scoped_refptr<ImportedTrackSource> track;
    {
      std::lock_guard lock(state_->mutex);
      track = state_->track;
    }
    worker_ = std::thread([state, track, signaling = signaling_, cancellation] {
      RunSource(state, track, signaling, cancellation);
    });
    std::optional<Failure> failure;
    {
      std::unique_lock lock(state_->mutex);
      while (!state_->start_finished) {
        // Cancellation is out of band and need not know this source's CV.
        state_->wake.wait_for(lock, std::chrono::milliseconds(20));
        if (cancellation) cancellation->Check();
      }
      failure = state_->start_error;
    }
    if (failure) {
      throw Error(failure->code.data(), failure->message.data(), failure->status, failure->hr);
    }
    CheckStarting(*state_, cancellation);
    OnSignaling(signaling_, [&] { track->SetState(webrtc::MediaSourceInterface::kLive); });
    CheckStarting(*state_, cancellation);
  }

  webrtc::scoped_refptr<webrtc::VideoTrackSourceInterface> TrackSource() const override {
    std::lock_guard lock(state_->mutex);
    return state_->track;
  }
  const std::string& SyncGroup() const override { return state_->options.sync_group; }
  bool Enabled() const override { return state_->enabled.load() && !state_->stopping.load(); }

  void SetEnabled(bool enabled) override {
    FrameBatch cancelled;
    {
      std::lock_guard publication(state_->publication_mutex);
      std::lock_guard lock(state_->mutex);
      if (state_->stopping.load()) {
        throw Error("ERR_RTC_SOURCE_CLOSED", "The source is closed", MONKY_ENGINE_CLOSED);
      }
      if (state_->enabled.load() == enabled) return;
      if (state_->generation == (std::numeric_limits<std::uint64_t>::max)()) {
        throw Error("ERR_RTC_SOURCE_GENERATION", "Source publication generation is exhausted");
      }
      ++state_->generation;
      state_->enabled.store(enabled);
      if (!enabled) state_->TakeQueued(cancelled);
    }
    CancelBatch(cancelled, DisabledFailure());
    state_->wake.notify_all();
  }

  void Submit(std::shared_ptr<InputFrame> input) override {
    // No GPU/context calls, worker waits, publication locks, or unbounded queue.
    std::unique_lock lock(state_->mutex, std::try_to_lock);
    if (!lock.owns_lock()) {
      ++state_->rejected_busy;
      throw Error("ERR_RTC_SOURCE_BUSY", "Source admission is busy; retry without transferring the lease",
                  MONKY_ENGINE_BUSY);
    }
    if (state_->stopping.load()) {
      ++state_->counts.rejected_closed;
      throw Error("ERR_RTC_SOURCE_CLOSED", "The source is closed", MONKY_ENGINE_CLOSED);
    }
    if (!state_->enabled.load()) {
      ++state_->counts.rejected_disabled;
      throw Error("ERR_RTC_SOURCE_DISABLED", "The source is disabled", MONKY_ENGINE_BUSY);
    }
    if (!input || !input->texture || input->texture == INVALID_HANDLE_VALUE ||
        !input->id || input->id > kMaxId || input->timestamp_us < 0 ||
        input->timestamp_us > (std::numeric_limits<std::int64_t>::max)() / 10 ||
        input->duration_us <= 0 || input->duration_us > 1000000 ||
        input->ntp_time_ms < -1 ||
        input->ntp_time_ms > (std::numeric_limits<std::int64_t>::max)() / 1000) {
      ++state_->counts.rejected_invalid;
      throw Error("ERR_RTC_SOURCE_FRAME", "A leased NT texture and real bounded frame timing/ID are required",
                  MONKY_ENGINE_INVALID);
    }
    std::size_t slot = state_->options.pool_size;
    for (std::size_t i = 0; i < state_->options.pool_size; ++i) {
      if (state_->live_ids[i] == input->id) {
        ++state_->counts.rejected_duplicate;
        throw Error("ERR_RTC_SOURCE_FRAME_ID", "The input frame ID still has a live admission",
                    MONKY_ENGINE_INVALID);
      }
      if (!state_->live_ids[i]) slot = i;
    }
    if (slot == state_->options.pool_size ||
        state_->counts.retained >= state_->options.pool_size) {
      ++state_->counts.rejected_full;
      throw Error("ERR_RTC_SOURCE_FULL", "The source's total retained-frame budget is full",
                  MONKY_ENGINE_QUEUE_FULL);
    }
    // All potentially throwing construction precedes the admission commit.
    // In particular, a rejected Submit must never emit source.frameReleased.
    auto lease = std::make_shared<FrameLease>(state_, std::move(input));
    lease->slot = slot;
    lease->generation = state_->generation;
    state_->live_ids[slot] = lease->id;
    lease->admitted = true;
    state_->queue[(state_->queue_head + state_->queue_size) % state_->options.pool_size] = std::move(lease);
    ++state_->queue_size;
    ++state_->counts.retained;
    ++state_->counts.admitted;
    state_->counts.peak_retained = (std::max)(state_->counts.peak_retained, state_->counts.retained);
    // No accepted frame reference remains on the submitter. Even if the worker
    // retires it immediately, GPU COM destruction cannot migrate onto Node here.
    lock.unlock();
    // The caller installs release tracking before Submit: release can race return.
    state_->wake.notify_one();
  }

  void Close() override {
    {
      std::lock_guard lock(state_->mutex);
      if (state_->joined) return;
    }
    // The worker captures shared state, never this object; destruction therefore
    // cannot be caused by its last frame reference on that worker.
    if (state_->worker_thread_id.load() == GetCurrentThreadId()) {
      RequestStop(state_);
      throw Error("ERR_RTC_SOURCE_SELF_CLOSE", "Source stop requested; its owner must join the worker",
                  MONKY_ENGINE_BUSY);
    }
    std::lock_guard close(close_mutex_);
    {
      std::lock_guard lock(state_->mutex);
      if (state_->joined) return;
    }
    RequestStop(state_);
    {
      std::lock_guard publication(state_->publication_mutex);
    }
    // Joining is intentionally not converted into a timeout that drops ownership.
    // A Host wait timeout must retain its actor/source while a driver call retires.
    if (worker_.joinable()) worker_.join();
    {
      std::lock_guard lock(state_->mutex);
      state_->joined = true;
    }
    try {
      OnSignaling(signaling_, [&] {
        // VideoTrack::Create installs the downstream signaling/worker proxy.
        // End and drop our own source reference here too, including on errors.
        webrtc::scoped_refptr<ImportedTrackSource> track;
        {
          std::lock_guard lock(state_->mutex);
          track = std::move(state_->track);
        }
        if (track) track->SetState(webrtc::MediaSourceInterface::kEnded);
      });
    } catch (...) {
      state_->Report(CurrentFailure(), true);
    }
  }

  Json Snapshot() const override {
    Counters counts;
    std::size_t queued;
    bool initialized, failed, joined, enabled, stopping;
    std::optional<Failure> error;
    std::optional<std::int32_t> native_close;
    {
      std::lock_guard lock(state_->mutex);
      counts = state_->counts;
      queued = state_->queue_size;
      initialized = state_->initialized;
      failed = state_->failed;
      joined = state_->joined;
      enabled = state_->enabled.load();
      stopping = state_->stopping.load();
      error = state_->last_error;
      native_close = state_->native_close_status;
    }
    const auto& options = state_->options;
    Json result{
        {"sourceId", state_->id}, {"syncGroup", options.sync_group},
        {"width", options.width}, {"height", options.height}, {"requestedFps", options.fps},
        {"poolSize", options.pool_size}, {"format", "NV12"}, {"colorSpace", "BT709-limited"},
        {"adapter", {{"luidLow", options.adapter.LowPart}, {"luidHigh", options.adapter.HighPart}}},
        {"enabled", enabled && !stopping}, {"initialized", initialized}, {"workerJoined", joined},
        {"state", failed ? "failed" : joined ? "closed" : stopping ? "stopping" : initialized ? "live" : "starting"},
        {"admitted", counts.admitted}, {"retained", counts.retained}, {"peakRetained", counts.peak_retained},
        {"queued", queued}, {"imported", counts.imported}, {"published", counts.published},
        {"readersRetired", counts.readers_retired}, {"released", counts.released},
        {"dropped", counts.dropped}, {"droppedNoSinks", counts.no_sink_drops},
        {"droppedClock", counts.clock_drops},
        {"droppedCancelled", counts.cancelled_drops},
        {"earlyCaptureWaits", counts.early_waits}, {"earlyCaptureWaitUs", counts.early_wait_us},
        {"earlyCaptureFrames", counts.early_frames},
        {"maxEarlyCaptureLeadUs", counts.early_frames ? Json(counts.max_early_lead_us) : Json(nullptr)},
        {"releaseErrors", counts.release_errors},
        {"rejectedBusy", state_->rejected_busy.load()}, {"rejectedClosed", counts.rejected_closed},
        {"rejectedDisabled", counts.rejected_disabled}, {"rejectedFull", counts.rejected_full},
        {"rejectedDuplicate", counts.rejected_duplicate}, {"rejectedInvalid", counts.rejected_invalid},
        {"errors", counts.errors}, {"eventFailures", counts.event_failures},
        {"pendingReleaseEvents", counts.pending_release_events},
        {"hardwareExecutionObserved", nullptr}};
    result["lastError"] = error ? FailureJson(*error) : Json(nullptr);
    result["nativeCloseStatus"] = native_close ? Json(*native_close) : Json(nullptr);
    const auto clock = state_->capture_clock->Snapshot();
    result["captureClock"] = {
        {"scope", "engine"}, {"initialized", clock.initialized},
        {"resetRequired", clock.reset_required}, {"closed", clock.closed},
        {"pairedSamples", clock.paired_samples},
        {"calibrationSamples", clock.calibration_samples},
        {"lastResult", CaptureClockErrorCode(clock.last.status)},
        {"lastQpcNowUs", clock.last.paired_qpc_us}, {"lastRtcNowUs", clock.last.paired_rtc_us},
        {"lastAlignedNowUs", clock.last.aligned_now_us},
        {"lastCaptureTimestampUs", clock.last.capture_timestamp_us},
        {"lastCaptureAgeUs", clock.last.capture_age_us},
        {"lastMappedTimestampUs", clock.last.timestamp_us},
        {"lastSampleUncertaintyUs", clock.last.sample_uncertainty_us},
        {"maxCaptureAgeUs", CaptureClockPolicy::kMaxCaptureAgeUs},
        {"maxSampleSpanUs", CaptureClockPolicy::kMaxSampleSpanUs},
        {"maxAlignmentErrorUs", CaptureClockPolicy::kMaxAlignmentErrorUs},
        {"calibrationIntervalUs", CaptureClockPolicy::kCalibrationIntervalUs}};
    auto& results = result["captureClock"]["results"];
    results = Json::object();
    for (std::size_t i = 0; i < clock.results.size(); ++i) {
      results[CaptureClockErrorCode(static_cast<CaptureClockStatus>(i))] = clock.results[i];
    }
    return result;
  }

 private:
  const std::shared_ptr<SourceState> state_;
  webrtc::Thread* const signaling_;
  std::mutex close_mutex_;
  std::thread worker_;
};

}  // namespace

std::shared_ptr<VideoSource> CreateGpuSource(
    Host& host, std::uint64_t id, const Json& options,
    const std::shared_ptr<Cancellation>& cancellation) {
  if (!id || id > kMaxId) {
    throw Error("ERR_RTC_ARGUMENT", "A safe nonzero source ID is required", MONKY_ENGINE_INVALID);
  }
  auto parsed = ParseOptions(options);
  if (cancellation) cancellation->Check();
  auto context = host.MfContext();
  auto capture_clock = host.CaptureTimebase();
  if (!capture_clock) {
    throw Error("ERR_RTC_CAPTURE_CLOCK_MISSING",
                "Source requires the shared engine environment capture clock",
                MONKY_ENGINE_CLOSED);
  }
  const auto clock_state = capture_clock->Snapshot();
  if (clock_state.closed || clock_state.reset_required) {
    const auto status = clock_state.closed ? CaptureClockStatus::kClosed
                                          : CaptureClockStatus::kClockResetRequired;
    throw Error(CaptureClockErrorCode(status), CaptureClockErrorMessage(status), MONKY_ENGINE_CLOSED);
  }
  if (!host.SignalingThread() || !context) {
    throw Error("ERR_RTC_SOURCE_HOST", "Source requires the Host's signaling thread and real MF context",
                MONKY_ENGINE_CLOSED);
  }
  auto source = std::make_shared<ExternalGpuSource>(
      host, id, std::move(parsed), std::move(context), std::move(capture_clock));
  try {
    source->Start(cancellation);
  } catch (const WorkerFailure& error) {
    throw Error(error.failure.code.data(), error.what(), error.failure.status, error.failure.hr);
  }
  return source;
}

}  // namespace monky::native_rtc::engine
