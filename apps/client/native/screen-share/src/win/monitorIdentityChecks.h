#pragma once

// Device-free checks of the shared monitor identity, run by the capture and thumbnail contract tests.
// Fake displays replace the Win32 calls so every device interface read can be counted.

#include "monitorIdentity.h"

#include <array>
#include <cwchar>

namespace monky::win::checks {

struct FakeMonitor {
  HMONITOR handle = nullptr;
  const wchar_t* name = L"";
  const wchar_t* deviceId = L"";
  RECT bounds{};
  bool connected = true;
};

struct FakeDisplays {
  std::array<FakeMonitor, 2> monitors{};
  unsigned interfaceReads = 0;
};

inline FakeDisplays& Displays() {
  static FakeDisplays displays;
  return displays;
}

inline const FakeMonitor* FindFake(HMONITOR handle) {
  for (const auto& monitor : Displays().monitors)
    if (monitor.connected && monitor.handle == handle) return &monitor;
  return nullptr;
}

inline BOOL WINAPI FakeEnumerate(HDC, LPCRECT, MONITORENUMPROC visit, LPARAM data) {
  for (const auto& monitor : Displays().monitors)
    if (monitor.connected && !visit(monitor.handle, nullptr, nullptr, data)) return FALSE;
  return TRUE;
}

inline BOOL WINAPI FakeInfo(HMONITOR handle, LPMONITORINFO info) {
  const auto* monitor = FindFake(handle);
  if (!monitor || info->cbSize != sizeof(MONITORINFOEXW)) return FALSE;
  auto& extended = *static_cast<MONITORINFOEXW*>(info);
  extended.rcMonitor = monitor->bounds;
  return wcscpy_s(extended.szDevice, monitor->name) == 0;
}

inline BOOL WINAPI FakeDevice(LPCWSTR name, DWORD index, PDISPLAY_DEVICEW device, DWORD flags) {
  ++Displays().interfaceReads;
  if (index != 0 || flags != EDD_GET_DEVICE_INTERFACE_NAME) return FALSE;
  for (const auto& monitor : Displays().monitors)
    if (monitor.connected && std::wcscmp(monitor.name, name) == 0)
      return wcscpy_s(device->DeviceID, monitor.deviceId) == 0;
  return FALSE;
}

template <typename Check>
void RunMonitorIdentityChecks(Check check) {
  const MonitorPlatform fakes{FakeEnumerate, FakeInfo, FakeDevice};
  const auto first = reinterpret_cast<HMONITOR>(std::uintptr_t{0x1000});
  const auto second = reinterpret_cast<HMONITOR>(std::uintptr_t{0x2000});
  const auto reset = [&] {
    Displays() = {};
    Displays().monitors[0] = {first, L"\\\\.\\DISPLAY1", L"\\\\?\\DISPLAY#MAIN#{1}", {0, 0, 2560, 1440}};
    Displays().monitors[1] = {second, L"\\\\.\\DISPLAY2", L"\\\\?\\DISPLAY#SIDE#{2}", {-1920, 0, 0, 1080}};
  };
  const MonitorIdentity selected{L"\\\\?\\DISPLAY#SIDE#{2}", L"\\\\.\\DISPLAY2", -1920, 0, 1920, 1080};

  reset();
  MonitorBinding binding(selected, fakes);
  check(binding.status() == MonitorStatus::kMatches && binding.monitor() == second,
        "The selected interface did not bind its one connected display");
  check(Displays().interfaceReads == 2, "Admission did not read each connected display's interface once");
  // #762: a capture or thumbnail loop verifies many times while it waits for frames.
  for (unsigned tick = 0; tick < 500; ++tick)
    check(binding.Verify() == MonitorStatus::kMatches, "Cached monitor verification rejected the bound display");
  check(Displays().interfaceReads == 2, "Per-loop verification read the device interface");
  check(binding.VerifyUnique() == MonitorStatus::kMatches && Displays().interfaceReads == 4,
        "Explicit re-resolution did not read every interface again");

  Displays().monitors[1].bounds = {-1920, 0, 0, 1200};
  check(binding.Verify() == MonitorStatus::kChanged && binding.VerifyUnique() == MonitorStatus::kChanged,
        "A resolution change was not reported as changed");
  check(Displays().interfaceReads == 4, "A cached mismatch read the device interface");
  reset();
  Displays().monitors[1].name = L"\\\\.\\DISPLAY3";
  check(binding.Verify() == MonitorStatus::kLost, "A renamed GDI device kept the old binding");
  reset();
  Displays().monitors[1].connected = false;
  check(binding.Verify() == MonitorStatus::kLost, "A disconnected display kept the old binding");

  reset();
  Displays().monitors[0].deviceId = L"\\\\?\\DISPLAY#SIDE#{2}";
  Displays().monitors[1].deviceId = L"\\\\?\\DISPLAY#OTHER#{3}";
  check(binding.Verify() == MonitorStatus::kMatches && binding.VerifyUnique() == MonitorStatus::kLost,
        "The selected interface moved to another display without a reselection");
  reset();
  Displays().monitors[0].deviceId = L"\\\\?\\DISPLAY#SIDE#{2}";
  check(binding.VerifyUnique() == MonitorStatus::kUnresolved, "An ambiguous interface kept the old binding");
  check(MonitorBinding(selected, fakes).status() == MonitorStatus::kUnresolved,
        "An ambiguous interface was admitted by ordinal or position");
  reset();
  Displays().monitors[1].deviceId = L"\\\\?\\DISPLAY#OTHER#{3}";
  const MonitorBinding absent(selected, fakes);
  check(absent.status() == MonitorStatus::kUnresolved && absent.Verify() == MonitorStatus::kUnresolved &&
        absent.monitor() == nullptr, "An absent interface fell back to another display");

  check(ValidMonitorIdentity(selected), "A canonical monitor identity was refused");
  const auto rejected = [&](auto mutate) {
    auto invalid = selected;
    mutate(invalid);
    check(!ValidMonitorIdentity(invalid), "A malformed monitor identity was admitted");
  };
  rejected([](MonitorIdentity& value) { value.deviceId = L"screen:0"; });
  rejected([](MonitorIdentity& value) { value.deviceId += L'\u00e9'; });
  rejected([](MonitorIdentity& value) { value.deviceName = L"\\\\.\\DISPLAY0"; });
  rejected([](MonitorIdentity& value) { value.deviceName = L"\\\\.\\DISPLAY01"; });
  rejected([](MonitorIdentity& value) { value.deviceName = L"\\\\.\\DISPLAY4294967296"; });
  rejected([](MonitorIdentity& value) { value.width = 0; });
  rejected([](MonitorIdentity& value) { value.x = INT32_MAX; });
  Displays() = {};
}

}  // namespace monky::win::checks
