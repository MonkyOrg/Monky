#pragma once

#include "mf_h264_encoder.h"

#include <functional>
#include <optional>
#include <span>

namespace monky::screen_video {

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

struct FrameInspection {
  std::string hash;
  double meanLuma = 0, stddevLuma = 0;
  std::uint32_t minLuma = 0, maxLuma = 0;
  static constexpr std::uint32_t width = 24, height = 24;
};

struct I420Image {
  std::uint32_t width = 0, height = 0;
  std::vector<std::uint8_t> y, u, v;
};

// Pure layout helpers also exercised by no-media contract tests.
H264Sps ParseProfileLevelId(const std::string& value);
I420Image CopyNv12ToI420(std::span<const std::uint8_t> mapped, std::size_t rowPitch,
                         std::uint32_t textureWidth, std::uint32_t textureHeight, VideoFrameRect crop);
FrameInspection InspectLuma(std::span<const std::uint8_t> mapped, std::size_t rowPitch);

struct DecoderSchedulingStats {
  EncoderTimingAggregate enqueueToFirstProcessInput, enqueueToAccepted;
  EncoderTimingAggregate processInput, processOutput, acceptedToOutputSample;
  EncoderTimingAggregate copyOutput, acceptedCallback, frameSink;
  std::uint64_t outputCapacityChecks = 0, outputCapacityDeferrals = 0;
  std::uint64_t processInputOtherHresults = 0, processOutputOtherHresults = 0;
  std::uint64_t pumpBudgetYields = 0;
};

// One scalar stamp per existing queued AU; retries keep that AU and its first
// attempt. These steady-clock intervals never replace its original media PTS.
struct DecoderInputTiming {
  using Clock = EncoderTimingAggregate::Clock;
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
  std::uint64_t diagnosticReadbacks = 0, diagnosticReadbackBytes = 0;
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
                 AcceptedSink accepted, RetainedFrames retained);
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
  FrameInspection Inspect(const std::shared_ptr<const GpuDecodedFrame>& frame);
  // Explicit, full-frame readback for a future real kNative ToI420 implementation.
  // Never called by normal decoding. Caller retains frame and invokes on this worker.
  I420Image ReadI420(const std::shared_ptr<const GpuDecodedFrame>& frame);
 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace monky::screen_video
