#pragma once

#include <cstdint>
#include <limits>
#if defined(_WIN32)
#include <windows.h>
#else
#include <mach/mach_time.h>
#endif

namespace monky::native_rtc::engine {
inline bool NativeCaptureNowUs(std::int64_t& value) {
#if defined(_WIN32)
  LARGE_INTEGER ticks{}, frequency{};
  if (!QueryPerformanceCounter(&ticks) || !QueryPerformanceFrequency(&frequency) ||
      ticks.QuadPart < 0 || frequency.QuadPart <= 0) return false;
  const auto seconds = ticks.QuadPart / frequency.QuadPart;
  const auto remainder = ticks.QuadPart % frequency.QuadPart;
  if (seconds > 9007199254 || remainder > (std::numeric_limits<std::int64_t>::max)() / 1000000)
    return false;
  value = seconds * 1000000 + remainder * 1000000 / frequency.QuadPart;
#else
  mach_timebase_info_data_t scale{};
  if (mach_timebase_info(&scale) != KERN_SUCCESS || !scale.denom) return false;
  const auto microseconds = static_cast<unsigned __int128>(mach_absolute_time()) * scale.numer /
      scale.denom / 1000;
  if (microseconds > 9007199254740991ULL) return false;
  value = static_cast<std::int64_t>(microseconds);
#endif
  return value >= 0 && value <= 9007199254740991LL;
}
}
