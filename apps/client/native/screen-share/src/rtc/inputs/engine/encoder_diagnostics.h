#pragma once

#include "engine_shared.h"
#include "mf_rtc_adapters.h"

namespace monky::native_rtc::engine {

template <typename T>
inline Json DiagnosticValue(const std::optional<T>& value) {
  return value ? Json(*value) : Json(nullptr);
}

inline Json EncoderTimingSnapshot(const screen_video::EncoderTimingAggregate& timing) {
  const auto mean = timing.MeanMs(), maximum = timing.MaximumMs();
  return {{"count", timing.count}, {"totalMs", timing.totalMs},
          {"meanMs", mean ? Json(*mean) : Json(nullptr)},
          {"maxMs", maximum ? Json(*maximum) : Json(nullptr)},
          {"invalidIntervals", timing.invalidIntervals}};
}

inline Json EncoderSchedulingSnapshot(const screen_video::EncoderSchedulingStats& scheduling) {
  const auto event = [&](const screen_video::EncoderCallbackTiming& callback,
                         const screen_video::EncoderTimingAggregate& dispatch) {
    return Json{{"callbacks", callback.callbacks},
                {"arrivalInterval", EncoderTimingSnapshot(callback.arrivalInterval)},
                {"callbackToQueue", EncoderTimingSnapshot(callback.callbackToQueue)},
                {"queueToDispatch", EncoderTimingSnapshot(dispatch)}};
  };
  return {{"clock", "steady-clock"}, {"needInput", event(scheduling.needInput, scheduling.needInputDispatch)},
          {"haveOutput", event(scheduling.haveOutput, scheduling.haveOutputDispatch)},
          {"processInput", EncoderTimingSnapshot(scheduling.processInput)},
          {"processOutput", EncoderTimingSnapshot(scheduling.processOutput)},
          {"packetSink", EncoderTimingSnapshot(scheduling.packetSink)},
          {"peakPendingNotices", scheduling.peakPendingNotices}};
}

inline Json EncoderPropertySnapshot(const screen_video::EncoderPropertyReadback& property) {
  return {{"value", DiagnosticValue(property.value)},
          {"state", screen_video::EncoderReadbackStateName(property.state)},
          {"reason", screen_video::EncoderReadbackReasonName(property.reason)},
          {"hresult", DiagnosticValue(property.hresult)},
          {"variantType", DiagnosticValue(property.variantType)},
          {"observations", property.observations},
          {"cleanupHresult", DiagnosticValue(property.cleanupHresult)}};
}

inline Json EncoderLedgerSnapshot(const mf::EncoderDiagnosticSnapshot& diagnostics) {
  Json outcomes = Json::object(), inputs = Json::object();
  for (std::size_t i = 0; i < diagnostics.submit.outcomes.size(); ++i)
    outcomes[mf::EncoderSubmitOutcomeName(static_cast<mf::EncoderSubmitOutcome>(i))] = diagnostics.submit.outcomes[i];
  for (std::size_t i = 0; i < diagnostics.inputs.size(); ++i) {
    const auto& stage = diagnostics.inputs[i];
    Json releases = Json::object();
    for (std::size_t j = 0; j < stage.releases.size(); ++j)
      releases[mf::EncoderInputReleaseReasonName(static_cast<mf::EncoderInputReleaseReason>(j))] = stage.releases[j];
    inputs[mf::EncoderInputStageName(static_cast<mf::EncoderInputStage>(i))] =
        {{"entered", stage.entered}, {"active", stage.active}, {"releases", std::move(releases)}};
  }
  const auto attempt = [](const mf::EncoderAttemptDiagnostics& value) {
    return Json{{"calls", value.calls}, {"inProgress", value.in_progress},
                {"accepted", value.accepted}, {"refused", value.refused}, {"exceptions", value.exceptions}};
  };
  const auto& rates = diagnostics.rates;
  return {{"submit", {{"requests", diagnostics.submit.requests}, {"inProgress", diagnostics.submit.in_progress},
                      {"outcomes", std::move(outcomes)}}},
          {"inputStages", std::move(inputs)}, {"sourceReady", attempt(diagnostics.source_ready)},
          {"coreTryEncode", attempt(diagnostics.core_try_encode)},
          {"coreCapacityDeferrals", diagnostics.core_capacity_deferrals},
          {"keyframeDrainDeferrals", diagnostics.keyframe_drain_deferrals},
          {"rates", {{"validSetRates", rates.valid_set_rates},
                     {"setRatesTargetBitrateBps", DiagnosticValue(rates.target_bitrate_bps)},
                     {"setRatesAdjustedBitrateBps", DiagnosticValue(rates.adjusted_bitrate_bps)},
                     {"setRatesBandwidthAllocationBps", DiagnosticValue(rates.bandwidth_allocation_bps)},
                     {"setRatesFramerateFps", DiagnosticValue(rates.framerate_fps)},
                     {"adapterRequestedBitrateBps", rates.policy_bitrate_bps},
                     {"adapterLimiterFps", rates.effective_limiter_fps}}}};
}

inline Json EncoderRuntimeJson(const mf::EncoderRuntimeSnapshot& encoder) {
  Json observed_core = nullptr;
  if (encoder.core_observed) {
    const auto& core = encoder.core;
    const auto& readbacks = core.configurationReadbacks;
    observed_core = {
        {"state", core.state}, {"implementation", core.info.name}, {"clsid", core.info.clsid},
        {"hardwareAdvertised", core.info.hardware}, {"d3d11Aware", core.info.d3d11Aware},
        {"asynchronous", core.info.asynchronous}, {"lowLatencyConfigured", core.info.lowLatency},
        {"inputs", core.inputs}, {"accepted", core.accepted}, {"submitted", core.submitted},
        {"outputs", core.outputs}, {"bytes", core.bytes}, {"inFlight", core.inFlight},
        {"peakInFlight", core.peakInFlight}, {"bitrateBps", core.bitrateBps},
        {"programmedBitrateBps", core.bitrateBps}, {"bitrateUpdates", core.bitrateUpdates},
        {"keyFrames", core.keyFrames}, {"keyFrameRequests", core.keyFrameRequests},
        {"droppedInput", core.droppedInput}, {"droppedOnStop", core.droppedOnStop},
        {"droppedAfterSubmit", core.droppedAfterSubmit},
        {"needInputEvents", core.needInputEvents}, {"haveOutputEvents", core.haveOutputEvents},
        {"totalEncodeLatencyMs", core.totalEncodeLatencyMs}, {"maxEncodeLatencyMs", core.maxEncodeLatencyMs},
        {"totalQueueLatencyMs", core.totalQueueLatencyMs}, {"maxQueueLatencyMs", core.maxQueueLatencyMs},
        {"configurationReadback", {
            {"requestedGopSizeFrames", nullptr},
            {"requestedRateControlMode", static_cast<std::uint32_t>(eAVEncCommonRateControlMode_CBR)},
            {"gopSizeFrames", EncoderPropertySnapshot(readbacks.gopSize)},
            {"rateControlMode", EncoderPropertySnapshot(readbacks.rateControlMode)},
            {"meanBitrateBps", EncoderPropertySnapshot(readbacks.meanBitrateBps)}}},
        {"scheduling", EncoderSchedulingSnapshot(core.scheduling)}};
  }
  return {{"sessionId", encoder.session_id}, {"encodeRequests", encoder.encode_requests},
          {"configured", {{"width", encoder.configured.width}, {"height", encoder.configured.height},
                          {"fps", encoder.configured.fps}, {"maxInFlight", encoder.configured.maxInFlight},
                          {"initialMfBitrateBps", encoder.configured.bitrateBps},
                          {"initEncodeMaxBitrateBps", encoder.maximum_bitrate_bps
                              ? Json(encoder.maximum_bitrate_bps) : Json(nullptr)},
                          {"rtcKeyFrameIntervalFrames", encoder.requested_keyframe_interval}}},
          {"requestedFps", encoder.requested_fps}, {"requestedBitrateBps", encoder.requested_bitrate_bps},
          {"rtcRequestedFps", DiagnosticValue(encoder.rtc_requested_fps)},
          {"pendingFrames", encoder.pending_frames}, {"submittedMetadata", encoder.submitted_metadata},
          {"diagnostics", encoder.diagnostics ? EncoderLedgerSnapshot(*encoder.diagnostics) : Json(nullptr)},
          {"core", std::move(observed_core)}};
}

}  // namespace monky::native_rtc::engine
