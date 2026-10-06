#include "mf_h264_encoder.h"

#include <codecapi.h>
#include <strmif.h>
#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mftransform.h>
#include <propvarutil.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <deque>
#include <iomanip>
#include <limits>
#include <map>
#include <mutex>
#include <sstream>
#include <utility>

namespace monky::screen_video {
namespace {

using Clock = std::chrono::steady_clock;
constexpr DWORD maxPacketBytes = 8 * 1024 * 1024;
constexpr auto progressTimeout = std::chrono::seconds(10);

double Milliseconds(Clock::duration duration) {
  return std::chrono::duration<double, std::milli>(duration).count();
}

void Require(HRESULT hr, const char* code, const char* message) {
  if (FAILED(hr)) throw EncoderError(code, message, hr);
}

class Handle {
 public:
  Handle() : value_(CreateEventW(nullptr, FALSE, FALSE, nullptr)) {
    if (!value_) throw EncoderError("ERR_ENCODER_EVENT", "Could not create encoder wake event",
                                    HRESULT_FROM_WIN32(GetLastError()));
  }
  ~Handle() { CloseHandle(value_); }
  HANDLE Get() const { return value_; }
 private:
  HANDLE value_;
};

struct Notice {
  enum class Kind { Media, Returned };
  Kind kind = Kind::Media;
  MediaEventType type = MEUnknown;
  HRESULT status = S_OK;
  UINT32 stream = 0;
  std::uint64_t inputId = 0;
  std::optional<Clock::time_point> callbackEnteredAt, queuedAt;
};

struct CallbackState {
  explicit CallbackState(std::size_t limit) : limit(limit) {}
  Handle wake;
  const std::size_t limit;
  std::mutex mutex;
  std::deque<Notice> notices;
  std::atomic<bool> closing{false};
  std::atomic<std::uint64_t> owners{0};
  std::atomic<HRESULT> callbackError{S_OK};
  EncoderCallbackTiming needInputTiming, haveOutputTiming;
  std::uint64_t peakPendingNotices = 0;

  void Fail(HRESULT hr) noexcept {
    HRESULT expected = S_OK;
    callbackError.compare_exchange_strong(expected, FAILED(hr) ? hr : E_FAIL);
    SetEvent(wake.Get());
  }
  void Push(Notice notice) noexcept {
    try {
      std::lock_guard<std::mutex> lock(mutex);
      if (notices.size() >= limit) {
        Fail(MF_E_NOTACCEPTING);
        return;
      }
      notices.push_back(notice);
      auto& queued = notices.back();
      if (queued.kind == Notice::Kind::Media && queued.callbackEnteredAt) {
        queued.queuedAt = Clock::now();
        if (queued.type == METransformNeedInput)
          needInputTiming.Observe(*queued.callbackEnteredAt, *queued.queuedAt);
        else if (queued.type == METransformHaveOutput)
          haveOutputTiming.Observe(*queued.callbackEnteredAt, *queued.queuedAt);
      }
      peakPendingNotices = (std::max)(peakPendingNotices, std::uint64_t(notices.size()));
      SetEvent(wake.Get());
    } catch (...) {
      Fail(E_OUTOFMEMORY);
    }
  }
};

class SampleCallback : public winrt::implements<SampleCallback, IMFAsyncCallback> {
 public:
  SampleCallback(std::shared_ptr<CallbackState> state, std::uint64_t id)
      : state_(std::move(state)), id_(id) { ++state_->owners; }
  ~SampleCallback() {
    --state_->owners;
    SetEvent(state_->wake.Get());
  }
  HRESULT STDMETHODCALLTYPE GetParameters(DWORD*, DWORD*) noexcept override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE Invoke(IMFAsyncResult*) noexcept override {
    Notice notice;
    notice.kind = Notice::Kind::Returned;
    notice.inputId = id_;
    state_->Push(notice);
    return S_OK;
  }
 private:
  std::shared_ptr<CallbackState> state_;
  std::uint64_t id_;
};

class EventCallback : public winrt::implements<EventCallback, IMFAsyncCallback> {
 public:
  EventCallback(std::shared_ptr<CallbackState> state, IMFMediaEventGenerator* events)
      : state_(std::move(state)) {
    events_.copy_from(events);
    ++state_->owners;
  }
  ~EventCallback() {
    events_ = nullptr;
    --state_->owners;
    SetEvent(state_->wake.Get());
  }
  static void Arm(const std::shared_ptr<CallbackState>& state, IMFMediaEventGenerator* events) {
    if (state->closing.load()) return;
    auto callback = winrt::make_self<EventCallback>(state, events);
    const auto hr = events->BeginGetEvent(callback.get(), nullptr);
    if (hr == MF_E_SHUTDOWN && state->closing.load()) return;
    Require(hr, "ERR_ENCODER_EVENTS",
            "Could not subscribe to asynchronous encoder events");
  }
  HRESULT STDMETHODCALLTYPE GetParameters(DWORD*, DWORD*) noexcept override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE Invoke(IMFAsyncResult* result) noexcept override {
    const auto callbackEnteredAt = Clock::now();
    try {
      winrt::com_ptr<IMFMediaEvent> event;
      const auto hr = events_->EndGetEvent(result, event.put());
      if (state_->closing.load()) return S_OK;
      if (FAILED(hr)) { state_->Fail(hr); return S_OK; }
      Notice notice;
      notice.callbackEnteredAt = callbackEnteredAt;
      Require(event->GetType(&notice.type), "ERR_ENCODER_EVENTS", "Cannot read encoder event type");
      Require(event->GetStatus(&notice.status), "ERR_ENCODER_EVENTS", "Cannot read encoder event status");
      if (notice.type == METransformNeedInput) {
        Require(event->GetUINT32(MF_EVENT_MFT_INPUT_STREAM_ID, &notice.stream),
                "ERR_ENCODER_EVENTS", "NeedInput omitted its input stream identifier");
      }
      state_->Push(notice);
      Arm(state_, events_.get());
    } catch (const EncoderError& error) {
      state_->Fail(error.hresult);
    } catch (const winrt::hresult_error& error) {
      state_->Fail(error.code());
    } catch (...) {
      state_->Fail(E_OUTOFMEMORY);
    }
    return S_OK;
  }
 private:
  std::shared_ptr<CallbackState> state_;
  winrt::com_ptr<IMFMediaEventGenerator> events_;
};

std::string AttributeString(IMFAttributes* attributes, REFGUID key) {
  wchar_t* text = nullptr;
  UINT32 length = 0;
  Require(attributes->GetAllocatedString(key, &text, &length),
          "ERR_ENCODER_IDENTITY", "Hardware encoder identity is unavailable");
  std::string result;
  try { result = winrt::to_string(std::wstring_view(text, length)); }
  catch (...) { CoTaskMemFree(text); throw; }
  CoTaskMemFree(text);
  return result;
}

std::string GuidString(REFGUID guid) {
  wchar_t text[40]{};
  if (!StringFromGUID2(guid, text, 40)) throw EncoderError("ERR_ENCODER_IDENTITY", "Invalid encoder CLSID");
  return winrt::to_string(text);
}

void ApplyControl(ICodecAPI* codec, const GUID& key, VARIANT& setting, const char* code) {
  const auto supported = codec->IsSupported(&key);
  if (supported != S_OK) throw EncoderError(code, "Required hardware encoder control is unsupported", supported);
  const auto applied = codec->SetValue(&key, &setting);
  // CodecAPI uses S_FALSE for a read-only property, not successful application.
  if (applied != S_OK) throw EncoderError(code, "Hardware encoder control was not applied", applied);
}

void SetUi4(ICodecAPI* codec, const GUID& key, ULONG value, const char* code) {
  VARIANT setting;
  VariantInit(&setting);
  setting.vt = VT_UI4;
  setting.ulVal = value;
  ApplyControl(codec, key, setting, code);
}

void SetBool(ICodecAPI* codec, const GUID& key, bool value, const char* code) {
  VARIANT setting;
  VariantInit(&setting);
  setting.vt = VT_BOOL;
  setting.boolVal = value ? VARIANT_TRUE : VARIANT_FALSE;
  ApplyControl(codec, key, setting, code);
}

void SetVerifiedBitrate(ICodecAPI* codec, ULONG bitrate) {
  SetUi4(codec, CODECAPI_AVEncCommonMeanBitRate, bitrate, "ERR_ENCODER_BITRATE");
  VARIANT observed;
  VariantInit(&observed);
  const auto result = codec->GetValue(&CODECAPI_AVEncCommonMeanBitRate, &observed);
  const bool retained = result == S_OK && observed.vt == VT_UI4 && observed.ulVal == bitrate;
  VariantClear(&observed);
  if (!retained) {
    throw EncoderError("ERR_ENCODER_BITRATE_VERIFICATION", "Hardware encoder did not retain the requested bitrate", result);
  }
}

winrt::com_ptr<IMFMediaType> VideoType(const EncoderConfig& config, bool compressed) {
  winrt::com_ptr<IMFMediaType> type;
  Require(MFCreateMediaType(type.put()), "ERR_ENCODER_MEDIA_TYPE", "Cannot allocate media type");
  Require(type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video), "ERR_ENCODER_MEDIA_TYPE", "Cannot set video major type");
  Require(type->SetGUID(MF_MT_SUBTYPE, compressed ? MFVideoFormat_H264 : MFVideoFormat_NV12),
          "ERR_ENCODER_MEDIA_TYPE", "Cannot set video subtype");
  Require(MFSetAttributeSize(type.get(), MF_MT_FRAME_SIZE, config.width, config.height),
          "ERR_ENCODER_MEDIA_TYPE", "Cannot set encoder dimensions");
  Require(MFSetAttributeRatio(type.get(), MF_MT_FRAME_RATE, config.fps, 1),
          "ERR_ENCODER_MEDIA_TYPE", "Cannot set encoder frame rate");
  Require(MFSetAttributeRatio(type.get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1),
          "ERR_ENCODER_MEDIA_TYPE", "Cannot set pixel aspect ratio");
  Require(type->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive),
          "ERR_ENCODER_MEDIA_TYPE", "Cannot select progressive video");
  Require(type->SetUINT32(MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709),
          "ERR_ENCODER_MEDIA_TYPE", "Cannot set BT.709 matrix");
  Require(type->SetUINT32(MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709),
          "ERR_ENCODER_MEDIA_TYPE", "Cannot set BT.709 primaries");
  Require(type->SetUINT32(MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709),
          "ERR_ENCODER_MEDIA_TYPE", "Cannot set BT.709 transfer");
  Require(type->SetUINT32(MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235),
          "ERR_ENCODER_MEDIA_TYPE", "Cannot set limited-range video");
  if (compressed) {
    Require(type->SetUINT32(MF_MT_AVG_BITRATE, config.bitrateBps),
            "ERR_ENCODER_MEDIA_TYPE", "Cannot set bitrate");
    const auto profile = config.profile == H264Profile::Main ? eAVEncH264VProfile_Main
        : config.profile == H264Profile::ConstrainedBaseline ? eAVEncH264VProfile_ConstrainedBase
        : eAVEncH264VProfile_Base;
    Require(type->SetUINT32(MF_MT_MPEG2_PROFILE, profile),
            "ERR_ENCODER_MEDIA_TYPE", "Cannot select the explicit H264 profile");
    Require(type->SetUINT32(MF_MT_MPEG2_LEVEL, config.level),
            "ERR_ENCODER_MEDIA_TYPE", "Cannot select the required H264 level");
  }
  return type;
}

}  // namespace

struct MfH264Encoder::Impl {
  struct Input {
    std::uint64_t id = 0;
    std::shared_ptr<const GpuNv12Frame> source;
    winrt::com_ptr<ID3D11Texture2D> texture;
    winrt::com_ptr<IMFSample> sample;
    std::int64_t pts = 0;
    std::int64_t timestampUs = 0;
    std::int64_t durationUs = 0;
    bool copied = false;
    bool copyDone = false;
    bool accepted = false;
    bool returned = false;
    bool outputDone = false;
    Clock::time_point offeredAt{};
    Clock::time_point submittedAt{};
  };

  EncoderConfig config;
  EncoderStats stats;
  PacketSink sink;
  winrt::com_ptr<ID3D11Device> device;
  winrt::com_ptr<ID3D11DeviceContext4> context;
  winrt::com_ptr<ID3D11Fence> copyFence;
  winrt::com_ptr<IMFDXGIDeviceManager> manager;
  winrt::com_ptr<IMFActivate> activation;
  winrt::com_ptr<IMFTransform> transform;
  winrt::com_ptr<IMFMediaEventGenerator> events;
  winrt::com_ptr<ICodecAPI> codec;
  std::shared_ptr<CallbackState> callbacks;
  std::map<std::int64_t, Input> inputs;
  H264Bitstream bitstream;
  DWORD inputStream = 0;
  DWORD outputStream = 0;
  MFT_OUTPUT_STREAM_INFO outputInfo{};
  UINT resetToken = 0;
  std::uint64_t nextId = 1;
  std::uint64_t inputCredits = 0;
  std::uint64_t armedCopy = 0;
  ID3D11Fence* armedProducer = nullptr;
  std::uint64_t armedProducerValue = 0;
  std::int64_t epochUs = -1;
  bool mfStarted = false;
  HMODULE mfModule = nullptr;
  bool draining = false;
  bool drainSent = false;
  bool drainComplete = false;
  bool aborting = false;
  bool shutdown = false;
  bool completionValidated = false;
  bool gpuLost = false;
  bool abortFenceSent = false;
  Clock::time_point lastProgress = Clock::now();

  Impl(ID3D11Device* suppliedDevice, ID3D11DeviceContext4* suppliedContext,
       const EncoderConfig& requested, PacketSink output)
      : config(requested), sink(std::move(output)),
        callbacks(std::make_shared<CallbackState>(requested.maxInFlight * 4 + 32)),
        bitstream(requested.width, requested.height, requested.level, requested.profile) {
    device.copy_from(suppliedDevice);
    context.copy_from(suppliedContext);
    stats.bitrateBps = config.bitrateBps;
    stats.maxInFlight = config.maxInFlight;
    stats.info.requestedLevel = config.level;
    stats.info.requestedProfile = config.profile;
  }

  ~Impl() {
    CloseTransform();
    // The host pumps shutdown before destroying the core; retained sample
    // textures are immutable even if a failed MFT releases references late.
    inputs.clear();
    manager = nullptr;
    if (mfStarted) MFShutdown();
    if (mfModule) FreeLibrary(mfModule);
  }

  [[noreturn]] void Fail(const char* code, const char* message, HRESULT hr = S_OK) {
    ++stats.errors;
    stats.state = "error";
    throw EncoderError(code, message, hr);
  }

  void CheckDevice() {
    const auto hr = device->GetDeviceRemovedReason();
    if (FAILED(hr)) {
      gpuLost = true;
      Fail("ERR_ENCODER_DEVICE_LOST", "The shared native D3D11 device was lost", hr);
    }
  }

  void ReadSequenceHeader() {
    winrt::com_ptr<IMFMediaType> type;
    Require(transform->GetOutputCurrentType(outputStream, type.put()),
            "ERR_ENCODER_MEDIA_TYPE", "Cannot inspect current H264 output type");
    UINT32 width = 0, height = 0;
    Require(MFGetAttributeSize(type.get(), MF_MT_FRAME_SIZE, &width, &height),
            "ERR_ENCODER_MEDIA_TYPE", "H264 output omitted dimensions");
    if (width != config.width || height != config.height) {
      Fail("ERR_ENCODER_GEOMETRY", "The hardware encoder changed output dimensions");
    }
    UINT32 numerator = 0, denominator = 0, interlace = 0;
    Require(MFGetAttributeRatio(type.get(), MF_MT_FRAME_RATE, &numerator, &denominator),
            "ERR_ENCODER_MEDIA_TYPE", "H264 output omitted its configured frame rate");
    Require(type->GetUINT32(MF_MT_INTERLACE_MODE, &interlace),
            "ERR_ENCODER_MEDIA_TYPE", "H264 output omitted its scan mode");
    if (!denominator || numerator != static_cast<std::uint64_t>(config.fps) * denominator ||
        interlace != MFVideoInterlace_Progressive) {
      Fail("ERR_ENCODER_MEDIA_TYPE", "The hardware MFT changed frame rate or progressive scan mode");
    }
    UINT32 size = 0;
    const auto hr = type->GetBlobSize(MF_MT_MPEG_SEQUENCE_HEADER, &size);
    if (hr == MF_E_ATTRIBUTENOTFOUND) return;
    Require(hr, "ERR_H264_SEQUENCE_HEADER", "Cannot read H264 sequence header");
    if (size == 0) return;
    if (size > 64 * 1024) Fail("ERR_H264_SEQUENCE_HEADER", "H264 sequence header is too large");
    std::vector<std::uint8_t> bytes(size);
    Require(type->GetBlob(MF_MT_MPEG_SEQUENCE_HEADER, bytes.data(), size, &size),
            "ERR_H264_SEQUENCE_HEADER", "Cannot copy H264 sequence header");
    try { bitstream.SetSequenceHeader(bytes); }
    catch (const std::exception& error) { Fail("ERR_H264_SPS", error.what()); }
  }

  void InitializeCandidate(IMFActivate* candidate) {
    activation.copy_from(candidate);
    stats.info.name = AttributeString(candidate, MFT_FRIENDLY_NAME_Attribute);
    GUID clsid{};
    Require(candidate->GetGUID(MFT_TRANSFORM_CLSID_Attribute, &clsid),
            "ERR_ENCODER_IDENTITY", "Hardware encoder CLSID is unavailable");
    stats.info.clsid = GuidString(clsid);
    Require(candidate->ActivateObject(__uuidof(IMFTransform), transform.put_void()),
            "ERR_ENCODER_ACTIVATE", "Could not activate the hardware H264 MFT");
    winrt::com_ptr<IMFAttributes> attributes;
    Require(transform->GetAttributes(attributes.put()), "ERR_ENCODER_ATTRIBUTES", "Encoder has no attribute store");
    UINT32 async = 0, aware = 0;
    Require(attributes->GetUINT32(MF_TRANSFORM_ASYNC, &async), "ERR_ENCODER_ASYNC", "Encoder did not declare asynchronous support");
    Require(attributes->GetUINT32(MF_SA_D3D11_AWARE, &aware), "ERR_ENCODER_D3D11", "Encoder did not declare D3D11 awareness");
    if (!async || !aware) throw EncoderError("ERR_ENCODER_UNSUPPORTED", "A D3D11-aware asynchronous hardware MFT is required");
    Require(attributes->SetUINT32(MF_TRANSFORM_ASYNC_UNLOCK, TRUE),
            "ERR_ENCODER_ASYNC", "Could not unlock asynchronous MFT");
    Require(transform->ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, reinterpret_cast<ULONG_PTR>(manager.get())),
            "ERR_ENCODER_D3D_MANAGER", "Encoder rejected the native device manager");
    events = transform.try_as<IMFMediaEventGenerator>();
    codec = transform.try_as<ICodecAPI>();
    if (!events || !codec || !transform.try_as<IMFShutdown>()) {
      throw EncoderError("ERR_ENCODER_UNSUPPORTED", "Hardware MFT lacks events, shutdown, or CodecAPI");
    }
    DWORD inCount = 0, outCount = 0;
    Require(transform->GetStreamCount(&inCount, &outCount), "ERR_ENCODER_STREAMS", "Cannot inspect MFT streams");
    if (inCount != 1 || outCount != 1) throw EncoderError("ERR_ENCODER_STREAMS", "Only single-stream H264 MFTs are supported");
    const auto ids = transform->GetStreamIDs(1, &inputStream, 1, &outputStream);
    if (ids == E_NOTIMPL) { inputStream = 0; outputStream = 0; }
    else Require(ids, "ERR_ENCODER_STREAMS", "Cannot read MFT stream IDs");

    SetBool(codec.get(), CODECAPI_AVLowLatencyMode, true, "ERR_ENCODER_LOW_LATENCY");
    SetUi4(codec.get(), CODECAPI_AVEncCommonRateControlMode, eAVEncCommonRateControlMode_CBR,
           "ERR_ENCODER_RATE_CONTROL");
    SetUi4(codec.get(), CODECAPI_AVEncCommonMeanBitRate, config.bitrateBps, "ERR_ENCODER_BITRATE");
    const auto bFramesControl = codec->IsSupported(&CODECAPI_AVEncMPVDefaultBPictureCount);
    if (bFramesControl == S_OK) {
      SetUi4(codec.get(), CODECAPI_AVEncMPVDefaultBPictureCount, 0, "ERR_ENCODER_B_FRAMES");
    } else if (config.profile == H264Profile::Main) {
      throw EncoderError("ERR_ENCODER_B_FRAMES", "Main qualification requires an explicit zero-B-picture control", bFramesControl);
    }
    if (config.profile != H264Profile::Baseline && codec->IsSupported(&CODECAPI_AVEncMPVProfile) == S_OK) {
      SetUi4(codec.get(), CODECAPI_AVEncMPVProfile, config.profile == H264Profile::Main
          ? eAVEncH264VProfile_Main : eAVEncH264VProfile_ConstrainedBase, "ERR_ENCODER_PROFILE");
    }
    if (codec->IsSupported(&CODECAPI_AVEncAdaptiveMode) == S_OK) {
      SetUi4(codec.get(), CODECAPI_AVEncAdaptiveMode, eAVEncAdaptiveMode_None, "ERR_ENCODER_ADAPTIVE_MODE");
    }
    auto output = VideoType(config, true);
    auto input = VideoType(config, false);
    Require(transform->SetOutputType(outputStream, output.get(), 0),
            "ERR_ENCODER_OUTPUT_TYPE", "Hardware MFT rejected the requested H264 profile/level/rate");
    Require(transform->SetInputType(inputStream, input.get(), 0),
            "ERR_ENCODER_INPUT_TYPE", "Hardware MFT rejected native NV12 input");
    Require(transform->GetOutputStreamInfo(outputStream, &outputInfo),
            "ERR_ENCODER_OUTPUT_INFO", "Cannot inspect encoded output allocation requirements");
    ReadSequenceHeader();
    Require(transform->ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0),
            "ERR_ENCODER_START", "Encoder rejected begin-streaming");
    Require(transform->ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0),
            "ERR_ENCODER_START", "Encoder rejected start-of-stream");
    // IsModifiable is E_NOTIMPL in the AMD MFT. Exercise the real setter and
    // readback in streaming state instead of mistaking a missing query for no support.
    SetVerifiedBitrate(codec.get(), (std::max)(64000u, config.bitrateBps / 2));
    SetVerifiedBitrate(codec.get(), config.bitrateBps);
    SetUi4(codec.get(), CODECAPI_AVEncVideoForceKeyFrame, 1, "ERR_ENCODER_KEYFRAME");
    ++stats.keyFrameRequests;
    stats.info.hardware = true;
    stats.info.d3d11Aware = true;
    stats.info.asynchronous = true;
    stats.info.dynamicBitrate = true;
    stats.info.forceKeyFrame = true;
    stats.info.lowLatency = true;
  }

  void Initialize() {
    if (!device || !context || !sink || config.width < 16 || config.width > 4096 ||
        config.height < 16 || config.height > 4096 || (config.width & 1) || (config.height & 1) ||
        !config.fps || config.fps > 240 || config.bitrateBps < 64000 ||
        config.profile == H264Profile::AnySupported ||
        config.bitrateBps > 240000000 || config.maxInFlight < 2 || config.maxInFlight > 16 ||
        static_cast<std::uint64_t>(config.width) * config.height * 3 / 2 * config.maxInFlight > 256ull * 1024 * 1024 ||
        RequiredH264Level(config.width, config.height, config.fps, config.bitrateBps) != config.level) {
      Fail("ERR_ENCODER_CONFIGURATION", "Invalid bounded native encoder configuration/device");
    }
    winrt::com_ptr<ID3D11Device> contextDevice;
    context->GetDevice(contextDevice.put());
    if (contextDevice.as<IUnknown>().get() != device.as<IUnknown>().get()) {
      Fail("ERR_ENCODER_WRONG_DEVICE", "Encoder context must belong to the supplied device");
    }
    auto multithread = context.try_as<ID3D11Multithread>();
    if (!multithread) Fail("ERR_ENCODER_MULTITHREAD", "D3D11 multithread protection is required");
    multithread->SetMultithreadProtected(TRUE);
    if (!multithread->GetMultithreadProtected()) Fail("ERR_ENCODER_MULTITHREAD", "D3D11 multithread protection was not enabled");
    // mfplat is delay-loaded so requiring this addon / using createCapture
    // does not require the optional Media Feature Pack on Windows N editions.
    mfModule = LoadLibraryExW(L"mfplat.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
    if (!mfModule) Fail("ERR_ENCODER_MF_PLATFORM", "Media Foundation / the Windows Media Feature Pack is unavailable",
                        HRESULT_FROM_WIN32(GetLastError()));
    Require(MFStartup(MF_VERSION, MFSTARTUP_FULL), "ERR_ENCODER_MF_STARTUP", "Media Foundation is unavailable");
    mfStarted = true;
    Require(MFCreateDXGIDeviceManager(&resetToken, manager.put()),
            "ERR_ENCODER_DEVICE_MANAGER", "Cannot create DXGI device manager");
    Require(manager->ResetDevice(device.get(), resetToken),
            "ERR_ENCODER_DEVICE_MANAGER", "Cannot install the capture device in DXGI device manager");
    auto device5 = device.try_as<ID3D11Device5>();
    if (!device5) Fail("ERR_ENCODER_FENCE", "D3D11 fence support is required");
    Require(device5->CreateFence(0, D3D11_FENCE_FLAG_NONE, __uuidof(ID3D11Fence), copyFence.put_void()),
            "ERR_ENCODER_FENCE", "Cannot create native input-copy fence");
    auto dxgiDevice = device.as<IDXGIDevice>();
    winrt::com_ptr<IDXGIAdapter> adapter;
    Require(dxgiDevice->GetAdapter(adapter.put()), "ERR_ENCODER_ADAPTER", "Cannot locate capture adapter");
    DXGI_ADAPTER_DESC desc{};
    Require(adapter->GetDesc(&desc), "ERR_ENCODER_ADAPTER", "Cannot read capture adapter LUID");
    const auto luid = (static_cast<UINT64>(static_cast<UINT32>(desc.AdapterLuid.HighPart)) << 32) |
                       desc.AdapterLuid.LowPart;
    winrt::com_ptr<IMFAttributes> enumeration;
    Require(MFCreateAttributes(enumeration.put(), 1), "ERR_ENCODER_ENUMERATION", "Cannot create enumeration attributes");
    Require(enumeration->SetUINT64(MFT_ENUM_ADAPTER_LUID, luid),
            "ERR_ENCODER_ENUMERATION", "Cannot select hardware encoder adapter");
    MFT_REGISTER_TYPE_INFO input{MFMediaType_Video, MFVideoFormat_NV12};
    MFT_REGISTER_TYPE_INFO output{MFMediaType_Video, MFVideoFormat_H264};
    IMFActivate** raw = nullptr;
    UINT32 count = 0;
    Require(MFTEnum2(MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
                     &input, &output, enumeration.get(), &raw, &count),
            "ERR_ENCODER_ENUMERATION", "Cannot enumerate hardware H264 encoders for the native adapter");
    std::vector<winrt::com_ptr<IMFActivate>> candidates;
    try {
      candidates.reserve(count);
      for (UINT32 i = 0; i < count; ++i) {
        winrt::com_ptr<IMFActivate> candidate;
        candidate.attach(raw[i]);
        raw[i] = nullptr;
        candidates.push_back(std::move(candidate));
      }
    } catch (...) {
      for (UINT32 i = 0; i < count; ++i) if (raw[i]) raw[i]->Release();
      CoTaskMemFree(raw);
      throw;
    }
    CoTaskMemFree(raw);
    bool selected = false;
    for (auto& candidate : candidates) {
      try {
        InitializeCandidate(candidate.get());
        selected = true;
        break;
      } catch (const EncoderError& error) {
        if (stats.info.rejectedCandidates.size() < 16) {
          std::ostringstream detail;
          detail << stats.info.name << ": " << error.code << ": " << error.what()
                 << " (HRESULT 0x" << std::hex << static_cast<std::uint32_t>(error.hresult) << ')';
          stats.info.rejectedCandidates.push_back(detail.str());
        }
        const auto cleanup = candidate->ShutdownObject();
        if (FAILED(cleanup) && cleanup != MF_E_SHUTDOWN) {
          throw EncoderError("ERR_ENCODER_ACTIVATION_SHUTDOWN", "Failed to shut down rejected hardware MFT", cleanup);
        }
        codec = nullptr;
        events = nullptr;
        transform = nullptr;
        activation = nullptr;
        bitstream = H264Bitstream(config.width, config.height, config.level, config.profile);
      }
    }
    if (!selected) {
      std::string reason = "No compatible D3D11-aware hardware H264 encoder accepted the explicit profile/mode";
      for (const auto& rejected : stats.info.rejectedCandidates) reason += "\n" + rejected;
      Fail("ERR_ENCODER_HARDWARE_UNAVAILABLE", reason.c_str());
    }
    // Failed candidates are diagnostics, not errors in the selected session.
    stats.errors = 0;
    EventCallback::Arm(callbacks, events.get());
    stats.state = "running";
    // Observe only the selected streaming MFT, after the existing verification
    // has restored the requested bitrate and initialization has succeeded.
    ReadEncoderConfiguration(stats.configurationReadbacks,
        [this](const GUID* key, VARIANT* value) { return codec->GetValue(key, value); });
  }

  bool Submit(std::shared_ptr<const GpuNv12Frame> frame) {
    ++stats.inputs;
    if (draining || shutdown || inputs.size() >= config.maxInFlight) {
      ++stats.droppedInput;
      return false;
    }
    if (!frame || !frame->texture || !frame->readyFence || !frame->readyValue ||
        frame->readyValue == UINT64_MAX || frame->timestampUs < 0 ||
        frame->timestampUs > (std::numeric_limits<std::int64_t>::max)() / 10 ||
        frame->durationUs <= 0 || frame->durationUs > 1000000) {
      Fail("ERR_ENCODER_GPU_FRAME", "A real fenced NV12 GPU frame is required");
    }
    D3D11_TEXTURE2D_DESC desc{};
    frame->texture->GetDesc(&desc);
    if (desc.Format != DXGI_FORMAT_NV12 || desc.Width != config.width || desc.Height != config.height ||
        desc.MipLevels != 1 || desc.SampleDesc.Count != 1 || frame->subresource >= desc.ArraySize) {
      Fail("ERR_ENCODER_GPU_FRAME", "GPU frame format/geometry/subresource does not match the encoder");
    }
    winrt::com_ptr<ID3D11Device> frameDevice;
    frame->texture->GetDevice(frameDevice.put());
    winrt::com_ptr<ID3D11Device> fenceDevice;
    frame->readyFence->GetDevice(fenceDevice.put());
    if (frameDevice.as<IUnknown>().get() != device.as<IUnknown>().get() ||
        fenceDevice.as<IUnknown>().get() != device.as<IUnknown>().get()) {
      Fail("ERR_ENCODER_WRONG_DEVICE", "Encoder and NV12 input must use the same D3D11 device object");
    }
    if (epochUs < 0) epochUs = frame->timestampUs;
    if (stats.lastInputTimestampUs >= frame->timestampUs) {
      Fail("ERR_ENCODER_TIMESTAMP", "Input capture timestamps must be strictly increasing");
    }
    Input input;
    input.id = nextId++;
    input.pts = (frame->timestampUs - epochUs) * 10;
    input.timestampUs = frame->timestampUs;
    input.durationUs = frame->durationUs;
    input.source = std::move(frame);
    input.offeredAt = Clock::now();
    if (inputs.empty()) lastProgress = input.offeredAt;
    const auto pts = input.pts;
    inputs.emplace(pts, std::move(input));
    ++stats.accepted;
    stats.inFlight = inputs.size();
    stats.peakInFlight = std::max(stats.peakInFlight, stats.inFlight);
    if (stats.firstInputTimestampUs < 0) stats.firstInputTimestampUs = epochUs;
    stats.lastInputTimestampUs = inputs.at(pts).timestampUs;
    SetEvent(callbacks->wake.Get());
    return true;
  }

  void CopyInput(Input& input) {
    auto source = input.source;
    const auto ready = source->readyFence->GetCompletedValue();
    if (ready == UINT64_MAX) { gpuLost = true; Fail("ERR_ENCODER_DEVICE_LOST", "Producer fence reported device loss"); }
    if (ready < source->readyValue) {
      if (armedProducer != source->readyFence.get() || armedProducerValue != source->readyValue) {
        Require(source->readyFence->SetEventOnCompletion(source->readyValue, callbacks->wake.Get()),
                "ERR_ENCODER_FENCE", "Cannot wait for the real source frame");
        armedProducer = source->readyFence.get();
        armedProducerValue = source->readyValue;
      }
      return;
    }
    if (!input.texture) {
      D3D11_TEXTURE2D_DESC desc{};
      desc.Width = config.width;
      desc.Height = config.height;
      desc.MipLevels = 1;
      desc.ArraySize = 1;
      desc.Format = DXGI_FORMAT_NV12;
      desc.SampleDesc.Count = 1;
      desc.Usage = D3D11_USAGE_DEFAULT;
      desc.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
      // Immutable per submission: never exported, keyed, or rewritten after MFT receives it.
      Require(device->CreateTexture2D(&desc, nullptr, input.texture.put()),
              "ERR_ENCODER_PRIVATE_TEXTURE", "Cannot allocate immutable private NV12 encoder input");
      ++stats.privateAllocations;
      winrt::com_ptr<IMFTrackedSample> tracked;
      Require(MFCreateTrackedSample(tracked.put()), "ERR_ENCODER_SAMPLE", "Cannot create tracked input sample");
      input.sample = tracked.as<IMFSample>();
      winrt::com_ptr<IMFMediaBuffer> buffer;
      Require(MFCreateDXGISurfaceBuffer(__uuidof(ID3D11Texture2D), input.texture.get(), 0, FALSE, buffer.put()),
              "ERR_ENCODER_DXGI_BUFFER", "Cannot wrap private GPU input without CPU pixels");
      auto buffer2d = buffer.as<IMF2DBuffer>();
      DWORD length = 0;
      Require(buffer2d->GetContiguousLength(&length), "ERR_ENCODER_DXGI_BUFFER", "Cannot read NV12 logical buffer length");
      Require(buffer->SetCurrentLength(length), "ERR_ENCODER_DXGI_BUFFER", "Cannot set NV12 logical buffer length");
      Require(input.sample->AddBuffer(buffer.get()), "ERR_ENCODER_SAMPLE", "Cannot attach GPU buffer");
      Require(input.sample->SetSampleTime(input.pts), "ERR_ENCODER_TIMESTAMP", "Cannot set input PTS");
      Require(input.sample->SetSampleDuration(input.durationUs * 10),
              "ERR_ENCODER_TIMESTAMP", "Cannot set input duration");
      auto callback = winrt::make_self<SampleCallback>(callbacks, input.id);
      Require(tracked->SetAllocator(callback.get(), nullptr), "ERR_ENCODER_SAMPLE", "Cannot track MFT sample ownership");
    }
    auto keyed = source->texture.try_as<IDXGIKeyedMutex>();
    if (keyed) {
      const auto hr = keyed->AcquireSync(0, 0);
      if (hr == static_cast<HRESULT>(WAIT_TIMEOUT)) return;
      if (hr != S_OK) Fail("ERR_ENCODER_SOURCE_MUTEX", "Cannot acquire source NV12 for the native GPU copy", hr);
    }
    context->CopySubresourceRegion(input.texture.get(), 0, 0, 0, 0,
                                   source->texture.get(), source->subresource, nullptr);
    input.copied = true;
    ++stats.gpuCopies;
    const auto signal = context->Signal(copyFence.get(), input.id);
    context->Flush();
    const auto release = keyed ? keyed->ReleaseSync(0) : S_OK;
    Require(signal, "ERR_ENCODER_COPY_FENCE", "Cannot fence the encoder's source read");
    Require(release, "ERR_ENCODER_SOURCE_MUTEX", "Cannot release source texture mutex");
    armedProducer = nullptr;
    armedProducerValue = 0;
  }

  void ProcessCopies() {
    CheckDevice();
    const auto completed = copyFence->GetCompletedValue();
    if (completed == UINT64_MAX) { gpuLost = true; Fail("ERR_ENCODER_DEVICE_LOST", "Private copy fence reported device loss"); }
    if (armedCopy && completed >= armedCopy) armedCopy = 0;
    std::uint64_t oldestCopy = UINT64_MAX;
    for (auto& [pts, input] : inputs) {
      if (!input.copied && !aborting) {
        CopyInput(input);
        if (!input.copied) break;
      }
      if (input.copied && !input.copyDone) {
        if (completed >= input.id) {
          input.copyDone = true;
          input.source.reset();
        } else {
          oldestCopy = std::min(oldestCopy, input.id);
        }
      }
    }
    if (oldestCopy != UINT64_MAX && armedCopy != oldestCopy) {
      Require(copyFence->SetEventOnCompletion(oldestCopy, callbacks->wake.Get()),
              "ERR_ENCODER_COPY_FENCE", "Cannot await source-copy retirement");
      armedCopy = oldestCopy;
    }
  }

  void Feed() {
    for (auto& [pts, input] : inputs) {
      if (input.accepted || !input.copyDone || !input.sample) continue;
      if (!inputCredits || aborting || shutdown) break;
      const auto hr = MeasureEncoderCall(stats.scheduling.processInput, [&] {
        return transform->ProcessInput(inputStream, input.sample.get(), 0);
      });
      if (hr == MF_E_NOTACCEPTING) {
        inputCredits = 0;
        return;
      }
      Require(hr, "ERR_ENCODER_PROCESS_INPUT", "Hardware MFT rejected a real GPU input");
      --inputCredits;
      input.accepted = true;
      input.submittedAt = Clock::now();
      const auto queueMs = Milliseconds(input.submittedAt - input.offeredAt);
      stats.totalQueueLatencyMs += queueMs;
      stats.maxQueueLatencyMs = std::max(stats.maxQueueLatencyMs, queueMs);
      ++stats.submitted;
      input.sample = nullptr;
      lastProgress = Clock::now();
    }
  }

  void RenegotiateOutput() {
    for (DWORD i = 0; i < 32; ++i) {
      winrt::com_ptr<IMFMediaType> candidate;
      const auto hr = transform->GetOutputAvailableType(outputStream, i, candidate.put());
      if (hr == MF_E_NO_MORE_TYPES) break;
      Require(hr, "ERR_ENCODER_STREAM_CHANGE", "Cannot inspect changed output type");
      GUID subtype{};
      UINT32 w = 0, h = 0;
      if (SUCCEEDED(candidate->GetGUID(MF_MT_SUBTYPE, &subtype)) && subtype == MFVideoFormat_H264 &&
          SUCCEEDED(MFGetAttributeSize(candidate.get(), MF_MT_FRAME_SIZE, &w, &h)) &&
          w == config.width && h == config.height &&
          SUCCEEDED(transform->SetOutputType(outputStream, candidate.get(), 0))) {
        Require(transform->GetOutputStreamInfo(outputStream, &outputInfo),
                "ERR_ENCODER_STREAM_CHANGE", "Cannot refresh H264 output allocation requirements");
        ReadSequenceHeader();
        ++stats.streamChanges;
        return;
      }
    }
    Fail("ERR_ENCODER_STREAM_CHANGE", "MFT requested an incompatible output change");
  }

  void Output() {
    for (unsigned attempt = 0; attempt < 2; ++attempt) {
      winrt::com_ptr<IMFSample> supplied;
      if (!(outputInfo.dwFlags & (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES | MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES))) {
        if (!outputInfo.cbSize || outputInfo.cbSize > maxPacketBytes) {
          Fail("ERR_ENCODER_OUTPUT_ALLOCATION", "Hardware MFT requested an invalid/unbounded output buffer");
        }
        Require(MFCreateSample(supplied.put()), "ERR_ENCODER_OUTPUT_ALLOCATION", "Cannot create compressed output sample");
        winrt::com_ptr<IMFMediaBuffer> buffer;
        if (outputInfo.cbAlignment && (outputInfo.cbAlignment & (outputInfo.cbAlignment - 1))) {
          Fail("ERR_ENCODER_OUTPUT_ALLOCATION", "Hardware MFT requested a non-power-of-two output alignment");
        }
        const auto alignment = outputInfo.cbAlignment ? outputInfo.cbAlignment - 1 : 0;
        Require(MFCreateAlignedMemoryBuffer(outputInfo.cbSize, alignment, buffer.put()),
                "ERR_ENCODER_OUTPUT_ALLOCATION", "Cannot allocate bounded compressed output");
        Require(supplied->AddBuffer(buffer.get()), "ERR_ENCODER_OUTPUT_ALLOCATION", "Cannot attach compressed buffer");
      }
      MFT_OUTPUT_DATA_BUFFER output{};
      output.dwStreamID = outputStream;
      output.pSample = supplied.get();
      DWORD status = 0;
      const auto hr = MeasureEncoderCall(stats.scheduling.processOutput, [&] {
        return transform->ProcessOutput(0, 1, &output, &status);
      });
      if (output.pEvents) output.pEvents->Release();
      winrt::com_ptr<IMFSample> sample;
      if (output.pSample && output.pSample != supplied.get()) sample.attach(output.pSample);
      else sample = supplied;
      if (hr == MF_E_TRANSFORM_STREAM_CHANGE) { RenegotiateOutput(); continue; }
      Require(hr, "ERR_ENCODER_PROCESS_OUTPUT", "Asynchronous hardware output failed");
      if (!sample || (output.dwStatus & MFT_OUTPUT_DATA_BUFFER_NO_SAMPLE) == MFT_OUTPUT_DATA_BUFFER_NO_SAMPLE) return;
      winrt::com_ptr<IMFMediaBuffer> buffer;
      Require(sample->ConvertToContiguousBuffer(buffer.put()),
              "ERR_ENCODER_BITSTREAM", "Cannot access compressed H264 bytes");
      BYTE* data = nullptr;
      DWORD maximum = 0, length = 0;
      Require(buffer->Lock(&data, &maximum, &length), "ERR_ENCODER_BITSTREAM", "Cannot lock compressed output bytes");
      H264AccessUnit au;
      try {
        if (!data || !length || length > maximum || length > maxPacketBytes) {
          throw std::runtime_error("Invalid encoded access-unit size");
        }
        au = bitstream.Convert({data, length});
      } catch (...) {
        buffer->Unlock();
        throw;
      }
      Require(buffer->Unlock(), "ERR_ENCODER_BITSTREAM", "Cannot unlock compressed output bytes");
      if (!au.hasPicture) return;
      LONGLONG pts = 0;
      Require(sample->GetSampleTime(&pts), "ERR_ENCODER_OUTPUT_TIMESTAMP", "Encoded picture omitted its input PTS");
      auto found = inputs.find(pts);
      if (found == inputs.end() || !found->second.accepted || found->second.outputDone) {
        Fail("ERR_ENCODER_OUTPUT_IDENTITY", "Encoded picture does not map to exactly one submitted GPU frame");
      }
      auto& input = found->second;
      if (stats.outputs == 0 && !au.keyFrame) Fail("ERR_H264_INITIAL_IDR", "First encoded picture is not an IDR");
      input.outputDone = true;
      const auto latency = Milliseconds(Clock::now() - input.submittedAt);
      stats.totalEncodeLatencyMs += latency;
      stats.maxEncodeLatencyMs = std::max(stats.maxEncodeLatencyMs, latency);
      ++stats.outputs;
      if (au.keyFrame) ++stats.keyFrames;
      stats.bytes += au.data.size();
      if (stats.firstOutputTimestampUs < 0) stats.firstOutputTimestampUs = input.timestampUs;
      stats.lastOutputTimestampUs = input.timestampUs;
      stats.info.spsVerified = bitstream.Verified();
      stats.info.sps = bitstream.Sps();
      lastProgress = Clock::now();
      EncodedPacket packet{std::move(au.data), input.timestampUs, input.durationUs, au.keyFrame};
      if (!aborting && !MeasureEncoderCall(stats.scheduling.packetSink, [&] {
            return sink(std::move(packet));
          })) {
        Fail("ERR_ENCODER_OUTPUT_QUEUE", "Compressed output consumer queue is full; encoding stopped to preserve GOP integrity");
      }
      return;
    }
    Fail("ERR_ENCODER_STREAM_CHANGE", "Repeated output stream changes prevented frame delivery");
  }

  void CloseTransform() noexcept {
    if (shutdown) return;
    shutdown = true;
    callbacks->closing.store(true);
    inputCredits = 0;
    for (auto& [pts, input] : inputs) input.sample = nullptr;
    if (transform) {
      const auto end = transform->ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
      if (FAILED(end) && end != MF_E_SHUTDOWN && end != MF_E_TRANSFORM_TYPE_NOT_SET) callbacks->Fail(end);
    }
    if (activation) {
      // The activation owns shutdown; do not shut its MFT down a second time.
      const auto hr = activation->ShutdownObject();
      if (FAILED(hr) && hr != MF_E_SHUTDOWN) callbacks->Fail(hr);
    }
    codec = nullptr;
    events = nullptr;
    transform = nullptr;
    activation = nullptr;
    SetEvent(callbacks->wake.Get());
  }

  void Pump() {
    const auto callbackError = callbacks->callbackError.exchange(S_OK);
    if (FAILED(callbackError)) Fail("ERR_ENCODER_CALLBACK", "Encoder event/sample callback or shutdown failed or overflowed", callbackError);
    std::deque<Notice> batch;
    {
      std::lock_guard<std::mutex> lock(callbacks->mutex);
      batch.swap(callbacks->notices);
    }
    for (const auto& notice : batch) {
      if (notice.kind == Notice::Kind::Returned) {
        for (auto& [pts, input] : inputs) {
          if (input.id == notice.inputId && !input.returned) {
            input.returned = true;
            ++stats.sampleReturns;
            break;
          }
        }
        continue;
      }
      if (aborting || shutdown) continue;
      const auto dispatchAt = Clock::now();
      if (FAILED(notice.status)) Fail("ERR_ENCODER_EVENT_STATUS", "Hardware MFT reported an asynchronous error", notice.status);
      if (notice.type == METransformNeedInput) {
        if (notice.stream != inputStream) Fail("ERR_ENCODER_STREAMS", "MFT requested an unexpected input stream");
        if (notice.queuedAt) stats.scheduling.needInputDispatch.Observe(*notice.queuedAt, dispatchAt);
        ++stats.needInputEvents;
        if (!drainSent && ++inputCredits > 256) Fail("ERR_ENCODER_INPUT_CREDITS", "MFT issued an unbounded number of input credits");
      } else if (notice.type == METransformHaveOutput) {
        if (notice.queuedAt) stats.scheduling.haveOutputDispatch.Observe(*notice.queuedAt, dispatchAt);
        ++stats.haveOutputEvents;
        try { Output(); }
        catch (const EncoderError&) { throw; }
        catch (const std::exception& error) { Fail("ERR_H264_BITSTREAM", error.what()); }
      } else if (notice.type == METransformDrainComplete) {
        drainComplete = true;
        for (auto& [pts, input] : inputs) {
          if (input.accepted && !input.outputDone) {
            ++stats.droppedAfterSubmit;
            input.outputDone = true;
          }
        }
        CloseTransform();
      }
    }
    if (!gpuLost) {
      try { ProcessCopies(); }
      catch (const EncoderError&) {
        if (!aborting) throw;
        gpuLost = FAILED(device->GetDeviceRemovedReason());
        if (!gpuLost) throw;
      }
    }
    if (!shutdown && !aborting) Feed();
    if (draining && !drainSent && !shutdown && !aborting) {
      bool unsent = false;
      for (const auto& [pts, input] : inputs) if (!input.accepted) unsent = true;
      if (!unsent) {
        Require(transform->ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, inputStream),
                "ERR_ENCODER_DRAIN", "Encoder rejected end-of-stream");
        Require(transform->ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0),
                "ERR_ENCODER_DRAIN", "Encoder rejected drain");
        drainSent = true;
        inputCredits = 0;
      }
    }
    bool callbacksRetired = false;
    if (shutdown && callbacks->owners.load() == 0) {
      std::lock_guard<std::mutex> lock(callbacks->mutex);
      callbacksRetired = callbacks->notices.empty();
    }
    for (auto it = inputs.begin(); it != inputs.end();) {
      auto& input = it->second;
      const bool sourceDone = !input.copied || input.copyDone || gpuLost;
      const bool sampleDone = input.returned || (!input.sample && callbacksRetired);
      if (aborting && sourceDone) input.source.reset();
      if (sourceDone && ((input.outputDone && sampleDone) ||
                        (shutdown && sampleDone))) {
        if (aborting && !input.outputDone) ++stats.droppedOnStop;
        it = inputs.erase(it);
      } else {
        ++it;
      }
    }
    stats.inFlight = inputs.size();
    stats.pendingCallbacks = callbacks->owners.load();
    if (shutdown && inputs.empty() && callbacksRetired) {
      // CloseTransform and the last callback can fail after this pump's first
      // error check. Only this worker-side validation may authorize completion.
      const auto shutdownError = callbacks->callbackError.exchange(S_OK);
      if (FAILED(shutdownError)) {
        Fail("ERR_ENCODER_CALLBACK", "Encoder callback or shutdown failed during final retirement", shutdownError);
      }
      if (stats.droppedAfterSubmit && !aborting) {
        Fail("ERR_ENCODER_DROPPED_OUTPUT", "MFT drained without producing output for accepted frames");
      }
      manager = nullptr;
      if (mfStarted) {
        const auto hr = MFShutdown();
        mfStarted = false;
        if (FAILED(hr)) Fail("ERR_ENCODER_MF_SHUTDOWN", "Media Foundation shutdown failed", hr);
      }
      stats.state = stats.errors ? "error" : "stopped";
      completionValidated = true;
    } else if (!aborting && (!inputs.empty() || draining) && Clock::now() - lastProgress > progressTimeout) {
      Fail("ERR_ENCODER_PROGRESS_TIMEOUT", "Hardware encoder did not make progress within the bounded deadline");
    }
  }
};

MfH264Encoder::MfH264Encoder(ID3D11Device* device, ID3D11DeviceContext4* context,
                             const EncoderConfig& config, PacketSink sink)
    : impl_(std::make_unique<Impl>(device, context, config, std::move(sink))) {
  impl_->Initialize();
}

MfH264Encoder::~MfH264Encoder() = default;

bool MfH264Encoder::TryEncode(std::shared_ptr<const GpuNv12Frame> frame) {
  return impl_->Submit(std::move(frame));
}

void MfH264Encoder::Pump() { impl_->Pump(); }

void MfH264Encoder::SetBitrate(std::uint32_t bitrateBps) {
  if (impl_->draining || impl_->shutdown) throw EncoderError("ERR_ENCODER_STOPPED", "Encoder is stopping");
  if (bitrateBps < 64000) throw EncoderError("ERR_ENCODER_BITRATE", "Bitrate must be at least 64000 bits/s");
  if (bitrateBps > H264LevelMaxBitrate(impl_->config.level)) {
    throw EncoderError("ERR_ENCODER_RATE_REQUIRES_RESTART", "Bitrate exceeds the configured H264 level");
  }
  SetVerifiedBitrate(impl_->codec.get(), bitrateBps);
  impl_->config.bitrateBps = bitrateBps;
  impl_->stats.bitrateBps = bitrateBps;
  ++impl_->stats.bitrateUpdates;
  ReadEncoderConfiguration(impl_->stats.configurationReadbacks,
      [this](const GUID* key, VARIANT* value) { return impl_->codec->GetValue(key, value); });
}

void MfH264Encoder::RequestKeyFrame() {
  if (impl_->draining || impl_->shutdown) throw EncoderError("ERR_ENCODER_STOPPED", "Encoder is stopping");
  SetUi4(impl_->codec.get(), CODECAPI_AVEncVideoForceKeyFrame, 1, "ERR_ENCODER_KEYFRAME");
  ++impl_->stats.keyFrameRequests;
}

void MfH264Encoder::BeginDrain() {
  if (impl_->draining) return;
  impl_->draining = true;
  impl_->stats.state = "draining";
  impl_->lastProgress = Clock::now();
  SetEvent(impl_->callbacks->wake.Get());
}

void MfH264Encoder::Abort() {
  impl_->aborting = true;
  impl_->draining = true;
  impl_->CloseTransform();
  if (!impl_->abortFenceSent && !impl_->gpuLost) {
    impl_->abortFenceSent = true;
    std::uint64_t latest = 0;
    for (const auto& [pts, input] : impl_->inputs) {
      if (input.copied && !input.copyDone) latest = std::max(latest, input.id);
    }
    if (latest) {
      const auto hr = impl_->context->Signal(impl_->copyFence.get(), latest);
      impl_->context->Flush();
      if (FAILED(hr)) impl_->callbacks->Fail(hr);
    }
  }
}

bool MfH264Encoder::Finished() const {
  return impl_->completionValidated;
}

HANDLE MfH264Encoder::WakeEvent() const { return impl_->callbacks->wake.Get(); }

EncoderStats MfH264Encoder::GetStats() const {
  auto result = impl_->stats;
  result.pendingCallbacks = impl_->callbacks->owners.load();
  {
    std::lock_guard<std::mutex> lock(impl_->callbacks->mutex);
    result.scheduling.needInput = impl_->callbacks->needInputTiming;
    result.scheduling.haveOutput = impl_->callbacks->haveOutputTiming;
    result.scheduling.peakPendingNotices = impl_->callbacks->peakPendingNotices;
  }
  return result;
}

}  // namespace monky::screen_video
