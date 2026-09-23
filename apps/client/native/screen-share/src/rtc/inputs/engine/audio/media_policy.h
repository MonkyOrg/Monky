#pragma once

#include "..\peer_support.h"
#include "runtime.h"

#include <cmath>

namespace monky::native_rtc::engine::audio {

inline double Volume(const Json& data) {
  if (!data.contains("volume") || !data.at("volume").is_number())
    peer_detail::Invalid("Audio volume must be a finite number in 0..2");
  const auto value = data.at("volume").get<double>();
  if (!std::isfinite(value) || value < 0 || value > 2)
    peer_detail::Invalid("Audio volume must be a finite number in 0..2");
  return value;
}
inline void GateTrack(webrtc::MediaStreamTrackInterface& track, double volume) {
  if (track.kind() != webrtc::MediaStreamTrackInterface::kAudioKind)
    peer_detail::Invalid("Expected a receiver audio track");
  auto* source = static_cast<webrtc::AudioTrackInterface&>(track).GetSource();
  if (!source) throw Error("ERR_RTC_AUDIO_TRACK", "Receiver has no real audio source");
  source->SetVolume(volume);
}
inline void GateTrack(Host& host, webrtc::MediaStreamTrackInterface& track, double volume) {
  std::exception_ptr failure;
  auto apply = [&] {
    try { GateTrack(track, volume); } catch (...) { failure = std::current_exception(); }
  };
  if (host.SignalingThread()->IsCurrent()) apply();
  else host.SignalingThread()->BlockingCall(apply);
  if (failure) std::rethrow_exception(failure);
}
inline void PreferOpus(Host& host, webrtc::RtpTransceiverInterface& transceiver) {
  auto capabilities = host.Factory()->GetRtpSenderCapabilities(webrtc::MediaType::AUDIO);
  std::vector<webrtc::RtpCodecCapability> codecs;
  for (auto& codec : capabilities.codecs)
    if ((codec.name == "opus" || codec.name == "OPUS") &&
        codec.clock_rate == 48000 && codec.num_channels == 2 &&
        codec.parameters.contains("stereo") && codec.parameters.at("stereo") == "1")
      codecs.push_back(std::move(codec));
  if (codecs.empty()) throw Error("ERR_RTC_OPUS", "The injected factory has no Opus 48kHz codec");
  peer_detail::RtcOk(transceiver.SetCodecPreferences(codecs), "RTC rejected Opus codec preferences");
}
inline Json OpusCodecOptions() { return {{"opusStereo", true}}; }
inline std::uint64_t ExpectedOutputEpoch(const Json& data, bool receives_audio) {
  if (data.contains("expectedOutputEpoch")) return Id(data, "expectedOutputEpoch");
  if (receives_audio) peer_detail::Invalid("Receiving audio requires expectedOutputEpoch");
  return 0;
}
inline void CheckOutputAdmission(bool receives_audio, bool ready, bool before_mutation) {
  if (!receives_audio || ready) return;
  if (before_mutation)
    throw Error(MONKY_ENGINE_AUDIO_PRE_ADMISSION,
                "Expected audio output epoch is not ready before admission; no admission effects occurred",
                MONKY_ENGINE_BUSY);
  throw Error(MONKY_ENGINE_AUDIO_DURING_ADMISSION,
              "Expected audio output epoch changed or failed after admission started; do not replay SDP",
              MONKY_ENGINE_FAILURE);
}
inline webrtc::RtpEncodingParameters Encoding(const Json& data, bool enabled) {
  webrtc::RtpEncodingParameters result;
  result.active = enabled;
  result.max_bitrate_bps = static_cast<int>(peer_detail::Integer(data, "maxBitrateBps", 6000, 510000));
  return result;
}
inline bool DescriptionReceivesAudio(const webrtc::SessionDescriptionInterface& description, bool local) {
  for (const auto& content : description.description()->contents()) {
    const auto* media = content.media_description();
    if (content.rejected || media->type() != webrtc::MediaType::AUDIO) continue;
    const auto direction = media->direction();
    const bool receives = direction == webrtc::RtpTransceiverDirection::kSendRecv ||
        direction == (local ? webrtc::RtpTransceiverDirection::kRecvOnly
                            : webrtc::RtpTransceiverDirection::kSendOnly);
    if (receives) return true;
  }
  return false;
}
inline void RequireOutputForDescription(Host& host, const webrtc::SessionDescriptionInterface& description,
                                        bool local) {
  if (DescriptionReceivesAudio(description, local) && !host.AudioOutputReady())
    throw Error("ERR_RTC_AUDIO_OUTPUT_NOT_READY",
                "Configure the selected audio output before admitting remote screen audio", MONKY_ENGINE_CLOSED);
}

}  // namespace monky::native_rtc::engine::audio
