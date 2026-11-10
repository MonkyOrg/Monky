#include "headless_application.hpp"

#include "application_loop.hpp"
#include "identity_key.hpp"
#include "platform/console_control.hpp"
#include "platform/utf8.hpp"
#include "platform/websocket.hpp"
#include "profile_identity.hpp"
#include "protocol.hpp"
#include "protocol_session.hpp"
#include "push_to_talk_key.hpp"
#include "server_invite.hpp"

#include <rtc_base/logging.h>

#include <algorithm>
#include <atomic>
#include <csignal>
#include <cstdlib>
#include <filesystem>
#include <future>
#include <iostream>
#include <memory>
#include <optional>
#include <set>
#include <stdexcept>
#include <thread>
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
  bool tray = false;
  std::optional<std::string> pushToTalkKey;
  // From an invitation link given as --server (#821): the key it names and its password.
  std::optional<std::string> invitedServerKey;
  std::optional<std::string> invitedPassword;
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
    else if (flag == "--tray") result.tray = true;
    else {
      if (flag != "--profile" && flag != "--server" && flag != "--nickname" && flag != "--channel" &&
          flag != "--ptt-key") {
        throw std::invalid_argument("Unknown command-line option; use --help");
      }
      if (++index == arguments.size() || arguments[index].empty()) {
        throw std::invalid_argument("Command-line option requires a value");
      }
      const auto& value = arguments[index];
      if (flag == "--profile") result.profile = std::filesystem::path(std::u8string(value.begin(), value.end()));
      else if (flag == "--server") result.server = value;
      else if (flag == "--nickname") result.nickname = value;
      else if (flag == "--ptt-key") {
        if (!parsePushToTalkKey(value)) throw std::invalid_argument("Unknown --ptt-key; see --help");
        result.pushToTalkKey = value;
      } else result.channel = value;
    }
  }
  if (!result.profile.is_absolute() || result.server.empty() || result.nickname.empty()) {
    throw std::invalid_argument("--profile (absolute), --server and --nickname are required");
  }
  // An invitation link stands for its server, as in the desktop app. Its key is the only way a pinned key is replaced.
  if (looksLikeServerInvite(result.server)) {
    auto invite = parseServerInviteLink(result.server);
    result.server = invite.serverUrl();
    result.invitedServerKey = std::move(invite.serverKey);
    result.invitedPassword = std::move(invite.password);
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
    case media::EventKind::devices: return "audio-device-selected";
    case media::EventKind::speaking: return "speaking";
  }
  throw std::logic_error("Unknown media event");
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

// The environment password wins over one an invitation carries, as an explicit choice of the user.
std::optional<std::string> sessionPassword(const std::optional<std::string>& invited) {
  auto password = passwordFromEnvironment();
  return password ? password : invited;
}

class Application final {
 public:
  Application(Options options, HeadlessConfiguration audio)
      : options_(std::move(options)), audio_(std::move(audio)), identity_(options_.profile),
        session_({identity_.publicKeyHex(), identity_.deviceId(), options_.nickname,
                  sessionPassword(audio_.password ? audio_.password : options_.invitedPassword),
                  identity_.serverKey(options_.server), identity_.serverKeysExcept(options_.server),
                  options_.invitedServerKey},
                 {[this](const std::string& frame) {
                    const auto attempt = attempt_;
                    loop_.post([this, attempt, frame] { send(attempt, frame); }, frame.size());
                  },
                  [this](const ProtocolSession::Nonce& nonce, const std::optional<ProtocolSession::ServerProof>& proof)
                      -> std::optional<std::string> {
                    if (!proof) return identity_.signChallenge(nonce);
                    // Nothing is signed for a server that does not prove the key it presents (#821).
                    if (!verifyServerChallenge(nonce, proof->key, proof->signature)) return std::nullopt;
                    return identity_.signServerChallenge(nonce, proof->key);
                  },
                  [] { return randomUuid(); },
                  [this](const SessionEvent& event) {
                    const auto attempt = attempt_;
                    loop_.post([this, attempt, event] { onSession(attempt, event); }, event.payload.dump().size());
                  }}) {}

  // The interface is notified before the console stream, so an unusable stdout
  // cannot keep the tray from learning that the core is failing.
  void observeEvents(std::function<void(const Json&)> observer) { observer_ = std::move(observer); }

  CoreCommands commands() {
    return {
        [this](Json value) {
          auto line = value.dump();
          const auto bytes = line.size();
          loop_.post([this, line = std::move(line)] { command(line); }, bytes);
        },
        [this] { loop_.post([this] { quit(); }); },
        audio_.askAgain ? std::function<void()>([this] {
          audio_.askAgain(std::nullopt);
          loop_.post([this] { quit(); });
        })
                        : std::function<void()>(),
    };
  }

  ~Application() {
    stopWatchingDevices();
    if (cancelMicrophoneAccess_) cancelMicrophoneAccess_();
    // Settle app-owned RPCs before joining media workers or retiring the socket.
    if (session_.phase() != SessionPhase::stopped) session_.logout();
    active_.reset();
    retired_.clear();
    if (socket_) socket_->close();
  }

  int run() {
    // An application without a console has no control channel at all.
    std::optional<ConsoleControl> control;
    if (audio_.console) control.emplace(ConsoleControl::Callbacks{
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
    try {
      settings_ = identity_.loadSettings();
    } catch (const std::exception& error) {
      output({{"event", "warning"}, {"detail", std::string("Ignoring profile settings: ") + error.what()}});
    }
    // Saved like any other choice, so later starts and the tray keep the key.
    if (options_.pushToTalkKey && options_.pushToTalkKey != settings_.pushToTalkKey) {
      try {
        setPushToTalkKey(options_.pushToTalkKey);
      } catch (const std::invalid_argument& error) {
        output({{"event", "warning"}, {"detail", error.what()}});
      }
    }
    if (audio_.watchDevices) {
      stopWatchingDevices_ = audio_.watchDevices([this] {
        loop_.post([this] {
          devicesChangedDeadline_ = Clock::now() + kDeviceChangeSettle;
        });
      });
    }
    loop_.post([this] {
      session_.setMuted(options_.muted);
      session_.setDeafened(options_.deafened);
      if (options_.channel) session_.join(*options_.channel, Clock::now());
      dial();
    });
    loop_.run([this] { return nextDeadline(); }, [this](auto now) {
      session_.tick(now, unixMilliseconds());
      if (devicesChangedDeadline_ && now >= *devicesChangedDeadline_) devicesChanged();
      finishOperations(now);
    });
    stopWatchingDevices();
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
  struct DeviceQuery {
    Json id;
    std::future<media::AudioDeviceList> result;
  };
  struct RequestState {
    std::atomic_bool cancelled = false;
    std::string id;  // Owned only by the application loop.
  };

  void output(Json event) {
    if (observer_) observer_(event);
    if (outputLost_ || !audio_.console) return;
    std::cout << event.dump() << '\n' << std::flush;
    if (std::cout) return;
    // Nobody reads the events anymore. Leave the call and the server properly,
    // then stop. Losing whoever ran the core is a failure; losing the console
    // is how closing it ends the core on Windows 10 and Windows Server 2022,
    // which stop serving a closed console before its programs are done.
    outputLost_ = true;
    if (!outputIsConsole_) exitCode_ = 1;
    loop_.post([this] { quit(); });
  }

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
        // What this client never reads is dropped here, before it takes room
        // in the queue: a soundboard broadcast alone carries up to ~4 MiB.
        if (overrun_.load() == attempt || reader::discardable(frame)) return;
        const auto bytes = frame.size();
        if (loop_.offer([this, attempt, frame = std::move(frame)] {
              if (attempt == attempt_ && epoch_) session_.receive(*epoch_, frame, Clock::now());
            }, bytes)) return;
        // The core fell behind its own connection, as when the console holds
        // its output, and a message is lost: the session no longer knows what
        // the server said. Start over on a new connection, never mid-stream.
        overrun_.store(attempt);
        loop_.post([this, attempt] {
          if (attempt != attempt_ || closing_) return;
          output({{"event", "warning"}, {"detail", "Incoming messages outpaced the core; reconnecting"}});
          restartConnection();
        });
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

  // Drops the connection, and the session reconnects as after any loss.
  void restartConnection() {
    const auto epoch = epoch_;
    closeSocket();
    if (epoch) session_.disconnected(*epoch, Clock::now());
    else session_.connectFailed(Clock::now());
  }

  media::AudioPolicy audioPolicy() const {
    auto result = audio_.processing;
    result.muted = session_.policy().suppressMicrophone() ||
                   (audio_.requestMicrophoneAccess && !microphoneAuthorized_);
    result.deafened = session_.policy().suppressPlayback();
    result.transmit = !settings_.pushToTalk || pushToTalkActive_;
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
        // Read and validated by the session; absent on servers that predate it.
        const bool denied = participant.voiceState.value("permissionMuted", false);
        result.push_back({participant.userId, id, denied});
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
        if (event.kind == media::EventKind::speaking) {
          output({{"event", "speaking"}, {"generation", generation}, {"sessionId", event.session_id},
                  {"speaking", event.stats.at("speaking")}});
          return;
        }
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
    config.devices = devicePreference();
    for (const auto& [session, volume] : settings_.userVolumes) config.volumes.emplace(session, volume / 100.0);
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

  media::AudioDevicePreference devicePreference() const {
    return {settings_.inputDeviceId, settings_.outputDeviceId};
  }

  static Json deviceList(const std::vector<media::AudioDeviceInfo>& devices) {
    auto result = Json::array();
    for (const auto& device : devices) result.push_back({{"id", device.id}, {"name", device.name}});
    return result;
  }

  void queryDevices(Json id) {
    if (!audio_.enumerateDevices) throw std::invalid_argument("Audio device enumeration is unavailable");
    if (deviceQueries_.size() >= 4) throw std::invalid_argument("Too many pending audio device queries");
    std::promise<media::AudioDeviceList> promise;
    auto result = promise.get_future();
    // A dedicated thread keeps platform COM/apartment state out of reused pools.
    std::thread([enumerate = audio_.enumerateDevices, promise = std::move(promise)]() mutable {
      try {
        promise.set_value(enumerate());
      } catch (...) {
        promise.set_exception(std::current_exception());
      }
    }).detach();
    deviceQueries_.push_back({std::move(id), std::move(result)});
    operationDeadline_ = Clock::now() + 10ms;
  }

  void selectDevice(bool input, const Json& value) {
    if (!value.contains("deviceId")) throw std::invalid_argument("deviceId is required; use null for the system default");
    const auto& device = value.at("deviceId");
    if (!device.is_null() && !device.is_string()) throw std::invalid_argument("deviceId must be a string or null");
    auto settings = settings_;
    (input ? settings.inputDeviceId : settings.outputDeviceId) =
        device.is_null() ? std::nullopt : std::optional<std::string>(device.get<std::string>());
    try {
      identity_.saveSettings(settings);
    } catch (const std::invalid_argument&) {
      throw;
    } catch (const std::exception& error) {
      throw std::invalid_argument(std::string("Could not save audio device settings: ") + error.what());
    }
    settings_ = std::move(settings);
    if (active_) active_->select_devices(devicePreference());
  }

  void setInputMode(const Json& value) {
    const auto mode = value.at("mode").get<std::string>();
    if (mode != "voice_activity" && mode != "push_to_talk") {
      throw std::invalid_argument("mode must be voice_activity or push_to_talk");
    }
    auto settings = settings_;
    settings.pushToTalk = mode == "push_to_talk";
    try {
      identity_.saveSettings(settings);
    } catch (const std::invalid_argument&) {
      throw;
    } catch (const std::exception& error) {
      throw std::invalid_argument(std::string("Could not save input mode: ") + error.what());
    }
    settings_ = std::move(settings);
    // A key held while switching modes must not keep transmitting later.
    pushToTalkActive_ = false;
    applyAudioPolicy();
    output({{"event", "input-mode"}, {"mode", mode}});
  }

  // The key itself is the controller's business (a global hotkey in the tray
  // app); the core only gates transmission.
  void pushToTalk(bool active) {
    if (!settings_.pushToTalk) throw std::invalid_argument("Push-to-talk is not the input mode");
    if (pushToTalkActive_ == active) return;
    pushToTalkActive_ = active;
    applyAudioPolicy();
  }

  // The key is detected by the interface (a global hook in the tray); the core
  // only stores it so every interface and later start agree on it.
  void setPushToTalkKey(const std::optional<std::string>& key) {
    if (key && !parsePushToTalkKey(*key)) throw std::invalid_argument("Unknown push-to-talk key");
    auto settings = settings_;
    settings.pushToTalkKey = key;
    try {
      identity_.saveSettings(settings);
    } catch (const std::invalid_argument&) {
      throw;
    } catch (const std::exception& error) {
      throw std::invalid_argument(std::string("Could not save push-to-talk key: ") + error.what());
    }
    settings_ = std::move(settings);
    output({{"event", "push-to-talk-key"}, {"key", key ? Json(*key) : Json(nullptr)}});
  }

  // Who is in the current call, with the names the server sent and the volume
  // this profile hears each session at. Empty outside a call.
  Json members() const {
    auto result = Json::array();
    if (!session_.admission() || !session_.authentication()) return result;
    const auto& self = session_.authentication()->sessionId;
    for (const auto& [session, participant] : session_.admission()->participants) {
      std::string name;
      if (participant.user && participant.user->is_object()) {
        const auto nickname = participant.user->find("nickname");
        if (nickname != participant.user->end() && nickname->is_string()) name = nickname->get<std::string>();
      }
      const auto volume = settings_.userVolumes.find(session);
      result.push_back({{"sessionId", session}, {"userId", participant.userId}, {"name", name},
                        {"self", session == self},
                        {"volume", volume == settings_.userVolumes.end() ? kDefaultUserVolume : volume->second}});
    }
    return result;
  }

  void publishParticipants() {
    if (!closing_) output({{"event", "participants"}, {"members", members()}});
  }

  void applyAudioPolicy() {
    if (active_ && activeGeneration_ == session_.generation()) active_->update_policy(audioPolicy());
  }

  // Same scale and key as the full client: 0-200 percent per voice session.
  void setVolume(const Json& value) {
    const auto session = value.at("sessionId").get<std::string>();
    const auto& level = value.at("volume");
    if (!level.is_number_integer() || level.get<int>() < 0 || level.get<int>() > kMaxUserVolume) {
      throw std::invalid_argument("volume must be an integer from 0 to 200");
    }
    const auto volume = level.get<int>();
    auto settings = settings_;
    if (volume == kDefaultUserVolume) settings.userVolumes.erase(session);
    else settings.userVolumes[session] = volume;
    try {
      identity_.saveSettings(settings);
    } catch (const std::invalid_argument&) {
      throw;
    } catch (const std::exception& error) {
      throw std::invalid_argument(std::string("Could not save participant volume: ") + error.what());
    }
    settings_ = std::move(settings);
    if (active_) active_->set_volume(session, volume / 100.0);
    output({{"event", "participant-volume"}, {"sessionId", session}, {"volume", volume}});
  }

  void stopWatchingDevices() {
    if (!stopWatchingDevices_) return;
    auto stop = std::move(stopWatchingDevices_);
    stopWatchingDevices_ = nullptr;
    stop();
  }

  void devicesChanged() {
    devicesChangedDeadline_.reset();
    if (closing_) return;
    output({{"event", "audio-devices-changed"}});
    // Re-resolve the preference: return to a reconnected device, or leave a removed one.
    if (active_) active_->select_devices(devicePreference());
  }

  void retireVoice() {
    if (!active_) return;
    auto result = active_->leave();
    retired_.push_back({std::move(active_), std::move(result)});
    activeGeneration_ = 0;
    operationDeadline_ = Clock::now() + 10ms;
  }

  // The first protected sign-in pins this server's key in the profile; later runs require it (#821).
  void pinServerKey(const std::string& key) {
    try {
      identity_.pinServerKey(options_.server, key);
    } catch (const std::exception& error) {
      output({{"event", "warning"}, {"detail", std::string("Could not remember the server key: ") + error.what()}});
    }
  }

  void onSession(std::uint64_t attempt, const SessionEvent& event) {
    if (event.connection != session_.connection()) return;
    switch (event.kind) {
      case SessionEventKind::authenticated:
        if (!closing_ && session_.authentication()) {
          const auto& auth = *session_.authentication();
          if (auth.serverKey) pinServerKey(*auth.serverKey);
          output({{"event", "authenticated"}, {"userId", auth.userId}, {"sessionId", auth.sessionId},
                  {"voiceMode", session_.voiceMode() == VoiceMode::sfu ? "sfu" : "p2p"},
                  {"serverName", auth.server.at("name")},
                  {"channels", auth.server.at("channels")},
                  // An interface starts from these instead of asking for state.
                  {"inputMode", settings_.pushToTalk ? "push_to_talk" : "voice_activity"},
                  {"pushToTalkKey", settings_.pushToTalkKey ? Json(*settings_.pushToTalkKey) : Json(nullptr)}});
        }
        break;
      case SessionEventKind::admitted:
      case SessionEventKind::topologyChanged:
        if (event.generation != session_.generation() || closing_) break;
        output({{"event", "voice-admitted"}, {"generation", event.generation},
                {"channelId", session_.admission()->channelId},
                {"voiceMode", session_.voiceMode() == VoiceMode::sfu ? "sfu" : "p2p"}});
        beginVoice();
        publishParticipants();
        break;
      case SessionEventKind::teardown:
        if (active_ && activeGeneration_ < event.generation) retireVoice();
        // Like the full client, a key held across calls does not carry over.
        pushToTalkActive_ = false;
        output({{"event", "voice-left"}, {"generation", event.generation}});
        publishParticipants();
        break;
      case SessionEventKind::policyChanged:
        applyAudioPolicy();
        authorizeMicrophone();
        if (!closing_) output({{"event", "voice-policy"}, {"policy", event.payload}});
        break;
      case SessionEventKind::rosterChanged:
      case SessionEventKind::peerJoined:
      case SessionEventKind::peerLeft:
        if (active_ && activeGeneration_ == event.generation) active_->update_roster(roster());
        publishParticipants();
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
      case SessionEventKind::channelsChanged:
        // Channel creation, renaming and deletion used to be visible only by
        // polling the state snapshot, which an interface must not do.
        if (!closing_) output({{"event", "channels-changed"}, {"channels", event.payload.at("channels")}});
        break;
      case SessionEventKind::kicked:
        output({{"event", "kicked"}, {"type", event.type}});
        break;
      case SessionEventKind::failure:
        if (event.failure) {
          output({{"event", "session-error"}, {"code", event.failure->code},
                  {"kind", static_cast<int>(event.failure->kind)}, {"detail", event.failure->detail}});
          // Retrying cannot fix these; the connection window can.
          const auto& code = event.failure->code;
          if (audio_.askAgain && (code == protocol::error::AUTH_INVALID_PASSWORD ||
                                  code == protocol::error::NICKNAME_ALREADY_EXISTS ||
                                  code == protocol::error::NICKNAME_INVALID)) {
            audio_.askAgain(code);
            quit();
          }
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
    for (auto entry = deviceQueries_.begin(); entry != deviceQueries_.end();) {
      if (entry->result.wait_for(0ms) != std::future_status::ready) {
        ++entry;
        continue;
      }
      try {
        const auto devices = entry->result.get();
        if (!closing_) {
          output({{"event", "audio-devices"}, {"id", entry->id},
                  {"inputs", deviceList(devices.inputs)}, {"outputs", deviceList(devices.outputs)},
                  {"inputDeviceId", settings_.inputDeviceId ? Json(*settings_.inputDeviceId) : Json(nullptr)},
                  {"outputDeviceId", settings_.outputDeviceId ? Json(*settings_.outputDeviceId) : Json(nullptr)}});
        }
      } catch (const std::exception& error) {
        if (!closing_) {
          output({{"event", "command-error"}, {"id", entry->id},
                  {"detail", std::string("Audio device enumeration failed: ") + error.what()}});
        }
      }
      entry = deviceQueries_.erase(entry);
    }
    if (drainDeadline_ && (!socket_ || !socket_->hasPendingSends() || now >= *drainDeadline_)) {
      if (socket_ && socket_->hasPendingSends()) {
        output({{"event", "warning"}, {"detail", "Graceful logout write deadline exceeded"}});
      }
      closeSocket();
    }
    operationDeadline_ = joining_.empty() && retired_.empty() && deviceQueries_.empty() && !drainDeadline_
        ? std::nullopt : std::optional<Clock::time_point>(now + 10ms);
    if (closing_ && !waitingLogoutEvent_ && !socket_ && joining_.empty() && retired_.empty() &&
        deviceQueries_.empty()) {
      output({{"event", "stopped"}});
      loop_.stop();
    }
  }

  ApplicationLoop::Deadline nextDeadline() const {
    auto result = session_.nextDeadline();
    if (operationDeadline_ && (!result || *operationDeadline_ < *result)) result = operationDeadline_;
    if (devicesChangedDeadline_ && (!result || *devicesChangedDeadline_ < *result)) result = devicesChangedDeadline_;
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
                {"policy", session_.policy().describe()},
                {"inputMode", settings_.pushToTalk ? "push_to_talk" : "voice_activity"},
                {"pushToTalkActive", pushToTalkActive_},
                {"audioDevice", audio_.diagnostics ? audio_.diagnostics() : Json(nullptr)}};
    result["microphoneAccessPending"] = microphoneRequestPending_;
    result["channelId"] = session_.admission() ? Json(session_.admission()->channelId) : Json(nullptr);
    result["participants"] = session_.admission() ? session_.admission()->participants.size() : 0;
    // Only the current call's sessions: the profile may remember many more.
    auto volumes = Json::object();
    if (session_.admission()) {
      for (const auto& [session, participant] : session_.admission()->participants) {
        const auto found = settings_.userVolumes.find(session);
        if (found != settings_.userVolumes.end()) volumes[session] = found->second;
      }
    }
    result["userVolumes"] = std::move(volumes);
    result["members"] = members();
    result["pushToTalkKey"] = settings_.pushToTalkKey ? Json(*settings_.pushToTalkKey) : Json(nullptr);
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
      if (name == "devices") {
        queryDevices(id);
        return;
      }
      if (name.starts_with("fixture-") && audio_.fixtureCommand) audio_.fixtureCommand(value);
      else if (name == "set-input") selectDevice(true, value);
      else if (name == "set-output") selectDevice(false, value);
      else if (name == "set-input-mode") setInputMode(value);
      else if (name == "ptt") pushToTalk(value.at("active").get<bool>());
      else if (name == "set-volume") setVolume(value);
      else if (name == "set-ptt-key") {
        const auto& key = value.at("key");
        if (!key.is_null() && !key.is_string()) throw std::invalid_argument("key must be a key name or null");
        setPushToTalkKey(key.is_null() ? std::nullopt : std::optional<std::string>(key.get<std::string>()));
      }
      else if (name == "join") session_.join(value.at("channelId").get<std::string>(), Clock::now());
      else if (name == "leave") session_.leave();
      else if (name == "mute") session_.setMuted(value.at("enabled").get<bool>());
      else if (name == "deafen") session_.setDeafened(value.at("enabled").get<bool>());
      else if (name == "reconnect") restartConnection();
      else if (name != "quit") {
        throw std::invalid_argument("Unknown command; use join, leave, mute, deafen, devices, set-input, "
                                    "set-output, set-input-mode, ptt, set-ptt-key, set-volume, stats, channels, reconnect or quit");
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
  // The connection attempt whose input outran the core; written by the transport.
  std::atomic<std::uint64_t> overrun_ = 0;
  std::optional<std::uint64_t> epoch_;
  std::unique_ptr<media::VoiceEngine> active_;
  std::uint64_t activeGeneration_ = 0;
  std::vector<Joining> joining_;
  std::vector<Retiring> retired_;
  std::vector<DeviceQuery> deviceQueries_;
  ProfileSettings settings_;
  StopWatchingAudioDevices stopWatchingDevices_;
  // Device notifications arrive in bursts; apply the preference once they settle.
  static constexpr auto kDeviceChangeSettle = 300ms;
  ApplicationLoop::Deadline devicesChangedDeadline_;
  ApplicationLoop::Deadline operationDeadline_;
  ApplicationLoop::Deadline drainDeadline_;
  bool closing_ = false;
  bool waitingLogoutEvent_ = false;
  bool outputLost_ = false;
  // Read at start: once the console is closed it can no longer be told apart.
  const bool outputIsConsole_ = standardOutputIsConsole();
  bool microphoneAuthorized_ = false;
  bool microphoneRequestPending_ = false;
  bool pushToTalkActive_ = false;
  CancelMicrophoneAccess cancelMicrophoneAccess_;
  std::function<void(const Json&)> observer_;
  int exitCode_ = 0;
};

}  // namespace

int runHeadless(std::vector<std::string> arguments, HeadlessConfiguration audio) {
#ifndef _WIN32
  // Writing to a stdout nobody reads raises SIGPIPE, which would end the process
  // before it could leave the call and log out. Ignored, the write just fails,
  // and that failure is how the core learns it lost its output. It stays
  // ignored through teardown, which may still write.
  std::signal(SIGPIPE, SIG_IGN);
#endif
  try {
    if (arguments == std::vector<std::string>{"--help"}) {
      std::cout << "Monky Light native voice core (development)\n"
                   "  --profile <absolute-path> --server <ws[s]://host:port | invitation link> --nickname <name>\n"
                   "  [--channel <voice-channel-id>] [--muted] [--deafened] [--tray] [--ptt-key <key>]\n"
                   "--ptt-key: A-Z, 0-9, F1-F24, Mouse4, Mouse5, RightControl, RightAlt, RightShift,\n"
                   "  Backquote, Insert or Pause; saved in the profile for the tray's push-to-talk.\n"
                   "The profile parent must exist. Password: MONKY_LIGHT_PASSWORD environment variable, else the invitation's.\n"
                   "Control: one JSON object per line on stdin; events are JSON lines on stdout.\n"
                   "{\"command\":\"join\",\"channelId\":\"...\"}\n"
                   "{\"command\":\"mute\",\"enabled\":true}\n"
                   "{\"command\":\"deafen\",\"enabled\":false}\n"
                   "{\"command\":\"devices\"} / {\"command\":\"set-input\",\"deviceId\":\"...\"|null}\n"
                   "{\"command\":\"set-output\",\"deviceId\":\"...\"|null}\n"
                   "{\"command\":\"set-input-mode\",\"mode\":\"voice_activity\"|\"push_to_talk\"}\n"
                   "{\"command\":\"ptt\",\"active\":true|false}\n"
                   "{\"command\":\"set-ptt-key\",\"key\":\"F13\"|null}\n"
                   "{\"command\":\"set-volume\",\"sessionId\":\"...\",\"volume\":0-200}\n"
                   "{\"command\":\"stats\"} / {\"command\":\"channels\"}\n"
                   "{\"command\":\"leave\"} / {\"command\":\"reconnect\"} / {\"command\":\"quit\"}\n"
                   "EOF and Ctrl+C release the connection and media resources.\n"
                   "--tray adds the native tray interface; the console control stays available.\n";
      return 0;
    }
    const auto options = parseOptions(arguments);
    if (!audio.create) throw std::invalid_argument("An explicit audio device factory is required");
    webrtc::LogMessage::LogToDebug(webrtc::LS_ERROR);
    webrtc::LogMessage::SetLogToStderr(true);
    auto createInterface = std::move(audio.createInterface);
    Application application(options, std::move(audio));
    if (!options.tray) return application.run();
    if (!createInterface) throw std::invalid_argument("This build has no native tray interface");
    // The platform event loops own the main thread, so the core loop moves to a
    // worker. Without --tray the core keeps the main thread as it always has.
    auto tray = createInterface(application.commands());
    application.observeEvents([&tray](const Json& event) { tray->observe(event); });
    int core = 0;
    std::thread worker([&] {
      try {
        core = application.run();
      } catch (const std::exception& error) {
        std::cerr << Json{{"event", "fatal-error"}, {"detail", error.what()}}.dump() << '\n';
        core = 1;
      }
      // Always reached, so a failing core can never leave the interface waiting.
      tray->stopped();
    });
    const auto ui = tray->run();
    // The interface may also close on its own, through the window manager.
    application.commands().quit();
    worker.join();
    // The observer outlives neither thread; the interface is released first.
    application.observeEvents(nullptr);
    return core != 0 ? core : ui;
  } catch (const std::exception& error) {
    std::cerr << Json{{"event", "fatal-error"}, {"detail", error.what()}}.dump() << '\n';
    return 1;
  }
}

}  // namespace monky::light
