#pragma once

#include "contract.h"
#include <bit>
#include <cstring>

namespace monky::screen_capture::live {

constexpr std::uint32_t kMagic = 0x31484c4d, kHeaderBytes = 96;
constexpr std::size_t kQueueFrames = 16, kQueueBytes = 8 * 1024 * 1024;
constexpr std::uint64_t kQueueAgeMs = 500, kFeedbackCommands = kMaxSafeInteger;
enum class Kind : std::uint32_t { Packet = 1, Notice = 2, Closed = 3 };

struct Header {
  std::uint32_t magic = kMagic, kind = 0, headerBytes = kHeaderBytes, payloadBytes = 0;
  std::uint64_t sequence = 0, frameId = 0, observedQpc = 0, qpcFrequency = 0;
  std::int64_t timestampUs = 0, pts = 0, dts = 0, systemDtsUs = 0;
  std::uint32_t timebaseNumerator = 0, timebaseDenominator = 0, keyframe = 0, settingsBitrateKbps = 0;
};
static_assert(sizeof(Header) == kHeaderBytes && alignof(Header) == 8);
static_assert(offsetof(Header, timestampUs) == 48 && offsetof(Header, timebaseNumerator) == 80);
static_assert(std::endian::native == std::endian::little);

inline std::int64_t ScaleTime(std::int64_t ticks, std::uint32_t num, std::uint32_t den) {
  Require(num == 1 && den > 0 && den <= 120,
      "Capture requires the original configured video timebase", "ERR_SCREEN_CAPTURE_CLOCK");
  const auto whole = ticks / den, remainder = ticks % den;
  const auto secondsLimit = static_cast<std::int64_t>(kMaxSafeInteger / 1000000);
  Require(whole >= -secondsLimit && whole <= secondsLimit,
      "Capture timestamp exceeds the exact microsecond range", "ERR_SCREEN_CAPTURE_CLOCK");
  const auto value = whole * 1000000 + remainder * 1000000 / den;
  Require(value >= -static_cast<std::int64_t>(kMaxSafeInteger) && value <= static_cast<std::int64_t>(kMaxSafeInteger),
      "Capture timestamp overflow", "ERR_SCREEN_CAPTURE_CLOCK");
  return value;
}

class PacketClock {
 public:
  std::int64_t Observe(const abi::EncoderPacket& packet) {
    const auto pts = ScaleTime(packet.pts, packet.timebase_num, packet.timebase_den);
    const auto dts = ScaleTime(packet.dts, packet.timebase_num, packet.timebase_den);
    Require(packet.sys_dts_usec > 0 && packet.sys_dts_usec <= static_cast<std::int64_t>(kMaxSafeInteger),
        "OBS did not supply an actual system timestamp", "ERR_SCREEN_CAPTURE_CLOCK");
    if (!started_) {
      Require(packet.keyframe && packet.pts == 0,
          "The first live AU must bind the original encoder start at PTS0", "ERR_SCREEN_CAPTURE_CLOCK");
      firstDtsUs_ = dts;
    } else {
      Require(packet.pts > lastPts_ && packet.dts > lastDts_,
          "Original live PTS/DTS regressed", "ERR_SCREEN_CAPTURE_CLOCK");
    }
    // OBS32.1.1 subtracts the first encoded DTS when it forms sys_dts_usec.
    // Undo that offset before replacing decode time with the original PTS.
    const auto value = packet.sys_dts_usec + pts - dts + firstDtsUs_;
    Require(value > lastTimestamp_ && value <= static_cast<std::int64_t>(kMaxSafeInteger),
        "Original live presentation clock regressed or overflowed", "ERR_SCREEN_CAPTURE_CLOCK");
    started_ = true; lastTimestamp_ = value; lastPts_ = packet.pts; lastDts_ = packet.dts;
    return value;
  }
 private:
  bool started_ = false;
  std::int64_t firstDtsUs_ = 0, lastTimestamp_ = -1, lastPts_ = 0, lastDts_ = 0;
};

struct Feedback {
  std::uint64_t sequence = 0;
  bool keyframe = false;
  std::uint32_t bitrateKbps = 0;
};

inline Feedback ParseFeedback(std::string_view line) {
  Require(!line.empty() && line.size() < kMaxCommandLine, "Invalid live feedback length");
  const auto first = line.find(' '), second = line.find(' ', first == std::string_view::npos ? 0 : first + 1);
  Require(first != std::string_view::npos && second != std::string_view::npos &&
      line.find(' ', second + 1) == std::string_view::npos, "Live feedback requires three fields");
  Feedback value;
  value.sequence = Decimal(line.substr(0, first), kFeedbackCommands);
  Require(value.sequence > 0, "Live feedback sequence starts at1");
  const auto verb = line.substr(first + 1, second - first - 1);
  const auto amount = Decimal(line.substr(second + 1), kMaximumBitrateKbps);
  if (verb == "idr") {
    Require(amount == 0, "IDR requests cannot supply fabricated frame IDs");
    value.keyframe = true;
  } else {
    Require(verb == "bitrate" && amount >= 50 && amount % 50 == 0,
        "Hardware bitrate must be50..80000Kbps in50Kbps steps");
    value.bitrateKbps = static_cast<std::uint32_t>(amount);
  }
  return value;
}

inline void CheckBudget(std::size_t frames, std::size_t bytes, std::size_t next,
                        std::uint64_t oldestMs, std::uint64_t nowMs) {
  Require(frames < kQueueFrames && next <= kQueueBytes && bytes <= kQueueBytes - next,
      "Live compressed output exceeded its native copy budget", "ERR_SCREEN_CAPTURE_QUEUE");
  Require(nowMs >= oldestMs && nowMs - oldestMs <= kQueueAgeMs,
      "Live compressed output exceeded its500ms age limit", "ERR_SCREEN_CAPTURE_BACKPRESSURE");
}

}  // namespace monky::screen_capture::live
