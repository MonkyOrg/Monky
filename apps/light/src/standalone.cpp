#include "standalone.hpp"

#include "platform/websocket.hpp"
#include "protocol.hpp"
#include "server_invite.hpp"

#include <cstddef>
#include <exception>
#include <mutex>
#include <utility>

namespace monky::light {
namespace {

std::string trimmed(const std::string& value) {
  const auto first = value.find_first_not_of(" \t\r\n");
  if (first == std::string::npos) return {};
  const auto last = value.find_last_not_of(" \t\r\n");
  return value.substr(first, last - first + 1);
}

// The shared limit counts JavaScript string units (UTF-16), as the server does.
std::size_t utf16Length(const std::string& value) {
  std::size_t result = 0;
  for (const auto byte : value) {
    const auto unit = static_cast<unsigned char>(byte);
    if ((unit & 0xC0u) == 0x80u) continue;  // Continuation byte.
    result += unit >= 0xF0u ? 2 : 1;        // Four-byte sequences are surrogate pairs.
  }
  return result;
}

}  // namespace

std::optional<ConnectionIssue> checkConnection(const Connection& connection) {
  const auto server = trimmed(connection.server);
  if (server.empty()) return ConnectionIssue::missingServer;
  try {
    websocket_detail::validateUrl(savedServer(server));
  } catch (const std::exception&) {
    return ConnectionIssue::invalidServer;
  }
  const auto nickname = trimmed(connection.nickname);
  if (nickname.empty()) return ConnectionIssue::missingNickname;
  if (utf16Length(nickname) > static_cast<std::size_t>(protocol::limits::MAX_NICKNAME_LENGTH)) {
    return ConnectionIssue::nicknameTooLong;
  }
  return std::nullopt;
}

std::string savedServer(const std::string& server) {
  const auto value = trimmed(server);
  return looksLikeServerInvite(value) ? parseServerInviteLink(value).serverUrl() : value;
}

std::optional<ConnectionIssue> refusalIssue(const std::string& code) {
  if (code == protocol::error::AUTH_INVALID_PASSWORD) return ConnectionIssue::wrongPassword;
  if (code == protocol::error::NICKNAME_ALREADY_EXISTS) return ConnectionIssue::nicknameTaken;
  if (code == protocol::error::NICKNAME_INVALID) return ConnectionIssue::nicknameRefused;
  return std::nullopt;
}

int runStandalone(const StandaloneHooks& hooks) {
  bool ask = false;
  std::optional<ConnectionIssue> issue;
  std::optional<Connection> previous;
  for (;;) {
    ProfileSettings settings;
    try {
      settings = hooks.load(hooks.profile);
    } catch (const std::exception& error) {
      hooks.profileUnavailable(error.what());
      return 1;
    }
    // A refusal keeps what was typed, so only the refused field needs fixing.
    Connection connection = previous.value_or(Connection{settings.server.value_or(""),
                                                         settings.nickname.value_or(""), std::nullopt});
    if (ask || !settings.server || !settings.nickname) {
      for (;;) {
        auto answer = hooks.ask(connection, issue);
        if (!answer) return 0;
        connection = std::move(*answer);
        issue = checkConnection(connection);
        if (!issue) break;
      }
      connection.server = trimmed(connection.server);
      connection.nickname = trimmed(connection.nickname);
      settings.server = savedServer(connection.server);
      settings.nickname = connection.nickname;
      try {
        hooks.save(hooks.profile, settings);
      } catch (const std::exception& error) {
        hooks.profileUnavailable(error.what());
        return 1;
      }
    }
    // The first start after the window passes the typed text, so an invitation
    // still pins its key and supplies its password; later starts use the
    // saved address, whose key is pinned by then.
    const auto profile = hooks.profile.u8string();
    // Written by the core or interface thread, read once the core has stopped.
    std::mutex mutex;
    bool again = false;
    std::optional<std::string> refusal;
    const auto result = hooks.run({"--tray", "--profile", std::string(profile.begin(), profile.end()),
                                   "--server", connection.server, "--nickname", connection.nickname},
                                  connection.password, [&](std::optional<std::string> code) {
                                    std::lock_guard lock(mutex);
                                    again = true;
                                    refusal = std::move(code);
                                  });
    std::lock_guard lock(mutex);
    if (!again) return result;
    ask = true;
    issue = refusal ? refusalIssue(*refusal) : std::nullopt;
    if (issue) {
      // Retyping the password is the fix, so the refused one is not offered again.
      connection.password.reset();
      previous = std::move(connection);
    } else {
      // Changing server starts from the saved one, without the old password.
      previous.reset();
    }
  }
}

}  // namespace monky::light
