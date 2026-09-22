#pragma once

#include <cstdint>

namespace monky::native_rtc::engine {

struct FrameRoute {
  std::uint64_t target = 0;
  std::uint64_t receiver_id = 0;
  std::uint64_t receiver_epoch = 0;

  bool IsPeer() const noexcept { return receiver_id != 0; }
  bool Valid(std::uint64_t maximum_id) const noexcept {
    return target && target <= maximum_id && receiver_id <= maximum_id &&
           receiver_epoch <= maximum_id && ((receiver_id == 0) == (receiver_epoch == 0));
  }
  bool operator==(const FrameRoute&) const = default;
};

}  // namespace monky::native_rtc::engine
