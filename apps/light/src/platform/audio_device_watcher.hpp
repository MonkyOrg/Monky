#pragma once

#include <functional>

namespace monky::light {

using AudioDevicesChanged = std::function<void()>;
using StopWatchingAudioDevices = std::function<void()>;

// Event-driven notification of added, removed, disabled or default-changed
// audio endpoints. The callback runs on an operating system thread and must
// return promptly. The returned function stops callbacks before returning and
// must not be called from inside the callback.
StopWatchingAudioDevices watchAudioDevices(AudioDevicesChanged changed);

}  // namespace monky::light
