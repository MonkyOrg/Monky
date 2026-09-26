#pragma once
#include <AMF/core/Factory.h>
#include <AMF/components/VideoEncoderVCE.h>
#include <AMF/components/VideoEncoderAV1.h>
#include <d3d11.h>
#include <cstring>
#include <exception>
#include "platformContract.h"

namespace monky::screen_capture {

inline void ValidateAmfComponentResult(AMF_RESULT result, bool av1, const std::string& evidence) {
  if (result == AMF_OK) return;
  const bool unsupported = result == AMF_NOT_SUPPORTED || result == AMF_NOT_FOUND ||
      result == AMF_CODEC_NOT_SUPPORTED;
  throw ContractError(unsupported ? "ERR_SCREEN_CAPTURE_ENCODER_UNSUPPORTED" : "ERR_SCREEN_CAPTURE_AMF_UNAVAILABLE",
      evidence + (av1 ? "; CreateComponent(AV1)" : "; CreateComponent(H264)") +
      " status=" + std::to_string(result) +
      (unsupported ? "; selected codec is not supported by this GPU" : ""));
}

inline std::string ProbeAmfDevice(ID3D11Device* device, const VideoConfiguration& video, bool av1 = false) {
  constexpr auto errorCode = "ERR_SCREEN_CAPTURE_AMF_UNAVAILABLE";
  Require(device != nullptr, "Invalid AMF probe device", errorCode);
  const auto required = (std::max)(31u, RequiredCaptureH264Level(video));
  std::string evidence = av1 ? "AMF AV1 source-free probe" :
      "AMF H264 source-free probe requiredLevel=" + std::to_string(required);
  const auto fail = [&](const std::string& operation, AMF_RESULT result) {
    throw ContractError(errorCode, evidence + "; " + operation + " status=" + std::to_string(result));
  };
  const auto check = [&](AMF_RESULT result, const char* operation) {
    if (result != AMF_OK) fail(operation, result);
  };
  const auto library = LoadLibraryExW(L"amfrt64.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
  if (!library) throw ContractError(errorCode,
      "Cannot load system AMF runtime; win32=" + std::to_string(GetLastError()));
  amf::AMFContextPtr context;
  amf::AMFComponentPtr encoder;
  amf::AMFCapsPtr caps;
  std::exception_ptr failure;
  try {
    const auto address = GetProcAddress(library, AMF_INIT_FUNCTION_NAME);
    Require(address != nullptr, "System AMF runtime has no AMFInit entry point", errorCode);
    AMFInit_Fn init = nullptr;
    static_assert(sizeof(init) == sizeof(address));
    std::memcpy(&init, &address, sizeof(init));
    amf::AMFFactory* factory = nullptr;
    check(init(AMF_FULL_VERSION, &factory), "AMFInit");
    Require(factory != nullptr, "AMFInit returned no factory", errorCode);
    check(factory->CreateContext(&context), "CreateContext");
    Require(context != nullptr, "AMF returned no context", errorCode);
    check(context->InitDX11(device, amf::AMF_DX11_1), "InitDX11(selected OBS device)");
    const auto created = factory->CreateComponent(context, av1 ? AMFVideoEncoder_AV1 : AMFVideoEncoderVCE_AVC, &encoder);
    ValidateAmfComponentResult(created, av1, evidence);
    Require(encoder != nullptr, "AMF returned no selected codec component", errorCode);
    check(encoder->SetProperty(av1 ? AMF_VIDEO_ENCODER_AV1_FRAMESIZE : AMF_VIDEO_ENCODER_FRAMESIZE,
        AMFConstructSize(video.width, video.height)), "SetProperty(FrameSize)");
    check(encoder->SetProperty(av1 ? AMF_VIDEO_ENCODER_AV1_USAGE : AMF_VIDEO_ENCODER_USAGE,
        amf_int64{AMF_VIDEO_ENCODER_USAGE_TRANSCODING}), "SetProperty(Usage)");
    check(encoder->SetProperty(av1 ? AMF_VIDEO_ENCODER_AV1_PROFILE : AMF_VIDEO_ENCODER_PROFILE,
        amf_int64{av1 ? AMF_VIDEO_ENCODER_AV1_PROFILE_MAIN : AMF_VIDEO_ENCODER_PROFILE_MAIN}), "SetProperty(Profile)");
    check(encoder->GetCaps(&caps), "GetCaps");
    Require(caps != nullptr, "AMF returned no selected codec capabilities", errorCode);
    if (av1) {
      check(encoder->SetProperty(AMF_VIDEO_ENCODER_AV1_ENCODING_LATENCY_MODE,
          amf_int64{AMF_VIDEO_ENCODER_AV1_ENCODING_LATENCY_MODE_LOWEST_LATENCY}), "SetProperty(AV1 latency)");
      amf::AMFVariant profile, latency;
      check(encoder->GetProperty(AMF_VIDEO_ENCODER_AV1_PROFILE, &profile), "GetProperty(AV1 profile)");
      check(encoder->GetProperty(AMF_VIDEO_ENCODER_AV1_ENCODING_LATENCY_MODE, &latency), "GetProperty(AV1 latency)");
      Require(profile.type == amf::AMF_VARIANT_INT64 && profile.int64Value == AMF_VIDEO_ENCODER_AV1_PROFILE_MAIN &&
          latency.type == amf::AMF_VARIANT_INT64 &&
          latency.int64Value == AMF_VIDEO_ENCODER_AV1_ENCODING_LATENCY_MODE_LOWEST_LATENCY,
          "AMF changed the explicit AV1 Main low-latency configuration", errorCode);
      evidence += " profile=main latency=lowest sourceCaptured=false framesSubmitted=0";
    } else {
    amf::AMFVariant maximum;
    const auto observed = caps->GetProperty(AMF_VIDEO_ENCODER_CAP_MAX_LEVEL, &maximum);
    if (observed == AMF_OK) {
      Require(maximum.type == amf::AMF_VARIANT_INT64, "AMF MaxLevel is not an integer capability", errorCode);
      evidence += " MaxLevel=" + std::to_string(maximum.int64Value);
      ValidateAmfLevelCapability(maximum.int64Value, video);
    } else if (observed == AMF_NOT_FOUND || observed == AMF_NOT_SUPPORTED) {
      evidence += " MaxLevel=unavailable(status=" + std::to_string(observed) + ")";
    } else fail("GetProperty(MaxLevel)", observed);
    // Missing optional capability metadata is not support evidence: the exact
    // typed property must still round-trip, then OBS performs its real Init.
    check(encoder->SetProperty(AMF_VIDEO_ENCODER_PROFILE_LEVEL, amf_int64{required}),
          "SetProperty(ProfileLevel)");
    amf::AMFVariant actual;
    check(encoder->GetProperty(AMF_VIDEO_ENCODER_PROFILE_LEVEL, &actual), "GetProperty(ProfileLevel)");
    Require(actual.type == amf::AMF_VARIANT_INT64 && actual.int64Value == required,
            "AMF changed the explicitly required H264 level; fallback is forbidden", errorCode);
    evidence += " ProfileLevelReadback=" + std::to_string(actual.int64Value) +
        " sourceCaptured=false framesSubmitted=0";
    }
  } catch (...) { failure = std::current_exception(); }
  const auto cleanupFailure = [&](const std::string& detail) {
    if (failure) {
      try { std::rethrow_exception(failure); }
      catch (const std::exception& error) {
        failure = std::make_exception_ptr(ContractError(errorCode, std::string(error.what()) + "; " + detail));
      } catch (...) {
        failure = std::make_exception_ptr(ContractError(errorCode, evidence + "; unknown probe failure; " + detail));
      }
    } else failure = std::make_exception_ptr(ContractError(errorCode, evidence + "; " + detail));
  };
  bool retired = true;
  caps = nullptr;
  if (encoder) {
    const auto result = encoder->Terminate();
    if (result != AMF_OK) {
      retired = false;
      cleanupFailure("AMF encoder Terminate status=" + std::to_string(result) + " retirement=unconfirmed");
    }
    encoder = nullptr;
  }
  if (context) {
    const auto result = context->Terminate();
    if (result != AMF_OK) {
      retired = false;
      cleanupFailure("AMF context Terminate status=" + std::to_string(result) + " retirement=unconfirmed");
    }
    context = nullptr;
  }
  // Keep the driver loaded if teardown cannot confirm ownership retirement.
  if (retired && !FreeLibrary(library))
    cleanupFailure("FreeLibrary(amfrt64.dll) win32=" + std::to_string(GetLastError()));
  if (failure) std::rethrow_exception(failure);
  return evidence;
}
}  // namespace monky::screen_capture
