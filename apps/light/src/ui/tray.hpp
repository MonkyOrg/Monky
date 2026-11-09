#pragma once

#include "core_commands.hpp"
#include "ui/startup.hpp"
#include "ui/tray_strings.hpp"

#include <memory>

namespace monky::light::ui {

// Creates the platform tray. It must be called on the process main thread,
// before the core thread starts, because the returned interface is observed from
// the core thread. Throws when the platform interface cannot be created.
// `startup` is offered only to an application start (see systemStartup()).
std::unique_ptr<CoreInterface> createTray(CoreCommands core, Language language,
                                          std::optional<Startup> startup = std::nullopt);

// The operating system interface language, falling back to English.
Language systemLanguage();

}  // namespace monky::light::ui
