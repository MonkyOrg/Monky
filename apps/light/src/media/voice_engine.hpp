#pragma once

#include <api/audio/audio_device.h>
#include <api/environment/environment.h>
#include <api/scoped_refptr.h>
#include <json.hpp>

#include <chrono>
#include <functional>
#include <future>
#include <memory>
#include <optional>
#include <string>
#include <variant>
#include <vector>

namespace monky::light::media {

enum class VoiceMode { p2p, sfu };
enum class NoiseSuppression { off, low, moderate, high, very_high };

struct AudioPolicy {
  // These are EFFECTIVE values, including server restrictions.
  bool muted = false;
  bool deafened = false;
  bool echo_cancellation = true;
  bool automatic_gain = true;
  NoiseSuppression noise_suppression = NoiseSuppression::moderate;
};

struct Participant {
  std::string user_id;
  std::string session_id;
};

struct IceServer {
  std::vector<std::string> urls;
  std::string username;
  std::string credential;
};

struct JoinConfig {
  std::string self_user_id;
  std::string self_session_id;
  std::string channel_id;
  VoiceMode mode = VoiceMode::p2p;
  // Only pass the authoritative, correlated admission roster, including self.
  std::vector<Participant> admitted_participants;
  std::vector<IceServer> ice_servers;
  AudioPolicy policy;
  std::optional<int> network_ignore_mask;
  std::chrono::milliseconds operation_timeout{15000};
};

struct RpcResponse {
  std::string type;
  nlohmann::json payload;
};
struct RpcFailure {
  std::string code;
  std::string message;
};
using RpcResult = std::variant<RpcResponse, RpcFailure>;
using RpcCompletion = std::function<void(RpcResult)>;
using CancelRequest = std::function<void()>;

enum class EventKind {
  admitted,
  initialized,
  connected,
  reconnecting,
  failed,
  left,
  stats,
  warning
};
struct Event {
  EventKind kind;
  std::string channel_id;
  std::string session_id;
  std::string detail;
  nlohmann::json stats = nlohmann::json::object();
};

struct Callbacks {
  // Called from media control. Return promptly; completion MUST run on an
  // independent app/network loop, never a WebRTC thread or the media worker.
  // The engine also cancels its own wait if the parent is already shutting
  // down.
  std::function<CancelRequest(std::string, nlohmann::json,
                              std::vector<std::string>, RpcCompletion)>
      request;
  std::function<void(std::string, nlohmann::json)> notify;
  // Observers run on media control. Do not wait on an engine future here.
  std::function<void(Event)> observe;
  // Invoked on the WebRTC worker; null is an error, NEVER platform fallback.
  std::function<webrtc::scoped_refptr<webrtc::AudioDeviceModule>(
      const webrtc::Environment &)>
      create_audio_device;
};

class VoiceEngine final {
public:
  explicit VoiceEngine(Callbacks callbacks);
  ~VoiceEngine();
  VoiceEngine(const VoiceEngine &) = delete;
  VoiceEngine &operator=(const VoiceEngine &) = delete;

  // Admission/VOICE_LEAVE and topology grants belong to the session owner.
  // Join success means initialized, not proof that remote PCM has arrived.
  std::future<void> join(JoinConfig config);
  std::future<void> leave();
  void update_roster(std::vector<Participant> participants);
  void receive_signal(nlohmann::json payload);
  void producer_added(nlohmann::json payload);
  void producer_closed(std::string producer_id);
  void consumer_closed(std::string consumer_id);
  void update_policy(AudioPolicy policy);
  void poll_stats();

private:
  struct Impl;
  struct Owner;
  std::unique_ptr<Owner> owner_;
};

} // namespace monky::light::media
