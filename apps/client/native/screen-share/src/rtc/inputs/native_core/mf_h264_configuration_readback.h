#pragma once

#include <Windows.h>
#include <codecapi.h>
#include <oleauto.h>
#include <vfwmsgs.h>

#include <cstdint>
#include <optional>

namespace monky::screen_video {

enum class EncoderReadbackState : std::uint8_t {
  Unobserved, Available, Unavailable, Unsupported, Error
};

enum class EncoderReadbackReason : std::uint8_t {
  NotObserved, None, NoCurrentValue, NotImplemented, GetValueFailed,
  UnexpectedGetValueResult, UnexpectedVariantType, VariantClearFailed
};

constexpr const char* EncoderReadbackStateName(EncoderReadbackState state) noexcept {
  switch (state) {
    case EncoderReadbackState::Unobserved: return "unobserved";
    case EncoderReadbackState::Available: return "available";
    case EncoderReadbackState::Unavailable: return "unavailable";
    case EncoderReadbackState::Unsupported: return "unsupported";
    case EncoderReadbackState::Error: return "error";
  }
  return "error";
}

constexpr const char* EncoderReadbackReasonName(EncoderReadbackReason reason) noexcept {
  switch (reason) {
    case EncoderReadbackReason::NotObserved: return "not-observed";
    case EncoderReadbackReason::None: return "none";
    case EncoderReadbackReason::NoCurrentValue: return "no-current-value";
    case EncoderReadbackReason::NotImplemented: return "not-implemented";
    case EncoderReadbackReason::GetValueFailed: return "get-value-failed";
    case EncoderReadbackReason::UnexpectedGetValueResult: return "unexpected-get-value-result";
    case EncoderReadbackReason::UnexpectedVariantType: return "unexpected-variant-type";
    case EncoderReadbackReason::VariantClearFailed: return "variant-clear-failed";
  }
  return "invalid-reason";
}

struct EncoderPropertyReadback {
  std::optional<std::uint32_t> value;
  EncoderReadbackState state = EncoderReadbackState::Unobserved;
  std::optional<HRESULT> hresult;
  std::optional<VARTYPE> variantType;
  // Completed GetValue calls, including failures; snapshot reads add nothing.
  std::uint64_t observations = 0;
  EncoderReadbackReason reason = EncoderReadbackReason::NotObserved;
  std::optional<HRESULT> cleanupHresult;
};

struct EncoderConfigurationReadbacks {
  EncoderPropertyReadback gopSize, rateControlMode, meanBitrateBps;
};

namespace configuration_readback_detail {

template <typename GetValue>
void ReadProperty(EncoderPropertyReadback& readback, const GUID& key, GetValue& getValue) {
  const auto previousObservations = readback.observations;
  readback = {};
  readback.observations = previousObservations;
  struct Observation {
    EncoderPropertyReadback& readback;
    VARIANT value;
    explicit Observation(EncoderPropertyReadback& target) : readback(target) { VariantInit(&value); }
    ~Observation() {
      readback.cleanupHresult = VariantClear(&value);
      if (*readback.cleanupHresult != S_OK) {
        readback.value.reset();
        readback.state = EncoderReadbackState::Error;
        readback.reason = EncoderReadbackReason::VariantClearFailed;
      }
    }
  } observed{readback};

  const HRESULT hr = getValue(&key, &observed.value);
  ++readback.observations;
  readback.hresult = hr;
  // A failed getter may leave the initialized VT_EMPTY untouched. A successful
  // getter returning VT_EMPTY, however, is an observed invalid property type.
  if (hr == S_OK || observed.value.vt != VT_EMPTY) readback.variantType = observed.value.vt;
  if (hr == S_OK) {
    if (observed.value.vt == VT_UI4) {
      readback.value = static_cast<std::uint32_t>(observed.value.ulVal);
      readback.state = EncoderReadbackState::Available;
      readback.reason = EncoderReadbackReason::None;
    } else {
      readback.state = EncoderReadbackState::Error;
      readback.reason = EncoderReadbackReason::UnexpectedVariantType;
    }
  } else if (hr == VFW_E_CODECAPI_NO_CURRENT_VALUE) {
    readback.state = EncoderReadbackState::Unavailable;
    readback.reason = EncoderReadbackReason::NoCurrentValue;
  } else if (hr == E_NOTIMPL) {
    readback.state = EncoderReadbackState::Unsupported;
    readback.reason = EncoderReadbackReason::NotImplemented;
  } else {
    // S_FALSE means unsupported for IsSupported, not for GetValue. Do not
    // reinterpret undocumented getter results (including E_INVALIDARG).
    readback.state = EncoderReadbackState::Error;
    readback.reason = FAILED(hr) ? EncoderReadbackReason::GetValueFailed
                                 : EncoderReadbackReason::UnexpectedGetValueResult;
  }
}

}  // namespace configuration_readback_detail

// The getter has ICodecAPI::GetValue's HRESULT contract. Keeping the actual
// query/classification here permits CPU-only fake getters without COM startup.
template <typename GetValue>
void ReadEncoderConfiguration(EncoderConfigurationReadbacks& readbacks, GetValue&& getValue) {
  configuration_readback_detail::ReadProperty(readbacks.gopSize, CODECAPI_AVEncMPVGOPSize, getValue);
  configuration_readback_detail::ReadProperty(readbacks.rateControlMode, CODECAPI_AVEncCommonRateControlMode, getValue);
  configuration_readback_detail::ReadProperty(readbacks.meanBitrateBps, CODECAPI_AVEncCommonMeanBitRate, getValue);
}

}  // namespace monky::screen_video
