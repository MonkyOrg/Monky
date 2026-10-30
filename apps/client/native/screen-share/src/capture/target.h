#pragma once

// The window, game or monitor this host captures: its bound identity, verified on every tick, and the display
// changes that make a monitor identity worth reading again.
// Part of the single host.cpp translation unit, which is the only file that includes it.

#include "win32.h"

#include <Dbt.h>

#include <optional>

namespace {
using namespace monky::screen_capture;
namespace win = monky::win;

// The title is only a label (the HWND, process and class identify the window): read what the window reports now,
// without failing because it is long or changes while it is read. A longer title could never match a stock entry.
std::string WindowTitle(HWND window) {
  std::array<wchar_t, kMaxWindowSetting + 1> text{};
  const auto copied = GetWindowTextW(window, text.data(), static_cast<int>(text.size()));
  return WindowTitleUtf8({text.data(), static_cast<std::size_t>((std::max)(copied, 0))});
}

std::wstring WindowClass(HWND window) {
  std::array<wchar_t, 257> text{};
  const auto length = GetClassNameW(window, text.data(), static_cast<int>(text.size()));
  Require(length > 0 && length < 256, "Cannot observe bounded window class", "ERR_SCREEN_CAPTURE_SOURCE_IDENTITY");
  return {text.data(), static_cast<std::size_t>(length)};
}

std::wstring ExecutableBasename(HANDLE process) {
  std::array<wchar_t, 32768> path{};
  DWORD length = static_cast<DWORD>(path.size());
  CheckWin(QueryFullProcessImageNameW(process, 0, path.data(), &length),
      "ERR_SCREEN_CAPTURE_SOURCE_IDENTITY", "Cannot query selected process image");
  const std::wstring_view image(path.data(), length);
  const auto separator = image.find_last_of(L'\\');
  Require(separator != std::wstring_view::npos, "Process image has no basename", "ERR_SCREEN_CAPTURE_SOURCE_IDENTITY");
  return std::wstring(image.substr(separator + 1));
}

bool SameOrdinal(std::wstring_view a, std::wstring_view b) {
  return CompareStringOrdinal(a.data(), static_cast<int>(a.size()), b.data(), static_cast<int>(b.size()), TRUE) == CSTR_EQUAL;
}

struct Target {
  CaptureKind kind = CaptureKind::Window;
  std::optional<win::MonitorBinding> display;
  HWND window = nullptr;
  std::uint32_t pid = 0;
  std::uint64_t creation = 0;
  Handle process{};
  SourceKey key;
  std::wstring className, executable;

  HMONITOR Monitor() const { return display ? display->monitor() : nullptr; }

  static void RequireMonitor(win::MonitorStatus status) {
    switch (status) {
      case win::MonitorStatus::kMatches: return;
      case win::MonitorStatus::kLost:
        throw ContractError("ERR_SCREEN_CAPTURE_MONITOR_LOST",
            "Selected monitor was disconnected or its device identity changed; reselect explicitly");
      case win::MonitorStatus::kChanged:
        throw ContractError("ERR_SCREEN_CAPTURE_MONITOR_CHANGED",
            "Selected monitor bounds or resolution changed; reselect explicitly");
      case win::MonitorStatus::kUnresolved: break;
    }
    throw ContractError("ERR_SCREEN_CAPTURE_MONITOR_IDENTITY",
        "Monitor interface no longer identifies the one selected physical display");
  }

  void Verify() const {
    if (kind == CaptureKind::Monitor) {
      // Runs every capture tick, so it only reads cached monitor metadata; VerifyUnique reads the device interface
      // on admission, start and reported display changes (win/monitorIdentity.h).
      RequireMonitor(display ? display->Verify() : win::MonitorStatus::kUnresolved);
      return;
    }
    DWORD current = 0;
    Require(IsWindow(window) && GetWindowThreadProcessId(window, &current) != 0 && current == pid &&
        WaitForSingleObject(process.Get(), 0) == WAIT_TIMEOUT && ProcessCreation(process.Get()) == creation,
        "Selected HWND/PID/creation time is no longer live", "ERR_SCREEN_CAPTURE_SOURCE_LOST");
    Require(GetAncestor(window, GA_ROOT) == window,
        "Selected window is no longer top-level", "ERR_SCREEN_CAPTURE_SOURCE_LOST");
    // The title is not identity: a browser renames its window on every page while it is still the same source.
    Require(WindowClass(window) == className && ExecutableBasename(process.Get()) == executable,
        "Selected window class or executable changed; reselection is required", "ERR_SCREEN_CAPTURE_SOURCE_LOST");
  }

  bool Paused() const { return kind != CaptureKind::Monitor && (!IsWindowVisible(window) || IsIconic(window)); }

  void VerifyUnique() const {
    Verify();
    if (kind == CaptureKind::Monitor) RequireMonitor(display ? display->VerifyUnique() : win::MonitorStatus::kUnresolved);
  }
};

Target BindTarget(const Arguments& arguments) {
  Target value;
  value.kind = arguments.kind;
  if (arguments.kind == CaptureKind::Monitor) {
    value.display.emplace(arguments.monitor);
    Require(value.display->status() == win::MonitorStatus::kMatches,
            "Selected monitor interface is absent or ambiguous; no ordinal/primary fallback is allowed",
            "ERR_SCREEN_CAPTURE_MONITOR_IDENTITY");
    value.VerifyUnique();
    return value;
  }
  value.window = reinterpret_cast<HWND>(static_cast<std::uintptr_t>(arguments.hwnd));
  value.pid = arguments.processId;
  value.process = Handle(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, value.pid));
  Require(static_cast<bool>(value.process), "Cannot bind selected process", "ERR_SCREEN_CAPTURE_PROCESS_IDENTITY");
  value.creation = ProcessCreation(value.process.Get());
  Require(arguments.expectedCreation == 0 || arguments.expectedCreation == value.creation,
          "Selected process creation time changed since selection", "ERR_SCREEN_CAPTURE_PROCESS_IDENTITY");
  const auto title = WindowTitle(value.window);
  value.className = WindowClass(value.window);
  value.executable = ExecutableBasename(value.process.Get());
  Require(arguments.kind != CaptureKind::Game || (value.pid != GetCurrentProcessId() && !SameOrdinal(value.className, L"dwm")),
          "Game Capture cannot bind the compositor or capture helper", "ERR_SCREEN_CAPTURE_SOURCE_IDENTITY");
  value.key = {WindowTitleLabel(title), Utf8(value.className), Utf8(value.executable)};
  ValidateKey(value.key);
  value.VerifyUnique();
  return value;
}

// Tells a monitor capture when its full identity must be read again. Windows broadcasts display and device
// changes to top-level windows, so a hidden one on the host STA receives them while PumpMessages runs; a cheap
// snapshot of cached monitor metadata also catches changes whose broadcast was missed.
class DisplayChanges {
 public:
  DisplayChanges() = default;
  DisplayChanges(const DisplayChanges&) = delete;
  DisplayChanges& operator=(const DisplayChanges&) = delete;
  ~DisplayChanges() { if (window_) DestroyWindow(window_); }

  void Start() {
    const auto instance = GetModuleHandleW(nullptr);
    WNDCLASSEXW windowClass{};
    windowClass.cbSize = sizeof(windowClass);
    windowClass.lpfnWndProc = Procedure;
    windowClass.hInstance = instance;
    windowClass.lpszClassName = L"MonkyScreenCaptureDisplayChanges";
    Require(RegisterClassExW(&windowClass) != 0, "Cannot register the display change observer",
        "ERR_SCREEN_CAPTURE_MONITOR_IDENTITY");
    window_ = CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, windowClass.lpszClassName, L"", WS_POPUP,
        0, 0, 0, 0, nullptr, nullptr, instance, nullptr);
    Require(window_ != nullptr, "Cannot create the display change observer", "ERR_SCREEN_CAPTURE_MONITOR_IDENTITY");
    snapshot_ = Snapshot();
  }

  // Consumes any reported or observed change since the previous call.
  bool Changed() {
    auto current = Snapshot();
    const bool changed = pending_.exchange(false) || current != snapshot_;
    snapshot_ = std::move(current);
    return changed;
  }

 private:
  struct Monitor {
    HMONITOR handle = nullptr;
    LONG left = 0, top = 0, right = 0, bottom = 0;
    std::wstring device;
    bool operator==(const Monitor&) const = default;
  };
  struct Collection { std::vector<Monitor> monitors; bool failed = false; };

  static LRESULT CALLBACK Procedure(HWND window, UINT message, WPARAM wParam, LPARAM lParam) noexcept {
    if (message == WM_DISPLAYCHANGE || (message == WM_DEVICECHANGE && wParam == DBT_DEVNODES_CHANGED))
      pending_.store(true);
    return DefWindowProcW(window, message, wParam, lParam);
  }
  static BOOL CALLBACK Collect(HMONITOR handle, HDC, LPRECT, LPARAM parameter) noexcept {
    auto& collection = *reinterpret_cast<Collection*>(parameter);
    MONITORINFOEXW info{}; info.cbSize = sizeof(info);
    if (collection.monitors.size() >= 64 || !GetMonitorInfoW(handle, &info)) { collection.failed = true; return FALSE; }
    try {
      collection.monitors.push_back({handle, info.rcMonitor.left, info.rcMonitor.top, info.rcMonitor.right,
          info.rcMonitor.bottom, info.szDevice});
    } catch (...) { collection.failed = true; return FALSE; }
    return TRUE;
  }
  // GetMonitorInfoW reads cached topology without the device registry, so it is safe on every check.
  static std::vector<Monitor> Snapshot() {
    Collection collection;
    if (!EnumDisplayMonitors(nullptr, nullptr, Collect, reinterpret_cast<LPARAM>(&collection)) || collection.failed)
      collection.monitors.clear();
    return std::move(collection.monitors);
  }

  inline static std::atomic<bool> pending_{false};
  HWND window_ = nullptr;
  std::vector<Monitor> snapshot_;
};

}  // namespace
