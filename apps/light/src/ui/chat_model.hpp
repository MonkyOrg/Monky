#pragma once

#include "ui/tray_model.hpp"
#include "ui/tray_strings.hpp"

#include <json.hpp>

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <ctime>
#include <optional>
#include <set>
#include <string>
#include <utility>
#include <vector>

namespace monky::light::ui {

// One message as the window shows it: already formatted, keyed for updates.
struct ChatLine {
  std::string id;
  std::string text;
};

// What changed for the window after an event, so it redraws only that.
enum class ChatChange { none, channels, reset, appended, replaced };

// The platform-free half of the chat window. It keeps only the open channel's
// messages (bounded), correlates history answers by the command ID it chose,
// and formats every line, so platform code only appends or replaces text.
class ChatModel final {
 public:
  // Oldest messages are let go beyond this; the window is a reader, not an archive.
  static constexpr std::size_t kMaxMessages = 500;

  explicit ChatModel(Language language = Language::english) : text_(textFor(language)) {}

  ChatChange apply(const Json& event) {
    if (!event.is_object()) return ChatChange::none;
    const auto name = stringAt(event, "event");
    if (name == "authenticated" || name == "channels-changed") {
      applyChannels(event);
      return ChatChange::channels;
    }
    if (name == "chat-history") return applyHistory(event);
    if (name == "chat-message") return applyMessage(event, false);
    if (name == "chat-message-updated") return applyMessage(event, true);
    if (name == "command-error") {
      const auto id = stringAt(event, "id");
      if (id.empty() || (id != historyRequest_ && !sendRequests_.contains(id))) return ChatChange::none;
      if (id == historyRequest_) historyRequest_.clear();
      sendRequests_.erase(id);
      alert_ = stringAt(event, "detail");
      return ChatChange::none;
    }
    if (name == "chat-sent") {
      sendRequests_.erase(stringAt(event, "id"));
      return ChatChange::none;
    }
    if (name == "disconnected" || name == "stopped") {
      // Answers to requests of the lost connection never come.
      historyRequest_.clear();
      sendRequests_.clear();
    }
    return ChatChange::none;
  }

  // Commands, each with the ID its answer will carry.
  Json open(const std::string& channelId) {
    channel_ = channelId;
    messages_.clear();
    exhausted_ = false;
    olderRequest_ = false;
    changed_.reset();
    historyRequest_ = nextId("history");
    return {{"command", "chat-history"}, {"id", historyRequest_}, {"channelId", channelId}};
  }

  // Nothing while a page is on its way or when the channel has no older messages.
  std::optional<Json> older() {
    if (!channel_ || !historyRequest_.empty() || exhausted_ || messages_.empty()) return std::nullopt;
    historyRequest_ = nextId("history");
    olderRequest_ = true;
    return Json{{"command", "chat-history"}, {"id", historyRequest_}, {"channelId", *channel_},
                {"before", messages_.front().at("createdAt")}};
  }

  std::optional<Json> send(const std::string& content) {
    if (!channel_ || content.find_first_not_of(" \t\r\n") == std::string::npos) return std::nullopt;
    const auto id = nextId("send");
    sendRequests_.insert(id);
    return Json{{"command", "chat-send"}, {"id", id}, {"channelId", *channel_}, {"content", content}};
  }

  // The window closed: the messages are released and reading stops.
  Json close() {
    channel_.reset();
    messages_.clear();
    historyRequest_.clear();
    return {{"command", "chat-watch"}, {"enabled", false}};
  }

  const std::vector<MenuEntry>& channels() const { return channels_; }
  const std::optional<std::string>& channel() const { return channel_; }
  bool loading() const { return !historyRequest_.empty(); }
  bool canLoadOlder() const { return channel_ && historyRequest_.empty() && !exhausted_ && !messages_.empty(); }

  std::vector<ChatLine> lines() const {
    std::vector<ChatLine> result;
    result.reserve(messages_.size());
    for (const auto& message : messages_) result.push_back(line(message));
    return result;
  }
  // The line of the last appended or replaced message.
  std::optional<ChatLine> lastChanged() const { return changed_; }

  std::optional<std::string> takeAlert() { return std::exchange(alert_, std::nullopt); }

 private:
  static std::string stringAt(const Json& value, const char* key) {
    const auto found = value.find(key);
    return found != value.end() && found->is_string() ? found->get<std::string>() : std::string();
  }

  std::string nextId(const char* kind) { return std::string("chat-") + kind + "-" + std::to_string(++serial_); }

  void applyChannels(const Json& event) {
    const auto found = event.find("channels");
    if (found == event.end() || !found->is_array()) return;
    std::vector<std::pair<double, MenuEntry>> ordered;
    for (const auto& value : *found) {
      if (!value.is_object() || stringAt(value, "type") != "TEXT") continue;
      auto id = stringAt(value, "id");
      auto name = stringAt(value, "name");
      if (id.empty() || name.empty()) continue;
      const auto position = value.find("position");
      ordered.push_back({position != value.end() && position->is_number() ? position->get<double>() : 0.0,
                         MenuEntry{std::move(id), std::move(name), false}});
    }
    std::stable_sort(ordered.begin(), ordered.end(),
                     [](const auto& left, const auto& right) { return left.first < right.first; });
    channels_.clear();
    for (auto& entry : ordered) channels_.push_back(std::move(entry.second));
    for (auto& entry : channels_) entry.selected = channel_ && *channel_ == entry.id;
  }

  ChatChange applyHistory(const Json& event) {
    // Only the answer to the latest request: switching channels makes older ones stale.
    if (historyRequest_.empty() || stringAt(event, "id") != historyRequest_) return ChatChange::none;
    historyRequest_.clear();
    const bool older = std::exchange(olderRequest_, false);
    const auto found = event.find("messages");
    std::vector<Json> page;
    if (found != event.end() && found->is_array()) {
      for (const auto& message : *found) {
        if (message.is_object() && message.contains("id") && message.contains("createdAt")) page.push_back(message);
      }
    }
    if (older && page.empty()) exhausted_ = true;
    // The page ends where the previous one started; a message sent meanwhile
    // may also be in both, so known IDs are skipped.
    std::vector<Json> merged;
    merged.reserve(page.size() + messages_.size());
    for (auto& message : page) {
      if (!find(stringAt(message, "id"))) merged.push_back(std::move(message));
    }
    for (auto& message : messages_) merged.push_back(std::move(message));
    messages_ = std::move(merged);
    trim();
    return ChatChange::reset;
  }

  ChatChange applyMessage(const Json& event, bool update) {
    const auto found = event.find("message");
    if (found == event.end() || !found->is_object()) return ChatChange::none;
    const auto& message = *found;
    if (!channel_ || stringAt(message, "channelId") != *channel_) return ChatChange::none;
    const auto id = stringAt(message, "id");
    if (auto* known = find(id)) {
      *known = message;
      changed_ = line(message);
      return ChatChange::replaced;
    }
    // An update for a message outside the loaded window changes nothing shown.
    if (update) return ChatChange::none;
    messages_.push_back(message);
    trim();
    changed_ = line(message);
    return ChatChange::appended;
  }

  Json* find(const std::string& id) {
    const auto found = std::find_if(messages_.begin(), messages_.end(),
                                    [&](const Json& message) { return stringAt(message, "id") == id; });
    return found == messages_.end() ? nullptr : &*found;
  }

  void trim() {
    if (messages_.size() > kMaxMessages) {
      messages_.erase(messages_.begin(), messages_.begin() + static_cast<std::ptrdiff_t>(messages_.size() - kMaxMessages));
    }
  }

  static std::string clock(const Json& message) {
    const auto found = message.find("createdAt");
    if (found == message.end() || !found->is_number()) return "--:--";
    const auto seconds = static_cast<std::time_t>(found->get<double>() / 1000.0);
    std::tm local{};
#ifdef _WIN32
    if (localtime_s(&local, &seconds) != 0) return "--:--";
#else
    if (!localtime_r(&seconds, &local)) return "--:--";
#endif
    char buffer[8]{};
    std::strftime(buffer, sizeof(buffer), "%H:%M", &local);
    return buffer;
  }

  ChatLine line(const Json& message) const {
    std::string result = "[" + clock(message) + "] ";
    auto author = stringAt(message, "author");
    if (author.empty()) author = text_.participant;
    result += author;
    if (message.value("isBot", false)) result += " [bot]";
    result += ": ";
    if (const auto reply = message.find("reply"); reply != message.end() && reply->is_object()) {
      auto quoted = stringAt(*reply, "content");
      if (quoted.size() > 60) quoted = quoted.substr(0, 57) + "...";
      result += "(" + std::string(text_.replyingTo) + " " + stringAt(*reply, "userNickname") + ": " + quoted + ") ";
    }
    if (message.value("forwarded", false)) result += "(" + std::string(text_.forwarded) + ") ";
    if (message.contains("deletedAt")) {
      result += "(" + std::string(text_.messageDeleted) + ")";
    } else {
      result += stringAt(message, "content");
      if (const auto files = message.find("attachments"); files != message.end() && files->is_array()) {
        for (const auto& file : *files) {
          if (file.is_string()) result += " [" + std::string(text_.attachment) + ": " + file.get<std::string>() + "]";
        }
      }
      if (message.contains("editedAt")) result += " (" + std::string(text_.edited) + ")";
    }
    return {stringAt(message, "id"), std::move(result)};
  }

  const Strings& text_;
  std::vector<MenuEntry> channels_;
  std::optional<std::string> channel_;
  std::vector<Json> messages_;
  std::string historyRequest_;
  bool olderRequest_ = false;
  bool exhausted_ = false;
  std::set<std::string> sendRequests_;
  std::optional<ChatLine> changed_;
  std::optional<std::string> alert_;
  unsigned serial_ = 0;
};

}  // namespace monky::light::ui
