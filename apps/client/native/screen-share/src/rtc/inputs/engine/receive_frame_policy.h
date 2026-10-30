#pragma once

// What a viewer does with a decoded frame it cannot present. Before #717 such a frame was dropped; the AV1 upload
// made every one of them close the engine, which ends that screen and its audio.

#include "engine_shared.h"

#include <atomic>
#include <chrono>
#include <cstdint>
#include <functional>
#include <mutex>
#include <optional>
#include <utility>

namespace monky::native_rtc::engine {

struct UploadSize {
  std::uint32_t width = 0, height = 0;
};

// NV12 needs even dimensions: a sender's odd AV1 render size loses its last column or row, not the frame.
inline std::optional<UploadSize> CpuUploadSize(int width, int height) {
  const auto even_width = width & ~1, even_height = height & ~1;
  if (even_width < 4 || even_width > 3840 || even_height < 2 || even_height > 2160) return std::nullopt;
  return UploadSize{static_cast<std::uint32_t>(even_width), static_cast<std::uint32_t>(even_height)};
}

enum class ReceiveFailureAction { kDropAndReport, kDrop, kClose };

// A frame refused for its content (invalid or unsupported output) is dropped and reported once per streak of
// refusals. A streak that persists, or a failure that is not about one frame (device, allocation, timeout), closes
// the engine. Callers serialize access.
class ReceiveFailurePolicy {
 public:
  static constexpr std::chrono::milliseconds kPersistence{2000};

  ReceiveFailureAction Reject(MonkyEngineStatus status, std::chrono::steady_clock::time_point now) {
    if (status != MONKY_ENGINE_INVALID && status != MONKY_ENGINE_UNSUPPORTED) return ReceiveFailureAction::kClose;
    if (!since_) {
      since_ = now;
      return ReceiveFailureAction::kDropAndReport;
    }
    return now - *since_ >= kPersistence ? ReceiveFailureAction::kClose : ReceiveFailureAction::kDrop;
  }
  void Presented() noexcept { since_.reset(); }

 private:
  std::optional<std::chrono::steady_clock::time_point> since_;
};

// How the engine admits each received frame. An engine Error refuses the frame through ReceiveFailurePolicy; any
// other exception (allocation, a broken invariant) closes the engine. The effects are the engine's, injected so the
// device-free contracts drive this same path: the engine itself needs a device.
class ReceivedFrameFailures {
 public:
  struct Effects {
    // A non-terminal error event for the route: the screen keeps playing.
    std::function<void(const FrameRoute&, const Error&)> report;
    // Remembers this failure and closes the engine.
    std::function<void(const Error&)> close;
    // Remembers the exception being handled and closes the engine; only called inside a catch.
    std::function<void()> fail;
  };

  explicit ReceivedFrameFailures(Effects effects) : effects_(std::move(effects)) {}

  template <typename Admission>
  void Admit(const FrameRoute& route, std::chrono::steady_clock::time_point now, Admission&& admission) noexcept {
    try {
      std::forward<Admission>(admission)();
    } catch (const Error& error) {
      Refuse(route, error, now);
    } catch (...) {
      effects_.fail();
    }
  }

  // A presented frame ends the refusal streak.
  void Presented() noexcept {
    std::lock_guard lock(mutex_);
    policy_.Presented();
  }

  std::uint64_t Rejected() const noexcept { return rejected_.load(); }

 private:
  void Refuse(const FrameRoute& route, const Error& error, std::chrono::steady_clock::time_point now) noexcept {
    try {
      ReceiveFailureAction action;
      {
        std::lock_guard lock(mutex_);
        action = policy_.Reject(error.status, now);
      }
      if (action == ReceiveFailureAction::kClose) {
        effects_.close(error);
        return;
      }
      ++rejected_;
      if (action == ReceiveFailureAction::kDropAndReport) effects_.report(route, error);
    } catch (...) {
      effects_.fail();
    }
  }

  const Effects effects_;
  std::mutex mutex_;
  ReceiveFailurePolicy policy_;
  std::atomic<std::uint64_t> rejected_{0};
};

}  // namespace monky::native_rtc::engine
