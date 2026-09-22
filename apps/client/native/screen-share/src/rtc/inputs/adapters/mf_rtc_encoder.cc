#include "mf_rtc_internal.h"
#include "mf_rtc_encoder_submit_checks.h"

#include "api\environment\environment_factory.h"
#include "api\make_ref_counted.h"
#include "modules\video_coding\include\video_codec_interface.h"

#include <limits>
#include <numeric>
#include <string_view>

namespace monky::native_rtc::mf::detail {
namespace {

using EncodeGate = CallbackGate<webrtc::EncodedImageCallback>;

struct EncoderSubmitChecksAccess;

struct EncodeMetadata {
  std::uint64_t pause_epoch = 0;
  std::uint32_t rtp = 0;
  std::int64_t capture_us = 0, ntp_ms = 0, encode_start_ms = 0;
  std::int64_t duration_us = 0;
  webrtc::VideoRotation rotation = webrtc::kVideoRotation_0;
  std::optional<webrtc::Timestamp> presentation;
  std::uint16_t tracking_id = webrtc::VideoFrame::kNotSetId;
  bool requested_keyframe = false;
  std::shared_ptr<Budget::Ticket> admission;
};

struct EncodeInput {
  std::shared_ptr<NativeLease> lease;
  EncodeMetadata metadata;
  std::uint64_t pause_epoch = 0;
  std::shared_ptr<EncoderInputDiagnosticTicket> diagnostic;
};

class EncoderWorker final : public Worker {
 public:
  EncoderWorker(const webrtc::Environment& env, std::shared_ptr<SharedState> state,
                NegotiatedH264 negotiated, EncoderSetup setup,
                std::shared_ptr<EncodeGate> callbacks, std::uint64_t generation)
      : Worker(std::move(state)), env_(env), negotiated_(negotiated), setup_(std::move(setup)),
        callbacks_(std::move(callbacks)), generation_(generation),
        admission_(std::make_shared<Budget>(setup_.core.maxInFlight, 0)),
        diagnostics_(std::make_shared<EncoderDiagnosticLedger>(
            setup_.initial_bitrate, static_cast<double>(setup_.core.fps))),
        rates_{setup_.initial_bitrate, static_cast<double>(setup_.core.fps)},
        limiter_(setup_.core.fps), paused_(setup_.initial_bitrate == 0) {}

  const EncoderSetup& setup() const { return setup_; }

  std::int32_t Submit(const webrtc::VideoFrame& frame,
                      const std::vector<webrtc::VideoFrameType>* frame_types) {
    ++encode_requests_;
    EncoderSubmitDiagnostic submission(*diagnostics_);
    if (status() != WEBRTC_VIDEO_CODEC_OK) {
      submission.Select(EncoderSubmitOutcome::WorkerStatus);
      return status();
    }
    if (stopping()) {
      submission.Select(EncoderSubmitOutcome::Stopping);
      return WEBRTC_VIDEO_CODEC_UNINITIALIZED;
    }
    if (!callbacks_->HasCallback(generation_)) {
      submission.Select(EncoderSubmitOutcome::NoCallback);
      return WEBRTC_VIDEO_CODEC_UNINITIALIZED;
    }
    bool dropped = false;
    std::int32_t result = WEBRTC_VIDEO_CODEC_OK;
    const auto error = Protect([&] {
      bool keyframe = false, empty = false;
      if (frame_types && !frame_types->empty()) {
        if (frame_types->size() != 1) {
          submission.Select(EncoderSubmitOutcome::Validation);
          throw AdapterError("ERR_RTC_FRAME_LAYERS", "Only one frame type/layer is supported",
                             WEBRTC_VIDEO_CODEC_ERR_SIMULCAST_PARAMETERS_NOT_SUPPORTED);
        }
        keyframe = frame_types->front() == webrtc::VideoFrameType::kVideoFrameKey;
        empty = frame_types->front() == webrtc::VideoFrameType::kEmptyFrame;
        if (!keyframe && !empty && frame_types->front() != webrtc::VideoFrameType::kVideoFrameDelta) {
          submission.Select(EncoderSubmitOutcome::Validation);
          throw AdapterError("ERR_RTC_FRAME_TYPE", "Unsupported encoded frame request");
        }
      }
      auto lease = state()->Lookup(frame.video_frame_buffer());
      if (!lease) {
        submission.Select(EncoderSubmitOutcome::Validation);
        throw AdapterError("ERR_RTC_NATIVE_BUFFER",
                           "Encoder requires a real GPU lease registered by this factory bundle");
      }
      if (frame.width() != static_cast<int>(setup_.core.width) ||
          frame.height() != static_cast<int>(setup_.core.height) ||
          lease->visible.x || lease->visible.y ||
          lease->visible.width != setup_.core.width ||
          lease->visible.height != setup_.core.height ||
          (lease->decoded && (lease->decoded->codedWidth != setup_.core.width ||
                              lease->decoded->codedHeight != setup_.core.height))) {
        submission.Select(EncoderSubmitOutcome::Validation);
        throw AdapterError("ERR_RTC_ENCODER_GEOMETRY",
                           "Native input must match the full, unscaled encoder texture geometry");
      }
      if (frame.timestamp_us() < 0 ||
          (frame.color_space() && !IsBt709Limited(*frame.color_space()))) {
        submission.Select(EncoderSubmitOutcome::Validation);
        throw AdapterError("ERR_RTC_FRAME_METADATA",
                           "Input requires a valid RTC timestamp and BT.709-limited pixels");
      }
      switch (frame.rotation()) {
        case webrtc::kVideoRotation_0: case webrtc::kVideoRotation_90:
        case webrtc::kVideoRotation_180: case webrtc::kVideoRotation_270: break;
        default:
          submission.Select(EncoderSubmitOutcome::Validation);
          throw AdapterError("ERR_RTC_ROTATION", "Invalid video rotation metadata");
      }
      EncodeInput input;
      input.lease = std::move(lease);
      input.metadata.rtp = frame.rtp_timestamp();
      input.metadata.capture_us = frame.timestamp_us();
      input.metadata.ntp_ms = frame.ntp_time_ms();
      input.metadata.duration_us = input.lease->frame->durationUs;
      input.metadata.rotation = frame.rotation();
      input.metadata.presentation = frame.presentation_timestamp();
      input.metadata.tracking_id = frame.id();
      {
        std::lock_guard lock(policy_mutex_);
        force_key_requested_ = force_key_requested_ || keyframe;
        if (rate_error_.load() != WEBRTC_VIDEO_CODEC_OK) {
          submission.Select(EncoderSubmitOutcome::RateError);
          result = rate_error_.load();
          return;
        }
        if (rates_.bitrate == 0 || empty) {
          submission.Select(rates_.bitrate == 0
              ? EncoderSubmitOutcome::Paused : EncoderSubmitOutcome::EmptyFrame);
          dropped = true;
          return;
        }
        auto rtp_timeline = rtp_timeline_;
        try {
          rtp_timeline.Push(frame.rtp_timestamp());
          if (!limiter_.Accept(input.lease->frame->timestampUs)) {
            submission.Select(EncoderSubmitOutcome::RateLimited);
            dropped = true;
            return;
          }
        } catch (const AdapterError&) {
          submission.Select(EncoderSubmitOutcome::Validation);
          throw;
        }
        input.metadata.admission = admission_->Acquire(0);
        if (!input.metadata.admission) {
          submission.Select(EncoderSubmitOutcome::AdmissionFull);
          dropped = true;
          return;
        }
        input.metadata.requested_keyframe = force_key_requested_;
        input.pause_epoch = pause_epoch_;
        input.metadata.pause_epoch = pause_epoch_;
        input.diagnostic = std::make_shared<EncoderInputDiagnosticTicket>(diagnostics_);
        auto* input_diagnostic = input.diagnostic.get();
        // Queue publication and pause/rate policy use one lock, so a pause
        // cannot accidentally admit a new frame from an older policy epoch.
        if (!PostMedia([this, input = std::move(input)]() mutable {
              auto* diagnostic = input.diagnostic.get();
              diagnostic->Dispatched();
              try {
                pending_.push_back(std::move(input));
              } catch (...) {
                diagnostic->ReleaseAs(EncoderInputReleaseReason::Exception);
                throw;
              }
              diagnostic->Pending();
            }, input_diagnostic)) {
          submission.Select(EncoderSubmitOutcome::PostMediaRejected);
          dropped = true;
          result = stopping() ? WEBRTC_VIDEO_CODEC_UNINITIALIZED : WEBRTC_VIDEO_CODEC_OK;
          return;
        }
        rtp_timeline_ = rtp_timeline;
        force_key_requested_ = false;
        submission.Select(EncoderSubmitOutcome::Queued);
      }
    });
    if (error) {
      Report(*error);
      return error->codec_status;
    }
    if (dropped) NotifyDropped();
    return result;
  }

  void UpdateRates(const webrtc::VideoEncoder::RateControlParameters& parameters) {
    const auto error = Protect([&] {
      const auto next = ValidateRates(parameters, setup_);
      callbacks_->Synchronize([&] {
        std::lock_guard lock(policy_mutex_);
        if (stopping()) {
          throw AdapterError("ERR_RTC_ENCODER_STOPPED", "SetRates called on a stopping encoder",
                             WEBRTC_VIDEO_CODEC_UNINITIALIZED);
        }
        const bool changing_pause = (rates_.bitrate == 0) != (next.bitrate == 0);
        if (changing_pause || rate_error_.load() != WEBRTC_VIDEO_CODEC_OK) {
          ++pause_epoch_;
          force_key_requested_ = true;
          limiter_.Reset();
        }
        if (next.fps != rates_.fps) limiter_.SetFps(next.fps);
        rates_ = next;
        rtc_requested_fps_ = parameters.framerate_fps;
        diagnostics_->ObserveRates(
            parameters.target_bitrate.get_sum_bps(), parameters.bitrate.get_sum_bps(),
            parameters.bandwidth_allocation.IsFinite()
                ? std::optional<std::int64_t>(parameters.bandwidth_allocation.bps())
                : std::nullopt,
            parameters.framerate_fps, next.fps);
        ++rates_revision_;
        rate_error_.store(WEBRTC_VIDEO_CODEC_OK);
        paused_.store(next.bitrate == 0);
      });
      Wake();
    });
    if (error) {
      callbacks_->Synchronize([&] { rate_error_.store(error->codec_status); });
      Report(*error);
      Wake();
    }
  }

  std::int32_t Stop() {
    const bool inside_callback = callbacks_->IsInvokingOnCurrentThread();
    RevokeCallbacks();
    RequestStop();
    return inside_callback ? status() : WaitForMediaStop();
  }

 protected:
  void RevokeCallbacks() override { callbacks_->Deactivate(generation_); }
  void Initialize() override { PublishSnapshot(); }

  void BeforeWork() override {
    ApplyRates();
    const bool paused = paused_.load();
    if (paused || rate_error_.load() != WEBRTC_VIDEO_CODEC_OK) {
      const auto reason = paused ? EncoderInputReleaseReason::Paused : EncoderInputReleaseReason::RateError;
      const auto queued = CancelQueuedMedia(reason);
      DropPending(reason);
      for (std::size_t i = 0; i < queued; ++i) NotifyDropped();
    }
  }

  void PumpCore() override {
    if (core_) {
      core_->Pump();
      RefreshCoreStats();
    }
    if (stopping()) return;
    ApplyRates();
    const bool paused = paused_.load();
    if (paused || rate_error_.load() != WEBRTC_VIDEO_CODEC_OK) {
      DropPending(paused ? EncoderInputReleaseReason::Paused : EncoderInputReleaseReason::RateError);
      return;
    }
    while (!pending_.empty() && !stopping()) {
      auto& input = pending_.front();
      std::uint64_t epoch;
      {
        std::lock_guard lock(policy_mutex_);
        epoch = pause_epoch_;
      }
      const bool stale_epoch = input.pause_epoch != epoch;
      if (stale_epoch || drop_next_.exchange(false)) {
        input.diagnostic->ReleaseAs(stale_epoch
            ? EncoderInputReleaseReason::PauseEpoch : EncoderInputReleaseReason::RtcDropNext);
        force_key_on_worker_ = force_key_on_worker_ || input.metadata.requested_keyframe;
        pending_.pop_front();
        NotifyDropped();
        continue;
      }
      if (!input.diagnostic->SourceReady([&] {
            return SourceReady(input.lease, input.metadata.admission);
          })) break;
      if (!core_) {
        device_ = input.lease->device;
        context_ = input.lease->context;
        core_ = std::make_unique<sv::MfH264Encoder>(
            device_.get(), context_.get(), setup_.core,
            [this](sv::EncodedPacket&& packet) { return OnPacket(std::move(packet)); });
        applied_bitrate_ = setup_.core.bitrateBps;
        applied_revision_ = 0;
        ApplyRates();
        RefreshCoreStats();
      }
      if (paused_.load() || rate_error_.load() != WEBRTC_VIDEO_CODEC_OK) break;
      const bool periodic_key = setup_.keyframe_interval &&
          frames_since_key_submission_ >= setup_.keyframe_interval;
      const bool key = input.metadata.requested_keyframe || force_key_on_worker_ || periodic_key;
      if (stats_.inFlight >= setup_.core.maxInFlight) {
        diagnostics_->CoreCapacityDeferred();
        break;
      }
      if (key && stats_.inFlight != 0) {
        diagnostics_->KeyframeDrainDeferred();
        break;
      }

      // CodecAPI's force-keyframe control targets the NEXT ProcessInput, not
      // the next TryEncode. Retire older inputs first to preserve that identity.
      if (key) core_->RequestKeyFrame();
      auto metadata = input.metadata;
      metadata.requested_keyframe = key;
      metadata.encode_start_ms = env_.clock().TimeInMilliseconds();
      const auto timestamp = input.lease->frame->timestampUs;
      if (!submitted_.emplace(timestamp, std::move(metadata)).second) {
        throw AdapterError("ERR_RTC_ENCODER_PTS", "Duplicate source PTS in encoder metadata");
      }
      if (!input.diagnostic->TryEncode([&] {
            return core_->TryEncode(input.lease->Alias(input.lease));
          })) {
        submitted_.erase(timestamp);
        break;
      }
      force_key_on_worker_ = false;
      frames_since_key_submission_ = key ? 1 : frames_since_key_submission_ + 1;
      pending_.pop_front();
      core_->Pump();
      RefreshCoreStats();
    }
  }

  void BeginStopCore() override {
    ClearPending(status() != WEBRTC_VIDEO_CODEC_OK
        ? EncoderInputReleaseReason::WorkerError : EncoderInputReleaseReason::Stopped);
    if (core_ && !core_->Finished()) core_->BeginDrain();
  }
  void AbortCore() override {
    ClearPending(status() != WEBRTC_VIDEO_CODEC_OK
        ? EncoderInputReleaseReason::WorkerError : EncoderInputReleaseReason::Stopped);
    if (core_ && !core_->Finished()) core_->Abort();
    submitted_.clear();
  }
  bool CoreFinished() const override { return !core_ || core_->Finished(); }
  bool CorePending() const override {
    return !pending_.empty() || (core_ && !core_->Finished() &&
        (stats_.inFlight != 0 || stopping()));
  }
  HANDLE CoreEvent() const override { return core_ ? core_->WakeEvent() : nullptr; }
  void DestroyCore() noexcept override {
    core_.reset();
    submitted_.clear();
    ClearPending(EncoderInputReleaseReason::Abandoned);
    context_ = nullptr;
    device_ = nullptr;
  }
  sv::I420Image ReadFrame(const NativeLease&, ID3D11Fence*) override {
    throw AdapterError("ERR_RTC_ENCODER_READBACK",
                       "Source/decoder workers own native buffers, not the encoder worker");
  }

 private:
  friend struct EncoderSubmitChecksAccess;

  void RefreshCoreStats() {
    stats_ = core_->GetStats();
    core_observed_ = true;
    PublishSnapshot();
  }

  void PublishSnapshot() {
    EncoderRuntimeSnapshot snapshot;
    snapshot.session_id = id();
    snapshot.encode_requests = encode_requests_.load();
    snapshot.configured = setup_.core;
    snapshot.maximum_bitrate_bps = setup_.maximum_bitrate;
    snapshot.requested_keyframe_interval = setup_.keyframe_interval;
    {
      std::lock_guard lock(policy_mutex_);
      snapshot.requested_fps = rates_.fps;
      snapshot.rtc_requested_fps = rtc_requested_fps_;
      snapshot.requested_bitrate_bps = rates_.bitrate;
    }
    snapshot.pending_frames = pending_.size();
    snapshot.submitted_metadata = submitted_.size();
    snapshot.core_observed = core_observed_;
    snapshot.core = stats_;
    snapshot.diagnostic_ledger = diagnostics_;
    RecordEncoderSnapshot(std::move(snapshot));
  }

  void ApplyRates() {
    EncoderRates rates;
    std::uint64_t revision;
    {
      std::lock_guard lock(policy_mutex_);
      rates = rates_;
      revision = rates_revision_;
    }
    if (revision == applied_revision_ || rate_error_.load() != WEBRTC_VIDEO_CODEC_OK) return;
    if (core_ && rates.bitrate && rates.bitrate != applied_bitrate_) {
      core_->SetBitrate(rates.bitrate);
      applied_bitrate_ = rates.bitrate;
    }
    // MF's negotiated framerate remains the InitEncode ceiling. Fractional
    // and lower RTC rates are enforced against source PTS before admission.
    applied_revision_ = revision;
  }

  void NotifyDropped() {
    const auto error = Protect([&] {
      callbacks_->Invoke(generation_, [](webrtc::EncodedImageCallback& callback) {
        callback.OnDroppedFrame(webrtc::EncodedImageCallback::DropReason::kDroppedByEncoder);
      });
    });
    if (error) Fail(*error);
  }

  void ClearPending(EncoderInputReleaseReason reason) noexcept {
    for (const auto& input : pending_) input.diagnostic->ReleaseAs(reason);
    pending_.clear();
  }

  void DropPending(EncoderInputReleaseReason reason) {
    const auto count = pending_.size();
    for (const auto& input : pending_) {
      input.diagnostic->ReleaseAs(reason);
      force_key_on_worker_ = force_key_on_worker_ || input.metadata.requested_keyframe;
    }
    pending_.clear();
    for (std::size_t i = 0; i < count; ++i) NotifyDropped();
  }

  bool OnPacket(sv::EncodedPacket packet) {
    const auto found = submitted_.find(packet.timestampUs);
    if (found == submitted_.end() || packet.data.empty() ||
        packet.data.size() > kMaximumAccessUnitBytes ||
        packet.durationUs != found->second.duration_us ||
        (last_output_us_ && packet.timestampUs <= *last_output_us_)) {
      throw AdapterError("ERR_RTC_ENCODED_IDENTITY",
                         "Encoded AU does not correlate to exactly one admitted GPU frame",
                         WEBRTC_VIDEO_CODEC_ENCODER_FAILURE);
    }
    auto metadata = std::move(found->second);
    submitted_.erase(found);
    last_output_us_ = packet.timestampUs;
    if (metadata.requested_keyframe && !packet.keyFrame) {
      throw AdapterError("ERR_RTC_KEYFRAME_NOT_HONORED",
                         "MF did not produce an IDR for the requested GPU frame",
                         WEBRTC_VIDEO_CODEC_ENCODER_FAILURE);
    }
    const auto core_stats = core_->GetStats();
    if (!core_stats.info.spsVerified) {
      throw AdapterError("ERR_RTC_ENCODER_SPS", "Encoded AU lacks qualified SPS evidence");
    }
    ValidateSps(core_stats.info.sps, negotiated_, setup_.core.width, setup_.core.height);
    ++state()->encoded_access_units;
    std::uint64_t epoch;
    {
      std::lock_guard lock(policy_mutex_);
      epoch = pause_epoch_;
    }
    if (stopping() || metadata.pause_epoch != epoch || paused_.load() ||
        rate_error_.load() != WEBRTC_VIDEO_CODEC_OK ||
        (delivery_needs_keyframe_ && !packet.keyFrame)) {
      force_key_on_worker_ = true;
      delivery_needs_keyframe_ = true;
      NotifyDropped();
      return true;
    }
    webrtc::EncodedImage image;
    image.SetEncodedData(webrtc::EncodedImageBuffer::Create(packet.data.data(), packet.data.size()));
    image.SetRtpTimestamp(metadata.rtp);
    image._encodedWidth = setup_.core.width;
    image._encodedHeight = setup_.core.height;
    image.SetFrameType(packet.keyFrame ? webrtc::VideoFrameType::kVideoFrameKey
                                      : webrtc::VideoFrameType::kVideoFrameDelta);
    image.capture_time_ms_ = metadata.capture_us / 1000;
    image.ntp_time_ms_ = metadata.ntp_ms;
    image.rotation_ = metadata.rotation;
    image.content_type_ = setup_.content_type;
    image.SetPresentationTimestamp(metadata.presentation);
    image.SetColorSpace(Bt709Limited());
    image.SetVideoFrameTrackingId(metadata.tracking_id == webrtc::VideoFrame::kNotSetId
        ? std::nullopt : std::optional<std::uint16_t>(metadata.tracking_id));
    image.SetSimulcastIndex(0);
    image.SetEncodeTime(metadata.encode_start_ms, env_.clock().TimeInMilliseconds());
    webrtc::CodecSpecificInfo codec;
    codec.codecType = webrtc::kVideoCodecH264;
    codec.codecSpecific.H264.packetization_mode = webrtc::H264PacketizationMode::NonInterleaved;
    codec.codecSpecific.H264.temporal_idx = (std::numeric_limits<std::uint8_t>::max)();
    codec.codecSpecific.H264.base_layer_sync = false;
    codec.codecSpecific.H264.idr_frame = packet.keyFrame;
    codec.scalability_mode = webrtc::ScalabilityMode::kL1T1;
    codec.end_of_picture = true;
    bool delivered = false;
    callbacks_->Invoke(generation_, [&](webrtc::EncodedImageCallback& callback) {
      {
        std::lock_guard lock(policy_mutex_);
        if (metadata.pause_epoch != pause_epoch_ || rates_.bitrate == 0 ||
            rate_error_.load() != WEBRTC_VIDEO_CODEC_OK) return;
      }
      delivered = true;
      const auto result = callback.OnEncodedImage(image, &codec);
      if (result.error != webrtc::EncodedImageCallback::Result::OK) {
        if (result.error == webrtc::EncodedImageCallback::Result::ERROR_SEND_FAILED) {
          // RTC also returns this when a sender is paused with an AU in flight.
          ++state()->rtc_rejected_access_units;
        } else {
          Report(Diagnostic("ERR_RTC_ENCODED_CALLBACK", "RTC returned an unknown encoded callback error"));
        }
        force_key_on_worker_ = true;
        delivery_needs_keyframe_ = true;
      } else if (packet.keyFrame) {
        delivery_needs_keyframe_ = false;
      }
      if (result.drop_next_frame) drop_next_.store(true);
    });
    if (!delivered) {
      force_key_on_worker_ = true;
      delivery_needs_keyframe_ = true;
      NotifyDropped();
    }
    return true;
  }

  const webrtc::Environment env_;
  const NegotiatedH264 negotiated_;
  const EncoderSetup setup_;
  const std::shared_ptr<EncodeGate> callbacks_;
  const std::uint64_t generation_;
  const std::shared_ptr<Budget> admission_;
  const std::shared_ptr<EncoderDiagnosticLedger> diagnostics_;
  std::mutex policy_mutex_;
  EncoderRates rates_;
  std::optional<double> rtc_requested_fps_;
  SourceRateLimiter limiter_;
  RtpTimeline rtp_timeline_;
  std::uint64_t rates_revision_ = 1, pause_epoch_ = 0;
  bool force_key_requested_ = true;
  std::atomic<bool> paused_, drop_next_{false};
  std::atomic<std::uint64_t> encode_requests_{0};
  std::atomic<std::int32_t> rate_error_{WEBRTC_VIDEO_CODEC_OK};
  std::deque<EncodeInput> pending_;
  std::map<std::int64_t, EncodeMetadata> submitted_;
  std::unique_ptr<sv::MfH264Encoder> core_;
  winrt::com_ptr<ID3D11Device> device_;
  winrt::com_ptr<ID3D11DeviceContext4> context_;
  sv::EncoderStats stats_;
  bool core_observed_ = false;
  std::uint64_t applied_revision_ = 0, frames_since_key_submission_ = 0;
  std::uint32_t applied_bitrate_ = 0;
  bool force_key_on_worker_ = true, delivery_needs_keyframe_ = true;
  std::optional<std::int64_t> last_output_us_;
};

class MfVideoEncoder final : public webrtc::VideoEncoder {
 public:
  MfVideoEncoder(const webrtc::Environment& env, std::shared_ptr<SharedState> state,
                 NegotiatedH264 negotiated)
      : env_(env), state_(std::move(state)), negotiated_(negotiated),
        callbacks_(std::make_shared<EncodeGate>()) {}
  ~MfVideoEncoder() override { Release(); }

  int InitEncode(const webrtc::VideoCodec* codec,
                 const webrtc::VideoEncoder::Settings& settings) override {
    if (!codec) {
      state_->Report(0, Diagnostic("ERR_RTC_ENCODER_CONFIGURATION",
                                   "InitEncode requires codec settings",
                                   WEBRTC_VIDEO_CODEC_ERR_PARAMETER));
      return WEBRTC_VIDEO_CODEC_ERR_PARAMETER;
    }
    std::int32_t result = WEBRTC_VIDEO_CODEC_OK;
    const auto error = Protect([&] {
      const auto setup = MakeEncoderSetup(*codec, settings, negotiated_, state_->options);
      std::uint64_t initialization;
      const auto released = StopCurrent(&initialization);
      if (released == WEBRTC_VIDEO_CODEC_TIMEOUT) {
        result = released;
        return;
      }
      const auto generation = callbacks_->Activate();
      auto worker = std::make_shared<EncoderWorker>(
          env_, state_, negotiated_, setup, callbacks_, generation);
      {
        std::lock_guard lock(mutex_);
        if (initialization != initialization_) result = WEBRTC_VIDEO_CODEC_UNINITIALIZED;
        else worker_ = worker;
      }
      if (result != WEBRTC_VIDEO_CODEC_OK) {
        callbacks_->Deactivate(generation);
        return;
      }
      result = worker->Start();
      {
        std::lock_guard lock(mutex_);
        if (result == WEBRTC_VIDEO_CODEC_OK &&
            (initialization != initialization_ || worker->stopping())) {
          result = WEBRTC_VIDEO_CODEC_UNINITIALIZED;
        }
        if (result != WEBRTC_VIDEO_CODEC_OK && worker_ == worker) worker_.reset();
      }
      if (result != WEBRTC_VIDEO_CODEC_OK) {
        callbacks_->Deactivate(generation);
        worker->RequestStop();
        return;
      }
    });
    if (error) {
      state_->Report(0, *error);
      return error->codec_status;
    }
    return result;
  }
  std::int32_t InitEncode(const webrtc::VideoCodec* codec, std::int32_t cores,
                          std::size_t payload) override {
    return InitEncode(codec, Settings(Capabilities(false), cores, payload));
  }
  std::int32_t RegisterEncodeCompleteCallback(webrtc::EncodedImageCallback* callback) override {
    callbacks_->Register(callback);
    return WEBRTC_VIDEO_CODEC_OK;
  }
  std::int32_t Release() override {
    callbacks_->Clear();
    return StopCurrent();
  }
  std::int32_t Encode(const webrtc::VideoFrame& frame,
                      const std::vector<webrtc::VideoFrameType>* frame_types) override {
    const auto worker = Current();
    if (!worker) return WEBRTC_VIDEO_CODEC_UNINITIALIZED;
    return worker->Submit(frame, frame_types);
  }
  void SetRates(const RateControlParameters& parameters) override {
    const auto worker = Current();
    if (worker) {
      worker->UpdateRates(parameters);
    } else {
      state_->Report(0, Diagnostic("ERR_RTC_ENCODER_UNINITIALIZED",
                                   "SetRates requires an initialized encoder",
                                   WEBRTC_VIDEO_CODEC_UNINITIALIZED));
    }
  }
  EncoderInfo GetEncoderInfo() const override {
    EncoderInfo info;
    info.implementation_name = "Monky MF H264 native GPU adapter";
    info.supports_native_handle = true;
    info.preferred_pixel_formats = {webrtc::VideoFrameBuffer::Type::kNative};
    info.requested_resolution_alignment = 2;
    info.apply_alignment_to_all_simulcast_layers = false;
    info.supports_simulcast = false;
    info.scaling_settings = ScalingSettings::kOff;
    info.has_trusted_rate_controller = false;
    // M140 has no "unknown" value. Do not turn MFT/GPU capability evidence
    // into a claim that physical hardware codec execution was observed.
    info.is_hardware_accelerated = false;
    const auto worker = Current();
    if (worker) {
      const auto& setup = worker->setup();
      info.resolution_bitrate_limits.emplace_back(
          static_cast<int>(setup.core.width * setup.core.height), 64000, 64000,
          static_cast<int>(setup.maximum_bitrate));
    }
    return info;
  }

 private:
  std::int32_t StopCurrent(std::uint64_t* initialization = nullptr) {
    std::shared_ptr<EncoderWorker> worker;
    {
      std::lock_guard lock(mutex_);
      ++initialization_;
      if (initialization) *initialization = initialization_;
      worker = std::move(worker_);
    }
    return worker ? worker->Stop() : WEBRTC_VIDEO_CODEC_OK;
  }
  std::shared_ptr<EncoderWorker> Current() const {
    std::lock_guard lock(mutex_);
    return worker_;
  }
  const webrtc::Environment env_;
  const std::shared_ptr<SharedState> state_;
  const NegotiatedH264 negotiated_;
  const std::shared_ptr<EncodeGate> callbacks_;
  mutable std::mutex mutex_;
  std::uint64_t initialization_ = 0;
  std::shared_ptr<EncoderWorker> worker_;
};

class MfEncoderFactory final : public webrtc::VideoEncoderFactory {
 public:
  explicit MfEncoderFactory(std::shared_ptr<SharedState> state) : state_(std::move(state)) {}
  std::vector<webrtc::SdpVideoFormat> GetSupportedFormats() const override {
    return SupportedFormats(state_->options.maximum_h264_level);
  }
  CodecSupport QueryCodecSupport(const webrtc::SdpVideoFormat& format,
                                 std::optional<std::string> scalability_mode) const override {
    return {(!scalability_mode || *scalability_mode == "L1T1") &&
                ParseFormat(format, state_->options.maximum_h264_level).has_value(), false};
  }
  std::unique_ptr<webrtc::VideoEncoder> Create(
      const webrtc::Environment& env, const webrtc::SdpVideoFormat& format) override {
    const auto negotiated = ParseFormat(format, state_->options.maximum_h264_level);
    if (!negotiated) {
      state_->Report(0, Diagnostic("ERR_RTC_ENCODER_FORMAT",
                                   "Unsupported H264 SDP format or scalability mode",
                                   WEBRTC_VIDEO_CODEC_ERR_PARAMETER));
      return nullptr;
    }
    return std::make_unique<MfVideoEncoder>(env, state_, *negotiated);
  }
 private:
  const std::shared_ptr<SharedState> state_;
};

}  // namespace

std::unique_ptr<webrtc::VideoEncoderFactory> MakeEncoderFactory(
    const std::shared_ptr<SharedState>& state) {
  return std::make_unique<MfEncoderFactory>(state);
}

namespace {

// An unstarted Worker has no published slot. Observe its ledger directly,
// without starting/initializing it or adding a production snapshot side effect.
struct EncoderSubmitChecksAccess {
  static std::shared_ptr<const EncoderDiagnosticLedger> Ledger(const EncoderWorker& worker) {
    return worker.diagnostics_;
  }
  static bool NoMediaWork(const EncoderWorker& worker) {
    return !worker.core_ && !worker.core_observed_ && !worker.device_ && !worker.context_ &&
        worker.pending_.empty() && worker.submitted_.empty() &&
        worker.stats_.inputs == 0 && worker.stats_.accepted == 0 &&
        worker.stats_.submitted == 0 && worker.stats_.outputs == 0 && worker.stats_.gpuCopies == 0;
  }
};

namespace cpu_submit_checks {

using Check = void (*)(bool, const char*);
using Outcome = EncoderSubmitOutcome;
using Stage = EncoderInputStage;
using Reason = EncoderInputReleaseReason;

std::uint64_t Sum(const auto& values) {
  return std::accumulate(values.begin(), values.end(), std::uint64_t{0});
}

const EncoderInputStageDiagnostics& At(const EncoderDiagnosticSnapshot& snapshot, Stage stage) {
  return snapshot.inputs[static_cast<std::size_t>(stage)];
}

bool Conserved(const EncoderDiagnosticSnapshot& snapshot) {
  if (snapshot.submit.requests != snapshot.submit.in_progress + Sum(snapshot.submit.outcomes)) return false;
  for (const auto* attempt : {&snapshot.source_ready, &snapshot.core_try_encode}) {
    if (attempt->calls != attempt->in_progress + attempt->accepted + attempt->refused + attempt->exceptions)
      return false;
  }
  for (std::size_t i = 0; i < snapshot.inputs.size(); ++i) {
    const auto& stage = snapshot.inputs[i];
    const auto next = i + 1 < snapshot.inputs.size() ? snapshot.inputs[i + 1].entered : 0;
    if (stage.entered != stage.active + Sum(stage.releases) + next) return false;
  }
  return true;
}

bool SameInputs(const auto& first, const auto& second) {
  for (std::size_t i = 0; i < first.size(); ++i) {
    if (first[i].entered != second[i].entered || first[i].active != second[i].active ||
        first[i].releases != second[i].releases) return false;
  }
  return true;
}

// Separate from EncoderWorker: making the queued lease own that encoder would
// create an artificial self-cycle. Neither owner nor encoder ever calls Start.
class LeaseOwner final : public Worker {
 public:
  explicit LeaseOwner(std::shared_ptr<SharedState> state) : Worker(std::move(state)) {}

 protected:
  void PumpCore() override { throw std::runtime_error("CPU Submit owner must not run"); }
  void BeginStopCore() override {}
  void AbortCore() override {}
  bool CoreFinished() const override { return true; }
  bool CorePending() const override { return false; }
  HANDLE CoreEvent() const override { return nullptr; }
  void DestroyCore() noexcept override {}
  void RevokeCallbacks() override {}
  sv::I420Image ReadFrame(const NativeLease&, ID3D11Fence*) override {
    throw std::runtime_error("CPU Submit owner must not read pixels");
  }
};

class NativeBuffer : public webrtc::VideoFrameBuffer {
 public:
  NativeBuffer(std::shared_ptr<SharedState> state, std::shared_ptr<NativeLease> lease)
      : state_(std::move(state)), lease_(std::move(lease)) {
    state_->RegisterBuffer(this, lease_);
  }
  ~NativeBuffer() override { state_->UnregisterBuffer(this); }
  Type type() const override { return Type::kNative; }
  int width() const override {
    if (throw_width) throw std::runtime_error("CPU Submit width getter failure");
    return static_cast<int>(lease_->visible.width) + (wrong_width ? 2 : 0);
  }
  int height() const override { return static_cast<int>(lease_->visible.height); }
  webrtc::scoped_refptr<webrtc::I420BufferInterface> ToI420() override {
    ++pixel_requests;
    throw std::runtime_error("CPU Submit buffer must not convert pixels");
  }
  webrtc::scoped_refptr<webrtc::VideoFrameBuffer> CropAndScale(
      int, int, int, int, int, int) override {
    ++pixel_requests;
    throw std::runtime_error("CPU Submit buffer must not scale pixels");
  }
  bool throw_width = false, wrong_width = false;
  unsigned pixel_requests = 0;

 private:
  const std::shared_ptr<SharedState> state_;
  const std::shared_ptr<NativeLease> lease_;
};

class Callback final : public webrtc::EncodedImageCallback {
 public:
  Result OnEncodedImage(const webrtc::EncodedImage&, const webrtc::CodecSpecificInfo*) override {
    ++encoded;
    throw std::runtime_error("CPU Submit checks must not encode");
  }
  void OnDroppedFrame(DropReason reason) override {
    ++dropped;
    encoder_drops_only = encoder_drops_only && reason == DropReason::kDroppedByEncoder;
    during_drop = ledger->Snapshot();
    if (throw_drop) throw std::runtime_error("CPU Submit drop callback failure");
  }
  const EncoderDiagnosticLedger* ledger = nullptr;
  std::optional<EncoderDiagnosticSnapshot> during_drop;
  unsigned dropped = 0, encoded = 0;
  bool throw_drop = false, encoder_drops_only = true;
};

struct Input {
  std::int64_t source_us = 1000000;
  std::uint32_t rtp = 90000;
  std::int64_t capture_us = 9000123;
  bool registered = true, wrong_width = false, throw_width = false, wrong_color = false;
};

AdapterOptions Options(std::uint32_t admission, std::uint32_t queue) {
  AdapterOptions options;
  options.maximum_in_flight = admission;
  options.maximum_pending_frames = queue;
  return options;
}

EncoderSetup Setup(std::uint32_t admission) {
  EncoderSetup setup;
  setup.core = {16, 16, 120, 6000000, admission, 31, sv::H264Profile::ConstrainedBaseline};
  setup.initial_bitrate = 1000000;
  setup.maximum_bitrate = 6000000;
  return setup;
}

struct WeakInput {
  std::weak_ptr<NativeLease> lease;
  std::weak_ptr<const sv::GpuNv12Frame> source;
};

class Fixture {
 public:
  Fixture(Check check, const webrtc::Environment& env,
          std::uint32_t admission = 8, std::uint32_t queue = 8)
      : check(check), state(std::make_shared<SharedState>(Options(admission, queue))),
        owner(std::make_shared<LeaseOwner>(state)), callbacks(std::make_shared<EncodeGate>()) {
    callbacks->Register(&callback);
    worker = std::make_shared<EncoderWorker>(
        env, state, NegotiatedH264{sv::H264Profile::ConstrainedBaseline, 31},
        Setup(admission), callbacks, callbacks->Activate());
    ledger = EncoderSubmitChecksAccess::Ledger(*worker);
    callback.ledger = ledger.get();
    CpuOnly();
  }
  ~Fixture() { if (callbacks) callbacks->Clear(); }

  void CpuOnly() {
    const auto snapshot = ledger->Snapshot();
    const auto shared = state->Snapshot();
    check(EncoderSubmitChecksAccess::NoMediaWork(*worker) &&
          At(snapshot, Stage::Dispatching).entered == 0 && At(snapshot, Stage::Pending).entered == 0 &&
          At(snapshot, Stage::CoreAccepted).entered == 0 &&
          snapshot.source_ready.calls == 0 && snapshot.core_try_encode.calls == 0 &&
          snapshot.core_capacity_deferrals == 0 && snapshot.keyframe_drain_deferrals == 0 &&
          shared.live_workers == 0 && shared.encoders.empty() &&
          shared.encoded_access_units == 0 && shared.rtc_rejected_access_units == 0 &&
          shared.decoded_gpu_frames == 0 && shared.i420_readbacks == 0 && shared.i420_failures == 0 &&
          !shared.hardware_execution_observed && callback.encoded == 0 && Conserved(snapshot),
          "CPU Submit observation dispatched input, started media work or fabricated physical admission");
  }

  void Submit(const Input& input, Outcome outcome, std::int32_t expected_status, const char* message,
              const std::vector<webrtc::VideoFrameType>* types = nullptr) {
    const auto before = ledger->Snapshot();
    const auto retained = owner->retained();
    const auto dropped = callback.dropped;
    const bool queued = outcome == Outcome::Queued;
    const bool post_rejected = outcome == Outcome::PostMediaRejected;
    const bool drops = outcome == Outcome::Paused || outcome == Outcome::EmptyFrame ||
        outcome == Outcome::RateLimited || outcome == Outcome::AdmissionFull || post_rejected;
    WeakInput weak;
    {
      auto source = std::make_shared<sv::GpuNv12Frame>();
      source->timestampUs = input.source_us;
      source->durationUs = 17003;
      auto lease = std::make_shared<NativeLease>(
          owner, source, nullptr, winrt::com_ptr<ID3D11Device>{},
          winrt::com_ptr<ID3D11DeviceContext4>{}, sv::VideoFrameRect{0, 0, 16, 16});
      weak = {lease, source};
      auto buffer = webrtc::make_ref_counted<NativeBuffer>(state, lease);
      const auto color = input.wrong_color
          ? webrtc::ColorSpace(webrtc::ColorSpace::PrimaryID::kBT709,
                webrtc::ColorSpace::TransferID::kBT709, webrtc::ColorSpace::MatrixID::kBT709,
                webrtc::ColorSpace::RangeID::kFull)
          : Bt709Limited();
      const auto frame = webrtc::VideoFrame::Builder()
          .set_video_frame_buffer(buffer)
          .set_rtp_timestamp(input.rtp)
          .set_timestamp_us(input.capture_us)
          .set_ntp_time_ms(1234567)
          .set_rotation(webrtc::kVideoRotation_90)
          .set_color_space(std::optional<webrtc::ColorSpace>(color))
          .set_presentation_timestamp(webrtc::Timestamp::Micros(8000456))
          .set_id(73)
          .build();
      // Arm only after building the RTC frame, so the exception must occur
      // inside actual Submit validation, not in fixture/SDK construction.
      buffer->wrong_width = input.wrong_width;
      buffer->throw_width = input.throw_width;
      if (!input.registered) state->UnregisterBuffer(buffer.get());
      check(state->Lookup(frame.video_frame_buffer()) == (input.registered ? lease : nullptr),
            "CPU Submit fixture bypassed the actual native identity registry");
      const auto lease_refs = lease.use_count(), source_refs = source.use_count();
      const auto result = worker->Submit(frame, types);
      const auto after = ledger->Snapshot();
      auto expected_outcomes = before.submit.outcomes;
      ++expected_outcomes[static_cast<std::size_t>(outcome)];
      check(result == expected_status && after.submit.requests == before.submit.requests + 1 &&
            after.submit.in_progress == 0 && after.submit.outcomes == expected_outcomes &&
            Conserved(after), message);
      auto expected_inputs = before.inputs;
      if (queued || post_rejected) ++expected_inputs[static_cast<std::size_t>(Stage::Posting)].entered;
      if (queued) {
        auto& stage = expected_inputs[static_cast<std::size_t>(Stage::Queued)];
        ++stage.entered;
        ++stage.active;
      }
      if (post_rejected) {
        ++expected_inputs[static_cast<std::size_t>(Stage::Posting)]
              .releases[static_cast<std::size_t>(Reason::NotQueued)];
      }
      check(SameInputs(after.inputs, expected_inputs),
            "Actual Submit created an extra input ticket or conflated admission, queueing and dispatch");
      check(callback.dropped == dropped + (drops ? 1u : 0u) && callback.encoder_drops_only,
            "Actual Submit duplicated, omitted or fabricated the encoder drop callback");
      if (drops) {
        check(callback.during_drop && callback.during_drop->submit.requests == before.submit.requests + 1 &&
              callback.during_drop->submit.in_progress == 1 &&
              callback.during_drop->submit.outcomes == before.submit.outcomes &&
              Conserved(*callback.during_drop),
              "Drop callback observed Submit completed early or counted its still-live scope twice");
      }
      check(source->timestampUs == input.source_us && source->durationUs == 17003 &&
            frame.rtp_timestamp() == input.rtp && frame.timestamp_us() == input.capture_us &&
            frame.ntp_time_ms() == 1234567 && frame.rotation() == webrtc::kVideoRotation_90 &&
            frame.presentation_timestamp() == webrtc::Timestamp::Micros(8000456) && frame.id() == 73 &&
            frame.video_frame_buffer().get() == buffer.get() && lease->frame.get() == source.get() &&
            !source->texture && !source->readyFence && !lease->device && !lease->context &&
            !lease->decoded && !lease->decoder && buffer->pixel_requests == 0,
            "Submit rewrote source/RTC identity, replaced a lease or requested pixels/GPU objects");
      check(lease.use_count() == lease_refs + (queued ? 1 : 0) && source.use_count() == source_refs,
            "Submit diagnostics added a lease/source owner beyond the actual queued input");
    }
    check(weak.lease.expired() == !queued && weak.source.expired() == !queued &&
          owner->retained() == retained + (queued ? 1u : 0u) &&
          owner.use_count() == static_cast<long>(owner->retained() + 1) &&
          state->Snapshot().native_buffers == 0,
          "Returning from Submit retained a rejected input/RTC buffer or lost the accepted CPU lease");
    if (queued) {
      check(queued_count < queued_inputs.size(), "CPU Submit fixture exceeded its fixed observation bound");
      queued_inputs[queued_count++] = weak;
    }
    CpuOnly();
  }

  webrtc::VideoEncoder::RateControlParameters Parameters(
      std::uint32_t target, std::uint32_t adjusted, std::optional<std::int64_t> bandwidth, double fps) {
    webrtc::VideoEncoder::RateControlParameters parameters;
    check(parameters.target_bitrate.SetBitrate(0, 0, target) &&
          parameters.bitrate.SetBitrate(0, 0, adjusted), "CPU Submit fixture could not form L1T1 rates");
    parameters.bandwidth_allocation = bandwidth
        ? webrtc::DataRate::BitsPerSec(*bandwidth) : webrtc::DataRate::Infinity();
    parameters.framerate_fps = fps;
    return parameters;
  }

  void Rates(std::uint32_t target, std::uint32_t adjusted, std::optional<std::int64_t> bandwidth,
             double fps, double effective_fps) {
    const auto before = ledger->Snapshot();
    worker->UpdateRates(Parameters(target, adjusted, bandwidth, fps));
    const auto after = ledger->Snapshot();
    const auto& rates = after.rates;
    check(rates.valid_set_rates == before.rates.valid_set_rates + 1 &&
          rates.target_bitrate_bps == target && rates.adjusted_bitrate_bps == adjusted &&
          rates.bandwidth_allocation_bps == bandwidth && rates.framerate_fps == fps &&
          rates.policy_bitrate_bps == adjusted && rates.effective_limiter_fps == effective_fps &&
          worker->setup().core.fps == 120 && worker->setup().core.bitrateBps == 6000000 &&
          after.submit.requests == before.submit.requests && after.submit.outcomes == before.submit.outcomes &&
          SameInputs(after.inputs, before.inputs) && state->TakeDiagnostics().empty(),
          "Actual UpdateRates changed observed rates/ceilings, fabricated Submit work or rejected valid policy");
    CpuOnly();
  }

  void Error(const char* code, std::int32_t status, bool terminal = false) {
    const auto errors = state->TakeDiagnostics();
    check(errors.size() == 1 && std::string_view(errors.front().code.data()) == code &&
          errors.front().codec_status == status && errors.front().terminal == terminal,
          "Actual Submit/UpdateRates changed, duplicated or lost its expected diagnostic");
  }

  void Finish() {
    const auto held_snapshot = ledger->Snapshot();
    std::weak_ptr<EncoderWorker> weak_worker = worker;
    std::weak_ptr<LeaseOwner> weak_owner = owner;
    std::weak_ptr<EncodeGate> weak_callbacks = callbacks;
    std::weak_ptr<SharedState> weak_state = state;
    callbacks->Clear();
    callback.ledger = nullptr;
    worker.reset();
    const auto released = ledger->Snapshot();
    check(weak_worker.expired() && owner->retained() == 0 && owner.use_count() == 1 &&
          At(held_snapshot, Stage::Queued).active == queued_count &&
          At(released, Stage::Queued).active == 0 &&
          At(released, Stage::Queued).releases[static_cast<std::size_t>(Reason::Abandoned)] == queued_count &&
          released.submit.requests == held_snapshot.submit.requests &&
          released.submit.outcomes == held_snapshot.submit.outcomes && Conserved(released),
          "Holding Submit diagnostics retained an encoder/input or miscounted unstarted-queue destruction");
    for (std::size_t i = 0; i < queued_count; ++i) {
      check(queued_inputs[i].lease.expired() && queued_inputs[i].source.expired(),
            "Encoder destruction left a CPU lease/source retained by diagnostic observations");
    }
    const auto shared = state->Snapshot();
    check(shared.native_buffers == 0 && shared.live_workers == 0 && shared.encoders.empty() &&
          state->TakeDiagnostics().empty(), "CPU Submit teardown left registry entries/workers or unchecked errors");
    callbacks.reset();
    owner.reset();
    state.reset();
    check(weak_callbacks.expired() && weak_owner.expired() && weak_state.expired() &&
          Conserved(ledger->Snapshot()),
          "A held Submit ledger/snapshot retained callback, lease owner or shared adapter state");
  }

  Check check;
  std::shared_ptr<SharedState> state;
  std::shared_ptr<LeaseOwner> owner;
  Callback callback;
  std::shared_ptr<EncodeGate> callbacks;
  std::shared_ptr<EncoderWorker> worker;
  std::shared_ptr<const EncoderDiagnosticLedger> ledger;
  std::array<WeakInput, 16> queued_inputs{};
  std::size_t queued_count = 0;
};

void Run(Check check) {
  const auto env = webrtc::CreateEnvironment();
  {
    Fixture fixture(check, env);
    fixture.callbacks->Register(nullptr);
    fixture.Submit({.throw_width = true}, Outcome::NoCallback, WEBRTC_VIDEO_CODEC_UNINITIALIZED,
                   "Actual Submit did not settle NoCallback exactly once before input validation");
    fixture.worker->RequestStop();
    fixture.Submit({.throw_width = true}, Outcome::Stopping, WEBRTC_VIDEO_CODEC_UNINITIALIZED,
                   "Actual Submit did not settle Stopping exactly once before callback/validation checks");
    fixture.Finish();
  }
  {
    Fixture fixture(check, env);
    fixture.Rates(0, 0, 0, 0, 120);
    fixture.callback.throw_drop = true;
    fixture.Submit({}, Outcome::Paused, WEBRTC_VIDEO_CODEC_OK,
                   "A throwing drop callback overwrote/doubled the actual Paused Submit outcome");
    fixture.Error("ERR_RTC_CPP", WEBRTC_VIDEO_CODEC_ERROR, true);
    check(fixture.worker->status() == WEBRTC_VIDEO_CODEC_ERROR && fixture.worker->stopping(),
          "The real NotifyDropped failure did not fail/stop its worker");
    fixture.Submit({.throw_width = true}, Outcome::WorkerStatus, WEBRTC_VIDEO_CODEC_ERROR,
                   "Actual Submit did not preserve WorkerStatus precedence and settle exactly once");
    fixture.Finish();
  }
  {
    Fixture fixture(check, env);
    const std::vector layers{webrtc::VideoFrameType::kVideoFrameDelta, webrtc::VideoFrameType::kVideoFrameKey};
    fixture.Submit({.throw_width = true}, Outcome::Validation,
                   WEBRTC_VIDEO_CODEC_ERR_SIMULCAST_PARAMETERS_NOT_SUPPORTED,
                   "Actual layer validation was not settled exactly once", &layers);
    fixture.Error("ERR_RTC_FRAME_LAYERS", WEBRTC_VIDEO_CODEC_ERR_SIMULCAST_PARAMETERS_NOT_SUPPORTED);
    const std::vector unsupported{static_cast<webrtc::VideoFrameType>(1)};
    fixture.Submit({}, Outcome::Validation, WEBRTC_VIDEO_CODEC_ERR_PARAMETER,
                   "Actual frame-type validation was not settled exactly once", &unsupported);
    fixture.Error("ERR_RTC_FRAME_TYPE", WEBRTC_VIDEO_CODEC_ERR_PARAMETER);
    fixture.Submit({.registered = false}, Outcome::Validation, WEBRTC_VIDEO_CODEC_ERR_PARAMETER,
                   "Actual identity lookup accepted an unregistered native buffer");
    fixture.Error("ERR_RTC_NATIVE_BUFFER", WEBRTC_VIDEO_CODEC_ERR_PARAMETER);
    fixture.Submit({.wrong_width = true}, Outcome::Validation, WEBRTC_VIDEO_CODEC_ERR_PARAMETER,
                   "Actual geometry validation was not settled exactly once");
    fixture.Error("ERR_RTC_ENCODER_GEOMETRY", WEBRTC_VIDEO_CODEC_ERR_PARAMETER);
    fixture.Submit({.capture_us = -1}, Outcome::Validation, WEBRTC_VIDEO_CODEC_ERR_PARAMETER,
                   "Actual RTC timestamp validation was not settled exactly once");
    fixture.Error("ERR_RTC_FRAME_METADATA", WEBRTC_VIDEO_CODEC_ERR_PARAMETER);
    fixture.Submit({.wrong_color = true}, Outcome::Validation, WEBRTC_VIDEO_CODEC_ERR_PARAMETER,
                   "Actual color metadata validation was not settled exactly once");
    fixture.Error("ERR_RTC_FRAME_METADATA", WEBRTC_VIDEO_CODEC_ERR_PARAMETER);
    fixture.Submit({.throw_width = true}, Outcome::Exception, WEBRTC_VIDEO_CODEC_ERROR,
                   "An actual unclassified width-getter exception was omitted or counted as validation twice");
    fixture.Error("ERR_RTC_CPP", WEBRTC_VIDEO_CODEC_ERROR);
    check(fixture.worker->status() == WEBRTC_VIDEO_CODEC_OK && !fixture.worker->stopping(),
          "Reporting an input exception unexpectedly failed/stopped the encoder");
    fixture.Submit({}, Outcome::Queued, WEBRTC_VIDEO_CODEC_OK,
                   "Actual Submit did not recover from input validation/exception to queue exactly once");
    fixture.Submit({.source_us = 1020000}, Outcome::Validation, WEBRTC_VIDEO_CODEC_ERR_PARAMETER,
                   "Actual duplicate RTP validation was not settled exactly once");
    fixture.Error("ERR_RTC_RTP_TIMESTAMP", WEBRTC_VIDEO_CODEC_ERR_PARAMETER);
    fixture.Submit({.rtp = 90001}, Outcome::Validation, WEBRTC_VIDEO_CODEC_ERR_PARAMETER,
                   "Actual duplicate source-PTS validation was not settled exactly once");
    fixture.Error("ERR_RTC_SOURCE_TIMESTAMP", WEBRTC_VIDEO_CODEC_ERR_PARAMETER);
    fixture.Submit({.source_us = 1020000, .rtp = 90001}, Outcome::Queued, WEBRTC_VIDEO_CODEC_OK,
                   "Failed timestamp validation consumed the original source PTS/RTP timeline");
    fixture.Finish();
  }
  {
    Fixture fixture(check, env);
    fixture.Rates(1700000, 1400000, 1900000, 240, 120);
    fixture.Rates(1700000, 1400000, 1900000, 59.94, 59.94);
    fixture.Submit({.rtp = 0xfffffff0u}, Outcome::Queued, WEBRTC_VIDEO_CODEC_OK,
                   "Fractional-rate Submit did not queue its first original source/RTP timestamp");
    fixture.Submit({.source_us = 1000001, .rtp = 0x20u}, Outcome::Queued, WEBRTC_VIDEO_CODEC_OK,
                   "Actual Submit lost RTP wraparound or the limiter's single scheduling credit");
    // At 60 FPS this third input passes; at 59.94 it is still too early even
    // with one scheduling credit. The next input crosses the fractional due time.
    fixture.Submit({.source_us = 1016667, .rtp = 0x30u}, Outcome::RateLimited, WEBRTC_VIDEO_CODEC_OK,
                   "Actual Submit rounded 59.94 FPS or failed to settle RateLimited exactly once");
    fixture.Submit({.source_us = 1016684, .rtp = 0x30u}, Outcome::Queued, WEBRTC_VIDEO_CODEC_OK,
                   "Rate-limited Submit consumed RTP or shifted the fractional source deadline");
    fixture.Rates(0, 0, 0, 0, 120);
    fixture.Submit({.source_us = 1016685, .rtp = 0x40u}, Outcome::Paused, WEBRTC_VIDEO_CODEC_OK,
                   "Legitimate zero-rate Submit was not settled as Paused exactly once");
    fixture.Rates(1700000, 1400000, std::nullopt, 59.94, 59.94);
    fixture.Submit({.source_us = 1016685, .rtp = 0x40u}, Outcome::Queued, WEBRTC_VIDEO_CODEC_OK,
                   "Actual resume failed to reset pacing or a paused Submit consumed source PTS/RTP");
    const std::vector empty{webrtc::VideoFrameType::kEmptyFrame};
    fixture.Submit({.source_us = 1016686, .rtp = 0x50u}, Outcome::EmptyFrame, WEBRTC_VIDEO_CODEC_OK,
                   "Actual Submit did not settle EmptyFrame exactly once", &empty);
    fixture.Submit({.source_us = 1016686, .rtp = 0x50u}, Outcome::Queued, WEBRTC_VIDEO_CODEC_OK,
                   "An empty-frame request consumed source PTS/RTP or changed admission");
    const auto before_invalid = fixture.ledger->Snapshot();
    fixture.worker->UpdateRates(fixture.Parameters(70000, 63999, 0, 59.94));
    const auto after_invalid = fixture.ledger->Snapshot();
    check(after_invalid.rates.valid_set_rates == before_invalid.rates.valid_set_rates &&
          after_invalid.rates.policy_bitrate_bps == 1400000 &&
          after_invalid.rates.framerate_fps == 59.94 && after_invalid.rates.effective_limiter_fps == 59.94 &&
          after_invalid.rates.target_bitrate_bps == 1700000 &&
          after_invalid.rates.adjusted_bitrate_bps == 1400000 && !after_invalid.rates.bandwidth_allocation_bps &&
          after_invalid.submit.requests == before_invalid.submit.requests &&
          after_invalid.submit.outcomes == before_invalid.submit.outcomes &&
          SameInputs(after_invalid.inputs, before_invalid.inputs),
          "Actual invalid UpdateRates became a valid observation or overwrote the previous rate policy");
    fixture.Error("ERR_RTC_RATE_REQUIRES_INIT", WEBRTC_VIDEO_CODEC_ERR_PARAMETER);
    fixture.Submit({.source_us = 1016687, .rtp = 0x60u}, Outcome::RateError, WEBRTC_VIDEO_CODEC_ERR_PARAMETER,
                   "Actual Submit did not settle RateError exactly once without a drop callback");
    fixture.Rates(1700000, 1400000, std::nullopt, 59.94, 59.94);
    fixture.Submit({.source_us = 1016687, .rtp = 0x60u}, Outcome::Queued, WEBRTC_VIDEO_CODEC_OK,
                   "Actual valid-rate recovery lost pacing reset or consumed rate-error input identity");
    fixture.Finish();
  }
  for (const bool queue_full : {false, true}) {
    // The other bound has spare capacity. Repeated post rejection must also
    // release its admission ticket, otherwise the next result is AdmissionFull.
    Fixture fixture(check, env, queue_full ? 3u : 2u, queue_full ? 2u : 3u);
    fixture.Submit({}, Outcome::Queued, WEBRTC_VIDEO_CODEC_OK,
                   "Actual bounded Submit did not queue its first input");
    fixture.Submit({.source_us = 1020000, .rtp = 91800}, Outcome::Queued, WEBRTC_VIDEO_CODEC_OK,
                   "Actual bounded Submit did not queue its second input");
    const auto outcome = queue_full ? Outcome::PostMediaRejected : Outcome::AdmissionFull;
    const auto* message = queue_full
        ? "Actual PostMedia rejection was lost, double-counted, or leaked an admission ticket"
        : "Actual admission bound was lost, double-counted, or confused with queue rejection";
    fixture.Submit({.source_us = 1040000, .rtp = 93600}, outcome, WEBRTC_VIDEO_CODEC_OK, message);
    fixture.Submit({.source_us = 1060000, .rtp = 93600}, outcome, WEBRTC_VIDEO_CODEC_OK, message);
    fixture.Finish();
  }
}

}  // namespace cpu_submit_checks
}  // namespace

}  // namespace monky::native_rtc::mf::detail

namespace monky::native_rtc::mf {

void RunEncoderSubmitBranchChecks(void (*check)(bool, const char*)) {
  detail::cpu_submit_checks::Run(check);
}

}  // namespace monky::native_rtc::mf
