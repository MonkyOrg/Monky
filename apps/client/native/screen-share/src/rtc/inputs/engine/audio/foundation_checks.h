#pragma once

#include "capture_timestamp.h"
#include "credit_audio_device.h"
#include "pcm_track_source.h"
#include "playout_delay.h"
#include "output_clock.h"
#include "output_epoch.h"
#include "monky_rtc_audio.h"
#include "runtime.h"
#include "api\make_ref_counted.h"
#include "common_audio\include\audio_util.h"

#include <algorithm>
#include <cmath>
#include <limits>
#include <functional>
#include <future>
#include <condition_variable>

namespace monky::native_rtc::engine::audio {
namespace checks_detail {

inline CaptureFormat Stereo(std::uint32_t rate = kRate) {
  return {rate, 2, 3, 32, 32};
}

inline CapturePacketView Packet(const CaptureEpoch& epoch, std::span<const float> data,
                               std::uint64_t sequence, std::uint64_t frame_index) {
  return {epoch.session_id, epoch.epoch, epoch.format, data,
      static_cast<std::uint32_t>(data.size() / epoch.format.channels), sequence, frame_index,
      frame_index, 1000000 + std::int64_t(frame_index * 1000000 / epoch.format.sample_rate), {}};
}

class MissingTimestamp final : public CaptureTimestampMapper {
 public:
  std::optional<RtcCaptureTimestamp> Map(
      const CaptureEpoch&, const CaptureBlockTiming&) override { return std::nullopt; }
};

class Blocks final : public CaptureBlockObserver {
 public:
  void OnBlock(const NormalizedBlock& block, std::optional<RtcCaptureTimestamp> timestamp,
               bool enabled) noexcept override {
    ++count;
    spans += block.timing.spans.size();
    saw_timestamp = saw_timestamp || timestamp.has_value();
    saw_enabled = saw_enabled || enabled;
  }
  unsigned count = 0;
  std::size_t spans = 0;
  bool saw_timestamp = false, saw_enabled = false;
};

class TrackSink final : public webrtc::AudioTrackSinkInterface {
 public:
  void OnData(const void*, int bits, int rate, std::size_t channels, std::size_t frames,
              std::optional<std::int64_t> timestamp) override {
    if (bits != 16 || rate != kRate || channels != kChannels || frames != kBlockFrames || timestamp)
      throw std::runtime_error("Unexpected per-track PCM format/timestamp");
    ++blocks;
  }
  unsigned blocks = 0;
};

class Mixer final : public webrtc::AudioTransport {
 public:
  int32_t RecordedDataIsAvailable(const void*, std::size_t, std::size_t, std::size_t,
      uint32_t, uint32_t, int32_t, uint32_t, bool, uint32_t&) override {
    ++recording_calls;
    return -1;
  }
  int32_t NeedMorePlayData(std::size_t frames, std::size_t bytes_per_frame, std::size_t channels,
      uint32_t rate, void* data, std::size_t& samples_out,
      int64_t* elapsed_ms, int64_t* ntp_ms) override {
    if (frames != kBlockFrames || bytes_per_frame != 4 || channels != kChannels || rate != kRate)
      return -1;
    if (before_mix) before_mix();
    auto* samples = static_cast<std::int16_t*>(data);
    for (std::size_t i = 0; i < frames * channels; ++i) samples[i] = i % 2 ? -16384 : 16384;
    samples_out = short_block ? frames : frames * channels;
    *elapsed_ms = 10 * calls;
    *ntp_ms = -1;
    ++calls;
    return 0;
  }
  void PullRenderData(int, int, std::size_t, std::size_t, void*, int64_t*, int64_t*) override {
    throw std::runtime_error("Unexpected alternative mixer route");
  }
  unsigned calls = 0, recording_calls = 0;
  bool short_block = false;
  std::function<void()> before_mix;
};

class Output final : public PlayoutOutput {
 public:
  void OnPlayoutStarted(std::uint64_t epoch) noexcept override {
    started_epoch = epoch;
    ++starts;
    try { if (on_start) on_start(); } catch (...) { hook_failed = true; }
  }
  bool OnPcm(const PlayoutPacket& packet) noexcept override {
    if (!accept) return false;
    try { packets.push_back(packet); return true; }
    catch (...) { return false; }
  }
  void OnFailure(std::uint64_t epoch, Failure value) noexcept override {
    failure = value;
    failure_epoch = epoch;
    try { if (before_failure) before_failure(epoch); } catch (...) { hook_failed = true; }
  }
  void OnInvalidated(std::uint64_t epoch, StopReason reason) noexcept override {
    try { invalidated.emplace_back(epoch, reason); } catch (...) { hook_failed = true; }
  }
  bool accept = true;
  std::vector<PlayoutPacket> packets;
  std::optional<Failure> failure;
  std::uint64_t failure_epoch = 0;
  std::vector<std::pair<std::uint64_t, StopReason>> invalidated;
  std::function<void(std::uint64_t)> before_failure;
  bool hook_failed = false;
  std::uint64_t started_epoch = 0;
  unsigned starts = 0;
  std::function<void()> on_start;
};

class Feedback final : public PhysicalPlayoutClock {
 public:
  std::optional<CalibratedPlayoutFeedback> Read(std::uint64_t) const override { return value; }
  std::optional<CalibratedPlayoutFeedback> value;
};

}  // namespace checks_detail

// Explicitly CPU-only fixtures in the inert native contract probe.
// No Engine/PeerConnectionFactory, platform ADM, devices, real QPC sampler or
// application service is created. The concrete ADM uses only this fake mixer.
template <typename Check>
void RunAudioFoundationChecks(Check&& check) {
  using namespace checks_detail;
  const auto rejects = [&](auto&& action, Failure expected) {
    try { action(); }
    catch (const AudioError& error) {
      check(error.failure == expected, "Audio rejection lost its typed failure");
      return;
    }
    throw std::runtime_error("Invalid audio foundation input was accepted");
  };
  for (auto rate : {44100u, 48000u, 96000u}) {
    for (const auto& format : {Stereo(rate), CaptureFormat{rate, 6, 0x3f, 32, 32},
                              CaptureFormat{rate, 6, 0x60f, 32, 32},
                              CaptureFormat{rate, 8, 1599, 32, 32}}) {
      const auto frames = rate / 10;
      std::vector<float> input(frames * format.channels);
      for (std::size_t frame = 0; frame < frames; ++frame) {
        const auto sample = float(std::sin(double(frame) * .071) * .5);
        input[format.channels * frame] = sample;
        input[format.channels * frame + 1] = -sample;
      }
      const CaptureEpoch epoch{"session", "session:1", format, 17, 12345};
      const auto normalize = [&](bool split, bool with_device_position) {
        PcmNormalizer normalizer;
        normalizer.BeginEpoch(epoch);
        std::vector<std::int16_t> result;
        std::vector<CapturePacketView> packets;
        std::uint32_t offset = 0;
        std::uint64_t sequence = epoch.first_sequence, blocks = 0;
        while (offset < frames) {
          const auto count = split ? (std::min)(frames - offset, 37u + std::uint32_t(sequence % 101))
                                   : frames;
          auto packet = Packet(epoch, std::span<const float>(input).subspan(
              offset * format.channels, count * format.channels),
              sequence++, epoch.first_frame_index + offset);
          packet.device_position = with_device_position ? std::optional<std::uint64_t>(654321 + offset)
                                                       : std::nullopt;
          packet.qpc_timestamp_us = 9000000 + std::int64_t(std::uint64_t(offset) * 1000000 / rate);
          if (!offset) packet.flags = {1, false, true, false};
          packets.push_back(packet);
          normalizer.Push(packet, [&](const NormalizedBlock& block) {
            check(block.session_id == epoch.session_id && block.epoch == epoch.epoch &&
                  block.sequence == blocks++ &&
                  block.sequence * kBlockFrames == block.first_normalized_frame,
                  "Normalized identity/cursor does not count actual produced 10ms blocks");
            check(block.timing.input_rate == rate && block.timing.input_frames == rate / 100 &&
                  block.timing.filter_delay_input_frames == (rate == kRate ? 0u : 16u) &&
                  !block.timing.spans.empty(), "Mix/SRC changed original input timing or filter delay");
            std::uint32_t covered = 0;
            for (const auto& span : block.timing.spans) {
              const auto& original = packets.at(span.packet_sequence - epoch.first_sequence);
              check(span.packet_frame_index == original.frame_index &&
                    span.device_position == original.device_position &&
                    span.qpc_timestamp_us == original.qpc_timestamp_us &&
                    span.flags.raw == original.flags.raw &&
                    span.flags.silent == original.flags.silent &&
                    span.flags.data_discontinuity == original.flags.data_discontinuity &&
                    span.flags.timestamp_error == original.flags.timestamp_error,
                    "Downmix/SRC rewrote original packet/device/QPC/flag provenance");
              check(span.frames > 0 && span.offset_frames + span.frames <= original.frames &&
                    span.packet_frame_index + span.offset_frames ==
                        epoch.first_frame_index + block.sequence * (rate / 100) + covered,
                    "Downmix/SRC inserted, skipped or retimed captured input frames");
              covered += span.frames;
            }
            check(covered == rate / 100, "Normalized block lost its exact original 10ms coverage");
            if (rate == kRate) {
              const auto timestamp = CaptureTimestampQpc(epoch, block.timing);
              check(timestamp && std::abs(*timestamp - (9000000 + std::int64_t(block.sequence) * 10000)) <= 1,
                    "Valid original QPC mapping incorrectly depended on an available device counter");
            }
            bool anti_phase = true, nonzero = false, unchanged_stereo = true;
            for (std::size_t frame = 0; frame < kBlockFrames; ++frame) {
              const auto left = block.samples[2 * frame], right = block.samples[2 * frame + 1];
              anti_phase = anti_phase && int(left) == -int(right);
              nonzero = nonzero || left != 0;
              if (rate == kRate && format.channels == 2) {
                const auto index = 2 * (block.first_normalized_frame + frame);
                unchanged_stereo = unchanged_stereo &&
                    left == webrtc::FloatToS16(input[index]) &&
                    right == webrtc::FloatToS16(input[index + 1]);
              }
            }
            check(anti_phase && nonzero && unchanged_stereo,
                  "Normalizer collapsed anti-phase L/R or changed legacy stereo levels");
            result.insert(result.end(), block.samples.begin(), block.samples.end());
          });
          offset += count;
        }
        check(normalizer.Epoch().format == format && normalizer.Snapshot().blocks == 10 &&
              normalizer.Snapshot().packets == packets.size() &&
              normalizer.Snapshot().pending_input_frames == 0,
              "Downmix changed the capture format or packet-dependent output shape");
        return result;
      };
      check(normalize(false, true) == normalize(true, true) &&
            normalize(false, false) == normalize(true, false),
            "Mix/SRC state or sample assembly restarted at original packet boundaries");
    }
  }
  const auto format_json = [](const CaptureFormat& format) {
    return Json{{"encoding", "float32-interleaved"}, {"sampleRate", format.sample_rate},
        {"channels", format.channels},
        {"channelMask", format.channel_mask ? Json(*format.channel_mask) : Json(nullptr)},
        {"sourceBitsPerSample", format.source_bits_per_sample},
        {"sourceValidBitsPerSample", format.source_valid_bits_per_sample}};
  };
  for (const auto& format : {CaptureFormat{kRate, 6, 0x3f, 32, 32},
                            CaptureFormat{kRate, 6, 0x60f, 32, 32},
                            CaptureFormat{kRate, 8, 1599, 32, 32}}) {
    check(ParseFormat(format_json(format)) == format,
          "JSON admission rejected or disguised a supported original Windows surround format");
    const CaptureEpoch epoch{"surround", "surround:1", format, 0, 0};
    constexpr double half_power = double(0.707106781186547524401f);
    const auto headroom = 1 / (1 + (format.channels == 8 ? 4 : 3) * half_power);
    for (std::size_t channel = 0; channel < format.channels; ++channel) {
      PcmNormalizer normalizer;
      normalizer.BeginEpoch(epoch);
      std::vector<float> data(kBlockFrames * format.channels);
      for (std::size_t frame = 0; frame < kBlockFrames; ++frame)
        data[frame * format.channels + channel] = frame % 2 ? -.5f : .5f;
      // Windows order: FL, FR, FC, LFE, then back/side L/R pairs.
      const bool both = channel == 2 || channel == 3;
      const auto left = channel == 0 ? 1.0 :
          (both || (channel >= 4 && channel % 2 == 0) ? half_power : 0);
      const auto right = channel == 1 ? 1.0 :
          (both || (channel >= 4 && channel % 2 == 1) ? half_power : 0);
      normalizer.Push(Packet(epoch, data, 0, 0), [&](const NormalizedBlock& block) {
        bool matches = true;
        for (std::size_t frame = 0; frame < kBlockFrames; ++frame) {
          const auto value = frame % 2 ? -.5 : .5;
          matches = matches &&
              std::abs(int(block.samples[2 * frame]) -
                       webrtc::FloatToS16(float(value * left * headroom))) <= 1 &&
              std::abs(int(block.samples[2 * frame + 1]) -
                       webrtc::FloatToS16(float(value * right * headroom))) <= 1;
        }
        check(matches && block.clipped_samples == 0,
              "Isolated Windows speaker lost its side, center/LFE contribution, polarity or fixed level");
      });
      std::fill(data.begin(), data.end(), 0.f);
      auto silent = Packet(epoch, data, 1, kBlockFrames);
      silent.flags = {2, true, false, false};
      normalizer.Push(silent, [&](const NormalizedBlock& block) {
        check(block.timing.spans.front().flags.raw == 2 &&
              std::all_of(block.samples.begin(), block.samples.end(), [](auto sample) { return sample == 0; }),
              "Downmix added latency/tails or lost actual SILENT provenance");
      });
      check(normalizer.Snapshot().blocks == 2 && normalizer.Snapshot().pending_input_frames == 0,
            "One original surround frame no longer maps to one normalized frame at 48k");
    }
    {
      PcmNormalizer normalizer;
      normalizer.BeginEpoch(epoch);
      std::uint64_t sequence = 0;
      for (const auto value : {1.f, -1.f, 2.f, -2.f}) {
        const std::vector<float> data(kBlockFrames * format.channels, value);
        normalizer.Push(Packet(epoch, data, sequence, sequence * kBlockFrames),
                       [&](const NormalizedBlock& block) {
          check(std::all_of(block.samples.begin(), block.samples.end(),
                           [&](auto sample) { return sample == (value > 0 ? 32767 : -32768); }) &&
                block.clipped_samples == (std::abs(value) > 1 ? kBlockFrames * kChannels : 0),
                "Correlated surround lost fixed headroom or over-range clipping accounting");
        });
        ++sequence;
      }
      check(normalizer.Snapshot().clipped_samples == 2 * kBlockFrames * kChannels,
            "Surround clipping counters did not count actual saturated output samples");
    }
    {
      PcmNormalizer normalizer;
      normalizer.BeginEpoch(epoch);
      std::vector<float> partial((kBlockFrames - 1) * format.channels, .25f);
      normalizer.Push(Packet(epoch, partial, 0, 0), [](const NormalizedBlock&) {
        throw std::runtime_error("Partial surround input emitted padded PCM");
      });
      const CaptureEpoch next{"surround", "surround:2", Stereo(), 1, kBlockFrames - 1};
      normalizer.BeginEpoch(next);
      std::vector<float> stereo(kBlockFrames * kChannels, .25f);
      for (std::size_t frame = 0; frame < kBlockFrames; ++frame) stereo[2 * frame + 1] = -.25f;
      normalizer.Push(Packet(next, stereo, 1, kBlockFrames - 1), [&](const NormalizedBlock& block) {
        bool unchanged = true;
        for (std::size_t frame = 0; frame < kBlockFrames; ++frame)
          unchanged = unchanged && block.samples[2 * frame] == 8192 &&
                      block.samples[2 * frame + 1] == -8192;
        check(unchanged && block.sequence == 0, "Surround epoch leaked attenuation/PCM into legacy stereo");
      });
      check(normalizer.Snapshot().discarded_partial_frames == kBlockFrames - 1 &&
            normalizer.Snapshot().blocks == 1, "Surround partial frames were not retired exactly");
    }
    {
      PcmNormalizer normalizer;
      normalizer.BeginEpoch(epoch);
      const std::vector<float> data(kBlockFrames * format.channels);
      auto packet = Packet(epoch, data, 0, 0);
      packet.frames -= 1;
      rejects([&] { normalizer.Push(packet, [](const NormalizedBlock&) {}); }, Failure::InvalidPacket);
      normalizer.BeginEpoch({"surround", "surround:2", format, 0, 0});
      packet = Packet(normalizer.Epoch(), data, 0, 0);
      packet.flags = {6, true, false, true};
      packet.device_position.reset();
      packet.qpc_timestamp_us.reset();
      normalizer.Push(packet, [&](const NormalizedBlock& block) {
        check(!block.timing.spans.front().device_position &&
              !block.timing.spans.front().qpc_timestamp_us &&
              block.timing.spans.front().flags.raw == 6 &&
              std::all_of(block.samples.begin(), block.samples.end(), [](auto sample) { return sample == 0; }),
              "Timestamp-invalid surround silence acquired invented provenance or PCM");
      });
    }
  }
  for (const auto& format : {
      CaptureFormat{kRate, 6, std::nullopt, 32, 32}, CaptureFormat{kRate, 8, std::nullopt, 32, 32},
      CaptureFormat{kRate, 6, 0, 32, 32}, CaptureFormat{kRate, 8, 0, 32, 32},
      CaptureFormat{kRate, 6, 3, 32, 32}, CaptureFormat{kRate, 8, 3, 32, 32},
      CaptureFormat{kRate, 6, 0x63f, 32, 32}, CaptureFormat{kRate, 8, 0x3f, 32, 32},
      CaptureFormat{kRate, 8, 0x60f, 32, 32}, CaptureFormat{kRate, 8, 0xff, 32, 32},
      CaptureFormat{kRate, 6, 0x13f, 32, 32}, CaptureFormat{kRate, 8, 0xc3f, 32, 32},
      CaptureFormat{kRate, 3, 7, 32, 32}, CaptureFormat{kRate, 4, 0x33, 32, 32},
      CaptureFormat{kRate, 5, 0x37, 32, 32}, CaptureFormat{kRate, 7, 0x70f, 32, 32},
      CaptureFormat{kRate, 2, 0x80000003, 32, 32}}) {
    rejects([&] { PcmNormalizer::ValidateFormat(format); }, Failure::UnsupportedFormat);
    rejects([&] { (void)ParseFormat(format_json(format)); }, Failure::UnsupportedFormat);
  }
  {
    const CaptureEpoch epoch{"loopback", "loopback:0", {kRate, 8, 1599, 32, 32}, 0, 0};
    PcmNormalizer normalizer;
    normalizer.BeginEpoch(epoch);
    std::vector<float> data(kBlockFrames * 8);
    for (std::size_t frame = 0; frame < kBlockFrames; ++frame) {
      data[frame * 8] = .25f;
      data[frame * 8 + 1] = -.25f;
    }
    constexpr std::int64_t origin_us = 66576858724;
    for (std::uint64_t sequence = 0; sequence < 1311; ++sequence) {
      auto packet = Packet(epoch, data, sequence, sequence * kBlockFrames);
      packet.device_position.reset();
      packet.qpc_timestamp_us = origin_us + std::int64_t(sequence) * 10000;
      normalizer.Push(packet, [&](const NormalizedBlock& block) {
        check(block.epoch == "loopback:0" && block.sequence == sequence &&
              block.first_normalized_frame == sequence * kBlockFrames &&
              block.timing.spans.size() == 1 && !block.timing.spans.front().device_position &&
              block.timing.spans.front().qpc_timestamp_us == packet.qpc_timestamp_us &&
              block.timing.spans.front().packet_sequence == sequence &&
              block.timing.spans.front().packet_frame_index == sequence * kBlockFrames &&
              block.timing.spans.front().flags.raw == 0 &&
              CaptureTimestampQpc(epoch, block.timing) == packet.qpc_timestamp_us,
              "Observed QPC-only process packet cadence lost its continuous epoch or original anchors");
      });
    }
    check(normalizer.Snapshot().packets == 1311 && normalizer.Snapshot().blocks == 1311 &&
          normalizer.Snapshot().pending_input_frames == 0 &&
          normalizer.Snapshot().discarded_partial_frames == 0 && !normalizer.Snapshot().reset_required,
          "1311 contiguous original packets restarted SRC/source or discarded captured frames");
  }
  {
    const CaptureEpoch epoch{"anchors", "anchors:1", Stereo(), 0, 0};
    const std::vector<float> data(kBlockFrames * kChannels, .125f);
    for (unsigned kind = 0; kind < 12; ++kind) {
      PcmNormalizer normalizer;
      normalizer.BeginEpoch(epoch);
      auto first = Packet(epoch, data, 0, 0);
      if (kind < 1 || kind > 4) first.device_position.reset();
      if (kind == 11) {
        first.flags = {4, false, false, true};
        first.qpc_timestamp_us.reset();
      }
      normalizer.Push(first, [](const NormalizedBlock&) {});
      auto next = Packet(epoch, data, 1, kBlockFrames);
      next.device_position.reset();
      if (kind == 0 || kind == 2) next.device_position = 0;
      if (kind == 3) next.device_position = 481;
      if (kind == 4) next.device_position = 1;
      if (kind == 5) next.qpc_timestamp_us = 999999;
      if (kind == 6) next.qpc_timestamp_us = 1025000;
      if (kind == 7) next.qpc_timestamp_us = 1005000;
      if (kind == 8) next.qpc_timestamp_us = 1000000;
      if (kind == 9) next.flags = {1, false, true, false};
      if (kind == 10) {
        next.flags = {4, false, false, true};
        next.qpc_timestamp_us.reset();
      }
      rejects([&] { normalizer.Push(next, [](const NormalizedBlock&) {}); }, Failure::Discontinuity);
      check(normalizer.Snapshot().reset_required && normalizer.Snapshot().blocks == 1,
            "Counter/QPC availability, true sample gaps or raw discontinuities bypassed epoch admission");
    }
    for (unsigned kind = 0; kind < 3; ++kind) {
      PcmNormalizer normalizer;
      normalizer.BeginEpoch(epoch);
      auto packet = Packet(epoch, data, 0, 0);
      packet.device_position.reset();
      if (kind != 1) packet.qpc_timestamp_us.reset();
      if (kind != 0) packet.flags = {4, false, false, true};
      if (kind == 2) packet.device_position = 0;
      rejects([&] { normalizer.Push(packet, [](const NormalizedBlock&) {}); }, Failure::InvalidPacket);
    }
  }
  {
    CaptureEpoch epoch{"mono", "mono:1", {48000, 1, 4, 16, 16}, 0, 0};
    PcmNormalizer normalizer;
    normalizer.BeginEpoch(epoch);
    std::vector<float> data(kBlockFrames, .25f);
    normalizer.Push(Packet(epoch, data, 0, 0), [&](const NormalizedBlock& block) {
      check(std::all_of(block.samples.begin(), block.samples.end(),
                       [](auto value) { return value == 8192; }),
            "Explicit mono duplication did not preserve both stereo channels");
    });
    auto format = Stereo();
    format.channels = 6;
    rejects([&] { PcmNormalizer::ValidateFormat(format); }, Failure::UnsupportedFormat);
    format = Stereo();
    format.channel_mask = 12;
    rejects([&] { PcmNormalizer::ValidateFormat(format); }, Failure::UnsupportedFormat);
    format = Stereo(22050);
    rejects([&] { PcmNormalizer::ValidateFormat(format); }, Failure::UnsupportedFormat);
  }
  {
    const CaptureEpoch first{"session", "session:1", Stereo(), 0, 0};
    PcmNormalizer normalizer;
    normalizer.BeginEpoch(first);
    const std::vector<float> partial(2 * 200, .5f), remaining(2 * kBlockFrames, .25f);
    unsigned blocks = 0;
    normalizer.Push(Packet(first, partial, 0, 0), [&](const NormalizedBlock&) { ++blocks; });
    rejects([&] { normalizer.Push(Packet(first, remaining, 2, 200),
                                  [&](const NormalizedBlock&) { ++blocks; }); }, Failure::Discontinuity);
    check(normalizer.Snapshot().reset_required && blocks == 0,
          "Capture gap emitted padded PCM or retained an admissible old epoch");
    const CaptureEpoch next{"session", "session:2", Stereo(), 2, 300};
    normalizer.BeginEpoch(next);
    normalizer.Push(Packet(next, remaining, 2, 300), [&](const NormalizedBlock& block) {
      ++blocks;
      check(block.samples.front() == 8192 && block.sequence == 0,
            "New epoch mixed old partial PCM into the replacement");
    });
    check(normalizer.Snapshot().discarded_partial_frames == 200 && blocks == 1,
          "Old partial capture was not explicitly retired at epoch change");
    rejects([&] { normalizer.BeginEpoch(first); }, Failure::WrongEpoch);
  }
  {
    const CaptureEpoch epoch{"bad", "bad:1", Stereo(), 0, 0};
    std::vector<float> samples(2 * kBlockFrames, 0.f);
    for (unsigned kind = 0; kind < 3; ++kind) {
      PcmNormalizer normalizer;
      normalizer.BeginEpoch(epoch);
      auto packet = Packet(epoch, samples, 0, 0);
      if (kind == 0) samples[0] = (std::numeric_limits<float>::quiet_NaN)();
      if (kind == 1) {
        samples[0] = .1f;
        packet.flags = {2, true, false, false};
      }
      if (kind == 2) {
        samples[0] = 0.f;
        packet.flags = {4, false, false, true};
      }
      rejects([&] { normalizer.Push(packet, [](const NormalizedBlock&) {}); }, Failure::InvalidPacket);
    }
    PcmNormalizer normalizer;
    normalizer.BeginEpoch(epoch);
    auto silent = Packet(epoch, samples, 0, 0);
    silent.flags = {6, true, false, true};
    silent.device_position.reset();
    silent.qpc_timestamp_us.reset();
    normalizer.Push(silent, [&](const NormalizedBlock& block) {
      check(block.timing.spans.front().flags.silent &&
            !block.timing.spans.front().qpc_timestamp_us &&
            std::all_of(block.samples.begin(), block.samples.end(), [](auto sample) { return sample == 0; }),
            "Actual timestamp-invalid SILENT packet lost its provenance");
    });
  }
  {
    const CaptureEpoch epoch{"timing", "timing:1", Stereo(44100), 0, 0};
    CaptureSpan span{0, 0, 0, 441, 0, 1000000, {}};
    CaptureBlockTiming timing{44100, 441, 16, std::span<const CaptureSpan>(&span, 1)};
    check(!CaptureTimestampQpc(epoch, timing), "SRC priming was attributed to pre-epoch capture");
    span.packet_frame_index = 441;
    span.device_position = 441;
    span.qpc_timestamp_us = 1010000;
    check(CaptureTimestampQpc(epoch, timing) == 1009637,
          "Audio capture timestamp ignored the pinned SRC half-kernel delay");
    span.offset_frames = 16;
    check(CaptureTimestampQpc(epoch, timing) == 1010000,
          "Known sample offset was confused with arrival time");
    span.qpc_timestamp_us.reset();
    span.flags.timestamp_error = true;
    check(!CaptureTimestampQpc(epoch, timing), "Invalid QPC acquired a fabricated absolute timestamp");
  }
  {
    MissingTimestamp mapper;
    Blocks observation;
    TrackSink sink;
    auto source = webrtc::make_ref_counted<PcmTrackSource>(mapper, observation);
    const CaptureEpoch epoch{"track", "track:1", Stereo(), 0, 0};
    source->BeginEpoch(epoch);
    source->AddSink(&sink);
    std::vector<float> samples(2 * kBlockFrames, .125f);
    source->Push(Packet(epoch, samples, 0, 0));
    check(sink.blocks == 0 && observation.count == 1, "Audio source was not default-disabled");
    source->SetEnabled(true);
    source->Push(Packet(epoch, samples, 1, kBlockFrames));
    check(sink.blocks == 1 && observation.saw_enabled && !observation.saw_timestamp,
          "Per-track sink delivery invented timestamps or bypassed authorization");
    source->RemoveSink(&sink);
    source->Push(Packet(epoch, samples, 2, 2 * kBlockFrames));
    check(sink.blocks == 1, "Removed track sink still received audio");
    const auto options = source->options();
    check(options.init_recording_on_send == false && options.echo_cancellation == false &&
          options.auto_gain_control == false && options.noise_suppression == false,
          "Screen source inherited microphone processing or global ADM capture");
    source->End();
    rejects([&] { source->Push(Packet(epoch, samples, 3, 3 * kBlockFrames)); }, Failure::NotReady);
  }
  {
    webrtc::SimulatedClock rtc(1000000);
    Feedback feedback;
    Output output;
    Mixer mixer;
    auto adm = webrtc::make_ref_counted<CreditAudioDevice>(rtc, feedback, output);
    check(adm->Init() == 0 && adm->RegisterAudioCallback(&mixer) == 0,
          "Inert non-platform ADM setup failed");
    check(adm->InitPlayout() == -1 && adm->InitRecording() == -1 && adm->StartRecording() == -1,
          "ADM silently selected a default output or enabled recording");
    check(adm->SetPlayoutDevice(webrtc::AudioDeviceModule::kDefaultDevice) == -1 &&
          adm->PlayoutDevices() == 0 && adm->RecordingDevices() == 0,
          "Non-platform ADM exposed platform/default devices");
    adm->BeginPlayoutEpoch(7);
    check(adm->InitPlayout() == 0 && adm->StartPlayout() == 0, "Explicit output epoch did not start");
    check(adm->DrainCredits() == 0 && mixer.calls == 0, "ADM mixed PCM without worklet credit");
    adm->GrantCredits({7, 1, 960});
    rejects([&] { adm->GrantCredits({7, 1, 480}); }, Failure::InvalidCredit);
    adm->GrantCredits({7, 2, 960});
    rejects([&] { adm->GrantCredits({7, 3, 480}); }, Failure::CreditOverflow);
    check(adm->Snapshot().last_grant_sequence == 2 && adm->Snapshot().credit_frames == 1920,
          "Rejected credit mutated the bounded ledger");
    check(adm->DrainCredits() == 0 && output.packets.size() == 4 &&
          mixer.calls == 4 && mixer.recording_calls == 0, "ADM mixed through recording or beyond credit");
    for (std::size_t i = 0; i < output.packets.size(); ++i) {
      const auto& packet = output.packets[i];
      check(packet.epoch == 7 && packet.sequence == i &&
            packet.first_playout_frame == i * kBlockFrames &&
            packet.samples[0] == .5f && packet.samples[1] == -.5f &&
            !packet.mixer_ntp_time_ms, "Mixed PCM positions, conversion or unknown NTP were fabricated");
    }
    uint16_t delay = 999;
    check(adm->PlayoutDelay(&delay) == -1 && delay == 999, "Missing physical feedback became zero delay");
    feedback.value = CalibratedPlayoutFeedback{7, 1, 1000000, 1000, 1000, 1000, 960., 1920};
    feedback.value->estimated_playout_frame = -480;
    check(adm->PlayoutDelay(&delay) == 0 && delay == 50,
          "ADM clamped the legitimate pre-anchor physical position");
    feedback.value->estimated_playout_frame = 960;
    check(adm->PlayoutDelay(&delay) == 0 && delay == 20,
          "ADM delay did not use actual mixed minus physically played frames");
    rtc.AdvanceTimeMicroseconds(5000);
    check(adm->PlayoutDelay(&delay) == 0 && delay == 15, "ADM delay double-counted output latency");
    rtc.AdvanceTimeMicroseconds(30000);
    check(adm->PlayoutDelay(&delay) == -1, "Clock extrapolated beyond confirmed native PCM");
    adm->StopPlayout();
    check(output.invalidated.empty() && adm->Snapshot().epoch == 7 &&
          !adm->Playing() && adm->PlayoutIsInitialized(),
          "Normal RTC pause retired the explicitly owned output");
    adm->GrantCredits({7, 3, 480});
    check(!adm->Snapshot().HasPlayableCredits() && adm->DrainCredits() == 480 &&
          mixer.calls == 4 && adm->Snapshot().mixed_frame_cursor == 1920,
          "Paused credits were mixed/spun away or changed sample position");
    rejects([&] { adm->BeginPlayoutEpoch(8); }, Failure::NotReady);
    adm->StopPlayout();
    check(output.invalidated.empty() && adm->Snapshot().credit_frames == 480,
          "Repeated RTC pause lost debt or fabricated retirement");
    check(adm->StartPlayout() == 0 && output.started_epoch == 7 && output.starts == 2,
          "Resume failed to notify the existing output worker");
    check(adm->DrainCredits() == 0 && output.packets.size() == 5 &&
          output.packets.back().sequence == 4 && output.packets.back().first_playout_frame == 1920,
          "Resumed PCM reset or skipped the preserved sequence/cursor");
    check(adm->PlayoutDelay(&delay) == -1,
          "Resume extrapolated an old physical anchor beyond confirmed PCM");
    adm->EndPlayout(PlayoutOutput::StopReason::OwnerStop);
    check(output.invalidated.size() == 1 && output.invalidated.front().first == 7 &&
          output.invalidated.front().second == PlayoutOutput::StopReason::OwnerStop &&
          adm->Snapshot().epoch == 0,
          "Explicit output retirement failed to invalidate the owned epoch");
    rejects([&] { adm->GrantCredits({7, 4, 480}); }, Failure::NotReady);
    rejects([&] { adm->BeginPlayoutEpoch(7); }, Failure::WrongEpoch);
    adm->BeginPlayoutEpoch(8);
    check(adm->InitPlayout() == 0 && adm->StartPlayout() == 0, "Fresh output epoch could not start");
    output.accept = false;
    adm->GrantCredits({8, 1, 480});
    rejects([&] { (void)adm->DrainCredits(); }, Failure::OutputRejected);
    check(adm->Snapshot().failed && !adm->Playing() && adm->Snapshot().credit_frames == 0,
          "Rejected PCM was retried under the same output sample position");
    check(output.failure_epoch == 8, "Mixer failure lost its immutable positive epoch");
    adm->BeginPlayoutEpoch(9);
    check(adm->InitSpeaker() == 0 && adm->SpeakerIsInitialized() &&
          adm->InitPlayout() == 0 && adm->StartPlayout() == 0,
          "Explicit external speaker/playout state was not initialized");
    mixer.short_block = true;
    output.accept = true;
    adm->GrantCredits({9, 1, 480});
    rejects([&] { (void)adm->DrainCredits(); }, Failure::Transport);
    check(adm->Snapshot().failed && !adm->SpeakerIsInitialized(),
          "Short native mixing block silently became a valid silence packet");
    check(adm->Terminate() == 0 && !adm->Initialized(), "ADM callback ownership survived termination");
  }
  {
    webrtc::SimulatedClock rtc(1000000);
    Feedback feedback;
    Output output;
    Mixer mixer;
    auto adm = webrtc::make_ref_counted<CreditAudioDevice>(rtc, feedback, output);
    adm->Init();
    adm->RegisterAudioCallback(&mixer);
    adm->BeginPlayoutEpoch(41);
    adm->InitPlayout();
    adm->StartPlayout();
    output.accept = false;
    std::promise<void> entered, resume;
    auto entered_future = entered.get_future();
    auto resume_future = resume.get_future();
    std::uint64_t observed_epoch = 99;
    output.before_failure = [&](std::uint64_t) {
      entered.set_value();
      resume_future.wait();
      observed_epoch = adm->Snapshot().epoch;
    };
    adm->GrantCredits({41, 1, 480});
    std::thread drain([&] { try { (void)adm->DrainCredits(); } catch (...) {} });
    const bool callback_entered =
        entered_future.wait_for(std::chrono::seconds(5)) == std::future_status::ready;
    std::thread stopper([&] { adm->EndPlayout(PlayoutOutput::StopReason::OwnerStop); });
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (adm->Snapshot().epoch != 0 && std::chrono::steady_clock::now() < deadline)
      std::this_thread::yield();
    const bool stopped_before_callback = adm->Snapshot().epoch == 0;
    resume.set_value();
    drain.join();
    stopper.join();
    check(callback_entered && stopped_before_callback && observed_epoch == 0 &&
          output.failure_epoch == 41 && !output.hook_failed,
          "Concurrent explicit retirement replaced the failing epoch with snapshot0");
    check(output.invalidated.size() == 1 && output.invalidated.front().first == 41,
          "Concurrent explicit stop notification lost its retired epoch");
    adm->Terminate();
  }
  {
    webrtc::SimulatedClock rtc(1000000);
    Feedback feedback;
    Output output;
    Mixer mixer;
    auto adm = webrtc::make_ref_counted<CreditAudioDevice>(rtc, feedback, output);
    std::mutex wake_mutex;
    std::condition_variable wake;
    bool stopping = false;
    std::promise<void> entered, finish_mix, delivered;
    auto entered_future = entered.get_future();
    auto finish_future = finish_mix.get_future();
    auto delivered_future = delivered.get_future();
    bool worker_failed = false;
    output.on_start = [&] {
      { std::lock_guard lock(wake_mutex); }
      wake.notify_one();
    };
    mixer.before_mix = [&] {
      if (mixer.calls != 0) return;
      entered.set_value();
      finish_future.wait();
    };
    adm->Init();
    adm->RegisterAudioCallback(&mixer);
    adm->BeginPlayoutEpoch(51);
    adm->InitPlayout();
    adm->StartPlayout();
    adm->GrantCredits({51, 1, 960});
    std::thread worker([&] {
      try {
        for (;;) {
          {
            std::unique_lock lock(wake_mutex);
            wake.wait(lock, [&] { return stopping || adm->Snapshot().HasPlayableCredits(); });
            if (stopping) return;
          }
          adm->DrainCredits();
          if (output.packets.size() == 2) delivered.set_value();
        }
      } catch (...) { worker_failed = true; }
    });
    const bool began = entered_future.wait_for(std::chrono::seconds(5)) == std::future_status::ready;
    std::thread pauser([&] { adm->StopPlayout(); });
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (adm->Playing() && std::chrono::steady_clock::now() < deadline)
      std::this_thread::yield();
    const bool paused_in_flight = !adm->Playing();
    finish_mix.set_value();
    pauser.join();
    const auto paused = adm->Snapshot();
    const auto paused_packets = output.packets.size();
    const auto started = adm->StartPlayout();
    const bool resumed_without_grant =
        delivered_future.wait_for(std::chrono::seconds(5)) == std::future_status::ready;
    {
      std::lock_guard lock(wake_mutex);
      stopping = true;
    }
    wake.notify_one();
    worker.join();
    check(began && paused_in_flight && paused.epoch == 51 && !paused.playing &&
          paused.next_packet_sequence == 1 && paused.mixed_frame_cursor == 480 &&
          paused.credit_frames == 480 && paused_packets == 1,
          "RTC pause discarded the in-flight block or lost its outstanding credit");
    check(started == 0 && resumed_without_grant && !worker_failed && !output.hook_failed &&
          output.packets.size() == 2 && output.packets.back().epoch == 51 &&
          output.packets.back().sequence == 1 && output.packets.back().first_playout_frame == 480 &&
          adm->Snapshot().credit_frames == 0 && output.invalidated.empty(),
          "Resume required a new grant, reset media position or retired the persistent output");
    adm->Terminate();
  }
  {
    OutputEpoch gate;
    gate.Begin(10);
    check(!gate.Accepts(10) && gate.Ready(10) && gate.Accepts(10),
          "Unconfigured output accepted a credit or failed to publish readiness");
    check(gate.Invalidate(10) && !gate.Accepts(10) && !gate.Ready(10),
          "Retired output epoch became ready again");
    rejects([&] { gate.Begin(10); }, Failure::NotReady);
    gate.Begin(11);
    gate.Ready(11);
    check(!gate.Invalidate(10) && gate.Accepts(11),
          "Late failure of E cleared the readiness of E+1");
    OutputEpoch late;
    late.Begin(20);
    late.Ready(20);
    late.Begin(21);
    late.Ready(21);
    check(late.Invalidate(20) && late.Accepts(21),
          "First delayed invalidation of E, not only a duplicate, cleared E+1");
    OutputPackets packets;
    packets.emplace(std::pair(10ull, 0ull), PlayoutPacket{});
    packets.emplace(std::pair(11ull, 0ull), PlayoutPacket{});
    RetireOutputPackets(packets, 10);
    check(packets.size() == 1 && packets.begin()->first.first == 11,
          "Late failure of E erased queued PCM belonging to E+1");
    gate.Invalidate(12);
    rejects([&] { gate.Begin(12); }, Failure::NotReady);
    check(gate.Accepts(11) == false,
          "Native retirement observed before configure was ignored");
    for (const auto reason : {PlayoutOutput::StopReason::OwnerStop,
         PlayoutOutput::StopReason::EngineClose, PlayoutOutput::StopReason::TransportDetached,
         PlayoutOutput::StopReason::SetupFailed, PlayoutOutput::StopReason::MixerFailure})
      check(StopReasonText(reason) != nullptr, "A native stop reason has no public representation");
  }
  {
    CalibratedPlayoutFeedback feedback{9, 2, 1000000, 1000, 1000, 1000, 480., 960};
    check(PhysicalPlayoutDelay(feedback, 9, 960, 1000000) == 10,
          "Physical delay policy lost its units");
    check(!PhysicalPlayoutDelay(feedback, 10, 960, 1000000), "Stale output epoch provided a delay");
    feedback.feedback_age_us = 200001;
    check(!PhysicalPlayoutDelay(feedback, 9, 960, 1000000), "Stale Renderer feedback provided a delay");
    feedback.feedback_age_us = 0;
    feedback.calibration_uncertainty_us = 20001;
    check(!PhysicalPlayoutDelay(feedback, 9, 960, 1000000), "Uncertain clock calibration provided a delay");
    feedback.calibration_uncertainty_us = 0;
    feedback.estimated_playout_frame = -480;
    check(PhysicalPlayoutDelay(feedback, 9, 960, 1000000) == 30,
          "Pre-anchor physical delay was dropped or clamped to zero");
    check(PhysicalPlayoutDelay(feedback, 9, 960, 1005000) == 25 &&
          PhysicalPlayoutDelay(feedback, 9, 960, 1010000) == 20,
          "Signed physical position did not advance continuously through zero");
    feedback.estimated_playout_frame = -0.5;
    check(PhysicalPlayoutDelay(feedback, 9, 960, 1000000) == 21,
          "Fractional pre-anchor latency was truncated");
    feedback.estimated_playout_frame = -double(kMaxSafeInteger) - 1;
    check(!PhysicalPlayoutDelay(feedback, 9, 960, 1000000),
          "Unsafe negative physical position was accepted");
    feedback.estimated_playout_frame = -double(kMaxSafeInteger);
    check(!PhysicalPlayoutDelay(feedback, 9, 960, 1000000),
          "Unrepresentable ADM delay was fabricated from an extreme negative position");
  }
  {
    check(sizeof(MonkyEngineAudioPacket) == 384 && offsetof(MonkyEngineAudioPacket, pcm) == 80,
          "Audio input extension changed its C/POD layout");
    check(sizeof(MonkyEngineAudioPlayout) == 3904 && offsetof(MonkyEngineAudioPlayout, samples) == 48,
          "Audio output extension changed its C/POD layout");
    check(sizeof(MonkyEngineAudioReply) == 4112 && MONKY_ENGINE_AUDIO_EXTENSION_VERSION == 1,
          "Audio reply extension changed its fixed bound");
    OutputClock clock;
    check(!clock.Read(1), "Uncalibrated output has a physical clock");
    rejects([&] { clock.Probe({0, 1, 1000000, 1000000}); }, Failure::Clock);
    clock.Begin(1);
    rejects([&] { clock.Begin(1); }, Failure::Clock);
    rejects([&] { clock.Calibrate(1, 1, 2000000, 2001000, 1001000); }, Failure::Clock);
    rejects([&] { clock.Probe({2, 1, 1000000, 1000000}); }, Failure::Clock);
    rejects([&] { clock.Probe({1, 1, 1000001, 1000000}); }, Failure::Clock);
    rejects([&] { clock.Probe({1, 1, 1000000, 1020001}); }, Failure::Clock);
    clock.Probe({1, 1, 1000000, 1000000});
    rejects([&] { clock.Probe({1, 1, 1000000, 1000000}); }, Failure::Clock);
    rejects([&] { clock.Calibrate(1, 1, 2000000, 2008001, 1001000); }, Failure::Clock);
    rejects([&] { clock.Calibrate(1, 1, 2001000, 2000000, 1001000); }, Failure::Clock);
    rejects([&] { clock.Calibrate(1, 1, 2000000, 2001000, 999999); }, Failure::Clock);
    rejects([&] { clock.Calibrate(1, 1, 2000000, 2001000, 1200001); }, Failure::Clock);
    const auto calibration = clock.Calibrate(1, 1, 2000000, 2001000, 1001000);
    check(calibration.offset_us == -1000500 && calibration.uncertainty_us == 16500,
          "Output clock lost its real paired-clock offset/RTC quantization bound");
    rejects([&] { clock.Calibrate(1, 1, 2000000, 2001000, 1001000); }, Failure::Clock);
    RendererPlayoutFeedback feedback{1, 1, calibration.id, true, 2010500, 1000, 1000, -480., 960};
    clock.Feedback(feedback, 1010000, 960);
    check(clock.Read(1).has_value() && !clock.Read(2), "Physical clock leaked across output epochs");
    check(clock.Read(1)->estimated_playout_frame == -480 &&
          PhysicalPlayoutDelay(*clock.Read(1), 1, 960, 1010000) == 30,
          "Actual calibrated frame position did not reach physical delay");
    rejects([&] { clock.Feedback(feedback, 1010000, 960); }, Failure::Clock);
    ++feedback.at_performance_us;
    feedback.estimated_playout_frame = -479.5;
    clock.Feedback(feedback, 1010001, 960);
    check(clock.Read(1)->estimated_playout_frame == -479.5,
          "Native feedback clamped or rounded the signed fractional sample estimate");
    feedback.at_performance_us += 1000;
    feedback.estimated_playout_frame = -480;
    rejects([&] { clock.Feedback(feedback, 1011000, 960); }, Failure::Clock);
    feedback.clock_epoch = 2;
    feedback.estimated_playout_frame = -double(kMaxSafeInteger) - 1;
    rejects([&] { clock.Feedback(feedback, 1011000, 960); }, Failure::Clock);
    feedback.clock_epoch = 1;
    feedback.estimated_playout_frame = 961;
    rejects([&] { clock.Feedback(feedback, 1011000, 960); }, Failure::Clock);
    feedback.estimated_playout_frame = std::numeric_limits<double>::quiet_NaN();
    rejects([&] { clock.Feedback(feedback, 1011000, 960); }, Failure::Clock);
    feedback.estimated_playout_frame = 500;
    feedback.confirmed_pcm_end = 1440;
    rejects([&] { clock.Feedback(feedback, 1011000, 960); }, Failure::Clock);
    feedback.confirmed_pcm_end = 960;
    feedback.feedback_age_us = 200001;
    rejects([&] { clock.Feedback(feedback, 1011000, 960); }, Failure::Clock);
    feedback.feedback_age_us = 0;
    feedback.output_clock_age_us = 200001;
    rejects([&] { clock.Feedback(feedback, 1011000, 960); }, Failure::Clock);
    feedback.output_clock_age_us = 0;
    feedback.calibration_id = 2;
    rejects([&] { clock.Feedback(feedback, 1011000, 960); }, Failure::Clock);
    feedback.calibration_id = calibration.id;
    clock.Feedback(feedback, 1011000, 960);
    feedback.available = false;
    clock.Feedback(feedback, 1011000, 960);
    check(!clock.Read(1), "Worklet unavailability retained an old physical anchor");
    feedback.available = true;
    feedback.clock_epoch = 2;
    feedback.at_performance_us = 2013500;
    feedback.estimated_playout_frame = -480;
    clock.Feedback(feedback, 1013000, 1440);
    check(clock.Read(1) && clock.Read(1)->clock_epoch == 2 &&
          clock.Read(1)->estimated_playout_frame == -480,
          "A real post-gap worklet anchor could not resume under the same output epoch");
    clock.Stop();
    rejects([&] { clock.Probe({1, 2, 1012000, 1012000}); }, Failure::Clock);
    rejects([&] { clock.Feedback(feedback, 1011000, 960); }, Failure::Clock);
    rejects([&] { clock.Begin(1); }, Failure::Clock);
    clock.Begin(2);
    clock.Stop(1);
    for (std::uint64_t id = 1; id <= 16; ++id) clock.Probe({2, id, 2000000, 2000000});
    rejects([&] { clock.Probe({2, 17, 2000000, 2000000}); }, Failure::Clock);
    clock.Probe({2, 17, 2200001, 2200001});
    check(!clock.Read(2), "A fresh probe fabricated physical feedback");
  }
}

}  // namespace monky::native_rtc::engine::audio
