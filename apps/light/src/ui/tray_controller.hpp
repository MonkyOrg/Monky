#pragma once

#include "core_commands.hpp"
#include "ui/tray_model.hpp"

#include <mutex>
#include <optional>
#include <string>
#include <utility>

namespace monky::light::ui {

// The platform-free half of the tray. The core thread writes the model while the
// interface thread draws from it, so it lives behind a mutex; activations become
// the same commands the console control accepts, with the same validation and
// the same command-accepted/command-error answers.
class TrayController final {
 public:
  TrayController(CoreCommands core, Language language)
      : core_(std::move(core)), model_(language) {}

  // Core thread. Returns true when the interface must redraw or notify.
  bool observe(const Json& event) {
    bool changed = false;
    bool refresh = false;
    {
      std::lock_guard lock(mutex_);
      changed = model_.apply(event);
      refresh = model_.takeDeviceRefresh();
    }
    // Enumerating opens the audio module briefly and releases it, so the list is
    // only refreshed when the core says it changed, never on a timer.
    if (refresh) core_.command(Json{{"command", "devices"}});
    return changed;
  }

  // Interface thread.
  Presentation presentation() const {
    std::lock_guard lock(mutex_);
    return model_.presentation();
  }

  std::optional<std::string> takeAlert() {
    std::lock_guard lock(mutex_);
    return model_.takeAlert();
  }

  void join(const std::string& channelId) {
    core_.command(Json{{"command", "join"}, {"channelId", channelId}});
  }

  void leave() { core_.command(Json{{"command", "leave"}}); }

  void setMuted(bool enabled) { core_.command(Json{{"command", "mute"}, {"enabled", enabled}}); }

  void setDeafened(bool enabled) {
    core_.command(Json{{"command", "deafen"}, {"enabled", enabled}});
  }

  // An empty identifier follows the operating system default device.
  void selectInput(const std::string& deviceId) { selectDevice("set-input", deviceId); }

  void selectOutput(const std::string& deviceId) { selectDevice("set-output", deviceId); }

  void reconnect() { core_.command(Json{{"command", "reconnect"}}); }

  void quit() { core_.quit(); }

 private:
  void selectDevice(const char* command, const std::string& deviceId) {
    core_.command(Json{{"command", command},
                       {"deviceId", deviceId.empty() ? Json(nullptr) : Json(deviceId)}});
  }

  CoreCommands core_;
  mutable std::mutex mutex_;
  TrayModel model_;
};

}  // namespace monky::light::ui
