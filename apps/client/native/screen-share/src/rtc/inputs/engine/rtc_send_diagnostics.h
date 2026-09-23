#pragma once

#include "engine_shared.h"
#include "api\stats\rtc_stats_report.h"
#include "api\stats\rtcstats_objects.h"

#include <algorithm>
#include <array>
#include <map>

#if !defined(MONKY_RTC_SEND_DROP_STATS_REVISION) || MONKY_RTC_SEND_DROP_STATS_REVISION != 1
#error The native diagnostic build requires its pinned typed RTC stats overlay.
#endif

namespace monky::native_rtc::engine {

struct RtcStatsObservation {
  std::string json;
  Json send_stream_drops = nullptr;
  Json receive_stream_diagnostics = nullptr;
};

inline Json ObserveRtcSendStreamDrops(const webrtc::RTCStatsReport& report) {
  constexpr std::size_t kMaximumStreams = 128, kMaximumSsrcs = 64;
  if (!report.timestamp().IsFinite())
    throw Error("ERR_RTC_STATS", "RTC send diagnostics require an observed finite report timestamp");
  Json streams = Json::array();
  std::map<std::vector<std::uint32_t>, std::size_t> known;
  for (const auto* row : report.GetStatsOfType<webrtc::RTCOutboundRtpStreamStats>()) {
    if (!row->kind || *row->kind != "video") continue;
    if (row->id().empty() || row->id().size() > 256)
      throw Error("ERR_RTC_STATS", "RTC send diagnostics exceed their identity bound");
    if (!row->timestamp().IsFinite())
      throw Error("ERR_RTC_STATS", "RTC send diagnostics require an observed finite timestamp");
    Json rtp{{"statsId", row->id()},
             {"ssrc", row->ssrc ? Json(*row->ssrc) : Json(nullptr)},
             {"timestampUs", row->timestamp().us()}};
    const std::array values{
        row->monky_frames_dropped_by_encoder_queue,
        row->monky_frames_dropped_by_rate_limiter,
        row->monky_frames_dropped_by_congestion_window,
        row->monky_frames_dropped_by_bad_timestamp,
        row->monky_frames_dropped_by_encoder};
    const auto complete = std::all_of(values.begin(), values.end(),
        [](const auto& value) { return value.has_value(); });
    if (!row->monky_send_stream_ssrcs || row->monky_send_stream_ssrcs->empty() ||
        !complete) {
      const bool absent = !row->monky_send_stream_ssrcs && std::none_of(values.begin(), values.end(),
          [](const auto& value) { return value.has_value(); });
      if (streams.size() >= kMaximumStreams)
        throw Error("ERR_RTC_STATS", "RTC send diagnostics exceed their stream bound");
      streams.push_back({{"scopeSsrcs", nullptr}, {"counters", nullptr},
                         {"availability", absent ? "unobserved" : "incomplete-sdk-observation"},
                         {"rtpStreams", Json::array({std::move(rtp)})}});
      continue;
    }
    auto ssrcs = *row->monky_send_stream_ssrcs;
    if (ssrcs.size() > kMaximumSsrcs)
      throw Error("ERR_RTC_STATS", "RTC send diagnostics exceed their SSRC bound");
    std::sort(ssrcs.begin(), ssrcs.end());
    if (std::adjacent_find(ssrcs.begin(), ssrcs.end()) != ssrcs.end() ||
        !row->ssrc || !std::binary_search(ssrcs.begin(), ssrcs.end(), *row->ssrc))
      throw Error("ERR_RTC_STATS", "RTC send diagnostics have an inconsistent real stream scope");
    Json counters{{"encoderQueue", *values[0]}, {"rateLimiter", *values[1]},
                  {"congestionWindow", *values[2]}, {"badTimestamp", *values[3]},
                  {"encoder", *values[4]}};
    const auto found = known.find(ssrcs);
    if (found == known.end()) {
      if (streams.size() >= kMaximumStreams)
        throw Error("ERR_RTC_STATS", "RTC send diagnostics exceed their stream bound");
      known.emplace(ssrcs, streams.size());
      streams.push_back({{"scopeSsrcs", ssrcs}, {"counters", std::move(counters)},
                         {"availability", "observed"}, {"rtpStreams", Json::array({std::move(rtp)})}});
    } else {
      auto& stream = streams.at(found->second);
      auto& rtps = stream.at("rtpStreams");
      if (stream.at("counters") != counters || rtps.size() >= kMaximumSsrcs)
        throw Error("ERR_RTC_STATS", "RTC send-stream aggregates disagree across media SSRCs");
      rtps.push_back(std::move(rtp));
    }
  }
  return {{"scope", "M140-VideoSendStream"}, {"rateLimiterMeaning", "WebRTC-FrameDropper"},
          {"reportTimestampUs", report.timestamp().us()}, {"streams", std::move(streams)}};
}

}  // namespace monky::native_rtc::engine
