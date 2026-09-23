#pragma once

#include <cstdint>
#include <map>
#include <optional>
#include <span>
#include <stdexcept>
#include <string>
#include <vector>

namespace monky::screen_video {

enum class H264Profile { Baseline, ConstrainedBaseline, Main, AnySupported };
enum class H264LevelPolicy { Exact, Maximum };
const char* H264ProfileName(H264Profile profile);

struct H264Sps {
  std::uint32_t id = 0;
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::uint32_t codedWidth = 0;
  std::uint32_t codedHeight = 0;
  std::uint32_t cropLeft = 0;
  std::uint32_t cropTop = 0;
  std::uint8_t profileIdc = 0;
  std::uint8_t compatibility = 0;
  std::uint8_t levelIdc = 0;
  bool progressive = false;
  std::optional<bool> fullRange;
  std::optional<std::uint8_t> colorPrimaries;
  std::optional<std::uint8_t> transferCharacteristics;
  std::optional<std::uint8_t> matrixCoefficients;
  std::string ProfileLevelId() const;
};

struct H264AccessUnit {
  std::vector<std::uint8_t> data;
  bool keyFrame = false;
  bool hasPicture = false;
};

std::uint8_t RequiredH264Level(std::uint32_t width, std::uint32_t height,
                               std::uint32_t fps, std::uint32_t bitrateBps);
std::uint32_t H264LevelMaxBitrate(std::uint8_t level);
H264Sps ParseBaselineSps(std::span<const std::uint8_t> nal);
H264Sps ParseH264Sps(std::span<const std::uint8_t> nal);
bool MatchesH264Profile(const H264Sps& sps, H264Profile profile);
bool IsBt709LimitedCompatible(const H264Sps& sps);

class H264Bitstream {
 public:
  H264Bitstream(std::uint32_t width, std::uint32_t height, std::uint8_t level,
                H264Profile profile = H264Profile::Baseline,
                H264LevelPolicy levelPolicy = H264LevelPolicy::Exact);
  void SetSequenceHeader(std::span<const std::uint8_t> header);
  H264AccessUnit Convert(std::span<const std::uint8_t> bytes);
  const H264Sps& Sps() const { return sps_; }
  bool Verified() const { return verified_; }
 private:
  void Remember(std::span<const std::uint8_t> nal);
  std::vector<std::span<const std::uint8_t>> Split(std::span<const std::uint8_t> bytes) const;
  std::uint32_t width_;
  std::uint32_t height_;
  std::uint8_t level_;
  H264Profile profile_;
  H264LevelPolicy levelPolicy_;
  unsigned lengthBytes_ = 4;
  bool avcConfiguration_ = false;
  bool verified_ = false;
  H264Sps sps_;
  std::map<std::uint32_t, std::vector<std::uint8_t>> spsById_;
  std::map<std::uint32_t, std::vector<std::uint8_t>> ppsById_;
};

}  // namespace monky::screen_video
