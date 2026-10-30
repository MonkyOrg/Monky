#include "protocol_reader.hpp"
#include "protocol.hpp"

#include <algorithm>
#include <cctype>

namespace monky::light::reader {
namespace {
namespace msg = monky::protocol::message;

constexpr std::size_t maxSignalBytes = 128 * 1024;

// Stops at the value of the top-level "type", or at the first sign that the
// frame has none. Nothing is built: strings outside that one are not kept.
class TypePeek final : public Json::json_sax_t {
 public:
  std::optional<std::string> type;

  bool null() override { return value(); }
  bool boolean(bool) override { return value(); }
  bool number_integer(number_integer_t) override { return value(); }
  bool number_unsigned(number_unsigned_t) override { return value(); }
  bool number_float(number_float_t, const string_t&) override { return value(); }
  bool string(string_t& found) override {
    if (depth_ == 1 && typeNext_) {
      type = std::move(found);
      return false;
    }
    return value();
  }
  bool binary(binary_t&) override { return value(); }
  bool start_object(std::size_t) override {
    if (!value()) return false;
    ++depth_;
    return true;
  }
  bool key(string_t& name) override {
    typeNext_ = depth_ == 1 && name == "type";
    return true;
  }
  bool end_object() override {
    --depth_;
    return depth_ > 0;
  }
  bool start_array(std::size_t) override {
    // A frame has to be an object; an array at the top has no type.
    if (depth_ == 0 || !value()) return false;
    ++depth_;
    return true;
  }
  bool end_array() override {
    --depth_;
    return true;
  }
  bool parse_error(std::size_t, const std::string&, const Json::exception&) override { return false; }

 private:
  // A value where the type belongs that is not a string ends the search.
  bool value() { return !(depth_ == 1 && typeNext_); }

  unsigned depth_ = 0;
  bool typeNext_ = false;
};
}  // namespace

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

std::optional<bool> optionalBoolean(const Json& object, const char* key) {
  if (!object.is_object() || !object.contains(key)) return std::nullopt;
  return boolean(object, key);
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
  for (const auto& value : array) require(value.is_string(), "Expected string array entry");
}

bool hex(std::string_view value, std::size_t size) {
  return value.size() == size && std::all_of(value.begin(), value.end(), [](unsigned char c) {
    return std::isxdigit(c) != 0;
  });
}

void channel(const Json& value) {
  text(value, "id");
  text(value, "serverId");
  text(value, "name");
  text(value, "type");
}

void voiceState(const Json& value) {
  text(value, "sessionId");
  text(value, "userId");
  text(value, "channelId");
  for (const auto* key : {"isMuted", "isDeafened", "serverMuted", "serverDeafened"}) boolean(value, key);
  optionalBoolean(value, "permissionMuted");
}

Participant participant(const Json& state, const Json* user, const std::string& room) {
  voiceState(state);
  require(text(state, "channelId") == room, "Foreign channel in roster");
  Participant result{text(state, "userId"), text(state, "sessionId"), state, std::nullopt};
  if (user) {
    require(text(*user, "id") == result.userId, "Mismatched roster user");
    // UserSummary.sessionId is optional. VoiceParticipantState.sessionId is not.
    if (user->contains("sessionId"))
      require(text(*user, "sessionId") == result.sessionId, "Mismatched roster session");
    result.user = *user;
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

bool signal(const Json& payload) {
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
  } else if (type == "screen-audio-meta") {
    // Read to keep a screen's sound out of the microphone it may share a peer with.
    text(payload, "streamId");
  } else {
    return false;
  }
  require(payload.dump().size() <= maxSignalBytes, "Signal exceeds native queue limit");
  return true;
}

void sfu(const std::string& type, const Json& payload, const std::string& room,
         const std::map<std::string, Participant>& participants, const Json* request) {
  require(text(payload, "channelId") == room, "Foreign SFU reply channel");
  if (type == msg::SFU_ROUTER_RTP_CAPABILITIES) {
    objectField(payload, "rtpCapabilities");
    arrayField(payload.at("rtpCapabilities"), "codecs");
  } else if (type == msg::SFU_WEBRTC_TRANSPORT_CREATED) {
    const auto direction = text(payload, "direction");
    require(direction == "send" || direction == "recv", "Invalid SFU transport direction");
    if (request) require(direction == text(*request, "direction"), "Foreign transport direction");
    const auto& options = field(payload, "transportOptions");
    text(options, "id");
    objectField(options, "iceParameters");
    arrayField(options, "iceCandidates");
    objectField(options, "dtlsParameters");
    if (options.contains("sctpParameters")) objectField(options, "sctpParameters");
  } else if (type == msg::SFU_WEBRTC_TRANSPORT_CONNECTED) {
    const auto transport = text(payload, "transportId");
    if (request) require(transport == text(*request, "transportId"), "Foreign transport reply");
  } else if (type == msg::SFU_PRODUCED) {
    text(payload, "id");
  } else if (type == msg::SFU_PRODUCERS_LIST) {
    arrayField(payload, "producers");
    const auto listed = roster(field(payload, "participants"), room);
    for (const auto& producer : payload.at("producers")) {
      sfu(std::string(msg::SFU_NEW_PRODUCER), producer, room, listed, nullptr);
      require(listed.count(text(producer, "producerSessionId")) != 0, "Unknown producer session");
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
      require(participants.count(session) != 0, "Unknown consumed peer");
    }
    if (request) require(producer == text(*request, "producerId"), "Foreign producer reply");
  } else if (type == msg::SFU_PRODUCER_CLOSED) {
    const auto producer = text(payload, "producerId");
    if (request) require(producer == text(*request, "producerId"), "Foreign closed producer");
  } else if (type == msg::SFU_CONSUMER_CLOSED) {
    text(payload, "consumerId");
  }
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

bool discardable(std::string_view frame) {
  TypePeek peek;
  (void)Json::sax_parse(frame.begin(), frame.end(), &peek);
  return peek.type && !relevant(*peek.type);
}

}  // namespace monky::light::reader
