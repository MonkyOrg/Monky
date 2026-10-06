#pragma once

#include <api/audio/audio_device.h>
#include <api/scoped_refptr.h>

#include <cstddef>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace monky::light::test {

// Test-only endpoint list shared by the synthetic ADMs of one process, so a
// scenario can add or remove "devices". Every entry plays the same synthetic
// tone and sink; only the reported names and selection change.
class FixtureDeviceCatalog {
 public:
  struct Device {
    std::string id;
    std::string name;
  };

  FixtureDeviceCatalog();
  // Each direction needs at least one device; the first is the system default.
  void Set(std::vector<Device> inputs, std::vector<Device> outputs);
  std::vector<Device> Inputs() const;
  std::vector<Device> Outputs() const;

 private:
  mutable std::mutex mutex_;
  std::vector<Device> inputs_;
  std::vector<Device> outputs_;
};

// Test-only PCM source/sink. This device never accesses OS audio APIs.
// Keep the transport alive until RegisterAudioCallback(nullptr) or Terminate()
// returns. Both synchronously drain callbacks before releasing the borrowed
// transport. Init/Start/Stop/Terminate/RegisterAudioCallback must run outside
// AudioTransport callbacks; reentrant calls return -1. Queries and volume APIs
// are callback-safe. Stop retains direction initialization for a later restart.
// The last ADM reference must also be released outside its transport callbacks.
// Device indexes select catalog entries; index 0 and Windows default-device
// selectors mean its first entry, never the operating system's default device.
class FixtureAudioDevice : public webrtc::AudioDeviceModule {
 public:
  static constexpr std::uint32_t kSampleRate = 48000;
  static constexpr std::size_t kChannels = 1;
  static constexpr std::size_t kSamplesPerFrame = 480;

  struct Counters {
    std::uint64_t recording_callbacks = 0;
    std::uint64_t playout_callbacks = 0;
    std::uint64_t recorded_samples = 0;
    std::uint64_t playout_samples = 0;
    std::uint64_t nonzero_playout_callbacks = 0;
    std::uint64_t recording_errors = 0;
    std::uint64_t playout_errors = 0;
    std::uint64_t discarded_clock_frames = 0;
    // Cumulative sum of squared samples normalized to [-1, 1].
    double input_energy = 0;
    double output_energy = 0;
    double output_rms = 0;  // Cumulative normalized RMS of successful sink PCM.
    double waiting_ms = 0;
    double processing_ms = 0;
    bool worker_running = false;
    std::string selected_input;
    std::string selected_output;
  };

  // Allocation errors propagate; callers must not fall back to a physical ADM.
  static webrtc::scoped_refptr<FixtureAudioDevice> Create(
      std::shared_ptr<const FixtureDeviceCatalog> catalog = nullptr);
  explicit FixtureAudioDevice(std::shared_ptr<const FixtureDeviceCatalog> catalog = nullptr);
  Counters Snapshot() const;

  int32_t ActiveAudioLayer(AudioLayer* layer) const override;
  int32_t RegisterAudioCallback(webrtc::AudioTransport* callback) override;
  int32_t Init() override;
  int32_t Terminate() override;
  bool Initialized() const override;
  int16_t PlayoutDevices() override;
  int16_t RecordingDevices() override;
  int32_t PlayoutDeviceName(uint16_t index, char* name, char* guid) override;
  int32_t RecordingDeviceName(uint16_t index, char* name, char* guid) override;
  int32_t SetPlayoutDevice(uint16_t index) override;
  int32_t SetPlayoutDevice(WindowsDeviceType device) override;
  int32_t SetRecordingDevice(uint16_t index) override;
  int32_t SetRecordingDevice(WindowsDeviceType device) override;
  int32_t PlayoutIsAvailable(bool* available) override;
  int32_t InitPlayout() override;
  bool PlayoutIsInitialized() const override;
  int32_t RecordingIsAvailable(bool* available) override;
  int32_t InitRecording() override;
  bool RecordingIsInitialized() const override;
  int32_t StartPlayout() override;
  int32_t StopPlayout() override;
  bool Playing() const override;
  int32_t StartRecording() override;
  int32_t StopRecording() override;
  bool Recording() const override;
  int32_t InitSpeaker() override;
  bool SpeakerIsInitialized() const override;
  int32_t InitMicrophone() override;
  bool MicrophoneIsInitialized() const override;
  int32_t SpeakerVolumeIsAvailable(bool* available) override;
  int32_t SetSpeakerVolume(uint32_t volume) override;
  int32_t SpeakerVolume(uint32_t* volume) const override;
  int32_t MaxSpeakerVolume(uint32_t* volume) const override;
  int32_t MinSpeakerVolume(uint32_t* volume) const override;
  int32_t MicrophoneVolumeIsAvailable(bool* available) override;
  int32_t SetMicrophoneVolume(uint32_t volume) override;
  int32_t MicrophoneVolume(uint32_t* volume) const override;
  int32_t MaxMicrophoneVolume(uint32_t* volume) const override;
  int32_t MinMicrophoneVolume(uint32_t* volume) const override;
  int32_t SpeakerMuteIsAvailable(bool* available) override;
  int32_t SetSpeakerMute(bool enable) override;
  int32_t SpeakerMute(bool* enabled) const override;
  int32_t MicrophoneMuteIsAvailable(bool* available) override;
  int32_t SetMicrophoneMute(bool enable) override;
  int32_t MicrophoneMute(bool* enabled) const override;
  int32_t StereoPlayoutIsAvailable(bool* available) const override;
  int32_t SetStereoPlayout(bool enable) override;
  int32_t StereoPlayout(bool* enabled) const override;
  int32_t StereoRecordingIsAvailable(bool* available) const override;
  int32_t SetStereoRecording(bool enable) override;
  int32_t StereoRecording(bool* enabled) const override;
  int32_t PlayoutDelay(uint16_t* delay_ms) const override;
  bool BuiltInAECIsAvailable() const override;
  bool BuiltInAGCIsAvailable() const override;
  bool BuiltInNSIsAvailable() const override;
  int32_t EnableBuiltInAEC(bool enable) override;
  int32_t EnableBuiltInAGC(bool enable) override;
  int32_t EnableBuiltInNS(bool enable) override;

 protected:
  ~FixtureAudioDevice() override;

 private:
  struct State;
  std::unique_ptr<State> state_;
  std::shared_ptr<const FixtureDeviceCatalog> catalog_;
};

}  // namespace monky::light::test
