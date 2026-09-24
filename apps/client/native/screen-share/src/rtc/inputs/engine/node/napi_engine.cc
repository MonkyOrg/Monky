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
#include "audio\monky_rtc_audio.h"
#include "input_leases.h"
#include "event_queue.h"

#if defined(__clang__) || !defined(_MSC_VER) || NAPI_VERSION != 8
#error This consumer must be compiled independently with MSVC and Node-API 8.
#endif
#if !defined(_DLL) || !_HAS_EXCEPTIONS
#error The Node consumer requires the dynamic MSVC CRT and C++ exceptions.
#endif
static_assert(_MSVC_LANG >= 202002L);
static_assert(sizeof(void*) == 8);
static_assert(MONKY_ENGINE_ABI_VERSION == 2u);
static_assert(MONKY_ENGINE_CONTRACT_REVISION == 8u);
static_assert(std::endian::native == std::endian::little);
static_assert(sizeof(MonkyEngineError) == 608);
static_assert(sizeof(MonkyEngineOptions) == 32);
static_assert(sizeof(MonkyEngineEvent) == 48);
static_assert(sizeof(MonkyEngineCallbacks) == 24);
static_assert(sizeof(MonkyEngineInputFrame) == 48);
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
static_assert(offsetof(MonkyEngineInputFrame, texture_nt_handle) == 16);
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
static_assert(std::is_trivially_copyable_v<MonkyEngineInputFrame>);
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

namespace {

constexpr uint64_t kMaxSafeInteger = 9007199254740991ULL;
constexpr size_t kEventQueueSize = 128;
constexpr uint32_t kMaxJsonBytes = 1024 * 1024;
constexpr uint32_t kMaxCloseWaitMs = 60000;
constexpr uint32_t kSharedFrameFlags =
    MONKY_ENGINE_SHARED_GPU_COPY | MONKY_ENGINE_SHARED_COPY_COMPLETE |
    MONKY_ENGINE_SHARED_KEYED_MUTEX_ZERO | MONKY_ENGINE_SHARED_RECLAIM_FENCE;
static_assert(kSharedFrameFlags == 15u);
constexpr napi_type_tag kEngineTag = {
    0x6d6f6e6b79525443ULL, 0x4e41504938000202ULL};

struct JsFailure {
  // Only errors constructed here are safe to enrich without inspecting a
  // user-thrown object (which may be frozen, a proxy or contain getters).
  napi_value local_error = nullptr;
};
struct State;
using EventContext = monky::native_rtc::node::EventQueueContext<std::shared_ptr<State>>;
struct CloseWork;
struct CleanupOwner;

MonkyEngineError Error(MonkyEngineStatus status, const char* code,
                       const char* message) noexcept {
  MonkyEngineError error{};
  error.struct_size = sizeof(error);
  error.status = status;
  std::snprintf(error.code, sizeof(error.code), "%s", code);
  std::snprintf(error.message, sizeof(error.message), "%s", message);
  return error;
}

MonkyEngineError EmptyError() noexcept {
  MonkyEngineError error{};
  error.struct_size = sizeof(error);
  return error;
}

void Check(napi_env env, napi_status status) {
  if (status == napi_ok) return;
  bool pending = false;
  if (napi_is_exception_pending(env, &pending) != napi_ok || !pending) {
    napi_throw_error(env, "ERR_RTC_NAPI", "A Node-API operation failed");
  }
  throw JsFailure{};
}

napi_value Undefined(napi_env env) {
  napi_value value;
  Check(env, napi_get_undefined(env, &value));
  return value;
}

napi_value Text(napi_env env, const char* text, size_t bytes = NAPI_AUTO_LENGTH) {
  napi_value value;
  Check(env, napi_create_string_utf8(env, text, bytes, &value));
  return value;
}

napi_value Object(napi_env env) {
  napi_value value;
  Check(env, napi_create_object(env, &value));
  return value;
}

void Set(napi_env env, napi_value object, const char* key, napi_value value) {
  Check(env, napi_set_named_property(env, object, key, value));
}

void SetNumber(napi_env env, napi_value object, const char* key, double number) {
  napi_value value;
  Check(env, napi_create_double(env, number, &value));
  Set(env, object, key, value);
}

void SetBool(napi_env env, napi_value object, const char* key, bool boolean) {
  napi_value value;
  Check(env, napi_get_boolean(env, boolean, &value));
  Set(env, object, key, value);
}

// Own data properties cannot hand a borrowed HANDLE to a prototype setter before
// the listener's lease has been marked delivered.
void Define(napi_env env, napi_value object, const char* key, napi_value value) {
  const napi_property_descriptor property = {
      key, nullptr, nullptr, nullptr, nullptr, value, napi_default_jsproperty, nullptr};
  Check(env, napi_define_properties(env, object, 1, &property));
}

void DefineNumber(napi_env env, napi_value object, const char* key, double number) {
  napi_value value;
  Check(env, napi_create_double(env, number, &value));
  Define(env, object, key, value);
}

void DefineBool(napi_env env, napi_value object, const char* key, bool boolean) {
  napi_value value;
  Check(env, napi_get_boolean(env, boolean, &value));
  Define(env, object, key, value);
}

template <size_t N>
size_t BoundedLength(const char (&text)[N]) noexcept {
  const void* end = std::memchr(text, '\0', N);
  return end ? static_cast<const char*>(end) - text : N;
}

napi_value ErrorValue(napi_env env, MonkyEngineStatus status,
                      const MonkyEngineError& error) {
  const auto code_length = BoundedLength(error.code);
  const auto message_length = BoundedLength(error.message);
  napi_value code = code_length ? Text(env, error.code, code_length)
                               : Text(env, "ERR_RTC_ENGINE");
  napi_value message = message_length
                           ? Text(env, error.message, message_length)
                           : Text(env, "The native RTC engine rejected the operation");
  napi_value value;
  Check(env, napi_create_error(env, code, message, &value));
  DefineNumber(env, value, "status", status);
  DefineNumber(env, value, "hresult", error.hresult);
  return value;
}

[[noreturn]] void ThrowNative(napi_env env, MonkyEngineStatus status,
                              const MonkyEngineError& error) {
  const auto value = ErrorValue(env, status, error);
  Check(env, napi_throw(env, value));
  throw JsFailure{value};
}

[[noreturn]] void Invalid(napi_env env, const char* message, bool range = false) {
  napi_value value;
  const auto code = Text(env, "ERR_RTC_ARGUMENT");
  const auto text = Text(env, message);
  Check(env, range ? napi_create_range_error(env, code, text, &value)
                   : napi_create_type_error(env, code, text, &value));
  DefineNumber(env, value, "status", MONKY_ENGINE_INVALID);
  DefineNumber(env, value, "hresult", 0);
  Check(env, napi_throw(env, value));
  throw JsFailure{value};
}

[[noreturn]] void ContractFailure(napi_env env, const char* message) {
  ThrowNative(env, MONKY_ENGINE_INVALID,
              Error(MONKY_ENGINE_INVALID, "ERR_RTC_EVENT_CONTRACT", message));
}

napi_valuetype Type(napi_env env, napi_value value) {
  napi_valuetype type;
  Check(env, napi_typeof(env, value, &type));
  return type;
}

void Record(napi_env env, napi_value value, const char* message) {
  bool array = false;
  if (Type(env, value) != napi_object) Invalid(env, message);
  napi_value null_value;
  bool is_null = false;
  Check(env, napi_get_null(env, &null_value));
  Check(env, napi_strict_equals(env, value, null_value, &is_null));
  Check(env, napi_is_array(env, value, &array));
  if (is_null || array) Invalid(env, message);
}

napi_value Get(napi_env env, napi_value value, const char* key) {
  napi_value property;
  Check(env, napi_get_named_property(env, value, key, &property));
  return property;
}

bool Has(napi_env env, napi_value value, const char* key) {
  bool present = false;
  Check(env, napi_has_own_property(env, value, Text(env, key), &present));
  return present;
}

int64_t Integer(napi_env env, napi_value value, int64_t minimum,
                int64_t maximum, const char* message) {
  if (Type(env, value) != napi_number) Invalid(env, message);
  double number = 0;
  Check(env, napi_get_value_double(env, value, &number));
  if (!std::isfinite(number) || std::trunc(number) != number ||
      number < static_cast<double>(minimum) ||
      number > static_cast<double>(maximum)) {
    Invalid(env, message, true);
  }
  return static_cast<int64_t>(number);
}

uint64_t Id(napi_env env, napi_value value, bool zero = false) {
  return static_cast<uint64_t>(Integer(
      env, value, zero ? 0 : 1, kMaxSafeInteger,
      zero ? "targetId must be a nonnegative safe integer"
           : "IDs must be nonzero safe integers"));
}

bool Boolean(napi_env env, napi_value value, const char* message) {
  if (Type(env, value) != napi_boolean) Invalid(env, message);
  bool boolean = false;
  Check(env, napi_get_value_bool(env, value, &boolean));
  return boolean;
}

std::string String(napi_env env, napi_value value, size_t minimum,
                    size_t maximum, const char* message) {
  if (Type(env, value) != napi_string) Invalid(env, message);
  size_t length = 0;
  Check(env, napi_get_value_string_utf8(env, value, nullptr, 0, &length));
  if (length < minimum || length > maximum) Invalid(env, message, true);
  std::vector<char> bytes(length + 1);
  size_t copied = 0;
  Check(env, napi_get_value_string_utf8(env, value, bytes.data(), bytes.size(), &copied));
  if (copied != length || std::memchr(bytes.data(), '\0', length)) {
    Invalid(env, "Strings must not contain embedded NUL bytes");
  }
  return std::string(bytes.data(), length);
}

uint64_t HandleBytes(napi_env env, napi_value handle, napi_value buffer_prototype) {
  bool is_buffer = false;
  Check(env, napi_is_buffer(env, handle, &is_buffer));
  if (!is_buffer) Invalid(env, "handle must be a Buffer containing exactly 8 NT HANDLE bytes");
  napi_value prototype;
  bool genuine_buffer = false;
  Check(env, napi_get_prototype(env, handle, &prototype));
  Check(env, napi_strict_equals(env, prototype, buffer_prototype, &genuine_buffer));
  if (!genuine_buffer) Invalid(env, "handle must be a Buffer, not another ArrayBuffer view");
  bool typed = false;
  Check(env, napi_is_typedarray(env, handle, &typed));
  if (!typed) Invalid(env, "handle must have the Buffer Uint8Array representation");
  napi_typedarray_type array_type;
  size_t elements = 0, byte_offset = 0;
  void* array_data = nullptr;
  napi_value array_buffer;
  Check(env, napi_get_typedarray_info(env, handle, &array_type, &elements,
                                      &array_data, &array_buffer, &byte_offset));
  bool ordinary_buffer = false;
  Check(env, napi_is_arraybuffer(env, array_buffer, &ordinary_buffer));
  if (array_type != napi_uint8_array || elements != sizeof(uint64_t) || !ordinary_buffer) {
    Invalid(env, "handle must be an 8-byte Buffer backed by a non-shared ArrayBuffer");
  }
  bool detached = false;
  Check(env, napi_is_detached_arraybuffer(env, array_buffer, &detached));
  if (detached) Invalid(env, "handle must not use a detached ArrayBuffer");
  void* storage = nullptr;
  size_t storage_size = 0;
  Check(env, napi_get_arraybuffer_info(env, array_buffer, &storage, &storage_size));
  if (!storage || byte_offset > storage_size || elements > storage_size - byte_offset ||
      array_data != static_cast<unsigned char*>(storage) + byte_offset) {
    Invalid(env, "handle must use an in-bounds ordinary Buffer view");
  }
  void* bytes = nullptr;
  size_t size = 0;
  Check(env, napi_get_buffer_info(env, handle, &bytes, &size));
  if (size != sizeof(uint64_t) || !bytes || bytes != array_data) {
    Invalid(env, "handle must be a Buffer containing exactly 8 NT HANDLE bytes");
  }
  uint64_t value = 0;
  std::memcpy(&value, bytes, sizeof(value));
  if (!value || value > INT64_MAX) {
    Invalid(env, "Null and negative pseudo HANDLE values are not texture NT handles", true);
  }
  return value;
}

napi_value JsonCall(napi_env env, const char* method, napi_value argument) {
  napi_value global;
  Check(env, napi_get_global(env, &global));
  napi_value json = Get(env, global, "JSON");
  napi_value function = Get(env, json, method);
  if (Type(env, function) != napi_function) {
    Invalid(env, "The Node JSON intrinsics are not available");
  }
  napi_value result;
  Check(env, napi_call_function(env, json, function, 1, &argument, &result));
  return result;
}

std::string Stringify(napi_env env, napi_value value) {
  Record(env, value, "data must be a JSON object");
  auto json = String(env, JsonCall(env, "stringify", value), 2, kMaxJsonBytes,
                     "JSON must be an object of at most 1 MiB");
  if (json.front() != '{' || json.back() != '}') {
    Invalid(env, "toJSON must not replace the root object with a non-object");
  }
  return json;
}

napi_value Parse(napi_env env, const std::string& json) {
  napi_value value = JsonCall(env, "parse", Text(env, json.data(), json.size()));
  Record(env, value, "The native JSON result must be an object");
  return value;
}

void Settle(napi_env env, napi_deferred& deferred, napi_value value, bool ok) {
  if (!deferred) return;
  auto owned = std::exchange(deferred, nullptr);
  Check(env, ok ? napi_resolve_deferred(env, owned, value)
                : napi_reject_deferred(env, owned, value));
}

napi_value PendingException(napi_env env) {
  bool pending = false;
  Check(env, napi_is_exception_pending(env, &pending));
  if (!pending) {
    return ErrorValue(env, MONKY_ENGINE_FAILURE,
                      Error(MONKY_ENGINE_FAILURE, "ERR_RTC_NAPI",
                            "The native wrapper failed without a JavaScript exception"));
  }
  napi_value exception;
  Check(env, napi_get_and_clear_last_exception(env, &exception));
  return exception;
}

void ReportException(napi_env env, napi_value exception) noexcept {
  if (napi_fatal_exception(env, exception) != napi_ok) {
    napi_fatal_error("monky_rtc_engine", NAPI_AUTO_LENGTH,
                     "Could not report an uncaught Node callback exception", NAPI_AUTO_LENGTH);
  }
}

void AllocationException(napi_env env) noexcept {
  napi_throw_error(env, "ERR_RTC_ALLOCATION", "The MSVC Node consumer could not allocate memory");
}

template <typename Function>
napi_value Synchronous(napi_env env, Function&& function) noexcept {
  try {
    return function();
  } catch (const JsFailure&) {
    return nullptr;
  } catch (const std::bad_alloc&) {
    AllocationException(env);
  } catch (const std::exception&) {
    napi_throw_error(env, "ERR_RTC_WRAPPER", "An unexpected C++ wrapper exception occurred");
  } catch (...) {
    napi_throw_error(env, "ERR_RTC_WRAPPER", "An unknown native wrapper exception occurred");
  }
  return nullptr;
}

template <typename Function>
napi_value PromiseMethod(napi_env env, Function&& function) noexcept {
  return Synchronous(env, [&]() -> napi_value {
    napi_deferred deferred = nullptr;
    napi_value promise;
    Check(env, napi_create_promise(env, &deferred, &promise));
    try {
      function(deferred);
      return promise;
    } catch (const JsFailure&) {
    } catch (const std::bad_alloc&) {
      AllocationException(env);
    } catch (const std::exception&) {
      napi_throw_error(env, "ERR_RTC_WRAPPER", "An unexpected C++ wrapper exception occurred");
    } catch (...) {
      napi_throw_error(env, "ERR_RTC_WRAPPER", "An unknown native wrapper exception occurred");
    }
    Settle(env, deferred, PendingException(env), false);
    return promise;
  });
}

struct JsonResult {
  MonkyEngineStatus status = MONKY_ENGINE_OK;
  MonkyEngineError error = EmptyError();
  std::string json;
};

template <typename Copy>
JsonResult CopyJson(Copy&& copy) {
  JsonResult result;
  uint32_t required = 0;
  result.status = copy(nullptr, 0, &required, &result.error);
  if (result.status != MONKY_ENGINE_BUFFER_TOO_SMALL && result.status != MONKY_ENGINE_OK) {
    return result;
  }
  for (unsigned attempt = 0; attempt != 4; ++attempt) {
    if (required < 3 || required > kMaxJsonBytes + 1) break;
    std::vector<char> bytes(required, static_cast<char>(0xff));
    uint32_t written = 0;
    result.error = EmptyError();
    result.status = copy(bytes.data(), required, &written, &result.error);
    if (result.status == MONKY_ENGINE_BUFFER_TOO_SMALL) {
      required = written;
      continue;
    }
    if (result.status != MONKY_ENGINE_OK) return result;
    if (written < 3 || written > bytes.size() || bytes[written - 1] != '\0' ||
        std::memchr(bytes.data(), '\0', written - 1)) break;
    result.json.assign(bytes.data(), written - 1);
    return result;
  }
  result.status = MONKY_ENGINE_FAILURE;
  result.error = Error(MONKY_ENGINE_FAILURE, "ERR_RTC_JSON_BUFFER",
                       "The DLL returned an invalid, oversized or unstable JSON buffer");
  return result;
}

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
      !matches("inputLeaseCorrelation", enabled) || !matches("pairedCaptureClock", enabled) ||
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

struct ClosedRecord {
  JsonResult snapshot;
};

struct NativeResult {
  MonkyEngineStatus status = MONKY_ENGINE_OK;
  MonkyEngineError error = EmptyError();
  std::shared_ptr<ClosedRecord> closed;
};

struct PendingOperation {
  napi_deferred deferred = nullptr;
  std::string operation;
  uint64_t receiver = 0;
  bool enabled = false;
};

using monky::native_rtc::node::InputAdmission;
using monky::native_rtc::node::InputKey;
using monky::native_rtc::node::InputLeases;

napi_value InputError(napi_env env, napi_value error, const InputKey& key, bool retained) {
  DefineNumber(env, error, "sourceId", static_cast<double>(key.first));
  DefineNumber(env, error, "frameId", static_cast<double>(key.second));
  DefineBool(env, error, "nativeOwnershipRetained", retained);
  return error;
}

struct PendingRelease {
  napi_deferred deferred = nullptr;
  uint64_t target = 0;
};
using AudioInputKey = std::tuple<uint64_t, std::string, uint64_t>;
struct PendingAudioInput {
  napi_deferred deferred = nullptr;
  uint64_t frame_index = 0;
  uint32_t frames = 0;
};
napi_value AudioInputError(napi_env env, napi_value error, const AudioInputKey& key, bool pending,
                          const PendingAudioInput* span = nullptr) {
  DefineNumber(env, error, "sourceId", static_cast<double>(std::get<0>(key)));
  Define(env, error, "epoch", Text(env, std::get<1>(key).data(), std::get<1>(key).size()));
  DefineNumber(env, error, "sequence", static_cast<double>(std::get<2>(key)));
  if (span) {
    DefineNumber(env, error, "frameIndex", static_cast<double>(span->frame_index));
    DefineNumber(env, error, "frames", static_cast<double>(span->frames));
  }
  DefineBool(env, error, "ok", false);
  DefineBool(env, error, "nativeOwnershipRetained", false);
  DefineBool(env, error, "processingPending", pending);
  return error;
}

struct DecodedLease {
  uint64_t target = 0;
  bool delivered = false;
  bool releasing = false;
  bool release_admitted = false;
  bool automatic_unused = false;
  bool retirement_notified = false;
};

struct CallbackLease {
  uint64_t target = 0;
  uint64_t request = 0;
  bool responding = false;
};

struct State {
  explicit State(napi_env environment, const MonkyEngineOptions& configuration)
      : env(environment), options(configuration) {}

  napi_env env;
  MonkyEngineOptions options;

  // This mutex protects access admission, never an RTC call, join or wait.
  std::mutex native_mutex;
  std::condition_variable native_idle;
  MonkyRtcEngine* engine = nullptr;
  size_t native_calls = 0;
  bool retiring = false;
  std::shared_ptr<ClosedRecord> retired;
  std::atomic<bool> callbacks_detached{false};
  std::mutex worker_mutex;

  // All producer access AND TSFN release use this same mutex.
  std::mutex event_mutex;
  std::condition_variable events_drained;
  napi_threadsafe_function tsfn = nullptr;
  EventContext* event_context = nullptr;
  std::unordered_map<uint64_t, DecodedLease> decoded;
  // Bounded tombstones only, not owned leases: rejected FRAME callbacks leave
  // UNUSED retirement with the DLL, which may suppress their completion event.
  std::map<uint64_t, uint64_t> unused_transfers;
  std::unordered_map<uint64_t, CallbackLease> callbacks;
  std::atomic<MonkyEngineStatus> delivery_fault{MONKY_ENGINE_OK};
  std::atomic<bool> abandoned{false};
  std::atomic<bool> environment_closing{false};

  // The fields below are accessed only on Node's main thread.
  napi_ref listener = nullptr;
  napi_ref buffer_prototype = nullptr;
  napi_deferred ready = nullptr;
  bool ready_seen = false;
  bool closing = false;
  bool completed = false;
  std::atomic<bool> tsfn_finished{false};
  bool close_wait_finished = false;
  bool delivery_fault_reported = false;
  std::unordered_map<uint64_t, PendingOperation> operations;
  InputLeases<napi_deferred> inputs;
  std::map<AudioInputKey, PendingAudioInput> audio_inputs;
  std::unordered_map<uint64_t, PendingRelease> releases;
  napi_deferred close_deferred = nullptr;
  napi_ref close_promise = nullptr;
  CloseWork* close_work = nullptr;
  CleanupOwner* cleanup = nullptr;
  std::shared_ptr<ClosedRecord> final_record;
};

using StateOwner = std::shared_ptr<State>;

class NativeAccess {
 public:
  explicit NativeAccess(State& state) : state_(state) {
    std::lock_guard lock(state_.native_mutex);
    if (!state_.retiring && state_.engine) {
      engine_ = state_.engine;
      ++state_.native_calls;
    }
  }
  NativeAccess(const NativeAccess&) = delete;
  NativeAccess& operator=(const NativeAccess&) = delete;
  ~NativeAccess() { Reset(); }
  MonkyRtcEngine* get() const noexcept { return engine_; }
  void Reset() noexcept {
    if (!engine_) return;
    {
      std::lock_guard lock(state_.native_mutex);
      --state_.native_calls;
      engine_ = nullptr;
    }
    state_.native_idle.notify_all();
  }
 private:
  State& state_;
  MonkyRtcEngine* engine_ = nullptr;
};

void RequireNative(napi_env env, const NativeAccess& native) {
  if (!native.get()) {
    ThrowNative(env, MONKY_ENGINE_CLOSED,
                Error(MONKY_ENGINE_CLOSED, "ERR_RTC_ENGINE_CLOSED",
                      "The engine is closed or its final native retirement is in progress"));
  }
}

struct QueuedEvent {
  uint32_t kind = 0;
  uint64_t target = 0;
  uint64_t id = 0;
  bool unused_transfer = false;
  std::string json;
};

struct CloseWork {
  StateOwner state;
  napi_async_work work = nullptr;
  NativeResult result;
};

struct CleanupOwner {
  StateOwner state;
  napi_async_cleanup_hook_handle hook = nullptr;
  napi_async_work work = nullptr;
  bool queued = false;
  NativeResult result;
};

void MaybeCompleteClose(napi_env env, const StateOwner& state);
void StartAutoClose(napi_env env, const StateOwner& state);
void BeginAbandon(const StateOwner& state) noexcept;
void DisposeIdleCleanup(napi_env env, const StateOwner& state);

void StopEvents(const StateOwner& state,
                napi_threadsafe_function_release_mode mode) noexcept {
  if (!state->callbacks_detached.load()) {
    std::fprintf(stderr, "[monky-rtc] Callback access is not fenced; event queue ownership retained.\n");
    return;
  }
  std::lock_guard lock(state->event_mutex);
  if (auto tsfn = std::exchange(state->tsfn, nullptr)) {
    state->event_context = nullptr;
    const auto status = napi_release_threadsafe_function(tsfn, mode);
    if (status != napi_ok && status != napi_closing) {
      std::fprintf(stderr, "[monky-rtc] Failed to release the detached event queue (%d).\n",
                   static_cast<int>(status));
    }
  }
}

MonkyEngineStatus DetachCallbacks(const StateOwner& state,
                                  MonkyEngineError* error) noexcept {
  if (state->callbacks_detached.load()) return MONKY_ENGINE_OK;
  NativeAccess native(*state);
  if (!native.get()) {
    // Retirement cannot exclude new callers until callbacks have been detached.
    return state->callbacks_detached.load() ? MONKY_ENGINE_OK : MONKY_ENGINE_CLOSED;
  }
  const auto status = monky_rtc_engine_detach_callbacks(native.get(), error);
  if (status == MONKY_ENGINE_OK) state->callbacks_detached.store(true);
  return status;
}

napi_status QueueEventLocked(State& state, void* data) noexcept {
  auto* context = state.event_context;
  if (!state.tsfn || !context) return napi_closing;
  context->RetainPending();
  const auto status = napi_call_threadsafe_function(state.tsfn, data, napi_tsfn_nonblocking);
  if (status == napi_closing) {
    // Some runtimes consumed the producer ref while returning this status.
    // Neither cleanup nor another producer may touch/release this handle again.
    state.tsfn = nullptr;
    state.event_context = nullptr;
  }
  if (status != napi_ok) (void)context->ReleasePending();
  return status;
}

void FaultLocked(State& state, MonkyEngineStatus status) noexcept {
  MonkyEngineStatus expected = MONKY_ENGINE_OK;
  state.delivery_fault.compare_exchange_strong(expected, status);
  if (!state.tsfn) return;
  (void)QueueEventLocked(state, nullptr);
}

void WaitForEventDrain(const StateOwner& state) {
  std::unique_lock lock(state->event_mutex);
  state->events_drained.wait(lock, [&] { return state->tsfn_finished.load(); });
}

void RememberUnusedTransferLocked(State& state, uint64_t id, uint64_t target) {
  // Monotonic IDs permit bounded history when the DLL suppresses these events.
  // A completion older than this history faults rather than guessing ownership.
  if (state.unused_transfers.size() >= kEventQueueSize) {
    state.unused_transfers.erase(state.unused_transfers.begin());
  }
  state.unused_transfers.emplace(id, target);
}

MonkyEngineStatus __cdecl NativeEvent(void* user, const MonkyEngineEvent* event) noexcept {
  auto& state = *static_cast<State*>(user);
  try {
    std::lock_guard lock(state.event_mutex);
    if (!state.tsfn || state.abandoned.load()) return MONKY_ENGINE_CLOSED;
    if (!event || event->struct_size != sizeof(MonkyEngineEvent)) {
      FaultLocked(state, MONKY_ENGINE_INVALID);
      return MONKY_ENGINE_INVALID;
    }
    const bool needs_id =
        (event->kind == MONKY_ENGINE_EVENT_OPERATION ||
         event->kind == MONKY_ENGINE_EVENT_REQUEST ||
         event->kind == MONKY_ENGINE_EVENT_FRAME ||
         event->kind == MONKY_ENGINE_EVENT_INPUT_RELEASED ||
         event->kind == MONKY_ENGINE_EVENT_FRAME_RELEASED ||
         event->kind == MONKY_ENGINE_EVENT_AUDIO_INPUT_RELEASED ||
         event->kind == MONKY_ENGINE_EVENT_AUDIO_OUTPUT);
    if (event->abi_version != MONKY_ENGINE_ABI_VERSION || event->reserved ||
        event->reserved2 || event->kind < MONKY_ENGINE_EVENT_READY ||
        event->kind > MONKY_ENGINE_EVENT_AUDIO_OUTPUT || !event->json ||
        !event->json_bytes || event->json_bytes > kMaxJsonBytes ||
        event->target > kMaxSafeInteger || event->id > kMaxSafeInteger ||
        (needs_id && !event->id) ||
        std::memchr(event->json, '\0', event->json_bytes)) {
      FaultLocked(state, MONKY_ENGINE_INVALID);
      return MONKY_ENGINE_INVALID;
    }
    auto copied = std::make_unique<QueuedEvent>();
    copied->kind = event->kind;
    copied->target = event->target;
    copied->id = event->id;
    copied->json.assign(event->json, event->json_bytes);
    bool frame_inserted = false;
    bool callback_inserted = false;
    if (event->kind == MONKY_ENGINE_EVENT_FRAME) {
      if (state.decoded.find(event->id) != state.decoded.end() ||
          state.unused_transfers.find(event->id) != state.unused_transfers.end()) {
        FaultLocked(state, MONKY_ENGINE_INVALID);
        return MONKY_ENGINE_INVALID;
      }
      // Actual retirement can be notified before release_frame returns to Node.
      // Keep its deferred on the main thread, but do not count that native slot.
      const auto retained = std::count_if(state.decoded.begin(), state.decoded.end(),
          [](const auto& entry) { return !entry.second.retirement_notified; });
      if (static_cast<size_t>(retained) >= state.options.max_decoded_frames ||
          state.decoded.size() >= state.options.max_decoded_frames + kEventQueueSize) {
        RememberUnusedTransferLocked(state, event->id, event->target);
        return MONKY_ENGINE_QUEUE_FULL;
      }
      frame_inserted = state.decoded.emplace(event->id, DecodedLease{event->target}).second;
      if (!frame_inserted) {
        FaultLocked(state, MONKY_ENGINE_INVALID);
        return MONKY_ENGINE_INVALID;
      }
    } else if (event->kind == MONKY_ENGINE_EVENT_FRAME_RELEASED) {
      auto frame = state.decoded.find(event->id);
      if (frame == state.decoded.end()) {
        const auto unused = state.unused_transfers.find(event->id);
        if (unused == state.unused_transfers.end() || unused->second != event->target) {
          FaultLocked(state, MONKY_ENGINE_INVALID);
          return MONKY_ENGINE_INVALID;
        }
        copied->unused_transfer = true;
      } else if (frame->second.target != event->target || !frame->second.releasing ||
                 frame->second.retirement_notified) {
        FaultLocked(state, MONKY_ENGINE_INVALID);
        return MONKY_ENGINE_INVALID;
      } else {
        // Only producer-side bookkeeping is touched here, never a napi_deferred.
        // If queueing fails, close must complete before the main-thread map settles.
        frame->second.retirement_notified = true;
      }
    } else if (event->kind == MONKY_ENGINE_EVENT_REQUEST) {
      // A respond may unblock a replacement callback before returning to Node.
      const auto waiting = std::count_if(state.callbacks.begin(), state.callbacks.end(),
          [](const auto& entry) { return !entry.second.responding; });
      if (static_cast<size_t>(waiting) >= state.options.max_pending_operations) {
        FaultLocked(state, MONKY_ENGINE_QUEUE_FULL);
        return MONKY_ENGINE_QUEUE_FULL;
      }
      callback_inserted = state.callbacks.emplace(event->id, CallbackLease{event->target}).second;
      if (!callback_inserted) {
        FaultLocked(state, MONKY_ENGINE_INVALID);
        return MONKY_ENGINE_INVALID;
      }
    }
    const bool unused_transfer = copied->unused_transfer;
    const auto status = QueueEventLocked(state, copied.get());
    if (status == napi_ok) {
      if (unused_transfer) state.unused_transfers.erase(event->id);
      copied.release();
      return MONKY_ENGINE_OK;
    }
    if (frame_inserted) {
      state.decoded.erase(event->id);
      if (status == napi_queue_full) RememberUnusedTransferLocked(state, event->id, event->target);
    }
    if (callback_inserted) state.callbacks.erase(event->id);
    if (status == napi_closing) {
      state.tsfn = nullptr;
      return MONKY_ENGINE_CLOSED;
    }
    const auto failure = status == napi_queue_full ? MONKY_ENGINE_QUEUE_FULL
                                                  : MONKY_ENGINE_FAILURE;
    // A rejected decoded event transfers no lease to Node: the DLL retires it
    // and counts a drop. Losing control/input/frame-release events requires close.
    if (event->kind != MONKY_ENGINE_EVENT_FRAME || status != napi_queue_full)
      FaultLocked(state, failure);
    return failure;
  } catch (...) {
    // No C++ exception, wait or JavaScript execution may cross the DLL callback.
    std::lock_guard lock(state.event_mutex);
    FaultLocked(state, MONKY_ENGINE_FAILURE);
    return MONKY_ENGINE_FAILURE;
  }
}

NativeResult WaitAndRetire(const StateOwner& state, uint32_t timeout_ms) {
  NativeResult result;
  NativeAccess native(*state);
  if (!native.get()) {
    std::lock_guard lock(state->native_mutex);
    result.closed = state->retired;
    if (!result.closed) {
      result.status = MONKY_ENGINE_CLOSED;
      result.error = Error(MONKY_ENGINE_CLOSED, "ERR_RTC_ENGINE_CLOSED",
                           "There is no native engine to wait for");
    }
    return result;
  }
  result.status = monky_rtc_engine_wait_closed(native.get(), timeout_ms, &result.error);
  if (result.status != MONKY_ENGINE_OK) return result;

  // Never acquire event_mutex before the DLL's callback mutex has been detached.
  result.error = EmptyError();
  result.status = monky_rtc_engine_detach_callbacks(native.get(), &result.error);
  if (result.status != MONKY_ENGINE_OK) return result;
  state->callbacks_detached.store(true);
  auto record = std::make_shared<ClosedRecord>();
  MonkyRtcEngine* engine = native.get();
  {
    std::lock_guard lock(state->native_mutex);
    state->retiring = true;
  }
  native.Reset();
  {
    std::unique_lock lock(state->native_mutex);
    state->native_idle.wait(lock, [&] { return state->native_calls == 0; });
  }
  try {
    record->snapshot = CopyJson([&](char* output, uint32_t capacity, uint32_t* bytes,
                                    MonkyEngineError* error) {
      return monky_rtc_engine_snapshot(engine, output, capacity, bytes, error);
    });
    result.error = EmptyError();
    result.status = monky_rtc_engine_destroy(engine, &result.error);
    {
      std::lock_guard lock(state->native_mutex);
      if (result.status == MONKY_ENGINE_OK) {
        state->engine = nullptr;
        state->retired = record;
        result.closed = std::move(record);
      }
      state->retiring = false;
    }
  } catch (...) {
    std::lock_guard lock(state->native_mutex);
    state->retiring = false;
    throw;
  }
  if (result.closed) {
    StopEvents(state, state->abandoned.load() ? napi_tsfn_abort : napi_tsfn_release);
    WaitForEventDrain(state);
  }
  return result;
}

void WorkerException(NativeResult& result) noexcept {
  result.status = MONKY_ENGINE_FAILURE;
  result.error = Error(MONKY_ENGINE_FAILURE, "ERR_RTC_CLEANUP_WORKER",
                       "A native cleanup worker failed; native ownership is retained");
}

void CloseExecute(napi_env, void* data) noexcept {
  auto& work = *static_cast<CloseWork*>(data);
  try {
    std::unique_lock lock(work.state->worker_mutex);
    work.result = WaitAndRetire(
        work.state, std::min(work.state->options.operation_timeout_ms, kMaxCloseWaitMs));
  } catch (...) {
    WorkerException(work.result);
  }
}

bool Emit(napi_env env, const StateOwner& state, napi_value event,
          uint64_t frame_id = 0, uint64_t target = 0) {
  if (!state->listener || state->environment_closing.load() || state->abandoned.load()) return false;
  napi_value listener;
  Check(env, napi_get_reference_value(env, state->listener, &listener));
  const auto receiver = Undefined(env);
  if (frame_id) {
    bool valid = false;
    {
      std::lock_guard lock(state->event_mutex);
      const auto frame = state->decoded.find(frame_id);
      if (state->closing || state->abandoned.load() || state->environment_closing.load() ||
          (frame != state->decoded.end() && frame->second.releasing)) return false;
      valid = frame != state->decoded.end() && frame->second.target == target &&
              !frame->second.delivered;
      // The listener can import the HANDLE and then throw. Once invoked it is
      // conservatively external, even if the call does not return successfully.
      if (valid) frame->second.delivered = true;
    }
    if (!valid) ContractFailure(env, "Invalid or duplicate decoded lease delivery");
  }
  napi_value result;
  const auto status = napi_call_function(env, receiver, listener, 1, &event, &result);
  if (status == napi_pending_exception) {
    ReportException(env, PendingException(env));
  } else {
    Check(env, status);
  }
  return true;
}

napi_value ErrorEnvelope(napi_env env, napi_value error, bool retained) {
  napi_value envelope = Object(env);
  Set(env, envelope, "type", Text(env, "error"));
  SetNumber(env, envelope, "target", 0);
  napi_value data = Object(env);
  for (const auto* key : {"code", "message", "status", "hresult"}) {
    Set(env, data, key, Get(env, error, key));
  }
  SetBool(env, data, "terminal", true);
  SetBool(env, data, "nativeOwnershipRetained", retained);
  Set(env, envelope, "data", data);
  return envelope;
}

void ClearClosePromise(napi_env env, const StateOwner& state) {
  if (auto reference = std::exchange(state->close_promise, nullptr)) {
    Check(env, napi_delete_reference(env, reference));
  }
}

void CloseComplete(napi_env env, napi_status status, void* data) noexcept {
  std::unique_ptr<CloseWork> work(static_cast<CloseWork*>(data));
  const auto state = work->state;
  state->close_work = nullptr;
  napi_delete_async_work(env, work->work);
  if (state->environment_closing.load()) return;
  try {
    if (!work->result.closed) {
      std::lock_guard lock(state->native_mutex);
      work->result.closed = state->retired;
    }
    if (status != napi_ok && !work->result.closed) WorkerException(work->result);
    if (work->result.closed) {
      state->close_wait_finished = true;
      state->final_record = work->result.closed;
      MaybeCompleteClose(env, state);
      return;
    }
    auto error = ErrorValue(env, work->result.status, work->result.error);
    SetBool(env, error, "nativeOwnershipRetained", true);
    SetBool(env, error, "retryable", work->result.status == MONKY_ENGINE_TIMEOUT);
    const bool observed = state->close_deferred != nullptr;
    Settle(env, state->close_deferred, error, false);
    ClearClosePromise(env, state);
    if (!observed) Emit(env, state, ErrorEnvelope(env, error, true));
  } catch (const JsFailure&) {
    ReportException(env, PendingException(env));
  } catch (...) {
    AllocationException(env);
    ReportException(env, PendingException(env));
  }
}

void StartClose(napi_env env, const StateOwner& state) {
  if (state->close_work || state->close_wait_finished || state->completed) return;
  auto work = std::make_unique<CloseWork>();
  work->state = state;
  Check(env, napi_create_async_work(env, nullptr, Text(env, "MonkyRtcEngine.close"),
                                    CloseExecute, CloseComplete, work.get(), &work->work));
  try {
    NativeAccess native(*state);
    RequireNative(env, native);
    MonkyEngineError error = EmptyError();
    const auto status = monky_rtc_engine_close(native.get(), &error);
    if (status != MONKY_ENGINE_OK && status != MONKY_ENGINE_CLOSED) {
      ThrowNative(env, status, error);
    }
    state->closing = true;
    if (state->ready) {
      auto reason = Error(MONKY_ENGINE_CLOSED, "ERR_RTC_ENGINE_CLOSING",
                          "The engine was closed before readiness could be observed");
      Settle(env, state->ready, ErrorValue(env, reason.status, reason), false);
    }
    Check(env, napi_queue_async_work(env, work->work));
    state->close_work = work.release();
  } catch (...) {
    napi_delete_async_work(env, work->work);
    throw;
  }
}

void StartAutoClose(napi_env env, const StateOwner& state) {
  if (state->abandoned.load() || state->environment_closing.load()) return;
  try {
    StartClose(env, state);
  } catch (const JsFailure&) {
    auto error = PendingException(env);
    Settle(env, state->ready, error, false);
    Emit(env, state, ErrorEnvelope(env, error, true));
  }
}

bool RecordReleaseAdmission(const StateOwner& state, uint64_t id,
                             MonkyEngineStatus status) noexcept {
  std::lock_guard lock(state->event_mutex);
  const auto frame = state->decoded.find(id);
  if (frame == state->decoded.end()) {
    FaultLocked(*state, MONKY_ENGINE_INVALID);
    return status == MONKY_ENGINE_OK;
  }
  if (status == MONKY_ENGINE_OK || frame->second.retirement_notified) {
    frame->second.release_admitted = true;
    if (status != MONKY_ENGINE_OK) {
      FaultLocked(*state, MONKY_ENGINE_INVALID);
      std::fprintf(stderr,
          "[monky-rtc] Native retirement preceded a failed release admission; "
          "its deferred is retained until completion or complete close.\n");
    }
    return true;
  }
  frame->second.releasing = false;
  frame->second.automatic_unused = false;
  return false;
}

void ReleaseUndelivered(const StateOwner& state, uint64_t id) noexcept {
  NativeAccess native(*state);
  if (!native.get()) return;
  {
    std::lock_guard lock(state->event_mutex);
    auto found = state->decoded.find(id);
    if (found == state->decoded.end() || found->second.delivered || found->second.releasing) return;
    found->second.releasing = true;
    found->second.automatic_unused = true;
  }
  MonkyEngineError error = EmptyError();
  const auto status = monky_rtc_engine_release_frame(
      native.get(), id, MONKY_ENGINE_FRAME_UNUSED, &error);
  RecordReleaseAdmission(state, id, status);
  if (status != MONKY_ENGINE_OK) {
    std::fprintf(stderr,
        "[monky-rtc] Could not admit UNUSED for an undelivered frame (status=%d); lease retained.\n",
        static_cast<int>(status));
    std::lock_guard lock(state->event_mutex);
    FaultLocked(*state, status);
  }
}

void ReleaseAbandonedFrames(const StateOwner& state) noexcept {
  uint64_t previous = 0;
  for (;;) {
    uint64_t id = kMaxSafeInteger + 1;
    {
      std::lock_guard lock(state->event_mutex);
      for (const auto& [candidate, frame] : state->decoded) {
        if (candidate > previous && candidate < id && !frame.delivered && !frame.releasing) {
          id = candidate;
        }
      }
    }
    if (id > kMaxSafeInteger) return;
    ReleaseUndelivered(state, id);
    // Attempt each eligible ID once per cleanup iteration, including rejections.
    previous = id;
  }
}

void CleanupExecute(napi_env, void* data) noexcept {
  auto& owner = *static_cast<CleanupOwner*>(data);
  const auto state = owner.state;
  unsigned failures = 0;
  for (;;) {
    try {
      std::unique_lock lock(state->worker_mutex);
      bool has_engine;
      {
        std::lock_guard native_lock(state->native_mutex);
        has_engine = state->engine != nullptr;
        if (!has_engine) owner.result.closed = state->retired;
      }
      if (!has_engine) {
        state->callbacks_detached.store(true);
        StopEvents(state, napi_tsfn_abort);
        WaitForEventDrain(state);
        return;
      }
      MonkyEngineError error = EmptyError();
      const auto detached = DetachCallbacks(state, &error);
      if (detached != MONKY_ENGINE_OK) {
        owner.result.status = detached;
        owner.result.error = error;
      } else {
        StopEvents(state, napi_tsfn_abort);
        // A queued event is not a delivery. Only never-exposed leases permit
        // automatic UNUSED; delivered leases require the parent's external proof.
        ReleaseAbandonedFrames(state);
        NativeAccess native(*state);
        if (native.get()) {
          error = EmptyError();
          const auto status = monky_rtc_engine_close(native.get(), &error);
          if (status != MONKY_ENGINE_OK && status != MONKY_ENGINE_CLOSED) {
            owner.result.status = status;
            owner.result.error = error;
          } else {
            native.Reset();
            owner.result = WaitAndRetire(
                state, std::min(state->options.operation_timeout_ms, uint32_t{12000}));
            if (owner.result.closed) return;
          }
        }
      }
    } catch (...) {
      WorkerException(owner.result);
    }
    if (failures++ % 5 == 0) {
      size_t delivered_unreleased = 0;
      size_t pending_releases = 0;
      if (state->callbacks_detached.load()) {
        std::lock_guard lock(state->event_mutex);
        for (const auto& [id, frame] : state->decoded) {
          if (frame.delivered && !frame.releasing) ++delivered_unreleased;
          if (frame.releasing && !frame.retirement_notified) ++pending_releases;
        }
      }
      std::fprintf(stderr,
          "[monky-rtc] Native cleanup remains pending (status=%d). "
          "%zu delivered leases have no external-release proof; %zu releases await retirement. "
          "Drain genuine Electron allReferencesReleased before environment teardown. "
          "The async hook retains the engine and addon; no live engine is destroyed.\n",
          static_cast<int>(owner.result.status), delivered_unreleased, pending_releases);
    }
    // A blocked driver is not permission to unload code or abandon its ownership.
    std::this_thread::sleep_for(std::chrono::milliseconds(250));
  }
}

void DeleteListener(napi_env env, const StateOwner& state) {
  if (auto listener = std::exchange(state->listener, nullptr)) {
    Check(env, napi_delete_reference(env, listener));
  }
  if (auto prototype = std::exchange(state->buffer_prototype, nullptr)) {
    Check(env, napi_delete_reference(env, prototype));
  }
}

void CleanupComplete(napi_env env, napi_status status, void* data) noexcept {
  auto* owner = static_cast<CleanupOwner*>(data);
  const auto state = owner->state;
  bool has_engine = false;
  {
    std::lock_guard lock(state->native_mutex);
    has_engine = state->engine != nullptr;
  }
  if (status != napi_ok || (!owner->result.closed && has_engine)) {
    // Retain the hook and its State on an unexpected queue cancellation.
    std::fprintf(stderr, "[monky-rtc] Native cleanup work did not complete; environment ownership retained.\n");
    return;
  }
  try {
    if (!state->environment_closing.load() && owner->result.closed) {
      state->close_wait_finished = true;
      state->final_record = owner->result.closed;
      MaybeCompleteClose(env, state);
    }
    ClearClosePromise(env, state);
    DeleteListener(env, state);
  } catch (const JsFailure&) {
    if (!state->environment_closing.load()) ReportException(env, PendingException(env));
  } catch (...) {
    if (!state->environment_closing.load()) {
      AllocationException(env);
      ReportException(env, PendingException(env));
    }
  }
  if (napi_delete_async_work(env, owner->work) != napi_ok) {
    std::fprintf(stderr, "[monky-rtc] Could not dispose cleanup work; environment hook retained.\n");
    return;
  }
  owner->work = nullptr;
  // This is removed only AFTER actual native destruction (or a failed create with no engine).
  if (napi_remove_async_cleanup_hook(owner->hook) != napi_ok) {
    std::fprintf(stderr, "[monky-rtc] Could not remove the completed environment hook; owner retained.\n");
    return;
  }
  state->cleanup = nullptr;
  delete owner;
}

void BeginAbandon(const StateOwner& state) noexcept {
  state->abandoned.store(true);
  // Detach first: taking event_mutex while holding the DLL callback mutex in the
  // opposite order would deadlock a producer copying a borrowed C event.
  MonkyEngineError error = EmptyError();
  const auto detached = DetachCallbacks(state, &error);
  if (detached != MONKY_ENGINE_OK && detached != MONKY_ENGINE_CLOSED) {
    std::fprintf(stderr, "[monky-rtc] Callback detachment will be retried by the cleanup worker.\n");
  }
  if (state->callbacks_detached.load()) StopEvents(state, napi_tsfn_abort);
  auto* owner = state->cleanup;
  if (!owner || owner->queued) return;
  const auto status = napi_queue_async_work(state->env, owner->work);
  if (status == napi_ok) {
    owner->queued = true;
  } else {
    // Do not remove the async hook or delete a possibly live C engine on failure.
    std::fprintf(stderr, "[monky-rtc] Could not queue native cleanup (%d); environment ownership retained.\n",
                 static_cast<int>(status));
  }
}

void EnvironmentCleanup(napi_async_cleanup_hook_handle, void* data) noexcept {
  const auto state = static_cast<CleanupOwner*>(data)->state;
  state->environment_closing.store(true);
  BeginAbandon(state);
}

void WrapperFinalizer(napi_env, void* data, void*) noexcept {
  std::unique_ptr<StateOwner> owner(static_cast<StateOwner*>(data));
  if (!(*owner)->completed) BeginAbandon(*owner);
}

void EventQueueDrained(const StateOwner& state) noexcept {
  {
    std::lock_guard lock(state->event_mutex);
    state->tsfn_finished.store(true);
  }
  state->events_drained.notify_all();
}

void TsfnFinalizer(napi_env, void* data, void*) noexcept {
  auto* context = static_cast<EventContext*>(data);
  const auto state = context->OwnerValue();
  {
    // Older runtimes can finalize independently of the native producer.
    // Fence producer access before allowing the runtime to destroy its handle.
    std::lock_guard lock(state->event_mutex);
    state->tsfn = nullptr;
    state->event_context = nullptr;
  }
  if (context->MarkFinalized()) EventQueueDrained(state);
  context->ReleaseFinalizer();
}

void DisposeIdleCleanup(napi_env env, const StateOwner& state) {
  auto* owner = state->cleanup;
  if (!owner || owner->queued) return;
  Check(env, napi_remove_async_cleanup_hook(owner->hook));
  owner->hook = nullptr;
  const auto status = napi_delete_async_work(env, owner->work);
  state->cleanup = nullptr;
  delete owner;
  Check(env, status);
}

void MaybeCompleteClose(napi_env env, const StateOwner& state) {
  if (state->completed || !state->close_wait_finished || !state->tsfn_finished ||
      !state->final_record || state->environment_closing.load()) return;
  state->completed = true;
  state->closing = true;
  const auto closed_error = Error(MONKY_ENGINE_CLOSED, "ERR_RTC_ENGINE_CLOSED",
      "The engine completed native close; remaining input and decoded leases have safely retired");
  const auto error = ErrorValue(env, closed_error.status, closed_error);
  SetBool(env, error, "nativeOwnershipRetained", false);
  Settle(env, state->ready, error, false);
  for (auto& [id, pending] : state->operations) Settle(env, pending.deferred, error, false);
  state->operations.clear();
  // Never settle these on a stop request, terminal event, cancellation or timeout.
  state->inputs.CompleteClose([&](const InputKey& key, napi_deferred& deferred) {
    const auto input_error = InputError(
        env, ErrorValue(env, closed_error.status, closed_error), key, false);
    Settle(env, deferred, input_error, false);
  });
  for (auto& [key, pending] : state->audio_inputs) {
    const auto input_error = AudioInputError(
        env, ErrorValue(env, closed_error.status, closed_error), key, false, &pending);
    Settle(env, pending.deferred, input_error, false);
  }
  state->audio_inputs.clear();
  // Lost release-event delivery is safe to settle only after wait_closed/destroy.
  for (auto& [id, release] : state->releases) Settle(env, release.deferred, error, false);
  state->releases.clear();
  {
    std::lock_guard lock(state->event_mutex);
    state->decoded.clear();
    state->unused_transfers.clear();
    state->callbacks.clear();
  }
  if (state->close_deferred) {
    const auto& snapshot = state->final_record->snapshot;
    if (snapshot.status == MONKY_ENGINE_OK) {
      try {
        Settle(env, state->close_deferred, Parse(env, snapshot.json), true);
      } catch (const JsFailure&) {
        Settle(env, state->close_deferred, PendingException(env), false);
      }
    } else {
      Settle(env, state->close_deferred,
             ErrorValue(env, snapshot.status, snapshot.error), false);
    }
  }
  ClearClosePromise(env, state);
  DeleteListener(env, state);
  DisposeIdleCleanup(env, state);
}

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

napi_value InputResult(napi_env env, napi_value data, const InputKey& key) {
  auto result = Object(env);
  napi_value keys;
  Check(env, napi_get_all_property_names(env, data, napi_key_own_only,
      napi_key_enumerable, napi_key_numbers_to_strings, &keys));
  uint32_t count = 0;
  Check(env, napi_get_array_length(env, keys, &count));
  if (count > 1024) ContractFailure(env, "Input retirement has too many metadata fields");
  for (uint32_t i = 0; i < count; ++i) {
    napi_value property;
    Check(env, napi_get_element(env, keys, i, &property));
    const auto name = String(env, property, 1, 1024, "Input metadata keys must be bounded strings");
    if (name == "sourceId" || name == "frameId" || name == "ok") continue;
    Define(env, result, name.c_str(), Get(env, data, name.c_str()));
  }
  DefineNumber(env, result, "sourceId", static_cast<double>(key.first));
  DefineNumber(env, result, "frameId", static_cast<double>(key.second));
  DefineBool(env, result, "ok", true);
  return result;
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
  if (Has(env, data, "gpuCopy") &&
      !Boolean(env, Get(env, data, "gpuCopy"), "Decoded gpuCopy must be boolean")) {
    ContractFailure(env, "Shared decoded NV12 must report its real GPU copy");
  }

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
      frame.flags != kSharedFrameFlags || frame.gpu_copy_count != 1 ||
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
  Define(env, handles, "ntHandle", handle);
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
  DefineBool(env, output, "gpuCopy", true);
  Define(env, output, "textureInfo", texture_info);
  auto envelope = Object(env);
  Define(env, envelope, "type", Text(env, "frame"));
  DefineNumber(env, envelope, "target", static_cast<double>(event.target));
  Define(env, envelope, "data", output);
  return envelope;
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
    case MONKY_ENGINE_EVENT_INPUT_RELEASED: {
      if (type != "source.frameReleased" || !event.target) {
        ContractFailure(env, "Invalid producer lease release event");
      }
      const InputKey typed{event.target, event.id};
      const InputKey payload{Id(env, Get(env, data, "sourceId")), Id(env, Get(env, data, "frameId"))};
      if (typed != payload) ContractFailure(env, "Input retirement IDs do not match the typed event");
      const bool ok = Boolean(env, Get(env, data, "ok"), "Frame release ok must be boolean");
      if (ok && Has(env, data, "error")) {
        ContractFailure(env, "Successful input retirement must not contain an error");
      }
      napi_value result = nullptr;
      if (ok) result = InputResult(env, data, InputKey{event.target, event.id});
      if (!ok) {
        result = Has(env, data, "error")
                     ? EventError(env, Get(env, data, "error"), false)
                     : ErrorValue(env, MONKY_ENGINE_FAILURE,
                                  Error(MONKY_ENGINE_FAILURE, "ERR_RTC_INPUT_FRAME",
                                        "The native source released this input after a failure"));
        InputError(env, result, InputKey{event.target, event.id}, false);
      }
      auto deferred = state->inputs.Retire(typed, payload);
      if (!deferred) {
        if (!state->completed) ContractFailure(env, "Release refers to an unknown input frameId");
        break;
      }
      Settle(env, *deferred, result, ok);
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
            if (reason != "rtc-unconsumed" && reason != "input-expired" &&
                reason != "publication-expired" && reason != "codec-expired" && reason != "clock-sample-uncertain")
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
    } else if (event && event->kind == MONKY_ENGINE_EVENT_INPUT_RELEASED) {
      const auto cause = exception;
      exception = ErrorValue(env, MONKY_ENGINE_INVALID,
          Error(MONKY_ENGINE_INVALID, "ERR_RTC_EVENT_CONTRACT",
                "Invalid input retirement; producer ownership remains retained until valid retirement or complete native close"));
      Define(env, exception, "cause", cause);
      DefineBool(env, exception, "nativeOwnershipRetained", true);
    } else if (event && event->kind == MONKY_ENGINE_EVENT_OPERATION) {
      auto operation = state->operations.find(event->id);
      if (operation != state->operations.end()) {
        auto deferred = operation->second.deferred;
        state->operations.erase(operation);
        Settle(env, deferred, exception, false);
      }
    }
    // Lost/malformed INPUT_RELEASED and FRAME_RELEASED preserve their ledgers.
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

MonkyEngineInputFrame InputFrame(napi_env env, napi_value object, napi_value buffer_prototype,
                                 uint64_t frame_id) {
  MonkyEngineInputFrame frame{};
  frame.struct_size = sizeof(frame);
  frame.abi_version = MONKY_ENGINE_ABI_VERSION;
  frame.frame_id = frame_id;
  frame.timestamp_us = Integer(env, Get(env, object, "timestampUs"),
      0, kMaxSafeInteger, "timestampUs must be a nonnegative safe integer");
  frame.duration_us = Integer(env, Get(env, object, "durationUs"), 1, 1000000,
                               "durationUs must be an integer in 1..1000000");
  frame.ntp_time_ms = Integer(env, Get(env, object, "ntpTimeMs"),
      -1, kMaxSafeInteger, "ntpTimeMs must be -1 or a nonnegative safe integer");
  frame.texture_nt_handle = HandleBytes(env, Get(env, object, "handle"), buffer_prototype);
  return frame;
}

napi_value SubmitFrame(napi_env env, napi_callback_info info) {
  return PromiseMethod(env, [&](napi_deferred deferred) {
    Arguments<2> args(env, info);
    const auto state = Unwrap(env, args.receiver);
    const auto source = Id(env, args.values[0]);
    uint64_t frame_id = 0;
    try {
      Record(env, args.values[1], "A producer frame must be a metadata object");
      frame_id = Id(env, Get(env, args.values[1], "frameId"));
      RequireReady(env, state);
      napi_value buffer_prototype;
      Check(env, napi_get_reference_value(env, state->buffer_prototype, &buffer_prototype));
      const auto frame = InputFrame(env, args.values[1], buffer_prototype, frame_id);
      // Every metadata getter runs at most once. It can close the engine or
      // submit this same key, including before a later getter throws.
      RequireReady(env, state);
      const InputKey key{source, frame.frame_id};
      NativeAccess native(*state);
      RequireNative(env, native);
      const auto admission = state->inputs.Reserve(key, deferred, state->options.max_pending_operations);
      if (admission == InputAdmission::Duplicate) {
        ThrowNative(env, MONKY_ENGINE_BUSY,
                    Error(MONKY_ENGINE_BUSY, "ERR_RTC_DUPLICATE_INPUT",
                          "This sourceId/frameId already owns a pending producer lease"));
      }
      if (admission == InputAdmission::Full) {
        ThrowNative(env, MONKY_ENGINE_QUEUE_FULL,
                    Error(MONKY_ENGINE_QUEUE_FULL, "ERR_RTC_INPUT_LIMIT",
                          "The bounded producer-lease promise map is full"));
      }
      MonkyEngineError error = EmptyError();
      const auto status = monky_rtc_engine_submit_frame(native.get(), source, &frame, &error);
      if (status != MONKY_ENGINE_OK) {
        // C admission is failure-atomic. A duplicate is the sole exception to
        // release proof: it may name an existing native obligation. Keep a
        // bounded ledger entry, but reject this submission visibly now.
        const bool existing_owner =
            std::string_view(error.code, BoundedLength(error.code)) == "ERR_RTC_SOURCE_FRAME_ID";
        state->inputs.Refused(key, existing_owner);
        ThrowNative(env, status, error);
      }
      // Only INPUT_RELEASED or a successfully completed native close settles this.
    } catch (const JsFailure& failure) {
      auto exception = PendingException(env);
      if (!failure.local_error) {
        const auto cause = exception;
        exception = ErrorValue(env, MONKY_ENGINE_INVALID,
            Error(MONKY_ENGINE_INVALID, "ERR_RTC_INPUT_ARGUMENT",
                  "Producer frame metadata access failed; see cause"));
        Define(env, exception, "cause", cause);
      }
      if (frame_id) {
        const InputKey key{source, frame_id};
        // No user code runs between this live-map check and own-property
        // construction. Never infer admission phase from SOURCE_DISABLED/CLOSED.
        InputError(env, exception, key, state->inputs.Contains(key));
      }
      Check(env, napi_throw(env, exception));
      throw JsFailure{};
    } catch (...) {
      const char* code = "ERR_RTC_WRAPPER";
      const char* message = "Unexpected input wrapper failure";
      try { throw; }
      catch (const std::bad_alloc&) {
        code = "ERR_RTC_ALLOCATION";
        message = "Could not allocate input admission metadata";
      } catch (...) {}
      const auto exception = ErrorValue(
          env, MONKY_ENGINE_FAILURE, Error(MONKY_ENGINE_FAILURE, code, message));
      if (frame_id) {
        const InputKey key{source, frame_id};
        InputError(env, exception, key, state->inputs.Contains(key));
      }
      Check(env, napi_throw(env, exception));
      throw JsFailure{exception};
    }
  });
}

const uint8_t* PcmBytes(napi_env env, napi_value value, napi_value buffer_prototype, size_t expected) {
  bool buffer = false, typed = false, genuine = false;
  Check(env, napi_is_buffer(env, value, &buffer));
  Check(env, napi_is_typedarray(env, value, &typed));
  if (!buffer || !typed) Invalid(env, "PCM must be an original non-shared Buffer");
  napi_value prototype;
  Check(env, napi_get_prototype(env, value, &prototype));
  Check(env, napi_strict_equals(env, prototype, buffer_prototype, &genuine));
  if (!genuine) Invalid(env, "PCM must use the original Buffer prototype");
  napi_typedarray_type type;
  size_t elements = 0, offset = 0;
  void* data = nullptr;
  napi_value backing;
  Check(env, napi_get_typedarray_info(env, value, &type, &elements, &data, &backing, &offset));
  bool ordinary = false, detached = false;
  Check(env, napi_is_arraybuffer(env, backing, &ordinary));
  if (!ordinary || type != napi_uint8_array || elements != expected)
    Invalid(env, "PCM must have the exact original Float32LE byte count in an ordinary Buffer");
  Check(env, napi_is_detached_arraybuffer(env, backing, &detached));
  if (detached) Invalid(env, "PCM cannot use a detached ArrayBuffer");
  void* storage = nullptr;
  size_t size = 0;
  Check(env, napi_get_arraybuffer_info(env, backing, &storage, &size));
  if (!storage || offset > size || elements > size - offset ||
      data != static_cast<uint8_t*>(storage) + offset)
    Invalid(env, "PCM Buffer view is out of bounds");
  void* bytes = nullptr;
  Check(env, napi_get_buffer_info(env, value, &bytes, &size));
  if (!bytes || bytes != data || size != expected) Invalid(env, "PCM Buffer storage is inconsistent");
  return static_cast<const uint8_t*>(bytes);
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
    // This existing validator also rejects shared/detached backing stores and
    // forged Buffer prototypes. No user getter runs after this borrowed view.
    frame.data = PcmBytes(env, data, prototype, size);
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
      const auto qpc = Get(env, object, "qpcTimestampUs");
      if (timestamp_error) {
        if (Type(env, device) != napi_null || Type(env, qpc) != napi_null)
          Invalid(env, "Timestamp-invalid packets require null device/QPC anchors");
        packet.device_position = UINT64_MAX;
        packet.qpc_timestamp_us = -1;
      } else {
        packet.device_position = Type(env, device) == napi_null ? UINT64_MAX : Id(env, device, true);
        packet.qpc_timestamp_us = Integer(env, qpc, 0, kMaxSafeInteger, "QPC anchor must be a safe integer");
      }
      packet.pcm_bytes = static_cast<uint32_t>(packet.frames * packet.channels * sizeof(float));
      if (packet.pcm_bytes > 1024 * 1024) Invalid(env, "Original audio packet exceeds 1 MiB");
      const auto pcm = Get(env, object, "pcm");
      napi_value buffer_prototype;
      Check(env, napi_get_reference_value(env, state->buffer_prototype, &buffer_prototype));
      // All caller getters have finished. No JS executes between storage
      // validation and the C function's synchronous copy into aligned storage.
      packet.pcm = PcmBytes(env, pcm, buffer_prototype, packet.pcm_bytes);
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

uint32_t Option(napi_env env, napi_value options, const char* name, uint32_t fallback) {
  if (!Has(env, options, name)) return fallback;
  auto value = Get(env, options, name);
  if (Type(env, value) == napi_undefined) return fallback;
  return static_cast<uint32_t>(Integer(env, value, 1, UINT32_MAX,
                                       "Numeric engine options must be positive uint32 safe integers"));
}

MonkyEngineOptions Options(napi_env env, napi_value object, bool& encoded) {
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
    const auto input = String(env, Get(env, object, "videoInput"), 1, 16, "videoInput must be nv12 or encoded-h264");
    if (input != "nv12" && input != "encoded-h264") Invalid(env, "videoInput must be nv12 or encoded-h264");
    encoded = input == "encoded-h264";
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
    bool encoded = false;
    const auto options = Options(env, args.values[0], encoded);
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
      const auto status = encoded ? monky_rtc_engine_create_encoded(&options, &callbacks, &engine, &error)
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
          {"submitFrame", nullptr, SubmitFrame, nullptr, nullptr, nullptr, napi_default, nullptr},
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
