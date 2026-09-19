#pragma once

#include "engine_shared.h"
#include "receiver_policy.h"

#include <map>
#include <utility>

namespace monky::native_rtc::engine {

class ReceiveRoutes {
 public:
  explicit ReceiveRoutes(std::size_t maximum) : maximum_(maximum) {
    if (!maximum_ || maximum_ > 64 * receiver_policy::kMaxReceiverHistory)
      throw Error("ERR_RTC_ROUTE_LIMIT", "Invalid receiver route budget", MONKY_ENGINE_INVALID);
  }
  void Activate(const FrameRoute& route) {
    if (!route.Valid(kMaxId) || !route.IsPeer())
      throw Error("ERR_RTC_ROUTE", "Activation requires a bounded peer receiver route",
                  MONKY_ENGINE_INVALID);
    const auto key = std::pair(route.target, route.receiver_id);
    const auto found = active_.find(key);
    if (found != active_.end() && found->second > route.receiver_epoch)
      throw Error("ERR_RTC_ROUTE", "A stale receiver epoch cannot replace an active route",
                  MONKY_ENGINE_INVALID);
    if (found == active_.end() && active_.size() >= maximum_)
      throw Error("ERR_RTC_ROUTE_LIMIT", "Active receiver route budget exhausted", MONKY_ENGINE_BUSY);
    active_.insert_or_assign(key, route.receiver_epoch);
  }
  bool Accepts(const FrameRoute& route) const {
    if (!route.Valid(kMaxId)) return false;
    if (!route.IsPeer()) return true;
    const auto found = active_.find(std::pair(route.target, route.receiver_id));
    return found != active_.end() && found->second == route.receiver_epoch;
  }
  void Retire(const FrameRoute& route) noexcept {
    const auto found = active_.find(std::pair(route.target, route.receiver_id));
    if (found != active_.end() && found->second == route.receiver_epoch) active_.erase(found);
  }
  void RetireTarget(std::uint64_t target) noexcept {
    for (auto item = active_.begin(); item != active_.end();) {
      if (item->first.first == target) item = active_.erase(item);
      else ++item;
    }
  }
  std::size_t Size() const noexcept { return active_.size(); }

 private:
  const std::size_t maximum_;
  std::map<std::pair<std::uint64_t, std::uint64_t>, std::uint64_t> active_;
};

}  // namespace monky::native_rtc::engine
