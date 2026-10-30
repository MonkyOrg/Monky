#pragma once

// Device-free checks of the encoded source, compiled only into the contract probe.

#include "encoded_video_internal.h"
#include "peer_support.h"

#include "api/environment/environment_factory.h"
#include "api/field_trials.h"
#include "rtc_base/experiments/rate_control_settings.h"

#include <array>
#include <functional>

namespace monky::native_rtc::engine {

inline void RunEncodedVideoChecks(const std::function<void(bool, const char*)>& check) {
  using namespace encoded;
  const std::array<std::optional<std::uint8_t>, 3> compatible_colours{std::nullopt, 1, 2};
  for (const auto primaries : compatible_colours) {
    for (const auto transfer : compatible_colours) {
      for (const auto matrix : compatible_colours) {
        sv::H264Sps sps;
        sps.colorPrimaries = primaries; sps.transferCharacteristics = transfer; sps.matrixCoefficients = matrix;
        check(sv::IsBt709LimitedCompatible(sps), "Absent and explicitly unspecified H264 colour must agree");
        sps.fullRange = false;
        check(sv::IsBt709LimitedCompatible(sps), "Limited-range colour contract changed");
        sps.fullRange = true;
        check(!sv::IsBt709LimitedCompatible(sps), "Full-range H264 cannot enter the limited-range pipeline");
      }
    }
  }
  for (unsigned value = 0; value <= 255; ++value) {
    if (value == 1 || value == 2) continue;
    for (const auto member : {&sv::H264Sps::colorPrimaries, &sv::H264Sps::transferCharacteristics,
                              &sv::H264Sps::matrixCoefficients}) {
      sv::H264Sps sps;
      sps.*member = static_cast<std::uint8_t>(value);
      check(!sv::IsBt709LimitedCompatible(sps), "Conflicting or reserved H264 colour description was accepted");
    }
  }
  const auto rejects = [&](auto&& operation) {
    bool rejected = false;
    try { operation(); } catch (const std::exception&) { rejected = true; }
    check(rejected, "Invalid encoded contract was accepted");
  };
  for (const auto video : {EncodedConfiguration{3840, 2160, 120}, {3840, 2160, 60},
                           {1920, 1080, 240}, {1920, 1080, 120}, {1920, 1080, 60},
                           {1280, 720, 60}, {854, 480, 30}}) {
    const auto parsed = ParseConfiguration({{"width", video.width}, {"height", video.height}, {"fps", video.fps}});
    check(parsed.width == video.width && parsed.height == video.height && parsed.fps == video.fps,
        "Encoded rendition geometry/framerate changed during admission");
    auto configured = std::make_shared<State>(1, "cpu-rendition", false,
        [](std::string_view, Json) { return true; }, parsed);
    const auto snapshot = configured->Snapshot();
    check(snapshot.at("width") == video.width && snapshot.at("height") == video.height &&
        snapshot.at("requestedFps") == video.fps && snapshot.at("profileLevelId").is_null(),
        "Rendition stats must report their own configuration without inventing an observed SPS");
  }
  for (const auto invalid : {Json{{"width", 3844}, {"height", 2160}, {"fps", 120}},
                            Json{{"width", 3840}, {"height", 2162}, {"fps", 120}},
                            Json{{"width", 3840}, {"height", 2160}, {"fps", 121}},
                            Json{{"width", 1920}, {"height", 1080}, {"fps", 241}},
                            Json{{"width", 0}, {"height", 1080}, {"fps", 120}},
                            Json{{"width", 1919}, {"height", 1080}, {"fps", 120}},
                            Json{{"width", 1920}, {"height", 1079}, {"fps", 120}},
                            Json{{"width", 1920}, {"height", 1080}, {"fps", 0}},
                            Json{{"width", -2}, {"height", 1080}, {"fps", 120}},
                            Json{{"width", "1920"}, {"height", 1080}, {"fps", 120}}}) {
    rejects([&] { ParseConfiguration(invalid); });
  }
  {
    sv::H264Sps sps;
    sps.width = sps.codedWidth = 3840; sps.height = sps.codedHeight = 2160; sps.levelIdc = 52;
    rejects([&] { ValidateEncodedLevel(sps, {3840, 2160, 120}); });
    sps.levelIdc = 60;
    ValidateEncodedLevel(sps, {3840, 2160, 120});
    sps.codedWidth = sps.codedHeight = 4096;
    rejects([&] { ValidateEncodedLevel(sps, {3840, 2160, 120}); });
    sps.width = sps.codedWidth = 1920; sps.height = 1080; sps.codedHeight = 1088; sps.levelIdc = 51;
    ValidateEncodedLevel(sps, {1920, 1080, 120});
    sps.levelIdc = 60;
    rejects([&] { ValidateEncodedLevel(sps, {1920, 1080, 120}); });
    check(true, "4K120 requires Level6 while 1080p120 retains its actual Level5.1 SPS");
  }
  check(sizeof(MonkyEngineEncodedFrame) == 80 && alignof(MonkyEngineEncodedFrame) == 8,
      "Encoded C/POD layout drift");
  check(offsetof(MonkyEngineEncodedFrame, data) == 16 &&
      offsetof(MonkyEngineEncodedFrame, timestamp_us) == 32 &&
      offsetof(MonkyEngineEncodedFrame, timebase_numerator) == 72, "Encoded POD field offset drift");
  std::uint8_t byte = 1;
  MonkyEngineEncodedFrame frame{sizeof(frame), MONKY_ENGINE_ABI_VERSION, 1, &byte, 1, 1, 10000, 8333, -1, -2, -2, 1, 120};
  ValidateEncodedFrame(frame);
  check(true, "Signed PTS and genuine QPC metadata are accepted without index retiming");
  {
    std::vector<std::uint8_t> packet{
      0, 0, 0, 1, 0x67, 0x4d, 0x00, 0x33, 0xf4, 0x02, 0x80, 0x2d, 0xd3, 0x50, 0x20, 0x20, 0x20, 0x20,
      0, 0, 0, 1, 0x68, 0xc8, 0, 0, 0, 1, 0x65, 0xbc,
    };
    auto input = frame;
    input.data = packet.data(); input.data_bytes = static_cast<std::uint32_t>(packet.size());
    sv::H264Bitstream parser(1280, 720, kEncodedH264Level, sv::H264Profile::Main, sv::H264LevelPolicy::Maximum);
    const auto admitted = Normalize(parser, input);
    check(admitted.hasPicture && admitted.keyFrame && parser.Sps().colorPrimaries == 2 &&
        parser.Sps().transferCharacteristics == 2 && parser.Sps().matrixCoefficients == 2,
        "The actual external-input path rejected explicitly unspecified H264 colour");
    check(admitted.data == packet, "Colour compatibility must not rewrite encoded parameter sets");
    {
      State bounded(1, "source-sps-level", false, [](std::string_view, Json) { return true; }, {1280, 720, 60});
      packet[7] = 60;
      rejects([&] { Normalize(bounded.stream, input); });
      packet[7] = 51;
      check(Normalize(bounded.stream, input).hasPicture,
          "Real SPS must fit the advertised source level without relabeling parameter sets");
    }
    packet[14] = packet[15] = packet[16] = 0x60;
    bool rejected = false;
    try { Normalize(parser, input); }
    catch (const Error& error) {
      rejected = error.code == "ERR_RTC_ENCODED_COLOR" &&
          std::string(error.what()).find("primaries=6, transfer=6, matrix=6") != std::string::npos;
    }
    check(rejected, "Contradictory colour must retain its exact observed values in the error");
    check(parser.Sps().colorPrimaries == 2, "Rejected colour must not poison the admitted SPS cache");
  }
  for (const auto bad : {0u, static_cast<unsigned>(kEncodedMaximumPacket + 1)}) {
    auto copy = frame; copy.data_bytes = bad; rejects([&] { ValidateEncodedFrame(copy); });
  }
  for (const auto bad : {std::int64_t{-1}, static_cast<std::int64_t>(kMaxId + 1)}) {
    auto copy = frame; copy.timestamp_us = bad; rejects([&] { ValidateEncodedFrame(copy); });
  }
  {
    // AMF can offset DTS even with B-frames disabled. The bitstream validator
    // rejects B slices; source admission independently checks PTS/DTS order.
    auto copy = frame; copy.dts = -3; ValidateEncodedFrame(copy);
    check(copy.pts == -2 && copy.dts == -3, "Independent original PTS/DTS must not be retimed");
  }
  { auto copy = frame; copy.data = nullptr; rejects([&] { ValidateEncodedFrame(copy); }); }
  Capacity(15, kEncodedMaximumBytes - 1, 1, 1000000, 1500000);
  check(true, "Exact encoded age/byte/frame bounds are accepted");
  rejects([&] { Capacity(16, 0, 1, 1000000, 1000000); });
  rejects([&] { Capacity(0, kEncodedMaximumBytes, 1, 1000000, 1000000); });
  rejects([&] { Capacity(0, 0, 1, 1000000, 1500001); });
  rejects([&] { Capacity(0, 0, 1, 1010001, 1000000); });
  const std::array<std::uint8_t, 8> bad_order{0, 0, 1, 0x65, 0, 0, 1, 0x67};
  rejects([&] { ParameterOrder(bad_order); });
  auto bundle = CreateEncodedVideoFactory(kEncodedH264Level);
  {
    auto av1 = CreateEncodedVideoFactory(kEncodedH264Level, true);
    const auto av1_formats = av1.encoder_factory->GetSupportedFormats();
    check(av1_formats.size() == 1 && av1_formats[0].name == "AV1" &&
        av1.encoder_factory->QueryCodecSupport(av1_formats[0], "L1T1").is_supported,
        "An AV1 pipeline must advertise only its real encoded codec");
    check(!av1.encoder_factory->QueryCodecSupport(av1_formats[0], "L1T2").is_supported &&
        !bundle.encoder_factory->QueryCodecSupport(av1_formats[0], "L1T1").is_supported,
        "AV1 must not alias H264 or fabricate temporal layers");
    auto invalid_av1 = av1_formats[0]; invalid_av1.parameters["level-idx"] = "24";
    check(!policy::IsScreenAv1Format(invalid_av1), "Reserved AV1 levels cannot be negotiated");
    invalid_av1 = av1_formats[0]; invalid_av1.parameters["profile"] = "1";
    check(!policy::IsScreenAv1Format(invalid_av1), "AV1 4:4:4 cannot enter the screen 4:2:0 pipeline");
    check(av1_formats[0] == policy::ScreenAv1Format() && policy::IsScreenAv1Format(webrtc::SdpVideoFormat("AV1")),
          "Both screen endpoints must offer the one screen AV1 format, with absent parameters at their default");
    check(Av1ReceiveLevel(webrtc::SdpVideoFormat("AV1")) == 5,
          "Absent AV1 level must retain its specified Level3.1 default");
  }
  const webrtc::RateControlSettings encoded_rates(*bundle.field_trials);
  check(bundle.field_trials->IsDisabled("WebRTC-FrameDropper") &&
      encoded_rates.UseCongestionWindow() && encoded_rates.UseCongestionWindowPushback() &&
      !encoded_rates.UseCongestionWindowDropFrameOnly(),
      "Encoded congestion must lower the producer bitrate, not discard compressed dependencies");
  check(encoded_rates.GetCongestionWindowAdditionalTimeMs() == 350 &&
      encoded_rates.CongestionWindowMinPushbackTargetBitrateBps() == 30000 &&
      encoded_rates.UseEncoderBitrateAdjuster(),
      "Encoded transport must preserve bounded congestion feedback and overshoot adjustment");
  const webrtc::FieldTrials default_trials("");
  const webrtc::RateControlSettings default_rates(default_trials);
  check(!default_trials.IsDisabled("WebRTC-FrameDropper") &&
      default_rates.UseCongestionWindowDropFrameOnly(),
      "Encoded-only congestion policies must not change the raw-video defaults");
  const auto formats = bundle.encoder_factory->GetSupportedFormats();
  check(formats.size() == 1 && formats[0].parameters.at("profile-level-id") == "4d003c",
      "External encoder must advertise Main6 support without mislabeling a 4K120 stream");
  check(bundle.encoder_factory->QueryCodecSupport(formats[0], "L1T1").is_supported,
      "External H264 L1T1 support is missing");
  auto lower_ceiling = CreateEncodedVideoFactory(51);
  check(lower_ceiling.encoder_factory->QueryCodecSupport(formats[0], "L1T1").is_supported,
      "A higher asymmetric receive ceiling must not disable a lower-level H264 publisher");
  check(!bundle.encoder_factory->QueryCodecSupport(formats[0], "L1T2").is_supported,
      "Encoded SVC must not be fabricated");
  {
    auto receive = formats[0];
    receive.parameters["profile-level-id"] = "4d001f";
    check(!AcceptsEncodedFormat(receive), "A Level3.1-only receiver cannot accept the external Main6 stream");
    receive.parameters["max-recv-level"] = "003c";
    check(AcceptsEncodedFormat(receive) && bundle.encoder_factory->QueryCodecSupport(receive, "L1T1").is_supported,
        "An explicit RFC6184 Main6 receive limit was ignored");
    for (const auto* invalid : {"", "3c", "xyz3", "001f", "002a", "0033", "0034", "003d", "8033"}) {
      receive.parameters["max-recv-level"] = invalid;
      check(!AcceptsEncodedFormat(receive), "Invalid or insufficient extended H264 receive level was accepted");
    }
    receive.parameters["max-recv-level"] = "003c";
    receive.parameters["profile-level-id"] = "42e01f";
    check(!AcceptsEncodedFormat(receive), "A Baseline receiver was mistaken for Main profile support");
    receive.parameters["profile-level-id"] = "4d0034";
    receive.parameters.erase("max-recv-level");
    check(!AcceptsEncodedFormat(receive), "Level5.2 is insufficient for a Main6 publication");
    receive.parameters["profile-level-id"] = "4d003c";
    check(AcceptsEncodedFormat(receive), "An explicit Main6 receiver must be admitted");
    Json router{{"codecs", Json::array({Json{
        {"kind", "video"}, {"mimeType", "video/H264"}, {"clockRate", 90000},
        {"preferredPayloadType", 102},
        {"parameters", {{"profile-level-id", "4d0034"}, {"packetization-mode", 1}}}}})}};
    const auto accepts_4k120 = [](const auto& format) { return AcceptsEncodedFormat(format, 60); };
    rejects([&] { peer_detail::SelectScreenSendCodec(router, accepts_4k120); });
    router["codecs"][0]["parameters"]["profile-level-id"] = "4d003c";
    check(peer_detail::SelectScreenSendCodec(router, accepts_4k120) == router["codecs"][0],
        "SFU admission must select the router's exact compatible codec before publication");
    auto isolated = std::make_shared<State>(1, "codec-rejection-isolation", false,
        [](std::string_view, Json) { return true; });
    auto context = std::make_shared<EncodedVideoContext>(kEncodedH264Level);
    context->source = isolated;
    Factory factory(context);
    receive.parameters["profile-level-id"] = "4d001f";
    check(!factory.Create(webrtc::CreateEnvironment(), receive) && !isolated->failed.load(),
        "An incompatible receiver must not poison the shared source for other viewers");
  }
  for (const auto video : {EncodedConfiguration{1920, 1080, 120}, {3840, 2160, 60}, {3840, 2160, 120}}) {
    const auto minimum = MinimumEncodedLevel(video);
    const auto expected = video.width == 1920 ? 51 : video.fps == 60 ? 52 : 60;
    check(minimum == expected, "Source minimum must reflect actual macroblocks/rate, with a Level5.1 floor");
    auto isolated = std::make_shared<State>(1, "source-codec-level", false,
        [](std::string_view, Json) { return true; }, video);
    auto fixed = CreateEncodedVideoFactory(minimum);
    auto context = fixed.context;
    auto& factory = *fixed.encoder_factory;
    const auto advertised = factory.GetSupportedFormats();
    check(advertised.size() == 1 && ParseEncodedFormat(advertised[0])->level == minimum,
        "Initial codec caches must receive the rendition level BEFORE any source exists");
    check(factory.QueryCodecSupport(advertised[0], "L1T1").is_supported,
        "Initial advertised codec must be supported before source creation");
    context->ValidateSource(video);
    context->source = isolated;
    check(factory.GetSupportedFormats() == advertised, "Source creation must not change cached capabilities");
    for (const auto candidate : {EncodedConfiguration{1920, 1080, 120},
             EncodedConfiguration{3840, 2160, 60}, EncodedConfiguration{3840, 2160, 120}}) {
      if (MinimumEncodedLevel(candidate) > minimum)
        rejects([&] { context->ValidateSource(candidate); });
      else context->ValidateSource(candidate);
    }
    for (const auto level : {std::uint8_t{51}, std::uint8_t{52}, std::uint8_t{60}}) {
      auto receive = policy::SupportedFormats(level).back();
      const bool accepted = level >= minimum;
      check(factory.QueryCodecSupport(receive, "L1T1").is_supported == accepted &&
          static_cast<bool>(factory.Create(webrtc::CreateEnvironment(), receive)) == accepted,
          "Receiver level must cover the source while the encoder retains its own lower ceiling");
      Json router{{"codecs", Json::array({Json{{"mimeType", "video/H264"},
          {"parameters", receive.parameters}}})}};
      const auto accepts = [&](const auto& format) { return AcceptsEncodedFormat(format, minimum); };
      if (level >= minimum)
        check(peer_detail::SelectScreenSendCodec(router, accepts) == router["codecs"][0],
            "SFU router receive capability must cover the actual source level");
      else rejects([&] { peer_detail::SelectScreenSendCodec(router, accepts); });
    }
    context->source.reset();
    check(factory.GetSupportedFormats() == advertised, "Source retirement must not raise cached capabilities to Main6");
  }
  rejects([&] { CreateEncodedVideoFactory(50); });
  rejects([&] { CreateEncodedVideoFactory(61); });
  const auto verify_rate_estimate = [&](double fps, bool valid, std::uint32_t maximum_kbps = 20000) {
    std::vector<Json> feedback;
    auto rate_state = std::make_shared<State>(1, "cpu-rate-estimate", true,
        [&](std::string_view type, Json data) { data["type"] = type; feedback.push_back(std::move(data)); return true; });
    Encoder encoder(rate_state, MinimumEncodedLevel(rate_state->video));
    check(!encoder.GetEncoderInfo().has_trusted_rate_controller,
        "The external encoder must not claim perfectly applied rate control");
    webrtc::VideoCodec codec;
    codec.codecType = webrtc::kVideoCodecH264;
    codec.width = 1920; codec.height = 1080; codec.maxFramerate = 120;
    codec.startBitrate = 5000; codec.maxBitrate = maximum_kbps; codec.minBitrate = 64;
    codec.active = true; codec.mode = webrtc::VideoCodecMode::kScreensharing;
    codec.H264()->numberOfTemporalLayers = 1; codec.spatialLayers[0].numberOfTemporalLayers = 1;
    check(encoder.InitEncode(&codec, 4, 1200) == WEBRTC_VIDEO_CODEC_OK,
        "Device-free external rate-feedback encoder initialization failed");
    webrtc::VideoEncoder::RateControlParameters rates;
    rates.framerate_fps = fps;
    check(rates.bitrate.SetBitrate(0, 0, maximum_kbps * 1000 + 10000000), "Cannot set rate-estimate test allocation");
    encoder.SetRates(rates);
    check(rate_state->failed.load() != valid, "External H264 rate estimate validity was misclassified");
    if (valid) {
      const auto& event = feedback.back();
      check(event.at("type") == "source.encodedFeedback" && event.at("requestedFps") == fps &&
          event.at("fpsApplied").is_null(), "Arrival-rate feedback must remain explicit, not applied FPS");
      check(event.at("bitrateBps") == (fps > 0 ? maximum_kbps * 1000 : 0) &&
          rate_state->Snapshot().at("requestedFps") == 120,
          "Arrival estimates must preserve the bitrate ceiling and the120fps media configuration");
    } else {
      check(feedback.back().at("type") == "error" &&
          feedback.back().at("code") == "ERR_RTC_ENCODED_RATES",
          "Invalid rate feedback must surface a terminal error");
    }
    check(encoder.Release() == WEBRTC_VIDEO_CODEC_OK && rate_state->rates.empty(),
        "Rate-estimate checks must retire their actual encoder registration");
  };
  verify_rate_estimate(120.0, true, 80000);
  for (const auto fps : {0.0, 120.0, 240.001, 1000.0,
                        static_cast<double>((std::numeric_limits<std::uint32_t>::max)())})
    verify_rate_estimate(fps, true);
  for (const auto fps : {-1.0, std::numeric_limits<double>::quiet_NaN(),
                        std::numeric_limits<double>::infinity(),
                        static_cast<double>((std::numeric_limits<std::uint32_t>::max)()) + 1})
    verify_rate_estimate(fps, false);
  {
    struct Callback final : webrtc::EncodedImageCallback {
      std::vector<webrtc::VideoFrameType> frames;
      Result OnEncodedImage(const webrtc::EncodedImage& image, const webrtc::CodecSpecificInfo*) override {
        frames.push_back(image.FrameType());
        return Result(Result::OK);
      }
    } callback;
    std::size_t requests = 0;
    auto live = std::make_shared<State>(1, "cpu-pli-continuity", true,
        [&](std::string_view type, Json data) {
          if (type == "source.encodedFeedback" && data.at("kind") == "keyframe") ++requests;
          return true;
        });
    Encoder encoder(live, MinimumEncodedLevel(live->video));
    webrtc::VideoCodec codec;
    codec.codecType = webrtc::kVideoCodecH264;
    codec.width = 1920; codec.height = 1080; codec.maxFramerate = 120;
    codec.startBitrate = 5000; codec.maxBitrate = 20000; codec.minBitrate = 64;
    codec.active = true; codec.mode = webrtc::VideoCodecMode::kScreensharing;
    codec.H264()->numberOfTemporalLayers = 1; codec.spatialLayers[0].numberOfTemporalLayers = 1;
    check(encoder.InitEncode(&codec, 4, 1200) == WEBRTC_VIDEO_CODEC_OK, "Cannot initialize the PLI continuity check");
    check(encoder.RegisterEncodeCompleteCallback(&callback) == WEBRTC_VIDEO_CODEC_OK,
        "Cannot register the PLI continuity callback");
    std::uint64_t next_frame = 0;
    const auto encode = [&](bool independent, bool request) {
      auto token = std::make_shared<Token>();
      token->owner = live; token->generation = live->generation;
      token->level = MinimumEncodedLevel(live->video);
      token->metadata.frame_id = ++next_frame; token->metadata.keyframe = independent;
      token->metadata.timestamp_us = QpcNowUs(); token->metadata.duration_us = 8333;
      token->bytes = {1, 2, 3};
      auto buffer = webrtc::make_ref_counted<NativeBuffer>(token);
      const auto frame = webrtc::VideoFrame::Builder().set_video_frame_buffer(buffer)
          .set_timestamp_us(token->metadata.timestamp_us).build();
      const std::vector<webrtc::VideoFrameType> types{
          request ? webrtc::VideoFrameType::kVideoFrameKey : webrtc::VideoFrameType::kVideoFrameDelta};
      check(encoder.Encode(frame, &types) == WEBRTC_VIDEO_CODEC_OK, "The PLI continuity encoder failed");
    };
    encode(false, false);
    check(callback.frames.empty() && requests == 1, "A new encoder must still wait for a real independent frame");
    encode(true, true);
    encode(false, true);
    encode(false, true);
    check(callback.frames.size() == 3 && requests == 2 &&
        callback.frames.back() == webrtc::VideoFrameType::kVideoFrameDelta,
        "A PLI must preserve an established chain and coalesce requests until a real keyframe");
    encode(true, true);
    encode(false, true);
    check(callback.frames.size() == 5 && requests == 3 && !live->failed.load(),
        "Only a real keyframe may settle the receiver request");
    check(encoder.Release() == WEBRTC_VIDEO_CODEC_OK && live->buffers.empty(),
        "PLI continuity checks must retire their actual native buffers");
  }
  {
    // AV1: a receiver that negotiated less than the actual sequence is refused alone. It used to end the source for
    // every viewer at its first frame.
    struct Callback final : webrtc::EncodedImageCallback {
      std::size_t frames = 0;
      Result OnEncodedImage(const webrtc::EncodedImage&, const webrtc::CodecSpecificInfo*) override {
        ++frames;
        return Result(Result::OK);
      }
    } low_frames, high_frames;
    std::vector<Json> av1_events;
    const EncodedConfiguration video{1920, 1080, 120, true};
    auto shared = std::make_shared<State>(1, "av1-receiver-levels", true,
        [&](std::string_view type, Json data) { data["type"] = type; av1_events.push_back(std::move(data)); return true; },
        video);
    const auto minimum = MinimumAv1Level(video);
    const auto receiver = [](unsigned level) {
      return webrtc::SdpVideoFormat("AV1", {{"profile", "0"}, {"level-idx", std::to_string(level)}, {"tier", "0"}});
    };
    auto context = std::make_shared<EncodedVideoContext>(kEncodedH264Level, true);
    context->source = shared;
    Factory factory(context);
    check(factory.QueryCodecSupport(receiver(minimum), "L1T1").is_supported &&
        !factory.QueryCodecSupport(receiver(minimum - 1u), "L1T1").is_supported,
        "Before a sequence is admitted, the source geometry sets the AV1 receive minimum");
    webrtc::VideoCodec codec;
    codec.codecType = webrtc::kVideoCodecAV1;
    codec.width = 1920; codec.height = 1080; codec.maxFramerate = 120;
    codec.startBitrate = 5000; codec.maxBitrate = 20000; codec.minBitrate = 64;
    codec.active = true; codec.mode = webrtc::VideoCodecMode::kScreensharing;
    Encoder low(shared, minimum), high(shared, 23);
    check(low.InitEncode(&codec, 4, 1200) == WEBRTC_VIDEO_CODEC_OK &&
        high.InitEncode(&codec, 4, 1200) == WEBRTC_VIDEO_CODEC_OK &&
        low.RegisterEncodeCompleteCallback(&low_frames) == WEBRTC_VIDEO_CODEC_OK &&
        high.RegisterEncodeCompleteCallback(&high_frames) == WEBRTC_VIDEO_CODEC_OK,
        "Cannot initialize the AV1 receiver-level check");
    std::uint64_t next_frame = 0;
    for (const bool keyframe : {true, false, false}) {
      auto token = std::make_shared<Token>();
      token->owner = shared; token->generation = shared->generation;
      token->level = static_cast<std::uint8_t>(minimum + 1);
      token->metadata.frame_id = ++next_frame; token->metadata.keyframe = keyframe;
      token->metadata.timestamp_us = QpcNowUs(); token->metadata.duration_us = 8333;
      token->bytes = {1, 2, 3};
      auto buffer = webrtc::make_ref_counted<NativeBuffer>(token);
      const auto picture = webrtc::VideoFrame::Builder().set_video_frame_buffer(buffer)
          .set_timestamp_us(token->metadata.timestamp_us).build();
      const std::vector<webrtc::VideoFrameType> types{
          keyframe ? webrtc::VideoFrameType::kVideoFrameKey : webrtc::VideoFrameType::kVideoFrameDelta};
      check(low.Encode(picture, &types) == WEBRTC_VIDEO_CODEC_OK && high.Encode(picture, &types) == WEBRTC_VIDEO_CODEC_OK,
          "An AV1 receiver-level mismatch failed the encoder callback");
    }
    const auto errors = std::count_if(av1_events.begin(), av1_events.end(),
        [](const Json& event) { return event.at("type") == "error"; });
    const auto reported = std::find_if(av1_events.begin(), av1_events.end(),
        [](const Json& event) { return event.at("type") == "error"; });
    check(!shared->failed.load() && low_frames.frames == 0 && high_frames.frames == 3 && errors == 1 &&
        reported->at("terminal") == false && reported->at("code") == "ERR_RTC_ENCODED_LEVEL",
        "An AV1 receiver below the actual level must be refused alone, reported once, without ending the source");
    {
      std::lock_guard lock(shared->mutex);
      shared->av1_level = static_cast<std::uint8_t>(minimum + 1);
      ++shared->admitted;
    }
    check(!factory.QueryCodecSupport(receiver(minimum), "L1T1").is_supported &&
        !factory.Create(webrtc::CreateEnvironment(), receiver(minimum)) &&
        factory.QueryCodecSupport(receiver(minimum + 1u), "L1T1").is_supported,
        "Once the actual AV1 level is admitted, lower receivers must be refused at negotiation");
    check(low.Release() == WEBRTC_VIDEO_CODEC_OK && high.Release() == WEBRTC_VIDEO_CODEC_OK &&
        shared->buffers.empty() && shared->rates.empty(),
        "AV1 receiver-level checks must retire their encoders and native buffers");
  }
  std::vector<Json> events;
  auto state = std::make_shared<State>(1, "cpu-encoded", true,
      [&](std::string_view type, Json data) { data["type"] = type; events.push_back(std::move(data)); return true; });
  state->rates.emplace(1, 20000000);
  state->rates.emplace(2, 10000000);
  state->Rates(1, 30000000, 120);
  check(events.back().at("bitrateBps") == 10000000 && events.back().at("requestedBitrateBps") == 30000000,
      "Shared-source bitrate ceiling/consumer minimum is not explicit");
  state->Rates(1, 0, 120);
  check(!events.back().at("paused").get<bool>(), "One paused peer must not mute an active peer");
  state->Rates(2, 0, 120);
  check(events.back().at("paused").get<bool>() && events.back().at("bitrateBps") == 0,
      "Zero aggregate feedback must pause admission");
  state->Rates(2, 1000000, 120);
  check(!events.back().at("paused").get<bool>(), "Positive feedback must be observable on resume");
  state->Keyframe(2);
  check(events.back().at("keyframeConfirmed") == false && events.back().at("maximumWaitMs") == 1500,
      "Keyframe request must not fabricate an observed IDR");
  state->EncoderClosed(1);
  state->EncoderClosed(2);
  check(state->rates.empty(), "Released encoder sessions must leave no feedback registrations");
  auto token = std::make_shared<Token>();
  token->owner = state;
  auto dispatch = webrtc::make_ref_counted<NativeBuffer>(token);
  auto second_reference = dispatch;
  dispatch = nullptr;
  check(!token->dispatch_retired.load() && state->buffers.size() == 1,
      "Compressed dispatch cannot advance while RTC retains the native buffer");
  second_reference = nullptr;
  check(token->dispatch_retired.load() && state->buffers.empty(),
      "Actual frame-buffer retirement must unblock the next compressed dispatch");
  check(state->Snapshot().at("rawConversions") == 0, "Pure encoded policies must not read pixels");
  const auto retain = [&](std::uint64_t id) {
    auto value = std::make_shared<Token>();
    value->owner = state; value->metadata.frame_id = id; value->bytes = {1, 2, 3};
    value->generation = state->generation; value->admitted = true;
    state->retained.emplace(id, value); state->retained_bytes += value->bytes.size(); ++state->admitted;
    return value;
  };
  auto missing = retain(1), queued = retain(2);
  missing->expected.store(1); state->queue.push_back(queued);
  auto dropped_buffer = webrtc::make_ref_counted<NativeBuffer>(missing);
  const auto before_generation = state->generation;
  dropped_buffer = nullptr;
  check(missing->dispatch_retired.load() && missing->unconsumed.load() && !state->failed.load(),
      "A real pre-codec RTC discard must request recovery before releasing dispatch credit");
  check(state->generation == before_generation + 1 && state->need_idr && state->recovering &&
      state->queue.empty() && queued->cancelled.load() && state->recovery_discards == 1,
      "A discarded compressed picture must fence its queued dependencies");
  check(state->retained.size() == 2, "Recovery must not fabricate compressed-byte retirement");
  queued.reset();
  check(state->retained.size() == 1 && state->released == 1, "Only actual reference retirement returns copy credit");
  state->Recover(before_generation, 1, "rtc-unconsumed");
  check(state->recovery_requests == 1, "An old epoch must not invalidate a newer recovery again");
  auto replacement = retain(3);
  replacement->metadata.keyframe = 1;
  state->Forwarded(*replacement);
  check(state->recovering, "IDR admission without callback acceptance must not complete recovery");
  missing->metadata.keyframe = 1; missing->accepted.store(1);
  state->Forwarded(*missing);
  check(state->recovering, "A callback from a retired generation must not complete recovery");
  replacement->accepted.store(1); state->Forwarded(*replacement);
  check(!state->recovering && state->recovery_completions == 1,
      "Only a current, actually accepted IDR completes compressed recovery");
  missing.reset(); replacement.reset();
  check(state->retained.empty() && state->retained_bytes == 0, "Recovery must eventually retire every owned byte");
  {
    CaptureClockMapping uncertain;
    uncertain.status = CaptureClockStatus::kSampleUncertain;
    const auto requests = state->recovery_requests, expired = state->expired;
    auto dependent = retain(8);
    state->queue.push_back(dependent);
    check(!state->AcceptClockMapping(uncertain, state->generation, 7) &&
        !state->failed.load() && state->need_idr && state->recovering &&
        dependent->cancelled.load() && state->queue.empty() && state->recovery_requests == requests + 1 &&
        state->expired == expired,
        "Uncertain clock sampling must fence compressed dependencies without terminating the source or counting expiry");
    dependent.reset();
    const auto deadline = state->recovery_frames;
    check(!state->AcceptClockMapping(uncertain, state->generation, 9) && state->recovery_frames == deadline,
        "Repeated uncertain clock sampling must not extend the recovery deadline");
    CaptureClockMapping valid;
    check(state->AcceptClockMapping(valid, state->generation, 10) && state->recovering,
        "A valid clock sample alone must not pretend that a replacement IDR was delivered");
    auto resumed = retain(10);
    resumed->metadata.keyframe = 1; resumed->accepted.store(1);
    state->Forwarded(*resumed);
    check(!state->recovering && !state->failed.load(), "A real current IDR must resume after uncertain clock sampling");
    resumed.reset();
    // Every status the mapper documents as a frame drop recovers like uncertain sampling; none ends the source.
    for (const auto status : {CaptureClockStatus::kSampleFailed, CaptureClockStatus::kFutureCapture,
                              CaptureClockStatus::kStaleCapture, CaptureClockStatus::kUntranslatable,
                              CaptureClockStatus::kNonMonotonicCapture, CaptureClockStatus::kNonMonotonicTranslation}) {
      CaptureClockMapping dropped;
      dropped.status = status;
      const auto before = state->recovery_requests, expired_before = state->expired;
      auto queued_dependent = retain(20);
      state->queue.push_back(queued_dependent);
      check(!state->AcceptClockMapping(dropped, state->generation, 19) && !state->failed.load() &&
          state->need_idr && state->recovering && queued_dependent->cancelled.load() && state->queue.empty() &&
          state->recovery_requests == before + 1 && state->expired == expired_before &&
          events.back().at("reason") == "clock-frame-dropped" &&
          events.back().at("clockStatus") == CaptureClockErrorCode(status),
          "A clock status documented as a frame drop must fence its dependents instead of ending the source");
      queued_dependent.reset();
      auto idr = retain(21);
      idr->metadata.keyframe = 1; idr->accepted.store(1);
      state->Forwarded(*idr);
      idr.reset();
      check(!state->recovering, "A real IDR must resume after a dropped clock mapping");
    }
    for (const auto status : {CaptureClockStatus::kInvalidTimestamp, CaptureClockStatus::kClockDiscontinuity,
                              CaptureClockStatus::kSourceResetRequired, CaptureClockStatus::kClosed}) {
      CaptureClockMapping invalid;
      invalid.status = status;
      rejects([&] { state->AcceptClockMapping(invalid, state->generation, 11); });
    }
  }
  {
    const auto requests = state->recovery_requests, expired = state->expired, generation = state->generation;
    auto delayed = retain(12), dependent = retain(13);
    state->queue.push_back(dependent);
    auto held = webrtc::make_ref_counted<NativeBuffer>(delayed);
    // The modeled RTC thread retires the dispatch only after the stall has already been recovered.
    std::thread rtc([&] {
      std::unique_lock lock(state->mutex);
      state->wake.wait(lock, [&] { return state->generation != generation; });
      lock.unlock();
      held = nullptr;
    });
    state->AwaitDispatch(delayed, std::chrono::microseconds(1000), std::chrono::seconds(5));
    rtc.join();
    check(delayed->dispatch_retired.load() && !delayed->unconsumed.load() && !state->failed.load() &&
        state->generation == generation + 1 && state->need_idr && state->recovering &&
        dependent->cancelled.load() && state->queue.empty() && state->recovery_requests == requests + 1 &&
        state->expired == expired,
        "A dispatch delayed past the age bound must fence stale dependencies and resume without ending the source");
    auto stuck = retain(14);
    auto never = webrtc::make_ref_counted<NativeBuffer>(stuck);
    rejects([&] { state->AwaitDispatch(stuck, std::chrono::microseconds(1000), std::chrono::microseconds(1000)); });
    never = nullptr;
    delayed.reset(); dependent.reset(); stuck.reset();
    check(state->retained.empty(), "Delayed dispatch recovery must still retire every owned byte");
  }
  state->Recover(state->generation, 4, "input-expired");
  state->recovery_frames = 5;
  state->Recover(state->generation, 5, "publication-expired");
  check(state->expired == 2 && state->recovery_frames == 5,
      "Repeated discarded IDRs cannot keep extending the recovery deadline");
  state->recovery_frames = RecoveryFrameBound(state->video);
  state->CheckRecoveryDeadline();
  check(!state->failed.load(), "A slow encoder within its configured GOP bound must keep recovering");
  state->recovery_frames = RecoveryFrameBound(state->video) + 1;
  rejects([&] { state->CheckRecoveryDeadline(); });
  rejects([&] { state->Recover(state->generation, 6, "codec-expired"); });
  state->recovering = false; state->stopping.store(true);
  const auto before_requests = state->recovery_requests;
  state->Recover(state->generation, 7, "codec-expired");
  check(state->recovery_requests == before_requests, "Shutdown must not restart compressed recovery");
  std::uint64_t previous_sequence = 0;
  for (const auto& event : events) {
    if (event.at("type") != "source.encodedFeedback") continue;
    const auto sequence = event.at("sequence").get<std::uint64_t>();
    check(sequence > previous_sequence, "Encoded feedback must be sequenced at actual delivery");
    previous_sequence = sequence;
  }
}

}  // namespace monky::native_rtc::engine
