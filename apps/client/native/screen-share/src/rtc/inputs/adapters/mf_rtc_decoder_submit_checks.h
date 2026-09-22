#pragma once

namespace monky::native_rtc::mf {

// Actual, unstarted DecoderWorker Submit/recovery and CPU callback controls.
// No worker thread, core, MFT, device, GPU delivery or readback is exercised.
// Queue/core-metadata admission and void callback completion are not MF/RTC acceptance.
void RunDecoderSubmitBranchChecks(void (*check)(bool, const char*));
void RunDecoderMappingChecks(void (*check)(bool, const char*));

}  // namespace monky::native_rtc::mf
