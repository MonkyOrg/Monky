#pragma once

#include <cstdarg>
#include <cstddef>
#include <cstdint>
#include <type_traits>

struct HWND__;

// Declaration-only x64 ABI, not copied OBS implementations.
// https://github.com/obsproject/obs-studio/tree/7272af1375b38bc3cf4e0f98a5d999e8b76e9309
// Layouts: libobs/obs.h (obs_video_info), obs-output.h, obs-encoder.h,
// callback/calldata.h, graphics/vec2.h. Signatures: obs.h, obs-data.h,
// obs-properties.h, callback/proc.h, util/base.h, util/bmem.h,
// graphics/graphics.h and util/windows/window-helpers.h.
// Module identity/config getters: pinned obs.h:503,521,533,536,661.
// Private source loading/canvas ownership: obs.h:836,875,1687,1759,2614-2688;
// encoder/output readback: obs.h:2040,2422; in-memory JSON: obs-data.h.
namespace monky::screen_capture::abi {

struct Source;
struct Scene;
struct SceneItem;
struct Output;
struct Encoder;
struct Data;
struct Properties;
struct Property;
struct Module;
struct ProcHandler;
struct Video;
struct VideoData;
struct AudioData;
struct ProfilerNameStore;
struct Canvas;

enum class VideoFormat : int { Nv12 = 2 };
enum class ColorSpace : int { Bt709 = 2 };
enum class Range : int { Partial = 1 };
enum class Scale : int { Bicubic = 2 };
enum class Bounds : int { Stretch = 1 };
enum class EncoderType : int { Audio = 0, Video = 1 };
enum class PropertyType : int { Boolean = 1, Integer = 2, Text = 4, List = 6 };
enum class ComboFormat : int { Integer = 1, String = 3 };
enum class WindowSearch : int { IncludeMinimized = 0 };
enum class WindowPriority : int { Title = 1 };
enum class TaskType : int { Graphics = 1, Destroy = 3 };

struct Vec2 { float x; float y; };

struct VideoInfo {
  const char* graphics_module;
  std::uint32_t fps_num;
  std::uint32_t fps_den;
  std::uint32_t base_width;
  std::uint32_t base_height;
  std::uint32_t output_width;
  std::uint32_t output_height;
  VideoFormat output_format;
  std::uint32_t adapter;
  bool gpu_conversion;
  ColorSpace colorspace;
  Range range;
  Scale scale_type;
};

struct EncoderPacket {
  std::uint8_t* data;
  std::size_t size;
  std::int64_t pts;
  std::int64_t dts;
  std::int32_t timebase_num;
  std::int32_t timebase_den;
  EncoderType type;
  bool keyframe;
  std::int64_t dts_usec;
  std::int64_t sys_dts_usec;
  int priority;
  int drop_priority;
  std::size_t track_idx;
  Encoder* encoder;
};

struct CallData {
  std::uint8_t* stack;
  std::size_t size;
  std::size_t capacity;
  bool fixed;
};

struct OutputInfo {
  const char* id;
  std::uint32_t flags;
  const char*(__cdecl* get_name)(void*);
  void*(__cdecl* create)(Data*, Output*);
  void(__cdecl* destroy)(void*);
  bool(__cdecl* start)(void*);
  void(__cdecl* stop)(void*, std::uint64_t);
  void(__cdecl* raw_video)(void*, VideoData*);
  void(__cdecl* raw_audio)(void*, AudioData*);
  void(__cdecl* encoded_packet)(void*, EncoderPacket*);
  void(__cdecl* update)(void*, Data*);
  void(__cdecl* get_defaults)(Data*);
  Properties*(__cdecl* get_properties)(void*);
  void(__cdecl* unused1)(void*);
  std::uint64_t(__cdecl* get_total_bytes)(void*);
  int(__cdecl* get_dropped_frames)(void*);
  void* type_data;
  void(__cdecl* free_type_data)(void*);
  float(__cdecl* get_congestion)(void*);
  int(__cdecl* get_connect_time_ms)(void*);
  const char* encoded_video_codecs;
  const char* encoded_audio_codecs;
  void(__cdecl* raw_audio2)(void*, std::size_t, AudioData*);
  const char* protocols;
};

constexpr std::uint32_t kVideoEncoded = 1u | 4u;
constexpr std::uint32_t kPassTexture = 2u;
constexpr std::uint32_t kDynamicBitrate = 4u;
constexpr std::uint32_t kMainCanvas = 1u;
constexpr int kLogError = 100;
constexpr int kLogWarning = 200;
using LogHandler = void(__cdecl*)(int, const char*, va_list, void*);
using Task = void(__cdecl*)(void*);

struct Api {
  bool(__cdecl* obs_startup)(const char*, const char*, ProfilerNameStore*) = nullptr;
  void(__cdecl* obs_shutdown)() = nullptr;
  const char*(__cdecl* obs_get_version_string)() = nullptr;
  void(__cdecl* base_set_log_handler)(LogHandler, void*) = nullptr;
  void(__cdecl* obs_add_data_path)(const char*) = nullptr;
  int(__cdecl* obs_reset_video)(VideoInfo*) = nullptr;
  bool(__cdecl* obs_get_video_info)(VideoInfo*) = nullptr;
  Video*(__cdecl* obs_get_video)() = nullptr;
  std::uint32_t(__cdecl* obs_get_total_frames)() = nullptr;
  std::uint32_t(__cdecl* obs_get_lagged_frames)() = nullptr;
  bool(__cdecl* obs_nv12_tex_active)() = nullptr;
  void(__cdecl* obs_enter_graphics)() = nullptr;
  void(__cdecl* obs_leave_graphics)() = nullptr;
  void*(__cdecl* gs_get_device_obj)() = nullptr;
  int(__cdecl* obs_open_module)(Module**, const char*, const char*) = nullptr;
  bool(__cdecl* obs_init_module)(Module*) = nullptr;
  Module*(__cdecl* obs_get_module)(const char*) = nullptr;
  const char*(__cdecl* obs_get_module_file_name)(Module*) = nullptr;
  const char*(__cdecl* obs_get_module_binary_path)(Module*) = nullptr;
  const char*(__cdecl* obs_get_module_data_path)(Module*) = nullptr;
  char*(__cdecl* obs_module_get_config_path)(Module*, const char*) = nullptr;
  void(__cdecl* obs_post_load_modules)() = nullptr;
  void(__cdecl* obs_queue_task)(TaskType, Task, void*, bool) = nullptr;
  Canvas*(__cdecl* obs_get_main_canvas)() = nullptr;
  Canvas*(__cdecl* obs_get_canvas_by_uuid)(const char*) = nullptr;
  const char*(__cdecl* obs_canvas_get_uuid)(const Canvas*) = nullptr;
  std::uint32_t(__cdecl* obs_canvas_get_flags)(const Canvas*) = nullptr;
  void(__cdecl* obs_canvas_release)(Canvas*) = nullptr;
  Video*(__cdecl* obs_canvas_get_video)(const Canvas*) = nullptr;
  bool(__cdecl* obs_canvas_get_video_info)(const Canvas*, VideoInfo*) = nullptr;
  void(__cdecl* obs_canvas_set_channel)(Canvas*, std::uint32_t, Source*) = nullptr;
  Source*(__cdecl* obs_canvas_get_channel)(Canvas*, std::uint32_t) = nullptr;
  Source*(__cdecl* obs_load_private_source)(Data*) = nullptr;
  bool(__cdecl* obs_obj_is_private)(void*) = nullptr;
  Source*(__cdecl* obs_source_create_private)(const char*, const char*, Data*) = nullptr;
  void(__cdecl* obs_source_release)(Source*) = nullptr;
  void(__cdecl* obs_source_set_enabled)(Source*, bool) = nullptr;
  std::uint32_t(__cdecl* obs_source_get_width)(Source*) = nullptr;
  std::uint32_t(__cdecl* obs_source_get_height)(Source*) = nullptr;
  ProcHandler*(__cdecl* obs_source_get_proc_handler)(const Source*) = nullptr;
  Properties*(__cdecl* obs_get_source_properties)(const char*) = nullptr;
  const char*(__cdecl* obs_source_get_display_name)(const char*) = nullptr;
  Scene*(__cdecl* obs_scene_from_source)(const Source*) = nullptr;
  Source*(__cdecl* obs_scene_get_source)(const Scene*) = nullptr;
  SceneItem*(__cdecl* obs_scene_add)(Scene*, Source*) = nullptr;
  Source*(__cdecl* obs_sceneitem_get_source)(const SceneItem*) = nullptr;
  void(__cdecl* obs_scene_release)(Scene*) = nullptr;
  void(__cdecl* obs_sceneitem_set_pos)(SceneItem*, const Vec2*) = nullptr;
  void(__cdecl* obs_sceneitem_set_alignment)(SceneItem*, std::uint32_t) = nullptr;
  void(__cdecl* obs_sceneitem_set_bounds_type)(SceneItem*, Bounds) = nullptr;
  void(__cdecl* obs_sceneitem_set_bounds_alignment)(SceneItem*, std::uint32_t) = nullptr;
  void(__cdecl* obs_sceneitem_set_bounds)(SceneItem*, const Vec2*) = nullptr;
  Data*(__cdecl* obs_data_create)() = nullptr;
  Data*(__cdecl* obs_data_create_from_json)(const char*) = nullptr;
  void(__cdecl* obs_data_release)(Data*) = nullptr;
  void(__cdecl* obs_data_set_string)(Data*, const char*, const char*) = nullptr;
  void(__cdecl* obs_data_set_int)(Data*, const char*, long long) = nullptr;
  void(__cdecl* obs_data_set_bool)(Data*, const char*, bool) = nullptr;
  const char*(__cdecl* obs_data_get_string)(Data*, const char*) = nullptr;
  long long(__cdecl* obs_data_get_int)(Data*, const char*) = nullptr;
  bool(__cdecl* obs_data_get_bool)(Data*, const char*) = nullptr;
  void(__cdecl* obs_properties_destroy)(Properties*) = nullptr;
  Property*(__cdecl* obs_properties_get)(Properties*, const char*) = nullptr;
  void(__cdecl* obs_properties_apply_settings)(Properties*, Data*) = nullptr;
  PropertyType(__cdecl* obs_property_get_type)(Property*) = nullptr;
  bool(__cdecl* obs_property_enabled)(Property*) = nullptr;
  ComboFormat(__cdecl* obs_property_list_format)(Property*) = nullptr;
  std::size_t(__cdecl* obs_property_list_item_count)(Property*) = nullptr;
  bool(__cdecl* obs_property_list_item_disabled)(Property*, std::size_t) = nullptr;
  const char*(__cdecl* obs_property_list_item_string)(Property*, std::size_t) = nullptr;
  long long(__cdecl* obs_property_list_item_int)(Property*, std::size_t) = nullptr;
  int(__cdecl* obs_property_int_min)(Property*) = nullptr;
  int(__cdecl* obs_property_int_max)(Property*) = nullptr;
  int(__cdecl* obs_property_int_step)(Property*) = nullptr;
  Data*(__cdecl* obs_encoder_defaults)(const char*) = nullptr;
  Properties*(__cdecl* obs_get_encoder_properties)(const char*) = nullptr;
  const char*(__cdecl* obs_get_encoder_codec)(const char*) = nullptr;
  EncoderType(__cdecl* obs_get_encoder_type)(const char*) = nullptr;
  std::uint32_t(__cdecl* obs_get_encoder_caps)(const char*) = nullptr;
  Encoder*(__cdecl* obs_video_encoder_create)(const char*, const char*, Data*, Data*) = nullptr;
  void(__cdecl* obs_encoder_update)(Encoder*, Data*) = nullptr;
  void(__cdecl* obs_encoder_release)(Encoder*) = nullptr;
  void(__cdecl* obs_encoder_set_video)(Encoder*, Video*) = nullptr;
  Video*(__cdecl* obs_encoder_video)(const Encoder*) = nullptr;
  bool(__cdecl* obs_encoder_active)(const Encoder*) = nullptr;
  bool(__cdecl* obs_encoder_get_extra_data)(const Encoder*, std::uint8_t**, std::size_t*) = nullptr;
  Data*(__cdecl* obs_encoder_get_settings)(const Encoder*) = nullptr;
  const char*(__cdecl* obs_encoder_get_id)(const Encoder*) = nullptr;
  const char*(__cdecl* obs_encoder_get_last_error)(Encoder*) = nullptr;
  void(__cdecl* obs_register_output_s)(const OutputInfo*, std::size_t) = nullptr;
  Output*(__cdecl* obs_output_create)(const char*, const char*, Data*, Data*) = nullptr;
  void(__cdecl* obs_output_release)(Output*) = nullptr;
  bool(__cdecl* obs_output_start)(Output*) = nullptr;
  void(__cdecl* obs_output_force_stop)(Output*) = nullptr;
  bool(__cdecl* obs_output_active)(const Output*) = nullptr;
  void(__cdecl* obs_output_set_video_encoder)(Output*, Encoder*) = nullptr;
  Encoder*(__cdecl* obs_output_get_video_encoder)(const Output*) = nullptr;
  bool(__cdecl* obs_output_can_begin_data_capture)(const Output*, std::uint32_t) = nullptr;
  bool(__cdecl* obs_output_initialize_encoders)(Output*, std::uint32_t) = nullptr;
  bool(__cdecl* obs_output_begin_data_capture)(Output*, std::uint32_t) = nullptr;
  void(__cdecl* obs_output_end_data_capture)(Output*) = nullptr;
  bool(__cdecl* proc_handler_call)(ProcHandler*, const char*, CallData*) = nullptr;
  bool(__cdecl* calldata_get_data)(const CallData*, const char*, void*, std::size_t) = nullptr;
  bool(__cdecl* calldata_get_string)(const CallData*, const char*, const char**) = nullptr;
  void(__cdecl* bfree)(void*) = nullptr;
  void(__cdecl* ms_build_window_strings)(const char*, char**, char**, char**) = nullptr;
  HWND__*(__cdecl* ms_find_window)(WindowSearch, WindowPriority, const char*, const char*, const char*) = nullptr;
  HWND__*(__cdecl* ms_find_window_top_level)(WindowSearch, WindowPriority, const char*, const char*, const char*) = nullptr;
};

static_assert(sizeof(void*) == 8 && sizeof(bool) == 1 && sizeof(int) == 4);
static_assert(sizeof(Vec2) == 8 && alignof(Vec2) == 4);
static_assert(std::is_standard_layout_v<VideoInfo> && sizeof(VideoInfo) == 56);
static_assert(offsetof(VideoInfo, fps_num) == 8 && offsetof(VideoInfo, output_format) == 32);
static_assert(offsetof(VideoInfo, gpu_conversion) == 40 && offsetof(VideoInfo, colorspace) == 44);
static_assert(offsetof(VideoInfo, range) == 48 && offsetof(VideoInfo, scale_type) == 52);
static_assert(std::is_standard_layout_v<EncoderPacket> && sizeof(EncoderPacket) == 88);
static_assert(offsetof(EncoderPacket, pts) == 16 && offsetof(EncoderPacket, timebase_num) == 32);
static_assert(offsetof(EncoderPacket, type) == 40 && offsetof(EncoderPacket, keyframe) == 44);
static_assert(offsetof(EncoderPacket, dts_usec) == 48 && offsetof(EncoderPacket, encoder) == 80);
static_assert(sizeof(CallData) == 32 && offsetof(CallData, fixed) == 24);
static_assert(std::is_standard_layout_v<OutputInfo> && sizeof(OutputInfo) == 192);
static_assert(offsetof(OutputInfo, flags) == 8 && offsetof(OutputInfo, create) == 24);
static_assert(offsetof(OutputInfo, encoded_packet) == 72 && offsetof(OutputInfo, type_data) == 128);
static_assert(offsetof(OutputInfo, encoded_video_codecs) == 160);
static_assert(offsetof(OutputInfo, raw_audio2) == 176 && offsetof(OutputInfo, protocols) == 184);

}  // namespace monky::screen_capture::abi
