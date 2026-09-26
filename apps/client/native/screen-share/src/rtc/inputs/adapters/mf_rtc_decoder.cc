#include "mf_rtc_internal.h"

#include "api\rtp_packet_infos.h"

#include <algorithm>
#include <cstring>
#include <limits>
#include <thread>

#if !defined(MONKY_RTC_DECODER_FRAME_INFO_LEASE_REVISION) || MONKY_RTC_DECODER_FRAME_INFO_LEASE_REVISION != 1
#error The native decoder requires its pinned ownership-aware SDK mapping.
#endif

namespace monky::native_rtc::mf::detail {
namespace {

using DecodeGate = CallbackGate<webrtc::DecodedImageCallback>;
constexpr auto kDecoderAdmissionWait = std::chrono::milliseconds(500);

struct DecoderSetup {
  std::uint32_t maximum_width = 4096, maximum_height = 4096;
  std::uint32_t maximum_in_flight = 0;
};

DecoderSetup MakeDecoderSetup(const webrtc::VideoDecoder::Settings& settings,
                             const AdapterOptions& options) {
  if (settings.codec_type() != webrtc::kVideoCodecH264 || settings.number_of_cores() <= 0) {
    throw AdapterError("ERR_RTC_DECODER_CONFIGURATION", "Decoder requires H264 and a positive core limit");
  }
  DecoderSetup setup;
  setup.maximum_in_flight = options.maximum_in_flight;
  const auto resolution = settings.max_render_resolution();
  if (resolution.Width() != 0 || resolution.Height() != 0) {
    if (!resolution.Valid() || resolution.Width() < 16 || resolution.Height() < 16 ||
        resolution.Width() > 4096 || resolution.Height() > 4096) {
      throw AdapterError("ERR_RTC_DECODER_GEOMETRY", "Unsupported decoder resolution ceiling");
    }
    setup.maximum_width = static_cast<std::uint32_t>(resolution.Width());
    setup.maximum_height = static_cast<std::uint32_t>(resolution.Height());
  }
  if (const auto pool = settings.buffer_pool_size()) {
    if (*pool < 2 || *pool > 16) {
      throw AdapterError("ERR_RTC_DECODER_POOL", "The qualified GPU pool supports 2..16 frames");
    }
    setup.maximum_in_flight = (std::min)(setup.maximum_in_flight, static_cast<std::uint32_t>(*pool));
  }
  return setup;
}

struct DecodeAdmission {
  DecodeAdmission() = default;
  DecodeAdmission(const DecodeAdmission&) = default;
  DecodeAdmission(DecodeAdmission&&) = default;
  DecodeAdmission& operator=(DecodeAdmission other) noexcept {
    admission.swap(other.admission);
    frame_info.swap(other.frame_info);
    return *this;
  }
  std::shared_ptr<Budget::Ticket> admission;
  // Also during assignment, retire metadata before making its slot reusable.
  std::shared_ptr<webrtc::MonkyDecoderFrameInfoLease> frame_info;
};

struct DecodeMetadata : DecodeAdmission {
  std::uint64_t request_id = 0, loss_epoch = 0;
  std::uint32_t rtp = 0, encoded_width = 0, encoded_height = 0;
  std::int64_t render_us = 0, ntp_ms = 0, duration_us = 0, accepted_ms = 0;
  webrtc::VideoRotation rotation = webrtc::kVideoRotation_0;
  std::optional<webrtc::Timestamp> presentation;
  std::optional<std::uint16_t> tracking_id;
  webrtc::RtpPacketInfos packet_infos;
  bool accepted = false;
  std::shared_ptr<DecoderInputDiagnosticTicket> diagnostic;
};

struct DecodeInput {
  sv::EncodedPacket packet;
  AccessUnitInfo access_unit;
  DecodeMetadata metadata;
};

class DecoderWorker final : public Worker {
 public:
  DecoderWorker(const webrtc::Environment& env, std::shared_ptr<SharedState> state,
                NegotiatedH264 negotiated, DecoderSetup setup,
                std::shared_ptr<DecodeGate> callbacks, std::uint64_t generation)
      : Worker(std::move(state)), env_(env), negotiated_(negotiated), setup_(setup),
        callbacks_(std::move(callbacks)), generation_(generation),
        admission_(std::make_shared<Budget>(
            this->state()->options.maximum_pending_frames,
            this->state()->options.maximum_pending_encoded_bytes)),
        retired_cores_(setup.maximum_in_flight) {}

  std::int32_t Submit(const webrtc::EncodedImage& image, bool missing_frames,
                      std::int64_t render_time_ms) {
    DecoderSubmitDiagnostic submission(*diagnostics_, &DecoderDiagnosticSnapshot::submit,
                                      DecoderSubmitOutcome::Exception);
    if (status() != WEBRTC_VIDEO_CODEC_OK) {
      submission.Select(DecoderSubmitOutcome::WorkerStatus);
      return status();
    }
    if (stopping()) {
      submission.Select(DecoderSubmitOutcome::Stopping);
      return WEBRTC_VIDEO_CODEC_UNINITIALIZED;
    }
    if (!callbacks_->HasCallback(generation_)) {
      submission.Select(DecoderSubmitOutcome::NoCallback);
      return WEBRTC_VIDEO_CODEC_UNINITIALIZED;
    }
    if (missing_frames) {
      submission.Select(DecoderSubmitOutcome::MissingFrames);
      RequestRecovery(Diagnostic("ERR_RTC_MISSING_FRAME",
                                "Missing input: draining/resetting predictive state; a fresh IDR is required"));
      return WEBRTC_VIDEO_CODEC_ERROR;
    }
    std::int32_t result = WEBRTC_VIDEO_CODEC_OK;
    const auto error = Protect([&] {
      if (!image.data() || image.size() == 0 || image.size() > kMaximumAccessUnitBytes ||
          !image.GetEncodedData() || image.size() > image.GetEncodedData()->size() ||
          image.PacketInfos().size() > 4096) {
        throw AdapterError("ERR_RTC_ENCODED_INPUT", "Invalid bounded encoded AU or RTP packet metadata");
      }
      if (image.SpatialIndex().value_or(0) != 0 || image.TemporalIndex().value_or(0) != 0 ||
          image.SimulcastIndex().value_or(0) != 0) {
        throw AdapterError("ERR_RTC_DECODER_LAYERS",
                           "The native decoder accepts one spatial/temporal stream only");
      }
      if ((image.ColorSpace() && !IsBt709Limited(*image.ColorSpace())) ||
          image._encodedWidth > setup_.maximum_width ||
          image._encodedHeight > setup_.maximum_height ||
          ((image._encodedWidth == 0) != (image._encodedHeight == 0))) {
        throw AdapterError("ERR_RTC_DECODE_METADATA", "Encoded geometry/color metadata is unsupported");
      }
      switch (image.rotation()) {
        case webrtc::kVideoRotation_0: case webrtc::kVideoRotation_90:
        case webrtc::kVideoRotation_180: case webrtc::kVideoRotation_270: break;
        default: throw AdapterError("ERR_RTC_ROTATION", "Invalid encoded rotation metadata");
      }
      auto information = InspectAccessUnit({image.data(), image.size()});
      if ((image.FrameType() != webrtc::VideoFrameType::kVideoFrameKey &&
           image.FrameType() != webrtc::VideoFrameType::kVideoFrameDelta) ||
          information.keyframe != (image.FrameType() == webrtc::VideoFrameType::kVideoFrameKey)) {
        throw AdapterError("ERR_RTC_IDR_METADATA", "Encoded frame type does not identify the actual AU");
      }
      if (information.sps) {
        ValidateSps(*information.sps, negotiated_, setup_.maximum_width, setup_.maximum_height);
      }
      DecodeInput input;
      input.access_unit = std::move(information);
      input.metadata.rtp = image.RtpTimestamp();
      input.metadata.ntp_ms = image.NtpTimeMs();
      input.metadata.rotation = image.rotation();
      input.metadata.encoded_width = image._encodedWidth;
      input.metadata.encoded_height = image._encodedHeight;
      input.metadata.presentation = image.PresentationTimestamp();
      input.metadata.tracking_id = image.VideoFrameTrackingId();
      input.metadata.packet_infos = image.PacketInfos();
      if (render_time_ms > (std::numeric_limits<std::int64_t>::max)() / 1000) {
        throw AdapterError("ERR_RTC_RENDER_TIMESTAMP", "Render timestamp exceeds integer bounds");
      }
      input.metadata.render_us = render_time_ms >= 0
          ? render_time_ms * 1000 : env_.clock().TimeInMicroseconds();
      input.metadata.duration_us = 1000000 / state()->options.decoder_fps;
      std::unique_lock lock(submit_mutex_);
      if (recovery_requested_ || recovery_in_progress_) {
        submission.Select(DecoderSubmitOutcome::RecoveryPending);
        result = WEBRTC_VIDEO_CODEC_ERROR;
        return;
      }
      if (needs_keyframe_ && !input.access_unit.keyframe) {
        submission.Select(DecoderSubmitOutcome::IdrRequired);
        throw AdapterError("ERR_RTC_IDR_REQUIRED", "Decoder requires a real IDR after start/input loss",
                           WEBRTC_VIDEO_CODEC_ERROR);
      }
      if (!ever_queued_ && !input.access_unit.sps) {
        submission.Select(DecoderSubmitOutcome::InitialSps);
        throw AdapterError("ERR_RTC_INITIAL_SPS", "Initial IDR must contain the actual SPS/PPS");
      }
      input.metadata.admission = admission_->Acquire(image.size());
      if (!input.metadata.admission && !IsWorkerThread() && !callbacks_->IsInvokingOnCurrentThread()) {
        const auto epoch = loss_epoch_;
        // Decode runs on RTC's decoder queue. Backpressure a burst there while
        // the independent MF worker retires real credit; never hold its mutex.
        lock.unlock();
        input.metadata.admission = admission_->AcquireUntil(image.size(),
            SteadyClock::now() + (std::min)(kDecoderAdmissionWait, state()->options.operation_timeout),
            [this] { return stopping() || status() != WEBRTC_VIDEO_CODEC_OK; });
        const bool callback_available = callbacks_->HasCallback(generation_);
        lock.lock();
        if (status() != WEBRTC_VIDEO_CODEC_OK) {
          submission.Select(DecoderSubmitOutcome::WorkerStatus);
          result = status();
          return;
        }
        if (stopping() || !callback_available) {
          submission.Select(stopping() ? DecoderSubmitOutcome::Stopping : DecoderSubmitOutcome::NoCallback);
          result = WEBRTC_VIDEO_CODEC_UNINITIALIZED;
          return;
        }
        if (epoch != loss_epoch_ || recovery_requested_ || recovery_in_progress_) {
          submission.Select(DecoderSubmitOutcome::RecoveryPending);
          result = WEBRTC_VIDEO_CODEC_ERROR;
          return;
        }
      }
      if (!input.metadata.admission) {
        submission.Select(DecoderSubmitOutcome::AdmissionFull);
        StartRecoveryLocked();
        result = WEBRTC_VIDEO_CODEC_ERROR;
        Report(Diagnostic("ERR_RTC_DECODER_BACKPRESSURE",
                          "AU count/byte credit unavailable after bounded backpressure; a fresh IDR is required"));
        Wake();
        return;
      }
      input.metadata.frame_info = image.MonkyFrameInfoLease();
      input.metadata.diagnostic = std::make_shared<DecoderInputDiagnosticTicket>(
          diagnostics_, loss_epoch_, submission.begin());
      if (next_request_id_ == (std::numeric_limits<std::uint64_t>::max)()) {
        throw AdapterError("ERR_RTC_DECODE_ID", "Decoder request identifiers exhausted");
      }
      auto timeline = timeline_;
      input.packet.timestampUs = timeline.Push(image.RtpTimestamp());
      input.packet.durationUs = input.metadata.duration_us;
      input.packet.keyFrame = input.access_unit.keyframe;
      input.packet.data.assign(image.data(), image.data() + image.size());
      input.metadata.request_id = next_request_id_;
      input.metadata.loss_epoch = loss_epoch_;
      auto* diagnostic = input.metadata.diagnostic.get();
      if (!PostMedia([this, input = std::move(input)]() mutable {
            input.metadata.diagnostic->Dispatched();
            EnqueueOnWorker(std::move(input));
          }, nullptr, diagnostic)) {
        submission.Select(DecoderSubmitOutcome::PostMediaRejected);
        if (!stopping()) StartRecoveryLocked();
        result = stopping() ? WEBRTC_VIDEO_CODEC_UNINITIALIZED : WEBRTC_VIDEO_CODEC_ERROR;
        Report(Diagnostic("ERR_RTC_DECODER_QUEUE", "Decoder worker rejected bounded AU admission", result));
        Wake();
        return;
      }
      timeline_ = timeline;
      ++next_request_id_;
      needs_keyframe_ = false;
      ever_queued_ = true;
      submission.Select(DecoderSubmitOutcome::Queued);
    });
    if (error) {
      const bool unexpected = std::strcmp(error->code.data(), "ERR_RTC_CPP") == 0 ||
          std::strcmp(error->code.data(), "ERR_RTC_MEMORY") == 0 ||
          std::strcmp(error->code.data(), "ERR_RTC_COM") == 0;
      submission.Select(unexpected ? DecoderSubmitOutcome::Exception : DecoderSubmitOutcome::Validation);
      RequestRecovery(*error);
      return error->codec_status;
    }
    return result;
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
    retired_cores_.Reap();
    bool recover = false;
    {
      std::lock_guard lock(submit_mutex_);
      if (recovery_requested_) {
        recovery_requested_ = false;
        recovery_in_progress_ = true;
        recover = true;
      }
    }
    if (!recover) return;
    diagnostics_->Update([](auto& value) { ++value.recoveries_begun; });
    CancelQueuedMedia(std::nullopt, DecoderInputReleaseReason::RecoveryCancelled);
    DropPending(DecoderInputReleaseReason::RecoveryCancelled);
    // A format transition already sent END_OF_STREAM. Do not FLUSH a stopping
    // core; finish its retirement, then require a fresh received IDR/SPS.
    if (switching_) return;
    if (core_) {
      diagnostics_->Measure(DecoderOperation::CoreFlush, [&] { core_->BeginFlush(); });
      flushing_ = true;
    } else {
      DropSubmitted(DecoderInputReleaseReason::RecoveryCancelled);
      FinishRecovery();
    }
  }

  void PumpCore() override {
    if (core_) {
      diagnostics_->Measure(DecoderOperation::CorePump, [&] { core_->Pump(); });
      RefreshCoreStats();
      if (switching_ && !stopping() && core_->Finished()) {
        if (!submitted_.empty())
          throw AdapterError("ERR_RTC_SESSION_IDENTITY", "Drained MF session left uncorrelated RTP pictures");
        retired_cores_.Retire(core_);
        config_ = {};
        current_sps_.reset();
        stats_ = {};
        core_observed_ = false;
        core_observed_at_rtc_us_.reset();
        core_start_loss_epoch_.reset();
        context_ = nullptr;
        device_ = nullptr;
        switching_ = false;
        bool recovering;
        {
          std::lock_guard lock(submit_mutex_);
          recovering = recovery_in_progress_;
        }
        if (recovering) FinishRecovery();
      } else if (flushing_ && !stopping() && core_->TakeFlushCompleted()) {
        if (!submitted_.empty())
          throw AdapterError("ERR_RTC_FLUSH_IDENTITY", "MF flush left uncorrelated submitted pictures");
        flushing_ = false;
        FinishRecovery();
      }
    }
    if (!stopping() && !switching_ && !flushing_ && !pending_.empty()) {
      auto input = std::move(pending_.front());
      pending_.pop_front();
      input.metadata.diagnostic->Resumed();
      DecodeOnWorker(std::move(input));
      if (!pending_.empty()) Wake();
    }
    PublishSnapshot();
  }
  void BeginStopCore() override {
    const auto reason = status() == WEBRTC_VIDEO_CODEC_OK
        ? DecoderInputReleaseReason::Stopped : DecoderInputReleaseReason::WorkerError;
    DropPending(reason);
    switching_ = false;
    if (core_ && !core_->Finished())
      diagnostics_->Measure(DecoderOperation::CoreStop, [&] { core_->BeginStop(); });
  }
  void AbortCore() override {
    const auto reason = status() == WEBRTC_VIDEO_CODEC_OK
        ? DecoderInputReleaseReason::Stopped : DecoderInputReleaseReason::WorkerError;
    DropPending(reason);
    switching_ = false;
    DropSubmitted(reason);
    if (core_ && !core_->Finished())
      diagnostics_->Measure(DecoderOperation::CoreAbort, [&] { core_->Abort(); });
  }
  bool CoreFinished() const override { return !core_ || core_->Finished(); }
  bool CorePending() const override {
    return !pending_.empty() || (core_ && !core_->Finished() &&
        (stats_.pendingPackets || stats_.awaitingOutput ||
         stats_.pendingGpuCopies || flushing_ || switching_ || stopping()));
  }
  HANDLE CoreEvent() const override { return core_ ? core_->WakeEvent() : nullptr; }
  void DestroyCore() noexcept override {
    core_.reset();
    retired_cores_.Reset();
    const auto reason = status() == WEBRTC_VIDEO_CODEC_OK
        ? DecoderInputReleaseReason::Stopped : DecoderInputReleaseReason::WorkerError;
    DropPending(reason);
    DropSubmitted(reason);
    context_ = nullptr;
    device_ = nullptr;
  }
  sv::I420Image ReadFrame(const NativeLease& lease, ID3D11Fence*) override {
    if (!lease.decoder || !lease.decoded) {
      throw AdapterError("ERR_RTC_DECODED_LEASE", "A retained output of this decoder is required");
    }
    // Intentionally valid AFTER core Finished()/VideoDecoder::Release().
    // The lease pins this MTA worker and the exact qualified readback owner.
    return lease.decoder->ReadI420(lease.decoded);
  }

 private:
  friend struct DecoderSubmitChecksAccess;

  void RefreshCoreStats() {
    stats_ = diagnostics_->Measure(DecoderOperation::CoreStatsCopy, [&] { return core_->GetStats(); });
    core_observed_ = true;
    core_observed_at_rtc_us_ = env_.clock().TimeInMicroseconds();
  }

  DecoderRuntimeSnapshot RuntimeSnapshot() {
    DecoderRuntimeSnapshot snapshot;
    snapshot.session_id = id();
    snapshot.observation_sequence = ++observation_sequence_;
    snapshot.observed_at_rtc_us = env_.clock().TimeInMicroseconds();
    snapshot.core_generation = core_generation_;
    snapshot.core_start_loss_epoch = core_start_loss_epoch_;
    snapshot.core_observed_at_rtc_us = core_observed_at_rtc_us_;
    snapshot.maximum_width = setup_.maximum_width;
    snapshot.maximum_height = setup_.maximum_height;
    snapshot.maximum_in_flight = setup_.maximum_in_flight;
    snapshot.maximum_pending_frames = state()->options.maximum_pending_frames;
    snapshot.maximum_pending_bytes = state()->options.maximum_pending_encoded_bytes;
    snapshot.capability_fps_hint = state()->options.decoder_fps;
    snapshot.capability_bitrate_hint_bps = state()->options.decoder_bitrate_bps;
    {
      std::lock_guard lock(submit_mutex_);
      snapshot.loss_epoch = loss_epoch_;
      snapshot.recovery_requested = recovery_requested_;
      snapshot.recovery_in_progress = recovery_in_progress_;
      snapshot.needs_keyframe = needs_keyframe_;
    }
    snapshot.pending_frames = pending_.size();
    snapshot.submitted_metadata = submitted_.size();
    snapshot.retained_leases = retained();
    snapshot.retired_core_sessions = retired_cores_.Retired();
    snapshot.flushing = flushing_;
    snapshot.switching = switching_;
    snapshot.stopping = stopping();
    snapshot.worker_status = status();
    snapshot.configured = config_;
    snapshot.core_observed = core_observed_;
    snapshot.core = stats_;
    snapshot.diagnostic_ledger = diagnostics_;
    return snapshot;
  }

  void PublishSnapshot() {
    diagnostics_->Measure(DecoderOperation::CachePublish, [&] {
      RecordDecoderSnapshot(RuntimeSnapshot());
    });
  }

  void DropPending(DecoderInputReleaseReason reason) noexcept {
    for (auto& input : pending_) input.metadata.diagnostic->ReleaseAs(reason);
    pending_.clear();
  }

  void DropSubmitted(DecoderInputReleaseReason reason) noexcept {
    for (auto& [timestamp, metadata] : submitted_) metadata.diagnostic->ReleaseAs(reason);
    submitted_.clear();
  }

  void StartRecoveryLocked() {
    const bool advanced = !recovery_requested_ && !recovery_in_progress_;
    if (advanced) {
      ++loss_epoch_;
      recovery_requested_ = true;
    }
    needs_keyframe_ = true;
    diagnostics_->RecoveryRequested(loss_epoch_, advanced);
  }

  void RequestRecovery(AdapterDiagnostic diagnostic) {
    {
      std::lock_guard lock(submit_mutex_);
      StartRecoveryLocked();
    }
    Report(diagnostic);
    Wake();
  }

  void FinishRecovery() {
    std::lock_guard lock(submit_mutex_);
    recovery_in_progress_ = false;
    needs_keyframe_ = true;
    if (!core_) ever_queued_ = false;
    diagnostics_->Update([](auto& value) { ++value.recoveries_finished; });
  }

  void EnqueueOnWorker(DecodeInput input) {
    if (!CurrentInput(input.metadata)) {
      input.metadata.diagnostic->ReleaseAs(DecoderInputReleaseReason::StaleLossEpoch);
      return;
    }
    if (switching_ || !pending_.empty()) {
      pending_.push_back(std::move(input));
      pending_.back().metadata.diagnostic->Pending();
      return;
    }
    DecodeOnWorker(std::move(input));
  }

  bool CurrentInput(const DecodeMetadata& metadata) {
    std::lock_guard lock(submit_mutex_);
    return metadata.loss_epoch == loss_epoch_ && !recovery_requested_ && !recovery_in_progress_;
  }

  void DecodeOnWorker(DecodeInput input) {
    if (!CurrentInput(input.metadata)) {
      input.metadata.diagnostic->ReleaseAs(DecoderInputReleaseReason::StaleLossEpoch);
      return;
    }
    std::optional<sv::DecoderConfig> replacement;
    const auto invalid = Protect([&] {
      replacement = PlanDecoderSession(current_sps_, input.access_unit, input.packet.data,
          negotiated_, setup_.maximum_width, setup_.maximum_height, setup_.maximum_in_flight,
          state()->options);
      const auto& expected = replacement ? *replacement : config_;
      if (input.metadata.encoded_width &&
          (input.metadata.encoded_width != expected.width ||
           input.metadata.encoded_height != expected.height))
        throw AdapterError("ERR_RTC_DECODE_GEOMETRY", "EncodedImage geometry contradicts actual SPS");
    });
    if (invalid) {
      input.metadata.diagnostic->ReleaseAs(DecoderInputReleaseReason::InvalidSession);
      RequestRecovery(*invalid);
      return;
    }
    if (replacement && core_) {
      pending_.push_front(std::move(input));
      pending_.front().metadata.diagnostic->Pending();
      switching_ = true;
      diagnostics_->Update([](auto& value) { ++value.session_switches; });
      diagnostics_->Measure(DecoderOperation::CoreStop, [&] { core_->BeginStop(); });
      return;
    }
    if (replacement) {
      config_ = std::move(*replacement);
      current_sps_ = input.access_unit.sps;
      core_ = diagnostics_->Measure(DecoderOperation::CoreCreate, [&] {
        return std::make_shared<sv::MfH264Decoder>(
            config_, [this](std::shared_ptr<const sv::GpuDecodedFrame> frame) {
              return OnFrame(std::move(frame));
            },
            [this](std::uint64_t request) { OnAccepted(request); },
            [this] { return retained(); }, ObserveNativeDecoderCalls(diagnostics_));
      });
      ++core_generation_;
      core_start_loss_epoch_ = input.metadata.loss_epoch;
      RefreshCoreStats();
      PublishSnapshot();
    }
    const auto request = input.metadata.request_id;
    const auto timestamp = input.packet.timestampUs;
    if (!submitted_.emplace(timestamp, std::move(input.metadata)).second) {
      throw AdapterError("ERR_RTC_DECODE_PTS", "Duplicate decoder PTS metadata");
    }
    auto& diagnostic = *submitted_.at(timestamp).diagnostic;
    diagnostic.CoreEnqueueStarting();
    {
      DecoderInputFailureGuard failure(diagnostic, DecoderInputReleaseReason::CoreEnqueueError);
      diagnostics_->Measure(DecoderOperation::CoreEnqueue, [&] {
        core_->Enqueue(request, std::move(input.packet));
      });
    }
    diagnostic.CoreAccepted();
    RefreshCoreStats();
    PublishSnapshot();
  }

  void OnAccepted(std::uint64_t request) {
    diagnostics_->Update([](auto& value) { ++value.accepted_callbacks; });
    for (auto& [timestamp, metadata] : submitted_) {
      if (metadata.request_id != request) continue;
      if (metadata.accepted) {
        diagnostics_->Update([](auto& value) { ++value.accepted_duplicate; });
        throw AdapterError("ERR_RTC_DECODE_ACCEPTED", "MF accepted one request more than once");
      }
      metadata.accepted = true;
      metadata.accepted_ms = env_.clock().TimeInMilliseconds();
      metadata.diagnostic->ProcessInputAccepted();
      return;
    }
    diagnostics_->Update([](auto& value) { ++value.accepted_unknown; });
    throw AdapterError("ERR_RTC_DECODE_ACCEPTED", "MF accepted an unknown AU request");
  }

  bool OnFrame(std::shared_ptr<const sv::GpuDecodedFrame> frame) {
    DecoderOutputDiagnostic output_diagnostic(*diagnostics_, &DecoderDiagnosticSnapshot::output,
                                              DecoderOutputOutcome::Exception);
    if (!frame) {
      output_diagnostic.Select(DecoderOutputOutcome::NullFrame);
      throw AdapterError("ERR_RTC_DECODED_FRAME", "MF supplied no GPU frame");
    }
    const auto found = submitted_.find(frame->timestampUs);
    if (found == submitted_.end() || !found->second.accepted ||
        found->second.duration_us != frame->durationUs) {
      output_diagnostic.Select(DecoderOutputOutcome::IdentityMismatch);
      throw AdapterError("ERR_RTC_DECODED_IDENTITY",
                         "Decoded texture does not map to exactly one accepted RTP access unit");
    }
    auto metadata = std::move(found->second);
    submitted_.erase(found);
    ++state()->decoded_gpu_frames;
    metadata.diagnostic->OutputMatched(output_diagnostic.begin());
    std::uint64_t epoch;
    {
      std::lock_guard lock(submit_mutex_);
      epoch = loss_epoch_;
    }
    if (stopping()) {
      output_diagnostic.Select(DecoderOutputOutcome::Stopping);
      metadata.diagnostic->ReleaseAs(DecoderInputReleaseReason::Stopped);
      return true;
    }
    if (metadata.loss_epoch != epoch) {
      output_diagnostic.Select(DecoderOutputOutcome::StaleLossEpoch);
      metadata.diagnostic->ReleaseAs(DecoderInputReleaseReason::StaleLossEpoch);
      return true;
    }
    if (!frame->texture || !frame->readyFence || !frame->readyValue ||
        frame->readyValue == UINT64_MAX || frame->colorSpace.fullRange ||
        frame->visibleRect.width != config_.width || frame->visibleRect.height != config_.height) {
      output_diagnostic.Select(DecoderOutputOutcome::InvalidLayout);
      metadata.diagnostic->ReleaseAs(DecoderInputReleaseReason::InvalidOutput);
      throw AdapterError("ERR_RTC_DECODED_LAYOUT", "MF did not supply a real qualified visible GPU surface");
    }
    if (!device_) {
      frame->texture->GetDevice(device_.put());
      winrt::com_ptr<ID3D11DeviceContext> immediate;
      device_->GetImmediateContext(immediate.put());
      context_ = immediate.as<ID3D11DeviceContext4>();
    }
    auto lease = std::make_shared<NativeLease>(
        shared_from_this(), frame, frame, device_, context_, frame->visibleRect, core_);
    auto buffer = MakeNativeBuffer(state(), std::move(lease));
    auto output = BuildOutput(metadata, buffer);
    DeliverOutput(metadata, output, output_diagnostic);
    return true;
  }

  static webrtc::VideoFrame BuildOutput(
      DecodeMetadata& metadata, webrtc::scoped_refptr<webrtc::VideoFrameBuffer> buffer) {
    return webrtc::VideoFrame::Builder()
        .set_video_frame_buffer(buffer)
        .set_rtp_timestamp(metadata.rtp)
        .set_timestamp_us(metadata.render_us)
        .set_ntp_time_ms(metadata.ntp_ms)
        .set_rotation(metadata.rotation)
        .set_color_space(std::optional<webrtc::ColorSpace>(Bt709Limited()))
        .set_presentation_timestamp(metadata.presentation)
        .set_id(metadata.tracking_id.value_or(webrtc::VideoFrame::kNotSetId))
        .set_packet_infos(std::move(metadata.packet_infos))
        .build();
  }

  void DeliverOutput(DecodeMetadata& metadata, webrtc::VideoFrame& output,
                     DecoderOutputDiagnostic& output_diagnostic) {
    const auto finish = env_.clock().CurrentTime();
    output.set_processing_time({webrtc::Timestamp::Millis(metadata.accepted_ms), finish});
    const auto elapsed = finish.ms() - metadata.accepted_ms;
    std::optional<std::int32_t> decode_ms;
    if (elapsed >= 0 && elapsed <= (std::numeric_limits<std::int32_t>::max)()) {
      decode_ms = static_cast<std::int32_t>(elapsed);
    } else {
      Report(Diagnostic("ERR_RTC_DECODE_CLOCK", "RTC clock cannot represent the measured decode interval"));
    }
    const bool invoked = callbacks_->Invoke(generation_, [&](webrtc::DecodedImageCallback& callback) {
      diagnostics_->Observe(DecoderInterval::OutputToCallback,
                            output_diagnostic.begin(), DecoderDiagnosticClock::now());
      output_diagnostic.Fallback(DecoderOutputOutcome::CallbackException);
      DecoderInputFailureGuard failure(*metadata.diagnostic, DecoderInputReleaseReason::CallbackException);
      diagnostics_->Measure(DecoderOperation::Callback, [&] {
        callback.Decoded(output, decode_ms, std::nullopt);
      });
      metadata.diagnostic->CallbackCompleted();
    });
    output_diagnostic.Select(invoked ? DecoderOutputOutcome::CallbackCompleted
                                     : DecoderOutputOutcome::CallbackRevoked);
    metadata.diagnostic->ReleaseAs(invoked ? DecoderInputReleaseReason::CallbackCompleted
                                          : DecoderInputReleaseReason::CallbackRevoked);
  }

  const webrtc::Environment env_;
  const NegotiatedH264 negotiated_;
  const DecoderSetup setup_;
  const std::shared_ptr<DecodeGate> callbacks_;
  const std::uint64_t generation_;
  const std::shared_ptr<Budget> admission_;
  const std::shared_ptr<DecoderDiagnosticLedger> diagnostics_ = std::make_shared<DecoderDiagnosticLedger>();
  std::mutex submit_mutex_;
  RtpTimeline timeline_;
  std::uint64_t next_request_id_ = 1, loss_epoch_ = 0;
  bool needs_keyframe_ = true, ever_queued_ = false;
  bool recovery_requested_ = false, recovery_in_progress_ = false;
  bool flushing_ = false, switching_ = false;
  std::optional<sv::H264Sps> current_sps_;
  sv::DecoderConfig config_;
  sv::DecoderStats stats_;
  bool core_observed_ = false;
  std::uint64_t core_generation_ = 0, observation_sequence_ = 0;
  std::optional<std::uint64_t> core_start_loss_epoch_;
  std::optional<std::int64_t> core_observed_at_rtc_us_;
  std::map<std::int64_t, DecodeMetadata> submitted_;
  std::deque<DecodeInput> pending_;
  std::shared_ptr<sv::MfH264Decoder> core_;
  RetiredDecoderSessions<sv::MfH264Decoder> retired_cores_;
  winrt::com_ptr<ID3D11Device> device_;
  winrt::com_ptr<ID3D11DeviceContext4> context_;
};

class MfVideoDecoder final : public webrtc::VideoDecoder {
 public:
  MfVideoDecoder(const webrtc::Environment& env, std::shared_ptr<SharedState> state,
                 NegotiatedH264 negotiated)
      : env_(env), state_(std::move(state)), negotiated_(negotiated),
        callbacks_(std::make_shared<DecodeGate>()) {}
  ~MfVideoDecoder() override { Release(); }

  bool Configure(const Settings& settings) override {
    bool configured = false;
    const auto error = Protect([&] {
      const auto setup = MakeDecoderSetup(settings, state_->options);
      std::uint64_t initialization;
      if (StopCurrent(&initialization) == WEBRTC_VIDEO_CODEC_TIMEOUT) return;
      const auto generation = callbacks_->Activate();
      auto worker = std::make_shared<DecoderWorker>(
          env_, state_, negotiated_, setup, callbacks_, generation);
      bool published = false;
      {
        std::lock_guard lock(mutex_);
        if (initialization == initialization_) {
          worker_ = worker;
          published = true;
        }
      }
      if (!published) {
        callbacks_->Deactivate(generation);
        return;
      }
      const auto started = worker->Start();
      {
        std::lock_guard lock(mutex_);
        configured = started == WEBRTC_VIDEO_CODEC_OK &&
            initialization == initialization_ && !worker->stopping();
        if (!configured && worker_ == worker) worker_.reset();
      }
      if (!configured) {
        callbacks_->Deactivate(generation);
        worker->RequestStop();
      }
    });
    if (error) state_->Report(0, *error);
    return configured;
  }
  std::int32_t Decode(const webrtc::EncodedImage& image, std::int64_t render_time_ms) override {
    return Decode(image, false, render_time_ms);
  }
  std::int32_t Decode(const webrtc::EncodedImage& image, bool missing_frames,
                      std::int64_t render_time_ms) override {
    const auto worker = Current();
    return worker ? worker->Submit(image, missing_frames, render_time_ms)
                  : WEBRTC_VIDEO_CODEC_UNINITIALIZED;
  }
  std::int32_t RegisterDecodeCompleteCallback(webrtc::DecodedImageCallback* callback) override {
    callbacks_->Register(callback);
    return WEBRTC_VIDEO_CODEC_OK;
  }
  std::int32_t Release() override {
    callbacks_->Clear();
    return StopCurrent();
  }
  DecoderInfo GetDecoderInfo() const override {
    DecoderInfo info{"Monky MF H264 native GPU adapter", false};
    info.monky_frame_info_lease_limit = state_->options.maximum_pending_frames;
    return info;
  }
  const char* ImplementationName() const override {
    return "Monky MF H264 native GPU adapter";
  }

 private:
  std::int32_t StopCurrent(std::uint64_t* initialization = nullptr) {
    std::shared_ptr<DecoderWorker> worker;
    {
      std::lock_guard lock(mutex_);
      ++initialization_;
      if (initialization) *initialization = initialization_;
      worker = std::move(worker_);
    }
    return worker ? worker->Stop() : WEBRTC_VIDEO_CODEC_OK;
  }
  std::shared_ptr<DecoderWorker> Current() const {
    std::lock_guard lock(mutex_);
    return worker_;
  }
  const webrtc::Environment env_;
  const std::shared_ptr<SharedState> state_;
  const NegotiatedH264 negotiated_;
  const std::shared_ptr<DecodeGate> callbacks_;
  mutable std::mutex mutex_;
  std::uint64_t initialization_ = 0;
  std::shared_ptr<DecoderWorker> worker_;
};

class MfDecoderFactory final : public webrtc::VideoDecoderFactory {
 public:
  explicit MfDecoderFactory(std::shared_ptr<SharedState> state) : state_(std::move(state)) {}
  std::vector<webrtc::SdpVideoFormat> GetSupportedFormats() const override {
    return SupportedFormats(state_->options.maximum_h264_level);
  }
  CodecSupport QueryCodecSupport(const webrtc::SdpVideoFormat& format,
                                 bool reference_scaling) const override {
    return {!reference_scaling &&
                ParseFormat(format, state_->options.maximum_h264_level).has_value(), false};
  }
  std::unique_ptr<webrtc::VideoDecoder> Create(
      const webrtc::Environment& env, const webrtc::SdpVideoFormat& format) override {
    const auto negotiated = ParseFormat(format, state_->options.maximum_h264_level);
    if (!negotiated) {
      state_->Report(0, Diagnostic("ERR_RTC_DECODER_FORMAT",
                                   "Unsupported H264 SDP format or scalability mode",
                                   WEBRTC_VIDEO_CODEC_ERR_PARAMETER));
      return nullptr;
    }
    return std::make_unique<MfVideoDecoder>(env, state_, *negotiated);
  }
 private:
  const std::shared_ptr<SharedState> state_;
};

}  // namespace

std::unique_ptr<webrtc::VideoDecoderFactory> MakeDecoderFactory(
    const std::shared_ptr<SharedState>& state) {
  return std::make_unique<MfDecoderFactory>(state);
}

}  // namespace monky::native_rtc::mf::detail

// Device-free DecoderWorker controls. Nothing below starts or initializes a worker.
#include "mf_rtc_decoder_submit_checks.h"

#include "api\environment\environment_factory.h"
#include "api\make_ref_counted.h"
#include "modules\video_coding\generic_decoder.h"
#include "modules\video_coding\include\video_coding_defines.h"
#include "rtc_base\logging.h"
#include "system_wrappers\include\clock.h"

#include <numeric>
#include <string_view>

namespace monky::native_rtc::mf::detail {

struct DecoderMappingQueueChecksAccess {
  static std::function<void()> Take(Worker& worker) {
    std::lock_guard lock(worker.queue_mutex_);
    if (worker.running_thread_id_.load() || worker.slot_ || worker.queued_readbacks_)
      throw std::runtime_error("CPU mapping fixture reached a started/readback worker");
    if (worker.queue_.empty()) return {};
    auto& task = worker.queue_.front();
    if (task.readback || task.encoder_diagnostic || !task.decoder_diagnostic || !worker.queued_media_)
      throw std::runtime_error("CPU mapping fixture encountered non-decoder work");
    auto function = std::move(task.function);
    worker.queue_.pop_front();
    --worker.queued_media_;
    return function;
  }
};

namespace {

// The ordinary friend seam only accesses our adapter, never SDK private state.
// An unstarted worker has no slot: RuntimeSnapshot is copied, never published.
struct DecoderSubmitChecksAccess {
  static std::shared_ptr<const DecoderDiagnosticLedger> Ledger(const DecoderWorker& worker) {
    return worker.diagnostics_;
  }
  static DecoderRuntimeSnapshot Runtime(DecoderWorker& worker) { return worker.RuntimeSnapshot(); }
  static std::weak_ptr<Budget> Admission(const DecoderWorker& worker) { return worker.admission_; }
  static bool CanAdmit(DecoderWorker& worker, std::size_t bytes) {
    return static_cast<bool>(worker.admission_->Acquire(bytes));
  }
  static std::shared_ptr<Budget::Ticket> HoldAdmission(DecoderWorker& worker, std::size_t bytes) {
    return worker.admission_->Acquire(bytes);
  }
  static std::uint64_t NextRequest(const DecoderWorker& worker) { return worker.next_request_id_; }
  static RtpTimeline Timeline(DecoderWorker& worker) {
    std::lock_guard lock(worker.submit_mutex_);
    return worker.timeline_;
  }
  static void ExhaustRequestIds(DecoderWorker& worker) {
    worker.next_request_id_ = (std::numeric_limits<std::uint64_t>::max)();
  }
  static bool NoCore(const DecoderWorker& worker) {
    const auto& stats = worker.stats_;
    return !worker.core_ && !worker.device_ && !worker.context_ && !worker.core_observed_ &&
        !worker.core_observed_at_rtc_us_ && !worker.core_start_loss_epoch_ &&
        worker.core_generation_ == 0 && worker.retired_cores_.Retired() == 0 &&
        !worker.current_sps_ && worker.config_.width == 0 && worker.config_.height == 0 &&
        stats.accepted == 0 && stats.submitted == 0 && stats.inputBytes == 0 &&
        stats.outputSamples == 0 && stats.gpuFrames == 0 && stats.gpuCopies == 0 &&
        stats.droppedInput == 0 && stats.droppedAfterSubmit == 0 &&
        stats.diagnosticReadbacks == 0 && stats.i420Readbacks == 0 &&
        !stats.hardwareExecutionObserved && worker.retained() == 0;
  }
  static void RequireNoCore(const DecoderWorker& worker) {
    if (!NoCore(worker)) throw std::runtime_error("CPU decoder control reached a media core");
  }
  static void FailWorker(DecoderWorker& worker) {
    worker.Fail(Diagnostic("ERR_RTC_CPU_WORKER", "Controlled unstarted worker failure"));
  }
  static void RequestRecovery(DecoderWorker& worker) {
    worker.RequestRecovery(Diagnostic("ERR_RTC_CPU_RECOVERY", "Controlled input loss during admission"));
  }
  static bool PostInert(DecoderWorker& worker, unsigned& executed) {
    return worker.PostMedia([&executed] { ++executed; });
  }
  static std::size_t CancelQueued(
      DecoderWorker& worker, std::optional<DecoderInputReleaseReason> reason = std::nullopt) {
    return worker.CancelQueuedMedia(std::nullopt, reason);
  }
  static void RecoverWithoutCore(DecoderWorker& worker) {
    RequireNoCore(worker);
    worker.BeforeWork();
  }
  static void Switching(DecoderWorker& worker, bool value) { worker.switching_ = value; }
  static void DispatchQueuedToPending(DecoderWorker& worker) {
    RequireNoCore(worker);
    worker.switching_ = true;
    while (auto function = DecoderMappingQueueChecksAccess::Take(worker)) function();
    worker.switching_ = false;
    RequireNoCore(worker);
  }
  static DecodeInput TakePending(DecoderWorker& worker) {
    RequireNoCore(worker);
    if (worker.pending_.empty()) throw std::runtime_error("CPU mapping fixture has no pending input");
    auto input = std::move(worker.pending_.front());
    worker.pending_.pop_front();
    return input;
  }
  static bool Current(DecoderWorker& worker, const DecodeMetadata& metadata) {
    return worker.CurrentInput(metadata);
  }
  static DecodeInput DispatchInput(DecoderWorker& worker, sv::EncodedPacket packet,
                                   AccessUnitInfo information, DecodeMetadata metadata) {
    RequireNoCore(worker);
    metadata.loss_epoch = worker.loss_epoch_;
    metadata.admission = worker.admission_->Acquire(packet.data.size());
    if (!metadata.admission) throw std::runtime_error("CPU metadata fixture exhausted admission");
    metadata.diagnostic = std::make_shared<DecoderInputDiagnosticTicket>(
        worker.diagnostics_, metadata.loss_epoch, DecoderDiagnosticClock::now());
    // Controlled metadata starts at dispatch, without claiming PostMedia ran.
    metadata.diagnostic->Dispatched();
    return {std::move(packet), std::move(information), std::move(metadata)};
  }
  static void EnqueueOnlyPendingOrStale(DecoderWorker& worker, DecodeInput input) {
    RequireNoCore(worker);
    if (worker.CurrentInput(input.metadata) && !worker.switching_ && worker.pending_.empty())
      throw std::runtime_error("CPU enqueue fixture would enter session creation");
    worker.EnqueueOnWorker(std::move(input));
  }
  static void DecodeOnlyStale(DecoderWorker& worker, DecodeInput input) {
    RequireNoCore(worker);
    if (worker.CurrentInput(input.metadata))
      throw std::runtime_error("CPU stale fixture would enter session planning");
    worker.DecodeOnWorker(std::move(input));
  }
  static void DecodeOnlyInvalidSession(DecoderWorker& worker, DecodeInput input) {
    RequireNoCore(worker);
    const bool contradicts_sps = input.access_unit.sps && input.metadata.encoded_width &&
        (input.metadata.encoded_width != input.access_unit.sps->width ||
         input.metadata.encoded_height != input.access_unit.sps->height);
    if (input.access_unit.sps && !contradicts_sps)
      throw std::runtime_error("CPU invalid-session fixture could create a decoder");
    worker.DecodeOnWorker(std::move(input));
  }
  static void DropPending(DecoderWorker& worker, DecoderInputReleaseReason reason) {
    worker.DropPending(reason);
  }
  static void BeginStopWithoutCore(DecoderWorker& worker) {
    RequireNoCore(worker);
    worker.BeginStopCore();
  }
  static void DropSubmitted(DecoderWorker& worker, DecoderInputReleaseReason reason) {
    worker.DropSubmitted(reason);
  }
  static void SubmitMetadata(DecoderWorker& worker, DecodeInput input) {
    RequireNoCore(worker);
    // Position metadata for the real accepted/output handlers. This does NOT
    // invoke Enqueue or ProcessInput, and the core operation counters stay zero.
    input.metadata.diagnostic->CoreAccepted();
    if (!worker.submitted_.emplace(input.packet.timestampUs, std::move(input.metadata)).second)
      throw std::runtime_error("CPU submitted metadata reused a PTS");
  }
  static const DecodeMetadata& Submitted(const DecoderWorker& worker, std::int64_t pts) {
    return worker.submitted_.at(pts);
  }
  static DecodeMetadata TakeSubmitted(DecoderWorker& worker, std::int64_t pts) {
    auto node = worker.submitted_.extract(pts);
    if (node.empty()) throw std::runtime_error("CPU output has no submitted metadata");
    return std::move(node.mapped());
  }
  static void Accepted(DecoderWorker& worker, std::uint64_t request) { worker.OnAccepted(request); }
  static bool Frame(DecoderWorker& worker, std::shared_ptr<const sv::GpuDecodedFrame> frame) {
    RequireNoCore(worker);
    if (frame && (frame->texture || frame->readyFence))
      throw std::runtime_error("CPU output rejection fixture contains GPU objects");
    return worker.OnFrame(std::move(frame));
  }
  static webrtc::VideoFrame BuildOutput(
      DecodeMetadata& metadata, webrtc::scoped_refptr<webrtc::VideoFrameBuffer> buffer) {
    return DecoderWorker::BuildOutput(metadata, std::move(buffer));
  }
  static DecoderOutputDiagnostic ObserveOutput(DecoderWorker& worker) {
    return DecoderOutputDiagnostic(*worker.diagnostics_, &DecoderDiagnosticSnapshot::output,
                                   DecoderOutputOutcome::Exception);
  }
  static void DeliverOutput(DecoderWorker& worker, DecodeMetadata& metadata,
                            webrtc::VideoFrame& output, DecoderOutputDiagnostic& diagnostic) {
    RequireNoCore(worker);
    worker.DeliverOutput(metadata, output, diagnostic);
  }
};

namespace cpu_decoder_submit_checks {

using Check = void (*)(bool, const char*);
using Access = DecoderSubmitChecksAccess;
using Outcome = DecoderSubmitOutcome;
using Stage = DecoderInputStage;
using Reason = DecoderInputReleaseReason;
using Output = DecoderOutputOutcome;
using Bytes = std::vector<std::uint8_t>;

static_assert(kMaximumAccessUnitBytes == 8 * 1024 * 1024);

std::uint64_t Sum(const auto& values) {
  return std::accumulate(values.begin(), values.end(), std::uint64_t{0});
}
const DecoderInputStageDiagnostics& At(const DecoderDiagnosticSnapshot& snapshot, Stage stage) {
  return snapshot.inputs[static_cast<std::size_t>(stage)];
}
std::uint64_t Released(const DecoderDiagnosticSnapshot& snapshot, Stage stage, Reason reason) {
  return At(snapshot, stage).releases[static_cast<std::size_t>(reason)];
}
bool Conserved(const DecoderDiagnosticSnapshot& snapshot) {
  if (snapshot.submit.calls != snapshot.submit.in_progress + Sum(snapshot.submit.outcomes) ||
      snapshot.output.calls != snapshot.output.in_progress + Sum(snapshot.output.outcomes)) return false;
  for (const auto& stage : snapshot.inputs)
    if (stage.entered != stage.active + stage.transitioned + Sum(stage.releases)) return false;
  for (const auto& operation : snapshot.operations)
    if (operation.calls != operation.in_progress + operation.returned + operation.exceptions) return false;
  return true;
}
bool SameInputs(const auto& first, const auto& second) {
  for (std::size_t i = 0; i < first.size(); ++i) {
    if (first[i].entered != second[i].entered || first[i].active != second[i].active ||
        first[i].transitioned != second[i].transitioned || first[i].releases != second[i].releases)
      return false;
  }
  return true;
}
void ExpectRelease(Check check, const DecoderDiagnosticSnapshot& before,
                   const DecoderDiagnosticSnapshot& after, Stage stage, Reason reason,
                   std::uint64_t count, const char* message) {
  auto expected = before.inputs;
  auto& value = expected[static_cast<std::size_t>(stage)];
  check(value.active >= count, "CPU release expectation underflowed its original active owners");
  value.active -= count;
  value.releases[static_cast<std::size_t>(reason)] += count;
  check(SameInputs(after.inputs, expected) && Conserved(after), message);
}
std::optional<std::int64_t> ProbeTimeline(RtpTimeline timeline, std::uint32_t rtp) {
  std::optional<std::int64_t> result;
  Protect([&] { result = timeline.Push(rtp); });
  return result;
}
bool SameTimeline(const RtpTimeline& first, const RtpTimeline& second, std::uint32_t rtp) {
  for (const auto offset : {0u, 1u, 3000u, 0x7fffffffu, 0x80000000u, 0xffffffffu})
    if (ProbeTimeline(first, rtp + offset) != ProbeTimeline(second, rtp + offset)) return false;
  return true;
}
void ExpectedError(Check check, const std::optional<AdapterDiagnostic>& error,
                   const char* code, std::int32_t status = WEBRTC_VIDEO_CODEC_ERR_PARAMETER) {
  check(error && std::string_view(error->code.data()) == code && error->codec_status == status,
        "CPU branch did not preserve its actual adapter exception/code/status");
}

Bytes ParserPacket(bool main_profile = false) {
  // Exact parser-only fixture from abi\adapter_policy_probe.cc; never decode it.
  Bytes sps{0x67, 0x42, 0xc0, 0x33, 0xf4, 0x03, 0xc0, 0x11, 0x3f, 0x2a};
  if (main_profile) { sps[1] = 77; sps[2] = 0; }
  Bytes packet{0, 0, 0, 1};
  packet.insert(packet.end(), sps.begin(), sps.end());
  packet.insert(packet.end(), {0, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80,
                               0, 0, 0, 1, 0x65, 0xbc});
  return packet;
}
enum class Packet { Full, Delta, IdrWithoutSps, MainProfile, Malformed };
enum class Storage { Normal, Missing, NullData, Empty, Oversized, Truncated };
enum class TicketPath { None, Queued, NotQueued };

struct Input {
  Packet packet = Packet::Full;
  Storage storage = Storage::Normal;
  std::size_t padded_size = 0, packet_count = 2;
  std::uint32_t rtp = 90000, width = 1920, height = 1080;
  std::int64_t render_ms = 9137;
  webrtc::VideoFrameType type = webrtc::VideoFrameType::kVideoFrameKey;
  webrtc::VideoRotation rotation = webrtc::kVideoRotation_90;
  int spatial = 0, temporal = 0, simulcast = 0;
  bool wrong_color = false, missing_frames = false;
  unsigned throw_on_data_call = 0;
};
Bytes PacketBytes(const Input& input) {
  Bytes bytes;
  switch (input.packet) {
    case Packet::Full: bytes = ParserPacket(); break;
    case Packet::MainProfile: bytes = ParserPacket(true); break;
    case Packet::Delta: bytes = {0, 0, 0, 1, 0x41, 0xf0}; break;
    case Packet::IdrWithoutSps: bytes = {0, 0, 0, 1, 0x65, 0xbc}; break;
    case Packet::Malformed: bytes = ParserPacket(); bytes[0] = 1; break;
  }
  if (input.padded_size) {
    // Annex B filler exercises the byte cap only; it is not decodable media.
    bytes.insert(bytes.end(), {0, 0, 0, 1, 0x0c});
    if (input.padded_size < bytes.size() || input.padded_size > kMaximumAccessUnitBytes)
      throw std::runtime_error("CPU AU padding exceeds its parser-only bound");
    bytes.resize(input.padded_size, 0xff);
  }
  return bytes;
}
webrtc::RtpPacketInfos Packets(std::uint32_t rtp, std::size_t count = 2) {
  webrtc::RtpPacketInfos::vector_type packets;
  for (std::size_t i = 0; i < count; ++i)
    packets.emplace_back(101u + static_cast<std::uint32_t>(i), std::vector<std::uint32_t>{77, 88},
                         rtp, webrtc::Timestamp::Micros(7000123 + static_cast<std::int64_t>(i)));
  return webrtc::RtpPacketInfos(std::move(packets));
}
bool SamePackets(const webrtc::RtpPacketInfos& first, const webrtc::RtpPacketInfos& second) {
  return first.size() == second.size() && std::equal(first.begin(), first.end(), second.begin());
}

class EncodedBuffer : public webrtc::EncodedImageBufferInterface {
 public:
  explicit EncodedBuffer(Bytes bytes) : bytes(std::move(bytes)), reported_size(this->bytes.size()) {}
  const std::uint8_t* data() const override { return GetData(); }
  std::uint8_t* data() override { GetData(); return null_data ? nullptr : bytes.data(); }
  std::size_t size() const override { return reported_size; }
  std::weak_ptr<int> Lifetime() const { return lifetime_; }
  Bytes bytes;
  std::size_t reported_size;
  bool null_data = false;
  unsigned throw_on_data_call = 0;
  mutable unsigned data_calls = 0;
  const DecoderDiagnosticLedger* ledger = nullptr;
  mutable std::optional<DecoderDiagnosticSnapshot> during_throw;

 private:
  const std::uint8_t* GetData() const {
    if (++data_calls == throw_on_data_call) {
      during_throw = ledger->Snapshot();
      throw std::runtime_error("CPU encoded data getter failure");
    }
    return null_data ? nullptr : bytes.data();
  }
  const std::shared_ptr<int> lifetime_ = std::make_shared<int>(0);
};

enum class CallbackAction { Complete, Throw, Unregister, UnregisterAndStop };
class Callback final : public webrtc::DecodedImageCallback {
 public:
  std::int32_t Decoded(webrtc::VideoFrame&) override {
    ++legacy_calls;
    return WEBRTC_VIDEO_CODEC_ERROR;
  }
  void Decoded(webrtc::VideoFrame& output, std::optional<std::int32_t> elapsed,
               std::optional<std::uint8_t> qp) override {
    ++calls;
    rtp = output.rtp_timestamp();
    render_us = output.timestamp_us();
    ntp_ms = output.ntp_time_ms();
    rotation = output.rotation();
    presentation = output.presentation_timestamp();
    tracking = output.id();
    packets = output.packet_infos();
    processing = output.processing_time();
    decode_ms = elapsed;
    no_qp = !qp;
    cpu_buffer = output.video_frame_buffer()->type() == webrtc::VideoFrameBuffer::Type::kI420;
    color_ok = output.color_space() && IsBt709Limited(*output.color_space());
    during = ledger->Snapshot();
    invoked_on_this_thread = gate->IsInvokingOnCurrentThread();
    if (action == CallbackAction::Unregister || action == CallbackAction::UnregisterAndStop)
      gate->Register(nullptr);
    if (action == CallbackAction::UnregisterAndStop) worker->RequestStop();
    if (action == CallbackAction::Throw) throw std::runtime_error("CPU void decoded callback failure");
  }
  DecoderWorker* worker = nullptr;
  DecodeGate* gate = nullptr;
  const DecoderDiagnosticLedger* ledger = nullptr;
  CallbackAction action = CallbackAction::Complete;
  unsigned calls = 0, legacy_calls = 0;
  std::uint32_t rtp = 0;
  std::int64_t render_us = 0, ntp_ms = 0;
  webrtc::VideoRotation rotation = webrtc::kVideoRotation_0;
  std::optional<webrtc::Timestamp> presentation;
  std::uint16_t tracking = 0;
  webrtc::RtpPacketInfos packets;
  std::optional<webrtc::VideoFrame::ProcessingTime> processing;
  std::optional<std::int32_t> decode_ms;
  std::optional<DecoderDiagnosticSnapshot> during;
  bool no_qp = false, cpu_buffer = false, color_ok = false, invoked_on_this_thread = false;
};

struct WeakInput {
  explicit WeakInput(const DecodeMetadata& metadata)
      : admission(metadata.admission), diagnostic(metadata.diagnostic) {}
  bool OwnedOnce() const { return admission.use_count() == 1 && diagnostic.use_count() == 1; }
  bool Expired() const { return admission.expired() && diagnostic.expired(); }
  std::weak_ptr<Budget::Ticket> admission;
  std::weak_ptr<DecoderInputDiagnosticTicket> diagnostic;
};

class Fixture {
 public:
  Fixture(Check check, const webrtc::Environment& env, AdapterOptions options = {})
      : check(check), env(env), state(std::make_shared<SharedState>(options)),
        callback(std::make_shared<Callback>()), callbacks(std::make_shared<DecodeGate>()) {
    callbacks->Register(callback.get());
    worker = NewWorker();
    ledger = Access::Ledger(*worker);
    callback->worker = worker.get();
    callback->gate = callbacks.get();
    callback->ledger = ledger.get();
    CpuOnly();
  }
  ~Fixture() { if (callbacks) callbacks->Clear(); }

  std::shared_ptr<DecoderWorker> NewWorker() {
    return std::make_shared<DecoderWorker>(
        env, state, NegotiatedH264{sv::H264Profile::ConstrainedBaseline, 52},
        DecoderSetup{4096, 4096, 8}, callbacks, callbacks->Activate());
  }
  void CpuOnly() {
    const auto diagnostic = ledger->Snapshot();
    const auto shared = state->Snapshot();
    const auto runtime = Access::Runtime(*worker);
    bool no_core_operations = true;
    for (std::size_t i = 0; i < diagnostic.operations.size(); ++i) {
      if (i != static_cast<std::size_t>(DecoderOperation::Callback))
        no_core_operations = no_core_operations && diagnostic.operations[i].calls == 0;
    }
    check(Access::NoCore(*worker) && no_core_operations && !runtime.core_observed &&
          runtime.session_id == worker->id() && runtime.core_generation == 0 &&
          runtime.loss_epoch == diagnostic.current_loss_epoch &&
          runtime.maximum_width == 4096 && runtime.maximum_height == 4096 &&
          runtime.maximum_in_flight == 8 &&
          runtime.maximum_pending_frames == state->options.maximum_pending_frames &&
          runtime.maximum_pending_bytes == 32 * 1024 * 1024 &&
          runtime.capability_fps_hint == 30 && runtime.capability_bitrate_hint_bps == 4000000 &&
          shared.live_workers == 0 && shared.decoders.empty() && shared.encoders.empty() &&
          shared.native_buffers == 0 && !shared.hardware_execution_observed &&
          shared.encoded_access_units == 0 && shared.rtc_rejected_access_units == 0 &&
          shared.i420_readbacks == 0 && shared.i420_failures == 0 &&
          shared.decoded_gpu_frames == matched_rejection_metadata &&
          inert_executed == 0 && callback->legacy_calls == 0 && Conserved(diagnostic),
          "Unstarted decoder controls started/published media, changed caps or lost scalar conservation");
  }
  void Error(const char* code, std::int32_t status = WEBRTC_VIDEO_CODEC_ERR_PARAMETER,
             bool terminal = false) {
    const auto errors = state->TakeDiagnostics();
    check(errors.size() == 1 && errors.front().session_id == worker->id() &&
          std::string_view(errors.front().code.data()) == code &&
          errors.front().codec_status == status && errors.front().terminal == terminal,
          "Actual decoder branch lost/duplicated its reported session diagnostic");
  }

  void Submit(const Input& input, Outcome outcome, std::int32_t expected_status,
              const char* message, TicketPath path = TicketPath::None) {
    if (outcome == Outcome::Queued) path = TicketPath::Queued;
    if (outcome == Outcome::PostMediaRejected) path = TicketPath::NotQueued;
    const auto before = ledger->Snapshot();
    const auto held_runtime = Access::Runtime(*worker);
    const auto held_shared = state->Snapshot();
    auto expected_timeline = Access::Timeline(*worker);
    const auto next_request = Access::NextRequest(*worker);
    const auto callbacks_before = callback->calls;
    std::weak_ptr<int> original_buffer;
    {
      const auto bytes = PacketBytes(input);
      auto buffer = webrtc::make_ref_counted<EncodedBuffer>(bytes);
      original_buffer = buffer->Lifetime();
      buffer->ledger = ledger.get();
      if (input.storage == Storage::Oversized) buffer->reported_size = kMaximumAccessUnitBytes + 1;
      webrtc::EncodedImage image;
      image.SetEncodedData(buffer);
      image.SetRtpTimestamp(input.rtp);
      image.ntp_time_ms_ = 1234567;
      image._encodedWidth = input.width;
      image._encodedHeight = input.height;
      image.rotation_ = input.rotation;
      image.SetFrameType(input.type);
      image.SetSpatialIndex(input.spatial);
      image.SetTemporalIndex(input.temporal);
      image.SetSimulcastIndex(input.simulcast);
      image.SetPresentationTimestamp(webrtc::Timestamp::Micros(8000456));
      image.SetVideoFrameTrackingId(73);
      const auto packets = Packets(input.rtp, input.packet_count);
      image.SetPacketInfos(packets);
      const auto color = input.wrong_color
          ? webrtc::ColorSpace(webrtc::ColorSpace::PrimaryID::kBT709,
                webrtc::ColorSpace::TransferID::kBT709, webrtc::ColorSpace::MatrixID::kBT709,
                webrtc::ColorSpace::RangeID::kFull)
          : Bt709Limited();
      image.SetColorSpace(color);
      if (input.storage == Storage::Missing) image.ClearEncodedData();
      if (input.storage == Storage::Empty) image.set_size(0);
      if (input.storage == Storage::Truncated) --buffer->reported_size;
      buffer->null_data = input.storage == Storage::NullData;
      buffer->throw_on_data_call = input.throw_on_data_call;
      const auto image_size = image.size();
      const auto result = worker->Submit(image, input.missing_frames, input.render_ms);
      const auto after = ledger->Snapshot();
      auto expected_outcomes = before.submit.outcomes;
      ++expected_outcomes[static_cast<std::size_t>(outcome)];
      check(result == expected_status && after.submit.calls == before.submit.calls + 1 &&
            after.submit.in_progress == 0 && after.submit.outcomes == expected_outcomes &&
            after.submit.duration.count == before.submit.duration.count + 1 && Conserved(after), message);
      auto expected_inputs = before.inputs;
      if (path != TicketPath::None) {
        auto& posting = expected_inputs[static_cast<std::size_t>(Stage::Posting)];
        ++posting.entered;
        if (path == TicketPath::Queued) {
          ++posting.transitioned;
          auto& queued = expected_inputs[static_cast<std::size_t>(Stage::Queued)];
          ++queued.entered;
          ++queued.active;
        } else ++posting.releases[static_cast<std::size_t>(Reason::NotQueued)];
      }
      check(SameInputs(after.inputs, expected_inputs) && callback->calls == callbacks_before &&
            after.output.calls == before.output.calls &&
            after.accepted_callbacks == before.accepted_callbacks,
            "Submit fabricated dispatch/MF acceptance, released queued metadata or duplicated a ticket");
      if (outcome == Outcome::Queued) expected_timeline.Push(input.rtp);
      check(Access::NextRequest(*worker) == next_request + (outcome == Outcome::Queued ? 1u : 0u) &&
            SameTimeline(Access::Timeline(*worker), expected_timeline, input.rtp),
            "Rejected Submit consumed a request/RTP PTS or successful Submit rewrote the timeline");
      const bool early = outcome == Outcome::WorkerStatus || outcome == Outcome::Stopping ||
          outcome == Outcome::NoCallback || outcome == Outcome::MissingFrames;
      if (early) check(buffer->data_calls == 0, "Submit precedence evaluated an encoded data getter early");
      if (outcome == Outcome::Exception) {
        check(buffer->during_throw && buffer->during_throw->submit.in_progress == 1 &&
              buffer->during_throw->submit.outcomes == before.submit.outcomes &&
              Conserved(*buffer->during_throw),
              "The actual throwing data getter observed an already-settled/double-counted Submit");
        if (path == TicketPath::NotQueued)
          check(At(*buffer->during_throw, Stage::Posting).active == At(before, Stage::Posting).active + 1 &&
                At(*buffer->during_throw, Stage::Posting).releases == At(before, Stage::Posting).releases,
                "An admitted throwing getter released its live metadata before unwinding");
      }
      check(buffer->bytes == bytes && image.size() == image_size && image.RtpTimestamp() == input.rtp &&
            image.ntp_time_ms_ == 1234567 && image.rotation() == input.rotation &&
            image._encodedWidth == input.width && image._encodedHeight == input.height &&
            image.PresentationTimestamp() == webrtc::Timestamp::Micros(8000456) &&
            image.VideoFrameTrackingId() == 73 && SamePackets(image.PacketInfos(), packets) &&
            (input.storage == Storage::Missing ? !image.GetEncodedData()
                                               : image.GetEncodedData().get() == buffer.get()),
            "Submit diagnostics rewrote or retained the original encoded-buffer/RTC provenance");
    }
    check(original_buffer.expired() && held_runtime.diagnostic_ledger.get() == ledger.get() &&
          held_shared.live_workers == 0 && held_shared.decoders.empty(),
          "A queued AU, snapshot or diagnostic ledger retained the caller's encoded buffer instead of its copy");
    CpuOnly();
  }

  DecodeInput Metadata(std::uint64_t request, std::int64_t pts, Packet packet = Packet::Full) {
    DecodeMetadata metadata;
    metadata.request_id = request;
    metadata.rtp = 0xfffffff0u;
    metadata.render_us = 9137000;
    metadata.ntp_ms = 1234567;
    metadata.duration_us = 17003;
    metadata.encoded_width = 1920;
    metadata.encoded_height = 1080;
    metadata.rotation = webrtc::kVideoRotation_90;
    metadata.presentation = webrtc::Timestamp::Micros(8000456);
    metadata.tracking_id = 73;
    metadata.packet_infos = Packets(metadata.rtp);
    sv::EncodedPacket encoded;
    encoded.data = PacketBytes(Input{.packet = packet});
    encoded.timestampUs = pts;
    encoded.durationUs = metadata.duration_us;
    auto information = InspectAccessUnit(encoded.data);
    encoded.keyFrame = information.keyframe;
    return Access::DispatchInput(*worker, std::move(encoded), std::move(information), std::move(metadata));
  }
  void Recover() { Access::RecoverWithoutCore(*worker); CpuOnly(); }

  void Finish(bool verify_new_session = false) {
    const auto held = ledger->Snapshot();
    const auto runtime = Access::Runtime(*worker);
    const auto shared = state->Snapshot();
    std::weak_ptr<DecoderWorker> weak_worker = worker;
    const auto weak_budget = Access::Admission(*worker);
    std::weak_ptr<Callback> weak_callback = callback;
    std::weak_ptr<DecodeGate> weak_gate = callbacks;
    std::weak_ptr<SharedState> weak_state = state;
    callbacks->Clear();
    worker.reset();
    const auto released = ledger->Snapshot();
    auto expected = held.inputs;
    for (std::size_t i = 0; i < expected.size(); ++i) {
      auto& stage = expected[i];
      stage.releases[static_cast<std::size_t>(
          i == static_cast<std::size_t>(Stage::Posting) ? Reason::NotQueued : Reason::Abandoned)] += stage.active;
      stage.active = 0;
    }
    check(weak_worker.expired() && weak_budget.expired() && SameInputs(released.inputs, expected) &&
          released.submit.calls == held.submit.calls && released.submit.outcomes == held.submit.outcomes &&
          released.output.outcomes == held.output.outcomes && Conserved(held) && Conserved(released) &&
          runtime.diagnostic_ledger.get() == ledger.get() && shared.live_workers == 0 &&
          state->Snapshot().decoders.empty() && state->TakeDiagnostics().empty(),
          "Retained diagnostics extended worker/admission/metadata lifetime or lost destruction releases");
    if (verify_new_session) {
      auto fresh = NewWorker();
      const auto fresh_ledger = Access::Ledger(*fresh);
      const auto fresh_snapshot = fresh_ledger->Snapshot();
      const auto fresh_runtime = Access::Runtime(*fresh);
      std::weak_ptr<DecoderWorker> weak_fresh = fresh;
      const auto weak_fresh_budget = Access::Admission(*fresh);
      bool no_operations_or_intervals = true;
      for (const auto& operation : fresh_snapshot.operations)
        no_operations_or_intervals = no_operations_or_intervals && operation.calls == 0;
      for (const auto& interval : fresh_snapshot.intervals)
        no_operations_or_intervals = no_operations_or_intervals &&
            interval.count == 0 && interval.invalidIntervals == 0;
      check(fresh_runtime.session_id != runtime.session_id && fresh_runtime.loss_epoch == 0 &&
            fresh_snapshot.submit.calls == 0 && fresh_snapshot.output.calls == 0 &&
            fresh_snapshot.accepted_callbacks == 0 && fresh_snapshot.recovery_requests == 0 &&
            fresh_snapshot.accepted_unknown == 0 && fresh_snapshot.accepted_duplicate == 0 &&
            fresh_snapshot.epoch_advances == 0 && fresh_snapshot.current_loss_epoch == 0 &&
            fresh_snapshot.recoveries_begun == 0 && fresh_snapshot.recoveries_finished == 0 &&
            fresh_snapshot.session_switches == 0 && !fresh_snapshot.last_accepted_loss_epoch &&
            !fresh_snapshot.last_output_loss_epoch && no_operations_or_intervals &&
            SameInputs(fresh_snapshot.inputs, DecoderDiagnosticSnapshot{}.inputs) &&
            Access::NextRequest(*fresh) == 1 && ProbeTimeline(Access::Timeline(*fresh), 90000) == 0 &&
            Access::NoCore(*fresh) && state->Snapshot().live_workers == 0 && Conserved(fresh_snapshot),
            "A new actual worker reused its predecessor's session, ledger, epoch or input timeline");
      fresh.reset();
      check(weak_fresh.expired() && weak_fresh_budget.expired() && Conserved(fresh_ledger->Snapshot()),
            "A fresh runtime snapshot retained its unstarted worker/admission");
    }
    callback.reset();
    callbacks.reset();
    state.reset();
    check(weak_callback.expired() && weak_gate.expired() && weak_state.expired() &&
          runtime.diagnostic_ledger->Snapshot().submit.calls == held.submit.calls &&
          Conserved(ledger->Snapshot()),
          "A held decoder snapshot/ledger retained the callback gate, callback or SharedState");
  }

  Check check;
  const webrtc::Environment& env;
  std::shared_ptr<SharedState> state;
  std::shared_ptr<Callback> callback;
  std::shared_ptr<DecodeGate> callbacks;
  std::shared_ptr<DecoderWorker> worker;
  std::shared_ptr<const DecoderDiagnosticLedger> ledger;
  unsigned inert_executed = 0;
  std::uint64_t matched_rejection_metadata = 0;
};

void RunSubmitBranches(Check check, const webrtc::Environment& env) {
  {
    Fixture fixture(check, env);
    fixture.callbacks->Register(nullptr);
    const Input unread{.missing_frames = true, .throw_on_data_call = 1};
    fixture.Submit(unread, Outcome::NoCallback, WEBRTC_VIDEO_CODEC_UNINITIALIZED,
                   "NoCallback did not win exactly once over missing frames/data validation");
    fixture.worker->RequestStop();
    fixture.Submit(unread, Outcome::Stopping, WEBRTC_VIDEO_CODEC_UNINITIALIZED,
                   "Stopping did not win exactly once over callback/missing-frame validation");
    Access::FailWorker(*fixture.worker);
    fixture.Error("ERR_RTC_CPU_WORKER", WEBRTC_VIDEO_CODEC_ERROR, true);
    fixture.Submit(unread, Outcome::WorkerStatus, WEBRTC_VIDEO_CODEC_ERROR,
                   "The actual Fail status did not win exactly once over stopping/callback validation");
    check(fixture.ledger->Snapshot().recovery_requests == 0,
          "Early Submit refusal manufactured an input-loss recovery");
    fixture.Finish();
  }
  {
    Fixture fixture(check, env);
    fixture.Submit({.missing_frames = true, .throw_on_data_call = 1},
                   Outcome::MissingFrames, WEBRTC_VIDEO_CODEC_ERROR,
                   "MissingFrames did not settle exactly once before the throwing data getter");
    fixture.Error("ERR_RTC_MISSING_FRAME", WEBRTC_VIDEO_CODEC_ERROR);
    fixture.Submit({.spatial = 1}, Outcome::Validation, WEBRTC_VIDEO_CODEC_ERR_PARAMETER,
                   "Input validation did not precede an already-requested recovery");
    fixture.Error("ERR_RTC_DECODER_LAYERS");
    fixture.Submit({}, Outcome::RecoveryPending, WEBRTC_VIDEO_CODEC_ERROR,
                   "A valid AU during actual recovery was not counted solely as RecoveryPending");
    const auto pending = fixture.ledger->Snapshot();
    const auto runtime = Access::Runtime(*fixture.worker);
    check(pending.recovery_requests == 2 && pending.epoch_advances == 1 &&
          pending.current_loss_epoch == 1 && runtime.recovery_requested &&
          !runtime.recovery_in_progress && runtime.needs_keyframe,
          "Repeated recovery requests advanced an already-active loss epoch or reset lifetime totals");
    fixture.Recover();
    const auto finished = fixture.ledger->Snapshot();
    check(finished.submit.calls == pending.submit.calls && finished.submit.outcomes == pending.submit.outcomes &&
          finished.recoveries_begun == 1 && finished.recoveries_finished == 1 &&
          finished.current_loss_epoch == 1 && !Access::Runtime(*fixture.worker).recovery_requested &&
          !Access::Runtime(*fixture.worker).recovery_in_progress,
          "Null-core BeforeWork reset lifetime Submit totals or failed to complete actual recovery");
    fixture.Submit({}, Outcome::Queued, WEBRTC_VIDEO_CODEC_OK,
                   "A fresh actual IDR/SPS could not enqueue after null-core recovery");
    fixture.Finish();
  }
  {
    Fixture fixture(check, env);
    fixture.Submit({.packet = Packet::Delta, .type = webrtc::VideoFrameType::kVideoFrameDelta},
                   Outcome::IdrRequired, WEBRTC_VIDEO_CODEC_ERROR,
                   "A real non-IDR at startup was counted as validation/initial SPS instead of IdrRequired");
    fixture.Error("ERR_RTC_IDR_REQUIRED", WEBRTC_VIDEO_CODEC_ERROR);
    fixture.Finish();
  }
  {
    Fixture fixture(check, env);
    fixture.Submit({.packet = Packet::IdrWithoutSps}, Outcome::InitialSps, WEBRTC_VIDEO_CODEC_ERR_PARAMETER,
                   "A real initial IDR without SPS was not counted solely as InitialSps");
    fixture.Error("ERR_RTC_INITIAL_SPS");
    fixture.Finish();
  }

  struct Invalid {
    Input input;
    const char* code;
  };
  const std::array invalid{
      Invalid{{.storage = Storage::Missing}, "ERR_RTC_ENCODED_INPUT"},
      Invalid{{.storage = Storage::NullData}, "ERR_RTC_ENCODED_INPUT"},
      Invalid{{.storage = Storage::Empty}, "ERR_RTC_ENCODED_INPUT"},
      Invalid{{.storage = Storage::Oversized}, "ERR_RTC_ENCODED_INPUT"},
      Invalid{{.storage = Storage::Truncated}, "ERR_RTC_ENCODED_INPUT"},
      Invalid{{.packet_count = 4097}, "ERR_RTC_ENCODED_INPUT"},
      Invalid{{.spatial = 1}, "ERR_RTC_DECODER_LAYERS"},
      Invalid{{.temporal = 1}, "ERR_RTC_DECODER_LAYERS"},
      Invalid{{.simulcast = 1}, "ERR_RTC_DECODER_LAYERS"},
      Invalid{{.wrong_color = true}, "ERR_RTC_DECODE_METADATA"},
      Invalid{{.width = 4097}, "ERR_RTC_DECODE_METADATA"},
      Invalid{{.height = 4097}, "ERR_RTC_DECODE_METADATA"},
      Invalid{{.width = 0}, "ERR_RTC_DECODE_METADATA"},
      Invalid{{.height = 0}, "ERR_RTC_DECODE_METADATA"},
      Invalid{{.rotation = static_cast<webrtc::VideoRotation>(45)}, "ERR_RTC_ROTATION"},
      Invalid{{.type = webrtc::VideoFrameType::kVideoFrameDelta}, "ERR_RTC_IDR_METADATA"},
      Invalid{{.packet = Packet::Delta}, "ERR_RTC_IDR_METADATA"},
      Invalid{{.type = webrtc::VideoFrameType::kEmptyFrame}, "ERR_RTC_IDR_METADATA"},
      Invalid{{.packet = Packet::Malformed}, "ERR_RTC_ANNEX_B"},
      Invalid{{.packet = Packet::MainProfile}, "ERR_RTC_NEGOTIATED_SPS"},
      Invalid{{.render_ms = (std::numeric_limits<std::int64_t>::max)() / 1000 + 1},
              "ERR_RTC_RENDER_TIMESTAMP"}};
  {
    Fixture fixture(check, env);
    for (const auto& item : invalid) {
      fixture.Submit(item.input, Outcome::Validation, WEBRTC_VIDEO_CODEC_ERR_PARAMETER,
                     "Actual bounded Submit validation did not settle exactly once before admission");
      fixture.Error(item.code);
      fixture.Recover();
    }
    check(fixture.ledger->Snapshot().epoch_advances == invalid.size() &&
          fixture.ledger->Snapshot().submit.outcomes[static_cast<std::size_t>(Outcome::Validation)] == invalid.size(),
          "Independent actual validation recoveries lost their per-worker cumulative accounting");
    fixture.Submit({.packet_count = 4096, .width = 0, .height = 0, .render_ms = -1},
                   Outcome::Queued, WEBRTC_VIDEO_CODEC_OK,
                   "Valid bounded packet metadata/unspecified geometry/RTC render fallback was rejected");
    fixture.Submit({.packet = Packet::Delta, .rtp = 93000,
                    .type = webrtc::VideoFrameType::kVideoFrameDelta},
                   Outcome::Queued, WEBRTC_VIDEO_CODEC_OK,
                   "A following actual delta AU spuriously required initial SPS or MF work");
    fixture.Finish();
  }
  for (const unsigned throwing_call : {1u, 3u}) {
    Fixture fixture(check, env);
    fixture.Submit({.throw_on_data_call = throwing_call}, Outcome::Exception, WEBRTC_VIDEO_CODEC_ERROR,
                   "A real encoded-data getter exception was lost or double-counted as validation",
                   throwing_call == 3 ? TicketPath::NotQueued : TicketPath::None);
    fixture.Error("ERR_RTC_CPP", WEBRTC_VIDEO_CODEC_ERROR);
    check(fixture.worker->status() == WEBRTC_VIDEO_CODEC_OK && !fixture.worker->stopping(),
          "An input exception changed existing nonterminal recovery/worker policy");
    fixture.Recover();
    fixture.Submit({}, Outcome::Queued, WEBRTC_VIDEO_CODEC_OK,
                   "A throwing getter consumed admission/request/RTP state needed by the retry");
    fixture.Finish();
  }
  {
    Fixture fixture(check, env);
    Access::ExhaustRequestIds(*fixture.worker);
    fixture.Submit({}, Outcome::Validation, WEBRTC_VIDEO_CODEC_ERR_PARAMETER,
                   "Actual request-ID exhaustion was not counted once after admission",
                   TicketPath::NotQueued);
    fixture.Error("ERR_RTC_DECODE_ID");
    check(Access::CanAdmit(*fixture.worker, 32 * 1024 * 1024),
          "Request-ID exhaustion leaked the original admission ticket");
    fixture.Finish();
  }
  {
    Fixture fixture(check, env);
    fixture.Submit({.rtp = 0xfffffff0u}, Outcome::Queued, WEBRTC_VIDEO_CODEC_OK,
                   "The initial wrapped RTP AU did not enqueue exactly once");
    fixture.Submit({.rtp = 0x20u}, Outcome::Queued, WEBRTC_VIDEO_CODEC_OK,
                   "Actual Submit lost valid RTP wraparound");
    check(ProbeTimeline(Access::Timeline(*fixture.worker), 0x2ffu) == 8700,
          "Actual queued RTP timestamps lost their original 90kHz-derived MF timeline");
    fixture.Submit({.rtp = 0x20u}, Outcome::Validation, WEBRTC_VIDEO_CODEC_ERR_PARAMETER,
                   "Duplicate RTP was not counted exactly once after admission", TicketPath::NotQueued);
    fixture.Error("ERR_RTC_RTP_TIMESTAMP");
    const auto before = fixture.ledger->Snapshot();
    check(At(before, Stage::Queued).active == 2,
          "Selecting recovery released queued metadata before actual cancellation");
    fixture.Recover();
    ExpectRelease(check, before, fixture.ledger->Snapshot(), Stage::Queued, Reason::RecoveryCancelled, 2,
                  "Actual null-core recovery did not release exactly the two queued original owners");
    fixture.Submit({.rtp = 0x2ffu}, Outcome::Queued, WEBRTC_VIDEO_CODEC_OK,
                   "Recovery reset request/PTS provenance rather than retaining worker-lifetime identity");
    check(Access::NextRequest(*fixture.worker) == 4 &&
          ProbeTimeline(Access::Timeline(*fixture.worker), 0x5eeu) == 17044,
          "A loss epoch reset the original RTP timeline or reused accepted request IDs");
    fixture.Finish();
  }
  for (const std::uint32_t invalid_rtp : {89999u, 90000u + 0x80000000u}) {
    Fixture fixture(check, env);
    fixture.Submit({}, Outcome::Queued, WEBRTC_VIDEO_CODEC_OK,
                   "Timeline refusal fixture did not enqueue its original AU");
    fixture.Submit({.rtp = invalid_rtp}, Outcome::Validation, WEBRTC_VIDEO_CODEC_ERR_PARAMETER,
                   "Reordered/ambiguous RTP escaped actual bounded timeline validation", TicketPath::NotQueued);
    fixture.Error("ERR_RTC_RTP_TIMESTAMP");
    fixture.Finish();
  }
}

void RunAdmissionBranches(Check check, const webrtc::Environment& env) {
  for (const bool bytes_full : {false, true}) {
    Fixture fixture(check, env);
    std::vector<std::shared_ptr<Budget::Ticket>> held;
    for (unsigned i = 0; i < (bytes_full ? 1u : 32u); ++i) {
      held.push_back(Access::HoldAdmission(*fixture.worker, bytes_full ? 32 * 1024 * 1024 : 1));
      check(held.back() != nullptr, "Transient-pressure fixture did not own its bounded admission");
    }
    std::atomic<bool> released{false};
    std::jthread release([&](std::stop_token stop) {
      const auto deadline = SteadyClock::now() + std::chrono::seconds(1);
      while (!fixture.ledger->Snapshot().submit.in_progress && !stop.stop_requested() &&
             SteadyClock::now() < deadline)
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
      if (stop.stop_requested() || !fixture.ledger->Snapshot().submit.in_progress) return;
      std::this_thread::sleep_for(std::chrono::milliseconds(20));
      // Output retirement also needs this mutex. Submit must release it while
      // waiting for an existing admission, rather than blocking its own progress.
      const auto runtime = Access::Runtime(*fixture.worker);
      if (runtime.loss_epoch != 0) return;
      held.pop_back();
      released.store(true);
    });
    fixture.Submit({}, Outcome::Queued, WEBRTC_VIDEO_CODEC_OK,
                   "Transient decoder pressure discarded a valid AU instead of awaiting actual credit");
    release.join();
    check(released.load() && fixture.ledger->Snapshot().recovery_requests == 0 &&
          fixture.state->TakeDiagnostics().empty(),
          "Returning one actual admission triggered dependency recovery or fabricated extra capacity");
    held.clear();
    fixture.Finish();
  }
  for (unsigned action = 0; action < 4; ++action) {
    Fixture fixture(check, env);
    auto held = Access::HoldAdmission(*fixture.worker, 32 * 1024 * 1024);
    check(held != nullptr, "Interrupted-admission fixture did not own its full byte budget");
    auto bytes = PacketBytes({});
    webrtc::EncodedImage image;
    image.SetEncodedData(webrtc::make_ref_counted<EncodedBuffer>(bytes));
    image.SetFrameType(webrtc::VideoFrameType::kVideoFrameKey);
    image.SetRtpTimestamp(90000);
    std::atomic<bool> interrupted{false};
    std::jthread interrupt([&](std::stop_token stop) {
      const auto deadline = SteadyClock::now() + std::chrono::seconds(1);
      while (!fixture.ledger->Snapshot().submit.in_progress && !stop.stop_requested() &&
             SteadyClock::now() < deadline)
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
      if (stop.stop_requested() || !fixture.ledger->Snapshot().submit.in_progress) return;
      std::this_thread::sleep_for(std::chrono::milliseconds(20));
      if (action == 0) fixture.worker->RequestStop();
      else if (action == 1) Access::FailWorker(*fixture.worker);
      else if (action == 2) Access::RequestRecovery(*fixture.worker);
      else fixture.callbacks->Register(nullptr);
      if (action >= 2) held.reset();
      interrupted.store(true);
    });
    const auto result = fixture.worker->Submit(image, false, 0);
    interrupt.join();
    const std::array outcomes{Outcome::Stopping, Outcome::WorkerStatus,
                              Outcome::RecoveryPending, Outcome::NoCallback};
    const auto diagnostic = fixture.ledger->Snapshot();
    check(interrupted.load() &&
          result == (action == 0 || action == 3 ? WEBRTC_VIDEO_CODEC_UNINITIALIZED : WEBRTC_VIDEO_CODEC_ERROR) &&
          diagnostic.submit.outcomes[static_cast<std::size_t>(outcomes[action])] == 1 &&
          diagnostic.recovery_requests == (action == 2 ? 1u : 0u) &&
          At(diagnostic, Stage::Posting).entered == 0 && Access::NextRequest(*fixture.worker) == 1,
          "Admission wait ignored interruption, admitted an old epoch or invented dependency loss");
    held.reset();
    check(Access::CanAdmit(*fixture.worker, 32 * 1024 * 1024),
          "Interrupted admission wait retained a ticket or consumed its caller's RTP identity");
    if (action == 1) fixture.Error("ERR_RTC_CPU_WORKER", WEBRTC_VIDEO_CODEC_ERROR, true);
    else if (action == 2) fixture.Error("ERR_RTC_CPU_RECOVERY", WEBRTC_VIDEO_CODEC_ERROR);
    else check(fixture.state->TakeDiagnostics().empty(), "Cancelled backpressure invented a codec error");
    fixture.Finish();
  }
  for (const bool bytes_full : {false, true}) {
    Fixture fixture(check, env);
    const std::uint32_t admitted = bytes_full ? 4u : 32u;
    for (std::uint32_t i = 0; i < admitted; ++i) {
      fixture.Submit({.padded_size = bytes_full ? kMaximumAccessUnitBytes : 0, .rtp = 90000 + i * 3000},
                     Outcome::Queued, WEBRTC_VIDEO_CODEC_OK,
                     "An AU at the unchanged 32-count/32-MiB budget was rejected early");
    }
    check(Access::CanAdmit(*fixture.worker, 0) == bytes_full &&
          !Access::CanAdmit(*fixture.worker, 1),
          "The actual count and byte budgets were not independently exhausted at their original caps");
    const auto started = SteadyClock::now();
    fixture.Submit({.rtp = 90000 + admitted * 3000}, Outcome::AdmissionFull, WEBRTC_VIDEO_CODEC_ERROR,
                   "Genuine admission exhaustion was conflated with PostMedia rejection or counted twice");
    check(SteadyClock::now() - started >= kDecoderAdmissionWait,
          "Decoder discarded a bounded AU before giving actual output retirement its wait interval");
    fixture.Error("ERR_RTC_DECODER_BACKPRESSURE", WEBRTC_VIDEO_CODEC_ERROR);
    const auto held = fixture.ledger->Snapshot();
    check(At(held, Stage::Queued).active == admitted && held.current_loss_epoch == 1,
          "Admission refusal released the old queued owners before BeforeWork");
    fixture.Recover();
    ExpectRelease(check, held, fixture.ledger->Snapshot(), Stage::Queued, Reason::RecoveryCancelled, admitted,
                  "Budget recovery lost queued release reasons or double-counted metadata as MF drops");
    check(Access::CanAdmit(*fixture.worker, 32 * 1024 * 1024),
          "Cancelling actual queued AUs failed to restore all 32 MiB of admission credit");
    fixture.Submit({.rtp = 90000 + admitted * 3000}, Outcome::Queued, WEBRTC_VIDEO_CODEC_OK,
                   "Admission refusal consumed the request/timestamp needed after recovery");
    fixture.Finish();
  }
  {
    Fixture fixture(check, env);
    for (unsigned i = 0; i < 32; ++i)
      check(Access::PostInert(*fixture.worker, fixture.inert_executed),
            "The actual unstarted PostMedia queue filled before its unchanged 32-AU cap");
    check(!Access::PostInert(*fixture.worker, fixture.inert_executed) &&
          Access::CanAdmit(*fixture.worker, 32 * 1024 * 1024) &&
          At(fixture.ledger->Snapshot(), Stage::Queued).entered == 0,
          "Inert queue filling consumed diagnostic/admission tickets or changed the queue cap");
    fixture.Submit({}, Outcome::PostMediaRejected, WEBRTC_VIDEO_CODEC_ERROR,
                   "Actual full PostMedia with spare admission was not counted exactly once");
    fixture.Error("ERR_RTC_DECODER_QUEUE", WEBRTC_VIDEO_CODEC_ERROR);
    check(Released(fixture.ledger->Snapshot(), Stage::Posting, Reason::NotQueued) == 1 &&
          At(fixture.ledger->Snapshot(), Stage::Queued).entered == 0 &&
          Access::CanAdmit(*fixture.worker, 32 * 1024 * 1024),
          "PostMedia rejection fabricated queue ownership or leaked its posting admission");
    fixture.Recover();
    fixture.Submit({}, Outcome::Queued, WEBRTC_VIDEO_CODEC_OK,
                   "Rejected PostMedia consumed a request/RTP identity or left inert tasks/admission behind");
    fixture.Finish();
  }
}

void RunPendingAndRecovery(Check check, const webrtc::Environment& env) {
  {
    Fixture fixture(check, env);
    fixture.Submit({}, Outcome::Queued, WEBRTC_VIDEO_CODEC_OK, "Recovery fixture did not queue its original AU");
    auto first = fixture.Metadata(71, 1000);
    const WeakInput weak_first(first.metadata);
    Access::Switching(*fixture.worker, true);
    Access::EnqueueOnlyPendingOrStale(*fixture.worker, std::move(first));
    Access::Switching(*fixture.worker, false);
    auto second = fixture.Metadata(72, 18003);
    const WeakInput weak_second(second.metadata);
    Access::EnqueueOnlyPendingOrStale(*fixture.worker, std::move(second));
    auto submitted = fixture.Metadata(73, 35006);
    const WeakInput weak_submitted(submitted.metadata);
    Access::SubmitMetadata(*fixture.worker, std::move(submitted));
    Access::Accepted(*fixture.worker, 73);
    const auto owned = fixture.ledger->Snapshot();
    check(At(owned, Stage::WorkerPending).active == 2 &&
          At(owned, Stage::ProcessInputAccepted).active == 1 &&
          weak_first.OwnedOnce() && weak_second.OwnedOnce() && weak_submitted.OwnedOnce() &&
          Access::Runtime(*fixture.worker).pending_frames == 2,
          "Actual switching/pending admission released metadata or fabricated a core");
    fixture.Submit({.missing_frames = true}, Outcome::MissingFrames, WEBRTC_VIDEO_CODEC_ERROR,
                   "Pending recovery fixture did not request actual input-loss recovery");
    fixture.Error("ERR_RTC_MISSING_FRAME", WEBRTC_VIDEO_CODEC_ERROR);
    const auto held = fixture.ledger->Snapshot();
    check(SameInputs(owned.inputs, held.inputs),
          "Requesting recovery settled pending/submitted releases before their original cancellation");
    fixture.Recover();
    const auto finished = fixture.ledger->Snapshot();
    auto expected = held.inputs;
    for (const auto stage : {Stage::Queued, Stage::WorkerPending, Stage::ProcessInputAccepted}) {
      auto& value = expected[static_cast<std::size_t>(stage)];
      value.releases[static_cast<std::size_t>(Reason::RecoveryCancelled)] += value.active;
      value.active = 0;
    }
    const auto runtime = Access::Runtime(*fixture.worker);
    check(SameInputs(finished.inputs, expected) && weak_first.Expired() && weak_second.Expired() &&
          weak_submitted.Expired() && finished.accepted_callbacks == 1 &&
          finished.last_accepted_loss_epoch == 0 && finished.current_loss_epoch == 1 &&
          finished.recoveries_begun == 1 && finished.recoveries_finished == 1 &&
          runtime.pending_frames == 0 && runtime.submitted_metadata == 0 && runtime.needs_keyframe &&
          !runtime.recovery_requested && !runtime.recovery_in_progress && Conserved(finished),
          "Null-core BeforeWork lost cumulative acceptance/epoch state or actual pending/submitted releases");
    fixture.Finish();
  }
  {
    Fixture fixture(check, env);
    auto input = fixture.Metadata(71, 1000);
    const WeakInput weak(input.metadata);
    Access::Switching(*fixture.worker, true);
    Access::EnqueueOnlyPendingOrStale(*fixture.worker, std::move(input));
    fixture.Submit({.missing_frames = true}, Outcome::MissingFrames, WEBRTC_VIDEO_CODEC_ERROR,
                   "Switching recovery fixture did not request recovery");
    fixture.Error("ERR_RTC_MISSING_FRAME", WEBRTC_VIDEO_CODEC_ERROR);
    fixture.Recover();
    const auto runtime = Access::Runtime(*fixture.worker);
    const auto diagnostic = fixture.ledger->Snapshot();
    check(weak.Expired() && runtime.switching && runtime.recovery_in_progress &&
          !runtime.recovery_requested && diagnostic.recoveries_begun == 1 &&
          diagnostic.recoveries_finished == 0,
          "BeforeWork incorrectly finished a switching recovery or retained cancelled pending metadata");
    fixture.Submit({}, Outcome::RecoveryPending, WEBRTC_VIDEO_CODEC_ERROR,
                   "The actual recovery-in-progress branch did not refuse exactly once");
    fixture.Finish();
  }
  {
    Fixture fixture(check, env);
    auto stale_enqueue = fixture.Metadata(71, 1000);
    auto stale_decode = fixture.Metadata(72, 18003);
    const WeakInput weak_enqueue(stale_enqueue.metadata), weak_decode(stale_decode.metadata);
    fixture.Submit({.missing_frames = true}, Outcome::MissingFrames, WEBRTC_VIDEO_CODEC_ERROR,
                   "Stale input fixture did not advance the actual worker loss epoch");
    fixture.Error("ERR_RTC_MISSING_FRAME", WEBRTC_VIDEO_CODEC_ERROR);
    fixture.Recover();
    check(!Access::Current(*fixture.worker, stale_enqueue.metadata) &&
          !Access::Current(*fixture.worker, stale_decode.metadata),
          "CurrentInput accepted metadata from before an actual completed loss-epoch advance");
    const auto before = fixture.ledger->Snapshot();
    Access::EnqueueOnlyPendingOrStale(*fixture.worker, std::move(stale_enqueue));
    Access::DecodeOnlyStale(*fixture.worker, std::move(stale_decode));
    ExpectRelease(check, before, fixture.ledger->Snapshot(), Stage::Dispatching, Reason::StaleLossEpoch, 2,
                  "Actual stale EnqueueOnWorker/DecodeOnWorker did not release only their original owners");
    check(weak_enqueue.Expired() && weak_decode.Expired(), "Stale rejection retained admission/diagnostic tickets");
    fixture.CpuOnly();
    fixture.Finish();
  }
  for (const bool geometry_mismatch : {false, true}) {
    Fixture fixture(check, env);
    auto input = fixture.Metadata(71, 1000, geometry_mismatch ? Packet::Full : Packet::Delta);
    if (geometry_mismatch) { input.metadata.encoded_width = 16; input.metadata.encoded_height = 16; }
    const WeakInput weak(input.metadata);
    const auto before = fixture.ledger->Snapshot();
    Access::DecodeOnlyInvalidSession(*fixture.worker, std::move(input));
    fixture.Error(geometry_mismatch ? "ERR_RTC_DECODE_GEOMETRY" : "ERR_RTC_DECODER_SESSION_IDR",
                  geometry_mismatch ? WEBRTC_VIDEO_CODEC_ERR_PARAMETER : WEBRTC_VIDEO_CODEC_ERROR);
    ExpectRelease(check, before, fixture.ledger->Snapshot(), Stage::Dispatching, Reason::InvalidSession, 1,
                  "Invalid actual PlanDecoderSession/geometry created a core or lost its release reason");
    check(weak.Expired() && fixture.ledger->Snapshot().recovery_requests == 1,
          "Invalid session retained its original metadata/admission or omitted actual recovery");
    fixture.CpuOnly();
    fixture.Finish();
  }
  for (const bool worker_error : {false, true}) {
    Fixture fixture(check, env);
    fixture.Submit({}, Outcome::Queued, WEBRTC_VIDEO_CODEC_OK, "Cancellation fixture failed to enqueue");
    auto pending = fixture.Metadata(71, 1000);
    const WeakInput weak_pending(pending.metadata);
    Access::Switching(*fixture.worker, true);
    Access::EnqueueOnlyPendingOrStale(*fixture.worker, std::move(pending));
    auto submitted = fixture.Metadata(72, 18003);
    const WeakInput weak_submitted(submitted.metadata);
    Access::SubmitMetadata(*fixture.worker, std::move(submitted));
    const auto before = fixture.ledger->Snapshot();
    if (worker_error) {
      Access::FailWorker(*fixture.worker);
      fixture.Error("ERR_RTC_CPU_WORKER", WEBRTC_VIDEO_CODEC_ERROR, true);
    } else fixture.worker->RequestStop();
    check(SameInputs(before.inputs, fixture.ledger->Snapshot().inputs),
          "RequestStop/Fail released queue/pending/submitted metadata before cancellation");
    const auto reason = worker_error ? Reason::WorkerError : Reason::Stopped;
    check(Access::CancelQueued(*fixture.worker) == 1, "Actual default queue cancellation lost its one owner");
    Access::BeginStopWithoutCore(*fixture.worker);
    check(Released(fixture.ledger->Snapshot(), Stage::WorkerPending, reason) ==
              Released(before, Stage::WorkerPending, reason) + 1 &&
          At(fixture.ledger->Snapshot(), Stage::CoreAccepted).active == 1,
          "BeginStopCore mislabelled worker failure or released submitted metadata before drain/abort");
    Access::DropSubmitted(*fixture.worker, reason);
    auto expected = before.inputs;
    for (const auto stage : {Stage::Queued, Stage::WorkerPending, Stage::CoreAccepted}) {
      auto& value = expected[static_cast<std::size_t>(stage)];
      value.releases[static_cast<std::size_t>(reason)] += value.active;
      value.active = 0;
    }
    check(SameInputs(fixture.ledger->Snapshot().inputs, expected) &&
          weak_pending.Expired() && weak_submitted.Expired() &&
          Access::CanAdmit(*fixture.worker, 32 * 1024 * 1024),
          "Actual stopped/error cancellation lost release reasons or failed to return admission");
    fixture.CpuOnly();
    fixture.Finish();
  }
  {
    Fixture fixture(check, env);
    fixture.Submit({}, Outcome::Queued, WEBRTC_VIDEO_CODEC_OK, "Lifetime fixture failed to enqueue");
    fixture.Submit({.missing_frames = true}, Outcome::MissingFrames, WEBRTC_VIDEO_CODEC_ERROR,
                   "Lifetime fixture did not establish cumulative loss-epoch history");
    fixture.Error("ERR_RTC_MISSING_FRAME", WEBRTC_VIDEO_CODEC_ERROR);
    fixture.Recover();
    fixture.Submit({.rtp = 93000}, Outcome::Queued, WEBRTC_VIDEO_CODEC_OK,
                   "Lifetime fixture could not retain a new-epoch original queued AU");
    auto pending = fixture.Metadata(71, 1000);
    const WeakInput weak_pending(pending.metadata);
    Access::Switching(*fixture.worker, true);
    Access::EnqueueOnlyPendingOrStale(*fixture.worker, std::move(pending));
    auto submitted = fixture.Metadata(72, 18003);
    const WeakInput weak_submitted(submitted.metadata);
    Access::SubmitMetadata(*fixture.worker, std::move(submitted));
    fixture.Finish(true);
    check(weak_pending.Expired() && weak_submitted.Expired(),
          "Retained old-session snapshots extended abandoned pending/submitted metadata lifetimes");
  }
}

std::shared_ptr<sv::GpuDecodedFrame> TextureFreeFrame(std::int64_t pts, std::int64_t duration = 17003) {
  auto frame = std::make_shared<sv::GpuDecodedFrame>();
  frame->timestampUs = pts;
  frame->durationUs = duration;
  return frame;
}
void FrameCall(Fixture& fixture, std::shared_ptr<const sv::GpuDecodedFrame> frame,
               Output outcome, const char* error_code = nullptr) {
  const auto before = fixture.ledger->Snapshot();
  const auto callbacks = fixture.callback->calls;
  std::optional<bool> consumed;
  const auto error = Protect([&] { consumed = Access::Frame(*fixture.worker, std::move(frame)); });
  if (error_code) ExpectedError(fixture.check, error, error_code);
  else fixture.check(!error && consumed == true, "A suppressed actual OnFrame did not retain its return policy");
  const auto after = fixture.ledger->Snapshot();
  auto expected = before.output.outcomes;
  ++expected[static_cast<std::size_t>(outcome)];
  fixture.check(after.output.calls == before.output.calls + 1 && after.output.in_progress == 0 &&
                after.output.outcomes == expected && after.output.duration.count == before.output.duration.count + 1 &&
                after.submit.outcomes == before.submit.outcomes &&
                fixture.callback->calls == callbacks && Conserved(after),
                "Actual texture-free OnFrame did not settle exactly one exclusive output outcome");
  // Existing accounting increments on identity match, before stop/epoch/layout
  // rejection. These synthetic matches are NOT evidence of a GPU-produced frame.
  if (outcome == Output::Stopping || outcome == Output::StaleLossEpoch || outcome == Output::InvalidLayout)
    ++fixture.matched_rejection_metadata;
  fixture.CpuOnly();
}

void RunAcceptedAndOutputRejections(Check check, const webrtc::Environment& env,
                                    webrtc::SimulatedClock& clock) {
  {
    Fixture fixture(check, env);
    FrameCall(fixture, nullptr, Output::NullFrame, "ERR_RTC_DECODED_FRAME");
    FrameCall(fixture, TextureFreeFrame(1000), Output::IdentityMismatch, "ERR_RTC_DECODED_IDENTITY");
    auto input = fixture.Metadata(71, 1000);
    const WeakInput weak(input.metadata);
    Access::SubmitMetadata(*fixture.worker, std::move(input));
    const auto enqueued_metadata = fixture.ledger->Snapshot();
    check(At(enqueued_metadata, Stage::CoreAccepted).active == 1 &&
          At(enqueued_metadata, Stage::ProcessInputAccepted).entered == 0 &&
          enqueued_metadata.accepted_callbacks == 0 && !Access::Submitted(*fixture.worker, 1000).accepted,
          "Core-enqueued metadata was misrepresented as a successful MF ProcessInput");
    FrameCall(fixture, TextureFreeFrame(1000), Output::IdentityMismatch, "ERR_RTC_DECODED_IDENTITY");
    check(SameInputs(enqueued_metadata.inputs, fixture.ledger->Snapshot().inputs) && weak.OwnedOnce(),
          "An unaccepted output identity consumed submitted metadata/admission");
    ExpectedError(check, Protect([&] { Access::Accepted(*fixture.worker, 999); }), "ERR_RTC_DECODE_ACCEPTED");
    check(SameInputs(enqueued_metadata.inputs, fixture.ledger->Snapshot().inputs) &&
          fixture.ledger->Snapshot().accepted_unknown == 1,
          "Unknown actual OnAccepted callback altered owned metadata");
    const auto accepted_ms = clock.TimeInMilliseconds();
    Access::Accepted(*fixture.worker, 71);
    const auto accepted = fixture.ledger->Snapshot();
    check(At(accepted, Stage::CoreAccepted).active == 0 &&
          At(accepted, Stage::CoreAccepted).transitioned == 1 &&
          At(accepted, Stage::ProcessInputAccepted).active == 1 &&
          Access::Submitted(*fixture.worker, 1000).accepted &&
          Access::Submitted(*fixture.worker, 1000).accepted_ms == accepted_ms &&
          accepted.last_accepted_loss_epoch == 0,
          "Actual OnAccepted failed to mark exactly the original request/RTC acceptance timestamp");
    clock.AdvanceTimeMilliseconds(19);
    ExpectedError(check, Protect([&] { Access::Accepted(*fixture.worker, 71); }), "ERR_RTC_DECODE_ACCEPTED");
    const auto duplicate = fixture.ledger->Snapshot();
    check(duplicate.accepted_callbacks == 3 && duplicate.accepted_unknown == 1 &&
          duplicate.accepted_duplicate == 1 && SameInputs(accepted.inputs, duplicate.inputs) &&
          Access::Submitted(*fixture.worker, 1000).accepted_ms == accepted_ms &&
          duplicate.intervals[static_cast<std::size_t>(DecoderInterval::CoreEnqueueToAccepted)].count == 1,
          "Duplicate OnAccepted re-transitioned input or overwrote its original RTC clock timestamp");
    FrameCall(fixture, TextureFreeFrame(1000, 17004), Output::IdentityMismatch, "ERR_RTC_DECODED_IDENTITY");
    check(SameInputs(accepted.inputs, fixture.ledger->Snapshot().inputs) && weak.OwnedOnce(),
          "A duration mismatch consumed the original accepted metadata");
    const auto frame = TextureFreeFrame(1000);
    FrameCall(fixture, frame, Output::InvalidLayout, "ERR_RTC_DECODED_LAYOUT");
    const auto invalid = fixture.ledger->Snapshot();
    check(weak.Expired() && Access::Runtime(*fixture.worker).submitted_metadata == 0 &&
          At(invalid, Stage::ProcessInputAccepted).active == 0 &&
          At(invalid, Stage::OutputMatched).entered == 1 &&
          Released(invalid, Stage::OutputMatched, Reason::InvalidOutput) == 1 &&
          invalid.last_output_loss_epoch == 0 && frame->timestampUs == 1000 && frame->durationUs == 17003 &&
          !frame->texture && !frame->readyFence,
          "Invalid actual output layout reached GPU work or lost original metadata/release provenance");
    fixture.Finish();
  }
  for (const bool stop : {false, true}) {
    Fixture fixture(check, env);
    auto input = fixture.Metadata(71, 1000);
    const WeakInput weak(input.metadata);
    Access::SubmitMetadata(*fixture.worker, std::move(input));
    Access::Accepted(*fixture.worker, 71);
    fixture.Submit({.missing_frames = true}, Outcome::MissingFrames, WEBRTC_VIDEO_CODEC_ERROR,
                   "Suppressed-output fixture did not advance the actual loss epoch");
    fixture.Error("ERR_RTC_MISSING_FRAME", WEBRTC_VIDEO_CODEC_ERROR);
    if (stop) fixture.worker->RequestStop();
    FrameCall(fixture, TextureFreeFrame(1000), stop ? Output::Stopping : Output::StaleLossEpoch);
    const auto result = fixture.ledger->Snapshot();
    check(weak.Expired() && result.current_loss_epoch == 1 && result.last_output_loss_epoch == 0 &&
          Released(result, Stage::OutputMatched, stop ? Reason::Stopped : Reason::StaleLossEpoch) == 1 &&
          fixture.callback->calls == 0 && Access::Runtime(*fixture.worker).submitted_metadata == 0,
          "Stopping/stale epoch suppression lost precedence over missing texture/fence or changed input ownership");
    fixture.Finish();
  }
}

void DeliverCpuOutput(Fixture& fixture, webrtc::SimulatedClock& clock,
                      std::uint64_t request, std::int64_t pts, Output outcome,
                      bool absent_optional_metadata = false) {
  auto input = fixture.Metadata(request, pts);
  if (absent_optional_metadata) {
    input.metadata.presentation.reset();
    input.metadata.tracking_id.reset();
    input.metadata.packet_infos = {};
  }
  const auto rtp = input.metadata.rtp;
  const auto render_us = input.metadata.render_us, ntp_ms = input.metadata.ntp_ms;
  const auto rotation = input.metadata.rotation;
  const auto presentation = input.metadata.presentation;
  const auto tracking = input.metadata.tracking_id.value_or(webrtc::VideoFrame::kNotSetId);
  const auto packets = input.metadata.packet_infos;
  const WeakInput weak(input.metadata);
  Access::SubmitMetadata(*fixture.worker, std::move(input));
  Access::Accepted(*fixture.worker, request);
  const auto accepted_ms = clock.TimeInMilliseconds();
  clock.AdvanceTimeMilliseconds(37);
  const auto expected_finish = clock.CurrentTime();
  const auto before = fixture.ledger->Snapshot();
  const auto calls_before = fixture.callback->calls;
  const bool revoked = outcome == Output::CallbackRevoked, throwing = outcome == Output::CallbackException;
  const auto reason = revoked ? Reason::CallbackRevoked
      : throwing ? Reason::CallbackException : Reason::CallbackCompleted;
  DecoderDiagnosticSnapshot selected_reason;
  {
    auto metadata = Access::TakeSubmitted(*fixture.worker, pts);
    {
      // Only the exact production helper path after GPU validation is exercised.
      // The controlled I420 buffer is never a native lease or a GPU delivery.
      auto observation = Access::ObserveOutput(*fixture.worker);
      metadata.diagnostic->OutputMatched(observation.begin());
      auto pixels = webrtc::I420Buffer::Create(16, 16);
      auto output = Access::BuildOutput(metadata, pixels);
      fixture.check(output.video_frame_buffer().get() == pixels.get() && output.rtp_timestamp() == rtp &&
                    output.timestamp_us() == render_us && output.ntp_time_ms() == ntp_ms &&
                    output.rotation() == rotation && output.presentation_timestamp() == presentation &&
                    output.id() == tracking && SamePackets(output.packet_infos(), packets) &&
                    output.color_space() && IsBt709Limited(*output.color_space()),
                    "Exact BuildOutput changed original RTP/render/NTP/presentation/tracking/packet provenance");
      const auto error = Protect([&] { Access::DeliverOutput(*fixture.worker, metadata, output, observation); });
      if (throwing) ExpectedError(fixture.check, error, "ERR_RTC_CPP", WEBRTC_VIDEO_CODEC_ERROR);
      else fixture.check(!error, "Exact CPU DeliverOutput unexpectedly threw");
      const auto processing = output.processing_time();
      fixture.check(metadata.accepted_ms == accepted_ms && output.timestamp_us() == render_us &&
                    output.rtp_timestamp() == rtp && processing &&
                    processing->start == webrtc::Timestamp::Millis(accepted_ms) &&
                    processing->finish == expected_finish && processing->Elapsed() == webrtc::TimeDelta::Millis(37),
                    "Steady-clock diagnostic timing replaced the original accepted-ms RTC decode interval");
    }
    selected_reason = fixture.ledger->Snapshot();
    auto expected_outcomes = before.output.outcomes;
    ++expected_outcomes[static_cast<std::size_t>(outcome)];
    auto expected_inputs = before.inputs;
    auto& accepted = expected_inputs[static_cast<std::size_t>(Stage::ProcessInputAccepted)];
    --accepted.active;
    ++accepted.transitioned;
    auto& matched = expected_inputs[static_cast<std::size_t>(Stage::OutputMatched)];
    ++matched.entered;
    ++matched.active;
    const auto& callback_operation = selected_reason.operations[static_cast<std::size_t>(DecoderOperation::Callback)];
    const auto& previous_operation = before.operations[static_cast<std::size_t>(DecoderOperation::Callback)];
    fixture.check(selected_reason.output.calls == before.output.calls + 1 &&
                  selected_reason.output.in_progress == 0 && selected_reason.output.outcomes == expected_outcomes &&
                  SameInputs(selected_reason.inputs, expected_inputs) && weak.OwnedOnce() &&
                  fixture.callback->calls == calls_before + (revoked ? 0u : 1u) &&
                  callback_operation.calls == previous_operation.calls + (revoked ? 0u : 1u) &&
                  callback_operation.in_progress == 0 &&
                  callback_operation.returned == previous_operation.returned + (!revoked && !throwing ? 1u : 0u) &&
                  callback_operation.exceptions == previous_operation.exceptions + (throwing ? 1u : 0u) &&
                  !fixture.callbacks->IsInvokingOnCurrentThread() && Conserved(selected_reason),
                  "Void callback completion/refusal/exception was counted twice or settled live input ownership");
    const auto callback_interval = static_cast<std::size_t>(DecoderInterval::OutputToCallback);
    const auto completed_interval = static_cast<std::size_t>(DecoderInterval::SubmitToCallbackCompleted);
    fixture.check(selected_reason.intervals[callback_interval].count ==
                      before.intervals[callback_interval].count + (revoked ? 0u : 1u) &&
                  selected_reason.intervals[completed_interval].count ==
                      before.intervals[completed_interval].count + (!revoked && !throwing ? 1u : 0u),
                  "A revoked/throwing void callback fabricated successful completion timing");
    if (!revoked) {
      const auto& callback = *fixture.callback;
      fixture.check(callback.rtp == rtp && callback.render_us == render_us && callback.ntp_ms == ntp_ms &&
                    callback.rotation == rotation && callback.presentation == presentation &&
                    callback.tracking == tracking && SamePackets(callback.packets, packets) &&
                    callback.processing && callback.processing->start == webrtc::Timestamp::Millis(accepted_ms) &&
                    callback.processing->finish == expected_finish && callback.decode_ms == 37 &&
                    callback.no_qp && callback.cpu_buffer && callback.color_ok && callback.invoked_on_this_thread &&
                    callback.during && callback.during->output.in_progress == 1 &&
                    callback.during->output.outcomes == before.output.outcomes &&
                    At(*callback.during, Stage::OutputMatched).releases == At(before, Stage::OutputMatched).releases &&
                    callback.during->operations[static_cast<std::size_t>(DecoderOperation::Callback)].in_progress == 1 &&
                    Conserved(*callback.during),
                    "Actual callback gate observed altered provenance, early completion/release or wrong RTC elapsed time");
    }
  }
  ExpectRelease(fixture.check, selected_reason, fixture.ledger->Snapshot(), Stage::OutputMatched, reason, 1,
                "DeliverOutput release reason did not settle only at original metadata destruction");
  fixture.check(weak.Expired() && Access::CanAdmit(*fixture.worker, 32 * 1024 * 1024),
                "Holding callback snapshots/ledger extended original output metadata or admission lifetime");
  fixture.CpuOnly();
}

void RunCallbackBranches(Check check, const webrtc::Environment& env, webrtc::SimulatedClock& clock) {
  {
    Fixture fixture(check, env);
    DeliverCpuOutput(fixture, clock, 71, 1000, Output::CallbackCompleted);
    fixture.callbacks->Clear();
    DeliverCpuOutput(fixture, clock, 72, 18003, Output::CallbackRevoked);
    check(fixture.callback->calls == 1,
          "Clearing the actual callback gate allowed a second invocation from already-matched metadata");
    fixture.Finish();
  }
  {
    Fixture fixture(check, env);
    DeliverCpuOutput(fixture, clock, 71, 1000, Output::CallbackCompleted, true);
    fixture.Finish();
  }
  {
    Fixture fixture(check, env);
    fixture.callbacks->Activate();
    DeliverCpuOutput(fixture, clock, 71, 1000, Output::CallbackRevoked);
    check(fixture.callback->calls == 0, "An obsolete worker generation invoked the newly active callback gate");
    fixture.Finish();
  }
  {
    Fixture fixture(check, env);
    fixture.callback->action = CallbackAction::Throw;
    DeliverCpuOutput(fixture, clock, 71, 1000, Output::CallbackException);
    check(fixture.callback->calls == 1 && fixture.state->Snapshot().rtc_rejected_access_units == 0,
          "A throwing void decoded callback fabricated RTC acceptance/rejection or was invoked twice");
    fixture.Finish();
  }
  for (const auto action : {CallbackAction::Unregister, CallbackAction::UnregisterAndStop}) {
    Fixture fixture(check, env);
    fixture.callback->action = action;
    DeliverCpuOutput(fixture, clock, 71, 1000, Output::CallbackCompleted);
    check(fixture.worker->stopping() == (action == CallbackAction::UnregisterAndStop),
          "Reentrant callback unregister/request-stop changed existing stop policy");
    DeliverCpuOutput(fixture, clock, 72, 18003, Output::CallbackRevoked);
    check(fixture.callback->calls == 1,
          "Reentrant callback revocation did not prevent the next exact CPU gate invocation");
    fixture.Finish();
  }
}

void Run(Check check) {
  webrtc::SimulatedClock clock(webrtc::Timestamp::Micros(123456000));
  const auto env = webrtc::CreateEnvironment(&clock);
  RunSubmitBranches(check, env);
  RunAdmissionBranches(check, env);
  RunPendingAndRecovery(check, env);
  RunAcceptedAndOutputRejections(check, env, clock);
  RunCallbackBranches(check, env, clock);
}

}  // namespace cpu_decoder_submit_checks

#include "mf_rtc_decoder_mapping_checks.h"

}  // namespace
}  // namespace monky::native_rtc::mf::detail

namespace monky::native_rtc::mf {

void RunDecoderSubmitBranchChecks(void (*check)(bool, const char*)) {
  detail::cpu_decoder_submit_checks::Run(check);
}

void RunDecoderMappingChecks(void (*check)(bool, const char*)) {
  detail::cpu_decoder_mapping_checks::Run(check);
}

}  // namespace monky::native_rtc::mf
