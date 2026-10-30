#pragma once

// Monitor identity shared by the Windows capture and thumbnail helpers.
//
// A selected monitor is its device interface, GDI device name and physical bounds. Reading the interface
// (EnumDisplayDevicesW with EDD_GET_DEVICE_INTERFACE_NAME) queries the registry while holding the system display
// lock: repeated while another program wrote to the registry, it froze every screen (#762). A MonitorBinding reads
// it only to admit the monitor and when asked to re-resolve it; Verify() uses the GDI metadata Windows keeps cached.

#include <windows.h>

#include <cstddef>
#include <cstdint>
#include <string>
#include <utility>

namespace monky::win {

struct MonitorIdentity {
  std::wstring deviceId, deviceName;
  std::int32_t x = 0, y = 0;
  std::uint32_t width = 0, height = 0;
};

// The exact identity the Main process selected: an interface path, a \\.\DISPLAYn name and physical bounds.
inline bool ValidMonitorIdentity(const MonitorIdentity& monitor) noexcept {
  constexpr std::size_t kNamePrefix = 11;
  if (!monitor.deviceId.starts_with(L"\\\\?\\DISPLAY#") || monitor.deviceId.size() <= 12 ||
      monitor.deviceId.size() >= 128 || !monitor.deviceName.starts_with(L"\\\\.\\DISPLAY") ||
      monitor.deviceName.size() <= kNamePrefix || monitor.deviceName.size() > kNamePrefix + 10 ||
      monitor.deviceName[kNamePrefix] == L'0' || monitor.width == 0 || monitor.width > 32768 ||
      monitor.height == 0 || monitor.height > 32768 ||
      std::int64_t{monitor.x} + monitor.width > INT32_MAX || std::int64_t{monitor.y} + monitor.height > INT32_MAX)
    return false;
  for (const auto character : monitor.deviceId)
    if (character < 0x20 || character >= 0x7f) return false;
  std::uint64_t ordinal = 0;
  for (std::size_t index = kNamePrefix; index < monitor.deviceName.size(); ++index) {
    const auto character = monitor.deviceName[index];
    if (character < L'0' || character > L'9') return false;
    ordinal = ordinal * 10 + static_cast<unsigned>(character - L'0');
  }
  return ordinal <= UINT32_MAX;
}

enum class MonitorStatus {
  kMatches,
  // Disconnected, or its GDI name or device interface now belongs to another display.
  kLost,
  // The same display with other bounds or resolution.
  kChanged,
  // The interface names no single connected display: absent, ambiguous, or the monitors could not be read.
  kUnresolved,
};

// The Win32 calls a binding makes. Device-free contract tests substitute fakes that count interface reads.
struct MonitorPlatform {
  BOOL (WINAPI* enumerate)(HDC, LPCRECT, MONITORENUMPROC, LPARAM);
  BOOL (WINAPI* info)(HMONITOR, LPMONITORINFO);
  BOOL (WINAPI* device)(LPCWSTR, DWORD, PDISPLAY_DEVICEW, DWORD);
};

inline MonitorPlatform Win32Monitors() noexcept { return {EnumDisplayMonitors, GetMonitorInfoW, EnumDisplayDevicesW}; }

class MonitorBinding {
 public:
  // Reads every connected monitor's interface once: the selection must name exactly one display, with no ordinal
  // or primary fallback. Check status() before using the binding.
  explicit MonitorBinding(MonitorIdentity identity, MonitorPlatform platform = Win32Monitors())
      : identity_(std::move(identity)), platform_(platform) {
    const auto found = Search(nullptr);
    if (!found.failed && found.matches == 1) {
      monitor_ = found.matched;
      status_ = MonitorStatus::kMatches;
    }
  }

  MonitorStatus status() const noexcept { return status_; }
  HMONITOR monitor() const noexcept { return monitor_; }
  const MonitorIdentity& identity() const noexcept { return identity_; }

  // Compares only the cached GDI name and bounds, never the interface: safe on every capture loop.
  MonitorStatus Verify() const noexcept {
    if (status_ != MonitorStatus::kMatches) return status_;
    MONITORINFOEXW info{};
    info.cbSize = sizeof(info);
    if (!platform_.info(monitor_, &info) || identity_.deviceName != info.szDevice) return MonitorStatus::kLost;
    if (info.rcMonitor.left != identity_.x || info.rcMonitor.top != identity_.y ||
        info.rcMonitor.right - info.rcMonitor.left != static_cast<LONG>(identity_.width) ||
        info.rcMonitor.bottom - info.rcMonitor.top != static_cast<LONG>(identity_.height))
      return MonitorStatus::kChanged;
    return MonitorStatus::kMatches;
  }

  // Reads every interface again, for admission, start and reported display changes only: the bound display must
  // still carry the selected interface, and be the only one that does.
  MonitorStatus VerifyUnique() const noexcept {
    if (const auto cached = Verify(); cached != MonitorStatus::kMatches) return cached;
    const auto found = Search(monitor_);
    if (found.failed) return MonitorStatus::kUnresolved;
    if (!found.boundCarriesInterface) return MonitorStatus::kLost;
    if (found.matches != 1) return MonitorStatus::kUnresolved;
    return Verify();
  }

 private:
  struct Found {
    const MonitorBinding* owner = nullptr;
    HMONITOR bound = nullptr, matched = nullptr;
    std::size_t visited = 0, matches = 0;
    bool failed = false, boundCarriesInterface = false;
  };

  static BOOL CALLBACK Visit(HMONITOR handle, HDC, LPRECT, LPARAM parameter) noexcept {
    auto& found = *reinterpret_cast<Found*>(parameter);
    const auto& owner = *found.owner;
    if (++found.visited > 64) { found.failed = true; return FALSE; }
    MONITORINFOEXW info{};
    info.cbSize = sizeof(info);
    DISPLAY_DEVICEW device{};
    device.cb = sizeof(device);
    if (!owner.platform_.info(handle, &info) ||
        !owner.platform_.device(info.szDevice, 0, &device, EDD_GET_DEVICE_INTERFACE_NAME)) {
      found.failed = true;
      return FALSE;
    }
    if (owner.identity_.deviceId == device.DeviceID) {
      ++found.matches;
      found.matched = handle;
      if (handle == found.bound) found.boundCarriesInterface = true;
    }
    return TRUE;
  }

  Found Search(HMONITOR bound) const noexcept {
    Found found{this, bound};
    if (!platform_.enumerate(nullptr, nullptr, Visit, reinterpret_cast<LPARAM>(&found))) found.failed = true;
    return found;
  }

  MonitorIdentity identity_;
  MonitorPlatform platform_;
  HMONITOR monitor_ = nullptr;
  MonitorStatus status_ = MonitorStatus::kUnresolved;
};

}  // namespace monky::win
