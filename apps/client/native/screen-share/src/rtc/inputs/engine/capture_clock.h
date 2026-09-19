#pragma once

#include "rtc_base\timestamp_aligner.h"

#include <array>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <mutex>

namespace webrtc {
class Clock;
}

namespace monky::native_rtc::engine {

enum class CaptureClockStatus {
  kOk,
  kSampleFailed,
  kSampleUncertain,
  kInvalidTimestamp,
  kFutureCapture,
  kStaleCapture,
  kUntranslatable,
  kNonMonotonicCapture,
  kNonMonotonicTranslation,
  kSourceDiscontinuity,
  kSourceResetRequired,
  kClockDiscontinuity,
  kClockResetRequired,
  kClosed,
  kCount
};

const char* CaptureClockErrorCode(CaptureClockStatus status) noexcept;
const char* CaptureClockErrorMessage(CaptureClockStatus status) noexcept;
bool CaptureClockRequiresReset(CaptureClockStatus status) noexcept;

struct CaptureClockSample {
  bool valid = false;
  std::int64_t qpc_before_us = 0;
  std::int64_t rtc_now_us = 0;
  std::int64_t qpc_after_us = 0;
};

// One guard per source, retained across enable/disable. Never share this guard
// between tracks: ordering between unrelated capture streams is not defined.
class CaptureClockSourceState {
 private:
  friend class CaptureClockPolicy;
  bool initialized_ = false;
  bool reset_required_ = false;
  std::int64_t capture_us_ = 0;
  std::int64_t translated_us_ = 0;
};

struct CaptureClockMapping {
  CaptureClockStatus status = CaptureClockStatus::kOk;
  std::int64_t capture_timestamp_us = -1;
  std::int64_t timestamp_us = -1;
  std::int64_t capture_age_us = -1;
  std::int64_t paired_qpc_us = -1;
  std::int64_t paired_rtc_us = -1;
  std::int64_t aligned_now_us = -1;
  std::int64_t sample_uncertainty_us = 0;
};

struct CaptureClockSnapshot {
  bool initialized = false;
  bool reset_required = false;
  bool closed = false;
  std::uint64_t paired_samples = 0;
  std::uint64_t calibration_samples = 0;
  std::array<std::uint64_t, static_cast<std::size_t>(CaptureClockStatus::kCount)> results{};
  CaptureClockMapping last;
};

// Device-free production policy. The wrapper below supplies actual paired
// clock observations and serializes this policy, including each source guard.
class CaptureClockPolicy {
 public:
  static constexpr std::int64_t kMaxTimestampUs =
      (std::numeric_limits<std::int64_t>::max)() / 10;
  static constexpr std::int64_t kMaxSampleSpanUs = 2000;
  // Desktop M140 reads timeGetTime, whose tick can be ~15.625 ms. Do not
  // request timer resolution changes merely to improve timestamp sampling.
  static constexpr std::int64_t kRtcQuantizationUs = 16000;
  static constexpr std::int64_t kMaxCaptureAgeUs = 2000000;
  static constexpr std::int64_t kDiscontinuityUs = 100000;
  static constexpr std::int64_t kMaxAlignmentErrorUs = 50000;
  static constexpr std::int64_t kCalibrationIntervalUs = 100000;

  CaptureClockMapping Map(const CaptureClockSample& sample, std::int64_t capture_us,
                          CaptureClockSourceState& source);
  CaptureClockSnapshot Snapshot() const { return snapshot_; }

 private:
  CaptureClockMapping Finish(CaptureClockMapping result, CaptureClockStatus status);
  webrtc::TimestampAligner aligner_;
  CaptureClockSnapshot snapshot_;
  std::int64_t previous_qpc_after_us_ = 0;
  std::int64_t previous_qpc_midpoint_us_ = 0;
  std::int64_t previous_rtc_us_ = 0;
  std::int64_t calibration_qpc_us_ = 0;
};

// Pure checked conversion shared by the Windows sampler and inert regressions.
bool CaptureQpcMicroseconds(std::int64_t ticks, std::int64_t frequency,
                            std::int64_t& microseconds) noexcept;
std::int64_t CaptureClockEarlyWaitUs(const CaptureClockMapping& mapping,
                                    std::int64_t frame_interval_us) noexcept;

class CaptureClock final {
 public:
  // The engine's environment clock must live until Close() returns. Sources
  // retain this wrapper, not the environment. Close before destroying the
  // environment to make even late source references harmless.
  explicit CaptureClock(webrtc::Clock& clock);
  CaptureClockMapping Map(std::int64_t capture_us, CaptureClockSourceState& source);
  CaptureClockSnapshot Snapshot() const;
  void Close();

 private:
  webrtc::Clock& clock_;
  mutable std::mutex mutex_;
  CaptureClockPolicy policy_;
  bool closed_ = false;
};

}  // namespace monky::native_rtc::engine
