#pragma once

#include "..\monky_rtc_engine.h"

#define MONKY_ENGINE_AUDIO_EXTENSION_VERSION 1u
#define MONKY_ENGINE_EVENT_AUDIO_INPUT_RELEASED 10u
#define MONKY_ENGINE_EVENT_AUDIO_OUTPUT 11u
#define MONKY_ENGINE_AUDIO_INVALIDATED "audio.outputInvalidated"
#define MONKY_ENGINE_AUDIO_OWNER_STOP "owner-stop"
#define MONKY_ENGINE_AUDIO_ENGINE_CLOSE "engine-close"
#define MONKY_ENGINE_AUDIO_TRANSPORT_DETACHED "transport-detached"
#define MONKY_ENGINE_AUDIO_SETUP_FAILED "setup-failed"
#define MONKY_ENGINE_AUDIO_MIXER_FAILURE "mixer-failure"
#define MONKY_ENGINE_AUDIO_PRE_ADMISSION "ERR_RTC_AUDIO_OUTPUT_PRE_ADMISSION"
#define MONKY_ENGINE_AUDIO_DURING_ADMISSION "ERR_RTC_AUDIO_OUTPUT_DURING_ADMISSION"

#pragma pack(push, 8)
typedef struct MonkyEngineAudioPacket {
  uint32_t struct_size;
  uint32_t extension_version;
  uint32_t frames;
  uint32_t flags;
  uint64_t sequence;
  uint64_t frame_index;
  uint64_t device_position;  // UINT64_MAX when unavailable/unrequested; required with flags&4, optional with valid QPC.
  int64_t qpc_timestamp_us;  // -1 only when timestamp_error.
  uint32_t sample_rate;
  uint32_t channels;
  uint32_t channel_mask;
  uint32_t has_channel_mask;
  uint32_t source_bits_per_sample;
  uint32_t source_valid_bits_per_sample;
  uint32_t pcm_bytes;
  uint32_t reserved;
  const uint8_t* pcm;        // Borrowed Float32LE bytes ONLY until C admission returns.
  char session_id[129];
  char epoch[161];
} MonkyEngineAudioPacket;

typedef struct MonkyEngineAudioPlayout {
  uint32_t struct_size;
  uint32_t extension_version;
  uint64_t epoch;
  uint64_t sequence;
  uint64_t first_playout_frame;
  uint32_t frames;
  uint32_t sample_rate;
  uint32_t channels;
  uint32_t reserved;
  float samples[960];
  int64_t mixer_elapsed_time_ms;
  int64_t mixer_ntp_time_ms;
} MonkyEngineAudioPlayout;

typedef struct MonkyEngineAudioReply {
  uint32_t struct_size;
  uint32_t extension_version;
  uint32_t json_bytes;
  uint32_t reserved;
  char json[4096];
} MonkyEngineAudioReply;
#pragma pack(pop)

#ifdef __cplusplus
extern "C" {
#endif

// PCM is copied into DLL-owned aligned storage before OK. No JS memory or
// foreign allocator remains borrowed. AUDIO_INPUT_RELEASED reports processing
// retirement, not RTP delivery. A failed partial processing epoch is never replayed.
MONKY_ENGINE_API MonkyEngineStatus __cdecl monky_rtc_engine_submit_audio_packet(
    MonkyRtcEngine* engine, uint64_t source_id, const MonkyEngineAudioPacket* packet,
    MonkyEngineError* error) MONKY_ENGINE_NOEXCEPT;

// Copy-and-retire one actual mixed CPU packet after its event. Exact epoch and
// sequence are required; stale/duplicate reads fail without substituting silence.
MONKY_ENGINE_API MonkyEngineStatus __cdecl monky_rtc_engine_read_audio_playout(
    MonkyRtcEngine* engine, uint64_t epoch, uint64_t sequence, MonkyEngineAudioPlayout* packet,
    MonkyEngineError* error) MONKY_ENGINE_NOEXCEPT;

// Out-of-band bounded metadata commands: grant, probe, calibrate, feedback.
// The caller supplies the fixed reply POD before any side effect: never query
// output length by executing a credit/calibration command twice.
MONKY_ENGINE_API MonkyEngineStatus __cdecl monky_rtc_engine_audio_command(
    MonkyRtcEngine* engine, const char* command, uint32_t command_bytes,
    const char* json, uint32_t json_bytes, MonkyEngineAudioReply* reply,
    MonkyEngineError* error) MONKY_ENGINE_NOEXCEPT;

#ifdef __cplusplus
}
#endif
