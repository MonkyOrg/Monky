#pragma once

#include "encoder_diagnostics.h"

namespace monky::native_rtc::engine {

template <typename Check>
void RunEncoderJsonChecks(Check&& check) {
  mf::EncoderRuntimeSnapshot encoder;
  auto missing = EncoderRuntimeJson(encoder);
  check(missing.at("core").is_null() && missing.at("diagnostics").is_null() &&
        missing.at("rtcRequestedFps").is_null() &&
        missing.at("configured").at("initEncodeMaxBitrateBps").is_null(),
        "Unobserved encoder/core/rates were exported as observed zero values");
  encoder.session_id = 606;
  encoder.configured.fps = 120;
  encoder.configured.bitrateBps = 1000000;
  encoder.maximum_bitrate_bps = 20000000;
  encoder.requested_keyframe_interval = 3000;
  encoder.diagnostics = mf::EncoderDiagnosticSnapshot{};
  auto initial = EncoderRuntimeJson(encoder);
  check(initial.at("diagnostics").at("submit").at("requests") == 0 &&
        initial.at("diagnostics").at("rates").at("validSetRates") == 0 &&
        initial.at("diagnostics").at("rates").at("setRatesTargetBitrateBps").is_null() &&
        initial.at("core").is_null(),
        "Observed adapter zero invented a SetRates or MF observation");
  auto& rates = encoder.diagnostics->rates;
  rates.valid_set_rates = 1;
  rates.target_bitrate_bps = 17000000;
  rates.adjusted_bitrate_bps = 14000000;
  rates.bandwidth_allocation_bps = 19000000;
  rates.framerate_fps = 59.94;
  rates.policy_bitrate_bps = 14000000;
  rates.effective_limiter_fps = 59.94;
  encoder.core_observed = true;
  encoder.core.bitrateBps = 13000000;
  encoder.core.configurationReadbacks.gopSize = {30, screen_video::EncoderReadbackState::Available,
      S_OK, VT_UI4, 1, screen_video::EncoderReadbackReason::None, S_OK};
  auto snapshot = EncoderRuntimeJson(encoder);
  const auto& serialized_rates = snapshot.at("diagnostics").at("rates");
  check(snapshot.at("configured").at("initEncodeMaxBitrateBps") == 20000000 &&
        snapshot.at("configured").at("initialMfBitrateBps") == 1000000 &&
        serialized_rates.at("setRatesTargetBitrateBps") == 17000000 &&
        serialized_rates.at("setRatesAdjustedBitrateBps") == 14000000 &&
        serialized_rates.at("setRatesBandwidthAllocationBps") == 19000000 &&
        snapshot.at("core").at("programmedBitrateBps") == 13000000 &&
        snapshot.at("configured").at("fps") == 120 &&
        serialized_rates.at("setRatesFramerateFps") == 59.94 &&
        serialized_rates.at("adapterLimiterFps") == 59.94,
        "The serialized bitrate/FPS fields collapsed distinct configured/observed stages");
  const auto& properties = snapshot.at("core").at("configurationReadback");
  check(snapshot.at("configured").at("rtcKeyFrameIntervalFrames") == 3000 &&
        properties.at("requestedGopSizeFrames").is_null() &&
        properties.at("gopSizeFrames").at("value") == 30 &&
        properties.at("gopSizeFrames").at("state") == "available" &&
        properties.at("gopSizeFrames").at("hresult") == 0 &&
        properties.at("meanBitrateBps").at("value").is_null() &&
        properties.at("meanBitrateBps").at("observations") == 0,
        "The RTC interval was fabricated as a programmed/read-back MFT GOP or bitrate");
  check(snapshot.at("core").at("scheduling").at("processInput").at("count") == 0 &&
        snapshot.at("core").at("scheduling").at("processInput").at("meanMs").is_null(),
        "Moving snapshot serialization changed existing timing availability");
  for (std::size_t i = 0; i < encoder.diagnostics->submit.outcomes.size(); ++i)
    encoder.diagnostics->submit.outcomes[i] = i + 1;
  const auto named = EncoderRuntimeJson(encoder);
  for (std::size_t i = 0; i < encoder.diagnostics->submit.outcomes.size(); ++i)
    check(named.at("diagnostics").at("submit").at("outcomes").at(
        mf::EncoderSubmitOutcomeName(static_cast<mf::EncoderSubmitOutcome>(i))) == i + 1,
        "An adapter Submit branch was missing or renamed incorrectly in the recorded snapshot");
  check(named.at("diagnostics").at("inputStages").size() == encoder.diagnostics->inputs.size() &&
        named.at("diagnostics").at("inputStages").at("pending").at("releases").size() ==
            encoder.diagnostics->inputs.front().releases.size(),
        "The recorded snapshot lost a bounded input stage or release reason");
  rates.valid_set_rates = 2;
  rates.target_bitrate_bps = rates.adjusted_bitrate_bps = 0;
  rates.policy_bitrate_bps = 0;
  const auto paused = EncoderRuntimeJson(encoder);
  check(paused.at("diagnostics").at("rates").at("setRatesAdjustedBitrateBps") == 0 &&
        paused.at("core").at("programmedBitrateBps") == 13000000 &&
        snapshot.at("diagnostics").at("rates").at("setRatesAdjustedBitrateBps") == 14000000,
        "Pause rewrote the programmed MF bitrate or mutated an earlier snapshot");
}

}  // namespace monky::native_rtc::engine
