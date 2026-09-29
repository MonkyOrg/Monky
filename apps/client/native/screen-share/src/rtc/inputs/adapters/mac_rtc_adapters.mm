#include "mac_rtc_adapters.h"
#include "codec_policy.h"
#include "engine_shared.h"
#include "videoDecoder.h"
#include "api/make_ref_counted.h"
#include "api/video/i420_buffer.h"
#include "common_video/h264/h264_common.h"
#include "libyuv/convert.h"
#include "rtc_base/logging.h"
#import <Foundation/Foundation.h>
#include <dispatch/dispatch.h>
#include <IOSurface/IOSurface.h>
#include <atomic>
#include <condition_variable>
#include <cstdio>
#include <map>
#include <mutex>

namespace monky::native_rtc::mac {
using Json = nlohmann::json;
namespace sv = monky::screen_video;
namespace capture = monky::screen::mac;
struct DecoderMetrics {
  struct Operation {
    uint64_t calls = 0, in_progress = 0, returned = 0;
    int64_t started_us = 0, completed_us = 0;
  };
  uint64_t completed = 0, submitted = 0;
  uint32_t width = 0, height = 0;
  std::optional<bool> hardware;
  std::map<std::string, Operation> operations;
};
struct NativeRtcContext::State {
  std::mutex mutex;
  std::condition_variable changed;
  std::map<const webrtc::VideoFrameBuffer*, std::weak_ptr<const PixelFrame>> buffers;
  std::vector<AdapterDiagnostic> diagnostics;
  std::map<uint64_t, std::shared_ptr<DecoderMetrics>> workers;
  const AdapterOptions options;
  std::atomic<std::uint64_t> next_decoder{0}, decoded{0}, failures{0}, readbacks{0};
  std::atomic<std::size_t> live_decoders{0};
  std::atomic<std::size_t> queued_callbacks{0};
  dispatch_queue_t output_queue = dispatch_queue_create("org.monky.screen.decoded", DISPATCH_QUEUE_SERIAL);
  explicit State(AdapterOptions value) : options(value) {}
  void Report(std::uint64_t id, const char* code, std::int32_t status, bool terminal) {
    std::lock_guard lock(mutex);
    AdapterDiagnostic diagnostic{};
    diagnostic.session_id = id;
    diagnostic.hresult = status;
    diagnostic.codec_status = WEBRTC_VIDEO_CODEC_ERROR;
    diagnostic.terminal = terminal;
    std::snprintf(diagnostic.code.data(), diagnostic.code.size(), "%s", code);
    std::snprintf(diagnostic.message.data(), diagnostic.message.size(), "%s", "Native VideoToolbox decoding failed");
    if (diagnostics.size() == 64) diagnostics.erase(diagnostics.begin());
    diagnostics.push_back(diagnostic);
    ++failures;
  }
};

namespace {
int64_t SteadyUs() {
  return std::chrono::duration_cast<std::chrono::microseconds>(
      std::chrono::steady_clock::now().time_since_epoch()).count();
}
class DecoderOperation {
 public:
  DecoderOperation(NativeRtcContext::State& state, DecoderMetrics& metrics, const char* name)
      : state_(state), metrics_(metrics), name_(name) {
    std::lock_guard lock(state_.mutex);
    auto& operation = metrics_.operations[name_];
    ++operation.calls;
    ++operation.in_progress;
    operation.started_us = SteadyUs();
  }
  ~DecoderOperation() {
    std::lock_guard lock(state_.mutex);
    auto& operation = metrics_.operations.at(name_);
    --operation.in_progress;
    ++operation.returned;
    operation.completed_us = SteadyUs();
  }
 private:
  NativeRtcContext::State& state_;
  DecoderMetrics& metrics_;
  const char* name_;
};
void Require(bool value, const char* code) {
  if (!value) throw codec_policy::AdapterError(code, code);
}
class PixelBuffer : public webrtc::VideoFrameBuffer {
 public:
  PixelBuffer(std::shared_ptr<NativeRtcContext::State> state, CVPixelBufferRef pixel)
      : state_(std::move(state)), frame_(std::make_shared<PixelFrame>(pixel)) {
    Require(CVPixelBufferGetIOSurface(pixel) &&
        CVPixelBufferGetPixelFormatType(pixel) == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
        "ERR_RTC_MAC_PIXEL_FORMAT");
    std::lock_guard lock(state_->mutex);
    Require(state_->buffers.size() < state_->options.maximum_native_buffers, "ERR_RTC_MAC_BUFFER_LIMIT");
    state_->buffers.emplace(this, frame_);
  }
  ~PixelBuffer() override {
    std::lock_guard lock(state_->mutex);
    state_->buffers.erase(this);
    state_->changed.notify_all();
  }
  Type type() const override { return Type::kNative; }
  int width() const override { return static_cast<int>(CVPixelBufferGetWidth(frame_->pixel)); }
  int height() const override { return static_cast<int>(CVPixelBufferGetHeight(frame_->pixel)); }
  webrtc::scoped_refptr<webrtc::I420BufferInterface> ToI420() override {
    const auto pixel = frame_->pixel;
    if (CVPixelBufferLockBaseAddress(pixel, kCVPixelBufferLock_ReadOnly) != kCVReturnSuccess) {
      state_->Report(0, "ERR_RTC_MAC_READBACK_LOCK", 0, true);
      return nullptr;
    }
    struct Unlock {
      CVPixelBufferRef pixel;
      ~Unlock() { CVPixelBufferUnlockBaseAddress(pixel, kCVPixelBufferLock_ReadOnly); }
    } unlock{pixel};
    auto result = webrtc::I420Buffer::Create(width(), height());
    if (libyuv::NV12ToI420(
        static_cast<const uint8_t*>(CVPixelBufferGetBaseAddressOfPlane(pixel, 0)),
        static_cast<int>(CVPixelBufferGetBytesPerRowOfPlane(pixel, 0)),
        static_cast<const uint8_t*>(CVPixelBufferGetBaseAddressOfPlane(pixel, 1)),
        static_cast<int>(CVPixelBufferGetBytesPerRowOfPlane(pixel, 1)),
        result->MutableDataY(), result->StrideY(), result->MutableDataU(), result->StrideU(),
        result->MutableDataV(), result->StrideV(), width(), height()) != 0) {
      state_->Report(0, "ERR_RTC_MAC_READBACK", 0, true);
      return nullptr;
    }
    ++state_->readbacks;
    return result;
  }
 private:
  std::shared_ptr<NativeRtcContext::State> state_;
  std::shared_ptr<const PixelFrame> frame_;
};

using DecodeGate = codec_policy::CallbackGate<webrtc::DecodedImageCallback>;
struct DecoderOutput : std::enable_shared_from_this<DecoderOutput> {
  struct Metadata {
    uint32_t rtp;
    int64_t ntp_ms, render_ms;
    std::shared_ptr<webrtc::MonkyDecoderFrameInfoLease> frame_info;
  };
  std::shared_ptr<NativeRtcContext::State> state;
  std::shared_ptr<DecodeGate> callbacks;
  std::shared_ptr<DecoderMetrics> metrics;
  const uint64_t id, generation;
  std::atomic<bool> failed{false};
  std::mutex mutex;
  std::map<int64_t, Metadata> pending;
  DecoderOutput(std::shared_ptr<NativeRtcContext::State> context,
      std::shared_ptr<DecodeGate> gate, std::shared_ptr<DecoderMetrics> counters, uint64_t session, uint64_t epoch)
      : state(std::move(context)), callbacks(std::move(gate)), metrics(std::move(counters)), id(session), generation(epoch) {}
  void Receive(CVPixelBufferRef pixel, int64_t timestamp) {
    Metadata metadata;
    {
      std::lock_guard lock(mutex);
      const auto found = pending.find(timestamp);
      Require(found != pending.end(), "ERR_RTC_MAC_DECODER_IDENTITY");
      metadata = found->second;
      pending.erase(found);
    }
    if (failed) return;
    auto frame = webrtc::VideoFrame::Builder()
        .set_video_frame_buffer(webrtc::make_ref_counted<PixelBuffer>(state, pixel))
        .set_rtp_timestamp(metadata.rtp).set_ntp_time_ms(metadata.ntp_ms)
        .set_timestamp_us(metadata.render_ms > 0 ? metadata.render_ms * 1000 : 0)
        .set_color_space(codec_policy::Bt709Limited()).build();
    const auto owner = shared_from_this();
    // Never invoke WebRTC inside VideoToolbox's callback: a callback may release
    // its decoder, which must be able to wait for VideoToolbox without waiting on itself.
    ++state->queued_callbacks;
    dispatch_async(state->output_queue, ^{
      @autoreleasepool {
        try {
          if (!owner->failed && metadata.frame_info && metadata.frame_info->IsLive())
            owner->callbacks->Invoke(owner->generation, [&](webrtc::DecodedImageCallback& callback) {
            auto output = frame;
            callback.Decoded(output, std::nullopt, std::nullopt);
            {
              std::lock_guard lock(owner->state->mutex);
              ++owner->metrics->completed;
              ++owner->state->decoded;
            }
          });
        } catch (const std::exception& error) {
          RTC_LOG(LS_ERROR) << "VideoToolbox output callback: " << error.what();
          owner->failed = true;
          owner->state->Report(owner->id, "ERR_RTC_MAC_DECODER_CALLBACK", 0, true);
        }
        --owner->state->queued_callbacks;
        owner->state->changed.notify_all();
      }
    });
  }
};

class Decoder final : public webrtc::VideoDecoder {
 public:
  Decoder(std::shared_ptr<NativeRtcContext::State> state, codec_policy::NegotiatedH264 mode)
      : state_(std::move(state)), mode_(mode), id_(++state_->next_decoder) {}
  ~Decoder() override {
    Release();
    std::lock_guard lock(state_->mutex);
    state_->workers.erase(id_);
  }
  bool Configure(const Settings& settings) override {
    if (settings.codec_type() != webrtc::kVideoCodecH264 || settings.number_of_cores() <= 0) return false;
    try {
      callbacks_->Synchronize([&] {
        CloseCore();
        generation_ = callbacks_->Activate();
        configured_ = true;
      });
      return true;
    } catch (const std::exception& error) {
      RTC_LOG(LS_ERROR) << "VideoToolbox decoder configuration: " << error.what();
      state_->Report(id_, "ERR_RTC_MAC_DECODER_CONFIGURE", 0, true);
      return false;
    }
  }
  int32_t RegisterDecodeCompleteCallback(webrtc::DecodedImageCallback* callback) override {
    callbacks_->Register(callback);
    return WEBRTC_VIDEO_CODEC_OK;
  }
  int32_t Decode(const webrtc::EncodedImage& image, int64_t render_time_ms) override {
    int32_t result = WEBRTC_VIDEO_CODEC_ERROR;
    callbacks_->Synchronize([&] { result = DecodeLocked(image, render_time_ms); });
    return result;
  }
  int32_t Release() override {
    int32_t result = WEBRTC_VIDEO_CODEC_OK;
    callbacks_->Synchronize([&] {
      callbacks_->Clear();
      configured_ = false;
      try { CloseCore(); }
      catch (const std::exception& error) {
        RTC_LOG(LS_ERROR) << "VideoToolbox decoder retirement: " << error.what();
        state_->Report(id_, "ERR_RTC_MAC_DECODER_CLOSE", 0, true);
        result = WEBRTC_VIDEO_CODEC_ERROR;
      }
    });
    return result;
  }
  DecoderInfo GetDecoderInfo() const override {
    DecoderInfo info{"VideoToolbox H264", hardware_.load()};
    info.monky_frame_info_lease_limit = 8;
    return info;
  }
 private:
  int32_t DecodeLocked(const webrtc::EncodedImage& image, int64_t render_time_ms) {
    try {
      Require(configured_ && callbacks_->HasCallback(generation_), "ERR_RTC_MAC_DECODER_STATE");
      Require(image.data() && image.size() && image.size() <= 4 * 1024 * 1024, "ERR_RTC_MAC_DECODER_SIZE");
      const auto nals = webrtc::H264::FindNaluIndices({image.data(), image.size()});
      Require(!nals.empty() && nals.size() <= 4096 && nals.front().start_offset == 0,
          "ERR_RTC_MAC_DECODER_ANNEX_B");
      std::optional<sv::H264Sps> sps;
      bool keyframe = false;
      for (const auto& nal : nals) {
        Require(nal.payload_size > 0, "ERR_RTC_MAC_DECODER_NAL");
        const auto type = image.data()[nal.payload_start_offset] & 31;
        keyframe |= type == 5;
        if (type == 7)
          sps = sv::ParseH264Sps({image.data() + nal.payload_start_offset, nal.payload_size});
      }
      if (sps) {
        Require(sps->width >= 4 && sps->width <= 3840 && sps->height >= 2 && sps->height <= 2160 &&
            !(sps->width & 1) && !(sps->height & 1) && sps->levelIdc <= mode_.level &&
            sv::MatchesH264Profile(*sps, mode_.profile) && sv::IsBt709LimitedCompatible(*sps),
            "ERR_RTC_MAC_DECODER_SPS");
        if (width_ != sps->width || height_ != sps->height) {
          Require(keyframe, "ERR_RTC_MAC_DECODER_RESIZE");
          CloseCore();
          width_ = sps->width; height_ = sps->height;
        }
      }
      if (output_ && output_->failed.load()) {
        if (!keyframe) return WEBRTC_VIDEO_CODEC_ERROR;
        CloseCore();
      }
      if (!core_) {
        if (!keyframe || !sps) return WEBRTC_VIDEO_CODEC_ERROR;
        auto count = state_->live_decoders.load();
        do { Require(count < state_->options.maximum_workers, "ERR_RTC_MAC_DECODER_LIMIT"); }
        while (!state_->live_decoders.compare_exchange_weak(count, count + 1));
        try {
          {
            std::lock_guard lock(state_->mutex);
            state_->workers.emplace(id_, metrics_);
            metrics_->width = width_;
            metrics_->height = height_;
            metrics_->hardware.reset();
          }
          const DecoderOperation operation(*state_, *metrics_, "core-create");
          const auto output = std::make_shared<DecoderOutput>(state_, callbacks_, metrics_, id_, generation_);
          core_ = std::make_unique<capture::VideoDecoder>(width_, height_,
            [output](CVPixelBufferRef pixel, int64_t timestamp) { output->Receive(pixel, timestamp); },
            [output](const char* code, OSStatus status) {
              output->failed = true;
              output->state->Report(output->id, code, status, false);
            });
          output_ = output;
        } catch (...) {
          --state_->live_decoders;
          state_->changed.notify_all();
          throw;
        }
      }
      const auto rtp = image.RtpTimestamp();
      if (last_rtp_) {
        const auto delta = static_cast<int32_t>(rtp - *last_rtp_);
        Require(delta > 0, "ERR_RTC_MAC_DECODER_TIMESTAMP");
        unwrapped_rtp_ += static_cast<uint32_t>(delta);
      } else unwrapped_rtp_ = rtp;
      last_rtp_ = rtp;
      const auto timestamp = static_cast<int64_t>(unwrapped_rtp_ * 1000000 / 90000);
      {
        std::lock_guard lock(output_->mutex);
        Require(output_->pending.size() < 8, "ERR_RTC_MAC_DECODER_BACKPRESSURE");
        Require(image.MonkyFrameInfoLease() != nullptr, "ERR_RTC_MAC_DECODER_METADATA");
        Require(output_->pending.emplace(timestamp, DecoderOutput::Metadata{
            rtp, image.NtpTimeMs(), render_time_ms, image.MonkyFrameInfoLease()}).second,
            "ERR_RTC_MAC_DECODER_TIMESTAMP");
      }
      capture::EncodedFrame input;
      input.bytes.assign(image.data(), image.data() + image.size());
      input.timestamp_us = timestamp;
      input.duration_us = 0;
      input.keyframe = keyframe;
      {
        const DecoderOperation operation(*state_, *metrics_, "core-pump");
        core_->Submit(input);
      }
      const auto hardware = core_->Hardware();
      hardware_.store(hardware.value_or(false));
      {
        std::lock_guard lock(state_->mutex);
        ++metrics_->submitted;
        metrics_->hardware = hardware;
      }
      return output_->failed ? WEBRTC_VIDEO_CODEC_ERROR : WEBRTC_VIDEO_CODEC_OK;
    } catch (const std::exception& error) {
      RTC_LOG(LS_ERROR) << "VideoToolbox screen decoder: " << error.what();
      if (output_) output_->failed = true;
      state_->Report(id_, "ERR_RTC_MAC_DECODER_INPUT", 0, false);
      return WEBRTC_VIDEO_CODEC_ERROR;
    }
  }
  void CloseCore() {
    hardware_.store(false);
    if (output_) output_->failed = true;
    if (core_) {
      const DecoderOperation operation(*state_, *metrics_, "core-stop");
      core_->Close();
      core_.reset();
      --state_->live_decoders;
      state_->changed.notify_all();
    }
    output_.reset();
    last_rtp_.reset();
    unwrapped_rtp_ = 0;
  }
  std::shared_ptr<NativeRtcContext::State> state_;
  codec_policy::NegotiatedH264 mode_;
  const uint64_t id_;
  const std::shared_ptr<DecodeGate> callbacks_ = std::make_shared<DecodeGate>();
  uint64_t generation_ = 0, unwrapped_rtp_ = 0;
  std::optional<uint32_t> last_rtp_;
  uint32_t width_ = 0, height_ = 0;
  bool configured_ = false;
  std::shared_ptr<DecoderOutput> output_;
  const std::shared_ptr<DecoderMetrics> metrics_ = std::make_shared<DecoderMetrics>();
  std::atomic<bool> hardware_{false};
  std::unique_ptr<capture::VideoDecoder> core_;
};

class DecoderFactory final : public webrtc::VideoDecoderFactory {
 public:
  explicit DecoderFactory(std::shared_ptr<NativeRtcContext::State> state) : state_(std::move(state)) {}
  std::vector<webrtc::SdpVideoFormat> GetSupportedFormats() const override {
    return codec_policy::SupportedFormats(state_->options.maximum_h264_level);
  }
  CodecSupport QueryCodecSupport(const webrtc::SdpVideoFormat& format, bool scaling) const override {
    return {!scaling && codec_policy::ParseFormat(format, state_->options.maximum_h264_level).has_value(), false};
  }
  std::unique_ptr<webrtc::VideoDecoder> Create(const webrtc::Environment&, const webrtc::SdpVideoFormat& format) override {
    const auto mode = codec_policy::ParseFormat(format, state_->options.maximum_h264_level);
    return mode ? std::make_unique<Decoder>(state_, *mode) : nullptr;
  }
 private:
  std::shared_ptr<NativeRtcContext::State> state_;
};
}

NativeRtcContext::NativeRtcContext(std::shared_ptr<State> state) : state_(std::move(state)) {}
NativeRtcContext::~NativeRtcContext() = default;
std::shared_ptr<const PixelFrame> NativeRtcContext::GetDecodedFrame(
    const webrtc::scoped_refptr<webrtc::VideoFrameBuffer>& buffer) const {
  std::lock_guard lock(state_->mutex);
  const auto found = state_->buffers.find(buffer.get());
  return found == state_->buffers.end() ? nullptr : found->second.lock();
}
std::vector<AdapterDiagnostic> NativeRtcContext::TakeDiagnostics() {
  std::lock_guard lock(state_->mutex);
  return std::exchange(state_->diagnostics, {});
}
Json NativeRtcContext::Snapshot() const {
  const auto start = std::chrono::steady_clock::now();
  std::lock_guard lock(state_->mutex);
  const auto now = std::chrono::steady_clock::now();
  const auto observed = std::chrono::duration_cast<std::chrono::microseconds>(now.time_since_epoch()).count();
  const auto copy_ms = std::chrono::duration<double, std::milli>(now - start).count();
  auto decoders = Json::array();
  for (const auto& [id, worker] : state_->workers) {
    auto operations = Json::object();
    for (const auto& [name, operation] : worker->operations)
      operations[name] = {{"calls", operation.calls}, {"inProgress", operation.in_progress},
        {"returned", operation.returned}, {"lastStartSteadyUs", operation.started_us},
        {"lastCompletionSteadyUs", operation.completed_us}};
    decoders.push_back({{"sessionId", id}, {"backend", "VideoToolbox"},
      {"hardwareExecutionObserved", worker->hardware ? Json(*worker->hardware) : Json(nullptr)},
      {"core", {{"submitted", worker->submitted}, {"gpuFrames", worker->completed},
        {"width", worker->width}, {"height", worker->height}}},
      {"diagnostics", {{"observedAtSteadyUs", observed}, {"snapshotCopyMs", copy_ms},
        {"operations", std::move(operations)},
        {"clock", "process-steady-clock"}, {"counterScope", "decoder-worker-lifetime"},
        {"output", {{"outcomes", {{"callback-completed", worker->completed}}}}}}}});
  }
  return {{"backend", "VideoToolbox"}, {"liveWorkers", state_->live_decoders.load()},
      {"nativeBuffers", state_->buffers.size()}, {"decodedGpuFrames", state_->decoded.load()},
      {"i420Readbacks", state_->readbacks.load()}, {"errors", state_->failures.load()},
      {"observedAtSteadyUs", observed}, {"decoders", std::move(decoders)},
      {"clock", "process-steady-clock"}};
}
bool NativeRtcContext::WaitForIdle(std::chrono::milliseconds timeout) {
  std::unique_lock lock(state_->mutex);
  return state_->changed.wait_for(lock, timeout, [&] {
    return state_->buffers.empty() && state_->live_decoders == 0 && state_->queued_callbacks == 0;
  });
}
FactoryBundle CreateFactoryBundle(const AdapterOptions& options) {
  Require(codec_policy::IsSupportedLevel(options.maximum_h264_level) &&
      options.maximum_workers > 0 && options.maximum_workers <= 32 &&
      options.maximum_native_buffers > 0 && options.maximum_native_buffers <= 256, "ERR_RTC_MAC_OPTIONS");
  auto state = std::make_shared<NativeRtcContext::State>(options);
  return {std::make_shared<NativeRtcContext>(state), nullptr, std::make_unique<DecoderFactory>(state)};
}
std::shared_ptr<const PixelFrame> UploadCpuFrame(const webrtc::VideoFrame& input) {
  const auto& buffer = input.video_frame_buffer();
  Require(buffer && buffer->type() == webrtc::VideoFrameBuffer::Type::kI420 &&
      input.width() >= 4 && input.width() <= 3840 && input.height() >= 2 && input.height() <= 2160 &&
      !(input.width() & 1) && !(input.height() & 1), "ERR_RTC_MAC_AV1_OUTPUT");
  const auto pixels = buffer->GetI420();
  Require(pixels != nullptr, "ERR_RTC_MAC_AV1_PLANES");
  CVPixelBufferRef pixel = nullptr;
  NSDictionary* attributes = @{(__bridge NSString*)kCVPixelBufferIOSurfacePropertiesKey: @{},
      (__bridge NSString*)kCVPixelBufferMetalCompatibilityKey: @YES};
  Require(CVPixelBufferCreate(kCFAllocatorDefault, input.width(), input.height(),
      kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, (__bridge CFDictionaryRef)attributes, &pixel)
      == kCVReturnSuccess, "ERR_RTC_MAC_AV1_SURFACE");
  struct Release { CVPixelBufferRef pixel; ~Release() { CVPixelBufferRelease(pixel); } } release{pixel};
  Require(CVPixelBufferLockBaseAddress(pixel, 0) == kCVReturnSuccess, "ERR_RTC_MAC_AV1_LOCK");
  const auto result = libyuv::I420ToNV12(pixels->DataY(), pixels->StrideY(), pixels->DataU(), pixels->StrideU(),
      pixels->DataV(), pixels->StrideV(), static_cast<uint8_t*>(CVPixelBufferGetBaseAddressOfPlane(pixel, 0)),
      static_cast<int>(CVPixelBufferGetBytesPerRowOfPlane(pixel, 0)),
      static_cast<uint8_t*>(CVPixelBufferGetBaseAddressOfPlane(pixel, 1)),
      static_cast<int>(CVPixelBufferGetBytesPerRowOfPlane(pixel, 1)), input.width(), input.height());
  CVPixelBufferUnlockBaseAddress(pixel, 0);
  Require(result == 0, "ERR_RTC_MAC_AV1_CONVERSION");
  return std::make_shared<PixelFrame>(pixel);
}
}

namespace monky::native_rtc::engine {
std::shared_ptr<VideoSource> CreateGpuSource(
    Host&, std::uint64_t, const Json&, const std::shared_ptr<Cancellation>&) {
  throw Error("ERR_RTC_INPUT_MODE", "Native macOS publication requires encoded capture", MONKY_ENGINE_UNSUPPORTED);
}
}
