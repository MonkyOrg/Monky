#pragma once

#include "api/scoped_refptr.h"
#include "api/video/video_frame.h"
#include "api/video/video_frame_buffer.h"
#include "api/video_codecs/video_decoder_factory.h"
#include "api/video_codecs/video_encoder_factory.h"
#include "json.hpp"
#include <CoreVideo/CoreVideo.h>
#include <array>
#include <chrono>
#include <memory>
#include <vector>

namespace monky::native_rtc::mac {
struct PixelFrame {
  explicit PixelFrame(CVPixelBufferRef pixel) : pixel(pixel) { CVPixelBufferRetain(pixel); }
  ~PixelFrame() { CVPixelBufferRelease(pixel); }
  PixelFrame(const PixelFrame&) = delete;
  PixelFrame& operator=(const PixelFrame&) = delete;
  CVPixelBufferRef pixel;
};
struct AdapterOptions {
  std::uint8_t maximum_h264_level = 60;
  std::uint32_t maximum_workers = 32;
  std::uint32_t maximum_native_buffers = 256;
  std::chrono::milliseconds operation_timeout{12000};
};
struct AdapterDiagnostic {
  std::uint64_t session_id = 0;
  std::int32_t codec_status = 0, hresult = 0;
  bool terminal = false;
  std::array<char, 80> code{};
  std::array<char, 512> message{};
};
struct FactoryBundle;
class NativeRtcContext {
 public:
  struct State;
  explicit NativeRtcContext(std::shared_ptr<State>);
  ~NativeRtcContext();
  std::shared_ptr<const PixelFrame> GetDecodedFrame(
      const webrtc::scoped_refptr<webrtc::VideoFrameBuffer>&) const;
  std::vector<AdapterDiagnostic> TakeDiagnostics();
  nlohmann::json Snapshot() const;
  bool WaitForIdle(std::chrono::milliseconds);
 private:
  std::shared_ptr<State> state_;
};
struct FactoryBundle {
  std::shared_ptr<NativeRtcContext> context;
  std::unique_ptr<webrtc::VideoEncoderFactory> encoder_factory;
  std::unique_ptr<webrtc::VideoDecoderFactory> decoder_factory;
};
FactoryBundle CreateFactoryBundle(const AdapterOptions&);
std::shared_ptr<const PixelFrame> UploadCpuFrame(const webrtc::VideoFrame&);
}
