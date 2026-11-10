#include "standalone.hpp"

#include <deque>
#include <filesystem>
#include <iostream>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace {

using monky::light::Connection;
using monky::light::ConnectionIssue;
using monky::light::ProfileSettings;
using monky::light::StandaloneHooks;

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

// The profile, the window and the core, recorded instead of shown or started.
struct Fake {
  std::optional<ProfileSettings> stored = ProfileSettings{};
  std::vector<ProfileSettings> saves;
  std::deque<std::optional<Connection>> answers;
  std::vector<std::pair<Connection, std::optional<ConnectionIssue>>> asked;
  std::vector<std::string> unavailable;
  struct Run {
    std::vector<std::string> arguments;
    std::optional<std::string> password;
  };
  std::vector<Run> runs;
  // What each run asks before quitting: a server refusal code, or nothing for
  // "change server". Runs beyond the list just quit.
  std::deque<std::optional<std::string>> again;

  StandaloneHooks hooks() {
    StandaloneHooks result;
    result.profile = std::filesystem::path(u8"/perfil/Monky Light/Profile-á");
    result.load = [this](const std::filesystem::path&) {
      if (!stored) throw std::runtime_error("profile locked by another Monky Light");
      return *stored;
    };
    result.save = [this](const std::filesystem::path&, const ProfileSettings& settings) {
      saves.push_back(settings);
      stored = settings;
    };
    result.ask = [this](const Connection& current, std::optional<ConnectionIssue> issue) {
      asked.push_back({current, issue});
      if (answers.empty()) throw std::runtime_error("The window was asked more often than expected");
      auto answer = std::move(answers.front());
      answers.pop_front();
      return answer;
    };
    result.profileUnavailable = [this](const std::string& detail) { unavailable.push_back(detail); };
    result.run = [this](std::vector<std::string> arguments, std::optional<std::string> password,
                        std::function<void(std::optional<std::string>)> askAgain) {
      runs.push_back({std::move(arguments), std::move(password)});
      if (again.empty()) return 0;
      askAgain(std::move(again.front()));
      again.pop_front();
      return 1;
    };
    return result;
  }
};

std::string argument(const std::vector<std::string>& arguments, const char* flag) {
  for (std::size_t index = 0; index + 1 < arguments.size(); ++index) {
    if (arguments[index] == flag) return arguments[index + 1];
  }
  throw std::runtime_error("A core argument is missing");
}

void firstStartAsksAndRemembersWithoutThePassword() {
  Fake fake;
  fake.answers.push_back(Connection{"", "Ana", std::nullopt});
  fake.answers.push_back(Connection{"monky://#~Aw", " ", std::nullopt});
  fake.answers.push_back(Connection{"  monky://#~Aw  ", "  Ana  ", std::string("segredo")});
  require(monky::light::runStandalone(fake.hooks()) == 0, "A normal quit must end with success");
  require(fake.asked.size() == 3, "Each refused answer must reopen the window");
  require(!fake.asked[0].second, "The first window shows no issue");
  require(fake.asked[1].second == ConnectionIssue::missingServer, "An empty server must be explained");
  require(fake.asked[2].second == ConnectionIssue::missingNickname, "A blank nickname must be explained");
  require(fake.asked[2].first.server == "monky://#~Aw", "A refused answer must stay in the window");
  require(fake.saves.size() == 1, "Only an accepted connection is saved");
  require(fake.saves[0].server == std::optional<std::string>("ws://localhost:3000"),
          "An invitation must be saved as its server address only");
  require(fake.saves[0].nickname == std::optional<std::string>("Ana"), "The nickname is saved trimmed");
  require(fake.runs.size() == 1, "The core runs once");
  const auto& run = fake.runs[0];
  require(argument(run.arguments, "--server") == "monky://#~Aw",
          "The first start passes the invitation, so its key and password are used");
  require(argument(run.arguments, "--nickname") == "Ana", "The core gets the trimmed nickname");
  const auto profile = fake.hooks().profile.u8string();
  require(argument(run.arguments, "--profile") == std::string(profile.begin(), profile.end()),
          "The profile path must reach the core as UTF-8");
  require(run.arguments.front() == "--tray", "Without a console the tray is the only interface");
  require(run.password == std::optional<std::string>("segredo"), "The typed password reaches the core in memory");
}

void laterStartsReuseTheSavedServer() {
  Fake fake;
  ProfileSettings saved;
  saved.server = "ws://10.0.0.2:8080";
  saved.nickname = "Bia";
  fake.stored = saved;
  require(monky::light::runStandalone(fake.hooks()) == 0, "A saved connection must start directly");
  require(fake.asked.empty() && fake.saves.empty(), "A saved connection must not open the window");
  require(argument(fake.runs.at(0).arguments, "--server") == "ws://10.0.0.2:8080", "The saved server is used");
  require(!fake.runs.at(0).password, "No password is ever read back from the profile");
}

void changingServerReopensTheWindowWithoutTheOldPassword() {
  Fake fake;
  fake.again.push_back(std::nullopt);
  fake.answers.push_back(Connection{"ws://a.example:1", "Ana", std::string("velha")});
  fake.answers.push_back(Connection{"wss://b.example:443", "Ana", std::nullopt});
  require(monky::light::runStandalone(fake.hooks()) == 0, "Changing server must not end the application");
  require(fake.runs.size() == 2, "The core must start again on the new server");
  require(fake.asked.size() == 2 && fake.asked[1].first.server == "ws://a.example:1",
          "The window reopens filled with the current server");
  require(!fake.asked[1].first.password, "The previous password is never offered again");
  require(argument(fake.runs[1].arguments, "--server") == "wss://b.example:443", "The new server is used");
  require(fake.stored->server == std::optional<std::string>("wss://b.example:443"), "The new server is saved");
}

void aRefusedPasswordReopensTheWindowOnThatField() {
  Fake fake;
  ProfileSettings saved;
  saved.server = "ws://casa.example:8080";
  saved.nickname = "Ana";
  fake.stored = saved;
  fake.again.push_back(std::string("AUTH_INVALID_PASSWORD"));
  fake.again.push_back(std::string("NICKNAME_ALREADY_EXISTS"));
  fake.answers.push_back(Connection{"ws://casa.example:8080", "Ana", std::string("certa")});
  fake.answers.push_back(Connection{"ws://casa.example:8080", "Ana 2", std::string("certa")});
  require(monky::light::runStandalone(fake.hooks()) == 0, "A fixed connection must end normally");
  require(fake.runs.size() == 3 && !fake.runs[0].password, "The saved connection starts without a password");
  require(fake.asked.size() == 2 && fake.asked[0].second == ConnectionIssue::wrongPassword,
          "A refused password must reopen the window with the reason");
  require(fake.asked[0].first.server == "ws://casa.example:8080" && !fake.asked[0].first.password,
          "The window keeps the server and does not offer the refused password");
  require(fake.runs[1].password == std::optional<std::string>("certa"), "The new password is used");
  require(fake.asked[1].second == ConnectionIssue::nicknameTaken && fake.asked[1].first.nickname == "Ana",
          "A taken nickname must be explained with the typed nickname kept");
  require(argument(fake.runs[2].arguments, "--nickname") == "Ana 2", "The new nickname is used");
  require(fake.stored->nickname == std::optional<std::string>("Ana 2"), "The accepted nickname is saved");
  require(monky::light::refusalIssue("AUTH_FAILED") == std::nullopt,
          "Only refusals the window can fix reopen it");
}

void cancellingOrALockedProfileEndsTheStart() {
  Fake cancelled;
  cancelled.answers.push_back(std::nullopt);
  require(monky::light::runStandalone(cancelled.hooks()) == 0 && cancelled.runs.empty(),
          "Cancelling the window quits without starting the core");
  Fake locked;
  locked.stored.reset();
  require(monky::light::runStandalone(locked.hooks()) == 1 && locked.runs.empty() && locked.unavailable.size() == 1,
          "A profile held by another Light must be reported, not replaced");
}

void connectionsAreCheckedLikeTheCore() {
  using monky::light::checkConnection;
  require(checkConnection({"http://host:1", "Ana", std::nullopt}) == ConnectionIssue::invalidServer,
          "Only ws:// and wss:// addresses are servers");
  require(checkConnection({"monky://#~not-an-invite", "Ana", std::nullopt}) == ConnectionIssue::invalidServer,
          "A broken invitation must be refused in the window");
  require(!checkConnection({"wss://host:443", "Ana", std::nullopt}), "A secure address is accepted");
  require(!checkConnection({"ws://host:1", std::string(32, 'a'), std::nullopt}), "32 units is the limit");
  require(checkConnection({"ws://host:1", std::string(33, 'a'), std::nullopt}) == ConnectionIssue::nicknameTooLong,
          "Longer nicknames are refused like the server would");
  // An emoji is one code point but two UTF-16 units, as the server counts it.
  std::string emojis;
  for (int index = 0; index < 16; ++index) emojis += "\xF0\x9F\x90\x92";
  require(!checkConnection({"ws://host:1", emojis, std::nullopt}), "16 emoji are 32 units");
  require(checkConnection({"ws://host:1", emojis + "a", std::nullopt}) == ConnectionIssue::nicknameTooLong,
          "Emoji count as two units each");
}

}  // namespace

int main() {
  try {
    firstStartAsksAndRemembersWithoutThePassword();
    laterStartsReuseTheSavedServer();
    changingServerReopensTheWindowWithoutTheOldPassword();
    aRefusedPasswordReopensTheWindowOnThatField();
    cancellingOrALockedProfileEndsTheStart();
    connectionsAreCheckedLikeTheCore();
    std::cout << "Standalone start scenarios passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
