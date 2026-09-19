#pragma once

#include "stereo_opus.h"
#include "media_policy.h"
#pragma push_macro("GetObject")
#undef GetObject
#include "sdp\MediaSection.hpp"
#include "modules\audio_coding\codecs\opus\opus_interface.h"

#include <array>
#include <cmath>
#include <memory>

namespace monky::native_rtc::engine::audio {

// Pinned SDP/Opus DSP only: no factory, AudioState, transport, thread or device.
template <typename Check>
void RunStereoChecks(Check&& check) {
  const webrtc::SdpAudioFormat legacy("opus", 48000, 2);
  const auto mono = webrtc::AudioEncoderOpus::SdpToConfig(legacy);
  check(mono && mono->num_channels == 1 && !StereoOpusEncoder::SdpToConfig(legacy),
        "RTP channels2 was mistaken for actual stereo encoder negotiation");
  std::vector<webrtc::AudioCodecSpec> encoders, decoders;
  StereoOpusEncoder::AppendSupportedEncoders(&encoders);
  StereoOpusDecoder::AppendSupportedDecoders(&decoders);
  check(encoders.size() == 1 && decoders.size() == 1 &&
        encoders.front().info.num_channels == 2,
        "Audio factory advertised a mono/default codec");
  const auto p2p = encoders.front().format;
  check(p2p.parameters.at("stereo") == "1" && p2p.parameters.at("sprop-stereo") == "1" &&
        decoders.front().format.parameters.at("stereo") == "1",
        "P2P offer/answer factory capabilities lost stereo FMTP");

  const Json codec{{"mimeType", "audio/opus"}, {"payloadType", 111}, {"clockRate", 48000},
      {"channels", 2}, {"parameters", Json::object()}, {"rtcpFeedback", Json::array()}};
  const Json parameters{{"codecs", Json::array({codec})}, {"headerExtensions", Json::array()}};
  const Json media{{"mid", "audio0"}, {"type", "audio"}, {"protocol", "UDP/TLS/RTP/SAVPF"},
      {"ext", Json::array()}};
  const Json ice{{"usernameFragment", "fixture"}, {"password", "fixture-password"}};
  const Json dtls{{"role", "server"}};
  auto offer = parameters, answer = parameters;
  const auto options = OpusCodecOptions();
  mediasoupclient::Sdp::AnswerMediaSection remote(ice, Json::array(), dtls, nullptr,
      media, offer, answer, &options);
  const auto object = remote.GetObject();
  check(offer.at("codecs").front().at("parameters").at("sprop-stereo") == 1 &&
        object.at("fmtp").size() == 1 &&
        object.at("fmtp").front().at("config") == "stereo=1",
        "Actual SDK Produce codec options did not negotiate a stereo remote answer");
  auto old_offer = parameters, old_answer = parameters;
  mediasoupclient::Sdp::AnswerMediaSection old_remote(ice, Json::array(), dtls, nullptr,
      media, old_offer, old_answer, nullptr);
  check(old_remote.GetObject().at("fmtp").empty(),
        "Legacy null codec-options fixture no longer reproduces missing stereo negotiation");
  const auto sdp = std::string(
      "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n"
      "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\nc=IN IP4 0.0.0.0\r\n"
      "a=mid:audio0\r\na=rtcp-mux\r\na=recvonly\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 ") +
      object.at("fmtp").front().at("config").get<std::string>() + "\r\n";
  const auto parsed = peer_detail::ParseDescription(webrtc::SdpType::kAnswer, sdp, 64);
  const auto& parsed_codec = parsed->description()->contents().front().media_description()->as_audio()->codecs().front();
  const webrtc::SdpAudioFormat sfu(parsed_codec.name, parsed_codec.clockrate,
                                  parsed_codec.channels, parsed_codec.params);
  for (const auto& format : {p2p, sfu}) {
    const auto config = StereoOpusEncoder::SdpToConfig(format);
    check(config && config->num_channels == 2, "Pinned encoder selected mono from actual negotiated FMTP");
    if (!config) throw std::runtime_error("Stereo codec fixture has no encoder configuration");
    OpusEncInst* raw_encoder = nullptr;
    if (WebRtcOpus_EncoderCreate(&raw_encoder, config->num_channels, 1, 48000) != 0)
      throw std::runtime_error("CPU Opus encoder allocation failed");
    const std::unique_ptr<OpusEncInst, decltype(&WebRtcOpus_EncoderFree)>
        encoder(raw_encoder, &WebRtcOpus_EncoderFree);
    OpusDecInst* raw_decoder = nullptr;
    if (WebRtcOpus_DecoderCreate(&raw_decoder, 2, 48000) != 0)
      throw std::runtime_error("CPU Opus decoder allocation failed");
    const std::unique_ptr<OpusDecInst, decltype(&WebRtcOpus_DecoderFree)>
        decoder(raw_decoder, &WebRtcOpus_DecoderFree);
    check(WebRtcOpus_SetBitRate(encoder.get(), 128000) == 0, "CPU Opus bitrate was rejected");
    double energy = 0, summed_energy = 0;
    for (unsigned block = 0; block < 10; ++block) {
      std::array<std::int16_t, 1920> input{}, output{};
      for (unsigned frame = 0; frame < 960; ++frame) {
        const auto sample = static_cast<std::int16_t>(16384 * std::sin(
            6.283185307179586 * 997 * (block * 960 + frame) / 48000));
        input[2 * frame] = sample;
        input[2 * frame + 1] = -sample;
      }
      std::array<std::uint8_t, 4096> packet{};
      const int bytes = WebRtcOpus_Encode(encoder.get(), input.data(), 960, packet.size(), packet.data());
      if (bytes <= 0) throw std::runtime_error("CPU Opus encoding failed");
      std::int16_t audio_type = 0;
      const auto frames = WebRtcOpus_Decode(decoder.get(), packet.data(), bytes, output.data(), &audio_type);
      check(frames == 960, "CPU Opus decoding lost the stereo block");
      if (frames != 960) throw std::runtime_error("CPU Opus decoder returned an invalid block");
      for (unsigned frame = 0; frame < 960; ++frame) {
        const double left = output[2 * frame], right = output[2 * frame + 1];
        energy += left * left + right * right;
        summed_energy += (left + right) * (left + right);
      }
    }
    check(energy > 100000000 && summed_energy < energy * .05,
          "Anti-phase stereo collapsed to silence or duplicated mono after pinned Opus DSP");
  }
}

}  // namespace monky::native_rtc::engine::audio

#pragma pop_macro("GetObject")
