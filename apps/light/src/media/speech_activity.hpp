#pragma once

#include <api/audio/audio_device_defines.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <optional>

namespace monky::light::media {

// Levels use the RFC 6464 scale carried by RTP: 0 is full scale, 127 silence,
// in -dBov. Remote levels come from that header; local ones are measured here.
constexpr std::uint8_t kSilentLevel = 127;
// -40 dBov is the 0.01 linear audioLevel the Chromium client treats as voice.
constexpr std::uint8_t kSpeechLevel = 40;
// Consecutive quiet samples before speech ends, so word gaps do not flicker.
constexpr unsigned kSpeechHoldSamples = 4;

inline std::uint8_t LevelOf(const std::int16_t *samples, std::size_t count) {
  if (count == 0)
    return kSilentLevel;
  double energy = 0;
  for (std::size_t index = 0; index < count; ++index)
    energy += static_cast<double>(samples[index]) * samples[index];
  const double rms = std::sqrt(energy / static_cast<double>(count)) / 32768.0;
  if (rms <= 0)
    return kSilentLevel;
  return static_cast<std::uint8_t>(
      std::clamp(-20.0 * std::log10(rms), 0.0, double{kSilentLevel}));
}

// Hysteresis over periodic samples. Missing samples (no packets, stopped
// capture) count as silence. Owned by a single thread.
class SpeechDetector {
public:
  // Returns the new state only when it changes.
  std::optional<bool> Sample(std::uint8_t level) {
    if (level <= kSpeechLevel) {
      quiet_ = 0;
      return Set(true);
    }
    if (++quiet_ < kSpeechHoldSamples)
      return std::nullopt;
    return Set(false);
  }
  // Ends speech immediately, e.g. when transmission is gated.
  std::optional<bool> Silence() {
    quiet_ = kSpeechHoldSamples;
    return Set(false);
  }
  bool speaking() const { return speaking_; }

private:
  std::optional<bool> Set(bool value) {
    if (speaking_ == value)
      return std::nullopt;
    speaking_ = value;
    return value;
  }
  bool speaking_ = false;
  unsigned quiet_ = 0;
};

// Sits between the native ADM and WebRTC's audio transport and keeps the
// loudest capture level since the last read. Measuring costs one pass over
// each 10 ms block on the capture thread; nothing is copied or allocated.
// The level is raw device input, before echo cancellation and noise
// suppression, so steady loud background noise can count as speech.
class InputLevelMeter final : public webrtc::AudioTransport {
public:
  void SetTarget(webrtc::AudioTransport *target) { target_.store(target); }
  // Loudest level since the previous call; silence when nothing was captured.
  std::uint8_t Take() { return loudest_.exchange(kSilentLevel); }

  int32_t RecordedDataIsAvailable(const void *samples, size_t count,
                                  size_t bytes_per_sample, size_t channels,
                                  uint32_t rate, uint32_t delay,
                                  int32_t drift, uint32_t mic_level,
                                  bool key_pressed,
                                  uint32_t &new_mic_level) override {
    return RecordedDataIsAvailable(samples, count, bytes_per_sample, channels,
                                   rate, delay, drift, mic_level, key_pressed,
                                   new_mic_level, std::nullopt);
  }
  int32_t RecordedDataIsAvailable(
      const void *samples, size_t count, size_t bytes_per_sample,
      size_t channels, uint32_t rate, uint32_t delay, int32_t drift,
      uint32_t mic_level, bool key_pressed, uint32_t &new_mic_level,
      std::optional<int64_t> capture_time_ns) override {
    if (bytes_per_sample == channels * sizeof(std::int16_t))
      Record(LevelOf(static_cast<const std::int16_t *>(samples),
                     count * channels));
    auto *target = target_.load();
    if (!target) {
      new_mic_level = mic_level;
      return 0;
    }
    return target->RecordedDataIsAvailable(
        samples, count, bytes_per_sample, channels, rate, delay, drift,
        mic_level, key_pressed, new_mic_level, capture_time_ns);
  }
  int32_t NeedMorePlayData(size_t count, size_t bytes_per_sample,
                           size_t channels, uint32_t rate, void *samples,
                           size_t &samples_out, int64_t *elapsed_ms,
                           int64_t *ntp_ms) override {
    auto *target = target_.load();
    if (!target) {
      samples_out = 0;
      return 0;
    }
    return target->NeedMorePlayData(count, bytes_per_sample, channels, rate,
                                     samples, samples_out, elapsed_ms, ntp_ms);
  }
  void PullRenderData(int bits_per_sample, int rate, size_t channels,
                      size_t frames, void *data, int64_t *elapsed_ms,
                      int64_t *ntp_ms) override {
    if (auto *target = target_.load())
      target->PullRenderData(bits_per_sample, rate, channels, frames, data,
                              elapsed_ms, ntp_ms);
  }

private:
  void Record(std::uint8_t level) {
    auto current = loudest_.load();
    while (level < current && !loudest_.compare_exchange_weak(current, level)) {
    }
  }
  // WebRTC registers with both directions stopped, but test devices do not
  // enforce that; an atomic keeps a late callback from reading a torn value.
  std::atomic<webrtc::AudioTransport *> target_{nullptr};
  std::atomic<std::uint8_t> loudest_{kSilentLevel};
};

} // namespace monky::light::media
