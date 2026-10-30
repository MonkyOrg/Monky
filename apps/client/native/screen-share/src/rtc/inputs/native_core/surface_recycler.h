#pragma once

#include <cstddef>
#include <cstdint>
#include <mutex>
#include <optional>
#include <utility>
#include <vector>

namespace monky::screen_video {

struct SurfaceSize {
  std::uint32_t width = 0, height = 0;
  bool operator==(const SurfaceSize&) const = default;
};

// Keeps the surfaces of released frames for the next frame of the same size,
// so a receiver does not allocate one per frame. Clear() drops what is kept
// and refuses the surfaces still owned by frames, for an owner whose streams
// ended. Pure bookkeeping: the producers supply the textures.
template <typename Surface>
class SurfaceRecycler {
 public:
  explicit SurfaceRecycler(std::size_t capacity) : capacity_(capacity) { kept_.reserve(capacity); }

  // The most recently released surface of this size, if any.
  std::optional<Surface> Take(SurfaceSize size) {
    std::lock_guard lock(mutex_);
    for (auto index = kept_.size(); index-- > 0;) {
      if (kept_[index].size != size) continue;
      std::optional<Surface> surface(std::move(kept_[index].surface));
      kept_.erase(kept_.begin() + static_cast<std::ptrdiff_t>(index));
      return surface;
    }
    return std::nullopt;
  }

  // Tags the surfaces handed out now; Return refuses them after a Clear().
  std::uint64_t Generation() const {
    std::lock_guard lock(mutex_);
    return generation_;
  }

  // When full, the oldest kept surface makes room, so a size that stopped
  // arriving leaves as the current one comes back.
  void Return(Surface surface, SurfaceSize size, std::uint64_t generation) noexcept {
    try {
      std::lock_guard lock(mutex_);
      if (generation != generation_ || !capacity_) return;
      if (kept_.size() == capacity_) kept_.erase(kept_.begin());
      kept_.push_back({std::move(surface), size});
    } catch (...) {}  // A surface that cannot be kept is released instead.
  }

  void Clear() noexcept {
    try {
      std::lock_guard lock(mutex_);
      ++generation_;
      kept_.clear();
    } catch (...) {}
  }

  std::size_t Kept() const {
    std::lock_guard lock(mutex_);
    return kept_.size();
  }

 private:
  struct Entry {
    Surface surface;
    SurfaceSize size;
  };
  mutable std::mutex mutex_;
  std::vector<Entry> kept_;
  const std::size_t capacity_;
  std::uint64_t generation_ = 0;
};

}  // namespace monky::screen_video
