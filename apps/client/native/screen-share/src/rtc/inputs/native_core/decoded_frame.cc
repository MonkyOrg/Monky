#include "mf_h264_decoder.h"

#include <cstring>
#include <limits>

namespace monky::screen_video {

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

}  // namespace monky::screen_video
