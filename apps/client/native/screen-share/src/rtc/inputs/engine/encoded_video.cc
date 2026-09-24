#include "encoded_video.h"
#include "capture_clock.h"
#include "h264_bitstream.h"
#include "mf_rtc_internal.h"
#include "peer_support.h"

#include "api\environment\environment_factory.h"
#include "api\field_trials.h"
#include "api\make_ref_counted.h"
#include "api\video\encoded_image.h"
#include "media\base\video_broadcaster.h"
#include "modules\video_coding\include\video_codec_interface.h"
#include "pc\video_track_source.h"
#include "rtc_base\logging.h"
#include "rtc_base\experiments\rate_control_settings.h"

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
namespace {
namespace sv = monky::screen_video;
namespace policy = monky::native_rtc::mf::detail;
using Clock = std::chrono::steady_clock;
using Gate = policy::CallbackGate<webrtc::EncodedImageCallback>;

void Require(bool condition, const char* message, MonkyEngineStatus status = MONKY_ENGINE_INVALID) {
  if (!condition) throw Error("ERR_RTC_ENCODED_INPUT", message, status);
}

struct EncodedConfiguration {
  std::uint32_t width = 1920, height = 1080, fps = 120;
};

std::uint8_t MinimumEncodedLevel(const EncodedConfiguration& video) {
  // Level5.1 covers every admitted bitrate (up to 80Mbps), even after feedback
  // raises it. Only geometry/rate can require a higher level within this product.
  return (std::max)(std::uint8_t{51},
      sv::RequiredH264Level(video.width, video.height, video.fps, kEncodedBitrateCeiling));
}

std::optional<policy::NegotiatedH264> ParseEncodedFormat(const webrtc::SdpVideoFormat& format) {
  auto negotiated = format;
  const auto maximum = negotiated.parameters.find("max-recv-level");
  const bool extended = maximum != negotiated.parameters.end();
  std::string receive_level;
  if (extended) {
    receive_level = maximum->second;
    negotiated.parameters.erase(maximum);
  }
  auto parsed = policy::ParseFormat(negotiated, kEncodedH264Level);
  if (!parsed || parsed->profile != sv::H264Profile::Main) return std::nullopt;
  if (!receive_level.empty()) {
    if (receive_level.size() != 4 ||
        !std::all_of(receive_level.begin(), receive_level.end(), [](unsigned char c) {
          return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
        })) return std::nullopt;
    const auto default_level = parsed->level;
    negotiated.parameters["profile-level-id"] = "4d" + receive_level;
    parsed = policy::ParseFormat(negotiated, kEncodedH264Level);
    if (!parsed || parsed->profile != sv::H264Profile::Main || parsed->level <= default_level) return std::nullopt;
  } else if (extended) {
    return std::nullopt;
  }
  return parsed;
}

bool AcceptsEncodedFormat(const webrtc::SdpVideoFormat& format,
                          std::uint8_t minimum_level = kEncodedH264Level) {
  const auto parsed = ParseEncodedFormat(format);
  return parsed && parsed->level >= minimum_level;
}

EncodedConfiguration ParseConfiguration(const Json& options) {
  const auto integer = [&](const char* key, std::uint32_t minimum, std::uint32_t maximum) {
    Require(options.contains(key) && options.at(key).is_number_integer() &&
        options.at(key) >= minimum && options.at(key) <= maximum, "Invalid encoded video configuration");
    return options.at(key).get<std::uint32_t>();
  };
  EncodedConfiguration value{integer("width", 2, 3840), integer("height", 2, 2160), integer("fps", 1, 120)};
  Require(value.width % 2 == 0 && value.height % 2 == 0, "H264 NV12 dimensions must be even");
  return value;
}

void ValidateEncodedLevel(const sv::H264Sps& sps, const EncodedConfiguration& video) {
  if (sv::RequiredH264Level(sps.codedWidth, sps.codedHeight, video.fps, 64000) > sps.levelIdc ||
      sps.levelIdc > MinimumEncodedLevel(video))
    throw Error("ERR_RTC_ENCODED_LEVEL",
        "Actual H264 SPS level must describe the source and fit its advertised level", MONKY_ENGINE_INVALID);
}

std::int64_t QpcNowUs() {
  LARGE_INTEGER ticks{}, frequency{};
  std::int64_t result = 0;
  Require(QueryPerformanceCounter(&ticks) && QueryPerformanceFrequency(&frequency) &&
      CaptureQpcMicroseconds(ticks.QuadPart, frequency.QuadPart, result),
      "Cannot read the local system-QPC clock", MONKY_ENGINE_FAILURE);
  return result;
}

bool Expired(std::int64_t timestamp, std::int64_t now) {
  return timestamp < now && now - timestamp > kEncodedMaximumAgeUs;
}

void Capacity(std::size_t frames, std::size_t bytes, std::size_t next,
              std::int64_t timestamp, std::int64_t now) {
  Require(frames < kEncodedMaximumFrames && next <= kEncodedMaximumBytes &&
      bytes <= kEncodedMaximumBytes - next, "Encoded native copy budget is full", MONKY_ENGINE_QUEUE_FULL);
  Require(timestamp <= now || timestamp - now <= 10000, "Encoded timestamp is ahead of system QPC");
  Require(!Expired(timestamp, now),
      "Encoded access unit exceeds the500ms age bound", MONKY_ENGINE_TIMEOUT);
}

std::size_t StartCode(std::span<const std::uint8_t> bytes, std::size_t at) {
  if (at > bytes.size() || bytes.size() - at < 3 || bytes[at] || bytes[at + 1]) return 0;
  if (bytes[at + 2] == 1) return 3;
  return bytes.size() - at >= 4 && !bytes[at + 2] && bytes[at + 3] == 1 ? 4 : 0;
}

void ParameterOrder(std::span<const std::uint8_t> bytes) {
  Require(StartCode(bytes, 0) != 0, "External input must be Annex B, not AVCC or raw pixels");
  bool picture = false;
  std::size_t at = 0, count = 0;
  while (at < bytes.size()) {
    const auto prefix = StartCode(bytes, at);
    Require(prefix != 0 && at + prefix < bytes.size() && ++count <= 4096, "Malformed or excessive Annex B NALs");
    const auto type = bytes[at + prefix] & 31;
    Require(type == 1 || type == 5 || type == 6 || type == 7 || type == 8 || type == 9 ||
        type == 10 || type == 11 || type == 12, "Unsupported external H264 NAL type");
    Require(!picture || (type != 7 && type != 8 && type != 9),
        "Parameter sets/AUD after VCL would change the picture's decoding order");
    picture = picture || type == 1 || type == 5;
    at += prefix + 1;
    while (at < bytes.size() && !StartCode(bytes, at)) ++at;
  }
}

sv::H264AccessUnit Normalize(sv::H264Bitstream& stream, const MonkyEngineEncodedFrame& frame) {
  ValidateEncodedFrame(frame);
  ParameterOrder({frame.data, frame.data_bytes});
  auto candidate = stream;
  sv::H264AccessUnit packet;
  try {
    packet = candidate.Convert({frame.data, frame.data_bytes});
    Require(packet.hasPicture && packet.keyFrame == (frame.keyframe != 0),
        "The packet keyframe flag must match one complete I/P picture");
    const auto& sps = candidate.Sps();
    if (!sv::IsBt709LimitedCompatible(sps)) {
      const auto field = [](std::optional<std::uint8_t> value) {
        return value ? std::to_string(*value) : std::string("absent");
      };
      throw Error("ERR_RTC_ENCODED_COLOR",
          "External H264 must retain the admitted BT.709 limited-range mode: fullRange=" +
          (sps.fullRange ? std::to_string(*sps.fullRange) : std::string("absent")) +
          ", primaries=" + field(sps.colorPrimaries) + ", transfer=" + field(sps.transferCharacteristics) +
          ", matrix=" + field(sps.matrixCoefficients), MONKY_ENGINE_INVALID);
    }
    Require(packet.data.size() <= kEncodedMaximumPacket, "Current SPS/PPS plus AU exceed the packet bound");
  } catch (const Error&) { throw; }
  catch (const std::exception& error) {
    throw Error("ERR_RTC_ENCODED_H264", error.what(), MONKY_ENGINE_INVALID);
  }
  stream = std::move(candidate);
  return packet;
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
      if (!error_reported.exchange(true))
        Event("error", {{"code", code}, {"message", message}, {"status", MONKY_ENGINE_FAILURE},
              {"hresult", 0}, {"terminal", true}});
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
  void Recover(std::uint64_t expected_generation, std::uint64_t frame, const char* reason);
  bool AcceptClockMapping(const CaptureClockMapping& mapping, std::uint64_t generation, std::uint64_t frame) {
    if (mapping.status == CaptureClockStatus::kSampleUncertain) {
      Recover(generation, frame, "clock-sample-uncertain");
      return false;
    }
    Require(mapping.status == CaptureClockStatus::kOk, CaptureClockErrorMessage(mapping.status), MONKY_ENGINE_FAILURE);
    return true;
  }
  void DispatchRetired(Token& token, const webrtc::VideoFrameBuffer* buffer) noexcept;
  void Forwarded(const Token& token);
  void CheckRecoveryDeadline() const {
    Require(!recovering || Clock::now() - recovery_started <= std::chrono::milliseconds(1500),
        "External H264 did not recover through a real IDR within1500ms", MONKY_ENGINE_TIMEOUT);
  }
  void Retired(const Token& token) noexcept;
  Json Snapshot() const {
    std::lock_guard lock(mutex);
    return {{"kind", "encoded-h264"}, {"width", video.width}, {"height", video.height}, {"requestedFps", video.fps},
      {"profileLevelId", stream.Verified() ? Json(stream.Sps().ProfileLevelId()) : Json(nullptr)},
      {"maximumProfileLevelId", "4d003c"}, {"sourceId", id}, {"syncGroup", sync_group},
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
  Clock::time_point recovery_started{};
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

void State::Recover(std::uint64_t expected_generation, std::uint64_t frame, const char* reason) {
  std::deque<std::shared_ptr<Token>> discarded;
  Json feedback;
  {
    std::lock_guard publication_lock(publication);
    std::lock_guard lock(mutex);
    if (stopping.load() || failed.load() || !enabled.load() || paused || expected_generation != generation) return;
    CheckRecoveryDeadline();
    if (!recovering) { recovering = true; recovery_started = Clock::now(); }
    ++generation; need_idr = true; ++recovery_requests;
    if (std::string_view(reason) != "rtc-unconsumed" && std::string_view(reason) != "clock-sample-uncertain") ++expired;
    discarded.swap(queue); recovery_discards += discarded.size();
    for (const auto& queued : discarded) queued->cancelled.store(true);
    feedback = {{"sourceId", id}, {"kind", "recovery"}, {"frameId", frame},
      {"generation", generation}, {"reason", reason}, {"mode", "next-real-idr"},
      {"maximumWaitMs", 1500}, {"keyframeConfirmed", false}};
  }
  Event("source.encodedFeedback", std::move(feedback));
  discarded.clear();
  wake.notify_all();
}

void State::DispatchRetired(Token& token, const webrtc::VideoFrameBuffer* buffer) noexcept {
  try {
    bool missing;
    {
      std::lock_guard lock(mutex);
      buffers.erase(buffer);
      const bool cancelled = token.cancelled.load() || token.generation != generation ||
          stopping.load() || !enabled.load() || failed.load();
      missing = !cancelled && token.accepted.load() + token.refused.load() < token.expected.load();
      token.unconsumed.store(missing);
      if (missing) ++unconsumed;
    }
    // Detect loss before waking the next dispatch, not when a later network
    // reference releases the compressed bytes. Dependent pictures must be fenced.
    if (missing) Recover(token.generation, token.metadata.frame_id, "rtc-unconsumed");
  } catch (const std::exception& error) { Fail("ERR_RTC_ENCODED_RECOVERY", error.what()); }
  catch (...) { Fail("ERR_RTC_ENCODED_RECOVERY", "Cannot fence discarded encoded dependencies"); }
  token.dispatch_retired.store(true);
  wake.notify_all();
}

void State::Forwarded(const Token& token) {
  std::lock_guard lock(mutex);
  if (recovering && token.generation == generation && token.metadata.keyframe && token.accepted.load()) {
    recovering = false;
    ++recovery_completions;
  }
}

void State::Retired(const Token& token) noexcept {
  bool missing = false, cancelled = false, paused_consumer = false;
  try {
    {
      std::lock_guard lock(mutex);
      retained.erase(token.metadata.frame_id);
      retained_bytes -= token.bytes.size();
      ++released;
      accepted_callbacks += token.accepted.load();
      not_sent += token.refused.load();
      cancelled = token.cancelled.load() || token.generation != generation || stopping.load() || !enabled.load();
      paused_consumer = std::any_of(rates.begin(), rates.end(), [](const auto& entry) { return entry.second == 0; });
      missing = token.unconsumed.load();
    }
    Event("source.encodedFrameReleased", {{"sourceId", id}, {"frameId", token.metadata.frame_id},
      {"acceptedCodecCallbacks", token.accepted.load()}, {"explicitlyNotSent", token.refused.load()},
      {"cancelled", cancelled}, {"unconsumed", missing}, {"pausedConsumerPresent", paused_consumer}, {"nativeCopyRetired", true},
      {"networkDeliveryConfirmed", false}});
  } catch (...) { Fail("ERR_RTC_ENCODED_RETIREMENT", "Cannot report bounded encoded copy retirement"); }
  wake.notify_all();
}

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
          "External H264 bitrate exceeds the 80000Kbps product ceiling");
      mf::AdapterOptions options;
      const auto setup = policy::MakeEncoderSetup(*codec, settings, {sv::H264Profile::Main, negotiated_level_}, options);
      Require(setup.core.width == state_->video.width && setup.core.height == state_->video.height &&
          codec->maxFramerate <= state_->video.fps,
          "RTC cannot resize or increase the framerate of already encoded H264");
      StopSession();
      maximum_bitrate_ = (std::min)(setup.maximum_bitrate, kEncodedBitrateCeiling);
      {
        std::lock_guard lock(state_->mutex);
        Require(state_->rates.size() < 32, "Too many encoded RTC consumers", MONKY_ENGINE_QUEUE_FULL);
        session_ = state_->next_encoder++;
        state_->rates.emplace(session_, setup.initial_bitrate);
      }
      generation_ = callbacks_.Activate();
      needs_idr_ = true;
      requested_idr_ = false;
      state_->Rates(session_, setup.initial_bitrate, codec->maxFramerate);
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
      Require(session_ != 0, "External H264 rate feedback preceded encoder initialization");
      // RTC estimates input arrivals, not the encoded media clock. An AU burst
      // may exceed 120fps; reporting it must not retime or reject valid H264.
      Require(std::isfinite(rates.framerate_fps) && rates.framerate_fps >= 0 &&
          rates.framerate_fps <= (std::numeric_limits<std::uint32_t>::max)(),
          "Invalid external H264 rate feedback");
      for (std::size_t spatial = 0; spatial < webrtc::kMaxSpatialLayers; ++spatial)
        for (std::size_t temporal = 0; temporal < webrtc::kMaxTemporalStreams; ++temporal)
          Require((spatial == 0 && temporal == 0) ||
              (!rates.bitrate.GetBitrate(spatial, temporal) && !rates.target_bitrate.GetBitrate(spatial, temporal)),
              "External H264 supports only L1T1 rate feedback");
      const auto requested = rates.bitrate.get_sum_bps();
      if (!requested || rates.framerate_fps == 0) needs_idr_ = true;
      state_->Rates(session_, requested, rates.framerate_fps, maximum_bitrate_);
    } catch (const std::exception& error) { state_->Fail("ERR_RTC_ENCODED_RATES", error.what()); }
  }
  int32_t Encode(const webrtc::VideoFrame& frame,
                 const std::vector<webrtc::VideoFrameType>* types) override {
    std::shared_ptr<Token> token;
    try {
      Require(session_ && !state_->failed.load(), "External H264 encoder is not initialized");
      {
        std::lock_guard lock(state_->mutex);
        const auto found = state_->buffers.find(frame.video_frame_buffer().get());
        Require(found != state_->buffers.end() && (token = found->second.lock()),
            "External encoder received a foreign/raw native buffer");
        Require(token->level <= negotiated_level_,
            "Actual H264 SPS exceeds this receiver's negotiated level");
        if (state_->stopping.load() || !state_->enabled.load() || token->generation != state_->generation ||
            !state_->rates.at(session_)) {
          ++token->refused;
          needs_idr_ = true;
          return WEBRTC_VIDEO_CODEC_OK;
        }
      }
      Require(!types || (types->size() == 1 && ((*types)[0] == webrtc::VideoFrameType::kVideoFrameKey ||
          (*types)[0] == webrtc::VideoFrameType::kVideoFrameDelta)), "Unsupported encoded frame/layer request");
      const auto now = QpcNowUs();
      if (Expired(token->metadata.timestamp_us, now)) {
        ++token->refused; needs_idr_ = true;
        state_->Recover(token->generation, token->metadata.frame_id, "codec-expired");
        return WEBRTC_VIDEO_CODEC_OK;
      }
      Capacity(0, 0, token->bytes.size(), token->metadata.timestamp_us, now);
      if (types && (*types)[0] == webrtc::VideoFrameType::kVideoFrameKey) needs_idr_ = true;
      if (needs_idr_ && !token->metadata.keyframe) {
        if (!requested_idr_) {
          requested_idr_ = true; idr_at_ = Clock::now();
          state_->Keyframe(session_);
        }
        Require(Clock::now() - idr_at_ <= std::chrono::milliseconds(1500),
            "No real IDR arrived within the1500ms recovery bound", MONKY_ENGINE_TIMEOUT);
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
      codec.codecType = webrtc::kVideoCodecH264;
      codec.codecSpecific.H264.packetization_mode = webrtc::H264PacketizationMode::NonInterleaved;
      codec.codecSpecific.H264.temporal_idx = (std::numeric_limits<std::uint8_t>::max)();
      codec.codecSpecific.H264.idr_frame = token->metadata.keyframe != 0;
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
        needs_idr_ = false; requested_idr_ = false;
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
    info.implementation_name = "Monky external H264 pass-through (no TX encode)";
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
  Gate callbacks_;
  std::uint64_t session_ = 0, generation_ = 0;
  std::uint32_t maximum_bitrate_ = kEncodedBitrateCeiling;
  bool needs_idr_ = true, requested_idr_ = false;
  Clock::time_point idr_at_{};
};
}  // namespace

class EncodedVideoContext {
 public:
  explicit EncodedVideoContext(std::uint8_t level) : maximum_level(level) {
    Require(level == 51 || level == 52 || level == 60, "External H264 requires a Main5.1, Main5.2 or Main6 ceiling");
  }
  void ValidateSource(const EncodedConfiguration& video) const {
    if (MinimumEncodedLevel(video) > maximum_level)
      throw Error("ERR_RTC_ENCODED_LEVEL", "Encoded source exceeds the engine's fixed advertised H264 level",
          MONKY_ENGINE_UNSUPPORTED);
  }
  const std::uint8_t maximum_level;
  std::mutex mutex;
  std::weak_ptr<State> source;
};

namespace {
class Factory final : public webrtc::VideoEncoderFactory {
 public:
  explicit Factory(std::shared_ptr<EncodedVideoContext> context) : context_(std::move(context)) {}
  std::vector<webrtc::SdpVideoFormat> GetSupportedFormats() const override {
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
    const auto negotiated = ParseEncodedFormat(format);
    return {negotiated && negotiated->level <= context_->maximum_level &&
      AcceptsEncodedFormat(format, source ? MinimumEncodedLevel(source->video) : context_->maximum_level) &&
      (!scalability || *scalability == "L1T1"), false};
  }
  std::unique_ptr<webrtc::VideoEncoder> Create(const webrtc::Environment&,
                                              const webrtc::SdpVideoFormat& format) override {
    std::lock_guard lock(context_->mutex);
    auto source = context_->source.lock();
    const auto negotiated = ParseEncodedFormat(format);
    if (!source || source->stopping.load() || !negotiated || negotiated->level > context_->maximum_level ||
        negotiated->level < MinimumEncodedLevel(source->video)) {
      RTC_LOG(LS_ERROR) << "External H264 requires a live source and a receiver supporting its actual Main level L1T1";
      return nullptr;
    }
    return std::make_unique<Encoder>(std::move(source), negotiated->level);
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
    return AcceptsEncodedFormat(format, MinimumEncodedLevel(state_->video));
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
    auto normalized = Normalize(parser, frame);
    ValidateEncodedLevel(parser.Sps(), state_->video);
    Capacity(state_->retained.size(), state_->retained_bytes, normalized.data.size(), frame.timestamp_us, current_time());
    auto token = std::make_shared<Token>();
    token->level = parser.Sps().levelIdc;
    token->owner = state_; token->metadata = frame; token->metadata.data = nullptr;
    token->bytes = std::move(normalized.data); token->generation = state_->generation;
    state_->retained.emplace(frame.frame_id, token);
    try { state_->queue.push_back(token); }
    catch (...) { state_->retained.erase(frame.frame_id); throw; }
    state_->stream = std::move(parser);
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
        std::unique_lock lock(state_->mutex);
        Require(state_->wake.wait_for(lock, std::chrono::microseconds(kEncodedMaximumAgeUs), [&] {
          return token->dispatch_retired.load() || state_->stopping.load() || state_->failed.load();
        }), "RTC encoded dispatch exceeded its500ms retirement bound", MONKY_ENGINE_TIMEOUT);
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
}  // namespace

void ValidateEncodedFrame(const MonkyEngineEncodedFrame& frame) {
  static_assert(std::is_nothrow_move_assignable_v<sv::H264Bitstream>);
  Require(frame.struct_size == sizeof(frame) && frame.abi_version == MONKY_ENGINE_ABI_VERSION &&
      frame.frame_id > 0 && frame.frame_id <= kMaxId && frame.data && frame.data_bytes > 0 &&
      frame.data_bytes <= kEncodedMaximumPacket && frame.keyframe <= 1 &&
      frame.timestamp_us >= 0 && frame.timestamp_us <= static_cast<std::int64_t>(kMaxId) &&
      frame.duration_us > 0 && frame.duration_us <= 1000000 &&
      frame.ntp_time_ms >= -1 && frame.ntp_time_ms <= static_cast<std::int64_t>(kMaxId) &&
      frame.timebase_numerator > 0 && frame.timebase_numerator <= INT32_MAX &&
      frame.timebase_denominator > 0 && frame.timebase_denominator <= INT32_MAX,
      "Invalid bounded Annex B input metadata");
}

EncodedFactoryBundle CreateEncodedVideoFactory(std::uint8_t maximum_level) {
  auto context = std::make_shared<EncodedVideoContext>(maximum_level);
  auto field_trials = webrtc::FieldTrials::Create(
      "WebRTC-FrameDropper/Disabled/"
      "WebRTC-CongestionWindow/QueueSize:350,MinBitrate:30000,DropFrame:false/");
  Require(field_trials != nullptr, "Cannot configure encoded-video congestion control", MONKY_ENGINE_FAILURE);
  return {context, std::make_unique<Factory>(context), std::move(field_trials)};
}

std::shared_ptr<VideoSource> CreateEncodedVideoSource(Host& host, std::uint64_t id, const Json& options,
    const std::shared_ptr<Cancellation>& cancellation, const std::shared_ptr<EncodedVideoContext>& context) {
  Require(options.is_object() && options.size() >= 4 && options.size() <= 5, "Invalid encoded source options");
  for (const auto& item : options.items())
    Require(item.key() == "width" || item.key() == "height" || item.key() == "fps" ||
        item.key() == "syncGroup" || item.key() == "enabled", "Unknown encoded source option");
  const auto configuration = ParseConfiguration(options);
  const auto group = SyncGroup(options);
  const bool enabled = Boolean(options, "enabled");
  Require(context != nullptr, "The engine has no external-H264 factory");
  context->ValidateSource(configuration);
  std::lock_guard lock(context->mutex);
  if (const auto previous = context->source.lock())
    Require(previous->closed.load(), "Previous encoded source still owns its copy/codec state", MONKY_ENGINE_BUSY);
  cancellation->Check();
  auto source = std::make_shared<Source>(host, id, group, enabled, configuration);
  context->source = source->Shared();
  return source;
}

void RunEncodedVideoChecks(const std::function<void(bool, const char*)>& check) {
  const std::array<std::optional<std::uint8_t>, 3> compatible_colours{std::nullopt, 1, 2};
  for (const auto primaries : compatible_colours) {
    for (const auto transfer : compatible_colours) {
      for (const auto matrix : compatible_colours) {
        sv::H264Sps sps;
        sps.colorPrimaries = primaries; sps.transferCharacteristics = transfer; sps.matrixCoefficients = matrix;
        check(sv::IsBt709LimitedCompatible(sps), "Absent and explicitly unspecified H264 colour must agree");
        sps.fullRange = false;
        check(sv::IsBt709LimitedCompatible(sps), "Limited-range colour contract changed");
        sps.fullRange = true;
        check(!sv::IsBt709LimitedCompatible(sps), "Full-range H264 cannot enter the limited-range pipeline");
      }
    }
  }
  for (unsigned value = 0; value <= 255; ++value) {
    if (value == 1 || value == 2) continue;
    for (const auto member : {&sv::H264Sps::colorPrimaries, &sv::H264Sps::transferCharacteristics,
                              &sv::H264Sps::matrixCoefficients}) {
      sv::H264Sps sps;
      sps.*member = static_cast<std::uint8_t>(value);
      check(!sv::IsBt709LimitedCompatible(sps), "Conflicting or reserved H264 colour description was accepted");
    }
  }
  const auto rejects = [&](auto&& operation) {
    bool rejected = false;
    try { operation(); } catch (const std::exception&) { rejected = true; }
    check(rejected, "Invalid encoded contract was accepted");
  };
  for (const auto video : {EncodedConfiguration{3840, 2160, 120}, {3840, 2160, 60},
                           {1920, 1080, 120}, {1920, 1080, 60},
                           {1280, 720, 60}, {854, 480, 30}}) {
    const auto parsed = ParseConfiguration({{"width", video.width}, {"height", video.height}, {"fps", video.fps}});
    check(parsed.width == video.width && parsed.height == video.height && parsed.fps == video.fps,
        "Encoded rendition geometry/framerate changed during admission");
    auto configured = std::make_shared<State>(1, "cpu-rendition", false,
        [](std::string_view, Json) { return true; }, parsed);
    const auto snapshot = configured->Snapshot();
    check(snapshot.at("width") == video.width && snapshot.at("height") == video.height &&
        snapshot.at("requestedFps") == video.fps && snapshot.at("profileLevelId").is_null(),
        "Rendition stats must report their own configuration without inventing an observed SPS");
  }
  for (const auto invalid : {Json{{"width", 3844}, {"height", 2160}, {"fps", 120}},
                            Json{{"width", 3840}, {"height", 2162}, {"fps", 120}},
                            Json{{"width", 3840}, {"height", 2160}, {"fps", 121}},
                            Json{{"width", 1920}, {"height", 1080}, {"fps", 121}},
                            Json{{"width", 0}, {"height", 1080}, {"fps", 120}},
                            Json{{"width", 1919}, {"height", 1080}, {"fps", 120}},
                            Json{{"width", 1920}, {"height", 1079}, {"fps", 120}},
                            Json{{"width", 1920}, {"height", 1080}, {"fps", 0}},
                            Json{{"width", -2}, {"height", 1080}, {"fps", 120}},
                            Json{{"width", "1920"}, {"height", 1080}, {"fps", 120}}}) {
    rejects([&] { ParseConfiguration(invalid); });
  }
  {
    sv::H264Sps sps;
    sps.width = sps.codedWidth = 3840; sps.height = sps.codedHeight = 2160; sps.levelIdc = 52;
    rejects([&] { ValidateEncodedLevel(sps, {3840, 2160, 120}); });
    sps.levelIdc = 60;
    ValidateEncodedLevel(sps, {3840, 2160, 120});
    sps.codedWidth = sps.codedHeight = 4096;
    rejects([&] { ValidateEncodedLevel(sps, {3840, 2160, 120}); });
    sps.width = sps.codedWidth = 1920; sps.height = 1080; sps.codedHeight = 1088; sps.levelIdc = 51;
    ValidateEncodedLevel(sps, {1920, 1080, 120});
    sps.levelIdc = 60;
    rejects([&] { ValidateEncodedLevel(sps, {1920, 1080, 120}); });
    check(true, "4K120 requires Level6 while 1080p120 retains its actual Level5.1 SPS");
  }
  check(sizeof(MonkyEngineEncodedFrame) == 80 && alignof(MonkyEngineEncodedFrame) == 8,
      "Encoded C/POD layout drift");
  check(offsetof(MonkyEngineEncodedFrame, data) == 16 &&
      offsetof(MonkyEngineEncodedFrame, timestamp_us) == 32 &&
      offsetof(MonkyEngineEncodedFrame, timebase_numerator) == 72, "Encoded POD field offset drift");
  std::uint8_t byte = 1;
  MonkyEngineEncodedFrame frame{sizeof(frame), MONKY_ENGINE_ABI_VERSION, 1, &byte, 1, 1, 10000, 8333, -1, -2, -2, 1, 120};
  ValidateEncodedFrame(frame);
  check(true, "Signed PTS and genuine QPC metadata are accepted without index retiming");
  {
    std::vector<std::uint8_t> packet{
      0, 0, 0, 1, 0x67, 0x4d, 0x00, 0x33, 0xf4, 0x02, 0x80, 0x2d, 0xd3, 0x50, 0x20, 0x20, 0x20, 0x20,
      0, 0, 0, 1, 0x68, 0xc8, 0, 0, 0, 1, 0x65, 0xbc,
    };
    auto input = frame;
    input.data = packet.data(); input.data_bytes = static_cast<std::uint32_t>(packet.size());
    sv::H264Bitstream parser(1280, 720, kEncodedH264Level, sv::H264Profile::Main, sv::H264LevelPolicy::Maximum);
    const auto admitted = Normalize(parser, input);
    check(admitted.hasPicture && admitted.keyFrame && parser.Sps().colorPrimaries == 2 &&
        parser.Sps().transferCharacteristics == 2 && parser.Sps().matrixCoefficients == 2,
        "The actual external-input path rejected explicitly unspecified H264 colour");
    check(admitted.data == packet, "Colour compatibility must not rewrite encoded parameter sets");
    {
      State bounded(1, "source-sps-level", false, [](std::string_view, Json) { return true; }, {1280, 720, 60});
      packet[7] = 60;
      rejects([&] { Normalize(bounded.stream, input); });
      packet[7] = 51;
      check(Normalize(bounded.stream, input).hasPicture,
          "Real SPS must fit the advertised source level without relabeling parameter sets");
    }
    packet[14] = packet[15] = packet[16] = 0x60;
    bool rejected = false;
    try { Normalize(parser, input); }
    catch (const Error& error) {
      rejected = error.code == "ERR_RTC_ENCODED_COLOR" &&
          std::string(error.what()).find("primaries=6, transfer=6, matrix=6") != std::string::npos;
    }
    check(rejected, "Contradictory colour must retain its exact observed values in the error");
    check(parser.Sps().colorPrimaries == 2, "Rejected colour must not poison the admitted SPS cache");
  }
  for (const auto bad : {0u, static_cast<unsigned>(kEncodedMaximumPacket + 1)}) {
    auto copy = frame; copy.data_bytes = bad; rejects([&] { ValidateEncodedFrame(copy); });
  }
  for (const auto bad : {std::int64_t{-1}, static_cast<std::int64_t>(kMaxId + 1)}) {
    auto copy = frame; copy.timestamp_us = bad; rejects([&] { ValidateEncodedFrame(copy); });
  }
  {
    // AMF can offset DTS even with B-frames disabled. The bitstream validator
    // rejects B slices; source admission independently checks PTS/DTS order.
    auto copy = frame; copy.dts = -3; ValidateEncodedFrame(copy);
    check(copy.pts == -2 && copy.dts == -3, "Independent original PTS/DTS must not be retimed");
  }
  { auto copy = frame; copy.data = nullptr; rejects([&] { ValidateEncodedFrame(copy); }); }
  Capacity(15, kEncodedMaximumBytes - 1, 1, 1000000, 1500000);
  check(true, "Exact encoded age/byte/frame bounds are accepted");
  rejects([&] { Capacity(16, 0, 1, 1000000, 1000000); });
  rejects([&] { Capacity(0, kEncodedMaximumBytes, 1, 1000000, 1000000); });
  rejects([&] { Capacity(0, 0, 1, 1000000, 1500001); });
  rejects([&] { Capacity(0, 0, 1, 1010001, 1000000); });
  const std::array<std::uint8_t, 8> bad_order{0, 0, 1, 0x65, 0, 0, 1, 0x67};
  rejects([&] { ParameterOrder(bad_order); });
  auto bundle = CreateEncodedVideoFactory(kEncodedH264Level);
  const webrtc::RateControlSettings encoded_rates(*bundle.field_trials);
  check(bundle.field_trials->IsDisabled("WebRTC-FrameDropper") &&
      encoded_rates.UseCongestionWindow() && encoded_rates.UseCongestionWindowPushback() &&
      !encoded_rates.UseCongestionWindowDropFrameOnly(),
      "Encoded congestion must lower the producer bitrate, not discard compressed dependencies");
  check(encoded_rates.GetCongestionWindowAdditionalTimeMs() == 350 &&
      encoded_rates.CongestionWindowMinPushbackTargetBitrateBps() == 30000 &&
      encoded_rates.UseEncoderBitrateAdjuster(),
      "Encoded transport must preserve bounded congestion feedback and overshoot adjustment");
  const webrtc::FieldTrials default_trials("");
  const webrtc::RateControlSettings default_rates(default_trials);
  check(!default_trials.IsDisabled("WebRTC-FrameDropper") &&
      default_rates.UseCongestionWindowDropFrameOnly(),
      "Encoded-only congestion policies must not change the raw-video defaults");
  const auto formats = bundle.encoder_factory->GetSupportedFormats();
  check(formats.size() == 1 && formats[0].parameters.at("profile-level-id") == "4d003c",
      "External encoder must advertise Main6 support without mislabeling a 4K120 stream");
  check(bundle.encoder_factory->QueryCodecSupport(formats[0], "L1T1").is_supported,
      "External H264 L1T1 support is missing");
  check(!bundle.encoder_factory->QueryCodecSupport(formats[0], "L1T2").is_supported,
      "Encoded SVC must not be fabricated");
  {
    auto receive = formats[0];
    receive.parameters["profile-level-id"] = "4d001f";
    check(!AcceptsEncodedFormat(receive), "A Level3.1-only receiver cannot accept the external Main6 stream");
    receive.parameters["max-recv-level"] = "003c";
    check(AcceptsEncodedFormat(receive) && bundle.encoder_factory->QueryCodecSupport(receive, "L1T1").is_supported,
        "An explicit RFC6184 Main6 receive limit was ignored");
    for (const auto* invalid : {"", "3c", "xyz3", "001f", "002a", "0033", "0034", "003d", "8033"}) {
      receive.parameters["max-recv-level"] = invalid;
      check(!AcceptsEncodedFormat(receive), "Invalid or insufficient extended H264 receive level was accepted");
    }
    receive.parameters["max-recv-level"] = "003c";
    receive.parameters["profile-level-id"] = "42e01f";
    check(!AcceptsEncodedFormat(receive), "A Baseline receiver was mistaken for Main profile support");
    receive.parameters["profile-level-id"] = "4d0034";
    receive.parameters.erase("max-recv-level");
    check(!AcceptsEncodedFormat(receive), "Level5.2 is insufficient for a Main6 publication");
    receive.parameters["profile-level-id"] = "4d003c";
    check(AcceptsEncodedFormat(receive), "An explicit Main6 receiver must be admitted");
    Json router{{"codecs", Json::array({Json{
        {"kind", "video"}, {"mimeType", "video/H264"}, {"clockRate", 90000},
        {"preferredPayloadType", 102},
        {"parameters", {{"profile-level-id", "4d0034"}, {"packetization-mode", 1}}}}})}};
    const auto accepts_4k120 = [](const auto& format) { return AcceptsEncodedFormat(format, 60); };
    rejects([&] { peer_detail::SelectScreenSendCodec(router, accepts_4k120); });
    router["codecs"][0]["parameters"]["profile-level-id"] = "4d003c";
    check(peer_detail::SelectScreenSendCodec(router, accepts_4k120) == router["codecs"][0],
        "SFU admission must select the router's exact compatible codec before publication");
    auto isolated = std::make_shared<State>(1, "codec-rejection-isolation", false,
        [](std::string_view, Json) { return true; });
    auto context = std::make_shared<EncodedVideoContext>(kEncodedH264Level);
    context->source = isolated;
    Factory factory(context);
    receive.parameters["profile-level-id"] = "4d001f";
    check(!factory.Create(webrtc::CreateEnvironment(), receive) && !isolated->failed.load(),
        "An incompatible receiver must not poison the shared source for other viewers");
  }
  for (const auto video : {EncodedConfiguration{1920, 1080, 120}, {3840, 2160, 60}, {3840, 2160, 120}}) {
    const auto minimum = MinimumEncodedLevel(video);
    const auto expected = video.width == 1920 ? 51 : video.fps == 60 ? 52 : 60;
    check(minimum == expected, "Source minimum must reflect actual macroblocks/rate, with a Level5.1 floor");
    auto isolated = std::make_shared<State>(1, "source-codec-level", false,
        [](std::string_view, Json) { return true; }, video);
    auto fixed = CreateEncodedVideoFactory(minimum);
    auto context = fixed.context;
    auto& factory = *fixed.encoder_factory;
    const auto advertised = factory.GetSupportedFormats();
    check(advertised.size() == 1 && ParseEncodedFormat(advertised[0])->level == minimum,
        "Initial codec caches must receive the rendition level BEFORE any source exists");
    check(factory.QueryCodecSupport(advertised[0], "L1T1").is_supported,
        "Initial advertised codec must be supported before source creation");
    context->ValidateSource(video);
    context->source = isolated;
    check(factory.GetSupportedFormats() == advertised, "Source creation must not change cached capabilities");
    for (const auto candidate : {EncodedConfiguration{1920, 1080, 120},
             EncodedConfiguration{3840, 2160, 60}, EncodedConfiguration{3840, 2160, 120}}) {
      if (MinimumEncodedLevel(candidate) > minimum)
        rejects([&] { context->ValidateSource(candidate); });
      else context->ValidateSource(candidate);
    }
    for (const auto level : {std::uint8_t{51}, std::uint8_t{52}, std::uint8_t{60}}) {
      auto receive = policy::SupportedFormats(level).back();
      const bool accepted = level == minimum;
      check(factory.QueryCodecSupport(receive, "L1T1").is_supported == accepted &&
          static_cast<bool>(factory.Create(webrtc::CreateEnvironment(), receive)) == accepted,
          "Negotiated encoder level must fit both the source and the fixed factory ceiling");
      Json router{{"codecs", Json::array({Json{{"mimeType", "video/H264"},
          {"parameters", receive.parameters}}})}};
      const auto accepts = [&](const auto& format) { return AcceptsEncodedFormat(format, minimum); };
      if (level >= minimum)
        check(peer_detail::SelectScreenSendCodec(router, accepts) == router["codecs"][0],
            "SFU router receive capability must cover the actual source level");
      else rejects([&] { peer_detail::SelectScreenSendCodec(router, accepts); });
    }
    context->source.reset();
    check(factory.GetSupportedFormats() == advertised, "Source retirement must not raise cached capabilities to Main6");
  }
  rejects([&] { CreateEncodedVideoFactory(50); });
  rejects([&] { CreateEncodedVideoFactory(61); });
  const auto verify_rate_estimate = [&](double fps, bool valid, std::uint32_t maximum_kbps = 20000) {
    std::vector<Json> feedback;
    auto rate_state = std::make_shared<State>(1, "cpu-rate-estimate", true,
        [&](std::string_view type, Json data) { data["type"] = type; feedback.push_back(std::move(data)); return true; });
    Encoder encoder(rate_state, MinimumEncodedLevel(rate_state->video));
    check(!encoder.GetEncoderInfo().has_trusted_rate_controller,
        "The external encoder must not claim perfectly applied rate control");
    webrtc::VideoCodec codec;
    codec.codecType = webrtc::kVideoCodecH264;
    codec.width = 1920; codec.height = 1080; codec.maxFramerate = 120;
    codec.startBitrate = 5000; codec.maxBitrate = maximum_kbps; codec.minBitrate = 64;
    codec.active = true; codec.mode = webrtc::VideoCodecMode::kScreensharing;
    codec.H264()->numberOfTemporalLayers = 1; codec.spatialLayers[0].numberOfTemporalLayers = 1;
    check(encoder.InitEncode(&codec, 4, 1200) == WEBRTC_VIDEO_CODEC_OK,
        "Device-free external rate-feedback encoder initialization failed");
    webrtc::VideoEncoder::RateControlParameters rates;
    rates.framerate_fps = fps;
    check(rates.bitrate.SetBitrate(0, 0, maximum_kbps * 1000 + 10000000), "Cannot set rate-estimate test allocation");
    encoder.SetRates(rates);
    check(rate_state->failed.load() != valid, "External H264 rate estimate validity was misclassified");
    if (valid) {
      const auto& event = feedback.back();
      check(event.at("type") == "source.encodedFeedback" && event.at("requestedFps") == fps &&
          event.at("fpsApplied").is_null(), "Arrival-rate feedback must remain explicit, not applied FPS");
      check(event.at("bitrateBps") == (fps > 0 ? maximum_kbps * 1000 : 0) &&
          rate_state->Snapshot().at("requestedFps") == 120,
          "Arrival estimates must preserve the bitrate ceiling and the120fps media configuration");
    } else {
      check(feedback.back().at("type") == "error" &&
          feedback.back().at("code") == "ERR_RTC_ENCODED_RATES",
          "Invalid rate feedback must surface a terminal error");
    }
    check(encoder.Release() == WEBRTC_VIDEO_CODEC_OK && rate_state->rates.empty(),
        "Rate-estimate checks must retire their actual encoder registration");
  };
  verify_rate_estimate(120.0, true, 80000);
  for (const auto fps : {0.0, 120.0, 240.001, 1000.0,
                        static_cast<double>((std::numeric_limits<std::uint32_t>::max)())})
    verify_rate_estimate(fps, true);
  for (const auto fps : {-1.0, std::numeric_limits<double>::quiet_NaN(),
                        std::numeric_limits<double>::infinity(),
                        static_cast<double>((std::numeric_limits<std::uint32_t>::max)()) + 1})
    verify_rate_estimate(fps, false);
  std::vector<Json> events;
  auto state = std::make_shared<State>(1, "cpu-encoded", true,
      [&](std::string_view type, Json data) { data["type"] = type; events.push_back(std::move(data)); return true; });
  state->rates.emplace(1, 20000000);
  state->rates.emplace(2, 10000000);
  state->Rates(1, 30000000, 120);
  check(events.back().at("bitrateBps") == 10000000 && events.back().at("requestedBitrateBps") == 30000000,
      "Shared-source bitrate ceiling/consumer minimum is not explicit");
  state->Rates(1, 0, 120);
  check(!events.back().at("paused").get<bool>(), "One paused peer must not mute an active peer");
  state->Rates(2, 0, 120);
  check(events.back().at("paused").get<bool>() && events.back().at("bitrateBps") == 0,
      "Zero aggregate feedback must pause admission");
  state->Rates(2, 1000000, 120);
  check(!events.back().at("paused").get<bool>(), "Positive feedback must be observable on resume");
  state->Keyframe(2);
  check(events.back().at("keyframeConfirmed") == false && events.back().at("maximumWaitMs") == 1500,
      "Keyframe request must not fabricate an observed IDR");
  state->EncoderClosed(1);
  state->EncoderClosed(2);
  check(state->rates.empty(), "Released encoder sessions must leave no feedback registrations");
  auto token = std::make_shared<Token>();
  token->owner = state;
  auto dispatch = webrtc::make_ref_counted<NativeBuffer>(token);
  auto second_reference = dispatch;
  dispatch = nullptr;
  check(!token->dispatch_retired.load() && state->buffers.size() == 1,
      "Compressed dispatch cannot advance while RTC retains the native buffer");
  second_reference = nullptr;
  check(token->dispatch_retired.load() && state->buffers.empty(),
      "Actual frame-buffer retirement must unblock the next compressed dispatch");
  check(state->Snapshot().at("rawConversions") == 0, "Pure encoded policies must not read pixels");
  const auto retain = [&](std::uint64_t id) {
    auto value = std::make_shared<Token>();
    value->owner = state; value->metadata.frame_id = id; value->bytes = {1, 2, 3};
    value->generation = state->generation; value->admitted = true;
    state->retained.emplace(id, value); state->retained_bytes += value->bytes.size(); ++state->admitted;
    return value;
  };
  auto missing = retain(1), queued = retain(2);
  missing->expected.store(1); state->queue.push_back(queued);
  auto dropped_buffer = webrtc::make_ref_counted<NativeBuffer>(missing);
  const auto before_generation = state->generation;
  dropped_buffer = nullptr;
  check(missing->dispatch_retired.load() && missing->unconsumed.load() && !state->failed.load(),
      "A real pre-codec RTC discard must request recovery before releasing dispatch credit");
  check(state->generation == before_generation + 1 && state->need_idr && state->recovering &&
      state->queue.empty() && queued->cancelled.load() && state->recovery_discards == 1,
      "A discarded compressed picture must fence its queued dependencies");
  check(state->retained.size() == 2, "Recovery must not fabricate compressed-byte retirement");
  queued.reset();
  check(state->retained.size() == 1 && state->released == 1, "Only actual reference retirement returns copy credit");
  state->Recover(before_generation, 1, "rtc-unconsumed");
  check(state->recovery_requests == 1, "An old epoch must not invalidate a newer recovery again");
  auto replacement = retain(3);
  replacement->metadata.keyframe = 1;
  state->Forwarded(*replacement);
  check(state->recovering, "IDR admission without callback acceptance must not complete recovery");
  missing->metadata.keyframe = 1; missing->accepted.store(1);
  state->Forwarded(*missing);
  check(state->recovering, "A callback from a retired generation must not complete recovery");
  replacement->accepted.store(1); state->Forwarded(*replacement);
  check(!state->recovering && state->recovery_completions == 1,
      "Only a current, actually accepted IDR completes compressed recovery");
  missing.reset(); replacement.reset();
  check(state->retained.empty() && state->retained_bytes == 0, "Recovery must eventually retire every owned byte");
  {
    CaptureClockMapping uncertain;
    uncertain.status = CaptureClockStatus::kSampleUncertain;
    const auto requests = state->recovery_requests, expired = state->expired;
    auto dependent = retain(8);
    state->queue.push_back(dependent);
    check(!state->AcceptClockMapping(uncertain, state->generation, 7) &&
        !state->failed.load() && state->need_idr && state->recovering &&
        dependent->cancelled.load() && state->queue.empty() && state->recovery_requests == requests + 1 &&
        state->expired == expired,
        "Uncertain clock sampling must fence compressed dependencies without terminating the source or counting expiry");
    dependent.reset();
    const auto deadline = state->recovery_started;
    check(!state->AcceptClockMapping(uncertain, state->generation, 9) && state->recovery_started == deadline,
        "Repeated uncertain clock sampling must not extend the recovery deadline");
    CaptureClockMapping valid;
    check(state->AcceptClockMapping(valid, state->generation, 10) && state->recovering,
        "A valid clock sample alone must not pretend that a replacement IDR was delivered");
    auto resumed = retain(10);
    resumed->metadata.keyframe = 1; resumed->accepted.store(1);
    state->Forwarded(*resumed);
    check(!state->recovering && !state->failed.load(), "A real current IDR must resume after uncertain clock sampling");
    resumed.reset();
    for (const auto status : {CaptureClockStatus::kInvalidTimestamp, CaptureClockStatus::kClockDiscontinuity,
                              CaptureClockStatus::kSourceResetRequired, CaptureClockStatus::kClosed}) {
      CaptureClockMapping invalid;
      invalid.status = status;
      rejects([&] { state->AcceptClockMapping(invalid, state->generation, 11); });
    }
  }
  state->Recover(state->generation, 4, "input-expired");
  const auto recovery_started = state->recovery_started;
  state->Recover(state->generation, 5, "publication-expired");
  check(state->expired == 2 && state->recovery_started == recovery_started,
      "Repeated discarded IDRs cannot keep extending the recovery deadline");
  state->recovery_started = Clock::now() - std::chrono::milliseconds(1501);
  rejects([&] { state->CheckRecoveryDeadline(); });
  rejects([&] { state->Recover(state->generation, 6, "codec-expired"); });
  state->recovering = false; state->stopping.store(true);
  const auto before_requests = state->recovery_requests;
  state->Recover(state->generation, 7, "codec-expired");
  check(state->recovery_requests == before_requests, "Shutdown must not restart compressed recovery");
  std::uint64_t previous_sequence = 0;
  for (const auto& event : events) {
    if (event.at("type") != "source.encodedFeedback") continue;
    const auto sequence = event.at("sequence").get<std::uint64_t>();
    check(sequence > previous_sequence, "Encoded feedback must be sequenced at actual delivery");
    previous_sequence = sequence;
  }
}

}  // namespace monky::native_rtc::engine
