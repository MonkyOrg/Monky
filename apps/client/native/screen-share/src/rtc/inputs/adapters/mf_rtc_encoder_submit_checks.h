#pragma once

namespace monky::native_rtc::mf {

// Actual EncoderWorker::Submit/UpdateRates and bounded CPU queue controls.
// Workers are never started; registered fixtures have no pixels/GPU objects.
// Queue acceptance is NOT source readiness, core/MF admission or encoded output.
void RunEncoderSubmitBranchChecks(void (*check)(bool, const char*));

}  // namespace monky::native_rtc::mf
