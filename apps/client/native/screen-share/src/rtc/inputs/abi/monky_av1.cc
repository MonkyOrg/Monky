#include "monky_av1.h"
#include "aom/aom_encoder.h"
#include "aom/aomcx.h"
#include "av1_sequence.h"

#include <algorithm>
#include <cstdio>
#include <memory>
#include <new>
#include <stdexcept>
#include <vector>

namespace {
struct Encoder {
  aom_codec_ctx_t codec{};
  aom_codec_enc_cfg_t config{};
  bool initialized = false;
  std::vector<uint8_t> packet;
  ~Encoder() { if (initialized) aom_codec_destroy(&codec); }
  void Check(aom_codec_err_t result) {
    if (result != AOM_CODEC_OK) {
      const char* detail = aom_codec_error_detail(&codec);
      throw std::runtime_error(detail ? detail : aom_codec_err_to_string(result));
    }
  }
};
void Error(char* output, size_t capacity, const char* message) noexcept {
  if (output && capacity) std::snprintf(output, capacity, "%s", message);
}
}

extern "C" {
void* MonkyAv1Create(const MonkyAv1Config* requested, char* error, size_t capacity) {
  try {
    if (!requested || requested->width < 4 || requested->width > 3840 || requested->width % 4 ||
        requested->height < 2 || requested->height > 2160 || requested->height % 2 ||
        !requested->fps || requested->fps > 120 || requested->bitrate_kbps < 50 ||
        requested->bitrate_kbps > 80000 || !requested->threads || requested->threads > 16)
      throw std::runtime_error("Invalid real-time AV1 configuration");
    auto encoder = std::make_unique<Encoder>();
    encoder->Check(aom_codec_enc_config_default(aom_codec_av1_cx(), &encoder->config, AOM_USAGE_REALTIME));
    auto& config = encoder->config;
    config.g_w = requested->width; config.g_h = requested->height;
    config.g_timebase = {1, static_cast<int>(requested->fps)};
    config.g_threads = requested->threads;
    config.g_lag_in_frames = 0;
    config.rc_end_usage = AOM_CBR;
    config.rc_target_bitrate = requested->bitrate_kbps;
    config.rc_min_quantizer = 10; config.rc_max_quantizer = 56;
    config.rc_dropframe_thresh = 0;
    config.rc_buf_sz = 600; config.rc_buf_initial_sz = 400; config.rc_buf_optimal_sz = 400;
    config.kf_mode = AOM_KF_AUTO;
    config.kf_min_dist = requested->fps; config.kf_max_dist = requested->fps;
    encoder->Check(aom_codec_enc_init(&encoder->codec, aom_codec_av1_cx(), &config, 0));
    encoder->initialized = true;
    encoder->Check(aom_codec_control(&encoder->codec, AOME_SET_CPUUSED, 10));
    encoder->Check(aom_codec_control(&encoder->codec, AV1E_SET_ROW_MT, 1));
    encoder->Check(aom_codec_control(&encoder->codec, AV1E_SET_COLOR_PRIMARIES, 1));
    encoder->Check(aom_codec_control(&encoder->codec, AV1E_SET_TRANSFER_CHARACTERISTICS, 1));
    encoder->Check(aom_codec_control(&encoder->codec, AV1E_SET_MATRIX_COEFFICIENTS, 1));
    encoder->Check(aom_codec_control(&encoder->codec, AV1E_SET_COLOR_RANGE, 0));
    return encoder.release();
  } catch (const std::exception& failure) { Error(error, capacity, failure.what()); }
  catch (...) { Error(error, capacity, "Unknown AV1 encoder initialization failure"); }
  return nullptr;
}

int MonkyAv1Encode(void* opaque, const uint8_t* const planes[3], const uint32_t strides[3],
                   int64_t pts, MonkyAv1Packet* output, char* error, size_t capacity) {
  try {
    if (!opaque || !output || !planes || !strides || !planes[0] || !planes[1] || !planes[2])
      throw std::runtime_error("Missing AV1 input planes");
    auto& encoder = *static_cast<Encoder*>(opaque);
    aom_image_t image{};
    if (!aom_img_wrap(&image, AOM_IMG_FMT_I420, encoder.config.g_w, encoder.config.g_h, 1,
                      const_cast<uint8_t*>(planes[0])))
      throw std::runtime_error("Cannot describe AV1 input");
    for (size_t plane = 0; plane < 3; ++plane) {
      if (strides[plane] < (encoder.config.g_w >> (plane ? 1 : 0)) || strides[plane] > 65536)
        throw std::runtime_error("Invalid AV1 input stride");
      image.planes[plane] = const_cast<uint8_t*>(planes[plane]);
      image.stride[plane] = static_cast<int>(strides[plane]);
    }
    image.cp = AOM_CICP_CP_BT_709; image.tc = AOM_CICP_TC_BT_709;
    image.mc = AOM_CICP_MC_BT_709; image.range = AOM_CR_STUDIO_RANGE;
    encoder.Check(aom_codec_encode(&encoder.codec, &image, pts, 1, 0));
    encoder.packet.clear();
    aom_codec_iter_t iterator = nullptr;
    const aom_codec_cx_pkt_t* packet;
    bool found = false;
    while ((packet = aom_codec_get_cx_data(&encoder.codec, &iterator))) {
      if (packet->kind != AOM_CODEC_CX_FRAME_PKT) continue;
      if (found || packet->data.frame.sz == 0 || packet->data.frame.sz > 4 * 1024 * 1024 ||
          packet->data.frame.pts != pts)
        throw std::runtime_error("AV1 encoder did not produce one bounded zero-lag frame");
      found = true;
      const auto* bytes = static_cast<const uint8_t*>(packet->data.frame.buf);
      encoder.packet.assign(bytes, bytes + packet->data.frame.sz);
      *output = {encoder.packet.data(), encoder.packet.size(), pts,
                 (packet->data.frame.flags & AOM_FRAME_IS_KEY) ? 1u : 0u};
    }
    if (!found) throw std::runtime_error("Real-time AV1 encoder buffered its input frame");
    return 1;
  } catch (const std::exception& failure) { Error(error, capacity, failure.what()); }
  catch (...) { Error(error, capacity, "Unknown AV1 encode failure"); }
  return 0;
}

int MonkyAv1SetBitrate(void* opaque, uint32_t bitrate, char* error, size_t capacity) {
  try {
    if (!opaque || bitrate < 50 || bitrate > 80000) throw std::runtime_error("Invalid AV1 bitrate");
    auto& encoder = *static_cast<Encoder*>(opaque);
    auto config = encoder.config;
    config.rc_target_bitrate = bitrate;
    encoder.Check(aom_codec_enc_config_set(&encoder.codec, &config));
    encoder.config = config;
    return 1;
  } catch (const std::exception& failure) { Error(error, capacity, failure.what()); }
  catch (...) { Error(error, capacity, "Unknown AV1 bitrate update failure"); }
  return 0;
}
void MonkyAv1Destroy(void* opaque) { delete static_cast<Encoder*>(opaque); }
int MonkyAv1Validate(const uint8_t* bytes, size_t size, uint32_t width, uint32_t height,
                    char* error, size_t capacity) {
  try {
    if (!bytes) throw std::runtime_error("Missing AV1 sequence");
    monky::screen_video::ReadAv1Sequence({bytes, size}, width, height);
    return 1;
  } catch (const std::exception& failure) { Error(error, capacity, failure.what()); }
  catch (...) { Error(error, capacity, "Unknown AV1 sequence validation failure"); }
  return 0;
}
}
