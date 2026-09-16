#include "headless_application.hpp"
#include "platform/utf8.hpp"

#include <api/audio/create_audio_device_module.h>
#include <api/environment/environment_factory.h>
#ifdef _WIN32
#include <modules/audio_device/include/audio_device_factory.h>
#include <rtc_base/win/scoped_com_initializer.h>
#endif

#include <iostream>
#include <stdexcept>

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

int run(std::vector<std::string> arguments) {
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
