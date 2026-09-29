#pragma once

#include "h264_bitstream.h"
#include <cstdint>

namespace monky::screen_video {
struct EncoderConfig {
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::uint32_t fps = 0;
  std::uint32_t bitrateBps = 0;
  std::uint32_t maxInFlight = 8;
  std::uint8_t level = 0;
  H264Profile profile = H264Profile::Baseline;
};
}
