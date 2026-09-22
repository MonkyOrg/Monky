#pragma once

#include <Windows.h>
#include <d3d11_4.h>
#include <winrt/base.h>

#include "h264_bitstream.h"
#include "mf_h264_configuration_readback.h"

#include <cstdint>
#include <chrono>
#include <functional>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace monky::screen_video {

class EncoderError : public std::runtime_error {
 public:
  EncoderError(std::string code, std::string message, HRESULT hr = S_OK)
      : std::runtime_error(std::move(message)), code(std::move(code)), hresult(hr) {}
  std::string code;
  HRESULT hresult;
};

struct EncoderConfig {
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::uint32_t fps = 0;
  std::uint32_t bitrateBps = 0;
  std::uint32_t maxInFlight = 8;
  std::uint8_t level = 0;
  H264Profile profile = H264Profile::Baseline;
};

// A real GPU frame. A caller may use an aliasing shared_ptr to retain its own
// source lease; this encoder releases only its reference after its copy fence.
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

struct EncoderInfo {
  std::string name;
  std::string clsid;
  bool hardware = false;
  bool d3d11Aware = false;
  bool asynchronous = false;
  bool dynamicBitrate = false;
  bool forceKeyFrame = false;
  bool lowLatency = false;
  std::uint8_t requestedLevel = 0;
  H264Profile requestedProfile = H264Profile::Baseline;
  bool spsVerified = false;
  H264Sps sps;
  std::vector<std::string> rejectedCandidates;
};

struct EncoderTimingAggregate {
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
decltype(auto) MeasureEncoderCall(EncoderTimingAggregate& aggregate, Function&& function) {
  struct Measurement {
    EncoderTimingAggregate& aggregate;
    EncoderTimingAggregate::Clock::time_point begin = EncoderTimingAggregate::Clock::now();
    ~Measurement() { aggregate.Observe(begin, EncoderTimingAggregate::Clock::now()); }
  } measurement{aggregate};
  return std::forward<Function>(function)();
}

struct EncoderCallbackTiming {
  std::uint64_t callbacks = 0;
  EncoderTimingAggregate arrivalInterval, callbackToQueue;

  // Caller owns the callback-queue mutex. Entry is captured in Invoke, NOT
  // when the worker eventually handles the notification.
  void Observe(EncoderTimingAggregate::Clock::time_point entered,
               EncoderTimingAggregate::Clock::time_point queued) noexcept {
    ++callbacks;
    if (previous_) arrivalInterval.Observe(*previous_, entered);
    callbackToQueue.Observe(entered, queued);
    previous_ = entered;
  }
 private:
  std::optional<EncoderTimingAggregate::Clock::time_point> previous_;
};

struct EncoderSchedulingStats {
  EncoderCallbackTiming needInput, haveOutput;
  EncoderTimingAggregate needInputDispatch, haveOutputDispatch;
  EncoderTimingAggregate processInput, processOutput, packetSink;
  std::uint64_t peakPendingNotices = 0;
};

struct EncoderStats {
  std::string state = "starting";
  EncoderInfo info;
  std::uint64_t inputs = 0;
  std::uint64_t accepted = 0;
  std::uint64_t submitted = 0;
  std::uint64_t outputs = 0;
  std::uint64_t keyFrames = 0;
  std::uint64_t bytes = 0;
  std::uint64_t droppedInput = 0;
  std::uint64_t droppedOnStop = 0;
  std::uint64_t droppedAfterSubmit = 0;
  std::uint64_t privateAllocations = 0;
  std::uint64_t gpuCopies = 0;
  std::uint64_t sampleReturns = 0;
  std::uint64_t needInputEvents = 0;
  std::uint64_t haveOutputEvents = 0;
  std::uint64_t streamChanges = 0;
  std::uint64_t bitrateUpdates = 0;
  std::uint64_t keyFrameRequests = 0;
  std::uint64_t errors = 0;
  std::uint64_t inFlight = 0;
  std::uint64_t peakInFlight = 0;
  std::uint64_t pendingCallbacks = 0;
  std::uint32_t bitrateBps = 0;
  std::uint32_t maxInFlight = 0;
  double totalEncodeLatencyMs = 0;
  double maxEncodeLatencyMs = 0;
  double totalQueueLatencyMs = 0;
  double maxQueueLatencyMs = 0;
  EncoderSchedulingStats scheduling;
  std::int64_t firstInputTimestampUs = -1;
  std::int64_t lastInputTimestampUs = -1;
  std::int64_t firstOutputTimestampUs = -1;
  std::int64_t lastOutputTimestampUs = -1;
  EncoderConfigurationReadbacks configurationReadbacks;
};

// Thread-affine MTA core: no Node-API, Electron, transport or CPU pixel buffers.
// The host pumps WakeEvent() on its worker alongside its capture/fence events.
class MfH264Encoder {
 public:
  using PacketSink = std::function<bool(EncodedPacket&&)>;
  MfH264Encoder(ID3D11Device* device, ID3D11DeviceContext4* context,
                const EncoderConfig& config, PacketSink sink);
  ~MfH264Encoder();
  MfH264Encoder(const MfH264Encoder&) = delete;
  MfH264Encoder& operator=(const MfH264Encoder&) = delete;

  bool TryEncode(std::shared_ptr<const GpuNv12Frame> frame);
  void Pump();
  void SetBitrate(std::uint32_t bitrateBps);
  void RequestKeyFrame();
  void BeginDrain();
  void Abort();
  bool Finished() const;
  HANDLE WakeEvent() const;
  EncoderStats GetStats() const;
 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace monky::screen_video
