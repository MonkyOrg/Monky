#pragma once
#include <windows.h>
#include "contract.h"

namespace monky::thumbnail {
struct Handle {
  HANDLE value = nullptr;
  ~Handle() { if (value) CloseHandle(value); }
  Handle() = default;
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
};
class Lifetime {
 public:
  Lifetime() {
    finished_.value = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    Require(finished_.value != nullptr, "ERR_DESKTOP_PREVIEW_WATCHDOG");
    thread_.value = CreateThread(nullptr, 0, Watch, finished_.value, 0, nullptr);
    Require(thread_.value != nullptr, "ERR_DESKTOP_PREVIEW_WATCHDOG");
  }
  ~Lifetime() {
    if (!SetEvent(finished_.value) || WaitForSingleObject(thread_.value, INFINITE) != WAIT_OBJECT_0)
      TerminateProcess(GetCurrentProcess(), 124);
  }
  Lifetime(const Lifetime&) = delete;
  Lifetime& operator=(const Lifetime&) = delete;
 private:
  static DWORD WINAPI Watch(void* finished) noexcept {
    if (WaitForSingleObject(finished, kHardLifetimeMs) != WAIT_OBJECT_0) {
      // A stalled owner cannot be trusted to drain diagnostics. Exit 124
      // invalidates any bytes and is never proof of resource retirement.
      TerminateProcess(GetCurrentProcess(), 124);
    }
    return 0;
  }
  Handle finished_, thread_;
};
}  // namespace monky::thumbnail
