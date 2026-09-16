#include "protocol_session.hpp"
#include "protocol.hpp"

#include <algorithm>
#include <iostream>
#include <stdexcept>
#include <utility>

using namespace monky::light;
using namespace std::chrono_literals;
namespace message = monky::protocol::message;

namespace {
void check(bool condition, const char* detail) {
  if (!condition) throw std::runtime_error(detail);
}
Json member(std::string id = "self", std::string session = "self:device") {
  return {{"id", id}, {"sessionId", session}, {"clientId", "client"}, {"nickname", "Human"},
          {"status", "VOICE"}, {"joinedAt", 1000}};
}
Json voice(std::string id = "self", std::string session = "self:device", std::string room = "room") {
  return {{"userId", id}, {"sessionId", session}, {"channelId", room},
          {"isMuted", false}, {"isDeafened", false}, {"serverMuted", false}, {"serverDeafened", false},
          {"isSpeaking", false}, {"isCameraOn", false}, {"isScreenSharing", false},
          {"isSharingScreenAudio", false}};
}
Json room(std::string id = "room") {
  return {{"id", id}, {"serverId", "server"}, {"name", "Voice"}, {"type", "VOICE"},
          {"position", 0}, {"createdAt", 1000}, {"isPrivate", false},
          {"allowedRoleIds", Json::array()}, {"botCommandsEnabled", false}};
}
Json authenticated(std::string mode = "p2p") {
  return {{"currentUser", member()}, {"voiceRestrictions", {{"serverMuted", false}, {"serverDeafened", false}}},
          {"server", {{"id", "server"}, {"name", "Test"}, {"createdAt", 1000}, {"maxUsers", 20},
                      {"voiceMode", mode}, {"channels", Json::array({room(), room("other")})},
                      {"members", Json::array({member()})}, {"voiceStates", Json::object()}}},
          {"iceServers", Json::array({Json{{"urls", Json::array({"stun:example.invalid:3478"})}}})}};
}
Json admission(bool peers = true) {
  Json participants = Json::array({Json{{"user", member()}, {"voiceState", voice()}}});
  if (peers) {
    participants.push_back({{"user", member("peer", "peer:a")}, {"voiceState", voice("peer", "peer:a")}});
    participants.push_back({{"user", member("peer", "peer:b")}, {"voiceState", voice("peer", "peer:b")}});
  }
  // The optional top-level user is deliberately absent.
  return {{"channelId", "room"}, {"userId", "self"}, {"sessionId", "self:device"},
          {"voiceState", voice()}, {"participants", participants}};
}
Json offer(std::string from = "peer:a", std::string target = "self:device") {
  return {{"fromSessionId", from}, {"targetSessionId", target}, {"signalType", "offer"},
          {"sdp", {{"type", "offer"}, {"sdp", "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"}}}};
}
Json departure(std::string session = "self:device", bool reconnect = false) {
  Json result{{"channelId", "room"}, {"userId", session == "self:device" ? "self" : "peer"},
              {"sessionId", session}};
  if (reconnect) result["reconnect"] = {{"id", "transition"}, {"from", "sfu"}, {"to", "p2p"}};
  return result;
}
Json settings() {
  return {{"name", "Test"}, {"hasPassword", false}, {"voiceMode", "p2p"},
          {"voiceTransition", {{"id", "transition"}, {"from", "sfu"}, {"to", "p2p"}}}};
}

struct Fixture {
  ProtocolSession::Time now{};
  std::vector<Json> sent;
  std::vector<SessionEvent> events;
  unsigned signedCount = 0;
  ProtocolSession::Nonce signedNonce{};
  std::function<void(const Json&)> onSend;
  std::function<void(const SessionEvent&)> onEvent;
  ProtocolSession session;

  explicit Fixture(std::size_t maxIncomingMessageBytes = ProtocolSession::defaultMaxIncomingMessageBytes)
      : session({"302a300506032b6570032100" + std::string(64, 'a'), "independent-device", "Human", "secret"},
                {[this](const std::string& frame) {
                   const auto value = Json::parse(frame);
                   sent.push_back(value);
                   if (onSend) onSend(value);
                 },
                 [this](const ProtocolSession::Nonce& nonce) {
                   ++signedCount;
                   signedNonce = nonce;
                   return std::string(128, 'b');
                 },
                 [] { return "test-id"; },
                 [this](const SessionEvent& event) {
                   events.push_back(event);
                   if (onEvent) onEvent(event);
                 }}, maxIncomingMessageBytes) {}

  void receive(std::string_view type, Json payload, std::string id = {}) {
    Json envelope{{"type", std::string(type)}, {"payload", std::move(payload)}};
    if (!id.empty()) envelope["requestId"] = std::move(id);
    session.receive(session.connection(), envelope.dump(), now);
  }
  std::string lastId() const { return sent.back().at("requestId").get<std::string>(); }
  std::size_t count(SessionEventKind kind) const {
    return static_cast<std::size_t>(std::count_if(events.begin(), events.end(), [kind](const SessionEvent& e) {
      return e.kind == kind;
    }));
  }
  std::size_t sentCount(std::string_view type) const {
    return static_cast<std::size_t>(std::count_if(sent.begin(), sent.end(), [type](const Json& value) {
      return value.at("type") == std::string(type);
    }));
  }
  void open() { session.opened(now, 123456); }
  void auth(std::string mode = "p2p") {
    open();
    const auto id = lastId();
    receive(message::AUTH_CHALLENGE, {{"nonce", std::string(64, '1')}}, id);
    receive(message::AUTH_SUCCESS, authenticated(mode), id);
    check(session.authentication().has_value(), "Authentication did not complete");
  }
  void join(bool peers = true) {
    session.join("room", now);
    receive(message::VOICE_USER_JOINED, admission(peers), lastId());
    check(session.phase() == SessionPhase::admitted, "Admission did not complete");
  }
  std::string capabilities(ProtocolSession::RpcCallback callback) {
    return session.request(std::string(message::SFU_GET_ROUTER_RTP_CAPABILITIES), {{"channelId", "room"}},
        {std::string(message::SFU_ROUTER_RTP_CAPABILITIES)}, std::move(callback), now, session.generation());
  }
  void pong() { receive(message::PONG, {{"timestamp", 1}}); }
};

void authenticationAndMalformedFrames() {
  Fixture f;
  f.open();
  const auto id = f.lastId();
  const auto& payload = f.sent.front().at("payload");
  check(payload.at("protocolVersion") == monky::protocol::VERSION, "Wrong generated protocol version");
  check(payload.at("deviceId") == "independent-device", "Device identity omitted");
  check(payload.at("publicKey").get<std::string>().size() == 88, "SPKI not transmitted");
  check(payload.at("password") == "secret" && !payload.contains("botToken"), "Not human auth");
  f.receive(message::AUTH_CHALLENGE, {{"nonce", std::string(64, '1')}}, "foreign");
  check(f.signedCount == 0, "Signed uncorrelated challenge");
  f.receive(message::AUTH_CHALLENGE, {{"nonce", std::string(64, 'x')}}, id);
  check(f.signedCount == 0 && f.count(SessionEventKind::failure) == 1, "Malformed nonce accepted");
  f.receive(message::AUTH_SUCCESS, authenticated(), id);
  check(!f.session.authentication(), "Authenticated without challenge");
  f.receive(message::AUTH_CHALLENGE, {{"nonce", std::string(64, '1')}}, id);
  check(f.signedCount == 1 && f.signedNonce.front() == 0x11, "Signed text instead of nonce bytes");
  check(f.lastId() == id && f.sent.back().at("payload").at("signature") == std::string(128, 'b'),
        "Challenge response correlation/payload incorrect");
  f.receive(message::AUTH_CHALLENGE, {{"nonce", std::string(64, '2')}}, id);
  check(f.signedCount == 1, "Repeated challenge signed twice");
  auto invalidAuth = authenticated();
  invalidAuth["currentUser"].erase("sessionId");
  f.receive(message::AUTH_SUCCESS, invalidAuth, id);
  check(!f.session.authentication(), "Missing live session accepted");
  f.receive(message::AUTH_SUCCESS, authenticated(), "foreign");
  check(!f.session.authentication(), "Foreign auth ID accepted");
  f.receive(message::AUTH_SUCCESS, authenticated(), id);
  check(f.session.authentication()->sessionId == "self:device", "Lost session identity");
  check(f.session.authentication()->iceServers.has_value(), "Lost ICE configuration");
  const auto failures = f.count(SessionEventKind::failure);
  f.session.receive(f.session.connection(), "{", f.now);
  f.receive(message::PONG, {{"timestamp", "bad"}});
  check(f.count(SessionEventKind::failure) == failures + 2, "Malformed frames not surfaced");
  // Unknown content is never dispatched or interpreted, even when payload is not an object.
  f.receive("CHAT_MESSAGE", Json::array({"<script>never execute</script>"}));
  check(f.count(SessionEventKind::failure) == failures + 2, "Unrelated content inspected");
  const Json largeOptional{{"audio", std::string(2 * 1024 * 1024, 'A')}};
  f.receive("SOUNDBOARD_PLAY", largeOptional);
  check(f.count(SessionEventKind::failure) == failures + 2 &&
        f.session.phase() == SessionPhase::ready, "Legitimate optional broadcast exceeded default capacity");
  Fixture bounded(1024 * 1024);
  bounded.auth();
  bounded.receive("SOUNDBOARD_PLAY", largeOptional);
  check(bounded.count(SessionEventKind::failure) == 1 &&
        bounded.session.phase() == SessionPhase::ready, "Configured full-message bound was not enforced safely");
}

void authoritativeAdmissionAndRouting() {
  Fixture f;
  f.auth();
  f.session.join("room", f.now);
  const auto id = f.lastId();
  auto broadcast = admission();
  broadcast.erase("participants");
  f.receive(message::VOICE_USER_JOINED, broadcast);
  check(!f.session.admission() && f.count(SessionEventKind::admitted) == 0, "Broadcast admitted self");
  f.receive(message::RTC_SIGNAL, offer());
  check(f.count(SessionEventKind::rtcSignal) == 0, "Early signal published before admission");
  f.receive(message::RTC_SIGNAL, offer("stranger"));
  auto bad = admission();
  bad["userId"] = "other";
  f.receive(message::VOICE_USER_JOINED, bad, id);
  check(!f.session.admission(), "Top-level user mismatch accepted");
  bad = admission();
  bad["sessionId"] = "self:wrong";
  f.receive(message::VOICE_USER_JOINED, bad, id);
  check(!f.session.admission(), "Top-level session mismatch accepted");
  bad = admission();
  bad["participants"][1]["voiceState"]["channelId"] = "other";
  f.receive(message::VOICE_USER_JOINED, bad, id);
  check(!f.session.admission(), "Foreign roster channel accepted");
  bad = admission();
  bad["participants"].push_back(bad["participants"][1]);
  f.receive(message::VOICE_USER_JOINED, bad, id);
  check(!f.session.admission(), "Duplicate session roster accepted");
  f.receive(message::VOICE_USER_JOINED, admission(), "foreign");
  check(!f.session.admission(), "Foreign request admitted self");
  f.receive(message::VOICE_USER_JOINED, admission(), id);
  check(f.session.admission()->participants.size() == 3, "Peers keyed by user rather than session");
  check(f.count(SessionEventKind::rtcSignal) == 1, "Known early signal not flushed");
  check(f.session.admission()->participants.count("stranger") == 0, "Signal created membership");
  f.receive(message::RTC_SIGNAL, offer("peer:a", "foreign"));
  check(f.count(SessionEventKind::rtcSignal) == 1, "Foreign target signal forwarded");
  f.receive(message::VOICE_USER_LEFT, departure("peer:a"));
  check(f.session.admission()->participants.count("peer:b") == 1, "Leaving one device removed another");
  check(f.session.admission()->participants.count("peer:a") == 0, "Peer was not removed");
  auto newPeer = Json{{"channelId", "room"}, {"userId", "peer"}, {"sessionId", "peer:c"},
                      {"voiceState", voice("peer", "peer:c")}};
  f.receive(message::VOICE_USER_JOINED, newPeer);
  check(f.session.admission()->participants.count("peer:c") == 1, "Optional user incorrectly required");
  auto outgoing = offer("fake", "peer:c");
  check(f.session.sendSignal(outgoing, f.session.generation()), "Valid session signal rejected");
  check(f.sent.back()["payload"]["fromSessionId"] == "self:device", "Sender not bound to self");
  check(!f.session.sendSignal(offer("fake", "peer"), f.session.generation()), "User ID accepted as peer ID");
  const auto generation = f.session.generation();
  f.session.leave();
  check(!f.session.sendSignal(outgoing, generation), "Late media callback resurrected departed call");
  f.receive(message::VOICE_USER_JOINED, admission(), id);
  check(!f.session.admission(), "Late admission resurrected call");
}

void policyAndRestrictions() {
  Fixture f;
  f.auth();
  f.join(false);
  f.session.setDeafened(true);
  check(f.session.policy().suppressMicrophone() && f.session.policy().suppressPlayback(), "Deafen ineffective");
  check(f.sent.back()["payload"]["isMuted"] == true, "Deafen did not mute wire state");
  f.session.setDeafened(false);
  check(!f.session.policy().muted && !f.session.policy().deafened, "Undeafen did not restore mic");
  f.session.setMuted(true);
  f.session.setDeafened(true);
  f.session.setDeafened(false);
  check(f.session.policy().muted, "Undeafen lost prior mute");
  f.receive(message::VOICE_RESTRICTIONS_UPDATED,
            {{"userId", "self"}, {"serverMuted", true}, {"serverDeafened", true}});
  f.session.setMuted(false);
  check(f.session.policy().suppressMicrophone() && f.session.policy().suppressPlayback(),
        "Manual state overrode administrator restrictions");
  auto self = voice();
  self["serverMuted"] = true;
  f.receive(message::VOICE_STATE_CHANGED, {{"voiceState", self}});
  check(f.session.policy().serverMuted && !f.session.policy().serverDeafened, "Own state restrictions ignored");
  f.receive(message::VOICE_RESTRICTIONS_UPDATED,
            {{"userId", "self"}, {"serverMuted", false}, {"serverDeafened", false}});
  check(!f.session.policy().suppressMicrophone(), "Restriction removal not applied");
  f.session.setMuted(false);
  const auto staleControl = f.lastId();
  f.session.setMuted(true);
  const auto newestControl = f.lastId();
  auto unmutedEcho = voice();
  f.receive(message::VOICE_STATE_CHANGED, {{"voiceState", unmutedEcho}}, staleControl);
  check(f.session.policy().muted, "Late state echo reopened locally muted microphone");
  auto mutedEcho = voice();
  mutedEcho["isMuted"] = true;
  f.receive(message::VOICE_STATE_CHANGED, {{"voiceState", mutedEcho}}, newestControl);
  check(f.session.policy().muted, "Newest state acknowledgment lost manual mute");
  const auto before = f.count(SessionEventKind::failure);
  self.erase("serverMuted");
  f.receive(message::VOICE_STATE_CHANGED, {{"voiceState", self}});
  check(f.count(SessionEventKind::failure) == before + 1, "Malformed restriction silently defaulted");
}

void rpcCorrelationAndCancellation() {
  Fixture f;
  f.auth("sfu");
  f.join();
  std::vector<RpcResult> results;
  auto callback = [&](RpcResult result) { results.push_back(std::move(result)); };
  const auto id = f.capabilities(callback);
  f.receive(message::SFU_PRODUCED, {{"channelId", "room"}, {"id", "wrong-type"}}, id);
  check(results.empty(), "RPC resolved wrong expected type");
  f.receive(message::SFU_ROUTER_RTP_CAPABILITIES,
            {{"channelId", "room"}, {"rtpCapabilities", {{"codecs", Json::array()}}}}, "foreign");
  check(results.empty(), "RPC resolved foreign ID");
  f.receive(message::SFU_ROUTER_RTP_CAPABILITIES,
            {{"channelId", "other"}, {"rtpCapabilities", {{"codecs", Json::array()}}}}, id);
  check(results.empty(), "RPC accepted foreign channel");
  f.receive(message::SFU_ROUTER_RTP_CAPABILITIES,
            {{"channelId", "room"}, {"rtpCapabilities", {{"codecs", Json::array()}}}}, id);
  check(results.size() == 1 && !results.back().failure, "RPC failed valid reply");
  auto consume = f.session.request(std::string(message::SFU_CONSUME),
      {{"channelId", "room"}, {"transportId", "recv"}, {"producerId", "producer"},
       {"rtpCapabilities", Json::object()}}, {std::string(message::SFU_CONSUMED)},
      callback, f.now, f.session.generation());
  f.receive(message::SFU_PRODUCER_CLOSED, {{"channelId", "room"}, {"producerId", "foreign"}}, consume);
  check(results.size() == 1, "Consume resolved wrong producer");
  f.receive(message::SFU_PRODUCER_CLOSED, {{"channelId", "room"}, {"producerId", "producer"}}, consume);
  check(results.size() == 2 && !results.back().failure &&
        results.back().type == message::SFU_PRODUCER_CLOSED, "Consume-close race not accepted");
  const auto denied = f.capabilities(callback);
  f.receive(message::SERVER_ERROR,
            {{"code", std::string(monky::protocol::error::SFU_UNAVAILABLE)}, {"message", "Unavailable"}}, denied);
  check(results.size() == 3 && results.back().failure->code == monky::protocol::error::SFU_UNAVAILABLE,
        "SERVER_ERROR did not fail RPC");
  const auto authFailed = f.capabilities(callback);
  f.receive(message::AUTH_FAILED, {{"message", "Denied"}}, authFailed);
  check(results.size() == 4 && results.back().failure->kind == FailureKind::authentication,
        "AUTH_FAILED did not fail RPC");
  const auto cancelled = f.capabilities(callback);
  f.session.cancel(cancelled);
  check(results.size() == 5 && results.back().failure->kind == FailureKind::cancelled, "Cancel omitted callback");
  f.receive(message::SFU_ROUTER_RTP_CAPABILITIES,
            {{"channelId", "room"}, {"rtpCapabilities", {{"codecs", Json::array()}}}}, cancelled);
  check(results.size() == 5, "Cancelled RPC completed twice");
  f.capabilities(callback);
  f.capabilities(callback);
  f.session.disconnected(f.session.connection(), f.now);
  check(results.size() == 7 && results.back().failure->kind == FailureKind::disconnected,
        "Disconnect did not cancel every pending request");
}

void deadlinesAndReconnect() {
  Fixture f;
  f.session.join("room", f.now);
  f.auth();
  check(f.session.phase() == SessionPhase::joining, "Desired room not joined after auth");
  f.receive(message::VOICE_USER_JOINED, admission(), f.lastId());
  const auto oldConnection = f.session.connection();
  const auto oldGeneration = f.session.generation();
  check(f.session.nextDeadline() == f.now + 5s, "Incorrect heartbeat deadline");
  f.now += 5s;
  f.session.tick(f.now, 999);
  check(f.sent.back()["type"] == std::string(message::PING) &&
        f.sent.back()["payload"]["timestamp"] == 999, "Missing timestamped heartbeat");
  f.pong();
  f.now += 12s;
  f.session.tick(f.now, 1000);
  check(f.session.phase() == SessionPhase::offline && !f.session.admission(), "PONG deadline did not disconnect");
  check(f.session.desiredChannel() == "room", "Unexpected disconnect lost rejoin intention");
  check(f.session.nextDeadline() == f.now + 1s, "Incorrect reconnect backoff");
  f.now += 1s;
  f.session.tick(f.now, 1001);
  check(f.count(SessionEventKind::reconnectRequested) == 1, "No reconnect intention emitted");
  f.auth();
  check(f.session.connection() != oldConnection && f.session.generation() != oldGeneration,
        "Reconnect did not retire generations");
  f.session.disconnected(oldConnection, f.now);
  check(f.session.phase() == SessionPhase::joining, "Old socket disconnected new session");
  f.receive(message::VOICE_USER_JOINED, admission(), f.lastId());

  Fixture auth;
  auth.open();
  auth.now += 10s;
  auth.pong();
  auth.now += 5s;
  auth.session.tick(auth.now, 0);
  check(auth.session.phase() == SessionPhase::offline, "Auth deadline not enforced");

  Fixture rpc;
  rpc.auth("sfu");
  rpc.join();
  std::optional<Failure> failure;
  rpc.capabilities([&](RpcResult result) { failure = result.failure; });
  rpc.now += 10s;
  rpc.pong();
  rpc.session.tick(rpc.now, 0);
  check(failure && failure->kind == FailureKind::timeout, "RPC timeout not delivered");

  Fixture join;
  join.auth();
  join.session.join("room", join.now);
  join.now += 10s;
  join.pong();
  join.session.tick(join.now, 0);
  check(!join.session.desiredChannel() && join.sentCount(message::VOICE_LEAVE) == 1,
        "Timed-out ambiguous admission was not cleaned up");
}

void kicksAndLogout() {
  Fixture f;
  f.auth();
  f.join();
  f.receive(message::ADMIN_KICK_VOICE, {{"targetSessionId", "self:device"}});
  check(!f.session.admission() && !f.session.desiredChannel(), "Kick retained automatic rejoin");
  f.session.disconnected(f.session.connection(), f.now);
  f.auth();
  check(f.session.phase() == SessionPhase::ready, "Kicked channel rejoined on reconnect");
  f.receive(message::MEMBER_KICKED, {{"userId", "self"}, {"nickname", "Human"}});
  check(f.session.phase() == SessionPhase::stopped && !f.session.nextDeadline(), "Server kick kept reconnecting");

  Fixture logout;
  logout.auth();
  logout.join();
  logout.session.logout();
  check(logout.sent.back()["type"] == std::string(message::USER_LOGOUT), "Logout not sent");
  check(logout.session.phase() == SessionPhase::stopped && !logout.session.admission(), "Logout kept call alive");
  logout.receive(message::VOICE_USER_JOINED, admission());
  check(!logout.session.admission(), "Late broadcast resurrected logged-out call");
}

void topologyTransitions() {
  Fixture p2p;
  p2p.auth();
  p2p.join();
  const auto generation = p2p.session.generation();
  p2p.receive(message::SERVER_SETTINGS_UPDATED, {{"voiceMode", "sfu"}});
  check(p2p.session.phase() == SessionPhase::admitted && p2p.session.admission()->participants.size() == 3,
        "P2P to SFU falsely dropped membership");
  check(p2p.session.generation() != generation && p2p.count(SessionEventKind::topologyChanged) == 1,
        "Topology switch did not fence media generation");
  check(p2p.sentCount(message::VOICE_LEAVE) == 0, "P2P to SFU sent unnecessary leave");

  Fixture sfu;
  sfu.auth("sfu");
  sfu.join();
  sfu.receive(message::VOICE_USER_LEFT, departure("self:device", true));
  check(!sfu.session.admission() && sfu.session.phase() == SessionPhase::transitioning, "No transition teardown");
  check(sfu.sentCount(message::VOICE_LEAVE) == 0 && sfu.sentCount(message::VOICE_RECONNECT) == 0,
        "Transition cancelled grant or reconnected before settings");
  sfu.receive(message::SERVER_SETTINGS_UPDATED, settings());
  check(sfu.sentCount(message::VOICE_RECONNECT) == 1 && sfu.session.voiceMode() == VoiceMode::p2p,
        "Matching transition did not request reconnect");
  const auto reconnect = sfu.lastId();
  check(sfu.sent.back()["payload"]["transitionId"] == "transition", "Reconnect omitted grant ID");
  sfu.receive(message::SERVER_SETTINGS_UPDATED, settings());
  sfu.receive(message::VOICE_USER_LEFT, departure("self:device", true));
  check(sfu.sentCount(message::VOICE_RECONNECT) == 1 && sfu.session.phase() == SessionPhase::joining,
        "Duplicate transition reused grant or cancelled in-flight reconnect");
  sfu.receive(message::VOICE_USER_JOINED, admission(), reconnect);
  check(!sfu.session.admission(), "Ordinary admission accepted as reconnect reply");
  sfu.receive(message::VOICE_RECONNECTED, admission(), reconnect);
  check(sfu.session.admission() && sfu.session.voiceMode() == VoiceMode::p2p, "Reconnect roster not accepted");
  sfu.receive(message::VOICE_USER_LEFT, departure("self:device", true));
  check(sfu.session.admission().has_value(), "Late duplicate transition removed new call");

  Fixture reverse;
  reverse.auth("sfu");
  reverse.join();
  reverse.receive(message::SERVER_SETTINGS_UPDATED, settings());
  check(reverse.session.admission().has_value(), "Settings alone dropped membership");
  reverse.receive(message::VOICE_USER_LEFT, departure("self:device", true));
  check(reverse.sentCount(message::VOICE_RECONNECT) == 1 && reverse.session.voiceMode() == VoiceMode::p2p,
        "Settings-first transition order unsupported");

  Fixture cancelled;
  cancelled.auth("sfu");
  cancelled.join();
  cancelled.receive(message::VOICE_USER_LEFT, departure("self:device", true));
  cancelled.session.leave();
  cancelled.receive(message::SERVER_SETTINGS_UPDATED, settings());
  check(cancelled.sentCount(message::VOICE_RECONNECT) == 0, "Manual leave did not cancel grant");

  Fixture expired;
  expired.auth("sfu");
  expired.join();
  expired.receive(message::VOICE_USER_LEFT, departure("self:device", true));
  for (unsigned i = 0; i < 6; ++i) {
    expired.now += 5s;
    expired.pong();
    expired.session.tick(expired.now, 0);
  }
  expired.receive(message::SERVER_SETTINGS_UPDATED, settings());
  check(!expired.session.desiredChannel() && expired.sentCount(message::VOICE_RECONNECT) == 0,
        "Expired grant retried or silently ordinary-joined");
}

void adversarialLifecycleEdges() {
  Fixture restricted;
  restricted.open();
  const auto authId = restricted.lastId();
  restricted.receive(message::AUTH_CHALLENGE, {{"nonce", std::string(64, '1')}}, authId);
  auto authPayload = authenticated();
  authPayload["voiceRestrictions"]["serverMuted"] = true;
  restricted.receive(message::AUTH_SUCCESS, authPayload, authId);
  check(restricted.session.policy().serverMuted, "Auth restrictions not applied");
  restricted.session.join("room", restricted.now);
  const auto joinId = restricted.lastId();
  restricted.session.setMuted(true);
  auto restrictedAdmission = admission();
  restrictedAdmission["participants"][0]["voiceState"]["serverMuted"] = true;
  restricted.receive(message::VOICE_USER_JOINED, restrictedAdmission, joinId);
  check(restricted.session.policy().muted && restricted.sent.back()["type"] == std::string(message::VOICE_STATE_UPDATE),
        "Joining response overwrote a newer local mute");
  check(restricted.session.policy().serverMuted, "Admission ignored fresher authoritative roster restrictions");
  restricted.receive(message::ADMIN_MOVE_USER, {{"targetSessionId", "self:device"}, {"channelId", "other"}});
  check(restricted.session.phase() == SessionPhase::joining &&
        restricted.session.desiredChannel() == "other", "Administrative move not readmitted");
  restricted.receive(message::VOICE_USER_LEFT, departure());
  check(restricted.session.phase() == SessionPhase::joining, "Old-room departure cancelled administrative move");

  Fixture peer;
  peer.auth();
  peer.join(false);
  peer.receive(message::VOICE_USER_JOINED,
      {{"channelId", "room"}, {"userId", "peer"}, {"sessionId", "peer:a"},
       {"voiceState", voice("peer", "peer:a")}}, "administrator-request");
  check(peer.session.admission()->participants.count("peer:a") == 1,
        "Correlated administrative broadcast discarded");
  peer.receive(message::CHANNEL_DELETED, {{"channelId", "room"}});
  check(!peer.session.admission() && !peer.session.desiredChannel(), "Deleted channel retained a call");

  Fixture bounded;
  bounded.auth();
  bounded.session.join("room", bounded.now);
  const auto boundedId = bounded.lastId();
  for (unsigned i = 0; i < 33; ++i) bounded.receive(message::RTC_SIGNAL, offer("stranger-" + std::to_string(i)));
  check(bounded.count(SessionEventKind::failure) == 1, "Early signaling was not bounded");
  bounded.now += 5s;
  bounded.session.tick(bounded.now, 0);
  bounded.receive(message::VOICE_USER_JOINED, admission(), boundedId);
  check(bounded.count(SessionEventKind::rtcSignal) == 0, "Unknown early peers were published");

  Fixture backoff;
  backoff.session.connectFailed(backoff.now);
  check(backoff.session.nextDeadline() == backoff.now + 1s, "Initial dial failure not retried");
  backoff.now += 1s;
  backoff.session.tick(backoff.now, 0);
  backoff.session.connectFailed(backoff.now);
  check(backoff.session.nextDeadline() == backoff.now + 2s, "Second dial failure backoff incorrect");

  Fixture late;
  late.auth("sfu");
  late.join();
  std::optional<Failure> lateFailure;
  const auto lateId = late.capabilities([&](RpcResult result) { lateFailure = result.failure; });
  late.now += 10s;
  late.receive(message::SFU_ROUTER_RTP_CAPABILITIES,
      {{"channelId", "room"}, {"rtpCapabilities", {{"codecs", Json::array()}}}}, lateId);
  check(lateFailure && lateFailure->kind == FailureKind::timeout, "Late reply beat deadline without tick");

  Fixture noFallback;
  noFallback.auth("sfu");
  noFallback.join();
  noFallback.receive(message::SERVER_SETTINGS_UPDATED, {{"voiceMode", "p2p"}});
  check(noFallback.session.voiceMode() == VoiceMode::sfu && noFallback.session.admission(),
        "SFU silently fell back without reconnect grant");
  noFallback.receive(message::VOICE_USER_LEFT, departure("self:device", true));
  noFallback.receive(message::SERVER_SETTINGS_UPDATED, {{"voiceMode", "sfu"}});
  noFallback.receive(message::SERVER_SETTINGS_UPDATED, settings());
  check(noFallback.sentCount(message::VOICE_RECONNECT) == 0,
        "Subsequent topology change did not invalidate old grant");

  Fixture failedGrant;
  failedGrant.auth("sfu");
  failedGrant.join();
  failedGrant.receive(message::VOICE_USER_LEFT, departure("self:device", true));
  failedGrant.receive(message::SERVER_SETTINGS_UPDATED, settings());
  const auto reconnectId = failedGrant.lastId();
  failedGrant.receive(message::SERVER_ERROR,
      {{"code", std::string(monky::protocol::error::VOICE_RECONNECT_EXPIRED)}, {"message", "Expired"}}, reconnectId);
  failedGrant.receive(message::SERVER_SETTINGS_UPDATED, settings());
  check(failedGrant.sentCount(message::VOICE_RECONNECT) == 1 && !failedGrant.session.desiredChannel(),
        "Rejected one-use reconnect was retried");

  Fixture roster;
  roster.auth("sfu");
  roster.join();
  std::optional<Failure> cancelledReply;
  const auto rosterId = roster.session.request(std::string(message::SFU_GET_PRODUCERS),
      {{"channelId", "room"}}, {std::string(message::SFU_PRODUCERS_LIST)},
      [&](RpcResult result) { cancelledReply = result.failure; }, roster.now, roster.session.generation());
  roster.onEvent = [&](const SessionEvent& event) {
    if (event.kind == SessionEventKind::rosterChanged) roster.session.leave();
  };
  roster.receive(message::SFU_PRODUCERS_LIST,
      {{"channelId", "room"}, {"producers", Json::array()}, {"participants", admission()["participants"]}}, rosterId);
  check(cancelledReply && cancelledReply->kind == FailureKind::cancelled,
        "Reentrant teardown allowed queued successful RPC to recreate media");
}

void synchronousReentrancy() {
  Fixture f;
  f.onSend = [&](const Json& frame) {
    const auto type = frame.at("type").get<std::string>();
    const auto id = frame.contains("requestId") ? frame.at("requestId").get<std::string>() : "";
    if (type == message::AUTH_CONNECT)
      f.receive(message::AUTH_CHALLENGE, {{"nonce", std::string(64, '1')}}, id);
    else if (type == message::AUTH_CHALLENGE_RESPONSE)
      f.receive(message::AUTH_SUCCESS, authenticated("sfu"), id);
    else if (type == message::VOICE_JOIN)
      f.receive(message::VOICE_USER_JOINED, admission(), id);
    else if (type == message::SFU_GET_ROUTER_RTP_CAPABILITIES)
      f.receive(message::SFU_ROUTER_RTP_CAPABILITIES,
          {{"channelId", "room"}, {"rtpCapabilities", {{"codecs", Json::array()}}}}, id);
  };
  f.open();
  f.session.join("room", f.now);
  check(f.session.admission().has_value(), "Synchronous auth/admission callback raced state registration");
  unsigned completed = 0;
  f.capabilities([&](RpcResult result) {
    check(!result.failure, "Synchronous RPC failed");
    ++completed;
    f.session.leave();
  });
  check(completed == 1 && !f.session.admission(), "Reentrant callback invalidated pending iteration");

  Fixture abandoned;
  abandoned.auth();
  abandoned.session.join("room", abandoned.now);
  const auto id = abandoned.lastId();
  abandoned.receive(message::RTC_SIGNAL, offer());
  abandoned.onEvent = [&](const SessionEvent& event) {
    if (event.kind == SessionEventKind::policyChanged) abandoned.session.leave();
  };
  abandoned.receive(message::VOICE_USER_JOINED, admission(), id);
  check(!abandoned.session.admission() && abandoned.count(SessionEventKind::admitted) == 0 &&
        abandoned.count(SessionEventKind::rtcSignal) == 0, "Queued event resurrected a reentrantly departed call");
}
} // namespace

int main() {
  try {
    authenticationAndMalformedFrames();
    authoritativeAdmissionAndRouting();
    policyAndRestrictions();
    rpcCorrelationAndCancellation();
    deadlinesAndReconnect();
    kicksAndLogout();
    topologyTransitions();
    adversarialLifecycleEdges();
    synchronousReentrancy();
    std::cout << "Protocol session: 9 focused native test groups passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "Protocol session test failure: " << error.what() << '\n';
    return 1;
  }
}
