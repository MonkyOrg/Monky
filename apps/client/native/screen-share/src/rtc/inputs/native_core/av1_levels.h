#pragma once

// AV1 Annex A, Main tier, in one place for the capture host and the RTC engine: picture size, maximum width and
// height, display rate in samples per second and bitrate.

#include <cstdint>

namespace monky::screen_video {

struct Av1LevelLimit {
  std::uint8_t index;
  std::uint32_t pictureSize, width, height;
  std::uint64_t displayRate;
  std::uint32_t bitrateKbps;
};

inline constexpr Av1LevelLimit kAv1Levels[] = {
  {0, 147456, 2048, 1152, 4423680, 1500}, {1, 278784, 2816, 1584, 8363520, 3000},
  {4, 665856, 4352, 2448, 19975680, 6000}, {5, 1065024, 5504, 3096, 31950720, 10000},
  {8, 2359296, 6144, 3456, 70778880, 12000}, {9, 2359296, 6144, 3456, 141557760, 20000},
  {12, 8912896, 8192, 4352, 267386880, 30000}, {13, 8912896, 8192, 4352, 534773760, 40000},
  {14, 8912896, 8192, 4352, 1069547520, 60000}, {17, 35651584, 16384, 8704, 2139095040, 100000},
};

}  // namespace monky::screen_video
