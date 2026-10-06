#pragma once
#include "monky_av1.h"
#include "av1_sequence.h"
#include <algorithm>
#include <cstring>
#include <memory>

namespace monky::native_rtc::engine {
template <class Check>
void RunAv1EncoderChecks(Check check) {
  char error[512]{};
  MonkyAv1Config config{320, 180, 30, 400, 2};
  std::unique_ptr<void, decltype(&MonkyAv1Destroy)> encoder(
      MonkyAv1Create(&config, error, sizeof(error)), MonkyAv1Destroy);
  check(encoder != nullptr, error);
  auto invalid = config; invalid.width = 319;
  check(MonkyAv1Create(&invalid, error, sizeof(error)) == nullptr && error[0],
        "AV1 must reject invalid dimensions with an explicit cause");
  check(!MonkyAv1SetBitrate(encoder.get(), 0, error, sizeof(error)),
        "AV1 must reject an invalid bitrate without changing its running encoder");
  std::vector<std::uint8_t> y(config.width * config.height), u(y.size() / 4, 128), v(u);
  const std::uint8_t* planes[]{y.data(), u.data(), v.data()};
  const std::uint32_t strides[]{config.width, config.width / 2, config.width / 2};
  Dav1dSettings settings{};
  dav1d_default_settings(&settings);
  settings.n_threads = 1; settings.max_frame_delay = 1; settings.frame_size_limit = y.size();
  Dav1dContext* raw = nullptr;
  check(dav1d_open(&raw, &settings) == 0, "Cannot create the bounded synthetic AV1 decoder");
  const auto close = [](Dav1dContext* context) { dav1d_close(&context); };
  std::unique_ptr<Dav1dContext, decltype(close)> decoder(raw, close);
  unsigned keyframes = 0;
  for (unsigned index = 0; index < 65; ++index) {
    const std::uint8_t brightness = index < 30 ? 40 : 160;
    std::fill(y.begin(), y.end(), brightness);
    if (index == 20)
      check(MonkyAv1SetBitrate(encoder.get(), 800, error, sizeof(error)) != 0,
            "AV1 must apply dynamic bitrate without replacing its timeline");
    MonkyAv1Packet packet{};
    check(MonkyAv1Encode(encoder.get(), planes, strides, index, &packet, error, sizeof(error)) != 0, error);
    check(packet.pts == index && packet.bytes > 0 && packet.bytes <= 4 * 1024 * 1024,
          "AV1 must produce one bounded zero-lag frame per input timestamp");
    const auto info = screen_video::InspectAv1({packet.data, packet.bytes});
    check(info.picture && info.keyframe == (packet.keyframe != 0), "AV1 picture/keyframe metadata disagrees");
    if (packet.keyframe) {
      ++keyframes;
      check(info.sequence && MonkyAv1Validate(packet.data, packet.bytes, config.width, config.height,
            error, sizeof(error)), "Every AV1 keyframe must carry a conformant independent sequence");
    }
    Dav1dData data{};
    auto* copied = dav1d_data_create(&data, packet.bytes);
    check(copied != nullptr, "Cannot copy the bounded synthetic AV1 packet");
    std::memcpy(copied, packet.data, packet.bytes);
    const auto submitted = dav1d_send_data(decoder.get(), &data);
    dav1d_data_unref(&data);
    check(submitted == 0, "AV1 synthetic decoder rejected an encoded frame");
    Dav1dPicture picture{};
    const auto decoded = dav1d_get_picture(decoder.get(), &picture);
    check(decoded == 0, "AV1 decoder must not buffer the real-time picture");
    const bool geometry = picture.p.w == static_cast<int>(config.width) &&
        picture.p.h == static_cast<int>(config.height) && picture.p.bpc == 8 &&
        picture.p.layout == DAV1D_PIXEL_LAYOUT_I420;
    const auto sample = static_cast<const std::uint8_t*>(picture.data[0])[config.width / 2];
    dav1d_picture_unref(&picture);
    check(geometry && std::abs(static_cast<int>(sample) - brightness) < 10,
          "Decoded AV1 pixels or geometry do not match the synthetic input");
  }
  check(keyframes >= 3, "AV1 must produce independent keyframes at least every second");
}
}
