#pragma once

#include <functional>
#include <optional>

namespace monky::light::ui {

// Starting with the system, for an application start only. Both functions run
// on the interface thread; `set` throws when the system refuses the change.
struct Startup {
  std::function<bool()> enabled;
  std::function<void(bool)> set;
};

// Registers this executable, with no arguments, to open at sign-in: a value
// under HKCU\...\CurrentVersion\Run on Windows, a LaunchAgent in
// ~/Library/LaunchAgents on macOS. Reported as enabled only when the
// registration points at this very executable, so another copy's entry is
// never shown as ours.
Startup systemStartup();

}  // namespace monky::light::ui
