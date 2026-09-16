#include "fixture_audio_device.hpp"
#include "headless_application.hpp"
#include "platform/utf8.hpp"

#include <rtc_base/network_constants.h>

#include <algorithm>
#include <atomic>
#include <iostream>
#include <iterator>
#include <memory>
#include <mutex>
#include <stdexcept>

namespace {

using monky::light::test::FixtureAudioDevice;

struct Devices {
  std::mutex mutex;
  std::vector<webrtc::scoped_refptr<FixtureAudioDevice>> values;

  nlohmann::json snapshot() {
    std::lock_guard lock(mutex);
    auto current = values.empty() ? FixtureAudioDevice::Counters{} : values.back()->Snapshot();
    const auto running = std::count_if(values.begin(), values.end(), [](const auto& value) {
      return value->Snapshot().worker_running;
    });
    return {{"synthetic", true}, {"createdDevices", values.size()}, {"runningDevices", running},
            {"recording", !values.empty() && values.back()->Recording()},
            {"playing", !values.empty() && values.back()->Playing()},
            {"recordingCallbacks", current.recording_callbacks}, {"playoutCallbacks", current.playout_callbacks},
            {"recordedSamples", current.recorded_samples}, {"playoutSamples", current.playout_samples},
            {"nonzeroPlayoutCallbacks", current.nonzero_playout_callbacks},
            {"recordingErrors", current.recording_errors}, {"playoutErrors", current.playout_errors},
            {"inputEnergy", current.input_energy}, {"outputEnergy", current.output_energy},
            {"outputRms", current.output_rms}, {"workerRunning", current.worker_running}};
  }
};

int run(std::vector<std::string> arguments) {
  const auto devices = std::make_shared<Devices>();
  const auto permissionRequests = std::make_shared<std::atomic<unsigned>>(0);
  monky::light::HeadlessConfiguration audio;
  const auto processing = std::find(arguments.begin(), arguments.end(), "--fixture-default-processing");
  const bool defaultProcessing = processing != arguments.end();
  if (defaultProcessing) arguments.erase(processing);
  const auto permission = std::find(arguments.begin(), arguments.end(), "--fixture-microphone-access");
  if (permission != arguments.end()) {
    if (std::next(permission) == arguments.end()) throw std::invalid_argument("Missing fixture permission state");
    const auto state = *std::next(permission);
    if (state != "granted" && state != "denied" && state != "restricted" && state != "pending") {
      throw std::invalid_argument("Unknown fixture permission state");
    }
    arguments.erase(permission, std::next(permission, 2));
    audio.requestMicrophoneAccess = [state, permissionRequests](monky::light::MicrophoneAccessCallback callback) {
      ++*permissionRequests;
      if (state == "pending") {
        return monky::light::CancelMicrophoneAccess([callback = std::move(callback)]() mutable { callback = {}; });
      }
      callback(state == "granted" ? monky::light::MicrophoneAccess::granted :
          state == "restricted" ? monky::light::MicrophoneAccess::restricted : monky::light::MicrophoneAccess::denied);
      return monky::light::CancelMicrophoneAccess{};
    };
  }
  audio.create = [devices](const webrtc::Environment&) -> webrtc::scoped_refptr<webrtc::AudioDeviceModule> {
    const auto device = FixtureAudioDevice::Create();
    std::lock_guard lock(devices->mutex);
    devices->values.push_back(device);
    return device;
  };
  audio.diagnostics = [devices, permissionRequests] {
    auto result = devices->snapshot();
    result["permissionRequests"] = permissionRequests->load();
    return result;
  };
  if (!defaultProcessing) {
    audio.processing.echo_cancellation = false;
    audio.processing.automatic_gain = false;
    audio.processing.noise_suppression = monky::light::media::NoiseSuppression::off;
  }
  audio.networkIgnoreMask = ~static_cast<int>(webrtc::ADAPTER_TYPE_LOOPBACK);
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
