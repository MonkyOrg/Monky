#pragma once

#include <json.hpp>

#include <cstddef>
#include <map>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>

namespace monky::light {

using Json = nlohmann::json;

// One connection in a voice room, as the server's roster lists it (#309).
struct Participant {
  std::string userId;
  std::string sessionId;
  Json voiceState;
  std::optional<Json> user;
};

// How the Light reads what the server sends (Tolerant Reader). A field the Light
// acts on is checked strictly, and a frame that breaks one is malformed.
// Everything else passes unread: fields this client never uses, and the values
// a server adds over time to its lists (channel types, user status, call
// health, signal types). A newer server then never locks an older Light out,
// as a forum channel or a listen-only call in the AFK room once did.
namespace reader {

// The part of the contract this client consumes was broken.
struct Invalid : std::runtime_error {
  explicit Invalid(const char* detail) : std::runtime_error(detail) {}
};

void require(bool condition, const char* detail);
const Json& field(const Json& object, const char* key);
std::string text(const Json& object, const char* key);
bool boolean(const Json& object, const char* key);
// Absent is nullopt; present, it has to be a boolean.
std::optional<bool> optionalBoolean(const Json& object, const char* key);
void number(const Json& object, const char* key);
void objectField(const Json& object, const char* key);
void arrayField(const Json& object, const char* key);
void strings(const Json& array);
bool hex(std::string_view value, std::size_t size);

// Identity, server and name. Every type of channel is listed; only VOICE ones
// are ever joined, so a type this client does not know is no error.
void channel(const Json& value);
// Identity, room and the restrictions the Light obeys. permissionMuted is
// optional: servers from before it existed never send it.
void voiceState(const Json& value);
Participant participant(const Json& voiceState, const Json* user, const std::string& room);
std::map<std::string, Participant> roster(const Json& values, const std::string& room);
Participant joined(const Json& payload);
// The one-use SFU to P2P reconnect grant of a departure or a settings change.
std::string transitionId(const Json& value);
// Validates what this client reads of a WebRTC signal. False for the kinds it
// has no use for (screen metadata and watching, departures, future kinds),
// which are dropped rather than reported.
bool signal(const Json& payload);
// An SFU reply, or announcement, for the call in `room`. `request` is the
// payload of the request it answers, when it answers one.
void sfu(const std::string& type, const Json& payload, const std::string& room,
         const std::map<std::string, Participant>& participants, const Json* request);

// The messages this client acts on; anything else is dropped unread.
bool relevant(std::string_view type);
// True only for a frame whose top-level type was read and is not one this
// client acts on. Reads that type without building the frame, so the
// transport can drop it before it takes room in the event queue. A frame
// without a readable type is kept, to be reported as malformed.
bool discardable(std::string_view frame);

}  // namespace reader
}  // namespace monky::light
