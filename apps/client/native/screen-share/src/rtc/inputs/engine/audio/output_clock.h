#pragma once

#include "audio_types.h"

#include <map>
#include <mutex>

namespace monky::native_rtc::engine::audio {

struct ClockProbe {
  std::uint64_t epoch = 0, id = 0;
  std::int64_t rtc_before_us = 0, rtc_after_us = 0;
};
struct ClockCalibration {
  std::uint64_t epoch = 0, id = 0;
  std::int64_t offset_us = 0, uncertainty_us = 0, measured_rtc_us = 0;
};
struct RendererPlayoutFeedback {
  std::uint64_t epoch = 0, clock_epoch = 0, calibration_id = 0;
  bool available = false;
  std::int64_t at_performance_us = 0, feedback_age_us = 0, output_clock_age_us = 0;
  double estimated_playout_frame = 0;
  std::uint64_t confirmed_pcm_end = 0;
};

// Pure state/clock arithmetic. Runtime alone supplies the real RTC readings;
// Renderer echoes only its own performance-clock bracket and native probe ID.
class OutputClock final : public PhysicalPlayoutClock {
 public:
  void Begin(std::uint64_t epoch);
  void Stop();
  void Stop(std::uint64_t epoch);
  void Probe(const ClockProbe& probe);
  ClockCalibration Calibrate(std::uint64_t epoch, std::uint64_t probe_id,
      std::int64_t renderer_before_us, std::int64_t renderer_after_us, std::int64_t rtc_now_us);
  void Feedback(const RendererPlayoutFeedback& feedback, std::int64_t rtc_now_us,
                std::uint64_t mixed_cursor);
  std::optional<CalibratedPlayoutFeedback> Read(std::uint64_t epoch) const override;

 private:
  mutable std::mutex mutex_;
  std::uint64_t epoch_ = 0, last_probe_id_ = 0, clock_epoch_ = 0;
  bool active_ = false;
  std::map<std::uint64_t, ClockProbe> probes_;
  std::optional<ClockCalibration> calibration_;
  std::optional<CalibratedPlayoutFeedback> feedback_;
};

}  // namespace monky::native_rtc::engine::audio
