#pragma once

#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <deque>
#include <functional>
#include <mutex>
#include <optional>

namespace monky::light {

class ApplicationLoop final {
 public:
  using Clock = std::chrono::steady_clock;
  using Task = std::function<void()>;
  using Deadline = std::optional<Clock::time_point>;

  // Everything queued at once. Past it the core is broken, not busy, and run() throws.
  static constexpr std::size_t maxCallbacks = 256;
  static constexpr std::size_t maxRetainedBytes = 16 * 1024 * 1024;
  // The share network input may take, so the core's own work always finds room.
  static constexpr std::size_t maxOfferedCallbacks = 192;
  static constexpr std::size_t maxOfferedBytes = 12 * 1024 * 1024;

  // The core's own work: overflowing the queue is fatal.
  bool post(Task task, std::size_t retainedBytes = 0);
  // Network input: refused, without harm to the loop, once it would take more
  // than its share. The caller has lost a message and must start over.
  bool offer(Task task, std::size_t retainedBytes);
  void run(const std::function<Deadline()>& nextDeadline,
           const std::function<void(Clock::time_point)>& tick);
  void stop() noexcept;

 private:
  struct Entry {
    Task task;
    std::size_t retainedBytes;
  };

  std::mutex mutex_;
  std::condition_variable changed_;
  std::deque<Entry> tasks_;
  std::size_t retainedBytes_ = 0;
  bool stopped_ = false;
  bool overflowed_ = false;
  bool entered_ = false;
};

}  // namespace monky::light
