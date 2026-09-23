#pragma once

#include "transport_parameters.h"

#include <set>
#include <stdexcept>

namespace monky::native_rtc::engine::sfu_detail {

template <typename Check>
void RunReceiveMidChecks(Check&& check) {
  const auto rejected = [&](auto&& action, MonkyEngineStatus expected) {
    try { action(); }
    catch (const Error& error) {
      check(error.status == expected, "Receive MID rejection had an unexpected status");
      return;
    }
    throw std::runtime_error("A conflicting receive MID was admitted");
  };
  ReceiveMidReservations mids(5);
  std::set<std::string> active;
  check(mids.Contains("probator") && mids.Size() == 1, "Automatic probator MID was not reserved");
  Json explicit_two{{"mid", "2"}};
  auto two = mids.Reserve(explicit_two);
  check(two.Mid() == "2" && mids.Contains("2"), "Explicit MID was not reserved before SDK effects");
  two.Commit();
  active.insert(two.Mid());
  Json omitted = Json::object();
  auto zero = mids.Reserve(omitted);
  check(zero.Mid() == "0" && omitted.at("mid") == zero.Mid(),
        "Explicit MID 2 plus probator still fell back to SDK map size");
  zero.Commit();
  active.insert(zero.Mid());
  check(active.size() == 2 && mids.Size() == 3, "Independent receive MID history was lost");
  rejected([&] { (void)mids.Reserve(explicit_two); }, MONKY_ENGINE_INVALID);
  check(active.contains("0") && active.contains("2") && mids.Size() == 3,
        "MID conflict affected existing consumers");
  active.erase("2");
  rejected([&] { (void)mids.Reserve(explicit_two); }, MONKY_ENGINE_INVALID);
  check(mids.Contains("2") && active.contains("0"), "Consumer close freed a historical SDP MID");
  Json probator{{"mid", "probator"}};
  rejected([&] { (void)mids.Reserve(probator); }, MONKY_ENGINE_INVALID);
  {
    Json pending{{"mid", "pending"}};
    auto abandoned = mids.Reserve(pending);
    check(mids.Contains("pending"), "Pre-SDP work did not reserve its MID");
  }
  check(!mids.Contains("pending") && mids.Size() == 3,
        "Pre-SDP cancellation permanently consumed MID history");
  {
    Json invalid{{"mid", "bad\r\nmid"}};
    rejected([&] { (void)mids.Reserve(invalid); }, MONKY_ENGINE_INVALID);
  }
  check(mids.Size() == 3, "Malformed MID mutated transport history");
  Json next = Json::object();
  auto one = mids.Reserve(next);
  check(one.Mid() == "1", "Omitted MID did not choose an unused numeric value");
  auto moved = std::move(one);
  moved.Commit();
  Json last = Json::object();
  auto three = mids.Reserve(last);
  check(three.Mid() == "3", "Omitted MID reused a closed consumer or probator slot");
  three.Commit();
  Json full = Json::object();
  rejected([&] { (void)mids.Reserve(full); }, MONKY_ENGINE_BUSY);
  check(mids.Size() == 5 && !full.contains("mid"), "Exhausted MID budget changed caller parameters");
  ReceiveMidReservations another(2);
  auto independent = another.Reserve(explicit_two);
  independent.Commit();
  check(another.Contains("2") && mids.Contains("2"), "Different transports shared MID reservations");
}

}  // namespace monky::native_rtc::engine::sfu_detail
