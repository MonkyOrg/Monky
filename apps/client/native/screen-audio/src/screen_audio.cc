#include <napi.h>
#if defined(_WIN32) || defined(__MACOS__)
namespace screen_audio { Napi::Value CreatePacketCapture(const Napi::CallbackInfo& info); }
#endif

// Platform-specific forward declarations
#if defined(_WIN32)
bool platform_is_supported();
Napi::Value platform_list_windows(Napi::Env env);
Napi::Value platform_get_window_state(const Napi::CallbackInfo& info);
Napi::Value platform_get_process_ancestry(const Napi::CallbackInfo& info);
Napi::Value platform_get_window_occlusion(const Napi::CallbackInfo& info);
Napi::Value platform_start_window_frame_probe(const Napi::CallbackInfo& info);
Napi::Value platform_get_window_frame_probe(const Napi::CallbackInfo& info);
Napi::Value platform_stop_window_frame_probe(const Napi::CallbackInfo& info);
void platform_register_window_frame_probes(Napi::Env env);
Napi::Value platform_list_monitors(const Napi::CallbackInfo& info);
Napi::Value platform_get_monitor_state(const Napi::CallbackInfo& info);
bool platform_restore_window(int64_t hwnd);
Napi::Value GetKeyboardLayoutSnapshot(const Napi::CallbackInfo& info);
Napi::Value SetWindowResizeAspect(const Napi::CallbackInfo& info);
#elif defined(__MACOS__)
bool platform_is_supported();
Napi::Value platform_list_window_owners(Napi::Env env);
#else
bool platform_is_supported() { return false; }
#endif

Napi::Value IsSupported(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), platform_is_supported());
}

// Lista as janelas visiveis junto do app que as criou. So o macOS implementa:
// nas outras plataformas o Electron ja entrega `appIcon` por conta propria e a
// lista vazia mantem o chamador no caminho padrao (#455).
Napi::Value ListWindowOwners(const Napi::CallbackInfo& info) {
#if defined(__MACOS__)
  return platform_list_window_owners(info.Env());
#else
  return Napi::Array::New(info.Env());
#endif
}

// Enumera as janelas top-level com seus atributos Win32 brutos. Usado no Windows
// para (a) filtrar overlays que o capturador WGC passou a vazar e (b) reexibir
// janelas minimizadas que ele omite, como um jogo em tela cheia (#560). Nas
// outras plataformas devolve uma lista vazia e o chamador segue o caminho padrao.
Napi::Value ListWindows(const Napi::CallbackInfo& info) {
#if defined(_WIN32)
  return platform_list_windows(info.Env());
#else
  return Napi::Array::New(info.Env());
#endif
}

// Restaura (desminimiza) uma janela pelo handle antes de captura-la — a captura
// WGC nao inicia numa janela minimizada (#560). Retorna `true` se desminimizou.
Napi::Value RestoreWindow(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
#if defined(_WIN32)
  if (info.Length() < 1 || !info[0].IsNumber()) return Napi::Boolean::New(env, false);
  int64_t hwnd = info[0].As<Napi::Number>().Int64Value();
  return Napi::Boolean::New(env, platform_restore_window(hwnd));
#else
  return Napi::Boolean::New(env, false);
#endif
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("isSupported", Napi::Function::New(env, IsSupported));
  exports.Set("listWindowOwners", Napi::Function::New(env, ListWindowOwners));
  exports.Set("listWindows", Napi::Function::New(env, ListWindows));
  exports.Set("restoreWindow", Napi::Function::New(env, RestoreWindow));
#if defined(_WIN32)
  exports.Set("getWindowState", Napi::Function::New(env, platform_get_window_state));
  exports.Set("getProcessAncestry", Napi::Function::New(env, platform_get_process_ancestry));
  exports.Set("getWindowOcclusion", Napi::Function::New(env, platform_get_window_occlusion));
  exports.Set("startWindowFrameProbe", Napi::Function::New(env, platform_start_window_frame_probe));
  exports.Set("getWindowFrameProbe", Napi::Function::New(env, platform_get_window_frame_probe));
  exports.Set("stopWindowFrameProbe", Napi::Function::New(env, platform_stop_window_frame_probe));
  platform_register_window_frame_probes(env);
  exports.Set("listMonitors", Napi::Function::New(env, platform_list_monitors));
  exports.Set("getMonitorState", Napi::Function::New(env, platform_get_monitor_state));
  exports.Set("getKeyboardLayout", Napi::Function::New(env, GetKeyboardLayoutSnapshot));
  exports.Set("setWindowResizeAspect", Napi::Function::New(env, SetWindowResizeAspect));
#endif
#if defined(_WIN32) || defined(__MACOS__)
  exports.Set("createPacketCapture", Napi::Function::New(env, screen_audio::CreatePacketCapture));
#endif
  return exports;
}

NODE_API_MODULE(screen_audio, Init)
