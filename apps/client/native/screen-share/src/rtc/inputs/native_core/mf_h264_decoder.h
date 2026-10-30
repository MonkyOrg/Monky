#pragma once

#include <Windows.h>
#include <d3d11_4.h>
#include <winrt/base.h>

#include "h264_bitstream.h"
#include "surface_recycler.h"

#include <chrono>
#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <span>
#include <stdexcept>
#include <string>
#include <type_traits>
#include <utility>
#include <vector>

namespace monky::screen_video {

// A real GPU frame. A caller may use an aliasing shared_ptr to retain its own
// lease; readers release only their reference after their copy fence.
struct GpuNv12Frame {
  winrt::com_ptr<ID3D11Texture2D> texture;
  winrt::com_ptr<ID3D11Fence> readyFence;
  std::uint64_t readyValue = 0;
  UINT subresource = 0;
  std::int64_t timestampUs = 0;
  std::int64_t durationUs = 0;
};

struct EncodedPacket {
  std::vector<std::uint8_t> data;
  std::int64_t timestampUs = 0;
  std::int64_t durationUs = 0;
  bool keyFrame = false;
};

struct TimingAggregate {
  using Clock = std::chrono::steady_clock;
  std::uint64_t count = 0, invalidIntervals = 0;
  double totalMs = 0, maxMs = 0;

  void Observe(Clock::time_point begin, Clock::time_point end) noexcept {
    if (end < begin) { ++invalidIntervals; return; }
    const auto elapsed = std::chrono::duration<double, std::milli>(end - begin).count();
    ++count;
    totalMs += elapsed;
    if (elapsed > maxMs) maxMs = elapsed;
  }
  std::optional<double> MeanMs() const { return count ? std::optional(totalMs / count) : std::nullopt; }
  std::optional<double> MaximumMs() const { return count ? std::optional(maxMs) : std::nullopt; }
};

// Records only a completed invocation, including failures/throws. Reading a
// snapshot never finishes an in-progress call or samples another clock domain.
template <typename Function>
decltype(auto) MeasureCall(TimingAggregate& aggregate, Function&& function) {
  struct Measurement {
    TimingAggregate& aggregate;
    TimingAggregate::Clock::time_point begin = TimingAggregate::Clock::now();
    ~Measurement() { aggregate.Observe(begin, TimingAggregate::Clock::now()); }
  } measurement{aggregate};
  return std::forward<Function>(function)();
}

class DecoderError : public std::runtime_error {
 public:
  DecoderError(std::string code, std::string message, HRESULT hr = S_OK)
      : std::runtime_error(std::move(message)), code(std::move(code)), hresult(hr) {}
  std::string code;
  HRESULT hresult;
};

struct DecoderConfig {
  std::uint32_t width = 0, height = 0, fps = 0, bitrateBps = 0;
  std::uint32_t maxInFlight = 8, maxPendingPackets = 32;
  std::string profileLevelId;
};

enum class DecoderNativeOperation : std::uint8_t {
  ProcessInput, ProcessOutput, OutputCopy, DeviceCheck, TextureCreate, CopySubmit,
  FenceSignal, ContextFlush, FencePoll, FenceArm, SampleReturn,
  EndStreaming, TransformShutdown, PlatformShutdown, Count
};

using DecoderNativeCallObserver =
    std::function<void(DecoderNativeOperation, const std::function<void()>&)>;

template <typename Function>
std::invoke_result_t<Function> ObserveDecoderNativeCall(
    const DecoderNativeCallObserver& observer, DecoderNativeOperation operation,
    Function&& function) {
  if (!observer) return std::forward<Function>(function)();
  if constexpr (std::is_void_v<std::invoke_result_t<Function>>) {
    observer(operation, std::forward<Function>(function));
  } else {
    std::optional<std::invoke_result_t<Function>> result;
    observer(operation, [&] { result.emplace(std::forward<Function>(function)()); });
    return std::move(result).value();
  }
}

struct VideoFrameRect {
  std::uint32_t x = 0, y = 0, width = 0, height = 0;
};

struct DecodedColorSpace {
  std::string source = "configured-bt709-limited";
  bool fullRange = false;
};

struct GpuDecodedFrame : GpuNv12Frame {
  std::uint64_t frameId = 0;
  std::uint32_t codedWidth = 0, codedHeight = 0;
  VideoFrameRect visibleRect;
  DecodedColorSpace colorSpace;
  UINT originalSubresource = 0;
};

// What a decoded frame presents, plus the staging texture a CPU producer
// writes it through. Both go back to their recycler with the frame.
struct DecodedSurface {
  winrt::com_ptr<ID3D11Texture2D> texture, staging;
};
using DecodedSurfaces = SurfaceRecycler<DecodedSurface>;

// The frame presenting surface.texture; its last owner gives the surface back.
// Every reader reads a decoded frame on the producer's immediate context and
// waits for that read before releasing it (exporter RetireInput, ReadI420), so
// the next write into a recycled texture is queued after those reads.
inline std::shared_ptr<GpuDecodedFrame> RecycledFrame(
    const std::shared_ptr<DecodedSurfaces>& surfaces, DecodedSurface surface, SurfaceSize size) {
  struct Recycle {
    std::weak_ptr<DecodedSurfaces> surfaces;
    winrt::com_ptr<ID3D11Texture2D> staging;
    SurfaceSize size;
    std::uint64_t generation = 0;
    void operator()(GpuDecodedFrame* frame) noexcept {
      const std::unique_ptr<GpuDecodedFrame> owned(frame);
      if (const auto target = surfaces.lock(); target && frame->texture)
        target->Return({std::move(frame->texture), std::move(staging)}, size, generation);
    }
  };
  auto frame = std::make_unique<GpuDecodedFrame>();
  frame->texture = std::move(surface.texture);
  Recycle recycle{surfaces, std::move(surface.staging), size, surfaces->Generation()};
  return std::shared_ptr<GpuDecodedFrame>(frame.release(), std::move(recycle));
}

struct I420Image {
  std::uint32_t width = 0, height = 0;
  std::vector<std::uint8_t> y, u, v;
};

// Pure layout helper also exercised by no-media contract tests.
I420Image CopyNv12ToI420(std::span<const std::uint8_t> mapped, std::size_t rowPitch,
                         std::uint32_t textureWidth, std::uint32_t textureHeight, VideoFrameRect crop);

struct DecoderSchedulingStats {
  TimingAggregate enqueueToFirstProcessInput, enqueueToAccepted;
  TimingAggregate processInput, processOutput, acceptedToOutputSample;
  TimingAggregate copyOutput, acceptedCallback, frameSink;
  std::uint64_t outputCapacityChecks = 0, outputCapacityDeferrals = 0;
  std::uint64_t processInputOtherHresults = 0, processOutputOtherHresults = 0;
  std::uint64_t pumpBudgetYields = 0;
  std::uint64_t sampleRetirementDeferrals = 0;
};

template <typename Retire, typename Pending>
bool DecoderSamplesReadyForTransform(Retire&& retire, Pending&& pending) {
  std::forward<Retire>(retire)();
  return std::forward<Pending>(pending)() == 0;
}

// One scalar stamp per existing queued AU; retries keep that AU and its first
// attempt. These steady-clock intervals never replace its original media PTS.
struct DecoderInputTiming {
  using Clock = TimingAggregate::Clock;
  Clock::time_point enqueuedAt{};
  bool attempted = false;
  void BeforeProcessInput(DecoderSchedulingStats& stats, Clock::time_point now) noexcept {
    if (attempted) return;
    attempted = true;
    stats.enqueueToFirstProcessInput.Observe(enqueuedAt, now);
  }
  void Accepted(DecoderSchedulingStats& stats, Clock::time_point now) const noexcept {
    stats.enqueueToAccepted.Observe(enqueuedAt, now);
  }
};

struct DecoderStats {
  std::string state = "starting";
  std::string name, clsid, adapterDescription, driverVersion;
  UINT vendorId = 0, deviceId = 0;
  LUID luid{};
  bool synchronous = false, d3d11Aware = false, d3d11Configured = false;
  bool lowLatencyConfigured = false;
  bool gpuOutputValidated = false, capabilitiesChecked = false, nv12Supported = false;
  std::optional<bool> hardwareExecutionObserved;
  UINT decoderCaps = 0, capsWidth = 0, capsHeight = 0;
  bool outputTypeConfigured = false, spsVerified = false;
  H264Sps sps;
  std::uint64_t accepted = 0, submitted = 0, inputBytes = 0, notAccepting = 0;
  std::uint64_t outputSamples = 0, gpuFrames = 0, sampleReturns = 0, gpuCopies = 0;
  std::uint64_t gpuCopiesCompleted = 0, discardedGpuFrames = 0, abandonedGpuCopies = 0;
  std::uint64_t streamChanges = 0, needMoreInput = 0, flushes = 0;
  std::uint64_t droppedInput = 0, droppedAfterSubmit = 0, errors = 0;
  std::uint64_t pendingPackets = 0, pendingBytes = 0, pendingGpuCopies = 0;
  std::uint64_t awaitingOutput = 0, peakAwaitingOutput = 0, peakGpuCopies = 0;
  std::uint64_t i420Readbacks = 0, i420ReadbackBytes = 0;
  double totalDecodeLatencyMs = 0, maxDecodeLatencyMs = 0;
  double totalGpuHoldMs = 0, maxGpuHoldMs = 0;
  std::int64_t firstTimestampUs = -1, lastTimestampUs = -1;
  DecoderSchedulingStats scheduling;
};

// Synchronous inbox MFT, pumped on one MTA worker. GPU outputs are asynchronous
// only with respect to our copy fence; there are no MFT NeedInput/HaveOutput credits.
class MfH264Decoder {
 public:
  using FrameSink = std::function<bool(std::shared_ptr<const GpuDecodedFrame>)>;
  using AcceptedSink = std::function<void(std::uint64_t)>;
  using RetainedFrames = std::function<std::size_t()>;
  MfH264Decoder(const DecoderConfig& config, FrameSink frames,
                 AcceptedSink accepted, RetainedFrames retained,
                 DecoderNativeCallObserver observer = {});
  ~MfH264Decoder();
  MfH264Decoder(const MfH264Decoder&) = delete;
  MfH264Decoder& operator=(const MfH264Decoder&) = delete;
  void Enqueue(std::uint64_t requestId, EncodedPacket packet);
  void Pump();
  void BeginFlush();
  bool TakeFlushCompleted();
  void BeginStop();
  void Abort();
  bool Finished() const;
  HANDLE WakeEvent() const;
  DecoderStats GetStats() const;
  // Explicit, full-frame readback for a future real kNative ToI420 implementation.
  // Never called by normal decoding. Caller retains frame and invokes on this worker.
  I420Image ReadI420(const std::shared_ptr<const GpuDecodedFrame>& frame);
 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace monky::screen_video
