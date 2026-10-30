#include "encoded_video_internal.h"

#include "api/field_trials.h"

namespace monky::native_rtc::engine {
namespace encoded {

void State::Recover(std::uint64_t expected_generation, std::uint64_t frame, const char* reason,
                    const char* clock_status) {
  std::deque<std::shared_ptr<Token>> discarded;
  Json feedback;
  {
    std::lock_guard publication_lock(publication);
    std::lock_guard lock(mutex);
    if (stopping.load() || failed.load() || !enabled.load() || paused || expected_generation != generation) return;
    CheckRecoveryDeadline();
    if (!recovering) { recovering = true; recovery_frames = 0; }
    ++generation; need_idr = true; ++recovery_requests;
    if (CountsAsExpiry(reason)) ++expired;
    discarded.swap(queue); recovery_discards += discarded.size();
    for (const auto& queued : discarded) queued->cancelled.store(true);
    feedback = {{"sourceId", id}, {"kind", "recovery"}, {"frameId", frame},
      {"generation", generation}, {"reason", reason}, {"mode", "next-real-idr"},
      {"maximumWaitMs", 1500}, {"keyframeConfirmed", false}};
    if (clock_status) feedback["clockStatus"] = clock_status;
  }
  Event("source.encodedFeedback", std::move(feedback));
  discarded.clear();
  wake.notify_all();
}

// RTC normally retires one dispatch within a frame. A system-wide stall (for example a network stack blocked by
// a firewall rebuilding its filters) can hold it longer than the age bound; every queued picture is stale by
// then, so they are fenced and publication resumes from the next real IDR instead of ending the share.
void State::AwaitDispatch(const std::shared_ptr<Token>& token, std::chrono::microseconds recover_after,
    std::chrono::microseconds fail_after) {
  const auto retired = [&] { return token->dispatch_retired.load() || stopping.load() || failed.load(); };
  std::unique_lock lock(mutex);
  if (wake.wait_for(lock, recover_after, retired)) return;
  lock.unlock();
  Recover(token->generation, token->metadata.frame_id, "dispatch-delayed");
  lock.lock();
  Require(wake.wait_for(lock, fail_after, retired),
      "RTC encoded dispatch exceeded its 5 s retirement bound", MONKY_ENGINE_TIMEOUT);
}

void State::DispatchRetired(Token& token, const webrtc::VideoFrameBuffer* buffer) noexcept {
  try {
    bool missing;
    {
      std::lock_guard lock(mutex);
      buffers.erase(buffer);
      const bool cancelled = token.cancelled.load() || token.generation != generation ||
          stopping.load() || !enabled.load() || failed.load();
      missing = !cancelled && token.accepted.load() + token.refused.load() < token.expected.load();
      token.unconsumed.store(missing);
      if (missing) ++unconsumed;
    }
    // Detect loss before waking the next dispatch, not when a later network
    // reference releases the compressed bytes. Dependent pictures must be fenced.
    if (missing) Recover(token.generation, token.metadata.frame_id, "rtc-unconsumed");
  } catch (const std::exception& error) { Fail("ERR_RTC_ENCODED_RECOVERY", error.what()); }
  catch (...) { Fail("ERR_RTC_ENCODED_RECOVERY", "Cannot fence discarded encoded dependencies"); }
  token.dispatch_retired.store(true);
  wake.notify_all();
}

void State::Forwarded(const Token& token) {
  std::lock_guard lock(mutex);
  if (recovering && token.generation == generation && token.metadata.keyframe && token.accepted.load()) {
    recovering = false;
    ++recovery_completions;
  }
}

void State::Retired(const Token& token) noexcept {
  bool missing = false, cancelled = false, paused_consumer = false;
  try {
    {
      std::lock_guard lock(mutex);
      retained.erase(token.metadata.frame_id);
      retained_bytes -= token.bytes.size();
      ++released;
      accepted_callbacks += token.accepted.load();
      not_sent += token.refused.load();
      cancelled = token.cancelled.load() || token.generation != generation || stopping.load() || !enabled.load();
      paused_consumer = std::any_of(rates.begin(), rates.end(), [](const auto& entry) { return entry.second == 0; });
      missing = token.unconsumed.load();
    }
    Event("source.encodedFrameReleased", {{"sourceId", id}, {"frameId", token.metadata.frame_id},
      {"acceptedCodecCallbacks", token.accepted.load()}, {"explicitlyNotSent", token.refused.load()},
      {"cancelled", cancelled}, {"unconsumed", missing}, {"pausedConsumerPresent", paused_consumer}, {"nativeCopyRetired", true},
      {"networkDeliveryConfirmed", false}});
  } catch (...) { Fail("ERR_RTC_ENCODED_RETIREMENT", "Cannot report bounded encoded copy retirement"); }
  wake.notify_all();
}

}  // namespace encoded

using namespace encoded;

void ValidateEncodedFrame(const MonkyEngineEncodedFrame& frame) {
  static_assert(std::is_nothrow_move_assignable_v<sv::H264Bitstream>);
  Require(frame.struct_size == sizeof(frame) && frame.abi_version == MONKY_ENGINE_ABI_VERSION &&
      frame.frame_id > 0 && frame.frame_id <= kMaxId && frame.data && frame.data_bytes > 0 &&
      frame.data_bytes <= kEncodedMaximumPacket && frame.keyframe <= 1 &&
      frame.timestamp_us >= 0 && frame.timestamp_us <= static_cast<std::int64_t>(kMaxId) &&
      frame.duration_us > 0 && frame.duration_us <= 1000000 &&
      frame.ntp_time_ms >= -1 && frame.ntp_time_ms <= static_cast<std::int64_t>(kMaxId) &&
      frame.timebase_numerator > 0 && frame.timebase_numerator <= INT32_MAX &&
      frame.timebase_denominator > 0 && frame.timebase_denominator <= INT32_MAX,
      "Invalid bounded Annex B input metadata");
}

EncodedFactoryBundle CreateEncodedVideoFactory(std::uint8_t maximum_level, bool av1) {
  auto context = std::make_shared<EncodedVideoContext>(maximum_level, av1);
  auto field_trials = webrtc::FieldTrials::Create(
       "WebRTC-Dav1dDecoder-CropToRenderResolution/Enabled/"
      "WebRTC-FrameDropper/Disabled/"
      "WebRTC-CongestionWindow/QueueSize:350,MinBitrate:30000,DropFrame:false/");
  Require(field_trials != nullptr, "Cannot configure encoded-video congestion control", MONKY_ENGINE_FAILURE);
  return {context, std::make_unique<Factory>(context), std::move(field_trials)};
}

std::shared_ptr<VideoSource> CreateEncodedVideoSource(Host& host, std::uint64_t id, const Json& options,
    const std::shared_ptr<Cancellation>& cancellation, const std::shared_ptr<EncodedVideoContext>& context) {
  Require(options.is_object() && options.size() >= 4 && options.size() <= 5, "Invalid encoded source options");
  for (const auto& item : options.items())
    Require(item.key() == "width" || item.key() == "height" || item.key() == "fps" ||
        item.key() == "syncGroup" || item.key() == "enabled", "Unknown encoded source option");
  auto configuration = ParseConfiguration(options);
  configuration.av1 = context->av1;
  const auto group = SyncGroup(options);
  const bool enabled = Boolean(options, "enabled");
  Require(context != nullptr, "The engine has no external-H264 factory");
  context->ValidateSource(configuration);
  std::lock_guard lock(context->mutex);
  if (const auto previous = context->source.lock())
    Require(previous->closed.load(), "Previous encoded source still owns its copy/codec state", MONKY_ENGINE_BUSY);
  cancellation->Check();
  auto source = std::make_shared<Source>(host, id, group, enabled, configuration);
  context->source = source->Shared();
  return source;
}

}  // namespace monky::native_rtc::engine
