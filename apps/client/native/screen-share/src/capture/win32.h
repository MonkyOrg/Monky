#pragma once

// Win32 helpers of the capture host: owned handles, checked calls, bounded stock strings, process times, QPC and
// pipe writes.
// Part of the single host.cpp translation unit, which is the only file that includes it.

#include <Windows.h>

#include "contract.h"

#include <array>
#include <cstdio>
#include <cstring>
#include <span>
#include <string>
#include <string_view>

namespace {
using namespace monky::screen_capture;
namespace win = monky::win;

class Handle {
 public:
  explicit Handle(HANDLE handle = nullptr) : handle_(handle) {}
  ~Handle() { Close(); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  Handle(Handle&& other) noexcept : handle_(other.Take()) {}
  Handle& operator=(Handle&& other) noexcept {
    if (this != &other) { Close(); handle_ = other.Take(); }
    return *this;
  }
  HANDLE Get() const { return handle_; }
  HANDLE Take() { const auto value = handle_; handle_ = nullptr; return value; }
  explicit operator bool() const { return handle_ && handle_ != INVALID_HANDLE_VALUE; }
 private:
  void Close() { if (*this) CloseHandle(handle_); handle_ = nullptr; }
  HANDLE handle_;
};

std::string Hex(std::uint32_t value) {
  char text[11]{};
  std::snprintf(text, sizeof(text), "0x%08x", static_cast<unsigned>(value));
  return text;
}

void CheckWin(BOOL result, const char* code, const char* message) {
  if (!result) throw ContractError(code, std::string(message) + ": " + Hex(GetLastError()));
}

std::string ObsPath(std::wstring_view windowsPath) {
  Require(SafeAbsolutePath(windowsPath), "OBS API path was not admitted as an ordinary absolute Windows path",
          "ERR_SCREEN_CAPTURE_MODULE_PATH");
  return ObsApiPath(Utf8(windowsPath));
}

std::wstring HostImagePath() {
  std::array<wchar_t, 32768> image{};
  const DWORD length = GetModuleFileNameW(nullptr, image.data(), static_cast<DWORD>(image.size()));
  Require(length > 0 && length < image.size(), "Cannot bind the native host image path",
          "ERR_SCREEN_CAPTURE_RUNTIME_PATH");
  return {image.data(), length};
}

std::string BoundedString(const char* value, std::size_t maximum) {
  Require(value != nullptr, "Missing stock string", "ERR_SCREEN_CAPTURE_ABI");
  const auto length = strnlen_s(value, maximum + 1);
  Require(length <= maximum, "Stock string exceeds its bound", "ERR_SCREEN_CAPTURE_ABI");
  const std::string result(value, length);
  Require(ValidUtf8(result), "Stock identity is not valid UTF-8", "ERR_SCREEN_CAPTURE_ABI");
  return result;
}

std::uint64_t FileTimeValue(FILETIME time) {
  return (static_cast<std::uint64_t>(time.dwHighDateTime) << 32) | time.dwLowDateTime;
}

std::uint64_t ProcessCreation(HANDLE process) {
  FILETIME created{}, exited{}, kernel{}, user{};
  CheckWin(GetProcessTimes(process, &created, &exited, &kernel, &user),
      "ERR_SCREEN_CAPTURE_PROCESS_IDENTITY", "Cannot query process creation time");
  const auto value = FileTimeValue(created);
  Require(value > 0, "Process creation time is zero", "ERR_SCREEN_CAPTURE_PROCESS_IDENTITY");
  return value;
}

std::uint64_t Qpc() {
  LARGE_INTEGER value{};
  CheckWin(QueryPerformanceCounter(&value), "ERR_SCREEN_CAPTURE_CLOCK", "QPC failed");
  Require(value.QuadPart > 0, "QPC is not positive", "ERR_SCREEN_CAPTURE_CLOCK");
  return static_cast<std::uint64_t>(value.QuadPart);
}

std::uint64_t QpcFrequency() {
  LARGE_INTEGER value{};
  CheckWin(QueryPerformanceFrequency(&value), "ERR_SCREEN_CAPTURE_CLOCK", "QPC frequency failed");
  Require(value.QuadPart > 0, "QPC frequency is not positive", "ERR_SCREEN_CAPTURE_CLOCK");
  return static_cast<std::uint64_t>(value.QuadPart);
}

void WriteAll(HANDLE file, std::span<const std::uint8_t> bytes, const char* code) {
  while (!bytes.empty()) {
    const auto amount = static_cast<DWORD>((std::min)(bytes.size(), std::size_t{1048576}));
    DWORD written = 0;
    CheckWin(WriteFile(file, bytes.data(), amount, &written, nullptr), code, "WriteFile failed");
    Require(written > 0 && written <= amount, "WriteFile made no valid progress", code);
    bytes = bytes.subspan(written);
  }
}

void WriteText(HANDLE file, std::string_view text, const char* code) {
  WriteAll(file, {reinterpret_cast<const std::uint8_t*>(text.data()), text.size()}, code);
}

}  // namespace
