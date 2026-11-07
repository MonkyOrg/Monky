#pragma once

#include "push_to_talk_key.hpp"
#include "ui/tray_strings.hpp"

#include <json.hpp>

#include <algorithm>
#include <array>
#include <set>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace monky::light::ui {

using Json = nlohmann::json;

// One selectable row of the interface: a voice channel or an audio device.
struct MenuEntry {
  // Empty for the operating system default audio device.
  std::string id;
  std::string name;
  bool selected = false;
};

// Someone else in the current call, with the volume this profile hears them at.
struct Person {
  std::string sessionId;
  std::string name;
  int volume = 100;
  bool speaking = false;
};

// The volumes a native menu offers. A slider belongs to the future panels.
inline constexpr std::array<int, 7> kVolumePresets{0, 25, 50, 75, 100, 150, 200};

// Everything the native interface draws, already localized. Platform code only
// maps these fields onto menu items, so this is the one place where interface
// behaviour is decided and the only part worth covering with unit tests.
struct Presentation {
  std::string tooltip;
  std::string status;
  // Icon variants. They are independent: a disconnected client can be muted.
  bool connected = false;
  bool inCall = false;
  bool silenced = false;
  std::vector<MenuEntry> channels;
  std::vector<MenuEntry> inputs;
  std::vector<MenuEntry> outputs;
  bool canJoin = false;
  bool canLeave = false;
  bool muteChecked = false;
  bool muteEnabled = false;
  bool deafenChecked = false;
  bool deafenEnabled = false;
  std::string muteLabel;
  std::string deafenLabel;
  // The local user is speaking in an established call.
  bool speaking = false;
  bool pushToTalkChecked = false;
  std::string pushToTalkLabel;
  // The key the interface must watch, only while push-to-talk can transmit: a
  // global hook costs nothing when it is not installed.
  std::optional<PushToTalkKey> hotkey;
  std::vector<Person> people;
};

// Rebuilds the interface state from the events the console consumer already
// receives, so the tray never needs a second query path into the core.
class TrayModel final {
 public:
  explicit TrayModel(Language language = Language::english) : text_(textFor(language)) {}

  // Returns true when the interface must react: redraw, or show a pending alert.
  // Events that only carry statistics deliberately return false so a call does
  // not wake the interface thread on every measurement.
  bool apply(const Json& event) {
    if (!event.is_object()) return false;
    const auto name = stringAt(event, "event");
    if (name == "connecting") return relink(Link::connecting);
    if (name == "authenticating") return relink(Link::authenticating);
    if (name == "authenticated") {
      serverName_ = stringAt(event, "serverName");
      selfSession_ = stringAt(event, "sessionId");
      applyInput(event);
      applyChannels(event);
      // The list is only enumerated on demand; ask once the session is usable.
      refreshDevices_ = true;
      relink(Link::ready);
      return true;
    }
    if (name == "state") return applyState(event);
    if (name == "input-mode") {
      pushToTalk_ = stringAt(event, "mode") == "push_to_talk";
      return true;
    }
    if (name == "push-to-talk-key") {
      pushToTalkKey_ = idAt(event, "key");
      return true;
    }
    if (name == "participants") {
      applyMembers(event);
      return true;
    }
    if (name == "participant-volume") {
      const auto session = stringAt(event, "sessionId");
      const auto volume = event.find("volume");
      for (auto& person : members_) {
        if (person.sessionId == session && volume != event.end() && volume->is_number_integer()) {
          person.volume = volume->get<int>();
        }
      }
      // Only the menu shows volumes, and it is rebuilt when it opens.
      return false;
    }
    if (name == "speaking") {
      const auto session = stringAt(event, "sessionId");
      if (boolAt(event, "speaking")) speakers_.insert(session);
      else speakers_.erase(session);
      // Only the local user's speech changes the icon; the menu reads the rest when it opens.
      return session == selfSession_;
    }
    if (name == "channels-changed") {
      applyChannels(event);
      return true;
    }
    if (name == "disconnected") {
      mediaConnected_ = false;
      return relink(boolAt(event, "reconnecting") ? Link::reconnecting : Link::disconnected);
    }
    if (name == "stopped") {
      mediaConnected_ = false;
      channelId_.reset();
      members_.clear();
      speakers_.clear();
      return relink(Link::disconnected);
    }
    if (name == "voice-admitted") {
      channelId_ = idAt(event, "channelId");
      return true;
    }
    if (name == "voice-left") {
      channelId_.reset();
      mediaConnected_ = false;
      members_.clear();
      speakers_.clear();
      return true;
    }
    if (name == "voice-policy") return applyPolicy(event);
    if (name == "media-connected") {
      mediaConnected_ = true;
      return true;
    }
    if (name == "media-reconnecting") {
      mediaConnected_ = false;
      return true;
    }
    if (name == "audio-devices") {
      inputs_ = entries(event, "inputs");
      outputs_ = entries(event, "outputs");
      inputPreference_ = idAt(event, "inputDeviceId");
      outputPreference_ = idAt(event, "outputDeviceId");
      return true;
    }
    if (name == "audio-devices-changed") {
      // The answer replaces the list; enumerating here would open the devices twice.
      refreshDevices_ = true;
      return false;
    }
    if (name == "audio-device-selected") return applySelection(event);
    if (name == "microphone-permission") return applyMicrophone(event);
    if (name == "kicked") {
      alert_ = text_.kicked;
      return true;
    }
    if (name == "media-error" || name == "media-cleanup-error") {
      // A failure tied to one participant costs only that participant's audio.
      if (stringAt(event, "sessionId").empty()) mediaConnected_ = false;
      alert_ = detail(event);
      return true;
    }
    if (name == "session-error" || name == "fatal-error" || name == "transport-error" ||
        name == "command-error") {
      alert_ = serverKeyAlert(event).value_or(detail(event));
      return true;
    }
    return false;
  }

  Presentation presentation() const {
    Presentation result;
    result.status = status();
    result.tooltip = serverName_.empty() ? std::string(text_.application) + " — " + result.status
                                         : std::string(text_.application) + " · " + serverName_ +
                                               " — " + result.status;
    result.connected = link_ == Link::ready;
    result.inCall = channelId_.has_value() && mediaConnected_;
    result.silenced = muted_ || serverMuted_ || permissionMuted_ || deafened_ || serverDeafened_;
    result.channels = channels_;
    for (auto& channel : result.channels) channel.selected = channelId_ && *channelId_ == channel.id;
    result.inputs = select(inputs_, inputPreference_, unavailableInput_);
    result.outputs = select(outputs_, outputPreference_, unavailableOutput_);
    result.canJoin = link_ == Link::ready;
    result.canLeave = channelId_.has_value();
    result.muteChecked = muted_ || serverMuted_ || permissionMuted_;
    result.muteEnabled = !serverMuted_ && !permissionMuted_;
    result.deafenChecked = deafened_ || serverDeafened_;
    result.deafenEnabled = !serverDeafened_;
    // Who keeps the microphone closed: a moderator, or the room's Speak permission.
    result.muteLabel = label(text_.muteMicrophone, serverMuted_       ? text_.byServer
                                                   : permissionMuted_ ? text_.noPermissionToSpeak
                                                                      : nullptr);
    result.deafenLabel = label(text_.deafen, serverDeafened_ ? text_.byServer : nullptr);
    result.speaking = result.inCall && speakers_.contains(selfSession_);
    result.pushToTalkChecked = pushToTalk_;
    const auto key = pushToTalkKey_ ? parsePushToTalkKey(*pushToTalkKey_) : std::nullopt;
    const bool usable = key && hotkeyUsable(*key);
    result.pushToTalkLabel = label(text_.pushToTalk, nullptr);
    if (!key) result.pushToTalkLabel += " (" + std::string(text_.noPushToTalkKey) + ")";
    else {
      result.pushToTalkLabel += " (" + std::string(text_.key) + ": " + key->name;
      if (!usable) result.pushToTalkLabel += ", " + std::string(text_.keyUnavailable);
      result.pushToTalkLabel += ")";
    }
    if (pushToTalk_ && usable && channelId_) result.hotkey = key;
    for (const auto& member : members_) {
      if (member.sessionId == selfSession_) continue;
      auto person = member;
      person.speaking = speakers_.contains(member.sessionId);
      if (person.name.empty()) person.name = text_.participant;
      result.people.push_back(std::move(person));
    }
    return result;
  }

  // An alert is consumed once shown so a notification is never repeated.
  std::optional<std::string> takeAlert() { return std::exchange(alert_, std::nullopt); }

  // True once when the device list must be enumerated again.
  bool takeDeviceRefresh() { return std::exchange(refreshDevices_, false); }

 private:
  enum class Link { connecting, authenticating, ready, reconnecting, disconnected };

  // macOS reports no key code for some names a Windows profile may hold.
  static bool hotkeyUsable(const PushToTalkKey& key) {
#ifdef __APPLE__
    return key.mac.has_value();
#else
    return key.windows != 0;
#endif
  }

  void applyInput(const Json& event) {
    if (event.contains("inputMode")) pushToTalk_ = stringAt(event, "inputMode") == "push_to_talk";
    if (event.contains("pushToTalkKey")) pushToTalkKey_ = idAt(event, "pushToTalkKey");
  }

  void applyMembers(const Json& event) {
    const auto found = event.find("members");
    if (found == event.end() || !found->is_array()) return;
    members_.clear();
    std::set<std::string> present;
    for (const auto& value : *found) {
      if (!value.is_object()) continue;
      Person person;
      person.sessionId = stringAt(value, "sessionId");
      if (person.sessionId.empty()) continue;
      person.name = stringAt(value, "name");
      const auto volume = value.find("volume");
      if (volume != value.end() && volume->is_number_integer()) person.volume = volume->get<int>();
      present.insert(person.sessionId);
      members_.push_back(std::move(person));
    }
    // Someone who left cannot still be speaking.
    std::erase_if(speakers_, [&](const std::string& session) { return !present.contains(session); });
  }

  static std::string stringAt(const Json& value, const char* key) {
    const auto found = value.find(key);
    return found != value.end() && found->is_string() ? found->get<std::string>() : std::string();
  }

  static bool boolAt(const Json& value, const char* key) {
    const auto found = value.find(key);
    return found != value.end() && found->is_boolean() && found->get<bool>();
  }

  static std::optional<std::string> idAt(const Json& value, const char* key) {
    const auto found = value.find(key);
    if (found == value.end() || !found->is_string() || found->get<std::string>().empty()) {
      return std::nullopt;
    }
    return found->get<std::string>();
  }

  static const Json* objectAt(const Json& value, const char* key) {
    const auto found = value.find(key);
    return found != value.end() && found->is_object() ? &*found : nullptr;
  }

  std::string detail(const Json& event) const {
    auto result = stringAt(event, "detail");
    return result.empty() ? std::string(text_.disconnected) : result;
  }

  // A sign-in the core refused over the server's identity key, explained in the interface language (#821).
  std::optional<std::string> serverKeyAlert(const Json& event) const {
    const auto code = stringAt(event, "code");
    if (code == "SERVER_KEY_CHANGED") return std::string(text_.serverKeyChanged);
    if (code == "SERVER_KEY_MISSING") return std::string(text_.serverKeyMissing);
    if (code == "SERVER_KEY_OF_OTHER_SERVER") return std::string(text_.serverKeyOfOtherServer);
    if (code == "SERVER_KEY_INVALID") return std::string(text_.serverKeyInvalid);
    return std::nullopt;
  }

  bool relink(Link link) {
    if (link_ == link) return false;
    link_ = link;
    return true;
  }

  void applyChannels(const Json& event) {
    const auto found = event.find("channels");
    if (found == event.end() || !found->is_array()) return;
    std::vector<std::pair<double, MenuEntry>> ordered;
    for (const auto& value : *found) {
      if (!value.is_object() || stringAt(value, "type") != "VOICE") continue;
      auto id = stringAt(value, "id");
      auto name = stringAt(value, "name");
      if (id.empty() || name.empty()) continue;
      const auto position = value.find("position");
      const auto rank = position != value.end() && position->is_number()
                            ? position->get<double>()
                            : 0.0;
      ordered.push_back({rank, MenuEntry{std::move(id), std::move(name), false}});
    }
    // Channels created after authentication arrive appended, not in server order.
    std::stable_sort(ordered.begin(), ordered.end(),
                     [](const auto& left, const auto& right) { return left.first < right.first; });
    channels_.clear();
    for (auto& entry : ordered) channels_.push_back(std::move(entry.second));
  }

  bool applyState(const Json& event) {
    const auto phase = stringAt(event, "phase");
    if (phase == "stopped") link_ = Link::disconnected;
    else if (phase == "offline") link_ = Link::reconnecting;
    else if (phase == "authenticating") link_ = Link::authenticating;
    else if (!phase.empty()) link_ = Link::ready;
    channelId_ = idAt(event, "channelId");
    // mediaActive only means an engine exists; it never promotes a pending call.
    if (!boolAt(event, "mediaActive")) mediaConnected_ = false;
    applyChannels(event);
    applyInput(event);
    applyMembers(event);
    applyPolicy(event);
    return true;
  }

  bool applyPolicy(const Json& event) {
    const auto* policy = objectAt(event, "policy");
    if (!policy) return false;
    muted_ = boolAt(*policy, "muted");
    deafened_ = boolAt(*policy, "deafened");
    serverMuted_ = boolAt(*policy, "serverMuted");
    serverDeafened_ = boolAt(*policy, "serverDeafened");
    permissionMuted_ = boolAt(*policy, "permissionMuted");
    return true;
  }

  bool applySelection(const Json& event) {
    const auto* stats = objectAt(event, "stats");
    if (!stats) return false;
    const auto unavailable = [](const Json* side) -> std::optional<std::string> {
      if (!side || !boolAt(*side, "fallback")) return std::nullopt;
      return idAt(*side, "requestedId");
    };
    unavailableInput_ = unavailable(objectAt(*stats, "input"));
    unavailableOutput_ = unavailable(objectAt(*stats, "output"));
    if (unavailableInput_ || unavailableOutput_) alert_ = detail(event);
    return true;
  }

  bool applyMicrophone(const Json& event) {
    const auto state = stringAt(event, "state");
    microphoneRefused_ = state == "denied" || state == "restricted";
    if (microphoneRefused_) alert_ = text_.microphoneRefused;
    microphonePending_ = state == "requesting";
    return true;
  }

  std::string channelName(const std::string& id) const {
    const auto found = std::find_if(channels_.begin(), channels_.end(),
                                    [&](const MenuEntry& entry) { return entry.id == id; });
    return found == channels_.end() ? id : found->name;
  }

  std::string status() const {
    switch (link_) {
      case Link::connecting: return text_.connecting;
      case Link::authenticating: return text_.authenticating;
      case Link::reconnecting: return text_.reconnecting;
      case Link::disconnected: return text_.disconnected;
      case Link::ready: break;
    }
    if (!channelId_) return text_.connected;
    if (!mediaConnected_) {
      return microphonePending_ ? std::string(text_.microphonePending) : std::string(text_.joining);
    }
    auto result = std::string(text_.inCall) + ": " + channelName(*channelId_);
    if (microphoneRefused_) result += " · " + std::string(text_.microphoneRefused);
    return result;
  }

  std::string label(const char* base, const char* note) const {
    auto result = std::string(base);
    if (note) result += " (" + std::string(note) + ")";
    return result;
  }

  std::vector<MenuEntry> entries(const Json& event, const char* key) const {
    std::vector<MenuEntry> result;
    const auto found = event.find(key);
    if (found == event.end() || !found->is_array()) return result;
    for (const auto& value : *found) {
      if (!value.is_object()) continue;
      auto id = stringAt(value, "id");
      auto name = stringAt(value, "name");
      if (id.empty() || name.empty()) continue;
      result.push_back({std::move(id), std::move(name), false});
    }
    return result;
  }

  std::vector<MenuEntry> select(const std::vector<MenuEntry>& devices,
                                const std::optional<std::string>& preference,
                                const std::optional<std::string>& unavailable) const {
    std::vector<MenuEntry> result;
    // The default row always exists, even before the first enumeration answers:
    // it is the only way to clear a preference.
    result.push_back({{}, text_.systemDefault, !preference.has_value()});
    for (const auto& device : devices) {
      auto entry = device;
      entry.selected = preference && *preference == device.id;
      // The preference is kept even while the device is gone, so it can return.
      if (unavailable && *unavailable == device.id) {
        entry.name += " (" + std::string(text_.usingDefault) + ")";
      }
      result.push_back(std::move(entry));
    }
    // A preference that no longer enumerates at all must still be visible.
    if (preference && std::none_of(devices.begin(), devices.end(), [&](const MenuEntry& device) {
          return device.id == *preference;
        })) {
      result.push_back({*preference, *preference + " (" + std::string(text_.usingDefault) + ")", true});
    }
    return result;
  }

  const Strings& text_;
  Link link_ = Link::connecting;
  std::string serverName_;
  std::vector<MenuEntry> channels_;
  std::optional<std::string> channelId_;
  bool mediaConnected_ = false;
  bool muted_ = false;
  bool deafened_ = false;
  bool serverMuted_ = false;
  bool serverDeafened_ = false;
  bool permissionMuted_ = false;
  bool microphoneRefused_ = false;
  bool microphonePending_ = false;
  std::vector<MenuEntry> inputs_;
  std::vector<MenuEntry> outputs_;
  std::optional<std::string> inputPreference_;
  std::optional<std::string> outputPreference_;
  std::optional<std::string> unavailableInput_;
  std::optional<std::string> unavailableOutput_;
  std::optional<std::string> alert_;
  bool refreshDevices_ = false;
  std::string selfSession_;
  bool pushToTalk_ = false;
  std::optional<std::string> pushToTalkKey_;
  std::vector<Person> members_;
  std::set<std::string> speakers_;
};

}  // namespace monky::light::ui
