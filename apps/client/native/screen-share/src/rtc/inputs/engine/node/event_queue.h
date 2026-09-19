#pragma once

#include <atomic>
#include <cstddef>
#include <utility>

namespace monky::native_rtc::node {

// The runtime's finalizer and each accepted queue item own independent refs.
// Finalization can precede env=null disposal; producer refs are unrelated.
template <typename Owner>
class EventQueueContext final {
 public:
  explicit EventQueueContext(Owner owner) : owner_(std::move(owner)) {}
  const Owner& OwnerValue() const noexcept { return owner_; }

  void RetainPending() noexcept {
    references_.fetch_add(1, std::memory_order_relaxed);
    pending_.fetch_add(1, std::memory_order_release);
  }
  bool ReleasePending() noexcept {
    const auto previous = pending_.fetch_sub(1, std::memory_order_acq_rel);
    const bool drained = previous == 1 && finalized_.load(std::memory_order_acquire);
    ReleaseReference();
    return drained;
  }
  bool MarkFinalized() noexcept {
    finalized_.store(true, std::memory_order_release);
    return pending_.load(std::memory_order_acquire) == 0;
  }
  void ReleaseFinalizer() noexcept { ReleaseReference(); }
  std::size_t Pending() const noexcept { return pending_.load(std::memory_order_acquire); }

 private:
  void ReleaseReference() noexcept {
    if (references_.fetch_sub(1, std::memory_order_acq_rel) == 1) delete this;
  }
  Owner owner_;
  std::atomic<std::size_t> references_{1}, pending_{0};
  std::atomic<bool> finalized_{false};
};

}  // namespace monky::native_rtc::node
