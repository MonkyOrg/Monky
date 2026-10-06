#include "../src/rtc/inputs/engine/platform_clock.h"
#include <cstdio>

int main() {
  std::int64_t timestamp = 0;
  if (!monky::native_rtc::engine::NativeCaptureNowUs(timestamp)) {
    std::fprintf(stderr, "Could not read the native capture clock.\n");
    return 1;
  }
  std::printf("%lld\n", static_cast<long long>(timestamp));
  return 0;
}
