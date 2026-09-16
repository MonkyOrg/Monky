#pragma once

#include <api/audio/audio_device.h>
#include <api/scoped_refptr.h>
#include <stdexcept>

namespace monky::light::media {

// WebRTC can request StartRecording again when a transceiver changes. Gate the
// native ADM itself, not just track.enabled, so mute cannot reopen the device.
// All calls, including SetPolicy, are serialized on the WebRTC worker.
class PolicyAudioDevice : public webrtc::AudioDeviceModule {
public:
  explicit PolicyAudioDevice(
      webrtc::scoped_refptr<webrtc::AudioDeviceModule> native)
      : native_(std::move(native)) {
    if (!native_)
      throw std::runtime_error("Audio device factory returned null");
  }

  int SetPolicy(bool capture, bool playout) {
    capture_allowed_ = capture;
    playout_allowed_ = playout;
    int result = 0;
    if (!capture && native_->StopRecording() != 0)
      result = -1;
    if (!playout && native_->StopPlayout() != 0)
      result = -1;
    if (result != 0)
      return result;
    if (capture && capture_requested_ && !native_->Recording()) {
      if ((!native_->RecordingIsInitialized() &&
           native_->InitRecording() != 0) ||
          native_->StartRecording() != 0)
        return -1;
    }
    if (playout && playout_requested_ && !native_->Playing()) {
      if ((!native_->PlayoutIsInitialized() && native_->InitPlayout() != 0) ||
          native_->StartPlayout() != 0)
        return -1;
    }
    return 0;
  }

  int32_t InitRecording() override {
    return capture_allowed_ ? native_->InitRecording() : 0;
  }
  int32_t StartRecording() override {
    capture_requested_ = true;
    if (!capture_allowed_)
      return 0;
    if (!native_->RecordingIsInitialized() && native_->InitRecording() != 0)
      return -1;
    return native_->StartRecording();
  }
  int32_t StopRecording() override {
    capture_requested_ = false;
    return native_->StopRecording();
  }
  int32_t InitPlayout() override {
    return playout_allowed_ ? native_->InitPlayout() : 0;
  }
  int32_t StartPlayout() override {
    playout_requested_ = true;
    if (!playout_allowed_)
      return 0;
    if (!native_->PlayoutIsInitialized() && native_->InitPlayout() != 0)
      return -1;
    return native_->StartPlayout();
  }
  int32_t StopPlayout() override {
    playout_requested_ = false;
    return native_->StopPlayout();
  }

#define MONKY_ADM_FORWARD(result, name, parameters, arguments)                 \
  result name parameters override { return native_->name arguments; }
#define MONKY_ADM_CONST(result, name, parameters, arguments)                   \
  result name parameters const override { return native_->name arguments; }
  MONKY_ADM_CONST(int32_t, ActiveAudioLayer, (AudioLayer * layer), (layer))
  MONKY_ADM_FORWARD(int32_t, RegisterAudioCallback,
                    (webrtc::AudioTransport * callback), (callback))
  MONKY_ADM_FORWARD(int32_t, Init, (), ())
  MONKY_ADM_FORWARD(int32_t, Terminate, (), ())
  MONKY_ADM_CONST(bool, Initialized, (), ())
  MONKY_ADM_FORWARD(int16_t, PlayoutDevices, (), ())
  MONKY_ADM_FORWARD(int16_t, RecordingDevices, (), ())
  MONKY_ADM_FORWARD(int32_t, PlayoutDeviceName,
                    (uint16_t index, char *name, char *guid),
                    (index, name, guid))
  MONKY_ADM_FORWARD(int32_t, RecordingDeviceName,
                    (uint16_t index, char *name, char *guid),
                    (index, name, guid))
  MONKY_ADM_FORWARD(int32_t, SetPlayoutDevice, (uint16_t index), (index))
  MONKY_ADM_FORWARD(int32_t, SetPlayoutDevice, (WindowsDeviceType type), (type))
  MONKY_ADM_FORWARD(int32_t, SetRecordingDevice, (uint16_t index), (index))
  MONKY_ADM_FORWARD(int32_t, SetRecordingDevice, (WindowsDeviceType type),
                    (type))
  MONKY_ADM_FORWARD(int32_t, PlayoutIsAvailable, (bool *available), (available))
  MONKY_ADM_FORWARD(int32_t, RecordingIsAvailable, (bool *available),
                    (available))
  MONKY_ADM_CONST(bool, PlayoutIsInitialized, (), ())
  MONKY_ADM_CONST(bool, RecordingIsInitialized, (), ())
  MONKY_ADM_CONST(bool, Playing, (), ())
  MONKY_ADM_CONST(bool, Recording, (), ())
  MONKY_ADM_FORWARD(int32_t, InitSpeaker, (), ())
  MONKY_ADM_CONST(bool, SpeakerIsInitialized, (), ())
  MONKY_ADM_FORWARD(int32_t, InitMicrophone, (), ())
  MONKY_ADM_CONST(bool, MicrophoneIsInitialized, (), ())
  MONKY_ADM_FORWARD(int32_t, SpeakerVolumeIsAvailable, (bool *value), (value))
  MONKY_ADM_FORWARD(int32_t, SetSpeakerVolume, (uint32_t value), (value))
  MONKY_ADM_CONST(int32_t, SpeakerVolume, (uint32_t *value), (value))
  MONKY_ADM_CONST(int32_t, MaxSpeakerVolume, (uint32_t *value), (value))
  MONKY_ADM_CONST(int32_t, MinSpeakerVolume, (uint32_t *value), (value))
  MONKY_ADM_FORWARD(int32_t, MicrophoneVolumeIsAvailable, (bool *value),
                    (value))
  MONKY_ADM_FORWARD(int32_t, SetMicrophoneVolume, (uint32_t value), (value))
  MONKY_ADM_CONST(int32_t, MicrophoneVolume, (uint32_t *value), (value))
  MONKY_ADM_CONST(int32_t, MaxMicrophoneVolume, (uint32_t *value), (value))
  MONKY_ADM_CONST(int32_t, MinMicrophoneVolume, (uint32_t *value), (value))
  MONKY_ADM_FORWARD(int32_t, SpeakerMuteIsAvailable, (bool *value), (value))
  MONKY_ADM_FORWARD(int32_t, SetSpeakerMute, (bool value), (value))
  MONKY_ADM_CONST(int32_t, SpeakerMute, (bool *value), (value))
  MONKY_ADM_FORWARD(int32_t, MicrophoneMuteIsAvailable, (bool *value), (value))
  MONKY_ADM_FORWARD(int32_t, SetMicrophoneMute, (bool value), (value))
  MONKY_ADM_CONST(int32_t, MicrophoneMute, (bool *value), (value))
  MONKY_ADM_CONST(int32_t, StereoPlayoutIsAvailable, (bool *value), (value))
  MONKY_ADM_FORWARD(int32_t, SetStereoPlayout, (bool value), (value))
  MONKY_ADM_CONST(int32_t, StereoPlayout, (bool *value), (value))
  MONKY_ADM_CONST(int32_t, StereoRecordingIsAvailable, (bool *value), (value))
  MONKY_ADM_FORWARD(int32_t, SetStereoRecording, (bool value), (value))
  MONKY_ADM_CONST(int32_t, StereoRecording, (bool *value), (value))
  MONKY_ADM_CONST(int32_t, PlayoutDelay, (uint16_t *value), (value))
  MONKY_ADM_CONST(bool, BuiltInAECIsAvailable, (), ())
  MONKY_ADM_CONST(bool, BuiltInAGCIsAvailable, (), ())
  MONKY_ADM_CONST(bool, BuiltInNSIsAvailable, (), ())
  MONKY_ADM_FORWARD(int32_t, EnableBuiltInAEC, (bool value), (value))
  MONKY_ADM_FORWARD(int32_t, EnableBuiltInAGC, (bool value), (value))
  MONKY_ADM_FORWARD(int32_t, EnableBuiltInNS, (bool value), (value))
  MONKY_ADM_CONST(int32_t, GetPlayoutUnderrunCount, (), ())
  MONKY_ADM_CONST(std::optional<Stats>, GetStats, (), ())
#undef MONKY_ADM_FORWARD
#undef MONKY_ADM_CONST

protected:
  ~PolicyAudioDevice() override = default;

private:
  webrtc::scoped_refptr<webrtc::AudioDeviceModule> native_;
  bool capture_allowed_ = false;
  bool playout_allowed_ = false;
  bool capture_requested_ = false;
  bool playout_requested_ = false;
};

} // namespace monky::light::media
