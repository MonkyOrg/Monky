#pragma once

#include "media_policy.h"
#include "stereo_checks.h"
#include "..\receiver_policy.h"

namespace monky::native_rtc::engine::audio {

// SDP parsing and policy arithmetic only: no factory, transport, track or device.
template <typename Check>
void RunAudioOperationalChecks(Check&& check) {
  RunStereoChecks(check);
  for (const bool before : {true, false}) {
    CheckOutputAdmission(false, false, before);
    CheckOutputAdmission(true, true, before);
    bool rejected = false;
    try { CheckOutputAdmission(true, false, before); }
    catch (const Error& error) {
      rejected = error.code == (before ? MONKY_ENGINE_AUDIO_PRE_ADMISSION :
                                       MONKY_ENGINE_AUDIO_DURING_ADMISSION) &&
                 error.status == (before ? MONKY_ENGINE_BUSY : MONKY_ENGINE_FAILURE);
    }
    check(rejected, "Audio admission confused retry-safe preflight with a committed RTC mutation");
  }
  {
    OutputEpoch gate;
    PlayoutSnapshot state;
    state.initialized = true;
    state.epoch = 31;
    gate.Begin(31);
    gate.Ready(31);
    unsigned mutations = 0;
    const auto admit = [&](std::uint64_t expected_epoch) {
      CheckOutputAdmission(true, state.HasOutputEpoch(expected_epoch) && gate.Accepts(state.epoch), true);
      ++mutations;
    };
    admit(31);
    check(!state.playing && mutations == 1,
          "Removing the last receiver incorrectly prevented admission to a configured output");
    gate.Invalidate(31);
    state.epoch = 0;
    bool pre = false;
    try { admit(31); }
    catch (const Error& error) { pre = error.code == MONKY_ENGINE_AUDIO_PRE_ADMISSION && error.status == 8; }
    check(pre && mutations == 1, "Explicit output retirement between JS preflight and admission mutated RTC");
    gate.Begin(32);
    gate.Ready(32);
    state.epoch = 32;
    bool replaced = false;
    try { admit(31); }
    catch (const Error& error) {
      replaced = error.code == MONKY_ENGINE_AUDIO_PRE_ADMISSION && error.status == 8;
    }
    check(replaced && mutations == 1 && gate.Accepts(32),
          "A ready replacement epoch admitted an old-epoch request or retired the replacement");
    admit(32);
    state.failed = true;
    gate.Invalidate(32);
    bool late = false;
    try { CheckOutputAdmission(true, state.HasOutputEpoch(32) && gate.Accepts(state.epoch), false); }
    catch (const Error& error) { late = error.code == MONKY_ENGINE_AUDIO_DURING_ADMISSION && error.status == 7; }
    check(late && mutations == 2, "Post-admission output failure was presented as safe SDP retry");
    gate.Begin(33);
    gate.Ready(33);
    state.epoch = 33;
    state.failed = false;
    bool late_replaced = false;
    try { CheckOutputAdmission(true, state.HasOutputEpoch(32) && gate.Accepts(state.epoch), false); }
    catch (const Error& error) {
      late_replaced = error.code == MONKY_ENGINE_AUDIO_DURING_ADMISSION && error.status == 7;
    }
    check(late_replaced && gate.Accepts(33) && mutations == 2,
          "A replacement hid post-admission failure or was retired by the old attempt");
  }
  const auto rejects = [&](auto&& action) {
    bool rejected = false;
    try { action(); } catch (const std::exception&) { rejected = true; }
    check(rejected, "Invalid audio integration policy was accepted");
  };
  check(ExpectedOutputEpoch(Json::object(), false) == 0,
        "Video/inactive SDP unexpectedly required an audio output epoch");
  check(ExpectedOutputEpoch(Json{{"expectedOutputEpoch", 31u}}, true) == 31,
        "Native admission did not preserve the caller's expected epoch");
  rejects([&] { (void)ExpectedOutputEpoch(Json::object(), true); });
  for (const Json& value : {Json(0), Json(-1), Json(1.5), Json("31"), Json(nullptr),
                          Json(9007199254740992ULL)}) {
    rejects([&] { (void)ExpectedOutputEpoch(Json{{"expectedOutputEpoch", value}}, true); });
  }
  for (const bool audio_receiver : {false, true}) {
    for (const bool enabled : {false, true}) {
      const bool required = audio_receiver && enabled;
      const Json gate{{"enabled", enabled}, {"expectedOutputEpoch", 41u}};
      check(ExpectedOutputEpoch(gate, required) == 41, "Receiver gate lost its explicitly prepared output epoch");
      if (required) rejects([&] { (void)ExpectedOutputEpoch(Json{{"enabled", enabled}}, required); });
      else check(ExpectedOutputEpoch(Json{{"enabled", enabled}}, required) == 0,
                 "Video or disabled audio gate unexpectedly required output preparation");
    }
  }
  check(peer_detail::StatsArray("").is_array() && peer_detail::StatsArray("").empty(),
        "Empty RTC report did not become a direct array");
  check(peer_detail::StatsArray(R"([{"id":"fixture","timestamp":1000000}])").front().at("timestamp") == 1000000,
        "Native stats acquired an envelope or changed microsecond units");
  rejects([&] { (void)peer_detail::StatsArray("{}"); });
  rejects([&] { (void)peer_detail::StatsArray("null"); });
  check(Volume(Json{{"volume", 0}}) == 0 && Volume(Json{{"volume", 2.0}}) == 2,
        "Audio gain lost the explicit mute/amplification bounds");
  rejects([&] { (void)Volume(Json{{"volume", -0.1}}); });
  rejects([&] { (void)Volume(Json{{"volume", 2.1}}); });
  rejects([&] { (void)Volume(Json{{"volume", "1"}}); });
  const auto encoding = Encoding(Json{{"maxBitrateBps", 128000}}, false);
  check(!encoding.active && encoding.max_bitrate_bps == 128000 && !encoding.max_framerate,
        "Audio encoding acquired video pacing or enabled itself");
  rejects([&] { (void)Encoding(Json{{"maxBitrateBps", 5999}}, false); });
  rejects([&] { (void)Encoding(Json{{"maxBitrateBps", 510001}}, false); });
  receiver_policy::Metadata metadata{"fixture-audio", "a0", {"fixture-G1"}, "audio"};
  receiver_policy::Receiver receiver(1, 2, metadata, true);
  check(!receiver.Effective(), "Fresh audio receiver was implicitly authorized");
  receiver.SetRequested(true);
  const auto old = receiver.Route();
  metadata.stream_ids = {"fixture-G2"};
  check(receiver.Bind(metadata, false) && !receiver.Effective() && !receiver.Accepts(old),
        "Audio MSID reassociation retained an old authorization epoch");
  receiver.SetRequested(true);
  receiver.Remove();
  check(!receiver.Effective(), "Removed audio receiver remained audible");
  metadata.kind = "data";
  rejects([&] { receiver.Bind(metadata, false); });

  const auto sdp = [](const std::string& direction, const std::string& codec = "opus/48000/2") {
    return "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n"
           "a=group:BUNDLE a0\r\na=msid-semantic: WMS fixture-G1\r\n"
           "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\nc=IN IP4 0.0.0.0\r\na=mid:a0\r\n"
           "a=rtcp-mux\r\na=" + direction + "\r\na=rtpmap:111 " + codec +
           "\r\na=msid:fixture-G1 fixture-track\r\n"
           "a=ssrc:1234 cname:fixture-cname\r\na=ssrc:1234 msid:fixture-G1 fixture-track\r\n";
  };
  for (const auto& direction : {"sendonly", "recvonly", "sendrecv", "inactive"}) {
    const auto description = peer_detail::ParseDescription(webrtc::SdpType::kOffer, sdp(direction), 64);
    const bool sends = std::string_view(direction) == "sendonly" || std::string_view(direction) == "sendrecv";
    const bool receives = std::string_view(direction) == "recvonly" || std::string_view(direction) == "sendrecv";
    check(DescriptionReceivesAudio(*description, false) == sends &&
          DescriptionReceivesAudio(*description, true) == receives,
          "Audio output requirement confused local and remote SDP directions");
  }
  rejects([&] { (void)peer_detail::ParseDescription(webrtc::SdpType::kOffer, sdp("sendonly", "PCMU/8000"), 64); });
  rejects([&] { (void)peer_detail::ParseDescription(webrtc::SdpType::kOffer, sdp("sendonly", "opus/48000/1"), 64); });
}

}  // namespace monky::native_rtc::engine::audio
