#pragma once

#include "..\engine_shared.h"
#include "capture_timestamp.h"
#include "credit_audio_device.h"
#include "monky_rtc_audio.h"
#include "output_clock.h"
#include "output_epoch.h"
#include "pcm_track_source.h"

#include <condition_variable>
#include <deque>
#include <future>
#include <set>
#include <tuple>

namespace monky::native_rtc::engine::audio {

CaptureFormat ParseFormat(const Json& data);

class AudioSource final : public CaptureBlockObserver {
 public:
  AudioSource(Host& host, std::uint64_t id, const Json& options);
  ~AudioSource() override = default;
  webrtc::scoped_refptr<webrtc::AudioSourceInterface> TrackSource() const { return source_; }
  std::string SyncGroup() const;
  bool Enabled() const noexcept { return enabled_.load(); }
  void SetEnabled(bool enabled);
  void SetSyncGroup(std::string group);
  void BeginEpoch(const Json& data);
  void ValidateAdmissionEpoch(std::string_view epoch) const;
  void Close();
  void Process(const CapturePacketView& packet);
  Json Snapshot() const;
  void OnBlock(const NormalizedBlock&, std::optional<RtcCaptureTimestamp>, bool) noexcept override;

  const std::uint64_t id;
  const std::string session_id;
  std::atomic<bool> accepting{false};

 private:
  Host& host_;
  mutable std::mutex metadata_mutex_;
  std::string sync_group_;
  std::string capture_epoch_;
  PairedCaptureTimestampMapper mapper_;
  webrtc::scoped_refptr<PcmTrackSource> source_;
  std::atomic<bool> enabled_{false}, closed_{false};
  std::atomic<std::uint64_t> observed_blocks_{0}, timestamped_blocks_{0};
};

class AudioRuntime final : public PlayoutOutput {
 public:
  AudioRuntime(Host& host, webrtc::Clock& clock);
  ~AudioRuntime() override;
  void Start();
  webrtc::scoped_refptr<webrtc::AudioDeviceModule> Adm() const { return adm_; }
  void FenceCapture(const std::shared_ptr<Cancellation>& cancellation);
  void Submit(std::shared_ptr<AudioSource> source, const MonkyEngineAudioPacket& packet);
  Json ConfigureOutput(const Json& data);
  Json StopOutput(const Json& data);
  Json Command(std::string_view command, const Json& data);
  void ReadOutput(std::uint64_t epoch, std::uint64_t sequence, MonkyEngineAudioPlayout& output);
  bool OutputReady(std::uint64_t expected_epoch = 0) const;
  void Stop();
  Json Snapshot() const;
  bool OnPcm(const PlayoutPacket& packet) noexcept override;
  void OnPlayoutStarted(std::uint64_t epoch) noexcept override;
  void OnFailure(std::uint64_t epoch, Failure failure) noexcept override;
  void OnInvalidated(std::uint64_t epoch, PlayoutOutput::StopReason reason) noexcept override;

 private:
  struct Packet {
    std::shared_ptr<AudioSource> source;
    CapturePacketView view;
    std::vector<float> pcm;
  };
  struct Work {
    std::unique_ptr<Packet> packet;
    std::shared_ptr<std::promise<void>> barrier;
  };
  using Key = std::tuple<std::uint64_t, std::string, std::uint64_t>;
  void CaptureLoop() noexcept;
  void PlayoutLoop() noexcept;
  std::int64_t Now() const;
  void InvalidateOutput(std::uint64_t epoch);
  Host& host_;
  webrtc::Clock& rtc_clock_;
  OutputClock clock_;
  webrtc::scoped_refptr<CreditAudioDevice> adm_;
  mutable std::mutex mutex_;
  std::condition_variable wake_capture_, wake_playout_;
  bool stopping_ = false, started_ = false;
  OutputEpoch output_epoch_;
  std::deque<Work> capture_;
  std::set<Key> pending_;
  OutputPackets output_;
  std::thread capture_thread_, playout_thread_;
};

}  // namespace monky::native_rtc::engine::audio
