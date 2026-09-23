#pragma once

#include "audio_types.h"
#include "..\capture_clock.h"

#include <memory>

namespace monky::native_rtc::engine::audio {

// QPC capture origin of this resampled block, including the pinned SRC delay.
// A sample before this capture epoch is never attributed to an invented packet.
std::optional<std::int64_t> CaptureTimestampQpc(
    const CaptureEpoch& epoch, const CaptureBlockTiming& timing);

// Shares the engine's existing paired NOW mapper but not another track's order
// guard. No wall clock, NTP, arrival-time calibration or independent clock is made.
class PairedCaptureTimestampMapper final : public CaptureTimestampMapper {
 public:
  explicit PairedCaptureTimestampMapper(std::shared_ptr<CaptureClock> clock);
  std::optional<RtcCaptureTimestamp> Map(
      const CaptureEpoch& epoch, const CaptureBlockTiming& timing) override;

 private:
  std::shared_ptr<CaptureClock> clock_;
  CaptureClockSourceState ordering_;
  std::string epoch_;
};

}  // namespace monky::native_rtc::engine::audio
