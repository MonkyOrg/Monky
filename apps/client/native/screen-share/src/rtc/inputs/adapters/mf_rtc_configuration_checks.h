#pragma once

#include "mf_h264_encoder.h"

#include <array>
#include <limits>
#include <string_view>
#include <type_traits>

namespace monky::native_rtc::mf {
namespace configuration_checks_detail {

using screen_video::EncoderConfigurationReadbacks;
using screen_video::EncoderPropertyReadback;
using State = screen_video::EncoderReadbackState;
using Reason = screen_video::EncoderReadbackReason;

// A stack-owned IUnknown only observes VariantClear's Release; no COM object
// activation, apartment, MF startup, encoder or device is involved.
class TrackedValue final : public IUnknown {
 public:
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** result) noexcept override {
    if (!result) return E_POINTER;
    *result = nullptr;
    if (iid != __uuidof(IUnknown)) return E_NOINTERFACE;
    *result = static_cast<IUnknown*>(this);
    AddRef();
    return S_OK;
  }
  ULONG STDMETHODCALLTYPE AddRef() noexcept override {
    ++addRefs;
    return ++references;
  }
  ULONG STDMETHODCALLTYPE Release() noexcept override {
    ++releases;
    return --references;
  }
  ULONG references = 1;
  std::uint64_t addRefs = 0, releases = 0;
};

struct Reply {
  HRESULT hresult = S_OK;
  VARTYPE type = VT_UI4;
  std::uint32_t value = 0;
  IUnknown* object = nullptr;
  bool operator==(const Reply&) const = default;
};

class FakeCodec {
 public:
  std::array<Reply, 3> replies{};
  std::array<std::uint64_t, 3> reads{};
  std::uint64_t writes = 0, unexpectedKeys = 0;
  bool initializedVariants = true;

  HRESULT GetValue(const GUID* key, VARIANT* value) noexcept {
    if (!key || !value) return E_POINTER;
    std::size_t index = 0;
    if (*key == CODECAPI_AVEncMPVGOPSize) index = 0;
    else if (*key == CODECAPI_AVEncCommonRateControlMode) index = 1;
    else if (*key == CODECAPI_AVEncCommonMeanBitRate) index = 2;
    else { ++unexpectedKeys; return E_INVALIDARG; }
    ++reads[index];
    initializedVariants = initializedVariants && value->vt == VT_EMPTY;
    const auto& reply = replies[index];
    *value = {};
    value->vt = reply.type;
    switch (reply.type) {
      case VT_UI4: value->ulVal = reply.value; break;
      case VT_UINT: value->uintVal = reply.value; break;
      case VT_I4: value->lVal = -1; break;
      case VT_UI8: value->ullVal = (std::numeric_limits<ULONGLONG>::max)(); break;
      case VT_BOOL: value->boolVal = VARIANT_TRUE; break;
      case VT_UNKNOWN:
        value->punkVal = reply.object;
        if (value->punkVal) value->punkVal->AddRef();
        break;
      default: break;
    }
    return reply.hresult;
  }

  HRESULT SetValue(const GUID*, VARIANT*) noexcept {
    ++writes;
    return E_ACCESSDENIED;
  }

  void Read(EncoderConfigurationReadbacks& readbacks) {
    screen_video::ReadEncoderConfiguration(readbacks,
        [this](const GUID* key, VARIANT* value) { return GetValue(key, value); });
  }
};

inline std::array<const EncoderPropertyReadback*, 3> Properties(const EncoderConfigurationReadbacks& readbacks) {
  return {&readbacks.gopSize, &readbacks.rateControlMode, &readbacks.meanBitrateBps};
}

inline bool Unobserved(const EncoderConfigurationReadbacks& readbacks) {
  for (const auto* property : Properties(readbacks)) {
    if (property->state != State::Unobserved || property->reason != Reason::NotObserved ||
        property->observations != 0 || property->value || property->hresult ||
        property->variantType || property->cleanupHresult) return false;
  }
  return true;
}

}  // namespace configuration_checks_detail

template <typename Check>
void RunEncoderConfigurationChecks(Check&& check) {
  using namespace configuration_checks_detail;
  static_assert(std::is_trivially_copyable_v<EncoderConfigurationReadbacks>);
  screen_video::EncoderStats stats;
  TrackedValue object;
  FakeCodec codec;
  check(Unobserved(stats.configurationReadbacks) && codec.reads == std::array<std::uint64_t, 3>{},
        "Constructing encoder stats invented a readback value, HRESULT, VARTYPE or observation");

  codec.replies = {Reply{S_OK, VT_UI4, 0}, Reply{S_OK, VT_UI4, 0}, Reply{S_OK, VT_UI4, 4000000}};
  const auto zeroReplies = codec.replies;
  codec.Read(stats.configurationReadbacks);
  auto properties = Properties(stats.configurationReadbacks);
  for (std::size_t i = 0; i < properties.size(); ++i) {
    const auto& observed = *properties[i];
    check(observed.state == State::Available && observed.reason == Reason::None &&
          observed.value == zeroReplies[i].value && observed.hresult == S_OK &&
          observed.variantType == VT_UI4 && observed.cleanupHresult == S_OK &&
          observed.observations == 1 && codec.reads[i] == 1,
          "A real GetValue result (including value zero) was not recorded exactly once");
  }
  check(codec.replies == zeroReplies && codec.writes == 0 && codec.unexpectedKeys == 0 && codec.initializedVariants,
        "Configuration readback mutated settings, queried another property or used an uninitialized VARIANT");

  const auto readsBeforeSnapshot = codec.reads;
  auto snapshot = stats;
  snapshot.configurationReadbacks.gopSize.value = 99;
  snapshot.configurationReadbacks.rateControlMode.hresult.reset();
  check(stats.configurationReadbacks.gopSize.value == 0 &&
        stats.configurationReadbacks.rateControlMode.hresult == S_OK && codec.reads == readsBeforeSnapshot,
        "Copying or changing a stats snapshot queried the codec or changed the worker's readbacks");

  codec.replies = {Reply{S_OK, VT_UI4, (std::numeric_limits<std::uint32_t>::max)()},
                   Reply{S_OK, VT_UI4, 5}, Reply{S_OK, VT_UI4, 8000000}};
  const auto validReplies = codec.replies;
  codec.Read(stats.configurationReadbacks);
  for (std::size_t i = 0; i < properties.size(); ++i) {
    check(properties[i]->value == validReplies[i].value && properties[i]->state == State::Available &&
          properties[i]->observations == 2 && codec.reads[i] == 2,
          "Readback changed a raw uint32 value, confused property GUIDs or skipped a completed read");
  }

  struct Case {
    HRESULT hresult;
    VARTYPE type;
    State state;
    Reason reason;
    const char* message;
  };
  const std::array cases{
      Case{E_NOTIMPL, VT_EMPTY, State::Unsupported, Reason::NotImplemented,
           "E_NOTIMPL was not recorded as an unsupported readback"},
      Case{VFW_E_CODECAPI_NO_CURRENT_VALUE, VT_EMPTY, State::Unavailable, Reason::NoCurrentValue,
           "No-current-value was confused with unsupported, error, zero or unobserved"},
      Case{E_FAIL, VT_EMPTY, State::Error, Reason::GetValueFailed,
           "An unexpected failing HRESULT was hidden as unsupported"},
      Case{E_INVALIDARG, VT_EMPTY, State::Error, Reason::GetValueFailed,
           "E_INVALIDARG was hidden as an unsupported property"},
      Case{E_NOINTERFACE, VT_EMPTY, State::Error, Reason::GetValueFailed,
           "An unexpected interface failure was hidden as unsupported"},
      Case{S_FALSE, VT_EMPTY, State::Error, Reason::UnexpectedGetValueResult,
           "GetValue S_FALSE was treated like IsSupported S_FALSE"},
      Case{static_cast<HRESULT>(2), VT_UI4, State::Error, Reason::UnexpectedGetValueResult,
           "An undocumented successful HRESULT was accepted as a property value"},
      Case{S_OK, VT_EMPTY, State::Error, Reason::UnexpectedVariantType,
           "Successful VT_EMPTY was accepted or confused with an unobserved type"},
      Case{S_OK, VT_NULL, State::Error, Reason::UnexpectedVariantType,
           "Successful VT_NULL was accepted as a numeric readback"},
      Case{S_OK, VT_I4, State::Error, Reason::UnexpectedVariantType,
           "A signed negative property was coerced into an unsigned value"},
      Case{S_OK, VT_UI8, State::Error, Reason::UnexpectedVariantType,
           "A 64-bit property was silently narrowed to uint32"},
      Case{S_OK, VT_UINT, State::Error, Reason::UnexpectedVariantType,
           "VT_UINT was silently accepted instead of the property's documented VT_UI4"},
      Case{S_OK, VT_BOOL, State::Error, Reason::UnexpectedVariantType,
           "A boolean property was silently accepted as an unsigned value"},
      Case{E_FAIL, VT_UI4, State::Error, Reason::GetValueFailed,
           "A value written by a failed getter became an available readback"},
      Case{S_FALSE, VT_UI4, State::Error, Reason::UnexpectedGetValueResult,
           "A value written with S_FALSE became an available readback"},
      Case{E_NOTIMPL, VT_UI4, State::Unsupported, Reason::NotImplemented,
           "An unsupported getter's output hid its actual HRESULT"},
      Case{VFW_E_CODECAPI_NO_CURRENT_VALUE, VT_UI4, State::Unavailable, Reason::NoCurrentValue,
           "A no-current-value getter's output hid its actual HRESULT"},
      Case{S_OK, VT_UNKNOWN, State::Error, Reason::UnexpectedVariantType,
           "A resource-owning unexpected VARIANT was accepted as a numeric property"},
      Case{E_FAIL, VT_UNKNOWN, State::Error, Reason::GetValueFailed,
           "A resource-owning failed getter hid its actual HRESULT"},
      Case{E_NOTIMPL, VT_UNKNOWN, State::Unsupported, Reason::NotImplemented,
           "A resource-owning unsupported getter hid its actual HRESULT"},
      Case{VFW_E_CODECAPI_NO_CURRENT_VALUE, VT_UNKNOWN, State::Unavailable, Reason::NoCurrentValue,
           "A resource-owning unavailable getter hid its actual HRESULT"}};

  for (const auto& test : cases) {
    codec.replies = validReplies;
    codec.Read(stats.configurationReadbacks);
    const auto previousReads = codec.reads;
    const auto previousReleases = object.releases;
    codec.replies.fill(Reply{test.hresult, test.type, 123, &object});
    const auto configuredReplies = codec.replies;
    codec.Read(stats.configurationReadbacks);
    for (std::size_t i = 0; i < properties.size(); ++i) {
      const auto& observed = *properties[i];
      check(observed.state == test.state && observed.reason == test.reason &&
            !observed.value && observed.hresult == test.hresult, test.message);
      const auto expectedType = test.hresult == S_OK || test.type != VT_EMPTY
          ? std::optional<VARTYPE>(test.type) : std::nullopt;
      check(observed.variantType == expectedType && observed.cleanupHresult == S_OK &&
            observed.observations == codec.reads[i] && codec.reads[i] == previousReads[i] + 1,
            "Failed readback retained stale evidence, fabricated a VARTYPE, skipped a query or miscounted calls");
    }
    check(codec.replies == configuredReplies && codec.writes == 0,
          "A failing diagnostic readback tried to repair or reconfigure the codec");
    const auto expectedReleases = test.type == VT_UNKNOWN ? 3u : 0u;
    check(object.references == 1 && object.addRefs == object.releases &&
          object.releases == previousReleases + expectedReleases,
          "VariantClear did not release every returned resource, including on failed/unsupported getters");
  }

  codec.replies = validReplies;
  codec.Read(stats.configurationReadbacks);
  codec.replies = {Reply{E_FAIL, VT_EMPTY}, Reply{S_OK, VT_UI4, 0}, Reply{E_NOTIMPL, VT_EMPTY}};
  codec.Read(stats.configurationReadbacks);
  check(stats.configurationReadbacks.gopSize.state == State::Error &&
        stats.configurationReadbacks.rateControlMode.state == State::Available &&
        stats.configurationReadbacks.rateControlMode.value == 0 &&
        stats.configurationReadbacks.meanBitrateBps.state == State::Unsupported,
        "A property's diagnostic failure stopped later reads or contaminated another property's state");
  for (std::size_t i = 0; i < properties.size(); ++i) {
    check(properties[i]->observations == codec.reads[i],
          "Mixed property outcomes changed the actual GetValue observation counts");
  }

  codec.replies.fill(Reply{S_OK, VT_ILLEGAL});
  codec.Read(stats.configurationReadbacks);
  for (const auto* observed : properties) {
    check(observed->state == State::Error && observed->reason == Reason::VariantClearFailed &&
          !observed->value && observed->hresult == S_OK && observed->variantType == VT_ILLEGAL &&
          observed->cleanupHresult == DISP_E_BADVARTYPE,
          "VariantClear failure was hidden or overwrote the raw getter HRESULT/VARTYPE");
  }
  check(codec.writes == 0 && codec.unexpectedKeys == 0 && codec.initializedVariants,
        "Readback wrote settings, queried extra properties or reused an uncleared VARIANT");

  const auto readsBeforeReset = codec.reads;
  const screen_video::EncoderStats nextEncoder;
  stats = {};
  check(Unobserved(stats.configurationReadbacks) && Unobserved(nextEncoder.configurationReadbacks) &&
        codec.reads == readsBeforeReset,
        "Reset/new encoder lifecycle retained old values, HRESULTs, types or observation counts");
  codec.replies = zeroReplies;
  codec.Read(stats.configurationReadbacks);
  for (std::size_t i = 0; i < properties.size(); ++i) {
    check(properties[i]->state == State::Available && properties[i]->observations == 1 &&
          codec.reads[i] == readsBeforeReset[i] + 1 && properties[i]->value == zeroReplies[i].value,
          "A fresh encoder lifecycle inherited observations or failed to read the actual properties");
  }
  check(std::string_view(screen_video::EncoderReadbackStateName(State::Unobserved)) == "unobserved" &&
        std::string_view(screen_video::EncoderReadbackStateName(State::Available)) == "available" &&
        std::string_view(screen_video::EncoderReadbackStateName(State::Unavailable)) == "unavailable" &&
        std::string_view(screen_video::EncoderReadbackStateName(State::Unsupported)) == "unsupported" &&
        std::string_view(screen_video::EncoderReadbackStateName(State::Error)) == "error" &&
        std::string_view(screen_video::EncoderReadbackReasonName(Reason::NotObserved)) == "not-observed",
        "Readback status/reason names no longer expose the bounded diagnostic meanings");
}

}  // namespace monky::native_rtc::mf
