#pragma once

#include "receiver_policy.h"

namespace monky::native_rtc::engine::receiver_policy {

template <typename Check>
void RunReceiverPolicyChecks(Check&& check) {
  const Metadata screen_a{"screen-a", std::nullopt, {"shared-sync-group"}};
  const Metadata screen_b{"screen-b", std::nullopt, {"shared-sync-group"}};
  Receiver a(10, 11, screen_a, false), b(10, 12, screen_b, false);
  check(a.Route().target == b.Route().target && a.Route().receiver_id != b.Route().receiver_id,
        "Two screens on one peer lost individual receiver identities");
  check(!a.Requested() && !b.Requested() && !a.Effective() && !b.Effective(),
        "New receivers must be default disabled");
  check(a.SetRequested(true) && a.Requested() && !a.Effective(),
        "Individual authorization bypassed the aggregate gate");
  check(a.SetAggregate(true) && b.SetAggregate(true) && a.Effective() && !b.Effective(),
        "Aggregate receiving authorized an unwatched second screen");
  check(b.SetRequested(true) && b.Effective(), "Second receiver could not be independently authorized");
  const auto first_a = a.Route(), first_b = b.Route();
  check(a.Accepts(first_a) && !a.Accepts(first_b) && !b.Accepts(first_a),
        "A frame crossed receiver ownership on one peer");
  auto wrong_peer = first_a;
  ++wrong_peer.target;
  check(!a.Accepts(wrong_peer), "A frame crossed peer ownership");
  check(a.SetRequested(false) && !a.Accepts(first_a) && b.Accepts(first_b),
        "Disabling one receiver altered the other or accepted its own old frame");
  check(a.SetRequested(true) && a.Route().receiver_epoch > first_a.receiver_epoch &&
        !a.Accepts(first_a) && a.Accepts(a.Route()), "Reactivation relabeled a queued old frame");
  const auto enabled_a = a.Route();
  check(!a.SetRequested(true) && a.Route() == enabled_a, "An idempotent gate churned sink epochs");
  check(a.SetAggregate(false) && !a.Effective() && a.Requested(),
        "Aggregate disable erased individual authorization or still delivered frames");
  check(a.SetAggregate(true) && a.Effective() && !a.Accepts(enabled_a),
        "Aggregate reactivation reused an obsolete sink route");
  const auto before_removal = a.Route();
  check(a.Remove() && !a.Present() && !a.Requested() && !a.Accepts(before_removal),
        "Removal retained a deliverable route");
  check(!a.Remove(), "Duplicate removal changed receiver history");
  bool removed_rejected = false;
  try { a.SetRequested(true); }
  catch (const PolicyError& error) { removed_rejected = error.failure == Failure::NotPresent; }
  check(removed_rejected, "An absent receiver accepted authorization");
  check(a.Bind(screen_a, false) && a.Present() && !a.Requested() &&
        a.Route().receiver_id == before_removal.receiver_id &&
        a.Route().receiver_epoch > before_removal.receiver_epoch,
        "Reattachment lost stable identity, reused an epoch or inherited authorization");
  check(a.SetRequested(true), "Reattached receiver could not be authorized");
  auto assigned = screen_a;
  assigned.mid = "2";
  const auto no_mid = a.Route();
  check(a.Refresh(assigned, false) && a.Description().mid == "2" &&
        !a.Requested() && !a.Accepts(no_mid), "SDP MID assignment failed to invalidate prior binding");
  check(!a.Refresh(assigned, false), "Unchanged SDP metadata churned receiver epochs");
  check(a.SetRequested(true), "Assigned MID receiver could not be authorized");
  const auto before_replace = a.Route();
  check(a.Bind(assigned, true) && !a.Requested() && !a.Accepts(before_replace),
        "Replacing a native track with the same textual ID inherited authorization");
  check(a.SetRequested(true), "Replacement receiver could not be authorized");
  const auto before_stream = a.Route();
  assigned.stream_ids = {"new-sync-group"};
  check(a.Refresh(assigned, false) && !a.Requested() && !a.Accepts(before_stream),
        "Stream binding change did not invalidate prior authorization");
  check(b.Accepts(first_b), "Receiver lifecycle affected an unrelated receiver");

  CheckHistoryCapacity(1, 2);
  bool host_budget = false, native_budget = false;
  try { CheckHistoryCapacity(2, 2); }
  catch (const PolicyError& error) { host_budget = error.failure == Failure::HistoryFull; }
  try { CheckHistoryCapacity(kMaxReceiverHistory, kMaxReceiverHistory + 1); }
  catch (const PolicyError& error) { native_budget = error.failure == Failure::HistoryFull; }
  check(host_budget && native_budget, "Receiver history bypassed host or native slot budgets");
  bool zero_id = false, oversized = false;
  try { Receiver invalid(10, 0, screen_a, false); }
  catch (const PolicyError& error) { zero_id = error.failure == Failure::InvalidIdentity; }
  try {
    auto invalid = assigned;
    invalid.stream_ids.resize(kMaxReceiverHistory + 1, "stream");
    a.Refresh(std::move(invalid), false);
  } catch (const PolicyError& error) { oversized = error.failure == Failure::InvalidMetadata; }
  check(zero_id && oversized, "Invalid receiver identity or unbounded metadata was accepted");
  check(a.Description() == assigned && !a.Requested(),
        "Rejected metadata partially mutated the retained receiver");
  check(b.Remove() && !b.Accepts(first_b) && b.Route().receiver_id == first_b.receiver_id,
        "Teardown lost identity before invalidating the active route");
  bool retained_budget = false;
  try { CheckHistoryCapacity(2, 2); }
  catch (const PolicyError& error) { retained_budget = error.failure == Failure::HistoryFull; }
  check(retained_budget, "Removed receiver history allowed unbounded replacement identities");
}

}  // namespace monky::native_rtc::engine::receiver_policy
