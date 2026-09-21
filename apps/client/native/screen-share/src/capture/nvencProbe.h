#pragma once
#include <cstring>
#include <ffnvcodec/nvEncodeAPI.h>
#include "platformContract.h"

namespace monky::screen_capture {

inline void ProbeNvencDevice(ID3D11Device* device, const VideoConfiguration& video) {
  const auto library = LoadLibraryExW(L"nvEncodeAPI64.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
  Require(library != nullptr, "NVIDIA NVENC driver API is unavailable", "ERR_SCREEN_CAPTURE_NVENC_UNAVAILABLE");
  NV_ENCODE_API_FUNCTION_LIST functions{};
  void* session = nullptr;
  try {
    using CreateInstance = NVENCSTATUS(NVENCAPI*)(NV_ENCODE_API_FUNCTION_LIST*);
    const auto address = GetProcAddress(library, "NvEncodeAPICreateInstance");
    CreateInstance create = nullptr;
    static_assert(sizeof(create) == sizeof(address));
    std::memcpy(&create, &address, sizeof(create));
    functions.version = NV_ENCODE_API_FUNCTION_LIST_VER;
    Require(create && create(&functions) == NV_ENC_SUCCESS && functions.nvEncOpenEncodeSessionEx &&
            functions.nvEncGetEncodeGUIDs && functions.nvEncGetEncodeProfileGUIDs &&
            functions.nvEncGetInputFormats && functions.nvEncGetEncodeCaps && functions.nvEncDestroyEncoder,
            "NVIDIA driver does not support the pinned NVENC probe API", "ERR_SCREEN_CAPTURE_NVENC_UNAVAILABLE");
    NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS open{};
    open.version = NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER;
    open.apiVersion = NVENCAPI_VERSION;
    open.device = device;
    open.deviceType = NV_ENC_DEVICE_TYPE_DIRECTX;
    Require(functions.nvEncOpenEncodeSessionEx(&open, &session) == NV_ENC_SUCCESS && session,
            "NVENC refused a hardware session on the actual OBS D3D11 adapter; check driver, GPU support or session limits",
            "ERR_SCREEN_CAPTURE_NVENC_UNAVAILABLE");
    std::array<GUID, 64> codecs{}, profiles{};
    std::array<NV_ENC_BUFFER_FORMAT, 64> formats{};
    std::uint32_t codecCount = 0, profileCount = 0, formatCount = 0;
    const auto contains = [](const auto& values, std::uint32_t count, const GUID& needle) {
      if (count > values.size()) return false;
      for (std::uint32_t index = 0; index < count; ++index)
        if (IsEqualGUID(values[index], needle)) return true;
      return false;
    };
    const bool h264 = functions.nvEncGetEncodeGUIDs(session, codecs.data(), static_cast<std::uint32_t>(codecs.size()),
        &codecCount) == NV_ENC_SUCCESS && contains(codecs, codecCount, NV_ENC_CODEC_H264_GUID);
    const bool main = h264 && functions.nvEncGetEncodeProfileGUIDs(session, NV_ENC_CODEC_H264_GUID, profiles.data(),
        static_cast<std::uint32_t>(profiles.size()), &profileCount) == NV_ENC_SUCCESS &&
        contains(profiles, profileCount, NV_ENC_H264_PROFILE_MAIN_GUID);
    bool nv12 = false;
    if (h264 && functions.nvEncGetInputFormats(session, NV_ENC_CODEC_H264_GUID, formats.data(),
        static_cast<std::uint32_t>(formats.size()), &formatCount) == NV_ENC_SUCCESS && formatCount <= formats.size())
      for (std::uint32_t index = 0; index < formatCount; ++index) nv12 |= formats[index] == NV_ENC_BUFFER_FORMAT_NV12;
    const auto cap = [&](NV_ENC_CAPS name) {
      NV_ENC_CAPS_PARAM parameters{};
      parameters.version = NV_ENC_CAPS_PARAM_VER;
      parameters.capsToQuery = name;
      int value = 0;
      Require(h264 && functions.nvEncGetEncodeCaps(session, NV_ENC_CODEC_H264_GUID, &parameters, &value) == NV_ENC_SUCCESS &&
              value >= 0, "NVENC H264 capability query failed", "ERR_SCREEN_CAPTURE_NVENC_UNAVAILABLE");
      return static_cast<std::uint32_t>(value);
    };
    ValidateNvencProbeEvidence(true, h264, main, nv12, cap(NV_ENC_CAPS_SUPPORT_DYN_BITRATE_CHANGE) != 0,
        cap(NV_ENC_CAPS_WIDTH_MAX), cap(NV_ENC_CAPS_HEIGHT_MAX), video);
    const auto destroyed = functions.nvEncDestroyEncoder(session);
    session = nullptr;
    Require(destroyed == NV_ENC_SUCCESS, "NVENC probe session did not retire cleanly",
            "ERR_SCREEN_CAPTURE_NVENC_UNAVAILABLE");
  } catch (...) {
    if (session && functions.nvEncDestroyEncoder) functions.nvEncDestroyEncoder(session);
    FreeLibrary(library);
    throw;
  }
  FreeLibrary(library);
}
}  // namespace monky::screen_capture
