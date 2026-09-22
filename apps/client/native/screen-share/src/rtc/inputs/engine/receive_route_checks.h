#pragma once

#include "receive_routes.h"
#include "presentation\lease_policy.h"

#include <stdexcept>

namespace monky::native_rtc::engine {

template <typename Check>
void RunReceiveRouteChecks(Check&& check) {
  namespace policy = presentation::policy;
  const FrameRoute first{1, 2, 1}, second{1, 3, 1}, reactivated{1, 2, 3};
  const FrameRoute other_peer{4, 5, 1}, consumer{6, 0, 0};
  ReceiveRoutes routes(2);
  check(first.Valid(kMaxId) && consumer.Valid(kMaxId), "Valid route metadata was rejected");
  check(!FrameRoute{1, 2, 0}.Valid(kMaxId) && !FrameRoute{1, 0, 1}.Valid(kMaxId),
        "Incomplete receiver identity was accepted");
  check(!routes.Accepts(first) && routes.Accepts(consumer), "Receiver gate was not default-disabled");
  routes.Activate(first);
  routes.Activate(second);
  check(routes.Accepts(first) && routes.Accepts(second) && routes.Size() == 2,
        "Two receivers on one peer did not retain independent routes");
  try {
    routes.Activate(other_peer);
    throw std::runtime_error("Unbounded receiver route was admitted");
  } catch (const Error& error) {
    check(error.status == MONKY_ENGINE_BUSY && routes.Size() == 2,
          "Route budget failure mutated existing receivers");
  }
  policy::Lease first_queued, second_queued;
  check(!policy::SupersedeQueued(second_queued, second, first) && !second_queued.Cancelled(),
        "Latest-frame replacement crossed receivers on one peer");
  check(policy::SupersedeQueued(first_queued, first, first),
        "Newer frame did not supersede queued work of its exact route");
  check(!first_queued.InputMayRetire(), "Superseding skipped the original source fence");
  check(first_queued.SourceCompleted() && first_queued.CanRetire(),
        "Unsubmitted cancelled frame did not retire after source completion");

  routes.Retire(first);
  check(!routes.Accepts(first) && routes.Accepts(second), "Disabling one receiver disabled another");
  routes.Activate(reactivated);
  check(!routes.Accepts(first) && routes.Accepts(reactivated),
        "An old epoch remained eligible after reactivation");
  routes.Retire(first);
  check(routes.Accepts(reactivated), "Late removal of an old epoch removed its replacement");
  policy::Lease new_epoch;
  check(!policy::RetireRoute(new_epoch, reactivated, first) && !new_epoch.Cancelled(),
        "Old epoch cancellation reached newer queued frames");
  check(!policy::SupersedeQueued(new_epoch, reactivated, first),
        "An old frame superseded a new epoch");
  try {
    routes.Activate(first);
    throw std::runtime_error("Stale route activation replaced its successor");
  } catch (const Error& error) {
    check(error.status == MONKY_ENGINE_INVALID && routes.Accepts(reactivated),
          "Rejected stale activation mutated its successor");
  }

  policy::Lease exposed;
  check(exposed.SourceCompleted() && exposed.CopySubmitted() && exposed.CopyCompleted() &&
        exposed.KeyZeroReleased() && exposed.BeginPublication() && exposed.FinishPublication(true),
        "Export publication policy setup failed");
  check(!policy::RetireRoute(exposed, first, first) && exposed.Published() &&
        !exposed.HasReleaseProof(), "Route removal fabricated external release proof");
  check(exposed.Release(policy::kExternalReferencesReleased) == policy::ReleaseResult::Accepted,
        "Actual external release was rejected after route removal");
  check(exposed.MutexReacquired() && exposed.ReclaimSignaled() && !exposed.CanRetire(),
        "External callback and mutex alone retired a GPU lease");
  check(exposed.ReclaimCompleted() && exposed.CanRetire(),
        "Actual reclamation completion did not retire the removed route's lease");
  routes.RetireTarget(1);
  check(!routes.Accepts(reactivated) && !routes.Accepts(second) && routes.Size() == 0,
        "Peer close left active receiver routes");
  routes.Activate(other_peer);
  routes.RetireTarget(1);
  check(routes.Accepts(other_peer), "Another peer's close removed this peer's route");
}

}  // namespace monky::native_rtc::engine
