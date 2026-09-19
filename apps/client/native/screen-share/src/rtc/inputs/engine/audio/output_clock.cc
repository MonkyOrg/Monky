#include "output_clock.h"

#include <cmath>

namespace monky::native_rtc::engine::audio {
namespace {
constexpr std::int64_t kMaximumAgeUs = 200000;
constexpr std::int64_t kQuantizationUs = 16000;
bool Time(std::int64_t value) { return value >= 0 && std::uint64_t(value) <= kMaxSafeInteger; }
void Require(bool valid, const char* message) {
  if (!valid) throw AudioError(Failure::Clock, message);
}
}

void OutputClock::Begin(std::uint64_t epoch) {
  std::lock_guard lock(mutex_);
  Require(epoch && epoch <= kMaxSafeInteger && epoch > epoch_, "Audio output clock epoch must advance");
  epoch_ = epoch;
  active_ = true;
  last_probe_id_ = clock_epoch_ = 0;
  probes_.clear();
  calibration_.reset();
  feedback_.reset();
}

void OutputClock::Stop() {
  std::lock_guard lock(mutex_);
  active_ = false;
  probes_.clear();
  calibration_.reset();
  feedback_.reset();
}

void OutputClock::Stop(std::uint64_t epoch) {
  std::lock_guard lock(mutex_);
  if (epoch_ != epoch) return;
  active_ = false;
  probes_.clear();
  calibration_.reset();
  feedback_.reset();
}

void OutputClock::Probe(const ClockProbe& probe) {
  std::lock_guard lock(mutex_);
  Require(active_ && probe.epoch == epoch_ && probe.id > last_probe_id_ && probe.id <= kMaxSafeInteger &&
          Time(probe.rtc_before_us) && Time(probe.rtc_after_us) &&
          probe.rtc_after_us >= probe.rtc_before_us &&
          probe.rtc_after_us - probe.rtc_before_us <= 20000, "Invalid actual RTC clock probe");
  for (auto item = probes_.begin(); item != probes_.end();) {
    if (probe.rtc_before_us - item->second.rtc_after_us > kMaximumAgeUs) item = probes_.erase(item);
    else ++item;
  }
  Require(probes_.size() < 16, "Audio clock probe budget exhausted");
  probes_.emplace(probe.id, probe);
  last_probe_id_ = probe.id;
}

ClockCalibration OutputClock::Calibrate(std::uint64_t epoch, std::uint64_t probe_id,
    std::int64_t before, std::int64_t after, std::int64_t rtc_now) {
  std::lock_guard lock(mutex_);
  const auto found = probes_.find(probe_id);
  Require(active_ && epoch == epoch_ && found != probes_.end(), "Audio calibration has no owned native probe");
  const auto& probe = found->second;
  Require(Time(before) && Time(after) && after >= before && after - before <= 8000 &&
          Time(rtc_now) && rtc_now >= probe.rtc_after_us &&
          rtc_now - probe.rtc_after_us <= kMaximumAgeUs, "Clock calibration is stale or uncertain");
  const auto uncertainty = (after - before + probe.rtc_after_us - probe.rtc_before_us + 1) / 2
      + kQuantizationUs;
  Require(uncertainty <= 20000, "Clock calibration exceeds its measured uncertainty bound");
  ClockCalibration result{epoch, probe_id,
      (probe.rtc_before_us + probe.rtc_after_us - before - after) / 2,
      uncertainty, probe.rtc_after_us};
  if (calibration_) {
    Require(result.id > calibration_->id, "Clock calibration ID regressed");
    const auto delta = result.offset_us - calibration_->offset_us;
    Require(delta >= -100000 && delta <= 100000, "Renderer/native clocks changed epoch");
  }
  probes_.erase(found);
  calibration_ = result;
  feedback_.reset();
  return result;
}

void OutputClock::Feedback(const RendererPlayoutFeedback& input, std::int64_t rtc_now,
                           std::uint64_t mixed_cursor) {
  std::lock_guard lock(mutex_);
  Require(active_ && input.epoch == epoch_, "Feedback belongs to another output epoch");
  if (!input.available) {
    feedback_.reset();
    return;
  }
  Require(calibration_ && input.calibration_id == calibration_->id &&
          input.clock_epoch && input.clock_epoch <= kMaxSafeInteger && input.clock_epoch >= clock_epoch_ &&
          Time(input.at_performance_us) && Time(rtc_now) &&
          rtc_now >= calibration_->measured_rtc_us &&
          rtc_now - calibration_->measured_rtc_us <= kMaximumAgeUs &&
          input.feedback_age_us >= 0 && input.feedback_age_us <= kMaximumAgeUs &&
          input.output_clock_age_us >= 0 && input.output_clock_age_us <= kMaximumAgeUs &&
          input.confirmed_pcm_end <= mixed_cursor && mixed_cursor <= kMaxSafeInteger &&
          std::isfinite(input.estimated_playout_frame) &&
          input.estimated_playout_frame >= -double(kMaxSafeInteger) &&
          input.estimated_playout_frame <= double(input.confirmed_pcm_end),
          "Physical audio feedback is invalid, stale, uncalibrated or beyond actual PCM");
  const auto observed = input.at_performance_us + calibration_->offset_us;
  Require(Time(observed) && observed - rtc_now <= calibration_->uncertainty_us &&
          rtc_now - observed <= kMaximumAgeUs, "Renderer feedback time has no current native correlation");
  if (feedback_ && feedback_->clock_epoch == input.clock_epoch) {
    Require(observed > feedback_->observation_rtc_us &&
            input.estimated_playout_frame >= feedback_->estimated_playout_frame &&
            input.confirmed_pcm_end >= feedback_->confirmed_pcm_end,
            "Physical audio feedback regressed without a new worklet clock epoch");
  }
  feedback_ = CalibratedPlayoutFeedback{epoch_, input.clock_epoch, observed,
      calibration_->uncertainty_us, input.feedback_age_us, input.output_clock_age_us,
      input.estimated_playout_frame, input.confirmed_pcm_end};
  clock_epoch_ = input.clock_epoch;
}

std::optional<CalibratedPlayoutFeedback> OutputClock::Read(std::uint64_t epoch) const {
  std::lock_guard lock(mutex_);
  return active_ && epoch == epoch_ ? feedback_ : std::nullopt;
}

}  // namespace monky::native_rtc::engine::audio
