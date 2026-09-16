#include "platform/audio_device_watcher.hpp"

#include <CoreAudio/CoreAudio.h>
#include <dispatch/dispatch.h>

#include <array>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <system_error>

namespace monky::light {
namespace {

constexpr std::array<AudioObjectPropertySelector, 3> kSelectors{
    kAudioHardwarePropertyDevices, kAudioHardwarePropertyDefaultInputDevice,
    kAudioHardwarePropertyDefaultOutputDevice};

AudioObjectPropertyAddress address(AudioObjectPropertySelector selector) {
  return {selector, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
}

struct Watcher final {
  std::mutex mutex;
  bool active = true;
  AudioDevicesChanged changed;
  dispatch_queue_t queue = nil;
  AudioObjectPropertyListenerBlock listener = nil;
  std::size_t registered = 0;

  void stop() {
    for (std::size_t index = 0; index < registered; ++index) {
      const auto property = address(kSelectors[index]);
      AudioObjectRemovePropertyListenerBlock(kAudioObjectSystemObject, &property, queue, listener);
    }
    registered = 0;
    // Drain a listener already running on the private serial queue.
    dispatch_sync(queue, ^{});
    std::lock_guard lock(mutex);
    active = false;
  }
};

}  // namespace

StopWatchingAudioDevices watchAudioDevices(AudioDevicesChanged changed) {
  if (!changed) throw std::invalid_argument("Audio device watcher requires a callback");
  auto watcher = std::make_shared<Watcher>();
  watcher->changed = std::move(changed);
  watcher->queue = dispatch_queue_create("org.monky.light.audio-devices", DISPATCH_QUEUE_SERIAL);
  if (!watcher->queue) throw std::runtime_error("Could not create the audio device notification queue");
  std::weak_ptr<Watcher> weak = watcher;
  watcher->listener = ^(UInt32, const AudioObjectPropertyAddress*) {
    auto state = weak.lock();
    if (!state) return;
    std::lock_guard lock(state->mutex);
    if (!state->active) return;
    try {
      state->changed();
    } catch (...) {
      // The next notification retries; exceptions must not unwind into Core Audio.
    }
  };
  for (const auto selector : kSelectors) {
    const auto property = address(selector);
    if (const auto status = AudioObjectAddPropertyListenerBlock(kAudioObjectSystemObject, &property,
                                                                watcher->queue, watcher->listener);
        status != noErr) {
      watcher->stop();
      throw std::system_error(static_cast<int>(status), std::generic_category(),
                              "Register audio device notifications");
    }
    ++watcher->registered;
  }
  return [watcher]() mutable {
    if (!watcher) return;
    watcher->stop();
    watcher.reset();
  };
}

}  // namespace monky::light
