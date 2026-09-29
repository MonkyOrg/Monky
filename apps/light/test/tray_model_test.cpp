#include "ui/tray_controller.hpp"

#include <cstddef>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

using monky::light::ui::Json;
using monky::light::ui::Language;
using monky::light::ui::MenuEntry;
using monky::light::ui::TrayController;
using monky::light::ui::TrayModel;

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

Json channel(std::string id, std::string name, double position, std::string type = "VOICE") {
  return {{"id", std::move(id)}, {"name", std::move(name)}, {"type", std::move(type)},
          {"position", position}, {"serverId", "server"}};
}

Json authenticated() {
  return {{"event", "authenticated"}, {"userId", "user"}, {"sessionId", "user:a"},
          {"serverName", "Casa"}, {"voiceMode", "p2p"},
          {"channels", Json::array({channel("second", "Games", 1), channel("first", "General", 0),
                                    channel("text", "Chat", 0, "TEXT")})}};
}

const MenuEntry& row(const std::vector<MenuEntry>& rows, std::size_t index) {
  if (index >= rows.size()) throw std::runtime_error("The interface is missing a menu row");
  return rows[index];
}

void statusFollowsTheSession() {
  TrayModel model(Language::english);
  require(model.presentation().status == "Connecting…", "A new tray must report connecting");
  require(!model.presentation().connected, "A connecting tray must not look connected");
  require(model.apply(authenticated()), "Authentication must redraw the interface");
  auto view = model.presentation();
  require(view.status == "Connected", "An authenticated session is connected and idle");
  require(view.tooltip == "Monky Light · Casa — Connected", "The tooltip must name the server");
  require(view.connected && !view.inCall, "An idle session is connected without a call");
  require(view.canJoin && !view.canLeave, "An idle session can join but has nothing to leave");

  require(model.apply({{"event", "voice-admitted"}, {"channelId", "first"}}), "Admission must redraw");
  view = model.presentation();
  require(view.status == "Joining the channel…", "Admission alone is not an established call");
  require(!view.inCall, "The icon must not claim a call before the media connects");
  require(view.canLeave, "An admitted session can leave");

  require(model.apply({{"event", "media-connected"}}), "A connected call must redraw");
  view = model.presentation();
  require(view.status == "In a call: General", "An established call names its channel");
  require(view.inCall, "An established call must show the call icon");
  require(row(view.channels, 0).selected, "The joined channel must be marked");

  require(model.apply({{"event", "media-reconnecting"}}), "Media recovery must redraw");
  require(model.presentation().status == "Joining the channel…", "Recovery is not an active call");

  require(model.apply({{"event", "media-connected"}}), "Recovery must redraw once connected");
  require(model.apply({{"event", "voice-left"}}), "Leaving must redraw");
  view = model.presentation();
  require(view.status == "Connected" && !view.canLeave, "Leaving returns the session to idle");

  require(model.apply({{"event", "disconnected"}, {"reconnecting", true}}), "A drop must redraw");
  require(model.presentation().status == "Reconnecting…", "A recoverable drop is reconnecting");
  require(!model.presentation().connected, "A reconnecting session is not connected");
  require(model.apply({{"event", "stopped"}}), "A stopped core must redraw");
  require(model.presentation().status == "Disconnected", "A stopped core is disconnected");
}

void channelsStayInServerOrder() {
  TrayModel model(Language::english);
  model.apply(authenticated());
  auto view = model.presentation();
  require(view.channels.size() == 2, "Only voice channels belong in the interface");
  require(row(view.channels, 0).name == "General" && row(view.channels, 1).name == "Games",
          "Channels must follow their server position, not their arrival order");

  // Creating and deleting channels used to be visible only by polling the state.
  require(model.apply({{"event", "channels-changed"},
                       {"channels", Json::array({channel("third", "Study", 2),
                                                 channel("first", "Lobby", 0)})}}),
          "A channel change must redraw");
  view = model.presentation();
  require(view.channels.size() == 2, "A channel change replaces the whole list");
  require(row(view.channels, 0).name == "Lobby", "A renamed channel must show its new name");
  require(row(view.channels, 1).id == "third", "A created channel must appear");

  model.apply({{"event", "state"},
               {"phase", "ready"},
               {"channelId", nullptr},
               {"mediaActive", false},
               {"channels", Json::array({channel("first", "Lobby", 0)})}});
  require(model.presentation().channels.size() == 1, "A state snapshot also refreshes the list");
}

void serverPolicyOverridesTheControls() {
  TrayModel model(Language::english);
  model.apply(authenticated());
  auto view = model.presentation();
  require(!view.muteChecked && view.muteEnabled, "An unrestricted session controls its microphone");
  require(view.muteLabel == "Mute the microphone", "An unrestricted label carries no note");

  require(model.apply({{"event", "voice-policy"},
                       {"policy", {{"muted", true}, {"deafened", false},
                                   {"serverMuted", false}, {"serverDeafened", false}}}}),
          "A policy change must redraw");
  view = model.presentation();
  require(view.muteChecked && view.muteEnabled, "A self mute stays under the user's control");
  require(view.silenced, "A muted session must show the silenced icon");

  model.apply({{"event", "voice-policy"},
               {"policy", {{"muted", false}, {"deafened", false},
                           {"serverMuted", true}, {"serverDeafened", true}}}});
  view = model.presentation();
  require(view.muteChecked && !view.muteEnabled, "A server mute must not offer to unmute");
  require(view.deafenChecked && !view.deafenEnabled, "A server deafen must not offer to undo it");
  require(view.muteLabel == "Mute the microphone (by the server)", "A forced control says who forced it");
  require(view.deafenLabel == "Deafen (by the server)", "A forced control says who forced it");
}

void deviceRowsKeepThePreference() {
  TrayModel model(Language::english);
  model.apply(authenticated());
  require(model.takeDeviceRefresh(), "A usable session must enumerate the devices once");
  require(!model.takeDeviceRefresh(), "A refresh must only be requested once");
  auto view = model.presentation();
  require(view.inputs.size() == 1 && row(view.inputs, 0).selected,
          "The system default row exists before the first enumeration answers");

  require(model.apply({{"event", "audio-devices"},
                       {"inputs", Json::array({Json{{"id", "mic-a"}, {"name", "Headset"}},
                                               Json{{"id", "mic-b"}, {"name", "Webcam"}}})},
                       {"outputs", Json::array({Json{{"id", "out-a"}, {"name", "Speakers"}}})},
                       {"inputDeviceId", "mic-a"},
                       {"outputDeviceId", nullptr}}),
          "A device list must redraw");
  view = model.presentation();
  require(view.inputs.size() == 3, "The default row precedes the enumerated inputs");
  require(row(view.inputs, 0).name == "System default" && !row(view.inputs, 0).selected,
          "A chosen device clears the default row");
  require(row(view.inputs, 0).id.empty(), "The default row carries no device identifier");
  require(row(view.inputs, 1).selected && row(view.inputs, 1).id == "mic-a",
          "The chosen input must be marked");
  require(row(view.outputs, 0).selected, "An unset output follows the system default");

  // A removed device keeps its preference so the Light returns to it.
  require(model.apply({{"event", "audio-device-selected"},
                       {"detail", "A requested audio device is unavailable"},
                       {"stats", {{"input", {{"requestedId", "mic-a"}, {"id", nullptr},
                                             {"name", nullptr}, {"fallback", true}}},
                                  {"output", {{"requestedId", nullptr}, {"id", nullptr},
                                              {"name", nullptr}, {"fallback", false}}}}}}),
          "A device fallback must redraw");
  view = model.presentation();
  require(row(view.inputs, 1).selected, "A fallback must not drop the preference");
  require(row(view.inputs, 1).name == "Headset (unavailable, using the default)",
          "A fallback must say the device is gone");
  const auto alert = model.takeAlert();
  require(alert && *alert == "A requested audio device is unavailable", "A fallback must be reported");
  require(!model.takeAlert(), "An alert must only be shown once");

  // An unplugged device stops enumerating, and the preference must stay visible.
  model.apply({{"event", "audio-devices"},
               {"inputs", Json::array({Json{{"id", "mic-b"}, {"name", "Webcam"}}})},
               {"outputs", Json::array()},
               {"inputDeviceId", "mic-a"},
               {"outputDeviceId", nullptr}});
  view = model.presentation();
  require(view.inputs.size() == 3, "A preference that no longer enumerates must still be listed");
  require(row(view.inputs, 2).selected && row(view.inputs, 2).id == "mic-a",
          "The absent preference is the marked row");

  require(!model.apply({{"event", "audio-devices-changed"}}),
          "A device notification alone must not redraw; the new list will");
  require(model.takeDeviceRefresh(), "A device notification must ask for a new list");
}

void failuresAndPermissionsReachTheInterface() {
  TrayModel model(Language::english);
  model.apply(authenticated());
  require(!model.apply({{"event", "media-stats"}, {"stats", {{"bytes", 1}}}}),
          "Statistics must not wake the interface thread");
  require(!model.apply({{"event", "command-accepted"}, {"command", "mute"}}),
          "An accepted command must not redraw on its own");

  require(model.apply({{"event", "session-error"}, {"code", "FORBIDDEN"}, {"detail", "Channel is full"}}),
          "A session failure must reach the interface");
  const auto failure = model.takeAlert();
  require(failure && *failure == "Channel is full", "A failure must carry its detail");

  require(model.apply({{"event", "microphone-permission"}, {"state", "requesting"}}),
          "A pending permission must redraw");
  model.apply({{"event", "voice-admitted"}, {"channelId", "first"}});
  require(model.presentation().status == "Waiting for microphone permission…",
          "A pending permission explains why the call is not up yet");

  require(model.apply({{"event", "microphone-permission"}, {"state", "denied"}}),
          "A refused permission must redraw");
  const auto refused = model.takeAlert();
  require(refused && *refused == "Microphone access was refused", "A refusal must be reported");
  model.apply({{"event", "media-connected"}});
  require(model.presentation().status ==
              "In a call: General · Microphone access was refused",
          "A call without a microphone must not look healthy");

  require(model.apply({{"event", "kicked"}, {"type", "ADMIN_KICK"}}), "A removal must reach the interface");
  const auto kicked = model.takeAlert();
  require(kicked && *kicked == "Removed from the channel", "A removal must be named");
}

void portugueseFollowsTheSameStates() {
  TrayModel model(Language::portuguese);
  model.apply(authenticated());
  model.apply({{"event", "voice-admitted"}, {"channelId", "second"}});
  model.apply({{"event", "media-connected"}});
  const auto view = model.presentation();
  require(view.status == "Em chamada: Games", "The Portuguese interface reports the same state");
  require(view.tooltip == "Monky Light · Casa — Em chamada: Games",
          "The tooltip is localized with the status");
  require(row(view.inputs, 0).name == "Padrão do sistema", "The default row is localized");
}

void theControllerSendsConsoleCommands() {
  std::vector<Json> sent;
  bool quit = false;
  TrayController controller({[&](Json value) { sent.push_back(std::move(value)); }, [&] { quit = true; }},
                            Language::english);
  const auto last = [&](const char* name) -> const Json& {
    if (sent.empty()) throw std::runtime_error("The interface sent no command");
    if (sent.back().at("command") != name) throw std::runtime_error("The interface sent the wrong command");
    return sent.back();
  };

  // The interface never asks for the device list itself; the model decides when.
  require(controller.observe(authenticated()), "Authentication must redraw the interface");
  require(sent.size() == 1, "A usable session must enumerate the devices exactly once");
  last("devices");
  require(controller.presentation().status == "Connected", "The controller exposes the model state");

  controller.join("first");
  require(last("join").at("channelId") == "first", "Join must carry the chosen channel");
  controller.leave();
  require(last("leave").size() == 1, "Leave must not carry a channel");
  controller.setMuted(true);
  require(last("mute").at("enabled") == true, "Mute must carry the wanted value");
  controller.setDeafened(false);
  require(last("deafen").at("enabled") == false, "Undeafen must be an explicit false");
  controller.selectInput("mic-a");
  require(last("set-input").at("deviceId") == "mic-a", "A chosen input must carry its identifier");
  controller.selectOutput("");
  require(last("set-output").at("deviceId").is_null(),
          "The default row must clear the preference, not select an empty device");
  controller.reconnect();
  last("reconnect");

  const auto before = sent.size();
  require(!controller.observe({{"event", "media-stats"}, {"stats", Json::object()}}),
          "Statistics must not wake the interface thread");
  require(sent.size() == before, "Statistics must not command the core");
  require(!controller.observe({{"event", "audio-devices-changed"}}),
          "A device notification alone must not redraw; the new list will");
  require(sent.size() == before + 1, "A device notification must ask the core for a new list");
  last("devices");

  require(!quit, "Nothing so far asked the core to stop");
  controller.quit();
  require(quit, "Quit must reach the core");
}

void malformedEventsAreIgnored() {
  TrayModel model(Language::english);
  require(!model.apply(Json::array({1, 2})), "A non-object event must be ignored");
  require(!model.apply(Json::object()), "An event without a name must be ignored");
  require(!model.apply({{"event", "authenticated-later"}}), "An unknown event must be ignored");
  require(model.apply({{"event", "authenticated"}, {"channels", "not-a-list"}}),
          "A malformed channel list must not stop the session from connecting");
  require(model.presentation().channels.empty(), "A malformed channel list yields no rows");
  require(model.presentation().status == "Connected", "A malformed payload keeps the session usable");
}

}  // namespace

int main() {
  try {
    statusFollowsTheSession();
    channelsStayInServerOrder();
    serverPolicyOverridesTheControls();
    deviceRowsKeepThePreference();
    failuresAndPermissionsReachTheInterface();
    portugueseFollowsTheSameStates();
    theControllerSendsConsoleCommands();
    malformedEventsAreIgnored();
    std::cout << "Tray interface scenarios passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
