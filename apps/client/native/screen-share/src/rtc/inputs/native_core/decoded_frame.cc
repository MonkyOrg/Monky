#include "mf_h264_decoder.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <iomanip>
#include <limits>
#include <sstream>

namespace monky::screen_video {

H264Sps ParseProfileLevelId(const std::string& value) {
  if (value.size() != 6) throw std::runtime_error("profileLevelId must contain exactly six hexadecimal digits");
  std::uint32_t number = 0;
  for (const auto c : value) {
    unsigned digit;
    if (c >= '0' && c <= '9') digit = c - '0';
    else if (c >= 'a' && c <= 'f') digit = c - 'a' + 10;
    else if (c >= 'A' && c <= 'F') digit = c - 'A' + 10;
    else throw std::runtime_error("Invalid hexadecimal profileLevelId");
    number = (number << 4) | digit;
  }
  H264Sps result;
  result.profileIdc = static_cast<std::uint8_t>(number >> 16);
  result.compatibility = static_cast<std::uint8_t>(number >> 8);
  result.levelIdc = static_cast<std::uint8_t>(number);
  if ((result.profileIdc != 66 && result.profileIdc != 77) || (result.compatibility & 3)) {
    throw std::runtime_error("Decoder qualification supports only Baseline/Main profileLevelId");
  }
  H264LevelMaxBitrate(result.levelIdc);
  return result;
}

I420Image CopyNv12ToI420(std::span<const std::uint8_t> mapped, std::size_t pitch,
                         std::uint32_t textureWidth, std::uint32_t textureHeight, VideoFrameRect crop) {
  if (!textureWidth || !textureHeight || textureWidth > 8192 || textureHeight > 8192 ||
      (textureWidth & 1) || (textureHeight & 1) || !crop.width || !crop.height ||
      ((crop.x | crop.y | crop.width | crop.height) & 1) ||
      crop.x > textureWidth || crop.width > textureWidth - crop.x ||
      crop.y > textureHeight || crop.height > textureHeight - crop.y ||
      pitch < textureWidth || pitch > (std::numeric_limits<std::size_t>::max)() / (textureHeight + textureHeight / 2) ||
      mapped.size() < pitch * (textureHeight + textureHeight / 2)) {
    throw std::runtime_error("Invalid NV12 crop/pitch/mapped extent");
  }
  I420Image result;
  result.width = crop.width;
  result.height = crop.height;
  result.y.resize(static_cast<std::size_t>(crop.width) * crop.height);
  result.u.resize(result.y.size() / 4);
  result.v.resize(result.y.size() / 4);
  for (std::uint32_t y = 0; y < crop.height; ++y) {
    std::memcpy(result.y.data() + static_cast<std::size_t>(y) * crop.width,
                mapped.data() + (crop.y + y) * pitch + crop.x, crop.width);
  }
  const auto* uv = mapped.data() + textureHeight * pitch + (crop.y / 2) * pitch + crop.x;
  for (std::uint32_t y = 0; y < crop.height / 2; ++y) {
    for (std::uint32_t x = 0; x < crop.width / 2; ++x) {
      const auto target = static_cast<std::size_t>(y) * (crop.width / 2) + x;
      result.u[target] = uv[y * pitch + 2 * x];
      result.v[target] = uv[y * pitch + 2 * x + 1];
    }
  }
  return result;
}

FrameInspection InspectLuma(std::span<const std::uint8_t> mapped, std::size_t pitch) {
  constexpr std::size_t width = FrameInspection::width, height = FrameInspection::height;
  if (pitch < width || pitch > (std::numeric_limits<std::size_t>::max)() / height ||
      mapped.size() < pitch * height) throw std::runtime_error("Invalid diagnostic luma pitch/extent");
  FrameInspection result;
  result.minLuma = 255;
  std::uint64_t hash = 14695981039346656037ull;
  double sum = 0, squared = 0;
  for (std::size_t y = 0; y < height; ++y) {
    for (std::size_t x = 0; x < width; ++x) {
      const auto value = mapped[y * pitch + x];
      sum += value;
      squared += static_cast<double>(value) * value;
      result.minLuma = std::min(result.minLuma, static_cast<std::uint32_t>(value));
      result.maxLuma = std::max(result.maxLuma, static_cast<std::uint32_t>(value));
      hash = (hash ^ value) * 1099511628211ull;
    }
  }
  result.meanLuma = sum / (width * height);
  result.stddevLuma = std::sqrt(std::max(0.0, squared / (width * height) - result.meanLuma * result.meanLuma));
  std::ostringstream text;
  text << std::hex << std::setfill('0') << std::setw(16) << hash;
  result.hash = text.str();
  return result;
}

}  // namespace monky::screen_video
