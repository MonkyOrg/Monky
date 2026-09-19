#pragma once

#include "operation_completion.h"

#include <array>
#include <stdexcept>
#include <vector>

namespace monky::native_rtc::engine {
namespace completion_flow_checks {

using Check = void (*)(bool, const char*);
using Clock = std::chrono::steady_clock;
enum class Scope { Peer, Transport, Producer, Consumer };
enum class Execution { Success, Failure, Cancelled, Timeout, PreCancelled };

inline Json ErrorValue(const Error& error) {
  return {{"code", error.code}, {"message", error.what()}, {"status", error.status},
          {"hresult", static_cast<std::int32_t>(error.hr)}};
}

inline Json CurrentErrorValue() {
  try { throw; }
  catch (const Error& error) { return ErrorValue(error); }
}

// Controller/clock doubles only. Both result ordering and cache invalidation
// execute the same functions used by Engine::Run; no Engine/factory is started.
class Fixture {
 public:
  Fixture(Check check, Scope scope) : check(check), scope(scope) {
    peers = {{"peers", Json::array({Row("peerId", 100), Row("peerId", 101)})},
             {"publications", Json::array({Json{{"publicationId", 110}, {"peerId", 100}},
                                           Json{{"publicationId", 111}, {"peerId", 101}}})}};
    sfu = {{"transports", Json::array({Row("transportId", 200), Row("transportId", 300)})},
           {"producers", Json::array({Child("producerId", 201, 200), Child("producerId", 301, 300)})},
           {"consumers", Json::array({Child("consumerId", 202, 200), Child("consumerId", 302, 300)})}};
    Run();
    check(delivered.at("ok") == true && publish_calls == 1 && execute_calls == 1 &&
          observed == Snapshot() && cache_peers == peers && cache_sfu == sfu,
          "The actual completion flow did not establish a preceding successful scoped observation");
    previous = observed;
    ResetObservations();
  }

  void Run(std::string_view name = {}) {
    if (name.empty()) name = scope == Scope::Peer ? "peer.getStats" : "sfu.getStats";
    operation = std::make_shared<Cancellation>();
    operation->request_id = ++request_id;
    operation->target = Target();
    operation->deadline = now + deadline_after;
    if (execution == Execution::PreCancelled) operation->cancelled.store(true);
    {
      std::lock_guard lock(mutex);
      ReserveOperation(reservations, 1, operation);
      active = operation;
    }
    ExecuteAndCompleteOperation(name, mutex, reservations, active, operation, *this);
    check(deliver_calls == 1 && operation->committed,
          "Operation completion omitted/duplicated delivery or lost its commit point");
    if (replacement) {
      check(active == replacement && reservations.at(operation->request_id) == replacement &&
            !replacement->committed, "Late cleanup erased or committed a reused request ID");
      std::lock_guard lock(mutex);
      active.reset();
      reservations.clear();
      replacement.reset();
    } else check(!active && reservations.empty(), "Completion retained its original reservation");
  }

  Json Execute() {
    ++execute_calls;
    trace.push_back("execute");
    check(!operation->committed && active == operation && reservations.size() == 1,
          "Execute ran after completion or without its reserved owner");
    if (execution == Execution::PreCancelled)
      throw Error("ERR_RTC_CANCELLED", "Operation was cancelled before collection", MONKY_ENGINE_CANCELLED);
    Selected()["receiveStreamDiagnostics"] = nullptr;
    now += std::chrono::milliseconds(1);
    if (execution == Execution::Failure)
      throw Error("ERR_CPU_STATS_READ", "Original scoped stats failure", MONKY_ENGINE_FAILURE, E_ACCESSDENIED);
    if (execution == Execution::Cancelled || execution == Execution::Timeout) {
      // The actual controllers retire this PC/owning transport on a cancelled
      // or timed-out GetStats wait before rethrowing; no other owner is retired.
      RetireOwner();
      if (execution == Execution::Cancelled) operation->cancelled.store(true);
      else now = operation->deadline;
      throw Error(execution == Execution::Cancelled ? "ERR_RTC_CANCELLED" : "ERR_RTC_TIMEOUT",
                  "Original stats wait failed",
                  execution == Execution::Cancelled ? MONKY_ENGINE_CANCELLED : MONKY_ENGINE_TIMEOUT,
                  E_ABORT);
    }
    Selected()["receiveStreamDiagnostics"] = Observation(++report_timestamp);
    return Json::array({Json{{"id", "actual-selector-control"}, {"timestamp", report_timestamp}}});
  }

  void RefreshControlSnapshot() {
    ++publish_calls;
    trace.push_back("refresh");
    publish_committed.push_back(operation->committed);
    check(active == operation && reservations.size() == 1,
          "Snapshot publication happened after reservation retirement");
    now += publication_cost;
    if (cancel_during_first_publication && publish_calls == 1) operation->cancelled.store(true);
    auto next_peers = peers, next_sfu = sfu, next_mf = Json::object();
    if ((fail_first_publication && publish_calls == 1) ||
        (fail_final_publication && publish_calls == 2))
      throw Error(publish_calls == 1 ? "ERR_CPU_SNAPSHOT_1" : "ERR_CPU_SNAPSHOT_2",
                  "Control snapshot publication failed", MONKY_ENGINE_FAILURE, E_OUTOFMEMORY);
    std::lock_guard lock(mutex);
    cache_peers = std::move(next_peers);
    cache_sfu = std::move(next_sfu);
    cache_mf = std::move(next_mf);
  }

  Clock::time_point Now() {
    ++decision_calls;
    trace.push_back("decision");
    check(!operation->committed, "Deadline/cancellation was decided after commitment");
    return now;
  }

  void RollbackCancelled(const Json& value) {
    ++rollback_calls;
    trace.push_back("rollback");
    check(operation->committed && active == operation && reservations.size() == 1 && value.is_array(),
          "Rollback lost its committed owner or the actual Execute result");
    // Production getStats has a no-op late rollback. An explicit retirement
    // double also guards the shared completion flow against rollback side effects.
    if (retire_during_rollback) RetireOwner();
    if (throw_rollback)
      throw Error("ERR_CPU_ROLLBACK", "Secondary rollback failure", MONKY_ENGINE_FAILURE, E_FAIL);
  }

  void RememberRollbackFailure() {
    trace.push_back("rollback-error");
    const auto error = CurrentErrorValue();
    rollback_errors.push_back(error);
    if (error.at("status") != MONKY_ENGINE_CANCELLED && error.at("status") != MONKY_ENGINE_TIMEOUT) {
      if (failure.is_null()) failure = error;
      std::lock_guard lock(mutex);
      closing = true;
      for (const auto& [id, pending] : reservations) pending->cancelled.store(true);
    }
  }

  Json CurrentErrorJson() const { return CurrentErrorValue(); }

  void ControlSnapshotPublicationFailed() {
    trace.push_back("publication-error");
    InvalidateControlSnapshots(mutex, cache_peers, cache_sfu, cache_mf);
    {
      std::lock_guard lock(mutex);
      closing = true;
      for (const auto& [id, pending] : reservations) pending->cancelled.store(true);
    }
    const auto error = CurrentErrorValue();
    if (failure.is_null()) failure = error;
    publication_errors.push_back(error);
    const auto immediate = Snapshot();
    check(immediate.at("peers").is_null() && immediate.at("sfu").is_null() &&
          immediate.at("mf").is_null() && immediate.at("closing") == true &&
          !immediate.at("failure").is_null(),
          "Publication failure notification exposed stale control state or silent healthy defaults");
  }

  void Deliver(Json value) {
    ++deliver_calls;
    trace.push_back("deliver");
    {
      std::lock_guard lock(mutex);
      check(operation->committed && !active && reservations.empty(),
            "Immediate completion callback observed a live reservation or an uncommitted decision");
      // The real cancel endpoint ignores committed operations.
      if (!operation->committed) operation->cancelled.store(true);
      if (reuse_request_id && !closing) {
        replacement = std::make_shared<Cancellation>();
        replacement->request_id = operation->request_id;
        ReserveOperation(reservations, 1, replacement);
        active = replacement;
      }
    }
    observed = Snapshot();
    delivered = std::move(value);
  }

  Json Snapshot() const {
    std::lock_guard lock(mutex);
    return {{"peers", cache_peers}, {"sfu", cache_sfu}, {"mf", cache_mf},
            {"failure", failure}, {"closing", closing}};
  }

  bool SelectedIsMissing() const {
    const auto& collection = scope == Scope::Peer ? cache_peers.at("peers") : cache_sfu.at(Collection());
    return std::none_of(collection.begin(), collection.end(),
        [&](const Json& row) { return row.at(IdField()) == Target(); });
  }

  void RequireActualState() const {
    check(observed.at("peers") == peers && observed.at("sfu") == sfu &&
          cache_peers == peers && cache_sfu == sfu,
          "Immediate operation callback did not observe the final scoped controller state");
    check(peers.at("peers").back().at("peerId") == 101 &&
          sfu.at("transports").back().at("transportId") == 300 &&
          sfu.at("producers").back().at("producerId") == 301 &&
          sfu.at("consumers").back().at("consumerId") == 302,
          "A selected stats failure removed an unrelated peer/transport scope");
  }

  Json& Selected() {
    auto& collection = scope == Scope::Peer ? peers.at("peers") : sfu.at(Collection());
    const auto found = std::find_if(collection.begin(), collection.end(),
        [&](const Json& row) { return row.at(IdField()) == Target(); });
    if (found == collection.end()) throw std::runtime_error("CPU selected scope is already retired");
    return *found;
  }

  Check check;
  Scope scope;
  Execution execution = Execution::Success;
  std::chrono::milliseconds deadline_after{20}, publication_cost{1};
  bool cancel_during_first_publication = false, retire_during_rollback = false;
  bool throw_rollback = false, fail_first_publication = false, fail_final_publication = false;
  bool reuse_request_id = false, closing = false;
  unsigned execute_calls = 0, publish_calls = 0, decision_calls = 0, rollback_calls = 0, deliver_calls = 0;
  std::vector<bool> publish_committed;
  std::vector<std::string> trace;
  std::vector<Json> publication_errors, rollback_errors;
  Json peers, sfu, cache_peers, cache_sfu, cache_mf;
  Json delivered, observed, previous, failure = nullptr;
  std::shared_ptr<Cancellation> operation, replacement;
  OperationReservations reservations;
  std::shared_ptr<Cancellation> active;
  mutable std::mutex mutex;
  Clock::time_point now{};

 private:
  static Json Observation(std::uint64_t timestamp) {
    return {{"reportTimestampUs", timestamp}, {"streams", Json::array()}};
  }
  static Json Row(const char* field, std::uint64_t id) {
    return {{field, id}, {"receiveStreamDiagnostics", Observation(1000 + id)},
            {"sendStreamDrops", Observation(2000 + id)}};
  }
  static Json Child(const char* field, std::uint64_t id, std::uint64_t parent) {
    auto row = Row(field, id);
    row["transportId"] = parent;
    return row;
  }
  const char* Collection() const {
    switch (scope) {
      case Scope::Peer: return "peers";
      case Scope::Transport: return "transports";
      case Scope::Producer: return "producers";
      case Scope::Consumer: return "consumers";
    }
    throw std::runtime_error("Invalid CPU scope");
  }
  const char* IdField() const {
    switch (scope) {
      case Scope::Peer: return "peerId";
      case Scope::Transport: return "transportId";
      case Scope::Producer: return "producerId";
      case Scope::Consumer: return "consumerId";
    }
    throw std::runtime_error("Invalid CPU scope");
  }
  std::uint64_t Target() const {
    switch (scope) {
      case Scope::Peer: return 100;
      case Scope::Transport: return 200;
      case Scope::Producer: return 201;
      case Scope::Consumer: return 202;
    }
    throw std::runtime_error("Invalid CPU scope");
  }
  void RetireOwner() {
    const auto erase = [](Json& rows, const char* field, std::uint64_t id) {
      rows.erase(std::remove_if(rows.begin(), rows.end(),
          [&](const Json& row) { return row.at(field) == id; }), rows.end());
    };
    if (scope == Scope::Peer) {
      erase(peers.at("peers"), "peerId", 100);
      erase(peers.at("publications"), "peerId", 100);
    } else {
      erase(sfu.at("transports"), "transportId", 200);
      erase(sfu.at("producers"), "transportId", 200);
      erase(sfu.at("consumers"), "transportId", 200);
    }
  }
  void ResetObservations() {
    execute_calls = publish_calls = decision_calls = rollback_calls = deliver_calls = 0;
    publish_committed.clear();
    trace.clear();
  }
  std::uint64_t report_timestamp = 606000, request_id = 0;
};

inline void Run(Check check) {
  constexpr std::array scopes{Scope::Peer, Scope::Transport, Scope::Producer, Scope::Consumer};
  for (const auto scope : scopes) {
    {
      Fixture fixture(check, scope);
      fixture.reuse_request_id = true;
      fixture.Run();
      fixture.RequireActualState();
      check(fixture.delivered.at("ok") == true && fixture.decision_calls == 1 &&
            fixture.publish_calls == 1 && fixture.rollback_calls == 0 &&
            fixture.trace == std::vector<std::string>{"execute", "refresh", "decision", "deliver"} &&
            fixture.observed != fixture.previous && !fixture.operation->cancelled.load(),
            "Success changed publication/deadline order, repeated work or lost cancellation commitment");
    }
    {
      Fixture fixture(check, scope);
      fixture.execution = Execution::Failure;
      fixture.reuse_request_id = true;
      fixture.Run();
      fixture.RequireActualState();
      const auto expected = ErrorValue(Error("ERR_CPU_STATS_READ", "Original scoped stats failure",
                                           MONKY_ENGINE_FAILURE, E_ACCESSDENIED));
      check(fixture.delivered.at("ok") == false && fixture.delivered.at("error") == expected &&
            !fixture.delivered.contains("result") && fixture.publish_calls == 1 &&
            fixture.decision_calls == 0 && fixture.rollback_calls == 0 &&
            fixture.Selected().at("receiveStreamDiagnostics").is_null() &&
            fixture.publish_committed == std::vector<bool>{false} &&
            fixture.trace == std::vector<std::string>{"execute", "refresh", "deliver"},
            "A failed scoped collection exposed old success data, changed its error or moved commitment");
    }
    for (const auto execution : {Execution::Cancelled, Execution::Timeout}) {
      Fixture fixture(check, scope);
      fixture.execution = execution;
      fixture.Run();
      fixture.RequireActualState();
      const auto expected = ErrorValue(Error(
          execution == Execution::Cancelled ? "ERR_RTC_CANCELLED" : "ERR_RTC_TIMEOUT",
          "Original stats wait failed",
          execution == Execution::Cancelled ? MONKY_ENGINE_CANCELLED : MONKY_ENGINE_TIMEOUT, E_ABORT));
      check(fixture.delivered.at("ok") == false && fixture.delivered.at("error") == expected &&
            fixture.SelectedIsMissing() && fixture.decision_calls == 0 &&
            fixture.rollback_calls == 0 && fixture.publish_calls == 1,
            "An Execute-side cancelled/timed-out stats wait published a retired target or replaced its cause");
    }
    for (const bool timeout : {false, true}) {
      for (const bool retirement_hook : {false, true}) {
        Fixture fixture(check, scope);
        fixture.deadline_after = std::chrono::milliseconds(5);
        fixture.publication_cost = std::chrono::milliseconds(timeout ? 6 : 1);
        fixture.cancel_during_first_publication = !timeout;
        fixture.retire_during_rollback = retirement_hook;
        fixture.Run();
        fixture.RequireActualState();
        check(fixture.delivered.at("ok") == false &&
              fixture.delivered.at("error").at("code") == (timeout ? "ERR_RTC_TIMEOUT" : "ERR_RTC_CANCELLED") &&
              fixture.decision_calls == 1 && fixture.rollback_calls == 1 && fixture.publish_calls == 2 &&
              fixture.publish_committed == std::vector<bool>{false, true} &&
              fixture.SelectedIsMissing() == retirement_hook &&
              fixture.trace == std::vector<std::string>{"execute", "refresh", "decision", "rollback", "refresh", "deliver"},
              "Late cancellation/deadline skipped final publication, moved timed work or changed the rollback hook");
      }
    }
    {
      Fixture fixture(check, scope);
      fixture.deadline_after = std::chrono::milliseconds(1);
      fixture.cancel_during_first_publication = true;
      fixture.retire_during_rollback = fixture.throw_rollback = true;
      fixture.Run();
      fixture.RequireActualState();
      check(fixture.delivered.at("error").at("code") == "ERR_RTC_CANCELLED" &&
            fixture.delivered.at("error").at("hresult") == 0 &&
            fixture.rollback_errors.size() == 1 &&
            fixture.rollback_errors.front().at("code") == "ERR_CPU_ROLLBACK" &&
            fixture.SelectedIsMissing() && fixture.publish_calls == 2 && fixture.closing,
            "Rollback failure replaced cancellation precedence or escaped post-rollback publication");
    }
    {
      Fixture fixture(check, scope);
      fixture.execution = Execution::PreCancelled;
      fixture.Run();
      fixture.RequireActualState();
      check(fixture.delivered.at("error").at("code") == "ERR_RTC_CANCELLED" &&
            fixture.observed == fixture.previous && fixture.publish_calls == 1 &&
            fixture.decision_calls == 0 && fixture.rollback_calls == 0,
            "A pre-collection cancellation invented a collection/invalidation or retired an untouched target");
    }
    {
      Fixture fixture(check, scope);
      fixture.execution = Execution::Failure;
      fixture.fail_first_publication = true;
      fixture.Run();
      check(fixture.delivered.at("ok") == false &&
            fixture.delivered.at("error").at("code") == "ERR_CPU_STATS_READ" &&
            fixture.delivered.at("error").at("hresult") == static_cast<std::int32_t>(E_ACCESSDENIED) &&
            fixture.publication_errors.size() == 1 &&
            fixture.publication_errors.front().at("code") == "ERR_CPU_SNAPSHOT_1" &&
            fixture.observed.at("peers").is_null() && fixture.observed.at("sfu").is_null() &&
            fixture.observed.at("mf").is_null() && fixture.closing,
            "Failed error-state publication hid its own failure or replaced the original operation error");
    }
    for (const bool second_failure : {false, true}) {
      Fixture fixture(check, scope);
      fixture.fail_first_publication = true;
      fixture.fail_final_publication = second_failure;
      fixture.Run();
      check(fixture.delivered.at("ok") == false &&
            fixture.delivered.at("error").at("code") == "ERR_CPU_SNAPSHOT_1" &&
            fixture.delivered.at("error").at("hresult") == static_cast<std::int32_t>(E_OUTOFMEMORY) &&
            !fixture.delivered.contains("result") && fixture.publish_calls == 2 &&
            fixture.decision_calls == 0 && fixture.rollback_calls == 0,
            "A publication failure on the success path became an ok DTO or moved the result decision");
      if (second_failure) {
        check(fixture.closing && fixture.publication_errors.size() == 1 &&
              fixture.publication_errors.front().at("code") == "ERR_CPU_SNAPSHOT_2" &&
              fixture.observed.at("peers").is_null() && fixture.observed.at("sfu").is_null(),
              "Repeated publication failure exposed cached success or failed to signal its secondary error");
      } else {
        fixture.RequireActualState();
        check(!fixture.closing && fixture.publication_errors.empty(),
              "A successful bounded error-state publication invented a terminal second failure");
      }
    }
    {
      Fixture fixture(check, scope);
      fixture.cancel_during_first_publication = fixture.retire_during_rollback = true;
      fixture.fail_final_publication = true;
      fixture.Run();
      check(fixture.delivered.at("error").at("code") == "ERR_RTC_CANCELLED" &&
            fixture.publication_errors.size() == 1 && fixture.closing &&
            fixture.observed.at("peers").is_null() && fixture.observed.at("sfu").is_null(),
            "Post-rollback publication failure restored the old target or replaced cancellation");
    }
  }
  {
    Fixture fixture(check, Scope::Peer);
    fixture.Run("peer.setReceiverVolume");
    check(fixture.delivered.at("ok") == true && fixture.publish_calls == 0 &&
          fixture.decision_calls == 1 && fixture.observed == fixture.previous,
          "The stats barrier changed ordinary operations' publication/deadline behavior");
  }
}

}  // namespace completion_flow_checks

template <typename Check>
void RunOperationCompletionChecks(Check&& check) {
  std::mutex mutex;
  OperationReservations reservations;
  std::shared_ptr<Cancellation> active;
  const auto create = [](std::uint64_t id) {
    auto result = std::make_shared<Cancellation>();
    result->request_id = id;
    return result;
  };
  const auto rejected = [&](auto&& action, MonkyEngineStatus expected) {
    try { action(); }
    catch (const Error& error) {
      check(error.status == expected, "Operation reservation rejected with the wrong status");
      return;
    }
    throw std::runtime_error("An invalid operation reservation was accepted");
  };
  auto first = create(1);
  auto next = create(2);
  ReserveOperation(reservations, 1, first);
  active = first;
  rejected([&] { ReserveOperation(reservations, 1, next); }, MONKY_ENGINE_QUEUE_FULL);
  rejected([&] { ReserveOperation(reservations, 1, create(1)); }, MONKY_ENGINE_INVALID);
  CompleteOperation(mutex, reservations, active, first, [&] {
    std::lock_guard lock(mutex);
    check(first->committed && !active && reservations.empty(),
          "Completion became observable before its reservation retired");
    ReserveOperation(reservations, 1, next);
  });
  check(reservations.size() == 1 && reservations.at(2) == next,
        "Completion cleanup erased a newly admitted operation");

  active = next;
  auto replacement = create(2);
  std::weak_ptr<Cancellation> previous = next;
  CompleteOperation(mutex, reservations, active, next, [&] {
    next.reset();
    check(!previous.expired(), "Observable completion lost its local shared owner");
    std::lock_guard lock(mutex);
    ReserveOperation(reservations, 1, replacement);
    active = replacement;
    check(!replacement->committed, "Reused request ID inherited an old commit decision");
  });
  check(previous.expired(), "A completed operation retained its owner after delivery");
  check(reservations.at(2) == replacement && active == replacement,
        "Late completion cleanup touched a reused request ID");

  rejected([&] {
    CompleteOperation(mutex, reservations, active, create(2), [] {
      throw std::runtime_error("A stale completion was delivered");
    });
  }, MONKY_ENGINE_FAILURE);
  check(reservations.at(2) == replacement && !replacement->committed,
        "Rejected stale completion mutated its replacement");
  replacement->cancelled.store(true);
  CompleteOperation(mutex, reservations, active, replacement, [&] {
    std::lock_guard lock(mutex);
    check(replacement->committed && replacement->cancelled.load(),
          "Cancelled completion lost its serialized terminal decision");
    ReserveOperation(reservations, 1, create(2));
  });
  check(reservations.contains(2), "Cancelled completion prevented safe ID reuse");
  completion_flow_checks::Run(check);
}

}  // namespace monky::native_rtc::engine
