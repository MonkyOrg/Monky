#pragma once

#include "pcm_normalizer.h"
#include "api\notifier.h"

#include <atomic>
#include <mutex>

namespace monky::native_rtc::engine::audio {

class CaptureBlockObserver {
 public:
  virtual ~CaptureBlockObserver() = default;
  // Borrowed spans/samples, valid only during this call. Copy bounded metadata
  // if needed. This is observation, not permission to invent an RTC timestamp.
  virtual void OnBlock(const NormalizedBlock& block,
                       std::optional<RtcCaptureTimestamp> timestamp,
                       bool delivery_enabled) noexcept = 0;
};

// Construct with webrtc::make_ref_counted<PcmTrackSource>. Control/observer
// registration is signaling-thread confined. Push runs on one capture worker;
// RemoveSink/SetEnabled fence synchronous SDK sink delivery before returning.
// The mapper and observer owners must outlive this source and cannot reenter it.
class PcmTrackSource : public webrtc::Notifier<webrtc::AudioSourceInterface> {
 public:
  PcmTrackSource(CaptureTimestampMapper& mapper, CaptureBlockObserver& observer)
      : mapper_(mapper), observer_(observer) {}
  void BeginEpoch(const CaptureEpoch& epoch);
  void Push(const CapturePacketView& packet);
  void SetEnabled(bool enabled);
  void End();
  NormalizerSnapshot Snapshot() const;

  SourceState state() const override { return state_.load(); }
  bool remote() const override { return false; }
  const webrtc::AudioOptions options() const override;
  void AddSink(webrtc::AudioTrackSinkInterface* sink) override;
  void RemoveSink(webrtc::AudioTrackSinkInterface* sink) override;

 protected:
  ~PcmTrackSource() override = default;

 private:
  void Deliver(const NormalizedBlock& block);
  CaptureTimestampMapper& mapper_;
  CaptureBlockObserver& observer_;
  mutable std::mutex processing_mutex_;
  std::mutex delivery_mutex_;
  PcmNormalizer normalizer_;
  std::vector<webrtc::AudioTrackSinkInterface*> sinks_;
  std::atomic<SourceState> state_{kInitializing};
  bool enabled_ = false;
  std::optional<std::int64_t> last_rtc_capture_ms_;
};

}  // namespace monky::native_rtc::engine::audio
