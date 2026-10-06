#pragma once

#include "mf_h264_decoder.h"

#include <array>
#include <exception>
#include <memory>
#include <mutex>
#include <optional>
#include <type_traits>
#include <utility>

namespace monky::native_rtc::mf {

enum class DecoderSubmitOutcome : std::uint8_t {
  WorkerStatus, Stopping, NoCallback, MissingFrames, Validation, RecoveryPending,
  IdrRequired, InitialSps, AdmissionFull, PostMediaRejected, Queued, Exception, Count
};
inline const char* DecoderSubmitOutcomeName(DecoderSubmitOutcome value) noexcept {
  constexpr std::array names{"worker-status", "stopping", "no-callback", "missing-frames",
      "validation", "recovery-pending", "idr-required", "initial-sps", "admission-full",
      "post-media-rejected", "queued", "exception"};
  static_assert(names.size() == static_cast<std::size_t>(DecoderSubmitOutcome::Count));
  const auto index = static_cast<std::size_t>(value);
  return index < names.size() ? names[index] : "unknown";
}

enum class DecoderInputStage : std::uint8_t {
  Posting, Queued, Dispatching, WorkerPending, CoreAccepted, ProcessInputAccepted, OutputMatched, Count
};
inline const char* DecoderInputStageName(DecoderInputStage value) noexcept {
  constexpr std::array names{"posting", "queued", "dispatching", "worker-pending",
      "core-accepted", "process-input-accepted", "output-matched"};
  static_assert(names.size() == static_cast<std::size_t>(DecoderInputStage::Count));
  const auto index = static_cast<std::size_t>(value);
  return index < names.size() ? names[index] : "unknown";
}

enum class DecoderInputReleaseReason : std::uint8_t {
  NotQueued, RecoveryCancelled, StaleLossEpoch, InvalidSession, CoreEnqueueError,
  Stopped, WorkerError, CallbackRevoked, CallbackCompleted, CallbackException,
  InvalidOutput, Exception, Abandoned, Count
};
inline const char* DecoderInputReleaseReasonName(DecoderInputReleaseReason value) noexcept {
  constexpr std::array names{"not-queued", "recovery-cancelled", "stale-loss-epoch",
      "invalid-session", "core-enqueue-error", "stopped", "worker-error",
      "callback-revoked", "callback-completed", "callback-exception", "invalid-output",
      "exception", "abandoned"};
  static_assert(names.size() == static_cast<std::size_t>(DecoderInputReleaseReason::Count));
  const auto index = static_cast<std::size_t>(value);
  return index < names.size() ? names[index] : "unknown";
}

enum class DecoderOutputOutcome : std::uint8_t {
  NullFrame, IdentityMismatch, Stopping, StaleLossEpoch, InvalidLayout,
  CallbackRevoked, CallbackCompleted, CallbackException, Exception, Count
};
inline const char* DecoderOutputOutcomeName(DecoderOutputOutcome value) noexcept {
  constexpr std::array names{"null-frame", "identity-mismatch", "stopping", "stale-loss-epoch",
      "invalid-layout", "callback-revoked", "callback-completed", "callback-exception", "exception"};
  static_assert(names.size() == static_cast<std::size_t>(DecoderOutputOutcome::Count));
  const auto index = static_cast<std::size_t>(value);
  return index < names.size() ? names[index] : "unknown";
}

enum class DecoderOperation : std::uint8_t {
  CoreCreate, CoreEnqueue, CorePump, CoreFlush, CoreStop, CoreAbort,
  CoreStatsCopy, CachePublish, Callback,
  MftProcessInput, MftProcessOutput, GpuOutputCopy, GpuDeviceCheck, GpuTextureCreate,
  GpuCopySubmit, GpuFenceSignal, GpuContextFlush, GpuFencePoll, GpuFenceArm,
  MfSampleReturn, MftEndStreaming, MftShutdown, MfPlatformShutdown, Count
};
inline const char* DecoderOperationName(DecoderOperation value) noexcept {
  constexpr std::array names{"core-create", "core-enqueue", "core-pump", "core-flush",
      "core-stop", "core-abort", "core-stats-copy", "cache-publish", "callback",
      "mft-process-input", "mft-process-output", "gpu-output-copy", "gpu-device-check",
      "gpu-texture-create", "gpu-copy-submit", "gpu-fence-signal", "gpu-context-flush",
      "gpu-fence-poll", "gpu-fence-arm", "mf-sample-return", "mft-end-streaming",
      "mft-shutdown", "mf-platform-shutdown"};
  static_assert(names.size() == static_cast<std::size_t>(DecoderOperation::Count));
  const auto index = static_cast<std::size_t>(value);
  return index < names.size() ? names[index] : "unknown";
}

enum class DecoderInterval : std::uint8_t {
  AdmissionToQueue, QueueToWorker, WorkerToCoreEnqueue, CoreEnqueueToAccepted,
  AcceptedToOutput, OutputToCallback, SubmitToCallbackCompleted, Count
};
inline const char* DecoderIntervalName(DecoderInterval value) noexcept {
  constexpr std::array names{"admission-to-queue", "queue-to-worker", "worker-to-core-enqueue",
      "core-enqueue-to-accepted", "accepted-to-output", "output-to-callback",
      "submit-to-callback-completed"};
  static_assert(names.size() == static_cast<std::size_t>(DecoderInterval::Count));
  const auto index = static_cast<std::size_t>(value);
  return index < names.size() ? names[index] : "unknown";
}

template <typename Outcome>
struct DecoderCallDiagnostics {
  std::uint64_t calls = 0, in_progress = 0;
  std::array<std::uint64_t, static_cast<std::size_t>(Outcome::Count)> outcomes{};
  screen_video::EncoderTimingAggregate duration;
};

struct DecoderInputStageDiagnostics {
  std::uint64_t entered = 0, active = 0, transitioned = 0;
  std::array<std::uint64_t, static_cast<std::size_t>(DecoderInputReleaseReason::Count)> releases{};
};

struct DecoderOperationDiagnostics {
  std::uint64_t calls = 0, in_progress = 0, returned = 0, exceptions = 0;
  std::optional<std::int64_t> last_start_steady_us, last_completion_steady_us;
  screen_video::EncoderTimingAggregate duration;
};

struct DecoderDiagnosticSnapshot {
  DecoderCallDiagnostics<DecoderSubmitOutcome> submit;
  DecoderCallDiagnostics<DecoderOutputOutcome> output;
  std::array<DecoderInputStageDiagnostics, static_cast<std::size_t>(DecoderInputStage::Count)> inputs{};
  std::array<DecoderOperationDiagnostics, static_cast<std::size_t>(DecoderOperation::Count)> operations{};
  std::array<screen_video::EncoderTimingAggregate, static_cast<std::size_t>(DecoderInterval::Count)> intervals{};
  std::uint64_t current_loss_epoch = 0, recovery_requests = 0, epoch_advances = 0;
  std::uint64_t recoveries_begun = 0, recoveries_finished = 0, session_switches = 0;
  std::uint64_t accepted_callbacks = 0, accepted_unknown = 0, accepted_duplicate = 0;
  std::optional<std::uint64_t> last_accepted_loss_epoch, last_output_loss_epoch;
  screen_video::EncoderTimingAggregate bookkeeping;
  std::optional<std::int64_t> observed_at_steady_us;
  std::optional<double> snapshot_copy_ms;
};

namespace detail {

using DecoderDiagnosticClock = screen_video::EncoderTimingAggregate::Clock;
inline std::int64_t DecoderSteadyUs(DecoderDiagnosticClock::time_point value) noexcept {
  return std::chrono::duration_cast<std::chrono::microseconds>(value.time_since_epoch()).count();
}

// No worker, callback, admission or media ownership. One bounded ledger per
// actual DecoderWorker; epoch changes are markers, not resets of lifetime totals.
class DecoderDiagnosticLedger {
 public:
  DecoderDiagnosticSnapshot Snapshot() const noexcept {
    const auto begin = DecoderDiagnosticClock::now();
    std::lock_guard lock(mutex_);
    auto copy = snapshot_;
    const auto finish = DecoderDiagnosticClock::now();
    copy.observed_at_steady_us = DecoderSteadyUs(finish);
    copy.snapshot_copy_ms = std::chrono::duration<double, std::milli>(finish - begin).count();
    return copy;
  }
  template <typename Function>
  void Update(Function&& function) noexcept {
    const auto begin = DecoderDiagnosticClock::now();
    std::lock_guard lock(mutex_);
    std::forward<Function>(function)(snapshot_);
    snapshot_.bookkeeping.Observe(begin, DecoderDiagnosticClock::now());
  }
  void Observe(DecoderInterval interval, DecoderDiagnosticClock::time_point begin,
               DecoderDiagnosticClock::time_point end) noexcept {
    Update([&](auto& snapshot) { snapshot.intervals[static_cast<std::size_t>(interval)].Observe(begin, end); });
  }
  void RecoveryRequested(std::uint64_t epoch, bool advanced) noexcept {
    Update([&](auto& value) {
      value.current_loss_epoch = epoch;
      ++value.recovery_requests;
      if (advanced) ++value.epoch_advances;
    });
  }

  template <typename Function>
  std::invoke_result_t<Function> Measure(DecoderOperation operation, Function&& function) {
    struct Observation {
      DecoderDiagnosticLedger& ledger;
      DecoderOperation operation;
      DecoderDiagnosticClock::time_point begin = DecoderDiagnosticClock::now();
      bool returned = false;
      Observation(DecoderDiagnosticLedger& ledger, DecoderOperation operation)
          : ledger(ledger), operation(operation) {
        ledger.Update([&](auto& value) {
          auto& call = value.operations[static_cast<std::size_t>(operation)];
          ++call.calls;
          ++call.in_progress;
          call.last_start_steady_us = DecoderSteadyUs(begin);
        });
      }
      ~Observation() {
        const auto end = DecoderDiagnosticClock::now();
        ledger.Update([&](auto& value) {
          auto& call = value.operations[static_cast<std::size_t>(operation)];
          --call.in_progress;
          if (returned) ++call.returned;
          else ++call.exceptions;
          call.last_completion_steady_us = DecoderSteadyUs(end);
          call.duration.Observe(begin, end);
        });
      }
    } observation(*this, operation);
    // The foreign/core call is outside the ledger mutex.
    if constexpr (std::is_void_v<std::invoke_result_t<Function>>) {
      std::forward<Function>(function)();
      observation.returned = true;
    } else {
      auto result = std::forward<Function>(function)();
      observation.returned = true;
      return result;
    }
  }

 private:
  mutable std::mutex mutex_;
  DecoderDiagnosticSnapshot snapshot_;
};

inline DecoderOperation NativeDecoderOperation(screen_video::DecoderNativeOperation operation) {
  constexpr std::array mapping{
      DecoderOperation::MftProcessInput, DecoderOperation::MftProcessOutput,
      DecoderOperation::GpuOutputCopy, DecoderOperation::GpuDeviceCheck,
      DecoderOperation::GpuTextureCreate, DecoderOperation::GpuCopySubmit,
      DecoderOperation::GpuFenceSignal, DecoderOperation::GpuContextFlush,
      DecoderOperation::GpuFencePoll, DecoderOperation::GpuFenceArm,
      DecoderOperation::MfSampleReturn, DecoderOperation::MftEndStreaming,
      DecoderOperation::MftShutdown, DecoderOperation::MfPlatformShutdown};
  static_assert(mapping.size() == static_cast<std::size_t>(screen_video::DecoderNativeOperation::Count));
  const auto index = static_cast<std::size_t>(operation);
  if (index >= mapping.size()) throw std::invalid_argument("Unknown decoder native-call operation");
  return mapping[index];
}

inline screen_video::DecoderNativeCallObserver ObserveNativeDecoderCalls(
    std::shared_ptr<DecoderDiagnosticLedger> ledger) {
  return [ledger = std::move(ledger)](screen_video::DecoderNativeOperation operation,
                                    const std::function<void()>& call) {
    ledger->Measure(NativeDecoderOperation(operation), call);
  };
}

template <typename Outcome>
class DecoderCallDiagnostic {
 public:
  using Counters = DecoderCallDiagnostics<Outcome> DecoderDiagnosticSnapshot::*;
  DecoderCallDiagnostic(DecoderDiagnosticLedger& ledger, Counters counters, Outcome fallback) noexcept
      : ledger_(ledger), counters_(counters), fallback_(fallback) {
    ledger_.Update([&](auto& snapshot) {
      auto& call = snapshot.*counters_;
      ++call.calls;
      ++call.in_progress;
    });
  }
  ~DecoderCallDiagnostic() {
    const auto end = DecoderDiagnosticClock::now();
    ledger_.Update([&](auto& snapshot) {
      auto& call = snapshot.*counters_;
      --call.in_progress;
      ++call.outcomes[static_cast<std::size_t>(selected_.value_or(fallback_))];
      call.duration.Observe(begin_, end);
    });
  }
  DecoderCallDiagnostic(const DecoderCallDiagnostic&) = delete;
  DecoderCallDiagnostic& operator=(const DecoderCallDiagnostic&) = delete;
  void Select(Outcome outcome) noexcept { if (!selected_) selected_ = outcome; }
  void Fallback(Outcome outcome) noexcept { fallback_ = outcome; }
  DecoderDiagnosticClock::time_point begin() const noexcept { return begin_; }

 private:
  DecoderDiagnosticLedger& ledger_;
  const Counters counters_;
  const DecoderDiagnosticClock::time_point begin_ = DecoderDiagnosticClock::now();
  Outcome fallback_;
  std::optional<Outcome> selected_;
};

using DecoderSubmitDiagnostic = DecoderCallDiagnostic<DecoderSubmitOutcome>;
using DecoderOutputDiagnostic = DecoderCallDiagnostic<DecoderOutputOutcome>;

// Only the existing DecodeInput/DecodeMetadata owns this ticket. Worker tasks
// borrow it while their original lambda still owns the metadata.
class DecoderInputDiagnosticTicket {
 public:
  DecoderInputDiagnosticTicket(std::shared_ptr<DecoderDiagnosticLedger> ledger,
      std::uint64_t loss_epoch, DecoderDiagnosticClock::time_point submit_at) noexcept
      : ledger_(std::move(ledger)), loss_epoch_(loss_epoch), submit_at_(submit_at) {
    ledger_->Update([&](auto& value) {
      auto& stage = value.inputs[static_cast<std::size_t>(stage_)];
      ++stage.entered;
      ++stage.active;
    });
  }
  ~DecoderInputDiagnosticTicket() {
    ledger_->Update([&](auto& value) {
      auto& stage = value.inputs[static_cast<std::size_t>(stage_)];
      --stage.active;
      const auto reason = stage_ == DecoderInputStage::Posting
          ? DecoderInputReleaseReason::NotQueued
          : reason_.value_or(std::uncaught_exceptions() ? DecoderInputReleaseReason::Exception
                                                       : DecoderInputReleaseReason::Abandoned);
      ++stage.releases[static_cast<std::size_t>(reason)];
    });
  }
  DecoderInputDiagnosticTicket(const DecoderInputDiagnosticTicket&) = delete;
  DecoderInputDiagnosticTicket& operator=(const DecoderInputDiagnosticTicket&) = delete;

  void Queued() noexcept {
    const auto now = DecoderDiagnosticClock::now();
    Transition(DecoderInputStage::Queued);
    queued_at_ = now;
    ledger_->Observe(DecoderInterval::AdmissionToQueue, admitted_at_, now);
  }
  void Dispatched() noexcept {
    const auto now = DecoderDiagnosticClock::now();
    Transition(DecoderInputStage::Dispatching);
    dispatched_at_ = now;
    if (queued_at_) ledger_->Observe(DecoderInterval::QueueToWorker, *queued_at_, now);
  }
  void Pending() noexcept { Transition(DecoderInputStage::WorkerPending); }
  void Resumed() noexcept { Transition(DecoderInputStage::Dispatching); }
  void CoreEnqueueStarting() noexcept {
    if (dispatched_at_) ledger_->Observe(DecoderInterval::WorkerToCoreEnqueue,
                                         *dispatched_at_, DecoderDiagnosticClock::now());
  }
  void CoreAccepted() noexcept {
    core_enqueued_at_ = DecoderDiagnosticClock::now();
    Transition(DecoderInputStage::CoreAccepted);
  }
  void ProcessInputAccepted() noexcept {
    const auto now = DecoderDiagnosticClock::now();
    accepted_at_ = now;
    Transition(DecoderInputStage::ProcessInputAccepted);
    if (core_enqueued_at_) ledger_->Observe(DecoderInterval::CoreEnqueueToAccepted, *core_enqueued_at_, now);
    ledger_->Update([&](auto& value) { value.last_accepted_loss_epoch = loss_epoch_; });
  }
  void OutputMatched(DecoderDiagnosticClock::time_point output_at) noexcept {
    Transition(DecoderInputStage::OutputMatched);
    if (accepted_at_) ledger_->Observe(DecoderInterval::AcceptedToOutput, *accepted_at_, output_at);
    ledger_->Update([&](auto& value) { value.last_output_loss_epoch = loss_epoch_; });
  }
  void CallbackCompleted() noexcept {
    ledger_->Observe(DecoderInterval::SubmitToCallbackCompleted, submit_at_, DecoderDiagnosticClock::now());
  }
  void ReleaseAs(DecoderInputReleaseReason reason) noexcept {
    ledger_->Update([&](auto&) { if (!reason_) reason_ = reason; });
  }

 private:
  void Transition(DecoderInputStage next) noexcept {
    ledger_->Update([&](auto& value) {
      if (stage_ == next) return;
      auto& from = value.inputs[static_cast<std::size_t>(stage_)];
      --from.active;
      ++from.transitioned;
      auto& to = value.inputs[static_cast<std::size_t>(next)];
      ++to.entered;
      ++to.active;
      stage_ = next;
    });
  }
  const std::shared_ptr<DecoderDiagnosticLedger> ledger_;
  const std::uint64_t loss_epoch_;
  const DecoderDiagnosticClock::time_point submit_at_;
  const DecoderDiagnosticClock::time_point admitted_at_ = DecoderDiagnosticClock::now();
  std::optional<DecoderDiagnosticClock::time_point> queued_at_, dispatched_at_, core_enqueued_at_, accepted_at_;
  DecoderInputStage stage_ = DecoderInputStage::Posting;
  std::optional<DecoderInputReleaseReason> reason_;
};

// Use only while the surrounding scope still owns the metadata. This records
// the original exceptional exit without catching it or prolonging that owner.
class DecoderInputFailureGuard {
 public:
  DecoderInputFailureGuard(DecoderInputDiagnosticTicket& ticket, DecoderInputReleaseReason reason) noexcept
      : ticket_(ticket), reason_(reason), exceptions_(std::uncaught_exceptions()) {}
  ~DecoderInputFailureGuard() {
    if (std::uncaught_exceptions() > exceptions_) ticket_.ReleaseAs(reason_);
  }
 private:
  DecoderInputDiagnosticTicket& ticket_;
  const DecoderInputReleaseReason reason_;
  const int exceptions_;
};

}  // namespace detail
}  // namespace monky::native_rtc::mf
