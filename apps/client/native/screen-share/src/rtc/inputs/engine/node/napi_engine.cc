#include <node_api.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <bit>
#include <chrono>
#include <charconv>
#include <cmath>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <exception>
#include <iterator>
#include <limits>
#include <map>
#include <memory>
#include <mutex>
#include <new>
#include <string>
#include <string_view>
#include <thread>
#include <tuple>
#include <type_traits>
#include <unordered_map>
#include <utility>
#include <vector>

#include "monky_rtc_engine.h"
#include "audio/monky_rtc_audio.h"
#include "event_queue.h"

#if NAPI_VERSION != 8
#error The RTC addon requires Node-API 8.
#endif
#if defined(_WIN32)
#if defined(__clang__) || !defined(_MSC_VER)
#error This consumer must be compiled independently with MSVC and Node-API 8.
#endif
#if !defined(_DLL) || !_HAS_EXCEPTIONS
#error The Node consumer requires the dynamic MSVC CRT and C++ exceptions.
#endif
static_assert(_MSVC_LANG >= 202002L);
#else
static_assert(__cplusplus >= 202002L);
#endif
static_assert(sizeof(void*) == 8);
static_assert(MONKY_ENGINE_ABI_VERSION == 2u);
static_assert(MONKY_ENGINE_CONTRACT_REVISION == 8u);
static_assert(std::endian::native == std::endian::little);
static_assert(sizeof(MonkyEngineError) == 608);
static_assert(sizeof(MonkyEngineOptions) == 32);
static_assert(sizeof(MonkyEngineEvent) == 48);
static_assert(sizeof(MonkyEngineCallbacks) == 24);
static_assert(sizeof(MonkyEngineEncodedFrame) == 80);
static_assert(alignof(MonkyEngineEncodedFrame) == 8);
static_assert(offsetof(MonkyEngineEncodedFrame, data) == 16);
static_assert(offsetof(MonkyEngineEncodedFrame, timestamp_us) == 32);
static_assert(offsetof(MonkyEngineEncodedFrame, timebase_numerator) == 72);
static_assert(std::is_standard_layout_v<MonkyEngineEncodedFrame>);
static_assert(std::is_trivially_copyable_v<MonkyEngineEncodedFrame>);
static_assert(sizeof(MonkyEngineFrameCom) == 72);
static_assert(sizeof(MonkyEngineSharedFrame) == 64);
static_assert(alignof(MonkyEngineSharedFrame) == 8);
static_assert(offsetof(MonkyEngineEvent, target) == 16);
static_assert(offsetof(MonkyEngineEvent, id) == 24);
static_assert(offsetof(MonkyEngineEvent, json) == 32);
static_assert(offsetof(MonkyEngineSharedFrame, struct_size) == 0);
static_assert(offsetof(MonkyEngineSharedFrame, abi_version) == 4);
static_assert(offsetof(MonkyEngineSharedFrame, texture_nt_handle) == 8);
static_assert(offsetof(MonkyEngineSharedFrame, coded_width) == 16);
static_assert(offsetof(MonkyEngineSharedFrame, coded_height) == 20);
static_assert(offsetof(MonkyEngineSharedFrame, visible_x) == 24);
static_assert(offsetof(MonkyEngineSharedFrame, visible_y) == 28);
static_assert(offsetof(MonkyEngineSharedFrame, width) == 32);
static_assert(offsetof(MonkyEngineSharedFrame, height) == 36);
static_assert(offsetof(MonkyEngineSharedFrame, timestamp_us) == 40);
static_assert(offsetof(MonkyEngineSharedFrame, pixel_format) == 48);
static_assert(offsetof(MonkyEngineSharedFrame, flags) == 52);
static_assert(offsetof(MonkyEngineSharedFrame, gpu_copy_count) == 56);
static_assert(offsetof(MonkyEngineSharedFrame, reserved) == 60);
static_assert(std::is_standard_layout_v<MonkyEngineEvent>);
static_assert(std::is_standard_layout_v<MonkyEngineSharedFrame>);
static_assert(std::is_trivially_copyable_v<MonkyEngineSharedFrame>);
static_assert(MONKY_ENGINE_EVENT_FRAME_RELEASED == 9u);
static_assert(MONKY_ENGINE_AUDIO_EXTENSION_VERSION == 1u);
static_assert(sizeof(MonkyEngineAudioPacket) == 384);
static_assert(sizeof(MonkyEngineAudioPlayout) == 3904);
static_assert(sizeof(MonkyEngineAudioReply) == 4112);
static_assert(offsetof(MonkyEngineAudioPacket, pcm) == 80);
static_assert(offsetof(MonkyEngineAudioPlayout, samples) == 48);
static_assert(std::is_trivially_copyable_v<MonkyEngineAudioPacket>);
static_assert(std::is_standard_layout_v<MonkyEngineAudioPlayout>);
static_assert(MONKY_ENGINE_FRAME_UNUSED == 1u);
static_assert(MONKY_ENGINE_FRAME_EXTERNAL_REFERENCES_RELEASED == 2u);
static_assert(MONKY_ENGINE_PIXEL_FORMAT_NV12 == 1u);

#include "napi_event_dispatch.h"
#include "napi_methods.h"

namespace {

napi_value ReadCapabilities(napi_env env) {
  const auto result = CopyJson([](char* output, uint32_t capacity, uint32_t* bytes,
                                 MonkyEngineError*) {
    return monky_rtc_engine_capabilities(output, capacity, bytes);
  });
  if (result.status != MONKY_ENGINE_OK) ThrowNative(env, result.status, result.error);
  return Parse(env, result.json);
}

void RequireContract(napi_env env) {
  const auto capabilities = ReadCapabilities(env);
  const auto matches = [&](const char* name, napi_value expected) {
    if (!Has(env, capabilities, name)) return false;
    bool equal = false;
    Check(env, napi_strict_equals(env, Get(env, capabilities, name), expected, &equal));
    return equal;
  };
  napi_value abi, revision, extension, enabled;
  Check(env, napi_create_uint32(env, MONKY_ENGINE_ABI_VERSION, &abi));
  Check(env, napi_create_uint32(env, MONKY_ENGINE_CONTRACT_REVISION, &revision));
  Check(env, napi_create_uint32(env, MONKY_ENGINE_AUDIO_EXTENSION_VERSION, &extension));
  Check(env, napi_get_boolean(env, true, &enabled));
  if (!matches("abiVersion", abi) || !matches("contractRevision", revision) ||
      !matches("pairedCaptureClock", enabled) ||
      !matches("p2pReceiverRouting", enabled) || !matches("audioExtensionVersion", extension) ||
      !matches("audioAvailable", enabled) || !matches("pcmTrackInput", enabled) ||
      !matches("creditAudioPlayout", enabled) || !matches("calibratedAudioOutputClock", enabled) ||
      !matches("perShareAvGroups", enabled) || !matches("sfuExplicitStreamId", enabled) ||
      !matches("audioOutputInvalidation", enabled) || !matches("opusStereoNegotiation", enabled) ||
      !matches("audioPreAdmissionRetry", enabled) || !matches("ownerScopedAudioOutput", enabled) ||
      !matches("audioOutputEpochAdmission", enabled) || !matches("externallyEncodedH264", enabled) ||
      !matches("encodedInputCopied", enabled) || !matches("encodedFeedback", enabled)) {
    ThrowNative(env, MONKY_ENGINE_UNSUPPORTED,
        Error(MONKY_ENGINE_UNSUPPORTED, "ERR_RTC_NATIVE_CONTRACT",
              "The DLL must advertise ABI2 revision7/audio extension1 and all required compiled media features"));
  }
}

uint32_t Option(napi_env env, napi_value options, const char* name, uint32_t fallback) {
  if (!Has(env, options, name)) return fallback;
  auto value = Get(env, options, name);
  if (Type(env, value) == napi_undefined) return fallback;
  return static_cast<uint32_t>(Integer(env, value, 1, UINT32_MAX,
                                       "Numeric engine options must be positive uint32 safe integers"));
}

MonkyEngineOptions Options(napi_env env, napi_value object, bool& encoded, bool& av1) {
  Record(env, object, "options must be an object");
  constexpr std::array<const char*, 7> names{
      "maxResources", "maxPendingOperations", "maxDecodedFrames",
      "operationTimeoutMs", "maximumH264Level", "requireAudio", "videoInput"};
  napi_value keys;
  Check(env, napi_get_all_property_names(env, object, napi_key_own_only,
      napi_key_all_properties, napi_key_numbers_to_strings, &keys));
  uint32_t count = 0;
  Check(env, napi_get_array_length(env, keys, &count));
  if (count > names.size()) Invalid(env, "Unknown engine option");
  for (uint32_t i = 0; i < count; ++i) {
    napi_value key;
    Check(env, napi_get_element(env, keys, i, &key));
    const auto name = String(env, key, 1, 32, "Engine option names must be strings");
    if (std::find(names.begin(), names.end(), name) == names.end())
      Invalid(env, "Unknown engine option");
  }
  MonkyEngineOptions options{};
  options.struct_size = sizeof(options);
  options.abi_version = MONKY_ENGINE_ABI_VERSION;
  options.max_resources = Option(env, object, "maxResources", 32);
  options.max_pending_operations = Option(env, object, "maxPendingOperations", 64);
  options.max_decoded_frames = Option(env, object, "maxDecodedFrames", 16);
  options.operation_timeout_ms = Option(env, object, "operationTimeoutMs", 12000);
  options.maximum_h264_level = Option(env, object, "maximumH264Level", 60);
  if (Has(env, object, "videoInput")) {
    const auto input = String(env, Get(env, object, "videoInput"), 1, 16, "Invalid videoInput");
    if (input != "nv12" && input != "encoded-h264" && input != "encoded-av1")
      Invalid(env, "videoInput must be nv12, encoded-h264 or encoded-av1");
    av1 = input == "encoded-av1";
    encoded = input != "nv12";
  }
  if (options.max_resources > 64 || options.max_pending_operations > 128 ||
      options.max_decoded_frames > 64 || options.operation_timeout_ms < 100 ||
      options.operation_timeout_ms > 60000)
    Invalid(env, "Engine limits exceed the bounded native contract", true);
  constexpr std::array<uint32_t, 9> levels{31, 32, 40, 41, 42, 50, 51, 52, 60};
  if (std::find(levels.begin(), levels.end(), options.maximum_h264_level) == levels.end()) {
    Invalid(env, "maximumH264Level must be 31, 32, 40, 41, 42, 50, 51, 52 or 60", true);
  }
  if (Has(env, object, "requireAudio")) {
    auto audio = Get(env, object, "requireAudio");
    if (Type(env, audio) != napi_undefined) {
      options.require_audio = Boolean(env, audio, "requireAudio must be boolean") ? 1 : 0;
    }
  }
  return options;
}

void PrepareState(napi_env env, const StateOwner& state, napi_value listener) {
  Check(env, napi_create_reference(env, listener, 1, &state->listener));
  napi_value buffer, prototype;
  void* unused = nullptr;
  Check(env, napi_create_buffer(env, 0, &unused, &buffer));
  Check(env, napi_get_prototype(env, buffer, &prototype));
  Check(env, napi_create_reference(env, prototype, 1, &state->buffer_prototype));
  auto tsfn_owner = std::make_unique<EventContext>(state);
  Check(env, napi_create_threadsafe_function(
      env, listener, nullptr, Text(env, "MonkyRtcEngine.events"),
      kEventQueueSize, 1, tsfn_owner.get(), TsfnFinalizer, tsfn_owner.get(),
      CallJs, &state->tsfn));
  state->event_context = tsfn_owner.release();
  // Intentionally referenced by default: a live native engine cannot disappear
  // merely because the JS event loop happens to have no other work.
  auto cleanup = std::make_unique<CleanupOwner>();
  cleanup->state = state;
  Check(env, napi_create_async_work(env, nullptr, Text(env, "MonkyRtcEngine.cleanup"),
                                    CleanupExecute, CleanupComplete, cleanup.get(), &cleanup->work));
  const auto status = napi_add_async_cleanup_hook(
      env, EnvironmentCleanup, cleanup.get(), &cleanup->hook);
  if (status != napi_ok) {
    napi_delete_async_work(env, cleanup->work);
    Check(env, status);
  }
  // Hook ordering is not a lifetime guarantee: finalizer revocation and
  // per-queued-item context refs also protect independent runtime teardown.
  state->cleanup = cleanup.release();
}

void FailedConstruction(napi_env env, const StateOwner& state) noexcept {
  // An unreturned ready Promise must not create a spurious unhandled rejection.
  if (state->ready) {
    bool pending = false;
    napi_value exception = nullptr;
    napi_is_exception_pending(env, &pending);
    if (pending) napi_get_and_clear_last_exception(env, &exception);
    napi_value undefined = nullptr;
    if (napi_get_undefined(env, &undefined) == napi_ok) {
      napi_resolve_deferred(env, std::exchange(state->ready, nullptr), undefined);
    }
    if (exception) napi_throw(env, exception);
  }
  if (state->cleanup) {
    BeginAbandon(state);
  } else {
    // No native engine can exist before PrepareState installs the async hook.
    state->callbacks_detached.store(true);
    state->abandoned.store(true);
    StopEvents(state, napi_tsfn_abort);
    if (auto listener = std::exchange(state->listener, nullptr)) {
      napi_delete_reference(env, listener);
    }
    if (auto prototype = std::exchange(state->buffer_prototype, nullptr)) {
      napi_delete_reference(env, prototype);
    }
  }
}

napi_value CreateEngine(napi_env env, napi_callback_info info) {
  return Synchronous(env, [&]() -> napi_value {
    Arguments<2> args(env, info);
    // Inert DLL negotiation precedes option getters, async state and creation.
    RequireContract(env);
    bool encoded = false, av1 = false;
    const auto options = Options(env, args.values[0], encoded, av1);
    if (Type(env, args.values[1]) != napi_function) Invalid(env, "onEvent must be a function");
    auto state = std::make_shared<State>(env, options);
    try {
      PrepareState(env, state, args.values[1]);
      MonkyEngineCallbacks callbacks{};
      callbacks.struct_size = sizeof(callbacks);
      callbacks.abi_version = MONKY_ENGINE_ABI_VERSION;
      callbacks.on_event = NativeEvent;
      callbacks.user = state.get();
      MonkyEngineError error = EmptyError();
      MonkyRtcEngine* engine = nullptr;
      const auto status = av1 ? monky_rtc_engine_create_encoded_av1(&options, &callbacks, &engine, &error)
          : encoded ? monky_rtc_engine_create_encoded(&options, &callbacks, &engine, &error)
                                  : monky_rtc_engine_create(&options, &callbacks, &engine, &error);
      {
        std::lock_guard lock(state->native_mutex);
        state->engine = engine;
      }
      if (!engine) state->callbacks_detached.store(true);
      if (status != MONKY_ENGINE_OK) ThrowNative(env, status, error);
      if (!engine) {
        ThrowNative(env, MONKY_ENGINE_FAILURE,
                    Error(MONKY_ENGINE_FAILURE, "ERR_RTC_CREATE_CONTRACT",
                          "The DLL acknowledged creation without returning an owned engine"));
      }
      napi_value object = Object(env);
      Check(env, napi_type_tag_object(env, object, &kEngineTag));
      auto wrapped = std::make_unique<StateOwner>(state);
      Check(env, napi_wrap(env, object, wrapped.get(), WrapperFinalizer, nullptr, nullptr));
      wrapped.release();
      const napi_property_descriptor methods[] = {
          {"request", nullptr, Request, nullptr, nullptr, nullptr, napi_default, nullptr},
          {"respond", nullptr, Respond, nullptr, nullptr, nullptr, napi_default, nullptr},
          {"cancel", nullptr, Cancel, nullptr, nullptr, nullptr, napi_default, nullptr},
          {"submitEncodedFrame", nullptr, SubmitEncodedFrame, nullptr, nullptr, nullptr, napi_default, nullptr},
          {"submitAudioPacket", nullptr, SubmitAudioPacket, nullptr, nullptr, nullptr, napi_default, nullptr},
          {"grantAudioCredits", nullptr, GrantAudioCredits, nullptr, nullptr, nullptr, napi_default, nullptr},
          {"audioClockProbe", nullptr, AudioClockProbe, nullptr, nullptr, nullptr, napi_default, nullptr},
          {"calibrateAudioClock", nullptr, CalibrateAudioClock, nullptr, nullptr, nullptr, napi_default, nullptr},
          {"setAudioOutputFeedback", nullptr, SetAudioOutputFeedback, nullptr, nullptr, nullptr, napi_default, nullptr},
          {"releaseFrame", nullptr, ReleaseFrame, nullptr, nullptr, nullptr, napi_default, nullptr},
          {"snapshot", nullptr, Snapshot, nullptr, nullptr, nullptr, napi_default, nullptr},
          {"close", nullptr, Close, nullptr, nullptr, nullptr, napi_default, nullptr},
      };
      Check(env, napi_define_properties(env, object, std::size(methods), methods));
      napi_value promise;
      Check(env, napi_create_promise(env, &state->ready, &promise));
      const napi_property_descriptor ready = {
          "ready", nullptr, nullptr, nullptr, nullptr, promise, napi_enumerable, nullptr};
      Check(env, napi_define_properties(env, object, 1, &ready));
      return object;
    } catch (...) {
      FailedConstruction(env, state);
      throw;
    }
  });
}

napi_value Capabilities(napi_env env, napi_callback_info info) {
  return Synchronous(env, [&]() -> napi_value {
    Arguments<0> args(env, info);
    return ReadCapabilities(env);
  });
}

napi_value Init(napi_env env, napi_value exports) {
  return Synchronous(env, [&]() -> napi_value {
    const napi_property_descriptor methods[] = {
        {"capabilities", nullptr, Capabilities, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"createEngine", nullptr, CreateEngine, nullptr, nullptr, nullptr, napi_default, nullptr},
    };
    Check(env, napi_define_properties(env, exports, std::size(methods), methods));
    return exports;
  });
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
