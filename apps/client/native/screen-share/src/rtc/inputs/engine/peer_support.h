#pragma once

#include "engine_shared.h"
#include "encoded_video.h"
#include "h264_bitstream.h"

#include "api\jsep.h"
#include "api\rtp_receiver_interface.h"
#include "api\rtp_sender_interface.h"
#include "api\rtp_transceiver_interface.h"
#include "api\set_local_description_observer_interface.h"
#include "api\set_remote_description_observer_interface.h"
#include "api\stats\rtc_stats_collector_callback.h"
#include "api\transport\bitrate_settings.h"
#include "api\video_codecs\sdp_video_format.h"
#include "rtc_send_diagnostics.h"
#include "rtc_receive_diagnostics.h"
#include "pc\session_description.h"
#include "rtc_base\logging.h"
#include "rtc_base\ref_counted_object.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <exception>
#include <future>
#include <initializer_list>
#include <mutex>
#include <optional>
#include <type_traits>
#include <utility>
#include <vector>

namespace monky::native_rtc::engine::peer_detail {

template <typename Accepts>
Json SelectScreenSendCodec(const Json& capabilities, Accepts accepts) {
  for (const auto& codec : capabilities.at("codecs")) {
    if (!codec.contains("mimeType") || !codec.at("mimeType").is_string()) continue;
    const auto mime = codec.at("mimeType").get<std::string>();
    const bool av1 = mime == "video/AV1" || mime == "video/av1";
    if (!av1 && mime != "video/H264" && mime != "video/h264") continue;
    webrtc::CodecParameterMap parameters;
    if (codec.contains("parameters")) {
      for (const auto& [key, value] : codec.at("parameters").items()) {
        if (value.is_string()) parameters[key] = value.get<std::string>();
        else if (value.is_number_integer()) parameters[key] = value.dump();
        else throw Error("ERR_RTC_ENCODED_FORMAT", "Invalid H264 router codec parameter", MONKY_ENGINE_INVALID);
      }
    }
    if (accepts(webrtc::SdpVideoFormat(av1 ? "AV1" : "H264", parameters))) return codec;
  }
  throw Error("ERR_RTC_ENCODED_FORMAT",
      "The SFU router cannot receive this screen's actual H264 Main profile and required level",
      MONKY_ENGINE_UNSUPPORTED);
}

constexpr std::size_t kMaxMediaSections = 64;
constexpr std::size_t kMaxCandidates = 256;

inline void CallbackFailure() noexcept {
  std::fputs("[monky-rtc] ERR_RTC_CALLBACK: native callback delivery failed; pending operations retain their deadlines.\n",
             stderr);
}

[[noreturn]] inline void Invalid(const char* message) {
  throw Error("ERR_RTC_ARGUMENT", message, MONKY_ENGINE_INVALID);
}

[[noreturn]] inline void Unsupported(const char* message) {
  throw Error("ERR_RTC_UNSUPPORTED", message, MONKY_ENGINE_UNSUPPORTED);
}

inline void PrivateRtcLogging() {
  // Even parse failures in upstream webrtc_sdp.cc print the offending SDP line.
  static std::once_flag initialized;
  std::call_once(initialized, [] {
    webrtc::LogMessage::LogToDebug(webrtc::LS_NONE);
    webrtc::LogMessage::SetLogToStderr(false);
  });
#if RTC_LOG_ENABLED()
  if (webrtc::LogMessage::GetLogToDebug() != webrtc::LS_NONE ||
      webrtc::LogMessage::GetLogToStream() < webrtc::LS_NONE)
    throw Error("ERR_RTC_LOGGING", "Raw RTC log sinks must be disabled for screen signaling");
#endif
}

inline void CheckActor(const Host& host) {
  if (!host.SignalingThread() || host.SignalingThread()->IsCurrent())
    throw Error("ERR_RTC_THREAD", "RTC operations must run on the control actor");
}

inline void CheckJson(const Json& data) {
  if (!data.is_object() || data.dump().size() > kMaxJson)
    Invalid("Expected an object of at most 1 MiB");
}

inline void Keys(const Json& data, std::initializer_list<std::string_view> allowed) {
  CheckJson(data);
  for (auto it = data.begin(); it != data.end(); ++it) {
    if (std::find(allowed.begin(), allowed.end(), it.key()) == allowed.end())
      Unsupported("An option is outside the screen-video contract");
  }
}

inline std::string Token(const Json& data, const char* key, std::size_t maximum = 256) {
  auto value = Text(data, key, maximum);
  if (std::any_of(value.begin(), value.end(), [](unsigned char c) {
        return c <= 32 || c >= 127;
      }))
    Invalid("Expected a bounded ASCII token without whitespace");
  return value;
}

inline std::uint64_t Integer(const Json& data, const char* key,
                             std::uint64_t minimum, std::uint64_t maximum) {
  if (!data.contains(key) || !data.at(key).is_number_integer())
    Invalid("Expected an integer");
  const auto& number = data.at(key);
  if (number.is_number_unsigned()) {
    const auto result = number.get<std::uint64_t>();
    if (result >= minimum && result <= maximum) return result;
  } else {
    const auto result = number.get<std::int64_t>();
    if (result >= 0 && static_cast<std::uint64_t>(result) >= minimum &&
        static_cast<std::uint64_t>(result) <= maximum)
      return static_cast<std::uint64_t>(result);
  }
  Invalid("Integer is outside its supported range");
}

inline webrtc::RtpEncodingParameters Encoding(const Json& data, bool enabled) {
  webrtc::RtpEncodingParameters result;
  result.active = enabled;
  result.max_bitrate_bps = static_cast<int>(Integer(
      data, "maxBitrateBps", 64000, kEncodedBitrateCeiling));
  if (!data.contains("maxFramerate") || !data.at("maxFramerate").is_number())
    Invalid("maxFramerate is required");
  const double fps = data.at("maxFramerate").get<double>();
  if (!std::isfinite(fps) || fps < 1 || fps > 240)
    Invalid("maxFramerate must be between 1 and 240");
  result.max_framerate = fps;
  return result;
}

inline Json SfuVideoCodecOptions(const webrtc::RtpEncodingParameters& encoding) {
  if (!encoding.max_bitrate_bps || *encoding.max_bitrate_bps < 64000 ||
      *encoding.max_bitrate_bps > static_cast<int>(kEncodedBitrateCeiling))
    Invalid("SFU video requires its validated bitrate ceiling");
  const auto maximum_kbps = *encoding.max_bitrate_bps / 1000;
  // Match the native P2P startup estimate without forcing a congestion-control floor.
  return {{"videoGoogleStartBitrate", (std::min)(5000, maximum_kbps)},
          {"videoGoogleMaxBitrate", maximum_kbps}};
}

inline void CheckIceUrl(const std::string& url) {
  if (url.empty() || url.size() > 2048 ||
      std::any_of(url.begin(), url.end(), [](unsigned char c) { return c <= 32 || c >= 127; }) ||
      url.find_first_of("/\\@#") != std::string::npos)
    Invalid("Invalid ICE server URL");
  const auto colon = url.find(':');
  const auto scheme = url.substr(0, colon);
  if (colon == std::string::npos ||
      (scheme != "stun" && scheme != "stuns" && scheme != "turn" && scheme != "turns"))
    Invalid("ICE servers require stun, stuns, turn or turns URLs");
  const auto query = url.find('?', colon + 1);
  const auto authority = url.substr(colon + 1, query == std::string::npos ? query : query - colon - 1);
  if (authority.empty() || authority.size() > 320) Invalid("Invalid ICE server address");
  if (query != std::string::npos) {
    const auto parameters = url.substr(query + 1);
    if ((scheme != "turn" && scheme != "turns") ||
        (parameters != "transport=udp" && parameters != "transport=tcp"))
      Invalid("Unsupported ICE URL parameters");
  }
}

inline webrtc::PeerConnectionInterface::RTCConfiguration Configuration(const Json& data) {
  webrtc::PeerConnectionInterface::RTCConfiguration config;
  config.sdp_semantics = webrtc::SdpSemantics::kUnifiedPlan;
  config.bundle_policy = webrtc::PeerConnectionInterface::kBundlePolicyMaxBundle;
  config.rtcp_mux_policy = webrtc::PeerConnectionInterface::kRtcpMuxPolicyRequire;
  if (!data.contains("iceServers")) return config;
  const auto& servers = data.at("iceServers");
  if (!servers.is_array() || servers.size() > 16) Invalid("Too many ICE servers");
  std::size_t url_count = 0;
  for (const auto& input : servers) {
    Keys(input, {"urls", "username", "credential"});
    if (!input.contains("urls") || !input.at("urls").is_array() ||
        input.at("urls").empty() || input.at("urls").size() > 8)
      Invalid("ICE server urls must be a nonempty bounded array");
    webrtc::PeerConnectionInterface::IceServer server;
    for (const auto& item : input.at("urls")) {
      if (!item.is_string() || ++url_count > 32) Invalid("Invalid ICE URL list");
      auto url = item.get<std::string>();
      CheckIceUrl(url);
      server.urls.push_back(std::move(url));
    }
    if (input.contains("username")) server.username = Text(input, "username", 512);
    if (input.contains("credential")) server.password = Text(input, "credential", 512);
    config.servers.push_back(std::move(server));
  }
  return config;
}

inline void RtcOk(const webrtc::RTCError& error, const char* operation) {
  // Native error text can contain remote SDP, ICE passwords or addresses.
  if (!error.ok()) throw Error("ERR_RTC_NATIVE", operation);
}

template <typename T>
struct Completion {
  std::promise<T> promise;
  std::atomic<bool> settled{false};
  void Resolve(T value) noexcept {
    if (settled.exchange(true)) return;
    try { promise.set_value(std::move(value)); } catch (...) { CallbackFailure(); }
  }
  void Reject(std::exception_ptr error) noexcept {
    if (settled.exchange(true)) return;
    try { promise.set_exception(std::move(error)); } catch (...) { CallbackFailure(); }
  }
};

template <>
struct Completion<void> {
  std::promise<void> promise;
  std::atomic<bool> settled{false};
  void Resolve() noexcept {
    if (settled.exchange(true)) return;
    try { promise.set_value(); } catch (...) { CallbackFailure(); }
  }
  void Reject(std::exception_ptr error) noexcept {
    if (settled.exchange(true)) return;
    try { promise.set_exception(std::move(error)); } catch (...) { CallbackFailure(); }
  }
};

template <typename T>
T Wait(Host& host, const std::shared_ptr<Cancellation>& cancellation, std::future<T>& future) {
  CheckActor(host);
  const auto deadline = (std::min)(cancellation->deadline,
                                  std::chrono::steady_clock::now() + host.Timeout());
  for (;;) {
    cancellation->Check();
    const auto remaining = deadline - std::chrono::steady_clock::now();
    if (remaining <= std::chrono::steady_clock::duration::zero())
      throw Error("ERR_RTC_TIMEOUT", "RTC callback deadline expired", MONKY_ENGINE_TIMEOUT);
    if (future.wait_for((std::min)(remaining,
          std::chrono::steady_clock::duration(std::chrono::milliseconds(10)))) ==
        std::future_status::ready)
      break;
  }
  cancellation->Check();
  if constexpr (std::is_void_v<T>) {
    future.get();
    cancellation->Check();
  } else {
    auto result = future.get();
    cancellation->Check();
    return result;
  }
}

inline std::shared_ptr<Cancellation> CleanupCancellation(Host& host, std::uint64_t target = 0) {
  auto cancellation = std::make_shared<Cancellation>();
  cancellation->target = target;
  cancellation->deadline = std::chrono::steady_clock::now() + host.Timeout();
  return cancellation;
}

class CreateDescriptionObserver : public webrtc::CreateSessionDescriptionObserver {
 public:
  explicit CreateDescriptionObserver(std::shared_ptr<Completion<std::string>> completion)
      : completion_(std::move(completion)) {}
  void OnSuccess(webrtc::SessionDescriptionInterface* raw) override {
    std::unique_ptr<webrtc::SessionDescriptionInterface> description(raw);
    try {
      std::string sdp;
      if (!description || !description->ToString(&sdp) || sdp.empty() || sdp.size() > kMaxJson)
        throw Error("ERR_RTC_SDP", "RTC returned an invalid or oversized SDP");
      completion_->Resolve(std::move(sdp));
    } catch (...) { completion_->Reject(std::current_exception()); }
  }
  void OnFailure(webrtc::RTCError) override {
    try { throw Error("ERR_RTC_SDP", "RTC could not create SDP"); }
    catch (...) { completion_->Reject(std::current_exception()); }
  }
 private:
  std::shared_ptr<Completion<std::string>> completion_;
};

class LocalDescriptionObserver : public webrtc::SetLocalDescriptionObserverInterface {
 public:
  explicit LocalDescriptionObserver(std::shared_ptr<Completion<void>> completion)
      : completion_(std::move(completion)) {}
  void OnSetLocalDescriptionComplete(webrtc::RTCError error) override {
    try {
      RtcOk(error, "RTC rejected the local description");
      completion_->Resolve();
    } catch (...) { completion_->Reject(std::current_exception()); }
  }
 private:
  std::shared_ptr<Completion<void>> completion_;
};

class RemoteDescriptionObserver : public webrtc::SetRemoteDescriptionObserverInterface {
 public:
  explicit RemoteDescriptionObserver(std::shared_ptr<Completion<void>> completion)
      : completion_(std::move(completion)) {}
  void OnSetRemoteDescriptionComplete(webrtc::RTCError error) override {
    try {
      RtcOk(error, "RTC rejected the remote description");
      completion_->Resolve();
    } catch (...) { completion_->Reject(std::current_exception()); }
  }
 private:
  std::shared_ptr<Completion<void>> completion_;
};

class StatsObserver : public webrtc::RTCStatsCollectorCallback {
 public:
  explicit StatsObserver(std::shared_ptr<Completion<RtcStatsObservation>> completion)
      : completion_(std::move(completion)) {}
  void OnStatsDelivered(const webrtc::scoped_refptr<const webrtc::RTCStatsReport>& report) override {
    try {
      if (!report) throw Error("ERR_RTC_STATS", "RTC returned no stats report");
      auto text = report->ToJson();
      if (text.size() > kMaxJson) throw Error("ERR_RTC_LIMIT", "RTC stats exceed 1 MiB");
      completion_->Resolve(RtcStatsObservation{std::move(text), ObserveRtcSendStreamDrops(*report),
                                              ObserveRtcReceiveStreamDiagnostics(*report)});
    } catch (...) { completion_->Reject(std::current_exception()); }
  }
 private:
  std::shared_ptr<Completion<RtcStatsObservation>> completion_;
};

inline std::unique_ptr<webrtc::SessionDescriptionInterface> ParseDescription(
    webrtc::SdpType type, const std::string& sdp, std::size_t media_limit = kMaxMediaSections) {
  if (type != webrtc::SdpType::kOffer && type != webrtc::SdpType::kAnswer)
    Invalid("Only offer and answer descriptions are supported");
  if (sdp.empty() || sdp.size() > kMaxJson || sdp.find('\0') != std::string::npos)
    Invalid("SDP must be nonempty and at most 1 MiB");
  std::size_t candidates = 0;
  for (std::size_t begin = 0; begin < sdp.size();) {
    const auto end = sdp.find('\n', begin);
    const std::string_view line(sdp.data() + begin,
        end == std::string::npos ? sdp.size() - begin : end - begin);
    if (line.starts_with("a=simulcast:") || line.starts_with("a=rid:") ||
        line.starts_with("a=ssrc-group:SIM "))
      Unsupported("Simulcast and SVC are not supported by this engine");
    if (line.starts_with("a=candidate:") && (++candidates > kMaxCandidates || line.size() > 4096))
      Invalid("Too many or oversized SDP ICE candidates");
    if (end == std::string::npos) break;
    begin = end + 1;
  }
  webrtc::SdpParseError parse_error;
  auto description = webrtc::CreateSessionDescription(type, sdp, &parse_error);
  if (!description || !description->description())
    Invalid("RTC could not parse the SDP");
  const auto& contents = description->description()->contents();
  if (contents.size() > (std::min)(media_limit, kMaxMediaSections))
    Invalid("SDP has too many media sections");
  std::size_t parsed_candidates = 0;
  for (std::size_t index = 0; index < contents.size(); ++index) {
    const auto& content = contents[index];
    if (content.mid().size() > 256) Invalid("SDP MID is too long");
    const auto* media = content.media_description();
    if (!media) Invalid("SDP has no media description");
    if (!content.rejected && media->direction() != webrtc::RtpTransceiverDirection::kInactive) {
      if (media->type() == webrtc::MediaType::AUDIO) {
        const auto* audio = media->as_audio();
        if (!audio || audio->codecs().empty()) Unsupported("Audio SDP requires Opus");
        for (const auto& codec : audio->codecs())
          if ((codec.name != "opus" && codec.name != "OPUS") || codec.clockrate != 48000 ||
              codec.channels != 2)
            Unsupported("Only Opus 48kHz/2 screen-audio SDP is supported");
      } else if (media->type() != webrtc::MediaType::VIDEO) {
        Unsupported("Data SDP is not supported by the screen engine");
      }
    }
    if (const auto* collection = description->candidates(index)) {
      parsed_candidates += collection->count();
      if (parsed_candidates > kMaxCandidates) Invalid("Too many SDP ICE candidates");
      for (const auto& candidate : collection->candidates()) {
        if (!candidate || (candidate->candidate().protocol() != "udp" &&
                           candidate->candidate().protocol() != "tcp") ||
            candidate->ToString().size() > 4096)
          Invalid("SDP contains an invalid UDP/TCP ICE candidate");
      }
    }
  }
  return description;
}

inline std::string CreateDescription(Host& host, webrtc::PeerConnectionInterface& pc,
    bool offer, const webrtc::PeerConnectionInterface::RTCOfferAnswerOptions& options,
    const std::shared_ptr<Cancellation>& cancellation) {
  cancellation->Check();
  auto completion = std::make_shared<Completion<std::string>>();
  auto future = completion->promise.get_future();
  webrtc::scoped_refptr<CreateDescriptionObserver> observer(
      new webrtc::RefCountedObject<CreateDescriptionObserver>(completion));
  if (offer) pc.CreateOffer(observer.get(), options);
  else pc.CreateAnswer(observer.get(), options);
  return Wait(host, cancellation, future);
}

inline void SetDescription(Host& host, webrtc::PeerConnectionInterface& pc, bool local,
    std::unique_ptr<webrtc::SessionDescriptionInterface> description,
    const std::shared_ptr<Cancellation>& cancellation) {
  cancellation->Check();
  auto completion = std::make_shared<Completion<void>>();
  auto future = completion->promise.get_future();
  if (local) {
    webrtc::scoped_refptr<LocalDescriptionObserver> observer(
        new webrtc::RefCountedObject<LocalDescriptionObserver>(completion));
    pc.SetLocalDescription(std::move(description), observer);
  } else {
    webrtc::scoped_refptr<RemoteDescriptionObserver> observer(
        new webrtc::RefCountedObject<RemoteDescriptionObserver>(completion));
    pc.SetRemoteDescription(std::move(description), observer);
  }
  Wait(host, cancellation, future);
}

inline Json StatsArray(const std::string& text) {
  if (text.size() > kMaxJson) throw Error("ERR_RTC_STATS", "RTC stats exceed their byte bound");
  auto result = text.empty() ? Json::array() : Json::parse(text);
  if (!result.is_array()) throw Error("ERR_RTC_STATS", "RTC stats must be a top-level array");
  return result;
}

inline Json Stats(Host& host, webrtc::PeerConnectionInterface& pc,
    const std::shared_ptr<Cancellation>& cancellation,
    webrtc::scoped_refptr<webrtc::RtpSenderInterface> sender = nullptr,
    webrtc::scoped_refptr<webrtc::RtpReceiverInterface> receiver = nullptr,
    Json* send_stream_drops = nullptr, Json* receive_stream_diagnostics = nullptr) {
  if (receive_stream_diagnostics) *receive_stream_diagnostics = nullptr;
  cancellation->Check();
  auto completion = std::make_shared<Completion<RtcStatsObservation>>();
  auto future = completion->promise.get_future();
  webrtc::scoped_refptr<StatsObserver> observer(
      new webrtc::RefCountedObject<StatsObserver>(completion));
  if (sender) pc.GetStats(std::move(sender), observer);
  else if (receiver) pc.GetStats(std::move(receiver), observer);
  else pc.GetStats(observer.get());
  auto observation = Wait(host, cancellation, future);
  auto result = StatsArray(observation.json);
  cancellation->Check();
  if (send_stream_drops) *send_stream_drops = std::move(observation.send_stream_drops);
  if (receive_stream_diagnostics)
    *receive_stream_diagnostics = std::move(observation.receive_stream_diagnostics);
  return result;
}

inline void GateSender(webrtc::RtpSenderInterface& sender, bool enabled) {
  if (sender.media_type() != webrtc::MediaType::VIDEO && sender.media_type() != webrtc::MediaType::AUDIO)
    Unsupported("Only screen media senders can be gated");
  auto parameters = sender.GetParameters();
  if (parameters.encodings.size() != 1)
    Unsupported("The screen-video sender must have exactly one encoding");
  auto& encoding = parameters.encodings.front();
  if (encoding.scalability_mode && *encoding.scalability_mode != "L1T1")
    Unsupported("SVC is not supported by the screen-video engine");
  encoding.active = enabled;
  RtcOk(sender.SetParameters(parameters), "RTC could not change the sender encoding");
}

inline webrtc::BitrateSettings StartupBitrate(const Json& data) {
  Keys(data, {"startBitrateBps", "maxBitrateBps"});
  const auto start = Id(data, "startBitrateBps"), maximum = Id(data, "maxBitrateBps");
  if (start < 150000 || start > maximum || maximum > kEncodedBitrateCeiling)
    Invalid("Startup bitrate must satisfy150000 <= start <= max <=80000000");
  webrtc::BitrateSettings result;
  result.start_bitrate_bps = static_cast<int>(start);
  result.max_bitrate_bps = static_cast<int>(maximum);
  return result;
}

inline std::uint32_t VideoPlayoutDelayMs(const Json& data) {
  Keys(data, {"minimumDelayMs"});
  if (!data.contains("minimumDelayMs") || !data.at("minimumDelayMs").is_number_unsigned() ||
      data.at("minimumDelayMs").get<std::uint64_t>() > 1000)
    Invalid("Video minimum playout delay must be an integer from0 to1000ms");
  return data.at("minimumDelayMs").get<std::uint32_t>();
}

// The mutex drains an in-flight Host call before Disable/Detach returns.
class FrameSink : public webrtc::VideoSinkInterface<webrtc::VideoFrame> {
 public:
  FrameSink(Host& host, std::uint64_t target) : FrameSink(host, FrameRoute{target, 0, 0}) {}
  FrameSink(Host& host, FrameRoute route) : host_(&host), route_(route) {}
  const FrameRoute& Route() const noexcept { return route_; }
  void OnFrame(const webrtc::VideoFrame& frame) noexcept override {
    try {
      std::lock_guard lock(mutex_);
      if (host_ && enabled_) host_->ReceiveFrame(route_, frame);
    } catch (...) { CallbackFailure(); }
  }
  void Enable(bool enabled) {
    std::lock_guard lock(mutex_);
    enabled_ = enabled;
  }
  void Detach() {
    std::lock_guard lock(mutex_);
    enabled_ = false;
    host_ = nullptr;
  }
 private:
  std::mutex mutex_;
  Host* host_;
  const FrameRoute route_;
  bool enabled_ = false;
};

inline bool Cancelled(const std::exception_ptr& error) {
  try { std::rethrow_exception(error); }
  catch (const Error& failure) {
    return failure.status == MONKY_ENGINE_CANCELLED || failure.status == MONKY_ENGINE_TIMEOUT;
  } catch (...) { return false; }
}

}  // namespace monky::native_rtc::engine::peer_detail
