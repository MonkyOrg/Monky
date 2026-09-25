#include "transport_parameters.h"
#include "peer_support.h"
#include "resource_registry.h"
#include "presentation\lease_policy_checks.h"
#include "operation_completion_checks.h"
#include "receive_mid_checks.h"
#include "receive_route_checks.h"
#include "receiver_policy_checks.h"
#include "capture_clock_checks.h"
#include "encoded_video.h"
#include "av1_encoder_checks.h"
#include "node\input_leases_checks.h"
#include "node\event_queue_checks.h"
#include "audio\foundation_checks.h"
#include "audio\operational_checks.h"
#include "mf_rtc_timing_checks.h"
#include "mf_rtc_configuration_checks.h"
#include "mf_rtc_encoder_diagnostic_checks.h"
#include "mf_rtc_encoder_submit_checks.h"
#include "rtc_send_diagnostics_checks.h"
#include "encoder_diagnostics_checks.h"
#include "mf_rtc_decoder_diagnostic_checks.h"
#include "mf_rtc_decoder_submit_checks.h"
#include "decoder_diagnostics_checks.h"
#include "rtc_receive_diagnostics_checks.h"
#include "rtc_receive_sdk_checks.h"
#include "adapter_policy_probe.h"

#include <cstddef>
#include <cstdio>
#include <stdexcept>

namespace rtc = monky::native_rtc::engine;
namespace parameters = rtc::sfu_detail;
using rtc::Json;

namespace {

unsigned checks = 0;

void Check(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
  ++checks;
}

template <typename Function>
void Reject(Function&& function, MonkyEngineStatus expected) {
  try { function(); }
  catch (const rtc::Error& error) {
    Check(error.status == expected, "Unexpected validation error status");
    return;
  }
  throw std::runtime_error("Invalid signaling input was accepted");
}

Json Candidate() {
  return Json::parse(
      R"([{"foundation":"1","priority":1,"ip":"127.0.0.1","address":"127.0.0.1","protocol":"udp","port":4444,"type":"host"}])");
}

Json Fingerprint(const char* algorithm, std::size_t bytes) {
  std::string value;
  for (std::size_t i = 0; i < bytes; ++i) {
    if (i) value.push_back(':');
    value += "A0";
  }
  return {{"algorithm", algorithm}, {"value", std::move(value)}};
}

}  // namespace

int main() {
  try {
    auto candidates = Candidate();
    parameters::IceCandidates(candidates);
    Check(candidates.front().at("ip") == "127.0.0.1" &&
          !candidates.front().contains("address"), "Server ip/address DTO was not normalized");
    candidates = Candidate();
    candidates.front().erase("ip");
    parameters::IceCandidates(candidates);
    Check(candidates.front().at("ip") == "127.0.0.1", "Address-only candidate was not normalized");
    candidates = Candidate();
    candidates.front().erase("address");
    parameters::IceCandidates(candidates);
    Check(candidates.front().at("port") == 4444, "Legacy IP candidate changed");
    candidates = Candidate();
    candidates.front()["address"] = "127.0.0.2";
    Reject([&] { parameters::IceCandidates(candidates); }, MONKY_ENGINE_INVALID);
    candidates = Candidate();
    candidates.front()["protocol"] = "tcp";
    candidates.front()["tcpType"] = "passive";
    parameters::IceCandidates(candidates);
    Check(candidates.front().at("tcpType") == "passive", "TCP candidate was not preserved");
    candidates.front().erase("tcpType");
    Reject([&] { parameters::IceCandidates(candidates); }, MONKY_ENGINE_INVALID);
    candidates = Candidate();
    candidates.front()["port"] = 65536u;
    Reject([&] { parameters::IceCandidates(candidates); }, MONKY_ENGINE_INVALID);
    candidates = Candidate();
    candidates.front()["unexpected"] = true;
    Reject([&] { parameters::IceCandidates(candidates); }, MONKY_ENGINE_UNSUPPORTED);
    candidates = Json::array();
    Reject([&] { parameters::IceCandidates(candidates); }, MONKY_ENGINE_INVALID);

    auto fingerprints = Json::array({Fingerprint("sha-1", 20), Fingerprint("sha-224", 28),
        Fingerprint("sha-256", 32), Fingerprint("sha-384", 48), Fingerprint("sha-512", 64)});
    Json dtls{{"fingerprints", fingerprints}};
    parameters::DtlsParameters(dtls);
    Check(dtls.at("role") == "auto", "Optional server DTLS role was not normalized");
    Check(dtls.at("fingerprints").size() == 3, "Legacy hashes displaced strong DTLS fingerprints");
    Check(dtls.at("fingerprints").back().at("algorithm") == "sha-512",
          "Pinned RemoteSdp would select an unexpected fingerprint");
    dtls = {{"role", "server"}, {"fingerprints", Json::array({Fingerprint("sha-256", 32)})}};
    parameters::DtlsParameters(dtls);
    Check(dtls.at("role") == "server", "Explicit DTLS role changed");
    dtls["fingerprints"] = Json::array({Fingerprint("sha-1", 20)});
    Reject([&] { parameters::DtlsParameters(dtls); }, MONKY_ENGINE_UNSUPPORTED);
    dtls["fingerprints"] = Json::array({Fingerprint("sha-256", 31)});
    Reject([&] { parameters::DtlsParameters(dtls); }, MONKY_ENGINE_INVALID);
    dtls["fingerprints"] = Json::array({Fingerprint("sha-256", 32)});
    dtls["fingerprints"].front()["value"] = std::string(95, 'Z');
    Reject([&] { parameters::DtlsParameters(dtls); }, MONKY_ENGINE_INVALID);
    dtls = {{"role", "invalid"}, {"fingerprints", fingerprints}};
    Reject([&] { parameters::DtlsParameters(dtls); }, MONKY_ENGINE_INVALID);

    Check(rtc::SyncGroup(Json{{"syncGroup", "screen:606-source"}}) == "screen:606-source",
          "Valid synchronization group changed");
    Reject([] { (void)rtc::SyncGroup(Json{{"syncGroup", "screen\r\ninjected"}}); }, MONKY_ENGINE_INVALID);
    auto encoding = Json{{"maxBitrateBps", 60000000u}, {"maxFramerate", 120}};
    const auto configured = rtc::peer_detail::Encoding(encoding, false);
    Check(!configured.active && configured.max_bitrate_bps == 60000000 &&
          configured.max_framerate == 120, "Encoding limits did not preserve disabled 120fps intent");
    encoding["maxBitrateBps"] = 1u;
    Reject([&] { (void)rtc::peer_detail::Encoding(encoding, false); }, MONKY_ENGINE_INVALID);
    encoding["maxBitrateBps"] = 60000000u;
    encoding["maxFramerate"] = 241;
    Reject([&] { (void)rtc::peer_detail::Encoding(encoding, false); }, MONKY_ENGINE_INVALID);
    rtc::Cancellation cancellation;
    cancellation.deadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
    cancellation.Check();
    cancellation.cancelled.store(true);
    Reject([&] { cancellation.Check(); }, MONKY_ENGINE_CANCELLED);
    cancellation.cancelled.store(false);
    cancellation.deadline = std::chrono::steady_clock::now() - std::chrono::seconds(1);
    Reject([&] { cancellation.Check(); }, MONKY_ENGINE_TIMEOUT);

    Reject([] { rtc::ResourceRegistry invalid(0); }, MONKY_ENGINE_INVALID);
    rtc::ResourceRegistry resources(3);
    resources.Register(1, 0, 0);
    resources.Register(2, 0, 0);
    resources.Register(3, 2, 1);
    Check(resources.Size() == 3, "Resource budget accounting changed");
    Check(resources.Contains(3) && resources.Parent(3) == 2, "Publication lost its real parent");
    Check(resources.Within(3, 2) && !resources.Within(3, 1),
          "A source dependency must not become a transport parent");
    cancellation.target = 3;
    Check(resources.ShouldCancel(2, cancellation, cancellation.target), "Parent close did not cancel its child");
    cancellation.committed = true;
    Check(!resources.ShouldCancel(2, cancellation, cancellation.target), "Completion lost its commit point");
    cancellation.committed = false;
    cancellation.closes_resource = true;
    Check(!resources.ShouldCancel(2, cancellation, cancellation.target), "Concurrent closes cancelled each other");
    cancellation.closes_resource = false;
    cancellation.target = 1;
    Check(resources.ShouldCancel(2, cancellation, 3), "Server callback ownership ignored its actual target");
    Reject([&] { resources.ValidateClose(1, Json::object()); }, MONKY_ENGINE_BUSY);
    Check(resources.Size() == 3, "Rejected source close mutated ownership");
    Reject([&] { resources.ValidateClose(2, Json{{"unexpected", true}}); }, MONKY_ENGINE_INVALID);
    Reject([&] { resources.ValidateClose(99, Json::object()); }, MONKY_ENGINE_NOT_FOUND);
    Reject([&] { resources.Register(4, 2, 1); }, MONKY_ENGINE_BUSY);
    resources.Erase(3);
    resources.ValidateClose(1, Json::object());
    Check(resources.Size() == 2, "Publication close did not release its source dependency");
    Reject([&] { resources.Register(4, 99, 1); }, MONKY_ENGINE_NOT_FOUND);
    Reject([&] { resources.Register(4, 2, 99); }, MONKY_ENGINE_NOT_FOUND);
    Reject([&] { resources.Register(2, 0, 0); }, MONKY_ENGINE_INVALID);
    Check(resources.Size() == 2, "Failed registration mutated other resources");
    resources.Erase(2);
    resources.Erase(1);
    Check(!resources.Contains(2) && resources.Size() == 0, "Known retired resources remained registered");

    Json groups{{"signalingAndResources", checks}};
    const auto group = [&](const char* name, auto&& run) {
      const auto before = checks;
      run();
      groups[name] = checks - before;
    };
    group("presentationLease", [] { rtc::presentation::policy::RunChecks(Check); });
    group("operationCompletion", [] { rtc::RunOperationCompletionChecks(Check); });
    group("receiveMids", [] { parameters::RunReceiveMidChecks(Check); });
    group("receiveRoutes", [] { rtc::RunReceiveRouteChecks(Check); });
    group("receiverLifecycle", [] { rtc::receiver_policy::RunReceiverPolicyChecks(Check); });
    group("captureClock", [] { rtc::RunCaptureClockChecks(Check); });
    group("externalH264", [] { rtc::RunEncodedVideoChecks(Check); });
    group("softwareAV1", [] { rtc::RunAv1EncoderChecks(Check); });
    group("peerStartupBitrate", [] {
      const auto value = rtc::peer_detail::StartupBitrate({{"startBitrateBps", 5000000u}, {"maxBitrateBps", 20000000u}});
      Check(value.start_bitrate_bps == 5000000 && value.max_bitrate_bps == 20000000 &&
          !value.min_bitrate_bps.has_value(), "Startup estimate must not force a congestion-control minimum");
      for (const Json& data : std::vector<Json>{
          Json::object(), {{"startBitrateBps", 149999u}, {"maxBitrateBps", 20000000u}},
          {{"startBitrateBps", 5000000u}, {"maxBitrateBps", 4999999u}},
          {{"startBitrateBps", 5000000u}, {"maxBitrateBps", 80000001u}},
          {{"startBitrateBps", 5000000.5}, {"maxBitrateBps", 20000000u}}})
        Reject([&] { (void)rtc::peer_detail::StartupBitrate(data); }, MONKY_ENGINE_INVALID);
      Reject([] {
        (void)rtc::peer_detail::StartupBitrate({{"startBitrateBps", 5000000u},
          {"maxBitrateBps", 20000000u}, {"minBitrateBps", 5000000u}});
      }, MONKY_ENGINE_UNSUPPORTED);
    });
    group("peerVideoPlayout", [] {
      for (const auto delay : {0u, 200u, 1000u})
        Check(rtc::peer_detail::VideoPlayoutDelayMs({{"minimumDelayMs", delay}}) == delay,
              "Video playout delay must preserve its explicit millisecond value");
      for (const Json& data : std::vector<Json>{Json::object(), {{"minimumDelayMs", -1}},
          {{"minimumDelayMs", 1001u}}, {{"minimumDelayMs", 200.5}}, {{"minimumDelayMs", "200"}},
          {{"minimumDelayMs", true}}, {{"minimumDelayMs", nullptr}}})
        Reject([&] { (void)rtc::peer_detail::VideoPlayoutDelayMs(data); }, MONKY_ENGINE_INVALID);
      Reject([] {
        (void)rtc::peer_detail::VideoPlayoutDelayMs({{"minimumDelayMs", 200u}, {"actualDelayMeasured", true}});
      }, MONKY_ENGINE_UNSUPPORTED);
    });
    group("sfuVideoStartupBitrate", [] {
      for (const auto [maximum, start] : std::vector<std::pair<unsigned, unsigned>>{
          {80000000u, 5000u}, {20000000u, 5000u}, {1500000u, 1500u}, {64000u, 64u}}) {
        const auto encoding = rtc::peer_detail::Encoding(
            {{"maxBitrateBps", maximum}, {"maxFramerate", 120}}, false);
        const auto options = rtc::peer_detail::SfuVideoCodecOptions(encoding);
        Check(options == Json{{"videoGoogleStartBitrate", start},
                              {"videoGoogleMaxBitrate", maximum / 1000}},
              "SFU startup must follow its source ceiling without a forced minimum or the300kbps default");
      }
      Reject([] { (void)rtc::peer_detail::SfuVideoCodecOptions({}); }, MONKY_ENGINE_INVALID);
      for (const auto invalid : {-1, 0, 63999}) {
        webrtc::RtpEncodingParameters encoding;
        encoding.max_bitrate_bps = invalid;
        Reject([&] { (void)rtc::peer_detail::SfuVideoCodecOptions(encoding); }, MONKY_ENGINE_INVALID);
      }
    });
    group("inputLeases", [] { monky::native_rtc::node::RunInputLeaseChecks(Check); });
    group("nodeEventQueue", [] { monky::native_rtc::node::RunEventQueueChecks(Check); });
    group("audioFoundations", [] { rtc::audio::RunAudioFoundationChecks(Check); });
    group("audioOperationalPolicies", [] { rtc::audio::RunAudioOperationalChecks(Check); });
    group("encoderScheduling", [] { monky::native_rtc::mf::RunEncoderSchedulingChecks(Check); });
    group("encoderConfiguration", [] { monky::native_rtc::mf::RunEncoderConfigurationChecks(Check); });
    group("encoderDiagnostics", [] { monky::native_rtc::mf::RunEncoderDiagnosticChecks(Check); });
    group("encoderSubmitBranches", [] { monky::native_rtc::mf::RunEncoderSubmitBranchChecks(Check); });
    group("rtcSendDrops", [] { rtc::RunRtcSendDiagnosticChecks(Check); });
    group("encoderDiagnosticJson", [] { rtc::RunEncoderJsonChecks(Check); });
    group("decoderDiagnostics", [] { monky::native_rtc::mf::RunDecoderDiagnosticChecks(Check); });
    group("decoderScheduling", [] { monky::native_rtc::mf::RunDecoderSchedulingChecks(Check); });
    group("decoderSubmitBranches", [] { monky::native_rtc::mf::RunDecoderSubmitBranchChecks(Check); });
    group("decoderMapping", [] { monky::native_rtc::mf::RunDecoderMappingChecks(Check); });
    group("decoderDiagnosticJson", [] { rtc::RunDecoderJsonChecks(Check); });
    group("rtcReceiveDiagnostics", [] { rtc::RunRtcReceiveDiagnosticChecks(Check); });
    group("rtcReceiveSdk", [] { rtc::RunRtcReceiveSdkChecks(Check); });
    group("adapterPolicies", [] { monky::native_rtc::VerifyDeviceFreeAdapterPolicies(Check); });
    group("binaryLayout", [] {
      Check(MONKY_ENGINE_ABI_VERSION == 2 && MONKY_ENGINE_CONTRACT_REVISION == 8,
            "Binary ABI or JSON contract revision changed unexpectedly");
      Check(sizeof(MonkyEngineError) == 608 && offsetof(MonkyEngineError, code) == 16,
            "C error POD layout changed");
      Check(sizeof(MonkyEngineOptions) == 32, "C options POD layout changed");
      Check(sizeof(MonkyEngineEvent) == 48 && offsetof(MonkyEngineEvent, json) == 32,
            "C event POD layout changed");
      Check(sizeof(MonkyEngineCallbacks) == 24, "C callback POD layout changed");
      Check(sizeof(MonkyEngineInputFrame) == 48 && offsetof(MonkyEngineInputFrame, texture_nt_handle) == 16,
            "Input HANDLE POD layout changed");
      Check(sizeof(MonkyEngineFrameCom) == 72, "COM frame POD layout changed");
      Check(sizeof(MonkyEngineSharedFrame) == 64 &&
            offsetof(MonkyEngineSharedFrame, texture_nt_handle) == 8 &&
            offsetof(MonkyEngineSharedFrame, timestamp_us) == 40,
            "Shared NT HANDLE POD layout changed");
    });

    std::puts(Json{{"probe", "native-rtc-signaling-contract-device-free"}, {"checks", checks},
                   {"groups", std::move(groups)}, {"abiVersion", MONKY_ENGINE_ABI_VERSION},
                   {"contractRevision", MONKY_ENGINE_CONTRACT_REVISION},
                   {"operationalEngineCreated", false}, {"devicesOpened", false}}.dump().c_str());
    return 0;
  } catch (const std::exception& error) {
    std::fprintf(stderr, "Native signaling contract probe failed: %s\n", error.what());
    return 1;
  } catch (...) {
    std::fputs("Native signaling contract probe failed with an unknown error.\n", stderr);
    return 1;
  }
}
