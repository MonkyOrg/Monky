#include "runtime.h"

#include "..\peer_support.h"
#include "api\make_ref_counted.h"

#include <bit>
#include <cstring>

namespace monky::native_rtc::engine::audio {
namespace {
using namespace peer_detail;
constexpr std::size_t kMaximumPackets = 8;
static_assert(std::endian::native == std::endian::little);
static_assert(sizeof(MonkyEngineAudioPacket) == 384);
static_assert(sizeof(MonkyEngineAudioPlayout) == 3904);
static_assert(sizeof(MonkyEngineAudioReply) == 4112);

template <typename Action>
void Signaling(Host& host, Action&& action) {
  std::exception_ptr failure;
  host.SignalingThread()->BlockingCall([&] {
    try { action(); } catch (...) { failure = std::current_exception(); }
  });
  if (failure) std::rethrow_exception(failure);
}
template <std::size_t N>
std::string PacketText(const char (&text)[N]) {
  const auto* end = static_cast<const char*>(std::memchr(text, 0, N));
  if (!end || end == text) Invalid("Audio packet has invalid bounded identity");
  return {text, end};
}
Json AudioFailure(const char* message) {
  return {{"code", "ERR_RTC_AUDIO_PACKET"}, {"message", message},
          {"status", MONKY_ENGINE_FAILURE}, {"hresult", 0}};
}
}

CaptureFormat ParseFormat(const Json& data) {
  Keys(data, {"encoding", "sampleRate", "channels", "channelMask",
              "sourceBitsPerSample", "sourceValidBitsPerSample"});
  if (data.contains("encoding") && Text(data, "encoding", 32) != "float32-interleaved")
    Invalid("Audio PCM must be Float32LE interleaved");
  CaptureFormat result;
  result.sample_rate = static_cast<std::uint32_t>(Integer(data, "sampleRate", 1, 192000));
  result.channels = static_cast<std::uint32_t>(Integer(data, "channels", 1, 8));
  if (data.contains("channelMask") && !data.at("channelMask").is_null())
    result.channel_mask = static_cast<std::uint32_t>(Integer(data, "channelMask", 0, UINT32_MAX));
  result.source_bits_per_sample = static_cast<std::uint32_t>(Integer(data, "sourceBitsPerSample", 1, 64));
  result.source_valid_bits_per_sample =
      static_cast<std::uint32_t>(Integer(data, "sourceValidBitsPerSample", 1, 64));
  PcmNormalizer::ValidateFormat(result);
  return result;
}

AudioSource::AudioSource(Host& host, std::uint64_t source_id, const Json& options)
    : id(source_id), session_id(Text(options, "sessionId", 128)), host_(host),
      sync_group_(engine::SyncGroup(options)), mapper_(host.CaptureTimebase()),
      source_(webrtc::make_ref_counted<PcmTrackSource>(mapper_, *this)) {
  Keys(options, {"sessionId", "syncGroup", "format"});
  (void)ParseFormat(options.at("format"));
}
void AudioSource::SetEnabled(bool enabled) {
  if (closed_.load()) throw Error("ERR_RTC_AUDIO_SOURCE_CLOSED", "Audio source is closed", MONKY_ENGINE_CLOSED);
  Signaling(host_, [&] { source_->SetEnabled(enabled); });
  enabled_.store(enabled);
}
std::string AudioSource::SyncGroup() const {
  std::lock_guard lock(metadata_mutex_);
  return sync_group_;
}
void AudioSource::SetSyncGroup(std::string group) {
  std::lock_guard lock(metadata_mutex_);
  sync_group_ = std::move(group);
}
void AudioSource::BeginEpoch(const Json& data) {
  Keys(data, {"epoch", "firstSequence", "firstFrameIndex", "format"});
  CaptureEpoch epoch{session_id, Text(data, "epoch", 160), ParseFormat(data.at("format")),
      Integer(data, "firstSequence", 0, kMaxId), Integer(data, "firstFrameIndex", 0, kMaxId)};
  std::string admitted_epoch = epoch.epoch;
  Signaling(host_, [&] { source_->BeginEpoch(epoch); });
  { std::lock_guard lock(metadata_mutex_); capture_epoch_.swap(admitted_epoch); }
  accepting.store(true);
}
void AudioSource::ValidateAdmissionEpoch(std::string_view epoch) const {
  std::lock_guard lock(metadata_mutex_);
  if (closed_.load() || !accepting.load())
    throw Error("ERR_RTC_AUDIO_NOT_READY", "Audio source has no accepting epoch", MONKY_ENGINE_CLOSED);
  if (epoch != capture_epoch_)
    throw Error("ERR_RTC_AUDIO_EPOCH", "Audio packet belongs to a retired capture epoch", MONKY_ENGINE_INVALID);
}
void AudioSource::Close() {
  accepting.store(false);
  enabled_.store(false);
  if (closed_.load()) return;
  Signaling(host_, [&] { source_->End(); });
  closed_.store(true);
}
void AudioSource::Process(const CapturePacketView& packet) {
  if (closed_.load()) throw AudioError(Failure::Closed, "Audio source closed before processing");
  try { source_->Push(packet); }
  catch (...) {
    enabled_.store(false);
    accepting.store(false);
    throw;
  }
}
void AudioSource::OnBlock(const NormalizedBlock&, std::optional<RtcCaptureTimestamp> timestamp, bool) noexcept {
  ++observed_blocks_;
  if (timestamp) ++timestamped_blocks_;
}
Json AudioSource::Snapshot() const {
  const auto state = source_->Snapshot();
  return {{"sourceId", id}, {"kind", "audio"}, {"sessionId", session_id},
          {"syncGroup", SyncGroup()}, {"enabled", Enabled()}, {"accepting", accepting.load()},
          {"closed", closed_.load()}, {"resetRequired", state.reset_required},
          {"packets", state.packets}, {"blocks", state.blocks},
          {"pendingInputFrames", state.pending_input_frames},
          {"discardedPartialFrames", state.discarded_partial_frames},
          {"clippedSamples", state.clipped_samples}, {"timestampedBlocks", timestamped_blocks_.load()}};
}

AudioRuntime::AudioRuntime(Host& host, webrtc::Clock& clock)
    : host_(host), rtc_clock_(clock),
      adm_(webrtc::make_ref_counted<CreditAudioDevice>(clock, clock_, *this)) {}
AudioRuntime::~AudioRuntime() { Stop(); }
void AudioRuntime::Start() {
  std::lock_guard lock(mutex_);
  if (started_ || stopping_) throw Error("ERR_RTC_AUDIO_STATE", "Audio workers cannot restart");
  started_ = true;
  try {
    capture_thread_ = std::thread([this] { CaptureLoop(); });
    playout_thread_ = std::thread([this] { PlayoutLoop(); });
  } catch (...) {
    stopping_ = true;
    wake_capture_.notify_all();
    throw;
  }
}
void AudioRuntime::FenceCapture(const std::shared_ptr<Cancellation>& cancellation) {
  auto barrier = std::make_shared<std::promise<void>>();
  auto future = barrier->get_future();
  {
    std::lock_guard lock(mutex_);
    if (stopping_) throw Error("ERR_RTC_AUDIO_CLOSED", "Audio workers are stopping", MONKY_ENGINE_CLOSED);
    capture_.push_back({nullptr, barrier});
  }
  wake_capture_.notify_one();
  peer_detail::Wait(host_, cancellation, future);
}
void AudioRuntime::Submit(std::shared_ptr<AudioSource> source, const MonkyEngineAudioPacket& input) {
  if (!source || input.struct_size != sizeof(input) ||
      input.extension_version != MONKY_ENGINE_AUDIO_EXTENSION_VERSION || input.reserved ||
      input.has_channel_mask > 1 || !input.pcm || !input.frames ||
      input.pcm_bytes > 1024 * 1024 || input.pcm_bytes == 0 ||
      input.pcm_bytes % sizeof(float) || input.sequence >= kMaxId)
    Invalid("Invalid versioned audio packet descriptor");
  auto packet = std::make_unique<Packet>();
  packet->source = std::move(source);
  auto& view = packet->view;
  view.session_id = PacketText(input.session_id);
  view.epoch = PacketText(input.epoch);
  view.format = {input.sample_rate, input.channels,
      input.has_channel_mask ? std::optional(input.channel_mask) : std::nullopt,
      input.source_bits_per_sample, input.source_valid_bits_per_sample};
  PcmNormalizer::ValidateFormat(view.format);
  if (std::uint64_t(input.frames) * input.channels * sizeof(float) != input.pcm_bytes ||
      view.session_id != packet->source->session_id || input.flags > 7)
    Invalid("Audio packet dimensions/session/flags do not match its source");
  view.frames = input.frames;
  view.sequence = input.sequence;
  view.frame_index = input.frame_index;
  view.flags = {input.flags, bool(input.flags & 2u), bool(input.flags & 1u), bool(input.flags & 4u)};
  if (view.flags.timestamp_error) {
    if (input.device_position != UINT64_MAX || input.qpc_timestamp_us != -1)
      Invalid("Timestamp-invalid audio must not contain fabricated device/QPC positions");
  } else {
    if (input.device_position != UINT64_MAX) view.device_position = input.device_position;
    view.qpc_timestamp_us = input.qpc_timestamp_us;
  }
  packet->pcm.resize(input.pcm_bytes / sizeof(float));
  std::memcpy(packet->pcm.data(), input.pcm, input.pcm_bytes);
  view.samples = packet->pcm;
  const Key key{packet->source->id, view.epoch, view.sequence};
  {
    std::lock_guard lock(mutex_);
    if (stopping_ || !packet->source->accepting.load())
      throw Error("ERR_RTC_AUDIO_NOT_READY", "Audio source has no accepting capture epoch", MONKY_ENGINE_CLOSED);
    if (pending_.contains(key)) throw Error("ERR_RTC_AUDIO_DUPLICATE", "Audio packet is already pending", MONKY_ENGINE_BUSY);
    packet->source->ValidateAdmissionEpoch(view.epoch);
    if (pending_.size() >= kMaximumPackets)
      throw Error("ERR_RTC_AUDIO_QUEUE", "Audio packet budget exhausted", MONKY_ENGINE_QUEUE_FULL);
    pending_.insert(key);
    try { capture_.push_back({std::move(packet), nullptr}); }
    catch (...) { pending_.erase(key); throw; }
  }
  wake_capture_.notify_one();
}

void AudioRuntime::CaptureLoop() noexcept {
  for (;;) {
    Work work;
    bool stopping;
    {
      std::unique_lock lock(mutex_);
      wake_capture_.wait(lock, [&] { return stopping_ || !capture_.empty(); });
      if (capture_.empty()) return;
      work = std::move(capture_.front());
      capture_.pop_front();
      stopping = stopping_;
    }
    if (work.barrier) {
      try { work.barrier->set_value(); } catch (...) {}
      continue;
    }
    auto& packet = *work.packet;
    Json error = nullptr;
    bool succeeded = false;
    try {
      if (stopping) throw AudioError(Failure::Closed, "Audio engine closed before processing");
      packet.source->Process(packet.view);
      succeeded = true;
    } catch (const std::exception& failure) {
      try { error = AudioFailure(failure.what()); } catch (...) {}
    } catch (...) {
      try { error = AudioFailure("Unknown audio processing failure"); } catch (...) {}
    }
    try {
      Json data{{"sourceId", packet.source->id}, {"epoch", packet.view.epoch},
                {"sequence", packet.view.sequence}, {"frameIndex", packet.view.frame_index},
                {"frames", packet.view.frames}, {"ok", succeeded}};
      if (!error.is_null()) data["error"] = error;
      {
        std::lock_guard lock(mutex_);
        pending_.erase(Key{packet.source->id, packet.view.epoch, packet.view.sequence});
      }
      host_.Emit("source.audioPacketReleased", packet.source->id, std::move(data));
    } catch (...) {
      // Missing delivery is not processing success. Complete close settles
      // remaining Node promises; only DLL-owned PCM is retained here.
      // Null is deliberately not a success envelope: the existing native/Node
      // event fault path forces complete close if diagnostic allocation failed.
      host_.Emit("error", packet.source->id, nullptr);
    }
  }
}

void AudioRuntime::PlayoutLoop() noexcept {
  for (;;) {
    {
      std::unique_lock lock(mutex_);
      wake_playout_.wait(lock, [&] {
        const auto state = adm_->Snapshot();
        return stopping_ || state.HasPlayableCredits();
      });
      if (stopping_) return;
    }
    try { (void)adm_->DrainCredits(); }
    catch (...) {}
  }
}
std::int64_t AudioRuntime::Now() const {
  const auto now = rtc_clock_.CurrentTime();
  if (!now.IsFinite() || now.us() < 0 || std::uint64_t(now.us()) > kMaxId)
    throw AudioError(Failure::Clock, "Actual RTC audio clock is unavailable");
  return now.us();
}
Json AudioRuntime::ConfigureOutput(const Json& data) {
  Keys(data, {"epoch"});
  const auto epoch = Id(data, "epoch");
  adm_->BeginPlayoutEpoch(epoch);
  try {
    output_epoch_.Begin(epoch);
    clock_.Begin(epoch);
    if (adm_->InitSpeaker() || adm_->InitPlayout() || adm_->StartPlayout())
      throw Error("ERR_RTC_AUDIO_OUTPUT", "RTC mixer/output epoch is not ready");
  } catch (...) {
    adm_->EndPlayout(PlayoutOutput::StopReason::SetupFailed);
    clock_.Stop(epoch);
    throw;
  }
  {
    std::lock_guard lock(mutex_);
    output_.clear();
  }
  if (!output_epoch_.Ready(epoch))
    throw Error("ERR_RTC_AUDIO_OUTPUT_EPOCH", "Output stopped during configuration", MONKY_ENGINE_CLOSED);
  return {{"epoch", epoch}, {"sampleRate", kRate}, {"channels", kChannels}};
}
Json AudioRuntime::StopOutput(const Json& data) {
  Keys(data, {"epoch"});
  const auto epoch = Id(data, "epoch");
  const auto current = adm_->Snapshot();
  if (current.epoch && current.epoch != epoch) Invalid("Output stop belongs to another epoch");
  adm_->EndPlayout(PlayoutOutput::StopReason::OwnerStop);
  clock_.Stop(epoch);
  std::lock_guard lock(mutex_);
  RetireOutputPackets(output_, epoch);
  return Json::object();
}
Json AudioRuntime::Command(std::string_view command, const Json& data) {
  const auto epoch = Id(data, "epoch");
  const auto current = adm_->Snapshot();
  if (!output_epoch_.Accepts(epoch) || !current.HasOutputEpoch() || epoch != current.epoch)
    throw Error("ERR_RTC_AUDIO_OUTPUT_EPOCH", "Audio output epoch is not active", MONKY_ENGINE_CLOSED);
  if (command == "grant") {
    Keys(data, {"epoch", "grantSequence", "frames"});
    {
      std::lock_guard lock(mutex_);
      if (stopping_) throw Error("ERR_RTC_AUDIO_CLOSED", "Audio output is closing", MONKY_ENGINE_CLOSED);
      adm_->GrantCredits({epoch, Id(data, "grantSequence"),
          static_cast<std::uint32_t>(Integer(data, "frames", 480, 960))});
    }
    wake_playout_.notify_one();
    return Json::object();
  }
  if (command == "probe") {
    Keys(data, {"epoch", "probeId"});
    ClockProbe probe{epoch, Id(data, "probeId"), Now(), Now()};
    clock_.Probe(probe);
    return {{"epoch", epoch}, {"probeId", probe.id}, {"rtcBeforeUs", probe.rtc_before_us},
            {"rtcAfterUs", probe.rtc_after_us}};
  }
  if (command == "calibrate") {
    Keys(data, {"epoch", "probeId", "rendererBeforeUs", "rendererAfterUs"});
    const auto result = clock_.Calibrate(epoch, Id(data, "probeId"),
        Integer(data, "rendererBeforeUs", 0, kMaxId),
        Integer(data, "rendererAfterUs", 0, kMaxId), Now());
    return {{"epoch", epoch}, {"calibrationId", result.id},
            {"offsetUs", result.offset_us}, {"uncertaintyUs", result.uncertainty_us}};
  }
  if (command == "feedback") {
    RendererPlayoutFeedback feedback;
    feedback.epoch = epoch;
    feedback.available = Boolean(data, "available");
    if (feedback.available) {
      Keys(data, {"epoch", "available", "clockEpoch", "calibrationId", "atPerformanceTimeUs",
                  "estimatedPlayoutFrame", "confirmedPcmEnd", "feedbackAgeUs", "outputClockAgeUs"});
      feedback.clock_epoch = Id(data, "clockEpoch");
      feedback.calibration_id = Id(data, "calibrationId");
      feedback.at_performance_us = Integer(data, "atPerformanceTimeUs", 0, kMaxId);
      feedback.feedback_age_us = Integer(data, "feedbackAgeUs", 0, 200000);
      feedback.output_clock_age_us = Integer(data, "outputClockAgeUs", 0, 200000);
      if (!data.at("estimatedPlayoutFrame").is_number()) Invalid("Expected physical sample estimate");
      feedback.estimated_playout_frame = data.at("estimatedPlayoutFrame").get<double>();
      feedback.confirmed_pcm_end = Integer(data, "confirmedPcmEnd", 0, kMaxId);
    } else Keys(data, {"epoch", "available"});
    clock_.Feedback(feedback, Now(), current.mixed_frame_cursor);
    return Json::object();
  }
  Invalid("Unknown direct audio metadata command");
}
bool AudioRuntime::OnPcm(const PlayoutPacket& packet) noexcept {
  try {
    {
      std::lock_guard lock(mutex_);
      if (stopping_ || !output_epoch_.Accepts(packet.epoch) ||
          output_.size() >= kCapacityFrames / kBlockFrames ||
          !output_.emplace(std::pair(packet.epoch, packet.sequence), packet).second) return false;
    }
    return host_.Emit("audio.playout", 0, {{"epoch", packet.epoch}, {"sequence", packet.sequence},
        {"firstPlayoutFrame", packet.first_playout_frame}, {"frames", packet.frames},
        {"sampleRate", packet.sample_rate}, {"channels", packet.channels}});
  } catch (...) { return false; }
}
void AudioRuntime::OnPlayoutStarted(std::uint64_t) noexcept {
  // Pair the state transition with the waiter's mutex so a resume notification
  // cannot be lost between its predicate check and wait.
  {
    std::lock_guard lock(mutex_);
    if (stopping_) return;
  }
  wake_playout_.notify_one();
}
void AudioRuntime::InvalidateOutput(std::uint64_t epoch) {
  output_epoch_.Invalidate(epoch);
  clock_.Stop(epoch);
  std::lock_guard lock(mutex_);
  RetireOutputPackets(output_, epoch);
}
void AudioRuntime::OnInvalidated(std::uint64_t epoch, PlayoutOutput::StopReason reason) noexcept {
  try {
    if (!epoch) return;
    InvalidateOutput(epoch);
    const auto* text = StopReasonText(reason);
    if (!text) throw std::logic_error("Invalid internal output stop reason");
    host_.Emit(MONKY_ENGINE_AUDIO_INVALIDATED, 0, {{"epoch", epoch}, {"reason", text}});
  } catch (...) {
    host_.Emit("error", 0, nullptr);
  }
}
void AudioRuntime::OnFailure(std::uint64_t epoch, Failure) noexcept {
  try {
    if (!epoch) return;
    OnInvalidated(epoch, PlayoutOutput::StopReason::MixerFailure);
    host_.Emit("audio.outputError", 0, {{"epoch", epoch}, {"code", "ERR_RTC_AUDIO_OUTPUT"},
        {"message", "Audio output epoch failed; select/recreate a new output epoch"},
        {"status", MONKY_ENGINE_FAILURE}, {"hresult", 0}, {"terminal", false}});
  } catch (...) {}
}
void AudioRuntime::ReadOutput(std::uint64_t epoch, std::uint64_t sequence, MonkyEngineAudioPlayout& packet) {
  if (packet.struct_size != sizeof(packet) ||
      packet.extension_version != MONKY_ENGINE_AUDIO_EXTENSION_VERSION)
    Invalid("Invalid audio output POD");
  std::lock_guard lock(mutex_);
  const auto found = output_.find(std::pair(epoch, sequence));
  if (found == output_.end()) throw Error("ERR_RTC_AUDIO_PACKET_NOT_FOUND", "Mixed PCM is retired/stale", MONKY_ENGINE_NOT_FOUND);
  const auto& input = found->second;
  packet.epoch = epoch; packet.sequence = sequence; packet.first_playout_frame = input.first_playout_frame;
  packet.frames = input.frames; packet.sample_rate = input.sample_rate; packet.channels = input.channels;
  packet.reserved = 0;
  std::copy(input.samples.begin(), input.samples.end(), packet.samples);
  packet.mixer_elapsed_time_ms = input.mixer_elapsed_time_ms.value_or(-1);
  packet.mixer_ntp_time_ms = input.mixer_ntp_time_ms.value_or(-1);
  output_.erase(found);
}
bool AudioRuntime::OutputReady(std::uint64_t expected_epoch) const {
  const auto state = adm_->Snapshot();
  return state.HasOutputEpoch(expected_epoch) && output_epoch_.Accepts(state.epoch);
}
Json AudioRuntime::Snapshot() const {
  const auto state = adm_->Snapshot();
  std::lock_guard lock(mutex_);
  return {{"epoch", state.epoch}, {"playing", state.playing}, {"failed", state.failed},
          {"outputConfigured", state.HasOutputEpoch() && output_epoch_.Accepts(state.epoch)},
          {"creditFrames", state.credit_frames}, {"mixedFrameCursor", state.mixed_frame_cursor},
          {"pendingPackets", pending_.size()}, {"queuedOutputPackets", output_.size()}};
}
void AudioRuntime::Stop() {
  {
    std::lock_guard lock(mutex_);
    stopping_ = true;
  }
  adm_->EndPlayout(PlayoutOutput::StopReason::EngineClose);
  clock_.Stop();
  wake_capture_.notify_all();
  wake_playout_.notify_all();
  if (capture_thread_.joinable()) capture_thread_.join();
  if (playout_thread_.joinable()) playout_thread_.join();
  std::lock_guard lock(mutex_);
  output_.clear();
}

}  // namespace monky::native_rtc::engine::audio
