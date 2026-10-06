#pragma once

// Included after the existing unstarted-worker fixtures, inside their namespace.
namespace cpu_decoder_mapping_checks {

using namespace cpu_decoder_submit_checks;

class Receive final : public webrtc::VCMReceiveCallback {
 public:
  int32_t OnFrameToRender(const FrameToRender& frame) override {
    rendered.push_back(frame.video_frame.rtp_timestamp());
    if (on_render) on_render(frame);
    return render_result;
  }
  void OnDroppedFrames(uint32_t count) override { dropped += count; }
  void OnMonkyDecoderTimestampMap(webrtc::MonkyDecoderTimestampMapEvent event, uint32_t count) override {
    using Event = webrtc::MonkyDecoderTimestampMapEvent;
    switch (event) {
      case Event::kOverflowEviction: evicted += count; break;
      case Event::kMissingCallback: ++missing; skipped += count; break;
      case Event::kMappedCallback: ++mapped; skipped += count; break;
      case Event::kClear: cleared += count; ++clears; break;
      case Event::kLeaseRetirement: retired += count; break;
    }
  }
  std::uint64_t dropped = 0, evicted = 0, missing = 0, mapped = 0;
  std::uint64_t skipped = 0, cleared = 0, clears = 0, retired = 0;
  std::int32_t render_result = WEBRTC_VIDEO_CODEC_OK;
  std::vector<std::uint32_t> rendered;
  std::function<void(const FrameToRender&)> on_render;
};

AdapterOptions Options(std::uint32_t maximum_pending) {
  AdapterOptions options;
  options.maximum_pending_frames = maximum_pending;
  ValidateOptions(options);
  return options;
}

class Decoder final : public webrtc::VideoDecoder {
 public:
  Decoder(Check check, const webrtc::Environment& env, bool leased, std::uint32_t maximum_pending)
      : fixture(check, env, Options(maximum_pending)),
        descriptor_(env, fixture.state, {sv::H264Profile::ConstrainedBaseline, 52}), leased_(leased) {}
  ~Decoder() override { Release(); }
  bool Configure(const Settings&) override {
    if (fail_configure) return false;
    if (configured_) {
      Release();
      fixture.callbacks->Register(callback_);
      fixture.worker = fixture.NewWorker();
      fixture.ledger = Access::Ledger(*fixture.worker);
      fixture.callback->worker = fixture.worker.get();
      fixture.callback->ledger = fixture.ledger.get();
    }
    if (enable_ownership_on_configure) leased_ = true;
    configured_ = true;
    return true;
  }
  DecoderInfo GetDecoderInfo() const override {
    auto info = descriptor_.GetDecoderInfo();
    if (!leased_) info.monky_frame_info_lease_limit.reset();
    return info;
  }
  int32_t RegisterDecodeCompleteCallback(webrtc::DecodedImageCallback* callback) override {
    callback_ = callback;
    fixture.callbacks->Register(callback);
    return WEBRTC_VIDEO_CODEC_OK;
  }
  int32_t Decode(const webrtc::EncodedImage& image, int64_t render_ms) override {
    if (leases.size() >= 512) throw std::runtime_error("CPU mapping observation exceeded its bound");
    leases.emplace_back(image.MonkyFrameInfoLease());
    if (switch_to_legacy) {
      ClearInputs(Reason::RecoveryCancelled);
      leased_ = false;
      software_ = true;
      switch_to_legacy = false;
    } else if (switch_to_native) {
      leased_ = true;
      software_ = false;
      switch_to_native = false;
    }
    if (software_) {
      software_rtp_ = image.RtpTimestamp();
      return WEBRTC_VIDEO_CODEC_OK;
    }
    const auto request = Access::NextRequest(*fixture.worker);
    if (leased_ && !image.MonkyFrameInfoLease()) legacy_native_input_ = request;
    const auto expected_pts = ProbeTimeline(Access::Timeline(*fixture.worker), image.RtpTimestamp());
    const auto result = fixture.worker->Submit(image, false, render_ms);
    last_native_status = result;
    if (result != WEBRTC_VIDEO_CODEC_OK) return result;
    if (!expected_pts || !expected_.emplace(request, std::make_pair(image.RtpTimestamp(), *expected_pts)).second)
      throw std::runtime_error("CPU mapping fixture lost an original request/PTS");
    if (throw_from_decode) throw std::runtime_error("CPU original Decode exception");
    if (no_output) {
      // Fake-core terminal result, using real queued-input cancellation.
      Access::CancelQueued(*fixture.worker, Reason::RecoveryCancelled);
      expected_.clear();
      return WEBRTC_VIDEO_CODEC_NO_OUTPUT;
    }
    if (synchronous) Complete();
    return result;
  }
  int32_t Release() override {
    fixture.callbacks->Clear();
    ClearInputs(Reason::Stopped);
    fixture.worker->RequestStop();
    return WEBRTC_VIDEO_CODEC_OK;
  }
  void ClearInputs(Reason reason) {
    Access::CancelQueued(*fixture.worker, reason);
    Access::DropPending(*fixture.worker, reason);
    Access::DropSubmitted(*fixture.worker, reason);
    submitted_.clear();
    expected_.clear();
  }
  void AcceptQueued() {
    Access::DispatchQueuedToPending(*fixture.worker);
    while (Access::Runtime(*fixture.worker).pending_frames) {
      auto input = Access::TakePending(*fixture.worker);
      const auto pts = input.packet.timestampUs;
      const auto request = input.metadata.request_id;
      const auto original = expected_.extract(request);
      fixture.check(input.packet.durationUs == 1000000 / fixture.state->options.decoder_fps &&
                    !original.empty() && original.mapped().first == input.metadata.rtp &&
                    original.mapped().second == pts &&
                    input.metadata.loss_epoch == fixture.ledger->Snapshot().current_loss_epoch &&
                    input.metadata.admission &&
                    (!leased_ || input.metadata.frame_info || legacy_native_input_ == request),
                    "Mapping integration detached actual admission, PTS or the native loss epoch");
      submitted_.push_back(pts);
      Access::SubmitMetadata(*fixture.worker, std::move(input));
      Access::Accepted(*fixture.worker, request);
    }
  }
  void Complete(std::size_t index = 0) {
    AcceptQueued();
    if (index >= submitted_.size()) throw std::runtime_error("CPU fake core has no selected completion");
    const auto pts = submitted_[index];
    submitted_.erase(submitted_.begin() + index);
    auto metadata = Access::TakeSubmitted(*fixture.worker, pts);
    auto output_diagnostic = Access::ObserveOutput(*fixture.worker);
    metadata.diagnostic->OutputMatched(output_diagnostic.begin());
    auto pixels = webrtc::I420Buffer::Create(2, 2);
    pixels->InitializeData();
    auto output = Access::BuildOutput(metadata, pixels);
    during_admission = metadata.admission;
    during_lease = metadata.frame_info;
    fixture.check(metadata.accepted && metadata.accepted_ms == fixture.env.clock().TimeInMilliseconds() &&
                  output.rtp_timestamp() == metadata.rtp && output.timestamp_us() == 9137000 &&
                  output.ntp_time_ms() == metadata.ntp_ms && output.rotation() == webrtc::kVideoRotation_90 &&
                  output.presentation_timestamp() == webrtc::Timestamp::Micros(8000456) &&
                  output.id() == 73 && SamePackets(output.packet_infos(), Packets(metadata.rtp)),
                  "Fake-core completion changed original native PTS/RTP/render/packet provenance");
    Access::DeliverOutput(*fixture.worker, metadata, output, output_diagnostic);
  }
  void CompleteFiltered(bool stopping) {
    AcceptQueued();
    if (submitted_.empty()) throw std::runtime_error("CPU filter has no accepted metadata");
    const auto pts = submitted_.front();
    submitted_.pop_front();
    if (stopping) fixture.worker->RequestStop();
    else {
      webrtc::EncodedImage absent;
      fixture.check(fixture.worker->Submit(absent, true, 0) == WEBRTC_VIDEO_CODEC_ERROR,
                    "CPU stale output did not advance the real native loss epoch");
    }
    auto frame = std::make_shared<sv::GpuDecodedFrame>();
    frame->timestampUs = pts;
    frame->durationUs = 1000000 / fixture.state->options.decoder_fps;
    ++fixture.matched_rejection_metadata;
    fixture.check(Access::Frame(*fixture.worker, std::move(frame)),
                  "Actual stale/stop filter refused metadata-only output retirement");
  }
  void CompleteSoftware() {
    if (!software_rtp_ || !callback_) throw std::runtime_error("CPU legacy callback has no input");
    auto pixels = webrtc::I420Buffer::Create(2, 2);
    pixels->InitializeData();
    auto output = webrtc::VideoFrame::Builder().set_video_frame_buffer(pixels)
        .set_rtp_timestamp(*software_rtp_).build();
    software_rtp_.reset();
    callback_->Decoded(output, std::optional<int32_t>(0), std::nullopt);
  }
  std::size_t LiveLeases() const {
    return static_cast<std::size_t>(std::count_if(leases.begin(), leases.end(),
        [](const auto& lease) { return !lease.expired(); }));
  }
  Fixture fixture;
  std::vector<std::weak_ptr<webrtc::MonkyDecoderFrameInfoLease>> leases;
  std::weak_ptr<Budget::Ticket> during_admission;
  std::weak_ptr<webrtc::MonkyDecoderFrameInfoLease> during_lease;
  std::int32_t last_native_status = WEBRTC_VIDEO_CODEC_OK;
  bool synchronous = false, no_output = false, throw_from_decode = false, fail_configure = false;
  bool switch_to_legacy = false, switch_to_native = false;
  bool enable_ownership_on_configure = false;

 private:
  MfVideoDecoder descriptor_;
  bool leased_, configured_ = false, software_ = false;
  webrtc::DecodedImageCallback* callback_ = nullptr;
  std::optional<std::uint32_t> software_rtp_;
  std::deque<std::int64_t> submitted_;
  std::map<std::uint64_t, std::pair<std::uint32_t, std::int64_t>> expected_;
  std::optional<std::uint64_t> legacy_native_input_;
};

struct Harness {
  Harness(Check check, const webrtc::Environment& env, bool leased = true, std::uint32_t maximum_pending = 32)
      : check(check), env(env), timing(&env.clock(), env.field_trials()),
        callback(&timing, &env.clock(), env.field_trials(), nullptr),
        decoder(check, env, leased, maximum_pending) {
    callback.SetUserReceiveCallback(&receive);
    Configure();
  }
  ~Harness() {
    generic.reset();
    callback.ClearTimestampMap();
    callback.SetUserReceiveCallback(nullptr);
  }
  void Configure() {
    generic = std::make_unique<webrtc::VCMGenericDecoder>(&decoder);
    check(generic->Configure({}) && generic->RegisterDecodeCompleteCallback(&callback) == WEBRTC_VIDEO_CODEC_OK,
          "CPU real GenericDecoder did not configure/register its unstarted-worker facade");
  }
  int32_t Send(std::uint32_t rtp, bool malformed = false, std::int64_t ntp_ms = 1234567) {
    std::weak_ptr<int> bytes_lifetime;
    std::int32_t result;
    const auto before = Access::Timeline(*decoder.fixture.worker);
    {
      auto bytes = ParserPacket();
      if (malformed) bytes.front() = 1;
      auto buffer = webrtc::make_ref_counted<EncodedBuffer>(std::move(bytes));
      bytes_lifetime = buffer->Lifetime();
      webrtc::EncodedFrame frame;
      frame.SetEncodedData(buffer);
      frame.SetRtpTimestamp(rtp);
      frame.SetFrameType(webrtc::VideoFrameType::kVideoFrameKey);
      frame._encodedWidth = 1920;
      frame._encodedHeight = 1080;
      frame.ntp_time_ms_ = ntp_ms;
      frame.rotation_ = webrtc::kVideoRotation_90;
      frame.SetColorSpace(Bt709Limited());
      frame.SetRenderTime(9137);
      frame.SetPresentationTimestamp(webrtc::Timestamp::Micros(8000456));
      frame.SetVideoFrameTrackingId(73);
      frame.SetPacketInfos(Packets(rtp));
      result = generic->Decode(frame, env.clock().CurrentTime());
      check(!frame.MonkyFrameInfoLease(), "SDK provisional state mutated the caller's original EncodedImage");
    }
    check(bytes_lifetime.expired(), "Mapping metadata retained the original compressed image/payload");
    if (result < WEBRTC_VIDEO_CODEC_OK)
      check(SameTimeline(before, Access::Timeline(*decoder.fixture.worker), rtp),
            "Refused mapping/Decode changed the native original RTP timeline");
    decoder.fixture.CpuOnly();
    return result;
  }
  void Empty() {
    decoder.ClearInputs(Reason::Stopped);
    callback.PruneFrameInfoLeases();
    check(decoder.LiveLeases() == 0 && decoder.during_admission.expired() &&
          decoder.during_lease.expired() &&
          Access::CanAdmit(*decoder.fixture.worker, 32 * 1024 * 1024),
          "Terminal mapping retained metadata/admission or consumed a future byte-budget slot");
    decoder.fixture.CpuOnly();
  }
  Check check;
  const webrtc::Environment& env;
  Receive receive;
  webrtc::VCMTiming timing;
  webrtc::VCMDecodedFrameCallback callback;
  Decoder decoder;
  std::unique_ptr<webrtc::VCMGenericDecoder> generic;
};

void Burst(Check check, const webrtc::Environment& env, bool leased) {
  Harness h(check, env, leased);
  for (uint32_t i = 0; i < 22; ++i)
    check(h.Send(90000 + i * 750) == WEBRTC_VIDEO_CODEC_OK, "CPU burst was not actually admitted");
  check(h.decoder.LiveLeases() == (leased ? 22 : 0) &&
        h.receive.evicted == (leased ? 0 : 12),
        "Real SDK/admission burst failed to reproduce the original twelve premature evictions");
  for (unsigned i = 0; i < 22; ++i) h.decoder.Complete();
  for (uint32_t i = 22; i < 80; ++i) {
    check(h.Send(90000 + i * 750) == WEBRTC_VIDEO_CODEC_OK, "CPU steady input was not admitted");
    h.decoder.Complete();
  }
  const auto snapshot = h.decoder.fixture.ledger->Snapshot();
  check(snapshot.submit.outcomes[static_cast<std::size_t>(Outcome::Queued)] == 80 &&
        snapshot.output.outcomes[static_cast<std::size_t>(Output::CallbackCompleted)] == 80 &&
        h.receive.mapped == (leased ? 80 : 68) && h.receive.missing == (leased ? 0 : 12) &&
        h.receive.evicted == (leased ? 0 : 12) && h.receive.dropped == (leased ? 0 : 12) &&
        h.receive.retired == 0 && h.receive.skipped == 0,
        "Actual eighty native callbacks did not distinguish legacy68 mappings from leased80");
  h.Empty();
}

void Capacity(Check check, const webrtc::Environment& env, uint32_t capacity) {
  Harness h(check, env, true, capacity);
  check(h.decoder.GetDecoderInfo().monky_frame_info_lease_limit == capacity,
        "DecoderInfo limit was guessed instead of derived from the actual native budget");
  for (uint32_t i = 0; i < capacity; ++i)
    check(h.Send(90000 + i * 750) == WEBRTC_VIDEO_CODEC_OK, "Bounded native admission stopped early");
  check(h.Send(90000 + capacity * 750) == WEBRTC_VIDEO_CODEC_ERROR &&
        h.decoder.last_native_status == WEBRTC_VIDEO_CODEC_ERROR &&
        h.decoder.fixture.ledger->Snapshot().submit.outcomes[static_cast<std::size_t>(Outcome::AdmissionFull)] == 1 &&
        h.decoder.LiveLeases() == capacity && h.decoder.leases.back().expired() &&
        h.receive.evicted == 0 && h.receive.retired == 1 && h.receive.dropped == 1,
        "Full budget plus provisional attempt evicted accepted work or bypassed actual native refusal");
  Access::RecoverWithoutCore(*h.decoder.fixture.worker);
  check(h.decoder.LiveLeases() == 0, "Actual recovery retained old-epoch input mapping metadata");
  h.callback.PruneFrameInfoLeases();
  check(h.receive.retired == capacity + 1 && h.receive.dropped == capacity + 1 &&
        h.receive.cleared == 0 && h.receive.missing == 0,
        "Recovery ownership was mislabeled as overflow, a bulk clear, or duplicate loss");
  check(h.Send(90000 + (capacity + 1) * 750) == WEBRTC_VIDEO_CODEC_OK,
        "Native recovery failed to admit a new original-PTS input");
  h.decoder.Complete();
  h.Empty();
}

void Run(Check check) {
  webrtc::LogMessage::LogToDebug(webrtc::LS_NONE);
  webrtc::LogMessage::SetLogToStderr(false);
  webrtc::SimulatedClock clock(webrtc::Timestamp::Millis(606000));
  const auto env = webrtc::CreateEnvironment(&clock);
  check(AdapterOptions{}.maximum_pending_frames == 32, "Mapping correction changed native admission policy");
  {
    auto lease = std::make_shared<webrtc::MonkyDecoderFrameInfoLease>();
    std::weak_ptr<webrtc::MonkyDecoderFrameInfoLease> weak = lease;
    webrtc::EncodedImage image;
    image.SetMonkyFrameInfoLease(lease);
    webrtc::EncodedImage copied(image), moved(std::move(copied)), assigned;
    assigned = image;
    webrtc::EncodedImage move_assigned;
    move_assigned = std::move(assigned);
    check(moved.MonkyFrameInfoLease() == lease && move_assigned.MonkyFrameInfoLease() == lease &&
          !copied.MonkyFrameInfoLease() && !assigned.MonkyFrameInfoLease(),
          "Actual EncodedImage copy/move lost the typed metadata ownership contract");
    image.SetMonkyFrameInfoLease(nullptr);
    lease.reset();
    check(!weak.expired(), "EncodedImage copy failed to retain its provisional metadata");
    moved.SetMonkyFrameInfoLease(nullptr);
    move_assigned.SetMonkyFrameInfoLease(nullptr);
    check(weak.expired(), "EncodedImage retained metadata after every actual owner released it");
    webrtc::VideoDecoder::DecoderInfo first, second;
    check(first == second && !first.monky_frame_info_lease_limit, "Other decoders did not remain opted out");
    first.monky_frame_info_lease_limit = 32;
    check(first != second, "DecoderInfo equality ignored the ownership contract");
    second.monky_frame_info_lease_limit = 32;
    check(first == second, "Identical ownership contracts compared unequal");
  }
  {
    struct RetireBeforeSlot final : webrtc::MonkyDecoderFrameInfoLease {
      RetireBeforeSlot(std::shared_ptr<Budget> budget, bool& observed)
          : budget(std::move(budget)), observed(observed) {}
      ~RetireBeforeSlot() override { observed = !budget->Acquire(1); }
      std::shared_ptr<Budget> budget;
      bool& observed;
    };
    auto budget = std::make_shared<Budget>(2, 1024);
    auto occupied = budget->Acquire(1);
    bool before_slot = false;
    DecodeAdmission first;
    first.admission = budget->Acquire(1);
    first.frame_info = std::make_shared<RetireBeforeSlot>(budget, before_slot);
    DecodeAdmission copied = first;
    first = DecodeAdmission{};
    check(!before_slot && !budget->Acquire(1), "Metadata copy released the original native admission");
    copied = first;
    check(before_slot && budget->Acquire(1), "Metadata assignment made its slot reusable before lease retirement");
  }
  Burst(check, env, false);
  Burst(check, env, true);
  for (uint32_t capacity : {2u, 32u, 128u}) Capacity(check, env, capacity);
  {
    Harness h(check, env);
    h.decoder.synchronous = true;
    h.receive.on_render = [&](const auto& frame) {
      check(!h.decoder.during_admission.expired() && !h.decoder.during_lease.expired() &&
            h.decoder.fixture.ledger->Snapshot().output.in_progress == 1 &&
            frame.video_frame.packet_infos().size() == 2,
            "Synchronous callback ran before mapping or after releasing its real admission");
    };
    check(h.Send(90000) == WEBRTC_VIDEO_CODEC_OK && h.receive.mapped == 1 && h.receive.missing == 0 &&
          h.decoder.LiveLeases() == 0, "Synchronous callback lost its before-Decode provisional lease");
    h.Empty();
  }
  {
    Harness h(check, env);
    for (uint32_t i = 0; i < 32; ++i) h.Send(90000 + i * 750);
    h.receive.on_render = [&](const auto&) {
      check(!Access::CanAdmit(*h.decoder.fixture.worker, 1) &&
            !h.decoder.during_admission.expired() && !h.decoder.during_lease.expired(),
            "Callback in progress released/reused one of the thirty-two original admissions");
    };
    h.decoder.Complete();
    h.receive.on_render = {};
    check(Access::CanAdmit(*h.decoder.fixture.worker, 1) &&
          h.Send(90000 + 32 * 750) == WEBRTC_VIDEO_CODEC_OK,
          "Completed callback failed to release exactly its metadata/admission before reuse");
    for (unsigned i = 0; i < 32; ++i) h.decoder.Complete();
    check(h.receive.mapped == 33 && h.receive.evicted == 0 && h.receive.missing == 0,
          "Sustained full admission lost a mapping at callback/provisional overlap");
    h.Empty();
  }
  for (bool malformed : {false, true}) {
    Harness h(check, env);
    h.Send(90000);
    check(h.Send(malformed ? 90750 : 90000, malformed) < WEBRTC_VIDEO_CODEC_OK &&
          h.decoder.leases.front().lock() && h.decoder.leases.front().lock()->IsLive() &&
          h.decoder.leases.back().expired() && h.receive.evicted == 0 && h.receive.retired == 1,
          "Duplicate/invalid input retired an accepted mapping with the same RTP identity");
    Access::RecoverWithoutCore(*h.decoder.fixture.worker);
    h.Empty();
  }
  for (unsigned refusal = 0; refusal < 3; ++refusal) {
    Harness h(check, env);
    h.Send(90000);
    if (refusal == 0) h.decoder.fixture.callbacks->Register(nullptr);
    else if (refusal == 1) h.decoder.fixture.worker->RequestStop();
    else Access::FailWorker(*h.decoder.fixture.worker);
    const auto result = h.Send(90750);
    check(result < WEBRTC_VIDEO_CODEC_OK && result == h.decoder.last_native_status &&
          h.decoder.LiveLeases() == 1 && h.decoder.leases.back().expired() &&
          h.receive.retired == 1 && h.receive.evicted == 0 && h.receive.cleared == 0,
          "Unstarted status/stop/callback refusal cleared unrelated accepted SDK work");
    h.Empty();
  }
  {
    Harness h(check, env);
    h.Send(90000);
    for (unsigned i = 1; i < 32; ++i)
      check(Access::PostInert(*h.decoder.fixture.worker, h.decoder.fixture.inert_executed),
            "CPU queue fixture failed before its unchanged native capacity");
    check(h.Send(90750) == WEBRTC_VIDEO_CODEC_ERROR &&
          h.decoder.fixture.ledger->Snapshot().submit.outcomes[
              static_cast<std::size_t>(Outcome::PostMediaRejected)] == 1 &&
          h.decoder.LiveLeases() == 1 && h.receive.retired == 1 && h.receive.evicted == 0,
          "Real PostMedia refusal evicted accepted mapping despite spare AU admission");
    Access::RecoverWithoutCore(*h.decoder.fixture.worker);
    h.Empty();
  }
  {
    Harness h(check, env);
    h.decoder.no_output = true;
    check(h.Send(90000) == WEBRTC_VIDEO_CODEC_NO_OUTPUT &&
          h.receive.retired == 1 && h.receive.evicted == 0 && h.decoder.LiveLeases() == 0,
          "NO_OUTPUT fabricated accepted mapping state or leaked its provisional");
    h.Empty();
  }
  {
    Harness h(check, env);
    h.Send(90000);
    h.decoder.throw_from_decode = true;
    bool original = false;
    try { h.Send(90750); }
    catch (const std::runtime_error& error) { original = std::string_view(error.what()) == "CPU original Decode exception"; }
    check(original && h.decoder.leases.front().lock()->IsLive() &&
          !h.decoder.leases.back().lock()->IsLive(),
          "Decode unwind lost its original exception or failed to invalidate only the current provisional");
    h.callback.PruneFrameInfoLeases();
    check(h.receive.retired == 1 && h.receive.cleared == 0,
          "Decode exception was converted into a global timestamp-map clear");
    h.Empty();
  }
  for (bool stopping : {false, true}) {
    Harness h(check, env);
    h.Send(90000);
    h.decoder.CompleteFiltered(stopping);
    h.callback.PruneFrameInfoLeases();
    const auto snapshot = h.decoder.fixture.ledger->Snapshot();
    check(snapshot.output.outcomes[static_cast<std::size_t>(
              stopping ? Output::Stopping : Output::StaleLossEpoch)] == 1 &&
          h.receive.mapped == 0 && h.receive.missing == 0 && h.receive.retired == 1 &&
          h.decoder.LiveLeases() == 0,
          "Actual native stale/stop filter retained metadata or manufactured an RTC callback");
    h.Empty();
  }
  for (bool throw_callback : {false, true}) {
    Harness h(check, env);
    h.Send(90000);
    if (throw_callback)
      h.receive.on_render = [](const auto&) { throw std::runtime_error("CPU original receive exception"); };
    else h.receive.render_result = WEBRTC_VIDEO_CODEC_ERROR;
    bool original = false;
    try { h.decoder.Complete(); }
    catch (const std::runtime_error& error) { original = std::string_view(error.what()) == "CPU original receive exception"; }
    check(original == throw_callback && h.decoder.LiveLeases() == 0 &&
          h.receive.mapped == (throw_callback ? 0 : 1) && h.receive.missing == 0 &&
          h.decoder.fixture.ledger->Snapshot().output.outcomes[static_cast<std::size_t>(
              throw_callback ? Output::CallbackException : Output::CallbackCompleted)] == 1,
          "Callback errors changed ownership, swallowed their cause, or implied void RTC acceptance");
    h.Empty();
  }
  {
    Harness h(check, env);
    h.Send(90000);
    h.decoder.fixture.callbacks->Register(nullptr);
    h.decoder.Complete();
    h.callback.PruneFrameInfoLeases();
    check(h.receive.retired == 1 && h.receive.mapped == 0 &&
          h.decoder.fixture.ledger->Snapshot().output.outcomes[static_cast<std::size_t>(Output::CallbackRevoked)] == 1,
          "Revoked native callback leaked its accepted mapping");
    h.Empty();
  }
  {
    Harness h(check, env);
    for (uint32_t i = 0; i < 22; ++i)
      check(h.Send(0xfffff800u + i * 750) == WEBRTC_VIDEO_CODEC_OK, "Real RTP wrap was refused");
    for (unsigned i = 0; i < 22; ++i) h.decoder.Complete();
    check(h.receive.mapped == 22 && h.receive.missing == 0 && h.receive.skipped == 0 &&
          h.receive.rendered.front() == 0xfffff800u &&
          h.receive.rendered.back() == 0xfffff800u + 21u * 750u,
          "Ownership-aware lookup changed wrap order or original RTP values");
    h.Empty();
  }
  {
    Harness h(check, env);
    h.Send(90000);
    h.Send(90750);
    h.decoder.Complete(1);
    h.decoder.Complete();
    check(h.receive.mapped == 1 && h.receive.rendered.front() == 90750 &&
          h.receive.skipped == 1 && h.receive.missing == 1 && h.receive.dropped == 1 &&
          h.receive.evicted == 0,
          "Genuinely late output was resurrected or double-counted after exact mapping retention");
    h.Empty();
  }
  {
    Harness h(check, env);
    h.Send(90000);
    h.decoder.fail_configure = true;
    check(!h.generic->Configure({}), "Controlled rejected Configure became successful");
    h.decoder.Complete();
    check(h.receive.mapped == 1, "Failed Configure invalidated still-owned original metadata");
    h.decoder.fail_configure = false;
    h.Send(90750);
    const auto old_session = h.decoder.fixture.worker->id();
    check(h.generic->Configure({}) && h.decoder.fixture.worker->id() != old_session &&
          h.decoder.LiveLeases() == 0, "Actual old admission survived fake-core/session replacement");
    h.Send(90000);
    h.decoder.Complete();
    check(h.receive.mapped == 2 && h.receive.retired == 1 && h.receive.missing == 0,
          "New configured lifetime inherited an old mapping of the same RTP timestamp");
    h.Empty();
  }
  {
    Harness h(check, env), other(check, env);
    h.Send(90000);
    other.Send(90000);
    h.generic.reset();
    check(h.decoder.LiveLeases() == 0 && other.decoder.LiveLeases() == 1 &&
          other.receive.retired == 0, "Release crossed receiver scopes or retained original media");
    h.Configure();
    h.Send(90000);
    h.decoder.Complete();
    other.decoder.Complete();
    check(h.receive.mapped == 1 && other.receive.mapped == 1 && h.receive.retired == 1,
          "Replacement GenericDecoder mixed retired scope with another receive callback");
    h.Empty();
    other.Empty();
  }
  {
    Harness h(check, env, false);
    h.Send(90000, false, 71);
    h.decoder.enable_ownership_on_configure = true;
    check(h.generic->Configure({}), "CPU native replacement failed to configure");
    h.receive.on_render = [&](const auto& frame) {
      check(frame.video_frame.ntp_time_ms() == 1234567,
            "A legacy entry from the previous decoder replaced current leased metadata at equal RTP");
    };
    h.Send(90000);
    h.decoder.Complete();
    check(h.receive.mapped == 1 && h.receive.skipped == 1 && h.receive.dropped == 1 &&
          h.receive.evicted == 0 && h.receive.missing == 0,
          "Equal-RTP decoder replacement mixed active native and obsolete legacy mappings");
    h.Empty();
  }
  {
    Harness h(check, env);
    h.Send(90000);
    h.decoder.switch_to_legacy = true;
    h.Send(90750);
    h.decoder.CompleteSoftware();
    check(h.receive.mapped == 1 && h.receive.rendered.back() == 90750 && h.receive.retired == 1,
          "Mid-Decode fallback lost the current frame or retained old native ownership");
    h.Send(91500);
    h.decoder.switch_to_native = true;
    h.Send(92250);
    h.Send(93000);
    h.decoder.Complete();
    h.decoder.Complete();
    check(h.receive.mapped == 3 && h.receive.skipped == 1 && h.receive.missing == 0 &&
          h.receive.evicted == 0, "Mixed transition failed to preserve the legacy late-frame ordering");
    h.Empty();
  }
}

}  // namespace cpu_decoder_mapping_checks
