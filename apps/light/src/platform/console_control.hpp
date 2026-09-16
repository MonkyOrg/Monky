#pragma once

#include <functional>
#include <memory>
#include <string>

namespace monky::light {

class ConsoleControl final {
 public:
  struct Callbacks {
    std::function<void(std::string)> line;
    std::function<void()> quit;
    std::function<void(std::string)> error;
  };

  explicit ConsoleControl(Callbacks callbacks);
  ~ConsoleControl();
  ConsoleControl(const ConsoleControl&) = delete;
  ConsoleControl& operator=(const ConsoleControl&) = delete;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace monky::light
