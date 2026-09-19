#pragma once

#include "engine_shared.h"

#include <map>
#include <optional>

namespace monky::native_rtc::engine {

// Pure ownership bookkeeping. The engine mutex serializes all access.
class ResourceRegistry {
 public:
  explicit ResourceRegistry(std::size_t maximum) : maximum_(maximum) {
    if (!maximum || maximum > 64)
      throw Error("ERR_RTC_RESOURCE_LIMIT", "Resource limit must be 1..64", MONKY_ENGINE_INVALID);
  }

  void Register(std::uint64_t id, std::uint64_t parent, std::uint64_t source) {
    if (!id || id > kMaxId || Contains(id))
      throw Error("ERR_RTC_RESOURCE_ID", "Resource ID is invalid or already registered", MONKY_ENGINE_INVALID);
    if ((parent && !Contains(parent)) || (source && !Contains(source)))
      throw Error("ERR_RTC_RESOURCE_OWNER", "Resource parent or source is unavailable", MONKY_ENGINE_NOT_FOUND);
    if (entries_.size() >= maximum_)
      throw Error("ERR_RTC_RESOURCE_LIMIT", "Resource budget is full", MONKY_ENGINE_BUSY);
    entries_.emplace(id, Entry{parent, source});
  }

  bool Contains(std::uint64_t id) const { return entries_.contains(id); }
  std::size_t Size() const { return entries_.size(); }
  void Erase(std::uint64_t id) noexcept { entries_.erase(id); }
  std::optional<std::uint64_t> Parent(std::uint64_t id) const {
    const auto entry = entries_.find(id);
    return entry == entries_.end() ? std::nullopt : std::optional(entry->second.parent);
  }

  bool Within(std::uint64_t resource, std::uint64_t scope) const {
    for (std::size_t depth = 0; depth <= maximum_ && resource; ++depth) {
      if (resource == scope) return true;
      const auto parent = Parent(resource);
      resource = parent ? *parent : 0;
    }
    return false;
  }

  bool ShouldCancel(std::uint64_t scope, const Cancellation& cancellation,
                    std::uint64_t subject) const {
    return !cancellation.committed && !cancellation.closes_resource && Within(subject, scope);
  }

  void ValidateClose(std::uint64_t id, const Json& data) const {
    if (!data.is_object() || !data.empty())
      throw Error("ERR_RTC_ARGUMENT", "resource.close accepts an empty object", MONKY_ENGINE_INVALID);
    if (!Contains(id))
      throw Error("ERR_RTC_RESOURCE", "Resource not found", MONKY_ENGINE_NOT_FOUND);
    for (const auto& [resource, entry] : entries_) {
      if (entry.source == id)
        throw Error("ERR_RTC_SOURCE_IN_USE", "Close publications before their source", MONKY_ENGINE_BUSY);
    }
  }

 private:
  struct Entry { std::uint64_t parent, source; };
  const std::size_t maximum_;
  std::map<std::uint64_t, Entry> entries_;
};

}  // namespace monky::native_rtc::engine
