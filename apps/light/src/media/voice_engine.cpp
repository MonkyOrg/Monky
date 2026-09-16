#include "voice_engine.hpp"
#include "video_codec_factories.hpp"
#include "policy_audio_device.hpp"
#include "protocol.hpp"

#include <Device.hpp>
#include <api/audio/builtin_audio_processing_builder.h>
#include <api/audio_codecs/builtin_audio_decoder_factory.h>
#include <api/audio_codecs/builtin_audio_encoder_factory.h>
#include <api/create_peerconnection_factory.h>
#include <api/environment/environment_factory.h>
#include <api/jsep.h>
#include <api/make_ref_counted.h>
#include <api/rtp_transceiver_interface.h>
#include <api/stats/rtc_stats_collector_callback.h>
#include <api/stats/rtc_stats_report.h>
#include <api/video_codecs/video_decoder_factory.h>
#include <api/video_codecs/video_encoder_factory.h>
#include <rtc_base/ssl_adapter.h>
#include <rtc_base/thread.h>
#if defined(WEBRTC_WIN)
#include <rtc_base/win32_socket_init.h>
#endif

#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <deque>
#include <iostream>
#include <map>
#include <mutex>
#include <set>
#include <sstream>
#include <stdexcept>
#include <thread>
#include <utility>

namespace monky::light::media {
namespace {
using Json = nlohmann::json;
using Clock = std::chrono::steady_clock;
namespace msg = monky::protocol::message;

class Cancelled : public std::runtime_error {
public:
  Cancelled() : std::runtime_error("Voice operation cancelled") {}
};

void EnsureSslRuntime() {
  struct Runtime {
#if defined(WEBRTC_WIN)
    webrtc::WinsockInitializer sockets;
#endif
    Runtime() {
#if defined(WEBRTC_WIN)
      if (sockets.error() != 0)
        throw std::runtime_error("WebRTC Winsock initialization failed");
#endif
      if (!webrtc::InitializeSSL())
        throw std::runtime_error("WebRTC SSL init failed");
    }
    ~Runtime() {
      if (!webrtc::CleanupSSL())
        std::cerr << "WebRTC SSL cleanup failed\n";
    }
  };
  // Initialized by the facade owner, before any owned WebRTC threads exist.
  static Runtime runtime;
}

void Check(const webrtc::RTCError &error, const char *operation) {
  if (!error.ok())
    throw std::runtime_error(std::string(operation) + ": " +
                             std::string(error.message()));
}

std::string Text(const Json &object, const char *key) {
  const auto found = object.find(key);
  if (found == object.end() || !found->is_string() ||
      found->get_ref<const std::string &>().empty())
    throw std::runtime_error(std::string("Missing or invalid media field: ") +
                             key);
  return found->get<std::string>();
}

// A reentrant observer may destroy the facade on its control thread. Transfer
// that join to a process-owned joiner; never detach the media worker or
// self-join.
class ThreadJoiner {
public:
  ThreadJoiner()
      : thread_([this] {
          std::unique_lock lock(mutex_);
          for (;;) {
            ready_.wait(lock,
                        [this] { return stopping_ || !threads_.empty(); });
            if (threads_.empty() && stopping_)
              return;
            auto thread = std::move(threads_.front());
            threads_.pop_front();
            lock.unlock();
            thread.join();
            lock.lock();
          }
        }) {}
  ~ThreadJoiner() {
    {
      std::lock_guard lock(mutex_);
      stopping_ = true;
    }
    ready_.notify_one();
    thread_.join();
  }
  void Add(std::thread thread) {
    {
      std::lock_guard lock(mutex_);
      threads_.push_back(std::move(thread));
    }
    ready_.notify_one();
  }
  static ThreadJoiner &Instance() {
    static ThreadJoiner joiner;
    return joiner;
  }

private:
  std::mutex mutex_;
  std::condition_variable ready_;
  std::deque<std::thread> threads_;
  bool stopping_ = false;
  std::thread thread_;
};

struct RpcWait {
  std::mutex mutex;
  std::condition_variable ready;
  std::optional<RpcResult> result;
  CancelRequest cancel;
  bool cancelled = false;

  void Complete(RpcResult value) {
    {
      std::lock_guard lock(mutex);
      if (result)
        return;
      result = std::move(value);
      cancel = {};
    }
    ready.notify_all();
  }
  void SetCancel(CancelRequest value) {
    bool invoke;
    {
      std::lock_guard lock(mutex);
      invoke = cancelled;
      if (!invoke && !result)
        cancel = std::move(value);
    }
    if (invoke && value)
      value();
  }
  void Cancel() {
    CancelRequest callback;
    {
      std::lock_guard lock(mutex);
      if (cancelled)
        return;
      cancelled = true;
      if (!result)
        result = RpcFailure{std::string(monky::protocol::error::INTERNAL_ERROR),
                            "Voice RPC cancelled"};
      callback = std::move(cancel);
    }
    ready.notify_all();
    if (callback) {
      try {
        callback();
      } catch (const std::exception &error) {
        std::cerr << "Voice RPC cancellation failed: " << error.what() << '\n';
      }
    }
  }
};

struct CallToken {
  std::string self_user_id;
  std::string self_session_id;
  std::atomic<bool> cancelled{false};
  std::atomic<bool> muted{false};
  std::atomic<bool> deafened{false};
  std::mutex mutex;
  std::vector<std::weak_ptr<RpcWait>> requests;
  void CheckActive() const {
    if (cancelled.load())
      throw Cancelled();
  }
  void Register(const std::shared_ptr<RpcWait> &request) {
    {
      std::lock_guard lock(mutex);
      std::erase_if(requests, [](const auto &item) { return item.expired(); });
      requests.push_back(request);
    }
    if (cancelled.load())
      request->Cancel();
  }
  void Cancel() {
    cancelled.store(true);
    std::vector<std::shared_ptr<RpcWait>> pending;
    {
      std::lock_guard lock(mutex);
      for (auto &item : requests)
        if (auto request = item.lock())
          pending.push_back(std::move(request));
      requests.clear();
    }
    for (auto &request : pending)
      request->Cancel();
  }
};

template <class T>
T Await(std::future<T> &future, const std::shared_ptr<CallToken> &token,
        std::chrono::milliseconds timeout) {
  const auto end = Clock::now() + timeout;
  while (future.wait_for(std::chrono::milliseconds(10)) !=
         std::future_status::ready) {
    token->CheckActive();
    if (Clock::now() >= end)
      throw std::runtime_error("WebRTC operation timed out");
  }
  token->CheckActive();
  return future.get();
}

class CreateSdpObserver : public webrtc::CreateSessionDescriptionObserver {
public:
  std::promise<std::unique_ptr<webrtc::SessionDescriptionInterface>> promise;
  void OnSuccess(webrtc::SessionDescriptionInterface *sdp) override {
    promise.set_value(
        std::unique_ptr<webrtc::SessionDescriptionInterface>(sdp));
  }
  void OnFailure(webrtc::RTCError error) override {
    promise.set_exception(std::make_exception_ptr(
        std::runtime_error(std::string(error.message()))));
  }
};

class SetSdpObserver : public webrtc::SetSessionDescriptionObserver {
public:
  std::promise<void> promise;
  void OnSuccess() override { promise.set_value(); }
  void OnFailure(webrtc::RTCError error) override {
    promise.set_exception(std::make_exception_ptr(
        std::runtime_error(std::string(error.message()))));
  }
};

class StatsObserver : public webrtc::RTCStatsCollectorCallback {
public:
  explicit StatsObserver(std::function<void(Json)> callback)
      : callback_(std::move(callback)) {}
  void OnStatsDelivered(
      const webrtc::scoped_refptr<const webrtc::RTCStatsReport> &report)
      override {
    callback_(Json::parse(report->ToJson()));
  }

private:
  std::function<void(Json)> callback_;
};

struct SdpSection {
  std::string kind;
  std::string mid;
  std::string stream;
  std::string ufrag;
};

// Read metadata only. WebRTC parses and validates the complete, unchanged SDP.
std::vector<SdpSection> Sections(const std::string &sdp) {
  if (sdp.size() > 1024 * 1024)
    throw std::runtime_error("SDP exceeds 1 MiB");
  std::vector<SdpSection> result;
  std::string session_ufrag;
  std::istringstream lines(sdp);
  std::string line;
  while (std::getline(lines, line)) {
    if (!line.empty() && line.back() == '\r')
      line.pop_back();
    if (line.starts_with("m=")) {
      if (result.size() >= 64)
        throw std::runtime_error("Too many SDP sections");
      result.push_back(
          {line.substr(2, line.find(' ') - 2), {}, {}, session_ufrag});
    } else if (line.starts_with("a=ice-ufrag:")) {
      if (result.empty())
        session_ufrag = line.substr(12);
      else
        result.back().ufrag = line.substr(12);
    } else if (!result.empty() && line.starts_with("a=mid:")) {
      result.back().mid = line.substr(6);
    } else if (!result.empty() && line.starts_with("a=msid:")) {
      auto value = line.substr(7);
      result.back().stream = value.substr(0, value.find(' '));
    }
  }
  return result;
}
} // namespace

struct VoiceEngine::Impl : std::enable_shared_from_this<VoiceEngine::Impl> {
  struct Peer;
  struct SfuListener;
  explicit Impl(Callbacks value) : callbacks(std::move(value)) {}

  Callbacks callbacks;
  std::mutex queue_mutex;
  std::condition_variable queue_ready;
  std::deque<std::function<void()>> queue;
  std::multimap<Clock::time_point, std::function<void()>> timers;
  bool stopping = false;
  bool overloaded = false;
  std::thread::id control_id;
  std::mutex ingress_mutex;
  std::shared_ptr<CallToken> ingress_token;
  std::recursive_mutex audio_mutex;
  std::unique_ptr<webrtc::Thread> network;
  std::unique_ptr<webrtc::Thread> worker;
  std::unique_ptr<webrtc::Thread> signaling;
  std::optional<webrtc::Environment> environment;
  webrtc::scoped_refptr<PolicyAudioDevice> adm;
  std::shared_ptr<CallToken> audio_token;
  webrtc::scoped_refptr<webrtc::AudioProcessing> apm;
  webrtc::scoped_refptr<webrtc::PeerConnectionFactoryInterface> factory;
  std::shared_ptr<VideoCodecActivity> video_codec_activity;
  webrtc::scoped_refptr<webrtc::AudioSourceInterface> source;
  webrtc::scoped_refptr<webrtc::AudioTrackInterface> microphone;
  JoinConfig config;
  std::shared_ptr<CallToken> token;
  std::map<std::string, Participant> roster;
  std::map<std::string, std::shared_ptr<Peer>> peers;
  std::unique_ptr<SfuListener> sfu_listener;
  std::unique_ptr<mediasoupclient::Device> device;
  std::unique_ptr<mediasoupclient::SendTransport> send_transport;
  std::unique_ptr<mediasoupclient::RecvTransport> recv_transport;
  std::unique_ptr<mediasoupclient::Producer> producer;
  std::map<std::string, std::unique_ptr<mediasoupclient::Consumer>> consumers;
  std::map<std::string, Json> known_producers;
  std::set<std::string> closed_producers;
  std::map<std::string, std::string> sfu_transport_states;
  bool initialized = false;
  bool sfu_recovery_pending = false;
  unsigned sfu_recovery_attempts = 0;

  void Post(std::function<void()> task) {
    {
      std::lock_guard lock(queue_mutex);
      if (stopping)
        return;
      if (queue.size() >= 4096) {
        overloaded = true;
        queue_ready.notify_one();
        return;
      }
      queue.push_back(std::move(task));
    }
    queue_ready.notify_one();
  }
  void PostAfter(std::chrono::milliseconds delay, std::function<void()> task) {
    {
      std::lock_guard lock(queue_mutex);
      if (stopping)
        return;
      timers.emplace(Clock::now() + delay, std::move(task));
    }
    queue_ready.notify_one();
  }
  void Run() {
    control_id = std::this_thread::get_id();
    std::unique_lock lock(queue_mutex);
    for (;;) {
      while (queue.empty() && !stopping) {
        if (timers.empty())
          queue_ready.wait(lock);
        else if (timers.begin()->first <= Clock::now()) {
          queue.push_back(std::move(timers.begin()->second));
          timers.erase(timers.begin());
        } else
          queue_ready.wait_until(lock, timers.begin()->first);
      }
      if (queue.empty() && stopping)
        break;
      auto task = std::move(queue.front());
      queue.pop_front();
      lock.unlock();
      try {
        task();
      } catch (const Cancelled
                   &) { /* Cancellation is a terminal operation outcome. */
      } catch (const std::exception &error) {
        Fail(error.what());
      }
      lock.lock();
      if (overloaded) {
        overloaded = false;
        lock.unlock();
        Fail("Media event queue capacity exceeded");
        lock.lock();
      }
    }
    lock.unlock();
    Cleanup();
  }
  void Emit(EventKind kind, std::string detail = {}, std::string session = {},
            Json stats = Json::object()) {
    if (!callbacks.observe)
      return;
    try {
      callbacks.observe({kind, config.channel_id, std::move(session),
                         std::move(detail), std::move(stats)});
    } catch (const std::exception &error) {
      std::cerr << "Voice observer failed: " << error.what() << '\n';
    }
  }
  void Fail(const std::string &reason) {
    if (token)
      token->Cancel();
    Emit(EventKind::failed, reason);
    Cleanup();
  }
  bool Current(const std::shared_ptr<CallToken> &value) const {
    return token == value && !value->cancelled.load();
  }
  template <class F> void PeerOperation(const std::string &session, F task) {
    try {
      task();
    } catch (const Cancelled &) {
      throw;
    } catch (const std::exception &error) {
      // A peer's SDP/ICE failure must not close the other participants' audio.
      RetirePeer(session);
      Emit(EventKind::failed, error.what(), session);
    }
  }
  template <class F> void ForCall(std::shared_ptr<CallToken> value, F task) {
    auto weak = weak_from_this();
    Post([weak, value = std::move(value), task = std::move(task)]() mutable {
      if (auto self = weak.lock(); self && self->Current(value))
        task(*self);
    });
  }
  std::shared_ptr<CallToken> Ingress() {
    std::lock_guard lock(ingress_mutex);
    return ingress_token;
  }
  RpcResponse Request(std::string_view type, Json payload,
                      std::initializer_list<std::string_view> expected) {
    if (std::this_thread::get_id() != control_id)
      throw std::logic_error("Blocking SFU RPC outside media-control thread");
    auto call = token;
    call->CheckActive();
    auto waiting = std::make_shared<RpcWait>();
    call->Register(waiting);
    std::vector<std::string> types;
    for (auto item : expected)
      types.emplace_back(item);
    waiting->SetCancel(callbacks.request(
        std::string(type), std::move(payload), types,
        [waiting](RpcResult result) { waiting->Complete(std::move(result)); }));
    std::unique_lock lock(waiting->mutex);
    if (!waiting->ready.wait_for(lock, config.operation_timeout,
                                 [&] { return waiting->result.has_value(); })) {
      lock.unlock();
      waiting->Cancel();
      throw std::runtime_error("SFU RPC timed out: " + std::string(type));
    }
    auto result = std::move(*waiting->result);
    lock.unlock();
    call->CheckActive();
    if (const auto *error = std::get_if<RpcFailure>(&result))
      throw std::runtime_error("SFU RPC " + error->code + ": " +
                               error->message);
    auto response = std::get<RpcResponse>(std::move(result));
    if (std::find(types.begin(), types.end(), response.type) == types.end())
      throw std::runtime_error("Unexpected SFU response: " + response.type);
    if (Text(response.payload, "channelId") != config.channel_id)
      throw std::runtime_error("SFU response belongs to another channel");
    return response;
  }
  void Notify(std::string_view type, Json payload) {
    token->CheckActive();
    callbacks.notify(std::string(type), std::move(payload));
  }
  webrtc::PeerConnectionInterface::RTCConfiguration RtcConfig() const {
    webrtc::PeerConnectionInterface::RTCConfiguration result;
    result.sdp_semantics = webrtc::SdpSemantics::kUnifiedPlan;
    for (const auto &ice : config.ice_servers) {
      webrtc::PeerConnectionInterface::IceServer server;
      server.urls = ice.urls;
      server.username = ice.username;
      server.password = ice.credential;
      result.servers.push_back(std::move(server));
    }
    return result;
  }
  void InitializeAudio();
  void ApplyProcessing();
  void ApplyPolicy();
  void GateAudio(const std::shared_ptr<CallToken> &call);
  void EnsureMicrophone();
  void StopMicrophone(bool notify_server);
  std::string Cleanup();
  void Join(JoinConfig value, std::shared_ptr<CallToken> call);
  void Reconcile(std::vector<Participant> participants, bool newcomer);
  void CreatePeer(const Participant &participant, bool offer);
  void RetirePeer(const std::string &session);
  void Offer(Peer &peer, bool restart);
  void Signal(const Json &payload);
  void SetSdp(Peer &peer, bool local,
              std::unique_ptr<webrtc::SessionDescriptionInterface> description);
  void ConfigureTracks(Peer &peer);
  void FlushCandidates(Peer &peer);
  void PeerState(const std::shared_ptr<Peer> &peer,
                 webrtc::PeerConnectionInterface::PeerConnectionState state);
  void InitializeSfu();
  void ScheduleSfuRecovery();
  void RecoverSfu();
  void AddProducer(const Json &description);
  void Consume(const std::string &id);
  void CloseConsumer(const std::string &id);
  void Stats();
};

struct VoiceEngine::Impl::Peer : webrtc::PeerConnectionObserver,
                                 std::enable_shared_from_this<Peer> {
  std::weak_ptr<Impl> owner;
  std::shared_ptr<CallToken> token;
  Participant participant;
  webrtc::scoped_refptr<webrtc::PeerConnectionInterface> pc;
  webrtc::scoped_refptr<webrtc::RtpTransceiverInterface> mic_transceiver;
  std::vector<SdpSection> remote_sections;
  std::string mic_mid;
  std::set<std::string> screen_streams;
  struct PendingCandidate {
    Json value;
    Clock::time_point arrived;
    unsigned generation;
  };
  std::deque<PendingCandidate> candidates;
  std::set<std::string> retired_ufrags;
  bool making_offer = false;
  bool ignore_offer = false;
  bool polite = false;
  bool needs_offer = false;
  unsigned restarts = 0;
  unsigned reconnects = 0;
  unsigned remote_generation = 0;
  bool recovery_pending = false;
  std::atomic<bool> retired{false};

  template <class F> void Dispatch(F callback) {
    if (retired.load())
      return;
    if (auto self = owner.lock()) {
      auto weak = weak_from_this();
      self->ForCall(
          token, [weak, callback = std::move(callback)](Impl &engine) {
            if (auto peer = weak.lock(); peer && !peer->retired.load())
              engine.PeerOperation(peer->participant.session_id,
                                   [&] { callback(engine, peer); });
          });
    }
  }
  void OnSignalingChange(
      webrtc::PeerConnectionInterface::SignalingState state) override {
    Dispatch([state](Impl &engine, const auto &peer) {
      engine.Emit(EventKind::stats, "P2P signaling state",
                  peer->participant.session_id,
                  {{"signalingState", static_cast<int>(state)}});
    });
  }
  void OnDataChannel(
      webrtc::scoped_refptr<webrtc::DataChannelInterface> channel) override {
    channel->Close();
  }
  void OnIceGatheringChange(
      webrtc::PeerConnectionInterface::IceGatheringState state) override {
    Dispatch([state](Impl &engine, const auto &peer) {
      engine.Emit(EventKind::stats, "P2P ICE gathering state",
                  peer->participant.session_id,
                  {{"iceGatheringState", static_cast<int>(state)}});
    });
  }
  void OnIceCandidate(const webrtc::IceCandidate *candidate) override {
    std::string text;
    if (!candidate->ToString(&text))
      return;
    Json value{{"candidate", text},
               {"sdpMid", candidate->sdp_mid()},
               {"sdpMLineIndex", candidate->sdp_mline_index()},
               {"usernameFragment", candidate->candidate().username()}};
    Dispatch([value = std::move(value)](Impl &engine, const auto &peer) {
      engine.Notify(msg::RTC_SIGNAL,
                    {{"targetSessionId", peer->participant.session_id},
                     {"fromSessionId", engine.config.self_session_id},
                     {"signalType", "candidate"},
                     {"candidate", value}});
    });
  }
  void OnTrack(webrtc::scoped_refptr<webrtc::RtpTransceiverInterface>
                   transceiver) override {
    // Default-deny until SDP metadata and same-user policy classify this track.
    if (auto track = transceiver->receiver()->track())
      track->set_enabled(false);
    Dispatch(
        [](Impl &engine, const auto &peer) { engine.ConfigureTracks(*peer); });
  }
  void OnConnectionChange(
      webrtc::PeerConnectionInterface::PeerConnectionState state) override {
    Dispatch([state](Impl &engine, const auto &peer) {
      engine.PeerState(peer, state);
    });
  }
};

struct VoiceEngine::Impl::SfuListener
    : mediasoupclient::SendTransport::Listener,
      mediasoupclient::RecvTransport::Listener,
      mediasoupclient::Producer::Listener,
      mediasoupclient::Consumer::Listener {
  std::weak_ptr<Impl> owner;
  std::shared_ptr<CallToken> token;
  std::future<void> OnConnect(mediasoupclient::Transport *transport,
                              const Json &dtls) override {
    auto self = owner.lock();
    if (!self)
      throw Cancelled();
    token->CheckActive();
    auto response = self->Request(msg::SFU_CONNECT_WEBRTC_TRANSPORT,
                                  {{"channelId", self->config.channel_id},
                                   {"transportId", transport->GetId()},
                                   {"dtlsParameters", dtls}},
                                  {msg::SFU_WEBRTC_TRANSPORT_CONNECTED});
    if (Text(response.payload, "transportId") != transport->GetId())
      throw std::runtime_error(
          "SFU connected acknowledgment has wrong transport");
    std::promise<void> promise;
    promise.set_value();
    return promise.get_future();
  }
  std::future<std::string> OnProduce(mediasoupclient::SendTransport *transport,
                                     const std::string &kind, Json parameters,
                                     const Json &app_data) override {
    auto self = owner.lock();
    if (!self)
      throw Cancelled();
    token->CheckActive();
    auto response = self->Request(msg::SFU_PRODUCE,
                                  {{"channelId", self->config.channel_id},
                                   {"transportId", transport->GetId()},
                                   {"kind", kind},
                                   {"rtpParameters", std::move(parameters)},
                                   {"appData", app_data}},
                                  {msg::SFU_PRODUCED});
    std::promise<std::string> promise;
    promise.set_value(Text(response.payload, "id"));
    return promise.get_future();
  }
  std::future<std::string> OnProduceData(mediasoupclient::SendTransport *,
                                         const Json &, const std::string &,
                                         const std::string &,
                                         const Json &) override {
    throw std::logic_error("Data production is outside the voice milestone");
  }
  void OnConnectionStateChange(mediasoupclient::Transport *transport,
                               const std::string &state) override {
    if (auto self = owner.lock()) {
      const auto id = transport->GetId();
      self->ForCall(token, [id, state](Impl &engine) {
        if ((!engine.send_transport || engine.send_transport->GetId() != id) &&
            (!engine.recv_transport || engine.recv_transport->GetId() != id))
          return;
        engine.sfu_transport_states[id] = state;
        if (state == "connected" || state == "completed")
          engine.Emit(EventKind::connected, "SFU transport " + id);
        else if (state == "disconnected" || state == "failed")
          engine.ScheduleSfuRecovery();
      });
    }
  }
  void OnTransportClose(mediasoupclient::Producer *) override {
    ReportClose("SFU send transport closed");
  }
  void OnTransportClose(mediasoupclient::Consumer *) override {
    ReportClose("SFU receive transport closed");
  }
  void ReportClose(std::string reason) {
    if (auto self = owner.lock())
      self->ForCall(token, [reason = std::move(reason)](Impl &engine) {
        engine.Emit(EventKind::warning, reason);
      });
  }
};

void VoiceEngine::Impl::InitializeAudio() {
  // The native ADM retains a task-queue-factory pointer from this environment.
  // Keep its utilities alive through ADM/APM teardown, not just construction.
  environment.emplace(webrtc::CreateEnvironment());
  {
    std::lock_guard lock(audio_mutex);
    network = webrtc::Thread::CreateWithSocketServer();
    worker = webrtc::Thread::Create();
    signaling = webrtc::Thread::Create();
    if (!network || !worker || !signaling)
      throw std::runtime_error("Could not allocate WebRTC threads");
    network->SetName("monky-ice", nullptr);
    worker->SetName("monky-audio", nullptr);
    signaling->SetName("monky-sdp", nullptr);
    if (!network->Start() || !worker->Start() || !signaling->Start())
      throw std::runtime_error("Could not start WebRTC threads");
  }
  std::exception_ptr initialization_error;
  webrtc::scoped_refptr<PolicyAudioDevice> audio;
  webrtc::scoped_refptr<webrtc::AudioProcessing> processing;
  worker->BlockingCall([this, &initialization_error, &audio, &processing] {
    try {
      auto native = callbacks.create_audio_device(*environment);
      if (!native)
        throw std::runtime_error("Audio device factory returned null");
      audio = webrtc::make_ref_counted<PolicyAudioDevice>(std::move(native));
      processing = webrtc::BuiltinAudioProcessingBuilder().Build(*environment);
      if (!processing)
        throw std::runtime_error("Could not create audio processing module");
    } catch (...) {
      // Exceptions cannot escape a WebRTC task; propagate to media control.
      initialization_error = std::current_exception();
    }
  });
  if (initialization_error)
    std::rethrow_exception(initialization_error);
  {
    std::lock_guard lock(audio_mutex);
    adm = std::move(audio);
    apm = std::move(processing);
    audio_token = token;
  }
  token->CheckActive();
  video_codec_activity = std::make_shared<VideoCodecActivity>();
  factory = webrtc::CreatePeerConnectionFactory(
      network.get(), worker.get(), signaling.get(), adm,
      webrtc::CreateBuiltinAudioEncoderFactory(),
      webrtc::CreateBuiltinAudioDecoderFactory(),
      std::make_unique<NegotiationVideoEncoderFactory>(video_codec_activity),
      std::make_unique<NegotiationVideoDecoderFactory>(video_codec_activity), nullptr, apm);
  if (!factory)
    throw std::runtime_error("Could not create audio PeerConnectionFactory");
  if (config.network_ignore_mask) {
    webrtc::PeerConnectionFactoryInterface::Options options;
    options.network_ignore_mask = *config.network_ignore_mask;
    factory->SetOptions(options);
  }
  token->CheckActive();
  ApplyProcessing();
}

void VoiceEngine::Impl::ApplyProcessing() {
  webrtc::AudioProcessing::Config processing;
  processing.echo_canceller.enabled = config.policy.echo_cancellation;
  processing.echo_canceller.mobile_mode = false;
  processing.gain_controller1.enabled = config.policy.automatic_gain;
  processing.gain_controller2.enabled = false;
  processing.noise_suppression.enabled =
      config.policy.noise_suppression != NoiseSuppression::off;
  using Level = webrtc::AudioProcessing::Config::NoiseSuppression;
  switch (config.policy.noise_suppression) {
  case NoiseSuppression::off:
  case NoiseSuppression::low:
    processing.noise_suppression.level = Level::kLow;
    break;
  case NoiseSuppression::moderate:
    processing.noise_suppression.level = Level::kModerate;
    break;
  case NoiseSuppression::high:
    processing.noise_suppression.level = Level::kHigh;
    break;
  case NoiseSuppression::very_high:
    processing.noise_suppression.level = Level::kVeryHigh;
    break;
  }
  worker->BlockingCall([this, processing] { apm->ApplyConfig(processing); });
}

void VoiceEngine::Impl::GateAudio(const std::shared_ptr<CallToken> &call) {
  std::lock_guard lock(audio_mutex);
  if (!worker || !adm || audio_token != call)
    return;
  auto audio = adm;
  auto weak = weak_from_this();
  worker->PostTask([audio, call, weak] {
    const bool active = !call->cancelled.load();
    const bool output = active && !call->deafened.load();
    if (audio->SetPolicy(output && !call->muted.load(), output) != 0) {
      if (auto self = weak.lock())
        self->ForCall(call, [](Impl &engine) {
          engine.Fail("Native audio device failed to apply mute/deafen policy");
        });
    }
  });
}

void VoiceEngine::Impl::EnsureMicrophone() {
  if (microphone || token->muted.load() || token->deafened.load())
    return;
  source = factory->CreateAudioSource(webrtc::AudioOptions{});
  if (!source)
    throw std::runtime_error("Could not create microphone source");
  microphone = factory->CreateAudioTrack("monky-microphone", source.get());
  if (!microphone)
    throw std::runtime_error("Could not create microphone track");
  for (auto &[id, peer] : peers)
    if (!peer->mic_transceiver->sender()->SetTrack(microphone.get()))
      throw std::runtime_error("Could not attach microphone to peer " + id);
  if (send_transport) {
    Json codec_options{{"opusDtx", true}};
    producer.reset(send_transport->Produce(sfu_listener.get(), microphone.get(),
                                           nullptr, &codec_options, nullptr,
                                           {{"mediaType", "mic"}}));
    if (!producer)
      throw std::runtime_error("SFU microphone production returned null");
  }
  ApplyProcessing();
}

void VoiceEngine::Impl::StopMicrophone(bool notify_server) {
  if (producer) {
    const auto id = producer->GetId();
    producer->Close();
    producer.reset();
    if (notify_server)
      Notify(msg::SFU_PRODUCER_CLOSED,
             {{"channelId", config.channel_id}, {"producerId", id}});
  }
  for (auto &[id, peer] : peers)
    if (!peer->mic_transceiver->sender()->SetTrack(nullptr))
      throw std::runtime_error("Could not detach microphone from peer " + id);
  microphone = nullptr;
  source = nullptr;
}

void VoiceEngine::Impl::ApplyPolicy() {
  token->CheckActive();
  const bool deafened = token->deafened.load();
  const bool muted = token->muted.load() || deafened;
  // Stop physical capture before potentially blocking SFU close/produce calls.
  if (muted || deafened) {
    const auto result = worker->BlockingCall([this] {
      const bool output = !token->cancelled.load() && !token->deafened.load();
      return adm->SetPolicy(output && !token->muted.load(), output);
    });
    if (result != 0)
      throw std::runtime_error("Native audio device policy failed");
  }
  if (muted)
    StopMicrophone(true);
  else
    EnsureMicrophone();
  for (auto &[id, peer] : peers)
    ConfigureTracks(*peer);
  for (auto &[id, consumer] : consumers) {
    if (consumer->IsPaused() == deafened)
      continue;
    if (deafened)
      consumer->Pause();
    else
      consumer->Resume();
    Notify(msg::SFU_CONSUMER_SET_PAUSED, {{"channelId", config.channel_id},
                                          {"consumerId", consumer->GetId()},
                                          {"paused", deafened}});
  }
  ApplyProcessing();
  token->CheckActive();
  const auto result = worker->BlockingCall([this] {
    const bool output = !token->cancelled.load() && !token->deafened.load();
    return adm->SetPolicy(output && !token->muted.load(), output);
  });
  if (result != 0)
    throw std::runtime_error("Native audio device failed to start");
}

std::string VoiceEngine::Impl::Cleanup() {
  if (token)
    token->Cancel();
  std::string failures;
  auto attempt = [this, &failures](const char *label, auto operation) {
    try {
      operation();
    } catch (const std::exception &error) {
      const auto failure =
          std::string("Cleanup ") + label + ": " + error.what();
      if (!failures.empty())
        failures += "; ";
      failures += failure;
      Emit(EventKind::warning, failure);
    }
  };
  if (worker && adm)
    attempt("audio stop", [this] {
      const auto result =
          worker->BlockingCall([this] { return adm->SetPolicy(false, false); });
      if (result != 0)
        throw std::runtime_error("Native ADM stop failed");
    });
  for (auto &[id, peer] : peers) {
    peer->retired.store(true);
    attempt("peer close", [&] { peer->pc->Close(); });
    peer->mic_transceiver = nullptr;
    peer->pc = nullptr;
  }
  peers.clear();
  if (producer)
    attempt("producer close", [this] { producer->Close(); });
  producer.reset();
  for (auto &[id, consumer] : consumers)
    attempt("consumer close", [&] { consumer->Close(); });
  consumers.clear();
  if (send_transport)
    attempt("send transport close", [this] { send_transport->Close(); });
  if (recv_transport)
    attempt("receive transport close", [this] { recv_transport->Close(); });
  send_transport.reset();
  recv_transport.reset();
  device.reset();
  sfu_listener.reset();
  known_producers.clear();
  closed_producers.clear();
  sfu_transport_states.clear();
  microphone = nullptr;
  source = nullptr;
  factory = nullptr;
  video_codec_activity.reset();
  {
    std::lock_guard lock(audio_mutex);
    if (worker && adm)
      attempt("device terminate", [this] {
        const int result = worker->BlockingCall([this] {
          const int result = adm->Terminate();
          adm = nullptr;
          apm = nullptr;
          return result;
        });
        if (result != 0)
          throw std::runtime_error("Native ADM termination failed");
      });
    if (signaling)
      signaling->Stop();
    if (worker)
      worker->Stop();
    if (network)
      network->Stop();
    signaling.reset();
    worker.reset();
    network.reset();
    adm = nullptr;
    apm = nullptr;
    audio_token.reset();
  }
  environment.reset();
  initialized = false;
  sfu_recovery_pending = false;
  sfu_recovery_attempts = 0;
  roster.clear();
  token.reset();
  return failures;
}

void VoiceEngine::Impl::Join(JoinConfig value,
                             std::shared_ptr<CallToken> call) {
  Cleanup();
  call->CheckActive();
  config = std::move(value);
  token = std::move(call);
  if (config.self_user_id.empty() || config.self_session_id.empty() ||
      config.channel_id.empty() || config.operation_timeout.count() <= 0)
    throw std::runtime_error("Invalid admitted voice configuration");
  if (config.admitted_participants.size() > 1024)
    throw std::runtime_error("Voice roster too large");
  std::set<std::string> admitted_sessions;
  for (const auto &participant : config.admitted_participants) {
    if (participant.user_id.empty() || participant.session_id.empty() ||
        !admitted_sessions.insert(participant.session_id).second)
      throw std::runtime_error("Invalid or duplicate admission roster session");
  }
  auto self = std::find_if(config.admitted_participants.begin(),
                           config.admitted_participants.end(),
                           [this](const Participant &item) {
                             return item.user_id == config.self_user_id &&
                                    item.session_id == config.self_session_id;
                           });
  if (self == config.admitted_participants.end())
    throw std::runtime_error(
        "Authoritative admission roster does not contain self");
  Emit(EventKind::admitted, "Authoritative voice admission accepted");
  token->CheckActive();
  InitializeAudio();
  // Gate remains closed during transport setup; admission alone publishes
  // nothing.
  Reconcile(config.admitted_participants, false);
  if (config.mode == VoiceMode::sfu)
    InitializeSfu();
  ApplyPolicy();
  if (config.mode == VoiceMode::p2p) {
    for (auto entry = peers.begin(); entry != peers.end();) {
      auto peer = entry++->second;
      PeerOperation(peer->participant.session_id, [&] { Offer(*peer, false); });
    }
  }
  token->CheckActive();
  initialized = true;
  Emit(EventKind::initialized,
       peers.empty() && consumers.empty()
           ? "Voice initialized; no remote microphone connected"
           : "Voice initialized; remote audio must be verified with stats");
  token->CheckActive();
}

void VoiceEngine::Impl::Reconcile(std::vector<Participant> participants,
                                  bool newcomer) {
  if (participants.size() > 1024)
    throw std::runtime_error("Voice roster too large");
  std::map<std::string, Participant> next;
  for (auto &participant : participants) {
    if (participant.session_id.empty() || participant.user_id.empty() ||
        !next.emplace(participant.session_id, participant).second)
      throw std::runtime_error("Invalid or duplicate participant session");
  }
  const auto self = next.find(config.self_session_id);
  if (self == next.end() || self->second.user_id != config.self_user_id)
    throw std::runtime_error("Voice membership was removed");
  std::vector<std::string> removed;
  for (auto &[id, peer] : peers) {
    const auto found = next.find(id);
    if (found == next.end() ||
        found->second.user_id != peer->participant.user_id)
      removed.push_back(id);
  }
  for (const auto &id : removed)
    RetirePeer(id);
  roster = std::move(next);
  if (config.mode == VoiceMode::p2p) {
    for (const auto &[id, participant] : roster)
      if (id != config.self_session_id && !peers.contains(id))
        PeerOperation(id, [&] { CreatePeer(participant, newcomer); });
  } else {
    std::vector<std::string> remove_consumers;
    for (const auto &[id, consumer] : consumers) {
      const auto found = known_producers.find(id);
      if (found == known_producers.end())
        continue;
      const auto session = Text(found->second, "producerSessionId");
      const auto member = roster.find(session);
      if (member == roster.end() ||
          member->second.user_id == config.self_user_id)
        remove_consumers.push_back(id);
    }
    for (const auto &id : remove_consumers)
      CloseConsumer(id);
    if (recv_transport) {
      std::vector<std::string> pending;
      for (const auto &[id, description] : known_producers)
        pending.push_back(id);
      for (const auto &id : pending)
        Consume(id);
    }
  }
}

void VoiceEngine::Impl::CreatePeer(const Participant &participant, bool offer) {
  auto peer = std::make_shared<Peer>();
  peer->owner = weak_from_this();
  peer->token = token;
  peer->participant = participant;
  peer->polite = config.self_session_id < participant.session_id;
  auto result = factory->CreatePeerConnectionOrError(
      RtcConfig(), webrtc::PeerConnectionDependencies(peer.get()));
  if (!result.ok())
    Check(result.error(), "Create peer connection");
  peer->pc = result.MoveValue();
  webrtc::RtpTransceiverInit init;
  init.direction = webrtc::RtpTransceiverDirection::kSendRecv;
  init.stream_ids = {"monky-mic-" + config.self_session_id};
  auto transceiver = peer->pc->AddTransceiver(webrtc::MediaType::AUDIO, init);
  if (!transceiver.ok()) {
    peer->pc->Close();
    Check(transceiver.error(), "Create microphone transceiver");
  }
  peer->mic_transceiver = transceiver.MoveValue();
  if (microphone &&
      !peer->mic_transceiver->sender()->SetTrack(microphone.get())) {
    peer->pc->Close();
    throw std::runtime_error("Attach microphone failed");
  }
  peers.emplace(participant.session_id, peer);
  if (offer)
    Offer(*peer, false);
}

void VoiceEngine::Impl::RetirePeer(const std::string &session) {
  const auto found = peers.find(session);
  if (found == peers.end())
    return;
  auto peer = found->second;
  peer->retired.store(true);
  peer->pc->Close();
  peer->mic_transceiver = nullptr;
  peer->pc = nullptr;
  peers.erase(found);
}

void VoiceEngine::Impl::SetSdp(
    Peer &peer, bool local,
    std::unique_ptr<webrtc::SessionDescriptionInterface> description) {
  auto observer = webrtc::make_ref_counted<SetSdpObserver>();
  auto future = observer->promise.get_future();
  if (local)
    peer.pc->SetLocalDescription(observer.get(), description.release());
  else
    peer.pc->SetRemoteDescription(observer.get(), description.release());
  Await(future, token, config.operation_timeout);
}

void VoiceEngine::Impl::Offer(Peer &peer, bool restart) {
  if (peer.pc->signaling_state() != webrtc::PeerConnectionInterface::kStable) {
    peer.needs_offer = true;
    return;
  }
  peer.making_offer = true;
  auto observer = webrtc::make_ref_counted<CreateSdpObserver>();
  auto future = observer->promise.get_future();
  webrtc::PeerConnectionInterface::RTCOfferAnswerOptions options;
  options.ice_restart = restart;
  peer.pc->CreateOffer(observer.get(), options);
  auto description = Await(future, token, config.operation_timeout);
  std::string sdp;
  if (!description->ToString(&sdp))
    throw std::runtime_error("Serialize offer failed");
  SetSdp(peer, true, std::move(description));
  peer.making_offer = false;
  peer.needs_offer = false;
  Notify(msg::RTC_SIGNAL, {{"targetSessionId", peer.participant.session_id},
                           {"fromSessionId", config.self_session_id},
                           {"signalType", "offer"},
                           {"sdp", {{"type", "offer"}, {"sdp", sdp}}}});
  ApplyProcessing();
}

void VoiceEngine::Impl::ConfigureTracks(Peer &peer) {
  if (peer.mic_mid.empty()) {
    const auto found =
        std::find_if(peer.remote_sections.begin(), peer.remote_sections.end(),
                     [&](const SdpSection &section) {
                       return section.kind == "audio" &&
                              !peer.screen_streams.contains(section.stream);
                     });
    if (found != peer.remote_sections.end())
      peer.mic_mid = found->mid;
  }
  for (auto &transceiver : peer.pc->GetTransceivers()) {
    const auto mid = transceiver->mid();
    bool mic =
        transceiver->media_type() == webrtc::MediaType::AUDIO &&
        (mid && !peer.mic_mid.empty() ? *mid == peer.mic_mid
                                      : transceiver == peer.mic_transceiver);
    if (mic && mid) {
      for (const auto &section : peer.remote_sections)
        if (section.mid == *mid && peer.screen_streams.contains(section.stream))
          mic = false;
    }
    const bool listen = mic &&
                        peer.participant.user_id != config.self_user_id &&
                        !token->deafened.load();
    if (auto track = transceiver->receiver()->track())
      track->set_enabled(listen);
    if (transceiver->media_type() == webrtc::MediaType::VIDEO) {
      if (!transceiver->stopped())
        Check(transceiver->StopStandard(), "Reject video transceiver");
      continue;
    }
    if (!transceiver->stopped()) {
      auto direction = mic ? webrtc::RtpTransceiverDirection::kSendRecv
                           : webrtc::RtpTransceiverDirection::kInactive;
      if (mic && peer.participant.user_id == config.self_user_id)
        direction = webrtc::RtpTransceiverDirection::kSendOnly;
      Check(transceiver->SetDirectionWithError(direction),
            "Set voice media direction");
    }
    if (mic) {
      peer.mic_transceiver = transceiver;
      if (!transceiver->sender()->SetTrack(microphone.get()))
        throw std::runtime_error("Set primary microphone track failed");
    } else if (transceiver->sender()->track()) {
      if (!transceiver->sender()->SetTrack(nullptr))
        throw std::runtime_error("Detach unsupported media track failed");
    }
  }
}

void VoiceEngine::Impl::Signal(const Json &payload) {
  if (config.mode != VoiceMode::p2p)
    return;
  const auto session = Text(payload, "fromSessionId");
  const auto target = payload.find("targetSessionId");
  if (target != payload.end() && *target != config.self_session_id)
    return;
  const auto found = peers.find(session);
  if (found == peers.end())
    return; // Membership, never signaling, creates a peer.
  auto peer = found->second;
  const auto type = Text(payload, "signalType");
  if (type == "screen-audio-meta") {
    if (peer->screen_streams.size() >= 64)
      throw std::runtime_error("Too many screen stream identifiers");
    peer->screen_streams.insert(Text(payload, "streamId"));
    ConfigureTracks(*peer);
    return;
  }
  if (type == "candidate") {
    const auto &candidate = payload.at("candidate");
    if (candidate.is_null())
      return;
    if (Text(candidate, "candidate").size() > 8192)
      throw std::runtime_error("ICE candidate too large");
    if (peer->ignore_offer && !candidate.contains("usernameFragment"))
      return;
    if (peer->candidates.size() >= 256)
      peer->candidates.pop_front();
    peer->candidates.push_back(
        {candidate, Clock::now(), std::max(1u, peer->remote_generation)});
    FlushCandidates(*peer);
    return;
  }
  if (type != "offer" && type != "answer")
    return;
  const auto &envelope = payload.at("sdp");
  if (Text(envelope, "type") != type)
    throw std::runtime_error("RTC signal SDP type mismatch");
  const auto sdp = Text(envelope, "sdp");
  auto sections = Sections(sdp);
  const bool collision =
      type == "offer" &&
      (peer->making_offer ||
       peer->pc->signaling_state() != webrtc::PeerConnectionInterface::kStable);
  peer->ignore_offer = collision && !peer->polite;
  if (peer->ignore_offer) {
    for (const auto &section : sections)
      if (!section.ufrag.empty() &&
          std::none_of(peer->remote_sections.begin(),
                       peer->remote_sections.end(), [&](const auto &current) {
                         return current.ufrag == section.ufrag;
                       }))
        peer->retired_ufrags.insert(section.ufrag);
    while (peer->retired_ufrags.size() > 32)
      peer->retired_ufrags.erase(peer->retired_ufrags.begin());
    return;
  }
  if (type == "answer" && peer->pc->signaling_state() !=
                              webrtc::PeerConnectionInterface::kHaveLocalOffer)
    return; // Late answer for a rolled-back or retired offer.
  if (collision) {
    auto rollback =
        webrtc::CreateSessionDescription(webrtc::SdpType::kRollback, "");
    if (!rollback)
      throw std::runtime_error("Could not create SDP rollback");
    SetSdp(*peer, true, std::move(rollback));
    peer->making_offer = false;
  }
  webrtc::SdpParseError parse_error;
  auto description = webrtc::CreateSessionDescription(
      type == "offer" ? webrtc::SdpType::kOffer : webrtc::SdpType::kAnswer, sdp,
      &parse_error);
  if (!description)
    throw std::runtime_error("Invalid remote SDP: " + parse_error.description);
  for (const auto &old : peer->remote_sections) {
    if (!old.ufrag.empty() &&
        std::none_of(sections.begin(), sections.end(),
                     [&](const auto &item) { return item.ufrag == old.ufrag; }))
      peer->retired_ufrags.insert(old.ufrag);
  }
  while (peer->retired_ufrags.size() > 32)
    peer->retired_ufrags.erase(peer->retired_ufrags.begin());
  SetSdp(*peer, false, std::move(description));
  if (peer->remote_sections.empty() ||
      std::any_of(sections.begin(), sections.end(), [&](const auto &section) {
        return std::none_of(peer->remote_sections.begin(),
                            peer->remote_sections.end(), [&](const auto &old) {
                              return old.mid == section.mid &&
                                     old.ufrag == section.ufrag;
                            });
      }))
    ++peer->remote_generation;
  peer->remote_sections = std::move(sections);
  ConfigureTracks(*peer);
  FlushCandidates(*peer);
  if (type == "offer") {
    auto observer = webrtc::make_ref_counted<CreateSdpObserver>();
    auto future = observer->promise.get_future();
    peer->pc->CreateAnswer(
        observer.get(),
        webrtc::PeerConnectionInterface::RTCOfferAnswerOptions{});
    auto answer = Await(future, token, config.operation_timeout);
    std::string answer_sdp;
    if (!answer->ToString(&answer_sdp))
      throw std::runtime_error("Serialize answer failed");
    SetSdp(*peer, true, std::move(answer));
    Notify(msg::RTC_SIGNAL,
           {{"targetSessionId", session},
            {"fromSessionId", config.self_session_id},
            {"signalType", "answer"},
            {"sdp", {{"type", "answer"}, {"sdp", answer_sdp}}}});
  }
  ApplyProcessing();
  if (peer->needs_offer)
    Offer(*peer, true);
}

void VoiceEngine::Impl::FlushCandidates(Peer &peer) {
  if (peer.remote_sections.empty())
    return;
  auto pending = std::move(peer.candidates);
  peer.candidates.clear();
  for (auto &candidate : pending) {
    if (Clock::now() - candidate.arrived > std::chrono::seconds(30))
      continue;
    const auto &json = candidate.value;
    const auto ufrag_value = json.find("usernameFragment");
    const std::string ufrag =
        ufrag_value != json.end() && ufrag_value->is_string()
            ? ufrag_value->get<std::string>()
            : "";
    if (ufrag.empty() && candidate.generation != peer.remote_generation)
      continue;
    if (!ufrag.empty() && peer.retired_ufrags.contains(ufrag))
      continue;
    const auto mid_value = json.find("sdpMid");
    const std::string mid = mid_value != json.end() && mid_value->is_string()
                                ? mid_value->get<std::string>()
                                : "";
    const auto index_value = json.find("sdpMLineIndex");
    int index = index_value != json.end() && index_value->is_number_integer()
                    ? index_value->get<int>()
                    : -1;
    const SdpSection *section = nullptr;
    if (!mid.empty()) {
      const auto found =
          std::find_if(peer.remote_sections.begin(), peer.remote_sections.end(),
                       [&](const auto &item) { return item.mid == mid; });
      if (found != peer.remote_sections.end()) {
        section = &*found;
        index = static_cast<int>(found - peer.remote_sections.begin());
      }
    } else if (index >= 0 &&
               static_cast<size_t>(index) < peer.remote_sections.size())
      section = &peer.remote_sections[static_cast<size_t>(index)];
    if (!section || (!ufrag.empty() && section->ufrag != ufrag)) {
      peer.candidates.push_back(std::move(candidate)); // Future ICE generation.
      continue;
    }
    webrtc::SdpParseError error;
    std::unique_ptr<webrtc::IceCandidate> parsed(webrtc::CreateIceCandidate(
        section->mid, index, Text(json, "candidate"), &error));
    if (!parsed) {
      Emit(EventKind::warning, "Invalid ICE candidate: " + error.description,
           peer.participant.session_id);
      continue;
    }
    if (!peer.pc->AddIceCandidate(parsed.get()))
      Emit(EventKind::warning, "ICE candidate rejected",
           peer.participant.session_id);
  }
}

void VoiceEngine::Impl::PeerState(
    const std::shared_ptr<Peer> &peer,
    webrtc::PeerConnectionInterface::PeerConnectionState state) {
  using State = webrtc::PeerConnectionInterface::PeerConnectionState;
  if (state == State::kConnected) {
    peer->restarts = 0;
    peer->reconnects = 0;
    Emit(EventKind::connected, "P2P ICE/DTLS connected",
         peer->participant.session_id);
  } else if (state == State::kDisconnected || state == State::kFailed) {
    if (peer->recovery_pending)
      return;
    peer->recovery_pending = true;
    Emit(EventKind::reconnecting, "P2P ICE recovery",
         peer->participant.session_id);
    auto weak = weak_from_this();
    const auto weak_peer = std::weak_ptr<Peer>(peer);
    const auto call = token;
    const auto delay =
        std::chrono::seconds(3u + (1u << std::min(peer->reconnects, 2u)));
    PostAfter(delay, [weak, weak_peer, call] {
      auto self = weak.lock();
      auto current = weak_peer.lock();
      if (!self || !self->Current(call) || !current || current->retired.load())
        return;
      const auto session = current->participant.session_id;
      self->PeerOperation(session, [&] {
        current->recovery_pending = false;
        if (current->pc->peer_connection_state() == State::kConnected)
          return;
        if (current->restarts++ < 2) {
          current->pc->RestartIce();
          self->Offer(*current, true);
        } else if (current->reconnects < 3) {
          auto participant = current->participant;
          const auto reconnects = current->reconnects + 1;
          self->RetirePeer(session);
          self->CreatePeer(participant, true);
          current = self->peers.at(session);
          current->reconnects = reconnects;
        } else {
          self->RetirePeer(session);
          self->Emit(EventKind::failed, "P2P recovery exhausted", session);
          return;
        }
        self->PeerState(current, State::kFailed);
      });
    });
  }
}

void VoiceEngine::Impl::InitializeSfu() {
  sfu_listener = std::make_unique<SfuListener>();
  sfu_listener->owner = weak_from_this();
  sfu_listener->token = token;
  auto capabilities = Request(msg::SFU_GET_ROUTER_RTP_CAPABILITIES,
                              {{"channelId", config.channel_id}},
                              {msg::SFU_ROUTER_RTP_CAPABILITIES});
  mediasoupclient::PeerConnection::Options options;
  options.factory = factory.get();
  options.config = RtcConfig();
  device = std::make_unique<mediasoupclient::Device>();
  device->Load(capabilities.payload.at("rtpCapabilities"), &options);
  if (!device->CanProduce("audio"))
    throw std::runtime_error(
        "SFU router does not support native audio production");

  for (const std::string direction : {"send", "recv"}) {
    auto response =
        Request(msg::SFU_CREATE_WEBRTC_TRANSPORT,
                {{"channelId", config.channel_id}, {"direction", direction}},
                {msg::SFU_WEBRTC_TRANSPORT_CREATED});
    if (Text(response.payload, "direction") != direction)
      throw std::runtime_error("SFU transport has incorrect direction");
    const auto &transport = response.payload.at("transportOptions");
    const auto id = Text(transport, "id");
    if (direction == "send") {
      send_transport.reset(device->CreateSendTransport(
          sfu_listener.get(), id, transport.at("iceParameters"),
          transport.at("iceCandidates"), transport.at("dtlsParameters"),
          &options));
      if (!send_transport)
        throw std::runtime_error("Null SFU send transport");
    } else {
      recv_transport.reset(device->CreateRecvTransport(
          sfu_listener.get(), id, transport.at("iceParameters"),
          transport.at("iceCandidates"), transport.at("dtlsParameters"),
          &options));
      if (!recv_transport)
        throw std::runtime_error("Null SFU receive transport");
    }
  }
  // producer_added/closed already enqueue on this call before snapshot
  // discovery.
  auto response =
      Request(msg::SFU_GET_PRODUCERS, {{"channelId", config.channel_id}},
              {msg::SFU_PRODUCERS_LIST});
  std::vector<Participant> participants;
  for (const auto &member : response.payload.at("participants")) {
    const auto &user = member.at("user");
    const auto &state = member.at("voiceState");
    if (Text(state, "channelId") != config.channel_id)
      throw std::runtime_error("SFU roster includes another channel");
    participants.push_back({Text(user, "id"), Text(state, "sessionId")});
  }
  Reconcile(std::move(participants), false);
  for (const auto &item : response.payload.at("producers"))
    AddProducer(item);
  ApplyProcessing();
}

void VoiceEngine::Impl::ScheduleSfuRecovery() {
  if (sfu_recovery_pending)
    return;
  if (sfu_recovery_attempts >= 5) {
    Fail("SFU reconnection exhausted; no P2P fallback attempted");
    return;
  }
  sfu_recovery_pending = true;
  const unsigned seconds = std::min(15u, 1u << sfu_recovery_attempts);
  Emit(EventKind::reconnecting,
       "Retrying SFU transport in " + std::to_string(seconds) + " seconds");
  const auto call = token;
  auto weak = weak_from_this();
  PostAfter(std::chrono::seconds(seconds), [weak, call] {
    if (auto self = weak.lock(); self && self->Current(call)) {
      self->sfu_recovery_pending = false;
      const auto unhealthy = [&](const auto &transport) {
        if (!transport)
          return true;
        const auto found = self->sfu_transport_states.find(transport->GetId());
        return found != self->sfu_transport_states.end() &&
               (found->second == "disconnected" || found->second == "failed");
      };
      if (!unhealthy(self->send_transport) && !unhealthy(self->recv_transport))
        return;
      self->RecoverSfu();
    }
  });
}

void VoiceEngine::Impl::RecoverSfu() {
  ++sfu_recovery_attempts;
  try {
    const int stopped =
        worker->BlockingCall([this] { return adm->SetPolicy(false, false); });
    if (stopped != 0)
      throw std::runtime_error("Could not stop audio for SFU recovery");
    StopMicrophone(true);
    for (auto &[id, consumer] : consumers)
      consumer->Close();
    consumers.clear();
    if (send_transport)
      send_transport->Close();
    if (recv_transport)
      recv_transport->Close();
    send_transport.reset();
    recv_transport.reset();
    sfu_listener.reset();
    device.reset();
    known_producers.clear();
    sfu_transport_states.clear();
    InitializeSfu();
    ApplyPolicy();
  } catch (const Cancelled &) {
    throw;
  } catch (const std::exception &error) {
    Emit(EventKind::warning,
         "SFU recovery failed: " + std::string(error.what()));
    // A failed partial setup must be retried even when its transport is "new".
    if (send_transport)
      send_transport->Close();
    if (recv_transport)
      recv_transport->Close();
    send_transport.reset();
    recv_transport.reset();
    ScheduleSfuRecovery();
  }
}

void VoiceEngine::Impl::AddProducer(const Json &description) {
  if (config.mode != VoiceMode::sfu ||
      Text(description, "channelId") != config.channel_id)
    return;
  const auto id = Text(description, "producerId");
  if (closed_producers.contains(id))
    return;
  if (description.value("kind", "") != "audio" ||
      !description.contains("appData") ||
      description.at("appData").value("mediaType", "") != "mic")
    return;
  if (known_producers.size() >= 2048 && !known_producers.contains(id))
    throw std::runtime_error("Too many SFU microphone producers");
  Text(description, "producerSessionId");
  known_producers.insert_or_assign(id, description);
  if (recv_transport)
    Consume(id);
}

void VoiceEngine::Impl::Consume(const std::string &id) {
  if (!recv_transport || consumers.contains(id) ||
      closed_producers.contains(id))
    return;
  const auto found = known_producers.find(id);
  if (found == known_producers.end())
    return;
  // Copy before RPC: all owned state remains on media control.
  const auto description = found->second;
  const auto session = Text(description, "producerSessionId");
  const auto member = roster.find(session);
  if (member == roster.end() || member->second.user_id == config.self_user_id)
    return;
  auto response = Request(msg::SFU_CONSUME,
                          {{"channelId", config.channel_id},
                           {"transportId", recv_transport->GetId()},
                           {"producerId", id},
                           {"rtpCapabilities", device->GetRtpCapabilities()}},
                          {msg::SFU_CONSUMED, msg::SFU_PRODUCER_CLOSED});
  if (Text(response.payload, "producerId") != id)
    throw std::runtime_error("SFU consume acknowledged another producer");
  if (response.type == msg::SFU_PRODUCER_CLOSED) {
    closed_producers.insert(id);
    known_producers.erase(id);
    return;
  }
  if (Text(response.payload, "kind") != "audio" ||
      Text(response.payload, "producerSessionId") != session ||
      response.payload.at("appData").value("mediaType", "") != "mic")
    throw std::runtime_error(
        "SFU consumed media differs from selected microphone");
  auto parameters = response.payload.at("rtpParameters");
  auto consumer =
      std::unique_ptr<mediasoupclient::Consumer>(recv_transport->Consume(
          sfu_listener.get(), Text(response.payload, "id"), id, "audio",
          &parameters, response.payload.at("appData")));
  if (!consumer)
    throw std::runtime_error("SFU Consume returned null");
  if (token->deafened.load()) {
    consumer->Pause();
    Notify(msg::SFU_CONSUMER_SET_PAUSED, {{"channelId", config.channel_id},
                                          {"consumerId", consumer->GetId()},
                                          {"paused", true}});
  }
  consumers.emplace(id, std::move(consumer));
  ApplyProcessing();
}

void VoiceEngine::Impl::CloseConsumer(const std::string &id) {
  const auto found = consumers.find(id);
  if (found == consumers.end())
    return;
  found->second->Close();
  consumers.erase(found);
}

void VoiceEngine::Impl::Stats() {
  if (!initialized)
    return;
  Json audio = worker->BlockingCall([this] {
    Json result{{"recording", adm->Recording()}, {"playing", adm->Playing()},
                {"videoEncoderCreations", video_codec_activity->encoders.load()},
                {"videoDecoderCreations", video_codec_activity->decoders.load()}};
    if (auto stats = adm->GetStats()) {
      result["totalPlayoutSamples"] = stats->total_samples_count;
      result["totalPlayoutDuration"] = stats->total_samples_duration_s;
      result["concealedPlayoutDuration"] =
          stats->synthesized_samples_duration_s;
    }
    return result;
  });
  Emit(EventKind::stats, "Native audio device", config.self_session_id,
       std::move(audio));
  for (const auto &[id, peer] : peers) {
    auto weak = weak_from_this();
    auto weak_peer = std::weak_ptr<Peer>(peer);
    const auto call = token;
    auto observer = webrtc::make_ref_counted<StatsObserver>(
        [weak, weak_peer, call, id](Json report) {
          if (auto self = weak.lock())
            self->ForCall(call, [weak_peer, id,
                                 report = std::move(report)](Impl &engine) {
              if (auto peer = weak_peer.lock(); peer && !peer->retired.load())
                engine.Emit(EventKind::stats, "P2P RTP/audio stats", id,
                            report);
            });
        });
    peer->pc->GetStats(observer.get());
  }
  if (producer)
    Emit(EventKind::stats, "SFU microphone RTP stats", config.self_session_id,
         producer->GetStats());
  for (const auto &[id, consumer] : consumers) {
    const auto found = known_producers.find(id);
    Emit(EventKind::stats, "SFU received microphone RTP/audio stats",
         found != known_producers.end()
             ? Text(found->second, "producerSessionId")
             : "",
         consumer->GetStats());
  }
}

struct VoiceEngine::Owner {
  std::shared_ptr<Impl> impl;
  std::thread thread;
  explicit Owner(Callbacks callbacks)
      : impl(std::make_shared<Impl>(std::move(callbacks))),
        thread([state = impl] { state->Run(); }) {}
  ~Owner() {
    if (auto token = impl->Ingress()) {
      token->Cancel();
      impl->GateAudio(token);
    }
    {
      std::lock_guard lock(impl->queue_mutex);
      impl->stopping = true;
    }
    impl->queue_ready.notify_one();
    bool owned_rtc_thread = false;
    {
      std::lock_guard lock(impl->audio_mutex);
      owned_rtc_thread = (impl->worker && impl->worker->IsCurrent()) ||
                         (impl->signaling && impl->signaling->IsCurrent()) ||
                         (impl->network && impl->network->IsCurrent());
    }
    if (thread.get_id() == std::this_thread::get_id() || owned_rtc_thread)
      ThreadJoiner::Instance().Add(std::move(thread));
    else
      thread.join();
  }
};

VoiceEngine::VoiceEngine(Callbacks callbacks) {
  if (!callbacks.create_audio_device || !callbacks.notify || !callbacks.request)
    throw std::invalid_argument(
        "Voice engine requires device, notify and RPC callbacks");
  EnsureSslRuntime();
  owner_ = std::make_unique<Owner>(std::move(callbacks));
}
VoiceEngine::~VoiceEngine() = default;

std::future<void> VoiceEngine::join(JoinConfig config) {
  auto self = owner_->impl;
  auto call = std::make_shared<CallToken>();
  call->self_user_id = config.self_user_id;
  call->self_session_id = config.self_session_id;
  call->muted.store(config.policy.muted);
  call->deafened.store(config.policy.deafened);
  std::shared_ptr<CallToken> previous;
  {
    std::lock_guard lock(self->ingress_mutex);
    previous = std::exchange(self->ingress_token, call);
  }
  if (previous) {
    previous->Cancel();
    self->GateAudio(previous);
  }
  auto promise = std::make_shared<std::promise<void>>();
  auto future = promise->get_future();
  self->Post([self, call, config = std::move(config), promise]() mutable {
    try {
      self->Join(std::move(config), call);
      promise->set_value();
    } catch (const Cancelled &) {
      self->Cleanup();
      promise->set_exception(std::current_exception());
    } catch (const std::exception &error) {
      self->Fail(error.what());
      promise->set_exception(std::current_exception());
    }
  });
  return future;
}

std::future<void> VoiceEngine::leave() {
  auto self = owner_->impl;
  std::shared_ptr<CallToken> previous;
  {
    std::lock_guard lock(self->ingress_mutex);
    previous = std::exchange(self->ingress_token, nullptr);
  }
  if (previous) {
    previous->Cancel();
    self->GateAudio(previous);
  }
  auto promise = std::make_shared<std::promise<void>>();
  auto future = promise->get_future();
  self->Post([self, previous, promise] {
    if (!self->token || self->token == previous) {
      const auto failure = self->Cleanup();
      if (!failure.empty()) {
        promise->set_exception(
            std::make_exception_ptr(std::runtime_error(failure)));
        return;
      }
      self->Emit(EventKind::left, "Voice resources released");
    }
    promise->set_value();
  });
  return future;
}

void VoiceEngine::update_roster(std::vector<Participant> participants) {
  auto self = owner_->impl;
  if (auto call = self->Ingress()) {
    if (std::none_of(participants.begin(), participants.end(),
                     [&](const auto &item) {
                       return item.session_id == call->self_session_id &&
                              item.user_id == call->self_user_id;
                     })) {
      call->Cancel();
      self->GateAudio(call);
      self->Post([self, call] {
        if (self->token == call)
          self->Fail("Voice membership was removed");
      });
      return;
    }
    self->ForCall(
        call, [participants = std::move(participants)](Impl &engine) mutable {
          // Existing members respond; only the newcomer offers its admission
          // roster.
          engine.Reconcile(std::move(participants), false);
        });
  }
}

void VoiceEngine::receive_signal(Json payload) {
  auto self = owner_->impl;
  if (auto call = self->Ingress())
    self->ForCall(call, [payload = std::move(payload)](Impl &engine) {
      const auto session = Text(payload, "fromSessionId");
      engine.PeerOperation(session, [&] { engine.Signal(payload); });
    });
}

void VoiceEngine::producer_added(Json payload) {
  auto self = owner_->impl;
  if (auto call = self->Ingress())
    self->ForCall(call, [payload = std::move(payload)](Impl &engine) {
      engine.AddProducer(payload);
    });
}

void VoiceEngine::producer_closed(std::string producer_id) {
  auto self = owner_->impl;
  if (auto call = self->Ingress())
    self->ForCall(call, [id = std::move(producer_id)](Impl &engine) {
      engine.CloseConsumer(id);
      engine.known_producers.erase(id);
      engine.closed_producers.insert(id);
      // IDs are unique. Bound tombstones independently from active consumers.
      if (engine.closed_producers.size() > 4096)
        throw std::runtime_error(
            "SFU producer churn exceeded call safety limit");
    });
}

void VoiceEngine::consumer_closed(std::string consumer_id) {
  auto self = owner_->impl;
  if (auto call = self->Ingress())
    self->ForCall(call, [id = std::move(consumer_id)](Impl& engine) {
      const auto found = std::find_if(engine.consumers.begin(), engine.consumers.end(),
          [&id](const auto& entry) { return entry.second->GetId() == id; });
      if (found != engine.consumers.end()) {
        const auto producer_id = found->first;
        engine.CloseConsumer(producer_id);
      }
    });
}

void VoiceEngine::update_policy(AudioPolicy policy) {
  auto self = owner_->impl;
  if (auto call = self->Ingress()) {
    call->muted.store(policy.muted);
    call->deafened.store(policy.deafened);
    // The worker gate can stop input while media control is waiting for an RPC.
    // Enabling waits for serialized source/producer creation below.
    if (policy.muted || policy.deafened)
      self->GateAudio(call);
    self->ForCall(call, [policy](Impl &engine) {
      engine.config.policy = policy;
      engine.ApplyPolicy();
    });
  }
}

void VoiceEngine::poll_stats() {
  auto self = owner_->impl;
  if (auto call = self->Ingress())
    self->ForCall(call, [](Impl &engine) { engine.Stats(); });
}

} // namespace monky::light::media
