#include <node_api.h>
#include <windows.h>

#include <cstdint>
#include <cstring>
#include <new>

// Kernel HANDLE ownership only. This addon deliberately has no RTC, codec,
// D3D, COM, driver or worker-thread dependencies in Electron Main.
namespace {
constexpr napi_type_tag kProcess{0x6d6f6e6b7950726fULL, 0x65737348616e646cULL};
constexpr napi_type_tag kLease{0x6d6f6e6b794c6561ULL, 0x6548616e646c6531ULL};
struct Owner { HANDLE handle = nullptr; };

napi_value Fail(napi_env env, const char* message) {
  napi_throw_error(env, "ERR_RTC_HANDLE", message);
  return nullptr;
}
void Finalize(napi_env, void* data, void*) {
  auto* owner = static_cast<Owner*>(data);
  if (owner->handle) CloseHandle(owner->handle);
  delete owner;
}
Owner* Unwrap(napi_env env, napi_value value, const napi_type_tag& tag) {
  bool match = false;
  void* owner = nullptr;
  if (napi_check_object_type_tag(env, value, &tag, &match) != napi_ok || !match ||
      napi_unwrap(env, value, &owner) != napi_ok || !owner) {
    Fail(env, "An owned process or texture handle is required.");
    return nullptr;
  }
  return static_cast<Owner*>(owner);
}
napi_value Close(napi_env env, napi_callback_info info) {
  napi_value self, result;
  size_t count = 0;
  if (napi_get_cb_info(env, info, &count, nullptr, &self, nullptr) != napi_ok) return nullptr;
  bool process = false, lease = false;
  napi_check_object_type_tag(env, self, &kProcess, &process);
  napi_check_object_type_tag(env, self, &kLease, &lease);
  if (!process && !lease) return Fail(env, "Invalid owned HANDLE receiver.");
  auto* owner = Unwrap(env, self, process ? kProcess : kLease);
  if (!owner) return nullptr;
  if (owner->handle) {
    if (!CloseHandle(owner->handle)) return Fail(env, "Owned HANDLE closure failed.");
    owner->handle = nullptr;
  }
  napi_get_undefined(env, &result);
  return result;
}
napi_value Wrap(napi_env env, HANDLE handle, const napi_type_tag& tag) {
  auto* owner = new (std::nothrow) Owner{handle};
  if (!owner) { CloseHandle(handle); return Fail(env, "HANDLE owner allocation failed."); }
  napi_value object;
  if (napi_create_object(env, &object) != napi_ok ||
      napi_type_tag_object(env, object, &tag) != napi_ok ||
      napi_wrap(env, object, owner, Finalize, nullptr, nullptr) != napi_ok) {
    Finalize(env, owner, nullptr);
    return Fail(env, "HANDLE owner creation failed.");
  }
  const napi_property_descriptor close{
      "close", nullptr, Close, nullptr, nullptr, nullptr, napi_default, nullptr};
  if (napi_define_properties(env, object, 1, &close) != napi_ok) return nullptr;
  return object;
}
napi_value Duplicate(napi_env env, napi_callback_info info) {
  napi_value self, argument;
  size_t count = 1, bytes = 0;
  void* data = nullptr;
  bool buffer = false;
  if (napi_get_cb_info(env, info, &count, &argument, &self, nullptr) != napi_ok || count != 1)
    return Fail(env, "An eight-byte source HANDLE is required.");
  auto* process = Unwrap(env, self, kProcess);
  if (!process || !process->handle) return Fail(env, "The source process owner is closed.");
  if (napi_is_buffer(env, argument, &buffer) != napi_ok || !buffer ||
      napi_get_buffer_info(env, argument, &data, &bytes) != napi_ok || bytes != sizeof(HANDLE))
    return Fail(env, "An eight-byte source HANDLE is required.");
  HANDLE source = nullptr, copied = nullptr;
  std::memcpy(&source, data, sizeof(source));
  if (!source || source == INVALID_HANDLE_VALUE ||
      !DuplicateHandle(process->handle, source, GetCurrentProcess(), &copied,
                       0, FALSE, DUPLICATE_SAME_ACCESS))
    return Fail(env, "Cross-process NT HANDLE duplication failed.");
  napi_value object = Wrap(env, copied, kLease);
  if (!object) return nullptr;
  napi_value value;
  if (napi_create_buffer_copy(env, sizeof(copied), &copied, nullptr, &value) != napi_ok) return nullptr;
  const napi_property_descriptor property{
      "handle", nullptr, nullptr, nullptr, nullptr, value, napi_enumerable, nullptr};
  if (napi_define_properties(env, object, 1, &property) != napi_ok) return nullptr;
  return object;
}
napi_value OpenProcessOwner(napi_env env, napi_callback_info info) {
  napi_value argument;
  size_t count = 1;
  double pid = 0;
  if (napi_get_cb_info(env, info, &count, &argument, nullptr, nullptr) != napi_ok || count != 1 ||
      napi_get_value_double(env, argument, &pid) != napi_ok || pid != pid || pid < 1 || pid > UINT32_MAX ||
      pid != static_cast<DWORD>(pid)) return Fail(env, "A valid owned child or parent PID is required.");
  HANDLE process = OpenProcess(PROCESS_DUP_HANDLE, FALSE, static_cast<DWORD>(pid));
  if (!process) return Fail(env, "The owned process could not be opened for HANDLE duplication.");
  napi_value object = Wrap(env, process, kProcess);
  if (!object) return nullptr;
  const napi_property_descriptor duplicate{
      "duplicate", nullptr, Duplicate, nullptr, nullptr, nullptr, napi_default, nullptr};
  if (napi_define_properties(env, object, 1, &duplicate) != napi_ok) return nullptr;
  return object;
}
napi_value Init(napi_env env, napi_value exports) {
  const napi_property_descriptor method{
      "openProcess", nullptr, OpenProcessOwner, nullptr, nullptr, nullptr, napi_default, nullptr};
  if (napi_define_properties(env, exports, 1, &method) != napi_ok) return nullptr;
  return exports;
}
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
