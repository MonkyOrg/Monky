#include "monky_rtc_engine.h"
#include <array>
#include <cstdio>

int main() {
  std::array<char, 65536> json{};
  uint32_t required = 0;
  const auto status = monky_rtc_engine_capabilities(json.data(), json.size(), &required);
  if (status != MONKY_ENGINE_OK || required == 0 || required > json.size()) {
    std::fprintf(stderr, "Native RTC capabilities failed: status=%d bytes=%u\n", status, required);
    return 1;
  }
  std::puts(json.data());
  return 0;
}
