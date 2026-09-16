#include "headless_application.hpp"
#include "platform/utf8.hpp"

#include <api/audio/create_audio_device_module.h>

#include <iostream>

namespace {

int run(std::vector<std::string> arguments) {
  monky::light::HeadlessConfiguration audio;
  audio.create = [](const webrtc::Environment& environment) {
    return webrtc::CreateAudioDeviceModule(environment, webrtc::AudioDeviceModule::kPlatformDefaultAudio);
  };
#ifdef __APPLE__
  audio.requestMicrophoneAccess = monky::light::requestMicrophoneAccess;
#endif
  return monky::light::runHeadless(std::move(arguments), std::move(audio));
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
