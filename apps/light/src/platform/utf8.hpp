#pragma once

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

#include <limits>
#include <stdexcept>
#include <string>
#include <string_view>

namespace monky::light {

inline std::string utf8FromWide(std::wstring_view value) {
  if (value.empty()) return {};
  if (value.size() > static_cast<std::size_t>(std::numeric_limits<int>::max())) {
    throw std::invalid_argument("UTF-16 input exceeds the conversion limit");
  }
  const auto size = static_cast<int>(value.size());
  const auto count = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), size,
                                       nullptr, 0, nullptr, nullptr);
  if (count <= 0) throw std::invalid_argument("Invalid UTF-16 input");
  std::string output(static_cast<std::size_t>(count), '\0');
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), size,
                          output.data(), count, nullptr, nullptr) != count) {
    throw std::runtime_error("Unable to convert UTF-16 input");
  }
  return output;
}

}  // namespace monky::light
#endif
