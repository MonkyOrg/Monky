#pragma once

#include <api/video_codecs/video_decoder_factory_template.h>
#include <api/video_codecs/video_decoder_factory_template_libvpx_vp8_adapter.h>
#include <api/video_codecs/video_encoder_factory_template.h>
#include <api/video_codecs/video_encoder_factory_template_libvpx_vp8_adapter.h>

#include <atomic>
#include <cstdint>
#include <memory>
#include <utility>

namespace monky::light::media {

struct VideoCodecActivity {
  std::atomic<std::uint64_t> encoders{0};
  std::atomic<std::uint64_t> decoders{0};
};

// M140 dereferences recv_codecs.front() when applying a video offer, before the
// answer can reject it. Keep real, lazy VP8 capabilities, then stop every video
// transceiver before answering. Counters distinguish capabilities from codecs.
class NegotiationVideoEncoderFactory final
    : public webrtc::VideoEncoderFactoryTemplate<webrtc::LibvpxVp8EncoderTemplateAdapter> {
 public:
  explicit NegotiationVideoEncoderFactory(std::shared_ptr<VideoCodecActivity> activity)
      : activity_(std::move(activity)) {}
  std::unique_ptr<webrtc::VideoEncoder> Create(
      const webrtc::Environment& environment, const webrtc::SdpVideoFormat& format) override {
    ++activity_->encoders;
    return VideoEncoderFactoryTemplate::Create(environment, format);
  }
 private:
  std::shared_ptr<VideoCodecActivity> activity_;
};

class NegotiationVideoDecoderFactory final
    : public webrtc::VideoDecoderFactoryTemplate<webrtc::LibvpxVp8DecoderTemplateAdapter> {
 public:
  explicit NegotiationVideoDecoderFactory(std::shared_ptr<VideoCodecActivity> activity)
      : activity_(std::move(activity)) {}
  std::unique_ptr<webrtc::VideoDecoder> Create(
      const webrtc::Environment& environment, const webrtc::SdpVideoFormat& format) override {
    ++activity_->decoders;
    return VideoDecoderFactoryTemplate::Create(environment, format);
  }
 private:
  std::shared_ptr<VideoCodecActivity> activity_;
};

}  // namespace monky::light::media
