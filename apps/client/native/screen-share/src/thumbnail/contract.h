#pragma once
#include <algorithm>
#include <cstdint>
#include <limits>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>
#include "../win/monitorIdentity.h"

namespace monky::thumbnail {
namespace win = ::monky::win;
inline constexpr std::size_t kMaximumPngBytes = 1024 * 1024;
inline constexpr std::uint64_t kMaximumPixelBytes = 256 * 1024 * 1024;
inline constexpr std::uint64_t kDeadlineMs = 3000;
inline constexpr std::uint32_t kHardLifetimeMs = 4500;

struct Failure : std::runtime_error {
  explicit Failure(const char* code) : std::runtime_error(code) {}
};
inline void Require(bool valid, const char* code = "ERR_DESKTOP_PREVIEW_ARGUMENT") {
  if (!valid) throw Failure(code);
}
template <typename Session>
void StartBorderlessPreview(Session& session, bool supported, bool allowed) {
  Require(supported, "ERR_DESKTOP_PREVIEW_BORDER_UNSUPPORTED");
  Require(allowed, "ERR_DESKTOP_PREVIEW_BORDER_PERMISSION");
  session.IsBorderRequired(false);
  Require(!session.IsBorderRequired(), "ERR_DESKTOP_PREVIEW_BORDER_REQUIRED");
  session.StartCapture();
}
inline std::uint64_t Unsigned(std::wstring_view text, std::uint64_t maximum) {
  Require(!text.empty() && (text.size() == 1 || text.front() != L'0'));
  std::uint64_t result = 0;
  for (const auto value : text) {
    Require(value >= L'0' && value <= L'9');
    const auto digit = static_cast<unsigned>(value - L'0');
    Require(result <= maximum / 10 && (result < maximum / 10 || digit <= maximum % 10));
    result = result * 10 + digit;
  }
  return result;
}
inline std::int32_t Coordinate(std::wstring_view text) {
  const bool negative = text.starts_with(L"-");
  if (negative) text.remove_prefix(1);
  const auto value = Unsigned(text, negative ? 2147483648ULL : 2147483647ULL);
  Require(!negative || value != 0);
  return static_cast<std::int32_t>(negative ? -static_cast<std::int64_t>(value) : value);
}
struct Arguments {
  bool window = false;
  std::uint64_t hwnd = 0, creation = 0;
  std::uint32_t pid = 0, maxWidth = 0, maxHeight = 0;
  win::MonitorIdentity monitor;
};
inline Arguments Parse(const std::vector<std::wstring_view>& values) {
  Require(!values.empty());
  Arguments result;
  if (values[0] == L"--window") {
    Require(values.size() == 6);
    result.window = true;
    result.hwnd = Unsigned(values[1], 9007199254740991ULL);
    result.pid = static_cast<std::uint32_t>(Unsigned(values[2], UINT32_MAX));
    result.creation = Unsigned(values[3], UINT64_MAX);
    Require(result.hwnd && result.pid && result.creation);
    result.maxWidth = static_cast<std::uint32_t>(Unsigned(values[4], 640));
    result.maxHeight = static_cast<std::uint32_t>(Unsigned(values[5], 360));
  } else {
    Require(values[0] == L"--monitor" && values.size() == 9);
    auto& monitor = result.monitor;
    monitor.deviceId = values[1]; monitor.deviceName = values[2];
    monitor.x = Coordinate(values[3]); monitor.y = Coordinate(values[4]);
    monitor.width = static_cast<std::uint32_t>(Unsigned(values[5], 32768));
    monitor.height = static_cast<std::uint32_t>(Unsigned(values[6], 32768));
    Require(win::ValidMonitorIdentity(monitor));
    result.maxWidth = static_cast<std::uint32_t>(Unsigned(values[7], 640));
    result.maxHeight = static_cast<std::uint32_t>(Unsigned(values[8], 360));
  }
  Require(result.maxWidth && result.maxHeight);
  return result;
}
inline std::pair<std::uint32_t, std::uint32_t> Dimensions(std::uint32_t width, std::uint32_t height,
                                                       std::uint32_t maxWidth, std::uint32_t maxHeight) {
  Require(width && height && maxWidth && maxHeight && maxWidth <= 640 && maxHeight <= 360);
  if (width <= maxWidth && height <= maxHeight) return {width, height};
  if (static_cast<std::uint64_t>(width) * maxHeight >= static_cast<std::uint64_t>(height) * maxWidth)
    return {maxWidth, (std::max)(1u, static_cast<std::uint32_t>(static_cast<std::uint64_t>(height) * maxWidth / width))};
  return {(std::max)(1u, static_cast<std::uint32_t>(static_cast<std::uint64_t>(width) * maxHeight / height)), maxHeight};
}
}  // namespace monky::thumbnail
