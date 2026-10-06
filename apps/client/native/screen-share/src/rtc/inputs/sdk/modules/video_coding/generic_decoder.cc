/*
 *  Copyright (c) 2012 The WebRTC project authors. All Rights Reserved.
 *
 *  Use of this source code is governed by a BSD-style license
 *  that can be found in the LICENSE file in the root of the source
 *  tree. An additional intellectual property rights grant can be found
 *  in the file PATENTS.  All contributing project authors may
 *  be found in the AUTHORS file in the root of the source tree.
 */

#include "modules/video_coding/generic_decoder.h"

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <iterator>
#include <optional>
#include <tuple>
#include <utility>
#include <variant>

#include "absl/algorithm/container.h"
#include "api/field_trials_view.h"
#include "api/units/time_delta.h"
#include "api/units/timestamp.h"
#include "api/video/color_space.h"
#include "api/video/encoded_frame.h"
#include "api/video/encoded_image.h"
#include "api/video/video_content_type.h"
#include "api/video/video_frame.h"
#include "api/video/video_frame_type.h"
#include "api/video/video_timing.h"
#include "api/video_codecs/video_decoder.h"
#include "common_video/frame_instrumentation_data.h"
#include "common_video/include/corruption_score_calculator.h"
#include "modules/include/module_common_types_public.h"
#include "modules/video_coding/encoded_frame.h"
#include "modules/video_coding/include/video_coding_defines.h"
#include "modules/video_coding/include/video_error_codes.h"
#include "modules/video_coding/timing/timing.h"
#include "rtc_base/checks.h"
#include "rtc_base/logging.h"
#include "rtc_base/synchronization/mutex.h"
#include "rtc_base/trace_event.h"
#include "system_wrappers/include/clock.h"
#include "system_wrappers/include/metrics.h"

namespace webrtc {

namespace {

constexpr size_t kDecoderFrameMemoryLength = 10;

class MonkyDecodeLeaseCall final {
 public:
  explicit MonkyDecodeLeaseCall(std::shared_ptr<MonkyDecoderFrameInfoLease> lease)
      : lease_(std::move(lease)) {}
  ~MonkyDecodeLeaseCall() { if (!accepted_) lease_->Invalidate(); }
  void Accepted() { accepted_ = true; }
 private:
  const std::shared_ptr<MonkyDecoderFrameInfoLease> lease_;
  bool accepted_ = false;
};

}  // namespace

VCMDecodedFrameCallback::VCMDecodedFrameCallback(
    VCMTiming* timing,
    Clock* clock,
    const FieldTrialsView& /* field_trials */,
    CorruptionScoreCalculator* corruption_score_calculator)
    : _clock(clock),
      _timing(timing),
      corruption_score_calculator_(corruption_score_calculator) {
  ntp_offset_ =
      _clock->CurrentNtpInMilliseconds() - _clock->TimeInMilliseconds();
}

VCMDecodedFrameCallback::~VCMDecodedFrameCallback() {}

void VCMDecodedFrameCallback::SetUserReceiveCallback(
    VCMReceiveCallback* receiveCallback) {
  RTC_DCHECK(construction_thread_.IsCurrent());
  RTC_DCHECK((!_receiveCallback && receiveCallback) ||
             (_receiveCallback && !receiveCallback));
  _receiveCallback = receiveCallback;
}

VCMReceiveCallback* VCMDecodedFrameCallback::UserReceiveCallback() {
  // Called on the decode thread via VCMCodecDataBase::GetDecoder.
  // The callback must always have been set before this happens.
  RTC_DCHECK(_receiveCallback);
  return _receiveCallback;
}

int32_t VCMDecodedFrameCallback::Decoded(VideoFrame& decodedImage) {
  // This function may be called on the decode TaskQueue, but may also be called
  // on an OS provided queue such as on iOS (see e.g. b/153465112).
  return Decoded(decodedImage, -1);
}

int32_t VCMDecodedFrameCallback::Decoded(VideoFrame& decodedImage,
                                         int64_t decode_time_ms) {
  Decoded(decodedImage,
          decode_time_ms >= 0 ? std::optional<int32_t>(decode_time_ms)
                              : std::nullopt,
          std::nullopt);
  return WEBRTC_VIDEO_CODEC_OK;
}

std::pair<std::optional<FrameInfo>, size_t>
VCMDecodedFrameCallback::FindFrameInfo(uint32_t rtp_timestamp, size_t* retired) {
  *retired = PruneFrameInfoLeasesLocked();
  std::optional<FrameInfo> frame_info;
  size_t leased_dropped = 0;
  if (!monky_frame_infos_.empty()) {
    auto it = absl::c_find_if(monky_frame_infos_, [rtp_timestamp](const auto& entry) {
      return entry.rtp_timestamp == rtp_timestamp ||
             IsNewerTimestamp(entry.rtp_timestamp, rtp_timestamp);
    });
    leased_dropped = std::distance(monky_frame_infos_.begin(), it);
    if (it != monky_frame_infos_.end() && it->rtp_timestamp == rtp_timestamp) {
      if (auto owned = it->info.lock()) frame_info = std::move(*owned);
      else ++*retired;
      ++it;
    }
    monky_frame_infos_.erase(monky_frame_infos_.begin(), it);
  }

  auto it = absl::c_find_if(frame_infos_, [rtp_timestamp](const auto& entry) {
    return entry.rtp_timestamp == rtp_timestamp ||
           IsNewerTimestamp(entry.rtp_timestamp, rtp_timestamp);
  });
  size_t dropped_frames = leased_dropped + std::distance(frame_infos_.begin(), it);

  if (it != frame_infos_.end() && it->rtp_timestamp == rtp_timestamp) {
    // Frame was found and should also be removed from the queue.
    // A leased match belongs to the current configured decoder, not an
    // older legacy entry with a reused RTP value after replacement.
    if (frame_info) ++dropped_frames;
    else frame_info = std::move(*it);
    ++it;
  }

  frame_infos_.erase(frame_infos_.begin(), it);
  return std::make_pair(std::move(frame_info), dropped_frames);
}

void VCMDecodedFrameCallback::Decoded(VideoFrame& decodedImage,
                                      std::optional<int32_t> decode_time_ms,
                                      std::optional<uint8_t> qp) {
  RTC_DCHECK(_receiveCallback) << "Callback must not be null at this point";
  TRACE_EVENT(
      "webrtc", "VCMDecodedFrameCallback::Decoded",
      perfetto::TerminatingFlow::ProcessScoped(decodedImage.rtp_timestamp()));
  // TODO(holmer): We should improve this so that we can handle multiple
  // callbacks from one call to Decode().
  std::optional<FrameInfo> frame_info;
  int timestamp_map_size = 0;
  size_t retired = 0;
  int dropped_frames = 0;
  {
    MutexLock lock(&lock_);
    std::tie(frame_info, dropped_frames) =
        FindFrameInfo(decodedImage.rtp_timestamp(), &retired);
    timestamp_map_size = frame_infos_.size() + monky_frame_infos_.size();
  }
  ReportFrameInfoRetirements(retired);
  if (dropped_frames > 0) {
    _receiveCallback->OnDroppedFrames(dropped_frames);
  }

  if (!frame_info) {
    _receiveCallback->OnMonkyDecoderTimestampMap(
        MonkyDecoderTimestampMapEvent::kMissingCallback, dropped_frames);
    RTC_LOG(LS_WARNING) << "Too many frames backed up in the decoder, dropping "
                           "frame with timestamp "
                        << decodedImage.rtp_timestamp();
    return;
  }

  decodedImage.set_ntp_time_ms(frame_info->ntp_time_ms);
  decodedImage.set_packet_infos(frame_info->packet_infos);
  decodedImage.set_rotation(frame_info->rotation);
  decodedImage.set_color_space(frame_info->color_space);
  VideoFrame::RenderParameters render_parameters = _timing->RenderParameters();
  if (render_parameters.max_composition_delay_in_frames) {
    // Subtract frames that are in flight.
    render_parameters.max_composition_delay_in_frames =
        std::max(0, *render_parameters.max_composition_delay_in_frames -
                        timestamp_map_size);
  }
  decodedImage.set_render_parameters(render_parameters);

  RTC_DCHECK(frame_info->decode_start);
  const Timestamp now = _clock->CurrentTime();
  const TimeDelta decode_time = decode_time_ms
                                    ? TimeDelta::Millis(*decode_time_ms)
                                    : now - *frame_info->decode_start;
  _timing->StopDecodeTimer(decode_time, now);
  decodedImage.set_processing_time(
      {*frame_info->decode_start, *frame_info->decode_start + decode_time});

  // Report timing information.
  TimingFrameInfo timing_frame_info;
  if (frame_info->timing.flags != VideoSendTiming::kInvalid) {
    int64_t capture_time_ms = decodedImage.ntp_time_ms() - ntp_offset_;
    // Convert remote timestamps to local time from ntp timestamps.
    frame_info->timing.encode_start_ms -= ntp_offset_;
    frame_info->timing.encode_finish_ms -= ntp_offset_;
    frame_info->timing.packetization_finish_ms -= ntp_offset_;
    frame_info->timing.pacer_exit_ms -= ntp_offset_;
    frame_info->timing.network_timestamp_ms -= ntp_offset_;
    frame_info->timing.network2_timestamp_ms -= ntp_offset_;

    int64_t sender_delta_ms = 0;
    if (decodedImage.ntp_time_ms() < 0) {
      // Sender clock is not estimated yet. Make sure that sender times are all
      // negative to indicate that. Yet they still should be relatively correct.
      sender_delta_ms =
          std::max({capture_time_ms, frame_info->timing.encode_start_ms,
                    frame_info->timing.encode_finish_ms,
                    frame_info->timing.packetization_finish_ms,
                    frame_info->timing.pacer_exit_ms,
                    frame_info->timing.network_timestamp_ms,
                    frame_info->timing.network2_timestamp_ms}) +
          1;
    }

    timing_frame_info.capture_time_ms = capture_time_ms - sender_delta_ms;
    timing_frame_info.encode_start_ms =
        frame_info->timing.encode_start_ms - sender_delta_ms;
    timing_frame_info.encode_finish_ms =
        frame_info->timing.encode_finish_ms - sender_delta_ms;
    timing_frame_info.packetization_finish_ms =
        frame_info->timing.packetization_finish_ms - sender_delta_ms;
    timing_frame_info.pacer_exit_ms =
        frame_info->timing.pacer_exit_ms - sender_delta_ms;
    timing_frame_info.network_timestamp_ms =
        frame_info->timing.network_timestamp_ms - sender_delta_ms;
    timing_frame_info.network2_timestamp_ms =
        frame_info->timing.network2_timestamp_ms - sender_delta_ms;
    RTC_HISTOGRAM_COUNTS_1000(
        "WebRTC.Video.GenericDecoder.CaptureToEncodeDelay",
        timing_frame_info.encode_start_ms - timing_frame_info.capture_time_ms);
    RTC_HISTOGRAM_COUNTS_1000(
        "WebRTC.Video.GenericDecoder.EncodeDelay",
        timing_frame_info.encode_finish_ms - timing_frame_info.encode_start_ms);
    RTC_HISTOGRAM_COUNTS_1000(
        "WebRTC.Video.GenericDecoder.PacerAndPacketizationDelay",
        timing_frame_info.pacer_exit_ms - timing_frame_info.encode_finish_ms);
  }

  timing_frame_info.flags = frame_info->timing.flags;
  timing_frame_info.decode_start_ms = frame_info->decode_start->ms();
  timing_frame_info.decode_finish_ms = now.ms();
  timing_frame_info.render_time_ms =
      frame_info->render_time ? frame_info->render_time->ms() : -1;
  timing_frame_info.rtp_timestamp = decodedImage.rtp_timestamp();
  timing_frame_info.receive_start_ms = frame_info->timing.receive_start_ms;
  timing_frame_info.receive_finish_ms = frame_info->timing.receive_finish_ms;
  RTC_HISTOGRAM_COUNTS_1000(
      "WebRTC.Video.GenericDecoder.PacketReceiveDelay",
      timing_frame_info.receive_finish_ms - timing_frame_info.receive_start_ms);
  RTC_HISTOGRAM_COUNTS_1000(
      "WebRTC.Video.GenericDecoder.JitterBufferDelay",
      timing_frame_info.decode_start_ms - timing_frame_info.receive_finish_ms);
  RTC_HISTOGRAM_COUNTS_1000(
      "WebRTC.Video.GenericDecoder.DecodeDelay",
      timing_frame_info.decode_finish_ms - timing_frame_info.decode_start_ms);
  _timing->SetTimingFrameInfo(timing_frame_info);

  decodedImage.set_timestamp_us(
      frame_info->render_time ? frame_info->render_time->us() : -1);
  _receiveCallback->OnFrameToRender({.video_frame = decodedImage,
                                     .qp = qp,
                                     .decode_time = decode_time,
                                     .content_type = frame_info->content_type,
                                     .frame_type = frame_info->frame_type});
  _receiveCallback->OnMonkyDecoderTimestampMap(
      MonkyDecoderTimestampMapEvent::kMappedCallback, dropped_frames);

  if (corruption_score_calculator_ &&
      frame_info->frame_instrumentation_data.has_value()) {
    if (const FrameInstrumentationData* data =
            std::get_if<FrameInstrumentationData>(
                &*frame_info->frame_instrumentation_data)) {
      corruption_score_calculator_->CalculateCorruptionScore(
          decodedImage, *data, frame_info->content_type);
    }
  }
}

void VCMDecodedFrameCallback::OnDecoderInfoChanged(
    const VideoDecoder::DecoderInfo& decoder_info) {
  _receiveCallback->OnDecoderInfoChanged(decoder_info);
}

void VCMDecodedFrameCallback::Map(FrameInfo frameInfo) {
  int dropped_frames = 0;
  {
    MutexLock lock(&lock_);
    dropped_frames = MapLegacyLocked(std::move(frameInfo));
  }
  ReportLegacyEvictions(dropped_frames);
}

// Weak indices never retain metadata after the native admission/callback ends.
// Cleanup notifications run only on an existing SDK call, never from a foreign
// lease destructor or after its callback owner has been destroyed.
int VCMDecodedFrameCallback::MapLegacyLocked(FrameInfo frame_info) {
  int dropped_frames = 0;
  if (frame_infos_.size() == kDecoderFrameMemoryLength) {
    frame_infos_.pop_front();
    dropped_frames = 1;
  }
  frame_infos_.push_back(std::move(frame_info));
  return dropped_frames;
}

void VCMDecodedFrameCallback::ReportLegacyEvictions(int dropped_frames) {
  if (dropped_frames > 0) {
    _receiveCallback->OnDroppedFrames(dropped_frames);
    _receiveCallback->OnMonkyDecoderTimestampMap(
        MonkyDecoderTimestampMapEvent::kOverflowEviction, dropped_frames);
  }
}

size_t VCMDecodedFrameCallback::PruneFrameInfoLeasesLocked() {
  size_t retired = 0;
  for (auto it = monky_frame_infos_.begin(); it != monky_frame_infos_.end();) {
    const auto owned = it->info.lock();
    if (!owned || !owned->IsLive() || it->scope.expired()) {
      it = monky_frame_infos_.erase(it);
      ++retired;
    } else {
      ++it;
    }
  }
  return retired;
}

void VCMDecodedFrameCallback::ReportFrameInfoRetirements(size_t retired) {
  if (!retired || !_receiveCallback) return;
  _receiveCallback->OnDroppedFrames(static_cast<uint32_t>(retired));
  _receiveCallback->OnMonkyDecoderTimestampMap(
      MonkyDecoderTimestampMapEvent::kLeaseRetirement, static_cast<uint32_t>(retired));
}

void VCMDecodedFrameCallback::PruneFrameInfoLeases() {
  size_t retired;
  {
    MutexLock lock(&lock_);
    retired = PruneFrameInfoLeasesLocked();
  }
  ReportFrameInfoRetirements(retired);
}

std::shared_ptr<MonkyDecoderFrameInfoLease> VCMDecodedFrameCallback::MapWithLease(
    FrameInfo frame_info, uint32_t maximum_pending,
    const std::shared_ptr<const MonkyDecoderFrameInfoScope>& scope) {
  std::shared_ptr<FrameInfo> lease;
  size_t retired;
  {
    MutexLock lock(&lock_);
    retired = PruneFrameInfoLeasesLocked();
    // The decoder retains at most N admissions through callback completion.
    // One existing serial Decode call can additionally own its provisional.
    const uint64_t limit = static_cast<uint64_t>(maximum_pending) + 1;
    if (maximum_pending && scope && monky_frame_infos_.size() < limit) {
      lease = std::make_shared<FrameInfo>(std::move(frame_info));
      monky_frame_infos_.push_back({lease->rtp_timestamp, lease, scope});
    }
  }
  ReportFrameInfoRetirements(retired);
  return lease;
}

void VCMDecodedFrameCallback::DiscardFrameInfoLease(
    const std::shared_ptr<MonkyDecoderFrameInfoLease>& lease) {
  if (!lease) return;
  size_t retired = 0;
  {
    MutexLock lock(&lock_);
    for (auto it = monky_frame_infos_.begin(); it != monky_frame_infos_.end(); ++it) {
      if (it->info.lock() == lease) {
        monky_frame_infos_.erase(it);
        retired = 1;
        break;
      }
    }
  }
  ReportFrameInfoRetirements(retired);
}

void VCMDecodedFrameCallback::TransferFrameInfoLeaseToLegacy(
    const std::shared_ptr<MonkyDecoderFrameInfoLease>& lease) {
  int dropped_frames = 0;
  {
    MutexLock lock(&lock_);
    for (auto it = monky_frame_infos_.begin(); it != monky_frame_infos_.end(); ++it) {
      if (auto owned = it->info.lock(); owned && owned == lease) {
        MonkyDecodeLeaseCall transfer(lease);
        // Callback lookup must see the weak entry or the legacy entry, never
        // an unlocked gap between removing one and inserting the other.
        dropped_frames = MapLegacyLocked(std::move(*owned));
        monky_frame_infos_.erase(it);
        transfer.Accepted();
        break;
      }
    }
  }
  ReportLegacyEvictions(dropped_frames);
}

void VCMDecodedFrameCallback::ClearTimestampMap() {
  int dropped_frames = 0;
  {
    MutexLock lock(&lock_);
    dropped_frames = frame_infos_.size() + monky_frame_infos_.size();
    frame_infos_.clear();
    monky_frame_infos_.clear();
  }
  if (_receiveCallback) {
    _receiveCallback->OnMonkyDecoderTimestampMap(
        MonkyDecoderTimestampMapEvent::kClear, dropped_frames);
  }
  if (dropped_frames > 0) {
    _receiveCallback->OnDroppedFrames(dropped_frames);
  }
}

VCMGenericDecoder::VCMGenericDecoder(VideoDecoder* decoder)
    : _callback(nullptr),
      decoder_(decoder),
      _last_keyframe_content_type(VideoContentType::UNSPECIFIED) {
  RTC_DCHECK(decoder_);
}

VCMGenericDecoder::~VCMGenericDecoder() {
  decoder_->Release();
}

bool VCMGenericDecoder::Configure(const VideoDecoder::Settings& settings) {
  TRACE_EVENT0("webrtc", "VCMGenericDecoder::Configure");

  bool ok = decoder_->Configure(settings);
  decoder_info_ = decoder_->GetDecoderInfo();
  if (decoder_info_.monky_frame_info_lease_limit) {
    if (ok || !monky_frame_info_scope_)
      monky_frame_info_scope_ = std::make_shared<const MonkyDecoderFrameInfoScope>();
  } else {
    monky_frame_info_scope_.reset();
  }
  RTC_LOG(LS_INFO) << "Decoder implementation: " << decoder_info_.ToString();
  if (_callback) {
    _callback->OnDecoderInfoChanged(decoder_info_);
  }
  return ok;
}

int32_t VCMGenericDecoder::Decode(const EncodedFrame& frame, Timestamp now) {
  return Decode(frame, now, frame.RenderTimeMs(),
                frame.CodecSpecific()->frame_instrumentation_data);
}

int32_t VCMGenericDecoder::Decode(const VCMEncodedFrame& frame, Timestamp now) {
  return Decode(frame, now, frame.RenderTimeMs(),
                frame.CodecSpecific()->frame_instrumentation_data);
}

int32_t VCMGenericDecoder::Decode(
    const EncodedImage& frame,
    Timestamp now,
    int64_t render_time_ms,
    const std::optional<
        std::variant<FrameInstrumentationSyncData, FrameInstrumentationData>>&
        frame_instrumentation_data) {
  TRACE_EVENT("webrtc", "VCMGenericDecoder::Decode",
              perfetto::Flow::ProcessScoped(frame.RtpTimestamp()));
  FrameInfo frame_info;
  frame_info.rtp_timestamp = frame.RtpTimestamp();
  frame_info.decode_start = now;
  frame_info.render_time =
      render_time_ms >= 0
          ? std::make_optional(Timestamp::Millis(render_time_ms))
          : std::nullopt;
  frame_info.rotation = frame.rotation();
  frame_info.timing = frame.video_timing();
  frame_info.ntp_time_ms = frame.ntp_time_ms_;
  frame_info.packet_infos = frame.PacketInfos();
  frame_info.frame_instrumentation_data = frame_instrumentation_data;
  const webrtc::ColorSpace* color_space = frame.ColorSpace();
  if (color_space)
    frame_info.color_space = *color_space;

  // Set correctly only for key frames. Thus, use latest key frame
  // content type. If the corresponding key frame was lost, decode will fail
  // and content type will be ignored.
  if (frame.FrameType() == VideoFrameType::kVideoFrameKey) {
    frame_info.content_type = frame.contentType();
    _last_keyframe_content_type = frame.contentType();
  } else {
    frame_info.content_type = _last_keyframe_content_type;
  }
  frame_info.frame_type = frame.FrameType();
  std::shared_ptr<MonkyDecoderFrameInfoLease> lease;
  const bool leased = decoder_info_.monky_frame_info_lease_limit.has_value();
  int32_t ret;
  if (leased) {
    lease = _callback->MapWithLease(std::move(frame_info),
        *decoder_info_.monky_frame_info_lease_limit, monky_frame_info_scope_);
    if (!lease) return WEBRTC_VIDEO_CODEC_MEMORY;
    MonkyDecodeLeaseCall call(lease);
    EncodedImage provisional(frame);
    provisional.SetMonkyFrameInfoLease(lease);
    ret = decoder_->Decode(provisional, render_time_ms);
    if (ret >= WEBRTC_VIDEO_CODEC_OK && ret != WEBRTC_VIDEO_CODEC_NO_OUTPUT)
      call.Accepted();
  } else {
    _callback->Map(std::move(frame_info));
    ret = decoder_->Decode(frame, render_time_ms);
  }
  VideoDecoder::DecoderInfo decoder_info = decoder_->GetDecoderInfo();
  if (decoder_info != decoder_info_) {
    RTC_LOG(LS_INFO) << "Changed decoder implementation to: "
                     << decoder_info.ToString();
    decoder_info_ = decoder_info;
    if (!decoder_info_.monky_frame_info_lease_limit) {
      // A fallback wrapper can switch implementation inside Decode. Keep
      // its current successful input under the original legacy policy.
      if (leased && ret >= WEBRTC_VIDEO_CODEC_OK && ret != WEBRTC_VIDEO_CODEC_NO_OUTPUT)
        _callback->TransferFrameInfoLeaseToLegacy(lease);
      monky_frame_info_scope_.reset();
    } else if (!monky_frame_info_scope_) {
      monky_frame_info_scope_ = std::make_shared<const MonkyDecoderFrameInfoScope>();
    }
    if (decoder_info.implementation_name.empty()) {
      decoder_info.implementation_name = "unknown";
    }
    _callback->OnDecoderInfoChanged(std::move(decoder_info));
  }
  if (ret < WEBRTC_VIDEO_CODEC_OK || ret == WEBRTC_VIDEO_CODEC_NO_OUTPUT) {
    if (leased) _callback->DiscardFrameInfoLease(lease);
    else _callback->ClearTimestampMap();
  }
  lease.reset();
  if (leased) _callback->PruneFrameInfoLeases();
  return ret;
}

int32_t VCMGenericDecoder::RegisterDecodeCompleteCallback(
    VCMDecodedFrameCallback* callback) {
  _callback = callback;
  int32_t ret = decoder_->RegisterDecodeCompleteCallback(callback);
  if (callback && !decoder_info_.implementation_name.empty()) {
    callback->OnDecoderInfoChanged(decoder_info_);
  }
  return ret;
}

}  // namespace webrtc
