#pragma once

#include "audio_types.h"
#include "common_audio\resampler\include\push_resampler.h"

#include <functional>
#include <memory>

namespace monky::native_rtc::engine::audio {

struct NormalizerSnapshot {
  bool initialized = false;
  bool reset_required = false;
  std::uint64_t packets = 0;
  std::uint64_t blocks = 0;
  std::uint64_t discarded_partial_frames = 0;
  std::uint64_t clipped_samples = 0;
  std::uint32_t pending_input_frames = 0;
};

// Single-owner CPU component. No device, RTC factory, timer, platform clock,
// global AudioTransport, or guessed layout. The SRC/mix live for a whole epoch.
class PcmNormalizer {
 public:
  using Output = std::function<void(const NormalizedBlock&)>;
  static void ValidateFormat(const CaptureFormat& format);
  void BeginEpoch(const CaptureEpoch& epoch);
  void Push(const CapturePacketView& packet, const Output& output);
  void ResetRequired() noexcept { snapshot_.reset_required = true; }
  const CaptureEpoch& Epoch() const noexcept { return epoch_; }
  NormalizerSnapshot Snapshot() const noexcept { return snapshot_; }

 private:
  void ValidatePacket(const CapturePacketView& packet) const;
  void Produce(const Output& output);
  CaptureEpoch epoch_;
  std::uint64_t generation_ = 0;
  std::uint64_t expected_sequence_ = 0, expected_frame_index_ = 0;
  std::uint64_t block_sequence_ = 0;
  std::optional<std::uint64_t> expected_device_position_;
  std::optional<std::int64_t> previous_qpc_;
  bool first_packet_ = true;
  std::uint32_t previous_packet_frames_ = 0;
  std::uint32_t input_frames_ = 0;
  std::vector<float> pending_;
  std::vector<std::vector<float>> downmix_;
  double downmix_gain_ = 1;
  std::vector<CaptureSpan> spans_;
  std::unique_ptr<webrtc::PushResampler<float>> resampler_;
  NormalizerSnapshot snapshot_;
};

}  // namespace monky::native_rtc::engine::audio
