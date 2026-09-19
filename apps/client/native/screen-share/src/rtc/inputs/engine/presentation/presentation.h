#pragma once

#include "engine_shared.h"

#include <functional>
#include <optional>

namespace monky::native_rtc::engine::presentation {

struct Options {
  std::uint32_t maximum_frames = 16;
  std::uint64_t maximum_texture_bytes = 256ull * 1024 * 1024;
  std::chrono::milliseconds observation_timeout{12000};
};

struct SharedFrame {
  std::uint64_t id = 0;
  FrameRoute route;
  MonkyEngineSharedFrame info{};
  winrt::com_ptr<ID3D11Texture2D> texture;
  winrt::com_ptr<ID3D11Fence> ready_fence;
  std::uint64_t ready_value = 0;
};

struct Completion {
  std::uint64_t id = 0;
  FrameRoute route;
  bool published = false;
  std::optional<MonkyEngineError> error;
};

struct Callbacks {
  // Called outside internal locks, after source/copy fences completed and key 0
  // was released. False means no external consumer received this frame.
  std::function<bool(std::shared_ptr<const SharedFrame>)> ready;
  // Only when all GPU use is actually retired; rejected/cancelled unpublished
  // inputs also complete here after their native input lease is safe to release.
  std::function<void(const Completion&)> retired;
  // A retained/ambiguous GPU failure reports an error, never fake completion.
  std::function<void(std::uint64_t target, std::uint64_t id,
                     const MonkyEngineError&, bool terminal)> error;
};

class Exporter {
 public:
  virtual ~Exporter() = default;
  // Called from RTC decode callbacks. Copies metadata/ownership only, never D3D
  // context work. False is bounded admission loss with no accepted lease.
  virtual bool Submit(std::uint64_t id, const FrameRoute& route, std::int64_t timestamp_us,
                      std::shared_ptr<const screen_video::GpuDecodedFrame> frame) = 0;
  // Thread-safe, nonblocking release admission; invalid/duplicate requests throw
  // Error without admission. Completion, not a successful return, retires the lease.
  virtual void Release(std::uint64_t id, std::uint32_t reason) = 0;
  virtual void RetireRoute(const FrameRoute& route) noexcept = 0;
  virtual void RetireTarget(std::uint64_t target) noexcept = 0;
  // Stops admission/cancels unpublished work, but NEVER revokes external leases.
  virtual void BeginStop() noexcept = 0;
  // Observe actual native-thread exit and join it. Timeout preserves ownership.
  virtual bool WaitClosed(std::chrono::milliseconds timeout) = 0;
  virtual Json Snapshot() const = 0;
};

// Creates an owned MTA worker, but no GPU device or texture until a real input.
// Compile/inert probes must not instantiate this exporter or an engine.
std::unique_ptr<Exporter> CreateExporter(const Options& options, Callbacks callbacks);

}  // namespace monky::native_rtc::engine::presentation
