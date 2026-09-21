#include "..\src\packet_core.h"
#include "..\src\win\wasapi_capture.h"
#include <ks.h>
#include <ksmedia.h>
#include <iostream>
#include <limits>
#include <future>
#include <thread>

using namespace screen_audio;

static int checks = 0;
static void Require(bool value, const char* message) {
  ++checks;
  if (!value) throw std::runtime_error(message);
}
template <typename Callback> static void Reject(Callback callback, const char* code) {
  ++checks;
  try { callback(); } catch (const Failure& failure) {
    if (failure.code == code) return;
    throw;
  }
  throw std::runtime_error("Expected explicit failure");
}
static Format Pcm(uint16_t bits, uint16_t channels = 2) {
  return {48000, channels, bits, bits, uint16_t(channels * bits / 8), 0,
          uint32_t(48000 * channels * bits / 8), false};
}
int main() {
  try {
    const uint8_t pcm16[] = {0, 128, 255, 127, 0, 0, 0, 64};
    auto output = Convert(Pcm(16), pcm16, sizeof(pcm16), 2, 0);
    Require(output.size() == 4 && output[0] == -1 && output[1] > 0.999f &&
            output[2] == 0 && output[3] == 0.5f, "PCM16 samples/channels changed");
    const uint8_t pcm24[] = {0, 0, 128, 255, 255, 127};
    output = Convert(Pcm(24), pcm24, sizeof(pcm24), 1, 0);
    Require(output[0] == -1 && output[1] > 0.999f, "PCM24 conversion failed");
    const uint8_t pcm32[] = {0, 0, 0, 128, 255, 255, 255, 127};
    output = Convert(Pcm(32), pcm32, sizeof(pcm32), 1, 0);
    Require(output[0] == -1 && output[1] > 0.999f, "PCM32 conversion failed");
    auto padded = Pcm(32); padded.validBits = 24;
    const uint8_t valid24[] = {0, 0, 0, 128, 0, 255, 255, 127};
    output = Convert(padded, valid24, sizeof(valid24), 1, 0);
    Require(output[0] == -1, "Left-aligned valid bits failed");
    Reject([&] { Convert(padded, pcm32, sizeof(pcm32), 1, 0); }, "ERR_AUDIO_PCM");
    auto floating = Pcm(32, 6); floating.floatingPoint = true; floating.channelMask = 0x3f;
    const float floats[] = {-1, -.5f, 0, .25f, .5f, 1.25f};
    output = Convert(floating, reinterpret_cast<const uint8_t*>(floats), sizeof(floats), 1, 0);
    Require(output.size() == 6 && output[5] == 1.25f && output[3] == .25f, "All float channels must survive");
    output = Convert(floating, nullptr, 0, 480, kSilent);
    Require(output.size() == 2880, "Silent frames were omitted");
    for (float sample : output) Require(sample == 0, "Silent PCM was not zero");
    auto invalid = floating; invalid.blockAlign = 1;
    Reject([&] { ValidateFormat(invalid); }, "ERR_AUDIO_FORMAT");
    invalid = floating; invalid.channelMask = 3;
    Reject([&] { ValidateFormat(invalid); }, "ERR_AUDIO_FORMAT");
    invalid = floating; invalid.validBits = 24;
    Reject([&] { ValidateFormat(invalid); }, "ERR_AUDIO_FORMAT");
    invalid = floating; invalid.sampleRate = UINT32_MAX;
    Reject([&] { ValidateFormat(invalid); }, "ERR_AUDIO_FORMAT");
    invalid = floating; invalid.averageBytesPerSecond++;
    Reject([&] { ValidateFormat(invalid); }, "ERR_AUDIO_FORMAT");
    invalid = floating; invalid.channels = 0;
    Reject([&] { ValidateFormat(invalid); }, "ERR_AUDIO_FORMAT");
    Reject([&] { PacketBytes(floating, UINT64_MAX); }, "ERR_AUDIO_PACKET_SIZE");
    Reject([&] { PacketBytes(floating, 0); }, "ERR_AUDIO_PACKET_SIZE");
    Reject([&] { Convert(Pcm(16), pcm16, sizeof(pcm16) - 1, 2, 0); }, "ERR_AUDIO_PACKET_SIZE");
    Reject([&] { Convert(Pcm(16), nullptr, sizeof(pcm16), 2, 0); }, "ERR_AUDIO_PACKET_SIZE");
    Reject([&] { Convert(Pcm(16), nullptr, 1, 2, kSilent); }, "ERR_AUDIO_PACKET_SIZE");
    Reject([&] { Convert(Pcm(16), pcm16, sizeof(pcm16), 2, 8); }, "ERR_AUDIO_FLAGS");
    auto floatMono = Pcm(32, 1); floatMono.floatingPoint = true;
    float nan = std::numeric_limits<float>::quiet_NaN();
    Reject([&] { Convert(floatMono, reinterpret_cast<uint8_t*>(&nan), 4, 1, 0); }, "ERR_AUDIO_PCM");

    WAVEFORMATEXTENSIBLE wave{};
    wave.Format.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
    wave.Format.cbSize = sizeof(wave) - sizeof(WAVEFORMATEX);
    wave.Format.nSamplesPerSec = 44100;
    wave.Format.nChannels = 6;
    wave.Format.wBitsPerSample = 32;
    wave.Format.nBlockAlign = 24;
    wave.Format.nAvgBytesPerSec = 44100 * 24;
    wave.Samples.wValidBitsPerSample = 32;
    wave.dwChannelMask = 0x3f;
    wave.SubFormat = KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
    auto parsed = ParseWasapiFormat(&wave.Format, sizeof(wave));
    Require(parsed.channels == 6 && parsed.sampleRate == 44100 && parsed.channelMask == 0x3f,
            "WASAPI original format was lost");
    Reject([&] { ParseWasapiFormat(&wave.Format, sizeof(WAVEFORMATEX)); }, "ERR_AUDIO_FORMAT");
    wave.Format.cbSize = 1;
    Reject([&] { ParseWasapiFormat(&wave.Format, sizeof(wave)); }, "ERR_AUDIO_FORMAT");
    wave.Format.cbSize = sizeof(wave) - sizeof(WAVEFORMATEX);
    wave.SubFormat = GUID{};
    Reject([&] { ParseWasapiFormat(&wave.Format, sizeof(wave)); }, "ERR_AUDIO_FORMAT");
    wave.Format.wFormatTag = WAVE_FORMAT_PCM;
    Reject([&] { ParseWasapiFormat(&wave.Format, sizeof(wave)); }, "ERR_AUDIO_FORMAT");
    Reject([&] { ParseWasapiFormat(nullptr, 0); }, "ERR_AUDIO_FORMAT");

    Timeline timeline;
    auto first = timeline.Next(441, 0, 100, 123456789, 44100);
    auto next = timeline.Next(441, kSilent, 541, 123556789, 44100);
    Require(first.sequence == 0 && first.frameIndex == 0 && first.qpcTimestampUs == 12345678,
            "QPC100ns was not converted to floored microseconds");
    Require(next.sequence == 1 && next.frameIndex == 441 && next.epoch == first.epoch,
            "Contiguous silent packet broke the timeline");
    auto reset = timeline.Next(10, 0, 0, 123556790, 44100);
    Require(reset.epoch == 1 && reset.frameIndex == 882, "Position reset did not create epoch");
    auto gap = timeline.Next(10, kDiscontinuity, 10, 123556791, 44100);
    Require(gap.epoch == 2 && gap.flags == kDiscontinuity, "Discontinuity flag lost");
    auto badTime = timeline.Next(10, kTimestampError, UINT64_MAX, UINT64_MAX, 44100);
    Require(badTime.epoch == 3 && !badTime.devicePosition && !badTime.qpcTimestampUs,
            "Invalid timestamp was trusted");
    auto recover = timeline.Next(10, 0, 30, 123556792, 44100);
    Require(recover.epoch == 4 && recover.qpcTimestampUs, "Clock recovery must begin an epoch");
    auto backward = timeline.Next(10, 0, 40, 1, 44100);
    Require(backward.epoch == 5, "QPC regression must begin an epoch");
    Reject([&] { timeline.Next(10, 0, UINT64_MAX, 1, 44100); }, "ERR_AUDIO_TIMING");
    Reject([&] { timeline.Next(10, 0, 0, UINT64_MAX, 44100); }, "ERR_AUDIO_TIMING");
    Reject([&] { timeline.Next(10, 8, 0, 0, 44100); }, "ERR_AUDIO_TIMING");
    Reject([&] { timeline.Next(0, 0, 0, 0, 44100); }, "ERR_AUDIO_TIMING");
    Reject([&] { timeline.Next(10, 0, std::nullopt, 0, 0); }, "ERR_AUDIO_TIMING");
    {
      Timeline process;
      constexpr uint64_t originUs = 66576858724;
      for (uint64_t i = 0; i < 1311; ++i) {
        const auto packet = process.Next(480, 0, std::nullopt, (originUs + i * 10000) * 10, 48000);
        Require(packet.sequence == i && packet.frameIndex == i * 480 && packet.epoch == 0 &&
                !packet.devicePosition && packet.qpcTimestampUs == originUs + i * 10000 &&
                packet.flags == 0,
                "QPC-only process capture fabricated a device position/flag or restarted each packet");
      }
      const auto silent = process.Next(480, kSilent, std::nullopt, (originUs + 13110000) * 10, 48000);
      Require(silent.epoch == 0 && silent.flags == kSilent && silent.frameIndex == 1311 * 480 &&
              !silent.devicePosition && silent.qpcTimestampUs == originUs + 13110000,
              "Actual QPC-only SILENT frames changed the capture epoch or anchors");
      Reject([&] { process.Next(480, 0, std::nullopt, UINT64_MAX, 48000); }, "ERR_AUDIO_TIMING");
    }
    {
      Timeline changes;
      const auto unavailable = changes.Next(480, 0, std::nullopt, 10000000, 48000);
      const auto available = changes.Next(480, 0, 0, 10100000, 48000);
      const auto contiguous = changes.Next(480, 0, 480, 10200000, 48000);
      const auto repeated = changes.Next(480, 0, 480, 10300000, 48000);
      const auto lost = changes.Next(480, 0, std::nullopt, 10400000, 48000);
      Require(unavailable.epoch == 0 && available.epoch == 1 && available.devicePosition == 0 &&
              contiguous.epoch == 1 && repeated.epoch == 2 && repeated.devicePosition == 480 &&
              lost.epoch == 3 && !lost.devicePosition && lost.qpcTimestampUs == 1040000,
              "Counter availability transitions or genuine repeated device positions were hidden");
      const auto forward = changes.Next(480, 0, std::nullopt, 10650000, 48000);
      const auto overlap = changes.Next(480, 0, std::nullopt, 10700000, 48000);
      const auto regression = changes.Next(480, 0, std::nullopt, 10699999, 48000);
      const auto flagged = changes.Next(480, kDiscontinuity, std::nullopt, 10799999, 48000);
      Require(forward.epoch == 4 && overlap.epoch == 5 && regression.epoch == 6 &&
              flagged.epoch == 7 && forward.flags == 0 && overlap.flags == 0 &&
              regression.flags == 0 && flagged.flags == kDiscontinuity,
              "QPC gaps/overlaps/regressions or raw discontinuity flags were retimed or fabricated");
      const auto invalid = changes.Next(480, kTimestampError, std::nullopt, UINT64_MAX, 48000);
      const auto valid = changes.Next(480, 0, std::nullopt, 11000000, 48000);
      Require(invalid.epoch == 8 && !invalid.qpcTimestampUs && !invalid.devicePosition &&
              valid.epoch == 9 && valid.qpcTimestampUs == 1100000 && !valid.devicePosition,
              "QPC validity transitions depend incorrectly on a requested device counter");
    }
    for (const uint32_t rate : {44100u, 48000u, 96000u}) {
      Timeline fragments;
      uint64_t frame = 0;
      for (uint32_t i = 0; i < 100; ++i) {
        const uint32_t frames = 37 + i;
        const auto packet = fragments.Next(frames, 0, std::nullopt,
            123456789 + frame * 10000000 / rate, rate);
        Require(packet.epoch == 0 && packet.frameIndex == frame && !packet.devicePosition,
                "Fractional-microsecond sample timing caused false QPC-only discontinuities");
        frame += frames;
      }
    }
    {
      CaptureLease legacy(CaptureOwner::legacy);
      Require(legacy.held(), "Cannot acquire legacy lease");
      CaptureLease conflict(CaptureOwner::packet);
      Require(!conflict.held(), "Packet interrupted legacy ownership");
    }
    {
      CaptureLease packet(CaptureOwner::packet);
      Require(packet.held(), "Legacy cleanup retained the lease");
      CaptureLease conflict(CaptureOwner::legacy);
      Require(!conflict.held(), "Legacy interrupted packet ownership");
      packet.Release(); packet.Release();
    }
    Require(captureOwner.load() == CaptureOwner::none, "Idempotent lease cleanup failed");
    const std::vector<std::pair<uint32_t, uint32_t>> parents{{10, 1}, {11, 10}, {12, 11}, {20, 1}, {1, 0}};
    ValidateIncludedProcess(20, 10, parents);
    Reject([&] { ValidateIncludedProcess(10, 10, parents); }, "ERR_AUDIO_TARGET");
    Reject([&] { ValidateIncludedProcess(12, 10, parents); }, "ERR_AUDIO_TARGET");
    Reject([&] { ValidateIncludedProcess(1, 10, parents); }, "ERR_AUDIO_TARGET");
    Reject([&] { ValidateIncludedProcess(999, 10, parents); }, "ERR_AUDIO_TARGET");
    Reject([&] { IsInProcessTree(1, 10, {{1, 2}, {2, 1}}); }, "ERR_AUDIO_TARGET");
    PacketBudget budget;
    for (size_t i = 0; i < kMaxQueuedPackets; ++i) Require(budget.Acquire(), "Queue capacity too small");
    Require(!budget.Acquire(), "Unbounded packet queue");
    budget.Release();
    Require(budget.Acquire(), "Released packet slot was leaked");
    for (size_t i = 0; i < kMaxQueuedPackets; ++i) budget.Release();
    Require(budget.queued() == 0, "Queue drain leaked slots");
    {
      std::atomic<bool> stop{false};
      for (size_t i = 0; i < kMaxQueuedPackets; ++i) budget.Acquire();
      auto waiting = std::async(std::launch::async, [&] { return budget.WaitForSlot(stop); });
      Require(waiting.wait_for(std::chrono::milliseconds(10)) == std::future_status::timeout,
          "A full packet budget did not apply backpressure");
      budget.Release();
      Require(waiting.get() && budget.queued() == kMaxQueuedPackets,
          "Returning admission credit did not resume the producer");
      auto cancelling = std::async(std::launch::async, [&] { return budget.WaitForSlot(stop); });
      stop.store(true);
      budget.Wake();
      Require(!cancelling.get() && budget.queued() == kMaxQueuedPackets,
          "Stop acquired or leaked an admission slot");
      stop.store(false);
      Require(!budget.WaitForSlot(stop) && budget.queued() == kMaxQueuedPackets,
          "Sustained overload must time out without raising the bounded capacity");
      for (size_t i = 0; i < kMaxQueuedPackets; ++i) budget.Release();
      Require(budget.queued() == 0, "Backpressure cleanup leaked slots");
    }
    std::cout << "{\"checks\":" << checks << ",\"hardwareUsed\":false}\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
