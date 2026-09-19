#pragma once

#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>
#include <utility>

namespace screen_audio {

constexpr uint64_t kSafeInteger = 9007199254740991ULL;
constexpr size_t kMaxPacketBytes = 1024 * 1024;
constexpr size_t kMaxQueuedPackets = 32;
constexpr uint32_t kDiscontinuity = 1, kSilent = 2, kTimestampError = 4;

struct Failure : std::runtime_error {
  std::string code;
  Failure(const char* code, const std::string& message)
      : std::runtime_error(message), code(code) {}
};

enum class CaptureOwner { none, legacy, packet };
inline std::atomic<CaptureOwner> captureOwner{CaptureOwner::none};

class CaptureLease {
 public:
  explicit CaptureLease(CaptureOwner owner) {
    auto expected = CaptureOwner::none;
    held_ = captureOwner.compare_exchange_strong(expected, owner);
  }
  ~CaptureLease() { Release(); }
  CaptureLease(const CaptureLease&) = delete;
  CaptureLease& operator=(const CaptureLease&) = delete;
  bool held() const { return held_; }
  void Release() {
    if (held_) {
      captureOwner.store(CaptureOwner::none);
      held_ = false;
    }
  }
 private:
  bool held_;
};

inline bool IsInProcessTree(uint32_t process, uint32_t root,
                            const std::vector<std::pair<uint32_t, uint32_t>>& parents) {
  for (size_t depth = 0; process; ++depth) {
    if (process == root) return true;
    if (depth > parents.size()) throw Failure("ERR_AUDIO_TARGET", "Cyclic process ancestry");
    uint32_t parent = 0;
    for (const auto& item : parents) if (item.first == process) { parent = item.second; break; }
    if (parent == process) throw Failure("ERR_AUDIO_TARGET", "Invalid process ancestry");
    process = parent;
  }
  return false;
}

inline void ValidateIncludedProcess(uint32_t selected, uint32_t host,
                                    const std::vector<std::pair<uint32_t, uint32_t>>& parents) {
  bool found = false;
  for (const auto& item : parents) if (item.first == selected) { found = true; break; }
  if (!selected || !host || !found)
    throw Failure("ERR_AUDIO_TARGET", "Selected process is absent from the process snapshot");
  if (IsInProcessTree(selected, host, parents) || IsInProcessTree(host, selected, parents))
    throw Failure("ERR_AUDIO_TARGET", "INCLUDE cannot exclude the Monky process tree");
}

struct Format {
  uint32_t sampleRate = 0;
  uint16_t channels = 0, bits = 0, validBits = 0, blockAlign = 0;
  uint32_t channelMask = 0, averageBytesPerSecond = 0;
  bool floatingPoint = false;
};

inline void ValidateFormat(const Format& f) {
  if (!f.sampleRate || f.sampleRate > 384000 || !f.channels || f.channels > 32)
    throw Failure("ERR_AUDIO_FORMAT", "Unsupported sample rate or channel count");
  if ((f.floatingPoint && (f.bits != 32 || f.validBits != 32)) ||
      (!f.floatingPoint && (f.bits != 16 && f.bits != 24 && f.bits != 32)) ||
      !f.validBits || f.validBits > f.bits)
    throw Failure("ERR_AUDIO_FORMAT", "Unsupported PCM container or valid-bit width");
  if (f.blockAlign != f.channels * (f.bits / 8) ||
      f.averageBytesPerSecond != uint64_t(f.sampleRate) * f.blockAlign)
    throw Failure("ERR_AUDIO_FORMAT", "Inconsistent PCM block alignment or byte rate");
  unsigned speakers = 0;
  for (uint32_t mask = f.channelMask; mask; mask >>= 1) speakers += mask & 1;
  if (f.channelMask && speakers != f.channels)
    throw Failure("ERR_AUDIO_FORMAT", "Channel mask does not describe every channel");
}

inline size_t PacketBytes(const Format& f, uint64_t frames) {
  ValidateFormat(f);
  if (!frames || frames > kMaxPacketBytes / (sizeof(float) * f.channels))
    throw Failure("ERR_AUDIO_PACKET_SIZE", "PCM packet exceeds the bounded allocation");
  return static_cast<size_t>(frames) * f.blockAlign;
}

inline std::vector<float> Convert(const Format& f, const uint8_t* data,
                                  size_t bytes, uint64_t frames, uint32_t flags) {
  const size_t expected = PacketBytes(f, frames);
  if (flags & ~(kDiscontinuity | kSilent | kTimestampError))
    throw Failure("ERR_AUDIO_FLAGS", "Unrecognized WASAPI buffer flags");
  if (!(flags & kSilent) && (!data || bytes != expected))
    throw Failure("ERR_AUDIO_PACKET_SIZE", "PCM buffer size does not match its frame count");
  // WASAPI explicitly allows a null data pointer for SILENT, but not invented frames.
  if ((flags & kSilent) && bytes != 0 && bytes != expected)
    throw Failure("ERR_AUDIO_PACKET_SIZE", "Invalid silent packet byte count");
  std::vector<float> output(static_cast<size_t>(frames) * f.channels, 0.0f);
  if (flags & kSilent) return output;
  const unsigned stride = f.bits / 8;
  for (size_t i = 0; i < output.size(); ++i) {
    const uint8_t* sample = data + i * stride;
    if (f.floatingPoint) {
      std::memcpy(&output[i], sample, sizeof(float));
      if (!std::isfinite(output[i]))
        throw Failure("ERR_AUDIO_PCM", "Non-finite float PCM sample");
    } else {
      uint32_t raw = 0;
      for (unsigned b = 0; b < stride; ++b) raw |= uint32_t(sample[b]) << (8 * b);
      const uint64_t sign = uint64_t(1) << (f.bits - 1);
      const int64_t signedSample = raw & sign
          ? int64_t(raw) - int64_t(uint64_t(1) << f.bits) : int64_t(raw);
      // WAVEFORMATEXTENSIBLE valid bits are left-aligned in the container.
      const int64_t scale = int64_t(1) << (f.bits - f.validBits);
      if (signedSample % scale != 0)
        throw Failure("ERR_AUDIO_PCM", "Nonzero padding outside the declared valid bits");
      output[i] = static_cast<float>(double(signedSample) / double(sign));
    }
  }
  return output;
}

struct Timing {
  uint64_t sequence = 0, epoch = 0, frameIndex = 0;
  std::optional<uint64_t> devicePosition, qpcTimestampUs;
  uint32_t flags = 0;
};

class Timeline {
 public:
  Timing Next(uint32_t frames, uint32_t flags, std::optional<uint64_t> devicePosition,
              uint64_t qpc100ns, uint32_t sampleRate) {
    if (!frames || !sampleRate || sampleRate > 384000 ||
        flags & ~(kDiscontinuity | kSilent | kTimestampError))
      throw Failure("ERR_AUDIO_TIMING", "Invalid frame count or timing flags");
    const bool valid = !(flags & kTimestampError);
    if (!valid) devicePosition.reset();
    if (sequence_ == kSafeInteger || frameIndex_ > kSafeInteger - frames ||
        (devicePosition && *devicePosition > kSafeInteger - frames) ||
        (valid && qpc100ns / 10 > kSafeInteger))
      throw Failure("ERR_AUDIO_TIMING", "Position or timestamp is not a JavaScript safe integer");
    bool qpcGap = false;
    if (seen_ && valid && valid_ && !devicePosition && !expectedPosition_ && qpc100ns >= lastQpc_) {
      const auto elapsed = qpc100ns / 10 - lastQpc_ / 10;
      const auto expected = uint64_t(lastFrames_) * 1000000 / sampleRate;
      // QPC-only continuity policy: two input frames plus microsecond rounding
      // slack. This detects gaps/overlaps; it never adjusts the original clock.
      const auto tolerance = (2000000ULL + sampleRate - 1) / sampleRate + 1;
      qpcGap = elapsed > expected + tolerance || elapsed + tolerance < expected;
    }
    if (seen_ && ((flags & kDiscontinuity) || valid != valid_ ||
        devicePosition.has_value() != expectedPosition_.has_value() ||
        (devicePosition && devicePosition != expectedPosition_) ||
        (valid && valid_ && qpc100ns < lastQpc_) || qpcGap)) {
      if (epoch_ == kSafeInteger) throw Failure("ERR_AUDIO_TIMING", "Epoch exhausted");
      ++epoch_;
    }
    Timing timing{sequence_++, epoch_, frameIndex_, devicePosition,
                  valid ? std::optional(qpc100ns / 10) : std::nullopt, flags};
    frameIndex_ += frames;
    seen_ = true;
    valid_ = valid;
    expectedPosition_ = devicePosition ? std::optional(*devicePosition + frames) : std::nullopt;
    lastFrames_ = frames;
    if (valid) {
      lastQpc_ = qpc100ns;
    }
    return timing;
  }
 private:
  uint64_t sequence_ = 0, epoch_ = 0, frameIndex_ = 0, lastQpc_ = 0;
  std::optional<uint64_t> expectedPosition_;
  uint32_t lastFrames_ = 0;
  bool seen_ = false, valid_ = false;
};

// Data slots are independent of ready/error/closed control delivery.
class PacketBudget {
 public:
  bool Acquire() {
    size_t count = queued_.load();
    while (count < kMaxQueuedPackets) {
      if (queued_.compare_exchange_weak(count, count + 1)) return true;
    }
    return false;
  }
  void Release() { queued_.fetch_sub(1); }
  size_t queued() const { return queued_.load(); }
 private:
  std::atomic<size_t> queued_{0};
};

}  // namespace screen_audio
