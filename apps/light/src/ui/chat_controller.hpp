#pragma once

#include "core_commands.hpp"
#include "ui/chat_model.hpp"

#include <mutex>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace monky::light::ui {

// The chat window's link to the core, shared by both platforms. Events arrive
// on the core thread and are applied under the lock; the window reads on the
// interface thread and sends the same commands the console accepts.
class ChatController final {
 public:
  ChatController(CoreCommands core, Language language) : core_(std::move(core)), model_(language) {}

  // Core thread. Returns what the open window must redraw.
  ChatChange observe(const Json& event) {
    std::lock_guard lock(mutex_);
    return model_.apply(event);
  }

  // Interface thread.
  void open(const std::string& channelId) { command([&] { return model_.open(channelId); }); }
  void older() {
    std::optional<Json> request;
    {
      std::lock_guard lock(mutex_);
      request = model_.older();
    }
    if (request) core_.command(std::move(*request));
  }
  // False when there is nothing to send, so the window keeps the text.
  bool send(const std::string& content) {
    std::optional<Json> request;
    {
      std::lock_guard lock(mutex_);
      request = model_.send(content);
    }
    if (!request) return false;
    core_.command(std::move(*request));
    return true;
  }
  void close() { command([&] { return model_.close(); }); }

  std::vector<MenuEntry> channels() const {
    std::lock_guard lock(mutex_);
    return model_.channels();
  }
  std::optional<std::string> channel() const {
    std::lock_guard lock(mutex_);
    return model_.channel();
  }
  std::vector<ChatLine> lines() const {
    std::lock_guard lock(mutex_);
    return model_.lines();
  }
  std::optional<ChatLine> lastChanged() const {
    std::lock_guard lock(mutex_);
    return model_.lastChanged();
  }
  bool canLoadOlder() const {
    std::lock_guard lock(mutex_);
    return model_.canLoadOlder();
  }
  std::optional<std::string> takeAlert() {
    std::lock_guard lock(mutex_);
    return model_.takeAlert();
  }

 private:
  template <class Make>
  void command(Make make) {
    Json request;
    {
      std::lock_guard lock(mutex_);
      request = make();
    }
    core_.command(std::move(request));
  }

  CoreCommands core_;
  mutable std::mutex mutex_;
  ChatModel model_;
};

}  // namespace monky::light::ui
