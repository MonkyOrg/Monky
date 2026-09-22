#pragma once

#include "engine_shared.h"
#include "api\stats\rtc_stats_report.h"
#include "api\stats\rtcstats_objects.h"

#include <algorithm>
#include <array>
#include <map>
#include <utility>

#if !defined(MONKY_RTC_RECEIVE_DIAGNOSTICS_REVISION) || MONKY_RTC_RECEIVE_DIAGNOSTICS_REVISION != 1
#error The native diagnostic build requires its pinned typed RTC receive overlay.
#endif

namespace monky::native_rtc::engine {

// Clear events include empty clears. Timestamp-map skip events count callbacks
// removing older mappings (whether the callback matched or missed); buffer skip
// events count positive aggregate delta reports, not temporal units or policies.
inline Json ObserveRtcReceiveStreamDiagnostics(const webrtc::RTCStatsReport& report) {
  constexpr std::size_t kMaximumStreams = 128, kMaximumRowsPerStream = 64;
  if (!report.timestamp().IsFinite())
    throw Error("ERR_RTC_STATS", "RTC receive diagnostics require a finite report timestamp");
  Json streams = Json::array();
  std::map<std::pair<std::uint64_t, std::uint32_t>, std::size_t> known;
  std::map<std::uint64_t, std::uint32_t> instances;
  for (const auto* row : report.GetStatsOfType<webrtc::RTCInboundRtpStreamStats>()) {
    if (!row->kind || *row->kind != "video") continue;
    if (row->id().empty() || row->id().size() > 256)
      throw Error("ERR_RTC_STATS", "RTC receive diagnostics exceed their identity bound");
    if (!row->timestamp().IsFinite())
      throw Error("ERR_RTC_STATS", "RTC receive diagnostics require a finite row timestamp");
    const auto instance = row->monky_receive_stream_instance_id;
    const auto ssrc = row->monky_receive_stream_ssrc;
    if ((instance && *instance == 0) || (ssrc && row->ssrc && *ssrc != *row->ssrc))
      throw Error("ERR_RTC_STATS", "RTC receive diagnostics have an inconsistent real stream scope");
    const std::array values{
        row->monky_decoder_timestamp_map_overflow_evictions,
        row->monky_decoder_timestamp_map_missing_callbacks,
        row->monky_decoder_timestamp_map_skipped_mappings,
        row->monky_decoder_timestamp_map_skip_events,
        row->monky_decoder_timestamp_map_cleared_mappings,
        row->monky_decoder_timestamp_map_clear_events,
        row->monky_decoder_timestamp_map_mapped_callbacks,
        row->monky_frame_buffer_skipped_frames,
        row->monky_frame_buffer_skip_events,
        row->monky_frame_buffer_cleared_frames,
        row->monky_frame_buffer_clear_events,
        row->monky_decoder_timestamp_map_lease_retirements};
    const bool scoped = instance && ssrc && row->ssrc;
    const bool complete = scoped && std::all_of(values.begin(), values.end(),
        [](const auto& value) { return value.has_value(); });
    const bool absent = !instance && !ssrc && std::none_of(values.begin(), values.end(),
        [](const auto& value) { return value.has_value(); });
    const char* availability = complete ? "observed" :
        absent ? "unobserved" : "incomplete-sdk-observation";
    Json counters = nullptr;
    if (complete) {
      counters = {
          {"timestampMap", {{"overflowEvictions", *values[0]}, {"missingCallbacks", *values[1]},
              {"skippedMappings", *values[2]}, {"skipEvents", *values[3]},
              {"clearedMappings", *values[4]}, {"clearEvents", *values[5]},
              {"mappedCallbacks", *values[6]}, {"leaseRetirements", *values[11]}}},
          {"frameBuffer", {{"skippedFrames", *values[7]}, {"skipEvents", *values[8]},
              {"clearedFrames", *values[9]}, {"clearEvents", *values[10]}}}};
    }
    Json scope = nullptr;
    if (scoped) {
      // A decimal string preserves a uint64 diagnostic ID in JavaScript.
      scope = {{"streamInstanceId", std::to_string(*instance)}, {"mediaSsrc", *ssrc}};
      const auto [it, inserted] = instances.emplace(*instance, *ssrc);
      if (!inserted && it->second != *ssrc)
        throw Error("ERR_RTC_STATS", "One receive stream instance has multiple media SSRCs");
    }
    Json rtp{{"statsId", row->id()}, {"ssrc", row->ssrc ? Json(*row->ssrc) : Json(nullptr)},
             {"timestampUs", row->timestamp().us()}};
    const auto key = std::make_pair(instance.value_or(0), ssrc.value_or(0));
    const auto found = scoped ? known.find(key) : known.end();
    if (found == known.end()) {
      if (streams.size() >= kMaximumStreams)
        throw Error("ERR_RTC_STATS", "RTC receive diagnostics exceed their stream bound");
      if (scoped) known.emplace(key, streams.size());
      streams.push_back({{"scope", std::move(scope)}, {"counters", std::move(counters)},
          {"availability", availability}, {"timestampUs", row->timestamp().us()},
          {"rtpStreams", Json::array({std::move(rtp)})}});
      continue;
    }
    auto& stream = streams.at(found->second);
    auto& rows = stream.at("rtpStreams");
    if (rows.size() >= kMaximumRowsPerStream)
      throw Error("ERR_RTC_STATS", "RTC receive diagnostics exceed their per-stream row bound");
    // Never choose a convenient newer/complete duplicate to repair a mixed
    // observation. Invalidate the whole group; retain original row timestamps.
    if (stream.at("timestampUs") != row->timestamp().us()) {
      stream["availability"] = "mixed-sdk-timestamps";
      stream["timestampUs"] = nullptr;
      stream["counters"] = nullptr;
    } else if (!complete && stream.at("availability") == "observed") {
      stream["availability"] = "incomplete-sdk-observation";
      stream["counters"] = nullptr;
    } else if (complete && stream.at("availability") == "observed" &&
               stream.at("counters") != counters) {
      stream["availability"] = "inconsistent-sdk-observation";
      stream["counters"] = nullptr;
    }
    rows.push_back(std::move(rtp));
  }
  return {{"scope", "M140-VideoReceiveStream"},
          {"resetScope", "ReceiveStatisticsProxy-instance"},
          {"instanceIdMeaning", "process-local-diagnostic-not-ownership"},
          {"counterSemantics", "saturating-uint64"},
          {"mappedCallbacksMeaning", "timestamp-matched-and-forwarded-to-OnFrameToRender"},
          {"leaseRetirementsMeaning", "exact-refusal-or-terminal-ownership-cleanup-observed-on-SDK-call"},
          {"frameBufferSkipEventsMeaning", "positive-UpdateDroppedFrames-delta"},
          {"frameBufferClearEventsMeaning", "VideoStreamBufferController-Clear"},
          {"reportTimestampUs", report.timestamp().us()}, {"streams", std::move(streams)}};
}

}  // namespace monky::native_rtc::engine
