#include "credit_audio_device.h"
#include "playout_delay.h"

#include "common_audio\include\audio_util.h"

namespace monky::native_rtc::engine::audio {

void CreditAudioDevice::BeginPlayoutEpoch(std::uint64_t epoch) {
  std::lock_guard pump(pump_mutex_);
  std::lock_guard lock(state_mutex_);
  if (!state_.initialized || state_.playing || (state_.epoch && !state_.failed))
    throw AudioError(Failure::NotReady, "Retire the owned output before attaching a new epoch");
  if (!epoch || epoch > kMaxSafeInteger || epoch <= last_epoch_)
    throw AudioError(Failure::WrongEpoch, "Playout requires a strictly newer output epoch");
  state_ = {};
  state_.initialized = true;
  state_.epoch = epoch;
  last_epoch_ = epoch;
  playout_initialized_ = false;
  speaker_initialized_ = false;
}

void CreditAudioDevice::GrantCredits(const PlayoutCredit& grant) {
  std::lock_guard lock(state_mutex_);
  if (!state_.initialized || state_.failed || !state_.epoch)
    throw AudioError(Failure::NotReady, "Playout is not ready for credits");
  if (grant.epoch != state_.epoch)
    throw AudioError(Failure::WrongEpoch, "Playout credit belongs to another output epoch");
  if (!grant.grant_sequence || grant.grant_sequence > kMaxSafeInteger ||
      grant.grant_sequence != state_.last_grant_sequence + 1 ||
      (grant.frames != 480 && grant.frames != 960))
    throw AudioError(Failure::InvalidCredit, "Playout grants must be consecutive 480/960-frame credits");
  if (grant.frames > kCapacityFrames - state_.credit_frames)
    throw AudioError(Failure::CreditOverflow, "Playout credit capacity exhausted");
  state_.last_grant_sequence = grant.grant_sequence;
  state_.credit_frames += grant.frames;
}

std::uint32_t CreditAudioDevice::DrainCredits() {
  std::lock_guard pump(pump_mutex_);
  if (playout_thread_ && *playout_thread_ != std::this_thread::get_id())
    throw AudioError(Failure::WrongThread, "RTC mixing must remain on its single playout worker");
  playout_thread_ = std::this_thread::get_id();
  for (std::uint32_t block = 0; block < kCapacityFrames / kBlockFrames; ++block) {
    PlayoutPacket packet;
    webrtc::AudioTransport* transport;
    {
      std::lock_guard lock(state_mutex_);
      if (!state_.playing || state_.failed || state_.credit_frames < kBlockFrames)
        return state_.credit_frames;
      if (!transport_) throw AudioError(Failure::Transport, "No registered RTC mixer callback");
      packet.epoch = state_.epoch;
      packet.sequence = state_.next_packet_sequence;
      packet.first_playout_frame = state_.mixed_frame_cursor;
      transport = transport_;
      state_.credit_frames -= kBlockFrames;
    }
    try {
      if (packet.sequence >= kMaxSafeInteger ||
          packet.first_playout_frame > kMaxSafeInteger - kBlockFrames)
        throw AudioError(Failure::Discontinuity, "Playout sample position exhausted");
      std::array<std::int16_t, kBlockFrames * kChannels> pcm{};
      std::size_t samples_out = 0;
      std::int64_t elapsed_ms = -1, ntp_ms = -1;
      // Pinned AudioDeviceBuffer passes BYTES PER FRAME (4), while M140
      // AudioTransportImpl returns TOTAL SAMPLES (960), not 480 channel frames.
      const auto status = transport->NeedMorePlayData(kBlockFrames,
          sizeof(std::int16_t) * kChannels, kChannels, kRate, pcm.data(),
          samples_out, &elapsed_ms, &ntp_ms);
      if (status != 0 || samples_out != pcm.size())
        throw AudioError(Failure::Transport, "RTC mixer did not return an exact stereo 10ms block");
      webrtc::S16ToFloat(pcm.data(), pcm.size(), packet.samples.data());
      if (elapsed_ms >= 0) packet.mixer_elapsed_time_ms = elapsed_ms;
      if (ntp_ms >= 0) packet.mixer_ntp_time_ms = ntp_ms;
      {
        std::lock_guard lock(state_mutex_);
        // A normal RTC pause retains this already-reserved block and its debt.
        // Only actual epoch retirement/failure may discard it.
        if (state_.epoch != packet.epoch || state_.failed) return state_.credit_frames;
        ++state_.next_packet_sequence;
        state_.mixed_frame_cursor += kBlockFrames;
      }
      if (!output_.OnPcm(packet))
        throw AudioError(Failure::OutputRejected, "Host rejected actual mixed PCM; recreate the output epoch");
    } catch (const AudioError& error) {
      FailEpoch(packet.epoch, error.failure);
      throw;
    } catch (...) {
      FailEpoch(packet.epoch, Failure::Transport);
      throw;
    }
  }
  std::lock_guard lock(state_mutex_);
  return state_.credit_frames;
}

void CreditAudioDevice::FailEpoch(std::uint64_t epoch, Failure failure) noexcept {
  {
    std::lock_guard lock(state_mutex_);
    if (state_.epoch != epoch || state_.failed) return;
    state_.failed = true;
    state_.playing = false;
    state_.credit_frames = 0;
    playout_initialized_ = false;
    speaker_initialized_ = false;
  }
  output_.OnFailure(epoch, failure);
}

PlayoutSnapshot CreditAudioDevice::Snapshot() const {
  std::lock_guard lock(state_mutex_);
  return state_;
}

int32_t CreditAudioDevice::ActiveAudioLayer(AudioLayer* layer) const {
  if (!layer) return -1;
  *layer = kDummyAudio;
  return 0;
}

int32_t CreditAudioDevice::RegisterAudioCallback(webrtc::AudioTransport* callback) {
  std::lock_guard pump(pump_mutex_);
  std::uint64_t epoch = 0;
  {
    std::lock_guard lock(state_mutex_);
    if (state_.playing && callback) return -1;
    if (!callback) {
      epoch = state_.epoch;
      state_.playing = false;
      state_.credit_frames = 0;
      state_.epoch = 0;
      playout_initialized_ = false;
      speaker_initialized_ = false;
    }
    transport_ = callback;
  }
  if (epoch) output_.OnInvalidated(epoch, PlayoutOutput::StopReason::TransportDetached);
  return 0;
}

int32_t CreditAudioDevice::Init() {
  std::lock_guard lock(state_mutex_);
  state_.initialized = true;
  return 0;
}

int32_t CreditAudioDevice::Terminate() {
  EndPlayout(PlayoutOutput::StopReason::EngineClose);
  std::lock_guard pump(pump_mutex_);
  std::lock_guard lock(state_mutex_);
  transport_ = nullptr;
  playout_thread_.reset();
  state_.initialized = false;
  return 0;
}

bool CreditAudioDevice::Initialized() const {
  std::lock_guard lock(state_mutex_);
  return state_.initialized;
}

int32_t CreditAudioDevice::PlayoutIsAvailable(bool* available) {
  std::lock_guard lock(state_mutex_);
  return Flag(available, state_.initialized && state_.epoch && !state_.failed);
}

int32_t CreditAudioDevice::InitPlayout() {
  std::lock_guard lock(state_mutex_);
  if (!state_.initialized || !state_.epoch || state_.failed || !transport_) return -1;
  playout_initialized_ = true;
  return 0;
}

bool CreditAudioDevice::PlayoutIsInitialized() const {
  std::lock_guard lock(state_mutex_);
  return playout_initialized_;
}

int32_t CreditAudioDevice::StartPlayout() {
  std::uint64_t epoch;
  {
    std::lock_guard lock(state_mutex_);
    if (!state_.initialized || !state_.epoch || state_.failed ||
        !playout_initialized_ || !transport_) return -1;
    state_.playing = true;
    epoch = state_.epoch;
  }
  output_.OnPlayoutStarted(epoch);
  return 0;
}

int32_t CreditAudioDevice::StopPlayout() {
  {
    std::lock_guard lock(state_mutex_);
    state_.playing = false;
  }
  // RTC owns activity, not the explicitly selected output. Finish an in-flight
  // block before returning; keep its epoch, sequence, cursor and unpaid credits.
  std::lock_guard pump(pump_mutex_);
  return 0;
}

int32_t CreditAudioDevice::EndPlayout(PlayoutOutput::StopReason reason) {
  std::uint64_t epoch;
  {
    std::lock_guard lock(state_mutex_);
    epoch = state_.epoch;
    state_.playing = false;
    state_.credit_frames = 0;
    state_.epoch = 0;
    playout_initialized_ = false;
    speaker_initialized_ = false;
  }
  // In-flight mixer/host callbacks finish before the caller can release their
  // owners. A subsequent start requires a new output epoch, not an old anchor.
  std::lock_guard pump(pump_mutex_);
  if (epoch) output_.OnInvalidated(epoch, reason);
  return 0;
}

bool CreditAudioDevice::Playing() const {
  std::lock_guard lock(state_mutex_);
  return state_.playing;
}

int32_t CreditAudioDevice::InitSpeaker() {
  std::lock_guard lock(state_mutex_);
  if (!state_.initialized || !state_.epoch || state_.failed) return -1;
  speaker_initialized_ = true;
  return 0;
}

bool CreditAudioDevice::SpeakerIsInitialized() const {
  std::lock_guard lock(state_mutex_);
  return speaker_initialized_;
}

int32_t CreditAudioDevice::PlayoutDelay(uint16_t* delay_ms) const {
  if (!delay_ms) return -1;
  try {
    const auto state = Snapshot();
    if (!state.playing || !state.epoch || state.failed) return -1;
    const auto feedback = clock_.Read(state.epoch);
    if (!feedback) return -1;
    const auto now = rtc_clock_.CurrentTime();
    if (!now.IsFinite()) return -1;
    std::lock_guard lock(state_mutex_);
    if (!state_.playing || state_.epoch != state.epoch) return -1;
    const auto delay = PhysicalPlayoutDelay(*feedback, state.epoch, state_.mixed_frame_cursor, now.us());
    if (!delay) return -1;
    *delay_ms = *delay;
    return 0;
  } catch (...) {
    return -1;
  }
}

}  // namespace monky::native_rtc::engine::audio
