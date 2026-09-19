#pragma once

#include "mf_h264_decoder.h"
#include "mf_rtc_encoder_diagnostics.h"
#include "mf_rtc_decoder_diagnostics.h"

#include "api\scoped_refptr.h"
#include "api\video\video_frame_buffer.h"
#include "api\video_codecs\video_decoder_factory.h"
#include "api\video_codecs\video_encoder_factory.h"

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
class SourceWorker;
}

struct AdapterOptions {
  std::uint8_t maximum_h264_level = 52;
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

struct EncoderRuntimeSnapshot {
  std::uint64_t session_id = 0, encode_requests = 0;
  screen_video::EncoderConfig configured;
  std::uint32_t maximum_bitrate_bps = 0, requested_keyframe_interval = 0;
  double requested_fps = 0;
  std::optional<double> rtc_requested_fps;
  std::uint32_t requested_bitrate_bps = 0;
  std::size_t pending_frames = 0, submitted_metadata = 0;
  bool core_observed = false;
  screen_video::EncoderStats core;
  std::optional<EncoderDiagnosticSnapshot> diagnostics;
  // Worker slots retain only the ledger. SharedState::Snapshot copies its live
  // values and clears this pointer in the returned, independently owned value.
  std::shared_ptr<const detail::EncoderDiagnosticLedger> diagnostic_ledger;
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
  std::shared_ptr<const detail::DecoderDiagnosticLedger> diagnostic_ledger;
};

struct AdapterSnapshot {
  std::size_t live_workers = 0;
  std::size_t native_buffers = 0;
  std::uint64_t diagnostics_overwritten = 0;
  std::uint64_t encoded_access_units = 0;
  std::uint64_t rtc_rejected_access_units = 0;
  std::uint64_t decoded_gpu_frames = 0;
  std::uint64_t i420_readbacks = 0;
  std::uint64_t i420_failures = 0;
  std::vector<EncoderRuntimeSnapshot> encoders;
  std::vector<DecoderRuntimeSnapshot> decoders;
  std::optional<bool> hardware_execution_observed;
};

struct FactoryBundle;

class NativeGpuSource {
 public:
  ~NativeGpuSource();
  NativeGpuSource(const NativeGpuSource&) = delete;
  NativeGpuSource& operator=(const NativeGpuSource&) = delete;

  // The supplied shared_ptr must retain the producer's immutable texture lease,
  // not just AddRef its texture. Timestamp/duration are the actual source times.
  // Pixels must be BT.709-limited NV12; there is no implicit color conversion.
  // Ready fences must be monotonic. Pending fence registrations retain their
  // owner even after Close/Release; stopping the producer must retire its fences.
  // Keyed textures use key 0 with nonblocking acquisition, as in the MF core.
  // External keyed-mutex owners must not prevent the consumer's GPU copy.
  // Returns nullptr with a diagnostic on invalid input or bounded admission loss.
  webrtc::scoped_refptr<webrtc::VideoFrameBuffer> WrapFrame(
      std::shared_ptr<const screen_video::GpuNv12Frame> frame);

  // Revokes new input. Existing buffers retain their MTA readback owner.
  // Returns a WebRTC codec status; a timeout never terminates a native thread.
  std::int32_t Close();

 private:
  friend class NativeRtcContext;
  explicit NativeGpuSource(std::shared_ptr<detail::SourceWorker> worker);
  std::shared_ptr<detail::SourceWorker> worker_;
};

class NativeRtcContext {
 public:
  ~NativeRtcContext();
  NativeRtcContext(const NativeRtcContext&) = delete;
  NativeRtcContext& operator=(const NativeRtcContext&) = delete;

  // Borrows and AddRefs an existing device/context; never creates a device.
  // One source worker serves all buffers from this source, including ToI420.
  std::shared_ptr<NativeGpuSource> CreateSource(
      ID3D11Device* device, ID3D11DeviceContext4* context);

  // Identity-checked lookup, with no RTTI requirement on upstream WebRTC.
  // The aliasing pointers retain the COMPLETE lease, including its readback
  // worker. Null means a foreign buffer, or (for GetDecodedFrame) a source frame.
  std::shared_ptr<const screen_video::GpuNv12Frame> GetGpuFrame(
      const webrtc::scoped_refptr<webrtc::VideoFrameBuffer>& buffer) const;
  std::shared_ptr<const screen_video::GpuDecodedFrame> GetDecodedFrame(
      const webrtc::scoped_refptr<webrtc::VideoFrameBuffer>& buffer) const;

  std::vector<AdapterDiagnostic> TakeDiagnostics();
  AdapterSnapshot Snapshot() const;

  // Observation only: first Release codecs, Close sources, and release buffers.
  // Waits for actual OS thread exit, not merely a stop-request acknowledgement.
  // The DLL and this context must remain alive until this returns true.
  bool WaitForIdle(std::chrono::milliseconds timeout);

 private:
  friend struct FactoryBundle;
  friend FactoryBundle CreateFactoryBundle(const AdapterOptions&);
  explicit NativeRtcContext(std::shared_ptr<detail::SharedState> state);
  std::shared_ptr<detail::SharedState> state_;
};

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
// InitEncode/Configure reconfiguration preserves a still-live registration.
// Release from a callback requests asynchronous retirement (never self-join).
// Retained buffers may still issue explicit ToI420 after codec Release.
FactoryBundle CreateFactoryBundle(const AdapterOptions& options = {});

}  // namespace monky::native_rtc::mf
