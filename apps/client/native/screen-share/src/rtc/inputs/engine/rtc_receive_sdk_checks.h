#pragma once

#include <atomic>
#include <barrier>
#include <exception>
#include <thread>

#include "rtc_receive_diagnostics.h"
#include "api\field_trials_view.h"
#include "api\task_queue\task_queue_base.h"
#include "api\video\i420_buffer.h"
#include "modules\video_coding\generic_decoder.h"
#include "modules\video_coding\include\video_coding_defines.h"
#include "modules\video_coding\timing\timing.h"
#include "rtc_base\logging.h"
#include "system_wrappers\include\clock.h"
#include "video\receive_statistics_proxy.h"
#include "video\video_stream_buffer_controller.h"

#include <deque>
#include <memory>
#include <stdexcept>

namespace monky::native_rtc::engine {
namespace rtc_receive_sdk_checks_detail {

class EmptyTrials final : public webrtc::FieldTrialsView {
 public:
  std::string Lookup(absl::string_view) const override { return {}; }
};

// Only installs task-queue TLS. No threads, OS timers, engines or devices.
class ManualQueue final : public webrtc::TaskQueueBase {
 public:
  ~ManualQueue() override {
    CurrentTaskQueueSetter current(this);
    immediate_.clear();
    delayed_.clear();
  }
  void Delete() override { throw std::runtime_error("A stack CPU queue cannot be deleted by the SDK"); }
  template <typename Function>
  void Run(Function&& function) {
    CurrentTaskQueueSetter current(this);
    function();
  }
  void Drain() {
    Run([&] {
      std::size_t count = 0;
      while (!immediate_.empty()) {
        if (++count > 256) throw std::runtime_error("CPU queue drain exceeded its bound");
        auto task = std::move(immediate_.front());
        immediate_.pop_front();
        std::move(task)();
      }
    });
  }
  std::size_t Pending() const { return immediate_.size(); }

 private:
  void PostTaskImpl(absl::AnyInvocable<void() &&> task,
                    const PostTaskTraits&, const webrtc::Location&) override {
    if (immediate_.size() >= 256) throw std::runtime_error("CPU queue exceeded its bound");
    immediate_.push_back(std::move(task));
  }
  void PostDelayedTaskImpl(absl::AnyInvocable<void() &&> task, webrtc::TimeDelta,
                           const PostDelayedTaskTraits&, const webrtc::Location&) override {
    if (delayed_.size() >= 16) throw std::runtime_error("CPU delayed queue exceeded its bound");
    delayed_.push_back(std::move(task));
  }
  std::deque<absl::AnyInvocable<void() &&>> immediate_, delayed_;
};

class ReceiveCallback final : public webrtc::VCMReceiveCallback {
 public:
  explicit ReceiveCallback(webrtc::internal::ReceiveStatisticsProxy& stats) : stats_(stats) {}
  int32_t OnFrameToRender(const FrameToRender& frame) override {
    ++rendered;
    last_decode_time = frame.decode_time;
    last_rotation = frame.video_frame.rotation();
    last_processing_time = frame.video_frame.processing_time();
    return 0;
  }
  void OnDroppedFrames(uint32_t frames) override {
    dropped += frames;
    stats_.OnDroppedFrames(frames);
  }
  void OnMonkyDecoderTimestampMap(webrtc::MonkyDecoderTimestampMapEvent event,
                                 uint32_t frames) override {
    stats_.OnMonkyDecoderTimestampMap(event, frames);
  }
  std::uint32_t rendered = 0, dropped = 0;
  webrtc::TimeDelta last_decode_time = webrtc::TimeDelta::Zero();
  webrtc::VideoRotation last_rotation = webrtc::kVideoRotation_0;
  std::optional<webrtc::VideoFrame::ProcessingTime> last_processing_time;

 private:
  webrtc::internal::ReceiveStatisticsProxy& stats_;
};

inline webrtc::FrameInfo Mapping(webrtc::Clock& clock, std::uint32_t rtp) {
  webrtc::FrameInfo info{};
  info.rtp_timestamp = rtp;
  info.render_time = clock.CurrentTime() + webrtc::TimeDelta::Millis(40);
  info.decode_start = clock.CurrentTime();
  info.rotation = webrtc::kVideoRotation_90;
  info.content_type = webrtc::VideoContentType::SCREENSHARE;
  info.frame_type = webrtc::VideoFrameType::kVideoFrameDelta;
  info.ntp_time_ms = clock.CurrentNtpInMilliseconds();
  return info;
}

class ConcurrentMappingReceiver final : public webrtc::VCMReceiveCallback {
 public:
  int32_t OnFrameToRender(const FrameToRender&) override { ++rendered; return 0; }
  void OnDroppedFrames(uint32_t frames) override { dropped += frames; }
  void OnMonkyDecoderTimestampMap(webrtc::MonkyDecoderTimestampMapEvent event, uint32_t) override {
    if (event == webrtc::MonkyDecoderTimestampMapEvent::kMappedCallback) ++mapped;
    if (event == webrtc::MonkyDecoderTimestampMapEvent::kMissingCallback) ++missing;
  }
  std::atomic<uint32_t> rendered{0}, dropped{0}, mapped{0}, missing{0};
};

template <typename Check>
void ConcurrentTransfer(Check&& check, webrtc::Clock& clock, const webrtc::FieldTrialsView& trials) {
  webrtc::VCMTiming timing(&clock, trials);
  ConcurrentMappingReceiver receiver;
  webrtc::VCMDecodedFrameCallback decoded(&timing, &clock, trials, nullptr);
  decoded.SetUserReceiveCallback(&receiver);
  auto scope = std::make_shared<const webrtc::MonkyDecoderFrameInfoScope>();
  constexpr uint32_t rounds = 512;
  std::barrier<> start(2), finished(2);
  std::exception_ptr callback_error, mapping_error;
  bool bounded = true;
  // Only a CPU callback thread; no decoder worker, task queue or device starts.
  std::thread callbacks([&] {
    try {
      auto pixels = webrtc::I420Buffer::Create(2, 2);
      pixels->InitializeData();
      for (uint32_t i = 0; i < rounds; ++i) {
        auto frame = webrtc::VideoFrame::Builder().set_video_frame_buffer(pixels)
            .set_rtp_timestamp(90000 + i * 750).build();
        start.arrive_and_wait();
        decoded.Decoded(frame, std::optional<int32_t>(0), std::nullopt);
        finished.arrive_and_wait();
      }
    } catch (...) {
      callback_error = std::current_exception();
      start.arrive_and_drop();
      finished.arrive_and_drop();
    }
  });
  try {
    for (uint32_t i = 0; i < rounds; ++i) {
      auto lease = decoded.MapWithLease(Mapping(clock, 90000 + i * 750), 2, scope);
      bounded = bounded && static_cast<bool>(lease);
      start.arrive_and_wait();
      decoded.TransferFrameInfoLeaseToLegacy(lease);
      finished.arrive_and_wait();
      lease.reset();
      decoded.PruneFrameInfoLeases();
    }
  } catch (...) {
    mapping_error = std::current_exception();
    start.arrive_and_drop();
    finished.arrive_and_drop();
  }
  callbacks.join();
  decoded.SetUserReceiveCallback(nullptr);
  if (mapping_error) std::rethrow_exception(mapping_error);
  if (callback_error) std::rethrow_exception(callback_error);
  check(bounded && receiver.rendered == rounds && receiver.mapped == rounds &&
        receiver.missing == 0 && receiver.dropped == 0,
        "Concurrent SDK fallback transfer exposed an unmapped gap to the actual decoded callback");
}

class EncodedMetadata final : public webrtc::EncodedFrame {
 public:
  EncodedMetadata(std::int64_t id, std::uint32_t rtp, std::int64_t received_ms, bool key)
      : received_ms_(received_ms) {
    SetId(id);
    SetRtpTimestamp(rtp);
    if (!key) {
      num_references = 1;
      references[0] = id - 1;
    }
  }
  int64_t ReceivedTime() const override { return received_ms_; }
 private:
  const std::int64_t received_ms_;
};

class NoDecodeScheduler final : public webrtc::FrameDecodeScheduler {
 public:
  std::optional<uint32_t> ScheduledRtpTimestamp() override { return std::nullopt; }
  void ScheduleFrame(uint32_t, webrtc::FrameDecodeTiming::FrameSchedule,
                     FrameReleaseCallback) override {
    throw std::runtime_error("Unexpected scheduled decode in an inert CPU control");
  }
  void CancelOutstanding() override {}
  void Stop() override {}
};

class MetadataReceiver final : public webrtc::FrameSchedulingReceiver {
 public:
  void OnEncodedFrame(std::unique_ptr<webrtc::EncodedFrame> frame) override {
    ++received;
    last_id = frame->Id();
  }
  void OnDecodableFrameTimeout(webrtc::TimeDelta) override {
    throw std::runtime_error("CPU controls must not execute timeouts");
  }
  std::uint32_t received = 0;
  std::int64_t last_id = -1;
};

struct StopBuffer final {
  webrtc::VideoStreamBufferController& buffer;
  ~StopBuffer() { buffer.Stop(); }
};

}  // namespace rtc_receive_sdk_checks_detail

template <typename Check>
void RunRtcReceiveSdkChecks(Check&& check) {
  using namespace rtc_receive_sdk_checks_detail;
  // Missing-map controls deliberately reach upstream's warning branch, without
  // exposing any raw RTC logging sink.
  webrtc::LogMessage::LogToDebug(webrtc::LS_NONE);
  webrtc::LogMessage::SetLogToStderr(false);
#if RTC_LOG_ENABLED()
  check(webrtc::LogMessage::GetLogToStream() == webrtc::LS_NONE,
        "Raw RTC logging must be disabled before CPU missing-map controls");
#endif
  EmptyTrials trials;
  webrtc::SimulatedClock clock(webrtc::Timestamp::Millis(606000));
  ConcurrentTransfer(check, clock, trials);
  ManualQueue queue;
  queue.Run([&] {
    webrtc::VCMTiming timing(&clock, trials);
    webrtc::internal::ReceiveStatisticsProxy stats(7, &clock, &queue);
    webrtc::internal::ReceiveStatisticsProxy other(8, &clock, &queue);
    const webrtc::VideoReceiveStreamInterface::Stats absent;
    const auto initial = stats.GetStats();
    check(!absent.monky_receive_stream_instance_id &&
          !absent.monky_decoder_timestamp_map_overflow_evictions &&
          !absent.monky_frame_buffer_clear_events,
          "Default SDK receive Stats manufactured an actual stream observation");
    check(initial.monky_receive_stream_instance_id && *initial.monky_receive_stream_instance_id != 0 &&
          initial.monky_receive_stream_ssrc == 7 &&
          initial.monky_decoder_timestamp_map_overflow_evictions == 0 &&
          initial.monky_decoder_timestamp_map_missing_callbacks == 0 &&
          initial.monky_decoder_timestamp_map_mapped_callbacks == 0 &&
          initial.monky_frame_buffer_clear_events == 0 &&
          initial.monky_receive_stream_instance_id != other.GetStats().monky_receive_stream_instance_id,
          "Real statistics-proxy instances lost observed zero or their independent lifecycle identity");

    ReceiveCallback callback(stats);
    webrtc::VCMDecodedFrameCallback decoded(&timing, &clock, trials, nullptr);
    decoded.SetUserReceiveCallback(&callback);
    const auto decode = [&](std::uint32_t rtp) {
      auto pixels = webrtc::I420Buffer::Create(2, 2);
      pixels->InitializeData();
      auto frame = webrtc::VideoFrame::Builder().set_video_frame_buffer(pixels)
                       .set_rtp_timestamp(rtp).build();
      decoded.Decoded(frame, std::optional<int32_t>(3), std::nullopt);
    };
    decoded.ClearTimestampMap();
    check(queue.Pending() == 1 && stats.GetStats().monky_decoder_timestamp_map_clear_events == 0,
          "Diagnostic callbacks did not preserve worker-queue observation timing");
    queue.Drain();
    check(stats.GetStats().monky_decoder_timestamp_map_clear_events == 1 &&
          stats.GetStats().monky_decoder_timestamp_map_cleared_mappings == 0 && callback.dropped == 0,
          "An actual empty timestamp-map clear was not an observed zero-frame event");

    for (std::uint32_t i = 1; i <= 10; ++i) decoded.Map(Mapping(clock, i * 100));
    queue.Drain();
    check(stats.GetStats().monky_decoder_timestamp_map_overflow_evictions == 0 &&
          callback.dropped == 0, "The pinned ten-entry map evicted before capacity");
    decoded.Map(Mapping(clock, 1100));
    queue.Drain();
    check(stats.GetStats().monky_decoder_timestamp_map_overflow_evictions == 1 &&
          stats.GetStats().frames_dropped == 1 && callback.dropped == 1,
          "The actual eleventh mapping did not evict exactly the oldest of ten");
    decode(100);
    queue.Drain();
    check(stats.GetStats().monky_decoder_timestamp_map_missing_callbacks == 1 &&
          stats.GetStats().monky_decoder_timestamp_map_skipped_mappings == 0 &&
          callback.rendered == 0 && callback.dropped == 1,
          "An overflow-evicted callback was rendered or counted again as an aggregate drop");
    decode(400);
    queue.Drain();
    check(stats.GetStats().monky_decoder_timestamp_map_mapped_callbacks == 1 &&
          stats.GetStats().monky_decoder_timestamp_map_skipped_mappings == 2 &&
          stats.GetStats().monky_decoder_timestamp_map_skip_events == 1 &&
          callback.rendered == 1 && callback.dropped == 3 &&
          callback.last_rotation == webrtc::kVideoRotation_90 &&
          callback.last_decode_time == webrtc::TimeDelta::Millis(3) &&
          callback.last_processing_time &&
          callback.last_processing_time->Elapsed() == webrtc::TimeDelta::Millis(3),
          "A matched callback lost skipped mappings, real metadata, or explicit decode timing");
    decode(350);
    decode(650);
    queue.Drain();
    check(stats.GetStats().monky_decoder_timestamp_map_missing_callbacks == 3 &&
          stats.GetStats().monky_decoder_timestamp_map_skipped_mappings == 4 &&
          stats.GetStats().monky_decoder_timestamp_map_skip_events == 2 &&
          callback.rendered == 1 && callback.dropped == 5,
          "Missing callbacks failed to distinguish zero skips from removed older mappings");
    decoded.ClearTimestampMap();
    decoded.ClearTimestampMap();
    decode(1100);
    decoded.Map(Mapping(clock, 1200));
    decode(1200);
    queue.Drain();
    const auto map_result = stats.GetStats();
    check(map_result.monky_decoder_timestamp_map_cleared_mappings == 5 &&
          map_result.monky_decoder_timestamp_map_clear_events == 3 &&
          map_result.monky_decoder_timestamp_map_missing_callbacks == 4 &&
          map_result.monky_decoder_timestamp_map_mapped_callbacks == 2 &&
          map_result.frames_dropped == 10 && callback.dropped == 10 && callback.rendered == 2,
          "Map clears/missing/matched paths changed the original drop aggregate or double-counted mappings");
    decoded.SetUserReceiveCallback(nullptr);
    decoded.ClearTimestampMap();
    check(queue.Pending() == 0, "An unregistered empty map fabricated a receiving observation");

    MetadataReceiver receiver;
    webrtc::VideoStreamBufferController buffer(&clock, &queue, &timing, &stats, &receiver,
        webrtc::TimeDelta::Seconds(1), webrtc::TimeDelta::Seconds(1),
        std::make_unique<NoDecodeScheduler>(), trials);
    StopBuffer stop{buffer};
    buffer.Clear();
    buffer.InsertFrame(std::make_unique<EncodedMetadata>(2, 2000, clock.TimeInMilliseconds(), false));
    buffer.InsertFrame(std::make_unique<EncodedMetadata>(3, 3000, clock.TimeInMilliseconds(), true));
    check(buffer.Size() == 2, "The actual buffer did not retain the undecodable older metadata");
    // The public keyframe path extracts frame 3 and discards the unresolved
    // frame 2. No compressed payload or actual decoder is involved.
    buffer.StartNextDecode(true);
    buffer.Stop();
    queue.Drain();
    check(receiver.received == 1 && receiver.last_id == 3 && buffer.Size() == 0 &&
          stats.GetStats().monky_frame_buffer_skipped_frames == 1 &&
          stats.GetStats().monky_frame_buffer_skip_events == 1 &&
          stats.GetStats().monky_frame_buffer_clear_events == 1 &&
          stats.GetStats().monky_frame_buffer_cleared_frames == 0 &&
          stats.GetStats().frames_dropped == 11,
          "Actual buffer extraction did not report its positive skipped-frame delta separately from clears");
    buffer.InsertFrame(std::make_unique<EncodedMetadata>(5, 5000, clock.TimeInMilliseconds(), false));
    buffer.InsertFrame(std::make_unique<EncodedMetadata>(6, 6000, clock.TimeInMilliseconds(), false));
    check(buffer.Size() == 2, "The buffer clear control lacks its two real queued metadata frames");
    buffer.Clear();
    buffer.Clear();
    queue.Drain();
    check(stats.GetStats().monky_frame_buffer_cleared_frames == 2 &&
          stats.GetStats().monky_frame_buffer_clear_events == 3 &&
          stats.GetStats().monky_frame_buffer_skipped_frames == 1 &&
          stats.GetStats().monky_frame_buffer_skip_events == 1 &&
          stats.GetStats().frames_dropped == 13,
          "Nonempty/empty buffer clears changed policy or conflated cleared and skipped aggregates");
    {
      webrtc::internal::ReceiveStatisticsProxy owned_stats(10, &clock, &queue);
      ReceiveCallback owned_callback(owned_stats);
      webrtc::VCMDecodedFrameCallback owned(&timing, &clock, trials, nullptr);
      owned.SetUserReceiveCallback(&owned_callback);
      auto scope = std::make_shared<const webrtc::MonkyDecoderFrameInfoScope>();
      auto first = owned.MapWithLease(Mapping(clock, 1300), 2, scope);
      auto second = owned.MapWithLease(Mapping(clock, 1400), 2, scope);
      auto provisional = owned.MapWithLease(Mapping(clock, 1500), 2, scope);
      check(first && second && provisional &&
            !owned.MapWithLease(Mapping(clock, 1600), 2, scope) &&
            !owned.MapWithLease(Mapping(clock, 1700), 0, scope) &&
            owned_stats.GetStats().monky_decoder_timestamp_map_overflow_evictions == 0,
            "Typed SDK reservation exceeded N plus one or evicted existing metadata");
      first.reset();
      owned.PruneFrameInfoLeases();
      check(owned_stats.GetStats().monky_decoder_timestamp_map_lease_retirements == 0 &&
            owned_callback.dropped == 1,
            "Ownership cleanup fabricated a worker observation before its real queued callback");
      queue.Drain();
      check(owned_stats.GetStats().monky_decoder_timestamp_map_lease_retirements == 1 &&
            owned_stats.GetStats().frames_dropped == 1,
            "Actual terminal metadata did not traverse the typed SDK statistics route");
      second->Invalidate();
      owned.PruneFrameInfoLeases();
      scope.reset();
      owned.PruneFrameInfoLeases();
      queue.Drain();
      const auto observation = owned_stats.GetStats();
      check(observation.monky_decoder_timestamp_map_lease_retirements == 3 &&
            observation.monky_decoder_timestamp_map_overflow_evictions == 0 &&
            observation.monky_decoder_timestamp_map_cleared_mappings == 0 &&
            observation.monky_decoder_timestamp_map_missing_callbacks == 0 &&
            observation.frames_dropped == 3 && owned_callback.dropped == 3,
            "Exact refusal/scope retirement became overflow, clear, missing callback or duplicate loss");
      std::weak_ptr<webrtc::MonkyDecoderFrameInfoLease> old = provisional;
      second.reset();
      provisional.reset();
      check(old.expired(), "SDK weak index retained terminal metadata after its final native owner");
      auto native_held = owned.MapWithLease(Mapping(clock, 1800), 2,
          std::make_shared<const webrtc::MonkyDecoderFrameInfoScope>());
      owned.PruneFrameInfoLeases();
      native_held.reset();
      queue.Drain();
      check(owned_stats.GetStats().monky_decoder_timestamp_map_lease_retirements == 4 &&
            stats.GetStats().monky_decoder_timestamp_map_lease_retirements == 0 &&
            other.GetStats().monky_decoder_timestamp_map_lease_retirements == 0 &&
            !absent.monky_decoder_timestamp_map_lease_retirements,
            "Lease cleanup mixed receive scopes or converted absent diagnostics to observed zero");
      owned.SetUserReceiveCallback(nullptr);
    }
    const auto isolated = other.GetStats();
    webrtc::internal::ReceiveStatisticsProxy restarted(7, &clock, &queue);
    const auto fresh = restarted.GetStats();
    check(isolated.monky_decoder_timestamp_map_missing_callbacks == 0 &&
          isolated.monky_frame_buffer_clear_events == 0 &&
          fresh.monky_receive_stream_ssrc == 7 &&
          fresh.monky_receive_stream_instance_id != initial.monky_receive_stream_instance_id &&
          fresh.monky_decoder_timestamp_map_overflow_evictions == 0 &&
          fresh.monky_decoder_timestamp_map_missing_callbacks == 0 &&
          fresh.monky_frame_buffer_clear_events == 0,
          "Receive diagnostics mixed SSRCs or inherited counters after a real proxy lifecycle restart");
    auto retired = std::make_unique<webrtc::internal::ReceiveStatisticsProxy>(9, &clock, &queue);
    retired->OnMonkyDecoderTimestampMap(webrtc::MonkyDecoderTimestampMapEvent::kClear, 2);
    retired.reset();
    queue.Drain();
    check(queue.Pending() == 0 && restarted.GetStats().monky_decoder_timestamp_map_clear_events == 0,
          "Retired receive-statistics callbacks escaped their SDK task-safety lifetime");
  });
}

}  // namespace monky::native_rtc::engine
