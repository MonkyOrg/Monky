#pragma once

#include "media/voice_engine.hpp"
#include "platform/microphone_access.hpp"

#include <functional>
#include <optional>
#include <string>
#include <vector>

namespace monky::light {

struct HeadlessConfiguration {
  decltype(media::Callbacks::create_audio_device) create;
  std::function<nlohmann::json()> diagnostics;
  media::AudioPolicy processing;
  std::optional<int> networkIgnoreMask;
  RequestMicrophoneAccess requestMicrophoneAccess;
};

int runHeadless(std::vector<std::string> arguments, HeadlessConfiguration configuration);

}  // namespace monky::light
