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

  bool post(Task task, std::size_t retainedBytes = 0);
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
