#include "headless_application.hpp"
#include "platform/utf8.hpp"
#include "profile_identity.hpp"
#include "standalone.hpp"
#include "ui/connect.hpp"
#include "ui/startup.hpp"
#include "ui/tray.hpp"

#include <api/audio/create_audio_device_module.h>
#include <api/environment/environment_factory.h>
#ifdef _WIN32
#include <modules/audio_device/include/audio_device_factory.h>
#include <rtc_base/win/scoped_com_initializer.h>
#endif

#include <algorithm>
#include <cstdlib>
#include <filesystem>
#include <functional>
#include <iostream>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace {

webrtc::scoped_refptr<webrtc::AudioDeviceModule> createAudioDevice(const webrtc::Environment& environment) {
#ifdef _WIN32
  return webrtc::CreateWindowsCoreAudioAudioDeviceModule(&environment.task_queue_factory());
#else
  return webrtc::CreateAudioDeviceModule(environment, webrtc::AudioDeviceModule::kPlatformDefaultAudio);
#endif
}

monky::light::media::AudioDeviceList enumerateAudioDevices() {
#ifdef _WIN32
  // Declared before the ADM so the apartment outlives every COM object it owns.
  webrtc::ScopedCOMInitializer apartment(webrtc::ScopedCOMInitializer::kMTA);
  if (!apartment.Succeeded()) throw std::runtime_error("Could not enter the COM apartment for audio");
#endif
  const auto environment = webrtc::CreateEnvironment();
  const auto device = createAudioDevice(environment);
  if (!device || device->Init() != 0) throw std::runtime_error("Could not initialize the audio device module");
  auto result = monky::light::media::EnumerateDevices(*device);
  if (device->Terminate() != 0) throw std::runtime_error("Could not release the audio device module");
  return result;
}

monky::light::HeadlessConfiguration configuration() {
  monky::light::HeadlessConfiguration audio;
  audio.create = [](const webrtc::Environment& environment) {
#ifdef _WIN32
    // Core Audio must be created and used on an MTA thread. The apartment lives
    // until the WebRTC worker exits, after the engine has released the ADM.
    thread_local webrtc::ScopedCOMInitializer apartment(webrtc::ScopedCOMInitializer::kMTA);
    if (!apartment.Succeeded()) throw std::runtime_error("Could not enter the COM apartment for audio");
#endif
    return createAudioDevice(environment);
  };
  audio.enumerateDevices = enumerateAudioDevices;
  audio.watchDevices = monky::light::watchAudioDevices;
  audio.createInterface = [](monky::light::CoreCommands core) {
    return monky::light::ui::createTray(std::move(core), monky::light::ui::systemLanguage());
  };
#ifdef __APPLE__
  audio.requestMicrophoneAccess = monky::light::requestMicrophoneAccess;
#endif
  return audio;
}

std::optional<std::filesystem::path> profileOverride() {
#ifdef _WIN32
  wchar_t* value = nullptr;
  std::size_t length = 0;
  if (_wdupenv_s(&value, &length, L"MONKY_LIGHT_PROFILE") != 0 || !value) return std::nullopt;
  std::filesystem::path result(value);
  std::free(value);
#else
  const auto* value = std::getenv("MONKY_LIGHT_PROFILE");
  if (!value) return std::nullopt;
  std::filesystem::path result(value);
#endif
  if (!result.is_absolute()) throw std::invalid_argument("MONKY_LIGHT_PROFILE must be an absolute path");
  return result;
}

// Opened like an application (a double click, Finder, a shortcut): no command
// line, no console reader, the tray as the only interface.
int runApplication() {
  namespace ui = monky::light::ui;
  const auto language = ui::systemLanguage();
#ifdef _WIN32
  // A double click gives the program a console of its own; hide it. One shared
  // with a terminal that started the program is left alone.
  DWORD processes[2]{};
  if (GetConsoleProcessList(processes, 2) == 1) FreeConsole();
#endif
  monky::light::StandaloneHooks hooks;
  // A build started with a development or QA profile must not register itself
  // to open at sign-in, where it would use the real profile instead.
  bool developmentProfile = false;
  try {
    // Development and QA point this elsewhere, never at the installed profile.
    const auto override = profileOverride();
    developmentProfile = override.has_value();
    hooks.profile = override ? *override : ui::defaultProfileDirectory();
    // The profile creates only its own folder; the one above is the Light's.
    std::filesystem::create_directories(hooks.profile.parent_path());
  } catch (const std::exception& error) {
    ui::showProfileUnavailable(error.what(), language);
    return 1;
  }
  hooks.load = [](const std::filesystem::path& profile) {
    monky::light::ProfileIdentity identity(profile);
    try {
      return identity.loadSettings();
    } catch (const std::exception&) {
      // Unreadable settings are only preferences; the core reports and replaces them.
      return monky::light::ProfileSettings{};
    }
  };
  hooks.save = [](const std::filesystem::path& profile, const monky::light::ProfileSettings& settings) {
    monky::light::ProfileIdentity identity(profile);
    identity.saveSettings(settings);
  };
  hooks.ask = [language](const monky::light::Connection& current, std::optional<monky::light::ConnectionIssue> issue) {
    return ui::askConnection(current, issue, language);
  };
  hooks.profileUnavailable = [language](const std::string& detail) { ui::showProfileUnavailable(detail, language); };
  hooks.run = [developmentProfile, language](std::vector<std::string> arguments, std::optional<std::string> password,
                                             std::function<void(std::optional<std::string>)> askAgain) {
    auto audio = configuration();
    if (!developmentProfile) {
      audio.createInterface = [language](monky::light::CoreCommands core) {
        return ui::createTray(std::move(core), language, ui::systemStartup());
      };
    }
    audio.console = false;
    audio.password = std::move(password);
    audio.askAgain = std::move(askAgain);
    return monky::light::runHeadless(std::move(arguments), std::move(audio));
  };
  return monky::light::runStandalone(hooks);
}

int run(std::vector<std::string> arguments) {
#ifdef __APPLE__
  // Older macOS versions pass a process serial number to applications Finder opens.
  std::erase_if(arguments, [](const std::string& value) { return value.starts_with("-psn_"); });
#endif
  if (arguments.empty()) return runApplication();
  return monky::light::runHeadless(std::move(arguments), configuration());
}

}  // namespace

#ifdef _WIN32
int wmain(int argc, wchar_t* argv[]) {
  try {
    std::vector<std::string> arguments;
    for (int index = 1; index < argc; ++index) {
      arguments.push_back(monky::light::utf8FromWide(argv[index]));
    }
    return run(std::move(arguments));
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 2;
  }
}
#else
int main(int argc, char* argv[]) {
  return run(std::vector<std::string>(argv + 1, argv + argc));
}
#endif
