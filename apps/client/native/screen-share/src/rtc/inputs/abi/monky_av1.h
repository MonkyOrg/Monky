#pragma once
#include <stddef.h>
#include <stdint.h>

#ifdef MONKY_AV1_BUILD
#define MONKY_AV1_API __declspec(dllexport)
#else
#define MONKY_AV1_API
#endif

#ifdef __cplusplus
extern "C" {
#endif
struct MonkyAv1Config {
  uint32_t width, height, fps, bitrate_kbps, threads;
};
struct MonkyAv1Packet {
  const uint8_t* data;
  size_t bytes;
  int64_t pts;
  uint32_t keyframe;
};
MONKY_AV1_API void* MonkyAv1Create(const struct MonkyAv1Config*, char* error, size_t capacity);
MONKY_AV1_API int MonkyAv1Encode(void*, const uint8_t* const planes[3], const uint32_t strides[3],
                               int64_t pts, struct MonkyAv1Packet*, char* error, size_t capacity);
MONKY_AV1_API int MonkyAv1SetBitrate(void*, uint32_t bitrate_kbps, char* error, size_t capacity);
MONKY_AV1_API int MonkyAv1Validate(const uint8_t*, size_t bytes, uint32_t width, uint32_t height,
                                 char* error, size_t capacity);
MONKY_AV1_API void MonkyAv1Destroy(void*);
#ifdef __cplusplus
}
#endif
