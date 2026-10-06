#pragma once

#include <stdint.h>
#include <unknwn.h>

#if defined(MONKY_RTC_BUILDING_DLL)
#define MONKY_RTC_API __declspec(dllexport)
#else
#define MONKY_RTC_API __declspec(dllimport)
#endif

#ifdef __cplusplus
#define MONKY_RTC_NOEXCEPT noexcept
extern "C" {
#else
#define MONKY_RTC_NOEXCEPT
#endif

#define MONKY_RTC_ABI_VERSION 1u
#define MONKY_RTC_OK 0
#define MONKY_RTC_INVALID_ARGUMENT 1
#define MONKY_RTC_PARSE_ERROR 2
#define MONKY_RTC_BUFFER_TOO_SMALL 3
#define MONKY_RTC_CPP_EXCEPTION 4
#define MONKY_RTC_OUT_OF_MEMORY 5
#define MONKY_RTC_COM_ERROR 6
#define MONKY_RTC_ABI_MISMATCH 7

#define MONKY_RTC_PROBE_WEBRTC_SDP 1u
#define MONKY_RTC_PROBE_SDPTRANSFORM 2u
#define MONKY_RTC_PROBE_MEDIASOUP_ORTC 4u
#define MONKY_RTC_PROBE_NATIVE_CORE 8u
#define MONKY_RTC_PROBE_CPPWINRT 16u
#define MONKY_RTC_PROBE_PCF_LINKED 32u
#define MONKY_RTC_PROBE_LIBCXX_CR 64u
#define MONKY_RTC_PROBE_MF_ADAPTER_POLICIES 128u

typedef int32_t MonkyRtcStatus;
typedef struct MonkyRtcLinkProbe MonkyRtcLinkProbe;

#pragma pack(push, 8)
typedef struct MonkyRtcError {
  uint32_t struct_size;
  int32_t code;
  int32_t hresult;
  uint32_t reserved;
  char message[256];
} MonkyRtcError;

typedef struct MonkyRtcProbeInfo {
  uint32_t struct_size;
  uint32_t abi_version;
  uint32_t pointer_bits;
  uint32_t clang_major;
  uint32_t libcxx_abi;
  uint32_t flags;
  uint32_t media_sections;
  uint32_t sdp_bytes;
} MonkyRtcProbeInfo;

typedef struct MonkyRtcComInfo {
  uint32_t struct_size;
  uint32_t abi_version;
  uint32_t identity_preserved;
  uint32_t reserved;
} MonkyRtcComInfo;
#pragma pack(pop)

// Diagnostic link/ABI surface only. Only inert codec-factory policy objects are
// constructed; no PeerConnectionFactory, codec worker, device or media is started.
// Input/output buffers are borrowed during calls; only this DLL destroys its opaque results.
MONKY_RTC_API MonkyRtcStatus __cdecl monky_rtc_link_probe_create(
    const char* sdp, uint32_t sdp_bytes, MonkyRtcLinkProbe** result,
    MonkyRtcError* error) MONKY_RTC_NOEXCEPT;
MONKY_RTC_API MonkyRtcStatus __cdecl monky_rtc_link_probe_info(
    const MonkyRtcLinkProbe* result, MonkyRtcProbeInfo* info) MONKY_RTC_NOEXCEPT;
MONKY_RTC_API MonkyRtcStatus __cdecl monky_rtc_link_probe_copy_sdp(
    const MonkyRtcLinkProbe* result, char* destination, uint32_t capacity,
    uint32_t* required_bytes) MONKY_RTC_NOEXCEPT;
MONKY_RTC_API MonkyRtcStatus __cdecl monky_rtc_link_probe_destroy(
    MonkyRtcLinkProbe* result) MONKY_RTC_NOEXCEPT;
MONKY_RTC_API uint32_t __cdecl monky_rtc_link_probe_live_results(void) MONKY_RTC_NOEXCEPT;

// Borrowed COM reference; QueryInterface/AddRef/Release are balanced inside the call.
MONKY_RTC_API MonkyRtcStatus __cdecl monky_rtc_link_probe_com(
    IUnknown* object, MonkyRtcComInfo* info, MonkyRtcError* error) MONKY_RTC_NOEXCEPT;

#ifdef __cplusplus
}
#endif
