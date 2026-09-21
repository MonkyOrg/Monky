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
#include <set>

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

std::string GetProcessCreation(DWORD pid) {
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid);
  if (!process) return {};
  FILETIME creation{}, exit{}, kernel{}, user{};
  const bool observed = WaitForSingleObject(process, 0) == WAIT_TIMEOUT &&
      GetProcessTimes(process, &creation, &exit, &kernel, &user);
  CloseHandle(process);
  if (!observed) return {};
  const auto born = (static_cast<uint64_t>(creation.dwHighDateTime) << 32) | creation.dwLowDateTime;
  return born ? std::to_string(born) : std::string{};
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
    const auto creation = GetProcessCreation(pid);
    DWORD observedPid = 0;
    if (!IsWindow(hwnd) || !GetWindowThreadProcessId(hwnd, &observedPid) || observedPid != pid) continue;

    Napi::Object obj = Napi::Object::New(env);
    obj.Set("hwnd", Napi::Number::New(env, static_cast<double>(reinterpret_cast<uintptr_t>(hwnd))));
    obj.Set("title", Napi::String::New(env, WideToUtf8(title)));
    obj.Set("processId", Napi::Number::New(env, static_cast<double>(pid)));
    obj.Set("processCreationTime100ns", creation.empty() ? env.Null() : Napi::String::New(env, creation));
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

namespace {
struct MonitorRecord {
  std::wstring deviceId, deviceName, name;
  RECT bounds{};
  bool primary = false;
};

struct MonitorEnumeration {
  std::vector<MonitorRecord> records;
  bool failed = false;
};

BOOL CALLBACK EnumMonitor(HMONITOR monitor, HDC, LPRECT, LPARAM parameter) noexcept {
  auto& enumeration = *reinterpret_cast<MonitorEnumeration*>(parameter);
  try {
    if (enumeration.records.size() >= 64) {
      enumeration.failed = true;
      return FALSE;
    }
    MONITORINFOEXW info{};
    info.cbSize = sizeof(info);
    DISPLAY_DEVICEW device{};
    device.cb = sizeof(device);
    if (!GetMonitorInfoW(monitor, &info) ||
        !EnumDisplayDevicesW(info.szDevice, 0, &device, EDD_GET_DEVICE_INTERFACE_NAME) ||
        !device.DeviceID[0]) {
      enumeration.failed = true;
      return FALSE;
    }
    const auto width = info.rcMonitor.right - info.rcMonitor.left;
    const auto height = info.rcMonitor.bottom - info.rcMonitor.top;
    if (width < 1 || width > 32768 || height < 1 || height > 32768) {
      enumeration.failed = true;
      return FALSE;
    }
    enumeration.records.push_back({device.DeviceID, info.szDevice, device.DeviceString,
        info.rcMonitor, (info.dwFlags & MONITORINFOF_PRIMARY) != 0});
    return TRUE;
  } catch (...) {
    enumeration.failed = true;
    return FALSE;
  }
}

Napi::Object MonitorObject(Napi::Env env, const MonitorRecord& monitor) {
  auto bounds = Napi::Object::New(env);
  bounds.Set("x", monitor.bounds.left);
  bounds.Set("y", monitor.bounds.top);
  bounds.Set("width", monitor.bounds.right - monitor.bounds.left);
  bounds.Set("height", monitor.bounds.bottom - monitor.bounds.top);
  auto result = Napi::Object::New(env);
  result.Set("deviceId", WideToUtf8(monitor.deviceId));
  result.Set("deviceName", WideToUtf8(monitor.deviceName));
  result.Set("name", WideToUtf8(monitor.name));
  result.Set("bounds", bounds);
  result.Set("isPrimary", monitor.primary);
  return result;
}

bool ReadMonitors(Napi::Env env, MonitorEnumeration& enumeration) {
  // Win32 metadata only: this does not create a graphics device or acquire pixels.
  const auto previous = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  if (!previous) {
    Napi::Error::New(env, "Cannot obtain physical monitor coordinates").ThrowAsJavaScriptException();
    return false;
  }
  const auto ok = EnumDisplayMonitors(nullptr, nullptr, EnumMonitor, reinterpret_cast<LPARAM>(&enumeration));
  SetThreadDpiAwarenessContext(previous);
  std::set<std::wstring> ids;
  for (const auto& monitor : enumeration.records)
    if (!ids.insert(monitor.deviceId).second) enumeration.failed = true;
  if (!ok || enumeration.failed) {
    Napi::Error::New(env, "Cannot enumerate unambiguous monitor device identities").ThrowAsJavaScriptException();
    return false;
  }
  return true;
}
}  // namespace

Napi::Value platform_list_monitors(const Napi::CallbackInfo& info) {
  MonitorEnumeration enumeration;
  if (!ReadMonitors(info.Env(), enumeration)) return info.Env().Undefined();
  auto result = Napi::Array::New(info.Env(), enumeration.records.size());
  for (uint32_t index = 0; index < enumeration.records.size(); ++index)
    result.Set(index, MonitorObject(info.Env(), enumeration.records[index]));
  return result;
}

Napi::Value platform_get_monitor_state(const Napi::CallbackInfo& info) {
  if (info.Length() != 1 || !info[0].IsString()) {
    Napi::TypeError::New(info.Env(), "A monitor device interface identity is required").ThrowAsJavaScriptException();
    return info.Env().Undefined();
  }
  const auto id = info[0].As<Napi::String>().Utf8Value();
  if (id.empty() || id.size() >= 128 || id.find('\0') != std::string::npos || id.rfind("\\\\?\\DISPLAY#", 0) != 0) {
    Napi::TypeError::New(info.Env(), "Invalid monitor device interface identity").ThrowAsJavaScriptException();
    return info.Env().Undefined();
  }
  MonitorEnumeration enumeration;
  if (!ReadMonitors(info.Env(), enumeration)) return info.Env().Undefined();
  for (const auto& monitor : enumeration.records)
    if (WideToUtf8(monitor.deviceId) == id) return MonitorObject(info.Env(), monitor);
  return info.Env().Null();
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
