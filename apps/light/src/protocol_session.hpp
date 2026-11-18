#pragma once

#include "protocol_reader.hpp"

#include <json.hpp>

#include <array>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <functional>
#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace monky::light {

using Json = nlohmann::json;

enum class VoiceMode { p2p, sfu };
enum class SessionPhase { offline, authenticating, ready, joining, admitted, transitioning, stopped };
enum class FailureKind { malformedMessage, invalidState, authentication, server, timeout, disconnected, cancelled, kicked };

struct Failure {
  FailureKind kind;
  std::string code;
  std::string detail;
};

struct VoicePolicy {
  bool muted = false;
  bool deafened = false;
  bool serverMuted = false;
  bool serverDeafened = false;
  // The room denies its Speak permission, as the AFK room does to everyone.
  bool permissionMuted = false;
  bool suppressMicrophone() const {
    return muted || deafened || serverMuted || serverDeafened || permissionMuted;
  }
  bool suppressPlayback() const { return deafened || serverDeafened; }
  // The one shape policy events and state snapshots report.
  Json describe() const;
};

struct Admission {
  std::string channelId;
  VoiceMode mode;
  std::map<std::string, Participant> participants;
};

struct Authenticated {
  std::string userId;
  std::string sessionId;
  Json server;
  // Absence stays absent: the media owner must explicitly select its ICE policy.
  std::optional<Json> iceServers;
  // The server key this sign-in was bound to (server-key-auth, #821), to pin for this server.
  std::optional<std::string> serverKey;
};

enum class SessionEventKind {
  authenticated, admitted, rosterChanged, peerJoined, peerLeft, policyChanged,
  rtcSignal, sfuEvent, topologyChanged, teardown, disconnected, reconnectRequested,
  kicked, channelsChanged, failure,
  // A new or changed chat message (type CHAT_MESSAGE or CHAT_MESSAGE_UPDATED),
  // already reduced by reader::chatMessage, delivered only while chat is read.
  chatMessage
};

struct SessionEvent {
  SessionEventKind kind;
  std::uint64_t connection = 0;
  std::uint64_t generation = 0;
  std::string type;
  Json payload = Json::object();
  std::optional<Failure> failure;
};

struct RpcResult {
  std::string type;
  Json payload = Json::object();
  std::optional<Failure> failure;
};

// All methods AND callbacks belong to one application event-loop thread.
// Post media-worker results onto that thread, carrying generation(). Never block
// a callback. Outbound/events/RPC callbacks must not throw; they may reenter.
// The request-ID factory must be a pure, nonempty-ID generator.
// No callback may destroy this object until its outermost operation returns.
class ProtocolSession {
public:
  using Clock = std::chrono::steady_clock;
  using Time = Clock::time_point;
  using Nonce = std::array<std::uint8_t, 32>;
  using RpcCallback = std::function<void(RpcResult)>;

  struct Identity {
    std::string publicKeyHex;
    std::string deviceId;
    std::string nickname;
    std::optional<std::string> password;
    // server-key-auth (#821): the key pinned for this server, and those pinned for the profile's other
    // servers. A server pinned once must present that key; a new one may not present another's.
    std::optional<std::string> serverKey;
    std::vector<std::string> keysPinnedElsewhere;
    // The key an invitation given for this server names: the only way to replace the pinned one,
    // and never accepted when another server of the profile pinned it.
    std::optional<std::string> invitedServerKey;
  };
  // The key a server presents in AUTH_CHALLENGE and its signature proving it holds it.
  struct ServerProof {
    std::string key;
    std::string signature;
  };
  struct Callbacks {
    std::function<void(const std::string&)> outbound;
    // Signs the challenge, bound to the proof's key when there is one. Returns nullopt
    // when the server's signature does not verify; nothing may be signed then.
    std::function<std::optional<std::string>(const Nonce&, const std::optional<ServerProof>&)> signNonce;
    std::function<std::string()> requestId;
    std::function<void(const SessionEvent&)> event;
  };

  // Match the transport's complete-message bound. Soundboard broadcasts can be
  // much larger than voice frames even though this client discards their content.
  static constexpr std::size_t defaultMaxIncomingMessageBytes = 8 * 1024 * 1024;
  ProtocolSession(Identity identity, Callbacks callbacks,
                  std::size_t maxIncomingMessageBytes = defaultMaxIncomingMessageBytes);
  ProtocolSession(const ProtocolSession&) = delete;
  ProtocolSession& operator=(const ProtocolSession&) = delete;

  // The transport owns control ping/pong and calls opened only on a fresh socket.
  // Tag transport callbacks with the returned connection token; stale sockets
  // cannot mutate the new session. Unix milliseconds are only a wire timestamp.
  std::uint64_t opened(Time now, std::int64_t unixMilliseconds);
  void receive(std::uint64_t connection, std::string_view frame, Time now);
  void disconnected(std::uint64_t connection, Time now);
  // A dial failure before opened() has no new connection token.
  void connectFailed(Time now);
  void tick(Time now, std::int64_t unixMilliseconds);
  std::optional<Time> nextDeadline() const;

  void join(std::string channelId, Time now);
  void leave();
  void logout();
  void setMuted(bool muted);
  void setDeafened(bool deafened);

  // Generic asynchronous SFU RPC; accepted replies must match the wire contract.
  // SFU_CONSUME automatically also accepts SFU_PRODUCER_CLOSED.
  std::string request(std::string type, Json payload, std::vector<std::string> accepted,
                      RpcCallback callback, Time now, std::uint64_t generation);
  void cancel(const std::string& requestId);
  bool sendSignal(Json payload, std::uint64_t generation);

  // Text chat, independent of any call: its requests survive leaving or
  // switching rooms and fail only with the connection. Reading chat is opt-in
  // (watchChat), and both requests turn it on.
  void watchChat(bool enabled);
  bool watchingChat() const { return chatWatching_; }
  // Answers {"channelId", "messages"} oldest first, at most `limit`.
  std::string loadChatHistory(std::string channelId, std::optional<std::int64_t> before, int limit,
                              RpcCallback callback, Time now);
  // Answers {"message"} once the server stored it; a refusal (no permission,
  // too long) comes back as a failure with the server's code.
  std::string sendChat(std::string channelId, std::string content, RpcCallback callback, Time now);
  bool sendSfuNotification(std::string type, Json payload, std::uint64_t generation);

  SessionPhase phase() const { return phase_; }
  std::uint64_t connection() const { return connection_; }
  std::uint64_t generation() const { return generation_; }
  VoiceMode voiceMode() const { return mode_; }
  const VoicePolicy& policy() const { return policy_; }
  const std::optional<Authenticated>& authentication() const { return auth_; }
  const std::optional<Admission>& admission() const { return admission_; }
  const std::optional<std::string>& desiredChannel() const { return desired_; }

private:
  struct Pending {
    std::vector<std::string> accepted;
    Time deadline;
    std::uint64_t generation;
    Json requestPayload;
    RpcCallback callback;
  };
  struct Transition {
    std::string id;
    std::string channel;
    Time deadline;
  };
  struct EarlySignal {
    Json payload;
    Time deadline;
  };
  struct Flush {
    ProtocolSession& session;
    explicit Flush(ProtocolSession& value) : session(value) { ++session.operationDepth_; }
    ~Flush() { if (--session.operationDepth_ == 0) session.flush(); }
  };

  void flush();
  void event(SessionEventKind kind, std::string type = {}, Json payload = Json::object());
  void failure(Failure value);
  void send(std::string_view type, Json payload, std::string requestId = {}, bool callScoped = false);
  std::string freshId();
  void dispatch(const std::string& type, const Json& payload, const std::string& id, Time now);
  void authenticate(const Json& payload);
  void beginJoin(Time now, bool reconnect);
  void followMove(std::string room, std::optional<std::string> moveId, Time now);
  void acceptAdmission(const Json& payload);
  void updatePolicy(const Json& state, bool acceptManual = false);
  void sendVoiceState();
  void publishPolicy();
  void clearCall(Failure reason);
  void retire(std::string requestId);
  void failPending(Failure reason);
  void loseConnection(Time now, Failure reason, bool retry);
  void handleSettings(const Json& payload, Time now);
  void handleSignal(const Json& payload);
  void flushEarlySignals();

  Identity identity_;
  Callbacks callbacks_;
  std::size_t maxIncomingMessageBytes_;
  SessionPhase phase_ = SessionPhase::offline;
  std::uint64_t connection_ = 0;
  std::uint64_t generation_ = 0;
  VoiceMode mode_ = VoiceMode::p2p;
  VoicePolicy policy_;
  bool muteBeforeDeafen_ = false;
  std::optional<Authenticated> auth_;
  std::optional<Admission> admission_;
  std::optional<std::string> desired_;
  // The server move the next join follows (voice-move-id), consumed by it.
  std::optional<std::string> followedMove_;
  std::optional<Transition> transition_;
  std::optional<std::string> settingsTransition_;
  std::optional<std::string> consumedTransition_;
  std::string authId_;
  bool challengeAnswered_ = false;
  bool signatureSent_ = false;
  // The server key the pending sign-in signature is bound to.
  std::optional<std::string> boundKey_;
  std::string joinId_;
  std::string joinReply_;
  std::string controlId_;
  std::map<std::string, Pending> pending_;
  struct ChatPending {
    std::string reply;
    std::string channelId;
    Time deadline;
    RpcCallback callback;
  };
  std::map<std::string, ChatPending> chatPending_;
  bool chatWatching_ = false;
  void failChat(Failure reason);
  void chatReply(const std::string& type, const Json& payload, const std::string& id);
  std::deque<std::string> retired_;
  std::deque<EarlySignal> earlySignals_;
  std::deque<std::function<void()>> effects_;
  bool flushing_ = false;
  unsigned operationDepth_ = 0;
  bool online_ = false;
  bool retryAllowed_ = true;
  Time now_{};
  std::optional<Time> authDeadline_;
  std::optional<Time> pingDeadline_;
  std::optional<Time> pongDeadline_;
  std::optional<Time> reconnectDeadline_;
  std::size_t reconnectAttempt_ = 0;
  std::uint64_t idSerial_ = 0;
  std::uint64_t policyRevision_ = 0;
  std::uint64_t joinPolicyRevision_ = 0;
};

} // namespace monky::light
