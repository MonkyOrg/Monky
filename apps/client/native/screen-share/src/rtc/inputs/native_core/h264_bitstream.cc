#include "h264_bitstream.h"

#include <algorithm>
#include <array>
#include <iomanip>
#include <limits>
#include <sstream>

namespace monky::screen_video {
namespace {

struct Level {
  std::uint8_t id;
  std::uint32_t mbps;
  std::uint32_t frameMbs;
  std::uint32_t bitrate;
};

constexpr Level levels[] = {
    {31, 108000, 3600, 14000000}, {32, 216000, 5120, 20000000},
    {40, 245760, 8192, 20000000}, {41, 245760, 8192, 50000000},
    {42, 522240, 8704, 50000000}, {50, 589824, 22080, 135000000},
    {51, 983040, 36864, 240000000}, {52, 2073600, 36864, 240000000}};
constexpr std::size_t maxAccessUnitBytes = 8 * 1024 * 1024;
constexpr std::size_t maxParameterBytes = 64 * 1024;

class Bits {
 public:
  explicit Bits(std::span<const std::uint8_t> nal) : data_(nal) {
    if (nal.empty()) throw std::runtime_error("Empty H264 NAL");
  }
  std::uint32_t Read(unsigned count) {
    if (count > 32) throw std::runtime_error("Invalid H264 bit width");
    std::uint32_t value = 0;
    for (unsigned i = 0; i < count; ++i) {
      if (!remaining_) {
        if (position_ == data_.size()) throw std::runtime_error("Truncated H264 bitstream");
        auto byte = data_[position_++];
        if (zeros_ >= 2 && byte == 3) {
          if (position_ == data_.size() || data_[position_] > 3) {
            throw std::runtime_error("Invalid H264 emulation-prevention byte");
          }
          byte = data_[position_++];
          zeros_ = 0;
        }
        zeros_ = byte == 0 ? zeros_ + 1 : 0;
        current_ = byte;
        remaining_ = 8;
      }
      value = (value << 1) | ((current_ >> --remaining_) & 1);
    }
    return value;
  }
  std::uint32_t Ue() {
    unsigned zeros = 0;
    while (Read(1) == 0) {
      if (++zeros > 30) throw std::runtime_error("H264 Exp-Golomb value is too large");
    }
    return ((1u << zeros) - 1) + Read(zeros);
  }
  std::int32_t Se() {
    const auto value = Ue();
    return value & 1 ? static_cast<std::int32_t>((value + 1) / 2)
                     : -static_cast<std::int32_t>(value / 2);
  }
 private:
  std::span<const std::uint8_t> data_;
  std::size_t position_ = 1;
  std::uint8_t current_ = 0;
  unsigned remaining_ = 0;
  unsigned zeros_ = 0;
};

unsigned Type(std::span<const std::uint8_t> nal) {
  if (nal.empty() || (nal[0] & 0x80) || (nal[0] & 31) == 0 || (nal[0] & 31) > 23) {
    throw std::runtime_error("Invalid elementary H264 NAL header");
  }
  return nal[0] & 31;
}

std::size_t StartCode(std::span<const std::uint8_t> bytes, std::size_t offset) {
  if (offset + 3 <= bytes.size() && bytes[offset] == 0 && bytes[offset + 1] == 0) {
    if (bytes[offset + 2] == 1) return 3;
    if (offset + 4 <= bytes.size() && bytes[offset + 2] == 0 && bytes[offset + 3] == 1) return 4;
  }
  return 0;
}

void Append(std::vector<std::uint8_t>& bytes, std::span<const std::uint8_t> nal) {
  if (bytes.size() + nal.size() + 4 > maxAccessUnitBytes) {
    throw std::runtime_error("H264 access unit exceeds the bounded output limit");
  }
  bytes.insert(bytes.end(), {0, 0, 0, 1});
  bytes.insert(bytes.end(), nal.begin(), nal.end());
}

}  // namespace

std::uint8_t RequiredH264Level(std::uint32_t width, std::uint32_t height,
                               std::uint32_t fps, std::uint32_t bitrateBps) {
  if (!width || !height || !fps || !bitrateBps) throw std::runtime_error("Invalid H264 configuration");
  const std::uint64_t w = (static_cast<std::uint64_t>(width) + 15) / 16;
  const std::uint64_t h = (static_cast<std::uint64_t>(height) + 15) / 16;
  for (const auto& level : levels) {
    if (w * h <= level.frameMbs && w * h * fps <= level.mbps &&
        w * w <= 8ull * level.frameMbs && h * h <= 8ull * level.frameMbs &&
        bitrateBps <= level.bitrate) return level.id;
  }
  throw std::runtime_error("Requested H264 mode exceeds supported Level 5.2 bounds");
}

std::uint32_t H264LevelMaxBitrate(std::uint8_t id) {
  for (const auto& level : levels) if (level.id == id) return level.bitrate;
  throw std::runtime_error("Unsupported H264 level");
}

std::string H264Sps::ProfileLevelId() const {
  std::ostringstream result;
  result << std::hex << std::setfill('0') << std::setw(2) << static_cast<unsigned>(profileIdc)
         << std::setw(2) << static_cast<unsigned>(compatibility)
         << std::setw(2) << static_cast<unsigned>(levelIdc);
  return result.str();
}

const char* H264ProfileName(H264Profile profile) {
  switch (profile) {
    case H264Profile::Baseline: return "baseline";
    case H264Profile::ConstrainedBaseline: return "constrained-baseline";
    case H264Profile::Main: return "main";
    case H264Profile::AnySupported: return "baseline-or-main";
  }
  throw std::runtime_error("Unsupported H264 profile");
}

bool IsBt709LimitedCompatible(const H264Sps& sps) {
  // H.264 value 2 is unspecified, just like an absent colour description.
  // The capture/decoder contract supplies BT.709 limited; conflicting VUI is rejected.
  const auto compatible = [](std::optional<std::uint8_t> value) {
    return !value || *value == 1 || *value == 2;
  };
  return !sps.fullRange.value_or(false) && compatible(sps.colorPrimaries) &&
      compatible(sps.transferCharacteristics) && compatible(sps.matrixCoefficients);
}

bool MatchesH264Profile(const H264Sps& sps, H264Profile profile) {
  switch (profile) {
    case H264Profile::Baseline: return sps.profileIdc == 66;
    case H264Profile::ConstrainedBaseline: return sps.profileIdc == 66 && (sps.compatibility & 0x40);
    case H264Profile::Main: return sps.profileIdc == 77;
    case H264Profile::AnySupported: return sps.profileIdc == 66 || sps.profileIdc == 77;
  }
  return false;
}

H264Sps ParseH264Sps(std::span<const std::uint8_t> nal) {
  if (Type(nal) != 7 || nal.size() > maxParameterBytes) throw std::runtime_error("Invalid SPS");
  Bits bits(nal);
  H264Sps result;
  result.profileIdc = static_cast<std::uint8_t>(bits.Read(8));
  result.compatibility = static_cast<std::uint8_t>(bits.Read(8));
  result.levelIdc = static_cast<std::uint8_t>(bits.Read(8));
  if ((result.profileIdc != 66 && result.profileIdc != 77) || (result.compatibility & 3)) {
    throw std::runtime_error("Only valid H264 Baseline/Main SPS is supported");
  }
  result.id = bits.Ue();
  if (result.id > 31 || bits.Ue() > 12) throw std::runtime_error("Invalid SPS identifiers");
  const auto poc = bits.Ue();
  if (poc == 0) {
    if (bits.Ue() > 12) throw std::runtime_error("Invalid H264 POC width");
  } else if (poc == 1) {
    bits.Read(1);
    bits.Se();
    bits.Se();
    const auto cycle = bits.Ue();
    if (cycle > 255) throw std::runtime_error("Invalid H264 POC cycle");
    for (std::uint32_t i = 0; i < cycle; ++i) bits.Se();
  } else if (poc != 2) {
    throw std::runtime_error("Invalid H264 POC type");
  }
  if (bits.Ue() > 16) throw std::runtime_error("Invalid H264 reference-frame count");
  bits.Read(1);
  const auto widthMbs = static_cast<std::uint64_t>(bits.Ue()) + 1;
  const auto heightMapUnits = static_cast<std::uint64_t>(bits.Ue()) + 1;
  result.progressive = bits.Read(1) != 0;
  if (!result.progressive) bits.Read(1);
  bits.Read(1);
  std::uint64_t cropX = 0;
  std::uint64_t cropY = 0;
  if (bits.Read(1)) {
    const auto left = static_cast<std::uint64_t>(bits.Ue()) * 2;
    const auto right = static_cast<std::uint64_t>(bits.Ue()) * 2;
    const auto top = static_cast<std::uint64_t>(bits.Ue()) * (result.progressive ? 2 : 4);
    const auto bottom = static_cast<std::uint64_t>(bits.Ue()) * (result.progressive ? 2 : 4);
    cropX = left + right;
    cropY = top + bottom;
    if (left > 8192 || top > 8192) throw std::runtime_error("Invalid H264 crop origin");
    result.cropLeft = static_cast<std::uint32_t>(left);
    result.cropTop = static_cast<std::uint32_t>(top);
  }
  const auto codedWidth = widthMbs * 16;
  const auto codedHeight = heightMapUnits * (result.progressive ? 16 : 32);
  if (codedWidth > 8192 || codedHeight > 8192 || cropX >= codedWidth || cropY >= codedHeight) {
    throw std::runtime_error("Invalid H264 coded dimensions/cropping");
  }
  result.width = static_cast<std::uint32_t>(codedWidth - cropX);
  result.height = static_cast<std::uint32_t>(codedHeight - cropY);
  result.codedWidth = static_cast<std::uint32_t>(codedWidth);
  result.codedHeight = static_cast<std::uint32_t>(codedHeight);
  if (bits.Read(1)) {
    if (bits.Read(1) && bits.Read(8) == 255) { bits.Read(16); bits.Read(16); }
    if (bits.Read(1)) bits.Read(1);
    if (bits.Read(1)) {
      bits.Read(3);
      result.fullRange = bits.Read(1) != 0;
      if (bits.Read(1)) {
        result.colorPrimaries = static_cast<std::uint8_t>(bits.Read(8));
        result.transferCharacteristics = static_cast<std::uint8_t>(bits.Read(8));
        result.matrixCoefficients = static_cast<std::uint8_t>(bits.Read(8));
      }
    }
  }
  return result;
}

H264Sps ParseBaselineSps(std::span<const std::uint8_t> nal) {
  auto sps = ParseH264Sps(nal);
  if (!MatchesH264Profile(sps, H264Profile::Baseline)) {
    throw std::runtime_error("The encoder changed the requested H264 Baseline profile");
  }
  return sps;
}

H264Bitstream::H264Bitstream(std::uint32_t width, std::uint32_t height, std::uint8_t level,
                             H264Profile profile, H264LevelPolicy levelPolicy)
    : width_(width), height_(height), level_(level), profile_(profile), levelPolicy_(levelPolicy) {}

std::vector<std::span<const std::uint8_t>> H264Bitstream::Split(std::span<const std::uint8_t> bytes) const {
  if (bytes.empty() || bytes.size() > maxAccessUnitBytes) throw std::runtime_error("Invalid H264 output size");
  std::vector<std::span<const std::uint8_t>> nals;
  // An AVC length such as 00 00 01 00 is not an Annex B start code.
  if (!avcConfiguration_ && StartCode(bytes, 0)) {
    std::size_t position = 0;
    while (position < bytes.size()) {
      const auto prefix = StartCode(bytes, position);
      if (!prefix) throw std::runtime_error("Malformed Annex B stream");
      const auto begin = position + prefix;
      position = begin;
      while (position < bytes.size() && !StartCode(bytes, position)) ++position;
      auto end = position;
      while (end > begin && bytes[end - 1] == 0) --end;
      if (end == begin) throw std::runtime_error("Empty Annex B NAL");
      if (nals.size() == 4096) throw std::runtime_error("Too many H264 NALs in an access unit");
      nals.push_back(bytes.subspan(begin, end - begin));
    }
  } else {
    std::size_t position = 0;
    while (position < bytes.size()) {
      if (bytes.size() - position < lengthBytes_) throw std::runtime_error("Truncated H264 NAL length");
      std::uint32_t size = 0;
      for (unsigned i = 0; i < lengthBytes_; ++i) size = (size << 8) | bytes[position++];
      if (!size || size > bytes.size() - position) throw std::runtime_error("Invalid H264 NAL length");
      if (nals.size() == 4096) throw std::runtime_error("Too many H264 NALs in an access unit");
      nals.push_back(bytes.subspan(position, size));
      position += size;
    }
  }
  for (const auto nal : nals) Type(nal);
  return nals;
}

void H264Bitstream::Remember(std::span<const std::uint8_t> nal) {
  if (nal.size() > maxParameterBytes) throw std::runtime_error("H264 parameter set is too large");
  if (Type(nal) == 7) {
    auto sps = ParseH264Sps(nal);
    const bool levelMatches = levelPolicy_ == H264LevelPolicy::Exact
        ? sps.levelIdc == level_
        : sps.levelIdc <= level_ && H264LevelMaxBitrate(sps.levelIdc) > 0;
    if (!sps.progressive || sps.width != width_ || sps.height != height_ ||
        !levelMatches || !MatchesH264Profile(sps, profile_)) {
      throw std::runtime_error("SPS profile/level/geometry does not match the requested encoder mode");
    }
    sps_ = sps;
    spsById_[sps.id] = {nal.begin(), nal.end()};
    verified_ = true;
  } else if (Type(nal) == 8) {
    Bits bits(nal);
    const auto ppsId = bits.Ue();
    const auto spsId = bits.Ue();
    if (ppsId > 255 || spsId > 31) throw std::runtime_error("Invalid PPS identifiers");
    if (bits.Read(1) && profile_ != H264Profile::Main && profile_ != H264Profile::AnySupported) {
      throw std::runtime_error("CABAC is not permitted in H264 Baseline");
    }
    ppsById_[ppsId] = {nal.begin(), nal.end()};
  }
  std::size_t total = 0;
  for (const auto& [id, bytes] : spsById_) total += bytes.size();
  for (const auto& [id, bytes] : ppsById_) total += bytes.size();
  if (total > maxParameterBytes) throw std::runtime_error("H264 parameter-set cache exceeds its limit");
}

void H264Bitstream::SetSequenceHeader(std::span<const std::uint8_t> bytes) {
  if (bytes.empty()) return;
  if (bytes.size() > maxParameterBytes) throw std::runtime_error("H264 sequence header exceeds its limit");
  if (bytes[0] != 1) {
    avcConfiguration_ = false;
    for (const auto nal : Split(bytes)) Remember(nal);
    return;
  }
  if (bytes.size() < 7) throw std::runtime_error("Truncated AVC configuration");
  const unsigned lengthBytes = (bytes[4] & 3) + 1;
  if (lengthBytes == 3) throw std::runtime_error("Unsupported AVC NAL length width");
  std::size_t offset = 6;
  const auto readSets = [&](unsigned count, unsigned expectedType) {
    for (unsigned i = 0; i < count; ++i) {
      if (offset + 2 > bytes.size()) throw std::runtime_error("Truncated AVC parameter length");
      const auto size = (static_cast<unsigned>(bytes[offset]) << 8) | bytes[offset + 1];
      offset += 2;
      if (!size || size > bytes.size() - offset) throw std::runtime_error("Truncated AVC parameter set");
      const auto nal = bytes.subspan(offset, size);
      if (Type(nal) != expectedType) throw std::runtime_error("Unexpected AVC parameter-set type");
      Remember(nal);
      offset += size;
    }
  };
  if (!(bytes[5] & 31)) throw std::runtime_error("Missing AVC SPS");
  readSets(bytes[5] & 31, 7);
  if (offset == bytes.size()) throw std::runtime_error("Missing AVC PPS count");
  const auto count = bytes[offset++];
  if (!count) throw std::runtime_error("Missing AVC PPS");
  readSets(count, 8);
  if (offset != bytes.size()) throw std::runtime_error("Unexpected trailing Baseline/Main AVC configuration data");
  lengthBytes_ = lengthBytes;
  avcConfiguration_ = true;
}

H264AccessUnit H264Bitstream::Convert(std::span<const std::uint8_t> bytes) {
  const auto nals = Split(bytes);
  H264AccessUnit result;
  for (const auto nal : nals) {
    const auto type = Type(nal);
    if (type == 7 || type == 8) Remember(nal);
    if (type == 1 || type == 5) {
      Bits slice(nal);
      const auto firstMb = slice.Ue();
      if ((!result.hasPicture && firstMb != 0) || (result.hasPicture && firstMb == 0)) {
        throw std::runtime_error("Output must contain exactly one complete H264 picture");
      }
      const auto sliceType = slice.Ue();
      const auto ppsId = slice.Ue();
      if (sliceType > 9 || (sliceType % 5 != 0 && sliceType % 5 != 2) ||
          (type == 5 && sliceType % 5 != 2)) {
        throw std::runtime_error("Only I/P slices and intra IDR pictures are supported; B slices are forbidden");
      }
      const auto pps = ppsById_.find(ppsId);
      if (pps == ppsById_.end()) throw std::runtime_error("H264 picture references an unknown PPS");
      Bits ppsBits(pps->second);
      ppsBits.Ue();
      const auto referencedSps = spsById_.find(ppsBits.Ue());
      if (referencedSps == spsById_.end()) throw std::runtime_error("H264 PPS references an unknown SPS");
      sps_ = ParseH264Sps(referencedSps->second);
      if (ppsBits.Read(1) && sps_.profileIdc != 77) {
        throw std::runtime_error("CABAC PPS requires the explicitly supported Main profile");
      }
      if (result.hasPicture && result.keyFrame != (type == 5)) {
        throw std::runtime_error("Output mixes IDR and non-IDR slices");
      }
      result.hasPicture = true;
      result.keyFrame = result.keyFrame || type == 5;
    }
  }
  if (!result.hasPicture) return result;
  if (!verified_ || spsById_.empty() || ppsById_.empty()) {
    throw std::runtime_error("Cannot emit H264 without verified SPS/PPS");
  }
  for (const auto nal : nals) if (Type(nal) == 9) Append(result.data, nal);
  if (result.keyFrame) {
    for (const auto& [id, nal] : spsById_) Append(result.data, nal);
    for (const auto& [id, nal] : ppsById_) Append(result.data, nal);
  }
  for (const auto nal : nals) {
    const auto type = Type(nal);
    if (type != 9 && !(result.keyFrame && (type == 7 || type == 8))) Append(result.data, nal);
  }
  return result;
}

}  // namespace monky::screen_video
