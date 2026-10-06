#pragma once

#include "mf_rtc_internal.h"

#include <numeric>
#include <string_view>
#include <thread>
#include <type_traits>

namespace monky::native_rtc::mf {
namespace encoder_diagnostic_checks_detail {

using detail::EncoderDiagnosticLedger;
using detail::EncoderInputDiagnosticTicket;
using detail::EncoderSubmitDiagnostic;
using Stage = EncoderInputStage;
using Reason = EncoderInputReleaseReason;
using Outcome = EncoderSubmitOutcome;

inline std::uint64_t Sum(const auto& values) {
  return std::accumulate(values.begin(), values.end(), std::uint64_t{0});
}
inline const EncoderInputStageDiagnostics& At(const EncoderDiagnosticSnapshot& snapshot, Stage stage) {
  return snapshot.inputs[static_cast<std::size_t>(stage)];
}
inline std::uint64_t Released(const EncoderDiagnosticSnapshot& snapshot, Stage stage, Reason reason) {
  return At(snapshot, stage).releases[static_cast<std::size_t>(reason)];
}
inline std::uint64_t Outcomes(const EncoderDiagnosticSnapshot& snapshot, Outcome outcome) {
  return snapshot.submit.outcomes[static_cast<std::size_t>(outcome)];
}
inline bool Conserved(const EncoderDiagnosticSnapshot& snapshot) {
  if (snapshot.submit.requests != snapshot.submit.in_progress + Sum(snapshot.submit.outcomes)) return false;
  for (const auto* attempt : {&snapshot.source_ready, &snapshot.core_try_encode}) {
    if (attempt->calls != attempt->in_progress + attempt->accepted + attempt->refused + attempt->exceptions)
      return false;
  }
  for (std::size_t i = 0; i < snapshot.inputs.size(); ++i) {
    const auto& stage = snapshot.inputs[i];
    const auto next = i + 1 < snapshot.inputs.size() ? snapshot.inputs[i + 1].entered : 0;
    if (stage.entered != stage.active + Sum(stage.releases) + next) return false;
  }
  return true;
}
inline auto Pending(const std::shared_ptr<EncoderDiagnosticLedger>& ledger) {
  auto ticket = std::make_shared<EncoderInputDiagnosticTicket>(ledger);
  ticket->Queued();
  ticket->Dispatched();
  ticket->Pending();
  return ticket;
}

// Exercises the real PostMedia/CancelQueuedMedia path, but NEVER Start(): no
// worker thread/apartment, COM activation, MF, GPU, capture or RTC engine.
class QueueWorker final : public detail::Worker {
 public:
  explicit QueueWorker(std::shared_ptr<detail::SharedState> state) : Worker(std::move(state)) {}
  bool Queue(const std::shared_ptr<EncoderDiagnosticLedger>& ledger, std::shared_ptr<int> media) {
    auto ticket = std::make_shared<EncoderInputDiagnosticTicket>(ledger);
    auto* diagnostic = ticket.get();
    return PostMedia([media = std::move(media), ticket = std::move(ticket)] {
      (void)media;
      (void)ticket;
    }, diagnostic);
  }
  std::size_t Cancel(std::optional<Reason> reason = std::nullopt) { return CancelQueuedMedia(reason); }
  void Error() { Fail(detail::Diagnostic("ERR_CPU_DIAGNOSTIC_CHECK", "Controlled CPU queue failure")); }

 protected:
  void PumpCore() override {}
  void BeginStopCore() override {}
  void AbortCore() override {}
  bool CoreFinished() const override { return true; }
  bool CorePending() const override { return false; }
  HANDLE CoreEvent() const override { return nullptr; }
  void DestroyCore() noexcept override {}
  void RevokeCallbacks() override {}
  screen_video::I420Image ReadFrame(const detail::NativeLease&, ID3D11Fence*) override {
    throw std::runtime_error("Diagnostic CPU fixture cannot read pixels");
  }
};

}  // namespace encoder_diagnostic_checks_detail

template <typename Check>
void RunEncoderDiagnosticChecks(Check&& check) {
  using namespace encoder_diagnostic_checks_detail;
  static_assert(std::is_trivially_copyable_v<EncoderDiagnosticSnapshot>);
  static_assert(!std::is_copy_constructible_v<EncoderDiagnosticLedger>);
  static_assert(!std::is_copy_constructible_v<EncoderInputDiagnosticTicket>);
  static_assert(!std::is_copy_constructible_v<EncoderSubmitDiagnostic>);

  auto outcomes = std::make_shared<EncoderDiagnosticLedger>(1000000, 120);
  for (std::size_t i = 0; i < static_cast<std::size_t>(Outcome::Count); ++i) {
    const auto outcome = static_cast<Outcome>(i);
    {
      EncoderSubmitDiagnostic submission(*outcomes);
      submission.Select(outcome);
      submission.Select(outcome);
      const auto live = outcomes->Snapshot();
      check(live.submit.requests == i + 1 && live.submit.in_progress == 1 &&
            Sum(live.submit.outcomes) == i && Conserved(live),
            "Selecting a Submit outcome fabricated completion or counted the call twice");
    }
    const auto settled = outcomes->Snapshot();
    check(settled.submit.requests == i + 1 && settled.submit.in_progress == 0 &&
          Outcomes(settled, outcome) == 1 && Conserved(settled) &&
          std::string_view(EncoderSubmitOutcomeName(outcome)) != "unknown",
          "A Submit branch was missing, unnamed or not settled exactly once");
  }
  bool preserved = false;
  try {
    EncoderSubmitDiagnostic submission(*outcomes);
    throw std::runtime_error("Submit exception identity");
  } catch (const std::runtime_error& error) {
    preserved = std::string_view(error.what()) == "Submit exception identity";
  }
  check(preserved && Outcomes(outcomes->Snapshot(), Outcome::Exception) == 2 &&
        outcomes->Snapshot().submit.in_progress == 0 && Conserved(outcomes->Snapshot()),
        "An exceptional Submit exit changed the failure or failed to settle its scope");
  try {
    EncoderSubmitDiagnostic submission(*outcomes);
    submission.Select(Outcome::Validation);
    throw std::runtime_error("Validation");
  } catch (const std::runtime_error&) {}
  check(Outcomes(outcomes->Snapshot(), Outcome::Validation) == 2 &&
        Outcomes(outcomes->Snapshot(), Outcome::Exception) == 2,
        "An explicitly classified validation throw became a second exceptional outcome");
  {
    EncoderSubmitDiagnostic submission(*outcomes);
    submission.Select(Outcome::RateLimited);
    submission.Select(Outcome::Queued);
  }
  check(Outcomes(outcomes->Snapshot(), Outcome::RateLimited) == 2 &&
        Outcomes(outcomes->Snapshot(), Outcome::Queued) == 1 && Conserved(outcomes->Snapshot()),
        "A second Submit decision overwrote the first or settled the call twice");

  auto attempts = std::make_shared<EncoderDiagnosticLedger>(1000000, 120);
  auto ticket = Pending(attempts);
  ticket->Queued();
  ticket->Dispatched();
  ticket->Pending();
  check(At(attempts->Snapshot(), Stage::Pending).entered == 1 && Conserved(attempts->Snapshot()),
        "Repeated diagnostic transition markers admitted a second input");
  unsigned source_calls = 0, core_calls = 0;
  for (unsigned i = 0; i < 2; ++i) {
    check(!ticket->SourceReady([&] { ++source_calls; return false; }),
          "SourceReady refusal was converted to readiness");
  }
  check(ticket->SourceReady([&] { ++source_calls; return true; }) && source_calls == 3,
        "SourceReady observations did not invoke the actual callable exactly once");
  for (unsigned i = 0; i < 3; ++i) {
    check(!ticket->TryEncode([&] {
      ++core_calls;
      const auto live = attempts->Snapshot();
      check(live.core_try_encode.in_progress == 1 && At(live, Stage::Pending).active == 1 &&
            At(live, Stage::CoreAccepted).entered == 0 && Conserved(live),
            "A getter settled a still-running core attempt or fabricated core admission");
      return false;
    }), "TryEncode refusal was converted to acceptance");
    const auto refused = attempts->Snapshot();
    check(refused.core_try_encode.refused == i + 1 && At(refused, Stage::Pending).active == 1 &&
          Sum(At(refused, Stage::Pending).releases) == 0 && Conserved(refused),
          "A refused retry became a terminal pending-input drop");
  }
  attempts->CoreCapacityDeferred();
  attempts->KeyframeDrainDeferred();
  check(ticket->TryEncode([&] { ++core_calls; return true; }) && core_calls == 4,
        "An accepted core attempt was repeated or changed");
  auto accepted = attempts->Snapshot();
  check(accepted.core_try_encode.calls == 4 && accepted.core_try_encode.accepted == 1 &&
        accepted.core_try_encode.refused == 3 && accepted.core_try_encode.exceptions == 0 &&
        accepted.source_ready.calls == 3 && accepted.source_ready.refused == 2 &&
        accepted.source_ready.accepted == 1 && accepted.core_capacity_deferrals == 1 &&
        accepted.keyframe_drain_deferrals == 1 && At(accepted, Stage::Pending).active == 0 &&
        At(accepted, Stage::CoreAccepted).active == 1 && Conserved(accepted),
        "Readiness, capacity deferral, retries and core admission were conflated");
  ticket->ReleaseAs(Reason::Stopped);
  ticket.reset();
  accepted = attempts->Snapshot();
  check(Released(accepted, Stage::CoreAccepted, Reason::CoreAccepted) == 1 &&
        Sum(At(accepted, Stage::Pending).releases) == 0 && Conserved(accepted),
        "Releasing a core-accepted input was counted again as a pre-core drop");

  for (const bool source : {false, true}) {
    auto errors = std::make_shared<EncoderDiagnosticLedger>(1000000, 120);
    auto input = Pending(errors);
    struct Failure { unsigned identity; };
    bool same_exception = false;
    const auto fail = []() -> bool { throw Failure{73}; };
    try {
      if (source) input->SourceReady(fail);
      else input->TryEncode(fail);
    } catch (const Failure& failure) {
      same_exception = failure.identity == 73;
    }
    const auto live = errors->Snapshot();
    const auto& observed = source ? live.source_ready : live.core_try_encode;
    check(same_exception && observed.calls == 1 && observed.exceptions == 1 &&
          observed.in_progress == 0 && observed.accepted == 0 && observed.refused == 0 &&
          At(live, Stage::Pending).active == 1 && Sum(At(live, Stage::Pending).releases) == 0 &&
          Conserved(live), "A throwing attempt changed its exception or prematurely released pending input");
    input->ReleaseAs(Reason::WorkerError);
    input.reset();
    check(Released(errors->Snapshot(), Stage::Pending, Reason::Exception) == 1 &&
          Conserved(errors->Snapshot()), "Worker teardown overwrote or duplicated the original attempt failure");
  }

  const std::array pending_reasons{
      Reason::Paused, Reason::RateError, Reason::PauseEpoch, Reason::RtcDropNext,
      Reason::Stopped, Reason::WorkerError, Reason::Exception, Reason::Abandoned};
  for (const auto reason : pending_reasons) {
    auto releases = std::make_shared<EncoderDiagnosticLedger>(1000000, 120);
    auto input = Pending(releases);
    if (reason != Reason::Abandoned) input->ReleaseAs(reason);
    const auto marked = releases->Snapshot();
    check(At(marked, Stage::Pending).active == 1 && Sum(At(marked, Stage::Pending).releases) == 0,
          "Marking an input's release reason fabricated actual release");
    auto same_input = input;
    input.reset();
    check(At(releases->Snapshot(), Stage::Pending).active == 1,
          "A non-final copy release settled the diagnostic ticket early");
    same_input.reset();
    const auto released = releases->Snapshot();
    check(Released(released, Stage::Pending, reason) == 1 &&
          Sum(At(released, Stage::Pending).releases) == 1 &&
          released.core_try_encode.calls == 0 && Conserved(released) &&
          std::string_view(EncoderInputReleaseReasonName(reason)) != "unknown",
          "Pending pause/epoch/RTC/stop/error/abandonment was missing or counted more than once");
  }
  for (const auto reason : {Reason::Exception, Reason::Abandoned}) {
    auto dispatch = std::make_shared<EncoderDiagnosticLedger>(0, 30);
    auto input = std::make_shared<EncoderInputDiagnosticTicket>(dispatch);
    input->Queued();
    input->Dispatched();
    if (reason != Reason::Abandoned) input->ReleaseAs(reason);
    input.reset();
    check(Released(dispatch->Snapshot(), Stage::Dispatching, reason) == 1 &&
          At(dispatch->Snapshot(), Stage::Pending).entered == 0 && Conserved(dispatch->Snapshot()),
          "Dispatch failure/abandonment was invented as pending insertion or lost");
  }

  AdapterOptions options;
  options.maximum_pending_frames = 2;
  for (const auto reason : {Reason::Paused, Reason::RateError, Reason::Stopped, Reason::WorkerError}) {
    auto queue_ledger = std::make_shared<EncoderDiagnosticLedger>(1000000, 120);
    auto state = std::make_shared<detail::SharedState>(options);
    auto worker = std::make_shared<QueueWorker>(state);
    auto media = std::make_shared<int>(7);
    std::weak_ptr<int> weak_media = media;
    check(worker->Queue(queue_ledger, std::move(media)) &&
          worker->Queue(queue_ledger, std::make_shared<int>(6)),
          "CPU queue fixture could not fill its two-input bound");
    const auto queued = queue_ledger->Snapshot();
    check(At(queued, Stage::Queued).entered == 2 && At(queued, Stage::Queued).active == 2 &&
          At(queued, Stage::Posting).active == 0 && !weak_media.expired() && Conserved(queued),
          "PostMedia returned before recording queue acceptance or changed media ownership");
    auto rejected_media = std::make_shared<int>(8);
    std::weak_ptr<int> weak_rejected = rejected_media;
    check(!worker->Queue(queue_ledger, std::move(rejected_media)) && weak_rejected.expired(),
          "Queue-full rejection changed acceptance or retained the rejected media");
    auto rejected = queue_ledger->Snapshot();
    check(Released(rejected, Stage::Posting, Reason::NotQueued) == 1 &&
          At(rejected, Stage::Queued).entered == 2 && Sum(At(rejected, Stage::Queued).releases) == 0 &&
          Conserved(rejected), "Declined PostMedia was counted as queued cancellation");
    if (reason == Reason::WorkerError) worker->Error();
    else if (reason == Reason::Stopped) worker->RequestStop();
    const auto removed = reason == Reason::Stopped || reason == Reason::WorkerError
        ? worker->Cancel() : worker->Cancel(reason);
    check(removed == 2 && weak_media.expired() &&
          Released(queue_ledger->Snapshot(), Stage::Queued, reason) == 2 &&
          Conserved(queue_ledger->Snapshot()),
          "Actual Worker cancellation missed queue release, mislabeled Stop/error or retained media");
    if (reason == Reason::Stopped || reason == Reason::WorkerError) {
      check(!worker->Queue(queue_ledger, std::make_shared<int>(9)) &&
            Released(queue_ledger->Snapshot(), Stage::Posting, Reason::NotQueued) == 2 &&
            Released(queue_ledger->Snapshot(), Stage::Queued, reason) == 2,
            "Posting after stop/failure fabricated another queued cancellation");
    }
  }
  auto abandoned = std::make_shared<EncoderDiagnosticLedger>(1000000, 120);
  auto abandoned_state = std::make_shared<detail::SharedState>(options);
  auto abandoned_worker = std::make_shared<QueueWorker>(abandoned_state);
  std::weak_ptr<QueueWorker> weak_worker = abandoned_worker;
  auto abandoned_media = std::make_shared<int>(10);
  std::weak_ptr<int> weak_abandoned_media = abandoned_media;
  check(abandoned_worker->Queue(abandoned, std::move(abandoned_media)), "Abandonment fixture failed to queue");
  auto held_snapshot = abandoned->Snapshot();
  abandoned_worker.reset();
  check(weak_worker.expired() && weak_abandoned_media.expired() &&
        At(held_snapshot, Stage::Queued).active == 1 &&
        Released(abandoned->Snapshot(), Stage::Queued, Reason::Abandoned) == 1 &&
        Conserved(abandoned->Snapshot()),
        "Held diagnostic ledger/value retained worker/media or lost queued-task abandonment");

  auto racing = std::make_shared<EncoderDiagnosticLedger>(1000000, 120);
  {
    EncoderSubmitDiagnostic submission(*racing);
    auto input = std::make_shared<EncoderInputDiagnosticTicket>(racing);
    input->Queued();
    std::thread worker([input = std::move(input)]() mutable {
      input->Dispatched();
      input->Pending();
      input->TryEncode([] { return false; });
      input->TryEncode([] { return true; });
      input.reset();
    });
    worker.join();
    const auto before_return = racing->Snapshot();
    check(before_return.submit.in_progress == 1 && Outcomes(before_return, Outcome::Queued) == 0 &&
          before_return.core_try_encode.refused == 1 && before_return.core_try_encode.accepted == 1 &&
          Released(before_return, Stage::CoreAccepted, Reason::CoreAccepted) == 1 && Conserved(before_return),
          "Worker-before-Submit-return ordering fabricated completion or duplicated input outcomes");
    submission.Select(Outcome::Queued);
  }
  check(Outcomes(racing->Snapshot(), Outcome::Queued) == 1 && racing->Snapshot().submit.in_progress == 0 &&
        Conserved(racing->Snapshot()), "Late Submit settlement lost the earlier worker outcome");

  auto concurrent = std::make_shared<EncoderDiagnosticLedger>(1000000, 120);
  constexpr unsigned observations = 128;
  std::thread producer([&] {
    for (unsigned i = 0; i < observations; ++i) {
      EncoderSubmitDiagnostic submission(*concurrent);
      auto input = Pending(concurrent);
      input->TryEncode([] { return false; });
      input->TryEncode([] { return true; });
      submission.Select(Outcome::Queued);
    }
  });
  bool coherent = true;
  for (unsigned i = 0; i < observations; ++i) {
    coherent = coherent && Conserved(concurrent->Snapshot());
    std::this_thread::yield();
  }
  producer.join();
  const auto concurrent_result = concurrent->Snapshot();
  check(coherent && concurrent_result.submit.requests == observations &&
        Outcomes(concurrent_result, Outcome::Queued) == observations &&
        concurrent_result.core_try_encode.refused == observations &&
        concurrent_result.core_try_encode.accepted == observations &&
        Released(concurrent_result, Stage::CoreAccepted, Reason::CoreAccepted) == observations &&
        Conserved(concurrent_result), "Concurrent value snapshots observed torn or reset ledger transitions");

  auto state = std::make_shared<detail::SharedState>(options);
  const auto slot = state->ReserveWorker();
  EncoderRuntimeSnapshot stored;
  stored.session_id = 123;
  stored.configured.fps = 120;
  stored.maximum_bitrate_bps = 6000000;
  stored.requested_keyframe_interval = 240;
  slot->encoder = stored;
  auto missing = state->Snapshot();
  check(missing.encoders.size() == 1 && !missing.encoders.front().diagnostics &&
        !missing.encoders.front().core_observed && !missing.encoders.front().rtc_requested_fps,
        "A missing ledger/core became fabricated zero-valued observation");
  auto live_ledger = std::make_shared<EncoderDiagnosticLedger>(1000000, 120);
  slot->encoder->diagnostic_ledger = live_ledger;
  const auto owners = live_ledger.use_count();
  auto initial = state->Snapshot().encoders.front();
  check(initial.diagnostics && !initial.diagnostic_ledger && live_ledger.use_count() == owners &&
        !initial.core_observed && initial.core.inputs == 0 && initial.core.outputs == 0 &&
        initial.diagnostics->rates.valid_set_rates == 0 &&
        !initial.diagnostics->rates.target_bitrate_bps && !initial.diagnostics->rates.adjusted_bitrate_bps &&
        !initial.diagnostics->rates.bandwidth_allocation_bps && !initial.diagnostics->rates.framerate_fps &&
        initial.requested_bitrate_bps == 1000000 && initial.requested_fps == 120,
        "Initial policy defaults became observed SetRates/core data or a returned snapshot retained the ledger");
  {
    EncoderSubmitDiagnostic submission(*live_ledger);
    submission.Select(Outcome::NoCallback);
    const auto during = state->Snapshot().encoders.front();
    check(during.encode_requests == 1 && during.diagnostics->submit.in_progress == 1 &&
          !during.core_observed && !during.rtc_requested_fps,
          "A pre-core rejection was invisible or a live snapshot invented completion/core work");
  }
  auto before_rates = state->Snapshot().encoders.front();
  check(before_rates.encode_requests == 1 && Outcomes(*before_rates.diagnostics, Outcome::NoCallback) == 1 &&
        before_rates.diagnostics->submit.in_progress == 0,
        "SharedState snapshot did not read settled pre-core Submit results without a worker wake");
  auto handed_off = Pending(live_ledger);
  handed_off->TryEncode([] { return true; });
  handed_off.reset();
  const auto no_mf = state->Snapshot().encoders.front();
  check(no_mf.diagnostics->core_try_encode.accepted == 1 && !no_mf.core_observed &&
        no_mf.core.inputs == 0 && no_mf.core.submitted == 0 && no_mf.core.outputs == 0,
        "Core TryEncode acceptance fabricated an actual MF ProcessInput/output observation");
  live_ledger->ObserveRates(1700000, 1400000, 1900000, 240, 120);
  auto rates = state->Snapshot().encoders.front();
  check(rates.maximum_bitrate_bps == 6000000 && rates.requested_keyframe_interval == 240 &&
        rates.configured.fps == 120 && rates.requested_fps == 120 && rates.rtc_requested_fps == 240 &&
        rates.diagnostics->rates.target_bitrate_bps == 1700000 &&
        rates.diagnostics->rates.adjusted_bitrate_bps == 1400000 &&
        rates.diagnostics->rates.bandwidth_allocation_bps == 1900000 &&
        rates.requested_bitrate_bps == 1400000 && !rates.core_observed && rates.core.bitrateBps == 0,
        "Ceiling, RTC target/adjustment/bandwidth, nominal/effective FPS or MF bitrate were conflated");
  live_ledger->ObserveRates(1700000, 1400000, std::nullopt, 59.94, 59.94);
  rates = state->Snapshot().encoders.front();
  check(rates.rtc_requested_fps == 59.94 && rates.requested_fps == 59.94 &&
        rates.diagnostics->rates.effective_limiter_fps == 59.94 &&
        !rates.diagnostics->rates.bandwidth_allocation_bps && rates.diagnostics->rates.valid_set_rates == 2,
        "Fractional rate observation was rounded or absent finite bandwidth retained a stale value");
  live_ledger->ObserveRates(0, 0, 0, 0, 120);
  rates = state->Snapshot().encoders.front();
  check(rates.diagnostics->rates.target_bitrate_bps == 0 && rates.diagnostics->rates.adjusted_bitrate_bps == 0 &&
        rates.diagnostics->rates.bandwidth_allocation_bps == 0 && rates.rtc_requested_fps == 0 &&
        rates.requested_fps == 120 && rates.diagnostics->rates.valid_set_rates == 3 &&
        rates.encode_requests == 1 && Outcomes(*rates.diagnostics, Outcome::NoCallback) == 1,
        "Observed zero/pause was confused with unobserved data or reset cumulative diagnostics");
  rates.diagnostics->submit.requests = 999;
  rates.diagnostics->rates.target_bitrate_bps = 999;
  check(live_ledger->Snapshot().submit.requests == 1 && live_ledger->Snapshot().rates.target_bitrate_bps == 0 &&
        !initial.diagnostics->rates.target_bitrate_bps && before_rates.encode_requests == 1,
        "Changing/retaining an earlier value snapshot mutated or reread live diagnostics");
  const EncoderDiagnosticLedger fresh(2000000, 60);
  const auto fresh_snapshot = fresh.Snapshot();
  check(fresh_snapshot.submit.requests == 0 && At(fresh_snapshot, Stage::Posting).entered == 0 &&
        fresh_snapshot.rates.valid_set_rates == 0 && !fresh_snapshot.rates.target_bitrate_bps &&
        fresh_snapshot.rates.policy_bitrate_bps == 2000000 && fresh_snapshot.rates.effective_limiter_fps == 60 &&
        live_ledger->Snapshot().submit.requests == 1 && Conserved(fresh_snapshot),
        "New encoder ledger inherited old observations or reset an existing ledger");
  for (std::size_t i = 0; i < static_cast<std::size_t>(Stage::Count); ++i)
    check(std::string_view(EncoderInputStageName(static_cast<Stage>(i))) != "unknown",
          "A diagnostic input stage lost its stable name");
}

}  // namespace monky::native_rtc::mf
