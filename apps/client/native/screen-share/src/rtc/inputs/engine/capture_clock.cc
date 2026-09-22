#include "capture_clock.h"

#include "system_wrappers\include\clock.h"

#include <windows.h>

namespace monky::native_rtc::engine {
namespace {

bool ValidTimestamp(std::int64_t value) noexcept {
  return value >= 0 && value <= CaptureClockPolicy::kMaxTimestampUs;
}

CaptureClockSample SampleClocks(webrtc::Clock& clock) {
  LARGE_INTEGER frequency{}, before{}, after{};
  CaptureClockSample sample;
  if (!QueryPerformanceFrequency(&frequency) || !QueryPerformanceCounter(&before)) return sample;
  const auto rtc_now = clock.CurrentTime();
  if (!QueryPerformanceCounter(&after) || !rtc_now.IsFinite()) return sample;
  if (!CaptureQpcMicroseconds(before.QuadPart, frequency.QuadPart, sample.qpc_before_us) ||
      !CaptureQpcMicroseconds(after.QuadPart, frequency.QuadPart, sample.qpc_after_us)) return sample;
  sample.rtc_now_us = rtc_now.us();
  sample.valid = true;
  return sample;
}

}  // namespace

const char* CaptureClockErrorCode(CaptureClockStatus status) noexcept {
  switch (status) {
    case CaptureClockStatus::kOk: return "OK";
    case CaptureClockStatus::kSampleFailed: return "ERR_RTC_CAPTURE_CLOCK_SAMPLE";
    case CaptureClockStatus::kSampleUncertain: return "ERR_RTC_CAPTURE_CLOCK_UNCERTAIN";
    case CaptureClockStatus::kInvalidTimestamp: return "ERR_RTC_CAPTURE_CLOCK_TIMESTAMP";
    case CaptureClockStatus::kFutureCapture: return "ERR_RTC_CAPTURE_CLOCK_FUTURE";
    case CaptureClockStatus::kStaleCapture: return "ERR_RTC_CAPTURE_CLOCK_STALE";
    case CaptureClockStatus::kUntranslatable: return "ERR_RTC_CAPTURE_CLOCK_UNTRANSLATABLE";
    case CaptureClockStatus::kNonMonotonicCapture: return "ERR_RTC_CAPTURE_CLOCK_ORDER";
    case CaptureClockStatus::kNonMonotonicTranslation: return "ERR_RTC_CAPTURE_CLOCK_RTC_ORDER";
    case CaptureClockStatus::kSourceDiscontinuity: return "ERR_RTC_CAPTURE_CLOCK_SOURCE_RESTART";
    case CaptureClockStatus::kSourceResetRequired: return "ERR_RTC_CAPTURE_CLOCK_SOURCE_RESET";
    case CaptureClockStatus::kClockDiscontinuity: return "ERR_RTC_CAPTURE_CLOCK_DISCONTINUITY";
    case CaptureClockStatus::kClockResetRequired: return "ERR_RTC_CAPTURE_CLOCK_RESET";
    case CaptureClockStatus::kClosed: return "ERR_RTC_CAPTURE_CLOCK_CLOSED";
    case CaptureClockStatus::kCount: break;
  }
  return "ERR_RTC_CAPTURE_CLOCK_UNKNOWN";
}

const char* CaptureClockErrorMessage(CaptureClockStatus status) noexcept {
  switch (status) {
    case CaptureClockStatus::kOk: return "Capture timestamp mapped from paired clocks";
    case CaptureClockStatus::kSampleFailed: return "Cannot obtain a finite paired QPC/RTC observation";
    case CaptureClockStatus::kSampleUncertain: return "QPC/RTC observation span exceeds 2 ms; frame dropped";
    case CaptureClockStatus::kInvalidTimestamp: return "Capture or clock timestamp is outside the safe range";
    case CaptureClockStatus::kFutureCapture: return "Capture timestamp is ahead of paired QPC now; not publishable yet";
    case CaptureClockStatus::kStaleCapture: return "Capture is older than 2 seconds at publication; frame dropped";
    case CaptureClockStatus::kUntranslatable: return "Mapped capture is negative or ahead of RTC sampling uncertainty; frame dropped";
    case CaptureClockStatus::kNonMonotonicCapture: return "Duplicate or out-of-order capture timestamp; frame dropped";
    case CaptureClockStatus::kNonMonotonicTranslation: return "Clock mapping would regress this source; frame dropped without retiming";
    case CaptureClockStatus::kSourceDiscontinuity: return "Capture moved backwards by over 100 ms; recreate this source";
    case CaptureClockStatus::kSourceResetRequired: return "Capture source requires recreation after a timestamp discontinuity";
    case CaptureClockStatus::kClockDiscontinuity: return "Paired clocks restarted, jumped, or diverged; recreate the engine clock and sources";
    case CaptureClockStatus::kClockResetRequired: return "Shared capture clock requires engine recreation after discontinuity";
    case CaptureClockStatus::kClosed: return "Capture clock is closed; no further clock reads are permitted";
    case CaptureClockStatus::kCount: break;
  }
  return "Unknown capture clock failure";
}

bool CaptureClockRequiresReset(CaptureClockStatus status) noexcept {
  return status == CaptureClockStatus::kSourceDiscontinuity ||
         status == CaptureClockStatus::kSourceResetRequired ||
         status == CaptureClockStatus::kClockDiscontinuity ||
         status == CaptureClockStatus::kClockResetRequired ||
         status == CaptureClockStatus::kClosed;
}

bool CaptureQpcMicroseconds(std::int64_t ticks, std::int64_t frequency,
                            std::int64_t& microseconds) noexcept {
  if (ticks < 0 || frequency <= 0) return false;
  const auto seconds = ticks / frequency;
  const auto remainder = ticks % frequency;
  if (seconds > CaptureClockPolicy::kMaxTimestampUs / 1000000 ||
      remainder > (std::numeric_limits<std::int64_t>::max)() / 1000000) return false;
  const auto value = seconds * 1000000 + remainder * 1000000 / frequency;
  if (!ValidTimestamp(value)) return false;
  microseconds = value;
  return true;
}

std::int64_t CaptureClockEarlyWaitUs(const CaptureClockMapping& mapping,
                                    std::int64_t frame_interval_us) noexcept {
  if (mapping.status != CaptureClockStatus::kFutureCapture ||
      !ValidTimestamp(mapping.capture_timestamp_us) || !ValidTimestamp(mapping.paired_qpc_us) ||
      frame_interval_us <= 0 || frame_interval_us > 1000000) return 0;
  const auto lead = mapping.capture_timestamp_us - mapping.paired_qpc_us;
  // One configured source interval at most, with a 10-ms ceiling at low FPS.
  return lead > 0 && lead <= 10000 && lead <= frame_interval_us ? lead : 0;
}

CaptureClockMapping CaptureClockPolicy::Finish(CaptureClockMapping result,
                                               CaptureClockStatus status) {
  result.status = status;
  if (status != CaptureClockStatus::kOk) result.timestamp_us = -1;
  ++snapshot_.results[static_cast<std::size_t>(status)];
  snapshot_.last = result;
  return result;
}

CaptureClockMapping CaptureClockPolicy::Map(const CaptureClockSample& sample,
                                            std::int64_t capture_us,
                                            CaptureClockSourceState& source) {
  CaptureClockMapping result;
  result.capture_timestamp_us = capture_us;
  if (snapshot_.reset_required) return Finish(result, CaptureClockStatus::kClockResetRequired);
  if (source.reset_required_) return Finish(result, CaptureClockStatus::kSourceResetRequired);
  if (!sample.valid) return Finish(result, CaptureClockStatus::kSampleFailed);
  if (!ValidTimestamp(sample.qpc_before_us) || !ValidTimestamp(sample.qpc_after_us) ||
      !ValidTimestamp(sample.rtc_now_us)) return Finish(result, CaptureClockStatus::kInvalidTimestamp);
  if (sample.qpc_after_us < sample.qpc_before_us) {
    snapshot_.reset_required = true;
    return Finish(result, CaptureClockStatus::kClockDiscontinuity);
  }
  const auto span = sample.qpc_after_us - sample.qpc_before_us;
  result.paired_qpc_us = sample.qpc_before_us + span / 2;
  result.paired_rtc_us = sample.rtc_now_us;
  result.sample_uncertainty_us = (span + 1) / 2 + 1 + kRtcQuantizationUs;
  if (snapshot_.initialized) {
    if (sample.qpc_before_us < previous_qpc_after_us_ || sample.rtc_now_us < previous_rtc_us_) {
      snapshot_.reset_required = true;
      return Finish(result, CaptureClockStatus::kClockDiscontinuity);
    }
  }
  if (span > kMaxSampleSpanUs) return Finish(result, CaptureClockStatus::kSampleUncertain);
  if (snapshot_.initialized) {
    const auto qpc_delta = result.paired_qpc_us - previous_qpc_midpoint_us_;
    const auto rtc_delta = sample.rtc_now_us - previous_rtc_us_;
    const auto offset_change = rtc_delta - qpc_delta;
    if (offset_change > kDiscontinuityUs || offset_change < -kDiscontinuityUs) {
      snapshot_.reset_required = true;
      return Finish(result, CaptureClockStatus::kClockDiscontinuity);
    }
  }

  if (snapshot_.initialized) {
    result.aligned_now_us = aligner_.TranslateTimestamp(result.paired_qpc_us);
    const auto alignment_error = sample.rtc_now_us - result.aligned_now_us;
    if (alignment_error > kMaxAlignmentErrorUs || alignment_error < -kMaxAlignmentErrorUs) {
      snapshot_.reset_required = true;
      return Finish(result, CaptureClockStatus::kClockDiscontinuity);
    }
  }
  // Only simultaneous NOW observations train M140's filter. Do not repeatedly
  // clamp calibration against the same coarse timeGetTime tick at 120 fps.
  // Sampling/continuity checks still run for every frame. Between calibrations
  // the one-argument overload preserves QPC precision; a future QPC frame drops.
  // ClipTimestamp's 1-ms guard is only for calibration, never source ordering.
  if (!snapshot_.initialized ||
      result.paired_qpc_us - calibration_qpc_us_ >= kCalibrationIntervalUs) {
    result.aligned_now_us = aligner_.TranslateTimestamp(result.paired_qpc_us, sample.rtc_now_us);
    calibration_qpc_us_ = result.paired_qpc_us;
    ++snapshot_.calibration_samples;
  }
  snapshot_.initialized = true;
  ++snapshot_.paired_samples;
  previous_qpc_after_us_ = sample.qpc_after_us;
  previous_qpc_midpoint_us_ = result.paired_qpc_us;
  previous_rtc_us_ = sample.rtc_now_us;
  if (!ValidTimestamp(capture_us)) return Finish(result, CaptureClockStatus::kInvalidTimestamp);
  if (capture_us > result.paired_qpc_us) return Finish(result, CaptureClockStatus::kFutureCapture);
  result.capture_age_us = result.paired_qpc_us - capture_us;
  if (source.initialized_ && capture_us < source.capture_us_ &&
      source.capture_us_ - capture_us > kDiscontinuityUs) {
    source.reset_required_ = true;
    return Finish(result, CaptureClockStatus::kSourceDiscontinuity);
  }
  if (result.capture_age_us > kMaxCaptureAgeUs) return Finish(result, CaptureClockStatus::kStaleCapture);
  if (source.initialized_ && capture_us <= source.capture_us_) {
    return Finish(result, CaptureClockStatus::kNonMonotonicCapture);
  }
  result.timestamp_us = aligner_.TranslateTimestamp(capture_us);
  // This identity preserves the actual QPC capture/queue age, including on the
  // first delayed frame. Never substitute RTC-now or a synthetic frame interval.
  // A real past QPC capture may be ahead of timeGetTime's latest coarse tick.
  // Allow only the measured bracket plus the documented timer quantization;
  // the independent QPC age check above still rejects genuinely future capture.
  if (result.timestamp_us < 0 ||
      result.timestamp_us - sample.rtc_now_us > result.sample_uncertainty_us ||
      result.aligned_now_us - result.timestamp_us != result.capture_age_us) {
    return Finish(result, CaptureClockStatus::kUntranslatable);
  }
  if (source.initialized_ && result.timestamp_us <= source.translated_us_) {
    return Finish(result, CaptureClockStatus::kNonMonotonicTranslation);
  }
  source.initialized_ = true;
  source.capture_us_ = capture_us;
  source.translated_us_ = result.timestamp_us;
  return Finish(result, CaptureClockStatus::kOk);
}

CaptureClock::CaptureClock(webrtc::Clock& clock) : clock_(clock) {}

CaptureClockMapping CaptureClock::Map(std::int64_t capture_us, CaptureClockSourceState& source) {
  std::lock_guard lock(mutex_);
  if (closed_) {
    CaptureClockMapping result;
    result.status = CaptureClockStatus::kClosed;
    return result;
  }
  CaptureClockSample sample;
  try {
    sample = SampleClocks(clock_);
  } catch (...) {
    // A failed clock provider must not reuse an old observation as fresh NOW.
  }
  return policy_.Map(sample, capture_us, source);
}

CaptureClockSnapshot CaptureClock::Snapshot() const {
  std::lock_guard lock(mutex_);
  auto result = policy_.Snapshot();
  result.closed = closed_;
  return result;
}

void CaptureClock::Close() {
  std::lock_guard lock(mutex_);
  closed_ = true;
}

}  // namespace monky::native_rtc::engine
