#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <mutex>
#include <optional>
#include <utility>

namespace monky::native_rtc::mf {

enum class EncoderSubmitOutcome : std::uint8_t {
  WorkerStatus, Stopping, NoCallback, Validation, RateError, Paused, EmptyFrame,
  RateLimited, AdmissionFull, PostMediaRejected, Queued, Exception, Count
};

inline const char* EncoderSubmitOutcomeName(EncoderSubmitOutcome outcome) noexcept {
  switch (outcome) {
    case EncoderSubmitOutcome::WorkerStatus: return "worker-status";
    case EncoderSubmitOutcome::Stopping: return "stopping";
    case EncoderSubmitOutcome::NoCallback: return "no-callback";
    case EncoderSubmitOutcome::Validation: return "validation";
    case EncoderSubmitOutcome::RateError: return "rate-error";
    case EncoderSubmitOutcome::Paused: return "paused";
    case EncoderSubmitOutcome::EmptyFrame: return "empty-frame";
    case EncoderSubmitOutcome::RateLimited: return "rate-limited";
    case EncoderSubmitOutcome::AdmissionFull: return "admission-full";
    case EncoderSubmitOutcome::PostMediaRejected: return "post-media-rejected";
    case EncoderSubmitOutcome::Queued: return "queued";
    case EncoderSubmitOutcome::Exception: return "exception";
    case EncoderSubmitOutcome::Count: break;
  }
  return "unknown";
}

enum class EncoderInputStage : std::uint8_t {
  Posting, Queued, Dispatching, Pending, CoreAccepted, Count
};

inline const char* EncoderInputStageName(EncoderInputStage stage) noexcept {
  switch (stage) {
    case EncoderInputStage::Posting: return "posting";
    case EncoderInputStage::Queued: return "queued";
    case EncoderInputStage::Dispatching: return "dispatching";
    case EncoderInputStage::Pending: return "pending";
    case EncoderInputStage::CoreAccepted: return "core-accepted";
    case EncoderInputStage::Count: break;
  }
  return "unknown";
}

enum class EncoderInputReleaseReason : std::uint8_t {
  NotQueued, Paused, RateError, PauseEpoch, RtcDropNext, Stopped, WorkerError,
  Exception, Abandoned, CoreAccepted, Count
};

inline const char* EncoderInputReleaseReasonName(EncoderInputReleaseReason reason) noexcept {
  switch (reason) {
    case EncoderInputReleaseReason::NotQueued: return "not-queued";
    case EncoderInputReleaseReason::Paused: return "paused";
    case EncoderInputReleaseReason::RateError: return "rate-error";
    case EncoderInputReleaseReason::PauseEpoch: return "pause-epoch";
    case EncoderInputReleaseReason::RtcDropNext: return "rtc-drop-next";
    case EncoderInputReleaseReason::Stopped: return "stopped";
    case EncoderInputReleaseReason::WorkerError: return "worker-error";
    case EncoderInputReleaseReason::Exception: return "exception";
    case EncoderInputReleaseReason::Abandoned: return "abandoned";
    case EncoderInputReleaseReason::CoreAccepted: return "core-accepted";
    case EncoderInputReleaseReason::Count: break;
  }
  return "unknown";
}

struct EncoderSubmitDiagnostics {
  std::uint64_t requests = 0, in_progress = 0;
  std::array<std::uint64_t, static_cast<std::size_t>(EncoderSubmitOutcome::Count)> outcomes{};
};

struct EncoderInputStageDiagnostics {
  // entered is cumulative; active counts diagnostic tickets still in this
  // stage. releases settle only at ticket destruction, not when a reason is set.
  std::uint64_t entered = 0, active = 0;
  std::array<std::uint64_t, static_cast<std::size_t>(EncoderInputReleaseReason::Count)> releases{};
};

struct EncoderAttemptDiagnostics {
  std::uint64_t calls = 0, in_progress = 0, accepted = 0, refused = 0, exceptions = 0;
};

struct EncoderRateDiagnostics {
  std::uint64_t valid_set_rates = 0;
  std::optional<std::uint32_t> target_bitrate_bps, adjusted_bitrate_bps;
  std::optional<std::int64_t> bandwidth_allocation_bps;
  std::optional<double> framerate_fps;
  std::uint32_t policy_bitrate_bps = 0;
  double effective_limiter_fps = 0;
};

struct EncoderDiagnosticSnapshot {
  EncoderSubmitDiagnostics submit;
  std::array<EncoderInputStageDiagnostics, static_cast<std::size_t>(EncoderInputStage::Count)> inputs{};
  // Attempts, including repeated refusals of the same pending input. These are
  // not MF ProcessInput/output counters or terminal per-input drop counts.
  EncoderAttemptDiagnostics source_ready, core_try_encode;
  std::uint64_t core_capacity_deferrals = 0, keyframe_drain_deferrals = 0;
  EncoderRateDiagnostics rates;
};

namespace detail {

class EncoderSubmitDiagnostic;
class EncoderInputDiagnosticTicket;

// Scalars only: retaining a ledger/snapshot never retains a worker, callback,
// admission budget, media lease or GPU resource. These are not cleanup proofs.
class EncoderDiagnosticLedger {
 public:
  EncoderDiagnosticLedger(std::uint32_t initial_bitrate, double limiter_fps) {
    snapshot_.rates.policy_bitrate_bps = initial_bitrate;
    snapshot_.rates.effective_limiter_fps = limiter_fps;
  }
  EncoderDiagnosticLedger(const EncoderDiagnosticLedger&) = delete;
  EncoderDiagnosticLedger& operator=(const EncoderDiagnosticLedger&) = delete;

  EncoderDiagnosticSnapshot Snapshot() const noexcept {
    std::lock_guard lock(mutex_);
    return snapshot_;
  }
  void ObserveRates(std::uint32_t target_bitrate, std::uint32_t adjusted_bitrate,
                    std::optional<std::int64_t> bandwidth_allocation,
                    double original_fps, double limiter_fps) noexcept {
    std::lock_guard lock(mutex_);
    auto& rates = snapshot_.rates;
    ++rates.valid_set_rates;
    rates.target_bitrate_bps = target_bitrate;
    rates.adjusted_bitrate_bps = adjusted_bitrate;
    rates.bandwidth_allocation_bps = bandwidth_allocation;
    rates.framerate_fps = original_fps;
    rates.policy_bitrate_bps = adjusted_bitrate;
    rates.effective_limiter_fps = limiter_fps;
  }
  void CoreCapacityDeferred() noexcept {
    std::lock_guard lock(mutex_);
    ++snapshot_.core_capacity_deferrals;
  }
  void KeyframeDrainDeferred() noexcept {
    std::lock_guard lock(mutex_);
    ++snapshot_.keyframe_drain_deferrals;
  }

 private:
  friend class EncoderSubmitDiagnostic;
  friend class EncoderInputDiagnosticTicket;
  mutable std::mutex mutex_;
  EncoderDiagnosticSnapshot snapshot_;
};

// Select records the branch decision; destruction settles exactly once, also
// on exceptional exits. A live scope is deliberately still in_progress.
class EncoderSubmitDiagnostic {
 public:
  explicit EncoderSubmitDiagnostic(EncoderDiagnosticLedger& ledger) noexcept : ledger_(ledger) {
    std::lock_guard lock(ledger_.mutex_);
    ++ledger_.snapshot_.submit.requests;
    ++ledger_.snapshot_.submit.in_progress;
  }
  ~EncoderSubmitDiagnostic() {
    std::lock_guard lock(ledger_.mutex_);
    auto& submit = ledger_.snapshot_.submit;
    --submit.in_progress;
    ++submit.outcomes[static_cast<std::size_t>(outcome_.value_or(EncoderSubmitOutcome::Exception))];
  }
  EncoderSubmitDiagnostic(const EncoderSubmitDiagnostic&) = delete;
  EncoderSubmitDiagnostic& operator=(const EncoderSubmitDiagnostic&) = delete;
  void Select(EncoderSubmitOutcome outcome) noexcept {
    if (!outcome_) outcome_ = outcome;
  }

 private:
  EncoderDiagnosticLedger& ledger_;
  std::optional<EncoderSubmitOutcome> outcome_;
};

// Only EncodeInput copies own this ticket. PostMedia/Task borrow its address;
// they neither retain the input nor postpone its original destruction point.
class EncoderInputDiagnosticTicket {
 public:
  explicit EncoderInputDiagnosticTicket(std::shared_ptr<EncoderDiagnosticLedger> ledger) noexcept
      : ledger_(std::move(ledger)) {
    std::lock_guard lock(ledger_->mutex_);
    auto& stage = StageLocked(stage_);
    ++stage.entered;
    ++stage.active;
  }
  ~EncoderInputDiagnosticTicket() {
    std::lock_guard lock(ledger_->mutex_);
    auto& stage = StageLocked(stage_);
    --stage.active;
    const auto reason = stage_ == EncoderInputStage::Posting
        ? EncoderInputReleaseReason::NotQueued
        : stage_ == EncoderInputStage::CoreAccepted
            ? EncoderInputReleaseReason::CoreAccepted
            : release_reason_.value_or(EncoderInputReleaseReason::Abandoned);
    ++stage.releases[static_cast<std::size_t>(reason)];
  }
  EncoderInputDiagnosticTicket(const EncoderInputDiagnosticTicket&) = delete;
  EncoderInputDiagnosticTicket& operator=(const EncoderInputDiagnosticTicket&) = delete;

  void Queued() noexcept { Transition(EncoderInputStage::Posting, EncoderInputStage::Queued); }
  void Dispatched() noexcept { Transition(EncoderInputStage::Queued, EncoderInputStage::Dispatching); }
  void Pending() noexcept { Transition(EncoderInputStage::Dispatching, EncoderInputStage::Pending); }
  void ReleaseAs(EncoderInputReleaseReason reason) noexcept {
    std::lock_guard lock(ledger_->mutex_);
    if (!release_reason_) release_reason_ = reason;
  }

  template <typename Function>
  bool SourceReady(Function&& function) {
    return ObserveAttempt(false, std::forward<Function>(function));
  }
  template <typename Function>
  bool TryEncode(Function&& function) {
    return ObserveAttempt(true, std::forward<Function>(function));
  }

 private:
  EncoderInputStageDiagnostics& StageLocked(EncoderInputStage stage) noexcept {
    return ledger_->snapshot_.inputs[static_cast<std::size_t>(stage)];
  }
  void TransitionLocked(EncoderInputStage from, EncoderInputStage to) noexcept {
    if (stage_ != from) return;
    --StageLocked(from).active;
    ++StageLocked(to).entered;
    ++StageLocked(to).active;
    stage_ = to;
  }
  void Transition(EncoderInputStage from, EncoderInputStage to) noexcept {
    std::lock_guard lock(ledger_->mutex_);
    TransitionLocked(from, to);
  }
  template <typename Function>
  bool ObserveAttempt(bool core, Function&& function) {
    auto& attempts = core ? ledger_->snapshot_.core_try_encode : ledger_->snapshot_.source_ready;
    {
      std::lock_guard lock(ledger_->mutex_);
      ++attempts.calls;
      ++attempts.in_progress;
    }
    // Never hold the diagnostic mutex across source/core/RTC work.
    try {
      const bool accepted = std::forward<Function>(function)();
      std::lock_guard lock(ledger_->mutex_);
      --attempts.in_progress;
      if (accepted) ++attempts.accepted;
      else ++attempts.refused;
      // A true TryEncode return is adapter/core admission, NOT evidence of
      // ProcessInput, an encoded output or RTC delivery. False remains pending.
      if (core && accepted) TransitionLocked(EncoderInputStage::Pending, EncoderInputStage::CoreAccepted);
      return accepted;
    } catch (...) {
      std::lock_guard lock(ledger_->mutex_);
      --attempts.in_progress;
      ++attempts.exceptions;
      if (!release_reason_) release_reason_ = EncoderInputReleaseReason::Exception;
      throw;
    }
  }

  const std::shared_ptr<EncoderDiagnosticLedger> ledger_;
  EncoderInputStage stage_ = EncoderInputStage::Posting;
  std::optional<EncoderInputReleaseReason> release_reason_;
};

}  // namespace detail
}  // namespace monky::native_rtc::mf
