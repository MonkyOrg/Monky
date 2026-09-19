#pragma once

#include "frame_route.h"

#include <algorithm>
#include <cstddef>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace monky::native_rtc::engine::receiver_policy {

constexpr std::uint64_t kMaxReceiverId = 9007199254740991ull;
constexpr std::size_t kMaxReceiverHistory = 64;

enum class Failure { InvalidIdentity, InvalidMetadata, HistoryFull, NotPresent, EpochExhausted };

class PolicyError : public std::runtime_error {
 public:
  PolicyError(Failure failure, const char* message) : std::runtime_error(message), failure(failure) {}
  const Failure failure;
};

inline void CheckHistoryCapacity(std::size_t size, std::size_t host_limit) {
  if (size >= (std::min)(host_limit, kMaxReceiverHistory))
    throw PolicyError(Failure::HistoryFull, "Peer receiver history budget exhausted; recreate the peer");
}

struct Metadata {
  std::string track_id;
  std::optional<std::string> mid;
  std::vector<std::string> stream_ids;
  std::string kind = "video";

  bool operator==(const Metadata&) const = default;
};

inline void CheckMetadata(const Metadata& metadata) {
  const auto bounded = [](const std::string& text) {
    return !text.empty() && text.size() <= 256 && text.find('\0') == std::string::npos;
  };
  if ((metadata.kind != "video" && metadata.kind != "audio") ||
      !bounded(metadata.track_id) || (metadata.mid && !bounded(*metadata.mid)) ||
      metadata.stream_ids.size() > kMaxReceiverHistory ||
      !std::all_of(metadata.stream_ids.begin(), metadata.stream_ids.end(), bounded))
    throw PolicyError(Failure::InvalidMetadata, "Receiver track, MID or stream metadata exceeds its bounds");
}

// One retained policy per native receiver, including Unified Plan removals.
// Native sink owners apply a copy, drain the old sink, then publish the new epoch.
class Receiver {
 public:
  Receiver(std::uint64_t peer_id, std::uint64_t receiver_id, Metadata metadata, bool aggregate)
      : route_{peer_id, receiver_id, 1}, metadata_(std::move(metadata)), aggregate_(aggregate) {
    if (!peer_id || peer_id > kMaxReceiverId || !receiver_id || receiver_id > kMaxReceiverId)
      throw PolicyError(Failure::InvalidIdentity, "Receiver identity is outside its safe range");
    CheckMetadata(metadata_);
  }

  const FrameRoute& Route() const noexcept { return route_; }
  const Metadata& Description() const noexcept { return metadata_; }
  bool Present() const noexcept { return present_; }
  bool Requested() const noexcept { return requested_; }
  bool Effective() const noexcept { return present_ && requested_ && aggregate_; }
  bool Accepts(const FrameRoute& route) const noexcept { return Effective() && route == route_; }

  bool SetRequested(bool enabled) {
    if (enabled && !present_)
      throw PolicyError(Failure::NotPresent, "Removed receiver requires a new track before authorization");
    if (requested_ == enabled) return false;
    Advance();
    requested_ = enabled;
    return true;
  }
  bool SetAggregate(bool enabled) {
    if (aggregate_ == enabled) return false;
    Advance();
    aggregate_ = enabled;
    return true;
  }
  bool Bind(Metadata metadata, bool track_replaced) {
    CheckMetadata(metadata);
    if (present_ && !track_replaced && metadata_ == metadata) return false;
    Advance();
    metadata_ = std::move(metadata);
    present_ = true;
    // MID/stream changes are authorization-boundary changes too.
    requested_ = false;
    return true;
  }
  bool Refresh(Metadata metadata, bool track_replaced) {
    CheckMetadata(metadata);
    if (!track_replaced && metadata_ == metadata) return false;
    Advance();
    metadata_ = std::move(metadata);
    requested_ = false;
    return true;
  }
  bool Remove() {
    if (!present_) return false;
    Advance();
    present_ = false;
    requested_ = false;
    return true;
  }

 private:
  void Advance() {
    if (route_.receiver_epoch == kMaxReceiverId)
      throw PolicyError(Failure::EpochExhausted, "Receiver epoch exhausted; recreate the peer");
    ++route_.receiver_epoch;
  }

  FrameRoute route_;
  Metadata metadata_;
  bool present_ = true;
  bool requested_ = false;
  bool aggregate_ = false;
};

}  // namespace monky::native_rtc::engine::receiver_policy
