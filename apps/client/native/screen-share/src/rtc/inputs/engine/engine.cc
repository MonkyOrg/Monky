#include "engine_shared.h"
#include "resource_registry.h"
#include "operation_completion.h"
#include "capture_clock.h"
#include "encoded_video.h"
#include "encoder_diagnostics.h"
#include "decoder_diagnostics.h"
#include "receive_routes.h"
#include "presentation\presentation.h"
#include "audio\runtime.h"

#include "audio\stereo_opus.h"
#include "api\create_peerconnection_factory.h"
#include "api\environment\environment_factory.h"
#include "rtc_base\ssl_adapter.h"

#include <algorithm>
#include <array>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <deque>
#include <limits>
#include <map>
#include <mutex>
#include <optional>
#include <thread>
#include <utility>

namespace monky::native_rtc::engine {
namespace {

constexpr char kCapabilities[] =
   R"({"abiVersion":2,"contractRevision":7,"audioExtensionVersion":1,"inputLeaseCorrelation":true,"pairedCaptureClock":true,"p2pReceiverRouting":true,"pcmTrackInput":true,"creditAudioPlayout":true,"calibratedAudioOutputClock":true,"perShareAvGroups":true,"sfuExplicitStreamId":true,"audioOutputInvalidation":true,"opusStereoNegotiation":true,"audioPreAdmissionRetry":true,"ownerScopedAudioOutput":true,"audioOutputEpochAdmission":true,"externallyEncodedH264":true,"encodedInputCopied":true,"encodedFeedback":true,"encodedProfileLevelId":"4d0033","encodedBitrateCeilingBps":20000000,"encodedInputMaximumBytes":4194304,"availabilityScope":"compiled-implementation-not-device-probe","videoAvailable":true,"p2pAvailable":true,"sfuAvailable":true,"audioAvailable":true,"audioRuntimeQualified":false,"captureAvailable":false,"presentationAvailable":true,"presentationStage":"shared-nv12-export-only-runtime-unqualified","presentationRuntimeQualified":false,"runtimeQualified":false,"hardwareExecutionObserved":null,"inputFormat":"NV12_SHARED_NT_KEY0","inputTimebase":"qpc-system-relative-us","encodedInputFormat":"H264_ANNEX_B","decodedOutput":"NV12_SHARED_NT_LEASE","decodedTimestampSemantics":"rtc-render-deadline-or-immediate-us","audioInputFormat":"FLOAT32LE_ORIGINAL_PACKET","audioPlayoutFormat":"FLOAT32_STEREO_48000_480","codecs":["H264-constrained-baseline","H264-main","Opus-48000-2"],"scalabilityModes":["L1T1"]})";
static_assert(MONKY_ENGINE_ABI_VERSION == 2 && MONKY_ENGINE_CONTRACT_REVISION == 7);

Json ErrorJson(const Error& error) {
  return {{"code", error.code}, {"message", error.what()}, {"status", error.status},
          {"hresult", static_cast<std::int32_t>(error.hr)}};
}

Error CurrentError() {
  try { throw; }
  catch (const Error& error) { return error; }
  catch (const audio::AudioError& error) {
    return Error("ERR_RTC_AUDIO", error.what(),
        error.failure == audio::Failure::Closed ? MONKY_ENGINE_CLOSED : MONKY_ENGINE_INVALID);
  }
  catch (const winrt::hresult_error& error) {
    return Error("ERR_RTC_COM", "A native COM operation failed", MONKY_ENGINE_FAILURE, error.code());
  }
  catch (const std::bad_alloc&) {
    return Error("ERR_RTC_MEMORY", "Native allocation failed", MONKY_ENGINE_FAILURE, E_OUTOFMEMORY);
  }
  catch (const std::exception&) { return Error("ERR_RTC_NATIVE", "Native operation failed"); }
  catch (...) { return Error("ERR_RTC_NATIVE", "Unknown native operation failure"); }
}

std::string Bytes(const char* value, std::uint32_t count, std::size_t maximum) {
  if (!value || !count || count > maximum || std::memchr(value, '\0', count))
    throw Error("ERR_RTC_ARGUMENT", "Expected bounded non-NUL UTF-8 bytes", MONKY_ENGINE_INVALID);
  return {value, count};
}

Json Parse(const char* value, std::uint32_t count) {
  auto text = Bytes(value, count, kMaxJson);
  try {
    auto result = Json::parse(text, [](int depth, Json::parse_event_t, Json&) {
      if (depth > 32) throw Error("ERR_RTC_ARGUMENT", "JSON nesting exceeds 32", MONKY_ENGINE_INVALID);
      return true;
    });
    if (!result.is_object())
      throw Error("ERR_RTC_ARGUMENT", "Expected a JSON object", MONKY_ENGINE_INVALID);
    return result;
  } catch (const Json::exception&) {
    throw Error("ERR_RTC_ARGUMENT", "Invalid bounded JSON object", MONKY_ENGINE_INVALID);
  }
}

void SafeId(std::uint64_t id) {
  if (!id || id > kMaxId)
    throw Error("ERR_RTC_ARGUMENT", "Expected a positive safe integer ID", MONKY_ENGINE_INVALID);
}

bool KnownOperation(std::string_view op) {
  constexpr std::string_view names[] = {
      "source.create", "source.createEncodedVideo", "source.createAudio", "source.beginAudioEpoch", "source.setAudioSyncGroup",
      "source.setEnabled", "audio.configureOutput", "audio.stopOutput", "resource.close",
      "peer.create", "peer.createOffer", "peer.createAnswer", "peer.setLocalDescription",
      "peer.setRemoteDescription", "peer.addIceCandidate", "peer.publish",
      "peer.publishAudio", "peer.setReceiverVolume",
      "peer.setPublicationEnabled", "peer.setReceiving", "peer.setReceiverEnabled", "peer.getStats", "peer.configureBitrate",
      "peer.configureVideoPlayout",
      "sfu.load", "sfu.createTransport", "sfu.produce", "sfu.consume",
      "sfu.setProducerEnabled", "sfu.setConsumerEnabled", "sfu.setConsumerVolume", "sfu.restartIce", "sfu.getStats"};
  return std::find(std::begin(names), std::end(names), op) != std::end(names);
}

void ValidateOptions(const MonkyEngineOptions& options) {
  if (options.struct_size != sizeof(options) || options.abi_version != MONKY_ENGINE_ABI_VERSION ||
      !options.max_resources || options.max_resources > 64 ||
      !options.max_pending_operations || options.max_pending_operations > 128 ||
      !options.max_decoded_frames || options.max_decoded_frames > 64 ||
      options.require_audio > 1 ||
      options.operation_timeout_ms < 100 || options.operation_timeout_ms > 60000 ||
      (options.maximum_h264_level != 31 && options.maximum_h264_level != 32 &&
       options.maximum_h264_level != 40 && options.maximum_h264_level != 41 &&
       options.maximum_h264_level != 42 && options.maximum_h264_level != 50 &&
       options.maximum_h264_level != 51 && options.maximum_h264_level != 52))
    throw Error("ERR_RTC_OPTIONS", "Invalid versioned engine limits", MONKY_ENGINE_INVALID);
}

struct Operation {
  std::string name;
  Json data;
  std::shared_ptr<Cancellation> cancellation;
};

struct Reply {
  std::shared_ptr<Cancellation> cancellation;
  std::uint64_t target = 0;
  Json response;
  bool done = false;
};

struct Frame {
  FrameRoute route;
  std::shared_ptr<const presentation::SharedFrame> shared;
  bool published = false, release_requested = false;
};

}  // namespace

class Engine final : public Host, public std::enable_shared_from_this<Engine> {
 public:
  Engine(MonkyEngineOptions options, MonkyEngineCallbacks callbacks, bool encoded_input = false)
      : options_(options), encoded_input_(encoded_input), callbacks_(callbacks), resources_(options.max_resources),
        receive_routes_(std::size_t(options.max_resources) * receiver_policy::kMaxReceiverHistory) {}
  ~Engine() override {
    if (actor_.joinable()) actor_.join();
  }

  void Start() {
    actor_ = std::thread([owner = shared_from_this()] { owner->Run(); });
  }

  std::uint64_t AllocateHandle() override {
    std::lock_guard lock(mutex_);
    if (next_id_ > kMaxId) throw Error("ERR_RTC_IDS", "Native handles exhausted");
    return next_id_++;
  }
  void RegisterResource(std::uint64_t id, std::uint64_t parent = 0,
                        std::uint64_t source = 0) override {
    std::lock_guard lock(mutex_);
    if (closing_)
      throw Error("ERR_RTC_CANCELLED", "Resource registration was cancelled", MONKY_ENGINE_CANCELLED);
    resources_.Register(id, parent, source);
  }
  void ForgetResource(std::uint64_t id) noexcept override {
    std::shared_ptr<presentation::Exporter> exporter;
    {
      std::lock_guard lock(mutex_);
      resources_.Erase(id);
      receive_routes_.RetireTarget(id);
      exporter = presenter_;
    }
    if (exporter) exporter->RetireTarget(id);
  }
  std::uint32_t MaxResources() const override { return options_.max_resources; }
  std::chrono::milliseconds Timeout() const override {
    return std::chrono::milliseconds(options_.operation_timeout_ms);
  }
  webrtc::scoped_refptr<webrtc::PeerConnectionFactoryInterface> Factory() const override {
    return factory_;
  }
  webrtc::Thread* SignalingThread() const override { return signaling_.get(); }
  std::shared_ptr<mf::NativeRtcContext> MfContext() const override {
    std::lock_guard lock(mutex_);
    return mf_context_;
  }
  std::shared_ptr<CaptureClock> CaptureTimebase() const override {
    std::lock_guard lock(mutex_);
    return capture_clock_;
  }
  std::shared_ptr<VideoSource> FindSource(std::uint64_t id) const override {
    std::lock_guard lock(mutex_);
    const auto found = sources_.find(id);
    return found == sources_.end() ? nullptr : found->second;
  }
  std::shared_ptr<audio::AudioSource> FindAudioSource(std::uint64_t id) const override {
    std::lock_guard lock(mutex_);
    const auto found = audio_sources_.find(id);
    return found == audio_sources_.end() ? nullptr : found->second;
  }
  std::shared_ptr<audio::AudioRuntime> Audio() const {
    std::lock_guard lock(mutex_);
    if (!audio_runtime_) throw Error("ERR_RTC_AUDIO_NOT_READY", "Audio runtime is unavailable", MONKY_ENGINE_CLOSED);
    return audio_runtime_;
  }
  bool AudioOutputReady(std::uint64_t expected_epoch = 0) const override {
    std::shared_ptr<audio::AudioRuntime> runtime;
    { std::lock_guard lock(mutex_); runtime = audio_runtime_; }
    return runtime && runtime->OutputReady(expected_epoch);
  }
  void SubmitAudio(std::uint64_t source, const MonkyEngineAudioPacket& packet) {
    const auto found = FindAudioSource(source);
    if (!found) throw Error("ERR_RTC_AUDIO_SOURCE", "Audio source not found", MONKY_ENGINE_NOT_FOUND);
    Audio()->Submit(found, packet);
  }

  bool Emit(std::string_view type, std::uint64_t target, Json data) noexcept override {
    try {
      MonkyEngineEvent event{};
      event.struct_size = sizeof(event);
      event.abi_version = MONKY_ENGINE_ABI_VERSION;
      event.target = target;
      event.kind = MONKY_ENGINE_EVENT_SIGNAL;
      if (type == "ready") event.kind = MONKY_ENGINE_EVENT_READY;
      else if (type == "operation") {
        event.kind = MONKY_ENGINE_EVENT_OPERATION;
        event.id = data.at("requestId").get<std::uint64_t>();
      } else if (type == "request") {
        event.kind = MONKY_ENGINE_EVENT_REQUEST;
        event.id = data.at("callbackId").get<std::uint64_t>();
      } else if (type == "frame") {
        event.kind = MONKY_ENGINE_EVENT_FRAME;
        event.id = data.at("frameId").get<std::uint64_t>();
      } else if (type == "source.frameReleased") {
        event.kind = MONKY_ENGINE_EVENT_INPUT_RELEASED;
        event.id = data.at("frameId").get<std::uint64_t>();
      } else if (type == "frame.released") {
        event.kind = MONKY_ENGINE_EVENT_FRAME_RELEASED;
        event.id = data.at("frameId").get<std::uint64_t>();
      } else if (type == "source.audioPacketReleased") {
        event.kind = MONKY_ENGINE_EVENT_AUDIO_INPUT_RELEASED;
        event.id = data.at("sequence").get<std::uint64_t>() + 1;
      } else if (type == "audio.playout") {
        event.kind = MONKY_ENGINE_EVENT_AUDIO_OUTPUT;
        event.id = data.at("sequence").get<std::uint64_t>() + 1;
      } else if (type == "error") event.kind = MONKY_ENGINE_EVENT_ERROR;
      else if (type == "closed") event.kind = MONKY_ENGINE_EVENT_CLOSED;
      const auto text = Json{{"type", type}, {"target", target}, {"data", std::move(data)}}.dump();
      if (text.size() > kMaxJson) throw Error("ERR_RTC_EVENT_LIMIT", "Event exceeds its byte bound");
      event.json = text.data();
      event.json_bytes = static_cast<std::uint32_t>(text.size());
      bool accepted;
      {
        std::lock_guard lock(callback_mutex_);
        if (event.kind == MONKY_ENGINE_EVENT_FRAME) {
          std::lock_guard state_lock(mutex_);
          // Serialize this gate with delivery: resource.close cannot report
          // completion before a delayed frame callback for that retired target.
          const auto frame = frames_.find(event.id);
          if (closing_ || !resources_.Contains(target) || frame == frames_.end() ||
              !receive_routes_.Accepts(frame->second.route)) return false;
        }
        accepted = callbacks_.on_event &&
            callbacks_.on_event(callbacks_.user, &event) == MONKY_ENGINE_OK;
      }
      if (!accepted) {
        ++rejected_events_;
        if (type != "frame" && !closing_.load()) {
          {
            std::lock_guard lock(mutex_);
            if (failure_.is_null())
              failure_ = ErrorJson(Error("ERR_RTC_EVENT_DELIVERY",
                  "Host rejected a required native event", MONKY_ENGINE_QUEUE_FULL));
          }
          RequestClose();
        }
      }
      return accepted;
    } catch (...) {
      ++rejected_events_;
      std::fputs("[monky-rtc] Native event construction/delivery failed; closing with ownership retained.\n", stderr);
      RequestClose();
      return false;
    }
  }

  Json RequestServer(std::string_view method, std::uint64_t target, Json data,
                     const std::shared_ptr<Cancellation>& supplied) override {
    auto cancellation = supplied;
    if (cancellation && !cancellation->request_id) {
      std::lock_guard lock(mutex_);
      cancellation = active_operation_;
    }
    if (!cancellation) throw Error("ERR_RTC_CALLBACK", "Server request has no cancellation context");
    cancellation->Check();
    if (cancellation->closes_resource)
      throw Error("ERR_RTC_CLOSE_CALLBACK", "Local teardown cannot wait for a server acknowledgement",
                  MONKY_ENGINE_UNSUPPORTED);
    const auto id = AllocateHandle();
    auto reply = std::make_shared<Reply>();
    reply->cancellation = cancellation;
    reply->target = target;
    {
      std::lock_guard lock(mutex_);
      if (closing_) throw Error("ERR_RTC_CANCELLED", "Engine is closing", MONKY_ENGINE_CANCELLED);
      if (replies_.size() >= options_.max_pending_operations)
        throw Error("ERR_RTC_QUEUE_FULL", "Server request budget exhausted", MONKY_ENGINE_QUEUE_FULL);
      replies_.emplace(id, reply);
    }
    struct Remove {
      Engine& owner;
      std::uint64_t id;
      ~Remove() { std::lock_guard lock(owner.mutex_); owner.replies_.erase(id); }
    } remove{*this, id};
    if (!Emit("request", target, {{"callbackId", id}, {"requestId", cancellation->request_id},
                                 {"method", method}, {"payload", std::move(data)}}))
      throw Error("ERR_RTC_CALLBACK_QUEUE", "Host rejected a server request", MONKY_ENGINE_QUEUE_FULL);
    std::unique_lock lock(mutex_);
    const auto deadline = (std::min)(cancellation->deadline,
                                    std::chrono::steady_clock::now() + Timeout());
    wake_.wait_until(lock, deadline, [&] {
      return reply->done || cancellation->cancelled.load() || closing_;
    });
    if (closing_ || cancellation->cancelled.load())
      throw Error("ERR_RTC_CANCELLED", "Server request was cancelled", MONKY_ENGINE_CANCELLED);
    cancellation->Check();
    if (!reply->done)
      throw Error("ERR_RTC_TIMEOUT", "Server acknowledgement deadline expired", MONKY_ENGINE_TIMEOUT);
    auto response = std::move(reply->response);
    lock.unlock();
    if (!response.at("ok").get<bool>()) {
      const auto& error = response.at("error");
      throw Error(Text(error, "code", 79), Text(error, "message", 511));
    }
    return response.at("data");
  }

  void ActivateReceiveRoute(const FrameRoute& route) override {
    std::lock_guard lock(mutex_);
    if (closing_ || !resources_.Contains(route.target))
      throw Error("ERR_RTC_ROUTE_CLOSED", "Receiver route target is closed", MONKY_ENGINE_CLOSED);
    receive_routes_.Activate(route);
  }

  void RetireReceiveRoute(const FrameRoute& route) noexcept override {
    std::shared_ptr<presentation::Exporter> exporter;
    {
      std::lock_guard lock(mutex_);
      receive_routes_.Retire(route);
      exporter = presenter_;
    }
    if (exporter) exporter->RetireRoute(route);
  }

  void ReceiveFrame(const FrameRoute& route, const webrtc::VideoFrame& input) noexcept override {
    try {
      auto context = MfContext();
      if (!context) return;
      auto gpu = context->GetDecodedFrame(input.video_frame_buffer());
      if (!gpu) {
        Emit("error", route.target, {{"code", "ERR_RTC_GPU_OUTPUT"}, {"message", "Non-native decoded output rejected"},
                              {"status", MONKY_ENGINE_UNSUPPORTED}, {"hresult", 0}, {"terminal", false}});
        return;
      }
      const auto id = AllocateHandle();
      std::shared_ptr<presentation::Exporter> exporter;
      {
        std::lock_guard lock(mutex_);
        if (closing_ || !presenter_ || !resources_.Contains(route.target) ||
            !receive_routes_.Accepts(route) ||
            frames_.size() >= options_.max_decoded_frames) {
          ++dropped_frames_;
          return;
        }
        exporter = presenter_;
        frames_.emplace(id, Frame{route, nullptr, false, false});
      }
      try {
        if (!exporter->Submit(id, route, input.timestamp_us(), std::move(gpu))) {
          std::lock_guard lock(mutex_);
          frames_.erase(id);
          ++dropped_frames_;
        } else {
          bool retired;
          {
            std::lock_guard lock(mutex_);
            retired = closing_ || !resources_.Contains(route.target) || !receive_routes_.Accepts(route);
          }
          // A route can retire between the engine reservation and exporter
          // admission. Reconcile that race after admission without revoking
          // anything an in-flight ready callback could have exposed.
          if (retired) exporter->RetireRoute(route);
        }
      } catch (...) {
        {
          std::lock_guard lock(mutex_);
          frames_.erase(id);
        }
        throw;
      }
    } catch (...) { RememberCurrentFailure(); RequestClose(); }
  }

  void Request(std::uint64_t id, std::string name, std::uint64_t target, Json data) {
    SafeId(id);
    if (target > kMaxId || !KnownOperation(name))
      throw Error("ERR_RTC_COMMAND", "Unknown operation or invalid target", MONKY_ENGINE_INVALID);
    const bool creates = name == "source.create" || name == "source.createEncodedVideo" || name == "source.createAudio" ||
        name == "audio.configureOutput" || name == "audio.stopOutput" ||
        name == "peer.create" || name == "sfu.load";
    if (creates != (target == 0))
      throw Error("ERR_RTC_TARGET", "Operation target does not match its creation/resource scope",
                  MONKY_ENGINE_INVALID);
    auto cancellation = std::make_shared<Cancellation>();
    cancellation->request_id = id;
    cancellation->target = target;
    cancellation->closes_resource = name == "resource.close";
    cancellation->deadline = std::chrono::steady_clock::now() + Timeout();
    {
      std::lock_guard lock(mutex_);
      if (!ready_ || closing_) throw Error("ERR_RTC_NOT_READY", "Engine is not ready", MONKY_ENGINE_CLOSED);
      if (cancellation->closes_resource) resources_.ValidateClose(target, data);
      ReserveOperation(operations_, options_.max_pending_operations, cancellation);
      try { queue_.push_back({std::move(name), std::move(data), cancellation}); }
      catch (...) { operations_.erase(id); throw; }
      // Validation and all allocating admission precede cancellation of others.
      if (cancellation->closes_resource) CancelTargetLocked(target);
    }
    wake_.notify_all();
  }

  void Respond(std::uint64_t id, Json response) {
    SafeId(id);
    if (!response.contains("ok") || !response.at("ok").is_boolean() ||
        (response.at("ok").get<bool>() && !response.contains("data")) ||
        (!response.at("ok").get<bool>() && (!response.contains("error") || !response.at("error").is_object())))
      throw Error("ERR_RTC_RESPONSE", "Malformed server response envelope", MONKY_ENGINE_INVALID);
    if (!response.at("ok").get<bool>()) {
      (void)Text(response.at("error"), "code", 79);
      (void)Text(response.at("error"), "message", 511);
    }
    {
      std::lock_guard lock(mutex_);
      const auto found = replies_.find(id);
      if (found == replies_.end() || found->second->done)
        throw Error("ERR_RTC_CALLBACK_ID", "Unknown or duplicate server response", MONKY_ENGINE_NOT_FOUND);
      found->second->cancellation->Check();
      if (closing_) throw Error("ERR_RTC_CANCELLED", "Engine is closing", MONKY_ENGINE_CANCELLED);
      found->second->response = std::move(response);
      found->second->done = true;
    }
    wake_.notify_all();
  }

  void Cancel(std::uint64_t id) {
    SafeId(id);
    {
      std::lock_guard lock(mutex_);
      const auto found = operations_.find(id);
      if (found == operations_.end() || found->second->committed)
        throw Error("ERR_RTC_REQUEST_ID", "Request is no longer pending", MONKY_ENGINE_NOT_FOUND);
      found->second->cancelled.store(true);
    }
    wake_.notify_all();
  }

  void Submit(std::uint64_t source_id, const MonkyEngineInputFrame& input) {
    SafeId(source_id);
    if (encoded_input_)
      throw Error("ERR_RTC_INPUT_MODE", "Encoded-H264 engines do not import NV12 input handles", MONKY_ENGINE_UNSUPPORTED);
    if (input.struct_size != sizeof(input) || input.abi_version != MONKY_ENGINE_ABI_VERSION ||
        !input.frame_id || input.frame_id > kMaxId || !input.texture_nt_handle ||
        input.texture_nt_handle > (std::numeric_limits<std::intptr_t>::max)() ||
        input.timestamp_us < 0 || static_cast<std::uint64_t>(input.timestamp_us) > kMaxId ||
        input.duration_us <= 0 || input.duration_us > 1000000 ||
        input.ntp_time_ms < -1 || input.ntp_time_ms > static_cast<std::int64_t>(kMaxId))
      throw Error("ERR_RTC_FRAME", "Invalid versioned leased GPU input", MONKY_ENGINE_INVALID);
    std::shared_ptr<VideoSource> source;
    {
      std::lock_guard lock(mutex_);
      if (closing_ || !ready_) throw Error("ERR_RTC_CLOSED", "Engine is not accepting frames", MONKY_ENGINE_CLOSED);
      const auto found = sources_.find(source_id);
      if (found == sources_.end()) throw Error("ERR_RTC_SOURCE", "Source not found", MONKY_ENGINE_NOT_FOUND);
      source = found->second;
    }
    auto frame = std::make_shared<InputFrame>();
    if (!DuplicateHandle(GetCurrentProcess(), reinterpret_cast<HANDLE>(input.texture_nt_handle),
                         GetCurrentProcess(), &frame->texture, 0, FALSE, DUPLICATE_SAME_ACCESS))
      throw Error("ERR_RTC_FRAME_HANDLE", "Cannot duplicate the producer's NT handle",
                  MONKY_ENGINE_INVALID, HRESULT_FROM_WIN32(GetLastError()));
    frame->id = input.frame_id;
    frame->timestamp_us = input.timestamp_us;
    frame->duration_us = input.duration_us;
    frame->ntp_time_ms = input.ntp_time_ms;
    source->Submit(std::move(frame));
  }

  void SubmitEncoded(std::uint64_t source_id, const MonkyEngineEncodedFrame& input) {
    SafeId(source_id);
    if (!encoded_input_)
      throw Error("ERR_RTC_INPUT_MODE", "External H264 requires explicit encoded engine creation", MONKY_ENGINE_UNSUPPORTED);
    ValidateEncodedFrame(input);
    std::shared_ptr<VideoSource> source;
    {
      std::lock_guard lock(mutex_);
      if (closing_ || !ready_) throw Error("ERR_RTC_CLOSED", "Engine is not accepting encoded input", MONKY_ENGINE_CLOSED);
      const auto found = sources_.find(source_id);
      if (found == sources_.end()) throw Error("ERR_RTC_SOURCE", "Encoded source not found", MONKY_ENGINE_NOT_FOUND);
      source = found->second;
    }
    source->SubmitEncoded(input);
  }

  void GetFrame(std::uint64_t id, MonkyEngineFrameCom& output) {
    if (output.struct_size != sizeof(output) || output.abi_version != MONKY_ENGINE_ABI_VERSION)
      throw Error("ERR_RTC_ABI", "Frame COM structure mismatch", MONKY_ENGINE_INVALID);
    const auto frame_owner = PresentedFrame(id);
    const auto& frame = *frame_owner;
    output.texture = frame.texture.get();
    output.ready_fence = frame.ready_fence.get();
    output.texture->AddRef();
    output.ready_fence->AddRef();
    output.ready_value = frame.ready_value;
    output.subresource = 0;
    output.coded_width = frame.info.coded_width;
    output.coded_height = frame.info.coded_height;
    output.visible_x = frame.info.visible_x;
    output.visible_y = frame.info.visible_y;
    output.width = frame.info.width;
    output.height = frame.info.height;
    output.reserved = 0;
    output.timestamp_us = frame.info.timestamp_us;
  }
  void GetSharedFrame(std::uint64_t id, MonkyEngineSharedFrame& output) {
    if (output.struct_size != sizeof(output) || output.abi_version != MONKY_ENGINE_ABI_VERSION)
      throw Error("ERR_RTC_ABI", "Shared frame structure mismatch", MONKY_ENGINE_INVALID);
    output = PresentedFrame(id)->info;
  }
  void ReleaseFrame(std::uint64_t id, std::uint32_t reason) {
    SafeId(id);
    if (reason != MONKY_ENGINE_FRAME_UNUSED && reason != MONKY_ENGINE_FRAME_EXTERNAL_REFERENCES_RELEASED)
      throw Error("ERR_RTC_RELEASE_REASON", "Frame release requires explicit external-reference proof",
                  MONKY_ENGINE_INVALID);
    std::shared_ptr<presentation::Exporter> exporter;
    {
      std::lock_guard lock(mutex_);
      const auto found = frames_.find(id);
      if (found == frames_.end() || !found->second.shared || !found->second.published || !presenter_)
        throw Error("ERR_RTC_FRAME_ID", "Unknown or unpublished shared frame lease", MONKY_ENGINE_NOT_FOUND);
      if (found->second.release_requested)
        throw Error("ERR_RTC_FRAME_RELEASE", "Shared frame release is already pending", MONKY_ENGINE_BUSY);
      found->second.release_requested = true;
      exporter = presenter_;
    }
    try { exporter->Release(id, reason); }
    catch (...) {
      std::lock_guard lock(mutex_);
      if (const auto frame = frames_.find(id); frame != frames_.end()) frame->second.release_requested = false;
      throw;
    }
  }

  Json Snapshot() const {
    Json snapshot;
    std::vector<std::pair<std::uint64_t, std::shared_ptr<VideoSource>>> sources;
    std::vector<std::shared_ptr<audio::AudioSource>> audio_sources;
    std::shared_ptr<audio::AudioRuntime> audio;
    std::shared_ptr<presentation::Exporter> exporter;
    {
      std::lock_guard lock(mutex_);
      snapshot = {{"state", done_ ? "closed" : closing_ ? "closing" : ready_ ? "ready" : "starting"},
                  {"closed", done_}, {"ready", ready_ && !closing_}, {"resources", resources_.Size()},
                  {"pendingOperations", operations_.size()}, {"pendingServerRequests", replies_.size()},
                  {"contractRevision", MONKY_ENGINE_CONTRACT_REVISION},
                  {"videoInput", encoded_input_ ? "encoded-h264" : "nv12"},
                  {"activeReceiverRoutes", receive_routes_.Size()},
                  {"decodedFrames", frames_.size()}, {"droppedFrames", dropped_frames_.load()},
                  {"rejectedEvents", rejected_events_.load()},
                  {"audioAvailable", true}, {"audioRuntimeQualified", false}, {"runtimeQualified", false},
                  {"hardwareExecutionObserved", nullptr}, {"failure", failure_},
                  {"peers", peer_snapshot_}, {"sfu", sfu_snapshot_}, {"mf", mf_snapshot_},
                  {"presentation", presentation_snapshot_}, {"presentationRuntimeQualified", false}};
      for (const auto& item : sources_) sources.push_back(item);
      for (const auto& [id, source] : audio_sources_) audio_sources.push_back(source);
      audio = audio_runtime_;
      exporter = presenter_;
    }
    snapshot["sources"] = Json::array();
    for (const auto& [id, source] : sources)
      snapshot["sources"].push_back({{"id", id}, {"stats", source->Snapshot()}});
    if (exporter) snapshot["presentation"] = exporter->Snapshot();
    snapshot["audioSources"] = Json::array();
    for (const auto& source : audio_sources) snapshot["audioSources"].push_back(source->Snapshot());
    if (audio) snapshot["audio"] = audio->Snapshot();
    return snapshot;
  }

  void RequestClose() noexcept {
    {
      std::lock_guard lock(mutex_);
      closing_ = true;
      for (auto& [id, cancellation] : operations_) cancellation->cancelled.store(true);
      for (auto& [id, reply] : replies_) reply->cancellation->cancelled.store(true);
    }
    wake_.notify_all();
  }
  void DetachCallbacks() {
    {
      std::lock_guard lock(callback_mutex_);
      callbacks_.on_event = nullptr;
      callbacks_.user = nullptr;
    }
    RequestClose();
  }
  void WaitClosed(std::uint32_t timeout) {
    if (!timeout || timeout > 60000)
      throw Error("ERR_RTC_TIMEOUT", "Close wait must be 1..60000ms", MONKY_ENGINE_INVALID);
    {
      std::unique_lock lock(mutex_);
      if (!wake_.wait_for(lock, std::chrono::milliseconds(timeout), [&] { return done_; }))
        throw Error("ERR_RTC_CLOSE_PENDING", "Native threads or retained GPU leases have not retired",
                    MONKY_ENGINE_TIMEOUT);
    }
    std::lock_guard lock(join_mutex_);
    if (actor_.joinable()) actor_.join();
  }
  void RequireDestroyable() {
    std::scoped_lock lock(join_mutex_, mutex_);
    if (!done_ || actor_.joinable() || !frames_.empty())
      throw Error("ERR_RTC_BUSY", "Wait for actual native retirement before destruction", MONKY_ENGINE_BUSY);
  }

 private:
  std::shared_ptr<const presentation::SharedFrame> PresentedFrame(std::uint64_t id) {
    std::lock_guard lock(mutex_);
    const auto frame = frames_.find(id);
    if (frame == frames_.end() || !frame->second.shared || !frame->second.published ||
        frame->second.release_requested)
      throw Error("ERR_RTC_FRAME_ID", "Frame is not a live, published shared lease", MONKY_ENGINE_NOT_FOUND);
    return frame->second.shared;
  }

  bool PresentReady(std::shared_ptr<const presentation::SharedFrame> frame) noexcept {
    const auto id = frame->id;
    try {
      {
        std::lock_guard lock(mutex_);
        const auto found = frames_.find(id);
        if (found == frames_.end() || closing_ || !resources_.Contains(frame->route.target) ||
            !receive_routes_.Accepts(frame->route)) return false;
        if (found->second.route != frame->route || found->second.shared)
          throw Error("ERR_RTC_PRESENTATION_ID", "Presentation identity does not match its accepted source");
        found->second.shared = frame;
        found->second.published = true;
      }
      const auto& info = frame->info;
      Json data{{"frameId", id}, {"width", info.width}, {"height", info.height},
           {"codedWidth", info.coded_width}, {"codedHeight", info.coded_height},
           {"timestampUs", info.timestamp_us}, {"format", "NV12"}, {"gpuCopy", true},
           {"routeKind", frame->route.IsPeer() ? "peer" : "consumer"}};
      if (frame->route.IsPeer()) {
        data["receiverId"] = frame->route.receiver_id;
        data["receiverEpoch"] = frame->route.receiver_epoch;
      }
      const bool accepted = Emit("frame", frame->route.target, std::move(data));
      if (!accepted) {
        std::lock_guard lock(mutex_);
        if (const auto found = frames_.find(id); found != frames_.end()) found->second.published = false;
      }
      return accepted;
    } catch (...) {
      {
        std::lock_guard lock(mutex_);
        if (const auto found = frames_.find(id); found != frames_.end()) found->second.published = false;
      }
      RememberCurrentFailure();
      RequestClose();
      return false;
    }
  }

  void PresentError(std::uint64_t target, std::uint64_t id, const MonkyEngineError& error,
                    bool terminal) noexcept {
    try {
      const Error failure(error.code, error.message, error.status, error.hresult);
      if (terminal) { RememberFailure(failure); RequestClose(); }
      else {
        auto data = ErrorJson(failure);
        data["frameId"] = id;
        data["terminal"] = false;
        Emit("error", target, std::move(data));
      }
    } catch (...) { RememberCurrentFailure(); RequestClose(); }
  }

  void PresentRetired(const presentation::Completion& completion) noexcept {
    try {
      {
        std::lock_guard lock(mutex_);
        const auto found = frames_.find(completion.id);
        if (found == frames_.end() || found->second.route != completion.route ||
            found->second.published != completion.published ||
            (completion.published && !found->second.release_requested))
          throw Error("ERR_RTC_PRESENTATION_RETIREMENT", "GPU retirement does not match its owned frame proof");
        frames_.erase(found);
      }
      wake_.notify_all();
      if (!completion.published) {
        ++dropped_frames_;
        if (completion.error && completion.error->status != MONKY_ENGINE_CANCELLED &&
            completion.error->status != MONKY_ENGINE_QUEUE_FULL)
          PresentError(completion.route.target, completion.id, *completion.error, false);
        return;
      }
      Json data{{"frameId", completion.id}, {"ok", !completion.error.has_value()}};
      if (completion.error) {
        const auto& error = *completion.error;
        data["error"] = ErrorJson(Error(error.code, error.message, error.status, error.hresult));
      }
      Emit("frame.released", completion.route.target, std::move(data));
    } catch (...) { RememberCurrentFailure(); RequestClose(); }
  }

  void CancelTargetLocked(std::uint64_t target) {
    for (auto& [id, cancellation] : operations_)
      if (resources_.ShouldCancel(target, *cancellation, cancellation->target))
        cancellation->cancelled.store(true);
    for (auto& [id, reply] : replies_)
      if (resources_.ShouldCancel(target, *reply->cancellation, reply->target))
        reply->cancellation->cancelled.store(true);
  }

  void Initialize() {
    if (closing_.load()) throw Error("ERR_RTC_CANCELLED", "Startup cancelled", MONKY_ENGINE_CANCELLED);
    if (!webrtc::InitializeSSL()) throw Error("ERR_RTC_SSL", "RTC SSL initialization failed");
    ssl_started_ = true;
    network_ = webrtc::Thread::CreateWithSocketServer();
    worker_ = webrtc::Thread::Create();
    signaling_ = webrtc::Thread::Create();
    if (!network_ || !worker_ || !signaling_) throw Error("ERR_RTC_THREADS", "Cannot allocate RTC threads");
    network_->SetName("monky-screen-network", nullptr);
    worker_->SetName("monky-screen-worker", nullptr);
    signaling_->SetName("monky-screen-signaling", nullptr);
    network_started_ = network_->Start();
    worker_started_ = network_started_ && worker_->Start();
    signaling_started_ = worker_started_ && signaling_->Start();
    if (!signaling_started_)
      throw Error("ERR_RTC_THREADS", "Cannot start RTC threads");
    mf::AdapterOptions options;
    options.maximum_h264_level = static_cast<std::uint8_t>(options_.maximum_h264_level);
    options.maximum_workers = 32;
    options.maximum_native_buffers = 256;
    options.operation_timeout = Timeout();
    auto bundle = mf::CreateFactoryBundle(options);
    std::unique_ptr<webrtc::FieldTrialsView> video_field_trials;
    if (encoded_input_) {
      auto external = CreateEncodedVideoFactory();
      encoded_context_ = std::move(external.context);
      bundle.encoder_factory = std::move(external.encoder_factory);
      video_field_trials = std::move(external.field_trials);
    }
    {
      std::lock_guard lock(mutex_);
      mf_context_ = bundle.context;
    }
    std::exception_ptr failure;
    signaling_->BlockingCall([&] {
      try {
        if (closing_.load()) throw Error("ERR_RTC_CANCELLED", "Startup cancelled", MONKY_ENGINE_CANCELLED);
        environment_.emplace(webrtc::CreateEnvironment());
        {
          auto capture_clock = std::make_shared<CaptureClock>(environment_->clock());
          std::lock_guard lock(mutex_);
          capture_clock_ = std::move(capture_clock);
        }
        auto audio_runtime = std::make_shared<audio::AudioRuntime>(*this, environment_->clock());
        { std::lock_guard lock(mutex_); audio_runtime_ = audio_runtime; }
        audio_runtime->Start();
        auto adm = audio_runtime->Adm();
        factory_ = webrtc::CreatePeerConnectionFactory(
            network_.get(), worker_.get(), signaling_.get(), adm,
            webrtc::CreateAudioEncoderFactory<audio::StereoOpusEncoder>(),
            webrtc::CreateAudioDecoderFactory<audio::StereoOpusDecoder>(),
            std::move(bundle.encoder_factory), std::move(bundle.decoder_factory),
            nullptr, nullptr, nullptr, std::move(video_field_trials));
        if (!factory_) throw Error("ERR_RTC_FACTORY", "RTC factory initialization failed");
      } catch (...) { failure = std::current_exception(); }
    });
    if (failure) std::rethrow_exception(failure);
    if (closing_.load()) throw Error("ERR_RTC_CANCELLED", "Startup cancelled", MONKY_ENGINE_CANCELLED);
    peers_ = CreatePeerController(*this);
    sfu_ = CreateSfuController(*this);
    presentation::Options presentation_options;
    presentation_options.maximum_frames = options_.max_decoded_frames;
    presentation_options.observation_timeout = Timeout();
    presentation::Callbacks presentation_callbacks;
    presentation_callbacks.ready = [this](std::shared_ptr<const presentation::SharedFrame> frame) {
      return PresentReady(std::move(frame));
    };
    presentation_callbacks.retired = [this](const presentation::Completion& completion) {
      PresentRetired(completion);
    };
    presentation_callbacks.error = [this](std::uint64_t target, std::uint64_t id,
                                          const MonkyEngineError& error, bool terminal) {
      PresentError(target, id, error, terminal);
    };
    std::shared_ptr<presentation::Exporter> exporter =
        presentation::CreateExporter(presentation_options, std::move(presentation_callbacks));
    {
      std::lock_guard lock(mutex_);
      presenter_ = std::move(exporter);
      if (closing_) throw Error("ERR_RTC_CANCELLED", "Startup cancelled", MONKY_ENGINE_CANCELLED);
      ready_ = true;
    }
    Emit("ready", 0, {{"capabilities", Json::parse(kCapabilities)}});
  }

  Json Execute(const Operation& operation) {
    const auto& cancellation = operation.cancellation;
    const auto target = cancellation->target;
    cancellation->Check();
    if (operation.name.starts_with("peer.")) return peers_->Execute(operation.name, target, operation.data, cancellation);
    if (operation.name.starts_with("sfu.")) return sfu_->Execute(operation.name, target, operation.data, cancellation);
    if (operation.name == "audio.configureOutput") return Audio()->ConfigureOutput(operation.data);
    if (operation.name == "audio.stopOutput") return Audio()->StopOutput(operation.data);
    if (operation.name == "source.createAudio") {
      {
        std::lock_guard lock(mutex_);
        if (!audio_sources_.empty())
          throw Error("ERR_RTC_AUDIO_PUBLISHER", "Only one local audio capture source is supported", MONKY_ENGINE_BUSY);
      }
      const auto id = AllocateHandle();
      RegisterResource(id);
      try {
        auto source = std::make_shared<audio::AudioSource>(*this, id, operation.data);
        cancellation->Check();
        std::lock_guard lock(mutex_);
        audio_sources_.emplace(id, std::move(source));
      } catch (...) { ForgetResource(id); throw; }
      return {{"sourceId", id}, {"kind", "audio"}};
    }
    if (operation.name == "source.beginAudioEpoch" || operation.name == "source.setAudioSyncGroup") {
      const auto source = FindAudioSource(target);
      if (!source) throw Error("ERR_RTC_AUDIO_SOURCE", "Audio source not found", MONKY_ENGINE_NOT_FOUND);
      if (operation.name == "source.setAudioSyncGroup") {
        if (operation.data.size() != 1)
          throw Error("ERR_RTC_ARGUMENT", "Only syncGroup is accepted", MONKY_ENGINE_INVALID);
        const auto group = SyncGroup(operation.data);
        { std::lock_guard lock(mutex_); resources_.ValidateClose(target, Json::object()); }
        source->SetSyncGroup(group);
        return {{"sourceId", target}, {"syncGroup", group}};
      }
      source->accepting.store(false);
      Audio()->FenceCapture(cancellation);
      cancellation->Check();
      source->BeginEpoch(operation.data);
      return {{"sourceId", target}, {"epoch", operation.data.at("epoch")}};
    }
    if (operation.name == "source.create" || operation.name == "source.createEncodedVideo") {
      const bool encoded = operation.name == "source.createEncodedVideo";
      if (encoded != encoded_input_)
        throw Error("ERR_RTC_INPUT_MODE", "Source kind must match the explicit engine videoInput mode", MONKY_ENGINE_UNSUPPORTED);
      const auto group = SyncGroup(operation.data);
      {
        std::lock_guard lock(mutex_);
        if (encoded && !sources_.empty())
          throw Error("ERR_RTC_ENCODED_SOURCE_LIMIT", "One encoded source per engine may be reused by multiple peers", MONKY_ENGINE_BUSY);
        for (const auto& [id, existing] : sources_)
          if (existing->SyncGroup() == group)
            throw Error("ERR_RTC_SYNC_GROUP", "Each local screen requires its own synchronization group",
                        MONKY_ENGINE_INVALID);
      }
      if (target) throw Error("ERR_RTC_TARGET", "source.create requires target zero", MONKY_ENGINE_INVALID);
      const auto id = AllocateHandle();
      // Reserve the shared resource budget BEFORE any source/device initialization.
      RegisterResource(id);
      std::shared_ptr<VideoSource> source;
      try {
        source = encoded ? CreateEncodedVideoSource(*this, id, operation.data, cancellation, encoded_context_)
                         : CreateGpuSource(*this, id, operation.data, cancellation);
        cancellation->Check();
        {
          std::lock_guard lock(mutex_);
          sources_.emplace(id, source);
        }
        cancellation->Check();
      } catch (...) {
        {
          std::lock_guard lock(mutex_);
          sources_.erase(id);
        }
        ForgetResource(id);
        if (source) source->Close();
        throw;
      }
      return {{"sourceId", id}};
    }
    if (operation.name == "source.setEnabled") {
      auto source = FindSource(target);
      auto audio_source = FindAudioSource(target);
      if (!source && !audio_source) throw Error("ERR_RTC_SOURCE", "Source not found", MONKY_ENGINE_NOT_FOUND);
      if (operation.data.size() != 1 || !operation.data.contains("enabled"))
        throw Error("ERR_RTC_ARGUMENT", "Only enabled is accepted", MONKY_ENGINE_INVALID);
      const bool enabled = Boolean(operation.data, "enabled");
      try {
        if (source) source->SetEnabled(enabled); else audio_source->SetEnabled(enabled);
        GateSource(target);
        cancellation->Check();
      } catch (...) {
        const auto failure = std::current_exception();
        try {
          if (source) source->SetEnabled(false); else audio_source->SetEnabled(false);
          GateSource(target);
        }
        catch (...) { RememberRollbackFailure(target); }
        std::rethrow_exception(failure);
      }
      return {{"enabled", enabled}};
    }
    if (operation.name == "resource.close") {
      {
        std::lock_guard lock(mutex_);
        // Admission proved ownership. An earlier cancelled command or another
        // valid close can already have completed this exact resource's teardown.
        if (!resources_.Contains(target)) return Json::object();
        resources_.ValidateClose(target, operation.data);
      }
      if (auto source = FindSource(target)) {
        if (peers_->UsesSource(target) || sfu_->UsesSource(target))
          throw Error("ERR_RTC_SOURCE_IN_USE", "Close publications before their source", MONKY_ENGINE_BUSY);
        source->Close();
        {
          std::lock_guard lock(mutex_);
          sources_.erase(target);
        }
        ForgetResource(target);
      } else if (auto source = FindAudioSource(target)) {
        source->accepting.store(false);
        Audio()->FenceCapture(cancellation);
        source->Close();
        { std::lock_guard lock(mutex_); audio_sources_.erase(target); }
        ForgetResource(target);
      } else if (peers_->Contains(target)) peers_->Close(target);
      else if (sfu_->Contains(target)) sfu_->Close(target);
      else throw Error("ERR_RTC_RESOURCE_STATE", "Registered resource has no live controller");
      return Json::object();
    }
    throw Error("ERR_RTC_COMMAND", "Unsupported command", MONKY_ENGINE_UNSUPPORTED);
  }

  void RememberFailure(const Error& error) noexcept {
    try {
      auto data = ErrorJson(error);
      {
        std::lock_guard lock(mutex_);
        if (failure_.is_null()) failure_ = data;
      }
      data["terminal"] = true;
      Emit("error", 0, std::move(data));
    } catch (...) {
      std::fputs("[monky-rtc] Could not retain a native failure report; closing.\n", stderr);
      RequestClose();
    }
  }

  void RememberCurrentFailure() noexcept {
    try { RememberFailure(CurrentError()); }
    catch (...) {
      std::fputs("[monky-rtc] Native error reporting failed; closing while retaining ownership.\n", stderr);
      RequestClose();
    }
  }

  void RememberRollbackFailure(std::uint64_t target) noexcept {
    try {
      const auto error = CurrentError();
      // Controllers already retire their affected PC/transport when a cancelled
      // server acknowledgement cannot be obtained. Do not close other sources.
      if (error.status == MONKY_ENGINE_CANCELLED || error.status == MONKY_ENGINE_TIMEOUT) {
        auto data = ErrorJson(error);
        data["terminal"] = false;
        Emit("error", target, std::move(data));
      } else {
        RememberFailure(error);
        RequestClose();
      }
    } catch (...) { RememberCurrentFailure(); RequestClose(); }
  }

  void RefreshControlSnapshot() {
    auto peers = peers_ ? peers_->Snapshot() : Json(nullptr);
    auto sfu = sfu_ ? sfu_->Snapshot() : Json(nullptr);
    const auto context = MfContext();
    auto mf = Json(nullptr);
    if (context) {
      const auto stats = context->Snapshot();
      auto encoders = Json::array();
      for (const auto& encoder : stats.encoders) encoders.push_back(EncoderRuntimeJson(encoder));
      auto decoders = Json::array();
      for (const auto& decoder : stats.decoders) decoders.push_back(DecoderRuntimeJson(decoder));
      mf = {{"liveWorkers", stats.live_workers}, {"nativeBuffers", stats.native_buffers},
            {"diagnosticsOverwritten", stats.diagnostics_overwritten},
            {"encodedAccessUnits", stats.encoded_access_units}, {"decodedGpuFrames", stats.decoded_gpu_frames},
            {"rtcRejectedAccessUnits", stats.rtc_rejected_access_units},
            {"encoders", std::move(encoders)},
            {"decoders", std::move(decoders)},
            {"i420Readbacks", stats.i420_readbacks}, {"i420Failures", stats.i420_failures},
            {"hardwareExecutionObserved", stats.hardware_execution_observed ?
                Json(*stats.hardware_execution_observed) : Json(nullptr)}};
    }
    std::lock_guard lock(mutex_);
    peer_snapshot_ = std::move(peers);
    sfu_snapshot_ = std::move(sfu);
    mf_snapshot_ = std::move(mf);
  }

  void ControlSnapshotPublicationFailed() noexcept {
    InvalidateControlSnapshots(mutex_, peer_snapshot_, sfu_snapshot_, mf_snapshot_);
    RequestClose();
    RememberCurrentFailure();
  }

  void DrainDiagnostics() {
    RefreshControlSnapshot();
    const auto context = MfContext();
    if (!context) return;
    for (const auto& diagnostic : context->TakeDiagnostics()) {
      auto data = Json{{"code", diagnostic.code.data()}, {"message", diagnostic.message.data()},
                       {"status", MONKY_ENGINE_FAILURE}, {"hresult", static_cast<std::int32_t>(diagnostic.hresult)},
                       {"codecStatus", diagnostic.codec_status}, {"adapterSessionId", diagnostic.session_id},
                       {"terminal", diagnostic.terminal}};
      if (diagnostic.terminal) {
        {
          std::lock_guard lock(mutex_);
          if (failure_.is_null()) failure_ = data;
        }
        RequestClose();
      }
      Emit("error", 0, std::move(data));
    }
  }

  void GateSource(std::uint64_t target) {
    std::exception_ptr failure;
    try { peers_->SourceEnabledChanged(target); } catch (...) { failure = std::current_exception(); }
    try { sfu_->SourceEnabledChanged(target); } catch (...) { if (!failure) failure = std::current_exception(); }
    if (failure) std::rethrow_exception(failure);
  }

  void RollbackCancelled(const Operation& operation, const Json& result) {
    if (operation.name == "audio.configureOutput") {
      Audio()->StopOutput(operation.data);
      return;
    }
    std::uint64_t target = operation.cancellation->target;
    for (const auto* key : {"sourceId", "peerId", "publicationId", "deviceId",
                             "transportId", "producerId", "consumerId"}) {
      if (result.contains(key) && result.at(key).is_number_unsigned()) {
        target = result.at(key).get<std::uint64_t>();
        break;
      }
    }
    if (operation.name.ends_with("getStats") || operation.name == "peer.createOffer" ||
        operation.name == "peer.createAnswer" || operation.name == "resource.close") return;
    if (auto source = FindSource(target)) {
      if (operation.name == "source.setEnabled") {
        source->SetEnabled(false);
        GateSource(target);
      } else {
        source->Close();
        {
          std::lock_guard lock(mutex_);
          sources_.erase(target);
        }
        ForgetResource(target);
      }
    } else if (auto source = FindAudioSource(target)) {
      source->accepting.store(false);
      source->SetEnabled(false);
      GateSource(target);
      if (operation.name == "source.createAudio") {
        source->Close();
        { std::lock_guard lock(mutex_); audio_sources_.erase(target); }
        ForgetResource(target);
      }
    } else if (peers_->Contains(target)) peers_->Close(target);
    else if (sfu_->Contains(target)) {
      // Producer/consumer close would request an acknowledgement from the very
      // operation being cancelled. Retire its native screen transport instead.
      if (operation.name == "sfu.produce" || operation.name == "sfu.consume" ||
          operation.name == "sfu.setProducerEnabled" || operation.name == "sfu.setConsumerEnabled") {
        std::lock_guard lock(mutex_);
        if (const auto parent = resources_.Parent(target)) target = *parent;
      }
      sfu_->Close(target);
    }
  }

  struct CompletionActions {
    Engine& engine;
    const Operation& operation;
    Json Execute() { return engine.Execute(operation); }
    void RefreshControlSnapshot() { engine.RefreshControlSnapshot(); }
    auto Now() const { return std::chrono::steady_clock::now(); }
    void RollbackCancelled(const Json& result) { engine.RollbackCancelled(operation, result); }
    void RememberRollbackFailure() noexcept {
      engine.RememberRollbackFailure(operation.cancellation->target);
    }
    Json CurrentErrorJson() const { return ErrorJson(CurrentError()); }
    void ControlSnapshotPublicationFailed() noexcept { engine.ControlSnapshotPublicationFailed(); }
    void Deliver(Json result) {
      engine.Emit("operation", operation.cancellation->target, std::move(result));
    }
  };

  void Run() noexcept {
    bool apartment = false;
    try {
      const auto hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
      if (FAILED(hr)) throw Error("ERR_RTC_COM", "Cannot initialize control actor COM", MONKY_ENGINE_FAILURE, hr);
      apartment = true;
      Initialize();
    } catch (...) { RememberCurrentFailure(); RequestClose(); }
    try {
      for (;;) {
        DrainDiagnostics();
        std::optional<Operation> operation;
        {
          std::unique_lock lock(mutex_);
          // Control-plane error observation, not media pacing.
          wake_.wait_for(lock, std::chrono::milliseconds(100), [&] { return closing_ || !queue_.empty(); });
          if (queue_.empty() && closing_) break;
          if (queue_.empty()) continue;
          operation.emplace(std::move(queue_.front()));
          queue_.pop_front();
          active_operation_ = operation->cancellation;
        }
        ExecuteAndCompleteOperation(operation->name, mutex_, operations_, active_operation_,
                                    operation->cancellation, CompletionActions{*this, *operation});
      }
    } catch (...) { RememberCurrentFailure(); RequestClose(); }
    // All pending Node-dependent waits were cancelled BEFORE the actor gets
    // here. Teardown never relies on Node fulfilling a future queued behind it.
    std::shared_ptr<presentation::Exporter> exporter;
    {
      std::lock_guard lock(mutex_);
      exporter = presenter_;
    }
    if (exporter) exporter->BeginStop();
    {
      std::shared_ptr<audio::AudioRuntime> audio;
      { std::lock_guard lock(mutex_); audio = audio_runtime_; }
      if (audio) audio->Stop();
    }
    bool retired = false;
    while (!retired) {
      try {
        if (sfu_) sfu_->CloseAll();
        if (peers_) peers_->CloseAll();
        std::vector<std::pair<std::uint64_t, std::shared_ptr<VideoSource>>> sources;
        {
          std::lock_guard lock(mutex_);
          for (const auto& item : sources_) sources.push_back(item);
        }
        for (const auto& [id, source] : sources) {
          source->Close();
          std::lock_guard lock(mutex_);
          sources_.erase(id);
          resources_.Erase(id);
        }
        std::vector<std::shared_ptr<audio::AudioSource>> audio_sources;
        { std::lock_guard lock(mutex_); for (const auto& [id, source] : audio_sources_) audio_sources.push_back(source); }
        for (const auto& source : audio_sources) {
          source->Close();
          std::lock_guard lock(mutex_);
          audio_sources_.erase(source->id);
          resources_.Erase(source->id);
        }
        if (exporter && !exporter->WaitClosed(std::chrono::milliseconds(100))) continue;
        {
          std::unique_lock lock(mutex_);
          wake_.wait(lock, [&] { return frames_.empty(); });
        }
        const auto context = MfContext();
        if (context && !context->WaitForIdle(std::chrono::milliseconds(100))) continue;
        DrainDiagnostics();
        if (exporter) {
          auto snapshot = exporter->Snapshot();
          std::lock_guard lock(mutex_);
          presentation_snapshot_ = std::move(snapshot);
        }
        retired = true;
      } catch (...) {
        RememberCurrentFailure();
        std::unique_lock lock(mutex_);
        wake_.wait_for(lock, std::chrono::milliseconds(100));
      }
    }
    sfu_.reset();
    peers_.reset();
    if (signaling_started_)
      signaling_->BlockingCall([&] { factory_ = nullptr; });
    else factory_ = nullptr;
    if (signaling_started_) signaling_->Stop();
    if (worker_started_) worker_->Stop();
    if (network_started_) network_->Stop();
    if (const auto capture_clock = CaptureTimebase()) capture_clock->Close();
    { std::lock_guard lock(mutex_); audio_runtime_.reset(); }
    environment_.reset();
    if (ssl_started_ && !webrtc::CleanupSSL()) {
      try { throw Error("ERR_RTC_SSL_CLEANUP", "RTC SSL cleanup failed"); }
      catch (...) { RememberCurrentFailure(); }
    }
    {
      std::lock_guard lock(mutex_);
      mf_context_.reset();
      presenter_.reset();
    }
    exporter.reset();
    if (apartment) CoUninitialize();
    {
      std::lock_guard lock(mutex_);
      done_ = true;
      ready_ = false;
      queue_.clear();
      operations_.clear();
      replies_.clear();
      active_operation_.reset();
    }
    try { Emit("closed", 0, Snapshot()); }
    catch (...) { RememberCurrentFailure(); }
    wake_.notify_all();
  }

  const MonkyEngineOptions options_;
  const bool encoded_input_;
  mutable std::mutex mutex_;
  std::condition_variable wake_;
  std::mutex callback_mutex_, join_mutex_;
  MonkyEngineCallbacks callbacks_;
  std::atomic<bool> closing_{false};
  bool ready_ = false, done_ = false;
  Json failure_ = nullptr;
  Json peer_snapshot_ = nullptr, sfu_snapshot_ = nullptr, mf_snapshot_ = nullptr;
  Json presentation_snapshot_ = nullptr;
  std::uint64_t next_id_ = 1;
  ResourceRegistry resources_;
  ReceiveRoutes receive_routes_;
  OperationReservations operations_;
  std::shared_ptr<Cancellation> active_operation_;
  std::map<std::uint64_t, std::shared_ptr<Reply>> replies_;
  std::deque<Operation> queue_;
  std::map<std::uint64_t, std::shared_ptr<VideoSource>> sources_;
  std::map<std::uint64_t, std::shared_ptr<audio::AudioSource>> audio_sources_;
  std::shared_ptr<audio::AudioRuntime> audio_runtime_;
  std::map<std::uint64_t, Frame> frames_;
  std::atomic<std::uint64_t> dropped_frames_{0};
  std::atomic<std::uint64_t> rejected_events_{0};
  std::thread actor_;
  std::unique_ptr<webrtc::Thread> network_, worker_, signaling_;
  bool network_started_ = false, worker_started_ = false, signaling_started_ = false;
  bool ssl_started_ = false;
  webrtc::scoped_refptr<webrtc::PeerConnectionFactoryInterface> factory_;
  std::shared_ptr<mf::NativeRtcContext> mf_context_;
  std::shared_ptr<EncodedVideoContext> encoded_context_;
  std::shared_ptr<CaptureClock> capture_clock_;
  std::shared_ptr<presentation::Exporter> presenter_;
  std::optional<webrtc::Environment> environment_;
  std::unique_ptr<PeerController> peers_;
  std::unique_ptr<SfuController> sfu_;
};

}  // namespace monky::native_rtc::engine

struct MonkyRtcEngine {
  std::shared_ptr<monky::native_rtc::engine::Engine> state;
};

namespace {
namespace rtc = monky::native_rtc::engine;

MonkyEngineStatus StoreError(MonkyEngineError* output, const rtc::Error& error) noexcept {
  if (output && output->struct_size == sizeof(*output)) {
    output->status = error.status;
    output->hresult = error.hr;
    output->reserved = 0;
    std::snprintf(output->code, sizeof(output->code), "%s", error.code.c_str());
    std::snprintf(output->message, sizeof(output->message), "%s", error.what());
  }
  return error.status;
}
template <typename Function>
MonkyEngineStatus Boundary(MonkyEngineError* error, Function&& function) noexcept {
  if (!error || error->struct_size != sizeof(*error)) return MONKY_ENGINE_INVALID;
  error->status = MONKY_ENGINE_OK;
  error->hresult = error->reserved = 0;
  error->code[0] = error->message[0] = '\0';
  try { function(); return MONKY_ENGINE_OK; }
  catch (...) {
    try { return StoreError(error, rtc::CurrentError()); }
    catch (...) {
      error->status = MONKY_ENGINE_FAILURE;
      error->hresult = E_OUTOFMEMORY;
      std::snprintf(error->code, sizeof(error->code), "%s", "ERR_RTC_MEMORY");
      std::snprintf(error->message, sizeof(error->message), "%s", "Native error reporting allocation failed");
      return MONKY_ENGINE_FAILURE;
    }
  }
}
rtc::Engine& State(MonkyRtcEngine* engine) {
  if (!engine || !engine->state)
    throw rtc::Error("ERR_RTC_ENGINE", "A live engine handle is required", MONKY_ENGINE_INVALID);
  return *engine->state;
}
MonkyEngineStatus Copy(const std::string_view value, char* output, std::uint32_t capacity,
                       std::uint32_t* required) {
  if (!required || (!output && capacity)) return MONKY_ENGINE_INVALID;
  *required = static_cast<std::uint32_t>(value.size()) + 1;
  if (!output || capacity < *required) return MONKY_ENGINE_BUFFER_TOO_SMALL;
  std::memcpy(output, value.data(), value.size());
  output[value.size()] = '\0';
  return MONKY_ENGINE_OK;
}
}  // namespace

extern "C" MONKY_ENGINE_API MonkyEngineStatus __cdecl monky_rtc_engine_capabilities(
    char* output, uint32_t capacity, uint32_t* required) noexcept {
  return Copy(rtc::kCapabilities, output, capacity, required);
}
extern "C" MONKY_ENGINE_API MonkyEngineStatus __cdecl monky_rtc_engine_create(
    const MonkyEngineOptions* options, const MonkyEngineCallbacks* callbacks,
    MonkyRtcEngine** engine, MonkyEngineError* error) noexcept {
  if (engine) *engine = nullptr;
  return Boundary(error, [&] {
    if (!engine || !options || !callbacks || callbacks->struct_size != sizeof(*callbacks) ||
        callbacks->abi_version != MONKY_ENGINE_ABI_VERSION || !callbacks->on_event)
      throw rtc::Error("ERR_RTC_ABI", "Invalid engine callback/option ABI", MONKY_ENGINE_INVALID);
    rtc::ValidateOptions(*options);
    auto result = std::make_unique<MonkyRtcEngine>();
    result->state = std::make_shared<rtc::Engine>(*options, *callbacks);
    result->state->Start();
    *engine = result.release();
  });
}
extern "C" MONKY_ENGINE_API MonkyEngineStatus __cdecl monky_rtc_engine_request(
    MonkyRtcEngine* engine, uint64_t id, const char* name, uint32_t name_bytes, uint64_t target,
    const char* json, uint32_t bytes, MonkyEngineError* error) noexcept {
  return Boundary(error, [&] { State(engine).Request(id, rtc::Bytes(name, name_bytes, 64), target, rtc::Parse(json, bytes)); });
}
extern "C" MONKY_ENGINE_API MonkyEngineStatus __cdecl monky_rtc_engine_create_encoded(
    const MonkyEngineOptions* options, const MonkyEngineCallbacks* callbacks,
    MonkyRtcEngine** engine, MonkyEngineError* error) noexcept {
  if (engine) *engine = nullptr;
  return Boundary(error, [&] {
    if (!engine || !options || !callbacks || callbacks->struct_size != sizeof(*callbacks) ||
        callbacks->abi_version != MONKY_ENGINE_ABI_VERSION || !callbacks->on_event)
      throw rtc::Error("ERR_RTC_ABI", "Invalid encoded engine callback/option ABI", MONKY_ENGINE_INVALID);
    rtc::ValidateOptions(*options);
    if (options->maximum_h264_level < rtc::kEncodedH264Level)
      throw rtc::Error("ERR_RTC_ENCODED_LEVEL", "External 1080p120 H264 requires Main level5.1", MONKY_ENGINE_UNSUPPORTED);
    auto result = std::make_unique<MonkyRtcEngine>();
    result->state = std::make_shared<rtc::Engine>(*options, *callbacks, true);
    result->state->Start();
    *engine = result.release();
  });
}
extern "C" MONKY_ENGINE_API MonkyEngineStatus __cdecl monky_rtc_engine_respond(
    MonkyRtcEngine* engine, uint64_t id, const char* json, uint32_t bytes, MonkyEngineError* error) noexcept {
  return Boundary(error, [&] { State(engine).Respond(id, rtc::Parse(json, bytes)); });
}
extern "C" MONKY_ENGINE_API MonkyEngineStatus __cdecl monky_rtc_engine_cancel(
    MonkyRtcEngine* engine, uint64_t id, MonkyEngineError* error) noexcept {
  return Boundary(error, [&] { State(engine).Cancel(id); });
}
extern "C" MONKY_ENGINE_API MonkyEngineStatus __cdecl monky_rtc_engine_submit_frame(
    MonkyRtcEngine* engine, uint64_t source, const MonkyEngineInputFrame* frame, MonkyEngineError* error) noexcept {
  return Boundary(error, [&] {
    if (!frame) throw rtc::Error("ERR_RTC_FRAME", "Input descriptor is required", MONKY_ENGINE_INVALID);
    State(engine).Submit(source, *frame);
  });
}
extern "C" MONKY_ENGINE_API MonkyEngineStatus __cdecl monky_rtc_engine_submit_encoded_frame(
    MonkyRtcEngine* engine, uint64_t source, const MonkyEngineEncodedFrame* frame, MonkyEngineError* error) noexcept {
  return Boundary(error, [&] {
    if (!frame) throw rtc::Error("ERR_RTC_ENCODED_FRAME", "Encoded input descriptor is required", MONKY_ENGINE_INVALID);
    State(engine).SubmitEncoded(source, *frame);
  });
}
extern "C" MONKY_ENGINE_API MonkyEngineStatus __cdecl monky_rtc_engine_frame_com(
    MonkyRtcEngine* engine, uint64_t id, MonkyEngineFrameCom* frame, MonkyEngineError* error) noexcept {
  return Boundary(error, [&] {
    if (!frame) throw rtc::Error("ERR_RTC_FRAME", "Output descriptor is required", MONKY_ENGINE_INVALID);
    State(engine).GetFrame(id, *frame);
  });
}
extern "C" MONKY_ENGINE_API MonkyEngineStatus __cdecl monky_rtc_engine_release_frame(
    MonkyRtcEngine* engine, uint64_t id, uint32_t reason, MonkyEngineError* error) noexcept {
  return Boundary(error, [&] { State(engine).ReleaseFrame(id, reason); });
}
extern "C" MONKY_ENGINE_API MonkyEngineStatus __cdecl monky_rtc_engine_frame_shared(
    MonkyRtcEngine* engine, uint64_t id, MonkyEngineSharedFrame* frame, MonkyEngineError* error) noexcept {
  return Boundary(error, [&] {
    if (!frame) throw rtc::Error("ERR_RTC_FRAME", "Shared output descriptor is required", MONKY_ENGINE_INVALID);
    State(engine).GetSharedFrame(id, *frame);
  });
}
extern "C" MONKY_ENGINE_API MonkyEngineStatus __cdecl monky_rtc_engine_snapshot(
    MonkyRtcEngine* engine, char* output, uint32_t capacity, uint32_t* required,
    MonkyEngineError* error) noexcept {
  MonkyEngineStatus copied = MONKY_ENGINE_FAILURE;
  const auto status = Boundary(error, [&] { copied = Copy(State(engine).Snapshot().dump(), output, capacity, required); });
  return status == MONKY_ENGINE_OK ? copied : status;
}
extern "C" MONKY_ENGINE_API MonkyEngineStatus __cdecl monky_rtc_engine_submit_audio_packet(
    MonkyRtcEngine* engine, uint64_t source, const MonkyEngineAudioPacket* packet,
    MonkyEngineError* error) noexcept {
  return Boundary(error, [&] {
    if (!packet) throw rtc::Error("ERR_RTC_AUDIO_PACKET", "Audio packet descriptor is required", MONKY_ENGINE_INVALID);
    State(engine).SubmitAudio(source, *packet);
  });
}
extern "C" MONKY_ENGINE_API MonkyEngineStatus __cdecl monky_rtc_engine_read_audio_playout(
    MonkyRtcEngine* engine, uint64_t epoch, uint64_t sequence, MonkyEngineAudioPlayout* packet,
    MonkyEngineError* error) noexcept {
  return Boundary(error, [&] {
    if (!packet) throw rtc::Error("ERR_RTC_AUDIO_PACKET", "Audio output descriptor is required", MONKY_ENGINE_INVALID);
    State(engine).Audio()->ReadOutput(epoch, sequence, *packet);
  });
}
extern "C" MONKY_ENGINE_API MonkyEngineStatus __cdecl monky_rtc_engine_audio_command(
    MonkyRtcEngine* engine, const char* command, uint32_t command_bytes, const char* json,
    uint32_t json_bytes, MonkyEngineAudioReply* reply, MonkyEngineError* error) noexcept {
  return Boundary(error, [&] {
    if (!reply || reply->struct_size != sizeof(*reply) ||
        reply->extension_version != MONKY_ENGINE_AUDIO_EXTENSION_VERSION || reply->reserved || json_bytes > 4096)
      throw rtc::Error("ERR_RTC_AUDIO_REPLY", "Invalid audio command/reply POD", MONKY_ENGINE_INVALID);
    const auto result = State(engine).Audio()->Command(
        rtc::Bytes(command, command_bytes, 32), rtc::Parse(json, json_bytes)).dump();
    if (result.size() >= sizeof(reply->json))
      throw rtc::Error("ERR_RTC_AUDIO_REPLY", "Audio metadata reply exceeds its fixed bound");
    reply->reserved = 0;
    reply->json_bytes = static_cast<uint32_t>(result.size());
    std::memcpy(reply->json, result.c_str(), result.size() + 1);
  });
}
extern "C" MONKY_ENGINE_API MonkyEngineStatus __cdecl monky_rtc_engine_close(
    MonkyRtcEngine* engine, MonkyEngineError* error) noexcept {
  return Boundary(error, [&] { State(engine).RequestClose(); });
}
extern "C" MONKY_ENGINE_API MonkyEngineStatus __cdecl monky_rtc_engine_wait_closed(
    MonkyRtcEngine* engine, uint32_t timeout, MonkyEngineError* error) noexcept {
  return Boundary(error, [&] { State(engine).WaitClosed(timeout); });
}
extern "C" MONKY_ENGINE_API MonkyEngineStatus __cdecl monky_rtc_engine_detach_callbacks(
    MonkyRtcEngine* engine, MonkyEngineError* error) noexcept {
  return Boundary(error, [&] { State(engine).DetachCallbacks(); });
}
extern "C" MONKY_ENGINE_API MonkyEngineStatus __cdecl monky_rtc_engine_destroy(
    MonkyRtcEngine* engine, MonkyEngineError* error) noexcept {
  return Boundary(error, [&] {
    State(engine).RequireDestroyable();
    State(engine).DetachCallbacks();
    delete engine;
  });
}
