#pragma once

#include <chrono>
#include <cstdint>

namespace monky::light::test {

inline constexpr auto kFixtureAudioPeriod = std::chrono::milliseconds(10);
inline constexpr auto kFixtureAudioBuffer = kFixtureAudioPeriod * 5;

struct FixtureAudioDeadline {
  std::chrono::steady_clock::time_point next;
  std::uint64_t discarded_frames;
};

constexpr FixtureAudioDeadline AdvanceFixtureAudioDeadline(
    std::chrono::steady_clock::time_point previous,
    std::chrono::steady_clock::time_point now) {
  const auto next = previous + kFixtureAudioPeriod;
  const auto late = now - next;
  if (late < kFixtureAudioBuffer) return {next, 0};
  const auto discarded = late / kFixtureAudioPeriod + 1;
  return {next + kFixtureAudioPeriod * discarded,
          static_cast<std::uint64_t>(discarded)};
}

}  // namespace monky::light::test
