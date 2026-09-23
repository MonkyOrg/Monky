#pragma once

#include "..\frame_route.h"

#include <cstdint>
#include <limits>

namespace monky::native_rtc::engine::presentation::policy {

constexpr std::uint32_t kUnused = 1;
constexpr std::uint32_t kExternalReferencesReleased = 2;

enum class ReleaseResult { Accepted, InvalidReason, NotPublished, Duplicate, Quarantined };
enum class FenceObservation { Pending, Complete, DeviceLost, InvalidTarget };
enum class Phase {
  SourcePending, SourceReady, CopyPending, Copied, Publishing, Published,
  Reacquiring, ReclaimUnsignaled, ReclaimPending, Retirable, Quarantined
};

constexpr FenceObservation ObserveFence(std::uint64_t completed, std::uint64_t target) noexcept {
  constexpr auto maximum = (std::numeric_limits<std::uint64_t>::max)();
  if (!target || target == maximum) return FenceObservation::InvalidTarget;
  if (completed == maximum) return FenceObservation::DeviceLost;
  return completed >= target ? FenceObservation::Complete : FenceObservation::Pending;
}

// Logical pixel storage, not driver allocation size, alignment, or measured VRAM.
constexpr std::uint64_t Nv12PixelBytes(std::uint32_t width, std::uint32_t height) noexcept {
  if (!width || !height || ((width | height) & 1u)) return 0;
  const auto pixels = static_cast<std::uint64_t>(width) * height;
  constexpr auto maximum = (std::numeric_limits<std::uint64_t>::max)();
  return pixels > maximum - pixels / 2 ? 0 : pixels + pixels / 2;
}

constexpr bool FitsBudget(std::uint64_t used, std::uint64_t additional,
                          std::uint64_t maximum) noexcept {
  return used <= maximum && additional <= maximum - used;
}

// Facts are recorded only after the corresponding native operation succeeded.
// In particular, neither an external callback nor mutex ownership is a fence.
class Lease {
 public:
  bool SourceCompleted() noexcept {
    if (quarantined_ || source_complete_ || copy_submitted_) return false;
    source_complete_ = true;
    return true;
  }
  bool CopySubmitted() noexcept {
    if (quarantined_ || cancelled_ || !source_complete_ || copy_submitted_) return false;
    copy_submitted_ = true;
    return true;
  }
  bool CopyCompleted() noexcept {
    if (quarantined_ || !copy_submitted_ || copy_complete_) return false;
    copy_complete_ = true;
    return true;
  }
  bool KeyZeroReleased() noexcept {
    if (quarantined_ || !copy_complete_ || key_released_) return false;
    key_released_ = true;
    if (cancelled_) DiscardWithoutConsumer();
    return true;
  }
  bool BeginPublication() noexcept {
    if (quarantined_ || cancelled_ || !source_complete_ || !copy_complete_ ||
        !key_released_ || publication_started_) return false;
    // Release admission precedes the unlocked callback: its consumer can run
    // and relinquish the frame before the callback returns to this worker.
    publication_started_ = true;
    return true;
  }
  bool FinishPublication(bool accepted) noexcept {
    if (quarantined_ || !publication_started_ || publication_finished_) return false;
    publication_finished_ = true;
    accepted_ = accepted;
    if (!accepted) {
      cancelled_ = true;
      if (!release_reason_) release_reason_ = kUnused;
    }
    return true;
  }
  ReleaseResult Release(std::uint32_t reason) noexcept {
    if (reason != kUnused && reason != kExternalReferencesReleased)
      return ReleaseResult::InvalidReason;
    if (quarantined_) return ReleaseResult::Quarantined;
    if (!publication_started_) return ReleaseResult::NotPublished;
    if (release_reason_) return ReleaseResult::Duplicate;
    release_reason_ = reason;
    return ReleaseResult::Accepted;
  }
  bool Stop() noexcept {
    // An in-flight ready callback is already a potential external lease.
    if (quarantined_ || publication_started_ || cancelled_) return false;
    cancelled_ = true;
    if (key_released_) DiscardWithoutConsumer();
    return true;
  }
  bool CanReacquire() const noexcept {
    return !quarantined_ && key_released_ && publication_finished_ &&
           release_reason_ && !reacquired_;
  }
  bool MutexReacquired() noexcept {
    if (!CanReacquire()) return false;
    reacquired_ = true;
    return true;
  }
  bool ReclaimSignaled() noexcept {
    if (quarantined_ || !reacquired_ || reclaim_signaled_) return false;
    reclaim_signaled_ = true;
    return true;
  }
  bool ReclaimCompleted() noexcept {
    if (quarantined_ || !reclaim_signaled_ || reclaim_complete_) return false;
    reclaim_complete_ = true;
    return true;
  }
  bool InputMayRetire() const noexcept {
    return !quarantined_ && source_complete_ &&
           (copy_complete_ || (cancelled_ && !copy_submitted_));
  }
  bool CanRetire() const noexcept {
    if (!InputMayRetire()) return false;
    if (!key_released_) return cancelled_;
    return publication_finished_ && release_reason_ && reacquired_ &&
           reclaim_signaled_ && reclaim_complete_;
  }
  void Quarantine() noexcept { quarantined_ = true; }

  bool Cancelled() const noexcept { return cancelled_; }
  bool SourceIsComplete() const noexcept { return source_complete_; }
  bool CopyWasSubmitted() const noexcept { return copy_submitted_; }
  bool CopyIsComplete() const noexcept { return copy_complete_; }
  bool KeyWasReleased() const noexcept { return key_released_; }
  bool PublicationStarted() const noexcept { return publication_started_; }
  bool PublicationFinished() const noexcept { return publication_finished_; }
  bool Published() const noexcept { return accepted_; }
  bool HasReleaseProof() const noexcept { return release_reason_ != 0; }
  bool IsQuarantined() const noexcept { return quarantined_; }
  bool HasReacquired() const noexcept { return reacquired_; }
  bool HasReclaimSignal() const noexcept { return reclaim_signaled_; }

  Phase CurrentPhase() const noexcept {
    if (quarantined_) return Phase::Quarantined;
    if (CanRetire()) return Phase::Retirable;
    if (reclaim_signaled_) return Phase::ReclaimPending;
    if (reacquired_) return Phase::ReclaimUnsignaled;
    if (CanReacquire()) return Phase::Reacquiring;
    if (publication_started_)
      return publication_finished_ ? Phase::Published : Phase::Publishing;
    if (copy_complete_) return Phase::Copied;
    if (copy_submitted_) return Phase::CopyPending;
    return source_complete_ ? Phase::SourceReady : Phase::SourcePending;
  }

 private:
  void DiscardWithoutConsumer() noexcept {
    publication_finished_ = true;
    release_reason_ = kUnused;
  }

  bool source_complete_ = false, copy_submitted_ = false, copy_complete_ = false;
  bool key_released_ = false, publication_started_ = false, publication_finished_ = false;
  bool accepted_ = false, cancelled_ = false, reacquired_ = false;
  bool reclaim_signaled_ = false, reclaim_complete_ = false, quarantined_ = false;
  std::uint32_t release_reason_ = 0;
};

inline bool SupersedeQueued(Lease& lease, const FrameRoute& retained,
                            const FrameRoute& replacement) noexcept {
  return retained == replacement && !lease.CopyWasSubmitted() && lease.Stop();
}

inline bool RetireRoute(Lease& lease, const FrameRoute& retained,
                         const FrameRoute& retired) noexcept {
  return retained == retired && lease.Stop();
}

}  // namespace monky::native_rtc::engine::presentation::policy
