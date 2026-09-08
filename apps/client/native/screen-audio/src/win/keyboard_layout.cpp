#include <napi.h>
#include <windows.h>
#include <string>

// This only queries the focused thread's layout. It installs no hook and never
// changes a layout, injects input, or reserves a key.
Napi::Value GetKeyboardLayoutSnapshot(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  DWORD thread = GetWindowThreadProcessId(GetForegroundWindow(), nullptr);
  HKL layout = GetKeyboardLayout(thread);
  if (!layout) return env.Null();
  std::string id = std::to_string(reinterpret_cast<uintptr_t>(layout));
  if (info.Length() > 0 && info[0].IsString() &&
      info[0].As<Napi::String>().Utf8Value() == id) return env.Null();

  Napi::Object scanCodes = Napi::Object::New(env);
  for (UINT scan = 1; scan < 128; ++scan) {
    for (UINT prefix : { 0u, 0xE000u }) {
      UINT physical = prefix | scan;
      UINT vk = MapVirtualKeyExW(physical, MAPVK_VSC_TO_VK_EX, layout);
      if (vk) scanCodes.Set(std::to_string(physical), Napi::Number::New(env, vk));
    }
  }

  Napi::Object characters = Napi::Object::New(env);
  if (info.Length() > 1 && info[1].IsString()) {
    std::u16string requested = info[1].As<Napi::String>().Utf16Value();
    for (char16_t character : requested) {
      SHORT vk = VkKeyScanExW(static_cast<WCHAR>(character), layout);
      if (vk != -1) {
        characters.Set(Napi::String::New(env, &character, 1),
                       Napi::Number::New(env, static_cast<unsigned short>(vk)));
      }
    }
  }
  Napi::Object result = Napi::Object::New(env);
  result.Set("id", Napi::String::New(env, id));
  result.Set("scanCodeToVirtualKey", scanCodes);
  result.Set("characterToVirtualKey", characters);
  return result;
}
