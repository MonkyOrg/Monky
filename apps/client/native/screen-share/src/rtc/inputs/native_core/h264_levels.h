#pragma once

// ITU-T H.264 Table A-1 for the Main profile, in one place for the capture host and the RTC engine.

#include <cstdint>

namespace monky::screen_video {

struct H264LevelLimit {
  std::uint8_t level;
  std::uint32_t macroblocksPerSecond, frameMacroblocks, bitrateKbps;
};

inline constexpr H264LevelLimit kH264Levels[] = {
  {10, 1485, 99, 64}, {11, 3000, 396, 192}, {12, 6000, 396, 384}, {13, 11880, 396, 768},
  {20, 11880, 396, 2000}, {21, 19800, 792, 4000}, {22, 20250, 1620, 4000}, {30, 40500, 1620, 10000},
  {31, 108000, 3600, 14000}, {32, 216000, 5120, 20000}, {40, 245760, 8192, 20000},
  {41, 245760, 8192, 50000}, {42, 522240, 8704, 50000}, {50, 589824, 22080, 135000},
  {51, 983040, 36864, 240000}, {52, 2073600, 36864, 240000}, {60, 4177920, 139264, 240000},
};

// Whether a level's frame and rate limits admit this picture at this frame rate; each caller compares the bitrate.
inline bool H264LevelAdmits(const H264LevelLimit& limit, std::uint32_t width, std::uint32_t height, std::uint32_t fps) {
  const std::uint64_t columns = (std::uint64_t{width} + 15) / 16, rows = (std::uint64_t{height} + 15) / 16;
  return columns * rows <= limit.frameMacroblocks && columns * rows * fps <= limit.macroblocksPerSecond &&
         columns * columns <= 8ull * limit.frameMacroblocks && rows * rows <= 8ull * limit.frameMacroblocks;
}

}  // namespace monky::screen_video
