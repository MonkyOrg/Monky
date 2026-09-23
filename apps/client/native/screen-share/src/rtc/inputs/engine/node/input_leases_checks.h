#pragma once

#include "input_leases.h"

#include <vector>

namespace monky::native_rtc::node {

template <typename Check>
void RunInputLeaseChecks(Check&& check) {
  InputLeases<unsigned> leases;
  const InputKey first{1, 10}, same_id_other_source{2, 10}, another{1, 11};
  check(leases.Reserve(first, 101, 1) == InputAdmission::Accepted, "Input admission failed");
  check(leases.Reserve(first, 999, 1) == InputAdmission::Duplicate && leases.Size() == 1,
        "Duplicate submission replaced the original deferred");
  check(leases.Reserve(another, 102, 1) == InputAdmission::Full && !leases.Contains(another),
        "Refused admission acquired ownership");
  check(!leases.Retire(first, same_id_other_source) && leases.Contains(first),
        "Wrong-source completion removed a live input");
  check(!leases.Retire(first, another) && leases.Contains(first),
        "Wrong-frame completion removed a live input");
  auto retired = leases.Retire(first, first);
  check(retired && *retired == 101 && !leases.Contains(first),
        "Valid completion did not retire the original deferred");
  check(!leases.Retire(first, first), "Duplicate completion produced another release");
  check(leases.Reserve(first, 103, 1) == InputAdmission::Accepted, "Retired input ID could not be reused");
  leases.Refused(first, false);
  check(!leases.Contains(first), "Proven pre-admission failure retained a nonexistent native owner");

  check(leases.Reserve(first, 104, 2) == InputAdmission::Accepted &&
        leases.Reserve(same_id_other_source, 105, 2) == InputAdmission::Accepted,
        "Input IDs were incorrectly global rather than source-scoped");
  leases.Refused(first, true);
  check(leases.Contains(first) && leases.Size() == 2,
        "Native duplicate refusal released the preexisting obligation");
  check(leases.Reserve(first, 106, 2) == InputAdmission::Duplicate,
        "Ambiguous native ownership admitted a replacement");
  retired = leases.Retire(first, first);
  check(retired && *retired == 0 && leases.Contains(same_id_other_source),
        "Real retirement of an orphan marker affected another source");
  retired = leases.Retire(same_id_other_source, same_id_other_source);
  check(retired && *retired == 105 && leases.Size() == 0, "Source-scoped retirement lost its deferred");

  check(leases.Reserve(first, 107, 2) == InputAdmission::Accepted &&
        leases.Reserve(another, 108, 2) == InputAdmission::Accepted,
        "Close-policy setup failed");
  // Malformed JSON, terminal errors, cancel and close requests do not call
  // Retire/CompleteClose; a later validated release still owns the same entry.
  check(!leases.Retire(first, InputKey{0, 0}) && leases.Contains(first),
        "Invalid completion retired an admitted obligation");
  std::vector<InputKey> closed;
  try {
    leases.CompleteClose([&](const InputKey& key, unsigned deferred) {
      if (key == another) throw std::runtime_error("inert host settlement failure");
      check(key == first && deferred == 107, "Complete close lost input correlation");
      closed.push_back(key);
    });
    throw std::logic_error("Host settlement failure was swallowed");
  } catch (const std::runtime_error&) {
    check(!leases.Contains(first) && leases.Contains(another),
          "Failed close settlement discarded an unresolved deferred");
  }
  leases.CompleteClose([&](const InputKey& key, unsigned deferred) {
    check(key == another && deferred == 108, "Retrying complete close changed input identity");
    closed.push_back(key);
  });
  check(closed == std::vector<InputKey>{first, another} && leases.Size() == 0,
        "Complete close did not retire each remaining input exactly once");
}

}  // namespace monky::native_rtc::node
