#pragma once

#include "monky_rtc_audio.h"

#include <array>
#include <cstdint>
#include <optional>
#include <span>
#include <stdexcept>
#include <string>
#include <vector>

namespace monky::native_rtc::engine::audio {

inline constexpr std::uint32_t kRate = 48000;
inline constexpr std::uint32_t kChannels = 2;
inline constexpr std::uint32_t kBlockFrames = 480;
inline constexpr std::uint32_t kCapacityFrames = 1920;
inline constexpr std::uint64_t kMaxSafeInteger = 9007199254740991ull;

enum class Failure {
  InvalidPacket, UnsupportedFormat, WrongEpoch, Discontinuity, NotReady,
  Closed, InvalidCredit, CreditOverflow, Transport, OutputRejected, Clock,
  WrongThread, ClockObservationUnavailable
};

class AudioError : public std::runtime_error {
 public:
  AudioError(Failure failure, const char* message)
      : std::runtime_error(message), failure(failure) {}
  const Failure failure;
};

struct CaptureFormat {
  std::uint32_t sample_rate = 0;
  std::uint32_t channels = 0;
  std::optional<std::uint32_t> channel_mask;
  std::uint32_t source_bits_per_sample = 0;
  std::uint32_t source_valid_bits_per_sample = 0;
  bool operator==(const CaptureFormat&) const = default;
};

struct CaptureFlags {
  std::uint32_t raw = 0;
  bool silent = false;
  bool data_discontinuity = false;
  bool timestamp_error = false;
};

// The eventual binary boundary must decode Float32LE into aligned native
// floats. A Node Buffer is not an aligned float array and must not be cast.
struct CapturePacketView {
  std::string session_id;
  std::string epoch;
  CaptureFormat format;
  std::span<const float> samples;
  std::uint32_t frames = 0;
  std::uint64_t sequence = 0;
  std::uint64_t frame_index = 0;
  // Process loopback leaves this absent independently of a valid original QPC.
  std::optional<std::uint64_t> device_position;
  std::optional<std::int64_t> qpc_timestamp_us;
  CaptureFlags flags;
};

struct CaptureEpoch {
  std::string session_id;
  std::string epoch;
  CaptureFormat format;
  std::uint64_t first_sequence = 0;
  std::uint64_t first_frame_index = 0;
};

// Original packet positions/timestamps survive packet assembly and resampling.
// offset_frames is a sample offset at input_rate, not a newly sampled clock.
struct CaptureSpan {
  std::uint64_t packet_sequence = 0;
  std::uint64_t packet_frame_index = 0;
  std::uint32_t offset_frames = 0;
  std::uint32_t frames = 0;
  std::optional<std::uint64_t> device_position;
  std::optional<std::int64_t> qpc_timestamp_us;
  CaptureFlags flags;
};

struct CaptureBlockTiming {
  std::uint32_t input_rate = 0;
  std::uint32_t input_frames = 0;
  // M140 PushSincResampler's exact half-kernel delay, in INPUT frames.
  // These are not padding samples attributed to capture.
  std::uint32_t filter_delay_input_frames = 0;
  std::span<const CaptureSpan> spans;
};

struct NormalizedBlock {
  std::string session_id;
  std::string epoch;
  std::uint64_t sequence = 0;
  std::uint64_t first_normalized_frame = 0;
  CaptureBlockTiming timing;
  std::array<std::int16_t, kBlockFrames * kChannels> samples{};
  std::uint32_t clipped_samples = 0;
};

struct RtcCaptureTimestamp {
  // AudioTrackSinkInterface M140 explicitly requires the TimeMillis clock,
  // despite naming this parameter "absolute_capture_timestamp_ms". NOT NTP.
  std::int64_t time_millis = 0;
};

class CaptureTimestampMapper {
 public:
  virtual ~CaptureTimestampMapper() = default;
  // Must account for input sample offsets AND filter delay. Missing/invalid
  // timestamps, priming before the captured epoch, or absent calibration return
  // nullopt. An implementation must use real paired clocks, never packet arrival.
  virtual std::optional<RtcCaptureTimestamp> Map(
      const CaptureEpoch& epoch, const CaptureBlockTiming& timing) = 0;
};

struct PlayoutCredit {
  std::uint64_t epoch = 0;
  std::uint64_t grant_sequence = 0;
  std::uint32_t frames = 0;
};

struct PlayoutPacket {
  std::uint64_t epoch = 0;
  std::uint64_t sequence = 0;
  std::uint64_t first_playout_frame = 0;
  std::uint32_t frames = kBlockFrames;
  std::uint32_t sample_rate = kRate;
  std::uint32_t channels = kChannels;
  std::array<float, kBlockFrames * kChannels> samples{};
  std::optional<std::int64_t> mixer_elapsed_time_ms;
  std::optional<std::int64_t> mixer_ntp_time_ms;
};

class PlayoutOutput {
 public:
  virtual ~PlayoutOutput() = default;
  // Synchronously copy into a bounded host-owned queue. No waiting for JS, no
  // retention of the borrowed reference, and no reentry into the ADM/source.
  virtual bool OnPcm(const PlayoutPacket& packet) noexcept = 0;
  enum class StopReason { OwnerStop, EngineClose, TransportDetached, SetupFailed, MixerFailure };
  virtual void OnPlayoutStarted(std::uint64_t epoch) noexcept = 0;
  virtual void OnFailure(std::uint64_t epoch, Failure failure) noexcept = 0;
  virtual void OnInvalidated(std::uint64_t epoch, StopReason reason) noexcept = 0;
};

inline const char* StopReasonText(PlayoutOutput::StopReason reason) noexcept {
  switch (reason) {
    case PlayoutOutput::StopReason::OwnerStop: return MONKY_ENGINE_AUDIO_OWNER_STOP;
    case PlayoutOutput::StopReason::EngineClose: return MONKY_ENGINE_AUDIO_ENGINE_CLOSE;
    case PlayoutOutput::StopReason::TransportDetached: return MONKY_ENGINE_AUDIO_TRANSPORT_DETACHED;
    case PlayoutOutput::StopReason::SetupFailed: return MONKY_ENGINE_AUDIO_SETUP_FAILED;
    case PlayoutOutput::StopReason::MixerFailure: return MONKY_ENGINE_AUDIO_MIXER_FAILURE;
  }
  return nullptr;
}

// Supplied only after REAL Renderer performance-clock -> engine RTC calibration.
// This type cannot turn Renderer performance.now() into native RTC by a cast.
struct CalibratedPlayoutFeedback {
  std::uint64_t epoch = 0;
  std::uint64_t clock_epoch = 0;
  std::int64_t observation_rtc_us = 0;
  std::int64_t calibration_uncertainty_us = 0;
  std::int64_t feedback_age_us = 0;
  std::int64_t output_clock_age_us = 0;
  double estimated_playout_frame = 0;
  std::uint64_t confirmed_pcm_end = 0;
};

class PhysicalPlayoutClock {
 public:
  virtual ~PhysicalPlayoutClock() = default;
  // Unavailable/suspended/underrun/stale/uncalibrated observations return nullopt.
  // The owner combines getOutputTimestamp + worklet anchor without adding
  // baseLatency/outputLatency a second time, and retains its real provenance.
  virtual std::optional<CalibratedPlayoutFeedback> Read(std::uint64_t epoch) const = 0;
};

}  // namespace monky::native_rtc::engine::audio
