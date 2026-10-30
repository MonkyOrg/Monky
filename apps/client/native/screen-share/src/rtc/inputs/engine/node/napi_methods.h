#pragma once

// The engine methods JS calls: requests, replies, cancellation, encoded and audio input, frames and close.
// Part of the single napi_engine.cc translation unit, which is the only file that includes it.

#include "napi_lifecycle.h"

namespace {

template <size_t Count>
struct Arguments {
  std::array<napi_value, Count + 1> values{};
  napi_value receiver = nullptr;
  explicit Arguments(napi_env env, napi_callback_info info) {
    size_t count = values.size();
    Check(env, napi_get_cb_info(env, info, &count, values.data(), &receiver, nullptr));
    if (count != Count) Invalid(env, "Incorrect number of arguments");
  }
};

StateOwner Unwrap(napi_env env, napi_value receiver) {
  if (Type(env, receiver) != napi_object) Invalid(env, "Expected a native RTC engine receiver");
  bool tagged = false;
  Check(env, napi_check_object_type_tag(env, receiver, &kEngineTag, &tagged));
  if (!tagged) Invalid(env, "This receiver is not a native RTC engine");
  void* wrapped = nullptr;
  Check(env, napi_unwrap(env, receiver, &wrapped));
  if (!wrapped) Invalid(env, "The native RTC engine wrapper is unavailable");
  return *static_cast<StateOwner*>(wrapped);
}

void RequireReady(napi_env env, const StateOwner& state) {
  if (state->closing || state->completed || state->abandoned.load() ||
      state->environment_closing.load()) {
    ThrowNative(env, MONKY_ENGINE_CLOSED,
                Error(MONKY_ENGINE_CLOSED, "ERR_RTC_ENGINE_CLOSING",
                      "New requests and frames are not accepted during close"));
  }
  if (!state->ready_seen) {
    ThrowNative(env, MONKY_ENGINE_BUSY,
                Error(MONKY_ENGINE_BUSY, "ERR_RTC_ENGINE_NOT_READY",
                      "Await engine.ready before submitting requests or frames"));
  }
}

napi_value Request(napi_env env, napi_callback_info info) {
  return PromiseMethod(env, [&](napi_deferred deferred) {
    Arguments<4> args(env, info);
    const auto state = Unwrap(env, args.receiver);
    const auto id = Id(env, args.values[0]);
    const auto operation = String(env, args.values[1], 1, 64,
                                   "operation must contain 1..64 UTF-8 bytes");
    const auto target = Id(env, args.values[2], true);
    RequireReady(env, state);
    const auto json = Stringify(env, args.values[3]);
    uint64_t receiver = 0;
    bool enabled = false;
    if (operation == "peer.setReceiverEnabled") {
      if (!target) Invalid(env, "peer.setReceiverEnabled requires a peer target");
      const auto data = Parse(env, json);
      receiver = Id(env, Get(env, data, "receiverId"));
      enabled = Boolean(env, Get(env, data, "enabled"), "Receiver enabled must be boolean");
    }
    // Serialization can invoke toJSON/getters. Recheck state after that reentrancy.
    RequireReady(env, state);
    if (state->operations.find(id) != state->operations.end()) {
      ThrowNative(env, MONKY_ENGINE_BUSY,
                  Error(MONKY_ENGINE_BUSY, "ERR_RTC_DUPLICATE_REQUEST",
                        "requestId is already pending"));
    }
    if (state->operations.size() >= state->options.max_pending_operations) {
      ThrowNative(env, MONKY_ENGINE_QUEUE_FULL,
                  Error(MONKY_ENGINE_QUEUE_FULL, "ERR_RTC_PENDING_LIMIT",
                        "maxPendingOperations has been reached"));
    }
    NativeAccess native(*state);
    RequireNative(env, native);
    state->operations.emplace(id, PendingOperation{deferred, operation, receiver, enabled});
    MonkyEngineError error = EmptyError();
    const auto status = monky_rtc_engine_request(
        native.get(), id, operation.data(), static_cast<uint32_t>(operation.size()),
        target, json.data(), static_cast<uint32_t>(json.size()), &error);
    if (status != MONKY_ENGINE_OK) {
      state->operations.erase(id);
      ThrowNative(env, status, error);
    }
    // Admission is not completion. No JS operation follows ownership transfer.
  });
}

napi_value Respond(napi_env env, napi_callback_info info) {
  return Synchronous(env, [&]() -> napi_value {
    Arguments<2> args(env, info);
    const auto state = Unwrap(env, args.receiver);
    const auto id = Id(env, args.values[0]);
    const auto json = Stringify(env, args.values[1]);
    // Validate the serialized envelope, not a getter's earlier answer.
    const auto response = Parse(env, json);
    const bool ok = Boolean(env, Get(env, response, "ok"), "response.ok must be boolean");
    if (ok) {
      if (!Has(env, response, "data")) Invalid(env, "Successful responses require data");
    } else {
      auto error = Get(env, response, "error");
      Record(env, error, "Failed responses require an error object");
      String(env, Get(env, error, "code"), 1, 79, "Response error.code must contain 1..79 bytes");
      String(env, Get(env, error, "message"), 1, 511,
               "Response error.message must contain 1..511 bytes");
    }
    NativeAccess native(*state);
    RequireNative(env, native);
    bool known = false;
    {
      std::lock_guard lock(state->event_mutex);
      auto callback = state->callbacks.find(id);
      known = callback != state->callbacks.end() && !callback->second.responding;
      if (known) callback->second.responding = true;
    }
    if (!known) {
      ThrowNative(env, MONKY_ENGINE_NOT_FOUND,
                  Error(MONKY_ENGINE_NOT_FOUND, "ERR_RTC_UNKNOWN_CALLBACK",
                        "callbackId is unknown, expired or already answered"));
    }
    MonkyEngineError error = EmptyError();
    const auto status = monky_rtc_engine_respond(
        native.get(), id, json.data(), static_cast<uint32_t>(json.size()), &error);
    {
      std::lock_guard lock(state->event_mutex);
      if (status == MONKY_ENGINE_OK || status == MONKY_ENGINE_NOT_FOUND) {
        state->callbacks.erase(id);
      } else if (auto callback = state->callbacks.find(id); callback != state->callbacks.end()) {
        callback->second.responding = false;
      }
    }
    if (status != MONKY_ENGINE_OK) ThrowNative(env, status, error);
    return Undefined(env);
  });
}

napi_value Cancel(napi_env env, napi_callback_info info) {
  return Synchronous(env, [&]() -> napi_value {
    Arguments<1> args(env, info);
    const auto state = Unwrap(env, args.receiver);
    const auto id = Id(env, args.values[0]);
    if (state->operations.find(id) == state->operations.end()) {
      ThrowNative(env, MONKY_ENGINE_NOT_FOUND,
                  Error(MONKY_ENGINE_NOT_FOUND, "ERR_RTC_UNKNOWN_REQUEST",
                        "requestId is not a pending operation"));
    }
    NativeAccess native(*state);
    RequireNative(env, native);
    MonkyEngineError error = EmptyError();
    const auto status = monky_rtc_engine_cancel(native.get(), id, &error);
    if (status != MONKY_ENGINE_OK) ThrowNative(env, status, error);
    return Undefined(env);
  });
}

int64_t EncodedDecimal(napi_env env, napi_value value) {
  const auto text = String(env, value, 1, 20, "PTS/DTS must be canonical signed decimal strings");
  int64_t result = 0;
  const auto parsed = std::from_chars(text.data(), text.data() + text.size(), result);
  if (parsed.ec != std::errc{} || parsed.ptr != text.data() + text.size() || std::to_string(result) != text)
    Invalid(env, "PTS/DTS exceed the signed int64 contract or are not canonical");
  return result;
}

napi_value SubmitEncodedFrame(napi_env env, napi_callback_info info) {
  return Synchronous(env, [&]() -> napi_value {
    Arguments<2> args(env, info);
    const auto state = Unwrap(env, args.receiver);
    const auto source = Id(env, args.values[0]);
    Record(env, args.values[1], "An encoded frame must be a metadata object");
    const auto object = args.values[1];
    MonkyEngineEncodedFrame frame{};
    frame.struct_size = sizeof(frame);
    frame.abi_version = MONKY_ENGINE_ABI_VERSION;
    frame.frame_id = Id(env, Get(env, object, "frameId"));
    frame.timestamp_us = Integer(env, Get(env, object, "timestampUs"), 0, kMaxSafeInteger,
        "timestampUs must be genuine system-QPC microseconds");
    frame.duration_us = Integer(env, Get(env, object, "durationUs"), 1, 1000000, "Invalid encoded durationUs");
    frame.ntp_time_ms = Integer(env, Get(env, object, "ntpTimeMs"), -1, kMaxSafeInteger, "Invalid encoded NTP time");
    frame.pts = EncodedDecimal(env, Get(env, object, "pts"));
    frame.dts = EncodedDecimal(env, Get(env, object, "dts"));
    frame.timebase_numerator = static_cast<uint32_t>(Integer(env, Get(env, object, "timebaseNumerator"),
        1, INT32_MAX, "Invalid encoded timebase numerator"));
    frame.timebase_denominator = static_cast<uint32_t>(Integer(env, Get(env, object, "timebaseDenominator"),
        1, INT32_MAX, "Invalid encoded timebase denominator"));
    frame.keyframe = Boolean(env, Get(env, object, "keyframe"), "keyframe must be boolean") ? 1u : 0u;
    const auto data = Get(env, object, "data");
    bool genuine = false;
    Check(env, napi_is_buffer(env, data, &genuine));
    if (!genuine) Invalid(env, "Encoded data must be an ordinary non-shared Buffer");
    void* bytes = nullptr;
    size_t size = 0;
    Check(env, napi_get_buffer_info(env, data, &bytes, &size));
    if (!bytes || !size || size > 4 * 1024 * 1024) Invalid(env, "Encoded Buffer exceeds4MiB or is empty");
    napi_value prototype;
    Check(env, napi_get_reference_value(env, state->buffer_prototype, &prototype));
    // Also rejects shared/detached backing stores and forged Buffer prototypes. No user getter runs after this
    // borrowed view.
    frame.data = GenuineBufferBytes(env, data, prototype, size, "Encoded data");
    frame.data_bytes = static_cast<uint32_t>(size);
    RequireReady(env, state);
    NativeAccess native(*state);
    RequireNative(env, native);
    auto error = EmptyError();
    const auto status = monky_rtc_engine_submit_encoded_frame(native.get(), source, &frame, &error);
    if (status != MONKY_ENGINE_OK) ThrowNative(env, status, error);
    auto result = Object(env);
    DefineNumber(env, result, "sourceId", static_cast<double>(source));
    DefineNumber(env, result, "frameId", static_cast<double>(frame.frame_id));
    DefineNumber(env, result, "inputBytes", static_cast<double>(size));
    DefineBool(env, result, "copied", true);
    DefineBool(env, result, "networkDeliveryConfirmed", false);
    return result;
  });
}

napi_value SubmitAudioPacket(napi_env env, napi_callback_info info) {
  return PromiseMethod(env, [&](napi_deferred deferred) {
    Arguments<2> args(env, info);
    const auto state = Unwrap(env, args.receiver);
    const auto source = Id(env, args.values[0]);
    AudioInputKey key;
    bool identity = false;
    std::optional<PendingAudioInput> span;
    try {
      RequireReady(env, state);
      auto object = args.values[1];
      Record(env, object, "An original capture packet is required");
      const auto epoch = String(env, Get(env, object, "epoch"), 1, 160, "Invalid capture epoch");
      const auto sequence = static_cast<uint64_t>(Integer(env, Get(env, object, "sequence"),
          0, kMaxSafeInteger - 1, "Audio sequence must be a bounded zero-based integer"));
      key = {source, epoch, sequence};
      identity = true;
      MonkyEngineAudioPacket packet{};
      packet.struct_size = sizeof(packet);
      packet.extension_version = MONKY_ENGINE_AUDIO_EXTENSION_VERSION;
      packet.sequence = sequence;
      std::memcpy(packet.epoch, epoch.c_str(), epoch.size() + 1);
      const auto session = String(env, Get(env, object, "sessionId"), 1, 128, "Invalid capture sessionId");
      std::memcpy(packet.session_id, session.c_str(), session.size() + 1);
      packet.frame_index = Id(env, Get(env, object, "frameIndex"), true);
      packet.frames = static_cast<uint32_t>(Integer(env, Get(env, object, "frames"),
          1, 262144, "Original PCM frame count is out of bounds"));
      span = PendingAudioInput{nullptr, packet.frame_index, packet.frames};
      auto format = Get(env, object, "format");
      Record(env, format, "Original PCM format is required");
      if (String(env, Get(env, format, "encoding"), 1, 32, "PCM encoding is required") != "float32-interleaved")
        Invalid(env, "Only original Float32LE interleaved capture packets are accepted");
      packet.sample_rate = static_cast<uint32_t>(Integer(env, Get(env, format, "sampleRate"),
          8000, 192000, "Unsupported original PCM sample rate"));
      packet.channels = static_cast<uint32_t>(Integer(env, Get(env, format, "channels"),
          1, 8, "Original PCM channel count must be between one and eight"));
      const auto mask = Get(env, format, "channelMask");
      packet.has_channel_mask = Type(env, mask) == napi_null ? 0 : 1;
      if (packet.has_channel_mask)
        packet.channel_mask = static_cast<uint32_t>(Integer(env, mask, 0, UINT32_MAX, "Invalid channel mask"));
      packet.source_bits_per_sample = static_cast<uint32_t>(Integer(
          env, Get(env, format, "sourceBitsPerSample"), 1, 64, "Invalid source bits per sample"));
      packet.source_valid_bits_per_sample = static_cast<uint32_t>(Integer(
          env, Get(env, format, "sourceValidBitsPerSample"), 1, 64, "Invalid source valid bits"));
      const auto flags = Get(env, object, "flags");
      Record(env, flags, "Original PCM flags are required");
      packet.flags = static_cast<uint32_t>(Integer(env, Get(env, flags, "raw"), 0, 7, "Unsupported capture flags"));
      const bool silent = Boolean(env, Get(env, flags, "silent"), "silent must be boolean");
      const bool discontinuity = Boolean(env, Get(env, flags, "dataDiscontinuity"), "dataDiscontinuity must be boolean");
      const bool timestamp_error = Boolean(env, Get(env, flags, "timestampError"), "timestampError must be boolean");
      if (silent != bool(packet.flags & 2) || discontinuity != bool(packet.flags & 1) ||
          timestamp_error != bool(packet.flags & 4))
        Invalid(env, "Capture flags disagree with their original raw bits");
      const auto device = Get(env, object, "devicePosition");
      const auto clock = Get(env, object, "captureClock");
      const bool explicit_clock = Type(env, clock) != napi_undefined;
#if defined(__APPLE__)
      if (!explicit_clock || String(env, clock, 1, 32, "Native audio clock is required") != "mach-host-us")
        Invalid(env, "macOS audio requires its original Mach host clock timestamp");
#else
      if (explicit_clock && String(env, clock, 1, 32, "Invalid native audio clock") != "qpc-us")
        Invalid(env, "Windows audio requires its original QPC clock timestamp");
#endif
      const auto qpc = Get(env, object, explicit_clock ? "captureTimestampUs" : "qpcTimestampUs");
      if (timestamp_error) {
        if (Type(env, device) != napi_null || Type(env, qpc) != napi_null)
          Invalid(env, "Timestamp-invalid packets require null device/capture anchors");
        packet.device_position = UINT64_MAX;
        packet.qpc_timestamp_us = -1;
      } else {
        packet.device_position = Type(env, device) == napi_null ? UINT64_MAX : Id(env, device, true);
        packet.qpc_timestamp_us = Integer(env, qpc, 0, kMaxSafeInteger, "Capture clock anchor must be a safe integer");
      }
      packet.pcm_bytes = static_cast<uint32_t>(packet.frames * packet.channels * sizeof(float));
      if (packet.pcm_bytes > 1024 * 1024) Invalid(env, "Original audio packet exceeds 1 MiB");
      const auto pcm = Get(env, object, "pcm");
      napi_value buffer_prototype;
      Check(env, napi_get_reference_value(env, state->buffer_prototype, &buffer_prototype));
      // All caller getters have finished. No JS executes between storage
      // validation and the C function's synchronous copy into aligned storage.
      packet.pcm = GenuineBufferBytes(env, pcm, buffer_prototype, packet.pcm_bytes, "PCM");
      RequireReady(env, state);
      NativeAccess native(*state);
      RequireNative(env, native);
      if (state->audio_inputs.contains(key))
        ThrowNative(env, MONKY_ENGINE_BUSY, Error(MONKY_ENGINE_BUSY, "ERR_RTC_AUDIO_DUPLICATE",
                    "This audio capture packet already has pending processing"));
      if (state->audio_inputs.size() >= 8)
        ThrowNative(env, MONKY_ENGINE_QUEUE_FULL, Error(MONKY_ENGINE_QUEUE_FULL, "ERR_RTC_AUDIO_QUEUE",
                    "The bounded audio processing promise map is full"));
      state->audio_inputs.emplace(key, PendingAudioInput{deferred, packet.frame_index, packet.frames});
      auto error = EmptyError();
      const auto status = monky_rtc_engine_submit_audio_packet(native.get(), source, &packet, &error);
      if (status != MONKY_ENGINE_OK) {
        if (std::string_view(error.code, BoundedLength(error.code)) == "ERR_RTC_AUDIO_DUPLICATE")
          state->audio_inputs.at(key).deferred = nullptr;
        else state->audio_inputs.erase(key);
        ThrowNative(env, status, error);
      }
    } catch (const JsFailure& failure) {
      auto exception = PendingException(env);
      if (!failure.local_error) {
        auto cause = exception;
        exception = ErrorValue(env, MONKY_ENGINE_INVALID,
            Error(MONKY_ENGINE_INVALID, "ERR_RTC_AUDIO_ARGUMENT", "PCM metadata access failed; see cause"));
        Define(env, exception, "cause", cause);
      }
      if (identity) AudioInputError(env, exception, key, state->audio_inputs.contains(key), span ? &*span : nullptr);
      Check(env, napi_throw(env, exception));
      throw JsFailure{};
    } catch (...) {
      const auto exception = ErrorValue(env, MONKY_ENGINE_FAILURE,
          Error(MONKY_ENGINE_FAILURE, "ERR_RTC_AUDIO_WRAPPER", "PCM wrapper allocation/processing failed"));
      if (identity) AudioInputError(env, exception, key, state->audio_inputs.contains(key), span ? &*span : nullptr);
      Check(env, napi_throw(env, exception));
      throw JsFailure{exception};
    }
  });
}

napi_value AudioCommand(napi_env env, napi_callback_info info, const char* command, bool result_needed) {
  return Synchronous(env, [&]() -> napi_value {
    Arguments<1> args(env, info);
    const auto state = Unwrap(env, args.receiver);
    RequireReady(env, state);
    const auto json = Stringify(env, args.values[0]);
    if (json.size() > 4096) Invalid(env, "Audio metadata command exceeds 4096 bytes");
    RequireReady(env, state);
    NativeAccess native(*state);
    RequireNative(env, native);
    MonkyEngineAudioReply reply{};
    reply.struct_size = sizeof(reply);
    reply.extension_version = MONKY_ENGINE_AUDIO_EXTENSION_VERSION;
    auto error = EmptyError();
    const auto status = monky_rtc_engine_audio_command(native.get(), command,
        static_cast<uint32_t>(std::strlen(command)), json.data(), static_cast<uint32_t>(json.size()),
        &reply, &error);
    if (status != MONKY_ENGINE_OK) ThrowNative(env, status, error);
    if (reply.struct_size != sizeof(reply) || reply.extension_version != MONKY_ENGINE_AUDIO_EXTENSION_VERSION ||
        reply.reserved || reply.json_bytes < 2 || reply.json_bytes >= sizeof(reply.json) ||
        reply.json[reply.json_bytes] != '\0' || std::memchr(reply.json, '\0', reply.json_bytes))
      ContractFailure(env, "Audio metadata reply violated its fixed C/POD bound");
    return result_needed ? Parse(env, std::string(reply.json, reply.json_bytes)) : Undefined(env);
  });
}
napi_value GrantAudioCredits(napi_env env, napi_callback_info info) {
  return AudioCommand(env, info, "grant", false);
}
napi_value AudioClockProbe(napi_env env, napi_callback_info info) {
  return AudioCommand(env, info, "probe", true);
}
napi_value CalibrateAudioClock(napi_env env, napi_callback_info info) {
  return AudioCommand(env, info, "calibrate", true);
}
napi_value SetAudioOutputFeedback(napi_env env, napi_callback_info info) {
  return AudioCommand(env, info, "feedback", false);
}

napi_value ReleaseFrame(napi_env env, napi_callback_info info) {
  return PromiseMethod(env, [&](napi_deferred deferred) {
    Arguments<2> args(env, info);
    const auto state = Unwrap(env, args.receiver);
    const auto id = Id(env, args.values[0]);
    const auto reason = String(env, args.values[1], 1, 32,
                                "release reason must be 'unused' or 'all-references-released'");
    uint32_t release_reason = 0;
    if (reason == "unused") release_reason = MONKY_ENGINE_FRAME_UNUSED;
    else if (reason == "all-references-released")
      release_reason = MONKY_ENGINE_FRAME_EXTERNAL_REFERENCES_RELEASED;
    else Invalid(env, "release reason must be 'unused' or 'all-references-released'");
    if (state->abandoned.load() || state->environment_closing.load()) {
      ThrowNative(env, MONKY_ENGINE_CLOSED,
                  Error(MONKY_ENGINE_CLOSED, "ERR_RTC_ENGINE_CLOSING",
                        "The owning environment is closing; external lease ownership is retained"));
    }
    NativeAccess native(*state);
    RequireNative(env, native);
    MonkyEngineError rejection = EmptyError();
    {
      std::lock_guard lock(state->event_mutex);
      auto frame = state->decoded.find(id);
      if (frame == state->decoded.end()) {
        rejection = Error(MONKY_ENGINE_NOT_FOUND, "ERR_RTC_UNKNOWN_FRAME",
                          "frameId is not a live Node-owned decoded lease");
      } else if (frame->second.releasing || state->releases.find(id) != state->releases.end()) {
        rejection = Error(MONKY_ENGINE_BUSY, "ERR_RTC_DUPLICATE_FRAME_RELEASE",
                          "This decoded lease already has a release in progress");
      } else if (release_reason == MONKY_ENGINE_FRAME_EXTERNAL_REFERENCES_RELEASED &&
                 !frame->second.delivered) {
        rejection = Error(MONKY_ENGINE_INVALID, "ERR_RTC_FRAME_NOT_DELIVERED",
                          "An undelivered frame cannot have external-reference release proof");
      } else if (state->releases.size() >= state->options.max_decoded_frames) {
        rejection = Error(MONKY_ENGINE_QUEUE_FULL, "ERR_RTC_RELEASE_LIMIT",
                          "The bounded decoded-release Promise map is full; retain and retry");
      } else {
        state->releases.emplace(id, PendingRelease{deferred, frame->second.target});
        frame->second.releasing = true;
      }
    }
    if (rejection.status != MONKY_ENGINE_OK) ThrowNative(env, rejection.status, rejection);
    MonkyEngineError error = EmptyError();
    const auto status = monky_rtc_engine_release_frame(native.get(), id, release_reason, &error);
    if (!RecordReleaseAdmission(state, id, status)) {
      state->releases.erase(id);
      ThrowNative(env, status, error);
    }
    // C OK admits the proof, not retirement. FRAME_RELEASED (or complete native
    // close after failed event delivery) owns the deferred and ledger from here.
  });
}

napi_value Snapshot(napi_env env, napi_callback_info info) {
  return Synchronous(env, [&]() -> napi_value {
    Arguments<0> args(env, info);
    const auto state = Unwrap(env, args.receiver);
    if (state->completed && state->final_record) {
      const auto& result = state->final_record->snapshot;
      if (result.status != MONKY_ENGINE_OK) ThrowNative(env, result.status, result.error);
      return Parse(env, result.json);
    }
    JsonResult result;
    {
      NativeAccess native(*state);
      RequireNative(env, native);
      result = CopyJson([&](char* output, uint32_t capacity, uint32_t* required,
                            MonkyEngineError* error) {
        return monky_rtc_engine_snapshot(native.get(), output, capacity, required, error);
      });
    }
    if (result.status != MONKY_ENGINE_OK) ThrowNative(env, result.status, result.error);
    return Parse(env, result.json);
  });
}

napi_value Close(napi_env env, napi_callback_info info) {
  return Synchronous(env, [&]() -> napi_value {
    Arguments<0> args(env, info);
    const auto state = Unwrap(env, args.receiver);
    if (state->close_promise) {
      napi_value promise;
      Check(env, napi_get_reference_value(env, state->close_promise, &promise));
      return promise;
    }
    napi_value promise;
    napi_deferred deferred = nullptr;
    Check(env, napi_create_promise(env, &deferred, &promise));
    if (state->completed && state->final_record) {
      const auto& result = state->final_record->snapshot;
      try {
        if (result.status != MONKY_ENGINE_OK) ThrowNative(env, result.status, result.error);
        Settle(env, deferred, Parse(env, result.json), true);
      } catch (const JsFailure&) {
        Settle(env, deferred, PendingException(env), false);
      }
      return promise;
    }
    Check(env, napi_create_reference(env, promise, 1, &state->close_promise));
    state->close_deferred = deferred;
    try {
      if (state->abandoned.load() || state->environment_closing.load()) {
        ThrowNative(env, MONKY_ENGINE_CLOSED,
                    Error(MONKY_ENGINE_CLOSED, "ERR_RTC_ENGINE_CLOSED",
                          "The owning Node environment is closing"));
      }
      StartClose(env, state);
    } catch (const JsFailure&) {
      Settle(env, state->close_deferred, PendingException(env), false);
      ClearClosePromise(env, state);
    } catch (...) {
      AllocationException(env);
      Settle(env, state->close_deferred, PendingException(env), false);
      ClearClosePromise(env, state);
    }
    return promise;
  });
}

}  // namespace
