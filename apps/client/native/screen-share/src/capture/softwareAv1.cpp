#include "softwareAv1.h"
#pragma warning(push)
#pragma warning(disable: 4201)
#include "obs.h"
#pragma warning(pop)
#include "../rtc/inputs/abi/monky_av1.h"
#include "../rtc/inputs/native_core/av1_obu.h"

#include <algorithm>
#include <cstring>
#include <memory>
#include <stdexcept>
#include <thread>
#include <vector>

namespace {
#define OBS_FUNCTIONS(X) \
  X(obs_data_get_int) X(obs_data_set_default_int) X(obs_data_set_default_string) \
  X(obs_encoder_video) X(video_output_get_info) X(obs_encoder_set_last_error) \
  X(obs_properties_create) X(obs_properties_add_int) X(obs_properties_add_list) \
  X(obs_property_list_add_string) X(obs_register_encoder_s)
#define FIELD(name) decltype(&name) name;
struct Api { OBS_FUNCTIONS(FIELD) };
#undef FIELD
Api api{};
decltype(&MonkyAv1Create) createAv1 = nullptr;
decltype(&MonkyAv1Encode) encodeAv1 = nullptr;
decltype(&MonkyAv1SetBitrate) bitrateAv1 = nullptr;
decltype(&MonkyAv1Destroy) destroyAv1 = nullptr;

template <typename T> T Symbol(HMODULE library, const char* name) {
  auto address = GetProcAddress(library, name);
  if (!address) throw std::runtime_error(std::string("Missing software encoder symbol: ") + name);
  T function;
  static_assert(sizeof(function) == sizeof(address));
  std::memcpy(&function, &address, sizeof(function));
  return function;
}
struct Encoder {
  obs_encoder_t* owner = nullptr;
  void* codec = nullptr;
  bool failed = false;
  std::vector<uint8_t> headers;
  ~Encoder() { if (codec) destroyAv1(codec); }
};
void* Create(obs_data_t* settings, obs_encoder_t* owner) noexcept {
  try {
    auto encoder = std::make_unique<Encoder>();
    encoder->owner = owner;
    const auto* video = api.video_output_get_info(api.obs_encoder_video(owner));
    const auto bitrate = api.obs_data_get_int(settings, "bitrate");
    if (!video || video->fps_den != 1 || bitrate < 50 || bitrate > 80000)
      throw std::runtime_error("Invalid libobs software AV1 configuration");
    MonkyAv1Config config{video->width, video->height, video->fps_num, static_cast<uint32_t>(bitrate),
        (std::clamp)(std::thread::hardware_concurrency(), 1u, 8u)};
    char error[1024]{};
    encoder->codec = createAv1(&config, error, sizeof(error));
    if (!encoder->codec) throw std::runtime_error(error);
    return encoder.release();
  } catch (const std::exception& failure) { api.obs_encoder_set_last_error(owner, failure.what()); }
  catch (...) { api.obs_encoder_set_last_error(owner, "Unknown software AV1 initialization failure"); }
  return nullptr;
}
bool Encode(void* opaque, encoder_frame* frame, encoder_packet* packet, bool* received) noexcept {
  auto& encoder = *static_cast<Encoder*>(opaque);
  *received = false;
  if (encoder.failed) return false;
  try {
    if (!frame) return true;
    const uint8_t* planes[]{frame->data[0], frame->data[1], frame->data[2]};
    const uint32_t strides[]{frame->linesize[0], frame->linesize[1], frame->linesize[2]};
    MonkyAv1Packet output{};
    char error[1024]{};
    if (!encodeAv1(encoder.codec, planes, strides, frame->pts, &output, error, sizeof(error)))
      throw std::runtime_error(error);
    const auto info = monky::screen_video::InspectAv1({output.data, output.bytes});
    if (!info.picture || info.keyframe != (output.keyframe != 0) || (info.keyframe && !info.sequence))
      throw std::runtime_error("Software AV1 output contradicts its keyframe contract");
    if (info.sequence) encoder.headers = info.sequence_header;
    packet->data = const_cast<uint8_t*>(output.data); packet->size = output.bytes;
    packet->pts = output.pts; packet->dts = output.pts;
    packet->keyframe = output.keyframe != 0; packet->type = OBS_ENCODER_VIDEO;
    *received = true;
    return true;
  } catch (const std::exception& failure) { api.obs_encoder_set_last_error(encoder.owner, failure.what()); }
  catch (...) { api.obs_encoder_set_last_error(encoder.owner, "Unknown software AV1 encode failure"); }
  return false;
}
bool Update(void* opaque, obs_data_t* settings) noexcept {
  auto& encoder = *static_cast<Encoder*>(opaque);
  const auto bitrate = api.obs_data_get_int(settings, "bitrate");
  char error[1024]{};
  if (bitrate < 50 || bitrate > 80000) {
    encoder.failed = true;
    api.obs_encoder_set_last_error(encoder.owner, "Software AV1 bitrate is outside its bounds");
    return false;
  }
  if (!bitrateAv1(encoder.codec, static_cast<uint32_t>(bitrate), error, sizeof(error))) {
    // libobs ignores the update return value; stop the next encode as well.
    encoder.failed = true;
    api.obs_encoder_set_last_error(encoder.owner, error);
    return false;
  }
  return true;
}
void Defaults(obs_data_t* settings) {
  api.obs_data_set_default_int(settings, "bitrate", 5000);
  api.obs_data_set_default_int(settings, "keyint_sec", 1);
  api.obs_data_set_default_string(settings, "rate_control", "CBR");
}
obs_properties_t* Properties(void*) {
  auto* properties = api.obs_properties_create();
  api.obs_properties_add_int(properties, "bitrate", "Bitrate", 50, 80000, 50);
  api.obs_properties_add_int(properties, "keyint_sec", "Keyframe interval", 1, 1, 1);
  auto* rate = api.obs_properties_add_list(properties, "rate_control", "Rate control",
      OBS_COMBO_TYPE_LIST, OBS_COMBO_FORMAT_STRING);
  api.obs_property_list_add_string(rate, "CBR", "CBR");
  return properties;
}
}

void RegisterSoftwareAv1(HMODULE obs, HMODULE av1) {
#define LOAD(name) api.name = Symbol<decltype(api.name)>(obs, #name);
  OBS_FUNCTIONS(LOAD)
#undef LOAD
  createAv1 = Symbol<decltype(createAv1)>(av1, "MonkyAv1Create");
  encodeAv1 = Symbol<decltype(encodeAv1)>(av1, "MonkyAv1Encode");
  bitrateAv1 = Symbol<decltype(bitrateAv1)>(av1, "MonkyAv1SetBitrate");
  destroyAv1 = Symbol<decltype(destroyAv1)>(av1, "MonkyAv1Destroy");
  obs_encoder_info info{};
  info.id = "monky_aom_av1"; info.type = OBS_ENCODER_VIDEO; info.codec = "av1";
  info.get_name = [](void*) { return "Monky AV1 software (libaom realtime)"; };
  info.create = Create; info.encode = Encode; info.update = Update;
  info.destroy = [](void* encoder) { delete static_cast<Encoder*>(encoder); };
  info.get_defaults = Defaults; info.get_properties = Properties;
  info.get_video_info = [](void*, video_scale_info* video) { video->format = VIDEO_FORMAT_I420; };
  info.get_extra_data = [](void* opaque, uint8_t** bytes, size_t* count) {
    auto& headers = static_cast<Encoder*>(opaque)->headers;
    *bytes = headers.data(); *count = headers.size();
    return !headers.empty();
  };
  info.caps = OBS_ENCODER_CAP_DYN_BITRATE;
  api.obs_register_encoder_s(&info, sizeof(info));
}
