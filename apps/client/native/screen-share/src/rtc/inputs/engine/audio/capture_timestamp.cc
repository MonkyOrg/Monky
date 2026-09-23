#include "capture_timestamp.h"
#include "common_audio\resampler\sinc_resampler.h"

namespace monky::native_rtc::engine::audio {

std::optional<std::int64_t> CaptureTimestampQpc(
    const CaptureEpoch& epoch, const CaptureBlockTiming& timing) {
  const auto delay = timing.input_rate == kRate ? 0u : webrtc::SincResampler::kKernelSize / 2;
  if (timing.spans.empty() || !timing.input_rate || timing.input_rate != epoch.format.sample_rate ||
      timing.input_frames != timing.input_rate / 100 || timing.filter_delay_input_frames != delay)
    throw AudioError(Failure::Clock, "Invalid normalized capture timing provenance");
  const auto& first = timing.spans.front();
  if (!first.qpc_timestamp_us || first.flags.timestamp_error) return std::nullopt;
  if (*first.qpc_timestamp_us < 0 ||
      std::uint64_t(*first.qpc_timestamp_us) > kMaxSafeInteger ||
      first.packet_frame_index > kMaxSafeInteger - first.offset_frames ||
      first.packet_frame_index + first.offset_frames < epoch.first_frame_index)
    throw AudioError(Failure::Clock, "Capture anchor is outside the current epoch");
  const auto from_epoch = first.packet_frame_index + first.offset_frames - epoch.first_frame_index;
  if (from_epoch < timing.filter_delay_input_frames) return std::nullopt;
  const auto input_offset = std::int64_t(first.offset_frames) - timing.filter_delay_input_frames;
  const auto numerator = input_offset * 1000000;
  const auto offset_us = numerator >= 0 ? numerator / timing.input_rate
      : -((-numerator + timing.input_rate - 1) / timing.input_rate);
  const auto capture_us = *first.qpc_timestamp_us + offset_us;
  if (capture_us < 0 || std::uint64_t(capture_us) > kMaxSafeInteger)
    throw AudioError(Failure::Clock, "Resampled capture origin is outside the QPC safe range");
  return capture_us;
}

PairedCaptureTimestampMapper::PairedCaptureTimestampMapper(std::shared_ptr<CaptureClock> clock)
    : clock_(std::move(clock)) {
  if (!clock_) throw AudioError(Failure::Clock, "Audio source requires the real engine capture mapper");
}

std::optional<RtcCaptureTimestamp> PairedCaptureTimestampMapper::Map(
    const CaptureEpoch& epoch, const CaptureBlockTiming& timing) {
  const auto capture = CaptureTimestampQpc(epoch, timing);
  if (!capture) return std::nullopt;
  if (epoch_ != epoch.epoch) {
    epoch_ = epoch.epoch;
    ordering_ = CaptureClockSourceState{};
  }
  const auto mapped = clock_->Map(*capture, ordering_);
  if (mapped.status != CaptureClockStatus::kOk)
    throw AudioError(Failure::Clock, CaptureClockErrorMessage(mapped.status));
  // AudioTrackSinkInterface's "absolute" timestamp uses TimeMillis, not the
  // NTP value reported independently by a remote mixer's RTP/RTCP mapping.
  return RtcCaptureTimestamp{mapped.timestamp_us / 1000};
}

}  // namespace monky::native_rtc::engine::audio
