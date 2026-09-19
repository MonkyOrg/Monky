#pragma once

#include "encoder_diagnostics.h"

namespace monky::native_rtc::engine {

inline Json DecoderSchedulingSnapshot(const screen_video::DecoderSchedulingStats& value) {
  return {{"clock", "process-steady-clock"},
          {"enqueueToFirstProcessInput", EncoderTimingSnapshot(value.enqueueToFirstProcessInput)},
          {"enqueueToAccepted", EncoderTimingSnapshot(value.enqueueToAccepted)},
          {"processInput", EncoderTimingSnapshot(value.processInput)},
          {"processOutput", EncoderTimingSnapshot(value.processOutput)},
          {"acceptedToOutputSample", EncoderTimingSnapshot(value.acceptedToOutputSample)},
          {"copyOutput", EncoderTimingSnapshot(value.copyOutput)},
          {"acceptedCallback", EncoderTimingSnapshot(value.acceptedCallback)},
          {"frameSink", EncoderTimingSnapshot(value.frameSink)},
          {"outputCapacityChecks", value.outputCapacityChecks},
          {"outputCapacityDeferrals", value.outputCapacityDeferrals},
          {"processInputOtherHresults", value.processInputOtherHresults},
          {"processOutputOtherHresults", value.processOutputOtherHresults},
          {"pumpBudgetYields", value.pumpBudgetYields}};
}

template <typename Outcome, typename Name>
inline Json DecoderCallsJson(const mf::DecoderCallDiagnostics<Outcome>& value, Name&& name) {
  Json outcomes = Json::object();
  for (std::size_t i = 0; i < value.outcomes.size(); ++i)
    outcomes[name(static_cast<Outcome>(i))] = value.outcomes[i];
  return {{"calls", value.calls}, {"inProgress", value.in_progress}, {"outcomes", std::move(outcomes)},
          {"duration", EncoderTimingSnapshot(value.duration)}};
}

inline Json DecoderLedgerJson(const mf::DecoderDiagnosticSnapshot& value) {
  Json stages = Json::object(), operations = Json::object(), intervals = Json::object();
  for (std::size_t i = 0; i < value.inputs.size(); ++i) {
    const auto& stage = value.inputs[i];
    Json releases = Json::object();
    for (std::size_t j = 0; j < stage.releases.size(); ++j)
      releases[mf::DecoderInputReleaseReasonName(static_cast<mf::DecoderInputReleaseReason>(j))] = stage.releases[j];
    stages[mf::DecoderInputStageName(static_cast<mf::DecoderInputStage>(i))] =
        {{"entered", stage.entered}, {"active", stage.active}, {"transitioned", stage.transitioned},
         {"releases", std::move(releases)}};
  }
  for (std::size_t i = 0; i < value.operations.size(); ++i) {
    const auto& operation = value.operations[i];
    operations[mf::DecoderOperationName(static_cast<mf::DecoderOperation>(i))] =
        {{"calls", operation.calls}, {"inProgress", operation.in_progress},
         {"returned", operation.returned}, {"exceptions", operation.exceptions},
         {"lastStartSteadyUs", DiagnosticValue(operation.last_start_steady_us)},
         {"lastCompletionSteadyUs", DiagnosticValue(operation.last_completion_steady_us)},
         {"duration", EncoderTimingSnapshot(operation.duration)}};
  }
  for (std::size_t i = 0; i < value.intervals.size(); ++i)
    intervals[mf::DecoderIntervalName(static_cast<mf::DecoderInterval>(i))] =
        EncoderTimingSnapshot(value.intervals[i]);
  return {{"counterScope", "decoder-worker-lifetime"}, {"clock", "process-steady-clock"},
          {"observedAtSteadyUs", DiagnosticValue(value.observed_at_steady_us)},
          {"snapshotCopyMs", DiagnosticValue(value.snapshot_copy_ms)},
          {"currentLossEpoch", value.current_loss_epoch},
          {"submit", DecoderCallsJson(value.submit, mf::DecoderSubmitOutcomeName)},
          {"output", DecoderCallsJson(value.output, mf::DecoderOutputOutcomeName)},
          {"inputStages", std::move(stages)}, {"operations", std::move(operations)},
          {"intervals", std::move(intervals)}, {"bookkeeping", EncoderTimingSnapshot(value.bookkeeping)},
          {"recovery", {{"requests", value.recovery_requests}, {"epochAdvances", value.epoch_advances},
                         {"begun", value.recoveries_begun}, {"finished", value.recoveries_finished},
                         {"sessionSwitches", value.session_switches}}},
          {"acceptedCallbacks", {{"calls", value.accepted_callbacks}, {"unknownRequest", value.accepted_unknown},
                                  {"duplicateRequest", value.accepted_duplicate}}},
          {"lastAcceptedLossEpoch", DiagnosticValue(value.last_accepted_loss_epoch)},
          {"lastOutputLossEpoch", DiagnosticValue(value.last_output_loss_epoch)},
          {"callbackRtcAcceptance", nullptr}};
}

inline Json DecoderRuntimeJson(const mf::DecoderRuntimeSnapshot& decoder) {
  Json core = nullptr;
  if (decoder.core_observed) {
    const auto& value = decoder.core;
    core = {
        {"counterScope", "mf-core-instance"}, {"generation", decoder.core_generation},
        {"startedInLossEpoch", DiagnosticValue(decoder.core_start_loss_epoch)},
        {"observedAtRtcUs", DiagnosticValue(decoder.core_observed_at_rtc_us)},
        {"configured", {{"width", decoder.configured.width}, {"height", decoder.configured.height},
                        {"capabilityFpsHint", decoder.configured.fps},
                        {"capabilityBitrateHintBps", decoder.configured.bitrateBps},
                        {"maxInFlight", decoder.configured.maxInFlight},
                        {"maxPendingPackets", decoder.configured.maxPendingPackets},
                        {"profileLevelId", decoder.configured.profileLevelId}}},
        {"state", value.state}, {"implementation", value.name}, {"clsid", value.clsid},
        {"adapter", {{"description", value.adapterDescription}, {"driverVersion", value.driverVersion},
                     {"vendorId", value.vendorId}, {"deviceId", value.deviceId},
                     {"luidLowPart", value.luid.LowPart}, {"luidHighPart", value.luid.HighPart}}},
        {"synchronous", value.synchronous}, {"d3d11Aware", value.d3d11Aware},
        {"d3d11Configured", value.d3d11Configured}, {"lowLatencyConfigured", value.lowLatencyConfigured},
        {"gpuOutputValidated", value.gpuOutputValidated}, {"capabilitiesChecked", value.capabilitiesChecked},
        {"nv12Supported", value.nv12Supported}, {"hardwareExecutionObserved", DiagnosticValue(value.hardwareExecutionObserved)},
        {"decoderCaps", value.decoderCaps}, {"capsWidth", value.capsWidth}, {"capsHeight", value.capsHeight},
        {"outputTypeConfigured", value.outputTypeConfigured}, {"spsVerified", value.spsVerified},
        {"accepted", value.accepted}, {"submitted", value.submitted}, {"inputBytes", value.inputBytes},
        {"notAccepting", value.notAccepting}, {"outputSamples", value.outputSamples},
        {"gpuFrames", value.gpuFrames}, {"sampleReturns", value.sampleReturns},
        {"gpuCopies", value.gpuCopies}, {"gpuCopiesCompleted", value.gpuCopiesCompleted},
        {"discardedGpuFrames", value.discardedGpuFrames}, {"abandonedGpuCopies", value.abandonedGpuCopies},
        {"streamChanges", value.streamChanges}, {"needMoreInput", value.needMoreInput}, {"flushes", value.flushes},
        {"droppedInput", value.droppedInput}, {"droppedAfterSubmit", value.droppedAfterSubmit}, {"errors", value.errors},
        {"pendingPackets", value.pendingPackets}, {"pendingBytes", value.pendingBytes},
        {"pendingGpuCopies", value.pendingGpuCopies}, {"awaitingOutput", value.awaitingOutput},
        {"peakAwaitingOutput", value.peakAwaitingOutput}, {"peakGpuCopies", value.peakGpuCopies},
        {"diagnosticReadbacks", value.diagnosticReadbacks}, {"diagnosticReadbackBytes", value.diagnosticReadbackBytes},
        {"i420Readbacks", value.i420Readbacks}, {"i420ReadbackBytes", value.i420ReadbackBytes},
        {"totalDecodeLatencyMs", value.totalDecodeLatencyMs}, {"maxDecodeLatencyMs", value.maxDecodeLatencyMs},
        {"totalGpuHoldMs", value.totalGpuHoldMs}, {"maxGpuHoldMs", value.maxGpuHoldMs},
        {"firstTimestampUs", value.firstTimestampUs < 0 ? Json(nullptr) : Json(value.firstTimestampUs)},
        {"lastTimestampUs", value.lastTimestampUs < 0 ? Json(nullptr) : Json(value.lastTimestampUs)},
        {"scheduling", DecoderSchedulingSnapshot(value.scheduling)}};
  }
  return {
      {"sessionId", decoder.session_id},
      {"configuredLimits", {{"maximumWidth", decoder.maximum_width}, {"maximumHeight", decoder.maximum_height},
                            {"maxInFlight", decoder.maximum_in_flight},
                            {"maxPendingFrames", decoder.maximum_pending_frames},
                            {"maxPendingEncodedBytes", decoder.maximum_pending_bytes},
                            {"capabilityFpsHint", decoder.capability_fps_hint},
                            {"capabilityBitrateHintBps", decoder.capability_bitrate_hint_bps}}},
      {"worker", {{"clock", "webrtc-clock-TimeInMicroseconds"},
                   {"observedAtRtcUs", DiagnosticValue(decoder.observed_at_rtc_us)},
                   {"observationSequence", decoder.observation_sequence}, {"lossEpoch", decoder.loss_epoch},
                   {"status", decoder.worker_status}, {"pendingFrames", decoder.pending_frames},
                   {"submittedMetadata", decoder.submitted_metadata}, {"retainedLeases", decoder.retained_leases},
                   {"retiredCoreSessions", decoder.retired_core_sessions},
                   {"recoveryRequested", decoder.recovery_requested}, {"recoveryInProgress", decoder.recovery_in_progress},
                   {"needsKeyframe", decoder.needs_keyframe}, {"flushing", decoder.flushing},
                   {"switching", decoder.switching}, {"stopping", decoder.stopping}}},
      {"diagnostics", decoder.diagnostics ? DecoderLedgerJson(*decoder.diagnostics) : Json(nullptr)},
      {"core", std::move(core)}};
}

}  // namespace monky::native_rtc::engine
