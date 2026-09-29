#include "codec_policy.h"
#include "api/video_codecs/h264_profile_level_id.h"
#include <algorithm>

namespace monky::native_rtc::codec_policy {
namespace {
namespace sv = ::monky::screen_video;
void RequireSingleLayer(const webrtc::SimulcastStream& layer, const webrtc::VideoCodec& codec) {
  if (layer.numberOfTemporalLayers != 1 ||
      (layer.width && layer.width != codec.width) ||
      (layer.height && layer.height != codec.height) ||
      (layer.maxFramerate && layer.maxFramerate != codec.maxFramerate))
    throw AdapterError("ERR_RTC_SPATIAL_MODE",
        "Only one unscaled spatial/temporal layer is implemented",
        WEBRTC_VIDEO_CODEC_ERR_SIMULCAST_PARAMETERS_NOT_SUPPORTED);
}
}

bool IsSupportedLevel(std::uint8_t level) {
  switch (level) {
    case 31: case 32: case 40: case 41:
    case 42: case 50: case 51: case 52: case 60: return true;
    default: return false;
  }
}
std::optional<NegotiatedH264> ParseFormat(
    const webrtc::SdpVideoFormat& format, std::uint8_t maximum_level) {
  const auto& name = format.name;
  if (name.size() != 4 || (name[0] != 'H' && name[0] != 'h') ||
      name[1] != '2' || name[2] != '6' || name[3] != '4') return std::nullopt;
  for (const auto mode : format.scalability_modes)
    if (mode != webrtc::ScalabilityMode::kL1T1) return std::nullopt;
  std::string profile = "42e01f";
  bool packetization_one = false;
  for (const auto& [key, value] : format.parameters) {
    if (key == "profile-level-id") {
      if (value.size() != 6) return std::nullopt;
      profile = value;
    } else if (key == "packetization-mode") {
      if (value != "1") return std::nullopt;
      packetization_one = true;
    } else if (key == "level-asymmetry-allowed") {
      if (value != "0" && value != "1") return std::nullopt;
    } else if (key == "x-google-start-bitrate" || key == "x-google-min-bitrate" ||
               key == "x-google-max-bitrate") {
      if (value.empty() || value.size() > 9 ||
          !std::all_of(value.begin(), value.end(), [](char c) { return c >= '0' && c <= '9'; }))
        return std::nullopt;
    } else return std::nullopt;
  }
  if (!packetization_one || profile.size() != 6 ||
      !std::all_of(profile.begin(), profile.end(), [](char c) {
        return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
      })) return std::nullopt;
  const auto parsed = webrtc::ParseH264ProfileLevelId(profile.c_str());
  if (!parsed || (parsed->profile != webrtc::H264Profile::kProfileConstrainedBaseline &&
                  parsed->profile != webrtc::H264Profile::kProfileMain) ||
      profile[0] != '4' || (profile[1] != '2' && profile[1] != 'd' && profile[1] != 'D'))
    return std::nullopt;
  const auto level = static_cast<std::uint8_t>(parsed->level);
  if (!IsSupportedLevel(level) || level > maximum_level) return std::nullopt;
  const auto raw = sv::ParseProfileLevelId(profile);
  if (parsed->profile == webrtc::H264Profile::kProfileConstrainedBaseline &&
      raw.profileIdc == 66 && (raw.compatibility & 0x40))
    return NegotiatedH264{sv::H264Profile::ConstrainedBaseline, level};
  if (parsed->profile == webrtc::H264Profile::kProfileMain && raw.profileIdc == 77)
    return NegotiatedH264{sv::H264Profile::Main, level};
  return std::nullopt;
}
std::vector<webrtc::SdpVideoFormat> SupportedFormats(std::uint8_t maximum_level) {
  std::vector<webrtc::SdpVideoFormat> formats;
  for (const auto profile : {webrtc::H264Profile::kProfileConstrainedBaseline, webrtc::H264Profile::kProfileMain}) {
    const auto text = webrtc::H264ProfileLevelIdToString({profile, static_cast<webrtc::H264Level>(maximum_level)});
    if (!text) throw AdapterError("ERR_RTC_SDP", "Unsupported H264 maximum level");
    formats.emplace_back("H264", webrtc::CodecParameterMap{
        {"profile-level-id", *text}, {"packetization-mode", "1"}, {"level-asymmetry-allowed", "1"}});
    formats.back().scalability_modes.push_back(webrtc::ScalabilityMode::kL1T1);
  }
  return formats;
}
webrtc::ColorSpace Bt709Limited() {
  return {webrtc::ColorSpace::PrimaryID::kBT709, webrtc::ColorSpace::TransferID::kBT709,
          webrtc::ColorSpace::MatrixID::kBT709, webrtc::ColorSpace::RangeID::kLimited};
}
bool IsBt709Limited(const webrtc::ColorSpace& color) {
  return (color.primaries() == webrtc::ColorSpace::PrimaryID::kBT709 ||
          color.primaries() == webrtc::ColorSpace::PrimaryID::kUnspecified) &&
         (color.transfer() == webrtc::ColorSpace::TransferID::kBT709 ||
          color.transfer() == webrtc::ColorSpace::TransferID::kUnspecified) &&
         (color.matrix() == webrtc::ColorSpace::MatrixID::kBT709 ||
          color.matrix() == webrtc::ColorSpace::MatrixID::kUnspecified) &&
         (color.range() == webrtc::ColorSpace::RangeID::kLimited ||
          color.range() == webrtc::ColorSpace::RangeID::kInvalid) && !color.hdr_metadata();
}
EncoderSetup MakeEncoderSetup(const webrtc::VideoCodec& codec,
    const webrtc::VideoEncoder::Settings& settings, NegotiatedH264 negotiated,
    std::uint32_t maximum_in_flight) {
  if (codec.codecType != webrtc::kVideoCodecH264 ||
      codec.width < 16 || codec.height < 16 || codec.width > 4096 || codec.height > 4096 ||
      ((codec.width | codec.height) & 1) || codec.maxFramerate == 0 || codec.maxFramerate > 240 ||
      settings.number_of_cores <= 0 || settings.max_payload_size == 0 ||
      static_cast<std::uint64_t>(codec.width) * codec.height * 3 / 2 * maximum_in_flight > 256ull * 1024 * 1024)
    throw AdapterError("ERR_RTC_ENCODER_CONFIGURATION",
        "Invalid H264 geometry, framerate, settings, or GPU budget");
  if (codec.numberOfSimulcastStreams > 1 || codec.legacy_conference_mode ||
      codec.H264().numberOfTemporalLayers != 1 ||
      (codec.GetScalabilityMode() && codec.GetScalabilityMode() != webrtc::ScalabilityMode::kL1T1))
    throw AdapterError("ERR_RTC_SPATIAL_MODE",
        "Simulcast, SVC, and temporal layering are not implemented",
        WEBRTC_VIDEO_CODEC_ERR_SIMULCAST_PARAMETERS_NOT_SUPPORTED);
  if (codec.numberOfSimulcastStreams == 1) RequireSingleLayer(codec.simulcastStream[0], codec);
  RequireSingleLayer(codec.spatialLayers[0], codec);
  for (std::size_t i = 1; i < webrtc::kMaxSpatialLayers; ++i) {
    const auto& layer = codec.spatialLayers[i];
    if (layer.active || layer.width || layer.height || layer.maxBitrate || layer.targetBitrate)
      throw AdapterError("ERR_RTC_SPATIAL_MODE", "Additional spatial layers are unsupported",
          WEBRTC_VIDEO_CODEC_ERR_SIMULCAST_PARAMETERS_NOT_SUPPORTED);
  }
  const std::uint64_t start = static_cast<std::uint64_t>(codec.startBitrate) * 1000;
  const std::uint64_t maximum = static_cast<std::uint64_t>(codec.maxBitrate) * 1000;
  const std::uint64_t minimum = static_cast<std::uint64_t>(codec.minBitrate) * 1000;
  const auto negotiated_maximum = sv::H264LevelMaxBitrate(negotiated.level);
  if ((start && start < 64000) || (maximum && maximum < 64000) || start > negotiated_maximum ||
      maximum > negotiated_maximum || (maximum && (start > maximum || minimum > maximum)) ||
      minimum > negotiated_maximum || codec.H264().keyFrameInterval < 0) {
    const auto message = "Unsupported initial H264 bitrate/interval: start=" + std::to_string(start) +
        ", min=" + std::to_string(minimum) + ", max=" + std::to_string(maximum) +
        ", negotiatedMax=" + std::to_string(negotiated_maximum) +
        ", keyframeInterval=" + std::to_string(codec.H264().keyFrameInterval);
    throw AdapterError("ERR_RTC_ENCODER_BITRATE", message.c_str());
  }
  EncoderSetup result;
  const auto reserve = static_cast<std::uint32_t>((std::max)({std::uint64_t{64000}, start, maximum}));
  const auto level = sv::RequiredH264Level(codec.width, codec.height, codec.maxFramerate, reserve);
  if (level > negotiated.level)
    throw AdapterError("ERR_RTC_ENCODER_LEVEL", "Geometry/rate exceeds the negotiated H264 level");
  result.core = {codec.width, codec.height, codec.maxFramerate, reserve,
    maximum_in_flight, level, negotiated.profile};
  result.initial_bitrate = codec.active ? static_cast<std::uint32_t>(start) : 0;
  if (codec.numberOfSimulcastStreams == 1 && !codec.simulcastStream[0].active) result.initial_bitrate = 0;
  result.maximum_bitrate = maximum ? static_cast<std::uint32_t>(maximum) : sv::H264LevelMaxBitrate(level);
  result.keyframe_interval = static_cast<std::uint32_t>(codec.H264().keyFrameInterval);
  result.content_type = codec.mode == webrtc::VideoCodecMode::kScreensharing
      ? webrtc::VideoContentType::SCREENSHARE : webrtc::VideoContentType::UNSPECIFIED;
  return result;
}
}
