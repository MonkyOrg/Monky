#pragma once

#include "audio_types.h"

#include <algorithm>
#include <cmath>
#include <limits>

namespace monky::native_rtc::engine::audio {

// Pure arithmetic only. The owner must first establish the cross-process
// clock correlation and supply current calibrated feedback, not a nominal
// 20/40ms buffering target. No feedback means unavailable, never zero delay.
inline std::optional<std::uint16_t> PhysicalPlayoutDelay(
    const CalibratedPlayoutFeedback& feedback, std::uint64_t epoch,
    std::uint64_t mixed_cursor, std::int64_t rtc_now_us) noexcept {
  constexpr std::int64_t maximum_age_us = 200000;
  constexpr std::int64_t maximum_calibration_uncertainty_us = 20000;
  if (!epoch || feedback.epoch != epoch || !feedback.clock_epoch ||
      epoch > kMaxSafeInteger || feedback.clock_epoch > kMaxSafeInteger ||
      mixed_cursor > kMaxSafeInteger || feedback.confirmed_pcm_end > mixed_cursor ||
      feedback.observation_rtc_us < 0 || rtc_now_us < feedback.observation_rtc_us ||
      rtc_now_us > std::int64_t(kMaxSafeInteger) ||
      feedback.calibration_uncertainty_us < 0 ||
      feedback.calibration_uncertainty_us > maximum_calibration_uncertainty_us ||
      feedback.feedback_age_us < 0 || feedback.feedback_age_us > maximum_age_us ||
      feedback.output_clock_age_us < 0 || feedback.output_clock_age_us > maximum_age_us ||
      !std::isfinite(feedback.estimated_playout_frame) ||
      feedback.estimated_playout_frame < -double(kMaxSafeInteger))
    return std::nullopt;
  const auto elapsed = rtc_now_us - feedback.observation_rtc_us;
  if (elapsed > maximum_age_us ||
      elapsed + (std::max)(feedback.feedback_age_us, feedback.output_clock_age_us) > maximum_age_us)
    return std::nullopt;
  // Before the first PCM anchor reaches the physical device this position is
  // legitimately negative. Clamping it would erase measured output latency.
  const auto played = feedback.estimated_playout_frame + double(elapsed) * kRate / 1000000.;
  if (played > double(feedback.confirmed_pcm_end)) return std::nullopt;
  const auto delay_ms = (double(mixed_cursor) - played) * 1000. / kRate;
  if (!std::isfinite(delay_ms) || delay_ms < 0 ||
      delay_ms > double((std::numeric_limits<std::uint16_t>::max)()))
    return std::nullopt;
  return static_cast<std::uint16_t>(std::ceil(delay_ms));
}

}  // namespace monky::native_rtc::engine::audio
