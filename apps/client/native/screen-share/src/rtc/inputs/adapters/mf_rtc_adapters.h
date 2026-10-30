#pragma once

#include "mf_h264_decoder.h"
#include "mf_rtc_decoder_diagnostics.h"

#include "api/scoped_refptr.h"
#include "api/video/video_frame_buffer.h"
#include "api/video_codecs/video_decoder_factory.h"
#include "api/video_codecs/video_encoder_factory.h"

#include <array>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <optional>
#include <vector>

// INTERNAL to the clang-cl/libc++ DLL. None of these types is an addon ABI.
namespace monky::native_rtc::mf {

namespace detail {
class SharedState;
}

struct AdapterOptions {
  std::uint8_t maximum_h264_level = 60;
  std::uint32_t maximum_workers = 8;
  std::uint32_t maximum_in_flight = 8;
  std::uint32_t maximum_pending_frames = 32;
  std::size_t maximum_pending_encoded_bytes = 32 * 1024 * 1024;
  std::uint32_t maximum_native_buffers = 64;
  // Explicit MF capability/media-type hints, not measured stream statistics.
  std::uint32_t decoder_fps = 30;
  std::uint32_t decoder_bitrate_bps = 4000000;
  // Bounds client waits, not a non-cancellable MFT call or a caller's callback.
  std::chrono::milliseconds operation_timeout{12000};
};

struct AdapterDiagnostic {
  std::uint64_t session_id = 0;
  std::int32_t codec_status = 0;
  HRESULT hresult = S_OK;
  bool terminal = false;
  std::array<char, 80> code{};
  std::array<char, 512> message{};
};

struct DecoderRuntimeSnapshot {
  std::uint64_t session_id = 0, loss_epoch = 0, core_generation = 0, observation_sequence = 0;
  std::optional<std::int64_t> observed_at_rtc_us, core_observed_at_rtc_us;
  std::optional<std::uint64_t> core_start_loss_epoch;
  std::uint32_t maximum_width = 0, maximum_height = 0, maximum_in_flight = 0;
  std::uint32_t maximum_pending_frames = 0;
  std::size_t maximum_pending_bytes = 0;
  std::uint32_t capability_fps_hint = 0, capability_bitrate_hint_bps = 0;
  std::size_t pending_frames = 0, submitted_metadata = 0, retained_leases = 0, retired_core_sessions = 0;
  bool recovery_requested = false, recovery_in_progress = false, needs_keyframe = true;
  bool flushing = false, switching = false, stopping = false;
  std::int32_t worker_status = 0;
  bool core_observed = false;
  screen_video::DecoderConfig configured;
  screen_video::DecoderStats core;
  std::optional<DecoderDiagnosticSnapshot> diagnostics;
  // Worker slots retain only the ledger. SharedState::Snapshot copies its live
  // values and clears this pointer in the returned, independently owned value.
  std::shared_ptr<const detail::DecoderDiagnosticLedger> diagnostic_ledger;
};

struct AdapterSnapshot {
  std::size_t live_workers = 0;
  std::size_t native_buffers = 0;
  std::uint64_t diagnostics_overwritten = 0;
  std::uint64_t decoded_gpu_frames = 0;
  std::uint64_t i420_readbacks = 0;
  std::uint64_t i420_failures = 0;
  std::vector<DecoderRuntimeSnapshot> decoders;
  std::optional<bool> hardware_execution_observed;
};

struct FactoryBundle;

class NativeRtcContext {
 public:
  ~NativeRtcContext();
  NativeRtcContext(const NativeRtcContext&) = delete;
  NativeRtcContext& operator=(const NativeRtcContext&) = delete;

  // Identity-checked lookup, with no RTTI requirement on upstream WebRTC.
  // The aliasing pointer retains the COMPLETE lease, including its readback
  // worker. Null means a foreign buffer.
  std::shared_ptr<const screen_video::GpuDecodedFrame> GetDecodedFrame(
      const webrtc::scoped_refptr<webrtc::VideoFrameBuffer>& buffer) const;

  std::vector<AdapterDiagnostic> TakeDiagnostics();
  AdapterSnapshot Snapshot() const;

  // Observation only: first Release codecs and release buffers.
  // Waits for actual OS thread exit, not merely a stop-request acknowledgement.
  // The DLL and this context must remain alive until this returns true.
  bool WaitForIdle(std::chrono::milliseconds timeout);

 private:
  friend struct FactoryBundle;
  friend FactoryBundle CreateFactoryBundle(const AdapterOptions&);
  explicit NativeRtcContext(std::shared_ptr<detail::SharedState> state);
  std::shared_ptr<detail::SharedState> state_;
};

// Media Foundation only decodes. Publication uses externally encoded frames, so
// encoder_factory stays empty here and encoded engines install their own.
struct FactoryBundle {
  std::shared_ptr<NativeRtcContext> context;
  std::unique_ptr<webrtc::VideoEncoderFactory> encoder_factory;
  std::unique_ptr<webrtc::VideoDecoderFactory> decoder_factory;
};

// Creates policy/factory objects only: no COM, media, device, or RTC factory.
// Move the factories into the parent's PeerConnectionFactory; both P2P and
// libmediasoupclient can use that same factory and this same context.
// Codec lifecycle calls follow WebRTC's externally serialized lifecycle.
// Register(nullptr) and Release revoke callbacks synchronously, waiting for
// an existing invocation unless called by that invocation. Callback objects
// must remain alive until then, must not throw, and must return promptly.
// Release clears registration; register again before using a released codec.
// Configure reconfiguration preserves a still-live registration.
// Release from a callback requests asynchronous retirement (never self-join).
// Retained buffers may still issue explicit ToI420 after codec Release.
FactoryBundle CreateFactoryBundle(const AdapterOptions& options = {});

}  // namespace monky::native_rtc::mf
