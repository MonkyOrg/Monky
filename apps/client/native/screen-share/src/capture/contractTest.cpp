#include <Windows.h>
#include "liveNative.h"
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

static std::vector<std::uint8_t> ParameterSets(const VideoConfiguration& video) {
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
  number(77, 8); number(0, 8); number(51, 8);
  ue(0); ue(0); ue(0); ue(0); ue(1); number(0, 1);
  const auto columns = (video.width + 15) / 16, rows = (video.height + 15) / 16;
  ue(columns - 1); ue(rows - 1); number(1, 1); number(1, 1); number(1, 1);
  ue(0); ue((columns * 16 - video.width) / 2); ue(0); ue((rows * 16 - video.height) / 2);
  number(0, 1); number(1, 1);
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
    check(ParseFeedback("2 idr 0").keyframe);
    for (const auto bad : {"0 bitrate 1000", "01 bitrate 1000", "1 bitrate 49", "1 bitrate 125",
                          "1 bitrate 20050", "1 idr 1", "1 unknown 0", "1 bitrate 1000 extra"})
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
    check(sizeof(PacketStatistics) < 256);
    for (const auto video : {VideoConfiguration{1920, 1080, 120, 5000}, {1920, 1080, 60, 5000},
                            {1280, 720, 60, 3000}, {852, 480, 30, 1500}}) {
      ValidateVideoConfiguration(video);
      const auto prefix = ParameterSets(video);
      PacketStatistics statistics(video);
      statistics.SetPrefix(prefix);
      const std::array<std::uint8_t, 5> idr{0, 0, 1, 0x65, 0xb8};
      const std::array<std::uint8_t, 5> delta{0, 0, 1, 0x41, 0xb8};
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
      }
    }
    for (const auto invalidVideo : {VideoConfiguration{1919, 1080, 120, 5000}, {1920, 1081, 120, 5000},
                                   {854, 480, 30, 1000}, {2, 2, 1, 50},
                                   {1920, 1080, 121, 5000}, {1920, 1080, 0, 5000}, {1920, 1080, 120, 5010}})
      rejects([&] { ValidateVideoConfiguration(invalidVideo); });
    check(RetirementJson({true, true, false, true, false}).find("\"sourceReleased\":false") != std::string::npos);
    OutputBudget budget;
    for (unsigned index = 0; index < 2048; ++index) budget.Add(1024);
    check(budget.Bytes() == 2097152);
    rejects([&] { budget.Add(kMaxOutputLine + 1); });
    std::cout << "{\"checks\":" << checks << ",\"deviceFree\":true,\"headerBytes\":96}\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
