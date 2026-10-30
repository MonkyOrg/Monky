#pragma once

// Validation of each native event against the frozen contract, and its dispatch to JS on the Node thread.
// Part of the single napi_engine.cc translation unit, which is the only file that includes it.

#include "napi_lifecycle.h"

namespace {

napi_value EventError(napi_env env, napi_value value, bool require_numbers = true) {
  Record(env, value, "Native error data must be an object");
  const auto code = String(env, Get(env, value, "code"), 1, 79,
                            "Native error code must contain 1..79 UTF-8 bytes");
  const auto message = String(env, Get(env, value, "message"), 1, kMaxJsonBytes,
                               "Native error message must be a nonempty string");
  int64_t status = MONKY_ENGINE_FAILURE;
  int64_t hresult = 0;
  if (require_numbers || Has(env, value, "status")) {
    status = Integer(env, Get(env, value, "status"),
                     std::numeric_limits<int32_t>::min(),
                     std::numeric_limits<int32_t>::max(),
                     "Native error status must be an int32 safe integer");
  }
  if (require_numbers || Has(env, value, "hresult")) {
    hresult = Integer(env, Get(env, value, "hresult"),
                      std::numeric_limits<int32_t>::min(),
                      std::numeric_limits<int32_t>::max(),
                      "Native HRESULT must be a signed int32 safe integer");
  }
  napi_value error;
  Check(env, napi_create_error(env, Text(env, code.data(), code.size()),
                               Text(env, message.data(), message.size()), &error));
  DefineNumber(env, error, "status", static_cast<double>(status));
  DefineNumber(env, error, "hresult", static_cast<double>(hresult));
  return error;
}

void MatchId(napi_env env, napi_value data, const char* name, uint64_t expected) {
  if (Id(env, Get(env, data, name)) != expected) {
    ContractFailure(env, "The event's JSON ID does not match its typed C ID");
  }
}

void TrackMetadata(napi_env env, napi_value data) {
  String(env, Get(env, data, "trackId"), 1, 256, "trackId must contain 1..256 UTF-8 bytes");
  const auto mid = Get(env, data, "mid");
  if (Type(env, mid) != napi_null) {
    String(env, mid, 1, 256, "mid must be null or contain 1..256 UTF-8 bytes");
  }
  const auto streams = Get(env, data, "streamIds");
  bool array = false;
  Check(env, napi_is_array(env, streams, &array));
  if (!array) ContractFailure(env, "streamIds must be an array");
  uint32_t count = 0;
  Check(env, napi_get_array_length(env, streams, &count));
  if (count > 64) ContractFailure(env, "streamIds must contain at most 64 entries");
  for (uint32_t i = 0; i < count; ++i) {
    napi_value stream;
    Check(env, napi_get_element(env, streams, i, &stream));
    String(env, stream, 1, 256, "Each streamId must contain 1..256 UTF-8 bytes");
  }
}

void ReceiverMetadata(napi_env env, napi_value data) {
  Id(env, Get(env, data, "receiverId"));
  Id(env, Get(env, data, "receiverEpoch"));
  const auto kind = String(env, Get(env, data, "kind"), 5, 5, "Receiver kind must be video or audio");
  if (kind != "video" && kind != "audio") {
    ContractFailure(env, "Only video/audio receiver routing is implemented");
  }
  TrackMetadata(env, data);
  if (Has(env, data, "reason")) {
    String(env, Get(env, data, "reason"), 1, 1024, "Receiver reason must contain 1..1024 UTF-8 bytes");
  }
}

void PublicationMetadata(napi_env env, napi_value data) {
  Id(env, Get(env, data, "publicationId"));
  const auto kind = String(env, Get(env, data, "kind"), 5, 5, "Publication kind must be video or audio");
  if (kind != "video" && kind != "audio") ContractFailure(env, "Invalid publication kind");
  TrackMetadata(env, data);
}

napi_value SharedFrameEnvelope(napi_env env, const StateOwner& state,
                                const QueuedEvent& event, napi_value data) {
  MatchId(env, data, "frameId", event.id);
  const auto route = String(env, Get(env, data, "routeKind"), 4, 8,
                            "Decoded routeKind must be peer or consumer");
  uint64_t receiver = 0, receiver_epoch = 0;
  if (route == "peer") {
    receiver = Id(env, Get(env, data, "receiverId"));
    receiver_epoch = Id(env, Get(env, data, "receiverEpoch"));
  } else if (route != "consumer" || Has(env, data, "receiverId") || Has(env, data, "receiverEpoch")) {
    ContractFailure(env, "Consumer frames must omit peer receiver identity");
  }
  const auto width = Integer(env, Get(env, data, "width"), 1, INT32_MAX,
                              "Decoded width must be a positive int32");
  const auto height = Integer(env, Get(env, data, "height"), 1, INT32_MAX,
                               "Decoded height must be a positive int32");
  const auto coded_width = Integer(env, Get(env, data, "codedWidth"), width, INT32_MAX,
                                    "Decoded codedWidth must contain the visible width");
  const auto coded_height = Integer(env, Get(env, data, "codedHeight"), height, INT32_MAX,
                                     "Decoded codedHeight must contain the visible height");
  const auto timestamp = Integer(env, Get(env, data, "timestampUs"),
      -static_cast<int64_t>(kMaxSafeInteger), kMaxSafeInteger,
      "Decoded timestampUs must be a signed safe integer");
  if (String(env, Get(env, data, "format"), 4, 4, "Decoded format must be NV12") != "NV12") {
    ContractFailure(env, "Only explicit NV12 decoded leases are supported");
  }
  const bool gpu_copy = Boolean(env, Get(env, data, "gpuCopy"), "Decoded gpuCopy must be boolean");

  MonkyEngineSharedFrame frame{};
  frame.struct_size = sizeof(frame);
  frame.abi_version = MONKY_ENGINE_ABI_VERSION;
  {
    NativeAccess native(*state);
    RequireNative(env, native);
    MonkyEngineError error = EmptyError();
    // Plain borrowed metadata/HANDLE access: no GPU work or wait on Node's thread.
    const auto status = monky_rtc_engine_frame_shared(native.get(), event.id, &frame, &error);
    if (status != MONKY_ENGINE_OK) ThrowNative(env, status, error);
  }
  if (frame.struct_size != sizeof(MonkyEngineSharedFrame) ||
      frame.abi_version != MONKY_ENGINE_ABI_VERSION || frame.reserved ||
      frame.pixel_format != MONKY_ENGINE_PIXEL_FORMAT_NV12 ||
      frame.flags != kSharedFrameFlags || frame.gpu_copy_count != static_cast<uint32_t>(gpu_copy) ||
#if defined(_WIN32)
      !gpu_copy ||
#else
      gpu_copy || frame.texture_nt_handle > UINT32_MAX ||
#endif
      !frame.texture_nt_handle || frame.texture_nt_handle > INT64_MAX) {
    ContractFailure(env, "Invalid shared NV12 ABI, copy/reclamation flags or borrowed NT HANDLE");
  }
  if (!frame.coded_width || !frame.coded_height ||
      frame.coded_width > INT32_MAX || frame.coded_height > INT32_MAX ||
      (frame.coded_width & 1u) || (frame.coded_height & 1u) ||
      (frame.visible_x & 1u) || (frame.visible_y & 1u) ||
      !frame.width || !frame.height ||
      frame.visible_x > frame.coded_width || frame.visible_y > frame.coded_height ||
      frame.width > frame.coded_width - frame.visible_x ||
      frame.height > frame.coded_height - frame.visible_y ||
      frame.timestamp_us < -static_cast<int64_t>(kMaxSafeInteger) ||
      frame.timestamp_us > static_cast<int64_t>(kMaxSafeInteger)) {
    ContractFailure(env, "Shared NV12 geometry, chroma alignment or timestamp is invalid");
  }
  if (frame.width != width || frame.height != height ||
      frame.coded_width != coded_width || frame.coded_height != coded_height ||
      frame.timestamp_us != timestamp) {
    ContractFailure(env, "Shared NV12 metadata differs from the admitted decoded event");
  }

  napi_value handle, buffer_prototype;
  void* copied = nullptr;
  Check(env, napi_get_reference_value(env, state->buffer_prototype, &buffer_prototype));
  Check(env, napi_create_buffer_copy(env, sizeof(frame.texture_nt_handle),
      &frame.texture_nt_handle, &copied, &handle));
  if (!copied || HandleBytes(env, handle, buffer_prototype) != frame.texture_nt_handle) {
    ContractFailure(env, "Shared NT HANDLE must be copied losslessly into an ordinary 8-byte Buffer");
  }
  // Electron45alpha6 duplicates this borrowed HANDLE internally. Neither this
  // Buffer nor the Node consumer owns a CloseHandle obligation.
  auto handles = Object(env);
#if defined(_WIN32)
  Define(env, handles, "ntHandle", handle);
#else
  Define(env, handles, "ioSurfaceId", handle);
#endif
  auto coded_size = Object(env);
  DefineNumber(env, coded_size, "width", frame.coded_width);
  DefineNumber(env, coded_size, "height", frame.coded_height);
  auto visible_rect = Object(env);
  DefineNumber(env, visible_rect, "x", frame.visible_x);
  DefineNumber(env, visible_rect, "y", frame.visible_y);
  DefineNumber(env, visible_rect, "width", frame.width);
  DefineNumber(env, visible_rect, "height", frame.height);
  auto color_space = Object(env);
  Define(env, color_space, "primaries", Text(env, "bt709"));
  Define(env, color_space, "transfer", Text(env, "bt709"));
  Define(env, color_space, "matrix", Text(env, "bt709"));
  Define(env, color_space, "range", Text(env, "limited"));
  auto texture_info = Object(env);
  Define(env, texture_info, "pixelFormat", Text(env, "nv12"));
  Define(env, texture_info, "handle", handles);
  Define(env, texture_info, "codedSize", coded_size);
  Define(env, texture_info, "visibleRect", visible_rect);
  DefineNumber(env, texture_info, "timestamp", static_cast<double>(frame.timestamp_us));
  Define(env, texture_info, "colorSpace", color_space);

  // Do not attach the HANDLE to objects returned by a replaceable JSON.parse.
  // A fresh own-property envelope cannot expose it through a proxy/setter.
  auto output = Object(env);
  DefineNumber(env, output, "frameId", static_cast<double>(event.id));
  DefineNumber(env, output, "width", frame.width);
  DefineNumber(env, output, "height", frame.height);
  DefineNumber(env, output, "codedWidth", frame.coded_width);
  DefineNumber(env, output, "codedHeight", frame.coded_height);
  DefineNumber(env, output, "timestampUs", static_cast<double>(frame.timestamp_us));
  Define(env, output, "routeKind", Text(env, route.data(), route.size()));
  if (route == "peer") {
    DefineNumber(env, output, "receiverId", static_cast<double>(receiver));
    DefineNumber(env, output, "receiverEpoch", static_cast<double>(receiver_epoch));
  }
  Define(env, output, "format", Text(env, "NV12"));
  DefineBool(env, output, "gpuCopy", gpu_copy);
  Define(env, output, "textureInfo", texture_info);
  auto envelope = Object(env);
  Define(env, envelope, "type", Text(env, "frame"));
  DefineNumber(env, envelope, "target", static_cast<double>(event.target));
  Define(env, envelope, "data", output);
  return envelope;
}

// Rate, keyframe and recovery feedback of an encoded source never confirms what the native side did not observe.
void ValidateEncodedFeedback(napi_env env, const QueuedEvent& event, napi_value data) {
  if (!event.target || event.id) ContractFailure(env, "Encoded feedback requires its source target");
  MatchId(env, data, "sourceId", event.target);
  Id(env, Get(env, data, "sequence"));
  if (Boolean(env, Get(env, data, "keyframeConfirmed"), "Keyframe confirmation must be boolean"))
    ContractFailure(env, "Encoded feedback cannot confirm an unobserved IDR");
  const auto kind = String(env, Get(env, data, "kind"), 1, 32, "Encoded feedback kind must be bounded");
  if (kind == "keyframe" || kind == "recovery") {
    if (kind == "keyframe") Id(env, Get(env, data, "encoderId"));
    else {
      Id(env, Get(env, data, "frameId"));
      Id(env, Get(env, data, "generation"));
      const auto reason = String(env, Get(env, data, "reason"), 1, 32, "Encoded recovery reason must be bounded");
      constexpr std::string_view reasons[] = {
        "rtc-unconsumed", "input-expired", "publication-expired", "codec-expired",
        "clock-sample-uncertain", "clock-frame-dropped", "dispatch-delayed",
      };
      if (std::find(std::begin(reasons), std::end(reasons), reason) == std::end(reasons))
        ContractFailure(env, "Unknown encoded dependency recovery reason");
    }
    if (String(env, Get(env, data, "mode"), 1, 32, "Invalid encoded recovery mode") != "next-real-idr" ||
        Id(env, Get(env, data, "maximumWaitMs")) != 1500)
      ContractFailure(env, "Encoded recovery must await a real IDR within1500ms");
  } else if (kind == "rate" || kind == "encoder-closed") {
    Id(env, Get(env, data, "encoderId"));
    Id(env, Get(env, data, "requestedBitrateBps"), true);
    if (Id(env, Get(env, data, "bitrateBps"), true) > 80000000 ||
        Id(env, Get(env, data, "bitrateCeilingBps")) != 80000000 ||
        Type(env, Get(env, data, "fpsApplied")) != napi_null)
      ContractFailure(env, "Encoded rate feedback exceeds its ceiling or fabricates applied FPS");
    Boolean(env, Get(env, data, "paused"), "Encoded pause must be boolean");
    const auto requested_fps = Get(env, data, "requestedFps");
    if (Type(env, requested_fps) != napi_number)
      ContractFailure(env, "Requested encoded FPS must be numeric");
    double fps = 0;
    Check(env, napi_get_value_double(env, requested_fps, &fps));
    if (!std::isfinite(fps) || fps < 0 || fps > (std::numeric_limits<std::uint32_t>::max)())
      ContractFailure(env, "Requested encoded FPS is outside its finite bound");
  } else ContractFailure(env, "Unknown encoded feedback kind");
}

// The signals the frozen engine contract allows, each with the target and fields it must carry.
void ValidateSignal(napi_env env, const std::string& type, const QueuedEvent& event, napi_value data) {
  if (type == "peer.trackAdded" || type == "peer.trackUpdated" || type == "peer.trackRemoved") {
    if (!event.target) ContractFailure(env, "Receiver signals require a peer target");
    ReceiverMetadata(env, data);
  } else if (type == "peer.publicationUpdated") {
    if (!event.target) ContractFailure(env, "Publication signals require a peer target");
    PublicationMetadata(env, data);
  } else if (type == MONKY_ENGINE_AUDIO_INVALIDATED) {
    if (event.target || event.id) ContractFailure(env, "Audio invalidation requires target zero");
    Id(env, Get(env, data, "epoch"));
    const auto reason = String(env, Get(env, data, "reason"), 1, 32,
                               "Audio invalidation reason must be a bounded string");
    constexpr std::string_view reasons[] = {
      MONKY_ENGINE_AUDIO_OWNER_STOP, MONKY_ENGINE_AUDIO_ENGINE_CLOSE,
      MONKY_ENGINE_AUDIO_TRANSPORT_DETACHED, MONKY_ENGINE_AUDIO_SETUP_FAILED, MONKY_ENGINE_AUDIO_MIXER_FAILURE
    };
    if (std::find(std::begin(reasons), std::end(reasons), reason) == std::end(reasons))
      ContractFailure(env, "Unknown audio invalidation reason");
  } else if (type == "audio.outputError") {
    if (event.target || event.id) ContractFailure(env, "Audio output errors require target zero");
    Id(env, Get(env, data, "epoch"));
    (void)EventError(env, data);
  } else if (type == "source.encodedFeedback") {
    ValidateEncodedFeedback(env, event, data);
  } else if (type == "source.encodedFrameReleased") {
    if (!event.target || event.id) ContractFailure(env, "Encoded copy retirement requires its source target");
    MatchId(env, data, "sourceId", event.target);
    Id(env, Get(env, data, "frameId"));
    if (Id(env, Get(env, data, "acceptedCodecCallbacks"), true) > 32 ||
        Id(env, Get(env, data, "explicitlyNotSent"), true) > 32 ||
        !Boolean(env, Get(env, data, "nativeCopyRetired"), "Encoded copy retirement must be boolean") ||
        Boolean(env, Get(env, data, "networkDeliveryConfirmed"), "Network delivery confirmation must be boolean"))
      ContractFailure(env, "Encoded copy retirement is not remote delivery proof");
    for (const auto* field : {"cancelled", "unconsumed", "pausedConsumerPresent"})
      Boolean(env, Get(env, data, field), "Encoded retirement outcome must be boolean");
  } else if (type != "peer.iceCandidate" && type != "peer.state" &&
             type != "peer.negotiationNeeded" && type != "sfu.state") {
    ContractFailure(env, "Unsupported signal event in the frozen engine contract");
  }
}

void ProcessEvent(napi_env env, const StateOwner& state, const QueuedEvent& event) {
  auto envelope = Parse(env, event.json);
  auto type = String(env, Get(env, envelope, "type"), 1, 128,
                     "The native event type must be a bounded string");
  if (Id(env, Get(env, envelope, "target"), true) != event.target) {
    ContractFailure(env, "The event's JSON target does not match its typed C target");
  }
  auto data = Get(env, envelope, "data");
  Record(env, data, "Native event data must be an object");
  if (state->abandoned.load() || state->environment_closing.load()) return;
  switch (event.kind) {
    case MONKY_ENGINE_EVENT_READY: {
      if (type != "ready" || event.target || event.id || state->ready_seen) {
        ContractFailure(env, "Invalid or duplicate native readiness event");
      }
      Record(env, Get(env, data, "capabilities"), "Readiness must include real native capabilities");
      state->ready_seen = true;
      Settle(env, state->ready, data, true);
      break;
    }
    case MONKY_ENGINE_EVENT_OPERATION: {
      if (type != "operation") ContractFailure(env, "Invalid native operation event");
      MatchId(env, data, "requestId", event.id);
      const bool ok = Boolean(env, Get(env, data, "ok"), "Operation ok must be boolean");
      if (ok && !Has(env, data, "result")) {
        ContractFailure(env, "A successful operation must include its actual result");
      }
      auto result = ok ? Get(env, data, "result") : EventError(env, Get(env, data, "error"));
      auto pending = state->operations.find(event.id);
      if (pending == state->operations.end()) {
        if (!state->completed) ContractFailure(env, "Completion refers to an unknown requestId");
        break;
      }
      const auto operation = pending->second.operation;
      const auto receiver = pending->second.receiver;
      const auto enabled = pending->second.enabled;
      if (ok && (operation == "peer.publish" || operation == "peer.publishAudio")) {
        Record(env, result, "peer.publish must return publication metadata");
        PublicationMetadata(env, result);
      } else if (ok && operation == "peer.setReceiverEnabled") {
        Record(env, result, "peer.setReceiverEnabled must return receiver metadata");
        MatchId(env, result, "receiverId", receiver);
        Id(env, Get(env, result, "receiverEpoch"));
        const bool effective = Boolean(env, Get(env, result, "enabled"),
                                       "Receiver enabled must be boolean");
        if (Boolean(env, Get(env, result, "requestedEnabled"),
                    "Receiver requestedEnabled must be boolean") != enabled ||
            (effective && !enabled)) {
          ContractFailure(env, "Receiver enable result does not match its request");
        }
      }
      // Metadata access can invoke user code through a replaced JSON.parse.
      pending = state->operations.find(event.id);
      if (pending == state->operations.end()) {
        ContractFailure(env, "Operation disappeared during result validation");
      }
      auto deferred = pending->second.deferred;
      state->operations.erase(pending);
      {
        std::lock_guard lock(state->event_mutex);
        for (auto it = state->callbacks.begin(); it != state->callbacks.end();) {
          if (it->second.request == event.id) it = state->callbacks.erase(it);
          else ++it;
        }
      }
      Settle(env, deferred, result, ok);
      break;
    }
    case MONKY_ENGINE_EVENT_REQUEST: {
      if (type != "request" || !event.target) ContractFailure(env, "Invalid server request event");
      MatchId(env, data, "callbackId", event.id);
      const auto request_id = Id(env, Get(env, data, "requestId"));
      String(env, Get(env, data, "method"), 1, 128, "Server method must be a bounded string");
      Record(env, Get(env, data, "payload"), "Server request payload must be an object");
      if (state->operations.find(request_id) == state->operations.end()) {
        ContractFailure(env, "Server request refers to an unknown pending operation");
      }
      bool admitted = false;
      {
        std::lock_guard lock(state->event_mutex);
        auto callback = state->callbacks.find(event.id);
        admitted = callback != state->callbacks.end() && callback->second.target == event.target;
        if (admitted) {
          callback->second.request = request_id;
        }
      }
      if (!admitted) ContractFailure(env, "Server callback does not own an admitted event");
      break;
    }
    case MONKY_ENGINE_EVENT_FRAME: {
      if (type != "frame" || !event.target) ContractFailure(env, "Invalid decoded frame event");
      if (state->closing) {
        ReleaseUndelivered(state, event.id);
        return;
      }
      bool valid_lease = false;
      {
        std::lock_guard lock(state->event_mutex);
        auto frame = state->decoded.find(event.id);
        // A caller may have admitted UNUSED for a not-yet-delivered ID.
        if (frame != state->decoded.end() && frame->second.releasing) return;
        valid_lease = frame != state->decoded.end() && frame->second.target == event.target &&
                      !frame->second.delivered;
      }
      if (!valid_lease) ContractFailure(env, "Invalid or duplicate decoded lease delivery");
      envelope = SharedFrameEnvelope(env, state, event, data);
      break;
    }
    case MONKY_ENGINE_EVENT_FRAME_RELEASED: {
      if (type != "frame.released" || !event.target) {
        ContractFailure(env, "Invalid decoded lease retirement event");
      }
      MatchId(env, data, "frameId", event.id);
      const bool ok = Boolean(env, Get(env, data, "ok"), "Decoded retirement ok must be boolean");
      if (ok && Has(env, data, "error")) {
        ContractFailure(env, "Successful decoded retirement must not contain an error");
      }
      napi_value result = data;
      if (!ok) {
        result = Has(env, data, "error")
                     ? EventError(env, Get(env, data, "error"), false)
                     : ErrorValue(env, MONKY_ENGINE_FAILURE,
                                  Error(MONKY_ENGINE_FAILURE, "ERR_RTC_FRAME_RETIREMENT",
                                        "The decoded lease retired after a native failure"));
        SetNumber(env, result, "frameId", static_cast<double>(event.id));
        SetNumber(env, result, "target", static_cast<double>(event.target));
        SetBool(env, result, "nativeOwnershipRetained", false);
      }
      if (event.unused_transfer) {
        if (state->releases.find(event.id) != state->releases.end()) {
          ContractFailure(env, "A rejected, unexposed frame cannot own a release Promise");
        }
        if (!ok) {
          Emit(env, state, ErrorEnvelope(env, result, true));
          StartAutoClose(env, state);
        }
        return;
      }
      bool valid = false;
      bool automatic_unused = false;
      {
        std::lock_guard lock(state->event_mutex);
        const auto frame = state->decoded.find(event.id);
        valid = frame != state->decoded.end() && frame->second.target == event.target &&
                frame->second.releasing && frame->second.release_admitted &&
                frame->second.retirement_notified;
        if (valid) automatic_unused = frame->second.automatic_unused;
      }
      if (!valid) ContractFailure(env, "Retirement refers to an unknown or unadmitted decoded release");
      auto pending = state->releases.find(event.id);
      if (automatic_unused) {
        if (pending != state->releases.end()) {
          ContractFailure(env, "An automatic UNUSED release must not own a user deferred");
        }
        {
          std::lock_guard lock(state->event_mutex);
          state->decoded.erase(event.id);
        }
        if (!ok) {
          Emit(env, state, ErrorEnvelope(env, result, true));
          StartAutoClose(env, state);
        }
        // No listener ever received this lease. Its genuine native completion
        // is consumed internally, not presented as a user's release operation.
        return;
      }
      if (pending == state->releases.end() || pending->second.target != event.target) {
        ContractFailure(env, "Decoded retirement does not match a pending release Promise");
      }
      auto deferred = pending->second.deferred;
      state->releases.erase(pending);
      {
        std::lock_guard lock(state->event_mutex);
        state->decoded.erase(event.id);
      }
      Settle(env, deferred, result, ok);
      break;
    }
    case MONKY_ENGINE_EVENT_AUDIO_INPUT_RELEASED: {
      if (type != "source.audioPacketReleased" || !event.target)
        ContractFailure(env, "Invalid audio packet retirement event");
      MatchId(env, data, "sourceId", event.target);
      const auto epoch = String(env, Get(env, data, "epoch"), 1, 160, "Invalid audio capture epoch");
      const auto sequence = Id(env, Get(env, data, "sequence"), true);
      if (sequence >= kMaxSafeInteger || sequence + 1 != event.id)
        ContractFailure(env, "Audio retirement sequence differs from its typed identity");
      const auto frame_index = Id(env, Get(env, data, "frameIndex"), true);
      const auto frames = Id(env, Get(env, data, "frames"));
      const bool ok = Boolean(env, Get(env, data, "ok"), "Audio retirement must contain boolean ok");
      if (ok && Has(env, data, "error")) ContractFailure(env, "Successful audio retirement contains an error");
      const AudioInputKey key{event.target, epoch, sequence};
      const auto pending = state->audio_inputs.find(key);
      if (pending == state->audio_inputs.end()) {
        if (!state->completed) ContractFailure(env, "Unknown audio processing retirement");
        break;
      }
      if (pending->second.frame_index != frame_index || pending->second.frames != frames)
        ContractFailure(env, "Audio retirement changed the admitted original packet span");
      auto result = ok ? Object(env) : EventError(env, Get(env, data, "error"));
      if (ok) {
        DefineNumber(env, result, "sourceId", static_cast<double>(event.target));
        Define(env, result, "epoch", Text(env, epoch.data(), epoch.size()));
        DefineNumber(env, result, "sequence", static_cast<double>(sequence));
        DefineNumber(env, result, "frameIndex", static_cast<double>(frame_index));
        DefineNumber(env, result, "frames", static_cast<double>(frames));
        DefineBool(env, result, "ok", true);
      } else AudioInputError(env, result, key, false, &pending->second);
      auto deferred = pending->second.deferred;
      state->audio_inputs.erase(pending);
      Settle(env, deferred, result, ok);
      break;
    }
    case MONKY_ENGINE_EVENT_AUDIO_OUTPUT: {
      if (type != "audio.playout" || event.target) ContractFailure(env, "Invalid mixed PCM event");
      const auto epoch = Id(env, Get(env, data, "epoch"));
      const auto sequence = Id(env, Get(env, data, "sequence"), true);
      const auto first_frame = Id(env, Get(env, data, "firstPlayoutFrame"), true);
      if (sequence >= kMaxSafeInteger || sequence + 1 != event.id ||
          Id(env, Get(env, data, "frames")) != 480 ||
          Id(env, Get(env, data, "sampleRate")) != 48000 ||
          Id(env, Get(env, data, "channels")) != 2)
        ContractFailure(env, "Mixed PCM event must describe one exact stereo 10ms block");
      NativeAccess native(*state);
      if (!native.get()) return;
      MonkyEngineAudioPlayout packet{};
      packet.struct_size = sizeof(packet);
      packet.extension_version = MONKY_ENGINE_AUDIO_EXTENSION_VERSION;
      auto error = EmptyError();
      const auto status = monky_rtc_engine_read_audio_playout(native.get(), epoch, sequence, &packet, &error);
      // An explicit stop/failure may have retired native CPU copies while this
      // TSFN event was queued. Never replace a retired packet with silence.
      if (status == MONKY_ENGINE_NOT_FOUND || status == MONKY_ENGINE_CLOSED) return;
      if (status != MONKY_ENGINE_OK) ThrowNative(env, status, error);
      if (packet.struct_size != sizeof(packet) ||
          packet.extension_version != MONKY_ENGINE_AUDIO_EXTENSION_VERSION ||
          packet.reserved || packet.epoch != epoch || packet.sequence != sequence ||
          packet.first_playout_frame != first_frame || packet.frames != 480 ||
          packet.sample_rate != 48000 || packet.channels != 2 ||
          !std::all_of(std::begin(packet.samples), std::end(packet.samples),
                       [](float sample) { return std::isfinite(sample); }))
        ContractFailure(env, "Mixed binary PCM differs from its notification");
      napi_value buffer, samples;
      void* bytes = nullptr;
      Check(env, napi_create_arraybuffer(env, sizeof(packet.samples), &bytes, &buffer));
      if (!bytes) ContractFailure(env, "PCM ArrayBuffer allocation returned no storage");
      std::memcpy(bytes, packet.samples, sizeof(packet.samples));
      Check(env, napi_create_typedarray(env, napi_float32_array, 960, buffer, 0, &samples));
      auto output = Object(env);
      DefineNumber(env, output, "epoch", static_cast<double>(epoch));
      DefineNumber(env, output, "sequence", static_cast<double>(sequence));
      DefineNumber(env, output, "firstPlayoutFrame", static_cast<double>(first_frame));
      DefineNumber(env, output, "frames", 480);
      DefineNumber(env, output, "sampleRate", 48000);
      DefineNumber(env, output, "channels", 2);
      Define(env, output, "samples", samples);
      envelope = Object(env);
      Define(env, envelope, "type", Text(env, "audio.playout"));
      DefineNumber(env, envelope, "target", 0);
      Define(env, envelope, "data", output);
      break;
    }
    case MONKY_ENGINE_EVENT_ERROR: {
      if (type != "error") ContractFailure(env, "Invalid native error event");
      auto error = EventError(env, data);
      const bool terminal = Boolean(env, Get(env, data, "terminal"),
                                     "Native terminal error flag must be boolean");
      if (terminal && !event.target) {
        state->closing = true;
        Settle(env, state->ready, error, false);
        StartAutoClose(env, state);
      }
      break;
    }
    case MONKY_ENGINE_EVENT_CLOSED:
      if (type != "closed" || event.target || event.id) {
        ContractFailure(env, "Invalid native closed event");
      }
      // A JSON notification alone is never permission to destroy or retire inputs.
      StartAutoClose(env, state);
      break;
    case MONKY_ENGINE_EVENT_SIGNAL:
      ValidateSignal(env, type, event, data);
      break;
    default:
      ContractFailure(env, "Unknown typed native event");
  }
  if (event.kind == MONKY_ENGINE_EVENT_FRAME) {
    if (!Emit(env, state, envelope, event.id, event.target)) ReleaseUndelivered(state, event.id);
  } else {
    Emit(env, state, envelope);
  }
}

class EventRetirement final {
 public:
  explicit EventRetirement(EventContext* context) : context_(context) {}
  ~EventRetirement() {
    const auto state = context_->OwnerValue();
    if (context_->ReleasePending()) EventQueueDrained(state);
  }
 private:
  EventContext* context_;
};

void CallJs(napi_env env, napi_value, void* context, void* data) noexcept {
  auto* queue = static_cast<EventContext*>(context);
  // Declared first so data is destroyed before its pending reference retires.
  // This context remains alive even after TsfnFinalizer released its own ref.
  EventRetirement retirement(queue);
  std::unique_ptr<QueuedEvent> event(static_cast<QueuedEvent*>(data));
  if (!env) return;
  const auto state = queue->OwnerValue();
  if (state->environment_closing.load() || state->abandoned.load()) return;
  try {
    const auto fault = state->delivery_fault.exchange(MONKY_ENGINE_OK);
    if (fault != MONKY_ENGINE_OK && !state->delivery_fault_reported) {
      state->delivery_fault_reported = true;
      state->closing = true;
      auto error = ErrorValue(env, fault,
          Error(fault, "ERR_RTC_EVENT_DELIVERY",
                "The bounded Node event boundary rejected a native event; close is required"));
      Settle(env, state->ready, error, false);
      Emit(env, state, ErrorEnvelope(env, error, true));
      StartAutoClose(env, state);
    }
    if (event && !state->environment_closing.load() && !state->abandoned.load()) {
      ProcessEvent(env, state, *event);
    }
    return;
  } catch (const JsFailure&) {
  } catch (const std::bad_alloc&) {
    AllocationException(env);
  } catch (...) {
    napi_throw_error(env, "ERR_RTC_EVENT_DISPATCH", "Native event dispatch failed");
  }
  try {
    auto exception = PendingException(env);
    if (event && event->kind == MONKY_ENGINE_EVENT_FRAME) {
      ReleaseUndelivered(state, event->id);
    } else if (event && event->kind == MONKY_ENGINE_EVENT_OPERATION) {
      auto operation = state->operations.find(event->id);
      if (operation != state->operations.end()) {
        auto deferred = operation->second.deferred;
        state->operations.erase(operation);
        Settle(env, deferred, exception, false);
      }
    }
    // Lost/malformed retirement events preserve their ledgers.
    // Only validated completion or successfully completed native close settles it.
    state->closing = true;
    Settle(env, state->ready, exception, false);
    StartAutoClose(env, state);
    ReportException(env, exception);
  } catch (...) {
    // Reporting failure must not escape a C Node-API callback or silently swallow the error.
    napi_fatal_error("monky_rtc_engine", NAPI_AUTO_LENGTH,
                     "Could not report a failed native event dispatch", NAPI_AUTO_LENGTH);
  }
}

}  // namespace
