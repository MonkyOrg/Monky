#pragma once

// The encoded source: its shared state, the RTC encoder that forwards already encoded access units, the factory
// and the track. Only encoded_video.cc and its device-free checks (encoded_video_checks.h) include this header.

#include "encoded_codec_policy.h"
#include "capture_clock.h"
#include "platform_clock.h"
#include "av1_obu.h"
#include "av1_sequence.h"

#include "api/make_ref_counted.h"
#include "api/video/encoded_image.h"
#include "media/base/video_broadcaster.h"
#include "modules/video_coding/include/video_codec_interface.h"
#include "modules/video_coding/svc/create_scalability_structure.h"
#include "pc/video_track_source.h"
#include "rtc_base/logging.h"

#include <atomic>
#include <condition_variable>
#include <cmath>
#include <deque>
#include <limits>
#include <map>
#include <mutex>
#include <set>
#include <span>
#include <thread>

namespace monky::native_rtc::engine {
namespace encoded {

using Gate = policy::CallbackGate<webrtc::EncodedImageCallback>;

// Capture encoders emit a real IDR every keyint_sec=1 GOP of encoded AUs. A
// loaded encoder skips frames and stretches that GOP in wall time, so recovery
// is bounded in AUs at the configured rate: three GOPs tolerate discarded IDRs.
inline constexpr std::uint64_t kRecoveryGops = 3;
inline std::uint64_t RecoveryFrameBound(const EncodedConfiguration& video) {
  return static_cast<std::uint64_t>(video.fps) * kRecoveryGops;
}

inline std::int64_t QpcNowUs() {
  std::int64_t result = 0;
  Require(NativeCaptureNowUs(result), "Cannot read the native capture clock", MONKY_ENGINE_FAILURE);
  return result;
}

inline bool Expired(std::int64_t timestamp, std::int64_t now) {
  return timestamp < now && now - timestamp > kEncodedMaximumAgeUs;
}

// Recovery reasons that count as expired access units; the others are clock drops, RTC discards and stalls.
inline bool CountsAsExpiry(std::string_view reason) {
  return reason == "input-expired" || reason == "publication-expired" || reason == "codec-expired";
}

inline void Capacity(std::size_t frames, std::size_t bytes, std::size_t next,
                     std::int64_t timestamp, std::int64_t now) {
  Require(frames < kEncodedMaximumFrames && next <= kEncodedMaximumBytes &&
      bytes <= kEncodedMaximumBytes - next, "Encoded native copy budget is full", MONKY_ENGINE_QUEUE_FULL);
  Require(timestamp <= now || timestamp - now <= 10000, "Encoded timestamp is ahead of system QPC");
  Require(!Expired(timestamp, now),
      "Encoded access unit exceeds the500ms age bound", MONKY_ENGINE_TIMEOUT);
}

struct Token;
struct State : std::enable_shared_from_this<State> {
  explicit State(std::uint64_t source, std::string group, bool initially_enabled,
                 std::function<bool(std::string_view, Json)> event, EncodedConfiguration configuration = {})
      : id(source), sync_group(std::move(group)), video(configuration), enabled(initially_enabled), emit(std::move(event)),
        stream(video.width, video.height, MinimumEncodedLevel(video), sv::H264Profile::Main,
               sv::H264LevelPolicy::Maximum) {}

  bool Event(std::string_view type, Json data) noexcept {
    try {
      std::unique_lock ordered(feedback_delivery, std::defer_lock);
      if (type == "source.encodedFeedback") {
        ordered.lock();
        data["sequence"] = ++feedback_sequence;
      }
      if (emit(type, std::move(data))) return true;
    } catch (...) {}
    event_failures.fetch_add(1);
    failed.store(true);
    enabled.store(false);
    wake.notify_all();
    return false;
  }
  void Fail(const char* code, const char* message) noexcept {
    failed.store(true);
    enabled.store(false);
    try {
      if (!error_reported.exchange(true)) Event("error", ErrorEvent(Error(code, message), true));
    } catch (...) { event_failures.fetch_add(1); }
    wake.notify_all();
  }
  Json RateData(const char* kind, std::uint64_t encoder, std::uint64_t requested,
                double requested_fps) {
    std::uint32_t selected = kEncodedBitrateCeiling;
    bool active = false;
    for (const auto& [session, rate] : rates) {
      if (!rate) continue;
      selected = (std::min)(selected, rate);
      active = true;
    }
    paused = !rates.empty() && !active;
    return {{"sourceId", id}, {"kind", kind}, {"encoderId", encoder},
      {"requestedBitrateBps", requested}, {"bitrateBps", active ? Json(selected) : Json(0)},
      {"requestedFps", requested_fps}, {"fpsApplied", nullptr}, {"paused", paused},
      {"bitrateCeilingBps", kEncodedBitrateCeiling}, {"keyframeConfirmed", false}};
  }
  void Rates(std::uint64_t encoder, std::uint64_t requested, double fps,
             std::uint32_t ceiling = kEncodedBitrateCeiling) {
    Json data;
    {
      std::lock_guard lock(mutex);
      Require(rates.contains(encoder), "Rate update refers to a retired encoder");
      rates[encoder] = requested && fps > 0
          ? static_cast<std::uint32_t>((std::min)({requested, std::uint64_t{ceiling},
                                                 std::uint64_t{kEncodedBitrateCeiling}})) : 0;
      const bool was_paused = paused;
      data = RateData("rate", encoder, requested, fps);
      if (!was_paused && paused) {
        ++generation;
        need_idr = true;
        recovering = false;
      }
    }
    Event("source.encodedFeedback", std::move(data));
    wake.notify_all();
  }
  void Keyframe(std::uint64_t encoder) {
    Json data;
    {
      std::lock_guard lock(mutex);
      data = {{"sourceId", id}, {"kind", "keyframe"},
        {"encoderId", encoder}, {"mode", "next-real-idr"}, {"keyframeConfirmed", false},
        {"maximumWaitMs", 1500}};
    }
    Event("source.encodedFeedback", std::move(data));
  }
  void EncoderClosed(std::uint64_t encoder) noexcept {
    try {
      Json data;
      {
        std::lock_guard lock(mutex);
        if (!rates.erase(encoder)) return;
        if (rates.empty()) {
          ++generation; need_idr = true; recovering = false;
        }
        data = RateData("encoder-closed", encoder, 0, 0);
      }
      Event("source.encodedFeedback", std::move(data));
    } catch (...) { Fail("ERR_RTC_ENCODED_FEEDBACK", "Cannot retire encoded feedback state"); }
  }
  void Recover(std::uint64_t expected_generation, std::uint64_t frame, const char* reason,
               const char* clock_status = nullptr);
  void AwaitDispatch(const std::shared_ptr<Token>& token,
      std::chrono::microseconds recover_after = std::chrono::microseconds(kEncodedMaximumAgeUs),
      std::chrono::microseconds fail_after = std::chrono::microseconds(kEncodedDispatchFailureUs));
  bool AcceptClockMapping(const CaptureClockMapping& mapping, std::uint64_t generation, std::uint64_t frame) {
    switch (CaptureClockActionFor(mapping.status)) {
      case CaptureClockAction::kUse: return true;
      case CaptureClockAction::kDropFrame:
        // The mapper drops this frame without retiming it, so its dependents wait for the next real IDR.
        Recover(generation, frame, mapping.status == CaptureClockStatus::kSampleUncertain
            ? "clock-sample-uncertain" : "clock-frame-dropped", CaptureClockErrorCode(mapping.status));
        return false;
      case CaptureClockAction::kReset: break;
    }
    throw Error("ERR_RTC_ENCODED_INPUT", CaptureClockErrorMessage(mapping.status), MONKY_ENGINE_FAILURE);
  }
  // Whether a receiver that negotiated this level decodes everything this source sends. H.264 never exceeds
  // MinimumEncodedLevel; an AV1 sequence's real level is known once admitted, and a receiver below it could never
  // decode this source.
  bool Serves(std::uint8_t receiver_level) const {
    if (!video.av1) return receiver_level >= MinimumEncodedLevel(video);
    std::lock_guard lock(mutex);
    return receiver_level >= MinimumAv1Level(video) && (!admitted || receiver_level >= av1_level);
  }
  // Not terminal: the source keeps serving every viewer that negotiated a level it can decode.
  void ReportIncompatibleReceiver(std::uint8_t actual, std::uint8_t negotiated) noexcept {
    try {
      Event("error", ErrorEvent(Error("ERR_RTC_ENCODED_LEVEL",
          "A receiver negotiated codec level " + std::to_string(negotiated) + ", below the actual sequence level " +
              std::to_string(actual) + "; it receives no video", MONKY_ENGINE_UNSUPPORTED), false));
    } catch (...) { event_failures.fetch_add(1); }
  }
  void DispatchRetired(Token& token, const webrtc::VideoFrameBuffer* buffer) noexcept;
  void Forwarded(const Token& token);
  void CheckRecoveryDeadline() const {
    Require(!recovering || recovery_frames <= RecoveryFrameBound(video),
        "Encoded video did not recover through a real independent keyframe within the live recovery bound",
        MONKY_ENGINE_TIMEOUT);
  }
  void Retired(const Token& token) noexcept;
  Json Snapshot() const {
    std::lock_guard lock(mutex);
    return {{"kind", video.av1 ? "encoded-av1" : "encoded-h264"}, {"width", video.width}, {"height", video.height}, {"requestedFps", video.fps},
      {"profileLevelId", stream.Verified() ? Json(stream.Sps().ProfileLevelId()) : Json(nullptr)},
      {"maximumProfileLevelId", video.av1 ? Json(nullptr) : Json("4d003c")},
      {"av1SequenceLevel", video.av1 && admitted ? Json(av1_level) : Json(nullptr)}, {"sourceId", id}, {"syncGroup", sync_group},
      {"enabled", enabled.load()}, {"paused", paused}, {"closed", closed.load()}, {"failed", failed.load()},
      {"admitted", admitted}, {"published", published}, {"released", released},
      {"acceptedCodecCallbacks", accepted_callbacks}, {"explicitlyNotSent", not_sent},
      {"unconsumed", unconsumed}, {"retainedFrames", retained.size()}, {"retainedBytes", retained_bytes},
      {"queuedFrames", queue.size()}, {"peakRetainedFrames", peak_frames}, {"peakRetainedBytes", peak_bytes},
      {"encoderSessions", rates.size()}, {"eventFailures", event_failures.load()},
      {"recovering", recovering}, {"recoveryRequests", recovery_requests},
      {"recoveryCompletions", recovery_completions}, {"expiredAccessUnits", expired},
      {"queuedRecoveryDiscards", recovery_discards},
      {"maximumFrames", kEncodedMaximumFrames}, {"maximumBytes", kEncodedMaximumBytes},
      {"maximumAgeUs", kEncodedMaximumAgeUs}, {"rawConversions", raw_conversions.load()},
      {"sourceFrames", nullptr}, {"nativeCopyRetirementIsDeliveryProof", false}};
  }

  const std::uint64_t id;
  const std::string sync_group;
  const EncodedConfiguration video;
  mutable std::mutex mutex;
  std::mutex publication;
  std::mutex feedback_delivery;
  std::condition_variable wake;
  std::atomic<bool> enabled, stopping{false}, closed{false}, failed{false}, error_reported{false};
  std::atomic<std::uint64_t> event_failures{0}, raw_conversions{0};
  const std::function<bool(std::string_view, Json)> emit;
  sv::H264Bitstream stream;
  std::uint8_t av1_level = 0;
  std::deque<std::shared_ptr<Token>> queue;
  std::map<std::uint64_t, std::weak_ptr<Token>> retained;
  std::map<const webrtc::VideoFrameBuffer*, std::weak_ptr<Token>> buffers;
  std::map<std::uint64_t, std::uint32_t> rates;
  std::uint64_t next_encoder = 1, feedback_sequence = 0, generation = 1, last_id = 0;
  std::int64_t last_timestamp = -1, last_pts = 0, last_dts = 0;
  std::uint32_t timebase_num = 0, timebase_den = 0;
  std::uint64_t admitted = 0, published = 0, released = 0, accepted_callbacks = 0, not_sent = 0, unconsumed = 0;
  std::uint64_t recovery_requests = 0, recovery_completions = 0, expired = 0, recovery_discards = 0;
  std::size_t retained_bytes = 0, peak_frames = 0, peak_bytes = 0;
  bool paused = false, need_idr = true, worker_exited = false;
  bool recovering = false;
  std::uint64_t recovery_frames = 0;
};

struct Token {
  ~Token() { if (admitted) owner->Retired(*this); }
  std::shared_ptr<State> owner;
  MonkyEngineEncodedFrame metadata{};
  std::vector<std::uint8_t> bytes;
  std::uint8_t level = 0;
  std::uint64_t generation = 0;
  bool admitted = false;
  std::atomic<std::size_t> expected{0}, accepted{0}, refused{0};
  std::atomic<bool> cancelled{false};
  std::atomic<bool> dispatch_retired{false};
  std::atomic<bool> unconsumed{false};
};

class NativeBuffer : public webrtc::VideoFrameBuffer {
 public:
  explicit NativeBuffer(std::shared_ptr<Token> token) : token_(std::move(token)) {
    std::lock_guard lock(token_->owner->mutex);
    token_->owner->buffers.emplace(this, token_);
  }
  ~NativeBuffer() override {
    token_->owner->DispatchRetired(*token_, this);
  }
  Type type() const override { return Type::kNative; }
  int width() const override { return static_cast<int>(token_->owner->video.width); }
  int height() const override { return static_cast<int>(token_->owner->video.height); }
  webrtc::scoped_refptr<webrtc::I420BufferInterface> ToI420() override {
    ++token_->owner->raw_conversions;
    token_->owner->Fail("ERR_RTC_ENCODED_RAW_CONVERSION", "An encoded source cannot be converted to I420");
    return nullptr;
  }
  webrtc::scoped_refptr<webrtc::VideoFrameBuffer> CropAndScale(int x, int y, int width, int height,
                                                             int scaled_width, int scaled_height) override {
    if (x == 0 && y == 0 && width == this->width() && height == this->height() &&
        scaled_width == width && scaled_height == height)
      return webrtc::scoped_refptr<webrtc::VideoFrameBuffer>(this);
    token_->owner->Fail("ERR_RTC_ENCODED_SCALING", "Already encoded H264 cannot be cropped or scaled");
    return nullptr;
  }
 private:
  const std::shared_ptr<Token> token_;
};

class EncodedBytes : public webrtc::EncodedImageBufferInterface {
 public:
  explicit EncodedBytes(std::shared_ptr<Token> token) : token_(std::move(token)) {}
  const std::uint8_t* data() const override { return token_->bytes.data(); }
  std::uint8_t* data() override { return token_->bytes.data(); }
  std::size_t size() const override { return token_->bytes.size(); }
 private:
  const std::shared_ptr<Token> token_;
};

class Track : public webrtc::VideoTrackSource {
 public:
  explicit Track(std::weak_ptr<State> state) : webrtc::VideoTrackSource(false), state_(std::move(state)) {}
  bool is_screencast() const override { return true; }
  std::optional<bool> needs_denoising() const override { return false; }
  bool GetStats(Stats* stats) override {
    const auto state = state_.lock();
    if (!state || !stats) return false;
    std::lock_guard lock(state->mutex);
    if (!state->published) return false;
    stats->input_width = static_cast<int>(state->video.width);
    stats->input_height = static_cast<int>(state->video.height);
    return true;
  }
  void AddOrUpdateSink(webrtc::VideoSinkInterface<webrtc::VideoFrame>* sink,
                       const webrtc::VideoSinkWants& wants) override {
    std::lock_guard lock(mutex_);
    if (wants.black_frames) { broadcaster_.RemoveSink(sink); sinks_.erase(sink); }
    else { broadcaster_.AddOrUpdateSink(sink, wants); sinks_.insert(sink); }
  }
  void RemoveSink(webrtc::VideoSinkInterface<webrtc::VideoFrame>* sink) override {
    std::lock_guard lock(mutex_);
    broadcaster_.RemoveSink(sink); sinks_.erase(sink);
  }
  void ProcessConstraints(const webrtc::VideoTrackSourceConstraints& constraints) override {
    std::lock_guard lock(mutex_); broadcaster_.ProcessConstraints(constraints);
  }
  bool HasSinks() { std::lock_guard lock(mutex_); return !sinks_.empty(); }
  bool Publish(const webrtc::VideoFrame& frame, const std::shared_ptr<Token>& token) {
    std::lock_guard lock(mutex_);
    if (sinks_.empty()) return false;
    token->expected.store(sinks_.size());
    broadcaster_.OnFrame(frame);
    return true;
  }
 protected:
  webrtc::VideoSourceInterface<webrtc::VideoFrame>* source() override { return &broadcaster_; }
 private:
  const std::weak_ptr<State> state_;
  std::mutex mutex_;
  std::set<webrtc::VideoSinkInterface<webrtc::VideoFrame>*> sinks_;
  webrtc::VideoBroadcaster broadcaster_;
};

class Encoder final : public webrtc::VideoEncoder {
 public:
  explicit Encoder(std::shared_ptr<State> state, std::uint8_t negotiated_level = kEncodedH264Level)
      : state_(std::move(state)), negotiated_level_(negotiated_level) {}
  ~Encoder() override { Release(); }
  int InitEncode(const webrtc::VideoCodec* codec, const Settings& settings) override {
    try {
      Require(codec && !state_->stopping.load(), "Encoded source is not available");
      Require(codec->maxBitrate <= kEncodedBitrateCeiling / 1000 &&
              codec->startBitrate <= kEncodedBitrateCeiling / 1000,
          "Encoded bitrate exceeds the 80000Kbps product ceiling");
      std::uint32_t initial_bitrate = 0, maximum_bitrate = kEncodedBitrateCeiling;
      if (state_->video.av1) {
        Require(codec->codecType == webrtc::kVideoCodecAV1 && settings.number_of_cores > 0 &&
            settings.max_payload_size > 0 && codec->numberOfSimulcastStreams <= 1 &&
            (!codec->GetScalabilityMode() || codec->GetScalabilityMode() == webrtc::ScalabilityMode::kL1T1) &&
            codec->maxFramerate > 0 && codec->minBitrate <= codec->maxBitrate &&
            codec->startBitrate <= codec->maxBitrate,
            "Invalid AV1 L1T1 encoder configuration");
        initial_bitrate = codec->active ? codec->startBitrate * 1000 : 0;
        maximum_bitrate = codec->maxBitrate ? codec->maxBitrate * 1000 : kEncodedBitrateCeiling;
      } else {
        const auto setup = policy::MakeEncoderSetup(*codec, settings, {sv::H264Profile::Main, negotiated_level_}, 8);
        initial_bitrate = setup.initial_bitrate;
        maximum_bitrate = setup.maximum_bitrate;
      }
      Require(codec->width == state_->video.width && codec->height == state_->video.height &&
          codec->maxFramerate <= state_->video.fps,
          "RTC cannot resize or increase the framerate of already encoded video");
      StopSession();
      maximum_bitrate_ = (std::min)(maximum_bitrate, kEncodedBitrateCeiling);
      {
        std::lock_guard lock(state_->mutex);
        Require(state_->rates.size() < 32, "Too many encoded RTC consumers", MONKY_ENGINE_QUEUE_FULL);
        session_ = state_->next_encoder++;
        state_->rates.emplace(session_, initial_bitrate);
      }
      generation_ = callbacks_.Activate();
      if (state_->video.av1) av1_controller_ = webrtc::CreateScalabilityStructure(webrtc::ScalabilityMode::kL1T1);
      needs_idr_ = true;
      requested_idr_ = false;
      state_->Rates(session_, initial_bitrate, codec->maxFramerate);
      return WEBRTC_VIDEO_CODEC_OK;
    } catch (const std::exception& error) {
      state_->Fail("ERR_RTC_ENCODED_INITIALIZATION", error.what());
      return WEBRTC_VIDEO_CODEC_ERR_PARAMETER;
    }
  }
  int32_t InitEncode(const webrtc::VideoCodec* codec, int32_t cores, std::size_t payload) override {
    return InitEncode(codec, Settings(Capabilities(false), cores, payload));
  }
  int32_t RegisterEncodeCompleteCallback(webrtc::EncodedImageCallback* callback) override {
    callbacks_.Register(callback);
    return WEBRTC_VIDEO_CODEC_OK;
  }
  int32_t Release() override {
    callbacks_.Clear();
    StopSession();
    return WEBRTC_VIDEO_CODEC_OK;
  }
  void SetRates(const RateControlParameters& rates) override {
    try {
      Require(session_ != 0, "Encoded rate feedback preceded encoder initialization");
      // RTC estimates input arrivals, not the encoded media clock. An AU burst
      // may exceed 120fps; reporting it must not retime or reject valid H264.
      Require(std::isfinite(rates.framerate_fps) && rates.framerate_fps >= 0 &&
          rates.framerate_fps <= (std::numeric_limits<std::uint32_t>::max)(),
          "Invalid encoded rate feedback");
      for (std::size_t spatial = 0; spatial < webrtc::kMaxSpatialLayers; ++spatial)
        for (std::size_t temporal = 0; temporal < webrtc::kMaxTemporalStreams; ++temporal)
          Require((spatial == 0 && temporal == 0) ||
              (!rates.bitrate.GetBitrate(spatial, temporal) && !rates.target_bitrate.GetBitrate(spatial, temporal)),
              "Encoded video supports only L1T1 rate feedback");
      const auto requested = rates.bitrate.get_sum_bps();
      if (!requested || rates.framerate_fps == 0) { needs_idr_ = true; requested_idr_ = false; }
      state_->Rates(session_, requested, rates.framerate_fps, maximum_bitrate_);
    } catch (const std::exception& error) { state_->Fail("ERR_RTC_ENCODED_RATES", error.what()); }
  }
  int32_t Encode(const webrtc::VideoFrame& frame,
                 const std::vector<webrtc::VideoFrameType>* types) override {
    std::shared_ptr<Token> token;
    try {
      Require(session_ && !state_->failed.load(), "Encoded adapter is not initialized");
      bool incompatible = false;
      {
        std::lock_guard lock(state_->mutex);
        const auto found = state_->buffers.find(frame.video_frame_buffer().get());
        Require(found != state_->buffers.end() && (token = found->second.lock()),
            "External encoder received a foreign/raw native buffer");
        incompatible = token->level > negotiated_level_;
        if (incompatible || state_->stopping.load() || !state_->enabled.load() ||
            token->generation != state_->generation || !state_->rates.at(session_)) {
          ++token->refused;
          needs_idr_ = true; requested_idr_ = false;
          if (!incompatible) return WEBRTC_VIDEO_CODEC_OK;
        }
      }
      if (incompatible) {
        // This receiver negotiated a lower level than the actual sequence and could never decode it: refuse only
        // its frames, once reported, instead of ending the source every other viewer shares.
        if (!std::exchange(incompatible_reported_, true))
          state_->ReportIncompatibleReceiver(token->level, negotiated_level_);
        return WEBRTC_VIDEO_CODEC_OK;
      }
      Require(!types || (types->size() == 1 && ((*types)[0] == webrtc::VideoFrameType::kVideoFrameKey ||
          (*types)[0] == webrtc::VideoFrameType::kVideoFrameDelta)), "Unsupported encoded frame/layer request");
      const auto now = QpcNowUs();
      if (Expired(token->metadata.timestamp_us, now)) {
        ++token->refused; needs_idr_ = true; requested_idr_ = false;
        state_->Recover(token->generation, token->metadata.frame_id, "codec-expired");
        return WEBRTC_VIDEO_CODEC_OK;
      }
      Capacity(0, 0, token->bytes.size(), token->metadata.timestamp_us, now);
      const bool requested = types && (*types)[0] == webrtc::VideoFrameType::kVideoFrameKey;
      if ((needs_idr_ || requested) && !token->metadata.keyframe && !requested_idr_) {
        requested_idr_ = true; idr_wait_frames_ = 0;
        state_->Keyframe(session_);
      }
      // PLI asks for a new independent picture; it does not break a valid local chain.
      if (needs_idr_ && !token->metadata.keyframe) {
        Require(++idr_wait_frames_ <= RecoveryFrameBound(state_->video),
            "No real IDR arrived within the live recovery bound", MONKY_ENGINE_TIMEOUT);
        ++token->refused;
        return WEBRTC_VIDEO_CODEC_OK;
      }
      webrtc::EncodedImage image;
      image.SetEncodedData(webrtc::make_ref_counted<EncodedBytes>(token));
      image.SetRtpTimestamp(frame.rtp_timestamp());
      image._encodedWidth = state_->video.width; image._encodedHeight = state_->video.height;
      image.SetFrameType(token->metadata.keyframe ? webrtc::VideoFrameType::kVideoFrameKey : webrtc::VideoFrameType::kVideoFrameDelta);
      image.capture_time_ms_ = frame.timestamp_us() / 1000;
      image.ntp_time_ms_ = token->metadata.ntp_time_ms;
      image.rotation_ = webrtc::kVideoRotation_0;
      image.content_type_ = webrtc::VideoContentType::SCREENSHARE;
      image.SetColorSpace(policy::Bt709Limited());
      image.SetSimulcastIndex(0);
      webrtc::CodecSpecificInfo codec{};
      codec.codecType = state_->video.av1 ? webrtc::kVideoCodecAV1 : webrtc::kVideoCodecH264;
      if (!state_->video.av1) {
        codec.codecSpecific.H264.packetization_mode = webrtc::H264PacketizationMode::NonInterleaved;
        codec.codecSpecific.H264.temporal_idx = (std::numeric_limits<std::uint8_t>::max)();
        codec.codecSpecific.H264.idr_frame = token->metadata.keyframe != 0;
      } else {
        Require(av1_controller_ != nullptr, "AV1 dependency controller is unavailable");
        auto configurations = av1_controller_->NextFrameConfig(token->metadata.keyframe != 0);
        Require(configurations.size() == 1, "AV1 requires one dependency configuration");
        codec.generic_frame_info = av1_controller_->OnEncodeDone(configurations.front());
        if (token->metadata.keyframe) {
          codec.template_structure = av1_controller_->DependencyStructure();
          codec.template_structure->resolutions = {
              webrtc::RenderResolution(state_->video.width, state_->video.height)};
        }
      }
      codec.scalability_mode = webrtc::ScalabilityMode::kL1T1;
      codec.end_of_picture = true;
      bool accepted = false;
      const bool invoked = callbacks_.Invoke(generation_, [&](webrtc::EncodedImageCallback& callback) {
        const auto result = callback.OnEncodedImage(image, &codec);
        accepted = result.error == webrtc::EncodedImageCallback::Result::OK;
      });
      if (invoked && accepted) {
        ++token->accepted;
        state_->Forwarded(*token);
        needs_idr_ = false;
        if (token->metadata.keyframe) requested_idr_ = false;
      } else {
        ++token->refused;
        state_->Fail("ERR_RTC_ENCODED_SEND", "RTC rejected the already-encoded access unit");
        return WEBRTC_VIDEO_CODEC_ERROR;
      }
      return WEBRTC_VIDEO_CODEC_OK;
    } catch (const std::exception& error) {
      if (token) ++token->refused;
      state_->Fail("ERR_RTC_ENCODED_CALLBACK", error.what());
      return WEBRTC_VIDEO_CODEC_ERROR;
    } catch (...) {
      if (token) ++token->refused;
      state_->Fail("ERR_RTC_ENCODED_CALLBACK", "Unknown exception inside encoded adapter callback");
      return WEBRTC_VIDEO_CODEC_ERROR;
    }
  }
  EncoderInfo GetEncoderInfo() const override {
    EncoderInfo info;
    info.implementation_name = state_->video.av1 ? "Monky external AV1 pass-through (no TX encode)" :
        "Monky external H264 pass-through (no TX encode)";
    info.supports_native_handle = true;
    info.preferred_pixel_formats = {webrtc::VideoFrameBuffer::Type::kNative};
    info.scaling_settings = ScalingSettings::kOff;
    info.supports_simulcast = false;
    // The encoded-only factory disables raw-frame dropping independently:
    // external rate control can overshoot and must still receive corrections.
    info.has_trusted_rate_controller = false;
    info.is_hardware_accelerated = false;
    return info;
  }
 private:
  void StopSession() noexcept {
    callbacks_.Deactivate(generation_);
    if (const auto session = std::exchange(session_, 0)) state_->EncoderClosed(session);
  }
  const std::shared_ptr<State> state_;
  const std::uint8_t negotiated_level_;
  std::unique_ptr<webrtc::ScalableVideoController> av1_controller_;
  Gate callbacks_;
  std::uint64_t session_ = 0, generation_ = 0;
  std::uint32_t maximum_bitrate_ = kEncodedBitrateCeiling;
  bool needs_idr_ = true, requested_idr_ = false, incompatible_reported_ = false;
  std::uint64_t idr_wait_frames_ = 0;
};

}  // namespace encoded

class EncodedVideoContext {
 public:
  explicit EncodedVideoContext(std::uint8_t level, bool is_av1 = false) : maximum_level(level), av1(is_av1) {
    encoded::Require(level == 51 || level == 52 || level == 60,
        "External H264 requires a Main5.1, Main5.2 or Main6 ceiling");
  }
  void ValidateSource(const encoded::EncodedConfiguration& video) const {
    if (!av1 && encoded::MinimumEncodedLevel(video) > maximum_level)
      throw Error("ERR_RTC_ENCODED_LEVEL", "Encoded source exceeds the engine's fixed advertised H264 level",
          MONKY_ENGINE_UNSUPPORTED);
  }
  // Before a source exists, an H.264 receiver must support the engine's fixed advertised level.
  bool Admits(std::uint8_t receiver_level) const { return av1 || receiver_level >= maximum_level; }
  const std::uint8_t maximum_level;
  const bool av1;
  std::mutex mutex;
  std::weak_ptr<encoded::State> source;
};

namespace encoded {

class Factory final : public webrtc::VideoEncoderFactory {
 public:
  explicit Factory(std::shared_ptr<EncodedVideoContext> context) : context_(std::move(context)) {}
  std::vector<webrtc::SdpVideoFormat> GetSupportedFormats() const override {
    if (context_->av1) return {policy::ScreenAv1Format()};
    // WebRTC caches these formats before a source exists. Never change them after startup.
    auto formats = policy::SupportedFormats(context_->maximum_level);
    std::erase_if(formats, [](const auto& format) {
      const auto parsed = policy::ParseFormat(format, kEncodedH264Level);
      Require(parsed.has_value(), "Internal H264 capability is invalid");
      return parsed->profile != sv::H264Profile::Main;
    });
    return formats;
  }
  CodecSupport QueryCodecSupport(const webrtc::SdpVideoFormat& format,
                                 std::optional<std::string> scalability) const override {
    std::lock_guard lock(context_->mutex);
    const auto source = context_->source.lock();
    const auto level = ReceiverLevel(format, context_->av1);
    return {level && (source ? source->Serves(*level) : context_->Admits(*level)) &&
        (!scalability || *scalability == "L1T1"), false};
  }
  std::unique_ptr<webrtc::VideoEncoder> Create(const webrtc::Environment&,
                                              const webrtc::SdpVideoFormat& format) override {
    std::lock_guard lock(context_->mutex);
    auto source = context_->source.lock();
    const auto level = ReceiverLevel(format, context_->av1);
    if (!source || source->stopping.load() || !level || !source->Serves(*level)) {
      RTC_LOG(LS_ERROR) << "Encoded video requires a live source and a receiver supporting its actual level L1T1";
      return nullptr;
    }
    return std::make_unique<Encoder>(std::move(source),
        context_->av1 ? *level : (std::min)(*level, context_->maximum_level));
  }
 private:
  const std::shared_ptr<EncodedVideoContext> context_;
};

class Source final : public VideoSource {
 public:
  Source(Host& host, std::uint64_t id, std::string group, bool enabled, EncodedConfiguration configuration)
      : host_(host), state_(std::make_shared<State>(id, std::move(group), enabled,
          [&host, id](std::string_view type, Json data) { return host.Emit(type, id, std::move(data)); }, configuration)),
        clock_(host.CaptureTimebase()) {
    Require(clock_ != nullptr, "The engine has no paired capture clock", MONKY_ENGINE_FAILURE);
    host.SignalingThread()->BlockingCall([this] {
      track_ = webrtc::make_ref_counted<Track>(state_);
      track_->SetState(webrtc::MediaSourceInterface::kLive);
    });
    worker_ = std::thread([this] { Run(); });
  }
  ~Source() override {
    state_->stopping.store(true); state_->wake.notify_all();
    if (worker_.joinable()) worker_.join();
  }
  std::shared_ptr<State> Shared() const { return state_; }
  webrtc::scoped_refptr<webrtc::VideoTrackSourceInterface> TrackSource() const override { return track_; }
  const std::string& SyncGroup() const override { return state_->sync_group; }
  bool Enabled() const override { return state_->enabled.load() && !state_->stopping.load() && !state_->failed.load(); }
  bool AcceptsSendCodec(const webrtc::SdpVideoFormat& format) const override {
    const auto level = ReceiverLevel(format, state_->video.av1);
    return level && state_->Serves(*level);
  }
  void SetEnabled(bool enabled) override {
    std::deque<std::shared_ptr<Token>> discarded;
    {
      std::lock_guard publication(state_->publication);
      std::lock_guard lock(state_->mutex);
      Require(!state_->stopping.load(), "Encoded source is closed", MONKY_ENGINE_CLOSED);
      if (state_->enabled.load() == enabled) return;
      ++state_->generation;
      state_->enabled.store(enabled);
      state_->need_idr = true;
      state_->recovering = false;
      if (!enabled) {
        discarded.swap(state_->queue);
        for (const auto& token : discarded) token->cancelled.store(true);
      }
    }
    state_->wake.notify_all();
  }
  void SubmitEncoded(const MonkyEngineEncodedFrame& frame) override {
    ValidateEncodedFrame(frame);
    Require(track_->HasSinks(), "Encoded source has no enabled RTC consumers", MONKY_ENGINE_BUSY);
    std::unique_lock lock(state_->mutex);
    Require(!state_->stopping.load() && !state_->failed.load(), "Encoded source is closed or failed", MONKY_ENGINE_CLOSED);
    Require(state_->enabled.load() && !state_->paused, "Encoded admission is disabled or rate-paused", MONKY_ENGINE_BUSY);
    if (state_->recovering) ++state_->recovery_frames;
    state_->CheckRecoveryDeadline();
    const auto current_time = [&] {
      const auto now = QpcNowUs();
      if (Expired(frame.timestamp_us, now)) {
        const auto generation = state_->generation;
        lock.unlock();
        state_->Recover(generation, frame.frame_id, "input-expired");
        throw Error("ERR_RTC_ENCODED_RECOVERY", "Expired encoded input was not copied; a fresh IDR is required", MONKY_ENGINE_BUSY);
      }
      return now;
    };
    Capacity(state_->retained.size(), state_->retained_bytes, frame.data_bytes, frame.timestamp_us, current_time());
    Require(frame.frame_id > state_->last_id && frame.timestamp_us > state_->last_timestamp,
        "Encoded frame IDs and real timestamps must strictly increase");
    if (state_->admitted) {
      Require(frame.pts > state_->last_pts && frame.dts > state_->last_dts &&
          frame.timebase_numerator == state_->timebase_num && frame.timebase_denominator == state_->timebase_den,
          "Encoded PTS/DTS order or timebase changed");
    }
    if (state_->need_idr && !frame.keyframe)
      throw Error("ERR_RTC_ENCODED_RECOVERY", "Encoded recovery requires a real IDR; no copy was admitted", MONKY_ENGINE_BUSY);
    auto parser = state_->stream;
    auto av1_level = state_->av1_level;
    sv::H264AccessUnit normalized;
    if (state_->video.av1) {
      const auto info = sv::InspectAv1({frame.data, frame.data_bytes});
      Require(info.picture && info.keyframe == (frame.keyframe != 0) && (!info.keyframe || info.sequence),
              "AV1 access unit has no matching picture or independent keyframe");
      if (info.sequence)
        av1_level = sv::Av1Level(sv::ReadAv1Sequence(info.sequence_header, state_->video.width, state_->video.height));
      normalized.data.assign(frame.data, frame.data + frame.data_bytes);
    } else {
      normalized = Normalize(parser, frame);
      ValidateEncodedLevel(parser.Sps(), state_->video);
    }
    Capacity(state_->retained.size(), state_->retained_bytes, normalized.data.size(), frame.timestamp_us, current_time());
    auto token = std::make_shared<Token>();
    token->level = state_->video.av1 ? av1_level : parser.Sps().levelIdc;
    token->owner = state_; token->metadata = frame; token->metadata.data = nullptr;
    token->bytes = std::move(normalized.data); token->generation = state_->generation;
    state_->retained.emplace(frame.frame_id, token);
    try { state_->queue.push_back(token); }
    catch (...) { state_->retained.erase(frame.frame_id); throw; }
    state_->stream = std::move(parser);
    state_->av1_level = av1_level;
    state_->last_id = frame.frame_id; state_->last_timestamp = frame.timestamp_us;
    state_->last_pts = frame.pts; state_->last_dts = frame.dts;
    state_->timebase_num = frame.timebase_numerator; state_->timebase_den = frame.timebase_denominator;
    state_->need_idr = false;
    ++state_->admitted;
    state_->retained_bytes += token->bytes.size();
    state_->peak_frames = (std::max)(state_->peak_frames, state_->retained.size());
    state_->peak_bytes = (std::max)(state_->peak_bytes, state_->retained_bytes);
    token->admitted = true;
    state_->wake.notify_all();
  }
  Json Snapshot() const override { return state_->Snapshot(); }
  void Close() override {
    std::deque<std::shared_ptr<Token>> discarded;
    {
      std::lock_guard publication(state_->publication);
      std::lock_guard lock(state_->mutex);
      state_->enabled.store(false); state_->stopping.store(true);
      discarded.swap(state_->queue);
      for (const auto& token : discarded) token->cancelled.store(true);
    }
    discarded.clear(); state_->wake.notify_all();
    {
      std::unique_lock lock(state_->mutex);
      Require(state_->wake.wait_for(lock, host_.Timeout(), [this] {
        return state_->worker_exited && state_->retained.empty();
      }), "Encoded copies/worker have not retired; ownership retained", MONKY_ENGINE_TIMEOUT);
    }
    if (worker_.joinable()) worker_.join();
    host_.SignalingThread()->BlockingCall([this] { track_->SetState(webrtc::MediaSourceInterface::kEnded); });
    state_->closed.store(true);
  }
 private:
  void Run() noexcept {
    CaptureClockSourceState order;
    try {
      for (;;) {
        std::shared_ptr<Token> token;
        {
          std::unique_lock lock(state_->mutex);
          state_->wake.wait_for(lock, std::chrono::milliseconds(20), [this] {
            return state_->stopping.load() || state_->failed.load() || !state_->queue.empty();
          });
          if (state_->stopping.load() || state_->failed.load()) break;
          if (state_->queue.empty()) continue;
          token = std::move(state_->queue.front()); state_->queue.pop_front();
        }
        {
          std::lock_guard lock(state_->mutex);
          if (!Enabled() || token->generation != state_->generation) { token->cancelled.store(true); continue; }
          state_->CheckRecoveryDeadline();
        }
        const auto now = QpcNowUs();
        if (Expired(token->metadata.timestamp_us, now)) {
          token->cancelled.store(true);
          state_->Recover(token->generation, token->metadata.frame_id, "publication-expired");
          continue;
        }
        Capacity(0, 0, token->bytes.size(), token->metadata.timestamp_us, now);
        auto mapped = clock_->Map(token->metadata.timestamp_us, order);
        if (const auto wait = CaptureClockEarlyWaitUs(mapped, token->metadata.duration_us)) {
          std::unique_lock lock(state_->mutex);
          state_->wake.wait_for(lock, std::chrono::microseconds(wait), [this] { return state_->stopping.load(); });
          lock.unlock();
          mapped = clock_->Map(token->metadata.timestamp_us, order);
        }
        if (!state_->AcceptClockMapping(mapped, token->generation, token->metadata.frame_id)) {
          token->cancelled.store(true);
          continue;
        }
        {
          auto buffer = webrtc::make_ref_counted<NativeBuffer>(token);
          const auto color = policy::Bt709Limited();
          const auto rtp = static_cast<std::uint32_t>((mapped.timestamp_us / 1000000) * 90000 +
              (mapped.timestamp_us % 1000000) * 90 / 1000);
          const auto frame = webrtc::VideoFrame::Builder().set_video_frame_buffer(buffer)
              .set_timestamp_us(mapped.timestamp_us).set_rtp_timestamp(rtp)
              .set_ntp_time_ms(token->metadata.ntp_time_ms).set_rotation(webrtc::kVideoRotation_0)
              .set_color_space(&color).build();
          std::lock_guard publication(state_->publication);
          bool current;
          {
            std::lock_guard lock(state_->mutex);
            current = Enabled() && !state_->paused && token->generation == state_->generation;
          }
          if (!current || !track_->Publish(frame, token)) token->cancelled.store(true);
          else { std::lock_guard lock(state_->mutex); ++state_->published; }
        }
        // RTC's raw-frame cadence adapter discards older queued pictures. Keep
        // compressed dependencies in our bounded queue, with one dispatch at a
        // time; encoded-byte/network references have a separate lifetime.
        state_->AwaitDispatch(token);
      }
    } catch (const std::exception& error) { state_->Fail("ERR_RTC_ENCODED_SOURCE", error.what()); }
    catch (...) { state_->Fail("ERR_RTC_ENCODED_SOURCE", "Unknown encoded source worker failure"); }
    std::deque<std::shared_ptr<Token>> discarded;
    {
      std::lock_guard lock(state_->mutex);
      discarded.swap(state_->queue);
      for (const auto& token : discarded) token->cancelled.store(true);
    }
    discarded.clear();
    { std::lock_guard lock(state_->mutex); state_->worker_exited = true; }
    state_->wake.notify_all();
  }
  Host& host_;
  const std::shared_ptr<State> state_;
  const std::shared_ptr<CaptureClock> clock_;
  webrtc::scoped_refptr<Track> track_;
  std::thread worker_;
};

}  // namespace encoded
}  // namespace monky::native_rtc::engine
