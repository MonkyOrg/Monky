#pragma once

#include "mf_rtc_internal.h"

#include <mferror.h>

#include <future>
#include <numeric>
#include <string_view>
#include <thread>

namespace monky::native_rtc::mf {
namespace decoder_diagnostic_checks_detail {

inline std::uint64_t Sum(const auto& values) {
  return std::accumulate(values.begin(), values.end(), std::uint64_t{0});
}

inline bool Conserved(const DecoderDiagnosticSnapshot& value) {
  if (value.submit.calls != value.submit.in_progress + Sum(value.submit.outcomes) ||
      value.output.calls != value.output.in_progress + Sum(value.output.outcomes)) return false;
  for (const auto& stage : value.inputs)
    if (stage.entered != stage.active + stage.transitioned + Sum(stage.releases)) return false;
  for (const auto& operation : value.operations)
    if (operation.calls != operation.in_progress + operation.returned + operation.exceptions) return false;
  return true;
}

inline void Reach(detail::DecoderInputDiagnosticTicket& input, DecoderInputStage stage) {
  if (stage >= DecoderInputStage::Queued) input.Queued();
  if (stage >= DecoderInputStage::Dispatching) input.Dispatched();
  if (stage >= DecoderInputStage::WorkerPending) input.Pending();
  if (stage >= DecoderInputStage::CoreAccepted) {
    input.CoreEnqueueStarting();
    input.CoreAccepted();
  }
  if (stage >= DecoderInputStage::ProcessInputAccepted) input.ProcessInputAccepted();
  if (stage >= DecoderInputStage::OutputMatched) input.OutputMatched(detail::DecoderDiagnosticClock::now());
}

class LimitedDecoderSurfacePool {
 public:
  explicit LimitedDecoderSurfacePool(std::size_t count) : capacity_(count) {
    for (std::size_t i = 1; i <= count; ++i) samples_.push_back(i);
  }
  bool TransformCall() {
    std::unique_lock lock(mutex_);
    ++calls_;
    changed_.notify_all();
    changed_.wait(lock, [&] { return cancelled_ || samples_.size() < capacity_; });
    return !cancelled_;
  }
  void RetireCopies() {
    std::lock_guard lock(mutex_);
    while (!samples_.empty() && samples_.front() <= completed_) {
      samples_.pop_front();
      ++returned_;
    }
    changed_.notify_all();
  }
  void CompleteFence(std::uint64_t completed) {
    std::lock_guard lock(mutex_);
    completed_ = completed;
    changed_.notify_all();
  }
  bool WaitForCall() {
    std::unique_lock lock(mutex_);
    return changed_.wait_for(lock, std::chrono::seconds(2), [&] { return calls_ != 0; });
  }
  void CancelFixtureWait() {
    std::lock_guard lock(mutex_);
    cancelled_ = true;
    changed_.notify_all();
  }
  std::size_t Pending() const { std::lock_guard lock(mutex_); return samples_.size(); }
  std::size_t Returned() const { std::lock_guard lock(mutex_); return returned_; }
  std::size_t Calls() const { std::lock_guard lock(mutex_); return calls_; }

 private:
  mutable std::mutex mutex_;
  std::condition_variable changed_;
  std::deque<std::uint64_t> samples_;
  const std::size_t capacity_;
  std::uint64_t completed_ = 0;
  std::size_t calls_ = 0, returned_ = 0;
  bool cancelled_ = false;
};

}  // namespace decoder_diagnostic_checks_detail

template <typename Check>
void RunDecoderDiagnosticChecks(Check&& check) {
  using namespace detail;
  using namespace decoder_diagnostic_checks_detail;
  auto ledger = std::make_shared<DecoderDiagnosticLedger>();
  const auto untouched = ledger->Snapshot();
  check(Conserved(untouched) && untouched.submit.calls == 0 && untouched.output.calls == 0 &&
        !untouched.last_accepted_loss_epoch && !untouched.last_output_loss_epoch &&
        untouched.observed_at_steady_us && untouched.snapshot_copy_ms &&
        untouched.bookkeeping.count == 0,
        "An observed empty decoder ledger invented a media/core/timing outcome");

  for (std::size_t i = 0; i < static_cast<std::size_t>(DecoderSubmitOutcome::Count); ++i) {
    const auto before = ledger->Snapshot();
    {
      DecoderSubmitDiagnostic call(*ledger, &DecoderDiagnosticSnapshot::submit, DecoderSubmitOutcome::Exception);
      call.Select(static_cast<DecoderSubmitOutcome>(i));
      call.Select(DecoderSubmitOutcome::Exception);
      const auto pending = ledger->Snapshot();
      check(Conserved(pending) && pending.submit.in_progress == 1 &&
            pending.submit.calls == before.submit.calls + 1 &&
            pending.submit.outcomes == before.submit.outcomes,
            "Selecting a Submit branch completed it early or counted a second outcome");
    }
    const auto after = ledger->Snapshot();
    auto expected = before.submit.outcomes;
    ++expected[i];
    check(Conserved(after) && after.submit.in_progress == 0 && after.submit.outcomes == expected &&
          after.submit.duration.count == before.submit.duration.count + 1,
          "A Submit diagnostic did not settle exactly the selected outcome once");
  }
  for (std::size_t i = 0; i < static_cast<std::size_t>(DecoderOutputOutcome::Count); ++i) {
    const auto before = ledger->Snapshot();
    {
      DecoderOutputDiagnostic output(*ledger, &DecoderDiagnosticSnapshot::output, DecoderOutputOutcome::Exception);
      output.Fallback(DecoderOutputOutcome::CallbackException);
      output.Select(static_cast<DecoderOutputOutcome>(i));
      check(ledger->Snapshot().output.in_progress == 1, "Live output became a fabricated callback completion");
    }
    const auto after = ledger->Snapshot();
    auto expected = before.output.outcomes;
    ++expected[i];
    check(Conserved(after) && after.output.outcomes == expected && after.output.in_progress == 0,
          "Output branches were doubled or overwritten by a fallback reason");
  }
  const auto failures_before = ledger->Snapshot();
  try {
    DecoderSubmitDiagnostic call(*ledger, &DecoderDiagnosticSnapshot::submit, DecoderSubmitOutcome::Exception);
    throw std::runtime_error("decoder-control-exception");
  } catch (const std::runtime_error& error) {
    check(std::string_view(error.what()) == "decoder-control-exception", "Diagnostic scope replaced the error");
  }
  const auto failures_after = ledger->Snapshot();
  check(failures_after.submit.outcomes[static_cast<std::size_t>(DecoderSubmitOutcome::Exception)] ==
        failures_before.submit.outcomes[static_cast<std::size_t>(DecoderSubmitOutcome::Exception)] + 1,
        "Exceptional Submit scope lost its only outcome");

  for (std::size_t operation_index = 0; operation_index < static_cast<std::size_t>(DecoderOperation::Count);
       ++operation_index) {
    const auto operation = static_cast<DecoderOperation>(operation_index);
    const auto initial = ledger->Snapshot().operations[operation_index];
    unsigned invocations = 0;
    const bool refused = ledger->Measure(operation, [&] {
      ++invocations;
      const auto during = ledger->Snapshot();
      check(Conserved(during) && during.operations[operation_index].in_progress == 1 &&
            during.operations[operation_index].last_start_steady_us &&
            during.operations[operation_index].returned == initial.returned &&
            during.operations[operation_index].duration.count == initial.duration.count,
            "Operation snapshot blocked on its own callback or invented a completed call");
      return false;
    });
    check(!refused && invocations == 1, "Operation instrumentation changed a real refusal into success");
    ledger->Measure(operation, [&] { ++invocations; });
    try {
      ledger->Measure(operation, [&] {
        ++invocations;
        throw std::runtime_error("preserved-core-error");
      });
    } catch (const std::runtime_error& error) {
      check(std::string_view(error.what()) == "preserved-core-error", "Core exception was swallowed/replaced");
    }
    const auto after = ledger->Snapshot();
    const auto& measured = after.operations[operation_index];
    check(Conserved(after) && invocations == 3 && measured.calls == initial.calls + 3 &&
          measured.returned == initial.returned + 2 && measured.exceptions == initial.exceptions + 1 &&
          measured.in_progress == 0 && measured.last_completion_steady_us &&
          measured.duration.count == initial.duration.count + 3,
          "Core/callback operations changed invocation count or treated refusal/throw as processed media");
  }

  {
    using Native = screen_video::DecoderNativeOperation;
    auto isolated = std::make_shared<DecoderDiagnosticLedger>();
    const auto observer = ObserveNativeDecoderCalls(isolated);
    for (std::size_t i = 0; i < static_cast<std::size_t>(Native::Count); ++i) {
      const auto native = static_cast<Native>(i);
      const auto operation = static_cast<std::size_t>(NativeDecoderOperation(native));
      unsigned calls = 0;
      const auto result = screen_video::ObserveDecoderNativeCall(observer, native, [&] {
        ++calls;
        check(isolated->Snapshot().operations[operation].in_progress == 1,
              "Native MFT/GPU call was not observable before its actual invocation");
        return E_FAIL;
      });
      check(result == E_FAIL && calls == 1 && isolated->Snapshot().operations[operation].returned == 1,
            "Native call diagnostics replaced a failed HRESULT or repeated the foreign call");
      try {
        screen_video::ObserveDecoderNativeCall(observer, native, [] {
          throw std::runtime_error("native-call-error");
        });
      } catch (const std::runtime_error& error) {
        check(std::string_view(error.what()) == "native-call-error", "Native-call exception was replaced");
      }
      check(isolated->Snapshot().operations[operation].exceptions == 1 &&
            Conserved(isolated->Snapshot()), "Native-call exceptions invented a successful operation");
    }
    std::promise<void> entered, release;
    auto entering = entered.get_future(), releasing = release.get_future();
    HRESULT result = S_OK;
    std::jthread worker([&] {
      isolated->Measure(DecoderOperation::CorePump, [&] {
        result = screen_video::ObserveDecoderNativeCall(observer, Native::ProcessOutput, [&] {
          entered.set_value();
          releasing.wait();
          return MF_E_TRANSFORM_NEED_MORE_INPUT;
        });
      });
    });
    const bool started = entering.wait_for(std::chrono::seconds(5)) == std::future_status::ready;
    auto snapshot = std::async(std::launch::async, [&] { return isolated->Snapshot(); });
    const bool responsive = snapshot.wait_for(std::chrono::seconds(2)) == std::future_status::ready;
    release.set_value();
    worker.join();
    const auto observed = snapshot.get();
    check(started && responsive && result == MF_E_TRANSFORM_NEED_MORE_INPUT &&
          observed.operations[static_cast<std::size_t>(DecoderOperation::CorePump)].in_progress == 1 &&
          observed.operations[static_cast<std::size_t>(DecoderOperation::MftProcessOutput)].in_progress == 1 &&
          observed.operations[static_cast<std::size_t>(DecoderOperation::GpuFencePoll)].in_progress == 0,
          "A blocked native call held the diagnostic mutex or concealed its exact nested operation");
  }

  for (std::size_t stage_index = 0; stage_index < static_cast<std::size_t>(DecoderInputStage::Count); ++stage_index) {
    for (std::size_t reason_index = 0; reason_index < static_cast<std::size_t>(DecoderInputReleaseReason::Count);
         ++reason_index) {
      auto isolated = std::make_shared<DecoderDiagnosticLedger>();
      const auto stage = static_cast<DecoderInputStage>(stage_index);
      auto ticket = std::make_shared<DecoderInputDiagnosticTicket>(isolated, 7, DecoderDiagnosticClock::now());
      Reach(*ticket, stage);
      const auto pending = isolated->Snapshot();
      auto same_metadata = ticket;
      ticket->ReleaseAs(static_cast<DecoderInputReleaseReason>(reason_index));
      ticket->ReleaseAs(DecoderInputReleaseReason::WorkerError);
      ticket.reset();
      check(Conserved(isolated->Snapshot()) && isolated->Snapshot().inputs[stage_index].active == 1 &&
            isolated->Snapshot().inputs[stage_index].releases == pending.inputs[stage_index].releases,
            "Reason selection or a metadata copy settled/released a still-owned AU");
      std::weak_ptr weak_ticket = same_metadata;
      same_metadata.reset();
      const auto released = isolated->Snapshot();
      const auto expected_reason = stage == DecoderInputStage::Posting
          ? static_cast<std::size_t>(DecoderInputReleaseReason::NotQueued) : reason_index;
      check(Conserved(released) && weak_ticket.expired() && released.inputs[stage_index].active == 0 &&
            Sum(released.inputs[stage_index].releases) == 1 &&
            released.inputs[stage_index].releases[expected_reason] == 1 &&
            pending.inputs[stage_index].active == 1,
            "Held diagnostic snapshots changed input lifetime or duplicated its terminal release");
    }
  }
  {
    auto isolated = std::make_shared<DecoderDiagnosticLedger>();
    auto ticket = std::make_shared<DecoderInputDiagnosticTicket>(isolated, 3, DecoderDiagnosticClock::now());
    Reach(*ticket, DecoderInputStage::WorkerPending);
    ticket->Resumed();
    ticket->Pending();
    check(Conserved(isolated->Snapshot()) &&
          isolated->Snapshot().inputs[static_cast<std::size_t>(DecoderInputStage::WorkerPending)].entered == 2,
          "A genuinely re-pending input lost its transitions or became a second admitted AU");
    try {
      DecoderInputFailureGuard failure(*ticket, DecoderInputReleaseReason::CoreEnqueueError);
      throw std::runtime_error("enqueue-refused");
    } catch (const std::runtime_error&) {}
    ticket.reset();
    const auto value = isolated->Snapshot();
    check(Conserved(value) && value.inputs[static_cast<std::size_t>(DecoderInputStage::WorkerPending)]
          .releases[static_cast<std::size_t>(DecoderInputReleaseReason::CoreEnqueueError)] == 1 &&
          value.inputs[static_cast<std::size_t>(DecoderInputStage::CoreAccepted)].entered == 0,
          "Failed core enqueue was counted as admission or a retried input was counted twice");
  }
  ledger->RecoveryRequested(1, true);
  ledger->RecoveryRequested(1, false);
  ledger->RecoveryRequested(2, true);
  const auto epochs = ledger->Snapshot();
  check(epochs.current_loss_epoch == 2 && epochs.epoch_advances == 2 && epochs.recovery_requests == 3 &&
        epochs.submit.calls == failures_after.submit.calls && Conserved(epochs),
        "Retrying a pending recovery fabricated a new epoch or reset worker-lifetime totals");
  DecoderDiagnosticLedger replacement;
  check(replacement.Snapshot().current_loss_epoch == 0 && replacement.Snapshot().submit.calls == 0,
        "A new decoder ledger inherited a retired worker's epoch/counters");

  // Actual SharedState/WorkerSlot copy path; reserved CPU slot, never started.
  auto state = std::make_shared<SharedState>(AdapterOptions{});
  auto slot = state->ReserveWorker();
  DecoderRuntimeSnapshot cached;
  cached.session_id = state->NextSessionId();
  cached.observed_at_rtc_us = 606123;
  cached.observation_sequence = 9;
  cached.core_observed = true;
  cached.core_generation = 1;
  cached.core_start_loss_epoch = 0;
  cached.core_observed_at_rtc_us = 606100;
  cached.diagnostic_ledger = ledger;
  {
    std::lock_guard lock(slot->snapshot_mutex);
    slot->decoder = cached;
  }
  const auto first_copy = state->Snapshot();
  ledger->RecoveryRequested(3, true);
  const auto second_copy = state->Snapshot();
  check(first_copy.decoders.size() == 1 && second_copy.decoders.size() == 1 &&
        first_copy.decoders.front().session_id == cached.session_id &&
        !first_copy.decoders.front().diagnostic_ledger &&
        first_copy.decoders.front().diagnostics->current_loss_epoch == 2 &&
        second_copy.decoders.front().diagnostics->current_loss_epoch == 3 &&
        second_copy.decoders.front().observed_at_rtc_us == 606123 &&
        second_copy.decoders.front().core_observed_at_rtc_us == 606100 &&
        second_copy.decoders.front().core.submitted == 0 &&
        second_copy.encoded_access_units == 0 && second_copy.decoded_gpu_frames == 0 &&
        second_copy.i420_readbacks == 0 && !second_copy.hardware_execution_observed,
        "Snapshot copy woke media, rewrote cached observation time or conflated live/cached scope");
  slot->start_failed.store(true);
  slot->published.Signal();
  check(state->Snapshot().decoders.empty(), "A retired reserved slot became unbounded decoder history");
  std::weak_ptr weak_state = state;
  slot.reset();
  state.reset();
  check(weak_state.expired() && first_copy.decoders.front().core_generation == 1,
        "A held scalar decoder snapshot retained its worker registry or changed after retirement");
}

template <typename Check>
void RunDecoderSchedulingChecks(Check&& check) {
  {
    decoder_diagnostic_checks_detail::LimitedDecoderSurfacePool pool(6);
    auto worker = std::async(std::launch::async, [&] {
      pool.RetireCopies();
      const bool returned = pool.TransformCall();
      pool.RetireCopies();
      return returned;
    });
    const bool entered = pool.WaitForCall();
    pool.CompleteFence(6);
    const bool blocked = worker.wait_for(std::chrono::milliseconds(0)) == std::future_status::timeout;
    const auto retained = pool.Pending(), returned = pool.Returned();
    // Only the fixture wait is cancelled; the worker then retires samples using
    // the already-completed fence. Real MFT calls have no such escape hatch.
    pool.CancelFixtureWait();
    const bool succeeded = worker.get();
    check(entered && blocked && retained == 6 && returned == 0 && !succeeded,
          "Legacy pre-loop-only retirement did not expose the limited-surface wait cycle");
    check(pool.Pending() == 0 && pool.Returned() == 6,
          "The blocked-call fixture abandoned ownership or retired before actual fence completion");
  }
  for (const auto operation : {"ProcessInput", "ProcessOutput", "END_OF_STREAM",
                                "DRAIN", "FLUSH", "Shutdown", "Abort"}) {
    for (const std::size_t count : {1u, 2u, 6u, 8u}) {
      decoder_diagnostic_checks_detail::LimitedDecoderSurfacePool pool(count);
      std::vector<std::string_view> order;
      const auto attempt = [&] {
        if (!screen_video::DecoderSamplesReadyForTransform(
              [&] { order.push_back("retire"); pool.RetireCopies(); },
              [&] { return pool.Pending(); })) return false;
        order.push_back(operation);
        return pool.TransformCall();
      };
      check(!attempt() && pool.Calls() == 0 && pool.Returned() == 0 &&
            pool.Pending() == count && order == std::vector<std::string_view>{"retire"},
            "A transform/control call began before its retained samples had a completion fence");
      pool.CompleteFence(count - 1);
      check(!attempt() && pool.Calls() == 0 && pool.Pending() == 1 &&
            pool.Returned() == count - 1,
            "Partial GPU completion was guessed to be sufficient decoder-pool capacity");
      pool.CompleteFence(count);
      check(attempt() && pool.Calls() == 1 && pool.Pending() == 0 &&
            pool.Returned() == count && order.back() == operation &&
            order[order.size() - 2] == "retire",
            "A completed fence did not resume the original operation after real sample return");
      check(attempt() && pool.Calls() == 2 && pool.Returned() == count,
            "The retirement gate fabricated another sample return or capped normal transform calls");
    }
  }
  {
    unsigned calls = 0;
    bool failed = false;
    try {
      if (screen_video::DecoderSamplesReadyForTransform(
            [] { throw std::runtime_error("retirement-unproven"); },
            [] { return std::size_t{0}; })) ++calls;
    } catch (const std::runtime_error& error) {
      failed = std::string_view(error.what()) == "retirement-unproven";
    }
    check(failed && calls == 0, "A retirement failure became transform admission or successful shutdown");
  }
  using Clock = screen_video::EncoderTimingAggregate::Clock;
  const auto begin = Clock::time_point{};
  screen_video::DecoderSchedulingStats stats;
  screen_video::DecoderInputTiming input{begin, false};
  check(!stats.enqueueToFirstProcessInput.MeanMs() && !stats.enqueueToAccepted.MaximumMs(),
        "Unattempted MF input acquired a fabricated zero-latency success");
  screen_video::EncodedPacket original;
  original.timestampUs = 606123456;
  original.durationUs = 8333;
  original.keyFrame = true;
  original.data = {0, 0, 0, 1, 0x65, 0xbc};
  const auto before = original;
  input.BeforeProcessInput(stats, begin + std::chrono::milliseconds(7));
  input.BeforeProcessInput(stats, begin + std::chrono::milliseconds(16));
  check(input.attempted && stats.enqueueToFirstProcessInput.count == 1 &&
        stats.enqueueToFirstProcessInput.totalMs == 7 && stats.enqueueToAccepted.count == 0 &&
        original.data == before.data && original.timestampUs == before.timestampUs,
        "MF retry restamped/replaced the pending AU or invented successful ProcessInput");
  input.Accepted(stats, begin + std::chrono::milliseconds(19));
  check(stats.enqueueToAccepted.count == 1 && stats.enqueueToAccepted.totalMs == 19 &&
        original.durationUs == before.durationUs && original.keyFrame == before.keyFrame,
        "Actual acceptance timing excluded preparation/retries or changed original PTS/shape");
  screen_video::DecoderInputTiming zero{begin, false};
  zero.BeforeProcessInput(stats, begin);
  zero.Accepted(stats, begin);
  check(stats.enqueueToFirstProcessInput.count == 2 && stats.enqueueToAccepted.count == 2 &&
        stats.enqueueToFirstProcessInput.totalMs == 7 && stats.enqueueToAccepted.totalMs == 19,
        "Observed zero waiting was confused with an absent attempt/acceptance");
  screen_video::DecoderInputTiming invalid{begin, false};
  invalid.BeforeProcessInput(stats, begin - std::chrono::microseconds(1));
  invalid.Accepted(stats, begin - std::chrono::microseconds(1));
  check(stats.enqueueToFirstProcessInput.count == 2 && stats.enqueueToFirstProcessInput.invalidIntervals == 1 &&
        stats.enqueueToAccepted.count == 2 && stats.enqueueToAccepted.invalidIntervals == 1,
        "A backwards diagnostic clock was accepted as a success-shaped queue interval");
  unsigned calls = 0;
  check(screen_video::MeasureEncoderCall(stats.processInput, [&] { ++calls; return E_FAIL; }) == E_FAIL &&
        calls == 1 && stats.processInput.count == 1 && stats.enqueueToAccepted.count == 2,
        "The shared native call timer substituted admission for a failed ProcessInput return");
  try {
    screen_video::MeasureEncoderCall(stats.frameSink, [&]() -> bool {
      ++calls;
      throw std::runtime_error("sink-exception");
    });
  } catch (const std::runtime_error& error) {
    check(std::string_view(error.what()) == "sink-exception", "Frame-sink timing hid the callback error");
  }
  check(calls == 2 && stats.frameSink.count == 1 && stats.copyOutput.count == 0 &&
        stats.acceptedToOutputSample.count == 0 && stats.outputCapacityDeferrals == 0,
        "Callback timing fabricated GPU work or labelled an unobserved output-capacity guard");
}

}  // namespace monky::native_rtc::mf
