#pragma once

#include <api/audio/audio_device.h>

#include <array>
#include <optional>
#include <string>
#include <vector>

namespace monky::light::media {

struct AudioDeviceInfo {
  // Stable platform identifier (Core Audio endpoint ID). An ADM that exposes no
  // identifier is represented by its name, which is less stable across drivers.
  std::string id;
  std::string name;
};

struct AudioDeviceList {
  std::vector<AudioDeviceInfo> inputs;
  std::vector<AudioDeviceInfo> outputs;
};

// nullopt follows the operating system default device.
struct AudioDevicePreference {
  std::optional<std::string> input;
  std::optional<std::string> output;
};

struct AudioDeviceSelection {
  std::optional<std::string> requested;
  // Empty id/name: the operating system default device is in use.
  std::string id;
  std::string name;
  // A requested device was unavailable, so the default device is in use.
  bool fallback = false;
};

enum class AudioDirection { input, output };

namespace detail {

// Windows Core Audio (kWindowsCoreAudio2) lists the logical default and
// communications devices, with the IDs of their current endpoints, before the
// physical endpoints. They are selected through the default path instead.
inline int LogicalDefaults(const webrtc::AudioDeviceModule &adm) {
  webrtc::AudioDeviceModule::AudioLayer layer{};
  return adm.ActiveAudioLayer(&layer) == 0 &&
                 layer == webrtc::AudioDeviceModule::kWindowsCoreAudio2
             ? 2
             : 0;
}

inline std::optional<AudioDeviceInfo> DeviceAt(webrtc::AudioDeviceModule &adm,
                                               AudioDirection direction,
                                               uint16_t index) {
  std::array<char, webrtc::kAdmMaxDeviceNameSize> name{};
  std::array<char, webrtc::kAdmMaxGuidSize> guid{};
  const auto result =
      direction == AudioDirection::input
          ? adm.RecordingDeviceName(index, name.data(), guid.data())
          : adm.PlayoutDeviceName(index, name.data(), guid.data());
  name.back() = '\0';
  guid.back() = '\0';
  if (result != 0 || name[0] == '\0')
    return std::nullopt;
  AudioDeviceInfo device{guid[0] ? guid.data() : name.data(), name.data()};
  // macOS names its logical default entry "default (<device>)".
  if (device.name.starts_with("default ("))
    return std::nullopt;
  return device;
}

} // namespace detail

inline int DeviceCount(webrtc::AudioDeviceModule &adm,
                       AudioDirection direction) {
  const auto count = direction == AudioDirection::input
                         ? adm.RecordingDevices()
                         : adm.PlayoutDevices();
  return count < 0 ? 0 : count;
}

// Physical devices only; requires an initialized ADM. Callers must serialize
// this with the ADM's own thread requirements.
inline std::vector<AudioDeviceInfo>
EnumerateDevices(webrtc::AudioDeviceModule &adm, AudioDirection direction) {
  std::vector<AudioDeviceInfo> result;
  const auto count = DeviceCount(adm, direction);
  for (int index = detail::LogicalDefaults(adm); index < count; ++index) {
    if (auto device =
            detail::DeviceAt(adm, direction, static_cast<uint16_t>(index)))
      result.push_back(std::move(*device));
  }
  return result;
}

inline AudioDeviceList EnumerateDevices(webrtc::AudioDeviceModule &adm) {
  return {EnumerateDevices(adm, AudioDirection::input),
          EnumerateDevices(adm, AudioDirection::output)};
}

// Index of a listed physical device, or nullopt when it is not present.
inline std::optional<uint16_t> FindDevice(webrtc::AudioDeviceModule &adm,
                                          AudioDirection direction,
                                          const std::string &id,
                                          std::string *name) {
  const auto count = DeviceCount(adm, direction);
  for (int index = detail::LogicalDefaults(adm); index < count; ++index) {
    auto device =
        detail::DeviceAt(adm, direction, static_cast<uint16_t>(index));
    if (device && device->id == id) {
      if (name)
        *name = std::move(device->name);
      return static_cast<uint16_t>(index);
    }
  }
  return std::nullopt;
}

} // namespace monky::light::media
