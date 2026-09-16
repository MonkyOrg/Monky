#include "fixture_audio_device.hpp"
#include "fixture_audio_clock.hpp"

#include <api/make_ref_counted.h>

#include <array>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstring>
#include <iostream>
#include <mutex>
#include <numbers>
#include <stdexcept>
#include <thread>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <mmsystem.h>
#endif

namespace monky::light::test {
namespace {

thread_local const void* callback_device = nullptr;

class FixtureTimerResolution final {
 public:
  FixtureTimerResolution() {
#ifdef _WIN32
    if (timeBeginPeriod(1) != TIMERR_NOERROR) {
      throw std::runtime_error("Unable to obtain the synthetic audio timer resolution");
    }
#endif
  }
  ~FixtureTimerResolution() {
#ifdef _WIN32
    if (timeEndPeriod(1) != TIMERR_NOERROR) {
      std::cerr << "Unable to release the synthetic audio timer resolution\n";
    }
#endif
  }
  FixtureTimerResolution(const FixtureTimerResolution&) = delete;
  FixtureTimerResolution& operator=(const FixtureTimerResolution&) = delete;
};

template <typename T>
int32_t WriteValue(T* output, T value) {
  if (!output) return -1;
  *output = value;
  return 0;
}

template <typename T>
int32_t Unsupported(T* output) {
  if (output) *output = T{};
  return -1;
}

template <std::size_t NameSize, std::size_t GuidSize>
int32_t DeviceName(uint16_t index, char* name, char* guid, const char (&label)[NameSize],
                   const char (&identifier)[GuidSize]) {
  static_assert(NameSize <= webrtc::kAdmMaxDeviceNameSize);
  static_assert(GuidSize <= webrtc::kAdmMaxGuidSize);
  if (name) name[0] = '\0';
  if (guid) guid[0] = '\0';
  if (index != 0 || !name) return -1;
  std::memcpy(name, label, NameSize);
  if (guid) std::memcpy(guid, identifier, GuidSize);
  return 0;
}

double Energy(const int16_t* samples, std::size_t count) {
  double energy = 0;
  for (std::size_t i = 0; i < count; ++i) {
    const double sample = samples[i] / 32768.0;
    energy += sample * sample;
  }
  return energy;
}

}  // namespace

struct FixtureAudioDevice::State {
  enum class Direction { none, recording, playout };

  State() {
    // 1 kHz, -24 dBFS peak. Ten complete periods make each frame repeatable.
    for (std::size_t i = 0; i < tone.size(); ++i) {
      tone[i] = static_cast<int16_t>(std::lround(
          2048.0 * std::sin(2.0 * std::numbers::pi * static_cast<double>(i % 48) / 48.0)));
    }
    tone_energy = Energy(tone.data(), tone.size());
  }

  bool HasWork() const { return callback && (recording || playing); }
  bool InCallback() const { return callback_device == this; }

  int32_t Start(Direction direction) {
    if (InCallback()) return -1;
    std::lock_guard control(lifecycle);
    std::unique_lock lock(mutex);
    bool& active = direction == Direction::recording ? recording : playing;
    const bool ready = direction == Direction::recording ? recording_initialized
                                                         : playout_initialized;
    if (!initialized || !ready || !callback) return -1;
    if (active) return 0;
    active = true;
    if (!worker.joinable()) {
      shutdown = false;
      counters.worker_running = true;
      try {
        // Windows' coarse default timer otherwise turns 10 ms audio into ~64 Hz.
        auto timer = std::make_unique<FixtureTimerResolution>();
        worker = std::thread([this, timer = std::move(timer)] {
          Run();
        });
      } catch (const std::exception& error) {
        std::cerr << "Unable to start synthetic audio: " << error.what() << '\n';
        active = false;
        shutdown = true;
        lock.unlock();
        if (worker.joinable()) worker.join();
        lock.lock();
        counters.worker_running = false;
        return -1;
      }
    }
    changed.notify_all();
    return 0;
  }

  int32_t Stop(Direction direction) {
    if (InCallback()) return -1;
    std::lock_guard control(lifecycle);
    std::unique_lock lock(mutex);
    (direction == Direction::recording ? recording : playing) = false;
    changed.notify_all();
    changed.wait(lock, [&] { return inflight != direction; });
    if (!recording && !playing) {
      shutdown = true;
      changed.notify_all();
      lock.unlock();
      if (worker.joinable()) worker.join();
    }
    return 0;
  }

  void Process(Direction direction) {
    webrtc::AudioTransport* transport;
    {
      std::lock_guard lock(mutex);
      const bool active = direction == Direction::recording ? recording : playing;
      if (shutdown || !active || !callback) return;
      transport = callback;
      inflight = direction;
    }

    // A lease (inflight) protects the borrowed callback, not a held mutex.
    // Transport code may synchronously query device/volume state.
    callback_device = this;
    int32_t result = -1;
    std::size_t samples_out = 0;
    std::array<int16_t, kSamplesPerFrame> output{};
    try {
      if (direction == Direction::recording) {
        uint32_t new_level = 0;
        result = transport->RecordedDataIsAvailable(
            tone.data(), tone.size(), sizeof(int16_t), kChannels, kSampleRate,
            0, 0, 0, false, new_level);
      } else {
        int64_t elapsed_ms = -1;
        int64_t ntp_ms = -1;
        // Unlike PullRenderData, this preserves WebRTC's AEC render reference.
        result = transport->NeedMorePlayData(
            output.size(), sizeof(int16_t), kChannels, kSampleRate, output.data(),
            samples_out, &elapsed_ms, &ntp_ms);
      }
    } catch (...) {
      result = -1;
    }
    callback_device = nullptr;

    std::lock_guard lock(mutex);
    if (direction == Direction::recording) {
      ++counters.recording_callbacks;
      if (result == 0) {
        counters.recorded_samples += tone.size();
        counters.input_energy += tone_energy;
      } else {
        ++counters.recording_errors;
      }
    } else {
      ++counters.playout_callbacks;
      if (result == 0 && samples_out <= output.size()) {
        const double energy = Energy(output.data(), samples_out);
        counters.playout_samples += samples_out;
        counters.output_energy += energy;
        if (energy > 0) ++counters.nonzero_playout_callbacks;
        counters.output_rms = counters.playout_samples == 0
                                  ? 0
                                  : std::sqrt(counters.output_energy /
                                              static_cast<double>(counters.playout_samples));
      } else {
        ++counters.playout_errors;
      }
    }
    inflight = Direction::none;
    changed.notify_all();
  }

  void Run() {
    std::unique_lock lock(mutex);
    while (!shutdown) {
      changed.wait(lock, [&] { return shutdown || HasWork(); });
      auto deadline = std::chrono::steady_clock::now();
      while (!shutdown && HasWork()) {
        const auto waiting = std::chrono::steady_clock::now();
        changed.wait_until(lock, deadline, [&] { return shutdown || !HasWork(); });
        const auto processing = std::chrono::steady_clock::now();
        counters.waiting_ms += std::chrono::duration<double, std::milli>(processing - waiting).count();
        if (shutdown || !HasWork()) break;
        lock.unlock();
        Process(Direction::playout);
        Process(Direction::recording);
        lock.lock();
        const auto now = std::chrono::steady_clock::now();
        counters.processing_ms += std::chrono::duration<double, std::milli>(now - processing).count();
        // Emulate a bounded device buffer: the sample clock does not slow down
        // with scheduler wakeups, but long stalls must not create unbounded work.
        const auto advanced = AdvanceFixtureAudioDeadline(deadline, now);
        deadline = advanced.next;
        counters.discarded_clock_frames += advanced.discarded_frames;
      }
    }
    counters.worker_running = false;
    changed.notify_all();
  }

  // lifecycle serializes joining/replacing the worker and borrowed transport.
  std::mutex lifecycle;
  mutable std::mutex mutex;
  std::condition_variable changed;
  std::thread worker;
  webrtc::AudioTransport* callback = nullptr;
  Direction inflight = Direction::none;
  bool initialized = false;
  bool playout_initialized = false;
  bool recording_initialized = false;
  bool speaker_initialized = false;
  bool microphone_initialized = false;
  bool playing = false;
  bool recording = false;
  bool shutdown = false;
  std::array<int16_t, kSamplesPerFrame> tone{};
  double tone_energy = 0;
  Counters counters;
};

webrtc::scoped_refptr<FixtureAudioDevice> FixtureAudioDevice::Create() {
  return webrtc::make_ref_counted<FixtureAudioDevice>();
}

FixtureAudioDevice::FixtureAudioDevice() : state_(std::make_unique<State>()) {}
FixtureAudioDevice::~FixtureAudioDevice() { Terminate(); }

FixtureAudioDevice::Counters FixtureAudioDevice::Snapshot() const {
  std::lock_guard lock(state_->mutex);
  return state_->counters;
}

int32_t FixtureAudioDevice::ActiveAudioLayer(AudioLayer* layer) const {
  return WriteValue(layer, kDummyAudio);
}

int32_t FixtureAudioDevice::RegisterAudioCallback(webrtc::AudioTransport* callback) {
  if (state_->InCallback()) return -1;
  std::lock_guard control(state_->lifecycle);
  std::unique_lock lock(state_->mutex);
  state_->callback = nullptr;
  state_->changed.notify_all();
  state_->changed.wait(lock, [&] { return state_->inflight == State::Direction::none; });
  state_->callback = callback;
  state_->changed.notify_all();
  return 0;
}

int32_t FixtureAudioDevice::Init() {
  if (state_->InCallback()) return -1;
  std::lock_guard control(state_->lifecycle);
  std::lock_guard lock(state_->mutex);
  state_->initialized = true;
  return 0;
}

int32_t FixtureAudioDevice::Terminate() {
  if (state_->InCallback()) return -1;
  std::lock_guard control(state_->lifecycle);
  {
    std::lock_guard lock(state_->mutex);
    state_->recording = false;
    state_->playing = false;
    state_->initialized = false;
    state_->recording_initialized = false;
    state_->playout_initialized = false;
    state_->speaker_initialized = false;
    state_->microphone_initialized = false;
    state_->callback = nullptr;
    state_->shutdown = true;
    state_->changed.notify_all();
  }
  if (state_->worker.joinable()) state_->worker.join();
  return 0;
}

bool FixtureAudioDevice::Initialized() const {
  std::lock_guard lock(state_->mutex);
  return state_->initialized;
}

int16_t FixtureAudioDevice::PlayoutDevices() { return 1; }
int16_t FixtureAudioDevice::RecordingDevices() { return 1; }
int32_t FixtureAudioDevice::PlayoutDeviceName(uint16_t index, char* name, char* guid) {
  return DeviceName(index, name, guid, "Monky synthetic PCM sink (test only)",
                    "monky-test-pcm-sink");
}
int32_t FixtureAudioDevice::RecordingDeviceName(uint16_t index, char* name, char* guid) {
  return DeviceName(index, name, guid, "Monky synthetic 1 kHz tone (test only)",
                    "monky-test-tone-source");
}
int32_t FixtureAudioDevice::SetPlayoutDevice(uint16_t index) {
  std::lock_guard lock(state_->mutex);
  return index == 0 && !state_->playing ? 0 : -1;
}
int32_t FixtureAudioDevice::SetRecordingDevice(uint16_t index) {
  std::lock_guard lock(state_->mutex);
  return index == 0 && !state_->recording ? 0 : -1;
}
int32_t FixtureAudioDevice::SetPlayoutDevice(WindowsDeviceType device) {
  // M140's ADM initialization helper selects this logical default on Windows.
  if (device != kDefaultDevice && device != kDefaultCommunicationDevice) return -1;
  return SetPlayoutDevice(uint16_t{0});
}
int32_t FixtureAudioDevice::SetRecordingDevice(WindowsDeviceType device) {
  if (device != kDefaultDevice && device != kDefaultCommunicationDevice) return -1;
  return SetRecordingDevice(uint16_t{0});
}
int32_t FixtureAudioDevice::PlayoutIsAvailable(bool* available) {
  return WriteValue(available, true);
}
int32_t FixtureAudioDevice::RecordingIsAvailable(bool* available) {
  return WriteValue(available, true);
}
int32_t FixtureAudioDevice::InitPlayout() {
  std::lock_guard lock(state_->mutex);
  if (!state_->initialized) return -1;
  state_->playout_initialized = true;
  return 0;
}
int32_t FixtureAudioDevice::InitRecording() {
  std::lock_guard lock(state_->mutex);
  if (!state_->initialized) return -1;
  state_->recording_initialized = true;
  return 0;
}
bool FixtureAudioDevice::PlayoutIsInitialized() const {
  std::lock_guard lock(state_->mutex);
  return state_->playout_initialized;
}
bool FixtureAudioDevice::RecordingIsInitialized() const {
  std::lock_guard lock(state_->mutex);
  return state_->recording_initialized;
}
int32_t FixtureAudioDevice::StartPlayout() { return state_->Start(State::Direction::playout); }
int32_t FixtureAudioDevice::StopPlayout() { return state_->Stop(State::Direction::playout); }
int32_t FixtureAudioDevice::StartRecording() { return state_->Start(State::Direction::recording); }
int32_t FixtureAudioDevice::StopRecording() { return state_->Stop(State::Direction::recording); }
bool FixtureAudioDevice::Playing() const {
  std::lock_guard lock(state_->mutex);
  return state_->playing;
}
bool FixtureAudioDevice::Recording() const {
  std::lock_guard lock(state_->mutex);
  return state_->recording;
}

int32_t FixtureAudioDevice::InitSpeaker() {
  std::lock_guard lock(state_->mutex);
  if (!state_->initialized) return -1;
  state_->speaker_initialized = true;
  return 0;
}
bool FixtureAudioDevice::SpeakerIsInitialized() const {
  std::lock_guard lock(state_->mutex);
  return state_->speaker_initialized;
}
int32_t FixtureAudioDevice::InitMicrophone() {
  std::lock_guard lock(state_->mutex);
  if (!state_->initialized) return -1;
  state_->microphone_initialized = true;
  return 0;
}
bool FixtureAudioDevice::MicrophoneIsInitialized() const {
  std::lock_guard lock(state_->mutex);
  return state_->microphone_initialized;
}
int32_t FixtureAudioDevice::SpeakerVolumeIsAvailable(bool* available) {
  return WriteValue(available, false);
}
int32_t FixtureAudioDevice::SetSpeakerVolume(uint32_t) { return -1; }
int32_t FixtureAudioDevice::SpeakerVolume(uint32_t* volume) const { return Unsupported(volume); }
int32_t FixtureAudioDevice::MaxSpeakerVolume(uint32_t* volume) const { return Unsupported(volume); }
int32_t FixtureAudioDevice::MinSpeakerVolume(uint32_t* volume) const { return Unsupported(volume); }
int32_t FixtureAudioDevice::MicrophoneVolumeIsAvailable(bool* available) {
  return WriteValue(available, false);
}
int32_t FixtureAudioDevice::SetMicrophoneVolume(uint32_t) { return -1; }
int32_t FixtureAudioDevice::MicrophoneVolume(uint32_t* volume) const { return Unsupported(volume); }
int32_t FixtureAudioDevice::MaxMicrophoneVolume(uint32_t* volume) const { return Unsupported(volume); }
int32_t FixtureAudioDevice::MinMicrophoneVolume(uint32_t* volume) const { return Unsupported(volume); }
int32_t FixtureAudioDevice::SpeakerMuteIsAvailable(bool* available) {
  return WriteValue(available, false);
}
int32_t FixtureAudioDevice::SetSpeakerMute(bool) { return -1; }
int32_t FixtureAudioDevice::SpeakerMute(bool* enabled) const { return Unsupported(enabled); }
int32_t FixtureAudioDevice::MicrophoneMuteIsAvailable(bool* available) {
  return WriteValue(available, false);
}
int32_t FixtureAudioDevice::SetMicrophoneMute(bool) { return -1; }
int32_t FixtureAudioDevice::MicrophoneMute(bool* enabled) const { return Unsupported(enabled); }
int32_t FixtureAudioDevice::StereoPlayoutIsAvailable(bool* available) const {
  return WriteValue(available, false);
}
int32_t FixtureAudioDevice::SetStereoPlayout(bool enable) { return enable ? -1 : 0; }
int32_t FixtureAudioDevice::StereoPlayout(bool* enabled) const { return WriteValue(enabled, false); }
int32_t FixtureAudioDevice::StereoRecordingIsAvailable(bool* available) const {
  return WriteValue(available, false);
}
int32_t FixtureAudioDevice::SetStereoRecording(bool enable) { return enable ? -1 : 0; }
int32_t FixtureAudioDevice::StereoRecording(bool* enabled) const { return WriteValue(enabled, false); }
int32_t FixtureAudioDevice::PlayoutDelay(uint16_t* delay_ms) const {
  return WriteValue(delay_ms, uint16_t{0});
}
bool FixtureAudioDevice::BuiltInAECIsAvailable() const { return false; }
bool FixtureAudioDevice::BuiltInAGCIsAvailable() const { return false; }
bool FixtureAudioDevice::BuiltInNSIsAvailable() const { return false; }
int32_t FixtureAudioDevice::EnableBuiltInAEC(bool) { return -1; }
int32_t FixtureAudioDevice::EnableBuiltInAGC(bool) { return -1; }
int32_t FixtureAudioDevice::EnableBuiltInNS(bool) { return -1; }

}  // namespace monky::light::test
