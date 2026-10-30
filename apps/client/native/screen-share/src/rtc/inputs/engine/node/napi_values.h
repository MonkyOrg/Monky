#pragma once

// JS values, errors, JSON and promises for the RTC addon, and the validation of an original Buffer.
// Part of the single napi_engine.cc translation unit, which is the only file that includes it.

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

namespace {

constexpr uint64_t kMaxSafeInteger = 9007199254740991ULL;
constexpr size_t kEventQueueSize = 128;
constexpr uint32_t kMaxJsonBytes = 1024 * 1024;
constexpr uint32_t kMaxCloseWaitMs = 60000;
constexpr uint32_t kSharedFrameFlags =
#if defined(_WIN32)
    MONKY_ENGINE_SHARED_GPU_COPY | MONKY_ENGINE_SHARED_COPY_COMPLETE |
    MONKY_ENGINE_SHARED_KEYED_MUTEX_ZERO | MONKY_ENGINE_SHARED_RECLAIM_FENCE;
static_assert(kSharedFrameFlags == 15u);
#else
    MONKY_ENGINE_SHARED_IOSURFACE;
#endif
constexpr napi_type_tag kEngineTag = {
    0x6d6f6e6b79525443ULL, 0x4e41504938000202ULL};

struct JsFailure {
  // Only errors constructed here are safe to enrich without inspecting a
  // user-thrown object (which may be frozen, a proxy or contain getters).
  napi_value local_error = nullptr;
};

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

// The bytes of an original Buffer: the genuine Buffer prototype over a Uint8Array view of exactly `expected` bytes,
// in bounds of a non-shared, attached ArrayBuffer. `what` names the argument in each error.
const uint8_t* GenuineBufferBytes(napi_env env, napi_value value, napi_value buffer_prototype, size_t expected,
                                  const char* what) {
  const auto invalid = [&](const char* problem) { Invalid(env, (std::string(what) + problem).c_str()); };
  bool buffer = false, typed = false, genuine = false;
  Check(env, napi_is_buffer(env, value, &buffer));
  Check(env, napi_is_typedarray(env, value, &typed));
  if (!buffer || !typed) invalid(" must be an original non-shared Buffer");
  napi_value prototype;
  Check(env, napi_get_prototype(env, value, &prototype));
  Check(env, napi_strict_equals(env, prototype, buffer_prototype, &genuine));
  if (!genuine) invalid(" must use the original Buffer prototype");
  napi_typedarray_type type;
  size_t elements = 0, offset = 0;
  void* data = nullptr;
  napi_value backing;
  Check(env, napi_get_typedarray_info(env, value, &type, &elements, &data, &backing, &offset));
  bool ordinary = false, detached = false;
  Check(env, napi_is_arraybuffer(env, backing, &ordinary));
  if (!ordinary || type != napi_uint8_array || elements != expected)
    invalid(" must have its exact byte count in a Buffer over a non-shared ArrayBuffer");
  Check(env, napi_is_detached_arraybuffer(env, backing, &detached));
  if (detached) invalid(" cannot use a detached ArrayBuffer");
  void* storage = nullptr;
  size_t size = 0;
  Check(env, napi_get_arraybuffer_info(env, backing, &storage, &size));
  if (!storage || offset > size || elements > size - offset ||
      data != static_cast<uint8_t*>(storage) + offset)
    invalid(" Buffer view is out of bounds");
  void* bytes = nullptr;
  Check(env, napi_get_buffer_info(env, value, &bytes, &size));
  if (!bytes || bytes != data || size != expected) invalid(" Buffer storage is inconsistent");
  return static_cast<const uint8_t*>(bytes);
}

uint64_t HandleBytes(napi_env env, napi_value handle, napi_value buffer_prototype) {
  uint64_t value = 0;
  std::memcpy(&value, GenuineBufferBytes(env, handle, buffer_prototype, sizeof(value), "handle"), sizeof(value));
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

}  // namespace
