// Enumeracao nativa de janelas top-level no Windows.
//
// O Electron 34 (Chromium 132) passou a usar o capturador WGC, cuja enumeracao
// de `desktopCapturer.getSources` (a) vaza janelas de overlay/ferramenta que nao
// sao janelas "de verdade" e (b) omite janelas minimizadas — inclusive um jogo em
// tela cheia que minimiza quando o usuario da alt-tab para abrir o seletor.
//
// `getSources` so expoe id/nome/thumbnail, sem nenhum atributo de janela, entao a
// unica forma de distinguir overlay de janela real e inspecionar os estilos Win32
// diretamente. Esta funcao devolve os atributos brutos (ja decompostos em
// booleanos) e deixa a politica de filtragem para a camada TypeScript.
#include <napi.h>
#include <windows.h>
#include <dwmapi.h>
#include <vector>
#include <string>
#include <cmath>

namespace {

std::string WideToUtf8(const std::wstring& w) {
  if (w.empty()) return std::string();
  int len = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), static_cast<int>(w.size()),
                                nullptr, 0, nullptr, nullptr);
  if (len <= 0) return std::string();
  std::string out(static_cast<size_t>(len), '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.c_str(), static_cast<int>(w.size()), &out[0], len,
                      nullptr, nullptr);
  return out;
}

std::wstring GetWindowTitle(HWND hwnd) {
  int len = GetWindowTextLengthW(hwnd);
  if (len <= 0) return std::wstring();
  std::wstring buf(static_cast<size_t>(len) + 1, L'\0');
  int got = GetWindowTextW(hwnd, &buf[0], len + 1);
  buf.resize(static_cast<size_t>(got < 0 ? 0 : got));
  return buf;
}

std::wstring GetProcessImagePath(DWORD pid) {
  std::wstring result;
  if (pid == 0) return result;
  HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!h) return result;
  wchar_t buf[MAX_PATH];
  DWORD size = MAX_PATH;
  if (QueryFullProcessImageNameW(h, 0, buf, &size)) {
    result.assign(buf, size);
  }
  CloseHandle(h);
  return result;
}

BOOL CALLBACK EnumProc(HWND hwnd, LPARAM lParam) {
  auto* handles = reinterpret_cast<std::vector<HWND>*>(lParam);
  handles->push_back(hwnd);
  return TRUE;
}

}  // namespace

Napi::Value platform_get_window_state(const Napi::CallbackInfo& info) {
  const auto env = info.Env();
  if (info.Length() != 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "A positive safe-integer HWND is required").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const auto value = info[0].As<Napi::Number>().DoubleValue();
  if (!std::isfinite(value) || value < 1 || value > 9007199254740991.0 || std::floor(value) != value) {
    Napi::TypeError::New(env, "A positive safe-integer HWND is required").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const auto hwnd = reinterpret_cast<HWND>(static_cast<uintptr_t>(value));
  DWORD pid = 0;
  if (!IsWindow(hwnd) || !GetWindowThreadProcessId(hwnd, &pid)) return env.Null();
  const auto process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid);
  if (!process) {
    const auto error = GetLastError();
    if (!IsWindow(hwnd) || error == ERROR_INVALID_PARAMETER) return env.Null();
    Napi::Error::New(env, "Cannot inspect selected window process: " + std::to_string(error)).ThrowAsJavaScriptException();
    return env.Undefined();
  }
  FILETIME creation{}, exit{}, kernel{}, user{};
  const auto alive = WaitForSingleObject(process, 0) == WAIT_TIMEOUT;
  const auto observed = GetProcessTimes(process, &creation, &exit, &kernel, &user);
  const auto error = observed ? ERROR_SUCCESS : GetLastError();
  CloseHandle(process);
  DWORD current = 0;
  if (!alive || !IsWindow(hwnd) || !GetWindowThreadProcessId(hwnd, &current) || current != pid) return env.Null();
  if (!observed) {
    Napi::Error::New(env, "Cannot inspect selected process creation time: " + std::to_string(error)).ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const auto born = (static_cast<uint64_t>(creation.dwHighDateTime) << 32) | creation.dwLowDateTime;
  auto result = Napi::Object::New(env);
  result.Set("processId", pid);
  result.Set("processCreationTime100ns", std::to_string(born));
  result.Set("isVisible", IsWindowVisible(hwnd) != 0);
  result.Set("isIconic", IsIconic(hwnd) != 0);
  result.Set("isTopLevel", GetAncestor(hwnd, GA_ROOT) == hwnd);
  return result;
}

Napi::Value platform_list_windows(Napi::Env env) {
  std::vector<HWND> handles;
  EnumWindows(EnumProc, reinterpret_cast<LPARAM>(&handles));

  Napi::Array arr = Napi::Array::New(env);
  uint32_t idx = 0;

  for (HWND hwnd : handles) {
    // Pre-filtro barato: janelas escondidas (WS_VISIBLE ausente) e sem titulo nao
    // sao candidatas a compartilhamento. Janelas minimizadas continuam "visiveis"
    // aos olhos do Win32, entao passam por aqui de proposito.
    if (!IsWindowVisible(hwnd)) continue;
    std::wstring title = GetWindowTitle(hwnd);
    if (title.empty()) continue;

    LONG_PTR exStyle = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);

    bool cloaked = false;
    DWORD cloakVal = 0;
    if (SUCCEEDED(DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &cloakVal, sizeof(cloakVal)))) {
      cloaked = (cloakVal != 0);
    }

    bool iconic = IsIconic(hwnd) != 0;

    // Janelas minimizadas reportam um retangulo de tela invalido; a dimensao util
    // e a posicao "restaurada" guardada pelo sistema.
    LONG width = 0;
    LONG height = 0;
    if (iconic) {
      WINDOWPLACEMENT wp;
      wp.length = sizeof(wp);
      if (GetWindowPlacement(hwnd, &wp)) {
        width = wp.rcNormalPosition.right - wp.rcNormalPosition.left;
        height = wp.rcNormalPosition.bottom - wp.rcNormalPosition.top;
      }
    } else {
      RECT r;
      if (GetWindowRect(hwnd, &r)) {
        width = r.right - r.left;
        height = r.bottom - r.top;
      }
    }

    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    std::wstring procPath = GetProcessImagePath(pid);

    Napi::Object obj = Napi::Object::New(env);
    obj.Set("hwnd", Napi::Number::New(env, static_cast<double>(reinterpret_cast<uintptr_t>(hwnd))));
    obj.Set("title", Napi::String::New(env, WideToUtf8(title)));
    obj.Set("processId", Napi::Number::New(env, static_cast<double>(pid)));
    obj.Set("processPath", Napi::String::New(env, WideToUtf8(procPath)));
    obj.Set("isIconic", Napi::Boolean::New(env, iconic));
    obj.Set("isVisible", Napi::Boolean::New(env, true));
    obj.Set("isCloaked", Napi::Boolean::New(env, cloaked));
    obj.Set("isToolWindow", Napi::Boolean::New(env, (exStyle & WS_EX_TOOLWINDOW) != 0));
    obj.Set("isLayered", Napi::Boolean::New(env, (exStyle & WS_EX_LAYERED) != 0));
    obj.Set("isTransparent", Napi::Boolean::New(env, (exStyle & WS_EX_TRANSPARENT) != 0));
    obj.Set("isNoActivate", Napi::Boolean::New(env, (exStyle & WS_EX_NOACTIVATE) != 0));
    obj.Set("isAppWindow", Napi::Boolean::New(env, (exStyle & WS_EX_APPWINDOW) != 0));
    obj.Set("width", Napi::Number::New(env, static_cast<double>(width)));
    obj.Set("height", Napi::Number::New(env, static_cast<double>(height)));

    arr.Set(idx++, obj);
  }

  return arr;
}

// Restaura (desminimiza) e traz uma janela para o primeiro plano pelo handle, para
// que uma captura consiga iniciar nela. Retorna `true` apenas quando de fato
// desminimizou algo — janelas ja visiveis nao sao tocadas (a captura WGC funciona
// nelas mesmo em segundo plano) e o chamador usa o retorno para saber se precisa
// aguardar o primeiro frame ser renderizado (#560).
bool platform_restore_window(int64_t hwndValue) {
  HWND hwnd = reinterpret_cast<HWND>(static_cast<uintptr_t>(hwndValue));
  if (!IsWindow(hwnd)) return false;
  if (!IsIconic(hwnd)) return false;
  ShowWindow(hwnd, SW_RESTORE);
  SetForegroundWindow(hwnd);
  return true;
}
