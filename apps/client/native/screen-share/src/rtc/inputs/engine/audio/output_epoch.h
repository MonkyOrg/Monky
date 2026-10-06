#pragma once

#include "audio_types.h"

#include <algorithm>
#include <map>
#include <mutex>

namespace monky::native_rtc::engine::audio {

class OutputEpoch {
 public:
  void Begin(std::uint64_t epoch) {
    std::lock_guard lock(mutex_);
    if (!epoch || epoch > kMaxSafeInteger || epoch <= retired_)
      throw AudioError(Failure::NotReady, "Output epoch was invalidated before configuration completed");
    epoch_ = epoch;
    ready_ = false;
  }
  bool Ready(std::uint64_t epoch) {
    std::lock_guard lock(mutex_);
    if (epoch_ != epoch || epoch <= retired_) return false;
    ready_ = true;
    return true;
  }
  bool Accepts(std::uint64_t epoch) const {
    std::lock_guard lock(mutex_);
    return epoch && epoch_ == epoch && ready_ && epoch > retired_;
  }
  bool Invalidate(std::uint64_t epoch) {
    std::lock_guard lock(mutex_);
    if (!epoch) return false;
    const bool first = epoch > retired_;
    retired_ = (std::max)(retired_, epoch);
    if (epoch_ == epoch) {
      epoch_ = 0;
      ready_ = false;
    }
    return first;
  }

 private:
  mutable std::mutex mutex_;
  std::uint64_t epoch_ = 0, retired_ = 0;
  bool ready_ = false;
};

using OutputPackets = std::map<std::pair<std::uint64_t, std::uint64_t>, PlayoutPacket>;

inline void RetireOutputPackets(OutputPackets& packets, std::uint64_t epoch) {
  std::erase_if(packets, [epoch](const auto& item) { return item.first.first == epoch; });
}

}  // namespace monky::native_rtc::engine::audio
