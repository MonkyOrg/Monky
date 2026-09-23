#include "mf_rtc_internal.h"

#include <algorithm>
#include <cmath>
#include <limits>

namespace monky::native_rtc::mf::detail {
namespace {

constexpr std::uint64_t kMaximumTimestampUs = 9007199254740991ull;

bool IsH264Name(const std::string& name) {
  return name.size() == 4 && (name[0] == 'H' || name[0] == 'h') &&
         name[1] == '2' && name[2] == '6' && name[3] == '4';
}

std::size_t StartCode(std::span<const std::uint8_t> bytes, std::size_t at) {
  if (bytes.size() - at < 3 || bytes[at] || bytes[at + 1]) return 0;
  if (bytes[at + 2] == 1) return 3;
  return bytes.size() - at >= 4 && bytes[at + 2] == 0 && bytes[at + 3] == 1
      ? 4 : 0;
}

bool SameSpsMode(const sv::H264Sps& a, const sv::H264Sps& b) {
  return a.ProfileLevelId() == b.ProfileLevelId() &&
         a.width == b.width && a.height == b.height &&
         a.codedWidth == b.codedWidth && a.codedHeight == b.codedHeight &&
         a.cropLeft == b.cropLeft && a.cropTop == b.cropTop;
}

void RequireSingleLayer(const webrtc::SimulcastStream& layer,
                        const webrtc::VideoCodec& codec) {
  if (layer.numberOfTemporalLayers != 1 ||
      (layer.width && layer.width != codec.width) ||
      (layer.height && layer.height != codec.height) ||
      (layer.maxFramerate && layer.maxFramerate != codec.maxFramerate)) {
    throw AdapterError("ERR_RTC_SPATIAL_MODE",
                       "Only one unscaled spatial/temporal layer is implemented",
                       WEBRTC_VIDEO_CODEC_ERR_SIMULCAST_PARAMETERS_NOT_SUPPORTED);
  }
}

}  // namespace

bool IsSupportedLevel(std::uint8_t level) {
  switch (level) {
    case 31: case 32: case 40: case 41:
    case 42: case 50: case 51: case 52: return true;
    default: return false;
  }
}

void ValidateOptions(const AdapterOptions& options) {
  if (!IsSupportedLevel(options.maximum_h264_level) ||
      options.maximum_workers == 0 || options.maximum_workers > 32 ||
      options.maximum_in_flight < 2 || options.maximum_in_flight > 16 ||
      options.maximum_pending_frames < 2 || options.maximum_pending_frames > 128 ||
      options.maximum_pending_encoded_bytes < kMaximumAccessUnitBytes ||
      options.maximum_pending_encoded_bytes > 32 * 1024 * 1024 ||
      options.maximum_native_buffers < options.maximum_in_flight ||
      options.maximum_native_buffers > 256 ||
      options.decoder_fps == 0 || options.decoder_fps > 240 ||
      options.decoder_bitrate_bps < 64000 ||
      options.decoder_bitrate_bps > sv::H264LevelMaxBitrate(options.maximum_h264_level) ||
      options.operation_timeout < std::chrono::milliseconds(1) ||
      options.operation_timeout > std::chrono::seconds(60)) {
    throw AdapterError("ERR_RTC_OPTIONS", "Invalid bounded MF adapter options");
  }
}

std::optional<NegotiatedH264> ParseFormat(
    const webrtc::SdpVideoFormat& format, std::uint8_t maximum_level) {
  if (!IsH264Name(format.name)) return std::nullopt;
  for (const auto mode : format.scalability_modes) {
    if (mode != webrtc::ScalabilityMode::kL1T1) return std::nullopt;
  }
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
      // WebRTC applies these advisory values to VideoCodec/SetRates.
      if (value.empty() || value.size() > 9 ||
          !std::all_of(value.begin(), value.end(),
                       [](char c) { return c >= '0' && c <= '9'; })) return std::nullopt;
    } else {
      return std::nullopt;
    }
  }
  if (!packetization_one || profile.size() != 6 ||
      !std::all_of(profile.begin(), profile.end(), [](char c) {
        return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') ||
               (c >= 'A' && c <= 'F');
      })) return std::nullopt;
  const auto parsed = webrtc::ParseH264ProfileLevelId(profile.c_str());
  if (!parsed) return std::nullopt;
  if ((parsed->profile != webrtc::H264Profile::kProfileConstrainedBaseline &&
       parsed->profile != webrtc::H264Profile::kProfileMain) ||
      profile[0] != '4' ||
      (profile[1] != '2' && profile[1] != 'd' && profile[1] != 'D')) return std::nullopt;
  const auto level = static_cast<std::uint8_t>(parsed->level);
  if (!IsSupportedLevel(level) || level > maximum_level) return std::nullopt;
  const auto raw = sv::ParseProfileLevelId(profile);
  if (parsed->profile == webrtc::H264Profile::kProfileConstrainedBaseline &&
      raw.profileIdc == 66 && (raw.compatibility & 0x40)) {
    return NegotiatedH264{sv::H264Profile::ConstrainedBaseline, level};
  }
  if (parsed->profile == webrtc::H264Profile::kProfileMain && raw.profileIdc == 77) {
    return NegotiatedH264{sv::H264Profile::Main, level};
  }
  return std::nullopt;
}

std::vector<webrtc::SdpVideoFormat> SupportedFormats(std::uint8_t maximum_level) {
  std::vector<webrtc::SdpVideoFormat> formats;
  for (const auto profile : {webrtc::H264Profile::kProfileConstrainedBaseline,
                            webrtc::H264Profile::kProfileMain}) {
    const auto text = webrtc::H264ProfileLevelIdToString(
        {profile, static_cast<webrtc::H264Level>(maximum_level)});
    if (!text) throw AdapterError("ERR_RTC_SDP", "Unsupported H264 maximum level");
    formats.emplace_back("H264", webrtc::CodecParameterMap{
        {"profile-level-id", *text}, {"packetization-mode", "1"},
        {"level-asymmetry-allowed", "1"}});
    formats.back().scalability_modes.push_back(webrtc::ScalabilityMode::kL1T1);
  }
  return formats;
}

webrtc::ColorSpace Bt709Limited() {
  return {webrtc::ColorSpace::PrimaryID::kBT709,
          webrtc::ColorSpace::TransferID::kBT709,
          webrtc::ColorSpace::MatrixID::kBT709,
          webrtc::ColorSpace::RangeID::kLimited};
}

bool IsBt709Limited(const webrtc::ColorSpace& color) {
  return (color.primaries() == webrtc::ColorSpace::PrimaryID::kBT709 ||
          color.primaries() == webrtc::ColorSpace::PrimaryID::kUnspecified) &&
         (color.transfer() == webrtc::ColorSpace::TransferID::kBT709 ||
          color.transfer() == webrtc::ColorSpace::TransferID::kUnspecified) &&
         (color.matrix() == webrtc::ColorSpace::MatrixID::kBT709 ||
          color.matrix() == webrtc::ColorSpace::MatrixID::kUnspecified) &&
         (color.range() == webrtc::ColorSpace::RangeID::kLimited ||
          color.range() == webrtc::ColorSpace::RangeID::kInvalid) &&
         !color.hdr_metadata();
}

EncoderSetup MakeEncoderSetup(const webrtc::VideoCodec& codec,
                             const webrtc::VideoEncoder::Settings& settings,
                             NegotiatedH264 negotiated,
                             const AdapterOptions& options) {
  if (codec.codecType != webrtc::kVideoCodecH264 ||
      codec.width < 16 || codec.height < 16 ||
      codec.width > 4096 || codec.height > 4096 ||
      ((codec.width | codec.height) & 1) ||
      codec.maxFramerate == 0 || codec.maxFramerate > 240 ||
      settings.number_of_cores <= 0 || settings.max_payload_size == 0 ||
      static_cast<std::uint64_t>(codec.width) * codec.height * 3 / 2 *
          options.maximum_in_flight > 256ull * 1024 * 1024) {
    throw AdapterError("ERR_RTC_ENCODER_CONFIGURATION",
                       "Invalid H264 geometry, framerate, settings, or GPU budget");
  }
  if (codec.numberOfSimulcastStreams > 1 || codec.legacy_conference_mode ||
      codec.H264().numberOfTemporalLayers != 1 ||
      (codec.GetScalabilityMode() &&
       codec.GetScalabilityMode() != webrtc::ScalabilityMode::kL1T1)) {
    throw AdapterError("ERR_RTC_SPATIAL_MODE",
                       "Simulcast, SVC, and temporal layering are not implemented",
                       WEBRTC_VIDEO_CODEC_ERR_SIMULCAST_PARAMETERS_NOT_SUPPORTED);
  }
  if (codec.numberOfSimulcastStreams == 1) {
    RequireSingleLayer(codec.simulcastStream[0], codec);
  }
  RequireSingleLayer(codec.spatialLayers[0], codec);
  for (std::size_t i = 1; i < webrtc::kMaxSpatialLayers; ++i) {
    const auto& layer = codec.spatialLayers[i];
    if (layer.active || layer.width || layer.height || layer.maxBitrate ||
        layer.targetBitrate) {
      throw AdapterError("ERR_RTC_SPATIAL_MODE", "Additional spatial layers are unsupported",
                         WEBRTC_VIDEO_CODEC_ERR_SIMULCAST_PARAMETERS_NOT_SUPPORTED);
    }
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
  // Reserve the explicitly configured rate range before setting the live rate.
  // The qualified core requires its MINIMUM sufficient level, not the SDP ceiling.
  const auto reserve = static_cast<std::uint32_t>(
      (std::max)({std::uint64_t{64000}, start, maximum}));
  const auto level = sv::RequiredH264Level(
      codec.width, codec.height, codec.maxFramerate, reserve);
  if (level > negotiated.level) {
    throw AdapterError("ERR_RTC_ENCODER_LEVEL", "Geometry/rate exceeds the negotiated H264 level");
  }
  result.core.width = codec.width;
  result.core.height = codec.height;
  result.core.fps = codec.maxFramerate;
  result.core.bitrateBps = reserve;
  result.core.maxInFlight = options.maximum_in_flight;
  result.core.level = level;
  result.core.profile = negotiated.profile;
  result.initial_bitrate = codec.active ? static_cast<std::uint32_t>(start) : 0;
  if (codec.numberOfSimulcastStreams == 1 && !codec.simulcastStream[0].active) {
    result.initial_bitrate = 0;
  }
  result.maximum_bitrate = maximum ? static_cast<std::uint32_t>(maximum)
                                  : sv::H264LevelMaxBitrate(level);
  result.keyframe_interval = static_cast<std::uint32_t>(codec.H264().keyFrameInterval);
  result.content_type = codec.mode == webrtc::VideoCodecMode::kScreensharing
      ? webrtc::VideoContentType::SCREENSHARE : webrtc::VideoContentType::UNSPECIFIED;
  return result;
}

EncoderRates ValidateRates(
    const webrtc::VideoEncoder::RateControlParameters& parameters,
    const EncoderSetup& setup) {
  for (std::size_t spatial = 0; spatial < webrtc::kMaxSpatialLayers; ++spatial) {
    for (std::size_t temporal = 0; temporal < webrtc::kMaxTemporalStreams; ++temporal) {
      if ((spatial || temporal) &&
          (parameters.bitrate.GetBitrate(spatial, temporal) ||
           parameters.target_bitrate.GetBitrate(spatial, temporal))) {
        throw AdapterError("ERR_RTC_RATE_LAYERS", "Only L1T1 bitrate allocation is supported",
                           WEBRTC_VIDEO_CODEC_ERR_SIMULCAST_PARAMETERS_NOT_SUPPORTED);
      }
    }
  }
  const auto bitrate = parameters.bitrate.get_sum_bps();
  if ((bitrate && bitrate < 64000) || bitrate > setup.maximum_bitrate ||
      bitrate > sv::H264LevelMaxBitrate(setup.core.level)) {
    throw AdapterError("ERR_RTC_RATE_REQUIRES_INIT",
                       "Nonzero rates must be >=64000 and fit the initialized H264 rate range");
  }
  if (!std::isfinite(parameters.framerate_fps)) {
    throw AdapterError("ERR_RTC_FRAMERATE", "Framerate must be finite");
  }
  // M140 derives this target from input cadence; bursts may exceed InitEncode's
  // ceiling. Limit admission, not the reported cadence or the original PTS.
  const double fps = parameters.framerate_fps <= 0
      ? setup.core.fps : (std::min)(parameters.framerate_fps, static_cast<double>(setup.core.fps));
  constexpr long double maximum_interval_us = static_cast<long double>(kMaximumTimestampUs);
  if (!(fps > 0) || fps < 1000000.0L / maximum_interval_us) {
    throw AdapterError("ERR_RTC_FRAMERATE",
                       "Framerate must be positive and timestamp-representable");
  }
  return {bitrate, fps};
}

void SourceRateLimiter::SetFps(double fps) {
  interval_us_ = 1000000.0L / fps;
  next_due_us_ = last_accepted_us_
      ? std::optional<long double>(*last_accepted_us_ + interval_us_) : std::nullopt;
}

void SourceRateLimiter::Reset() {
  next_due_us_.reset();
  last_accepted_us_.reset();
}

bool SourceRateLimiter::Accept(std::int64_t timestamp_us) {
  if (timestamp_us < 0 || static_cast<std::uint64_t>(timestamp_us) > kMaximumTimestampUs ||
      (last_seen_us_ && timestamp_us <= *last_seen_us_)) {
    throw AdapterError("ERR_RTC_SOURCE_TIMESTAMP",
                       "Source GPU timestamps must be bounded, nonnegative, and strictly increasing");
  }
  last_seen_us_ = timestamp_us;
  const long double now = timestamp_us;
  // One frame of bounded scheduling credit absorbs source timestamp jitter.
  // Deadlines still accumulate; neither an early frame nor a drop resets them.
  if (next_due_us_ && now + interval_us_ + 1 < *next_due_us_) return false;
  const auto due = next_due_us_.value_or(now);
  next_due_us_ = (now > due + interval_us_ ? now : due) + interval_us_;
  last_accepted_us_ = timestamp_us;
  return true;
}

std::int64_t RtpTimeline::Push(std::uint32_t timestamp) {
  if (last_) {
    const auto delta = static_cast<std::uint32_t>(timestamp - *last_);
    if (!delta || delta >= 0x80000000u) {
      throw AdapterError("ERR_RTC_RTP_TIMESTAMP",
                         "Duplicate, reordered, or ambiguous RTP timestamp; I/P-only input required");
    }
    constexpr std::uint64_t maximum_ticks = kMaximumTimestampUs / 1000 * 90;
    if (ticks_ > maximum_ticks - delta) {
      throw AdapterError("ERR_RTC_RTP_TIMESTAMP", "RTP timeline exceeds qualified MF timestamp bounds");
    }
    ticks_ += delta;
  }
  last_ = timestamp;
  return static_cast<std::int64_t>(ticks_ / 90 * 1000 + ticks_ % 90 * 1000 / 90);
}

FenceObservation FenceNotification::Observe(
    std::uint64_t completed, std::uint64_t required, bool device_lost) {
  if (!required || required == UINT64_MAX)
    throw AdapterError("ERR_RTC_FENCE_VALUE", "A finite, nonzero fence value is required");
  if (device_lost || completed == UINT64_MAX) return FenceObservation::DeviceLost;
  if (completed >= required) {
    complete_ = true;
    return FenceObservation::Complete;
  }
  return FenceObservation::Pending;
}

bool FenceNotification::ShouldArm(SteadyClock::time_point now) const {
  return !complete_ && !armed_ && (!retry_at_ || now >= *retry_at_);
}

void FenceNotification::RecordArm(bool success, SteadyClock::time_point now) {
  armed_ = success;
  retry_at_ = now + kFenceRetryInterval;
}

std::uint32_t FenceNotification::WaitMilliseconds(SteadyClock::time_point now) const {
  if (complete_) return UINT32_MAX;
  // Armed events retain a sparse device-loss health check. An unsuccessful
  // registration must never inherit the expired diagnostic watchdog's INFINITE.
  if (armed_) return static_cast<std::uint32_t>(
      std::chrono::duration_cast<std::chrono::milliseconds>(kFenceHealthInterval).count());
  if (!retry_at_ || now >= *retry_at_) return 0;
  return static_cast<std::uint32_t>(
      std::chrono::ceil<std::chrono::milliseconds>(*retry_at_ - now).count());
}

bool FenceNotification::ReportArmFailure() {
  return !std::exchange(failure_reported_, true);
}

AccessUnitInfo InspectAccessUnit(std::span<const std::uint8_t> bytes) {
  if (bytes.empty() || bytes.size() > kMaximumAccessUnitBytes || !StartCode(bytes, 0)) {
    throw AdapterError("ERR_RTC_ANNEX_B", "A bounded, complete Annex B access unit is required");
  }
  AccessUnitInfo result;
  std::size_t position = 0, count = 0;
  while (position < bytes.size()) {
    const auto prefix = StartCode(bytes, position);
    if (!prefix || ++count > 4096) {
      throw AdapterError("ERR_RTC_ANNEX_B", "Malformed or excessive Annex B NAL units");
    }
    const auto begin = position + prefix;
    position = begin;
    while (position < bytes.size() && !StartCode(bytes, position)) ++position;
    auto end = position;
    while (end > begin && bytes[end - 1] == 0) --end;
    if (end == begin || (bytes[begin] & 0x80)) {
      throw AdapterError("ERR_RTC_ANNEX_B", "Invalid elementary H264 NAL header");
    }
    const auto type = bytes[begin] & 31;
    if (type == 1 || type == 5) {
      if (result.has_picture && result.keyframe != (type == 5)) {
        throw AdapterError("ERR_RTC_ANNEX_B", "Mixed IDR/non-IDR access unit");
      }
      result.has_picture = true;
      result.keyframe = type == 5;
    } else if (type == 7) {
      auto sps = sv::ParseH264Sps(bytes.subspan(begin, end - begin));
      if (result.sps && !SameSpsMode(*result.sps, sps)) {
        throw AdapterError("ERR_RTC_SPS", "Conflicting SPS modes in one access unit");
      }
      result.sps = std::move(sps);
    } else if (type != 6 && type != 8 && type != 9 && type != 10 &&
               type != 11 && type != 12) {
      throw AdapterError("ERR_RTC_NAL_MODE",
                         "SVC/MVC, partitioned slices, and RTP fragments are unsupported");
    }
  }
  if (!result.has_picture) {
    throw AdapterError("ERR_RTC_EMPTY_PICTURE", "An access unit must contain a real picture");
  }
  return result;
}

void ValidateSps(const sv::H264Sps& sps, NegotiatedH264 negotiated,
                 std::uint32_t maximum_width, std::uint32_t maximum_height) {
  if (!sps.progressive || sps.width < 16 || sps.height < 16 ||
      sps.width > maximum_width || sps.height > maximum_height ||
      ((sps.width | sps.height | sps.cropLeft | sps.cropTop) & 1) ||
      !IsSupportedLevel(sps.levelIdc) || sps.levelIdc > negotiated.level ||
      !sv::MatchesH264Profile(sps, negotiated.profile) ||
      (sps.profileIdc == 66 && !(sps.compatibility & 0x40)) ||
      !sv::IsBt709LimitedCompatible(sps)) {
    throw AdapterError("ERR_RTC_NEGOTIATED_SPS",
                       "Actual SPS violates negotiated profile/level, geometry, or BT.709-limited input");
  }
  const auto actual = webrtc::ParseH264ProfileLevelId(sps.ProfileLevelId().c_str());
  const auto expected = negotiated.profile == sv::H264Profile::Main
      ? webrtc::H264Profile::kProfileMain : webrtc::H264Profile::kProfileConstrainedBaseline;
  // Pinned AMF emits this Main SPS byte pattern, outside WebRTC's SDP table.
  // Retain the original SPS; validate geometry and I/P pictures independently
  // rather than inferring picture support from this compatibility byte.
  const bool amf_constrained_main = negotiated.profile == sv::H264Profile::Main &&
      sps.profileIdc == 77 && sps.compatibility == 0x04;
  if (!amf_constrained_main && (!actual || actual->profile != expected)) {
    throw AdapterError("ERR_RTC_NEGOTIATED_PROFILE", "Actual SPS is not the negotiated H264 profile");
  }
}

std::optional<sv::DecoderConfig> PlanDecoderSession(
    const std::optional<sv::H264Sps>& current, const AccessUnitInfo& input,
    std::span<const std::uint8_t> packet, NegotiatedH264 negotiated,
    std::uint32_t maximum_width, std::uint32_t maximum_height,
    std::uint32_t maximum_in_flight, const AdapterOptions& options) {
  if (input.sps) ValidateSps(*input.sps, negotiated, maximum_width, maximum_height);
  if (current && (!input.sps || SameSpsMode(*current, *input.sps))) return std::nullopt;
  if (!input.sps || !input.keyframe)
    throw AdapterError("ERR_RTC_DECODER_SESSION_IDR", "Starting or changing MF mode requires a real IDR/SPS/PPS",
                       WEBRTC_VIDEO_CODEC_ERROR);
  const auto& sps = *input.sps;
  sv::DecoderConfig config;
  config.width = sps.width;
  config.height = sps.height;
  config.fps = options.decoder_fps;
  config.bitrateBps = options.decoder_bitrate_bps;
  config.maxInFlight = maximum_in_flight;
  config.maxPendingPackets = options.maximum_pending_frames;
  config.profileLevelId = sps.ProfileLevelId();
  if (sv::RequiredH264Level(config.width, config.height, config.fps, config.bitrateBps) > sps.levelIdc ||
      static_cast<std::uint64_t>(sps.codedWidth) * sps.codedHeight * 3 / 2 *
          config.maxInFlight > 256ull * 1024 * 1024)
    throw AdapterError("ERR_RTC_DECODER_MODE",
                       "Actual SPS does not fit configured MF rate/bitrate hints or GPU budget");
  sv::H264Bitstream initial(sps.width, sps.height, sps.levelIdc, negotiated.profile);
  const auto checked = initial.Convert(packet);
  if (!checked.hasPicture || !checked.keyFrame)
    throw AdapterError("ERR_RTC_INITIAL_IDR", "The replacement session requires a complete qualified IDR");
  return config;
}

}  // namespace monky::native_rtc::mf::detail
