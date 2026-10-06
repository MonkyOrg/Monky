#pragma once

#include "engine_shared.h"

#include <set>

namespace monky::native_rtc::engine::sfu_detail {

// Normalize the server's public DTO to the pinned C++ SDK before any RTC I/O.
void IceCandidates(Json& candidates);
void DtlsParameters(Json& parameters);

class ReceiveMidReservations {
 public:
  class Reservation {
   public:
    Reservation(const Reservation&) = delete;
    Reservation& operator=(const Reservation&) = delete;
    Reservation(Reservation&& other) noexcept;
    Reservation& operator=(Reservation&&) = delete;
    ~Reservation();
    const std::string& Mid() const noexcept { return mid_; }
    void Commit() noexcept { history_ = nullptr; }

   private:
    friend class ReceiveMidReservations;
    Reservation(std::set<std::string>& history, std::string mid) noexcept
        : history_(&history), mid_(std::move(mid)) {}
    std::set<std::string>* history_;
    std::string mid_;
  };

  explicit ReceiveMidReservations(std::size_t limit);
  Reservation Reserve(Json& parameters);
  bool Contains(const std::string& mid) const { return history_.contains(mid); }
  std::size_t Size() const noexcept { return history_.size(); }

 private:
  const std::size_t limit_;
  // SDK's automatic probator and every MID used by SDP remain reserved even
  // after Consumer::Close; active-consumer count is not an SDP MID allocator.
  std::set<std::string> history_{"probator"};
};

}  // namespace monky::native_rtc::engine::sfu_detail
