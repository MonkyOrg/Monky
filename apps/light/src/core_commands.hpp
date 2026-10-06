#pragma once

#include <json.hpp>

#include <functional>

namespace monky::light {

// Commands a native interface sends into the core. Both are safe to call from
// the interface thread; the core queues them on its own loop and answers with
// the same events and validation the console control path receives.
struct CoreCommands {
  std::function<void(nlohmann::json)> command;
  std::function<void()> quit;
};

// A native interface owns the process main thread, because the platform event
// loops require it, while the core loop runs on a worker thread. Every method
// except run() is called on the core thread.
class CoreInterface {
 public:
  virtual ~CoreInterface() = default;
  // Must only hand work to the interface thread, and must never block on it.
  virtual void observe(const nlohmann::json& event) = 0;
  // Called once the core loop has stopped; must unblock run().
  virtual void stopped() = 0;
  // Runs the platform event loop until the interface is asked to quit.
  virtual int run() = 0;
};

}  // namespace monky::light
