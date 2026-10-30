#pragma once

// What each encoded codec (H.264 or AV1) admits: the source geometry, the receiver formats and levels, and the
// access units the capture host sends. The encoded source (encoded_video.cc) and its device-free checks share it.

#include "encoded_video.h"
#include "annex_b.h"
#include "av1_levels.h"
#include "h264_bitstream.h"
#include "codec_policy.h"

#include <algorithm>
#include <optional>
#include <span>
#include <string>

namespace monky::native_rtc::engine::encoded {

namespace sv = monky::screen_video;
namespace policy = monky::native_rtc::codec_policy;

inline void Require(bool condition, const char* message, MonkyEngineStatus status = MONKY_ENGINE_INVALID) {
  if (!condition) throw Error("ERR_RTC_ENCODED_INPUT", message, status);
}

struct EncodedConfiguration {
  std::uint32_t width = 1920, height = 1080, fps = 120;
  bool av1 = false;
};

inline std::uint8_t Av1ReceiveLevel(const webrtc::SdpVideoFormat& format) {
  Require(policy::IsScreenAv1Format(format), "Invalid AV1 receive format");
  const auto found = format.parameters.find("level-idx");
  return found == format.parameters.end() ? 5 : static_cast<std::uint8_t>(std::stoi(found->second));
}

// The lowest level a receiver needs for this geometry and frame rate; the sequence's real level is known only once
// admitted (State::Serves).
inline std::uint8_t MinimumAv1Level(const EncodedConfiguration& video) {
  const std::uint64_t pixels = std::uint64_t{video.width} * video.height;
  for (const auto& limit : sv::kAv1Levels)
    if (pixels <= limit.pictureSize && pixels * video.fps <= limit.displayRate) return limit.index;
  throw Error("ERR_RTC_ENCODED_LEVEL", "AV1 source exceeds the supported screen levels", MONKY_ENGINE_UNSUPPORTED);
}

inline std::uint8_t MinimumEncodedLevel(const EncodedConfiguration& video) {
  // Level5.1 covers every admitted bitrate (up to 80Mbps), even after feedback
  // raises it. Only geometry/rate can require a higher level within this product.
  return (std::max)(std::uint8_t{51},
      sv::RequiredH264Level(video.width, video.height, video.fps, kEncodedBitrateCeiling));
}

inline std::optional<policy::NegotiatedH264> ParseEncodedFormat(const webrtc::SdpVideoFormat& format) {
  auto negotiated = format;
  const auto maximum = negotiated.parameters.find("max-recv-level");
  const bool extended = maximum != negotiated.parameters.end();
  std::string receive_level;
  if (extended) {
    receive_level = maximum->second;
    negotiated.parameters.erase(maximum);
  }
  auto parsed = policy::ParseFormat(negotiated, kEncodedH264Level);
  if (!parsed || parsed->profile != sv::H264Profile::Main) return std::nullopt;
  if (!receive_level.empty()) {
    if (receive_level.size() != 4 ||
        !std::all_of(receive_level.begin(), receive_level.end(), [](unsigned char c) {
          return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
        })) return std::nullopt;
    const auto default_level = parsed->level;
    negotiated.parameters["profile-level-id"] = "4d" + receive_level;
    parsed = policy::ParseFormat(negotiated, kEncodedH264Level);
    if (!parsed || parsed->profile != sv::H264Profile::Main || parsed->level <= default_level) return std::nullopt;
  } else if (extended) {
    return std::nullopt;
  }
  return parsed;
}

inline bool AcceptsEncodedFormat(const webrtc::SdpVideoFormat& format,
                                 std::uint8_t minimum_level = kEncodedH264Level) {
  const auto parsed = ParseEncodedFormat(format);
  return parsed && parsed->level >= minimum_level;
}

// The level a receiver negotiated with this format, when a source of this codec can send to that receiver at all.
inline std::optional<std::uint8_t> ReceiverLevel(const webrtc::SdpVideoFormat& format, bool av1) {
  if (av1) return policy::IsScreenAv1Format(format) ? std::optional(Av1ReceiveLevel(format)) : std::nullopt;
  const auto parsed = ParseEncodedFormat(format);
  return parsed ? std::optional(parsed->level) : std::nullopt;
}

inline EncodedConfiguration ParseConfiguration(const Json& options) {
  const auto integer = [&](const char* key, std::uint32_t minimum, std::uint32_t maximum) {
    Require(options.contains(key) && options.at(key).is_number_integer() &&
        options.at(key) >= minimum && options.at(key) <= maximum, "Invalid encoded video configuration");
    return options.at(key).get<std::uint32_t>();
  };
  EncodedConfiguration value{integer("width", 2, 3840), integer("height", 2, 2160), integer("fps", 1, 240)};
  Require(value.width % 2 == 0 && value.height % 2 == 0, "H264 NV12 dimensions must be even");
  Require((value.width < 3840 && value.height < 2160) || value.fps <= 120, "4K exceeds the 120 FPS capture budget");
  return value;
}

inline void ValidateEncodedLevel(const sv::H264Sps& sps, const EncodedConfiguration& video) {
  if (sv::RequiredH264Level(sps.codedWidth, sps.codedHeight, video.fps, 64000) > sps.levelIdc ||
      sps.levelIdc > MinimumEncodedLevel(video))
    throw Error("ERR_RTC_ENCODED_LEVEL",
        "Actual H264 SPS level must describe the source and fit its advertised level", MONKY_ENGINE_INVALID);
}

inline void ParameterOrder(std::span<const std::uint8_t> bytes) {
  Require(sv::AnnexBStartCode(bytes, 0) != 0, "External input must be Annex B, not AVCC or raw pixels");
  bool picture = false;
  const auto walked = sv::ForEachAnnexBNal(bytes, 4096, [&](std::span<const std::uint8_t> nal) {
    const auto type = nal[0] & 31;
    Require(type == 1 || type == 5 || type == 6 || type == 7 || type == 8 || type == 9 ||
        type == 10 || type == 11 || type == 12, "Unsupported external H264 NAL type");
    Require(!picture || (type != 7 && type != 8 && type != 9),
        "Parameter sets/AUD after VCL would change the picture's decoding order");
    picture = picture || type == 1 || type == 5;
  });
  Require(walked == sv::AnnexBError::kNone, "Malformed or excessive Annex B NALs");
}

inline sv::H264AccessUnit Normalize(sv::H264Bitstream& stream, const MonkyEngineEncodedFrame& frame) {
  ValidateEncodedFrame(frame);
  ParameterOrder({frame.data, frame.data_bytes});
  auto candidate = stream;
  sv::H264AccessUnit packet;
  try {
    packet = candidate.Convert({frame.data, frame.data_bytes});
    Require(packet.hasPicture && packet.keyFrame == (frame.keyframe != 0),
        "The packet keyframe flag must match one complete I/P picture");
    const auto& sps = candidate.Sps();
    if (!sv::IsBt709LimitedCompatible(sps)) {
      const auto field = [](std::optional<std::uint8_t> value) {
        return value ? std::to_string(*value) : std::string("absent");
      };
      throw Error("ERR_RTC_ENCODED_COLOR",
          "External H264 must retain the admitted BT.709 limited-range mode: fullRange=" +
          (sps.fullRange ? std::to_string(*sps.fullRange) : std::string("absent")) +
          ", primaries=" + field(sps.colorPrimaries) + ", transfer=" + field(sps.transferCharacteristics) +
          ", matrix=" + field(sps.matrixCoefficients), MONKY_ENGINE_INVALID);
    }
    Require(packet.data.size() <= kEncodedMaximumPacket, "Current SPS/PPS plus AU exceed the packet bound");
  } catch (const Error&) { throw; }
  catch (const std::exception& error) {
    throw Error("ERR_RTC_ENCODED_H264", error.what(), MONKY_ENGINE_INVALID);
  }
  stream = std::move(candidate);
  return packet;
}

}  // namespace monky::native_rtc::engine::encoded
