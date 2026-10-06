#pragma once

#include "engine_shared.h"

#include <map>
#include <mutex>
#include <utility>

namespace monky::native_rtc::engine {

using OperationReservations = std::map<std::uint64_t, std::shared_ptr<Cancellation>>;

inline void InvalidateControlSnapshots(std::mutex& mutex, Json& peers, Json& sfu, Json& mf) noexcept {
  std::lock_guard lock(mutex);
  peers = nullptr;
  sfu = nullptr;
  mf = nullptr;
}

// The caller holds the operation mutex, including rollback if queue allocation fails.
inline void ReserveOperation(OperationReservations& reservations, std::size_t limit,
                             const std::shared_ptr<Cancellation>& operation) {
  if (reservations.contains(operation->request_id))
    throw Error("ERR_RTC_REQUEST_ID", "Request ID is already pending", MONKY_ENGINE_INVALID);
  if (reservations.size() >= limit)
    throw Error("ERR_RTC_QUEUE_FULL", "Operation budget exhausted", MONKY_ENGINE_QUEUE_FULL);
  reservations.emplace(operation->request_id, operation);
}

template <typename Publish>
void CompleteOperation(std::mutex& mutex, OperationReservations& reservations,
                       std::shared_ptr<Cancellation>& active,
                       std::shared_ptr<Cancellation> completed, Publish&& publish) {
  {
    std::lock_guard lock(mutex);
    const auto found = reservations.find(completed->request_id);
    if (found == reservations.end() || found->second != completed || active != completed)
      throw Error("ERR_RTC_OPERATION_COMPLETION", "Completion does not own its operation reservation");
    completed->committed = true;
    reservations.erase(found);
    active.reset();
  }
  // A consumer may admit another operation, including this ID, as soon as
  // delivery starts. The local shared owner is the only old state kept alive.
  std::forward<Publish>(publish)();
}

template <typename Actions>
void ExecuteAndCompleteOperation(std::string_view name, std::mutex& mutex,
                                 OperationReservations& reservations,
                                 std::shared_ptr<Cancellation>& active,
                                 std::shared_ptr<Cancellation> cancellation, Actions&& actions) {
  const bool observes_control = name == "peer.getStats" || name == "sfu.getStats";
  Json result;
  bool succeeded = false;
  try {
    auto value = actions.Execute();
    // This work already counted against the operation deadline. Keep it before
    // the serialized decision; an error-path publication is a separate barrier.
    if (observes_control) actions.RefreshControlSnapshot();
    bool cancelled, expired;
    {
      std::lock_guard lock(mutex);
      cancelled = cancellation->cancelled.load();
      expired = actions.Now() >= cancellation->deadline;
      cancellation->committed = true;
    }
    if (cancelled || expired) {
      try { actions.RollbackCancelled(value); }
      catch (...) { actions.RememberRollbackFailure(); }
      throw Error(cancelled ? "ERR_RTC_CANCELLED" : "ERR_RTC_TIMEOUT",
                  "Completed native work was retired after cancellation or its deadline",
                  cancelled ? MONKY_ENGINE_CANCELLED : MONKY_ENGINE_TIMEOUT);
    }
    result = {{"requestId", cancellation->request_id}, {"ok", true},
              {"result", std::move(value)}};
    succeeded = true;
  } catch (...) {
    result = {{"requestId", cancellation->request_id}, {"ok", false},
              {"error", actions.CurrentErrorJson()}};
  }
  if (observes_control && !succeeded) {
    try {
      // Execute/rollback may have invalidated a selector or retired its owner.
      // Publish that actual state before retiring the reservation/delivering.
      actions.RefreshControlSnapshot();
    } catch (...) {
      // The original operation error is already fixed in result. Report this
      // secondary failure and make cached controls unavailable, never stale-ok.
      actions.ControlSnapshotPublicationFailed();
    }
  }
  CompleteOperation(mutex, reservations, active, cancellation,
                    [&] { actions.Deliver(std::move(result)); });
}

}  // namespace monky::native_rtc::engine
