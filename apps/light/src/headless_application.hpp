#pragma once

#include "media/voice_engine.hpp"
#include "platform/audio_device_watcher.hpp"
#include "platform/microphone_access.hpp"

#include <functional>
#include <optional>
#include <string>
#include <vector>

namespace monky::light {

struct HeadlessConfiguration {
  decltype(media::Callbacks::create_audio_device) create;
  // Runs on a short-lived thread owned by the application, never the app loop.
  std::function<media::AudioDeviceList()> enumerateDevices;
  // Optional event-driven notification; the callback may run on any thread.
  // The returned function must stop callbacks before it returns.
  std::function<StopWatchingAudioDevices(AudioDevicesChanged)> watchDevices;
  // Test executables only: handles commands prefixed with "fixture-".
  std::function<void(const nlohmann::json&)> fixtureCommand;
  std::function<nlohmann::json()> diagnostics;
  media::AudioPolicy processing;
  std::optional<int> networkIgnoreMask;
  RequestMicrophoneAccess requestMicrophoneAccess;
};

int runHeadless(std::vector<std::string> arguments, HeadlessConfiguration configuration);

}  // namespace monky::light
