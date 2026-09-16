#include "protocol_session.hpp"
#include "protocol.hpp"

#include <algorithm>
#include <cctype>
#include <stdexcept>
#include <utility>

namespace monky::light {
namespace {
namespace msg = monky::protocol::message;
using namespace std::chrono_literals;

constexpr auto authTimeout = 15s;
constexpr auto rpcTimeout = 10s;
// NetworkClient uses 12s, not the unrelated shared 35s timeout.
constexpr auto pongTimeout = 12s;
constexpr auto transitionTimeout = 30s;
constexpr auto earlySignalTimeout = 5s;
constexpr std::size_t maxEarlySignals = 32;
constexpr std::size_t maxSignalBytes = 128 * 1024;

struct Invalid : std::runtime_error {
  explicit Invalid(const char* detail) : std::runtime_error(detail) {}
};
void require(bool condition, const char* detail) {
  if (!condition) throw Invalid(detail);
}
const Json& field(const Json& object, const char* key) {
  require(object.is_object() && object.contains(key), "Missing required field");
  return object.at(key);
}
std::string text(const Json& object, const char* key) {
  const auto& value = field(object, key);
  require(value.is_string() && !value.get_ref<const std::string&>().empty(), "Expected nonempty string");
  return value.get<std::string>();
}
bool boolean(const Json& object, const char* key) {
  const auto& value = field(object, key);
  require(value.is_boolean(), "Expected boolean");
  return value.get<bool>();
}
void number(const Json& object, const char* key) {
  require(field(object, key).is_number(), "Expected number");
}
void objectField(const Json& object, const char* key) {
  require(field(object, key).is_object(), "Expected object");
}
void arrayField(const Json& object, const char* key) {
  require(field(object, key).is_array(), "Expected array");
}
void strings(const Json& array) {
  require(array.is_array(), "Expected string array");
  for (const auto& value : array)
    require(value.is_string(), "Expected string array entry");
}
bool hex(const std::string& value, std::size_t size) {
  return value.size() == size && std::all_of(value.begin(), value.end(), [](unsigned char c) {
    return std::isxdigit(c) != 0;
  });
}
VoiceMode voiceMode(const Json& object) {
  const auto mode = text(object, "voiceMode");
  require(mode == "p2p" || mode == "sfu", "Unsupported voice mode");
  return mode == "p2p" ? VoiceMode::p2p : VoiceMode::sfu;
}
void user(const Json& value) {
  text(value, "id");
  text(value, "clientId");
  text(value, "nickname");
  const auto status = text(value, "status");
  require(status == "ONLINE" || status == "IDLE" || status == "VOICE" || status == "DISCONNECTED",
          "Invalid user status");
  number(value, "joinedAt");
  if (value.contains("sessionId")) text(value, "sessionId");
  if (value.contains("connectedAt")) number(value, "connectedAt");
  if (value.contains("isBot")) boolean(value, "isBot");
}
void channel(const Json& value) {
  text(value, "id");
  text(value, "serverId");
  text(value, "name");
  const auto type = text(value, "type");
  require(type == "VOICE" || type == "TEXT", "Invalid channel type");
  number(value, "position");
  number(value, "createdAt");
  boolean(value, "isPrivate");
  boolean(value, "botCommandsEnabled");
  strings(field(value, "allowedRoleIds"));
  if (value.contains("maxParticipants")) number(value, "maxParticipants");
}
void state(const Json& value) {
  text(value, "sessionId");
  text(value, "userId");
  text(value, "channelId");
  for (const auto* key : {"isMuted", "isDeafened", "serverMuted", "serverDeafened",
                          "isSpeaking", "isCameraOn", "isScreenSharing", "isSharingScreenAudio"})
    boolean(value, key);
  if (value.contains("screenShareIds")) strings(value.at("screenShareIds"));
  if (value.contains("connectionHealth")) {
    const auto health = text(value, "connectionHealth");
    require(health == "connecting" || health == "connected" || health == "reconnecting" ||
            health == "failed", "Invalid voice health");
  }
}
Participant participant(const Json& voiceState, const Json* member, const std::string& room) {
  state(voiceState);
  require(text(voiceState, "channelId") == room, "Foreign channel in roster");
  Participant result{text(voiceState, "userId"), text(voiceState, "sessionId"), voiceState, std::nullopt};
  if (member) {
    user(*member);
    require(text(*member, "id") == result.userId, "Mismatched roster user");
    // UserSummary.sessionId is optional. VoiceParticipantState.sessionId is not.
    if (member->contains("sessionId"))
      require(text(*member, "sessionId") == result.sessionId, "Mismatched roster session");
    result.user = *member;
  }
  return result;
}
std::map<std::string, Participant> roster(const Json& values, const std::string& room) {
  require(values.is_array(), "Missing authoritative participants");
  std::map<std::string, Participant> result;
  for (const auto& value : values) {
    const auto& member = field(value, "user");
    auto parsed = participant(field(value, "voiceState"), &member, room);
    const auto key = parsed.sessionId;
    require(result.emplace(key, std::move(parsed)).second, "Duplicate roster session");
  }
  return result;
}
Participant joined(const Json& payload) {
  const auto room = text(payload, "channelId");
  const auto* member = payload.contains("user") ? &payload.at("user") : nullptr;
  auto result = participant(field(payload, "voiceState"), member, room);
  require(text(payload, "userId") == result.userId &&
          text(payload, "sessionId") == result.sessionId, "Mismatched join identity");
  return result;
}
std::string transitionId(const Json& value) {
  require(text(value, "from") == "sfu" && text(value, "to") == "p2p", "Invalid voice transition");
  return text(value, "id");
}
void signal(const Json& payload) {
  text(payload, "targetSessionId");
  text(payload, "fromSessionId");
  const auto type = text(payload, "signalType");
  if (type == "offer" || type == "answer") {
    const auto& sdp = field(payload, "sdp");
    require(text(sdp, "type") == type, "Mismatched SDP type");
    text(sdp, "sdp");
  } else if (type == "candidate") {
    const auto& candidate = field(payload, "candidate");
    text(candidate, "candidate");
    for (const auto* key : {"sdpMid", "usernameFragment"})
      if (candidate.contains(key))
        require(candidate.at(key).is_null() || candidate.at(key).is_string(), "Invalid ICE field");
    if (candidate.contains("sdpMLineIndex"))
      require(candidate.at("sdpMLineIndex").is_null() ||
              (candidate.at("sdpMLineIndex").is_number_integer() &&
               candidate.at("sdpMLineIndex") >= 0), "Invalid ICE m-line");
  } else if (type == "screen-audio-meta" || type == "screen-video-meta") {
    text(payload, "streamId");
  } else {
    require(type == "user-left", "Invalid signal type");
  }
  require(payload.dump().size() <= maxSignalBytes, "Signal exceeds native queue limit");
}
std::vector<std::string> replies(std::string_view type) {
  if (type == msg::SFU_GET_ROUTER_RTP_CAPABILITIES) return {std::string(msg::SFU_ROUTER_RTP_CAPABILITIES)};
  if (type == msg::SFU_CREATE_WEBRTC_TRANSPORT) return {std::string(msg::SFU_WEBRTC_TRANSPORT_CREATED)};
  if (type == msg::SFU_CONNECT_WEBRTC_TRANSPORT) return {std::string(msg::SFU_WEBRTC_TRANSPORT_CONNECTED)};
  if (type == msg::SFU_PRODUCE) return {std::string(msg::SFU_PRODUCED)};
  if (type == msg::SFU_GET_PRODUCERS) return {std::string(msg::SFU_PRODUCERS_LIST)};
  if (type == msg::SFU_CONSUME)
    return {std::string(msg::SFU_CONSUMED), std::string(msg::SFU_PRODUCER_CLOSED)};
  return {};
}
bool relevant(std::string_view type) {
  for (auto value : {
         msg::AUTH_CHALLENGE, msg::AUTH_SUCCESS, msg::AUTH_FAILED, msg::SERVER_ERROR, msg::PONG,
         msg::SERVER_SHUTDOWN, msg::VOICE_USER_JOINED, msg::VOICE_USER_LEFT, msg::VOICE_RECONNECTED,
         msg::VOICE_STATE_CHANGED, msg::VOICE_RESTRICTIONS_UPDATED, msg::RTC_SIGNAL,
         msg::ADMIN_KICK_VOICE, msg::MEMBER_KICKED, msg::ADMIN_MOVE_USER, msg::SERVER_SETTINGS_UPDATED,
         msg::CHANNEL_CREATED, msg::CHANNEL_UPDATED, msg::CHANNEL_DELETED,
         msg::SFU_ROUTER_RTP_CAPABILITIES, msg::SFU_WEBRTC_TRANSPORT_CREATED,
         msg::SFU_WEBRTC_TRANSPORT_CONNECTED, msg::SFU_PRODUCED, msg::SFU_PRODUCERS_LIST,
         msg::SFU_CONSUMED, msg::SFU_NEW_PRODUCER, msg::SFU_PRODUCER_CLOSED, msg::SFU_CONSUMER_CLOSED})
    if (type == value) return true;
  return false;
}
Failure cancelled() { return {FailureKind::cancelled, {}, "Voice generation retired"}; }
} // namespace

ProtocolSession::ProtocolSession(Identity identity, Callbacks callbacks, std::size_t maxIncomingMessageBytes)
    : identity_(std::move(identity)), callbacks_(std::move(callbacks)),
      maxIncomingMessageBytes_(maxIncomingMessageBytes) {
  if (maxIncomingMessageBytes_ == 0)
    throw std::invalid_argument("Incoming message limit must be positive");
  if (!callbacks_.outbound || !callbacks_.signNonce || !callbacks_.requestId || !callbacks_.event)
    throw std::invalid_argument("ProtocolSession requires all callbacks");
  std::string key = identity_.publicKeyHex;
  std::transform(key.begin(), key.end(), key.begin(), [](unsigned char c) {
    return static_cast<char>(std::tolower(c));
  });
  if (!hex(key, 88) || key.substr(0, 24) != "302a300506032b6570032100" ||
      identity_.deviceId.empty() || identity_.nickname.empty())
    throw std::invalid_argument("Invalid native authentication identity");
  identity_.publicKeyHex = std::move(key);
}

void ProtocolSession::flush() {
  if (flushing_) return;
  flushing_ = true;
  while (!effects_.empty()) {
    auto effect = std::move(effects_.front());
    effects_.pop_front();
    effect();
  }
  flushing_ = false;
}

void ProtocolSession::event(SessionEventKind kind, std::string type, Json payload) {
  SessionEvent value{kind, connection_, generation_, std::move(type), std::move(payload), std::nullopt};
  effects_.push_back([this, value = std::move(value)] {
    const auto kind = value.kind;
    const bool callScoped = kind == SessionEventKind::admitted || kind == SessionEventKind::rtcSignal ||
        kind == SessionEventKind::peerJoined || kind == SessionEventKind::peerLeft ||
        kind == SessionEventKind::rosterChanged || kind == SessionEventKind::sfuEvent ||
        kind == SessionEventKind::topologyChanged;
    if (callScoped && (value.connection != connection_ || value.generation != generation_)) return;
    if (kind == SessionEventKind::authenticated && (!online_ || !auth_ || value.connection != connection_)) return;
    if (kind == SessionEventKind::policyChanged && value.connection != connection_) return;
    if (kind == SessionEventKind::reconnectRequested && (online_ || phase_ != SessionPhase::offline)) return;
    callbacks_.event(value);
  });
}

void ProtocolSession::failure(Failure value) {
  SessionEvent notification{SessionEventKind::failure, connection_, generation_, {}, Json::object(),
                            std::move(value)};
  effects_.push_back([this, notification = std::move(notification)] { callbacks_.event(notification); });
}

void ProtocolSession::send(std::string_view type, Json payload, std::string requestId, bool callScoped) {
  Json envelope{{"type", std::string(type)}, {"payload", std::move(payload)}};
  if (!requestId.empty()) envelope["requestId"] = requestId;
  const auto connection = connection_;
  const auto generation = generation_;
  effects_.push_back([this, connection, generation, callScoped, requestId,
                      frame = envelope.dump()] {
    if (!online_ || connection != connection_ || (callScoped && generation != generation_)) return;
    if (!requestId.empty() && requestId != authId_ && requestId != controlId_ && pending_.count(requestId) == 0) return;
    callbacks_.outbound(frame);
  });
}

std::string ProtocolSession::freshId() {
  auto id = callbacks_.requestId();
  if (id.empty()) throw std::invalid_argument("Request-ID factory returned an empty ID");
  // Never reuse an ID, even if an injected factory repeats across reconnects.
  return id + "-" + std::to_string(++idSerial_);
}

std::uint64_t ProtocolSession::opened(Time now, std::int64_t unixMilliseconds) {
  Flush flush{*this};
  if (online_ || phase_ == SessionPhase::stopped) {
    failure({FailureKind::invalidState, {}, "Socket opened in an invalid session state"});
    return connection_;
  }
  (void)unixMilliseconds;
  now_ = now;
  ++connection_;
  online_ = true;
  phase_ = SessionPhase::authenticating;
  reconnectDeadline_.reset();
  authId_ = freshId();
  challengeAnswered_ = false;
  signatureSent_ = false;
  authDeadline_ = now + authTimeout;
  pingDeadline_ = now + std::chrono::milliseconds(monky::protocol::limits::HEARTBEAT_INTERVAL_MS);
  pongDeadline_ = now + pongTimeout;
  Json payload{{"protocolVersion", monky::protocol::VERSION}, {"publicKey", identity_.publicKeyHex},
               {"deviceId", identity_.deviceId}, {"nickname", identity_.nickname}};
  if (identity_.password) payload["password"] = *identity_.password;
  send(msg::AUTH_CONNECT, std::move(payload), authId_);
  return connection_;
}

void ProtocolSession::receive(std::uint64_t connection, std::string_view frame, Time now) {
  Flush flush{*this};
  if (!online_ || connection != connection_ || phase_ == SessionPhase::stopped) return;
  now_ = now;
  if ((authDeadline_ && now >= *authDeadline_) || (pongDeadline_ && now >= *pongDeadline_)) {
    loseConnection(now, {FailureKind::timeout, {}, "Session deadline exceeded"}, true);
    return;
  }
  try {
    require(frame.size() <= maxIncomingMessageBytes_, "Frame exceeds native protocol limit");
    auto envelope = Json::parse(frame.begin(), frame.end(), [](int depth, Json::parse_event_t, Json&) {
      require(depth <= 64, "JSON nesting exceeds native protocol limit");
      return true;
    });
    const auto type = text(envelope, "type");
    if (!relevant(type)) return;
    const auto& payload = field(envelope, "payload");
    require(payload.is_object(), "Expected payload object");
    const auto id = envelope.contains("requestId") ? text(envelope, "requestId") : std::string{};
    auto pending = pending_.find(id);
    if (pending != pending_.end() && now >= pending->second.deadline) {
      auto callback = std::move(pending->second.callback);
      pending_.erase(pending);
      effects_.push_back([callback = std::move(callback)] {
        callback(RpcResult{{}, Json::object(), Failure{FailureKind::timeout, {}, "RPC deadline exceeded"}});
      });
      return;
    }
    dispatch(type, payload, id, now);
  } catch (const Invalid& error) {
    failure({FailureKind::malformedMessage, {}, error.what()});
  } catch (const Json::exception&) {
    // JSON exception diagnostics can contain raw wire/auth data.
    failure({FailureKind::malformedMessage, {}, "Invalid JSON message"});
  }
}

void ProtocolSession::authenticate(const Json& payload) {
  const auto& server = field(payload, "server");
  const auto& self = field(payload, "currentUser");
  user(self);
  const auto session = text(self, "sessionId");
  require(!self.contains("isBot") || !boolean(self, "isBot"), "Human session authenticated as bot");
  text(server, "id");
  text(server, "name");
  number(server, "createdAt");
  number(server, "maxUsers");
  arrayField(server, "channels");
  for (const auto& value : server.at("channels")) {
    channel(value);
    require(text(value, "serverId") == text(server, "id"), "Foreign server channel");
  }
  arrayField(server, "members");
  for (const auto& value : server.at("members")) user(value);
  objectField(server, "voiceStates");
  for (auto it = server.at("voiceStates").begin(); it != server.at("voiceStates").end(); ++it) {
    state(it.value());
    require(text(it.value(), "sessionId") == it.key(), "Mismatched server voice session");
  }
  const auto& restrictions = field(payload, "voiceRestrictions");
  const auto serverMuted = boolean(restrictions, "serverMuted");
  const auto serverDeafened = boolean(restrictions, "serverDeafened");
  const auto mode = server.contains("voiceMode") ? ::monky::light::voiceMode(server) : VoiceMode::p2p;
  std::optional<Json> ice;
  if (payload.contains("iceServers")) {
    arrayField(payload, "iceServers");
    for (const auto& value : payload.at("iceServers")) {
      strings(field(value, "urls"));
      require(!value.at("urls").empty(), "Empty ICE URL list");
      for (const auto* key : {"username", "credential"})
        if (value.contains(key)) require(value.at(key).is_string(), "Invalid ICE credentials");
    }
    ice = payload.at("iceServers");
  }
  auth_ = Authenticated{text(self, "id"), session, server, std::move(ice)};
  mode_ = mode;
  policy_.serverMuted = serverMuted;
  policy_.serverDeafened = serverDeafened;
  phase_ = SessionPhase::ready;
  authDeadline_.reset();
  authId_.clear();
  reconnectAttempt_ = 0;
  event(SessionEventKind::authenticated, std::string(msg::AUTH_SUCCESS), payload);
  publishPolicy();
}

void ProtocolSession::dispatch(const std::string& type, const Json& payload,
                               const std::string& id, Time now) {
  if (type == msg::PONG) {
    number(payload, "timestamp");
    pongDeadline_ = now + pongTimeout;
    return;
  }
  if (type == msg::SERVER_ERROR || type == msg::AUTH_FAILED) {
    const auto& message = field(payload, "message");
    require(message.is_string(), "Invalid server error detail");
    const auto code = payload.contains("code") ? text(payload, "code") : std::string{};
    if (type == msg::SERVER_ERROR) require(!code.empty(), "Missing server error code");
    Failure error{type == msg::AUTH_FAILED ? FailureKind::authentication : FailureKind::server,
                  code, message.get<std::string>()};
    if (phase_ == SessionPhase::authenticating && id == authId_) {
      loseConnection(now, error, false);
      return;
    }
    auto found = pending_.find(id);
    if (found != pending_.end()) {
      auto callback = std::move(found->second.callback);
      pending_.erase(found);
      effects_.push_back([callback = std::move(callback), error] {
        callback(RpcResult{{}, Json::object(), error});
      });
    }
    failure(error);
    return;
  }
  if (type == msg::AUTH_CHALLENGE) {
    if (phase_ != SessionPhase::authenticating || id != authId_ || challengeAnswered_) return;
    const auto nonceHex = text(payload, "nonce");
    require(hex(nonceHex, 64), "Invalid authentication nonce");
    Nonce nonce{};
    for (std::size_t i = 0; i < nonce.size(); ++i)
      nonce[i] = static_cast<std::uint8_t>(std::stoul(nonceHex.substr(i * 2, 2), nullptr, 16));
    challengeAnswered_ = true;
    const auto connection = connection_;
    const auto authId = authId_;
    effects_.push_back([this, nonce, connection, authId] {
      if (!online_ || connection_ != connection || authId_ != authId) return;
      std::string signature;
      try {
        signature = callbacks_.signNonce(nonce);
      } catch (const std::exception&) {
        loseConnection(now_, {FailureKind::authentication, {}, "Nonce signer failed"}, false);
        return;
      }
      if (!online_ || connection_ != connection || authId_ != authId) return;
      if (!hex(signature, 128)) {
        loseConnection(now_, {FailureKind::authentication, {}, "Invalid signature encoding"}, false);
        return;
      }
      signatureSent_ = true;
      send(msg::AUTH_CHALLENGE_RESPONSE, Json{{"signature", signature}}, authId);
    });
    return;
  }
  if (type == msg::AUTH_SUCCESS) {
    if (phase_ != SessionPhase::authenticating || id != authId_) return;
    require(signatureSent_, "Authentication success before signed response");
    authenticate(payload);
    if (desired_) beginJoin(now, false);
    return;
  }
  if (!auth_) return;
  if (type == msg::SERVER_SHUTDOWN) {
    loseConnection(now, {FailureKind::disconnected, {}, "Server shutdown"}, true);
    return;
  }
  if (type == msg::VOICE_USER_JOINED || type == msg::VOICE_RECONNECTED) {
    if (phase_ == SessionPhase::joining && id == joinId_ && type == joinReply_) {
      // Validate everything before removing the pending entry or changing media state.
      acceptAdmission(payload);
      pending_.erase(id);
      joinId_.clear();
      return;
    }
    if (type == msg::VOICE_RECONNECTED || !admission_) return;
    auto peer = joined(payload);
    if (text(payload, "channelId") != admission_->channelId || peer.sessionId == auth_->sessionId) return;
    // Administrative arrivals also carry the administrator's request ID.
    admission_->participants[peer.sessionId] = std::move(peer);
    event(SessionEventKind::peerJoined, type, payload);
    flushEarlySignals();
    return;
  }
  if (type == msg::VOICE_USER_LEFT) {
    const auto room = text(payload, "channelId");
    const auto userId = text(payload, "userId");
    const auto session = text(payload, "sessionId");
    std::optional<std::string> grant;
    if (payload.contains("reconnect")) grant = transitionId(payload.at("reconnect"));
    if (session == auth_->sessionId) {
      require(userId == auth_->userId, "Mismatched self departure user");
      if (grant && consumedTransition_ == grant) return;
      if ((!admission_ || admission_->channelId != room) &&
          !(phase_ == SessionPhase::joining && desired_ == room)) return;
      if (grant && mode_ == VoiceMode::sfu && desired_ == room) {
        const bool settingsMatched = settingsTransition_ == grant;
        clearCall(cancelled());
        transition_ = Transition{*grant, room, now + transitionTimeout};
        phase_ = SessionPhase::transitioning;
        if (settingsMatched) {
          settingsTransition_ = grant;
          mode_ = VoiceMode::p2p;
          auth_->server["voiceMode"] = "p2p";
          beginJoin(now, true);
        }
      } else {
        desired_.reset();
        clearCall(cancelled());
      }
    } else if (admission_ && admission_->channelId == room) {
      auto peer = admission_->participants.find(session);
      if (peer == admission_->participants.end()) return;
      require(peer->second.userId == userId, "Mismatched departing peer");
      admission_->participants.erase(peer);
      earlySignals_.erase(std::remove_if(earlySignals_.begin(), earlySignals_.end(),
          [&](const EarlySignal& value) { return text(value.payload, "fromSessionId") == session; }),
          earlySignals_.end());
      event(SessionEventKind::peerLeft, type, payload);
    }
    return;
  }
  if (type == msg::VOICE_STATE_CHANGED) {
    const auto& value = field(payload, "voiceState");
    state(value);
    if (!admission_ || text(value, "channelId") != admission_->channelId) return;
    auto peer = admission_->participants.find(text(value, "sessionId"));
    if (peer == admission_->participants.end()) return;
    require(peer->second.userId == text(value, "userId"), "Mismatched voice-state user");
    peer->second.voiceState = value;
    if (peer->first == auth_->sessionId) updatePolicy(value, controlId_.empty() || id == controlId_);
    event(SessionEventKind::rosterChanged, type, payload);
    return;
  }
  if (type == msg::VOICE_RESTRICTIONS_UPDATED) {
    const auto userId = text(payload, "userId");
    const auto muted = boolean(payload, "serverMuted");
    const auto deafened = boolean(payload, "serverDeafened");
    if (userId == auth_->userId) {
      policy_.serverMuted = muted;
      policy_.serverDeafened = deafened;
      publishPolicy();
    }
    return;
  }
  if (type == msg::ADMIN_KICK_VOICE || type == msg::MEMBER_KICKED) {
    const bool self = type == msg::ADMIN_KICK_VOICE
        ? text(payload, "targetSessionId") == auth_->sessionId
        : text(payload, "userId") == auth_->userId;
    if (!self) return;
    desired_.reset();
    clearCall({FailureKind::kicked, {}, "Removed by server"});
    event(SessionEventKind::kicked, type, payload);
    if (type == msg::MEMBER_KICKED)
      loseConnection(now, {FailureKind::kicked, {}, "Removed from server"}, false);
    return;
  }
  if (type == msg::ADMIN_MOVE_USER) {
    const auto target = text(payload, "targetSessionId");
    const auto room = text(payload, "channelId");
    if (target == auth_->sessionId) join(room, now);
    return;
  }
  if (type == msg::SERVER_SETTINGS_UPDATED) {
    handleSettings(payload, now);
    return;
  }
  if (type == msg::CHANNEL_CREATED || type == msg::CHANNEL_UPDATED) {
    const auto& value = field(payload, "channel");
    channel(value);
    require(text(value, "serverId") == text(auth_->server, "id"), "Foreign channel update");
    auto& channels = auth_->server["channels"];
    auto found = std::find_if(channels.begin(), channels.end(), [&](const Json& existing) {
      return text(existing, "id") == text(value, "id");
    });
    if (found == channels.end()) channels.push_back(value);
    else *found = value;
    if (desired_ == text(value, "id") && text(value, "type") != "VOICE") leave();
    return;
  }
  if (type == msg::CHANNEL_DELETED) {
    const auto room = text(payload, "channelId");
    auto& channels = auth_->server["channels"];
    channels.erase(std::remove_if(channels.begin(), channels.end(), [&](const Json& value) {
      return text(value, "id") == room;
    }), channels.end());
    if (desired_ == room) {
      desired_.reset();
      clearCall({FailureKind::cancelled, {}, "Channel no longer accessible"});
    }
    return;
  }
  if (type == msg::RTC_SIGNAL) {
    handleSignal(payload);
    return;
  }
  auto found = pending_.find(id);
  if (found != pending_.end() &&
      std::find(found->second.accepted.begin(), found->second.accepted.end(), type) != found->second.accepted.end()) {
    if (!admission_ || mode_ != VoiceMode::sfu || found->second.generation != generation_) return;
    validateSfu(type, payload, &found->second);
    if (type == msg::SFU_PRODUCERS_LIST) {
      auto participants = roster(field(payload, "participants"), admission_->channelId);
      require(participants.count(auth_->sessionId) != 0 &&
              participants.at(auth_->sessionId).userId == auth_->userId, "SFU roster omits self");
      admission_->participants = std::move(participants);
      updatePolicy(admission_->participants.at(auth_->sessionId).voiceState);
      event(SessionEventKind::rosterChanged, type, payload);
    }
    auto callback = std::move(found->second.callback);
    const auto generation = generation_;
    const auto connection = connection_;
    pending_.erase(found);
    effects_.push_back([this, callback = std::move(callback), type, payload, generation, connection] {
      if (connection != connection_ || !online_)
        callback(RpcResult{{}, Json::object(), Failure{FailureKind::disconnected, {}, "Transport disconnected"}});
      else if (generation != generation_)
        callback(RpcResult{{}, Json::object(), cancelled()});
      else callback(RpcResult{type, payload, std::nullopt});
    });
    // Producer-closed may simultaneously be a consume response and a broadcast.
    if (type != msg::SFU_PRODUCER_CLOSED) return;
  }
  if (admission_ && mode_ == VoiceMode::sfu &&
      (type == msg::SFU_NEW_PRODUCER || type == msg::SFU_PRODUCER_CLOSED || type == msg::SFU_CONSUMER_CLOSED)) {
    validateSfu(type, payload, nullptr);
    if (type == msg::SFU_NEW_PRODUCER &&
        admission_->participants.count(text(payload, "producerSessionId")) == 0) return;
    event(SessionEventKind::sfuEvent, type, payload);
  }
}

void ProtocolSession::join(std::string channelId, Time now) {
  Flush flush{*this};
  now_ = now;
  if (channelId.empty() || phase_ == SessionPhase::stopped) {
    failure({FailureKind::invalidState, {}, "Cannot join channel"});
    return;
  }
  if (desired_ == channelId &&
      (phase_ == SessionPhase::joining || phase_ == SessionPhase::admitted || transition_)) return;
  if (desired_ || admission_ || transition_) leave();
  desired_ = std::move(channelId);
  if (auth_ && online_) beginJoin(now, false);
}

void ProtocolSession::beginJoin(Time now, bool reconnect) {
  if (!online_ || !auth_ || !desired_) return;
  const auto room = *desired_;
  const auto& channels = auth_->server.at("channels");
  if (std::none_of(channels.begin(), channels.end(), [&](const Json& value) {
        return text(value, "id") == room && text(value, "type") == "VOICE";
      })) {
    desired_.reset();
    transition_.reset();
    phase_ = SessionPhase::ready;
    failure({FailureKind::server, std::string(monky::protocol::error::CHANNEL_NOT_FOUND),
             "Desired voice channel is not accessible"});
    return;
  }
  Json payload{{"channelId", room}, {"isMuted", policy_.muted}, {"isDeafened", policy_.deafened}};
  if (reconnect) {
    if (!transition_ || transition_->channel != room || now >= transition_->deadline ||
        settingsTransition_ != transition_->id) return;
    payload["transitionId"] = transition_->id;
    consumedTransition_ = transition_->id;
    // Consume the local grant before sending. Failures never retry this authorization.
    transition_.reset();
    settingsTransition_.reset();
  }
  ++generation_;
  phase_ = SessionPhase::joining;
  joinPolicyRevision_ = policyRevision_;
  joinId_ = freshId();
  joinReply_ = std::string(reconnect ? msg::VOICE_RECONNECTED : msg::VOICE_USER_JOINED);
  const auto generation = generation_;
  pending_.emplace(joinId_, Pending{{joinReply_}, now + rpcTimeout, generation, payload,
    [this, generation](RpcResult result) {
      if (generation != generation_ || phase_ != SessionPhase::joining) return;
      if (result.failure) {
        // A timeout is ambiguous: serialize a leave before any later join.
        leave();
        failure(*result.failure);
      }
    }});
  send(reconnect ? msg::VOICE_RECONNECT : msg::VOICE_JOIN, std::move(payload), joinId_, true);
}

void ProtocolSession::acceptAdmission(const Json& payload) {
  auto self = joined(payload);
  require(auth_ && desired_ && self.sessionId == auth_->sessionId && self.userId == auth_->userId &&
          text(payload, "channelId") == *desired_, "Foreign admission acknowledgment");
  auto participants = roster(field(payload, "participants"), *desired_);
  require(participants.count(self.sessionId) != 0, "Admission roster omits self");
  require(participants.at(self.sessionId).userId == self.userId, "Inconsistent self roster user");
  // Restrictions can change during the server's awaited join broadcast.
  // The later physical roster, rather than the earlier join state, wins.
  const auto ownState = participants.at(self.sessionId).voiceState;
  admission_ = Admission{*desired_, mode_, std::move(participants)};
  phase_ = SessionPhase::admitted;
  policy_.serverMuted = boolean(ownState, "serverMuted");
  policy_.serverDeafened = boolean(ownState, "serverDeafened");
  if (policyRevision_ == joinPolicyRevision_) {
    policy_.muted = boolean(ownState, "isMuted");
    policy_.deafened = boolean(ownState, "isDeafened");
  }
  publishPolicy();
  if (policyRevision_ != joinPolicyRevision_) {
    sendVoiceState();
  }
  event(SessionEventKind::admitted, joinReply_, payload);
  flushEarlySignals();
}

void ProtocolSession::updatePolicy(const Json& value, bool acceptManual) {
  if (acceptManual) {
    policy_.muted = boolean(value, "isMuted");
    policy_.deafened = boolean(value, "isDeafened");
  }
  policy_.serverMuted = boolean(value, "serverMuted");
  policy_.serverDeafened = boolean(value, "serverDeafened");
  publishPolicy();
}

void ProtocolSession::sendVoiceState() {
  if (!admission_) return;
  controlId_ = freshId();
  send(msg::VOICE_STATE_UPDATE,
       Json{{"isMuted", policy_.muted}, {"isDeafened", policy_.deafened}, {"isSpeaking", false}}, controlId_, true);
}

void ProtocolSession::publishPolicy() {
  event(SessionEventKind::policyChanged, {}, Json{
    {"isMuted", policy_.muted}, {"isDeafened", policy_.deafened},
    {"serverMuted", policy_.serverMuted}, {"serverDeafened", policy_.serverDeafened},
    {"suppressMicrophone", policy_.suppressMicrophone()}, {"suppressPlayback", policy_.suppressPlayback()}});
}

void ProtocolSession::setMuted(bool muted) {
  Flush flush{*this};
  ++policyRevision_;
  if (policy_.deafened) muteBeforeDeafen_ = muted;
  else policy_.muted = muted;
  publishPolicy();
  sendVoiceState();
}

void ProtocolSession::setDeafened(bool deafened) {
  Flush flush{*this};
  if (policy_.deafened == deafened) return;
  ++policyRevision_;
  if (deafened) {
    muteBeforeDeafen_ = policy_.muted;
    policy_.muted = true;
  } else {
    policy_.muted = muteBeforeDeafen_;
  }
  policy_.deafened = deafened;
  publishPolicy();
  sendVoiceState();
}

void ProtocolSession::failPending(Failure reason) {
  auto pending = std::move(pending_);
  pending_.clear();
  for (auto& entry : pending) {
    auto callback = std::move(entry.second.callback);
    effects_.push_back([callback = std::move(callback), reason] {
      callback(RpcResult{{}, Json::object(), reason});
    });
  }
}

void ProtocolSession::clearCall(Failure reason) {
  const bool hadCall = admission_ || phase_ == SessionPhase::joining || transition_;
  ++generation_;
  admission_.reset();
  transition_.reset();
  settingsTransition_.reset();
  joinId_.clear();
  joinReply_.clear();
  controlId_.clear();
  earlySignals_.clear();
  if (online_ && auth_) phase_ = SessionPhase::ready;
  failPending(std::move(reason));
  if (hadCall) event(SessionEventKind::teardown);
}

void ProtocolSession::leave() {
  Flush flush{*this};
  const auto room = admission_ ? std::optional<std::string>(admission_->channelId) : desired_;
  const bool wasActive = admission_ || phase_ == SessionPhase::joining || transition_;
  desired_.reset();
  settingsTransition_.reset();
  clearCall(cancelled());
  if (online_ && auth_ && room && wasActive)
    send(msg::VOICE_LEAVE, Json{{"channelId", *room}});
}

void ProtocolSession::logout() {
  Flush flush{*this};
  retryAllowed_ = false;
  reconnectDeadline_.reset();
  desired_.reset();
  settingsTransition_.reset();
  clearCall(cancelled());
  if (online_) send(msg::USER_LOGOUT, Json::object());
  phase_ = SessionPhase::stopped;
  authDeadline_.reset();
  pingDeadline_.reset();
  pongDeadline_.reset();
  // The owner closes the socket after observing this event (after USER_LOGOUT).
  event(SessionEventKind::disconnected, std::string(msg::USER_LOGOUT));
}

void ProtocolSession::loseConnection(Time now, Failure reason, bool retry) {
  online_ = false;
  retryAllowed_ = retry;
  settingsTransition_.reset();
  consumedTransition_.reset();
  clearCall(reason);
  auth_.reset();
  authId_.clear();
  authDeadline_.reset();
  pingDeadline_.reset();
  pongDeadline_.reset();
  phase_ = retry ? SessionPhase::offline : SessionPhase::stopped;
  if (retry) {
    const auto count = std::size(monky::protocol::RECONNECT_DELAYS_MS);
    const auto index = std::min(reconnectAttempt_++, count - 1);
    reconnectDeadline_ = now + std::chrono::milliseconds(monky::protocol::RECONNECT_DELAYS_MS[index]);
  } else {
    desired_.reset();
    reconnectDeadline_.reset();
  }
  failure(reason);
  event(SessionEventKind::disconnected);
}

void ProtocolSession::disconnected(std::uint64_t connection, Time now) {
  Flush flush{*this};
  if (connection != connection_ || !online_) return;
  now_ = now;
  loseConnection(now, {FailureKind::disconnected, {}, "Transport disconnected"},
                 retryAllowed_ && phase_ != SessionPhase::stopped);
}

void ProtocolSession::connectFailed(Time now) {
  Flush flush{*this};
  if (online_ || phase_ == SessionPhase::stopped || reconnectDeadline_) return;
  now_ = now;
  loseConnection(now, {FailureKind::disconnected, {}, "Transport connection attempt failed"}, true);
}

void ProtocolSession::tick(Time now, std::int64_t unixMilliseconds) {
  Flush flush{*this};
  now_ = now;
  earlySignals_.erase(std::remove_if(earlySignals_.begin(), earlySignals_.end(),
      [now](const EarlySignal& value) { return now >= value.deadline; }), earlySignals_.end());
  if (authDeadline_ && now >= *authDeadline_) {
    loseConnection(now, {FailureKind::timeout, {}, "Authentication deadline exceeded"}, true);
    return;
  }
  if (pongDeadline_ && now >= *pongDeadline_) {
    loseConnection(now, {FailureKind::timeout, {}, "Heartbeat deadline exceeded"}, true);
    return;
  }
  if (transition_ && now >= transition_->deadline) {
    desired_.reset();
    settingsTransition_.reset();
    clearCall({FailureKind::timeout, std::string(monky::protocol::error::VOICE_RECONNECT_EXPIRED),
               "Voice reconnect grant expired"});
    failure({FailureKind::timeout, std::string(monky::protocol::error::VOICE_RECONNECT_EXPIRED),
             "Voice reconnect grant expired"});
  }
  std::vector<RpcCallback> expired;
  for (auto it = pending_.begin(); it != pending_.end();) {
    if (now >= it->second.deadline) {
      expired.push_back(std::move(it->second.callback));
      it = pending_.erase(it);
    } else ++it;
  }
  for (auto& callback : expired)
    effects_.push_back([callback = std::move(callback)] {
      callback(RpcResult{{}, Json::object(), Failure{FailureKind::timeout, {}, "RPC deadline exceeded"}});
    });
  if (online_ && pingDeadline_ && now >= *pingDeadline_) {
    pingDeadline_ = now + std::chrono::milliseconds(monky::protocol::limits::HEARTBEAT_INTERVAL_MS);
    send(msg::PING, Json{{"timestamp", unixMilliseconds}});
  }
  if (reconnectDeadline_ && now >= *reconnectDeadline_) {
    reconnectDeadline_.reset();
    event(SessionEventKind::reconnectRequested);
  }
}

std::optional<ProtocolSession::Time> ProtocolSession::nextDeadline() const {
  std::optional<Time> result;
  auto consider = [&](std::optional<Time> value) {
    if (value && (!result || *value < *result)) result = value;
  };
  consider(authDeadline_);
  consider(pingDeadline_);
  consider(pongDeadline_);
  consider(reconnectDeadline_);
  if (transition_) consider(transition_->deadline);
  for (const auto& entry : pending_) consider(entry.second.deadline);
  for (const auto& entry : earlySignals_) consider(entry.deadline);
  return result;
}

void ProtocolSession::handleSettings(const Json& payload, Time now) {
  if (!payload.contains("voiceMode")) return;
  const auto mode = ::monky::light::voiceMode(payload);
  std::optional<std::string> transition;
  if (payload.contains("voiceTransition")) transition = transitionId(payload.at("voiceTransition"));
  if (transition && consumedTransition_ == transition) return;
  if (mode == VoiceMode::sfu) settingsTransition_.reset();
  if (mode == VoiceMode::sfu && transition_) {
    desired_.reset();
    settingsTransition_.reset();
    clearCall(cancelled());
  }
  if (mode == VoiceMode::p2p && transition) {
    if (transition_) {
      require(transition_->id == *transition, "Mismatched reconnect transition");
      settingsTransition_ = transition;
      mode_ = mode;
      auth_->server["voiceMode"] = "p2p";
      beginJoin(now, true);
      return;
    }
    settingsTransition_ = transition;
    // Departure normally precedes settings. Preserve the SFU call until its
    // matching departure arrives; settings alone is not an admission grant.
    if ((admission_ || phase_ == SessionPhase::joining) && mode_ == VoiceMode::sfu) return;
  }
  if (mode == mode_) return;
  if (mode_ == VoiceMode::sfu && mode == VoiceMode::p2p && (admission_ || phase_ == SessionPhase::joining)) {
    failure({FailureKind::invalidState, {}, "SFU to P2P requires a reconnect grant"});
    return;
  }
  mode_ = mode;
  auth_->server["voiceMode"] = mode == VoiceMode::sfu ? "sfu" : "p2p";
  if (transition_ && mode != VoiceMode::p2p) {
    desired_.reset();
    settingsTransition_.reset();
    clearCall(cancelled());
  }
  if (admission_) {
    ++generation_;
    earlySignals_.clear();
    failPending(cancelled());
    admission_->mode = mode;
    event(SessionEventKind::topologyChanged, std::string(msg::SERVER_SETTINGS_UPDATED), payload);
  }
}

void ProtocolSession::handleSignal(const Json& payload) {
  if (mode_ != VoiceMode::p2p || (!admission_ && phase_ != SessionPhase::joining)) return;
  signal(payload);
  if (text(payload, "targetSessionId") != auth_->sessionId ||
      text(payload, "fromSessionId") == auth_->sessionId) return;
  if (admission_ && admission_->participants.count(text(payload, "fromSessionId"))) {
    event(SessionEventKind::rtcSignal, std::string(msg::RTC_SIGNAL), payload);
  } else if (earlySignals_.size() < maxEarlySignals) {
    earlySignals_.push_back(EarlySignal{payload, now_ + earlySignalTimeout});
  } else {
    failure({FailureKind::malformedMessage, {}, "Early signaling queue limit reached"});
  }
}

void ProtocolSession::flushEarlySignals() {
  if (!admission_ || mode_ != VoiceMode::p2p) return;
  for (auto it = earlySignals_.begin(); it != earlySignals_.end();) {
    if (now_ >= it->deadline) {
      it = earlySignals_.erase(it);
    } else if (admission_->participants.count(text(it->payload, "fromSessionId"))) {
      event(SessionEventKind::rtcSignal, std::string(msg::RTC_SIGNAL), it->payload);
      it = earlySignals_.erase(it);
    } else ++it;
  }
}

std::string ProtocolSession::request(std::string type, Json payload, std::vector<std::string> accepted,
                                     RpcCallback callback, Time now, std::uint64_t generation) {
  Flush flush{*this};
  if (!callback) throw std::invalid_argument("RPC callback is required");
  now_ = now;
  auto reject = [&](Failure error) {
    effects_.push_back([callback = std::move(callback), error] {
      callback(RpcResult{{}, Json::object(), error});
    });
    return std::string{};
  };
  if (!online_ || !admission_ || mode_ != VoiceMode::sfu || generation != generation_)
    return reject({FailureKind::invalidState, {}, "SFU request outside admitted generation"});
  const auto allowed = replies(type);
  if (allowed.empty() || accepted.empty() ||
      std::any_of(accepted.begin(), accepted.end(), [&](const std::string& value) {
        return std::find(allowed.begin(), allowed.end(), value) == allowed.end();
      }) || std::find(accepted.begin(), accepted.end(), allowed.front()) == accepted.end())
    return reject({FailureKind::invalidState, {}, "Invalid RPC reply contract"});
  if (type == msg::SFU_CONSUME) accepted = allowed;
  try {
    require(text(payload, "channelId") == admission_->channelId, "Foreign SFU request channel");
    if (type == msg::SFU_CREATE_WEBRTC_TRANSPORT) {
      const auto direction = text(payload, "direction");
      require(direction == "send" || direction == "recv", "Invalid transport direction");
    }
    if (type == msg::SFU_CONNECT_WEBRTC_TRANSPORT || type == msg::SFU_PRODUCE || type == msg::SFU_CONSUME)
      text(payload, "transportId");
    if (type == msg::SFU_CONNECT_WEBRTC_TRANSPORT) objectField(payload, "dtlsParameters");
    if (type == msg::SFU_PRODUCE) {
      require(text(payload, "kind") == "audio", "Light only produces audio");
      objectField(payload, "rtpParameters");
      require(text(field(payload, "appData"), "mediaType") == "mic", "Light only produces microphone audio");
    }
    if (type == msg::SFU_CONSUME) {
      text(payload, "producerId");
      objectField(payload, "rtpCapabilities");
    }
  } catch (const Invalid& error) {
    return reject({FailureKind::invalidState, {}, error.what()});
  }
  const auto id = freshId();
  pending_.emplace(id, Pending{std::move(accepted), now + rpcTimeout, generation, payload, std::move(callback)});
  send(type, std::move(payload), id, true);
  return id;
}

void ProtocolSession::cancel(const std::string& requestId) {
  Flush flush{*this};
  const auto found = pending_.find(requestId);
  if (found == pending_.end()) return;
  auto callback = std::move(found->second.callback);
  pending_.erase(found);
  effects_.push_back([callback = std::move(callback)] {
    callback(RpcResult{{}, Json::object(), cancelled()});
  });
}

bool ProtocolSession::sendSignal(Json payload, std::uint64_t generation) {
  Flush flush{*this};
  if (!admission_ || mode_ != VoiceMode::p2p || generation != generation_) return false;
  try {
    payload["fromSessionId"] = auth_->sessionId;
    signal(payload);
    const auto target = text(payload, "targetSessionId");
    require(target != auth_->sessionId && admission_->participants.count(target), "Unknown signaling peer");
    send(msg::RTC_SIGNAL, std::move(payload), {}, true);
    return true;
  } catch (const Invalid& error) {
    failure({FailureKind::invalidState, {}, error.what()});
  } catch (const Json::exception&) {
    failure({FailureKind::invalidState, {}, "Invalid outgoing signal"});
  }
  return false;
}

bool ProtocolSession::sendSfuNotification(std::string type, Json payload, std::uint64_t generation) {
  Flush flush{*this};
  if (!admission_ || mode_ != VoiceMode::sfu || generation != generation_) return false;
  try {
    require(text(payload, "channelId") == admission_->channelId, "Foreign SFU channel");
    if (type == msg::SFU_PRODUCER_CLOSED) text(payload, "producerId");
    else {
      require(type == msg::SFU_CONSUMER_SET_PAUSED, "Unsupported SFU notification");
      text(payload, "consumerId");
      boolean(payload, "paused");
    }
    send(type, std::move(payload), {}, true);
    return true;
  } catch (const Invalid& error) {
    failure({FailureKind::invalidState, {}, error.what()});
    return false;
  }
}

void ProtocolSession::validateSfu(const std::string& type, const Json& payload, const Pending* pending) const {
  require(admission_ && text(payload, "channelId") == admission_->channelId, "Foreign SFU reply channel");
  if (type == msg::SFU_ROUTER_RTP_CAPABILITIES) {
    objectField(payload, "rtpCapabilities");
    arrayField(payload.at("rtpCapabilities"), "codecs");
  } else if (type == msg::SFU_WEBRTC_TRANSPORT_CREATED) {
    const auto direction = text(payload, "direction");
    require(direction == "send" || direction == "recv", "Invalid SFU transport direction");
    if (pending) require(direction == text(pending->requestPayload, "direction"), "Foreign transport direction");
    const auto& options = field(payload, "transportOptions");
    text(options, "id");
    objectField(options, "iceParameters");
    arrayField(options, "iceCandidates");
    objectField(options, "dtlsParameters");
    if (options.contains("sctpParameters")) objectField(options, "sctpParameters");
  } else if (type == msg::SFU_WEBRTC_TRANSPORT_CONNECTED) {
    const auto transport = text(payload, "transportId");
    if (pending) require(transport == text(pending->requestPayload, "transportId"), "Foreign transport reply");
  } else if (type == msg::SFU_PRODUCED) {
    text(payload, "id");
  } else if (type == msg::SFU_PRODUCERS_LIST) {
    arrayField(payload, "producers");
    const auto participants = roster(field(payload, "participants"), admission_->channelId);
    for (const auto& producer : payload.at("producers")) {
      validateSfu(std::string(msg::SFU_NEW_PRODUCER), producer, nullptr);
      require(participants.count(text(producer, "producerSessionId")) != 0, "Unknown producer session");
    }
  } else if (type == msg::SFU_CONSUMED || type == msg::SFU_NEW_PRODUCER) {
    const auto producer = text(payload, "producerId");
    const auto session = text(payload, "producerSessionId");
    const auto kind = text(payload, "kind");
    require(kind == "audio" || kind == "video", "Invalid producer kind");
    objectField(payload, "appData");
    if (type == msg::SFU_CONSUMED) {
      text(payload, "id");
      objectField(payload, "rtpParameters");
      require(admission_->participants.count(session) != 0, "Unknown consumed peer");
    }
    if (pending) require(producer == text(pending->requestPayload, "producerId"), "Foreign producer reply");
  } else if (type == msg::SFU_PRODUCER_CLOSED) {
    const auto producer = text(payload, "producerId");
    if (pending) require(producer == text(pending->requestPayload, "producerId"), "Foreign closed producer");
  } else if (type == msg::SFU_CONSUMER_CLOSED) {
    text(payload, "consumerId");
  }
}

} // namespace monky::light
