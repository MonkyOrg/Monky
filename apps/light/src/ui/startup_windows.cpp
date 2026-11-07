#include "platform/utf8.hpp"  // Defines NOMINMAX and WIN32_LEAN_AND_MEAN before <windows.h>.
#include "ui/startup.hpp"

#include <stdexcept>
#include <string>
#include <vector>

namespace monky::light::ui {
namespace {

constexpr wchar_t kRunKey[] = L"Software\\Microsoft\\Windows\\CurrentVersion\\Run";
constexpr wchar_t kValue[] = L"Monky Light";

// The quoted path of this executable and nothing else: no arguments is an
// application start, which reuses the saved server.
std::wstring command() {
  std::vector<wchar_t> path(MAX_PATH);
  for (;;) {
    const auto length = GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size()));
    if (length == 0) throw std::runtime_error("Could not find the Monky Light executable");
    if (length < path.size()) return L"\"" + std::wstring(path.data(), length) + L"\"";
    path.resize(path.size() * 2);
  }
}

bool enabled() {
  DWORD size = 0;
  if (RegGetValueW(HKEY_CURRENT_USER, kRunKey, kValue, RRF_RT_REG_SZ, nullptr, nullptr, &size) != ERROR_SUCCESS ||
      size == 0) {
    return false;
  }
  std::wstring value(size / sizeof(wchar_t), L'\0');
  if (RegGetValueW(HKEY_CURRENT_USER, kRunKey, kValue, RRF_RT_REG_SZ, nullptr, value.data(), &size) !=
      ERROR_SUCCESS) {
    return false;
  }
  value.resize(size / sizeof(wchar_t));
  while (!value.empty() && value.back() == L'\0') value.pop_back();
  return CompareStringOrdinal(value.c_str(), -1, command().c_str(), -1, TRUE) == CSTR_EQUAL;
}

void set(bool wanted) {
  if (wanted) {
    const auto value = command();
    const auto bytes = static_cast<DWORD>((value.size() + 1) * sizeof(wchar_t));
    if (RegSetKeyValueW(HKEY_CURRENT_USER, kRunKey, kValue, REG_SZ, value.c_str(), bytes) != ERROR_SUCCESS) {
      throw std::runtime_error("Windows refused to start Monky Light with the system");
    }
    return;
  }
  const auto result = RegDeleteKeyValueW(HKEY_CURRENT_USER, kRunKey, kValue);
  if (result != ERROR_SUCCESS && result != ERROR_FILE_NOT_FOUND) {
    throw std::runtime_error("Windows refused to stop starting Monky Light with the system");
  }
}

}  // namespace

Startup systemStartup() { return {&enabled, &set}; }

}  // namespace monky::light::ui
