#include "peer_support.h"
#include "receiver_policy.h"
#include "audio\media_policy.h"

#include "api\data_channel_interface.h"

#include <map>

namespace monky::native_rtc::engine {
namespace {

using namespace peer_detail;
using Pc = webrtc::PeerConnectionInterface;
using Direction = webrtc::RtpTransceiverDirection;

static_assert(kMaxMediaSections == receiver_policy::kMaxReceiverHistory);

[[noreturn]] void RethrowReceiverFailure(const std::exception_ptr& failure) {
  try { std::rethrow_exception(failure); }
  catch (const receiver_policy::PolicyError& error) {
    using Failure = receiver_policy::Failure;
    if (error.failure == Failure::HistoryFull || error.failure == Failure::EpochExhausted)
      throw Error("ERR_RTC_LIMIT", error.what(), MONKY_ENGINE_BUSY);
    if (error.failure == Failure::NotPresent)
      throw Error("ERR_RTC_CLOSED", error.what(), MONKY_ENGINE_CLOSED);
    throw Error("ERR_RTC_ARGUMENT", error.what(), MONKY_ENGINE_INVALID);
  }
}

Json TrackMetadata(const receiver_policy::Metadata& metadata) {
  return {{"trackId", metadata.track_id}, {"kind", metadata.kind},
          {"mid", metadata.mid ? Json(*metadata.mid) : Json(nullptr)},
          {"streamIds", metadata.stream_ids}};
}

template <typename State>
std::string StateText(State state) {
  const auto text = Pc::AsString(state);
  return std::string(text.data(), text.size());
}

class PeerObserver final : public webrtc::PeerConnectionObserver {
 public:
  PeerObserver(Host& host, std::uint64_t id)
      : host_(&host), id_(id), limit_(host.MaxResources()) {}

  void OnSignalingChange(Pc::SignalingState state) override {
    try { Emit("peer.state", {{"signalingState", StateText(state)}}); } catch (...) { CallbackFailure(); }
  }
  void OnIceConnectionChange(Pc::IceConnectionState state) override {
    try { Emit("peer.state", {{"iceConnectionState", StateText(state)}}); } catch (...) { CallbackFailure(); }
  }
  void OnConnectionChange(Pc::PeerConnectionState state) override {
    try { Emit("peer.state", {{"connectionState", StateText(state)}}); } catch (...) { CallbackFailure(); }
  }
  void OnIceGatheringChange(Pc::IceGatheringState state) override {
    try { Emit("peer.state", {{"iceGatheringState", StateText(state)}}); } catch (...) { CallbackFailure(); }
  }
  void OnRenegotiationNeeded() override {
    try { Emit("peer.negotiationNeeded", Json::object()); } catch (...) { CallbackFailure(); }
  }
  void OnDataChannel(webrtc::scoped_refptr<webrtc::DataChannelInterface> channel) override {
    if (channel) channel->Close();
  }
  void OnIceCandidate(const webrtc::IceCandidate* candidate) override {
    if (!candidate) return;
    try {
      auto text = candidate->ToString();
      if (text.size() > 4096) throw Error("ERR_RTC_ICE_SIZE", "Native ICE candidate exceeds its bound");
      Emit("peer.iceCandidate", {{"candidate", std::move(text)},
           {"sdpMid", candidate->sdp_mid()}, {"sdpMLineIndex", candidate->sdp_mline_index()}});
    } catch (...) { CallbackFailure(); }
  }
  void OnTrack(webrtc::scoped_refptr<webrtc::RtpTransceiverInterface> transceiver) override {
    webrtc::scoped_refptr<webrtc::RtpReceiverInterface> receiver;
    try {
      if (!host_) return;
      if (!transceiver || (transceiver->media_type() != webrtc::MediaType::VIDEO &&
                           transceiver->media_type() != webrtc::MediaType::AUDIO))
        Unsupported("Only remote screen media tracks are supported");
      receiver = transceiver->receiver();
      auto track = Track(receiver);
      const auto metadata = Describe(*transceiver, *receiver, *track);
      if (metadata.kind == "video" && minimum_video_delay_seconds_.has_value())
        receiver->SetJitterBufferMinimumDelay(minimum_video_delay_seconds_);
      const auto found = FindNative(receiver.get());
      if (found == tracks_.end()) {
        receiver_policy::CheckHistoryCapacity(tracks_.size(), limit_);
        const auto id = host_->AllocateHandle();
        if (metadata.kind == "audio") audio::GateTrack(*track, 0);
        auto [inserted, fresh] = tracks_.emplace(id, Receiver{
            receiver_policy::Receiver(id_, id, metadata, receiving_), receiver,
            transceiver, track, nullptr});
        if (!fresh) throw Error("ERR_RTC_ID", "RTC allocated a duplicate receiver identity");
        EmitTrack("peer.trackAdded", inserted->second, "added");
      } else {
        auto& entry = found->second;
        auto next = entry.policy;
        const bool present = next.Present();
        if (!next.Bind(metadata, entry.track.get() != track.get() ||
                                entry.transceiver.get() != transceiver.get())) return;
        entry.transceiver = transceiver;
        Apply(entry, std::move(next), track, present ? "peer.trackUpdated" : "peer.trackAdded",
              present ? "binding-changed" : "reattached");
      }
    } catch (...) {
      const auto failure = std::current_exception();
      FailClosed(receiver.get());
      RememberFailure(failure);
    }
  }
  void OnRemoveTrack(webrtc::scoped_refptr<webrtc::RtpReceiverInterface> receiver) override {
    try {
      if (!host_) return;
      if (!receiver) Invalid("RTC removed a null receiver");
      const auto found = FindNative(receiver.get());
      if (found == tracks_.end())
        throw Error("ERR_RTC_NOT_FOUND", "RTC removed an unknown receiver", MONKY_ENGINE_NOT_FOUND);
      Remove(found->second, "removed");
    } catch (...) { RememberFailure(std::current_exception()); }
  }
  void Reconcile(const std::vector<webrtc::scoped_refptr<webrtc::RtpTransceiverInterface>>& transceivers) {
    CheckFailure();
    for (auto& [id, entry] : tracks_) {
      const auto found = std::find_if(transceivers.begin(), transceivers.end(), [&](const auto& item) {
        return item->receiver().get() == entry.receiver.get();
      });
      if (found == transceivers.end() || (*found)->stopped() || (*found)->stopping() ||
          !entry.receiver->track() ||
          entry.receiver->track()->state() == webrtc::MediaStreamTrackInterface::kEnded) {
        Remove(entry, "transceiver-removed");
        continue;
      }
      const auto track = Track(entry.receiver);
      const auto metadata = Describe(**found, *entry.receiver, *track);
      auto next = entry.policy;
      const bool replaced = entry.policy.Present() && entry.track.get() != track.get();
      if (!next.Refresh(metadata, replaced || entry.transceiver.get() != found->get())) continue;
      entry.transceiver = *found;
      Apply(entry, std::move(next), entry.policy.Present() ? track : nullptr,
            "peer.trackUpdated", replaced ? "binding-changed" : "metadata-changed");
    }
  }
  bool IsAudioReceiver(std::uint64_t id) const {
    const auto found = tracks_.find(id);
    if (found == tracks_.end())
      throw Error("ERR_RTC_NOT_FOUND", "Receiver does not belong to this peer", MONKY_ENGINE_NOT_FOUND);
    return found->second.policy.Description().kind == "audio";
  }
  bool HasRequestedAudio() const {
    return std::any_of(tracks_.begin(), tracks_.end(), [](const auto& item) {
      return item.second.policy.Present() && item.second.policy.Requested() &&
             item.second.policy.Description().kind == "audio";
    });
  }
  void ConfigureVideoPlayout(std::uint32_t minimum_delay_ms) {
    CheckFailure();
    if (minimum_video_delay_seconds_.has_value() || !tracks_.empty())
      throw Error("ERR_RTC_PLAYOUT_STATE", "Configure video playout only once, before receiver creation",
                  MONKY_ENGINE_BUSY);
    minimum_video_delay_seconds_ = minimum_delay_ms / 1000.0;
  }
  void CheckReceivingAdmission(bool enabled, std::uint64_t output_epoch, bool before_mutation = true) const {
    if (!enabled) return;
    for (const auto& [id, entry] : tracks_) {
      if (!entry.policy.Present() || !entry.policy.Requested() ||
          entry.policy.Description().kind != "audio") continue;
      audio::CheckOutputAdmission(true, host_ && entry.output_epoch == output_epoch &&
          host_->AudioOutputReady(output_epoch), before_mutation);
    }
  }
  Json SetReceiverEnabled(std::uint64_t id, bool enabled, std::uint64_t output_epoch = 0) {
    CheckFailure();
    const auto found = tracks_.find(id);
    if (found == tracks_.end())
      throw Error("ERR_RTC_NOT_FOUND", "Receiver does not belong to this peer", MONKY_ENGINE_NOT_FOUND);
    auto& entry = found->second;
    const bool audio_receiver = entry.policy.Description().kind == "audio";
    audio::CheckOutputAdmission(enabled && audio_receiver,
        host_ && host_->AudioOutputReady(output_epoch), true);
    if (enabled && entry.track &&
        entry.track->state() == webrtc::MediaStreamTrackInterface::kEnded)
      Remove(entry, "track-ended");
    auto next = entry.policy;
    const bool changed = next.SetRequested(enabled);
    if (audio_receiver) entry.output_epoch = enabled ? output_epoch : 0;
    Json result{{"receiverId", id}, {"receiverEpoch", next.Route().receiver_epoch},
                {"enabled", next.Effective()}, {"requestedEnabled", next.Requested()}};
    try {
      if (changed)
        Apply(entry, std::move(next), entry.track, "peer.trackUpdated",
              enabled ? "authorized" : "disabled");
      audio::CheckOutputAdmission(enabled && audio_receiver,
          host_ && host_->AudioOutputReady(output_epoch), false);
    } catch (...) {
      const auto failure = std::current_exception();
      StopSink(entry);
      try {
        if (entry.policy.SetRequested(false)) EmitTrack("peer.trackUpdated", entry, "activation-failed");
      } catch (...) { RememberFailure(std::current_exception()); }
      std::rethrow_exception(failure);
    }
    return result;
  }
  Json SetReceiverVolume(std::uint64_t id, double volume) {
    CheckFailure();
    const auto found = tracks_.find(id);
    if (found == tracks_.end() || found->second.policy.Description().kind != "audio")
      throw Error("ERR_RTC_AUDIO_RECEIVER", "Audio receiver does not belong to this peer", MONKY_ENGINE_NOT_FOUND);
    auto& entry = found->second;
    audio::CheckOutputAdmission(entry.policy.Effective(),
        host_ && host_->AudioOutputReady(entry.output_epoch), false);
    if (entry.track) audio::GateTrack(*entry.track, entry.policy.Effective() ? volume : 0);
    entry.volume = volume;
    return {{"receiverId", id}, {"receiverEpoch", entry.policy.Route().receiver_epoch}, {"volume", volume}};
  }
  void Receiving(bool enabled, std::uint64_t output_epoch = 0) {
    CheckFailure();
    CheckReceivingAdmission(enabled, output_epoch, false);
    if (receiving_ == enabled) return;
    receiving_ = enabled;
    for (auto& [id, entry] : tracks_) {
      auto next = entry.policy;
      if (next.SetAggregate(enabled))
        Apply(entry, std::move(next), entry.track, "peer.trackUpdated",
              enabled ? "receiving-enabled" : "receiving-disabled");
    }
  }
  Json Snapshot() const {
    Json result = Json::array();
    for (const auto& [id, entry] : tracks_) {
      auto item = Description(entry);
      item["present"] = entry.policy.Present();
      item["requestedEnabled"] = entry.policy.Requested();
      item["enabled"] = entry.policy.Effective();
      item["sinkAttached"] = entry.sink != nullptr;
      result.push_back(std::move(item));
    }
    return result;
  }
  void DetachHost() {
    // All receiver state is signaling-thread confined, including close.
    for (auto& [id, entry] : tracks_) {
      StopSink(entry);
      try {
        if (entry.policy.Remove()) EmitTrack("peer.trackRemoved", entry, "peer-closed");
      } catch (...) { RememberFailure(std::current_exception()); }
    }
    std::lock_guard lock(event_mutex_);
    host_ = nullptr;
  }
  void RemoveSinks() {
    for (auto& [id, entry] : tracks_) StopSink(entry);
    tracks_.clear();
  }
 private:
  struct Receiver {
    receiver_policy::Receiver policy;
    webrtc::scoped_refptr<webrtc::RtpReceiverInterface> receiver;
    webrtc::scoped_refptr<webrtc::RtpTransceiverInterface> transceiver;
    webrtc::scoped_refptr<webrtc::MediaStreamTrackInterface> track;
    std::unique_ptr<FrameSink> sink;
    double volume = 1;
    std::uint64_t output_epoch = 0;
  };

  std::map<std::uint64_t, Receiver>::iterator FindNative(webrtc::RtpReceiverInterface* receiver) {
    // Keep a native reference in each history slot: textual IDs may be reused.
    return std::find_if(tracks_.begin(), tracks_.end(),
        [receiver](const auto& item) { return item.second.receiver.get() == receiver; });
  }
  static webrtc::scoped_refptr<webrtc::MediaStreamTrackInterface> Track(
      const webrtc::scoped_refptr<webrtc::RtpReceiverInterface>& receiver) {
    const auto track = receiver ? receiver->track() : nullptr;
    if (!track || (track->kind() != webrtc::MediaStreamTrackInterface::kVideoKind &&
                   track->kind() != webrtc::MediaStreamTrackInterface::kAudioKind))
      throw Error("ERR_RTC_TRACK", "RTC receiver has no screen media track");
    return track;
  }
  static receiver_policy::Metadata Describe(webrtc::RtpTransceiverInterface& transceiver,
      webrtc::RtpReceiverInterface& receiver, webrtc::MediaStreamTrackInterface& track) {
    receiver_policy::Metadata metadata{track.id(), transceiver.mid(), receiver.stream_ids(), track.kind()};
    receiver_policy::CheckMetadata(metadata);
    return metadata;
  }
  static Json Description(const Receiver& entry) {
    auto result = TrackMetadata(entry.policy.Description());
    result["receiverId"] = entry.policy.Route().receiver_id;
    result["receiverEpoch"] = entry.policy.Route().receiver_epoch;
    result["kind"] = entry.policy.Description().kind;
    return result;
  }
  void EmitTrack(std::string_view type, const Receiver& entry, const char* reason) {
    auto data = Description(entry);
    data["reason"] = reason;
    if (!host_ || !host_->Emit(type, id_, std::move(data)))
      throw Error("ERR_RTC_EVENT_QUEUE", "Receiver lifecycle event could not be delivered",
                  MONKY_ENGINE_BUSY);
  }
  void StopSink(Receiver& entry) {
    if (entry.track && entry.policy.Description().kind == "audio") {
      audio::GateTrack(*entry.track, 0);
      return;
    }
    if (!entry.sink) return;
    entry.sink->Detach();
    if (host_) host_->RetireReceiveRoute(entry.sink->Route());
    if (entry.track) static_cast<webrtc::VideoTrackInterface*>(entry.track.get())->RemoveSink(entry.sink.get());
    entry.sink.reset();
  }
  void Apply(Receiver& entry, receiver_policy::Receiver next,
      webrtc::scoped_refptr<webrtc::MediaStreamTrackInterface> track,
      std::string_view type, const char* reason) {
    StopSink(entry);
    entry.policy = std::move(next);
    entry.track = std::move(track);
    try {
      if (entry.track && entry.policy.Description().kind == "audio")
        audio::GateTrack(*entry.track, 0);
      // Metadata commits before a new sink can submit frames of this epoch.
      EmitTrack(type, entry, reason);
      if (!entry.policy.Effective()) return;
      if (!host_ || !entry.track)
        throw Error("ERR_RTC_CLOSED", "Receiver has no live video binding", MONKY_ENGINE_CLOSED);
      if (entry.policy.Description().kind == "audio") {
        audio::CheckOutputAdmission(true, host_->AudioOutputReady(entry.output_epoch), false);
        audio::GateTrack(*entry.track, entry.volume);
        audio::CheckOutputAdmission(true, host_->AudioOutputReady(entry.output_epoch), false);
        return;
      }
      const auto route = entry.policy.Route();
      if (!entry.policy.Accepts(route))
        throw Error("ERR_RTC_ROUTE", "Receiver rejected its activation route");
      entry.sink = std::make_unique<FrameSink>(*host_, route);
      host_->ActivateReceiveRoute(route);
      entry.sink->Enable(true);
      static_cast<webrtc::VideoTrackInterface*>(entry.track.get())->AddOrUpdateSink(
          entry.sink.get(), webrtc::VideoSinkWants{});
    } catch (...) {
      const auto failure = std::current_exception();
      StopSink(entry);
      try {
        entry.policy.SetRequested(false);
        EmitTrack("peer.trackUpdated", entry, "activation-failed");
      } catch (...) { CallbackFailure(); }
      std::rethrow_exception(failure);
    }
  }
  void Remove(Receiver& entry, const char* reason) {
    auto next = entry.policy;
    if (next.Remove()) Apply(entry, std::move(next), nullptr, "peer.trackRemoved", reason);
  }
  void FailClosed(webrtc::RtpReceiverInterface* receiver) noexcept {
    if (!receiver) return;
    try {
      const auto found = FindNative(receiver);
      if (found == tracks_.end()) return;
      auto& entry = found->second;
      StopSink(entry);
      if (entry.policy.SetRequested(false))
        EmitTrack("peer.trackUpdated", entry, "binding-failed");
    } catch (...) { CallbackFailure(); }
  }
  void CheckFailure() const {
    if (failure_) RethrowReceiverFailure(failure_);
  }
  void RememberFailure(const std::exception_ptr& failure) noexcept {
    if (!failure_) failure_ = failure;
    try { RethrowReceiverFailure(failure); }
    catch (const Error& error) {
      try {
        Emit("error", {{"code", error.code}, {"message", error.what()}, {"status", error.status},
                      {"hresult", error.hr}, {"terminal", false}});
      } catch (...) { CallbackFailure(); }
    } catch (...) {
      try {
        Emit("error", {{"code", "ERR_RTC_CALLBACK"}, {"message", "Receiver callback failed"},
                      {"status", MONKY_ENGINE_FAILURE}, {"hresult", 0}, {"terminal", false}});
      } catch (...) { CallbackFailure(); }
    }
  }
  void Emit(std::string_view type, Json data) noexcept {
    try {
      std::lock_guard lock(event_mutex_);
      if (host_ && !host_->Emit(type, id_, std::move(data))) CallbackFailure();
    } catch (...) { CallbackFailure(); }
  }
  std::mutex event_mutex_;
  Host* host_;
  const std::uint64_t id_;
  const std::size_t limit_;
  bool receiving_ = false;
  std::optional<double> minimum_video_delay_seconds_;
  std::exception_ptr failure_;
  std::map<std::uint64_t, Receiver> tracks_;
};

struct Peer {
  std::uint64_t id = 0;
  std::string sync_group;
  bool receiving = false;
  bool registered = false;
  std::size_t native_slots = 0;
  std::size_t candidates = 0;
  Json send_stream_drops = nullptr;
  Json receive_stream_diagnostics = nullptr;
  Json configured_bitrate = nullptr;
  Json configured_video_playout = nullptr;
  std::vector<webrtc::scoped_refptr<webrtc::RtpTransceiverInterface>> retiring_audio;
  std::unique_ptr<PeerObserver> observer;
  webrtc::scoped_refptr<Pc> pc;
};

struct Publication {
  std::uint64_t id = 0, peer_id = 0, source_id = 0;
  bool requested = false;
  bool effective = false;
  std::shared_ptr<VideoSource> source;
  std::shared_ptr<audio::AudioSource> audio_source;
  webrtc::scoped_refptr<webrtc::MediaStreamTrackInterface> track;
  webrtc::scoped_refptr<webrtc::RtpTransceiverInterface> transceiver;
  Json metadata = nullptr;
  Json configured_video_encoding = nullptr;
  bool SourceEnabled() const { return source ? source->Enabled() : audio_source->Enabled(); }
};

class NativePeerController final : public PeerController {
 public:
  explicit NativePeerController(Host& host) : host_(host) { PrivateRtcLogging(); }
  ~NativePeerController() override { CloseAll(); }

  Json Execute(std::string_view operation, std::uint64_t target, const Json& data,
               const std::shared_ptr<Cancellation>& cancellation) override {
    CheckActor(host_);
    PrivateRtcLogging();
    if (!cancellation) Invalid("Missing cancellation context");
    cancellation->Check();
    CheckJson(data);
    if (operation == "peer.create") return Create(target, data, cancellation);
    if (operation == "resource.close") {
      Keys(data, {});
      if (!Contains(target))
        throw Error("ERR_RTC_NOT_FOUND", "Peer resource not found", MONKY_ENGINE_NOT_FOUND);
      Close(target);
      return Json::object();
    }
    if (operation == "peer.setPublicationEnabled") {
      Keys(data, {"enabled"});
      if (!data.contains("enabled")) Invalid("enabled is required");
      const bool enabled = Boolean(data, "enabled");
      auto& publication = FindPublication(target);
      const auto peer_id = publication.peer_id;
      try {
        cancellation->Check();
        GateSender(*publication.transceiver->sender(), enabled && publication.SourceEnabled());
        cancellation->Check();
        publication.requested = enabled;
        publication.effective = enabled && publication.SourceEnabled();
        return {{"enabled", publication.effective}};
      } catch (...) {
        Close(peer_id);
        throw;
      }
    }

    auto& peer = FindPeer(target);
    if (operation == "peer.configureVideoPlayout") {
      const auto minimum_delay_ms = VideoPlayoutDelayMs(data);
      if (!peer.configured_video_playout.is_null())
        throw Error("ERR_RTC_PLAYOUT_STATE", "Video playout was already configured", MONKY_ENGINE_BUSY);
      try {
        OnSignaling([&] {
          cancellation->Check();
          peer.observer->ConfigureVideoPlayout(minimum_delay_ms);
        });
        cancellation->Check();
        peer.configured_video_playout = {{"minimumDelayMs", minimum_delay_ms}, {"actualDelayMeasured", false}};
        return peer.configured_video_playout;
      } catch (...) {
        Close(target);
        throw;
      }
    }
    if (operation == "peer.configureBitrate") {
      const auto bitrate = StartupBitrate(data);
      if (!peer.configured_bitrate.is_null() || std::any_of(publications_.begin(), publications_.end(),
          [target](const auto& entry) { return entry.second.peer_id == target; }))
        throw Error("ERR_RTC_BITRATE_STATE", "Configure startup bitrate only once, before publication", MONKY_ENGINE_BUSY);
      try {
        OnSignaling([&] {
          cancellation->Check();
          RtcOk(peer.pc->SetBitrate(bitrate), "RTC rejected the startup bitrate configuration");
        });
        cancellation->Check();
        peer.configured_bitrate = {{"startBitrateBps", *bitrate.start_bitrate_bps},
          {"maxBitrateBps", *bitrate.max_bitrate_bps}, {"minimumBitrateForced", false},
          {"bandwidthMeasured", false}};
        return peer.configured_bitrate;
      } catch (...) {
        Close(target);
        throw;
      }
    }
    if (operation == "peer.setReceiverVolume") {
      Keys(data, {"receiverId", "volume"});
      const auto receiver_id = Id(data, "receiverId");
      const auto volume = audio::Volume(data);
      Json result;
      OnSignaling([&] { cancellation->Check(); result = peer.observer->SetReceiverVolume(receiver_id, volume); });
      return result;
    }
    if (operation == "peer.setReceiverEnabled") {
      Keys(data, {"receiverId", "enabled", "expectedOutputEpoch"});
      if (!data.contains("enabled")) Invalid("enabled is required");
      const auto receiver_id = Id(data, "receiverId");
      const bool enabled = Boolean(data, "enabled");
      Json result;
      try {
        OnSignaling([&] {
          cancellation->Check();
          const auto output_epoch = audio::ExpectedOutputEpoch(data, enabled && peer.observer->IsAudioReceiver(receiver_id));
          result = peer.observer->SetReceiverEnabled(receiver_id, enabled, output_epoch);
        });
      } catch (const Error& error) {
        if (error.code == MONKY_ENGINE_AUDIO_DURING_ADMISSION) Close(target);
        throw;
      }
      try { cancellation->Check(); }
      catch (...) {
        // Roll back this receiver only; an invalid ID never mutates any gate.
        OnSignaling([&] { peer.observer->SetReceiverEnabled(receiver_id, false); });
        throw;
      }
      return result;
    }
    if (operation == "peer.publish") return Publish(peer, data, cancellation);
    if (operation == "peer.publishAudio") return PublishAudio(peer, data, cancellation);
    if (operation == "peer.createOffer" || operation == "peer.createAnswer") {
      const bool offer = operation == "peer.createOffer";
      if (offer) Keys(data, {"iceRestart"});
      else Keys(data, {});
      Pc::RTCOfferAnswerOptions options;
      options.ice_restart = offer && Boolean(data, "iceRestart");
      try {
        auto sdp = CreateDescription(host_, *peer.pc, offer, options, cancellation);
        return {{"type", offer ? "offer" : "answer"}, {"sdp", std::move(sdp)}};
      } catch (...) {
        if (Cancelled(std::current_exception())) Close(target);
        throw;
      }
    }
    if (operation == "peer.setLocalDescription" || operation == "peer.setRemoteDescription") {
      Keys(data, {"type", "sdp", "expectedOutputEpoch"});
      const auto type = Text(data, "type", 16);
      if (type != "offer" && type != "answer") Invalid("Only offer and answer SDP are accepted");
      auto description = ParseDescription(type == "offer" ? webrtc::SdpType::kOffer :
          webrtc::SdpType::kAnswer, Text(data, "sdp", kMaxJson), host_.MaxResources());
      const bool local = operation == "peer.setLocalDescription";
      const bool receives_audio = audio::DescriptionReceivesAudio(*description, local);
      const auto output_epoch = audio::ExpectedOutputEpoch(data, receives_audio);
      audio::CheckOutputAdmission(receives_audio, host_.AudioOutputReady(output_epoch), true);
      if (local && !peer.receiving) {
        for (const auto& content : description->description()->contents()) {
          const auto* media = content.media_description();
          if (!content.rejected && media->type() == webrtc::MediaType::VIDEO &&
              (media->direction() == Direction::kRecvOnly || media->direction() == Direction::kSendRecv))
            Invalid("Local SDP requests receiving while disabled; create a new offer or answer");
        }
      }
      if (!local) {
        for (const auto& [id, publication] : publications_) {
          if (publication.peer_id != target || !publication.source) continue;
          const auto mid = publication.transceiver->mid();
          for (const auto& content : description->description()->contents()) {
            const auto* media = content.media_description();
            if (content.rejected || media->type() != webrtc::MediaType::VIDEO
                || (mid && content.mid() != *mid)
                || (media->direction() != Direction::kRecvOnly && media->direction() != Direction::kSendRecv)) continue;
            const auto& codecs = media->as_video()->codecs();
            if (!std::any_of(codecs.begin(), codecs.end(), [&](const auto& codec) {
                  return publication.source->AcceptsSendCodec(webrtc::SdpVideoFormat(codec.name, codec.params));
                }))
              throw Error("ERR_RTC_ENCODED_FORMAT", "The receiver cannot decode this screen's H264 profile and level",
                          MONKY_ENGINE_UNSUPPORTED);
          }
        }
      }
      try {
        SetDescription(host_, *peer.pc, local, std::move(description), cancellation);
        if (!local) {
          peer.native_slots = (std::max)(peer.native_slots, peer.pc->GetTransceivers().size());
          if (peer.native_slots > (std::min)(std::size_t(host_.MaxResources()), kMaxMediaSections))
            throw Error("ERR_RTC_LIMIT", "Remote description exceeded the transceiver limit",
                        MONKY_ENGINE_BUSY);
          RefreshCandidates(peer);
          SetReceiveDirections(peer, cancellation);
        }
        RefreshBindings(peer);
        cancellation->Check();
        audio::CheckOutputAdmission(receives_audio, host_.AudioOutputReady(output_epoch), false);
        return Json::object();
      } catch (...) {
        // A timed-out set-description may still finish on signaling. Retire its PC.
        Close(target);
        throw;
      }
    }
    if (operation == "peer.addIceCandidate") {
      Keys(data, {"candidate", "sdpMid", "sdpMLineIndex"});
      const auto candidate_text = Text(data, "candidate", 4096);
      if (candidate_text.find_first_of("\r\n") != std::string::npos)
        Invalid("Expected one ICE candidate line");
      const auto mid = Token(data, "sdpMid");
      const auto index = Integer(data, "sdpMLineIndex", 0, kMaxMediaSections - 1);
      webrtc::SdpParseError parse_error;
      auto candidate = webrtc::IceCandidate::Create(mid, static_cast<int>(index),
                                                    candidate_text, &parse_error);
      if (!candidate || (candidate->candidate().protocol() != "udp" &&
                         candidate->candidate().protocol() != "tcp"))
        Invalid("Invalid UDP/TCP ICE candidate");
      if (peer.candidates >= kMaxCandidates) Invalid("Remote ICE candidate limit reached");
      auto completion = std::make_shared<Completion<void>>();
      auto future = completion->promise.get_future();
      try {
        cancellation->Check();
        peer.pc->AddIceCandidate(std::move(candidate), [completion](webrtc::RTCError error) {
          try {
            RtcOk(error, "RTC rejected the remote ICE candidate");
            completion->Resolve();
          } catch (...) { completion->Reject(std::current_exception()); }
        });
        Wait(host_, cancellation, future);
        ++peer.candidates;
        return Json::object();
      } catch (...) {
        if (Cancelled(std::current_exception())) Close(target);
        throw;
      }
    }
    if (operation == "peer.setReceiving") {
      Keys(data, {"enabled", "expectedOutputEpoch"});
      if (!data.contains("enabled")) Invalid("enabled is required");
      const bool enabled = Boolean(data, "enabled");
      std::uint64_t output_epoch = 0;
      OnSignaling([&] {
        output_epoch = audio::ExpectedOutputEpoch(data, enabled && peer.observer->HasRequestedAudio());
        peer.observer->CheckReceivingAdmission(enabled, output_epoch);
      });
      try {
        if (peer.receiving == enabled)
          return {{"enabled", enabled}, {"renegotiationRequired", false}};
        if (!enabled) OnSignaling([&] { peer.observer->Receiving(false); });
        peer.receiving = enabled;
        SetReceiveDirections(peer, cancellation);
        cancellation->Check();
        if (enabled) OnSignaling([&] { peer.observer->Receiving(true, output_epoch); });
        cancellation->Check();
        host_.Emit("peer.negotiationNeeded", target, Json::object());
        return {{"enabled", enabled}, {"renegotiationRequired", true}};
      } catch (...) {
        Close(target);
        throw;
      }
    }
    if (operation == "peer.getStats") {
      Keys(data, {});
      try {
        return Stats(host_, *peer.pc, cancellation, nullptr, nullptr,
                     &peer.send_stream_drops, &peer.receive_stream_diagnostics);
      }
      catch (...) {
        // Do not allow an unlimited collection of unanswered stats callbacks.
        if (Cancelled(std::current_exception())) Close(target);
        throw;
      }
    }
    Unsupported("Unknown peer operation");
  }

  bool Contains(std::uint64_t id) const override {
    return peers_.contains(id) || publications_.contains(id);
  }
  bool UsesSource(std::uint64_t id) const override {
    return std::any_of(publications_.begin(), publications_.end(),
        [id](const auto& item) { return item.second.source_id == id; });
  }
  void SourceEnabledChanged(std::uint64_t source) override {
    CheckActor(host_);
    std::vector<std::uint64_t> ids;
    for (const auto& [id, publication] : publications_)
      if (publication.source_id == source) ids.push_back(id);
    std::exception_ptr failure;
    for (auto id : ids) {
      auto it = publications_.find(id);
      if (it == publications_.end()) continue;
      const auto peer_id = it->second.peer_id;
      try {
        const auto cancellation = CleanupCancellation(host_, id);
        auto& publication = it->second;
        const bool effective = publication.requested && publication.SourceEnabled();
        cancellation->Check();
        GateSender(*publication.transceiver->sender(), effective);
        cancellation->Check();
        publication.effective = effective;
      } catch (...) {
        if (!failure) failure = std::current_exception();
        Close(peer_id);
      }
    }
    if (failure) std::rethrow_exception(failure);
  }
  void Close(std::uint64_t target) override {
    CheckActor(host_);
    if (auto found = publications_.find(target); found != publications_.end()) {
      const auto peer_id = found->second.peer_id;
      auto& peer = FindPeer(peer_id);
      try {
        auto sender = found->second.transceiver->sender();
        GateSender(*sender, false);
        if (found->second.audio_source) {
          peer.retiring_audio.push_back(found->second.transceiver);
          if (!sender->SetTrack(nullptr)) throw Error("ERR_RTC_TRACK", "RTC could not detach audio source");
          RtcOk(found->second.transceiver->StopStandard(), "RTC could not retire the sendonly audio transceiver");
        } else {
          RtcOk(peer.pc->RemoveTrackOrError(sender), "RTC could not remove the publication");
          if (!sender->SetTrack(nullptr)) throw Error("ERR_RTC_TRACK", "RTC could not detach the source");
        }
        publications_.erase(found);
        host_.ForgetResource(target);
        host_.Emit("peer.negotiationNeeded", peer_id, Json::object());
      } catch (...) {
        Close(peer_id);
        throw;
      }
      return;
    }
    auto found = peers_.find(target);
    if (found == peers_.end()) return;
    auto& peer = *found->second;
    host_.SignalingThread()->BlockingCall([&] {
      peer.observer->DetachHost();
      peer.observer->RemoveSinks();
      peer.pc->Close();
      // Releasing the PC on signaling synchronizes its raw observer lifetime.
      peer.pc = nullptr;
    });
    for (auto it = publications_.begin(); it != publications_.end();) {
      if (it->second.peer_id != target) { ++it; continue; }
      host_.ForgetResource(it->first);
      it = publications_.erase(it);
    }
    if (peer.registered) host_.ForgetResource(target);
    peers_.erase(found);
  }
  void CloseAll() override {
    while (!peers_.empty()) Close(peers_.begin()->first);
  }
  Json Snapshot() const override {
    Json peers = Json::array(), publications = Json::array();
    for (const auto& [id, peer] : peers_) {
      Json receivers;
      OnSignaling([&] { receivers = peer->observer->Snapshot(); });
      peers.push_back({{"peerId", id}, {"syncGroup", peer->sync_group},
                      {"receivingRequested", peer->receiving}, {"nativeSlots", peer->native_slots},
                      {"receivers", std::move(receivers)}, {"sendStreamDrops", peer->send_stream_drops},
                      {"receiveStreamDiagnostics", peer->receive_stream_diagnostics},
                      {"configuredVideoPlayout", peer->configured_video_playout}});
    }
    for (const auto& [id, publication] : publications_)
      publications.push_back({{"publicationId", id}, {"peerId", publication.peer_id},
          {"sourceId", publication.source_id}, {"requestedEnabled", publication.requested},
          {"enabled", publication.effective}, {"metadata", publication.metadata},
          {"configuredVideoEncoding", publication.configured_video_encoding}});
    return {{"peers", std::move(peers)}, {"publications", std::move(publications)}};
  }

 private:
  template <typename Callback>
  void OnSignaling(Callback&& callback) const {
    std::exception_ptr failure;
    host_.SignalingThread()->BlockingCall([&] {
      try { callback(); }
      catch (...) { failure = std::current_exception(); }
    });
    if (failure) RethrowReceiverFailure(failure);
  }
  Json PublicationMetadata(const Publication& publication) const {
    const auto sender = publication.transceiver->sender();
    const auto track = sender->track();
    if (!track || (track->kind() != webrtc::MediaStreamTrackInterface::kVideoKind &&
                   track->kind() != webrtc::MediaStreamTrackInterface::kAudioKind))
      throw Error("ERR_RTC_TRACK", "Publication sender has no screen media track");
    receiver_policy::Metadata metadata{
        track->id(), publication.transceiver->mid(), sender->stream_ids(), track->kind()};
    receiver_policy::CheckMetadata(metadata);
    auto result = TrackMetadata(metadata);
    result["publicationId"] = publication.id;
    return result;
  }
  void RefreshBindings(Peer& peer) {
    OnSignaling([&] { peer.observer->Reconcile(peer.pc->GetTransceivers()); });
    std::erase_if(peer.retiring_audio, [](const auto& transceiver) { return transceiver->stopped(); });
    for (auto& [id, publication] : publications_) {
      if (publication.peer_id != peer.id) continue;
      auto metadata = PublicationMetadata(publication);
      if (metadata == publication.metadata) continue;
      if (!host_.Emit("peer.publicationUpdated", peer.id, metadata))
        throw Error("ERR_RTC_EVENT_QUEUE", "Publication lifecycle event could not be delivered",
                    MONKY_ENGINE_BUSY);
      publication.metadata = std::move(metadata);
    }
  }
  void Capacity() const {
    if (peers_.size() + publications_.size() >= host_.MaxResources())
      throw Error("ERR_RTC_LIMIT", "Peer resource limit reached", MONKY_ENGINE_BUSY);
  }
  Peer& FindPeer(std::uint64_t id) const {
    const auto it = peers_.find(id);
    if (it == peers_.end())
      throw Error("ERR_RTC_NOT_FOUND", "Peer not found", MONKY_ENGINE_NOT_FOUND);
    return *it->second;
  }
  Publication& FindPublication(std::uint64_t id) {
    const auto it = publications_.find(id);
    if (it == publications_.end())
      throw Error("ERR_RTC_NOT_FOUND", "Publication not found", MONKY_ENGINE_NOT_FOUND);
    return it->second;
  }
  void Slot(Peer& peer) {
    if (peer.native_slots >= (std::min)(std::size_t(host_.MaxResources()), kMaxMediaSections))
      throw Error("ERR_RTC_LIMIT", "Peer transceiver budget exhausted; recreate the peer",
                  MONKY_ENGINE_BUSY);
  }
  void RefreshCandidates(Peer& peer) {
    std::size_t count = 0;
    host_.SignalingThread()->BlockingCall([&] {
      const auto* description = peer.pc->remote_description();
      if (!description) return;
      for (std::size_t i = 0; i < description->number_of_mediasections(); ++i)
        if (const auto* candidates = description->candidates(i)) count += candidates->count();
    });
    if (count > kMaxCandidates)
      throw Error("ERR_RTC_LIMIT", "Peer remote ICE candidate limit reached", MONKY_ENGINE_BUSY);
    peer.candidates = count;
  }
  void SetReceiveDirections(Peer& peer, const std::shared_ptr<Cancellation>& cancellation) {
    bool found_video = false;
    for (auto& transceiver : peer.pc->GetTransceivers()) {
      cancellation->Check();
      if (transceiver->stopped() || transceiver->stopping()) continue;
      if (transceiver->media_type() == webrtc::MediaType::AUDIO) {
        const bool sends_audio = transceiver->sender()->track() != nullptr;
        RtcOk(transceiver->SetDirectionWithError(sends_audio ? Direction::kSendOnly :
            peer.receiving ? Direction::kRecvOnly : Direction::kInactive),
            "RTC could not change screen audio receiving direction");
        audio::PreferOpus(host_, *transceiver);
        continue;
      }
      if (transceiver->media_type() != webrtc::MediaType::VIDEO) continue;
      found_video = true;
      const bool sends = transceiver->sender()->track() != nullptr;
      const auto direction = sends ? (peer.receiving ? Direction::kSendRecv : Direction::kSendOnly)
          : (peer.receiving ? Direction::kRecvOnly : Direction::kInactive);
      RtcOk(transceiver->SetDirectionWithError(direction), "RTC could not change receiving direction");
      cancellation->Check();
    }
    if (peer.receiving && !found_video) {
      Slot(peer);
      cancellation->Check();
      webrtc::RtpTransceiverInit init;
      init.direction = Direction::kRecvOnly;
      auto transceiver = peer.pc->AddTransceiver(webrtc::MediaType::VIDEO, init);
      RtcOk(transceiver.error(), "RTC could not create a receiving transceiver");
      ++peer.native_slots;
      cancellation->Check();
    }
  }
  Json Create(std::uint64_t target, const Json& data,
              const std::shared_ptr<Cancellation>& cancellation) {
    if (target) Invalid("peer.create requires target zero");
    Keys(data, {"syncGroup", "iceServers", "receiveVideo"});
    const auto group = SyncGroup(data);
    auto config = Configuration(data);
    const bool receiving = Boolean(data, "receiveVideo");
    Capacity();
    const auto factory = host_.Factory();
    if (!factory) throw Error("ERR_RTC_NOT_READY", "The RTC factory is unavailable");
    auto peer = std::make_unique<Peer>();
    peer->id = host_.AllocateHandle();
    peer->sync_group = group;
    peer->receiving = receiving;
    peer->observer = std::make_unique<PeerObserver>(host_, peer->id);
    const auto id = peer->id;
    try {
      cancellation->Check();
      host_.RegisterResource(id);
      peer->registered = true;
      cancellation->Check();
      auto result = factory->CreatePeerConnectionOrError(config,
          webrtc::PeerConnectionDependencies(peer->observer.get()));
      RtcOk(result.error(), "RTC could not create the peer connection");
      peer->pc = result.MoveValue();
      if (!peer->pc) throw Error("ERR_RTC_NATIVE", "RTC returned no peer connection");
      cancellation->Check();
      SetReceiveDirections(*peer, cancellation);
      cancellation->Check();
      OnSignaling([&] { peer->observer->Receiving(receiving); });
      peers_.emplace(id, std::move(peer));
      cancellation->Check();
      return {{"peerId", id}};
    } catch (...) {
      if (peers_.contains(id)) Close(id);
      else if (peer) {
        host_.SignalingThread()->BlockingCall([&] {
          peer->observer->DetachHost();
          peer->observer->RemoveSinks();
          if (peer->pc) peer->pc->Close();
          peer->pc = nullptr;
        });
        if (peer->registered) host_.ForgetResource(id);
      }
      throw;
    }
  }
  Json Publish(Peer& peer, const Json& data, const std::shared_ptr<Cancellation>& cancellation) {
    Keys(data, {"sourceId", "enabled", "maxBitrateBps", "maxFramerate"});
    const auto source_id = Id(data, "sourceId");
    auto source = host_.FindSource(source_id);
    if (!source) throw Error("ERR_RTC_NOT_FOUND", "Source not found", MONKY_ENGINE_NOT_FOUND);
    for (const auto& [id, publication] : publications_)
      if (publication.peer_id == peer.id && publication.source_id == source_id)
        throw Error("ERR_RTC_PUBLICATION", "This peer already publishes the screen source", MONKY_ENGINE_BUSY);
    const bool requested = Boolean(data, "enabled");
    auto encoding = Encoding(data, requested && source->Enabled());
    auto native_source = source->TrackSource();
    if (!native_source) throw Error("ERR_RTC_CLOSED", "Source is closed", MONKY_ENGINE_CLOSED);
    Capacity();
    Slot(peer);
    const auto id = host_.AllocateHandle();
    const auto peer_id = peer.id;
    bool registered = false;
    bool transceiver_added = false;
    try {
      cancellation->Check();
      host_.RegisterResource(id, peer_id, source_id);
      registered = true;
      cancellation->Check();
      auto track = host_.Factory()->CreateVideoTrack(native_source, "screen-" + std::to_string(id));
      if (!track) throw Error("ERR_RTC_TRACK", "RTC could not create the video track");
      cancellation->Check();
      track->set_content_hint(webrtc::VideoTrackInterface::ContentHint::kDetailed);
      cancellation->Check();
      webrtc::RtpTransceiverInit init;
      init.direction = peer.receiving ? Direction::kSendRecv : Direction::kSendOnly;
      init.stream_ids = {source->SyncGroup()};
      init.send_encodings = {encoding};
      auto result = peer.pc->AddTransceiver(track, init);
      RtcOk(result.error(), "RTC could not add the screen publication");
      transceiver_added = true;
      auto transceiver = result.MoveValue();
      ++peer.native_slots;
      cancellation->Check();
      GateSender(*transceiver->sender(), encoding.active);
      cancellation->Check();
      auto [inserted, fresh] = publications_.emplace(id,
          Publication{id, peer_id, source_id, requested, encoding.active,
                      std::move(source), nullptr, std::move(track), std::move(transceiver)});
      if (!fresh) throw Error("ERR_RTC_ID", "RTC allocated a duplicate publication identity");
      inserted->second.configured_video_encoding = {
          {"maxBitrateBps", encoding.max_bitrate_bps ? Json(*encoding.max_bitrate_bps) : Json(nullptr)},
          {"maxFramerate", encoding.max_framerate ? Json(*encoding.max_framerate) : Json(nullptr)}};
      inserted->second.metadata = PublicationMetadata(inserted->second);
      cancellation->Check();
      return inserted->second.metadata;
    } catch (...) {
      const bool pending_registration = registered && !publications_.contains(id);
      if (transceiver_added) Close(peer_id);
      if (pending_registration) host_.ForgetResource(id);
      throw;
    }

  }

  Json PublishAudio(Peer& peer, const Json& data, const std::shared_ptr<Cancellation>& cancellation) {
    Keys(data, {"sourceId", "enabled", "maxBitrateBps"});
    const auto source_id = Id(data, "sourceId");
    auto source = host_.FindAudioSource(source_id);
    if (!source) throw Error("ERR_RTC_AUDIO_SOURCE", "Audio source not found", MONKY_ENGINE_NOT_FOUND);
    if (!peer.retiring_audio.empty())
      throw Error("ERR_RTC_AUDIO_RENEGOTIATION", "Complete prior audio transceiver retirement negotiation first",
                  MONKY_ENGINE_BUSY);
    for (const auto& [id, publication] : publications_)
      if (publication.peer_id == peer.id && publication.audio_source)
        throw Error("ERR_RTC_AUDIO_PUBLISHER", "This peer already has a local audio publication", MONKY_ENGINE_BUSY);
    const bool requested = Boolean(data, "enabled");
    const auto encoding = audio::Encoding(data, requested && source->Enabled());
    Capacity();
    Slot(peer);
    const auto id = host_.AllocateHandle();
    const auto peer_id = peer.id;
    bool added = false;
    host_.RegisterResource(id, peer_id, source_id);
    try {
      cancellation->Check();
      auto track = host_.Factory()->CreateAudioTrack(
          "screen-audio-" + std::to_string(id), source->TrackSource().get());
      if (!track) throw Error("ERR_RTC_AUDIO_TRACK", "RTC could not create the PCM audio track");
      webrtc::RtpTransceiverInit init;
      init.direction = Direction::kSendOnly;
      init.stream_ids = {source->SyncGroup()};
      init.send_encodings = {encoding};
      auto result = peer.pc->AddTransceiver(track, init);
      RtcOk(result.error(), "RTC could not create a dedicated sendonly audio transceiver");
      added = true;
      auto transceiver = result.MoveValue();
      ++peer.native_slots;
      audio::PreferOpus(host_, *transceiver);
      GateSender(*transceiver->sender(), encoding.active);
      cancellation->Check();
      auto [entry, fresh] = publications_.emplace(id, Publication{
          id, peer_id, source_id, requested, encoding.active, nullptr,
          std::move(source), std::move(track), std::move(transceiver)});
      if (!fresh) throw Error("ERR_RTC_ID", "Audio publication ID was reused");
      entry->second.metadata = PublicationMetadata(entry->second);
      return entry->second.metadata;
    } catch (...) {
      const bool registered = !publications_.contains(id);
      if (added) Close(peer_id);
      if (registered) host_.ForgetResource(id);
      throw;
    }
  }

  Host& host_;
  std::map<std::uint64_t, std::unique_ptr<Peer>> peers_;
  std::map<std::uint64_t, Publication> publications_;
};

}  // namespace

std::unique_ptr<PeerController> CreatePeerController(Host& host) {
  return std::make_unique<NativePeerController>(host);
}

}  // namespace monky::native_rtc::engine
