#include "pcm_track_source.h"

#include <algorithm>

namespace monky::native_rtc::engine::audio {

void PcmTrackSource::BeginEpoch(const CaptureEpoch& epoch) {
  {
    std::lock_guard lock(processing_mutex_);
    if (state_.load() == kEnded)
      throw AudioError(Failure::Closed, "An ended audio source cannot restart");
    normalizer_.BeginEpoch(epoch);
    last_rtc_capture_ms_.reset();
    state_.store(kLive);
  }
  FireOnChanged();
}

void PcmTrackSource::Push(const CapturePacketView& packet) {
  std::lock_guard lock(processing_mutex_);
  if (state_.load() != kLive)
    throw AudioError(Failure::NotReady, "Audio source has no live capture epoch");
  try {
    normalizer_.Push(packet, [this](const NormalizedBlock& block) { Deliver(block); });
  } catch (...) {
    std::lock_guard delivery(delivery_mutex_);
    enabled_ = false;
    throw;
  }
}

void PcmTrackSource::SetEnabled(bool enabled) {
  std::lock_guard processing(processing_mutex_);
  std::lock_guard lock(delivery_mutex_);
  if (enabled && (state_.load() != kLive || normalizer_.Snapshot().reset_required))
    throw AudioError(Failure::NotReady, "Cannot enable an audio source without a live epoch");
  enabled_ = enabled;
}

void PcmTrackSource::End() {
  {
    std::lock_guard processing(processing_mutex_);
    std::lock_guard delivery(delivery_mutex_);
    if (state_.load() == kEnded) return;
    enabled_ = false;
    normalizer_.ResetRequired();
    state_.store(kEnded);
  }
  FireOnChanged();
}

NormalizerSnapshot PcmTrackSource::Snapshot() const {
  std::lock_guard lock(processing_mutex_);
  return normalizer_.Snapshot();
}

const webrtc::AudioOptions PcmTrackSource::options() const {
  webrtc::AudioOptions options;
  options.echo_cancellation = false;
  options.auto_gain_control = false;
  options.noise_suppression = false;
  options.highpass_filter = false;
  options.stereo_swapping = false;
  options.init_recording_on_send = false;
  return options;
}

void PcmTrackSource::AddSink(webrtc::AudioTrackSinkInterface* sink) {
  if (!sink) throw AudioError(Failure::InvalidPacket, "Audio sink is null");
  std::lock_guard lock(delivery_mutex_);
  if (state_.load() == kEnded) throw AudioError(Failure::Closed, "Audio source is ended");
  if (std::find(sinks_.begin(), sinks_.end(), sink) != sinks_.end()) return;
  if (sinks_.size() >= 64) throw AudioError(Failure::NotReady, "Audio source sink budget exhausted");
  sinks_.push_back(sink);
}

void PcmTrackSource::RemoveSink(webrtc::AudioTrackSinkInterface* sink) {
  std::lock_guard lock(delivery_mutex_);
  std::erase(sinks_, sink);
}

void PcmTrackSource::Deliver(const NormalizedBlock& block) {
  std::optional<RtcCaptureTimestamp> timestamp;
  const auto has_timestamps = std::all_of(block.timing.spans.begin(), block.timing.spans.end(),
      [](const CaptureSpan& span) { return span.qpc_timestamp_us && !span.flags.timestamp_error; });
  if (has_timestamps) timestamp = mapper_.Map(normalizer_.Epoch(), block.timing);
  if (timestamp) {
    if (timestamp->time_millis < 0 ||
        std::uint64_t(timestamp->time_millis) > kMaxSafeInteger ||
        (last_rtc_capture_ms_ && timestamp->time_millis <= *last_rtc_capture_ms_))
      throw AudioError(Failure::Clock, "Capture mapper returned an unsafe or regressing RTC timestamp");
    last_rtc_capture_ms_ = timestamp->time_millis;
  }
  std::lock_guard lock(delivery_mutex_);
  observer_.OnBlock(block, timestamp, enabled_);
  if (!enabled_) return;
  const auto rtc_ms = timestamp ? std::optional(timestamp->time_millis) : std::nullopt;
  for (auto* sink : sinks_)
    sink->OnData(block.samples.data(), 16, kRate, kChannels, kBlockFrames, rtc_ms);
}

}  // namespace monky::native_rtc::engine::audio
