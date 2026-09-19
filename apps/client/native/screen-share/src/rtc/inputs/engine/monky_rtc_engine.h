#pragma once

#include <stdint.h>
#include <unknwn.h>

#if defined(MONKY_RTC_BUILDING_DLL)
#define MONKY_ENGINE_API __declspec(dllexport)
#else
#define MONKY_ENGINE_API __declspec(dllimport)
#endif
#ifdef __cplusplus
#define MONKY_ENGINE_NOEXCEPT noexcept
extern "C" {
#else
#define MONKY_ENGINE_NOEXCEPT
#endif

#define MONKY_ENGINE_ABI_VERSION 2u
#define MONKY_ENGINE_CONTRACT_REVISION 7u
#define MONKY_ENGINE_OK 0
#define MONKY_ENGINE_INVALID 1
#define MONKY_ENGINE_CLOSED 2
#define MONKY_ENGINE_QUEUE_FULL 3
#define MONKY_ENGINE_NOT_FOUND 4
#define MONKY_ENGINE_CANCELLED 5
#define MONKY_ENGINE_TIMEOUT 6
#define MONKY_ENGINE_FAILURE 7
#define MONKY_ENGINE_BUSY 8
#define MONKY_ENGINE_BUFFER_TOO_SMALL 9
#define MONKY_ENGINE_UNSUPPORTED 10

typedef int32_t MonkyEngineStatus;
typedef struct MonkyRtcEngine MonkyRtcEngine;

#pragma pack(push, 8)
typedef struct MonkyEngineError {
  uint32_t struct_size;
  int32_t status;
  int32_t hresult;
  uint32_t reserved;
  char code[80];
  char message[512];
} MonkyEngineError;

typedef struct MonkyEngineOptions {
  uint32_t struct_size;
  uint32_t abi_version;
  uint32_t max_resources;
  uint32_t max_pending_operations;
  uint32_t max_decoded_frames;
  uint32_t operation_timeout_ms;
  uint32_t require_audio;
  uint32_t maximum_h264_level;
} MonkyEngineOptions;

#define MONKY_ENGINE_EVENT_READY 1u
#define MONKY_ENGINE_EVENT_OPERATION 2u
#define MONKY_ENGINE_EVENT_REQUEST 3u
#define MONKY_ENGINE_EVENT_FRAME 4u
#define MONKY_ENGINE_EVENT_INPUT_RELEASED 5u
#define MONKY_ENGINE_EVENT_ERROR 6u
#define MONKY_ENGINE_EVENT_CLOSED 7u
#define MONKY_ENGINE_EVENT_SIGNAL 8u
#define MONKY_ENGINE_EVENT_FRAME_RELEASED 9u

#define MONKY_ENGINE_FRAME_UNUSED 1u
#define MONKY_ENGINE_FRAME_EXTERNAL_REFERENCES_RELEASED 2u
#define MONKY_ENGINE_PIXEL_FORMAT_NV12 1u
#define MONKY_ENGINE_SHARED_GPU_COPY 1u
#define MONKY_ENGINE_SHARED_COPY_COMPLETE 2u
#define MONKY_ENGINE_SHARED_KEYED_MUTEX_ZERO 4u
#define MONKY_ENGINE_SHARED_RECLAIM_FENCE 8u

typedef struct MonkyEngineEvent {
  uint32_t struct_size;
  uint32_t abi_version;
  uint32_t kind;
  uint32_t reserved;
  uint64_t target;
  uint64_t id;
  const char* json;
  uint32_t json_bytes;
  uint32_t reserved2;
} MonkyEngineEvent;

// The callback borrows UTF-8 bytes until it returns. OK means the host copied
// the event into a bounded queue. It must never wait for JavaScript to execute
// or reenter the engine; detach_callbacks fences in-progress callback access.
typedef MonkyEngineStatus (__cdecl *MonkyEngineEventCallback)(
    void* user, const MonkyEngineEvent* event);

typedef struct MonkyEngineCallbacks {
  uint32_t struct_size;
  uint32_t abi_version;
  MonkyEngineEventCallback on_event;
  void* user;
} MonkyEngineCallbacks;

typedef struct MonkyEngineInputFrame {
  uint32_t struct_size;
  uint32_t abi_version;
  uint64_t frame_id;
  uint64_t texture_nt_handle;
  int64_t timestamp_us;
  int64_t duration_us;
  int64_t ntp_time_ms;
} MonkyEngineInputFrame;

// Already encoded, complete Annex B H264 access unit. Borrowed bytes are
// copied before submit_encoded_frame returns; there is no asynchronous JS loan.
// timestamp_us is genuine system-QPC time (OBS sys_dts_usec for BF0), not PTS
// or frame_id multiplied by a nominal rate. Original signed PTS/DTS are retained.
typedef struct MonkyEngineEncodedFrame {
  uint32_t struct_size;
  uint32_t abi_version;
  uint64_t frame_id;
  const uint8_t* data;
  uint32_t data_bytes;
  uint32_t keyframe;
  int64_t timestamp_us;
  int64_t duration_us;
  int64_t ntp_time_ms;
  int64_t pts;
  int64_t dts;
  uint32_t timebase_numerator;
  uint32_t timebase_denominator;
} MonkyEngineEncodedFrame;

typedef struct MonkyEngineFrameCom {
  uint32_t struct_size;
  uint32_t abi_version;
  IUnknown* texture;
  IUnknown* ready_fence;
  uint64_t ready_value;
  uint32_t subresource;
  uint32_t coded_width;
  uint32_t coded_height;
  uint32_t visible_x;
  uint32_t visible_y;
  uint32_t width;
  uint32_t height;
  uint32_t reserved;
  int64_t timestamp_us;
} MonkyEngineFrameCom;

typedef struct MonkyEngineSharedFrame {
  uint32_t struct_size;
  uint32_t abi_version;
  uint64_t texture_nt_handle;
  uint32_t coded_width;
  uint32_t coded_height;
  uint32_t visible_x;
  uint32_t visible_y;
  uint32_t width;
  uint32_t height;
  int64_t timestamp_us;
  uint32_t pixel_format;
  uint32_t flags;
  uint32_t gpu_copy_count;
  uint32_t reserved;
} MonkyEngineSharedFrame;
#pragma pack(pop)

// capabilities is inert and safe to call before any engine is created.
MONKY_ENGINE_API MonkyEngineStatus __cdecl monky_rtc_engine_capabilities(
    char* output, uint32_t capacity, uint32_t* required_bytes) MONKY_ENGINE_NOEXCEPT;

// create returns a starting engine, not a fabricated ready result. The owned
// actor constructs the actual factory and reports ready/error/closed later.
// This call is NOT permitted in the current device-free build probes.
MONKY_ENGINE_API MonkyEngineStatus __cdecl monky_rtc_engine_create(
    const MonkyEngineOptions* options, const MonkyEngineCallbacks* callbacks,
    MonkyRtcEngine** engine, MonkyEngineError* error) MONKY_ENGINE_NOEXCEPT;

// Explicit external-H264 encoder factory; existing options/POD layouts stay
// unchanged. No MF encoder or raw-pixel conversion is used by its TX path.
// This is operational creation, NOT an allowed device-free probe.
MONKY_ENGINE_API MonkyEngineStatus __cdecl monky_rtc_engine_create_encoded(
    const MonkyEngineOptions* options, const MonkyEngineCallbacks* callbacks,
    MonkyRtcEngine** engine, MonkyEngineError* error) MONKY_ENGINE_NOEXCEPT;

// IDs are caller-selected nonzero safe JS integers. Do not reuse a request ID
// before its completion event has been consumed.
// OK acknowledges admission only. operation events report actual completion.
MONKY_ENGINE_API MonkyEngineStatus __cdecl monky_rtc_engine_request(
    MonkyRtcEngine* engine, uint64_t request_id, const char* operation, uint32_t operation_bytes,
    uint64_t target, const char* json, uint32_t json_bytes,
    MonkyEngineError* error) MONKY_ENGINE_NOEXCEPT;
// Out-of-band: these must not be queued behind a worker waiting for Node.
MONKY_ENGINE_API MonkyEngineStatus __cdecl monky_rtc_engine_respond(
    MonkyRtcEngine* engine, uint64_t callback_id, const char* json, uint32_t json_bytes,
    MonkyEngineError* error) MONKY_ENGINE_NOEXCEPT;
MONKY_ENGINE_API MonkyEngineStatus __cdecl monky_rtc_engine_cancel(
    MonkyRtcEngine* engine, uint64_t request_id, MonkyEngineError* error) MONKY_ENGINE_NOEXCEPT;

// Accepts only immutable BT.709-limited NV12 NT textures with keyed mutex key 0
// on the source's explicit adapter. The DLL duplicates the HANDLE. On OK the
// producer MUST retain its lease until source.frameReleased (including errors),
// or successful complete engine close. Rejection transfers no new ownership;
// a duplicate key never retires the previously admitted frame.
// Input frame_id is unique among retained inputs of that source, not globally.
MONKY_ENGINE_API MonkyEngineStatus __cdecl monky_rtc_engine_submit_frame(
    MonkyRtcEngine* engine, uint64_t source_id, const MonkyEngineInputFrame* frame,
    MonkyEngineError* error) MONKY_ENGINE_NOEXCEPT;

// OK means a bounded native copy was admitted, not RTP delivery. The caller
// may reuse its Buffer immediately. Native copy retirement is independently
// counted/reported; RX GPU leases retain their existing stricter contract.
MONKY_ENGINE_API MonkyEngineStatus __cdecl monky_rtc_engine_submit_encoded_frame(
    MonkyRtcEngine* engine, uint64_t source_id, const MonkyEngineEncodedFrame* frame,
    MonkyEngineError* error) MONKY_ENGINE_NOEXCEPT;

// A decoded frame event owns an exported single-slice NV12 lease. Publication
// follows actual GPU copy completion, not just CopySubresourceRegion submission.
// COM query returns AddRef'd interfaces; no COM pointer is exported to JS.
// Native consumers must acquire/release keyed mutex key 0 around GPU reads and
// release every returned COM reference before admitting the frame's retirement.
MONKY_ENGINE_API MonkyEngineStatus __cdecl monky_rtc_engine_frame_com(
    MonkyRtcEngine* engine, uint64_t frame_id, MonkyEngineFrameCom* frame,
    MonkyEngineError* error) MONKY_ENGINE_NOEXCEPT;
// Returns a BORROWED NT HANDLE valid in the engine's process until actual frame
// retirement. Electron45alpha6 duplicates it internally; never CloseHandle it
// from JS or convert it through a double. ArraySize/MipLevels are always 1.
MONKY_ENGINE_API MonkyEngineStatus __cdecl monky_rtc_engine_frame_shared(
    MonkyRtcEngine* engine, uint64_t frame_id, MonkyEngineSharedFrame* frame,
    MonkyEngineError* error) MONKY_ENGINE_NOEXCEPT;
// UNUSED means the frame was never imported by any external consumer.
// EXTERNAL_REFERENCES_RELEASED means the genuine allReferencesReleased callback,
// not an IPC ACK, writer.write, VideoFrame.close or a stop request.
// OK accepts this proof only; FRAME_RELEASED reports actual retirement after
// AcquireSync(0) AND a producer-side reclamation fence have completed.
MONKY_ENGINE_API MonkyEngineStatus __cdecl monky_rtc_engine_release_frame(
    MonkyRtcEngine* engine, uint64_t frame_id, uint32_t release_reason,
    MonkyEngineError* error) MONKY_ENGINE_NOEXCEPT;
MONKY_ENGINE_API MonkyEngineStatus __cdecl monky_rtc_engine_snapshot(
    MonkyRtcEngine* engine, char* output, uint32_t capacity, uint32_t* required_bytes,
    MonkyEngineError* error) MONKY_ENGINE_NOEXCEPT;

MONKY_ENGINE_API MonkyEngineStatus __cdecl monky_rtc_engine_close(
    MonkyRtcEngine* engine, MonkyEngineError* error) MONKY_ENGINE_NOEXCEPT;
// Blocking observation ONLY for native/background work, never Node's event loop.
// Timeout keeps ownership; it is not permission to destroy/unload the DLL.
MONKY_ENGINE_API MonkyEngineStatus __cdecl monky_rtc_engine_wait_closed(
    MonkyRtcEngine* engine, uint32_t timeout_ms, MonkyEngineError* error) MONKY_ENGINE_NOEXCEPT;
// Revokes/fences callbacks and requests close; a silent running engine is not supported.
MONKY_ENGINE_API MonkyEngineStatus __cdecl monky_rtc_engine_detach_callbacks(
    MonkyRtcEngine* engine, MonkyEngineError* error) MONKY_ENGINE_NOEXCEPT;
// Succeeds only after actual actor/thread/lease retirement. The caller must
// serialize destruction with every other C API call and detach callbacks first.
MONKY_ENGINE_API MonkyEngineStatus __cdecl monky_rtc_engine_destroy(
    MonkyRtcEngine* engine, MonkyEngineError* error) MONKY_ENGINE_NOEXCEPT;

#ifdef __cplusplus
}
#endif
