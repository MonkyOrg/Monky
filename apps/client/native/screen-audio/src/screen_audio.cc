#include <napi.h>

// Platform-specific forward declarations
#if defined(_WIN32)
bool platform_is_supported();
bool platform_start(uint32_t targetPid, uint32_t loopbackMode, int64_t includeWindowId,
                    uint32_t sampleRate, uint32_t channels, Napi::ThreadSafeFunction tsfn);
uint32_t platform_pid_for_hwnd(int64_t hwnd);
void platform_stop();
const char* platform_get_last_error();
int platform_get_status();
Napi::Value platform_list_windows(Napi::Env env);
bool platform_restore_window(int64_t hwnd);
Napi::Value GetKeyboardLayoutSnapshot(const Napi::CallbackInfo& info);
#elif defined(__MACOS__)
bool platform_is_supported();
bool platform_start(uint32_t targetPid, uint32_t loopbackMode, int64_t includeWindowId,
                    uint32_t sampleRate, uint32_t channels, Napi::ThreadSafeFunction tsfn);
void platform_stop();
const char* platform_get_last_error();
int platform_get_status();
Napi::Value platform_list_window_owners(Napi::Env env);
#else
bool platform_is_supported() { return false; }
bool platform_start(uint32_t, uint32_t, int64_t, uint32_t, uint32_t, Napi::ThreadSafeFunction) { return false; }
void platform_stop() {}
const char* platform_get_last_error() { return ""; }
int platform_get_status() { return 0; }
#endif

static Napi::ThreadSafeFunction g_tsfn;
static bool g_running = false;

Napi::Value IsSupported(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), platform_is_supported());
}

Napi::Value Start(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object result = Napi::Object::New(env);

  if (g_running) {
    result.Set("success", Napi::Boolean::New(env, false));
    result.Set("error", Napi::String::New(env, "Already capturing"));
    return result;
  }

  if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsFunction()) {
    result.Set("success", Napi::Boolean::New(env, false));
    result.Set("error", Napi::String::New(env, "Expected (options, callback)"));
    return result;
  }

  Napi::Object opts = info[0].As<Napi::Object>();
  Napi::Function callback = info[1].As<Napi::Function>();

  uint32_t excludePid = 0;
  uint32_t sampleRate = 48000;
  uint32_t channels = 2;

  if (opts.Has("excludePid") && opts.Get("excludePid").IsNumber()) {
    excludePid = opts.Get("excludePid").As<Napi::Number>().Uint32Value();
  }
  if (opts.Has("sampleRate") && opts.Get("sampleRate").IsNumber()) {
    sampleRate = opts.Get("sampleRate").As<Napi::Number>().Uint32Value();
  }
  if (opts.Has("channels") && opts.Get("channels").IsNumber()) {
    channels = opts.Get("channels").As<Napi::Number>().Uint32Value();
  }

  // By default capture the whole system minus our own process tree (EXCLUDE).
  // When a specific window is provided, narrow the capture down to that window's
  // application so unrelated app audio is not shared (#298).
  uint32_t targetPid = excludePid;
  uint32_t loopbackMode = 0; // 0 = exclude tree, 1 = include tree
  int64_t includeWindowId = 0;

  if (opts.Has("includeWindowId") && opts.Get("includeWindowId").IsNumber()) {
    includeWindowId = opts.Get("includeWindowId").As<Napi::Number>().Int64Value();
  }

#if defined(_WIN32)
  // Windows resolves the window handle to a PID up front and uses WASAPI's
  // process-tree loopback.
  if (includeWindowId != 0) {
    uint32_t appPid = platform_pid_for_hwnd(includeWindowId);
    if (appPid != 0) {
      targetPid = appPid;
      loopbackMode = 1;
    }
  }
  includeWindowId = 0;
#endif

  g_tsfn = Napi::ThreadSafeFunction::New(
    env,
    callback,
    "ScreenAudioCallback",
    0,   // unlimited queue
    1    // one thread
  );

  bool ok = platform_start(targetPid, loopbackMode, includeWindowId, sampleRate, channels, g_tsfn);
  if (ok) {
    g_running = true;
    result.Set("success", Napi::Boolean::New(env, true));
  } else {
    g_tsfn.Release();
    result.Set("success", Napi::Boolean::New(env, false));
    // Return the detailed error from the platform layer
    const char* err = platform_get_last_error();
    result.Set("error", Napi::String::New(env, (err && err[0]) ? err : "Platform start failed"));
  }
  return result;
}

Napi::Value Stop(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object result = Napi::Object::New(env);

  if (g_running) {
    g_running = false;
    platform_stop();
    g_tsfn.Release();
    result.Set("success", Napi::Boolean::New(env, true));
  } else {
    result.Set("success", Napi::Boolean::New(env, false));
  }
  return result;
}

Napi::Value GetLastError(const Napi::CallbackInfo& info) {
  const char* err = platform_get_last_error();
  return Napi::String::New(info.Env(), err ? err : "");
}

Napi::Value GetStatus(const Napi::CallbackInfo& info) {
  return Napi::Number::New(info.Env(), platform_get_status());
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
  exports.Set("start", Napi::Function::New(env, Start));
  exports.Set("stop", Napi::Function::New(env, Stop));
  exports.Set("getLastError", Napi::Function::New(env, GetLastError));
  exports.Set("getStatus", Napi::Function::New(env, GetStatus));
  exports.Set("listWindowOwners", Napi::Function::New(env, ListWindowOwners));
  exports.Set("listWindows", Napi::Function::New(env, ListWindows));
  exports.Set("restoreWindow", Napi::Function::New(env, RestoreWindow));
#if defined(_WIN32)
  exports.Set("getKeyboardLayout", Napi::Function::New(env, GetKeyboardLayoutSnapshot));
#endif
  return exports;
}

NODE_API_MODULE(screen_audio, Init)
