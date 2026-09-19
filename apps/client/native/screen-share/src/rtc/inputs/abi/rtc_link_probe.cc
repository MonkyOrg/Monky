#include "monky_rtc_abi.h"
#include "adapter_policy_probe.h"

#include <algorithm>
#include <atomic>
#include <cstring>
#include <memory>
#include <new>
#include <stdexcept>
#include <string>
#include <string_view>
#include <type_traits>

#include <winrt/base.h>

#include "api/create_peerconnection_factory.h"
#include "api/jsep.h"
#include "mf_h264_decoder.h"
#include "ortc.hpp"
#include "sdptransform.hpp"

#if !defined(__clang__) || !defined(_LIBCPP_VERSION)
#error The RTC DLL requires the pinned clang-cl and Chromium libc++.
#endif

#define MONKY_STRINGIFY_IMPL(value) #value
#define MONKY_STRINGIFY(value) MONKY_STRINGIFY_IMPL(value)
static_assert(std::string_view(MONKY_STRINGIFY(_LIBCPP_ABI_NAMESPACE)) == "__Cr");
static_assert(_LIBCPP_ABI_VERSION == 2);
static_assert(sizeof(void*) == 8);
static_assert(sizeof(MonkyRtcProbeInfo) == 32);
static_assert(sizeof(MonkyRtcComInfo) == 16);
static_assert(sizeof(MonkyRtcError) == 272);
static_assert(std::is_standard_layout_v<MonkyRtcProbeInfo>);
static_assert(std::is_trivially_copyable_v<MonkyRtcProbeInfo>);

struct MonkyRtcLinkProbe {
  std::string sdp;
  MonkyRtcProbeInfo info{};
};

namespace {

std::atomic<uint32_t> live_results{0};
// Keep a real reference to the public factory API at link time, without calling
// it: a null/default ADM during factory creation could open the microphone.
decltype(&webrtc::CreatePeerConnectionFactory) volatile factory_entry =
    &webrtc::CreatePeerConnectionFactory;

MonkyRtcStatus Failure(MonkyRtcError* error, MonkyRtcStatus status,
                       const char* message, int32_t hresult = 0) noexcept {
  if (error && error->struct_size == sizeof(*error)) {
    error->code = status;
    error->hresult = hresult;
    error->reserved = 0;
    const size_t length = (std::min)(std::strlen(message), sizeof(error->message) - 1);
    std::memcpy(error->message, message, length);
    error->message[length] = '\0';
  }
  return status;
}

template <typename Operation>
MonkyRtcStatus Boundary(MonkyRtcError* error, Operation&& operation) noexcept {
  if (!error || error->struct_size != sizeof(*error)) return MONKY_RTC_ABI_MISMATCH;
  Failure(error, MONKY_RTC_OK, "");
  try {
    return operation();
  } catch (const winrt::hresult_error& failure) {
    return Failure(error, MONKY_RTC_COM_ERROR, "C++/WinRT failure contained at C ABI",
                   static_cast<int32_t>(failure.code()));
  } catch (const std::bad_alloc&) {
    return Failure(error, MONKY_RTC_OUT_OF_MEMORY, "RTC DLL allocation failed");
  } catch (const std::exception& failure) {
    return Failure(error, MONKY_RTC_CPP_EXCEPTION, failure.what());
  } catch (...) {
    // The C ABI must never unwind into the independently compiled MSVC addon.
    return Failure(error, MONKY_RTC_CPP_EXCEPTION, "Non-standard C++ exception contained at C ABI");
  }
}

}  // namespace

extern "C" MONKY_RTC_API MonkyRtcStatus __cdecl monky_rtc_link_probe_create(
    const char* sdp, uint32_t sdp_bytes, MonkyRtcLinkProbe** result,
    MonkyRtcError* error) noexcept {
  if (result) *result = nullptr;
  return Boundary(error, [&]() -> MonkyRtcStatus {
    if (!result || !sdp || !sdp_bytes || sdp_bytes > 65536 ||
        std::memchr(sdp, '\0', sdp_bytes)) {
      return Failure(error, MONKY_RTC_INVALID_ARGUMENT, "Expected bounded SDP bytes without embedded NUL");
    }
    const std::string input(sdp, sdp_bytes);
    webrtc::SdpParseError parse_error;
    auto description = webrtc::CreateSessionDescription(webrtc::SdpType::kOffer, input, &parse_error);
    if (!description) return Failure(error, MONKY_RTC_PARSE_ERROR, parse_error.description.c_str());

    auto parsed = sdptransform::parse(input);
    auto normalized = sdptransform::write(parsed);
    auto roundtrip = webrtc::CreateSessionDescription(webrtc::SdpType::kOffer, normalized, &parse_error);
    if (!roundtrip || normalized.size() > 262144) {
      return Failure(error, MONKY_RTC_PARSE_ERROR, "SDP roundtrip failed or exceeded its bound");
    }

    nlohmann::json capabilities = {
        {"codecs", {{{"kind", "video"}, {"mimeType", "video/H264"},
                     {"preferredPayloadType", 96}, {"clockRate", 90000},
                     {"parameters", {{"packetization-mode", 1}, {"level-asymmetry-allowed", 1},
                                     {"profile-level-id", "42e033"}}},
                     {"rtcpFeedback", nlohmann::json::array()}}}},
        {"headerExtensions", nlohmann::json::array()}};
    mediasoupclient::ortc::validateRtpCapabilities(capabilities);
    auto remote = capabilities;
    auto extended = mediasoupclient::ortc::getExtendedRtpCapabilities(capabilities, remote);
    if (!mediasoupclient::ortc::canSend("video", extended) ||
        mediasoupclient::ortc::getRecvRtpCapabilities(extended).at("codecs").empty()) {
      return Failure(error, MONKY_RTC_PARSE_ERROR, "libmediasoupclient did not reconcile real H264 capabilities");
    }
    auto profile = monky::screen_video::ParseProfileLevelId("42e033");
    if (profile.profileIdc != 66 || profile.levelIdc != 51) {
      return Failure(error, MONKY_RTC_PARSE_ERROR, "Qualified native H264 profile parser disagreed");
    }
    const winrt::hstring wide(L"Monky RTC ABI");
    if (winrt::to_string(wide) != "Monky RTC ABI" || !factory_entry) {
      return Failure(error, MONKY_RTC_ABI_MISMATCH, "C++/WinRT or public factory link probe failed");
    }
    monky::native_rtc::VerifyDeviceFreeAdapterPolicies();

    auto output = std::make_unique<MonkyRtcLinkProbe>();
    output->sdp = std::move(normalized);
    output->info = {sizeof(MonkyRtcProbeInfo), MONKY_RTC_ABI_VERSION, 64, __clang_major__,
                    _LIBCPP_ABI_VERSION,
                    MONKY_RTC_PROBE_WEBRTC_SDP | MONKY_RTC_PROBE_SDPTRANSFORM |
                        MONKY_RTC_PROBE_MEDIASOUP_ORTC | MONKY_RTC_PROBE_NATIVE_CORE |
                        MONKY_RTC_PROBE_CPPWINRT | MONKY_RTC_PROBE_PCF_LINKED |
                        MONKY_RTC_PROBE_LIBCXX_CR | MONKY_RTC_PROBE_MF_ADAPTER_POLICIES,
                    static_cast<uint32_t>(roundtrip->number_of_mediasections()),
                    static_cast<uint32_t>(output->sdp.size())};
    *result = output.release();
    live_results.fetch_add(1, std::memory_order_relaxed);
    return MONKY_RTC_OK;
  });
}

extern "C" MONKY_RTC_API MonkyRtcStatus __cdecl monky_rtc_link_probe_info(
    const MonkyRtcLinkProbe* result, MonkyRtcProbeInfo* info) noexcept {
  if (!result || !info) return MONKY_RTC_INVALID_ARGUMENT;
  if (info->struct_size != sizeof(*info) || info->abi_version != MONKY_RTC_ABI_VERSION) {
    return MONKY_RTC_ABI_MISMATCH;
  }
  *info = result->info;
  return MONKY_RTC_OK;
}

extern "C" MONKY_RTC_API MonkyRtcStatus __cdecl monky_rtc_link_probe_copy_sdp(
    const MonkyRtcLinkProbe* result, char* destination, uint32_t capacity,
    uint32_t* required_bytes) noexcept {
  if (!result || !required_bytes || (!destination && capacity)) return MONKY_RTC_INVALID_ARGUMENT;
  *required_bytes = static_cast<uint32_t>(result->sdp.size()) + 1;
  if (!destination || capacity < *required_bytes) return MONKY_RTC_BUFFER_TOO_SMALL;
  std::memcpy(destination, result->sdp.c_str(), *required_bytes);
  return MONKY_RTC_OK;
}

extern "C" MONKY_RTC_API MonkyRtcStatus __cdecl monky_rtc_link_probe_destroy(
    MonkyRtcLinkProbe* result) noexcept {
  if (!result) return MONKY_RTC_INVALID_ARGUMENT;
  delete result;
  live_results.fetch_sub(1, std::memory_order_relaxed);
  return MONKY_RTC_OK;
}

extern "C" MONKY_RTC_API uint32_t __cdecl monky_rtc_link_probe_live_results() noexcept {
  return live_results.load(std::memory_order_relaxed);
}

extern "C" MONKY_RTC_API MonkyRtcStatus __cdecl monky_rtc_link_probe_com(
    IUnknown* object, MonkyRtcComInfo* info, MonkyRtcError* error) noexcept {
  return Boundary(error, [&]() -> MonkyRtcStatus {
    if (!object || !info) return Failure(error, MONKY_RTC_INVALID_ARGUMENT, "A borrowed COM reference is required");
    if (info->struct_size != sizeof(*info) || info->abi_version != MONKY_RTC_ABI_VERSION) {
      return Failure(error, MONKY_RTC_ABI_MISMATCH, "COM probe structure version/size mismatch");
    }
    winrt::com_ptr<IUnknown> retained;
    retained.copy_from(object);
    winrt::com_ptr<IUnknown> queried;
    winrt::check_hresult(retained->QueryInterface(IID_IUnknown, queried.put_void()));
    info->identity_preserved = queried.get() == object ? 1 : 0;
    info->reserved = 0;
    return MONKY_RTC_OK;
  });
}
