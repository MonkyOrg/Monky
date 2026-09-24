#include <Windows.h>
#include "liveNative.h"
#include "platformContract.h"
#include <iostream>

using namespace monky::screen_capture;
using namespace monky::screen_capture::live;

static bool HandledFaultProbe() noexcept {
  __try {
    const ULONG_PTR arguments[]{0, 0x123};
    RaiseException(EXCEPTION_ACCESS_VIOLATION, 0, 2, arguments);
  } __except (GetExceptionCode() == EXCEPTION_ACCESS_VIOLATION ? EXCEPTION_EXECUTE_HANDLER : EXCEPTION_CONTINUE_SEARCH) {
    return true;
  }
  return false;
}

struct TestSpsOptions {
  bool vui = false, videoSignal = true, colourDescription = true, richVui = false;
  std::uint8_t fullRange = 0, primaries = 0, transfer = 1, matrix = 1;
  std::uint32_t id = 0, order = 0;
};

static std::vector<std::uint8_t> ParameterSets(const VideoConfiguration& video, TestSpsOptions options = {}) {
  std::vector<bool> bits;
  const auto number = [&](std::uint32_t value, unsigned count) {
    for (unsigned index = count; index > 0; --index) bits.push_back((value >> (index - 1)) & 1u);
  };
  const auto ue = [&](std::uint32_t value) {
    ++value;
    unsigned width = 0;
    for (auto copy = value; copy; copy >>= 1) ++width;
    number(0, width - 1); number(value, width);
  };
  number(77, 8); number(0, 8); number((std::max)(51u, RequiredCaptureH264Level(video)), 8);
  ue(options.id); ue(0); ue(options.order);
  if (options.order == 0) ue(0);
  else if (options.order == 1) { number(0, 1); ue(0); ue(1); ue(2); ue(0); ue(1); }
  ue(1); number(0, 1);
  const auto columns = (video.width + 15) / 16, rows = (video.height + 15) / 16;
  ue(columns - 1); ue(rows - 1); number(1, 1); number(1, 1); number(1, 1);
  ue(0); ue((columns * 16 - video.width) / 2); ue(0); ue((rows * 16 - video.height) / 2);
  number(options.vui, 1);
  if (options.vui) {
    number(options.richVui, 1);
    if (options.richVui) { number(255, 8); number(1, 16); number(1, 16); }
    number(options.richVui, 1);
    if (options.richVui) number(1, 1);
    number(options.videoSignal, 1);
    if (options.videoSignal) {
      number(5, 3); number(options.fullRange, 1); number(options.colourDescription, 1);
      if (options.colourDescription) {
        number(options.primaries, 8); number(options.transfer, 8); number(options.matrix, 8);
      }
    }
    number(options.richVui, 1);
    if (options.richVui) { ue(0); ue(0); }
    number(options.richVui, 1);
    if (options.richVui) { number(1, 32); number(60, 32); number(1, 1); }
    for (unsigned hrd = 0; hrd < 2; ++hrd) {
      number(options.richVui, 1);
      if (options.richVui) {
        ue(1); number(0, 4); number(0, 4);
        for (unsigned cpb = 0; cpb < 2; ++cpb) { ue(cpb); ue(cpb); number(1, 1); }
        number(23, 5); number(23, 5); number(23, 5); number(24, 5);
      }
    }
    if (options.richVui) number(0, 1);
    number(0, 1); number(options.richVui, 1);
    if (options.richVui) { number(1, 1); ue(2); ue(1); ue(16); ue(16); ue(0); ue(1); }
  }
  number(1, 1);
  while (bits.size() % 8) bits.push_back(false);
  std::vector<std::uint8_t> result{0, 0, 1, 0x67};
  unsigned zeros = 0;
  for (std::size_t index = 0; index < bits.size(); index += 8) {
    std::uint8_t byte = 0;
    for (unsigned bit = 0; bit < 8; ++bit) byte = static_cast<std::uint8_t>((byte << 1) | bits[index + bit]);
    if (zeros >= 2 && byte <= 3) { result.push_back(3); zeros = 0; }
    result.push_back(byte); zeros = byte == 0 ? zeros + 1 : 0;
  }
  const std::array<std::uint8_t, 5> pps{0, 0, 1, 0x68, 0xc0};
  result.insert(result.end(), pps.begin(), pps.end());
  return result;
}

int main(int argc, char** argv) {
  try {
    if (argc == 2 && std::string_view(argv[1]) == "--admission-probe") {
      std::cout << "{\"deviceFree\":true,\"synthetic\":true,\"messages\":[";
      for (unsigned variant = 0; variant < 4; ++variant) {
        Arguments arguments;
        arguments.runId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        arguments.kind = variant == 3 ? CaptureKind::Monitor : variant == 2 ? CaptureKind::Game : CaptureKind::Window;
        arguments.hwnd = variant == 3 ? 0 : 19;
        arguments.processId = variant == 3 ? 0 : 10;
        arguments.expectedCreation = variant == 0 || variant == 3 ? 0 : 123456789;
        arguments.video.scaleMode = variant % 2 ? ScaleMode::Fit : ScaleMode::Stretch;
        arguments.monitor = {L"\\\\?\\DISPLAY#TEST#{1234}", L"\\\\.\\DISPLAY2", -1920, 0, 1920, 1080};
        Common common{arguments.runId, 42, arguments.processId, arguments.hwnd, arguments.expectedCreation, 1000, 10000000};
        Observation observation;
        observation.state = ObservationState::Failed;
        const Retirement retired{true, true, true, true, true};
        const NativeFailure failure{"ERR_SCREEN_CAPTURE_SOURCE_LOST", "Synthetic source disappeared before admission"};
        if (variant) std::cout << ',';
        std::cout << SerializeAdmissionFailure(arguments, common, 0, observation, retired, failure);
      }
      std::cout << "]}\n";
      return 0;
    }
    if (argc == 2 && std::string_view(argv[1]) == "--encoder-probe-contract") {
      std::cout << "{\"deviceFree\":true,\"synthetic\":true,\"messages\":[";
      bool first = true;
      for (const auto encoder : {EncoderKind::Amf, EncoderKind::Nvenc}) {
        Arguments arguments;
        arguments.encoderProbe = true; arguments.encoder = encoder;
        arguments.runId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        arguments.video = {1280, 720, 60, 5000, encoder == EncoderKind::Nvenc ? ScaleMode::Fit : ScaleMode::Stretch};
        Common common{arguments.runId, 42, 0, 0, 0, 1000, 10000000};
        EncoderCapability capability{encoder, 0, encoder == EncoderKind::Nvenc ? 0x10deu : 0x1002u, 123, 456, true};
        const Retirement retired{true, true, true, true, true};
        const NativeFailure failure{"ERR_SCREEN_CAPTURE_ENCODER_INITIALIZATION", "Synthetic encoder refusal"};
        if (!first) std::cout << ',';
        first = false;
        std::cout << SerializeEncoderProbeEvent(arguments, common, capability, "prepared", 0, true, true) << ',';
        ++common.qpc;
        std::cout << SerializeEncoderProbeEvent(arguments, common, capability, "stopped", 1, true, true, &retired) << ',';
        capability.verified = false;
        std::cout << SerializeEncoderProbeEvent(arguments, common, capability, "error", 0, false, false, &retired, &failure) << ','
                  << SerializeEncoderProbeEvent(arguments, common, capability, "stopped", 1, false, false, &retired);
      }
      std::cout << "]}\n";
      return 0;
    }
    if (argc == 2 && std::string_view(argv[1]) == "--platform-probe") {
      std::cout << "{\"deviceFree\":true,\"synthetic\":true,\"messages\":[";
      bool first = true;
      for (const auto scaleMode : {ScaleMode::Stretch, ScaleMode::Fit})
      for (const auto kind : {CaptureKind::Window, CaptureKind::Monitor, CaptureKind::Game}) {
        for (const auto encoder : {EncoderKind::Amf, EncoderKind::Nvenc}) {
          Arguments arguments;
          arguments.kind = kind; arguments.encoder = encoder;
          arguments.method = kind == CaptureKind::Game ? Method::GameHook : Method::Wgc;
          arguments.video = {1280, 720, 60, 5000, scaleMode};
          arguments.monitor = {L"\\\\?\\DISPLAY#TEST#{1234}", L"\\\\.\\DISPLAY2", -1920, 0, 1920, 1080};
          Common common{"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 42, kind == CaptureKind::Monitor ? 0u : 10u,
              kind == CaptureKind::Monitor ? 0u : 19u, kind == CaptureKind::Monitor ? 0u : 123456789u, 1000, 10000000};
          const EncoderCapability capability{encoder, 0, encoder == EncoderKind::Nvenc ? 0x10deu : 0x1002u, 123, 456, true};
          const SourceKey key{"Owned fixture", "MonkyCaptureFixture", "fixture.exe"};
          Observation observation;
          std::optional<SourceKey> hooked;
          const Retirement retired{true, true, true, true, true};
          for (unsigned step = 0; step < 4; ++step) {
            if (step == 1) {
              common.qpc = 1002;
              observation.state = ObservationState::Running; observation.sourceAttached = true;
              observation.sourceWidth = kind == CaptureKind::Monitor ? 1920 : 800;
              observation.sourceHeight = kind == CaptureKind::Monitor ? 1080 : 600;
              observation.outputPackets = 1; observation.outputBytes = 512; observation.keyframes = 1;
              observation.firstPts = 0; observation.lastPts = 0; observation.lastDts = 0;
              observation.timebaseNumerator = 1; observation.timebaseDenominator = 60;
              observation.firstPacketQpc = 1001; observation.obsTotalFrames = 1;
              if (kind != CaptureKind::Monitor) hooked = key;
            } else if (step >= 2) {
              common.qpc = 1002 + step;
              observation.sourceAttached = false;
              if (step == 3) observation.state = ObservationState::Stopped;
            }
            const auto type = step == 0 ? "prepared" : step == 1 ? "ready" : step == 2 ? "stats" : "stopped";
            if (!first) std::cout << ',';
            first = false;
            std::cout << SerializePlatformEvent(arguments, common, capability, type, step, observation,
                key, hooked, step == 3 ? &retired : nullptr);
          }
        }
        }
      std::cout << "]}\n";
      return 0;
    }
    if (argc == 2 && std::string_view(argv[1]) == "--fault-probe") {
      FaultDiagnostics diagnostics;
      Require(HandledFaultProbe(), "The diagnostic observer swallowed a synthetic exception");
      Require(FaultDiagnostics::Observations() == 1, "The synthetic exception was not observed exactly once");
      diagnostics.Close();
      Require(HandledFaultProbe() && FaultDiagnostics::Observations() == 1,
          "The diagnostic observer was not removed");
      std::cout << "{\"deviceFree\":true,\"handledByProbe\":true,\"observations\":1,\"observerRemoved\":true}\n";
      return 0;
    }
    if (argc == 2 && std::string_view(argv[1]) == "--pipe-probe") {
      Output output("00000000000000000000000000000018",
          [](const char* code, const char* message) { std::cerr << code << ": " << message << '\n'; });
      output.Notice("{\"kind\":\"device-free-pipe-probe\"}");
      for (unsigned i = 0; i < 500; ++i) {
        const auto commands = output.Poll();
        if (!commands.empty()) {
          Require(commands.size() == 1 && commands[0].bitrateKbps == 1000, "Unexpected pipe probe feedback");
          output.Notice("{\"kind\":\"feedback-received\",\"bitrateKbps\":1000}");
          std::array<std::uint8_t, 32768> bytes{};
          abi::EncoderPacket packet{};
          packet.data = bytes.data(); packet.size = bytes.size(); packet.type = abi::EncoderType::Video;
          packet.timebase_num = 1; packet.timebase_den = 120;
          for (std::int64_t frame = 0; frame < 80; ++frame) {
            packet.pts = frame; packet.dts = frame - 1; packet.keyframe = frame == 0;
            packet.sys_dts_usec = 1000000000 + frame * 1000000 / 120;
            LARGE_INTEGER qpc{};
            Require(QueryPerformanceCounter(&qpc) && qpc.QuadPart > 0, "Pipe probe QPC failed");
            output.Packet(packet, static_cast<std::uint64_t>(qpc.QuadPart));
          }
          output.Stop();
          std::cout << "{\"deviceFree\":true,\"pipeProbe\":true,\"syntheticPackets\":80}\n";
          return 0;
        }
        Sleep(5);
      }
      throw std::runtime_error("Device-free pipe probe timed out");
    }
    Require(argc == 1, "Unexpected contract probe arguments");
    unsigned checks = 0;
    const auto check = [&](bool condition) { Require(condition, "Live CPU contract failed"); ++checks; };
    const auto rejects = [&](auto work) {
      bool failed = false;
      try { work(); } catch (const ContractError&) { failed = true; }
      check(failed);
    };
    check(sizeof(Header) == 96 && offsetof(Header, pts) == 56);
    check(ParseFeedback("1 bitrate 20000").bitrateKbps == 20000);
    check(ParseFeedback("1 bitrate 80000").bitrateKbps == 80000);
    ValidateEncoderBitrateRange(80000, 50, 80000, 50);
    rejects([&] { ValidateEncoderBitrateRange(80050, 50, 100000, 50); });
    check(ParseFeedback("2 idr 0").keyframe);
    for (const auto bad : {"0 bitrate 1000", "01 bitrate 1000", "1 bitrate 49", "1 bitrate 125",
                          "1 bitrate 80050", "1 idr 1", "1 unknown 0", "1 bitrate 1000 extra"})
      rejects([&] { ParseFeedback(bad); });
    CheckBudget(15, kQueueBytes - 1, 1, 1000, 1500); check(true);
    rejects([&] { CheckBudget(16, 0, 1, 1000, 1000); });
    rejects([&] { CheckBudget(0, kQueueBytes, 1, 1000, 1000); });
    rejects([&] { CheckBudget(1, 0, 1, 1000, 1501); });
    rejects([&] { CheckBudget(1, 0, 1, 1000, 999); });
    PacketClock clock;
    abi::EncoderPacket packet{};
    packet.pts = 0; packet.dts = -1; packet.timebase_num = 1; packet.timebase_den = 120;
    packet.sys_dts_usec = 1234000000; packet.keyframe = true;
    check(clock.Observe(packet) == 1234000000);
    packet.pts = 1; packet.dts = 0; packet.sys_dts_usec += 8333; packet.keyframe = false;
    check(clock.Observe(packet) == 1234008333);
    check(packet.pts == 1 && packet.dts == 0);
    rejects([&] { clock.Observe(packet); });
    PacketClock invalid; packet.pts = 2;
    rejects([&] { invalid.Observe(packet); });
    rejects([&] { ScaleTime(INT64_MAX, 1, 120); });
    check(ScaleTime(120 * 60 * 60 * 8, 1, 120) == 28800000000LL);
    check(ScaleTime(18000, 1, 30) == 600000000);
    check(ScaleTime(-1, 1, 60) == -16666);
    rejects([&] { ScaleTime(1, 0, 120); });
    rejects([&] { ScaleTime(1, 1, 0); });
    rejects([&] { ScaleTime(1, 1, 121); });
    check(ParseFeedback("100000 bitrate 5000").sequence == 100000);
    check(ParseCommand("100000 stats").sequence == 100000);
    check(ExpiredDeadline(Phase::Running, 28800000, 0, 100, 0) == Deadline::None);
    check(ExpiredDeadline(Phase::Starting, 10100, 0, 100, 0) == Deadline::FirstAu);
    check(ExpiredDeadline(Phase::Stopping, 10100, 0, 0, 100) == Deadline::Retirement);
    Lifecycle startup;
    startup.Prepared();
    startup.Accept({1, Verb::Start}, 100);
    startup.ObserveStartupAvailability(200, false);
    startup.ObserveStartupAvailability(300, true);
    startup.ObserveStartupAvailability(30300, true);
    check(ExpiredDeadline(startup.phase, 30300, 0, startup.captureStartedMs, 0) == Deadline::None);
    startup.ObserveStartupAvailability(30400, false);
    check(ExpiredDeadline(startup.phase, 30400, 0, startup.captureStartedMs, 0) == Deadline::None);
    startup.ObserveStartupAvailability(40400, false);
    check(ExpiredDeadline(startup.phase, 40400, 0, startup.captureStartedMs, 0) == Deadline::FirstAu);
    rejects([&] { startup.ObserveStartupAvailability(1, true); });
    check(static_cast<int>(abi::Bounds::Stretch) == 1);
    check(static_cast<int>(abi::Bounds::ScaleInner) == 2);
    check(ScaleModeName(VideoConfiguration{}.scaleMode) == std::string_view("stretch"));
    const VideoConfiguration fitVideo{1280, 720, 60, 5000, ScaleMode::Fit};
    ValidateVideoConfiguration(fitVideo);
    check(ConfigurationJson(Method::Wgc, fitVideo).find("\"scaleMode\":\"fit\"") != std::string::npos);
    auto invalidScale = fitVideo; invalidScale.scaleMode = static_cast<ScaleMode>(-1);
    rejects([&] { ValidateVideoConfiguration(invalidScale); });
    const std::string cacheDigest(64, 'b');
    const std::wstring runDirectory = L"C:\\qa\\monky-screen-capture-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const std::wstring cacheDirectory = L"C:\\qa\\hooks-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    check(CaptureDataCacheDirectory(runDirectory, cacheDigest) == cacheDirectory);
    for (const auto& badDigest : {std::string{}, std::string(63, 'b'), std::string(64, 'G'), std::string(64, '/')})
      rejects([&] { CaptureDataCacheName(badDigest); });
    rejects([&] { CaptureDataCacheDirectory(L"relative\\run", cacheDigest); });
    const std::string binary = "C:\\runtime\\obs-plugins\\64bit\\win-capture.dll";
    const std::string config = "C:\\qa\\monky-screen-capture-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\config";
    const std::string cachedData = "C:\\qa\\hooks-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\\data\\obs-plugins\\win-capture";
    const auto cachedModule = ExpectedModuleIdentity("win-capture", binary, cachedData, config, cacheDigest);
    check(cachedModule.dataPath == ObsApiPath(cachedData) &&
          cachedModule.configPath == ObsApiPath(config) + "/win-capture/");
    rejects([&] { ExpectedModuleIdentity("win-capture", binary, cachedData, config); });
    rejects([&] { ExpectedModuleIdentity("win-capture", binary, cachedData, config, std::string(64, 'c')); });
    rejects([&] { ExpectedModuleIdentity("win-capture", binary, "D:" + cachedData.substr(2), config, cacheDigest); });
    rejects([&] { ExpectedModuleIdentity("obs-ffmpeg", "C:\\runtime\\obs-plugins\\64bit\\obs-ffmpeg.dll",
        "C:\\qa\\hooks-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\\data\\obs-plugins\\obs-ffmpeg", config, cacheDigest); });
    check(sizeof(PacketStatistics) < 256);
    check(std::string(EncoderExtraOptions(EncoderKind::Amf)) == "InColorPrimaries=1");
    check(std::string(EncoderExtraOptions(EncoderKind::Nvenc)).empty());
    check(EncoderProfileOptions(EncoderKind::Amf, {3840, 2160, 120, 20000}) == "InColorPrimaries=1 ProfileLevel=60");
    check(EncoderProfileOptions(EncoderKind::Amf, {3840, 2160, 60, 20000}) == "InColorPrimaries=1 ProfileLevel=52");
    check(EncoderProfileOptions(EncoderKind::Amf, {1920, 1080, 120, 5000}) == "InColorPrimaries=1 ProfileLevel=51");
    check(EncoderProfileOptions(EncoderKind::Amf, {852, 480, 30, 1500}) == "InColorPrimaries=1 ProfileLevel=31");
    check(EncoderProfileOptions(EncoderKind::Nvenc, {3840, 2160, 120, 20000}).empty());
    check(RequiredCaptureH264Level({3840, 2160, 120, 20000}) == 60);
    check(RequiredCaptureH264Level({3840, 2160, 60, 20000}) == 52);
    check(RequiredCaptureH264Level({1920, 1080, 120, 20000}) == 51);
    check(RequiredCaptureH264Level({1920, 1080, 120, 80000}) == 51);
    check(RequiredCaptureH264Level({3840, 2160, 60, 80000}) == 52);
    check(RequiredCaptureH264Level({3840, 2160, 120, 80000}) == 60);
    ValidateAmfLevelCapability(52, {3840, 2160, 60, 80000});
    ValidateAmfLevelCapability(60, {3840, 2160, 120, 80000});
    ValidateAmfLevelCapability(51, {1920, 1080, 120, 80000});
    for (const auto invalidMaximum : {-1, 0, 9, 63})
      rejects([&] { ValidateAmfLevelCapability(invalidMaximum, {3840, 2160, 60, 80000}); });
    try {
      ValidateAmfLevelCapability(52, {3840, 2160, 120, 80000});
      check(false);
    } catch (const ContractError& error) {
      check(error.code == "ERR_SCREEN_CAPTURE_AMF_LEVEL_UNSUPPORTED" &&
          std::string(error.what()).find("level_idc=60") != std::string::npos &&
          std::string(error.what()).find("MaxLevel=52") != std::string::npos);
    }
    for (const auto video : {VideoConfiguration{3840, 2160, 120, 80000}, {3840, 2160, 60, 80000},
                            {1920, 1080, 120, 5000}, {1920, 1080, 60, 5000},
                            {1280, 720, 60, 3000}, {852, 480, 30, 1500}}) {
      ValidateVideoConfiguration(video);
      const auto prefix = ParameterSets(video);
      const auto normalize = [&](std::span<const std::uint8_t> bytes) {
        return NormalizeAmfBt709(bytes, video, EncoderKind::Amf, true);
      };
      check(normalize(prefix).bytes.empty());
      for (const bool richVui : {false, true})
      for (std::uint32_t order = 0; order <= 2; ++order)
      for (std::uint32_t id = 0; id <= 31; ++id) {
        TestSpsOptions options;
        options.vui = true; options.richVui = richVui; options.id = id; options.order = order;
        const auto broken = ParameterSets(video, options);
        options.primaries = 1;
        const auto expected = ParameterSets(video, options);
        const auto normalized = normalize(broken);
        check(normalized.parameterSets == 1 && normalized.bytes == expected);
        check(normalize(normalized.bytes).bytes.empty());
        for (const auto encoder : {EncoderKind::Auto, EncoderKind::Nvenc})
          check(NormalizeAmfBt709(broken, video, encoder, true).bytes.empty());
        check(NormalizeAmfBt709(broken, video, EncoderKind::Amf, false).bytes.empty());
      }
      TestSpsOptions colour;
      colour.vui = true;
      const auto broken = ParameterSets(video, colour);
      const abi::VideoInfo admittedVideo{nullptr, video.fps, 1, video.width, video.height, video.width, video.height,
          abi::VideoFormat::Nv12, 0, true, abi::ColorSpace::Bt709, abi::Range::Partial, abi::Scale::Bicubic};
      check(ExactVideoConfiguration(admittedVideo, video));
      for (unsigned variant = 0; variant < 5; ++variant) {
        auto unverified = admittedVideo;
        if (variant == 0) unverified.output_format = static_cast<abi::VideoFormat>(0);
        if (variant == 1) unverified.colorspace = static_cast<abi::ColorSpace>(0);
        if (variant == 2) unverified.range = static_cast<abi::Range>(2);
        if (variant == 3) unverified.gpu_conversion = false;
        if (variant == 4) unverified.adapter = 1;
        check(!ExactVideoConfiguration(unverified, video));
        check(NormalizeAmfBt709(broken, video, EncoderKind::Amf,
            ExactVideoConfiguration(unverified, video)).bytes.empty());
      }
      colour.primaries = 1;
      const auto corrected = ParameterSets(video, colour);
      for (const auto primaries : {1, 2, 5, 6, 9, 255}) {
        colour.primaries = static_cast<std::uint8_t>(primaries);
        check(normalize(ParameterSets(video, colour)).bytes.empty());
      }
      colour.primaries = 0;
      colour.fullRange = 1;
      check(normalize(ParameterSets(video, colour)).bytes.empty());
      colour.fullRange = 0;
      for (const auto other : {0, 2, 6, 16, 18, 255}) {
        colour.transfer = static_cast<std::uint8_t>(other);
        check(normalize(ParameterSets(video, colour)).bytes.empty());
        colour.transfer = 1; colour.matrix = static_cast<std::uint8_t>(other);
        check(normalize(ParameterSets(video, colour)).bytes.empty());
        colour.matrix = 1;
      }
      colour.videoSignal = false;
      check(normalize(ParameterSets(video, colour)).bytes.empty());
      colour.videoSignal = true; colour.colourDescription = false;
      check(normalize(ParameterSets(video, colour)).bytes.empty());

      std::size_t spsEnd = 0;
      VisitAnnexB(broken, [&](std::span<const std::uint8_t> nal, std::size_t, std::size_t end) {
        if ((nal.front() & 0x1fu) == 7) spsEnd = end;
      });
      for (std::size_t length = 1; length < spsEnd; ++length)
        rejects([&] { normalize(std::span(broken).first(length)); });
      auto badSuffix = std::vector<std::uint8_t>(broken.begin(), broken.begin() + spsEnd);
      badSuffix.push_back(0xff);
      rejects([&] { normalize(badSuffix); });
      for (const auto malformed : {std::vector<std::uint8_t>{0, 0, 1, 0x67, 0, 0, 3},
                                {0, 0, 1, 0x67, 0, 0, 3, 4}, {0, 0, 1, 0x67, 0, 0, 2, 0x80},
                                {0, 0, 1, 0xe7, 0x80}, {0, 0, 0, 2, 0x67, 0x80}, {0, 0, 1}})
        rejects([&] { normalize(malformed); });
      rejects([&] { normalize({}); });
      rejects([&] { NormalizeAmfBt709(broken, {640, 480, 30, 1500}, EncoderKind::Amf, true); });
      auto wrongProfile = broken;
      wrongProfile[4] = 66;
      rejects([&] { normalize(wrongProfile); });
      auto wrongLevel = broken;
      wrongLevel[6] = 61;
      rejects([&] { normalize(wrongLevel); });
      if (video.width == 3840 && video.fps == 120) {
        wrongLevel[6] = 52;
        rejects([&] { InspectAnnexB(wrongLevel, video); });
        rejects([&] { normalize(wrongLevel); });
      }
      auto reservedConstraints = broken;
      reservedConstraints[5] = 1;
      rejects([&] { normalize(reservedConstraints); });

      PacketStatistics statistics(video);
      statistics.SetPrefix(prefix);
      const std::array<std::uint8_t, 5> idr{0, 0, 1, 0x65, 0xb8};
      const std::array<std::uint8_t, 5> delta{0, 0, 1, 0x41, 0xb8};
      const auto complete = CompleteH264Keyframe(idr, prefix, video);
      // Both encoder extra_data and repeated in-band SPS are rewritten before fan-out.
      auto inBand = broken;
      const std::array<std::uint8_t, 9> sei{0, 0, 0, 1, 6, 5, 1, 0x42, 0x80};
      inBand.insert(inBand.end(), sei.begin(), sei.end());
      inBand.insert(inBand.end(), idr.begin(), idr.end());
      inBand.insert(inBand.begin(), 0); // Exercise four-byte start code and trailing_zero_8bits.
      inBand.push_back(0);
      auto expectedInBand = corrected;
      expectedInBand.insert(expectedInBand.end(), sei.begin(), sei.end());
      expectedInBand.insert(expectedInBand.end(), idr.begin(), idr.end());
      expectedInBand.insert(expectedInBand.begin(), 0);
      expectedInBand.push_back(0);
      const auto normalizedInBand = normalize(inBand);
      check(normalizedInBand.bytes == expectedInBand && normalizedInBand.parameterSets == 1);
      const std::array<std::uint8_t, 14> secondSlice{0, 0, 0, 1, 0x65, 0x4e, 0, 0, 3, 0, 0, 3, 1, 0x80};
      auto multiSlice = inBand;
      multiSlice.insert(multiSlice.end(), secondSlice.begin(), secondSlice.end());
      auto expectedMultiSlice = expectedInBand;
      expectedMultiSlice.insert(expectedMultiSlice.end(), secondSlice.begin(), secondSlice.end());
      check(normalize(multiSlice).bytes == expectedMultiSlice && InspectAnnexB(expectedMultiSlice, video).idr);
      auto mixedSps = corrected;
      mixedSps.insert(mixedSps.end(), broken.begin(), broken.end());
      auto expectedMixedSps = corrected;
      expectedMixedSps.insert(expectedMixedSps.end(), corrected.begin(), corrected.end());
      check(normalize(mixedSps).bytes == expectedMixedSps && normalize(mixedSps).parameterSets == 1);
      const auto normalizedExtra = normalize(broken);
      const auto delivered = CompleteH264Keyframe(normalizedInBand.bytes, normalizedExtra.bytes, video);
      check(delivered == CompleteH264Keyframe(expectedInBand, corrected, video));
      check(normalize(delivered).bytes.empty());
      const auto twiceBroken = CompleteH264Keyframe(inBand, broken, video);
      check(normalize(twiceBroken).bytes == delivered && normalize(twiceBroken).parameterSets == 2);
      check(normalize(idr).bytes.empty() && normalize(delta).bytes.empty());
      auto inBandDelta = broken;
      inBandDelta.insert(inBandDelta.end(), delta.begin(), delta.end());
      auto expectedDelta = corrected;
      expectedDelta.insert(expectedDelta.end(), delta.begin(), delta.end());
      check(normalize(inBandDelta).bytes == expectedDelta);
      PacketStatistics colourStatistics(video);
      colourStatistics.SetPrefix(normalizedExtra.bytes);
      colourStatistics.Add({delivered, 0, -1, 1, video.fps, true, 1000});
      colourStatistics.Add({normalize(inBandDelta).bytes, 1, 0, 1, video.fps, false, 1001});
      check(colourStatistics.First()->pts == 0 && colourStatistics.First()->dts == -1 &&
          colourStatistics.Last()->pts == 1 && colourStatistics.Last()->dts == 0 &&
          colourStatistics.Last()->timebaseDenominator == video.fps &&
          colourStatistics.Last()->observedAtQpc == 1001);
      auto tooLarge = broken;
      tooLarge.resize(kMaxPacketBytes + 1, 0x80);
      rejects([&] { normalize(tooLarge); });
      auto atLimit = inBand;
      atLimit.resize(kMaxPacketBytes, 0x80);
      check(normalize(atLimit).bytes.size() == kMaxPacketBytes);
      rejects([&] { CompleteH264Keyframe(normalize(atLimit).bytes, corrected, video); });
      auto excessiveNals = broken;
      for (unsigned i = 0; i < 4094; ++i) excessiveNals.insert(excessiveNals.end(), sei.begin(), sei.end());
      check(normalize(excessiveNals).parameterSets == 1);
      excessiveNals.insert(excessiveNals.end(), sei.begin(), sei.end());
      rejects([&] { normalize(excessiveNals); });
      const auto independent = InspectAnnexB(complete, video);
      check(independent.sps && independent.pps && independent.idr && independent.accessUnit);
      check(complete.size() == prefix.size() + idr.size() &&
          std::equal(prefix.begin(), prefix.end(), complete.begin()) &&
          std::equal(idr.begin(), idr.end(), complete.begin() + prefix.size()));
      check(CompleteH264Keyframe(idr, prefix, video) == complete);
      PacketStatistics delayed(video);
      check(delayed.Count() == 0 && !delayed.First());
      rejects([&] { delayed.Add({idr, 0, -1, 1, video.fps, true, 1000}); });
      rejects([&] { delayed.SetPrefix({}); });
      rejects([&] { CompleteH264Keyframe(idr, {}, video); });
      // Model NVENC: headers become available with the first actual IDR, not at initialization.
      delayed.SetPrefix(prefix);
      delayed.Add({complete, 0, -1, 1, video.fps, true, 1000});
      check(delayed.Count() == 1 && delayed.Keyframes() == 1 && delayed.OutputBytes() == complete.size());
      delayed.Add({delta, 1, 0, 1, video.fps, false, 1001});
      const auto nextIdr = CompleteH264Keyframe(idr, prefix, video);
      delayed.Add({nextIdr, 2, 1, 1, video.fps, true, 1002});
      check(delayed.Count() == 3 && delayed.Keyframes() == 2);
      rejects([&] { delayed.SetPrefix(prefix); });
      PacketStatistics startsWithDelta(video);
      startsWithDelta.SetPrefix(prefix);
      rejects([&] { startsWithDelta.Add({delta, 0, -1, 1, video.fps, false, 1000}); });
      check(startsWithDelta.Count() == 0);
      rejects([&] { CompleteH264Keyframe(delta, prefix, video); });
      rejects([&] { CompleteH264Keyframe(idr, idr, video); });
      rejects([&] { CompleteH264Keyframe(idr, complete, video); });
      auto oversized = std::vector<std::uint8_t>(idr.begin(), idr.end());
      oversized.resize(kMaxPacketBytes, 0x80);
      rejects([&] { CompleteH264Keyframe(oversized, prefix, video); });
      statistics.Add({idr, 0, -1, 1, video.fps, true, 1000});
      for (std::int64_t frame = 1; frame < 100000; ++frame)
        statistics.Add({delta, frame, frame - 1, 1, video.fps, false, 1000 + static_cast<std::uint64_t>(frame)});
      Observation observation;
      ObservePackets(observation, statistics);
      check(observation.outputPackets == 100000 && observation.outputBytes == 500000 &&
          observation.bufferedBytes == 0 && observation.firstPts == 0 && observation.lastPts == 99999);
      check(ConfigurationJson(Method::Wgc, video).find("\"scaleMode\":\"stretch\"") != std::string::npos);
      rejects([&] { statistics.SetPrefix(prefix); });
      rejects([&] { statistics.Add({delta, 1, 0, 1, video.fps, false, 1}); });
      if (video.width != 1920) {
        PacketStatistics wrongDimensions({1920, 1080, video.fps, 5000});
        rejects([&] { wrongDimensions.SetPrefix(prefix); });
        rejects([&] { CompleteH264Keyframe(idr, prefix, {1920, 1080, video.fps, 5000}); });
      }
    }
    for (const auto invalidVideo : {VideoConfiguration{3844, 2160, 120, 20000}, {3840, 2162, 120, 20000},
                                   {3840, 2160, 121, 20000}, {3840, 2160, 120, 80050},
                                   {1919, 1080, 120, 5000}, {1920, 1081, 120, 5000},
                                   {854, 480, 30, 1000}, {2, 2, 1, 50},
                                   {1920, 1080, 121, 5000}, {1920, 1080, 0, 5000}, {1920, 1080, 120, 5010}})
      rejects([&] { ValidateVideoConfiguration(invalidVideo); });
    check(RetirementJson({true, true, false, true, false}).find("\"sourceReleased\":false") != std::string::npos);
    OutputBudget budget;
    for (unsigned index = 0; index < 2048; ++index) budget.Add(1024);
    check(budget.Bytes() == 2097152);
    rejects([&] { budget.Add(kMaxOutputLine + 1); });
    const std::vector<std::wstring_view> windowArguments{
      L"--runtime=C:\\obs", L"--run-directory=C:\\qa\\monky-screen-capture-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      L"--run-id=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", L"--hwnd=19", L"--pid=10",
      L"--width=1920", L"--height=1080", L"--fps=60", L"--bitrate=5000"};
    check(ParseArguments(windowArguments).encoder == EncoderKind::Auto);
    const auto checkScaleArguments = [&](const std::vector<std::wstring_view>& options) {
      check(ParseArguments(options).video.scaleMode == ScaleMode::Stretch);
      for (const auto mode : {L"--scale-mode=stretch", L"--scale-mode=fit"}) {
        auto selected = options; selected.push_back(mode);
        check(ParseArguments(selected).video.scaleMode ==
            (std::wstring_view(mode).ends_with(L"=fit") ? ScaleMode::Fit : ScaleMode::Stretch));
        selected.push_back(mode);
        rejects([&] { ParseArguments(selected); });
      }
      for (const auto mode : {L"--scale-mode=crop", L"--scale-mode=", L"--scale-mode=Fit"}) {
        auto badOptions = options; badOptions.push_back(mode);
        rejects([&] { ParseArguments(badOptions); });
      }
    };
    checkScaleArguments(windowArguments);
    const std::vector<std::wstring_view> probeArguments{
      windowArguments[0], windowArguments[1], windowArguments[2], L"--probe=encoder", L"--encoder=auto",
      L"--width=1920", L"--height=1080", L"--fps=60", L"--bitrate=5000"};
    const auto probe = ParseArguments(probeArguments);
    checkScaleArguments(probeArguments);
    check(probe.encoderProbe && probe.hwnd == 0 && probe.processId == 0 && probe.expectedCreation == 0 &&
          probe.monitor.deviceId.empty() && probe.encoder == EncoderKind::Auto);
    ValidateCommandMode(probe, {1, Verb::Stop}); check(true);
    rejects([&] { ValidateCommandMode(probe, {1, Verb::Start}); });
    rejects([&] { ValidateCommandMode(probe, {1, Verb::Stats}); });
    for (const auto sourceOption : {L"--hwnd=19", L"--pid=10", L"--kind=window", L"--kind=monitor", L"--kind=game",
         L"--process-created=123", L"--monitor-id=\\\\?\\DISPLAY#TEST#{1234}", L"--monitor-name=\\\\.\\DISPLAY2",
         L"--monitor-x=0", L"--monitor-y=0", L"--monitor-width=1920", L"--monitor-height=1080"}) {
      auto mixed = probeArguments; mixed.push_back(sourceOption);
      rejects([&] { ParseArguments(mixed); });
    }
    auto invalidProbe = probeArguments;
    invalidProbe[3] = L"--probe=window"; rejects([&] { ParseArguments(invalidProbe); });
    invalidProbe = probeArguments; invalidProbe.push_back(L"--probe=encoder");
    rejects([&] { ParseArguments(invalidProbe); });
    ValidateEncoderProbeIsolation(false, false, false, false, false, false, 0); check(true);
    for (unsigned present = 0; present < 7; ++present)
      rejects([&] { ValidateEncoderProbeIsolation(present == 0, present == 1, present == 2, present == 3,
        present == 4, present == 5, present == 6 ? 1 : 0); });
    auto gameArguments = windowArguments;
    gameArguments.insert(gameArguments.end(), {L"--kind=game", L"--process-created=123456789",
      L"--encoder=obs_nvenc_h264_tex"});
    const auto game = ParseArguments(gameArguments);
    checkScaleArguments(gameArguments);
    check(game.kind == CaptureKind::Game && game.method == Method::GameHook &&
        game.encoder == EncoderKind::Nvenc && game.expectedCreation == 123456789);
    gameArguments.back() = L"--encoder=x264";
    rejects([&] { ParseArguments(gameArguments); });
    gameArguments.pop_back();
    rejects([&] { ParseArguments(gameArguments); });
    std::vector<std::wstring_view> monitorArguments{
      windowArguments[0], windowArguments[1], windowArguments[2],
      L"--kind=monitor", L"--monitor-id=\\\\?\\DISPLAY#TEST#{1234}", L"--monitor-name=\\\\.\\DISPLAY2",
      L"--monitor-x=-1920", L"--monitor-y=0", L"--monitor-width=1920", L"--monitor-height=1080",
      L"--encoder=auto", L"--width=1920", L"--height=1080", L"--fps=60", L"--bitrate=5000"};
    const auto monitor = ParseArguments(monitorArguments);
    checkScaleArguments(monitorArguments);
    check(monitor.kind == CaptureKind::Monitor && monitor.monitor.x == -1920 && monitor.hwnd == 0);
    monitorArguments[6] = L"--monitor-x=-0";
    rejects([&] { ParseArguments(monitorArguments); });
    monitorArguments[6] = L"--hwnd=123";
    rejects([&] { ParseArguments(monitorArguments); });
    monitorArguments[6] = L"--monitor-x=-1920";
    monitorArguments[4] = L"--monitor-id=0";
    rejects([&] { ParseArguments(monitorArguments); });
    ValidateNvencProbeEvidence(true, true, true, true, true, 1920, 1080, {1920, 1080, 120, 5000}); check(true);
    for (unsigned missing = 0; missing < 7; ++missing)
      rejects([&] { ValidateNvencProbeEvidence(missing != 0, missing != 1, missing != 2, missing != 3,
        missing != 4, missing == 5 ? 1280 : 1920, missing == 6 ? 720 : 1080, {1920, 1080, 120, 5000}); });
    rejects([&] { ValidateEncoderAdmission(true, true, true, true, false, false, EncoderKind::Nvenc, false); });
    ValidateEncoderAdmission(true, true, true, true, false, false, EncoderKind::Nvenc, true); check(true);
    check(ConfigurationJson(Method::GameHook, game.video, EncoderKind::Nvenc).find("\"rateControl\":\"CBR\"") != std::string::npos);
    check(ConfigurationJson(Method::Wgc, game.video).find("\"rateControl\":\"VBR_LAT\"") != std::string::npos);
    EncoderCapability capability{EncoderKind::Nvenc, 0, 0x10de, 123, 456, true};
    check(CapabilityJson(capability).find("nvenc-d3d11-session") != std::string::npos);
    capability.vendorId = 0x1002;
    rejects([&] { CapabilityJson(capability); });
    capability.vendorId = 0x10de;
    Common monitorCommon{"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 42, 0, 0, 0, 1000, 10000000};
    Observation prepared;
    const auto preparedMonitor = SerializePlatformEvent(monitor, monitorCommon, capability, "prepared", 0, prepared, {}, {});
    check(preparedMonitor.find("\"schemaVersion\":2") != std::string::npos &&
          preparedMonitor.find("\"sourceKey\":null") != std::string::npos &&
          preparedMonitor.find("\"kind\":\"monitor\"") != std::string::npos);
    const auto preparedProbe = SerializeEncoderProbeEvent(probe, monitorCommon, capability, "prepared", 0, true, true);
    check(preparedProbe.find("\"encoderInitialized\":true") != std::string::npos &&
          preparedProbe.find("\"sourceCaptured\":false") != std::string::npos &&
          preparedProbe.find("\"target\"") == std::string::npos && preparedProbe.find("\"hwnd\"") == std::string::npos);
    rejects([&] { SerializeEncoderProbeEvent(probe, monitorCommon, capability, "prepared", 0, true, false); });
    rejects([&] { SerializeEncoderProbeEvent(probe, monitorCommon, capability, "prepared", 0, false, true); });
    rejects([&] { SerializeEncoderProbeEvent(probe, monitorCommon, capability, "ready", 1, true, true); });
    rejects([&] { TargetJson(probe, monitorCommon); });
    rejects([&] { SerializePlatformEvent(probe, monitorCommon, capability, "prepared", 0, prepared, {}, {}); });
    auto selectedProbe = probe; selectedProbe.hwnd = 19;
    rejects([&] { SerializeEncoderProbeEvent(selectedProbe, monitorCommon, capability, "prepared", 0, true, true); });
    Retirement probeRetired{true, true, true, true, true};
    check(SerializeEncoderProbeEvent(probe, monitorCommon, capability, "stopped", 1, true, true, &probeRetired)
        .find("\"obsShutdownReturned\":true") != std::string::npos);
    probeRetired.encoderReleased = false;
    rejects([&] { SerializeEncoderProbeEvent(probe, monitorCommon, capability, "stopped", 1, true, true, &probeRetired); });
    check(StockProbePath(L"C:\\qa\\monky-screen-capture.exe", L"obs-nvenc-test.exe") == L"C:\\qa\\obs-nvenc-test.exe");
    rejects([&] { StockProbePath(L"C:\\qa\\monky-screen-capture.exe", L"arbitrary.exe"); });
    Arguments rejectedTarget;
    rejectedTarget.runId = monitorCommon.runId; rejectedTarget.hwnd = 19; rejectedTarget.processId = 10;
    Common rejectedCommon{rejectedTarget.runId, 42, 10, 19, 0, 1000, 10000000};
    Observation rejectedObservation; rejectedObservation.state = ObservationState::Failed;
    const Retirement admissionRetired{true, true, true, true, true};
    const NativeFailure admissionFailure{"ERR_SCREEN_CAPTURE_SOURCE_LOST", "Synthetic source is unavailable"};
    const auto admission = [&] {
      return SerializeAdmissionFailure(rejectedTarget, rejectedCommon, 0, rejectedObservation, admissionRetired, admissionFailure);
    };
    check(admission().find("\"kind\":\"capture-admission-error\"") != std::string::npos);
    check(admission().find("\"target\":{\"hwnd\":19,\"expectedProcessId\":10}") != std::string::npos);
    ++rejectedCommon.processId; rejects(admission); --rejectedCommon.processId;
    rejectedObservation.outputPackets = 1; rejects(admission); rejectedObservation.outputPackets = 0;
    rejectedTarget.encoderProbe = true; rejects(admission);
    std::cout << "{\"checks\":" << checks << ",\"deviceFree\":true,\"headerBytes\":96}\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
