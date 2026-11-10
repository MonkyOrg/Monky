#pragma once

#include "profile_identity.hpp"

#include <filesystem>
#include <functional>
#include <optional>
#include <string>
#include <vector>

namespace monky::light {

// What the connection window asks for. The password is optional and only
// travels to the core in memory, never into the profile.
struct Connection {
  std::string server;
  std::string nickname;
  std::optional<std::string> password;
};

enum class ConnectionIssue {
  missingServer, invalidServer, missingNickname, nicknameTooLong,
  // Refused by the server; only the window can fix them.
  wrongPassword, nicknameTaken, nicknameRefused
};

// The issue for a server error code the window can fix, or nullopt.
std::optional<ConnectionIssue> refusalIssue(const std::string& code);

// The window refuses what the core would refuse anyway, so the user fixes it
// there instead of reading a failure in the tray. The server stays the
// authority on nicknames: only emptiness and the shared length limit are
// checked here.
std::optional<ConnectionIssue> checkConnection(const Connection& connection);

// The ws(s):// address to remember: an invitation is reduced to its server,
// because its password must not be stored and its key is pinned on first use.
std::string savedServer(const std::string& server);

// Platform pieces of an application start, injected so the flow below can be
// exercised without windows, profiles or a network.
struct StandaloneHooks {
  std::filesystem::path profile;
  // Both throw when the profile cannot be opened, which includes another
  // running Monky Light holding its lock.
  std::function<ProfileSettings(const std::filesystem::path&)> load;
  std::function<void(const std::filesystem::path&, const ProfileSettings&)> save;
  // Shows the window filled with `current` and the issue of the last attempt.
  // Returns nullopt when the user cancels.
  std::function<std::optional<Connection>(const Connection& current, std::optional<ConnectionIssue> issue)> ask;
  // A blocking message, for failures that end the start.
  std::function<void(const std::string& detail)> profileUnavailable;
  // Runs the core with the tray. `askAgain` may be called from any thread
  // before the core stops: with the server's refusal code, or with nothing for
  // the tray's "change server".
  std::function<int(std::vector<std::string> arguments, std::optional<std::string> password,
                    std::function<void(std::optional<std::string> refusal)> askAgain)>
      run;
};

// Opened without a command line: reuses the saved server, or asks for one, and
// runs the core with the tray until it quits for good.
int runStandalone(const StandaloneHooks& hooks);

}  // namespace monky::light
