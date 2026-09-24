#include "adapter_policy_probe.h"
#include "h264_level_checks.h"
#include "mf_rtc_internal.h"

#include <cmath>
#include <cstring>
#include <limits>
#include <stdexcept>
#include <thread>

namespace monky::native_rtc {
namespace {

namespace policy = mf::detail;
thread_local void (*check_sink)(bool, const char*) = nullptr;

void Check(bool condition, const char* message) {
  if (check_sink) check_sink(condition, message);
  if (!condition) throw std::runtime_error(message);
}

template <typename Function>
void Reject(Function&& function, const char* expected_code) {
  try {
    function();
  } catch (const policy::AdapterError& error) {
    Check(std::strcmp(error.code, expected_code) == 0, "Unexpected adapter policy error");
    return;
  }
  throw std::runtime_error("Invalid adapter policy input was accepted");
}

void VerifyFormatsAndIdleOwnership() {
  RunH264LevelChecks(Check);
  const mf::AdapterOptions options;
  auto bundle = mf::CreateFactoryBundle(options);
  const auto formats = bundle.encoder_factory->GetSupportedFormats();
  Check(formats.size() == 2 && bundle.decoder_factory->GetSupportedFormats() == formats,
        "Encoder/decoder factories disagree on the two H264 profiles");
  for (const auto& format : formats) {
    Check(bundle.encoder_factory->QueryCodecSupport(format, std::nullopt).is_supported &&
          bundle.decoder_factory->QueryCodecSupport(format, false).is_supported,
          "Advertised native H264 format is unsupported");
    Check(!bundle.encoder_factory->QueryCodecSupport(format, "L1T2").is_supported &&
          !bundle.decoder_factory->QueryCodecSupport(format, true).is_supported,
          "Unimplemented temporal/reference scaling was advertised");
    auto invalid = format;
    invalid.parameters["packetization-mode"] = "0";
    Check(!policy::ParseFormat(invalid, 52), "Packetization mode zero was accepted");
  }
  for (const auto prefix : {"42e0", "4d00"}) {
    for (const auto suffix : {"1f", "20", "28", "29", "2a", "32", "33", "34", "3c"}) {
      const webrtc::SdpVideoFormat format(
          "H264", {{"profile-level-id", std::string(prefix) + suffix},
                   {"packetization-mode", "1"}});
      Check(policy::ParseFormat(format, 60).has_value(), "Supported H264 level was rejected");
      if (std::string_view(suffix) == "3c")
        Check(!policy::ParseFormat(format, 52), "A Level5.2 peer was mistaken for Level6 support");
    }
  }
  Check(!policy::ParseFormat(
      webrtc::SdpVideoFormat("H264", {{"profile-level-id", "420033"}, {"packetization-mode", "1"}}), 52),
      "Unconstrained baseline was silently mapped to constrained baseline");
  const auto snapshot = bundle.context->Snapshot();
  Check(snapshot.live_workers == 0 && snapshot.native_buffers == 0 &&
        snapshot.encoded_access_units == 0 && snapshot.rtc_rejected_access_units == 0 &&
        snapshot.decoded_gpu_frames == 0 &&
        snapshot.i420_readbacks == 0 && snapshot.encoders.empty() && !snapshot.hardware_execution_observed &&
        bundle.context->TakeDiagnostics().empty() &&
        bundle.context->WaitForIdle(std::chrono::milliseconds::zero()),
        "Factory-only policy probe unexpectedly started native work");
  Check(!bundle.context->GetGpuFrame(nullptr) && !bundle.context->GetDecodedFrame(nullptr),
        "A missing buffer was represented as a real GPU lease");
  auto invalid = options;
  invalid.maximum_workers = 0;
  Reject([&] { mf::CreateFactoryBundle(invalid); }, "ERR_RTC_OPTIONS");
}

void VerifyRateAndTimestampPolicies() {
  webrtc::VideoCodec codec;
  codec.codecType = webrtc::kVideoCodecH264;
  codec.width = 1920;
  codec.height = 1080;
  codec.maxFramerate = 120;
  codec.startBitrate = codec.maxBitrate = 60000;
  codec.minBitrate = 64;
  codec.active = true;
  codec.mode = webrtc::VideoCodecMode::kScreensharing;
  codec.H264()->numberOfTemporalLayers = 1;
  codec.spatialLayers[0].numberOfTemporalLayers = 1;
  const webrtc::VideoEncoder::Settings settings(
      webrtc::VideoEncoder::Capabilities(false), 4, 1200);
  const auto setup = policy::MakeEncoderSetup(
      codec, settings, {screen_video::H264Profile::ConstrainedBaseline, 51}, {});
  Check(setup.core.level == 51 && setup.core.fps == 120 &&
        setup.initial_bitrate == 60000000 && setup.core.profile ==
            screen_video::H264Profile::ConstrainedBaseline,
        "1080p120 policy does not map to the qualified MF configuration");
  webrtc::VideoEncoder::RateControlParameters rate;
  rate.framerate_fps = 120;
  Check(rate.bitrate.SetBitrate(0, 0, 60000000), "Cannot set bounded bitrate allocation");
  Check(policy::ValidateRates(rate, setup).bitrate == 60000000,
        "Live MF rate policy discarded the requested bitrate");
  rate.bitrate = webrtc::VideoBitrateAllocation();
  rate.framerate_fps = 0;
  Check(policy::ValidateRates(rate, setup).bitrate == 0, "Zero bitrate did not pause admission");
  rate.framerate_fps = -1;
  Check(policy::ValidateRates(rate, setup).fps == 120,
        "RTC's unavailable framerate target did not use the InitEncode ceiling");
  for (const auto fps : {120.001, 121.0, 240.0, 1000.0}) {
    rate.framerate_fps = fps;
    Check(policy::ValidateRates(rate, setup).fps == 120,
          "A transient input-cadence estimate bypassed or rejected the configured ceiling");
  }
  rate.framerate_fps = 59.94;
  Check(policy::ValidateRates(rate, setup).fps == 59.94,
        "A legitimate lower fractional target was replaced by the configured maximum");
  rate.framerate_fps = std::numeric_limits<double>::denorm_min();
  Reject([&] { policy::ValidateRates(rate, setup); }, "ERR_RTC_FRAMERATE");
  rate.framerate_fps = std::numeric_limits<double>::infinity();
  Reject([&] { policy::ValidateRates(rate, setup); }, "ERR_RTC_FRAMERATE");
  rate.framerate_fps = std::numeric_limits<double>::quiet_NaN();
  Reject([&] { policy::ValidateRates(rate, setup); }, "ERR_RTC_FRAMERATE");
  rate.framerate_fps = 120;
  Check(rate.bitrate.SetBitrate(0, 1, 1000000), "Cannot construct rejected rate-layer input");
  Reject([&] { policy::ValidateRates(rate, setup); }, "ERR_RTC_RATE_LAYERS");

  policy::SourceRateLimiter jittered(120);
  for (std::int64_t frame = 0; frame < 7200; ++frame) {
    const auto timestamp = 1000000 + frame * 1000000 / 120 + (frame % 2 ? 2500 : -2500);
    Check(jittered.Accept(timestamp), "Source jitter caused systematic 120FPS policy drops");
  }
  policy::SourceRateLimiter bounded(120), fractional(59.94);
  std::size_t accepted = 0, fractional_accepted = 0;
  for (std::int64_t frame = 0; frame < 2400; ++frame) {
    const auto timestamp = frame * 1000000 / 240;
    accepted += bounded.Accept(timestamp);
    fractional_accepted += fractional.Accept(timestamp);
    // Include the production limiter's one-microsecond timestamp rounding.
    Check(accepted <= static_cast<std::size_t>((timestamp + 1) * 120 / 1000000 + 2),
          "Rate limiter accrued more than one extra scheduling credit");
  }
  Check(accepted >= 1199 && accepted <= 1201 &&
        fractional_accepted >= 599 && fractional_accepted <= 601,
        "Integer/fractional rates did not preserve their bounded long-run deadlines");
  bounded.Reset();
  bounded.SetFps(60);
  Check(bounded.Accept(11000000), "Rate policy did not resume after reset");
  Reject([&] { bounded.Accept(11000000); }, "ERR_RTC_SOURCE_TIMESTAMP");
  Reject([&] { bounded.Accept(9007199254740992ll); }, "ERR_RTC_SOURCE_TIMESTAMP");
  policy::RtpTimeline timeline;
  Check(timeline.Push(0xfffffff0u) == 0 && timeline.Push(0x20u) == 533,
        "RTP wraparound lost the original 90kHz timeline");
  Reject([&] { timeline.Push(0x20u); }, "ERR_RTC_RTP_TIMESTAMP");
  Reject([&] { timeline.Push(0x10u); }, "ERR_RTC_RTP_TIMESTAMP");
  Reject([&] { policy::InspectAccessUnit({}); }, "ERR_RTC_ANNEX_B");
}

void VerifyPureOwnership() {
  auto budget = std::make_shared<policy::Budget>(2, 10);
  auto first = budget->Acquire(6);
  Check(first && !budget->Acquire(5), "Byte admission bound was not enforced");
  auto second = budget->Acquire(4);
  Check(second && !budget->Acquire(0), "Count admission bound was not enforced");
  first.reset();
  auto replacement = budget->Acquire(5);
  Check(replacement != nullptr, "Released admission credit did not return");
  std::weak_ptr<policy::Budget> weak_budget = budget;
  budget.reset();
  Check(!weak_budget.expired(), "Budget was destroyed before its outstanding leases");
  second.reset();
  replacement.reset();
  Check(weak_budget.expired(), "Budget ownership leaked after final lease release");

  struct Counter { unsigned calls = 0; } callback;
  policy::CallbackGate<Counter> gate;
  gate.Register(&callback);
  const auto first_generation = gate.Activate();
  Check(gate.Invoke(first_generation, [&](Counter& current) {
    Check(gate.IsInvokingOnCurrentThread(), "Callback invocation ownership is missing");
    ++current.calls;
    gate.Clear();
  }), "Registered callback was not invoked");
  Check(!gate.Invoke(first_generation, [](Counter& current) { ++current.calls; }),
        "A revoked callback was invoked");
  gate.Register(&callback);
  const auto second_generation = gate.Activate();
  gate.Deactivate(first_generation);
  Check(!gate.HasCallback(first_generation) && gate.HasCallback(second_generation),
        "Old callback generation affected a newer codec session");
  gate.Invoke(second_generation, [](Counter& current) { ++current.calls; });
  gate.Clear();
  Check(callback.calls == 2, "Callback reentrant revocation lost ownership");

  auto state = std::make_shared<policy::SharedState>(mf::AdapterOptions{});
  for (std::uint64_t index = 0; index < 70; ++index) {
    state->Report(index, policy::Diagnostic("OFFLINE_CONTROL", "Bounded diagnostics control"));
  }
  const auto diagnostics = state->TakeDiagnostics();
  Check(diagnostics.size() == 64 && diagnostics.front().session_id == 6 &&
        state->Snapshot().diagnostics_overwritten == 6 && state->TakeDiagnostics().empty(),
        "Bounded diagnostic history was silently lost or grew");
  const auto first_slot = state->ReserveWorker(), second_slot = state->ReserveWorker();
  {
    std::lock_guard lock(first_slot->snapshot_mutex);
    first_slot->encoder = mf::EncoderRuntimeSnapshot{};
    first_slot->encoder->session_id = 71;
    first_slot->encoder->configured.fps = 120;
    first_slot->encoder->requested_fps = 30;
    first_slot->encoder->core.outputs = 5;
  }
  {
    std::lock_guard lock(second_slot->snapshot_mutex);
    second_slot->encoder = mf::EncoderRuntimeSnapshot{};
    second_slot->encoder->session_id = 72;
    second_slot->encoder->core.outputs = 9;
  }
  auto observed = state->Snapshot();
  Check(observed.encoders.size() == 2 && observed.encoders[0].session_id == 71 &&
        observed.encoders[1].session_id == 72 && observed.encoders[0].configured.fps == 120 &&
        observed.encoders[0].requested_fps == 30 && observed.encoders[0].core.outputs == 5 &&
        !observed.hardware_execution_observed,
        "Per-worker observation mixed configured rate, actual counters or hardware qualification");
  observed.encoders[0].core.outputs = 99;
  Check(state->Snapshot().encoders[0].core.outputs == 5,
        "A snapshot reader mutated the worker's diagnostic state");
  first_slot->start_failed.store(true);
  const auto remaining = state->Snapshot();
  Check(remaining.encoders.size() == 1 && remaining.encoders[0].session_id == 72,
        "Retired worker diagnostics were retained or removed a different worker");
  second_slot->start_failed.store(true);
  Check(state->Snapshot().encoders.empty(), "Worker-bound diagnostic storage outlived its slots");
}

using Bytes = std::vector<std::uint8_t>;

Bytes ParserPacket(const Bytes& sps) {
  // Parser-only SPS/PPS/slice descriptors, not entropy-coded media to decode.
  Bytes packet{0, 0, 0, 1};
  packet.insert(packet.end(), sps.begin(), sps.end());
  packet.insert(packet.end(), {0, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80,
                               0, 0, 0, 1, 0x65, 0xbc});
  return packet;
}

void VerifyAdaptiveDecoderSessions() {
  const Bytes full_sps{0x67, 0x42, 0xc0, 0x33, 0xf4, 0x03, 0xc0, 0x11, 0x3f, 0x2a};
  const Bytes small_sps{0x67, 0x42, 0xc0, 0x33, 0xf4, 0x02, 0x80, 0x2d, 0xc8};
  const Bytes crop_sps{0x67, 0x42, 0xc0, 0x33, 0xf4, 0x03, 0xc8, 0x11, 0x38, 0x9c, 0xa8};
  const auto full = ParserPacket(full_sps), smaller = ParserPacket(small_sps), crop = ParserPacket(crop_sps);
  const auto full_info = policy::InspectAccessUnit(full);
  const auto small_info = policy::InspectAccessUnit(smaller);
  const auto crop_info = policy::InspectAccessUnit(crop);
  const policy::NegotiatedH264 negotiated{screen_video::H264Profile::ConstrainedBaseline, 52};
  const mf::AdapterOptions options;
  const auto plan = [&](const std::optional<screen_video::H264Sps>& current,
                        const policy::AccessUnitInfo& information, const Bytes& packet) {
    return policy::PlanDecoderSession(current, information, packet, negotiated, 1920, 1080, 8, options);
  };
  const auto first = plan(std::nullopt, full_info, full);
  Check(first && first->width == 1920 && first->height == 1080 && first->profileLevelId == "42c033",
        "Initial session did not preserve actual received SPS geometry/profile/level");
  Check(!plan(full_info.sps, full_info, full), "Identical SPS unnecessarily replaced the MF session");
  const auto down = plan(full_info.sps, small_info, smaller);
  Check(down && down->width == 1280 && down->height == 720 && down->profileLevelId == first->profileLevelId,
        "Same-payload/profile/level 1080p-to-720p IDR did not request an internal MF replacement");
  const auto up = plan(small_info.sps, full_info, full);
  Check(up && up->width == 1920 && up->height == 1080, "720p-to-1080p IDR could not restore the mode");
  Check(crop_info.sps->width == 1920 && crop_info.sps->codedWidth == 1936 &&
        crop_info.sps->cropLeft == 16 && plan(full_info.sps, crop_info, crop).has_value(),
        "Coded geometry/crop change was lost because visible dimensions stayed equal");
  const Bytes delta{0, 0, 0, 1, 0x41, 0xf0};
  const auto delta_info = policy::InspectAccessUnit(delta);
  Check(!plan(small_info.sps, delta_info, delta), "A following P picture attempted to replace the new session");
  Reject([&] { plan(std::nullopt, delta_info, delta); }, "ERR_RTC_DECODER_SESSION_IDR");
  auto non_idr = smaller;
  non_idr[non_idr.size() - 2] = 0x41;
  Reject([&] { plan(full_info.sps, policy::InspectAccessUnit(non_idr), non_idr); },
         "ERR_RTC_DECODER_SESSION_IDR");
  Check(plan(std::nullopt, small_info, smaller).has_value(),
        "A reset could not bootstrap the new mode from a fresh IDR/SPS/PPS");
  Check(policy::Protect([&] {
    const Bytes missing_pps(smaller.begin(), smaller.begin() + 4 + small_sps.size());
    auto incomplete = missing_pps;
    incomplete.insert(incomplete.end(), {0, 0, 0, 1, 0x65, 0xbc});
    plan(full_info.sps, policy::InspectAccessUnit(incomplete), incomplete);
  }).has_value(), "Replacement accepted IDR with an unresolved PPS");
  auto limited = small_info;
  limited.sps->fullRange = true;
  Reject([&] { plan(full_info.sps, limited, smaller); }, "ERR_RTC_NEGOTIATED_SPS");
  auto main_sps = small_sps;
  main_sps[1] = 77;
  main_sps[2] = 0;
  const auto main_packet = ParserPacket(main_sps);
  Reject([&] { plan(full_info.sps, policy::InspectAccessUnit(main_packet), main_packet); },
         "ERR_RTC_NEGOTIATED_SPS");
  auto constrained_main = main_sps;
  constrained_main[2] = 0x04;
  const auto amf_packet = ParserPacket(constrained_main);
  const auto amf_info = policy::InspectAccessUnit(amf_packet);
  const auto amf_plan = policy::PlanDecoderSession(std::nullopt, amf_info, amf_packet,
      {screen_video::H264Profile::Main, 51}, 1920, 1080, 8, options);
  Check(amf_plan && amf_plan->profileLevelId == "4d0433" && amf_info.sps->compatibility == 0x04,
        "AMF constrained Main SPS must be admitted without rewriting its original bytes");
  Reject([&] { plan(std::nullopt, amf_info, amf_packet); }, "ERR_RTC_NEGOTIATED_SPS");
  for (const auto flags : {0x08, 0x0c, 0x20, 0x80}) {
    auto unsupported = *amf_info.sps;
    unsupported.compatibility = static_cast<std::uint8_t>(flags);
    Reject([&] { policy::ValidateSps(unsupported, {screen_video::H264Profile::Main, 51}, 1920, 1080); },
           "ERR_RTC_NEGOTIATED_PROFILE");
  }
  Reject([&] { policy::PlanDecoderSession(small_info.sps, full_info, full, negotiated,
                                         1280, 720, 8, options); }, "ERR_RTC_NEGOTIATED_SPS");
  auto lower_sps = small_sps;
  lower_sps[3] = 31;
  const auto lower_packet = ParserPacket(lower_sps);
  const auto lower = plan(full_info.sps, policy::InspectAccessUnit(lower_packet), lower_packet);
  Check(lower && lower->profileLevelId == "42c01f",
        "A valid lower actual level was replaced by the SDP ceiling");

  struct Callback { std::size_t frames = 0; } callback;
  policy::CallbackGate<Callback> callbacks;
  callbacks.Register(&callback);
  const auto generation = callbacks.Activate();
  policy::RtpTimeline timeline;
  Check(timeline.Push(0xfffffff0u) == 0, "Initial RTP origin changed");
  Check(plan(full_info.sps, small_info, smaller).has_value() &&
        timeline.Push(0x20u) == 533 && timeline.Push(0x2ffu) == 8700,
        "Session replacement reset or reordered the wrapped RTP timeline");
  Check(callbacks.Invoke(generation, [](Callback& sink) { ++sink.frames; }) &&
        callback.frames == 1, "An internal replacement revoked the live WebRTC callback generation");

  struct Core {
    Core(unsigned id, std::vector<std::pair<unsigned, DWORD>>& destroyed)
        : id(id), destroyed(destroyed) {}
    ~Core() { destroyed.emplace_back(id, GetCurrentThreadId()); }
    bool Finished() const { return finished; }
    unsigned ReadbackOwner() const { return id; }
    unsigned id;
    std::vector<std::pair<unsigned, DWORD>>& destroyed;
    bool finished = false;
  };
  std::vector<std::pair<unsigned, DWORD>> destroyed;
  const auto owner_thread = GetCurrentThreadId();
  policy::RetiredDecoderSessions<Core> retired(1);
  auto current = std::make_shared<Core>(1, destroyed);
  auto old_frame = current;
  auto old_readback = old_frame;
  Reject([&] { retired.Retire(current); }, "ERR_RTC_DECODER_SESSION");
  current->finished = true;
  retired.Retire(current);
  Check(!current && retired.Retired() == 1 && destroyed.empty(), "Old GPU owners were destroyed during replacement");
  current = std::make_shared<Core>(2, destroyed);
  Check(old_frame->ReadbackOwner() == 1 && old_readback->ReadbackOwner() == 1 &&
        current->ReadbackOwner() == 2, "Old outputs/readbacks were rebound to the new MF session");
  auto second_frame = current;
  current->finished = true;
  Reject([&] { retired.Retire(current); }, "ERR_RTC_DECODER_OWNERS");
  Check(current && retired.Retired() == 1, "Owner-budget rejection lost the active finished session");
  old_frame.reset();
  std::thread release([owner = std::move(old_readback)]() mutable { owner.reset(); });
  release.join();
  Check(destroyed.empty(), "The final foreign lease destroyed the MTA core on its caller's thread");
  retired.Reap();
  Check(destroyed == std::vector<std::pair<unsigned, DWORD>>{{1, owner_thread}},
        "Retired core was not reaped on its owning worker");
  retired.Retire(current);
  Check(!current && retired.Retired() == 1 && second_frame->ReadbackOwner() == 2,
        "Replacement could not resume after old owners returned their credit");
  second_frame.reset();
  retired.Reap();
  Check(retired.Retired() == 0 && destroyed.back() == std::pair<unsigned, DWORD>{2, owner_thread},
        "The last retired session leaked or changed destruction thread");
}

void VerifyFenceNotificationRecovery() {
  using Observation = policy::FenceObservation;
  const auto start = policy::SteadyClock::time_point{};
  policy::FenceNotification source, completion;
  source.RecordArm(true, start);
  completion.RecordArm(false, start);
  Check(source.Armed() && !completion.Armed() &&
        completion.ReportArmFailure() && !completion.ReportArmFailure(),
        "Failed registration was treated as armed or emitted unbounded duplicate diagnostics");
  Check(source.Observe(10, 10) == Observation::Complete &&
        source.WaitMilliseconds(start) == UINT32_MAX, "Completed source fence still required a wait");
  auto budget = std::make_shared<policy::Budget>(1, 0);
  auto source_owner = budget->Acquire(0);
  auto retirement = source_owner;
  source_owner.reset();  // Source closed; no more commands or media-core wakes.
  Check(!budget->Acquire(0), "Source close released the outstanding readback credit");
  for (unsigned tick = 1; tick <= 120; ++tick) {
    const auto now = start + policy::kFenceRetryInterval * tick;
    Check(completion.Observe(1, 2) == Observation::Pending &&
          completion.ShouldArm(now), "Pending completion lost its scheduled retry");
    completion.RecordArm(false, now);
    Check(!completion.ShouldArm(now + std::chrono::milliseconds(99)) &&
          completion.WaitMilliseconds(now) == 100 &&
          completion.WaitMilliseconds(now + std::chrono::milliseconds(99)) == 1,
          "Failed registration busy-spun or inherited INFINITE after watchdog expiry");
    Check(!budget->Acquire(0), "A timeout retired the source lease before real GPU completion");
  }
  const auto late = start + std::chrono::seconds(12);
  Check(late > start + policy::kProgressDeadline &&
        completion.Observe(2, 2) == Observation::Complete,
        "Real completion after the expired watchdog was not observable");
  retirement.reset();
  Check(budget->Acquire(0) != nullptr && completion.WaitMilliseconds(late) == UINT32_MAX,
        "A genuinely completed retirement failed to return ownership/credit");

  policy::FenceNotification recovered;
  recovered.RecordArm(false, start);
  Check(recovered.ShouldArm(start + policy::kFenceRetryInterval), "Rearm was never attempted");
  recovered.RecordArm(true, start + policy::kFenceRetryInterval);
  Check(recovered.Armed() && !recovered.ShouldArm(late) && recovered.WaitMilliseconds(late) == 1000,
        "A successful rearm was duplicated or lost its bounded device-loss health check");
  Check(recovered.Observe(0, 2, true) == Observation::DeviceLost,
        "Device loss after source close could not retire an armed but unsignaled fence");
  policy::FenceNotification lost;
  lost.RecordArm(false, start);
  Check(lost.Observe(UINT64_MAX, 2) == Observation::DeviceLost,
        "The device-loss sentinel was mistaken for successful GPU completion");
  Reject([&] { lost.Observe(0, 0); }, "ERR_RTC_FENCE_VALUE");
  Reject([&] { lost.Observe(0, UINT64_MAX); }, "ERR_RTC_FENCE_VALUE");
}

}  // namespace

void VerifyDeviceFreeAdapterPolicies(void (*check)(bool, const char*)) {
  struct RestoreCheckSink {
    decltype(check_sink) previous;
    ~RestoreCheckSink() { check_sink = previous; }
  } restore{std::exchange(check_sink, check)};
  VerifyFormatsAndIdleOwnership();
  VerifyRateAndTimestampPolicies();
  VerifyPureOwnership();
  VerifyAdaptiveDecoderSessions();
  VerifyFenceNotificationRecovery();
}

}  // namespace monky::native_rtc
