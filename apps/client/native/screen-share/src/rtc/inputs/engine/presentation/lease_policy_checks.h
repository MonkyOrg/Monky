#pragma once

#include "lease_policy.h"

namespace monky::native_rtc::engine::presentation::policy {

// Called by the existing contract probe with its Check(bool, const char*).
// This header has no COM, worker, exporter, media, or device dependencies.
template <typename Check>
void RunChecks(Check&& check) {
  const auto copied = [&] {
    Lease lease;
    check(!lease.CopySubmitted(), "A copy started before source completion");
    check(!lease.BeginPublication(), "An unready source was published");
    check(lease.SourceCompleted(), "Source completion was not recorded");
    check(!lease.InputMayRetire(), "A source lease retired before its planned read");
    check(lease.CopySubmitted(), "A ready source could not enter the copy phase");
    check(!lease.CopySubmitted(), "The producer submitted a duplicate copy");
    check(!lease.KeyZeroReleased(), "Key zero was released before copy completion");
    check(!lease.BeginPublication(), "A pending copy was published");
    check(!lease.InputMayRetire(), "A pending GPU read released its input owner");
    check(lease.CopyCompleted(), "Actual copy completion was not recorded");
    check(lease.InputMayRetire(), "Completed copying still retained the original input");
    check(!lease.BeginPublication(), "Publication omitted the key-zero release");
    check(lease.KeyZeroReleased(), "A completed copy could not release key zero");
    return lease;
  };
  const auto finish_reclamation = [&](Lease& lease) {
    check(!lease.CanRetire(), "A release callback alone retired a GPU lease");
    check(!lease.ReclaimCompleted(), "An unsignaled reclamation fence completed");
    check(lease.CanReacquire(), "Valid release proof did not enable reacquisition");
    check(lease.MutexReacquired(), "Successful key-zero reacquisition was not recorded");
    check(!lease.CanRetire(), "Mutex reacquisition substituted for a reclamation fence");
    check(!lease.ReclaimCompleted(), "Reacquisition invented fence completion");
    check(lease.ReclaimSignaled(), "A real reclamation signal could not be recorded");
    check(!lease.CanRetire(), "A submitted reclamation fence was treated as completed");
    check(lease.ReclaimCompleted(), "Actual reclamation completion was not recorded");
    check(lease.CanRetire(), "Fully fenced, released GPU use did not retire");
  };

  Lease pending;
  check(pending.Release(0) == ReleaseResult::InvalidReason, "Invalid release reason was accepted");
  check(pending.Release(3) == ReleaseResult::InvalidReason, "Unknown release reason was accepted");
  check(pending.Release(kUnused) == ReleaseResult::NotPublished, "An unpublished lease accepted release");
  check(pending.Stop(), "Stop failed to cancel queued work");
  check(!pending.CanRetire(), "Stop released a source with an incomplete ready fence");
  check(pending.SourceCompleted(), "Cancelled input could not observe its source fence");
  check(pending.CanRetire(), "Safely cancelled, unread input could not retire");
  check(!pending.CopySubmitted(), "Stop allowed new copy work");

  Lease copying;
  check(copying.SourceCompleted() && copying.CopySubmitted(), "Cannot prepare a pending copy");
  check(copying.Stop(), "Stop failed to cancel unpublished copy work");
  check(!copying.CanRetire(), "Stop revoked a GPU read before its copy fence");
  check(copying.CopyCompleted() && copying.CanRetire(), "A fenced unpublished copy did not retire");

  auto early_release = copied();
  check(early_release.BeginPublication(), "A completed keyed copy could not publish");
  check(early_release.Release(kExternalReferencesReleased) == ReleaseResult::Accepted,
        "Release racing the ready callback return was rejected");
  check(early_release.Release(kUnused) == ReleaseResult::Duplicate,
        "Duplicate release mutated an existing proof");
  check(!early_release.CanReacquire(), "An in-flight ready callback allowed slot reclamation");
  check(!early_release.Stop(), "Stop revoked an in-flight potential external lease");
  check(early_release.FinishPublication(true), "Publication could not finish after early release");
  check(early_release.Published(), "Accepted external publication was forgotten");
  finish_reclamation(early_release);

  auto published = copied();
  check(published.BeginPublication() && published.FinishPublication(true), "Cannot publish a lease");
  check(!published.Stop(), "Stop revoked a published external lease");
  check(!published.CanReacquire() && !published.CanRetire(),
        "Stop invented an all-references-released callback");
  check(published.Release(kUnused) == ReleaseResult::Accepted, "Genuine never-imported proof was rejected");
  finish_reclamation(published);

  auto rejected = copied();
  check(rejected.BeginPublication() && rejected.FinishPublication(false), "Cannot reject publication");
  check(!rejected.Published(), "Rejected publication invented an external consumer");
  finish_reclamation(rejected);

  auto stopped_after_key_release = copied();
  check(stopped_after_key_release.Stop(), "Stop failed before the publication commit");
  check(!stopped_after_key_release.BeginPublication(), "Stop allowed a new ready callback");
  finish_reclamation(stopped_after_key_release);

  auto unsafe = copied();
  check(unsafe.BeginPublication() && unsafe.FinishPublication(true), "Cannot prepare unsafe lease");
  unsafe.Quarantine();
  check(unsafe.Release(kExternalReferencesReleased) == ReleaseResult::Quarantined,
        "A callback erased a quarantined GPU failure");
  check(!unsafe.MutexReacquired() && !unsafe.ReclaimSignaled() && !unsafe.CanRetire(),
        "Ambiguous ownership was recycled");

  constexpr auto maximum = (std::numeric_limits<std::uint64_t>::max)();
  check(ObserveFence(0, 1) == FenceObservation::Pending, "Incomplete fence appeared complete");
  check(ObserveFence(1, 2) == FenceObservation::Pending,
        "The old producer-copy fence value satisfied a later reclamation target");
  check(ObserveFence(7, 7) == FenceObservation::Complete, "Equal fence value was not complete");
  check(ObserveFence(8, 7) == FenceObservation::Complete, "Later fence value was not complete");
  check(ObserveFence(maximum, 7) == FenceObservation::DeviceLost, "Device loss appeared complete");
  check(ObserveFence(7, 0) == FenceObservation::InvalidTarget, "Zero fence target was accepted");
  check(ObserveFence(7, maximum) == FenceObservation::InvalidTarget, "Device-loss sentinel was a target");
  check(Nv12PixelBytes(1920, 1080) == 3110400, "NV12 estimated pixel accounting changed");
  check(!Nv12PixelBytes(1919, 1080) && !Nv12PixelBytes(0, 1080), "Invalid NV12 geometry was budgeted");
  check(FitsBudget(8, 8, 16) && !FitsBudget(8, 9, 16), "Bounded pixel reservations changed");
  check(!FitsBudget(maximum, 1, maximum), "Pixel reservation overflow bypassed the budget");
}

}  // namespace monky::native_rtc::engine::presentation::policy
