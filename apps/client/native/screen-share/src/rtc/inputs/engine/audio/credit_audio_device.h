#pragma once

#include "audio_types.h"
#include "api\audio\audio_device.h"
#include "system_wrappers\include\clock.h"

#include <mutex>
#include <thread>

namespace monky::native_rtc::engine::audio {

struct PlayoutSnapshot {
  bool initialized = false;
  bool playing = false;
  bool failed = false;
  std::uint64_t epoch = 0;
  std::uint64_t last_grant_sequence = 0;
  std::uint64_t next_packet_sequence = 0;
  std::uint64_t mixed_frame_cursor = 0;
  std::uint32_t credit_frames = 0;
  bool HasOutputEpoch(std::uint64_t expected_epoch = 0) const noexcept {
    return initialized && !failed && epoch && (!expected_epoch || epoch == expected_epoch);
  }
  bool HasPlayableCredits() const noexcept {
    return HasOutputEpoch() && playing && credit_frames >= kBlockFrames;
  }
};

// A real non-platform AudioDeviceModule implementation, not a wrapper around a
// platform/default ADM. Construct with webrtc::make_ref_counted. This component
// creates no worker/timer itself: the owner schedules DrainCredits on ONE native
// playout worker, only when grants arrive. Never call DrainCredits on Node,
// signaling, or an event listener thread. Output/clock/RTC clock outlive the ADM.
class CreditAudioDevice : public webrtc::AudioDeviceModule {
 public:
  CreditAudioDevice(webrtc::Clock& rtc_clock, PhysicalPlayoutClock& clock, PlayoutOutput& output)
      : rtc_clock_(rtc_clock), clock_(clock), output_(output) {}
  void BeginPlayoutEpoch(std::uint64_t epoch);
  void GrantCredits(const PlayoutCredit& grant);
  int32_t EndPlayout(PlayoutOutput::StopReason reason);
  // Drains at most the bounded capacity (four blocks); returns remaining credit
  // frames. The owner must reconcile grants racing its worker-wakeup flag.
  std::uint32_t DrainCredits();
  PlayoutSnapshot Snapshot() const;

  int32_t ActiveAudioLayer(AudioLayer* layer) const override;
  int32_t RegisterAudioCallback(webrtc::AudioTransport* callback) override;
  int32_t Init() override;
  int32_t Terminate() override;
  bool Initialized() const override;
  int16_t PlayoutDevices() override { return 0; }
  int16_t RecordingDevices() override { return 0; }
  int32_t PlayoutDeviceName(uint16_t, char*, char*) override { return -1; }
  int32_t RecordingDeviceName(uint16_t, char*, char*) override { return -1; }
  int32_t SetPlayoutDevice(uint16_t) override { return -1; }
  int32_t SetPlayoutDevice(WindowsDeviceType) override { return -1; }
  int32_t SetRecordingDevice(uint16_t) override { return -1; }
  int32_t SetRecordingDevice(WindowsDeviceType) override { return -1; }
  int32_t PlayoutIsAvailable(bool* available) override;
  int32_t InitPlayout() override;
  bool PlayoutIsInitialized() const override;
  int32_t RecordingIsAvailable(bool* available) override { return Flag(available, false); }
  int32_t InitRecording() override { return -1; }
  bool RecordingIsInitialized() const override { return false; }
  int32_t StartPlayout() override;
  int32_t StopPlayout() override;
  bool Playing() const override;
  int32_t StartRecording() override { return -1; }
  int32_t StopRecording() override { return 0; }
  bool Recording() const override { return false; }
  int32_t InitSpeaker() override;
  bool SpeakerIsInitialized() const override;
  int32_t InitMicrophone() override { return -1; }
  bool MicrophoneIsInitialized() const override { return false; }
  int32_t SpeakerVolumeIsAvailable(bool* available) override { return Flag(available, false); }
  int32_t SetSpeakerVolume(uint32_t) override { return -1; }
  int32_t SpeakerVolume(uint32_t*) const override { return -1; }
  int32_t MaxSpeakerVolume(uint32_t*) const override { return -1; }
  int32_t MinSpeakerVolume(uint32_t*) const override { return -1; }
  int32_t MicrophoneVolumeIsAvailable(bool* available) override { return Flag(available, false); }
  int32_t SetMicrophoneVolume(uint32_t) override { return -1; }
  int32_t MicrophoneVolume(uint32_t*) const override { return -1; }
  int32_t MaxMicrophoneVolume(uint32_t*) const override { return -1; }
  int32_t MinMicrophoneVolume(uint32_t*) const override { return -1; }
  int32_t SpeakerMuteIsAvailable(bool* available) override { return Flag(available, false); }
  int32_t SetSpeakerMute(bool) override { return -1; }
  int32_t SpeakerMute(bool*) const override { return -1; }
  int32_t MicrophoneMuteIsAvailable(bool* available) override { return Flag(available, false); }
  int32_t SetMicrophoneMute(bool) override { return -1; }
  int32_t MicrophoneMute(bool*) const override { return -1; }
  int32_t StereoPlayoutIsAvailable(bool* available) const override { return Flag(available, true); }
  int32_t SetStereoPlayout(bool enable) override { return enable ? 0 : -1; }
  int32_t StereoPlayout(bool* enabled) const override { return Flag(enabled, true); }
  int32_t StereoRecordingIsAvailable(bool* available) const override { return Flag(available, false); }
  int32_t SetStereoRecording(bool enable) override { return enable ? -1 : 0; }
  int32_t StereoRecording(bool* enabled) const override { return Flag(enabled, false); }
  int32_t PlayoutDelay(uint16_t* delay_ms) const override;
  bool BuiltInAECIsAvailable() const override { return false; }
  bool BuiltInAGCIsAvailable() const override { return false; }
  bool BuiltInNSIsAvailable() const override { return false; }
  int32_t EnableBuiltInAEC(bool) override { return -1; }
  int32_t EnableBuiltInAGC(bool) override { return -1; }
  int32_t EnableBuiltInNS(bool) override { return -1; }

 protected:
  ~CreditAudioDevice() override = default;

 private:
  static int32_t Flag(bool* output, bool value) {
    if (!output) return -1;
    *output = value;
    return 0;
  }
  void FailEpoch(std::uint64_t epoch, Failure failure) noexcept;
  webrtc::Clock& rtc_clock_;
  PhysicalPlayoutClock& clock_;
  PlayoutOutput& output_;
  mutable std::mutex state_mutex_;
  std::mutex pump_mutex_;
  webrtc::AudioTransport* transport_ = nullptr;
  std::optional<std::thread::id> playout_thread_;
  PlayoutSnapshot state_;
  std::uint64_t last_epoch_ = 0;
  bool playout_initialized_ = false;
  bool speaker_initialized_ = false;
};

}  // namespace monky::native_rtc::engine::audio
