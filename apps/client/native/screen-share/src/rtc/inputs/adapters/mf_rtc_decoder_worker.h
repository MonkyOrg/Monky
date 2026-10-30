#pragma once

// The MF H.264 decoder adapter: setup, admission metadata, the MTA worker that owns the qualified core and the
// webrtc::VideoDecoder over it. The production factory (mf_rtc_decoder.cc) and the device-free fixtures that only
// the contract probe links (mf_rtc_decoder_checks.cc) share these definitions.

#include "mf_rtc_internal.h"

#include "api/rtp_packet_infos.h"

#include <algorithm>
#include <cstring>
#include <limits>
#include <thread>

#if !defined(MONKY_RTC_DECODER_FRAME_INFO_LEASE_REVISION) || MONKY_RTC_DECODER_FRAME_INFO_LEASE_REVISION != 1
#error The native decoder requires its pinned ownership-aware SDK mapping.
#endif

namespace monky::native_rtc::mf::detail {

using DecodeGate = CallbackGate<webrtc::DecodedImageCallback>;
inline constexpr auto kDecoderAdmissionWait = std::chrono::milliseconds(500);

struct DecoderSetup {
  std::uint32_t maximum_width = 4096, maximum_height = 4096;
  std::uint32_t maximum_in_flight = 0;
};

inline DecoderSetup MakeDecoderSetup(const webrtc::VideoDecoder::Settings& settings,
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
          }, diagnostic)) {
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
    CancelQueuedMedia(DecoderInputReleaseReason::RecoveryCancelled);
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
  sv::I420Image ReadFrame(const NativeLease& lease) override {
    if (!lease.decoder || !lease.frame) {
      throw AdapterError("ERR_RTC_DECODED_LEASE", "A retained output of this decoder is required");
    }
    // Intentionally valid AFTER core Finished()/VideoDecoder::Release().
    // The lease pins this MTA worker and the exact qualified readback owner.
    return lease.decoder->ReadI420(lease.frame);
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
        shared_from_this(), frame, device_, context_, core_);
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

}  // namespace monky::native_rtc::mf::detail
