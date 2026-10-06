#pragma once

#include "core_commands.hpp"
#include "ui/tray_strings.hpp"

#include <memory>

namespace monky::light::ui {

// Creates the platform tray. It must be called on the process main thread,
// before the core thread starts, because the returned interface is observed from
// the core thread. Throws when the platform interface cannot be created.
std::unique_ptr<CoreInterface> createTray(CoreCommands core, Language language);

// The operating system interface language, falling back to English.
Language systemLanguage();

}  // namespace monky::light::ui
