#pragma once

#include "ui/chat_controller.hpp"

#include <functional>
#include <memory>

namespace monky::light::ui {

// The text chat window on macOS: created when the tray opens it and released
// after it closes, which also stops the core from reading chat. Main thread.
class MacChatWindow final {
 public:
  // `closed` runs once the user closed the window; the tray then releases it
  // outside the window's own callback.
  MacChatWindow(ChatController& chat, const Strings& text, std::function<void()> closed);
  ~MacChatWindow();
  MacChatWindow(const MacChatWindow&) = delete;
  MacChatWindow& operator=(const MacChatWindow&) = delete;

  bool closed() const;
  void focus();
  void update(ChatChange change);

  struct Impl;

 private:
  std::unique_ptr<Impl> impl_;
};

}  // namespace monky::light::ui
