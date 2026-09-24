#pragma once
#include <cstring>
#include <d3d11.h>
#include <exception>
#include <ffnvcodec/nvEncodeAPI.h>
#include "platformContract.h"

namespace monky::screen_capture {

inline std::string NvencProbeStatus(NVENCSTATUS status) {
  constexpr std::array names{
    "NV_ENC_SUCCESS", "NV_ENC_ERR_NO_ENCODE_DEVICE", "NV_ENC_ERR_UNSUPPORTED_DEVICE",
    "NV_ENC_ERR_INVALID_ENCODERDEVICE", "NV_ENC_ERR_INVALID_DEVICE", "NV_ENC_ERR_DEVICE_NOT_EXIST",
    "NV_ENC_ERR_INVALID_PTR", "NV_ENC_ERR_INVALID_EVENT", "NV_ENC_ERR_INVALID_PARAM",
    "NV_ENC_ERR_INVALID_CALL", "NV_ENC_ERR_OUT_OF_MEMORY", "NV_ENC_ERR_ENCODER_NOT_INITIALIZED",
    "NV_ENC_ERR_UNSUPPORTED_PARAM", "NV_ENC_ERR_LOCK_BUSY", "NV_ENC_ERR_NOT_ENOUGH_BUFFER",
    "NV_ENC_ERR_INVALID_VERSION", "NV_ENC_ERR_MAP_FAILED", "NV_ENC_ERR_NEED_MORE_INPUT",
    "NV_ENC_ERR_ENCODER_BUSY", "NV_ENC_ERR_EVENT_NOT_REGISTERD", "NV_ENC_ERR_GENERIC",
    "NV_ENC_ERR_INCOMPATIBLE_CLIENT_KEY", "NV_ENC_ERR_UNIMPLEMENTED", "NV_ENC_ERR_RESOURCE_REGISTER_FAILED",
    "NV_ENC_ERR_RESOURCE_NOT_REGISTERED", "NV_ENC_ERR_RESOURCE_NOT_MAPPED", "NV_ENC_ERR_NEED_MORE_OUTPUT",
  };
  const auto value = static_cast<unsigned>(status);
  return "status=" + std::to_string(value) + "(" + (value < names.size() ? names[value] : "unknown NVENCSTATUS") + ")";
}

struct NvencProbeLoader {
  decltype(&LoadLibraryExW) load = &LoadLibraryExW;
  decltype(&GetProcAddress) resolve = &GetProcAddress;
  decltype(&FreeLibrary) release = &FreeLibrary;
};

inline void ProbeNvencDevice(ID3D11Device* device, const VideoConfiguration& video,
                             const NvencProbeLoader& loader = {}) {
  constexpr auto errorCode = "ERR_SCREEN_CAPTURE_NVENC_UNAVAILABLE";
  Require(device && loader.load && loader.resolve && loader.release, "Invalid NVENC probe device/loader", errorCode);
  std::string evidence = "api=" + std::to_string(NVENCAPI_MAJOR_VERSION) + "." + std::to_string(NVENCAPI_MINOR_VERSION);
  const auto fail = [&](const std::string& detail) {
    throw ContractError(errorCode, "NVENC " + detail + "; " + evidence);
  };
  const auto library = loader.load(L"nvEncodeAPI64.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
  if (!library) fail("LoadLibraryExW(nvEncodeAPI64.dll) win32=" + std::to_string(GetLastError()));
  NV_ENCODE_API_FUNCTION_LIST functions{};
  void* session = nullptr;
  std::exception_ptr failure;
  try {
    using CreateInstance = NVENCSTATUS(NVENCAPI*)(NV_ENCODE_API_FUNCTION_LIST*);
    const auto address = loader.resolve(library, "NvEncodeAPICreateInstance");
    if (!address) fail("GetProcAddress(NvEncodeAPICreateInstance) win32=" + std::to_string(GetLastError()));
    CreateInstance create = nullptr;
    static_assert(sizeof(create) == sizeof(address));
    std::memcpy(&create, &address, sizeof(create));
    functions.version = NV_ENCODE_API_FUNCTION_LIST_VER;
    const auto created = create(&functions);
    if (created != NV_ENC_SUCCESS)
      fail("NvEncodeAPICreateInstance " + NvencProbeStatus(created) +
           " functionListVersion=" + std::to_string(NV_ENCODE_API_FUNCTION_LIST_VER));
    const auto entry = [&](bool present, const char* name) {
      if (!present) fail(std::string{"NvEncodeAPICreateInstance missing "} + name);
    };
    entry(functions.nvEncOpenEncodeSessionEx != nullptr, "nvEncOpenEncodeSessionEx");
    entry(functions.nvEncGetEncodeGUIDCount != nullptr, "nvEncGetEncodeGUIDCount");
    entry(functions.nvEncGetEncodeGUIDs != nullptr, "nvEncGetEncodeGUIDs");
    entry(functions.nvEncGetEncodeProfileGUIDCount != nullptr, "nvEncGetEncodeProfileGUIDCount");
    entry(functions.nvEncGetEncodeProfileGUIDs != nullptr, "nvEncGetEncodeProfileGUIDs");
    entry(functions.nvEncGetInputFormatCount != nullptr, "nvEncGetInputFormatCount");
    entry(functions.nvEncGetInputFormats != nullptr, "nvEncGetInputFormats");
    entry(functions.nvEncGetEncodeCaps != nullptr, "nvEncGetEncodeCaps");
    entry(functions.nvEncDestroyEncoder != nullptr, "nvEncDestroyEncoder");
    NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS open{};
    open.version = NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER;
    open.apiVersion = NVENCAPI_VERSION;
    open.device = device;
    open.deviceType = NV_ENC_DEVICE_TYPE_DIRECTX;
    const auto opened = functions.nvEncOpenEncodeSessionEx(&open, &session);
    if (opened != NV_ENC_SUCCESS || !session)
      fail("nvEncOpenEncodeSessionEx " + NvencProbeStatus(opened) + " session=" + (session ? "1" : "0") +
           " device=D3D11 openVersion=" + std::to_string(open.version));
    std::array<GUID, 64> codecs{}, profiles{};
    std::array<NV_ENC_BUFFER_FORMAT, 64> formats{};
    const auto enumerate = [&](auto& values, const char* countOperation, const char* listOperation,
                               const char* required, auto countQuery, auto listQuery, auto matches) {
      std::uint32_t count = 0;
      const auto countStatus = countQuery(&count);
      evidence += "; " + std::string{countOperation} + "(status=" + std::to_string(countStatus) +
          ",count=" + std::to_string(count) + ")";
      if (countStatus != NV_ENC_SUCCESS || count == 0 || count > values.size())
        fail(std::string{countOperation} + " " + NvencProbeStatus(countStatus) +
             " count=" + std::to_string(count) + " bound=" + std::to_string(values.size()));
      // SDK 12.2 requires its queried count as guidArraySize, even with a larger backing array.
      std::uint32_t returned = 0;
      const auto listStatus = listQuery(values.data(), count, &returned);
      bool found = false;
      if (listStatus == NV_ENC_SUCCESS && returned <= count)
        for (std::uint32_t index = 0; index < returned; ++index) found |= matches(values[index]);
      evidence += "; " + std::string{listOperation} + "(status=" + std::to_string(listStatus) +
          ",returned=" + std::to_string(returned) + "," + required + "=" + (found ? "1" : "0") + ")";
      if (listStatus != NV_ENC_SUCCESS || !found)
        fail(std::string{listOperation} + " " + NvencProbeStatus(listStatus) +
             " capacity=" + std::to_string(count) + " returned=" + std::to_string(returned) +
             " " + required + "=" + (found ? "1" : "0"));
      return found;
    };
    const bool h264 = enumerate(codecs, "nvEncGetEncodeGUIDCount", "nvEncGetEncodeGUIDs", "H264",
        [&](auto* count) { return functions.nvEncGetEncodeGUIDCount(session, count); },
        [&](auto* values, auto count, auto* returned) { return functions.nvEncGetEncodeGUIDs(session, values, count, returned); },
        [](const GUID& value) { return IsEqualGUID(value, NV_ENC_CODEC_H264_GUID) != 0; });
    const bool main = enumerate(profiles, "nvEncGetEncodeProfileGUIDCount", "nvEncGetEncodeProfileGUIDs", "Main",
        [&](auto* count) { return functions.nvEncGetEncodeProfileGUIDCount(session, NV_ENC_CODEC_H264_GUID, count); },
        [&](auto* values, auto count, auto* returned) {
          return functions.nvEncGetEncodeProfileGUIDs(session, NV_ENC_CODEC_H264_GUID, values, count, returned);
        }, [](const GUID& value) { return IsEqualGUID(value, NV_ENC_H264_PROFILE_MAIN_GUID) != 0; });
    const bool nv12 = enumerate(formats, "nvEncGetInputFormatCount", "nvEncGetInputFormats", "NV12",
        [&](auto* count) { return functions.nvEncGetInputFormatCount(session, NV_ENC_CODEC_H264_GUID, count); },
        [&](auto* values, auto count, auto* returned) {
          return functions.nvEncGetInputFormats(session, NV_ENC_CODEC_H264_GUID, values, count, returned);
        }, [](NV_ENC_BUFFER_FORMAT value) { return value == NV_ENC_BUFFER_FORMAT_NV12; });
    const auto cap = [&](NV_ENC_CAPS query, const char* name, std::uint32_t required) {
      NV_ENC_CAPS_PARAM parameters{};
      parameters.version = NV_ENC_CAPS_PARAM_VER;
      parameters.capsToQuery = query;
      int value = -1;
      const auto status = functions.nvEncGetEncodeCaps(session, NV_ENC_CODEC_H264_GUID, &parameters, &value);
      if (status != NV_ENC_SUCCESS || value < 0 || static_cast<std::uint32_t>(value) < required)
        fail(std::string{"nvEncGetEncodeCaps "} + name + "(" + std::to_string(query) + ") " +
             NvencProbeStatus(status) + " value=" + std::to_string(value) + " required=" + std::to_string(required) +
             " capsVersion=" + std::to_string(parameters.version));
      evidence += "; " + std::string{name} + "=" + std::to_string(value);
      return static_cast<std::uint32_t>(value);
    };
    const auto dynamicBitrate = cap(NV_ENC_CAPS_SUPPORT_DYN_BITRATE_CHANGE, "NV_ENC_CAPS_SUPPORT_DYN_BITRATE_CHANGE", 1);
    const auto maximumWidth = cap(NV_ENC_CAPS_WIDTH_MAX, "NV_ENC_CAPS_WIDTH_MAX", video.width);
    const auto maximumHeight = cap(NV_ENC_CAPS_HEIGHT_MAX, "NV_ENC_CAPS_HEIGHT_MAX", video.height);
    cap(NV_ENC_CAPS_LEVEL_MAX, "NV_ENC_CAPS_LEVEL_MAX", RequiredCaptureH264Level(video));
    ValidateNvencProbeEvidence(true, h264, main, nv12, dynamicBitrate != 0, maximumWidth, maximumHeight, video);
  } catch (...) { failure = std::current_exception(); }
  const auto cleanupFailure = [&](const std::string& detail) {
    if (failure) {
      try { std::rethrow_exception(failure); }
      catch (const std::exception& error) {
        failure = std::make_exception_ptr(ContractError(errorCode, std::string{error.what()} + "; NVENC " + detail));
      } catch (...) {
        failure = std::make_exception_ptr(ContractError(errorCode, "Unknown NVENC probe exception; " + detail + "; " + evidence));
      }
    } else failure = std::make_exception_ptr(ContractError(errorCode, "NVENC " + detail + "; " + evidence));
  };
  bool retired = true;
  if (session) {
    const auto destroyed = functions.nvEncDestroyEncoder(session);
    retired = destroyed == NV_ENC_SUCCESS;
    if (!retired) cleanupFailure("nvEncDestroyEncoder " + NvencProbeStatus(destroyed) + " retirement=unconfirmed");
  }
  // Failed destruction leaves driver ownership unconfirmed until the private host exits.
  if (retired && !loader.release(library)) cleanupFailure("FreeLibrary(nvEncodeAPI64.dll) win32=" + std::to_string(GetLastError()));
  if (failure) std::rethrow_exception(failure);
}
}  // namespace monky::screen_capture
