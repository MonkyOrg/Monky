#pragma once

#include "rtc_receive_diagnostics.h"

#include <limits>
#include <memory>

namespace monky::native_rtc::engine {
namespace rtc_receive_checks_detail {

using Inbound = webrtc::RTCInboundRtpStreamStats;
inline constexpr std::array<std::optional<std::uint64_t> Inbound::*, 12> kCounters{
    &Inbound::monky_decoder_timestamp_map_overflow_evictions,
    &Inbound::monky_decoder_timestamp_map_missing_callbacks,
    &Inbound::monky_decoder_timestamp_map_skipped_mappings,
    &Inbound::monky_decoder_timestamp_map_skip_events,
    &Inbound::monky_decoder_timestamp_map_cleared_mappings,
    &Inbound::monky_decoder_timestamp_map_clear_events,
    &Inbound::monky_decoder_timestamp_map_mapped_callbacks,
    &Inbound::monky_frame_buffer_skipped_frames,
    &Inbound::monky_frame_buffer_skip_events,
    &Inbound::monky_frame_buffer_cleared_frames,
    &Inbound::monky_frame_buffer_clear_events,
    &Inbound::monky_decoder_timestamp_map_lease_retirements};

inline std::unique_ptr<Inbound> Row(const std::string& id, std::uint64_t instance,
    std::uint32_t ssrc, bool observed = true,
    webrtc::Timestamp timestamp = webrtc::Timestamp::Micros(606010)) {
  auto row = std::make_unique<Inbound>(id, timestamp);
  row->kind = "video";
  row->ssrc = ssrc;
  if (observed) {
    row->monky_receive_stream_instance_id = instance;
    row->monky_receive_stream_ssrc = ssrc;
    for (const auto member : kCounters) row.get()->*member = 0;
  }
  return row;
}

}  // namespace rtc_receive_checks_detail

template <typename Check>
void RunRtcReceiveDiagnosticChecks(Check&& check) {
  using namespace rtc_receive_checks_detail;
  const auto report = [] { return webrtc::RTCStatsReport::Create(webrtc::Timestamp::Micros(606000)); };
  const auto rejected = [](const webrtc::RTCStatsReport& input) {
    try { (void)ObserveRtcReceiveStreamDiagnostics(input); }
    catch (const Error& error) { return error.code == "ERR_RTC_STATS"; }
    return false;
  };
  Json uncollected = nullptr;
  auto empty = report();
  check(uncollected.is_null() && ObserveRtcReceiveStreamDiagnostics(*empty).at("streams").empty() &&
        ObserveRtcReceiveStreamDiagnostics(*empty).at("reportTimestampUs") == 606000,
        "A never-collected receiver was confused with a real empty RTCStatsReport");

  auto missing = report();
  missing->AddStats(Row("missing", 1, 7, false));
  const auto missing_json = ObserveRtcReceiveStreamDiagnostics(*missing);
  const auto& missing_stream = missing_json.at("streams").front();
  check(missing_stream.at("scope").is_null() && missing_stream.at("counters").is_null() &&
        missing_stream.at("availability") == "unobserved",
        "An absent SDK receive stream became observed zero or acquired an inferred instance");
  const auto missing_wire = Json::parse(missing->ToJson());
  check(!missing_wire.front().contains("monkyReceiveStreamInstanceId") &&
        !missing_wire.front().contains("monkyDecoderTimestampMapOverflowEvictions") &&
        !missing_wire.front().contains("monkyFrameBufferClearEvents") &&
        !missing_wire.front().contains("monkyDecoderTimestampMapLeaseRetirements"),
        "SDK RTCInboundRtpStreamStats serialization manufactured missing receive fields");

  auto zero = report();
  zero->AddStats(Row("zero", 1, 7));
  const auto zero_json = ObserveRtcReceiveStreamDiagnostics(*zero);
  const auto& zero_stream = zero_json.at("streams").front();
  const Json zero_counters{
      {"timestampMap", {{"overflowEvictions", 0}, {"missingCallbacks", 0}, {"skippedMappings", 0},
          {"skipEvents", 0}, {"clearedMappings", 0}, {"clearEvents", 0}, {"mappedCallbacks", 0},
          {"leaseRetirements", 0}}},
      {"frameBuffer", {{"skippedFrames", 0}, {"skipEvents", 0}, {"clearedFrames", 0}, {"clearEvents", 0}}}};
  check(zero_stream.at("scope") == Json{{"streamInstanceId", "1"}, {"mediaSsrc", 7}} &&
        zero_stream.at("counters") == zero_counters && zero_stream.at("availability") == "observed" &&
        zero_stream.at("timestampUs") == 606010 &&
        zero_stream.at("rtpStreams").front().at("timestampUs") == 606010 &&
        zero_json.at("reportTimestampUs") == 606000,
        "Observed zero lost actual media SSRC, diagnostic instance or original row/report timestamps");
  const auto zero_wire = Json::parse(zero->ToJson());
  check(zero_wire.front().at("monkyReceiveStreamInstanceId") == 1 &&
        zero_wire.front().at("monkyReceiveStreamSsrc") == 7 &&
        zero_wire.front().at("monkyDecoderTimestampMapMappedCallbacks") == 0 &&
        zero_wire.front().at("monkyDecoderTimestampMapMissingCallbacks") == 0 &&
        zero_wire.front().at("monkyFrameBufferClearEvents") == 0 &&
        zero_wire.front().at("monkyDecoderTimestampMapLeaseRetirements") == 0,
        "The compiled inbound RTCStats serializer disagrees with the typed diagnostic header");
  const auto clone = zero->Copy();
  check(ObserveRtcReceiveStreamDiagnostics(*clone) == zero_json &&
        Json::parse(clone->ToJson()) == zero_wire,
        "Actual RTCStatsReport cloning lost typed receiving fields or observation timestamps");

  auto distinct = report();
  auto first = Row("first", 1, 7), duplicate = Row("first-duplicate", 1, 7);
  std::uint64_t value = 10;
  for (const auto member : kCounters) {
    first.get()->*member = value;
    duplicate.get()->*member = value++;
  }
  distinct->AddStats(std::move(first));
  distinct->AddStats(std::move(duplicate));
  distinct->AddStats(Row("other-ssrc", 2, 8));
  distinct->AddStats(Row("same-ssrc-new-instance", 3, 7));
  const auto grouped = ObserveRtcReceiveStreamDiagnostics(*distinct);
  const auto found = std::find_if(grouped.at("streams").begin(), grouped.at("streams").end(),
      [](const Json& stream) {
        return stream.at("scope") == Json{{"streamInstanceId", "1"}, {"mediaSsrc", 7}};
      });
  check(grouped.at("streams").size() == 3 && found != grouped.at("streams").end() &&
        found->at("rtpStreams").size() == 2 &&
        found->at("counters").at("timestampMap") == Json{{"overflowEvictions", 10},
            {"missingCallbacks", 11}, {"skippedMappings", 12}, {"skipEvents", 13},
            {"clearedMappings", 14}, {"clearEvents", 15}, {"mappedCallbacks", 16},
            {"leaseRetirements", 21}} &&
        found->at("counters").at("frameBuffer") == Json{{"skippedFrames", 17}, {"skipEvents", 18},
            {"clearedFrames", 19}, {"clearEvents", 20}},
        "Receiving counters were summed across duplicate rows, mixed across SSRCs or inherited after restart");
  check(grouped.at("resetScope") == "ReceiveStatisticsProxy-instance" &&
        grouped.at("instanceIdMeaning") == "process-local-diagnostic-not-ownership" &&
        grouped.at("leaseRetirementsMeaning") ==
            "exact-refusal-or-terminal-ownership-cleanup-observed-on-SDK-call" &&
        grouped.at("frameBufferSkipEventsMeaning") == "positive-UpdateDroppedFrames-delta" &&
        grouped.at("frameBufferClearEventsMeaning") == "VideoStreamBufferController-Clear",
        "A diagnostic lifecycle or aggregate buffer-delta event was presented as native ownership or per-frame policy");
  const auto distinct_clone = distinct->Copy();
  check(ObserveRtcReceiveStreamDiagnostics(*distinct_clone) == grouped &&
        Json::parse(distinct_clone->ToJson()) == Json::parse(distinct->ToJson()),
        "Actual SDK cloning lost nonzero receiving counters or changed per-instance grouping");
  auto cached = grouped;
  cached = ObserveRtcReceiveStreamDiagnostics(*missing);
  check(cached.at("streams").front().at("counters").is_null() &&
        ObserveRtcReceiveStreamDiagnostics(*distinct) == grouped,
        "An incomplete newer collection reused cached counters or mutated the older report");
  cached = ObserveRtcReceiveStreamDiagnostics(*empty);
  check(cached.at("streams").empty(), "An empty newer observation retained retired receive streams");

  for (const bool incomplete_first : {false, true}) {
    auto mixed = report();
    auto partial = Row(incomplete_first ? "a-partial" : "z-partial", 1, 7);
    partial->monky_decoder_timestamp_map_mapped_callbacks.reset();
    mixed->AddStats(std::move(partial));
    mixed->AddStats(Row("m-complete", 1, 7));
    const auto observation = ObserveRtcReceiveStreamDiagnostics(*mixed);
    check(observation.at("streams").size() == 1 &&
          observation.at("streams").front().at("availability") == "incomplete-sdk-observation" &&
          observation.at("streams").front().at("counters").is_null() &&
          observation.at("streams").front().at("rtpStreams").size() == 2,
          "A convenient complete duplicate repaired an incomplete SDK group");
  }
  for (const bool timestamps : {false, true}) {
    auto mixed = report();
    mixed->AddStats(Row("a-old", 1, 7));
    auto newer = Row("z-new", 1, 7, true,
        webrtc::Timestamp::Micros(timestamps ? 606020 : 606010));
    newer->monky_decoder_timestamp_map_missing_callbacks = 1;
    mixed->AddStats(std::move(newer));
    const auto observed = ObserveRtcReceiveStreamDiagnostics(*mixed);
    const auto& group = observed.at("streams").front();
    check(group.at("counters").is_null() &&
          group.at("availability") == (timestamps ? "mixed-sdk-timestamps" : "inconsistent-sdk-observation") &&
          group.at("rtpStreams").front().at("timestampUs") == 606010 &&
          group.at("rtpStreams").back().at("timestampUs") == (timestamps ? 606020 : 606010) &&
          observed.at("reportTimestampUs") == 606000 &&
          (timestamps ? group.at("timestampUs").is_null() : group.at("timestampUs") == 606010),
          "A stale or inconsistent duplicate produced success-shaped counters or a fabricated collection time");
  }

  for (int mode = 0; mode < 4; ++mode) {
    auto partial = report();
    auto row = Row("partial-scope", 1, 7);
    if (mode == 0) row->monky_receive_stream_instance_id.reset();
    if (mode == 1) row->monky_receive_stream_ssrc.reset();
    if (mode == 2) row->ssrc.reset();
    if (mode == 3) row->monky_frame_buffer_clear_events.reset();
    partial->AddStats(std::move(row));
    const auto observation = ObserveRtcReceiveStreamDiagnostics(*partial);
    check(observation.at("streams").front().at("availability") == "incomplete-sdk-observation" &&
          observation.at("streams").front().at("counters").is_null(),
          "Partial typed identity or counters were filled from unrelated RTC fields or zero defaults");
  }

  auto audio = report();
  auto audio_row = Row("audio", 1, 7);
  audio_row->kind = "audio";
  audio->AddStats(std::move(audio_row));
  auto unspecified = Row("no-kind", 2, 8);
  unspecified->kind.reset();
  audio->AddStats(std::move(unspecified));
  check(ObserveRtcReceiveStreamDiagnostics(*audio).at("streams").empty(),
        "Non-video streams acquired decoder timestamp-map evidence");

  auto maximum = report();
  auto maximum_row = Row("maximum", (std::numeric_limits<std::uint64_t>::max)(), 0);
  maximum_row->monky_decoder_timestamp_map_overflow_evictions = (std::numeric_limits<std::uint64_t>::max)();
  maximum->AddStats(std::move(maximum_row));
  const auto maximum_json = ObserveRtcReceiveStreamDiagnostics(*maximum);
  const auto maximum_clone = maximum->Copy();
  const auto maximum_clone_json = ObserveRtcReceiveStreamDiagnostics(*maximum_clone);
  check(maximum_json.at("streams").front().at("scope").at("streamInstanceId") == "18446744073709551615" &&
        maximum_json.at("streams").front().at("scope").at("mediaSsrc") == 0 &&
        maximum_json.at("streams").front().at("counters").at("timestampMap").at("overflowEvictions") ==
            (std::numeric_limits<std::uint64_t>::max)() &&
        maximum_clone_json == maximum_json,
        "Typed uint64 counts/IDs were narrowed or an observed SSRC zero became missing");
  // M140 Attribute::ToString deliberately converts uint64 to double/%.16g.
  // The grouped observation must use typed stats, not round-trip that raw JSON.
  const auto maximum_wire = Json::parse(maximum_clone->ToJson());
  check(maximum_wire.front().at("monkyDecoderTimestampMapOverflowEvictions").is_number_float() &&
        maximum_wire.front().at("monkyReceiveStreamInstanceId").is_number_float(),
        "Pinned raw RTC JSON precision behavior changed independently of typed diagnostic cloning");
  auto safe_integer = report();
  auto safe_row = Row("safe-integer", 9007199254740991ull, 0);
  safe_row->monky_decoder_timestamp_map_overflow_evictions = 9007199254740991ull;
  safe_integer->AddStats(std::move(safe_row));
  const auto safe_wire = Json::parse(safe_integer->Copy()->ToJson());
  check(safe_wire.front().at("monkyReceiveStreamInstanceId") == 9007199254740991ull &&
        safe_wire.front().at("monkyDecoderTimestampMapOverflowEvictions") == 9007199254740991ull,
        "Raw RTC serialization lost a count/ID inside JavaScript's safe integer range");

  for (int mode = 0; mode < 6; ++mode) {
    auto invalid = report();
    auto row = Row("invalid", mode == 0 ? 0 : 1, 7);
    if (mode == 1) row->ssrc = 8;
    if (mode == 2) row = Row(std::string(257, 'x'), 1, 7);
    if (mode == 3) row = Row("", 1, 7);
    if (mode == 4) row = Row("infinite", 1, 7, true, webrtc::Timestamp::PlusInfinity());
    if (mode == 5) invalid->AddStats(Row("same-instance-other-ssrc", 1, 8));
    invalid->AddStats(std::move(row));
    check(rejected(*invalid), "Invalid/unbounded receive identities or row timestamps became attributed diagnostics");
  }
  auto infinite = webrtc::RTCStatsReport::Create(webrtc::Timestamp::PlusInfinity());
  check(rejected(*infinite), "A nonfinite report timestamp became a finite-looking receive observation");

  auto full = report();
  for (std::uint32_t i = 0; i < 128; ++i)
    full->AddStats(Row("bounded-" + std::to_string(i), i + 1, i));
  full->AddStats(Row("z-existing-at-capacity", 1, 0));
  const auto at_capacity = ObserveRtcReceiveStreamDiagnostics(*full);
  const auto existing = std::find_if(at_capacity.at("streams").begin(), at_capacity.at("streams").end(),
      [](const Json& stream) { return stream.at("scope").at("streamInstanceId") == "1"; });
  check(at_capacity.at("streams").size() == 128 && existing != at_capacity.at("streams").end() &&
        existing->at("rtpStreams").size() == 2 && existing->at("counters") == zero_counters,
        "The receive group bound rejected an existing real scope or erased observed zeros at capacity");
  full->AddStats(Row("zz-129th-instance", 129, 128));
  check(rejected(*full), "A 129th actual receive instance bypassed the shared group bound");

  for (const bool partial : {false, true}) {
    auto unavailable = report();
    for (std::uint32_t i = 0; i < 128; ++i) {
      auto row = Row("unavailable-" + std::to_string(i), i + 1, i, partial);
      if (partial) row->monky_frame_buffer_clear_events.reset();
      unavailable->AddStats(std::move(row));
    }
    const auto observation = ObserveRtcReceiveStreamDiagnostics(*unavailable);
    check(observation.at("streams").size() == 128 &&
          std::all_of(observation.at("streams").begin(), observation.at("streams").end(),
              [](const Json& stream) { return stream.at("counters").is_null(); }),
          "Unavailable/incomplete receive groups were lost or turned into zero counts at capacity");
    auto extra = Row("zz-extra-unavailable", 129, 128, partial);
    if (partial) extra->monky_frame_buffer_clear_events.reset();
    unavailable->AddStats(std::move(extra));
    check(rejected(*unavailable), "Unavailable or incomplete receive groups bypassed the bound");
  }
  auto rows = report();
  for (std::uint32_t i = 0; i < 64; ++i)
    rows->AddStats(Row("row-" + std::to_string(i), 1, 7));
  check(ObserveRtcReceiveStreamDiagnostics(*rows).at("streams").front().at("rtpStreams").size() == 64,
        "The existing bounded per-stream row allowance was rejected");
  rows->AddStats(Row("z-extra-row", 1, 7));
  check(rejected(*rows), "A 65th receive row bypassed the per-stream bound");
}

}  // namespace monky::native_rtc::engine
