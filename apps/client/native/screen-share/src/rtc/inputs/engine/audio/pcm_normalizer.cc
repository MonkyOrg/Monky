#include "pcm_normalizer.h"

#include "audio\utility\channel_mixing_matrix.h"
#include "common_audio\include\audio_util.h"
#include "common_audio\resampler\sinc_resampler.h"

#include <algorithm>
#include <charconv>
#include <cmath>
#include <limits>
#include <numeric>

namespace monky::native_rtc::engine::audio {
namespace {

webrtc::ChannelLayout CaptureLayout(const CaptureFormat& format) {
  const auto mask = format.channel_mask.value_or(0);
  if (format.channels == 1 && (mask == 0 || mask == 4))
    return webrtc::CHANNEL_LAYOUT_MONO;
  if (format.channels == 2 && (mask == 0 || mask == 3))
    return webrtc::CHANNEL_LAYOUT_STEREO;
  if (format.channels == 6 && mask == 0x3f)
    return webrtc::CHANNEL_LAYOUT_5_1_BACK;
  if (format.channels == 6 && mask == 0x60f)
    return webrtc::CHANNEL_LAYOUT_5_1;
  if (format.channels == 8 && mask == 0x63f)
    return webrtc::CHANNEL_LAYOUT_7_1;
  throw AudioError(Failure::UnsupportedFormat,
      "Capture requires mono, stereo, or an explicit supported Windows 5.1/7.1 speaker mask");
}

std::vector<std::vector<float>> StereoMatrix(const CaptureFormat& format) {
  const auto layout = CaptureLayout(format);
  std::vector<std::vector<float>> matrix;
  webrtc::ChannelMixingMatrix builder(layout, format.channels,
                                     webrtc::CHANNEL_LAYOUT_STEREO, kChannels);
  builder.CreateTransformationMatrix(&matrix);
  // WAVEFORMATEXTENSIBLE orders speakers by ascending mask bit. M140 7.1
  // instead puts side L/R before back L/R; reorder coefficients, not capture.
  for (auto& row : matrix) {
    const auto rtc_order = row;
    std::size_t input = 0;
    for (const auto speaker : {webrtc::LEFT, webrtc::RIGHT, webrtc::CENTER, webrtc::LFE,
                              webrtc::BACK_LEFT, webrtc::BACK_RIGHT,
                              webrtc::SIDE_LEFT, webrtc::SIDE_RIGHT}) {
      const auto index = webrtc::ChannelOrder(layout, speaker);
      if (index >= 0) row[input++] = rtc_order[index];
    }
  }
  return matrix;
}

std::uint64_t Generation(const CaptureEpoch& epoch) {
  if (epoch.session_id.empty() || epoch.session_id.size() > 128 ||
      epoch.session_id.find('\0') != std::string::npos ||
      epoch.epoch.size() > 160 || !epoch.epoch.starts_with(epoch.session_id + ":"))
    throw AudioError(Failure::WrongEpoch, "Capture epoch must belong to its explicit session");
  const auto suffix = std::string_view(epoch.epoch).substr(epoch.session_id.size() + 1);
  std::uint64_t generation = 0;
  const auto parsed = std::from_chars(suffix.data(), suffix.data() + suffix.size(), generation);
  if (suffix.empty() || parsed.ec != std::errc{} || parsed.ptr != suffix.data() + suffix.size() ||
      generation > kMaxSafeInteger || epoch.first_sequence > kMaxSafeInteger ||
      epoch.first_frame_index > kMaxSafeInteger)
    throw AudioError(Failure::WrongEpoch, "Invalid capture generation or original sample position");
  return generation;
}

}  // namespace

void PcmNormalizer::ValidateFormat(const CaptureFormat& format) {
  const auto rate = format.sample_rate;
  if (rate != 8000 && rate != 16000 && rate != 24000 && rate != 32000 &&
      rate != 44100 && rate != 48000 && rate != 88200 && rate != 96000 && rate != 192000)
    throw AudioError(Failure::UnsupportedFormat, "Capture rate has no supported integral 10ms SRC block");
  (void)CaptureLayout(format);
  if (!format.source_bits_per_sample || format.source_bits_per_sample > 64 ||
      !format.source_valid_bits_per_sample ||
      format.source_valid_bits_per_sample > format.source_bits_per_sample)
    throw AudioError(Failure::UnsupportedFormat, "Invalid original capture sample representation");
}

void PcmNormalizer::BeginEpoch(const CaptureEpoch& epoch) {
  ValidateFormat(epoch.format);
  const auto generation = Generation(epoch);
  if (snapshot_.initialized &&
      (epoch.session_id != epoch_.session_id || generation <= generation_ ||
       epoch.first_sequence < expected_sequence_ || epoch.first_frame_index < expected_frame_index_))
    throw AudioError(Failure::WrongEpoch, "Recreate the source for another session; generations cannot repeat");
  const auto frames = epoch.format.sample_rate / 100;
  const auto channels = (std::min)(epoch.format.channels, kChannels);
  std::vector<std::vector<float>> downmix;
  double downmix_gain = 1;
  if (epoch.format.channels > kChannels) {
    downmix = StereoMatrix(epoch.format);
    double peak_gain = 1;
    for (const auto& row : downmix)
      peak_gain = (std::max)(peak_gain, std::accumulate(row.begin(), row.end(), 0.0));
    // Fixed shared headroom, not content-dependent AGC: bounded correlated
    // inputs cannot overload the mix. It also attenuates front-only surround.
    downmix_gain = 1 / peak_gain;
  }
  auto resampler = std::make_unique<webrtc::PushResampler<float>>(
      frames, kBlockFrames, channels);
  std::vector<float> pending(frames * channels);
  std::vector<CaptureSpan> spans;
  spans.reserve(frames);
  auto owned_epoch = epoch;
  snapshot_.discarded_partial_frames += snapshot_.pending_input_frames;
  epoch_ = std::move(owned_epoch);
  generation_ = generation;
  expected_sequence_ = epoch.first_sequence;
  expected_frame_index_ = epoch.first_frame_index;
  block_sequence_ = 0;
  expected_device_position_.reset();
  previous_qpc_.reset();
  first_packet_ = true;
  previous_packet_frames_ = 0;
  input_frames_ = frames;
  pending_ = std::move(pending);
  downmix_ = std::move(downmix);
  downmix_gain_ = downmix_gain;
  spans_ = std::move(spans);
  resampler_ = std::move(resampler);
  snapshot_.pending_input_frames = 0;
  snapshot_.initialized = true;
  snapshot_.reset_required = false;
}

void PcmNormalizer::ValidatePacket(const CapturePacketView& packet) const {
  if (!snapshot_.initialized || snapshot_.reset_required)
    throw AudioError(Failure::NotReady, "A fresh capture epoch is required");
  if (packet.session_id != epoch_.session_id || packet.epoch != epoch_.epoch)
    throw AudioError(Failure::WrongEpoch, "Admit the actual new capture epoch before submitting its packets");
  if (packet.format != epoch_.format)
    throw AudioError(Failure::UnsupportedFormat, "Capture format changed within its epoch");
  if (!packet.frames || packet.frames > (1024 * 1024 / sizeof(float)) / packet.format.channels ||
      packet.samples.size() != std::size_t(packet.frames) * packet.format.channels ||
      packet.frame_index > kMaxSafeInteger - packet.frames || packet.sequence >= kMaxSafeInteger)
    throw AudioError(Failure::InvalidPacket, "Invalid bounded original PCM packet");
  if (packet.sequence != expected_sequence_ || packet.frame_index != expected_frame_index_ ||
      (!first_packet_ && packet.flags.data_discontinuity))
    throw AudioError(Failure::Discontinuity, "Capture gap requires a new explicit epoch; no silence is inserted");
  const auto& flags = packet.flags;
  if ((flags.raw & ~7u) || bool(flags.raw & 1u) != flags.data_discontinuity ||
      bool(flags.raw & 2u) != flags.silent || bool(flags.raw & 4u) != flags.timestamp_error ||
      (flags.timestamp_error && packet.device_position) ||
      packet.qpc_timestamp_us.has_value() != !flags.timestamp_error)
    throw AudioError(Failure::InvalidPacket, "Capture flags or nullable timestamp provenance do not agree");
  if (packet.device_position &&
      (*packet.device_position > kMaxSafeInteger - packet.frames ||
       (expected_device_position_ && *packet.device_position != *expected_device_position_)))
    throw AudioError(Failure::Discontinuity, "Device sample position changed without a new capture epoch");
  if (!first_packet_ && packet.device_position.has_value() != expected_device_position_.has_value())
    throw AudioError(Failure::Discontinuity, "Device position availability changed without a new capture epoch");
  if (packet.qpc_timestamp_us &&
      (*packet.qpc_timestamp_us < 0 || std::uint64_t(*packet.qpc_timestamp_us) > kMaxSafeInteger ||
       (previous_qpc_ && *packet.qpc_timestamp_us < *previous_qpc_)))
    throw AudioError(Failure::Discontinuity, "Capture QPC moved backwards or outside its safe range");
  if (!first_packet_ && packet.qpc_timestamp_us.has_value() != previous_qpc_.has_value())
    throw AudioError(Failure::Discontinuity, "Clock-validity transition requires a new capture epoch");
  if (!packet.device_position && packet.qpc_timestamp_us && previous_qpc_) {
    const auto elapsed = std::uint64_t(*packet.qpc_timestamp_us - *previous_qpc_);
    const auto expected = std::uint64_t(previous_packet_frames_) * 1000000 / epoch_.format.sample_rate;
    // Match capture Timeline's QPC-only gap policy without retiming samples:
    // two input frames of slack plus the original microsecond rounding.
    const auto tolerance = (2000000ULL + epoch_.format.sample_rate - 1) / epoch_.format.sample_rate + 1;
    if (elapsed > expected + tolerance || elapsed + tolerance < expected)
      throw AudioError(Failure::Discontinuity, "Original QPC and captured sample coverage have a gap or overlap");
  }
  for (const auto sample : packet.samples)
    if (!std::isfinite(sample) || (flags.silent && sample != 0.f))
      throw AudioError(Failure::InvalidPacket, "PCM contains nonfinite samples or nonzero SILENT data");
}

void PcmNormalizer::Push(const CapturePacketView& packet, const Output& output) {
  try {
    ValidatePacket(packet);
    if (!output) throw AudioError(Failure::NotReady, "Normalized PCM requires an explicit output");
    std::uint32_t offset = 0;
    while (offset < packet.frames) {
      const auto count = (std::min)(input_frames_ - snapshot_.pending_input_frames,
                                   packet.frames - offset);
      const auto channels = packet.format.channels;
      if (downmix_.empty()) {
        std::copy_n(packet.samples.data() + std::size_t(offset) * channels,
                    std::size_t(count) * channels,
                    pending_.data() + std::size_t(snapshot_.pending_input_frames) * channels);
      } else {
        for (std::size_t frame = 0; frame < count; ++frame) {
          for (std::size_t output_channel = 0; output_channel < kChannels; ++output_channel) {
            double mixed = 0;
            for (std::size_t input_channel = 0; input_channel < channels; ++input_channel)
              mixed += double(downmix_[output_channel][input_channel]) *
                  packet.samples[(offset + frame) * channels + input_channel];
            pending_[(snapshot_.pending_input_frames + frame) * kChannels + output_channel] =
                static_cast<float>(mixed * downmix_gain_);
          }
        }
      }
      spans_.push_back({packet.sequence, packet.frame_index, offset, count,
                        packet.device_position, packet.qpc_timestamp_us, packet.flags});
      snapshot_.pending_input_frames += count;
      offset += count;
      if (snapshot_.pending_input_frames == input_frames_) Produce(output);
    }
    expected_sequence_ = packet.sequence + 1;
    expected_frame_index_ = packet.frame_index + packet.frames;
    expected_device_position_ = packet.device_position
        ? std::optional(*packet.device_position + packet.frames) : std::nullopt;
    previous_qpc_ = packet.qpc_timestamp_us;
    previous_packet_frames_ = packet.frames;
    first_packet_ = false;
    ++snapshot_.packets;
  } catch (...) {
    snapshot_.reset_required = true;
    throw;
  }
}

void PcmNormalizer::Produce(const Output& output) {
  if (block_sequence_ > (kMaxSafeInteger - kBlockFrames) / kBlockFrames)
    throw AudioError(Failure::Discontinuity, "Normalized sample position exhausted");
  const auto channels = (std::min)(epoch_.format.channels, kChannels);
  std::array<float, kBlockFrames * kChannels> resampled;
  resampler_->Resample(
      webrtc::InterleavedView<const float>(pending_.data(), input_frames_, channels),
      webrtc::InterleavedView<float>(resampled.data(), kBlockFrames, channels));
  NormalizedBlock block;
  block.session_id = epoch_.session_id;
  block.epoch = epoch_.epoch;
  block.sequence = block_sequence_;
  block.first_normalized_frame = block_sequence_ * kBlockFrames;
  constexpr auto filter_delay = static_cast<std::uint32_t>(webrtc::SincResampler::kKernelSize / 2);
  block.timing = {epoch_.format.sample_rate, input_frames_,
      epoch_.format.sample_rate == kRate ? 0u : filter_delay, spans_};
  for (std::size_t frame = 0; frame < kBlockFrames; ++frame) {
    for (std::size_t channel = 0; channel < kChannels; ++channel) {
      const auto value = resampled[frame * channels + (channels == 1 ? 0 : channel)];
      if (!std::isfinite(value)) throw AudioError(Failure::InvalidPacket, "SRC produced nonfinite PCM");
      if (value < -1.f || value > 1.f) ++block.clipped_samples;
      block.samples[frame * kChannels + channel] = webrtc::FloatToS16(value);
    }
  }
  output(block);
  ++block_sequence_;
  ++snapshot_.blocks;
  snapshot_.clipped_samples += block.clipped_samples;
  snapshot_.pending_input_frames = 0;
  spans_.clear();
}

}  // namespace monky::native_rtc::engine::audio
