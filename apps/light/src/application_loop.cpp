#include "application_loop.hpp"

#include <stdexcept>
#include <utility>

namespace monky::light {

bool ApplicationLoop::post(Task task, std::size_t retainedBytes) {
  if (!task) throw std::invalid_argument("Cannot queue an empty application callback");
  std::lock_guard lock(mutex_);
  if (stopped_ || overflowed_) return false;
  constexpr std::size_t maxCallbacks = 256;
  constexpr std::size_t maxRetainedBytes = 16 * 1024 * 1024;
  if (tasks_.size() >= maxCallbacks || retainedBytes > maxRetainedBytes - retainedBytes_) {
    overflowed_ = true;
    changed_.notify_one();
    return false;
  }
  tasks_.push_back({std::move(task), retainedBytes});
  retainedBytes_ += retainedBytes;
  changed_.notify_one();
  return true;
}

void ApplicationLoop::run(const std::function<Deadline()>& nextDeadline,
                          const std::function<void(Clock::time_point)>& tick) {
  {
    std::lock_guard lock(mutex_);
    if (entered_) throw std::logic_error("The application loop cannot be restarted");
    entered_ = true;
  }
  for (;;) {
    const auto deadline = nextDeadline();
    Task task;
    bool expired = false;
    {
      std::unique_lock lock(mutex_);
      const auto ready = [this] { return stopped_ || overflowed_ || !tasks_.empty(); };
      if (deadline) changed_.wait_until(lock, *deadline, ready);
      else changed_.wait(lock, ready);
      if (overflowed_) throw std::runtime_error("Native application event queue exceeded its resource limit");
      if (stopped_) return;
      expired = deadline && Clock::now() >= *deadline;
      // Heartbeats and RPC timeouts cannot be starved by an incoming message flood.
      if (!expired && !tasks_.empty()) {
        retainedBytes_ -= tasks_.front().retainedBytes;
        task = std::move(tasks_.front().task);
        tasks_.pop_front();
      }
    }
    if (expired) tick(Clock::now());
    else if (task) task();
  }
}

void ApplicationLoop::stop() noexcept {
  std::lock_guard lock(mutex_);
  stopped_ = true;
  changed_.notify_one();
}

}  // namespace monky::light
