#pragma once

#include "capture_clock.h"
#include "system_wrappers\include\clock.h"

#include <array>
#include <cstdint>
#include <limits>

namespace monky::native_rtc::engine {

template <typename Check>
void RunCaptureClockChecks(Check check) {
  using Status = CaptureClockStatus;
  using Policy = CaptureClockPolicy;
  const auto pair = [](std::int64_t qpc_us, std::int64_t rtc_us) {
    return CaptureClockSample{true, qpc_us, rtc_us, qpc_us};
  };
  const auto preserved = [&](const CaptureClockMapping& mapped, std::int64_t age_us) {
    check(mapped.status == Status::kOk, "Valid capture-clock mapping was rejected");
    check(mapped.capture_age_us == age_us &&
              mapped.aligned_now_us - mapped.timestamp_us == age_us,
          "Pair mapping concealed real capture/queue age");
    check(mapped.timestamp_us - mapped.paired_rtc_us <= mapped.sample_uncertainty_us,
          "Pair mapping exceeded RTC sampling uncertainty");
  };

  {
    Policy policy;
    CaptureClockSourceState source;
    const auto early = policy.Map(pair(1000000, 4000000), 1001050, source);
    check(early.status == Status::kFutureCapture && early.timestamp_us == -1,
          "Early input was accepted or retimed before real QPC reached it");
    check(CaptureClockEarlyWaitUs(early, 8333) == 1050,
          "A small real compositor lead did not retain its exact deadline");
    check(CaptureClockEarlyWaitUs(early, 1000) == 0,
          "Early input wait exceeded the source frame duration");
    const auto next_tick = policy.Map(pair(1000000, 4000000), 1008333, source);
    check(CaptureClockEarlyWaitUs(next_tick, 8333) == 8333 &&
              CaptureClockEarlyWaitUs(next_tick, 8332) == 0,
          "Early input did not honor the configured frame-interval boundary");
    for (const auto interval : std::array<std::int64_t, 3>{-1, 0, 1000001}) {
      check(CaptureClockEarlyWaitUs(early, interval) == 0,
            "Invalid source interval admitted an early input wait");
    }
    for (const auto lead : std::array<std::int64_t, 3>{10001, 100000, 1000000}) {
      const auto future = policy.Map(pair(1000000, 4000000), 1000000 + lead, source);
      check(CaptureClockEarlyWaitUs(future, 1000000) == 0,
            "An unbounded future timestamp was allowed to stall the source");
    }
    const auto due = policy.Map(pair(1001200, 4001200), 1001050, source);
    preserved(due, 150);
    check(CaptureClockEarlyWaitUs(due, 8333) == 0 && due.timestamp_us == 4001050,
          "A due frame acquired another pacing wait or a replacement timestamp");
  }

  {
    Policy policy;
    CaptureClockSourceState source;
    const auto first = policy.Map(pair(900000000000, 4000000), 899999750000, source);
    preserved(first, 250000);
    check(first.timestamp_us == 3750000,
          "First delayed capture incorrectly calibrated QPC epoch from arrival");
    const auto delayed = policy.Map(pair(900000550000, 4550000), 900000100000, source);
    preserved(delayed, 450000);
    check(delayed.timestamp_us - first.timestamp_us == 350000,
          "Queue delay replaced the original capture interval");
    check(policy.Snapshot().paired_samples == 2,
          "Engine clock did not retain paired calibration observations");
  }
  {
    Policy policy;
    CaptureClockSourceState source;
    const auto mapped = policy.Map(pair(3000000, 900000000000), 2800000, source);
    preserved(mapped, 200000);
    check(mapped.timestamp_us == 899999800000, "Positive clock epoch offset failed");
  }
  {
    Policy policy;
    CaptureClockSourceState source;
    const auto sample = CaptureClockSample{true, 1000000, 4000000, 1000200};
    const auto mapped = policy.Map(sample, 950000, source);
    preserved(mapped, 50100);
    check(mapped.paired_qpc_us == 1000100 &&
              mapped.sample_uncertainty_us == Policy::kRtcQuantizationUs + 101,
          "Paired midpoint or QPC/RTC sampling uncertainty was lost");
  }
  for (const auto fps : {120, 240}) {
    // Delivery latency varies by 6 ms at both supported high frame rates.
    // Nothing in production mapping receives fps, duration, or frame IDs.
    Policy policy;
    CaptureClockSourceState source;
    constexpr std::array<std::int64_t, 4> delays{10000, 16000, 12000, 14000};
    std::int64_t previous_capture = 0, previous_output = 0;
    for (std::int64_t frame = 0; frame < fps; ++frame) {
      const auto capture = 1000000000 + (frame * 1000000 + fps / 2) / fps;
      const auto delay = delays[static_cast<std::size_t>(frame) % delays.size()];
      const auto now = capture + delay;
      const auto mapped = policy.Map(pair(now, now - 900000000), capture, source);
      preserved(mapped, delay);
      check(mapped.timestamp_us == capture - 900000000,
            "High-FPS mapping followed delivery jitter instead of capture time");
      if (frame != 0) {
        check(mapped.timestamp_us - previous_output == capture - previous_capture,
              "High-FPS capture cadence was synthesized or flattened");
      }
      previous_capture = capture;
      previous_output = mapped.timestamp_us;
    }
  }
  for (const auto fps : {120, 240})
  for (const auto drift_ppm : std::array<std::int64_t, 2>{-1000, 1000}) {
    Policy policy;
    CaptureClockSourceState source;
    std::int64_t previous = -1;
    unsigned accepted = 0;
    for (std::int64_t frame = 0; frame < 600; ++frame) {
      const auto elapsed = frame * 1000000 / fps;
      const auto qpc = 100000000 + elapsed;
      // Model the coarse desktop timer, including repeated RTC-now readings.
      const auto rtc = (10000000 + elapsed + elapsed * drift_ppm / 1000000) / 15625 * 15625;
      const auto mapped = policy.Map(pair(qpc, rtc), qpc - 30000, source);
      if (mapped.status == Status::kNonMonotonicTranslation) {
        check(mapped.timestamp_us == -1, "Rejected drift correction exposed a fabricated timestamp");
        continue;
      }
      preserved(mapped, 30000);
      check(mapped.timestamp_us > previous, "Clock drift/quantization broke source monotonicity");
      check(rtc - mapped.aligned_now_us <= Policy::kMaxAlignmentErrorUs &&
                mapped.aligned_now_us - rtc <= Policy::kMaxAlignmentErrorUs,
            "Clock drift accumulated unbounded alignment error");
      previous = mapped.timestamp_us;
      ++accepted;
    }
    check(accepted >= 570, "Coarse RTC calibration unnecessarily flattened high-FPS capture");
    check(policy.Snapshot().calibration_samples < 60,
          "Calibration was repeatedly clamped against coarse RTC ticks");
  }
  for (const auto fps : {120, 240})
  for (const auto age : std::array<std::int64_t, 4>{0, 1000, 2000, 8000}) {
    for (const auto phase : std::array<std::int64_t, 3>{0, 5000, 14000}) {
      Policy policy;
      CaptureClockSourceState source;
      unsigned accepted = 0;
      std::int64_t previous = -1;
      for (std::int64_t frame = 0; frame < 600; ++frame) {
        const auto elapsed = frame * 1000000 / fps;
        const auto qpc = 100000000 + elapsed;
        const auto rtc = (10000000 + phase + elapsed) / 15625 * 15625;
        const auto mapped = policy.Map(pair(qpc, rtc), qpc - age, source);
        if (mapped.status == Status::kNonMonotonicTranslation) continue;
        preserved(mapped, age);
        check(mapped.timestamp_us > previous,
              "Low-latency coarse-clock mapping lost independent source ordering");
        previous = mapped.timestamp_us;
        ++accepted;
      }
      check(accepted >= 570, "Timer quantization discarded valid low-latency high-FPS capture");
    }
  }
  {
    Policy policy;
    CaptureClockSourceState source;
    preserved(policy.Map(pair(1000000, 3000000), 1000000, source), 0);
    check(policy.Map(pair(1020000, 3000000), 1020000, source).status == Status::kUntranslatable,
          "RTC uncertainty allowance accepted a frame beyond its documented bound");
    preserved(policy.Map(pair(1030000, 3030000), 1030000, source), 0);
  }
  {
    Policy policy;
    CaptureClockSourceState source;
    check(policy.Map({}, 0, source).status == Status::kSampleFailed,
          "Failed paired sample was accepted");
    check(!policy.Snapshot().initialized, "Failed sample calibrated the mapper");
    check(policy.Map({true, 1000000, 5000000, 1200001}, 900000, source).status ==
              Status::kSampleUncertain,
          "Wide initial QPC/RTC bracket was accepted");
    check(!policy.Snapshot().initialized, "Wide initial sample calibrated the mapper");
    preserved(policy.Map(pair(2000000, 6000000), 1900000, source), 100000);
    check(policy.Map({true, 2010000, 6010000, 2410000}, 1990000, source).status ==
              Status::kSampleUncertain,
          "Scheduling stall was mislabeled as an established clock discontinuity");
    check(policy.Snapshot().paired_samples == 1 && !policy.Snapshot().reset_required,
          "Uncertain sample trained or permanently poisoned the mapper");
    preserved(policy.Map(pair(2500000, 6500000), 2400000, source), 100000);
  }
  {
    Policy policy;
    CaptureClockSourceState source;
    check(policy.Map(pair(5000000, 7000000), 5000001, source).status == Status::kFutureCapture,
          "Future QPC capture was silently clamped");
    check(policy.Map(pair(5000000, 7000000), 2999999, source).status == Status::kStaleCapture,
          "Stale capture was silently refreshed");
    check(policy.Map(pair(5000000, 7000000), -1, source).status == Status::kInvalidTimestamp,
          "Negative capture timestamp was accepted");
    check(policy.Map(pair(5000000, 7000000), Policy::kMaxTimestampUs + 1, source).status ==
              Status::kInvalidTimestamp,
          "Unsafe capture timestamp was accepted");
    preserved(policy.Map(pair(5000000, 7000000), 3000000, source), 2000000);
  }
  {
    Policy policy;
    CaptureClockSourceState source;
    check(policy.Map(pair(5000000, 50000), 4900000, source).status == Status::kUntranslatable,
          "Capture predating RTC epoch was made artificially nonnegative");
    preserved(policy.Map(pair(5100000, 150000), 5090000, source), 10000);
  }
  {
    Policy policy;
    CaptureClockSourceState source;
    preserved(policy.Map(pair(1000000, 3000000), 900000, source), 100000);
    check(policy.Map(pair(1010000, 3010000), 900000, source).status == Status::kNonMonotonicCapture,
          "Duplicate capture was incremented instead of dropped");
    check(policy.Map(pair(1020000, 3020000), 899999, source).status == Status::kNonMonotonicCapture,
          "Out-of-order capture was incremented instead of dropped");
    preserved(policy.Map(pair(1030000, 3030000), 920000, source), 110000);
    check(policy.Map(pair(1040000, 3040000), 800000, source).status == Status::kSourceDiscontinuity,
          "Large capture restart was not diagnosed");
    check(policy.Map(pair(1050000, 3050000), 1040000, source).status == Status::kSourceResetRequired,
          "Source timestamp restart silently recovered without explicit reset");
    CaptureClockSourceState independent;
    preserved(policy.Map(pair(1060000, 3060000), 1000000, independent), 60000);
    check(!policy.Snapshot().reset_required, "One source restart poisoned unrelated streams");
  }
  {
    Policy policy;
    CaptureClockSourceState source;
    preserved(policy.Map(pair(1000000, 3000000), 990000, source), 10000);
    // A bounded offset correction makes the delayed capture regress in RTC
    // even though its original QPC timestamp increases.
    check(policy.Map(pair(1100000, 3090000), 991000, source).status ==
              Status::kNonMonotonicTranslation,
          "Regressing mapped frame was fabricated into a monotonic timestamp");
    preserved(policy.Map(pair(1120000, 3110000), 1110000, source), 10000);
  }
  {
    Policy policy;
    CaptureClockSourceState a, b;
    const auto a1 = policy.Map(pair(1000000, 5000000), 950000, a);
    const auto b1 = policy.Map(pair(1000000, 5000000), 850000, b);
    preserved(a1, 50000);
    preserved(b1, 150000);
    check(b1.timestamp_us < a1.timestamp_us, "Unrelated sources shared a frame-order guard");
    const auto a2 = policy.Map(pair(1020000, 5020000), 970000, a);
    const auto b2 = policy.Map(pair(1020000, 5020000), 870000, b);
    preserved(a2, 50000);
    preserved(b2, 150000);
    check(a2.timestamp_us - a1.timestamp_us == 20000 &&
              b2.timestamp_us - b1.timestamp_us == 20000 &&
              a2.timestamp_us - b2.timestamp_us == 100000,
          "Interleaved sources lost their shared epoch or independent capture ages");
    check(policy.Map(pair(1030000, 5030000), 969999, a).status == Status::kNonMonotonicCapture,
          "Per-source ordering was lost between interleaved streams");
    preserved(policy.Map(pair(1040000, 5040000), 890000, b), 150000);
  }
  for (const auto bad : std::array<CaptureClockSample, 4>{
           pair(999999, 3000001), pair(1010000, 2999999),
           pair(1100000, 3300001), pair(1300001, 3100000)}) {
    Policy policy;
    CaptureClockSourceState a, b;
    preserved(policy.Map(pair(1000000, 3000000), 990000, a), 10000);
    check(policy.Map(bad, 995000, a).status == Status::kClockDiscontinuity,
          "Paired clock backwards/restart/jump was not detected before aligner reset");
    check(policy.Snapshot().reset_required, "Clock discontinuity was not latched");
    check(policy.Map(pair(1400000, 3400000), 1390000, b).status == Status::kClockResetRequired,
          "Another source silently continued using a discontinuous shared clock");
  }
  {
    Policy policy;
    CaptureClockSourceState source;
    check(policy.Map({true, 1000000, 3000000, 999999}, 900000, source).status ==
              Status::kClockDiscontinuity,
          "QPC going backwards during sampling was accepted");
    check(CaptureClockRequiresReset(Status::kClockDiscontinuity) &&
              CaptureClockRequiresReset(Status::kSourceDiscontinuity) &&
              !CaptureClockRequiresReset(Status::kSampleUncertain) &&
              !CaptureClockRequiresReset(Status::kNonMonotonicTranslation),
          "Recoverable frame drops and terminal clock failures were conflated");
  }
  {
    Policy policy;
    CaptureClockSourceState source;
    preserved(policy.Map(pair(1000000, 3000000), 900000, source), 100000);
    preserved(policy.Map(pair(1020000, 3040000), 920000, source), 100000);
    preserved(policy.Map(pair(1040000, 3080000), 940000, source), 100000);
    check(policy.Map(pair(1060000, 3120000), 960000, source).status ==
              Status::kClockDiscontinuity,
          "Gradual divergence bypassed bounded error checks and reset the upstream filter");
  }
  {
    Policy policy;
    CaptureClockSourceState source;
    preserved(policy.Map(pair(1000000, 3000000), 900000, source), 100000);
    preserved(policy.Map(pair(61000000, 63000000), 60900000, source), 100000);
    check(!policy.Snapshot().reset_required,
          "Equal clock advancement after an idle interval was mistaken for a restart");
  }
  {
    Policy policy;
    CaptureClockSourceState source;
    const auto huge = Policy::kMaxTimestampUs;
    preserved(policy.Map(pair(huge, 1000000), huge - 100000, source), 100000);
    std::int64_t converted = -1;
    check(CaptureQpcMicroseconds(123456789, 10000000, converted) && converted == 12345678,
          "QPC conversion changed SystemRelativeTime microsecond truncation");
    check(CaptureQpcMicroseconds((std::numeric_limits<std::int64_t>::max)(), 10000000, converted),
          "QPC conversion overflowed before dividing large tick values");
    check(!CaptureQpcMicroseconds(-1, 10000000, converted) &&
              !CaptureQpcMicroseconds(1, 0, converted) &&
              !CaptureQpcMicroseconds((std::numeric_limits<std::int64_t>::max)(), 1, converted),
          "Invalid or overflowing QPC conversion was accepted");
  }
  {
    // Closing is inert: the production wrapper must not sample QPC or RTC once
    // the owning environment begins retirement.
    webrtc::SimulatedClock environment_clock(1000000);
    CaptureClock clock(environment_clock);
    CaptureClockSourceState source;
    clock.Close();
    clock.Close();
    check(clock.Map(990000, source).status == Status::kClosed &&
              clock.Snapshot().closed && clock.Snapshot().paired_samples == 0,
          "Closed capture mapper still accessed clocks or accepted source work");
  }
}

}  // namespace monky::native_rtc::engine
