#include "headless_application.hpp"

#include "application_loop.hpp"
#include "identity_key.hpp"
#include "platform/console_control.hpp"
#include "platform/utf8.hpp"
#include "platform/websocket.hpp"
#include "profile_identity.hpp"
#include "protocol.hpp"
#include "protocol_session.hpp"

#include <rtc_base/logging.h>

#include <algorithm>
#include <atomic>
#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <memory>
#include <optional>
#include <set>
#include <stdexcept>
#include <utility>

namespace monky::light {
namespace {

using namespace std::chrono_literals;
namespace message = monky::protocol::message;
using Clock = ApplicationLoop::Clock;

struct Options {
  std::filesystem::path profile;
  std::string server;
  std::string nickname;
  std::optional<std::string> channel;
  bool muted = false;
  bool deafened = false;
};

std::int64_t unixMilliseconds() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::system_clock::now().time_since_epoch()).count();
}

Options parseOptions(const std::vector<std::string>& arguments) {
  Options result;
  std::set<std::string> seen;
  for (std::size_t index = 0; index < arguments.size(); ++index) {
    const auto& flag = arguments[index];
    if (!seen.insert(flag).second) throw std::invalid_argument("Duplicate command-line option");
    if (flag == "--muted") result.muted = true;
    else if (flag == "--deafened") result.deafened = true;
    else {
      if (flag != "--profile" && flag != "--server" && flag != "--nickname" && flag != "--channel") {
        throw std::invalid_argument("Unknown command-line option; use --help");
      }
      if (++index == arguments.size() || arguments[index].empty()) {
        throw std::invalid_argument("Command-line option requires a value");
      }
      const auto& value = arguments[index];
      if (flag == "--profile") result.profile = std::filesystem::path(std::u8string(value.begin(), value.end()));
      else if (flag == "--server") result.server = value;
      else if (flag == "--nickname") result.nickname = value;
      else result.channel = value;
    }
  }
  if (!result.profile.is_absolute() || result.server.empty() || result.nickname.empty()) {
    throw std::invalid_argument("--profile (absolute), --server and --nickname are required");
  }
  websocket_detail::validateUrl(result.server);
  return result;
}

const char* phaseName(SessionPhase phase) {
  switch (phase) {
    case SessionPhase::offline: return "offline";
    case SessionPhase::authenticating: return "authenticating";
    case SessionPhase::ready: return "ready";
    case SessionPhase::joining: return "joining";
    case SessionPhase::admitted: return "admitted";
    case SessionPhase::transitioning: return "transitioning";
    case SessionPhase::stopped: return "stopped";
  }
  throw std::logic_error("Unknown session phase");
}

const char* mediaEventName(media::EventKind kind) {
  switch (kind) {
    case media::EventKind::admitted: return "media-admitted";
    case media::EventKind::initialized: return "media-initialized";
    case media::EventKind::connected: return "media-connected";
    case media::EventKind::reconnecting: return "media-reconnecting";
    case media::EventKind::failed: return "media-error";
    case media::EventKind::left: return "media-left";
    case media::EventKind::stats: return "media-stats";
    case media::EventKind::warning: return "media-warning";
  }
  throw std::logic_error("Unknown media event");
}

void output(Json event) {
  std::cout << event.dump() << '\n' << std::flush;
  if (!std::cout) throw std::runtime_error("Headless output stream is unavailable");
}

std::optional<std::string> passwordFromEnvironment() {
#ifdef _WIN32
  wchar_t* value = nullptr;
  std::size_t length = 0;
  if (_wdupenv_s(&value, &length, L"MONKY_LIGHT_PASSWORD") != 0) {
    throw std::runtime_error("Unable to read the password environment variable");
  }
  std::unique_ptr<wchar_t, decltype(&std::free)> owned(value, &std::free);
  if (!value) return std::nullopt;
  return utf8FromWide(std::wstring_view(value, length - 1));
#else
  const auto* password = std::getenv("MONKY_LIGHT_PASSWORD");
  if (!password) return std::nullopt;
  if (!websocket_detail::validUtf8(password)) {
    throw std::invalid_argument("Password environment variable must be UTF-8");
  }
  return std::string(password);
#endif
}

class Application final {
 public:
  Application(Options options, HeadlessConfiguration audio)
      : options_(std::move(options)), audio_(std::move(audio)), identity_(options_.profile),
        session_({identity_.publicKeyHex(), identity_.deviceId(), options_.nickname, passwordFromEnvironment()},
                 {[this](const std::string& frame) {
                    const auto attempt = attempt_;
                    loop_.post([this, attempt, frame] { send(attempt, frame); }, frame.size());
                  },
                  [this](const ProtocolSession::Nonce& nonce) { return identity_.signChallenge(nonce); },
                  [] { return randomUuid(); },
                  [this](const SessionEvent& event) {
                    const auto attempt = attempt_;
                    loop_.post([this, attempt, event] { onSession(attempt, event); }, event.payload.dump().size());
                  }}) {}

  ~Application() {
    if (cancelMicrophoneAccess_) cancelMicrophoneAccess_();
    // Settle app-owned RPCs before joining media workers or retiring the socket.
    if (session_.phase() != SessionPhase::stopped) session_.logout();
    active_.reset();
    retired_.clear();
    if (socket_) socket_->close();
  }

  int run() {
    ConsoleControl control({
      [this](std::string line) {
        const auto bytes = line.size();
        loop_.post([this, line = std::move(line)] { command(line); }, bytes);
      },
      [this] { loop_.post([this] { quit(); }); },
      [this](std::string error) {
        loop_.post([this, error = std::move(error)] {
          output({{"event", "fatal-error"}, {"detail", error}});
          exitCode_ = 1;
          quit();
        });
      },
    });
    loop_.post([this] {
      session_.setMuted(options_.muted);
      session_.setDeafened(options_.deafened);
      if (options_.channel) session_.join(*options_.channel, Clock::now());
      dial();
    });
    loop_.run([this] { return nextDeadline(); }, [this](auto now) {
      session_.tick(now, unixMilliseconds());
      finishOperations(now);
    });
    return exitCode_;
  }

 private:
  struct Joining {
    std::uint64_t generation;
    std::future<void> result;
  };
  struct Retiring {
    std::unique_ptr<media::VoiceEngine> engine;
    std::future<void> result;
  };
  struct RequestState {
    std::atomic_bool cancelled = false;
    std::string id;  // Owned only by the application loop.
  };

  void closeSocket() {
    if (socket_) {
      ++attempt_;
      socket_->close();
      socket_.reset();
    }
    epoch_.reset();
    drainDeadline_.reset();
  }

  void dial() {
    if (closing_ || session_.phase() == SessionPhase::stopped) return;
    closeSocket();
    const auto attempt = ++attempt_;
    socket_ = std::make_unique<WebSocket>(WebSocketCallbacks{
      [this, attempt] {
        loop_.post([this, attempt] {
          if (attempt != attempt_ || closing_) return;
          epoch_ = session_.opened(Clock::now(), unixMilliseconds());
        });
      },
      [this, attempt](std::string frame) {
        const auto bytes = frame.size();
        loop_.post([this, attempt, frame = std::move(frame)] {
          if (attempt == attempt_ && epoch_) session_.receive(*epoch_, frame, Clock::now());
        }, bytes);
      },
      [this, attempt](WebSocketClose reason) {
        loop_.post([this, attempt, reason] {
          if (attempt != attempt_) return;
          const auto epoch = epoch_;
          closeSocket();
          if (!closing_) {
            output({{"event", "transport-closed"}, {"code", reason.code},
                    {"kind", static_cast<int>(reason.kind)}, {"nativeError", reason.nativeError}});
            if (epoch) session_.disconnected(*epoch, Clock::now());
            else session_.connectFailed(Clock::now());
          }
          finishOperations(Clock::now());
        });
      },
    });
    output({{"event", "connecting"}});
    socket_->connect(options_.server);
  }

  void send(std::uint64_t attempt, const std::string& frame) {
    if (attempt != attempt_) return;
    const auto result = socket_ ? socket_->send(frame) : WebSocketSendResult::notOpen;
    if (result == WebSocketSendResult::queued) return;
    output({{"event", "transport-error"}, {"detail", "Native transport rejected an outgoing message"},
            {"reason", static_cast<int>(result)}});
    if (epoch_) session_.disconnected(*epoch_, Clock::now());
    else session_.connectFailed(Clock::now());
  }

  media::AudioPolicy audioPolicy() const {
    auto result = audio_.processing;
    result.muted = session_.policy().suppressMicrophone() ||
                   (audio_.requestMicrophoneAccess && !microphoneAuthorized_);
    result.deafened = session_.policy().suppressPlayback();
    return result;
  }

  void authorizeMicrophone() {
    if (!audio_.requestMicrophoneAccess || microphoneAuthorized_ || microphoneRequestPending_ ||
        closing_ || !active_ || session_.policy().suppressMicrophone()) return;
    microphoneRequestPending_ = true;
    output({{"event", "microphone-permission"}, {"state", "requesting"}});
    cancelMicrophoneAccess_ = audio_.requestMicrophoneAccess([this](MicrophoneAccess access) {
      loop_.post([this, access] {
        microphoneRequestPending_ = false;
        if (closing_) return;
        microphoneAuthorized_ = access == MicrophoneAccess::granted;
        const auto state = microphoneAuthorized_ ? "granted" :
            access == MicrophoneAccess::restricted ? "restricted" : "denied";
        output({{"event", "microphone-permission"}, {"state", state}});
        if (!microphoneAuthorized_) {
          output({{"event", "microphone-error"}, {"detail", "Microphone access was refused by operating system privacy settings"}});
          session_.setMuted(true);
        }
        if (active_ && activeGeneration_ == session_.generation()) active_->update_policy(audioPolicy());
      });
    });
  }

  std::vector<media::Participant> roster() const {
    std::vector<media::Participant> result;
    if (session_.admission()) {
      for (const auto& [id, participant] : session_.admission()->participants) {
        result.push_back({participant.userId, id});
      }
    }
    return result;
  }

  media::Callbacks mediaCallbacks(std::uint64_t generation) {
    media::Callbacks callbacks;
    callbacks.create_audio_device = audio_.create;
    callbacks.request = [this, generation](std::string type, Json payload,
                                          std::vector<std::string> accepted,
                                          media::RpcCompletion completion) {
      auto request = std::make_shared<RequestState>();
      const auto bytes = payload.dump().size();
      const auto posted = loop_.post(
          [this, request, generation, type = std::move(type), payload = std::move(payload),
           accepted = std::move(accepted), completion]() mutable {
            if (request->cancelled || closing_ || generation != session_.generation()) {
              completion(media::RpcFailure{"CANCELLED", "Voice generation retired"});
              return;
            }
            request->id = session_.request(std::move(type), std::move(payload), std::move(accepted),
                [completion](RpcResult result) {
                  // This resolves the wait directly; media control may be blocked on it.
                  if (result.failure) {
                    completion(media::RpcFailure{result.failure->code, result.failure->detail});
                  } else {
                    completion(media::RpcResponse{std::move(result.type), std::move(result.payload)});
                  }
                }, Clock::now(), generation);
          }, bytes);
      if (!posted) completion(media::RpcFailure{"CANCELLED", "Application event loop unavailable"});
      return [this, request] {
        request->cancelled = true;
        loop_.post([this, request] {
          if (!request->id.empty()) session_.cancel(request->id);
        });
      };
    };
    callbacks.notify = [this, generation](std::string type, Json payload) {
      const auto bytes = payload.dump().size();
      loop_.post([this, generation, type = std::move(type), payload = std::move(payload)]() mutable {
        if (closing_ || generation != session_.generation()) return;
        if (type == message::RTC_SIGNAL) session_.sendSignal(std::move(payload), generation);
        else session_.sendSfuNotification(std::move(type), std::move(payload), generation);
      }, bytes);
    };
    callbacks.observe = [this, generation](media::Event event) {
      const auto bytes = event.stats.dump().size();
      loop_.post([this, generation, event = std::move(event)] {
        if (generation != session_.generation() || generation != activeGeneration_) return;
        output({{"event", mediaEventName(event.kind)}, {"generation", generation},
                {"channelId", event.channel_id}, {"sessionId", event.session_id},
                {"detail", event.detail}, {"stats", event.stats}});
        if (event.kind == media::EventKind::failed && event.session_id.empty()) session_.leave();
      }, bytes);
    };
    return callbacks;
  }

  void beginVoice() {
    if (closing_ || !session_.admission() || !session_.authentication()) return;
    retireVoice();
    const auto& auth = *session_.authentication();
    const auto& admission = *session_.admission();
    media::JoinConfig config;
    config.self_user_id = auth.userId;
    config.self_session_id = auth.sessionId;
    config.channel_id = admission.channelId;
    config.mode = admission.mode == VoiceMode::sfu ? media::VoiceMode::sfu : media::VoiceMode::p2p;
    config.admitted_participants = roster();
    config.policy = audioPolicy();
    config.network_ignore_mask = audio_.networkIgnoreMask;
    if (auth.iceServers) {
      for (const auto& value : *auth.iceServers) {
        config.ice_servers.push_back({value.at("urls").get<std::vector<std::string>>(),
                                     value.value("username", ""), value.value("credential", "")});
      }
    } else {
      output({{"event", "warning"}, {"detail", "Server supplied no ICE configuration; using host candidates only"}});
    }
    activeGeneration_ = session_.generation();
    active_ = std::make_unique<media::VoiceEngine>(mediaCallbacks(activeGeneration_));
    joining_.push_back({activeGeneration_, active_->join(std::move(config))});
    operationDeadline_ = Clock::now() + 10ms;
    authorizeMicrophone();
  }

  void retireVoice() {
    if (!active_) return;
    auto result = active_->leave();
    retired_.push_back({std::move(active_), std::move(result)});
    activeGeneration_ = 0;
    operationDeadline_ = Clock::now() + 10ms;
  }

  void onSession(std::uint64_t attempt, const SessionEvent& event) {
    if (event.connection != session_.connection()) return;
    switch (event.kind) {
      case SessionEventKind::authenticated:
        if (!closing_ && session_.authentication()) {
          const auto& auth = *session_.authentication();
          output({{"event", "authenticated"}, {"userId", auth.userId}, {"sessionId", auth.sessionId},
                  {"voiceMode", session_.voiceMode() == VoiceMode::sfu ? "sfu" : "p2p"},
                  {"channels", auth.server.at("channels")}});
        }
        break;
      case SessionEventKind::admitted:
      case SessionEventKind::topologyChanged:
        if (event.generation != session_.generation() || closing_) break;
        output({{"event", "voice-admitted"}, {"generation", event.generation},
                {"channelId", session_.admission()->channelId},
                {"voiceMode", session_.voiceMode() == VoiceMode::sfu ? "sfu" : "p2p"}});
        beginVoice();
        break;
      case SessionEventKind::teardown:
        if (active_ && activeGeneration_ < event.generation) retireVoice();
        output({{"event", "voice-left"}, {"generation", event.generation}});
        break;
      case SessionEventKind::policyChanged:
        if (active_ && activeGeneration_ == session_.generation()) active_->update_policy(audioPolicy());
        authorizeMicrophone();
        if (!closing_) output({{"event", "voice-policy"}, {"policy", event.payload}});
        break;
      case SessionEventKind::rosterChanged:
      case SessionEventKind::peerJoined:
      case SessionEventKind::peerLeft:
        if (active_ && activeGeneration_ == event.generation) active_->update_roster(roster());
        break;
      case SessionEventKind::rtcSignal:
        if (active_ && activeGeneration_ == event.generation) active_->receive_signal(event.payload);
        break;
      case SessionEventKind::sfuEvent:
        if (!active_ || activeGeneration_ != event.generation) break;
        if (event.type == message::SFU_NEW_PRODUCER) active_->producer_added(event.payload);
        else if (event.type == message::SFU_PRODUCER_CLOSED) {
          active_->producer_closed(event.payload.at("producerId").get<std::string>());
        } else if (event.type == message::SFU_CONSUMER_CLOSED) {
          active_->consumer_closed(event.payload.at("consumerId").get<std::string>());
        }
        break;
      case SessionEventKind::reconnectRequested:
        if (attempt == attempt_) dial();
        break;
      case SessionEventKind::disconnected:
        if (event.type == message::USER_LOGOUT && closing_) {
          waitingLogoutEvent_ = false;
          drainDeadline_ = Clock::now() + 1s;
          operationDeadline_ = Clock::now() + 10ms;
        } else {
          if (attempt != attempt_) break;
          closeSocket();
          if (session_.phase() == SessionPhase::stopped && !closing_) {
            exitCode_ = 1;
            closing_ = true;
            waitingLogoutEvent_ = false;
            retireVoice();
          }
        }
        output({{"event", "disconnected"}, {"reconnecting", !closing_ && session_.phase() == SessionPhase::offline}});
        finishOperations(Clock::now());
        break;
      case SessionEventKind::kicked:
        output({{"event", "kicked"}, {"type", event.type}});
        break;
      case SessionEventKind::failure:
        if (event.failure) {
          output({{"event", "session-error"}, {"code", event.failure->code},
                  {"kind", static_cast<int>(event.failure->kind)}, {"detail", event.failure->detail}});
        }
        break;
    }
  }

  void finishOperations(Clock::time_point now) {
    for (auto entry = joining_.begin(); entry != joining_.end();) {
      if (entry->result.wait_for(0ms) != std::future_status::ready) {
        ++entry;
        continue;
      }
      const auto generation = entry->generation;
      try {
        entry->result.get();
      } catch (const std::exception& error) {
        output({{"event", generation == activeGeneration_ ? "media-error" : "media-operation-retired"},
                {"generation", generation}, {"detail", error.what()}});
        if (generation == activeGeneration_) session_.leave();
      }
      entry = joining_.erase(entry);
    }
    for (auto entry = retired_.begin(); entry != retired_.end();) {
      if (entry->result.wait_for(0ms) != std::future_status::ready) {
        ++entry;
        continue;
      }
      try {
        entry->result.get();
      } catch (const std::exception& error) {
        exitCode_ = 1;
        output({{"event", "media-cleanup-error"}, {"detail", error.what()}});
      }
      entry = retired_.erase(entry);
      output({{"event", "media-retired"}});
    }
    if (drainDeadline_ && (!socket_ || !socket_->hasPendingSends() || now >= *drainDeadline_)) {
      if (socket_ && socket_->hasPendingSends()) {
        output({{"event", "warning"}, {"detail", "Graceful logout write deadline exceeded"}});
      }
      closeSocket();
    }
    operationDeadline_ = joining_.empty() && retired_.empty() && !drainDeadline_
        ? std::nullopt : std::optional<Clock::time_point>(now + 10ms);
    if (closing_ && !waitingLogoutEvent_ && !socket_ && joining_.empty() && retired_.empty()) {
      output({{"event", "stopped"}});
      loop_.stop();
    }
  }

  ApplicationLoop::Deadline nextDeadline() const {
    auto result = session_.nextDeadline();
    if (operationDeadline_ && (!result || *operationDeadline_ < *result)) result = operationDeadline_;
    return result;
  }

  void quit() {
    if (closing_) return;
    closing_ = true;
    waitingLogoutEvent_ = true;
    retireVoice();
    session_.logout();
  }

  Json state() const {
    Json result{{"event", "state"}, {"phase", phaseName(session_.phase())},
                {"generation", session_.generation()}, {"connection", session_.connection()},
                {"voiceMode", session_.voiceMode() == VoiceMode::sfu ? "sfu" : "p2p"},
                {"mediaActive", active_ != nullptr}, {"retiringMedia", retired_.size()},
                {"policy", {{"muted", session_.policy().muted}, {"deafened", session_.policy().deafened},
                            {"serverMuted", session_.policy().serverMuted},
                            {"serverDeafened", session_.policy().serverDeafened}}},
                {"audioDevice", audio_.diagnostics ? audio_.diagnostics() : Json(nullptr)}};
    result["microphoneAccessPending"] = microphoneRequestPending_;
    result["channelId"] = session_.admission() ? Json(session_.admission()->channelId) : Json(nullptr);
    result["participants"] = session_.admission() ? session_.admission()->participants.size() : 0;
    result["channels"] = session_.authentication() ? session_.authentication()->server.at("channels") : Json(nullptr);
    return result;
  }

  void command(const std::string& line) {
    if (closing_ || line.empty()) return;
    Json id = nullptr;
    try {
      auto value = Json::parse(line, [](int depth, Json::parse_event_t, Json&) {
        if (depth > 8) throw std::invalid_argument("Command nesting exceeds its limit");
        return true;
      });
      if (!value.is_object()) throw std::invalid_argument("Command must be a JSON object");
      if (value.contains("id")) {
        if (!value.at("id").is_string()) throw std::invalid_argument("Command id must be a string");
        id = value.at("id");
      }
      const auto name = value.at("command").get<std::string>();
      if (name == "stats" || name == "channels") {
        auto snapshot = state();
        snapshot["id"] = id;
        output(std::move(snapshot));
        if (name == "stats" && active_) active_->poll_stats();
        return;
      }
      if (name == "join") session_.join(value.at("channelId").get<std::string>(), Clock::now());
      else if (name == "leave") session_.leave();
      else if (name == "mute") session_.setMuted(value.at("enabled").get<bool>());
      else if (name == "deafen") session_.setDeafened(value.at("enabled").get<bool>());
      else if (name == "reconnect") {
        const auto epoch = epoch_;
        closeSocket();
        if (epoch) session_.disconnected(*epoch, Clock::now());
        else session_.connectFailed(Clock::now());
      } else if (name != "quit") {
        throw std::invalid_argument("Unknown command; use join, leave, mute, deafen, stats, channels, reconnect or quit");
      }
      output({{"event", "command-accepted"}, {"id", id}, {"command", name}});
      if (name == "quit") quit();
    } catch (const Json::exception&) {
      output({{"event", "command-error"}, {"id", id}, {"detail", "Invalid command JSON or field type"}});
    } catch (const std::invalid_argument& error) {
      output({{"event", "command-error"}, {"id", id}, {"detail", error.what()}});
    }
  }

  Options options_;
  HeadlessConfiguration audio_;
  ProfileIdentity identity_;
  ApplicationLoop loop_;
  ProtocolSession session_;
  std::unique_ptr<WebSocket> socket_;
  std::uint64_t attempt_ = 0;
  std::optional<std::uint64_t> epoch_;
  std::unique_ptr<media::VoiceEngine> active_;
  std::uint64_t activeGeneration_ = 0;
  std::vector<Joining> joining_;
  std::vector<Retiring> retired_;
  ApplicationLoop::Deadline operationDeadline_;
  ApplicationLoop::Deadline drainDeadline_;
  bool closing_ = false;
  bool waitingLogoutEvent_ = false;
  bool microphoneAuthorized_ = false;
  bool microphoneRequestPending_ = false;
  CancelMicrophoneAccess cancelMicrophoneAccess_;
  int exitCode_ = 0;
};

}  // namespace

int runHeadless(std::vector<std::string> arguments, HeadlessConfiguration audio) {
  try {
    if (arguments == std::vector<std::string>{"--help"}) {
      std::cout << "Monky Light native voice core (development)\n"
                   "  --profile <absolute-path> --server <ws[s]://host:port> --nickname <name>\n"
                   "  [--channel <voice-channel-id>] [--muted] [--deafened]\n"
                   "The profile parent must exist. Password: MONKY_LIGHT_PASSWORD environment variable.\n"
                   "Control: one JSON object per line on stdin; events are JSON lines on stdout.\n"
                   "{\"command\":\"join\",\"channelId\":\"...\"}\n"
                   "{\"command\":\"mute\",\"enabled\":true}\n"
                   "{\"command\":\"deafen\",\"enabled\":false}\n"
                   "{\"command\":\"stats\"} / {\"command\":\"channels\"}\n"
                   "{\"command\":\"leave\"} / {\"command\":\"reconnect\"} / {\"command\":\"quit\"}\n"
                   "EOF and Ctrl+C release the connection and media resources.\n";
      return 0;
    }
    const auto options = parseOptions(arguments);
    if (!audio.create) throw std::invalid_argument("An explicit audio device factory is required");
    webrtc::LogMessage::LogToDebug(webrtc::LS_ERROR);
    webrtc::LogMessage::SetLogToStderr(true);
    Application application(options, std::move(audio));
    return application.run();
  } catch (const std::exception& error) {
    std::cerr << Json{{"event", "fatal-error"}, {"detail", error.what()}}.dump() << '\n';
    return 1;
  }
}

}  // namespace monky::light
