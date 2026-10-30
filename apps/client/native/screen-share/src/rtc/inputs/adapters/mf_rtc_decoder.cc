#include "mf_rtc_decoder_worker.h"

namespace monky::native_rtc::mf::detail {
namespace {

class MfDecoderFactory final : public webrtc::VideoDecoderFactory {
 public:
  explicit MfDecoderFactory(std::shared_ptr<SharedState> state) : state_(std::move(state)) {}
  std::vector<webrtc::SdpVideoFormat> GetSupportedFormats() const override {
    return SupportedFormats(state_->options.maximum_h264_level);
  }
  CodecSupport QueryCodecSupport(const webrtc::SdpVideoFormat& format,
                                 bool reference_scaling) const override {
    return {!reference_scaling &&
                ParseFormat(format, state_->options.maximum_h264_level).has_value(), false};
  }
  std::unique_ptr<webrtc::VideoDecoder> Create(
      const webrtc::Environment& env, const webrtc::SdpVideoFormat& format) override {
    const auto negotiated = ParseFormat(format, state_->options.maximum_h264_level);
    if (!negotiated) {
      state_->Report(0, Diagnostic("ERR_RTC_DECODER_FORMAT",
                                   "Unsupported H264 SDP format or scalability mode",
                                   WEBRTC_VIDEO_CODEC_ERR_PARAMETER));
      return nullptr;
    }
    return std::make_unique<MfVideoDecoder>(env, state_, *negotiated);
  }
 private:
  const std::shared_ptr<SharedState> state_;
};

}  // namespace

std::unique_ptr<webrtc::VideoDecoderFactory> MakeDecoderFactory(
    const std::shared_ptr<SharedState>& state) {
  return std::make_unique<MfDecoderFactory>(state);
}

}  // namespace monky::native_rtc::mf::detail
