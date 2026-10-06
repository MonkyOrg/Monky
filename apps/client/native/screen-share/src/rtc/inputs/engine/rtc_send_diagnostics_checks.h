#pragma once

#include "rtc_send_diagnostics.h"

namespace monky::native_rtc::engine {
namespace rtc_diagnostic_checks_detail {

inline std::unique_ptr<webrtc::RTCOutboundRtpStreamStats> Row(
    const std::string& id, std::uint32_t ssrc, bool observed) {
  auto row = std::make_unique<webrtc::RTCOutboundRtpStreamStats>(
      id, webrtc::Timestamp::Micros(606000));
  row->kind = "video";
  row->ssrc = ssrc;
  if (observed) {
    row->monky_send_stream_ssrcs = std::vector<std::uint32_t>{ssrc};
    row->monky_frames_dropped_by_encoder_queue = 0;
    row->monky_frames_dropped_by_rate_limiter = 0;
    row->monky_frames_dropped_by_congestion_window = 0;
    row->monky_frames_dropped_by_bad_timestamp = 0;
    row->monky_frames_dropped_by_encoder = 0;
  }
  return row;
}

}  // namespace rtc_diagnostic_checks_detail

template <typename Check>
void RunRtcSendDiagnosticChecks(Check&& check) {
  using rtc_diagnostic_checks_detail::Row;
  const auto report = [] { return webrtc::RTCStatsReport::Create(webrtc::Timestamp::Micros(606000)); };
  Json not_collected = nullptr;
  auto empty = report();
  auto observed_empty = ObserveRtcSendStreamDrops(*empty);
  check(not_collected.is_null() && observed_empty.at("streams").empty(),
        "A never-collected peer was confused with an actual empty RTC stats report");

  auto missing = report();
  missing->AddStats(Row("not-started", 7, false));
  const auto missing_json = ObserveRtcSendStreamDrops(*missing);
  check(missing_json.at("streams").front().at("counters").is_null() &&
        missing_json.at("streams").front().at("availability") == "unobserved",
        "Missing send-stream observations became zero drop counts");
  const auto missing_wire = Json::parse(missing->ToJson());
  check(!missing_wire.front().contains("monkyFramesDroppedByRateLimiter"),
        "Typed SDK serialization manufactured a missing drop member");

  auto zero = report();
  zero->AddStats(Row("actual-zero", 7, true));
  const auto zero_json = ObserveRtcSendStreamDrops(*zero);
  const auto& zero_stream = zero_json.at("streams").front();
  check(zero_stream.at("availability") == "observed" &&
        zero_stream.at("counters").at("rateLimiter") == 0 &&
        zero_stream.at("scopeSsrcs") == Json::array({7}) &&
        zero_stream.at("rtpStreams").front().at("timestampUs") == 606000,
        "Observed zero lost its real send-stream/SSRC/timestamp scope");
  const auto zero_wire = Json::parse(zero->ToJson());
  check(zero_wire.front().at("monkyFramesDroppedByRateLimiter") == 0 &&
        zero_wire.front().at("monkySendStreamSsrcs") == Json::array({7}),
        "SDK header and compiled RTCStats attribute serializer do not agree");
  const auto cloned_zero = zero->Copy();
  check(ObserveRtcSendStreamDrops(*cloned_zero) == zero_json &&
        Json::parse(cloned_zero->ToJson()) == zero_wire &&
        zero_json.at("reportTimestampUs") == 606000,
        "The real SDK report clone lost typed counters/scope or changed the original collection timestamp");

  auto distinct = report();
  auto first = Row("first-ssrc", 7, true);
  first->monky_send_stream_ssrcs = std::vector<std::uint32_t>{7, 8};
  first->monky_frames_dropped_by_encoder_queue = 11;
  first->monky_frames_dropped_by_rate_limiter = 22;
  first->monky_frames_dropped_by_congestion_window = 33;
  first->monky_frames_dropped_by_bad_timestamp = 44;
  first->monky_frames_dropped_by_encoder = 55;
  auto second = Row("second-ssrc", 8, true);
  second->monky_send_stream_ssrcs = std::vector<std::uint32_t>{8, 7};
  second->monky_frames_dropped_by_encoder_queue = 11;
  second->monky_frames_dropped_by_rate_limiter = 22;
  second->monky_frames_dropped_by_congestion_window = 33;
  second->monky_frames_dropped_by_bad_timestamp = 44;
  second->monky_frames_dropped_by_encoder = 55;
  distinct->AddStats(std::move(first));
  distinct->AddStats(std::move(second));
  distinct->AddStats(Row("another-real-stream", 9, true));
  const auto grouped = ObserveRtcSendStreamDrops(*distinct);
  const auto found = std::find_if(grouped.at("streams").begin(), grouped.at("streams").end(),
      [](const Json& item) { return item.at("scopeSsrcs") == Json::array({7, 8}); });
  check(grouped.at("streams").size() == 2 && found != grouped.at("streams").end() &&
        found->at("rtpStreams").size() == 2 &&
        found->at("counters") == Json{{"encoderQueue", 11}, {"rateLimiter", 22},
            {"congestionWindow", 33}, {"badTimestamp", 44}, {"encoder", 55}},
        "Send-stream aggregates were duplicated across SSRCs or mixed between streams");
  check(grouped.at("rateLimiterMeaning") == "WebRTC-FrameDropper",
        "RTC rate-limiter drops were mislabeled as WGC or native adapter policy");
  const auto unchanged = grouped;
  auto copied = grouped;
  copied["streams"][0]["counters"] = nullptr;
  check(ObserveRtcSendStreamDrops(*distinct) == unchanged &&
        ObserveRtcSendStreamDrops(*zero) == zero_json,
        "A diagnostic snapshot mutated another peer/stream observation");

  auto partial = report();
  auto partial_row = Row("partial", 7, true);
  partial_row->monky_frames_dropped_by_encoder.reset();
  partial->AddStats(std::move(partial_row));
  const auto partial_json = ObserveRtcSendStreamDrops(*partial);
  check(partial_json.at("streams").front().at("counters").is_null() &&
        partial_json.at("streams").front().at("availability") == "incomplete-sdk-observation",
        "Incomplete SDK data was represented as successful zero counters");

  auto audio = report();
  auto audio_row = Row("audio-is-not-video-drops", 0, false);
  audio_row->kind = "audio";
  audio->AddStats(std::move(audio_row));
  check(ObserveRtcSendStreamDrops(*audio).at("streams").empty(),
        "Audio was assigned video encoder drop evidence");
  auto recreated = report();
  recreated->AddStats(Row("new-stream-lifecycle", 7, true));
  check(ObserveRtcSendStreamDrops(*recreated).at("streams").front().at("counters").at("encoder") == 0 &&
        ObserveRtcSendStreamDrops(*distinct) == unchanged,
        "A new actual stream inherited old drops or reset the prior observation");

  for (const auto mode : {0, 1, 2, 3}) {
    auto invalid = report();
    auto row = Row("invalid", 7, true);
    if (mode == 0) row->monky_send_stream_ssrcs = std::vector<std::uint32_t>{7, 7};
    else if (mode == 1) row->ssrc = 10;
    else if (mode == 2) row->monky_send_stream_ssrcs = std::vector<std::uint32_t>(65, 7);
    else row = Row(std::string(257, 'x'), 7, true);
    invalid->AddStats(std::move(row));
    bool rejected = false;
    try { (void)ObserveRtcSendStreamDrops(*invalid); }
    catch (const Error& error) { rejected = std::string(error.code) == "ERR_RTC_STATS"; }
    check(rejected, "Invalid/unbounded SDK stream scope became attributed diagnostics");
  }
  for (const bool disagreement : {false, true}) {
    auto invalid = report();
    if (disagreement) {
      auto a = Row("a", 7, true), b = Row("b", 8, true);
      a->monky_send_stream_ssrcs = b->monky_send_stream_ssrcs = std::vector<std::uint32_t>{7, 8};
      b->monky_frames_dropped_by_encoder = 1;
      invalid->AddStats(std::move(a));
      invalid->AddStats(std::move(b));
    } else {
      for (std::uint32_t i = 0; i < 129; ++i)
        invalid->AddStats(Row("stream-" + std::to_string(i), i, true));
    }
    bool rejected = false;
    try { (void)ObserveRtcSendStreamDrops(*invalid); }
    catch (const Error& error) { rejected = error.code == "ERR_RTC_STATS"; }
    check(rejected, "Disagreeing or unbounded real-stream observations were silently accepted");
  }

  auto full = report();
  for (std::uint32_t i = 0; i < 128; ++i) {
    auto row = Row("bounded-" + std::to_string(i), 1000 + i, true);
    if (i == 0) row->monky_send_stream_ssrcs = std::vector<std::uint32_t>{1000, 9999};
    full->AddStats(std::move(row));
  }
  auto later = Row("z-later-same-stream", 9999, true);
  later->monky_send_stream_ssrcs = std::vector<std::uint32_t>{9999, 1000};
  full->AddStats(std::move(later));
  const auto ordered = full->GetStatsOfType<webrtc::RTCOutboundRtpStreamStats>();
  check(ordered.size() == 129 && ordered.back()->id() == "z-later-same-stream",
        "The actual SDK report did not place the duplicate scope after all 128 distinct groups");
  const auto at_capacity = ObserveRtcSendStreamDrops(*full);
  const auto& full_streams = at_capacity.at("streams");
  const auto existing = std::find_if(full_streams.begin(), full_streams.end(),
      [](const Json& stream) { return stream.at("scopeSsrcs") == Json::array({1000, 9999}); });
  check(full_streams.size() == 128 && existing != full_streams.end() &&
        existing->at("rtpStreams").size() == 2 &&
        existing->at("rtpStreams").back().at("statsId") == "z-later-same-stream" &&
        existing->at("rtpStreams").back().at("ssrc") == 9999 &&
        existing->at("rtpStreams").back().at("timestampUs") == 606000,
        "An existing send-stream scope was rejected or duplicated at the 128-group boundary");
  check(existing->at("availability") == "observed" &&
        existing->at("counters").at("encoderQueue") == 0 &&
        at_capacity.at("reportTimestampUs") == 606000,
        "Deduplication at capacity changed observed zero, availability or the collection timestamp");
  full->AddStats(Row("zz-129th-unique-stream", 2000, true));
  bool overflow = false;
  try { (void)ObserveRtcSendStreamDrops(*full); }
  catch (const Error& error) { overflow = error.code == "ERR_RTC_STATS"; }
  check(overflow, "A 129th unique scope bypassed the group bound after valid deduplication");

  for (const bool incomplete : {false, true}) {
    auto unavailable = report();
    for (std::uint32_t i = 0; i < 128; ++i) {
      auto row = Row("unavailable-" + std::to_string(i), i, incomplete);
      if (incomplete) row->monky_frames_dropped_by_encoder.reset();
      unavailable->AddStats(std::move(row));
    }
    const auto collected = ObserveRtcSendStreamDrops(*unavailable);
    const auto& groups = collected.at("streams");
    check(groups.size() == 128 && std::all_of(groups.begin(), groups.end(),
          [incomplete](const Json& stream) {
            return stream.at("counters").is_null() &&
                stream.at("availability") == (incomplete ? "incomplete-sdk-observation" : "unobserved");
          }), "Exactly 128 unavailable/incomplete groups were rejected or turned into observed zeros");
    auto extra = Row("zz-unavailable-overflow", 1000, incomplete);
    if (incomplete) extra->monky_frames_dropped_by_encoder.reset();
    unavailable->AddStats(std::move(extra));
    bool rejected = false;
    try { (void)ObserveRtcSendStreamDrops(*unavailable); }
    catch (const Error& error) { rejected = error.code == "ERR_RTC_STATS"; }
    check(rejected, "Unavailable/incomplete groups bypassed the shared 128-group bound");
  }

  auto rtp_limit = report();
  std::vector<std::uint32_t> scope;
  for (std::uint32_t i = 0; i < 64; ++i) scope.push_back(i);
  for (const auto ssrc : scope) {
    auto row = Row("rtp-" + std::to_string(ssrc), ssrc, true);
    row->monky_send_stream_ssrcs = scope;
    rtp_limit->AddStats(std::move(row));
  }
  check(ObserveRtcSendStreamDrops(*rtp_limit).at("streams").front().at("rtpStreams").size() == 64,
        "The group-bound correction rejected the existing 64-row per-group allowance");
  auto extra_rtp = Row("zz-extra-rtp-row", 0, true);
  extra_rtp->monky_send_stream_ssrcs = scope;
  rtp_limit->AddStats(std::move(extra_rtp));
  bool rtp_overflow = false;
  try { (void)ObserveRtcSendStreamDrops(*rtp_limit); }
  catch (const Error& error) { rtp_overflow = error.code == "ERR_RTC_STATS"; }
  check(rtp_overflow, "Deduplication relaxed the existing per-group RTP-row bound");
}

}  // namespace monky::native_rtc::engine
