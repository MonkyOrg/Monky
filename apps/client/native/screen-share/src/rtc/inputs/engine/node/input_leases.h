#pragma once

#include <cstddef>
#include <cstdint>
#include <map>
#include <optional>
#include <stdexcept>
#include <utility>

namespace monky::native_rtc::node {

using InputKey = std::pair<std::uint64_t, std::uint64_t>;
enum class InputAdmission { Accepted, Duplicate, Full };

// Deferred is opaque to the ledger. No Node API, engine, or GPU is needed to
// exercise the same ownership transitions used by the actual consumer.
template <typename Deferred>
class InputLeases {
 public:
  InputAdmission Reserve(const InputKey& key, Deferred deferred, std::size_t maximum) {
    if (Contains(key)) return InputAdmission::Duplicate;
    if (pending_.size() >= maximum) return InputAdmission::Full;
    pending_.emplace(key, deferred);
    return InputAdmission::Accepted;
  }
  bool Contains(const InputKey& key) const { return pending_.contains(key); }
  std::size_t Size() const noexcept { return pending_.size(); }

  void Refused(const InputKey& key, bool existing_native_owner) {
    const auto found = pending_.find(key);
    if (found == pending_.end()) throw std::logic_error("Refused input has no reservation");
    if (existing_native_owner) found->second = Deferred{};
    else pending_.erase(found);
  }

  std::optional<Deferred> Retire(const InputKey& typed, const InputKey& payload) {
    if (typed != payload) return std::nullopt;
    const auto found = pending_.find(typed);
    if (found == pending_.end()) return std::nullopt;
    const auto deferred = found->second;
    pending_.erase(found);
    return std::optional<Deferred>(std::in_place, deferred);
  }

  template <typename Reject>
  void CompleteClose(Reject&& reject) {
    // Erase each completed item separately. A throwing host callback leaves
    // every not-yet-settled deferred correlated, rather than clearing blindly.
    while (!pending_.empty()) {
      const auto item = pending_.begin();
      reject(item->first, item->second);
      pending_.erase(item);
    }
  }

 private:
  std::map<InputKey, Deferred> pending_;
};

}  // namespace monky::native_rtc::node
