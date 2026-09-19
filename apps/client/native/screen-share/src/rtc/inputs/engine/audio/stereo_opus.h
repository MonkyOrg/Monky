#pragma once

#include "api\audio_codecs\audio_decoder_factory_template.h"
#include "api\audio_codecs\audio_encoder_factory_template.h"
#include "api\audio_codecs\opus\audio_decoder_opus.h"
#include "api\audio_codecs\opus\audio_encoder_opus.h"

#include <stdexcept>

namespace monky::native_rtc::engine::audio {

// M140 codec preferences select an existing supported codec; they do not copy
// arbitrary preference FMTP into SDP. Advertise stereo at the factory itself.
struct StereoOpusEncoder : webrtc::AudioEncoderOpus {
  static std::optional<Config> SdpToConfig(const webrtc::SdpAudioFormat& format) {
    auto config = webrtc::AudioEncoderOpus::SdpToConfig(format);
    return config && config->num_channels == 2 ? config : std::nullopt;
  }
  static void AppendSupportedEncoders(std::vector<webrtc::AudioCodecSpec>* specs) {
    const auto begin = specs->size();
    webrtc::AudioEncoderOpus::AppendSupportedEncoders(specs);
    for (auto index = begin; index < specs->size(); ++index) {
      auto& spec = (*specs)[index];
      spec.format.parameters["stereo"] = "1";
      spec.format.parameters["sprop-stereo"] = "1";
      const auto config = SdpToConfig(spec.format);
      if (!config) throw std::runtime_error("Pinned Opus stereo capability is invalid");
      spec.info = QueryAudioEncoder(*config);
    }
  }
};

struct StereoOpusDecoder : webrtc::AudioDecoderOpus {
  static void AppendSupportedDecoders(std::vector<webrtc::AudioCodecSpec>* specs) {
    const auto begin = specs->size();
    webrtc::AudioDecoderOpus::AppendSupportedDecoders(specs);
    for (auto index = begin; index < specs->size(); ++index) {
      (*specs)[index].format.parameters["stereo"] = "1";
      (*specs)[index].format.parameters["sprop-stereo"] = "1";
    }
  }
};

}  // namespace monky::native_rtc::engine::audio
