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

// Whether stdout is the console (a terminal) the person sees, rather than a
// pipe or a file another program reads. Ask before the console can go away.
bool standardOutputIsConsole();

}  // namespace monky::light
