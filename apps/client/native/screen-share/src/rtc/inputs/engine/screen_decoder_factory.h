#pragma once
#include "api/video_codecs/video_decoder_factory.h"
#include "modules/video_coding/codecs/av1/dav1d_decoder.h"
#include "modules/video_coding/include/video_error_codes.h"
#include "rtc_base/logging.h"
#include "av1_sequence.h"
#include "codec_policy.h"

namespace monky::native_rtc::engine {
class BoundedAv1Decoder final : public webrtc::VideoDecoder {
 public:
  explicit BoundedAv1Decoder(const webrtc::Environment& env) : decoder_(webrtc::CreateDav1dDecoder(env)) {}
  bool Configure(const Settings& settings) override {
    sequence_ = false;
    return decoder_->Configure(settings);
  }
  int32_t Decode(const webrtc::EncodedImage& image, int64_t render_time_ms) override {
    try {
      const auto info = screen_video::InspectAv1({image.data(), image.size()});
      if (info.sequence) {
        screen_video::ReadAv1Sequence(info.sequence_header);
        sequence_ = true;
      }
      if (!sequence_ || !info.picture)
        throw std::runtime_error("AV1 decoder requires an admitted sequence and frame");
    } catch (const std::exception& error) {
      RTC_LOG(LS_ERROR) << "Screen AV1 decoder rejected input: " << error.what();
      sequence_ = false;
      return WEBRTC_VIDEO_CODEC_ERR_PARAMETER;
    }
    return decoder_->Decode(image, render_time_ms);
  }
  int32_t RegisterDecodeCompleteCallback(webrtc::DecodedImageCallback* callback) override {
    return decoder_->RegisterDecodeCompleteCallback(callback);
  }
  int32_t Release() override { sequence_ = false; return decoder_->Release(); }
  DecoderInfo GetDecoderInfo() const override { return decoder_->GetDecoderInfo(); }
 private:
  std::unique_ptr<webrtc::VideoDecoder> decoder_;
  bool sequence_ = false;
};

class ScreenDecoderFactory final : public webrtc::VideoDecoderFactory {
 public:
  explicit ScreenDecoderFactory(std::unique_ptr<webrtc::VideoDecoderFactory> h264, bool encoded, bool av1)
      : h264_(std::move(h264)), h264_enabled_(!encoded || !av1), av1_enabled_(!encoded || av1) {}
  std::vector<webrtc::SdpVideoFormat> GetSupportedFormats() const override {
    auto formats = h264_enabled_ ? h264_->GetSupportedFormats() : std::vector<webrtc::SdpVideoFormat>{};
    if (av1_enabled_) formats.push_back(codec_policy::ScreenAv1Format());
    return formats;
  }
  CodecSupport QueryCodecSupport(const webrtc::SdpVideoFormat& format, bool scaling) const override {
    if (format.name != "AV1") return h264_enabled_ ? h264_->QueryCodecSupport(format, scaling) : CodecSupport{false, false};
    return {av1_enabled_ && !scaling && codec_policy::IsScreenAv1Format(format), false};
  }
  std::unique_ptr<webrtc::VideoDecoder> Create(const webrtc::Environment& env,
                                             const webrtc::SdpVideoFormat& format) override {
    if (format.name == "AV1")
      return QueryCodecSupport(format, false).is_supported ? std::make_unique<BoundedAv1Decoder>(env) : nullptr;
    return h264_enabled_ ? h264_->Create(env, format) : nullptr;
  }
 private:
  std::unique_ptr<webrtc::VideoDecoderFactory> h264_;
  const bool h264_enabled_, av1_enabled_;
};
}
