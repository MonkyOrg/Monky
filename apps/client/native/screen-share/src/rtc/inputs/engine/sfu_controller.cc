#include "peer_support.h"
#include "transport_parameters.h"
#include "audio\media_policy.h"

#include "Device.hpp"
#include "PeerConnection.hpp"
#include "ortc.hpp"

#define MSC_CLASS "MonkyRtcEngine"
#include "Logger.hpp"

#include "api\data_channel_interface.h"
#include "api\sctp_transport_interface.h"

#include <cctype>
#include <map>
#include <set>

namespace monky::native_rtc::engine::sfu_detail {

using namespace peer_detail;

struct Call;
thread_local Call* current_call = nullptr;

enum class StatsSelection { kPeerConnection, kSender, kReceiver };

struct StatsDiagnostics {
  Json send_stream_drops = nullptr;
  Json receive_stream_diagnostics = nullptr;
};

struct Call {
  Host& host;
  std::shared_ptr<Cancellation> cancellation;
  const mediasoupclient::PeerConnection::Options* options;
  bool capability_probe;
  std::string_view sync_group;
  std::exception_ptr listener_failure;
  Call* previous;
  StatsDiagnostics stats_diagnostics;
  std::optional<StatsSelection> stats_selection;

  Call(Host& host, std::shared_ptr<Cancellation> cancellation,
       const mediasoupclient::PeerConnection::Options* options, bool capability_probe = false,
       std::string_view sync_group = {})
      : host(host), cancellation(std::move(cancellation)), options(options),
        capability_probe(capability_probe), sync_group(sync_group), previous(current_call) {
    CheckActor(host);
    current_call = this;
  }
  ~Call() { current_call = previous; }
  Call(const Call&) = delete;
  Call& operator=(const Call&) = delete;
};

Call& Context() {
  if (!current_call) throw Error("ERR_RTC_THREAD", "SFU call has no control-actor context");
  CheckActor(current_call->host);
  current_call->cancellation->Check();
  return *current_call;
}

template <typename Function>
auto WithPc(webrtc::PeerConnectionInterface& pc, Function&& function) {
  auto& context = Context();
  try {
    if constexpr (std::is_void_v<std::invoke_result_t<Function, Call&>>) {
      function(context);
      context.cancellation->Check();
    } else {
      auto result = function(context);
      context.cancellation->Check();
      return result;
    }
  } catch (...) {
    // SDP callbacks can still arrive after a timeout; no old PC is reused.
    if (Cancelled(std::current_exception())) pc.Close();
    throw;
  }
}

std::string Lower(std::string value) {
  for (auto& c : value) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return value;
}

void BoundedStrings(const Json& value, unsigned depth = 0) {
  if (depth > 32) Invalid("SFU JSON nesting is too deep");
  if (value.is_string()) {
    const auto& text = value.get_ref<const std::string&>();
    if (text.size() > 65536 || std::any_of(text.begin(), text.end(),
        [](unsigned char c) { return c < 32 || c == 127; }))
      Invalid("SFU strings must be bounded and contain no control characters");
  } else if (value.is_object() || value.is_array()) {
    if (value.size() > 4096) Invalid("SFU JSON collection is too large");
    for (auto it = value.begin(); it != value.end(); ++it) {
      if (value.is_object()) {
        const auto& key = it.key();
        if (key.size() > 256 || std::any_of(key.begin(), key.end(),
            [](unsigned char c) { return c < 32 || c == 127; }))
          Invalid("Invalid SFU JSON object key");
      }
      BoundedStrings(it.value(), depth + 1);
    }
  }
}

Json Object(const Json& data, const char* key) {
  if (!data.contains(key) || !data.at(key).is_object()) Invalid("Missing SFU object");
  auto value = data.at(key);
  CheckJson(value);
  BoundedStrings(value);
  return value;
}

void IceParameters(Json& parameters) {
  Keys(parameters, {"usernameFragment", "password", "iceLite"});
  const auto username = Token(parameters, "usernameFragment", 256);
  const auto password = Token(parameters, "password", 256);
  if (username.size() < 4 || password.size() < 22)
    Invalid("ICE credentials are below their required minimum lengths");
  if (parameters.contains("iceLite")) (void)Boolean(parameters, "iceLite");
  mediasoupclient::ortc::validateIceParameters(parameters);
}

Json ScreenCapabilities(Json capabilities) {
  CheckJson(capabilities);
  BoundedStrings(capabilities);
  Json codecs = Json::array(), extensions = Json::array();
  if (!capabilities.contains("codecs") || !capabilities.at("codecs").is_array() ||
      capabilities.at("codecs").size() > 64)
    Invalid("Invalid router codec capabilities");
  for (const auto& codec : capabilities.at("codecs")) {
    const auto mime = Lower(Token(codec, "mimeType", 128));
    if (mime.starts_with("video/") || (mime == "audio/opus" &&
        Integer(codec, "clockRate", 1, 1000000) == 48000 &&
        Integer(codec, "channels", 1, 2) == 2)) {
      (void)Integer(codec, "clockRate", 1, 1000000);
      if (codec.contains("preferredPayloadType"))
        (void)Integer(codec, "preferredPayloadType", 0, 127);
      codecs.push_back(codec);
    }
    else if (!mime.starts_with("audio/")) Invalid("Invalid RTP codec kind");
  }
  if (capabilities.contains("headerExtensions")) {
    const auto& input = capabilities.at("headerExtensions");
    if (!input.is_array() || input.size() > 64) Invalid("Invalid RTP header extensions");
    for (auto extension : input) {
      if (!extension.is_object()) Invalid("Invalid RTP header extension");
      std::string kind;
      if (extension.contains("kind")) {
        if (!extension.at("kind").is_string()) Invalid("Invalid RTP header extension kind");
        kind = extension.at("kind").get<std::string>();
        if (kind != "video" && kind != "audio" && !kind.empty()) Invalid("Unsupported RTP extension kind");
      }
      if (kind.empty()) {
        extension["kind"] = "audio";
        extensions.push_back(extension);
        kind = "video";
      }
      extension["kind"] = kind;
      extensions.push_back(std::move(extension));
    }
  }
  Json filtered{{"codecs", std::move(codecs)}, {"headerExtensions", std::move(extensions)}};
  mediasoupclient::ortc::validateRtpCapabilities(filtered);
  return filtered;
}

void ScreenParameters(Json& parameters, std::string_view kind) {
  if (kind != "video" && kind != "audio") Unsupported("Unsupported screen media kind");
  CheckJson(parameters);
  BoundedStrings(parameters);
  if (!parameters.contains("codecs") || !parameters.at("codecs").is_array() ||
      parameters.at("codecs").empty() || parameters.at("codecs").size() > 32)
    Invalid("Invalid video RTP codecs");
  for (const auto& codec : parameters.at("codecs")) {
    const auto mime = Lower(Token(codec, "mimeType", 128));
    if (kind == "video" && !mime.starts_with("video/"))
      Unsupported("Video RTP parameters must contain video codecs");
    if (kind == "audio" && (mime != "audio/opus" ||
        Integer(codec, "clockRate", 1, 1000000) != 48000 || Integer(codec, "channels", 1, 2) != 2))
      Unsupported("Audio RTP parameters require Opus 48kHz/2");
    (void)Integer(codec, "payloadType", 0, 127);
    (void)Integer(codec, "clockRate", 1, 1000000);
    if (codec.contains("parameters") && codec.at("parameters").is_object() &&
        codec.at("parameters").contains("apt"))
      (void)Integer(codec.at("parameters"), "apt", 0, 127);
  }
  if (!parameters.contains("encodings") || !parameters.at("encodings").is_array() ||
      parameters.at("encodings").size() != 1)
    Unsupported("Exactly one non-simulcast RTP encoding is required");
  const auto& encoding = parameters.at("encodings").front();
  if (!encoding.is_object()) Invalid("Invalid RTP encoding");
  (void)Integer(encoding, "ssrc", 1, 4294967295ull);
  if (encoding.contains("rtx")) {
    if (!encoding.at("rtx").is_object()) Invalid("Invalid RTX encoding");
    (void)Integer(encoding.at("rtx"), "ssrc", 1, 4294967295ull);
  }
  if (encoding.contains("rid") ||
      (encoding.contains("scalabilityMode") && encoding.at("scalabilityMode") != "L1T1"))
    Unsupported("Simulcast and SVC are not supported");
  if (parameters.contains("mid")) (void)Token(parameters, "mid", 64);
  if (parameters.contains("headerExtensions")) {
    const auto& extensions = parameters.at("headerExtensions");
    if (!extensions.is_array() || extensions.size() > 32) Invalid("Too many RTP header extensions");
    for (const auto& extension : extensions) {
      (void)Token(extension, "uri", 512);
      (void)Integer(extension, "id", 1, 255);
    }
  }
  mediasoupclient::ortc::validateRtpParameters(parameters);
  if (!parameters.at("rtcp").contains("cname"))
    Invalid("A screen RTP synchronization CNAME is required");
  (void)Token(parameters.at("rtcp"), "cname", 256);
}

std::string AppData(const Json& app_data, std::string_view kind) {
  Keys(app_data, {"mediaType", "syncGroup"});
  if ((kind != "video" && kind != "audio") ||
      Text(app_data, "mediaType", 32) != (kind == "audio" ? "screen_audio" : "screen_video"))
    Unsupported("Screen appData must match the media kind");
  return SyncGroup(app_data);
}

void Ack(const Json& response) {
  if (!response.is_object() || response.dump().size() > kMaxJson)
    throw Error("ERR_RTC_SERVER_RESPONSE", "Server acknowledgement must be an object");
}

}  // namespace monky::native_rtc::engine::sfu_detail

// Engine-owned implementation of the pinned PeerConnection.hpp boundary.
// The engine GN target must NOT also compile upstream src/PeerConnection.cpp:
// that implementation uses unbounded waits and may create a default ADM/factory.
namespace mediasoupclient {
namespace {
namespace engine = monky::native_rtc::engine;
namespace detail = engine::peer_detail;
namespace sfu = engine::sfu_detail;
using Pc = webrtc::PeerConnectionInterface;
}

std::map<webrtc::SdpType, const webrtc::SdpType> PeerConnection::sdpType2webRtcSdpType{
    {webrtc::SdpType::kOffer, webrtc::SdpType::kOffer},
    {webrtc::SdpType::kPrAnswer, webrtc::SdpType::kPrAnswer},
    {webrtc::SdpType::kAnswer, webrtc::SdpType::kAnswer}};
std::map<Pc::IceConnectionState, const std::string> PeerConnection::iceConnectionState2String{
    {Pc::kIceConnectionNew, "new"}, {Pc::kIceConnectionChecking, "checking"},
    {Pc::kIceConnectionConnected, "connected"}, {Pc::kIceConnectionCompleted, "completed"},
    {Pc::kIceConnectionFailed, "failed"}, {Pc::kIceConnectionDisconnected, "disconnected"},
    {Pc::kIceConnectionClosed, "closed"}};
std::map<Pc::IceGatheringState, const std::string> PeerConnection::iceGatheringState2String{
    {Pc::kIceGatheringNew, "new"}, {Pc::kIceGatheringGathering, "gathering"},
    {Pc::kIceGatheringComplete, "complete"}};
std::map<Pc::SignalingState, const std::string> PeerConnection::signalingState2String{
    {Pc::kStable, "stable"}, {Pc::kHaveLocalOffer, "have-local-offer"},
    {Pc::kHaveLocalPrAnswer, "have-local-pranswer"}, {Pc::kHaveRemoteOffer, "have-remote-offer"},
    {Pc::kHaveRemotePrAnswer, "have-remote-pranswer"}, {Pc::kClosed, "closed"}};

PeerConnection::PeerConnection(PrivateListener* listener, const Options* options) {
  auto& context = sfu::Context();
  if (!listener || !options || options != context.options || !options->factory ||
      options->factory != context.host.Factory().get() ||
      options->config.sdp_semantics != webrtc::SdpSemantics::kUnifiedPlan)
    throw engine::Error("ERR_RTC_FACTORY", "SFU requires the engine's persistent factory options");
  peerConnectionFactory = webrtc::scoped_refptr<webrtc::PeerConnectionFactoryInterface>(options->factory);
  auto result = peerConnectionFactory->CreatePeerConnectionOrError(
      options->config, webrtc::PeerConnectionDependencies(listener));
  detail::RtcOk(result.error(), "RTC could not create the SFU peer connection");
  pc = result.MoveValue();
  if (!pc) throw engine::Error("ERR_RTC_NATIVE", "RTC returned no SFU peer connection");
  try { context.cancellation->Check(); }
  catch (...) {
    pc->Close();
    pc = nullptr;
    throw;
  }
}

void PeerConnection::Close() { if (pc) pc->Close(); }
Pc::RTCConfiguration PeerConnection::GetConfiguration() const { return pc->GetConfiguration(); }
bool PeerConnection::SetConfiguration(const Pc::RTCConfiguration& configuration) {
  return sfu::WithPc(*pc, [&](sfu::Call&) {
    if (configuration.sdp_semantics != webrtc::SdpSemantics::kUnifiedPlan)
      detail::Unsupported("SFU requires Unified Plan");
    for (const auto& server : configuration.servers) {
      if (!server.uri.empty()) detail::CheckIceUrl(server.uri);
      for (const auto& url : server.urls) detail::CheckIceUrl(url);
    }
    detail::RtcOk(pc->SetConfiguration(configuration), "RTC rejected the SFU configuration");
    return true;
  });
}
std::string PeerConnection::CreateOffer(const Pc::RTCOfferAnswerOptions& options) {
  return sfu::WithPc(*pc, [&](sfu::Call& context) {
    return detail::CreateDescription(context.host, *pc, true, options, context.cancellation);
  });
}
std::string PeerConnection::CreateAnswer(const Pc::RTCOfferAnswerOptions& options) {
  return sfu::WithPc(*pc, [&](sfu::Call& context) {
    return detail::CreateDescription(context.host, *pc, false, options, context.cancellation);
  });
}
void PeerConnection::SetLocalDescription(webrtc::SdpType type, const std::string& sdp) {
  sfu::WithPc(*pc, [&](sfu::Call& context) {
    auto description = detail::ParseDescription(type, sdp, context.host.MaxResources());
    engine::audio::RequireOutputForDescription(context.host, *description, true);
    detail::SetDescription(context.host, *pc, true, std::move(description), context.cancellation);
  });
}
void PeerConnection::SetRemoteDescription(webrtc::SdpType type, const std::string& sdp) {
  sfu::WithPc(*pc, [&](sfu::Call& context) {
    auto description = detail::ParseDescription(type, sdp, context.host.MaxResources());
    engine::audio::RequireOutputForDescription(context.host, *description, false);
    detail::SetDescription(context.host, *pc, false, std::move(description), context.cancellation);
  });
}
std::string PeerConnection::GetLocalDescription() {
  return sfu::WithPc(*pc, [&](sfu::Call& context) {
    std::string sdp;
    std::exception_ptr failure;
    context.host.SignalingThread()->BlockingCall([&] {
      try {
        const auto* description = pc->local_description();
        if (!description || !description->ToString(&sdp) || sdp.size() > engine::kMaxJson)
          throw engine::Error("ERR_RTC_SDP", "SFU local description is unavailable or oversized");
      } catch (...) { failure = std::current_exception(); }
    });
    if (failure) std::rethrow_exception(failure);
    return sdp;
  });
}
std::string PeerConnection::GetRemoteDescription() {
  return sfu::WithPc(*pc, [&](sfu::Call& context) {
    std::string sdp;
    std::exception_ptr failure;
    context.host.SignalingThread()->BlockingCall([&] {
      try {
        const auto* description = pc->remote_description();
        if (!description || !description->ToString(&sdp) || sdp.size() > engine::kMaxJson)
          throw engine::Error("ERR_RTC_SDP", "SFU remote description is unavailable or oversized");
      } catch (...) { failure = std::current_exception(); }
    });
    if (failure) std::rethrow_exception(failure);
    return sdp;
  });
}
std::vector<webrtc::scoped_refptr<webrtc::RtpTransceiverInterface>>
PeerConnection::GetTransceivers() const { return pc->GetTransceivers(); }

webrtc::scoped_refptr<webrtc::RtpTransceiverInterface> PeerConnection::AddTransceiver(
    webrtc::MediaType kind) {
  return sfu::WithPc(*pc, [&](sfu::Call& context) {
    webrtc::RtpTransceiverInit init;
    init.direction = webrtc::RtpTransceiverDirection::kRecvOnly;
    if (kind == webrtc::MediaType::AUDIO && context.capability_probe)
      init.direction = webrtc::RtpTransceiverDirection::kInactive;
    else if (kind != webrtc::MediaType::VIDEO)
      detail::Unsupported("SFU audio/data transceivers are unavailable");
    auto result = pc->AddTransceiver(kind, init);
    detail::RtcOk(result.error(), "RTC could not add the SFU capability transceiver");
    auto transceiver = result.MoveValue();
    if (kind == webrtc::MediaType::AUDIO) engine::audio::PreferOpus(context.host, *transceiver);
    return transceiver;
  });
}
webrtc::scoped_refptr<webrtc::RtpTransceiverInterface> PeerConnection::AddTransceiver(
    webrtc::scoped_refptr<webrtc::MediaStreamTrackInterface> track, webrtc::RtpTransceiverInit init) {
  return sfu::WithPc(*pc, [&](sfu::Call& context) {
    if (!track || (track->kind() != webrtc::MediaStreamTrackInterface::kVideoKind &&
                   track->kind() != webrtc::MediaStreamTrackInterface::kAudioKind) ||
        init.send_encodings.size() != 1)
      detail::Unsupported("SFU requires a single screen media encoding");
    if (pc->GetTransceivers().size() >= (std::min)(
        std::size_t(context.host.MaxResources()), detail::kMaxMediaSections))
      throw engine::Error("ERR_RTC_LIMIT", "SFU transceiver limit reached", MONKY_ENGINE_BUSY);
    if (context.sync_group.empty())
      throw engine::Error("ERR_RTC_SYNC_GROUP", "SFU publication has no synchronization group");
    init.stream_ids = {std::string(context.sync_group)};
    const bool audio = track->kind() == webrtc::MediaStreamTrackInterface::kAudioKind;
    if (audio && init.direction != webrtc::RtpTransceiverDirection::kSendOnly)
      detail::Unsupported("SFU audio publication requires a dedicated sendonly transceiver");
    auto result = pc->AddTransceiver(std::move(track), init);
    detail::RtcOk(result.error(), "RTC could not add the SFU sender");
    auto transceiver = result.MoveValue();
    if (audio) engine::audio::PreferOpus(context.host, *transceiver);
    return transceiver;
  });
}
std::vector<webrtc::scoped_refptr<webrtc::RtpSenderInterface>> PeerConnection::GetSenders() {
  return pc->GetSenders();
}
bool PeerConnection::RemoveTrack(webrtc::scoped_refptr<webrtc::RtpSenderInterface> sender) {
  return sfu::WithPc(*pc, [&](sfu::Call&) {
    detail::RtcOk(pc->RemoveTrackOrError(std::move(sender)), "RTC could not remove the SFU sender");
    return true;
  });
}
nlohmann::json PeerConnection::GetStats() {
  return sfu::WithPc(*pc, [&](sfu::Call& context) {
    auto stats = detail::Stats(context.host, *pc, context.cancellation, nullptr, nullptr,
        &context.stats_diagnostics.send_stream_drops, &context.stats_diagnostics.receive_stream_diagnostics);
    context.stats_selection = sfu::StatsSelection::kPeerConnection;
    return stats;
  });
}
nlohmann::json PeerConnection::GetStats(webrtc::scoped_refptr<webrtc::RtpSenderInterface> sender) {
  return sfu::WithPc(*pc, [&](sfu::Call& context) {
    if (!sender) throw engine::Error("ERR_RTC_STATS", "SFU sender stats require an actual selector");
    auto stats = detail::Stats(context.host, *pc, context.cancellation, std::move(sender), nullptr,
        &context.stats_diagnostics.send_stream_drops, &context.stats_diagnostics.receive_stream_diagnostics);
    context.stats_selection = sfu::StatsSelection::kSender;
    return stats;
  });
}
nlohmann::json PeerConnection::GetStats(webrtc::scoped_refptr<webrtc::RtpReceiverInterface> receiver) {
  return sfu::WithPc(*pc, [&](sfu::Call& context) {
    if (!receiver) throw engine::Error("ERR_RTC_STATS", "SFU receiver stats require an actual selector");
    auto stats = detail::Stats(context.host, *pc, context.cancellation, nullptr, std::move(receiver),
        &context.stats_diagnostics.send_stream_drops, &context.stats_diagnostics.receive_stream_diagnostics);
    context.stats_selection = sfu::StatsSelection::kReceiver;
    return stats;
  });
}
webrtc::scoped_refptr<webrtc::DataChannelInterface> PeerConnection::CreateDataChannel(
    const std::string&, const webrtc::DataChannelInit*) {
  detail::Unsupported("SFU data channels are unavailable");
}
std::optional<int> PeerConnection::GetSctpMaxChannels() const {
  const auto transport = pc->GetSctpTransport();
  return transport ? transport->Information().MaxChannels() : std::nullopt;
}

void PeerConnection::PrivateListener::OnSignalingChange(Pc::SignalingState) {}
void PeerConnection::PrivateListener::OnAddStream(webrtc::scoped_refptr<webrtc::MediaStreamInterface>) {}
void PeerConnection::PrivateListener::OnRemoveStream(webrtc::scoped_refptr<webrtc::MediaStreamInterface>) {}
void PeerConnection::PrivateListener::OnDataChannel(
    webrtc::scoped_refptr<webrtc::DataChannelInterface> channel) { if (channel) channel->Close(); }
void PeerConnection::PrivateListener::OnRenegotiationNeeded() {}
void PeerConnection::PrivateListener::OnIceConnectionChange(Pc::IceConnectionState) {}
void PeerConnection::PrivateListener::OnIceGatheringChange(Pc::IceGatheringState) {}
void PeerConnection::PrivateListener::OnIceCandidate(const webrtc::IceCandidateInterface*) {}
void PeerConnection::PrivateListener::OnIceCandidatesRemoved(const std::vector<webrtc::Candidate>&) {}
void PeerConnection::PrivateListener::OnIceConnectionReceivingChange(bool) {}
void PeerConnection::PrivateListener::OnAddTrack(
    webrtc::scoped_refptr<webrtc::RtpReceiverInterface>,
    const std::vector<webrtc::scoped_refptr<webrtc::MediaStreamInterface>>&) {}
void PeerConnection::PrivateListener::OnTrack(webrtc::scoped_refptr<webrtc::RtpTransceiverInterface>) {}
void PeerConnection::PrivateListener::OnRemoveTrack(webrtc::scoped_refptr<webrtc::RtpReceiverInterface>) {}
void PeerConnection::PrivateListener::OnInterestingUsage(int) {}

}  // namespace mediasoupclient

namespace monky::native_rtc::engine {
namespace {

using namespace peer_detail;
using namespace sfu_detail;

struct DeviceEntry {
  std::uint64_t id = 0;
  bool registered = false;
  // Device and its capabilities must outlive every transport: upstream stores
  // non-owning pointers to Device's canProduceByKind/recvRtpCapabilities maps.
  webrtc::scoped_refptr<webrtc::PeerConnectionFactoryInterface> factory;
  mediasoupclient::PeerConnection::Options options;
  mediasoupclient::Device native;
};

struct TransportEntry final : public mediasoupclient::SendTransport::Listener,
                              public mediasoupclient::RecvTransport::Listener {
  Host& host;
  const std::uint64_t id, device_id;
  const std::string server_id;
  const bool sending;
  bool registered = false;
  std::string sync_group;
  std::size_t creations = 0;
  StatsDiagnostics stats_diagnostics;
  std::set<std::string> producer_ids;
  std::set<std::string> consumer_ids;
  sfu_detail::ReceiveMidReservations receive_mids;
  std::string pending_producer_id;
  std::unique_ptr<mediasoupclient::SendTransport> send;
  std::unique_ptr<mediasoupclient::RecvTransport> recv;

  TransportEntry(Host& host, std::uint64_t id, std::uint64_t device_id,
                 std::string server_id, bool sending)
      : host(host), id(id), device_id(device_id), server_id(std::move(server_id)), sending(sending),
        receive_mids((std::min)(std::size_t(host.MaxResources()), kMaxMediaSections)) {}

  mediasoupclient::Transport& Native() {
    if (send) return *send;
    if (recv) return *recv;
    throw Error("ERR_RTC_CLOSED", "SFU transport is closed", MONKY_ENGINE_CLOSED);
  }
  std::future<void> OnConnect(mediasoupclient::Transport*, const Json& dtls) override {
    std::promise<void> promise;
    auto future = promise.get_future();
    try {
      auto& call = Context();
      call.cancellation->Check();
      Ack(host.RequestServer("connectTransport", id,
          {{"transportId", server_id}, {"dtlsParameters", dtls}, {"purpose", "screen"}},
          call.cancellation));
      call.cancellation->Check();
      promise.set_value();
    } catch (...) {
      const auto failure = std::current_exception();
      if (current_call) current_call->listener_failure = failure;
      promise.set_exception(failure);
    }
    return future;
  }
  std::future<std::string> OnProduce(mediasoupclient::SendTransport*, const std::string& kind,
                                     Json parameters, const Json& app_data) override {
    std::promise<std::string> promise;
    auto future = promise.get_future();
    try {
      auto& call = Context();
      if (AppData(app_data, kind) != call.sync_group)
        Unsupported("Publication appData does not match its source synchronization group");
      ScreenParameters(parameters, kind);
      call.cancellation->Check();
      const auto response = host.RequestServer("produce", id,
          {{"transportId", server_id}, {"kind", kind}, {"rtpParameters", std::move(parameters)},
           {"appData", app_data}, {"purpose", "screen"}}, call.cancellation);
      Ack(response);
      auto server_producer_id = Token(response, "id");
      if (producer_ids.contains(server_producer_id))
        throw Error("ERR_RTC_SERVER_RESPONSE", "Server returned a duplicate producer identifier");
      pending_producer_id = server_producer_id;
      call.cancellation->Check();
      promise.set_value(std::move(server_producer_id));
    } catch (...) {
      const auto failure = std::current_exception();
      if (current_call) current_call->listener_failure = failure;
      promise.set_exception(failure);
    }
    return future;
  }
  std::future<std::string> OnProduceData(mediasoupclient::SendTransport*, const Json&,
      const std::string&, const std::string&, const Json&) override {
    std::promise<std::string> promise;
    auto future = promise.get_future();
    promise.set_exception(std::make_exception_ptr(
        Error("ERR_RTC_UNSUPPORTED", "Data producers are unavailable", MONKY_ENGINE_UNSUPPORTED)));
    return future;
  }
  void OnConnectionStateChange(mediasoupclient::Transport*, const std::string& state) override {
    try {
      std::lock_guard lock(event_mutex);
      state_ = state;
      if (attached_) host.Emit("sfu.state", id,
          {{"state", state}, {"serverTransportId", server_id}, {"purpose", "screen"}});
    } catch (...) { CallbackFailure(); }
  }
  std::string State() const {
    std::lock_guard lock(event_mutex);
    return state_;
  }
  void DetachHost() {
    std::lock_guard lock(event_mutex);
    attached_ = false;
  }
 private:
  mutable std::mutex event_mutex;
  bool attached_ = true;
  std::string state_ = "new";
};

struct ProducerEntry final : public mediasoupclient::Producer::Listener {
  std::uint64_t id = 0, transport_id = 0, source_id = 0;
  std::string server_id;
  bool registered = false, requested = false, effective = false;
  StatsDiagnostics stats_diagnostics;
  std::shared_ptr<VideoSource> source;
  std::shared_ptr<audio::AudioSource> audio_source;
  std::string sync_group;
  webrtc::scoped_refptr<webrtc::MediaStreamTrackInterface> track;
  webrtc::scoped_refptr<webrtc::RtpSenderInterface> sender;
  std::unique_ptr<mediasoupclient::Producer> native;
  void OnTransportClose(mediasoupclient::Producer*) override { effective = false; }
  bool SourceEnabled() const { return source ? source->Enabled() : audio_source->Enabled(); }
};

struct ConsumerEntry final : public mediasoupclient::Consumer::Listener {
  Host& host;
  std::uint64_t id, transport_id;
  std::string server_id, server_producer_id, kind, sync_group;
  double volume = 1;
  std::uint64_t output_epoch = 0;
  bool registered = false, enabled = false, sink_attached = false;
  StatsDiagnostics stats_diagnostics;
  FrameSink sink;
  webrtc::scoped_refptr<webrtc::MediaStreamTrackInterface> track;
  std::unique_ptr<mediasoupclient::Consumer> native;

  ConsumerEntry(Host& host, std::uint64_t id, std::uint64_t transport_id,
                std::string server_id, std::string producer_id, std::string kind, std::string group)
      : host(host), id(id), transport_id(transport_id), server_id(std::move(server_id)),
        server_producer_id(std::move(producer_id)), kind(std::move(kind)),
        sync_group(std::move(group)), sink(host, id) {}
  void OnTransportClose(mediasoupclient::Consumer*) override { enabled = false; }
  void DetachSink() {
    sink.Detach();
    if (track && kind == "audio") audio::GateTrack(host, *track, 0);
    if (sink_attached && track)
      static_cast<webrtc::VideoTrackInterface*>(track.get())->RemoveSink(&sink);
    sink_attached = false;
  }
  ~ConsumerEntry() override { try { DetachSink(); } catch (...) { CallbackFailure(); } }
};

class NativeSfuController final : public SfuController {
 public:
  explicit NativeSfuController(Host& host) : host_(host) {
    PrivateRtcLogging();
    PrivateSfuLogging();
  }
  ~NativeSfuController() override { CloseAll(); }

  Json Execute(std::string_view operation, std::uint64_t target, const Json& data,
               const std::shared_ptr<Cancellation>& cancellation) override {
    CheckActor(host_);
    PrivateRtcLogging();
    PrivateSfuLogging();
    if (!cancellation) Invalid("Missing cancellation context");
    cancellation->Check();
    CheckJson(data);
    BoundedStrings(data);
    if (operation == "sfu.load") return Load(target, data, cancellation);
    if (operation == "sfu.createTransport") return CreateTransport(target, data, cancellation);
    if (operation == "sfu.produce") return Produce(target, data, cancellation);
    if (operation == "sfu.consume") return Consume(target, data, cancellation);
    if (operation == "sfu.setConsumerVolume") {
      Keys(data, {"volume"});
      const auto volume = audio::Volume(data);
      auto& consumer = FindConsumer(target);
      if (consumer.kind != "audio") Invalid("Volume applies only to audio consumers");
      audio::CheckOutputAdmission(consumer.enabled, host_.AudioOutputReady(consumer.output_epoch), false);
      if (consumer.track) audio::GateTrack(host_, *consumer.track, consumer.enabled ? volume : 0);
      consumer.volume = volume;
      return {{"consumerId", target}, {"volume", volume}};
    }
    if (operation == "resource.close") {
      Keys(data, {});
      if (!Contains(target))
        throw Error("ERR_RTC_NOT_FOUND", "SFU resource not found", MONKY_ENGINE_NOT_FOUND);
      Close(target);
      return Json::object();
    }
    if (operation == "sfu.setProducerEnabled") {
      Keys(data, {"enabled"});
      if (!data.contains("enabled")) Invalid("enabled is required");
      const bool requested = Boolean(data, "enabled");
      auto& producer = FindProducer(target);
      const auto transport_id = producer.transport_id;
      try {
        SetProducer(producer, requested, cancellation);
        return {{"enabled", producer.effective}};
      } catch (...) {
        CloseTransport(transport_id);
        throw;
      }
    }
    if (operation == "sfu.setConsumerEnabled") {
      Keys(data, {"enabled", "expectedOutputEpoch"});
      if (!data.contains("enabled")) Invalid("enabled is required");
      const bool enabled = Boolean(data, "enabled");
      auto& consumer = FindConsumer(target);
      const auto output_epoch = audio::ExpectedOutputEpoch(data, enabled && consumer.kind == "audio");
      audio::CheckOutputAdmission(enabled && consumer.kind == "audio", host_.AudioOutputReady(output_epoch), true);
      const auto transport_id = consumer.transport_id;
      try {
        SetConsumer(consumer, enabled, cancellation, output_epoch);
        return {{"enabled", consumer.enabled}};
      } catch (...) {
        CloseTransport(transport_id);
        throw;
      }
    }
    if (operation == "sfu.restartIce") {
      Keys(data, {"iceParameters"});
      auto parameters = Object(data, "iceParameters");
      IceParameters(parameters);
      auto& transport = FindTransport(target);
      auto& device = FindDevice(transport.device_id);
      Call call(host_, cancellation, &device.options);
      try {
        cancellation->Check();
        transport.Native().RestartIce(parameters);
        cancellation->Check();
        return Json::object();
      } catch (...) {
        CloseTransport(target);
        throw;
      }
    }
    if (operation == "sfu.getStats") {
      Keys(data, {});
      const auto transport_id = TransportId(target);
      auto& transport = FindTransport(transport_id);
      auto& device = FindDevice(transport.device_id);
      Call call(host_, cancellation, &device.options);
      const auto producer = producers_.find(target);
      const auto consumer = consumers_.find(target);
      auto* cached = &transport.stats_diagnostics;
      auto selection = StatsSelection::kPeerConnection;
      if (producer != producers_.end()) {
        cached = &producer->second->stats_diagnostics;
        selection = StatsSelection::kSender;
      } else if (consumer != consumers_.end()) {
        cached = &consumer->second->stats_diagnostics;
        selection = StatsSelection::kReceiver;
      }
      cached->receive_stream_diagnostics = nullptr;
      try {
        Json stats;
        if (producer != producers_.end())
          stats = producer->second->native->GetStats();
        else if (consumer != consumers_.end())
          stats = consumer->second->native->GetStats();
        else stats = transport.Native().GetStats();
        cancellation->Check();
        if (stats.dump().size() > kMaxJson) throw Error("ERR_RTC_LIMIT", "SFU stats exceed 1 MiB");
        if (call.stats_selection != selection)
          throw Error("ERR_RTC_STATS", "SFU stats did not observe the requested SDK selector");
        // A selected receiver/sender report never replaces a whole-transport observation.
        *cached = std::move(call.stats_diagnostics);
        return stats;
      } catch (...) {
        if (Cancelled(std::current_exception())) CloseTransport(transport_id);
        throw;
      }
    }
    Unsupported("Unknown SFU operation");
  }

  bool Contains(std::uint64_t target) const override {
    return devices_.contains(target) || transports_.contains(target) ||
           producers_.contains(target) || consumers_.contains(target);
  }
  bool UsesSource(std::uint64_t source) const override {
    return std::any_of(producers_.begin(), producers_.end(),
        [source](const auto& item) { return item.second->source_id == source; });
  }
  void SourceEnabledChanged(std::uint64_t source) override {
    CheckActor(host_);
    std::vector<std::uint64_t> ids;
    for (const auto& [id, producer] : producers_)
      if (producer->source_id == source) ids.push_back(id);
    std::exception_ptr failure;
    for (const auto id : ids) {
      const auto it = producers_.find(id);
      if (it == producers_.end()) continue;
      const auto transport_id = it->second->transport_id;
      try {
        SetProducer(*it->second, it->second->requested, CleanupCancellation(host_, id));
      } catch (...) {
        if (!failure) failure = std::current_exception();
        CloseTransport(transport_id);
      }
    }
    if (failure) std::rethrow_exception(failure);
  }
  void Close(std::uint64_t target) override {
    CheckActor(host_);
    if (transports_.contains(target)) { CloseTransport(target); return; }
    if (devices_.contains(target)) {
      std::vector<std::uint64_t> ids;
      for (const auto& [id, transport] : transports_)
        if (transport->device_id == target) ids.push_back(id);
      for (auto id : ids) CloseTransport(id);
      host_.ForgetResource(target);
      devices_.erase(target);
      return;
    }
    if (auto it = producers_.find(target); it != producers_.end()) {
      const auto transport_id = it->second->transport_id;
      auto& transport = FindTransport(transport_id);
      auto& device = FindDevice(transport.device_id);
      const auto cancellation = CleanupCancellation(host_, target);
      Call call(host_, cancellation, &device.options);
      try {
        GateSender(*it->second->sender, false);
        it->second->native->Close();
        cancellation->Check();
        transport.producer_ids.erase(it->second->server_id);
        host_.ForgetResource(target);
        producers_.erase(it);
      } catch (...) {
        CloseTransport(transport_id);
        throw;
      }
      return;
    }
    if (auto it = consumers_.find(target); it != consumers_.end()) {
      const auto transport_id = it->second->transport_id;
      auto& transport = FindTransport(transport_id);
      auto& device = FindDevice(transport.device_id);
      const auto cancellation = CleanupCancellation(host_, target);
      Call call(host_, cancellation, &device.options);
      try {
        it->second->DetachSink();
        it->second->native->Close();
        cancellation->Check();
        transport.consumer_ids.erase(it->second->server_id);
        host_.ForgetResource(target);
        consumers_.erase(it);
      } catch (...) {
        CloseTransport(transport_id);
        throw;
      }
    }
  }
  void CloseAll() override {
    while (!transports_.empty()) CloseTransport(transports_.begin()->first);
    for (const auto& [id, device] : devices_) host_.ForgetResource(id);
    devices_.clear();
  }
  Json Snapshot() const override {
    Json devices = Json::array(), transports = Json::array();
    Json producers = Json::array(), consumers = Json::array();
    for (const auto& [id, device] : devices_)
      devices.push_back({{"deviceId", id}, {"loaded", device->native.IsLoaded()},
                         {"canProduceAudio", device->native.CanProduce("audio")}});
    for (const auto& [id, transport] : transports_)
      transports.push_back({{"transportId", id}, {"deviceId", transport->device_id},
          {"serverTransportId", transport->server_id}, {"direction", transport->sending ? "send" : "recv"},
          {"purpose", "screen"}, {"state", transport->State()}, {"statsSelection", "peer-connection"},
          {"sendStreamDrops", transport->stats_diagnostics.send_stream_drops},
          {"receiveStreamDiagnostics", transport->stats_diagnostics.receive_stream_diagnostics}});
    for (const auto& [id, producer] : producers_)
      producers.push_back({{"producerId", id}, {"transportId", producer->transport_id},
          {"serverProducerId", producer->server_id}, {"sourceId", producer->source_id},
          {"kind", producer->audio_source ? "audio" : "video"}, {"syncGroup", producer->sync_group},
          {"requestedEnabled", producer->requested}, {"enabled", producer->effective},
          {"statsSelection", "sender"}, {"sendStreamDrops", producer->stats_diagnostics.send_stream_drops},
          {"receiveStreamDiagnostics", producer->stats_diagnostics.receive_stream_diagnostics}});
    for (const auto& [id, consumer] : consumers_)
      consumers.push_back({{"consumerId", id}, {"transportId", consumer->transport_id},
          {"serverConsumerId", consumer->server_id}, {"serverProducerId", consumer->server_producer_id},
          {"kind", consumer->kind}, {"syncGroup", consumer->sync_group},
          {"volume", consumer->volume}, {"enabled", consumer->enabled}, {"statsSelection", "receiver"},
          {"sendStreamDrops", consumer->stats_diagnostics.send_stream_drops},
          {"receiveStreamDiagnostics", consumer->stats_diagnostics.receive_stream_diagnostics}});
    return {{"devices", std::move(devices)}, {"transports", std::move(transports)},
            {"producers", std::move(producers)}, {"consumers", std::move(consumers)}};
  }

 private:
  static void PrivateSfuLogging() {
    if (mediasoupclient::Logger::handler ||
        mediasoupclient::Logger::logLevel != mediasoupclient::Logger::LogLevel::LOG_NONE)
      throw Error("ERR_RTC_LOGGING", "Raw mediasoup log sinks must be disabled for screen signaling");
  }
  void Capacity() const {
    if (devices_.size() + transports_.size() + producers_.size() + consumers_.size() >= host_.MaxResources())
      throw Error("ERR_RTC_LIMIT", "SFU resource limit reached", MONKY_ENGINE_BUSY);
  }
  void Slot(const TransportEntry& transport) const {
    const auto slots = transport.creations + (transport.sending ? 0 : 1);
    if (slots >= (std::min)(std::size_t(host_.MaxResources()), kMaxMediaSections))
      throw Error("ERR_RTC_LIMIT", "SFU transceiver budget exhausted; recreate the transport",
                  MONKY_ENGINE_BUSY);
  }
  DeviceEntry& FindDevice(std::uint64_t id) const {
    const auto it = devices_.find(id);
    if (it == devices_.end()) throw Error("ERR_RTC_NOT_FOUND", "SFU device not found", MONKY_ENGINE_NOT_FOUND);
    return *it->second;
  }
  TransportEntry& FindTransport(std::uint64_t id) const {
    const auto it = transports_.find(id);
    if (it == transports_.end()) throw Error("ERR_RTC_NOT_FOUND", "SFU transport not found", MONKY_ENGINE_NOT_FOUND);
    return *it->second;
  }
  ProducerEntry& FindProducer(std::uint64_t id) const {
    const auto it = producers_.find(id);
    if (it == producers_.end()) throw Error("ERR_RTC_NOT_FOUND", "SFU producer not found", MONKY_ENGINE_NOT_FOUND);
    return *it->second;
  }
  ConsumerEntry& FindConsumer(std::uint64_t id) const {
    const auto it = consumers_.find(id);
    if (it == consumers_.end()) throw Error("ERR_RTC_NOT_FOUND", "SFU consumer not found", MONKY_ENGINE_NOT_FOUND);
    return *it->second;
  }
  std::uint64_t TransportId(std::uint64_t target) const {
    if (transports_.contains(target)) return target;
    if (const auto it = producers_.find(target); it != producers_.end()) return it->second->transport_id;
    if (const auto it = consumers_.find(target); it != consumers_.end()) return it->second->transport_id;
    throw Error("ERR_RTC_NOT_FOUND", "SFU stats target not found", MONKY_ENGINE_NOT_FOUND);
  }
  void SetProducer(ProducerEntry& producer, bool requested,
                   const std::shared_ptr<Cancellation>& cancellation) {
    auto& transport = FindTransport(producer.transport_id);
    cancellation->Check();
    const bool effective = requested && producer.SourceEnabled();
    // Disable locally before asking the server. Enable only after a real ack.
    if (!effective) GateSender(*producer.sender, false);
    cancellation->Check();
    Ack(host_.RequestServer("setProducerEnabled", producer.id,
        {{"transportId", transport.server_id}, {"producerId", producer.server_id},
         {"enabled", effective}, {"purpose", "screen"}}, cancellation));
    cancellation->Check();
    GateSender(*producer.sender, effective);
    cancellation->Check();
    producer.requested = requested;
    producer.effective = effective;
  }
  void SetConsumer(ConsumerEntry& consumer, bool enabled,
                   const std::shared_ptr<Cancellation>& cancellation, std::uint64_t output_epoch = 0) {
    auto& transport = FindTransport(consumer.transport_id);
    cancellation->Check();
    if (consumer.kind == "audio") {
      audio::CheckOutputAdmission(enabled, host_.AudioOutputReady(output_epoch), false);
      if (!enabled && consumer.track) audio::GateTrack(host_, *consumer.track, 0);
    } else if (!enabled) consumer.sink.Enable(false);
    Ack(host_.RequestServer("setConsumerEnabled", consumer.id,
        {{"transportId", transport.server_id}, {"consumerId", consumer.server_id},
         {"enabled", enabled}, {"purpose", "screen"}}, cancellation));
    cancellation->Check();
    if (consumer.kind == "audio") {
      audio::CheckOutputAdmission(enabled, host_.AudioOutputReady(output_epoch), false);
      if (consumer.track) audio::GateTrack(host_, *consumer.track, enabled ? consumer.volume : 0);
      consumer.output_epoch = enabled ? output_epoch : 0;
    } else consumer.sink.Enable(enabled);
    consumer.enabled = enabled;
    cancellation->Check();
    audio::CheckOutputAdmission(enabled && consumer.kind == "audio", host_.AudioOutputReady(output_epoch), false);
  }
  void PauseUnpublishedProducer(std::uint64_t target, const std::string& transport_id,
                                const std::string& producer_id) noexcept {
    if (producer_id.empty()) return;
    try {
      Ack(host_.RequestServer("setProducerEnabled", target,
          {{"transportId", transport_id}, {"producerId", producer_id},
           {"enabled", false}, {"purpose", "screen"}}, CleanupCancellation(host_, target)));
    } catch (...) {
      try {
        host_.Emit("error", target, {{"code", "ERR_RTC_SERVER_CLEANUP"},
            {"message", "Server did not acknowledge pausing an unpublished producer"},
            {"status", MONKY_ENGINE_FAILURE}, {"hresult", 0}, {"terminal", false}});
      } catch (...) { CallbackFailure(); }
    }
  }
  void CloseTransport(std::uint64_t target) {
    const auto it = transports_.find(target);
    if (it == transports_.end()) return;
    auto& transport = *it->second;
    transport.DetachHost();
    for (auto& [id, consumer] : consumers_)
      if (consumer->transport_id == target) consumer->DetachSink();
    // Close notifies raw Producer/Consumer listeners. Keep every entry alive
    // until the actual PC and Handler have been destroyed on signaling.
    transport.Native().Close();
    host_.SignalingThread()->BlockingCall([&] {
      transport.send.reset();
      transport.recv.reset();
    });
    for (auto entry = producers_.begin(); entry != producers_.end();) {
      if (entry->second->transport_id != target) { ++entry; continue; }
      host_.ForgetResource(entry->first);
      entry = producers_.erase(entry);
    }
    for (auto entry = consumers_.begin(); entry != consumers_.end();) {
      if (entry->second->transport_id != target) { ++entry; continue; }
      host_.ForgetResource(entry->first);
      entry = consumers_.erase(entry);
    }
    if (transport.registered) host_.ForgetResource(target);
    transports_.erase(it);
  }
  Json Load(std::uint64_t target, const Json& data, const std::shared_ptr<Cancellation>& cancellation) {
    if (target) Invalid("sfu.load requires target zero");
    Keys(data, {"routerRtpCapabilities", "iceServers"});
    auto router = ScreenCapabilities(Object(data, "routerRtpCapabilities"));
    auto configuration = Configuration(data);
    Capacity();
    auto device = std::make_unique<DeviceEntry>();
    device->id = host_.AllocateHandle();
    device->factory = host_.Factory();
    if (!device->factory) throw Error("ERR_RTC_NOT_READY", "The RTC factory is unavailable");
    device->options.factory = device->factory.get();
    device->options.config = std::move(configuration);
    const auto id = device->id;
    Call call(host_, cancellation, &device->options, true);
    try {
      cancellation->Check();
      host_.RegisterResource(id);
      device->registered = true;
      cancellation->Check();
      device->native.Load(std::move(router), &device->options, false);
      cancellation->Check();
      auto capabilities = ScreenCapabilities(device->native.GetRtpCapabilities());
      const bool can_produce = device->native.CanProduce("video");
      const bool can_produce_audio = device->native.CanProduce("audio");
      devices_.emplace(id, std::move(device));
      cancellation->Check();
      return {{"deviceId", id}, {"rtpCapabilities", std::move(capabilities)},
              {"canProduceVideo", can_produce}, {"canProduceAudio", can_produce_audio}};
    } catch (...) {
      if (devices_.contains(id)) Close(id);
      else if (device && device->registered) host_.ForgetResource(id);
      throw;
    }
  }
  Json CreateTransport(std::uint64_t target, const Json& data,
                       const std::shared_ptr<Cancellation>& cancellation) {
    Keys(data, {"direction", "id", "purpose", "iceParameters", "iceCandidates", "dtlsParameters"});
    auto& device = FindDevice(target);
    const auto direction = Text(data, "direction", 8);
    if (direction != "send" && direction != "recv") Invalid("Invalid SFU transport direction");
    if (Text(data, "purpose", 16) != "screen") Unsupported("Only screen SFU transports are supported");
    const auto server_id = Token(data, "id");
    for (const auto& [id, transport] : transports_)
      if (transport->server_id == server_id) Invalid("Server transport is already registered");
    auto ice = Object(data, "iceParameters");
    auto dtls = Object(data, "dtlsParameters");
    if (!data.contains("iceCandidates")) Invalid("Missing ICE candidates");
    auto candidates = data.at("iceCandidates");
    IceParameters(ice);
    IceCandidates(candidates);
    DtlsParameters(dtls);
    Capacity();
    const auto id = host_.AllocateHandle();
    auto transport = std::make_unique<TransportEntry>(host_, id, target, server_id, direction == "send");
    Call call(host_, cancellation, &device.options);
    try {
      cancellation->Check();
      host_.RegisterResource(id, target);
      transport->registered = true;
      cancellation->Check();
      const Json app_data{{"purpose", "screen"}};
      if (transport->sending)
        transport->send.reset(device.native.CreateSendTransport(
            transport.get(), server_id, ice, candidates, dtls, &device.options, app_data));
      else
        transport->recv.reset(device.native.CreateRecvTransport(
            transport.get(), server_id, ice, candidates, dtls, &device.options, app_data));
      (void)transport->Native();
      cancellation->Check();
      transports_.emplace(id, std::move(transport));
      cancellation->Check();
      return {{"transportId", id}, {"serverTransportId", server_id},
              {"direction", direction}, {"purpose", "screen"}};
    } catch (...) {
      if (transports_.contains(id)) CloseTransport(id);
      else if (transport) {
        transport->DetachHost();
        if (transport->send || transport->recv) transport->Native().Close();
        host_.SignalingThread()->BlockingCall([&] {
          transport->send.reset();
          transport->recv.reset();
        });
        if (transport->registered) host_.ForgetResource(id);
      }
      throw;
    }
  }
  Json Produce(std::uint64_t target, const Json& data,
               const std::shared_ptr<Cancellation>& cancellation) {
    Keys(data, {"sourceId", "enabled", "maxBitrateBps", "maxFramerate", "appData"});
    auto& transport = FindTransport(target);
    if (!transport.sending) Invalid("Producing requires a send transport");
    auto& device = FindDevice(transport.device_id);
    const auto source_id = Id(data, "sourceId");
    auto source = host_.FindSource(source_id);
    auto audio_source = host_.FindAudioSource(source_id);
    if (!source && !audio_source) throw Error("ERR_RTC_NOT_FOUND", "Source not found", MONKY_ENGINE_NOT_FOUND);
    const std::string kind = audio_source ? "audio" : "video";
    for (const auto& [id, existing] : producers_)
      if (existing->transport_id == target && existing->source_id == source_id)
        Invalid("This transport already publishes the screen source");
    if (!device.native.CanProduce(kind)) Unsupported("Device cannot produce compatible screen media");
    if (audio_source) {
      if (data.contains("maxFramerate")) Invalid("Audio publication has no video framerate");
      for (const auto& [id, existing] : producers_)
        if (existing->audio_source) Invalid("A screen audio producer is already active");
    }
    const auto app_data = Object(data, "appData");
    const auto group = AppData(app_data, kind);
    if ((source ? source->SyncGroup() : audio_source->SyncGroup()) != group)
      Invalid("Producer appData does not match its source syncGroup");
    const bool requested = Boolean(data, "enabled");
    std::vector<webrtc::RtpEncodingParameters> encodings{
        audio_source ? audio::Encoding(data, false) : Encoding(data, false)};
    Capacity();
    Slot(transport);
    auto producer = std::make_unique<ProducerEntry>();
    producer->id = host_.AllocateHandle();
    producer->transport_id = target;
    producer->source_id = source_id;
    producer->source = std::move(source);
    producer->audio_source = std::move(audio_source);
    producer->sync_group = group;
    const auto id = producer->id;
    Call call(host_, cancellation, &device.options, false, group);
    bool native_started = false;
    try {
      cancellation->Check();
      host_.RegisterResource(id, target, source_id);
      producer->registered = true;
      cancellation->Check();
      if (producer->audio_source) {
        producer->track = device.factory->CreateAudioTrack(
            "screen-audio-" + std::to_string(id), producer->audio_source->TrackSource().get());
      } else {
        auto native_source = producer->source->TrackSource();
        if (!native_source) throw Error("ERR_RTC_CLOSED", "Source is closed", MONKY_ENGINE_CLOSED);
        auto video = device.factory->CreateVideoTrack(native_source, "screen-" + std::to_string(id));
        if (video) video->set_content_hint(webrtc::VideoTrackInterface::ContentHint::kDetailed);
        producer->track = std::move(video);
      }
      if (!producer->track) throw Error("ERR_RTC_TRACK", "RTC could not create the SFU media track");
      cancellation->Check();
      transport.pending_producer_id.clear();
      native_started = true;
      const auto codec_options = audio::OpusCodecOptions();
      producer->native.reset(transport.send->Produce(
          producer.get(), producer->track.get(), &encodings,
          producer->audio_source ? &codec_options : nullptr, nullptr, app_data));
      if (!producer->native) throw Error("ERR_RTC_PRODUCER", "SFU returned no producer");
      ++transport.creations;
      producer->server_id = producer->native->GetId();
      producer->sender = webrtc::scoped_refptr<webrtc::RtpSenderInterface>(producer->native->GetRtpSender());
      if (!producer->sender) throw Error("ERR_RTC_PRODUCER", "SFU returned no RTP sender");
      cancellation->Check();
      const auto server_id = producer->server_id;
      SetProducer(*producer, requested, cancellation);
      transport.producer_ids.insert(server_id);
      producers_.emplace(id, std::move(producer));
      cancellation->Check();
      transport.pending_producer_id.clear();
      return {{"producerId", id}, {"serverProducerId", server_id}, {"kind", kind}, {"syncGroup", group}};
    } catch (...) {
      if (!native_started) {
        if (producer && producer->registered) host_.ForgetResource(id);
        throw;
      }
      const auto server_transport_id = transport.server_id;
      auto server_producer_id = transport.pending_producer_id;
      if (server_producer_id.empty() && producer && producer->native)
        server_producer_id = producer->native->GetId();
      CloseTransport(target);
      if (producer && producer->registered) host_.ForgetResource(id);
      PauseUnpublishedProducer(target, server_transport_id, server_producer_id);
      // Handler::Send rethrows some std::exception values by value. Preserve
      // the real server rejection and cancellation instead of that sliced error.
      cancellation->Check();
      if (call.listener_failure) std::rethrow_exception(call.listener_failure);
      throw;
    }
  }
  Json Consume(std::uint64_t target, const Json& data,
               const std::shared_ptr<Cancellation>& cancellation) {
    Keys(data, {"id", "producerId", "kind", "rtpParameters", "appData", "enabled", "expectedOutputEpoch"});
    auto& transport = FindTransport(target);
    if (transport.sending) Invalid("Consuming requires a receive transport");
    auto& device = FindDevice(transport.device_id);
    const auto kind = Text(data, "kind", 16);
    if (kind != "video" && kind != "audio") Unsupported("Only screen media can be consumed");
    const auto output_epoch = audio::ExpectedOutputEpoch(data, kind == "audio");
    audio::CheckOutputAdmission(kind == "audio", host_.AudioOutputReady(output_epoch), true);
    const auto app_data = Object(data, "appData");
    const auto group = AppData(app_data, kind);
    const auto server_id = Token(data, "id");
    const auto producer_id = Token(data, "producerId");
    if (server_id == "probator") Invalid("The probator identifier is reserved");
    for (const auto& [id, consumer] : consumers_) {
      if (consumer->server_id == server_id) Invalid("Server consumer is already registered");
      if (consumer->transport_id == target && consumer->kind == kind && consumer->sync_group == group)
        Invalid("A synchronization group can contain only one track of each kind per receive transport");
      if (kind == "audio" && consumer->kind == "audio" &&
          consumer->server_producer_id == producer_id)
        Invalid("Close the old audio consumer before rebinding its producer to another syncGroup");
    }
    auto parameters = Object(data, "rtpParameters");
    ScreenParameters(parameters, kind);
    const bool enabled = Boolean(data, "enabled");
    Capacity();
    Slot(transport);
    auto mid = transport.receive_mids.Reserve(parameters);
    const auto id = host_.AllocateHandle();
    auto consumer = std::make_unique<ConsumerEntry>(host_, id, target, server_id, producer_id, kind, group);
    Call call(host_, cancellation, &device.options);
    bool native_started = false;
    try {
      cancellation->Check();
      host_.RegisterResource(id, target);
      consumer->registered = true;
      // Pause the actual server consumer before creating the receiving PC media.
      SetConsumer(*consumer, false, cancellation);
      mid.Commit();
      native_started = true;
      consumer->native.reset(transport.recv->Consume(
          consumer.get(), server_id, producer_id, kind, &parameters, app_data, group));
      if (!consumer->native) throw Error("ERR_RTC_CONSUMER", "SFU returned no consumer");
      if (consumer->native->GetLocalId() != mid.Mid())
        throw Error("ERR_RTC_CONSUMER_MID", "SDK did not preserve the reserved receive MID");
      ++transport.creations;
      cancellation->Check();
      auto* track = consumer->native->GetTrack();
      if (!track || track->kind() != kind)
        throw Error("ERR_RTC_TRACK", "SFU receiving track does not match the requested media kind");
      consumer->track = webrtc::scoped_refptr<webrtc::MediaStreamTrackInterface>(track);
      if (kind == "audio") audio::GateTrack(host_, *track, 0);
      else {
        static_cast<webrtc::VideoTrackInterface*>(track)->AddOrUpdateSink(
            &consumer->sink, webrtc::VideoSinkWants{});
        consumer->sink_attached = true;
      }
      cancellation->Check();
      if (enabled) SetConsumer(*consumer, true, cancellation, output_epoch);
      audio::CheckOutputAdmission(kind == "audio", host_.AudioOutputReady(output_epoch), false);
      transport.consumer_ids.insert(server_id);
      consumers_.emplace(id, std::move(consumer));
      cancellation->Check();
      return {{"consumerId", id}, {"serverConsumerId", server_id}, {"kind", kind},
              {"syncGroup", group}, {"mid", mid.Mid()}, {"trackId", track->id()}};
    } catch (...) {
      if (!native_started) {
        if (consumer && consumer->registered) host_.ForgetResource(id);
        throw;
      }
      const auto server_transport_id = transport.server_id;
      if (consumer) {
        consumer->DetachSink();
      }
      CloseTransport(target);
      if (consumer && consumer->registered) host_.ForgetResource(id);
      // A resumed result that arrives after cancellation is not published.
      try {
        Ack(host_.RequestServer("setConsumerEnabled", target,
            {{"transportId", server_transport_id}, {"consumerId", server_id},
             {"enabled", false}, {"purpose", "screen"}}, CleanupCancellation(host_, target)));
      } catch (...) {
        host_.Emit("error", target, {{"code", "ERR_RTC_SERVER_CLEANUP"},
            {"message", "Server did not acknowledge pausing an unpublished consumer"},
            {"status", MONKY_ENGINE_FAILURE}, {"hresult", 0}, {"terminal", false}});
      }
      cancellation->Check();
      if (call.listener_failure) std::rethrow_exception(call.listener_failure);
      throw;
    }
  }

  Host& host_;
  std::map<std::uint64_t, std::unique_ptr<DeviceEntry>> devices_;
  std::map<std::uint64_t, std::unique_ptr<TransportEntry>> transports_;
  std::map<std::uint64_t, std::unique_ptr<ProducerEntry>> producers_;
  std::map<std::uint64_t, std::unique_ptr<ConsumerEntry>> consumers_;
};

}  // namespace

std::unique_ptr<SfuController> CreateSfuController(Host& host) {
  return std::make_unique<NativeSfuController>(host);
}

}  // namespace monky::native_rtc::engine
