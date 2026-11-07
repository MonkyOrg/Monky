#pragma once

#include "standalone.hpp"
#include "ui/tray_strings.hpp"

#include <filesystem>
#include <optional>
#include <string>

namespace monky::light::ui {

// Main thread only, while no core runs: the window has its own modal loop.
// Returns nullopt when the user cancels or closes it.
std::optional<Connection> askConnection(const Connection& current, std::optional<ConnectionIssue> issue,
                                        Language language);

// A blocking notice for a start that cannot go on, with the system's detail.
void showProfileUnavailable(const std::string& detail, Language language);

// The profile of an application start, apart from any development profile:
// %LOCALAPPDATA%\Monky Light\Profile or ~/Library/Application Support/Monky Light/Profile.
std::filesystem::path defaultProfileDirectory();

// The field an issue is about, so the window can focus it.
enum class Field { server, nickname, password };

inline Field fieldFor(std::optional<ConnectionIssue> issue, const Connection& current) {
  if (!issue) return current.server.empty() ? Field::server : Field::nickname;
  switch (*issue) {
    case ConnectionIssue::missingServer:
    case ConnectionIssue::invalidServer: return Field::server;
    case ConnectionIssue::wrongPassword: return Field::password;
    case ConnectionIssue::missingNickname:
    case ConnectionIssue::nicknameTooLong:
    case ConnectionIssue::nicknameTaken:
    case ConnectionIssue::nicknameRefused: return Field::nickname;
  }
  return Field::server;
}

inline const char* issueText(ConnectionIssue issue, const Strings& text) {
  switch (issue) {
    case ConnectionIssue::missingServer: return text.missingServer;
    case ConnectionIssue::invalidServer: return text.invalidServer;
    case ConnectionIssue::missingNickname: return text.missingNickname;
    case ConnectionIssue::nicknameTooLong: return text.nicknameTooLong;
    case ConnectionIssue::wrongPassword: return text.wrongPassword;
    case ConnectionIssue::nicknameTaken: return text.nicknameTaken;
    case ConnectionIssue::nicknameRefused: return text.nicknameRefused;
  }
  return text.invalidServer;
}

}  // namespace monky::light::ui
