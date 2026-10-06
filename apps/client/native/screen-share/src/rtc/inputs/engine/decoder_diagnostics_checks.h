#pragma once

#include "decoder_diagnostics.h"

namespace monky::native_rtc::engine {

template <typename Check>
void RunDecoderJsonChecks(Check&& check) {
  mf::DecoderRuntimeSnapshot decoder;
  const auto absent = DecoderRuntimeJson(decoder);
  check(absent.at("core").is_null() && absent.at("diagnostics").is_null() &&
        absent.at("worker").at("observedAtRtcUs").is_null(),
        "Missing decoder worker/core observation was manufactured as observed zero");
  decoder.session_id = 606;
  decoder.maximum_pending_frames = 32;
  decoder.maximum_pending_bytes = 32 * 1024 * 1024;
  decoder.maximum_in_flight = 8;
  decoder.capability_fps_hint = 30;
  decoder.capability_bitrate_hint_bps = 4000000;
  decoder.observed_at_rtc_us = 606010;
  decoder.observation_sequence = 1;
  decoder.diagnostics = mf::DecoderDiagnosticSnapshot{};
  auto observed = DecoderRuntimeJson(decoder);
  check(observed.at("diagnostics").at("submit").at("calls") == 0 &&
        observed.at("diagnostics").at("callbackRtcAcceptance").is_null() &&
        observed.at("diagnostics").at("lastOutputLossEpoch").is_null() &&
        observed.at("diagnostics").at("operations").at("callback").at("lastStartSteadyUs").is_null() &&
        observed.at("diagnostics").at("operations").at("callback").at("duration").at("meanMs").is_null() &&
        observed.at("core").is_null() &&
        observed.at("configuredLimits").at("maxPendingFrames") == 32 &&
        observed.at("configuredLimits").at("maxPendingEncodedBytes") == 33554432,
        "Observed adapter zero fabricated MF output/RTC acceptance or changed admission bounds");
  decoder.core_observed = true;
  decoder.core_generation = 1;
  decoder.core_start_loss_epoch = 0;
  decoder.core_observed_at_rtc_us = 606007;
  decoder.configured = {1920, 1080, 30, 4000000, 8, 32, "42c033"};
  decoder.core.accepted = 32;
  decoder.core.submitted = 20;
  decoder.core.pendingPackets = 12;
  decoder.core.awaitingOutput = 11;
  decoder.core.pendingGpuCopies = 2;
  decoder.core.notAccepting = 9;
  decoder.core.gpuFrames = 7;
  decoder.core.firstTimestampUs = 0;
  decoder.core.lastTimestampUs = 50000;
  decoder.core.totalDecodeLatencyMs = 237.5;
  decoder.core.totalGpuHoldMs = 3;
  decoder.retained_leases = 6;
  decoder.retired_core_sessions = 1;
  auto& scheduler = decoder.core.scheduling;
  const auto start = screen_video::EncoderTimingAggregate::Clock::time_point{};
  scheduler.processInput.Observe(start, start);
  scheduler.outputCapacityDeferrals = 12;
  auto detailed = DecoderRuntimeJson(decoder);
  check(detailed.at("core").at("accepted") == 32 && detailed.at("core").at("submitted") == 20 &&
        detailed.at("core").at("pendingPackets") == 12 && detailed.at("core").at("notAccepting") == 9 &&
        detailed.at("core").at("awaitingOutput") == 11 && detailed.at("core").at("pendingGpuCopies") == 2 &&
        detailed.at("worker").at("retainedLeases") == 6 &&
        detailed.at("worker").at("retiredCoreSessions") == 1 &&
        detailed.at("core").at("droppedAfterSubmit") == 0 && detailed.at("core").at("gpuFrames") == 7,
        "Cached decoder stages conflated refusal/pending/retained output with a media drop");
  check(detailed.at("core").at("scheduling").at("processInput").at("meanMs") == 0 &&
        detailed.at("core").at("scheduling").at("processOutput").at("meanMs").is_null() &&
        detailed.at("core").at("scheduling").at("outputCapacityDeferrals") == 12 &&
        detailed.at("core").at("firstTimestampUs") == 0 &&
        detailed.at("core").at("hardwareExecutionObserved").is_null() &&
        detailed.at("core").at("totalDecodeLatencyMs") == 237.5 &&
        detailed.at("core").at("totalGpuHoldMs") == 3,
        "Decoder timing/PTS/physical availability was rewritten or observed zero was lost");
  decoder.loss_epoch = 2;
  decoder.diagnostics->current_loss_epoch = 3;
  decoder.core_start_loss_epoch = 1;
  decoder.diagnostics->last_accepted_loss_epoch = 2;
  decoder.diagnostics->last_output_loss_epoch = 1;
  auto mixed = DecoderRuntimeJson(decoder);
  check(mixed.at("worker").at("lossEpoch") == 2 && mixed.at("diagnostics").at("currentLossEpoch") == 3 &&
        mixed.at("diagnostics").at("lastOutputLossEpoch") == 1 &&
        mixed.at("core").at("startedInLossEpoch") == 1 &&
        mixed.at("worker").at("observedAtRtcUs") == 606010 &&
        mixed.at("core").at("observedAtRtcUs") == 606007,
        "Non-atomic worker/ledger/core observations were silently repaired into a fabricated common epoch");
  for (std::size_t i = 0; i < decoder.diagnostics->submit.outcomes.size(); ++i)
    decoder.diagnostics->submit.outcomes[i] = i + 1;
  for (std::size_t i = 0; i < decoder.diagnostics->output.outcomes.size(); ++i)
    decoder.diagnostics->output.outcomes[i] = i + 100;
  auto named = DecoderRuntimeJson(decoder);
  for (std::size_t i = 0; i < decoder.diagnostics->submit.outcomes.size(); ++i)
    check(named.at("diagnostics").at("submit").at("outcomes").at(
              mf::DecoderSubmitOutcomeName(static_cast<mf::DecoderSubmitOutcome>(i))) == i + 1,
          "A Submit outcome was missing from the saved native JSON");
  for (std::size_t i = 0; i < decoder.diagnostics->output.outcomes.size(); ++i)
    check(named.at("diagnostics").at("output").at("outcomes").at(
              mf::DecoderOutputOutcomeName(static_cast<mf::DecoderOutputOutcome>(i))) == i + 100,
          "An output/callback outcome was missing from the saved native JSON");
  check(named.at("diagnostics").at("inputStages").size() == decoder.diagnostics->inputs.size() &&
        named.at("diagnostics").at("inputStages").at("process-input-accepted").at("releases").size() ==
            decoder.diagnostics->inputs.front().releases.size(),
        "Input-stage/release serialization dropped a bounded diagnostic branch");
  const auto frozen = Json::parse(named.dump());
  decoder.core_generation = 2;
  decoder.core = {};
  decoder.core_observed_at_rtc_us = 607000;
  const auto replacement = DecoderRuntimeJson(decoder);
  check(replacement.at("core").at("generation") == 2 && replacement.at("core").at("submitted") == 0 &&
        replacement.at("core").at("firstTimestampUs").is_null() &&
        frozen.at("core").at("generation") == 1 && frozen.at("core").at("submitted") == 20 &&
        replacement.at("diagnostics").at("submit") == frozen.at("diagnostics").at("submit"),
        "Core replacement inherited old core stats, reset worker totals or mutated an earlier saved sample");
  decoder.core_observed = false;
  check(DecoderRuntimeJson(decoder).at("core").is_null(),
        "A retired/unobserved current core was exported as a successful zero-state replacement");
}

}  // namespace monky::native_rtc::engine
