#include "mf_h264_decoder.h"

#include <d3dcompiler.h>
#include <codecapi.h>
#include <strmif.h>
#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mftransform.h>
#include <wmcodecdsp.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstring>
#include <deque>
#include <map>
#include <sstream>

namespace monky::screen_video {
namespace {
using Clock = std::chrono::steady_clock;
constexpr std::size_t maxPacketBytes = 8 * 1024 * 1024;
constexpr std::size_t maxQueueBytes = 32 * 1024 * 1024;
constexpr auto progressTimeout = std::chrono::seconds(10);
std::atomic<std::uint64_t> nextDecodedFrameId{1};

void Require(HRESULT hr, const char* code, const char* message) {
  if (hr == MF_E_UNSUPPORTED_D3D_TYPE) {
    throw DecoderError("ERR_DECODER_UNSUPPORTED_D3D_TYPE",
        "Microsoft MFT rejected D3D decoding; device manager is retained and CPU fallback is prohibited", hr);
  }
  if (FAILED(hr)) throw DecoderError(code, message, hr);
}

void Applied(HRESULT hr, const char* code, const char* message) {
  Require(hr, code, message);
  if (hr != S_OK) throw DecoderError(code, message, hr);
}

class EventHandle {
 public:
  EventHandle() : value_(CreateEventW(nullptr, FALSE, FALSE, nullptr)) {
    if (!value_) throw DecoderError("ERR_DECODER_EVENT", "Cannot create GPU completion event",
                                    HRESULT_FROM_WIN32(GetLastError()));
  }
  ~EventHandle() { CloseHandle(value_); }
  HANDLE Get() const { return value_; }
 private:
  HANDLE value_;
};

std::uint8_t ConfigLevel(const DecoderConfig& config) {
  return config.profileLevelId.empty()
      ? RequiredH264Level(config.width, config.height, config.fps, config.bitrateBps)
      : ParseProfileLevelId(config.profileLevelId).levelIdc;
}

void ValidateDxvaProfile(const H264Sps& sps) {
  if (sps.profileIdc == 66 && !(sps.compatibility & 0x40)) {
    throw DecoderError("ERR_DECODER_BASELINE_COMPATIBILITY",
        "Baseline SPS lacks constraint_set1: inbox DXVA documents only Main-compatible Baseline; use an explicitly supported encoder profile");
  }
  if (sps.profileIdc != 66 && sps.profileIdc != 77) {
    throw DecoderError("ERR_DECODER_PROFILE", "This qualifier supports only Main-compatible Baseline or Main");
  }
}

double Milliseconds(Clock::duration value) {
  return std::chrono::duration<double, std::milli>(value).count();
}

winrt::com_ptr<ID3DBlob> Compile(const char* source, const char* entry, const char* target) {
  winrt::com_ptr<ID3DBlob> shader, errors;
  const auto hr = D3DCompile(source, std::strlen(source), nullptr, nullptr, nullptr, entry, target,
                             D3DCOMPILE_ENABLE_STRICTNESS, 0, shader.put(), errors.put());
  if (FAILED(hr)) {
    const std::string message = errors
        ? std::string(static_cast<const char*>(errors->GetBufferPointer()), errors->GetBufferSize())
        : "Cannot compile diagnostic GPU shader";
    throw DecoderError("ERR_DECODER_INSPECTION_SHADER", message, hr);
  }
  return shader;
}

}  // namespace

struct MfH264Decoder::Impl {
  struct QueuedInput {
    std::uint64_t requestId = 0;
    EncodedPacket packet;
    winrt::com_ptr<IMFSample> sample;
    std::int64_t pts = 0;
    DecoderInputTiming timing;
  };
  struct SubmittedInput {
    std::int64_t timestampUs = 0, durationUs = 0;
    Clock::time_point submittedAt{};
  };
  struct PendingOutput {
    winrt::com_ptr<IMFSample> originalSample;
    std::shared_ptr<GpuDecodedFrame> frame;
    Clock::time_point copyAt{}, inputAt{};
  };

  DecoderConfig config;
  DecoderStats stats;
  FrameSink sink;
  AcceptedSink accepted;
  RetainedFrames retained;
  EventHandle wake;
  winrt::com_ptr<ID3D11Device> device;
  winrt::com_ptr<ID3D11DeviceContext4> context;
  winrt::com_ptr<ID3D11VideoDevice1> videoDevice;
  winrt::com_ptr<ID3D11Fence> fence;
  winrt::com_ptr<IMFDXGIDeviceManager> manager;
  winrt::com_ptr<IMFActivate> activation;
  winrt::com_ptr<IMFTransform> transform;
  DWORD inputId = 0, outputId = 0;
  MFT_OUTPUT_STREAM_INFO outputInfo{};
  std::deque<QueuedInput> queue;
  std::map<std::int64_t, SubmittedInput> submitted;
  std::deque<PendingOutput> copies;
  H264Bitstream bitstream;
  std::int64_t epochUs = -1, lastQueuedUs = -1;
  std::uint64_t nextFenceValue = 1, armedFence = 0;
  bool mfStarted = false, streaming = false, outputAvailable = false;
  bool flushing = false, stopping = false, drainSent = false, drainComplete = false;
  bool flushCompleted = false, aborting = false, shutdown = false, completionValidated = false;
  bool deviceLost = false, requireIdr = true;
  HMODULE mfModule = nullptr;
  Clock::time_point lastProgress = Clock::now();
  winrt::com_ptr<ID3D11VertexShader> inspectVertex;
  winrt::com_ptr<ID3D11PixelShader> inspectPixel;
  winrt::com_ptr<ID3D11SamplerState> inspectSampler;
  winrt::com_ptr<ID3D11RasterizerState> inspectRasterizer;
  winrt::com_ptr<ID3D11Texture2D> inspectTarget, inspectReadback;
  winrt::com_ptr<ID3D11RenderTargetView> inspectRtv;
  winrt::com_ptr<ID3D11Buffer> inspectConstants;

  Impl(const DecoderConfig& config, FrameSink output, AcceptedSink input, RetainedFrames holders)
      : config(config), sink(std::move(output)), accepted(std::move(input)), retained(std::move(holders)),
        bitstream(config.width, config.height, ConfigLevel(config), H264Profile::AnySupported) {}

  ~Impl() {
    if (activation) activation->ShutdownObject();
    transform = nullptr;
    activation = nullptr;
    queue.clear();
    copies.clear();
    manager = nullptr;
    if (mfStarted) MFShutdown();
    if (context) { context->ClearState(); context->Flush(); }
    if (mfModule) FreeLibrary(mfModule);
  }

  [[noreturn]] void Fail(const char* code, const char* message, HRESULT hr = S_OK) {
    ++stats.errors;
    stats.state = "error";
    throw DecoderError(code, message, hr);
  }

  void CheckDevice() {
    if (!device) return;
    const auto hr = device->GetDeviceRemovedReason();
    if (FAILED(hr)) { deviceLost = true; Fail("ERR_DECODER_DEVICE_LOST", "Decoder D3D11 device was lost", hr); }
  }

  void CheckCaps(UINT width, UINT height) {
    if (stats.capabilitiesChecked && stats.capsWidth == width && stats.capsHeight == height) return;
    BOOL supported = FALSE;
    Applied(videoDevice->CheckVideoDecoderFormat(&D3D11_DECODER_PROFILE_H264_VLD_NOFGT,
                                                 DXGI_FORMAT_NV12, &supported),
            "ERR_DECODER_CAPABILITIES", "Cannot inspect H264/NV12 support");
    if (!supported) Fail("ERR_DECODER_NV12_UNSUPPORTED", "Native H264 VLD/NV12 output is unsupported");
    const DXGI_RATIONAL rate{config.fps, 1};
    UINT caps = 0;
    Applied(videoDevice->GetVideoDecoderCaps(&D3D11_DECODER_PROFILE_H264_VLD_NOFGT,
                                             width, height, &rate, config.bitrateBps, nullptr, &caps),
            "ERR_DECODER_CAPABILITIES", "Cannot query actual H264 coded-size/rate/bitrate capabilities");
    stats.decoderCaps = caps;
    stats.capsWidth = width;
    stats.capsHeight = height;
    stats.nv12Supported = true;
    stats.capabilitiesChecked = true;
    if (caps & D3D11_VIDEO_DECODER_CAPS_UNSUPPORTED) Fail("ERR_DECODER_CAPS_UNSUPPORTED", "D3D11 rejects the requested coded H264 mode");
    if (caps & D3D11_VIDEO_DECODER_CAPS_NON_REAL_TIME) Fail("ERR_DECODER_CAPS_NON_REAL_TIME", "D3D11 marks the requested H264 mode as non-real-time");
    if (caps & D3D11_VIDEO_DECODER_CAPS_DOWNSAMPLE_REQUIRED) Fail("ERR_DECODER_CAPS_DOWNSAMPLE_REQUIRED", "D3D11 requires downsampling; exact output is required");
  }

  void InitializeDevice() {
    const D3D_FEATURE_LEVEL levels[]{D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0};
    winrt::com_ptr<ID3D11DeviceContext> immediate;
    Require(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
        D3D11_CREATE_DEVICE_VIDEO_SUPPORT | D3D11_CREATE_DEVICE_BGRA_SUPPORT, levels, 2,
        D3D11_SDK_VERSION, device.put(), nullptr, immediate.put()),
        "ERR_DECODER_DEVICE", "Cannot create the hardware-capable D3D11 decoder device");
    context = immediate.try_as<ID3D11DeviceContext4>();
    auto device5 = device.try_as<ID3D11Device5>();
    videoDevice = device.try_as<ID3D11VideoDevice1>();
    if (!context || !device5 || !videoDevice) Fail("ERR_DECODER_DEVICE_INTERFACES", "D3D11 video capabilities and completion fences are required");
    auto multithread = context.as<ID3D11Multithread>();
    multithread->SetMultithreadProtected(TRUE);
    if (!multithread->GetMultithreadProtected()) Fail("ERR_DECODER_MULTITHREAD", "D3D11 multithread protection was not enabled");
    Require(device5->CreateFence(0, D3D11_FENCE_FLAG_NONE, __uuidof(ID3D11Fence), fence.put_void()),
            "ERR_DECODER_FENCE", "Cannot create decoder GPU copy fence");
    auto dxgi = device.as<IDXGIDevice>();
    winrt::com_ptr<IDXGIAdapter> adapter;
    Require(dxgi->GetAdapter(adapter.put()), "ERR_DECODER_ADAPTER", "Cannot inspect decoder adapter");
    DXGI_ADAPTER_DESC desc{};
    Require(adapter->GetDesc(&desc), "ERR_DECODER_ADAPTER", "Cannot inspect decoder adapter identity");
    stats.adapterDescription = winrt::to_string(desc.Description);
    stats.vendorId = desc.VendorId;
    stats.deviceId = desc.DeviceId;
    stats.luid = desc.AdapterLuid;
    LARGE_INTEGER version{};
    const auto driverResult = adapter->CheckInterfaceSupport(__uuidof(IDXGIDevice), &version);
    if (driverResult == S_OK) {
      std::ostringstream text;
      text << HIWORD(version.HighPart) << '.' << LOWORD(version.HighPart) << '.'
           << HIWORD(version.LowPart) << '.' << LOWORD(version.LowPart);
      stats.driverVersion = text.str();
    } else if (driverResult != DXGI_ERROR_UNSUPPORTED) {
      Require(driverResult, "ERR_DECODER_ADAPTER", "Cannot inspect decoder driver version");
    }
    CheckCaps((config.width + 15) & ~15u, (config.height + 15) & ~15u);
  }

  void ActivateInboxDecoder() {
    MFT_REGISTER_TYPE_INFO input{MFMediaType_Video, MFVideoFormat_H264};
    MFT_REGISTER_TYPE_INFO output{MFMediaType_Video, MFVideoFormat_NV12};
    IMFActivate** list = nullptr;
    UINT32 count = 0;
    Require(MFTEnum2(MFT_CATEGORY_VIDEO_DECODER, MFT_ENUM_FLAG_SYNCMFT | MFT_ENUM_FLAG_SORTANDFILTER,
                     &input, &output, nullptr, &list, &count),
            "ERR_DECODER_ENUMERATION", "Cannot locate the synchronous inbox H264 decoder");
    for (UINT32 i = 0; i < count; ++i) {
      GUID clsid{};
      if (!activation && list[i]->GetGUID(MFT_TRANSFORM_CLSID_Attribute, &clsid) == S_OK &&
          clsid == __uuidof(CMSH264DecoderMFT)) activation.copy_from(list[i]);
      list[i]->Release();
    }
    CoTaskMemFree(list);
    if (!activation) Fail("ERR_DECODER_INBOX_UNAVAILABLE", "Microsoft synchronous H264 Video Decoder MFT is unavailable");
    Require(activation->ActivateObject(__uuidof(IMFTransform), transform.put_void()),
            "ERR_DECODER_ACTIVATION", "Cannot activate Microsoft H264 Video Decoder MFT");
    stats.name = "Microsoft H264 Video Decoder MFT";
    stats.clsid = "{62CE7E72-4C71-4D20-B15D-452831A87D9D}";
    winrt::com_ptr<IMFAttributes> attrs;
    Require(transform->GetAttributes(attrs.put()), "ERR_DECODER_ATTRIBUTES", "Decoder omitted MFT attributes");
    UINT32 async = 0, aware = 0;
    const auto asyncHr = attrs->GetUINT32(MF_TRANSFORM_ASYNC, &async);
    if (asyncHr != MF_E_ATTRIBUTENOTFOUND) Require(asyncHr, "ERR_DECODER_ASYNC", "Cannot inspect decoder synchrony");
    if (async) Fail("ERR_DECODER_ASYNC", "This core requires the inbox synchronous MFT, not asynchronous credits");
    Require(attrs->GetUINT32(MF_SA_D3D11_AWARE, &aware), "ERR_DECODER_D3D11_AWARE", "Decoder did not declare D3D11 awareness");
    if (!aware) Fail("ERR_DECODER_D3D11_AWARE", "Decoder is not D3D11 aware");
    stats.synchronous = true;
    stats.d3d11Aware = true;
    UINT token = 0;
    Require(MFCreateDXGIDeviceManager(&token, manager.put()), "ERR_DECODER_MANAGER", "Cannot create decoder device manager");
    Require(manager->ResetDevice(device.get(), token), "ERR_DECODER_MANAGER", "Cannot assign the actual native D3D11 device");
    Applied(transform->ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, reinterpret_cast<ULONG_PTR>(manager.get())),
            "ERR_DECODER_MANAGER", "Decoder rejected D3D11 device manager");
    stats.d3d11Configured = true;
    DWORD inCount = 0, outCount = 0;
    Require(transform->GetStreamCount(&inCount, &outCount), "ERR_DECODER_STREAMS", "Cannot inspect decoder streams");
    if (inCount != 1 || outCount != 1) Fail("ERR_DECODER_STREAMS", "Only one input and output stream are supported");
    const auto ids = transform->GetStreamIDs(1, &inputId, 1, &outputId);
    if (ids != E_NOTIMPL) Require(ids, "ERR_DECODER_STREAMS", "Cannot inspect decoder stream IDs");
    winrt::com_ptr<IMFMediaType> type;
    Require(MFCreateMediaType(type.put()), "ERR_DECODER_MEDIA_TYPE", "Cannot create H264 input media type");
    Require(type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video), "ERR_DECODER_MEDIA_TYPE", "Cannot set video major type");
    Require(type->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_H264), "ERR_DECODER_MEDIA_TYPE", "Cannot select Annex B H264");
    Require(MFSetAttributeSize(type.get(), MF_MT_FRAME_SIZE, config.width, config.height), "ERR_DECODER_MEDIA_TYPE", "Cannot set visible geometry");
    Require(MFSetAttributeRatio(type.get(), MF_MT_FRAME_RATE, config.fps, 1), "ERR_DECODER_MEDIA_TYPE", "Cannot set requested frame rate");
    Require(MFSetAttributeRatio(type.get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1), "ERR_DECODER_MEDIA_TYPE", "Cannot set square pixels");
    Require(type->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive), "ERR_DECODER_MEDIA_TYPE", "Cannot set progressive scan");
    Require(type->SetUINT32(MF_MT_AVG_BITRATE, config.bitrateBps), "ERR_DECODER_MEDIA_TYPE", "Cannot set input bitrate");
    Require(type->SetUINT32(MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709), "ERR_DECODER_MEDIA_TYPE", "Cannot declare input BT.709 primaries");
    Require(type->SetUINT32(MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709), "ERR_DECODER_MEDIA_TYPE", "Cannot declare input BT.709 transfer");
    Require(type->SetUINT32(MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709), "ERR_DECODER_MEDIA_TYPE", "Cannot declare input BT.709 matrix");
    Require(type->SetUINT32(MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235), "ERR_DECODER_MEDIA_TYPE", "Cannot declare limited-range input");
    Applied(transform->SetInputType(inputId, type.get(), 0), "ERR_DECODER_INPUT_TYPE", "Inbox MFT rejected H264 input");
    ConfigureOutput(true);
    auto codec = transform.try_as<ICodecAPI>();
    if (!codec) Fail("ERR_DECODER_LOW_LATENCY", "The inbox decoder did not expose CodecAPI.");
    VARIANT latency;
    VariantInit(&latency);
    // Microsoft's H264 decoder uses VT_UI4 here, unlike the encoder's VT_BOOL.
    latency.vt = VT_UI4;
    latency.ulVal = 1;
    Applied(codec->SetValue(&CODECAPI_AVLowLatencyMode, &latency),
            "ERR_DECODER_LOW_LATENCY", "Decoder rejected real-time low-latency mode");
    VARIANT observed;
    VariantInit(&observed);
    const auto read = codec->GetValue(&CODECAPI_AVLowLatencyMode, &observed);
    const bool enabled = read == S_OK && observed.vt == VT_UI4 && observed.ulVal != 0;
    VariantClear(&observed);
    Applied(read, "ERR_DECODER_LOW_LATENCY", "Cannot confirm the decoder low-latency setting");
    if (!enabled) Fail("ERR_DECODER_LOW_LATENCY", "Decoder did not retain real-time low-latency mode");
    stats.lowLatencyConfigured = true;
    Applied(transform->ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0), "ERR_DECODER_START", "Decoder rejected begin-streaming");
    Applied(transform->ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0), "ERR_DECODER_START", "Decoder rejected start-of-stream");
    streaming = true;
  }

  void Initialize() {
    if (!sink || !accepted || !retained || config.width < 16 || config.height < 16 ||
        config.width > 4096 || config.height > 4096 || ((config.width | config.height) & 1) ||
        !config.fps || config.fps > 240 || config.bitrateBps < 64000 || config.bitrateBps > 240000000 ||
        config.maxInFlight < 2 || config.maxInFlight > 16 || config.maxPendingPackets < 2 || config.maxPendingPackets > 128) {
      Fail("ERR_DECODER_CONFIGURATION", "Invalid bounded native decoder configuration");
    }
    if (!config.profileLevelId.empty()) {
      const auto hint = ParseProfileLevelId(config.profileLevelId);
      ValidateDxvaProfile(hint);
      if (hint.levelIdc < RequiredH264Level(config.width, config.height, config.fps, config.bitrateBps)) {
        Fail("ERR_DECODER_LEVEL", "Declared H264 level cannot describe the requested geometry/rate/bitrate");
      }
    }
    InitializeDevice();
    mfModule = LoadLibraryExW(L"mfplat.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
    if (!mfModule) Fail("ERR_DECODER_MF_PLATFORM", "Media Foundation / Media Feature Pack is unavailable", HRESULT_FROM_WIN32(GetLastError()));
    Require(MFStartup(MF_VERSION, MFSTARTUP_FULL), "ERR_DECODER_MF_STARTUP", "Media Foundation startup failed");
    mfStarted = true;
    ActivateInboxDecoder();
    stats.state = "running";
  }

  void ConfigureOutput(bool allowDeferred) {
    for (DWORD i = 0; i < 64; ++i) {
      winrt::com_ptr<IMFMediaType> type;
      const auto hr = transform->GetOutputAvailableType(outputId, i, type.put());
      if (allowDeferred && i == 0 && hr == MF_E_TRANSFORM_TYPE_NOT_SET) return;
      if (hr == MF_E_NO_MORE_TYPES) break;
      Require(hr, "ERR_DECODER_OUTPUT_TYPE", "Cannot inspect decoder output formats");
      GUID subtype{};
      Require(type->GetGUID(MF_MT_SUBTYPE, &subtype), "ERR_DECODER_OUTPUT_TYPE", "Decoder omitted output subtype");
      if (subtype != MFVideoFormat_NV12) continue;
      Applied(transform->SetOutputType(outputId, type.get(), 0), "ERR_DECODER_OUTPUT_TYPE", "Decoder rejected GPU NV12 output");
      Require(transform->GetOutputStreamInfo(outputId, &outputInfo), "ERR_DECODER_OUTPUT_INFO", "Cannot inspect decoder allocation requirements");
      if (!(outputInfo.dwFlags & (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES | MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES))) {
        if (!allowDeferred) {
          Fail("ERR_DECODER_CPU_OUTPUT_REQUEST", "Decoder requested caller-allocated output; no CPU allocation/upload fallback is permitted");
        }
      }
      stats.outputTypeConfigured = true;
      return;
    }
    Fail("ERR_DECODER_NV12_OUTPUT", "Inbox decoder did not offer NV12 output");
  }

  void CheckSps() {
    const auto& sps = bitstream.Sps();
    ValidateDxvaProfile(sps);
    if (!config.profileLevelId.empty() && sps.ProfileLevelId() != ParseProfileLevelId(config.profileLevelId).ProfileLevelId()) {
      Fail("ERR_DECODER_PROFILE_CHANGED", "Actual SPS does not match the declared profileLevelId");
    }
    if (stats.spsVerified && (sps.ProfileLevelId() != stats.sps.ProfileLevelId() ||
        sps.codedWidth != stats.sps.codedWidth || sps.codedHeight != stats.sps.codedHeight ||
        sps.cropLeft != stats.sps.cropLeft || sps.cropTop != stats.sps.cropTop)) {
      Fail("ERR_DECODER_CONFIGURATION_CHANGED", "SPS profile/coded geometry/crop changed; create a new decoder session");
    }
    if ((sps.fullRange && *sps.fullRange) ||
        (sps.colorPrimaries && *sps.colorPrimaries != 1 && *sps.colorPrimaries != 2) ||
        (sps.transferCharacteristics && *sps.transferCharacteristics != 1 && *sps.transferCharacteristics != 2) ||
        (sps.matrixCoefficients && *sps.matrixCoefficients != 1 && *sps.matrixCoefficients != 2)) {
      Fail("ERR_DECODER_COLOR_SPACE", "This qualifier requires limited-range BT.709, not hidden color conversion");
    }
    CheckCaps(sps.codedWidth, sps.codedHeight);
    stats.sps = sps;
    stats.spsVerified = true;
  }

  void Enqueue(std::uint64_t requestId, EncodedPacket packet) {
    if (flushing || stopping || shutdown) throw DecoderError("ERR_DECODER_STOPPED", "Decoder is draining or stopped");
    if (queue.size() >= config.maxPendingPackets || packet.data.size() > maxQueueBytes - stats.pendingBytes) {
      ++stats.droppedInput;
      Fail("ERR_DECODER_INPUT_QUEUE", "Compressed input queue overflow; predictive input cannot be silently discarded");
    }
    if (packet.data.empty() || packet.data.size() > maxPacketBytes || packet.timestampUs < 0 ||
        packet.timestampUs > 9007199254740991ll || packet.durationUs <= 0 || packet.durationUs > 1000000 ||
        packet.timestampUs <= lastQueuedUs) {
      Fail("ERR_DECODER_PACKET", "Invalid bounded input packet or non-increasing capture timestamp");
    }
    if (packet.data.size() < 4 || packet.data[0] || packet.data[1] ||
        (packet.data[2] != 1 && (packet.data[2] || packet.data[3] != 1))) {
      Fail("ERR_DECODER_ANNEX_B", "Decoder input must be an Annex B access unit");
    }
    H264AccessUnit parsed;
    try { parsed = bitstream.Convert(packet.data); }
    catch (const std::exception& error) { Fail("ERR_DECODER_H264", error.what()); }
    if (!parsed.hasPicture || parsed.keyFrame != packet.keyFrame || (requireIdr && !parsed.keyFrame)) {
      Fail("ERR_DECODER_PACKET_IDENTITY", "Packet must represent a real complete picture and correctly label its IDR");
    }
    CheckSps();
    requireIdr = false;
    if (epochUs < 0) epochUs = packet.timestampUs;
    const auto pts = (packet.timestampUs - epochUs) * 10;
    lastQueuedUs = packet.timestampUs;
    if (queue.empty() && submitted.empty() && copies.empty()) lastProgress = Clock::now();
    stats.pendingBytes += packet.data.size();
    stats.inputBytes += packet.data.size();
    ++stats.accepted;
    queue.push_back({requestId, std::move(packet), nullptr, pts, {}});
    queue.back().timing.enqueuedAt = Clock::now();
    stats.pendingPackets = queue.size();
    SetEvent(wake.Get());
  }

  void PrepareInput(QueuedInput& input) {
    if (input.sample) return;
    Require(MFCreateSample(input.sample.put()), "ERR_DECODER_INPUT_SAMPLE", "Cannot allocate compressed input sample");
    winrt::com_ptr<IMFMediaBuffer> buffer;
    Require(MFCreateMemoryBuffer(static_cast<DWORD>(input.packet.data.size()), buffer.put()),
            "ERR_DECODER_INPUT_SAMPLE", "Cannot allocate bounded compressed input");
    BYTE* bytes = nullptr;
    Require(buffer->Lock(&bytes, nullptr, nullptr), "ERR_DECODER_INPUT_SAMPLE", "Cannot access compressed input buffer");
    std::memcpy(bytes, input.packet.data.data(), input.packet.data.size());
    Require(buffer->Unlock(), "ERR_DECODER_INPUT_SAMPLE", "Cannot unlock compressed input");
    Require(buffer->SetCurrentLength(static_cast<DWORD>(input.packet.data.size())), "ERR_DECODER_INPUT_SAMPLE", "Cannot set compressed input length");
    Require(input.sample->AddBuffer(buffer.get()), "ERR_DECODER_INPUT_SAMPLE", "Cannot attach compressed input");
    Require(input.sample->SetSampleTime(input.pts), "ERR_DECODER_TIMESTAMP", "Cannot assign capture PTS");
    Require(input.sample->SetSampleDuration(input.packet.durationUs * 10), "ERR_DECODER_TIMESTAMP", "Cannot assign capture duration");
    Require(input.sample->SetUINT32(MFSampleExtension_CleanPoint, input.packet.keyFrame),
            "ERR_DECODER_INPUT_SAMPLE", "Cannot set IDR sample metadata");
  }

  DecodedColorSpace ReadColor(IMFMediaType* type) {
    DecodedColorSpace color;
    if (stats.sps.colorPrimaries && *stats.sps.colorPrimaries == 1 &&
        stats.sps.transferCharacteristics && *stats.sps.transferCharacteristics == 1 &&
        stats.sps.matrixCoefficients && *stats.sps.matrixCoefficients == 1) color.source = "sps";
    const std::pair<const GUID*, UINT32> expected[] = {
        {&MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709},
        {&MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709},
        {&MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709},
        {&MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235}};
    bool specified = true;
    for (const auto& [key, value] : expected) {
      UINT32 actual = 0;
      const auto hr = type->GetUINT32(*key, &actual);
      if (hr == MF_E_ATTRIBUTENOTFOUND || (hr == S_OK && actual == 0)) { specified = false; continue; }
      Require(hr, "ERR_DECODER_COLOR_SPACE", "Cannot inspect decoded color metadata");
      if (actual != value) Fail("ERR_DECODER_COLOR_SPACE", "Decoded media type contradicted limited-range BT.709 input");
    }
    if (color.source != "sps" && specified) color.source = "media-type";
    return color;
  }

  void CopyOutput(winrt::com_ptr<IMFSample> sample, Clock::time_point outputAt) {
    LONGLONG pts = 0;
    Require(sample->GetSampleTime(&pts), "ERR_DECODER_OUTPUT_TIMESTAMP", "Decoded sample omitted PTS");
    const auto input = submitted.find(pts);
    if (input == submitted.end()) Fail("ERR_DECODER_OUTPUT_IDENTITY", "Decoded frame does not match one submitted AU");
    stats.scheduling.acceptedToOutputSample.Observe(input->second.submittedAt, outputAt);
    DWORD buffers = 0;
    Require(sample->GetBufferCount(&buffers), "ERR_DECODER_OUTPUT_BUFFER", "Cannot inspect decoded output buffers");
    if (buffers != 1) Fail("ERR_DECODER_OUTPUT_BUFFER", "Exactly one DXGI output buffer is required");
    winrt::com_ptr<IMFMediaBuffer> buffer;
    Require(sample->GetBufferByIndex(0, buffer.put()), "ERR_DECODER_OUTPUT_BUFFER", "Cannot get decoded output buffer");
    auto dxgi = buffer.try_as<IMFDXGIBuffer>();
    if (!dxgi) Fail("ERR_DECODER_CPU_OUTPUT", "Decoder produced CPU pixels; CPU upload fallback is prohibited");
    winrt::com_ptr<ID3D11Texture2D> source;
    Require(dxgi->GetResource(__uuidof(ID3D11Texture2D), source.put_void()), "ERR_DECODER_DXGI_RESOURCE", "Output is not a real D3D11 texture");
    UINT subresource = 0;
    Require(dxgi->GetSubresourceIndex(&subresource), "ERR_DECODER_SUBRESOURCE", "Cannot get actual decoder array slice");
    D3D11_TEXTURE2D_DESC desc{};
    source->GetDesc(&desc);
    if (desc.Format != DXGI_FORMAT_NV12 || desc.Usage != D3D11_USAGE_DEFAULT || desc.CPUAccessFlags ||
        desc.MipLevels != 1 || desc.SampleDesc.Count != 1 || subresource >= desc.ArraySize ||
        desc.Width < stats.sps.cropLeft + config.width || desc.Height < stats.sps.cropTop + config.height ||
        desc.Width > 8192 || desc.Height > 8192 || ((desc.Width | desc.Height) & 1) ||
        static_cast<std::uint64_t>(desc.Width) * desc.Height * 3 / 2 * config.maxInFlight > 256ull * 1024 * 1024) {
      Fail("ERR_DECODER_DXGI_LAYOUT", "Decoded NV12 GPU surface/subresource has invalid geometry, usage or bounds");
    }
    winrt::com_ptr<ID3D11Device> sourceDevice;
    source->GetDevice(sourceDevice.put());
    if (sourceDevice.as<IUnknown>().get() != device.as<IUnknown>().get()) {
      Fail("ERR_DECODER_WRONG_DEVICE", "Decoded surface is not on the configured D3D11 device");
    }
    winrt::com_ptr<IMFMediaType> type;
    Require(transform->GetOutputCurrentType(outputId, type.put()), "ERR_DECODER_OUTPUT_TYPE", "Cannot inspect decoded media type");
    UINT32 w = 0, h = 0;
    Require(MFGetAttributeSize(type.get(), MF_MT_FRAME_SIZE, &w, &h), "ERR_DECODER_GEOMETRY", "Decoded output omitted geometry");
    if (!((w == config.width && h == config.height) || (w == stats.sps.codedWidth && h == stats.sps.codedHeight))) {
      Fail("ERR_DECODER_GEOMETRY", "Decoded media geometry differs from SPS visible/coded geometry");
    }
    for (const auto* aperture : {&MF_MT_MINIMUM_DISPLAY_APERTURE, &MF_MT_GEOMETRIC_APERTURE}) {
      MFVideoArea area{};
      UINT32 bytes = 0;
      const auto hr = type->GetBlob(*aperture, reinterpret_cast<UINT8*>(&area), sizeof(area), &bytes);
      if (hr == MF_E_ATTRIBUTENOTFOUND) continue;
      Require(hr, "ERR_DECODER_APERTURE", "Cannot inspect decoder display aperture");
      if (bytes != sizeof(area) || area.OffsetX.fract || area.OffsetY.fract ||
          area.OffsetX.value < 0 || area.OffsetY.value < 0 || area.Area.cx <= 0 || area.Area.cy <= 0) {
        Fail("ERR_DECODER_APERTURE", "Decoded aperture is invalid or fractional");
      }
      const auto x = static_cast<UINT>(area.OffsetX.value), y = static_cast<UINT>(area.OffsetY.value);
      const auto width = static_cast<UINT>(area.Area.cx), height = static_cast<UINT>(area.Area.cy);
      const bool containsVisible = x <= stats.sps.cropLeft && y <= stats.sps.cropTop &&
          width <= desc.Width && x <= desc.Width - width && height <= desc.Height && y <= desc.Height - height &&
          x + width >= stats.sps.cropLeft + config.width && y + height >= stats.sps.cropTop + config.height;
      const bool exactVisible = x == stats.sps.cropLeft && y == stats.sps.cropTop &&
          width == config.width && height == config.height;
      // Geometric aperture may contain coded padding; minimum display aperture
      // is the actual crop. Both must be consistent with the real SPS/texture.
      if (!containsVisible || (*aperture == MF_MT_MINIMUM_DISPLAY_APERTURE && !exactVisible)) {
        Fail("ERR_DECODER_APERTURE", "Decoded aperture contradicts the actual progressive SPS crop");
      }
    }
    auto frame = std::make_shared<GpuDecodedFrame>();
    frame->frameId = nextDecodedFrameId.fetch_add(1);
    if (frame->frameId > 9007199254740991ull) Fail("ERR_DECODER_FRAME_ID", "Decoded frame IDs exhausted safe integers");
    frame->timestampUs = input->second.timestampUs;
    frame->durationUs = input->second.durationUs;
    frame->codedWidth = desc.Width;
    frame->codedHeight = desc.Height;
    frame->visibleRect = {stats.sps.cropLeft, stats.sps.cropTop, config.width, config.height};
    frame->colorSpace = ReadColor(type.get());
    frame->originalSubresource = subresource;
    frame->readyFence = fence;
    frame->readyValue = nextFenceValue++;
    desc.ArraySize = 1;
    desc.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
    desc.MiscFlags = 0;
    Require(device->CreateTexture2D(&desc, nullptr, frame->texture.put()),
            "ERR_DECODER_PRIVATE_TEXTURE", "Cannot allocate bounded immutable private NV12 output");
    // The original IMFSample, not merely its texture, prevents allocator slice reuse.
    copies.push_back({std::move(sample), frame, Clock::now(), input->second.submittedAt});
    submitted.erase(input);
    context->CopySubresourceRegion(frame->texture.get(), 0, 0, 0, 0, source.get(), subresource, nullptr);
    const auto signal = context->Signal(fence.get(), frame->readyValue);
    context->Flush();
    ++stats.outputSamples;
    ++stats.gpuCopies;
    stats.pendingGpuCopies = copies.size();
    stats.peakGpuCopies = std::max(stats.peakGpuCopies, stats.pendingGpuCopies);
    Require(signal, "ERR_DECODER_COPY_FENCE", "Cannot fence the decoder surface read");
    stats.gpuOutputValidated = true;
  }

  bool CanOutput() {
    // Empty-output/drain probes need no new texture. CopyOutput rejects an
    // unexpected picture without a submitted AU before allocating its backing.
    ++stats.scheduling.outputCapacityChecks;
    const bool available = submitted.empty() || retained() + copies.size() < config.maxInFlight;
    if (!available) ++stats.scheduling.outputCapacityDeferrals;
    return available;
  }

  bool Output() {
    if (!CanOutput()) return false;
    for (unsigned attempt = 0; attempt < 3; ++attempt) {
      MFT_OUTPUT_DATA_BUFFER output{};
      output.dwStreamID = outputId;
      DWORD status = 0;
      const auto hr = MeasureEncoderCall(stats.scheduling.processOutput, [&] {
        return transform->ProcessOutput(0, 1, &output, &status);
      });
      const auto outputAt = Clock::now();
      winrt::com_ptr<IMFSample> sample;
      sample.attach(output.pSample);
      if (output.pEvents) output.pEvents->Release();
      if (hr == MF_E_TRANSFORM_STREAM_CHANGE) {
        ConfigureOutput(false);
        ++stats.streamChanges;
        continue;
      }
      if (hr == MF_E_TRANSFORM_NEED_MORE_INPUT) {
        ++stats.needMoreInput;
        outputAvailable = false;
        if (drainSent) drainComplete = true;
        return false;
      }
      if (hr != S_OK) ++stats.scheduling.processOutputOtherHresults;
      Require(hr, "ERR_DECODER_PROCESS_OUTPUT", "Synchronous decoder ProcessOutput failed");
      if (!sample || (output.dwStatus & MFT_OUTPUT_DATA_BUFFER_NO_SAMPLE) == MFT_OUTPUT_DATA_BUFFER_NO_SAMPLE) {
        Fail("ERR_DECODER_EMPTY_OUTPUT", "Decoder returned success without a real output sample");
      }
      MeasureEncoderCall(stats.scheduling.copyOutput, [&] {
        CopyOutput(std::move(sample), outputAt);
      });
      lastProgress = Clock::now();
      return true;
    }
    Fail("ERR_DECODER_STREAM_CHANGE", "Repeated stream changes prevented decoded output");
  }

  void RetireCopies() {
    if (copies.empty()) return;
    if (!deviceLost) {
      const auto completed = fence->GetCompletedValue();
      if (completed == UINT64_MAX) {
        deviceLost = true;
        Fail("ERR_DECODER_DEVICE_LOST", "Decoder copy fence reported device loss");
      }
      if (armedFence && completed >= armedFence) armedFence = 0;
      while (!copies.empty() && copies.front().frame->readyValue <= completed) {
        auto copy = std::move(copies.front());
        copies.pop_front();
        copy.originalSample = nullptr;
        ++stats.sampleReturns;
        ++stats.gpuCopiesCompleted;
        const auto now = Clock::now();
        const auto hold = Milliseconds(now - copy.copyAt);
        stats.totalGpuHoldMs += hold;
        stats.maxGpuHoldMs = std::max(stats.maxGpuHoldMs, hold);
        if (!aborting) {
          const auto latency = Milliseconds(now - copy.inputAt);
          stats.totalDecodeLatencyMs += latency;
          stats.maxDecodeLatencyMs = std::max(stats.maxDecodeLatencyMs, latency);
          ++stats.gpuFrames;
          if (stats.firstTimestampUs < 0) stats.firstTimestampUs = copy.frame->timestampUs;
          stats.lastTimestampUs = copy.frame->timestampUs;
          if (!MeasureEncoderCall(stats.scheduling.frameSink, [&] {
                return sink(std::move(copy.frame));
              })) Fail("ERR_DECODER_FRAME_QUEUE", "Cannot publish a real GPU output lease");
        } else {
          ++stats.discardedGpuFrames;
        }
        lastProgress = now;
      }
      if (!copies.empty() && armedFence != copies.front().frame->readyValue) {
        armedFence = copies.front().frame->readyValue;
        Require(fence->SetEventOnCompletion(armedFence, wake.Get()), "ERR_DECODER_FENCE_EVENT", "Cannot await decoded copy completion");
      }
    } else {
      stats.sampleReturns += copies.size();
      stats.discardedGpuFrames += copies.size();
      stats.abandonedGpuCopies += copies.size();
      copies.clear();
    }
    stats.pendingGpuCopies = copies.size();
  }

  void EndPlatform() {
    if (activation) {
      auto owner = std::move(activation);
      const auto end = transform->ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
      const auto close = owner->ShutdownObject();
      transform = nullptr;
      streaming = false;
      shutdown = true;
      Require(end, "ERR_DECODER_END_STREAMING", "Decoder end-streaming failed");
      Require(close, "ERR_DECODER_SHUTDOWN", "Decoder activation shutdown failed");
    }
    if (!copies.empty()) return;
    manager = nullptr;
    if (mfStarted) {
      const auto hr = MFShutdown();
      mfStarted = false;
      Require(hr, "ERR_DECODER_MF_SHUTDOWN", "Decoder MF shutdown failed");
    }
    shutdown = true;
    completionValidated = true;
    stats.state = stats.errors ? "error" : "stopped";
  }

  void Pump() {
    if (completionValidated) return;
    if (!deviceLost) {
      try { CheckDevice(); }
      catch (const DecoderError&) { if (!aborting) throw; }
    }
    RetireCopies();
    if (aborting) {
      if (copies.empty()) EndPlatform();
      return;
    }
    unsigned operations = 0;
    while (++operations <= 64) {
      if (outputAvailable) {
        if (!CanOutput()) break;
        if (Output()) continue;
      }
      if (!queue.empty() && submitted.size() < config.maxInFlight + 16) {
        auto& input = queue.front();
        PrepareInput(input);
        input.timing.BeforeProcessInput(stats.scheduling, Clock::now());
        const auto hr = MeasureEncoderCall(stats.scheduling.processInput, [&] {
          return transform->ProcessInput(inputId, input.sample.get(), 0);
        });
        if (hr == MF_E_NOTACCEPTING) {
          ++stats.notAccepting;
          outputAvailable = true;
          if (!CanOutput() || !Output()) break;
          continue;  // Keep and retry this exact sample, never discard or replace it.
        }
        if (hr != S_OK) ++stats.scheduling.processInputOtherHresults;
        Applied(hr, "ERR_DECODER_PROCESS_INPUT", "Decoder rejected the real H264 access unit");
        const auto request = input.requestId;
        const auto submittedAt = Clock::now();
        submitted.emplace(input.pts, SubmittedInput{input.packet.timestampUs, input.packet.durationUs, submittedAt});
        input.timing.Accepted(stats.scheduling, submittedAt);
        stats.pendingBytes -= input.packet.data.size();
        queue.pop_front();
        ++stats.submitted;
        stats.pendingPackets = queue.size();
        stats.awaitingOutput = submitted.size();
        stats.peakAwaitingOutput = std::max(stats.peakAwaitingOutput, stats.awaitingOutput);
        MeasureEncoderCall(stats.scheduling.acceptedCallback, [&] { accepted(request); });
        outputAvailable = true;
        lastProgress = Clock::now();
        continue;
      }
      if ((flushing || stopping) && queue.empty() && !drainSent) {
        Applied(transform->ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, inputId), "ERR_DECODER_DRAIN", "Decoder rejected end-of-stream");
        Applied(transform->ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0), "ERR_DECODER_DRAIN", "Decoder rejected real drain");
        drainSent = true;
        outputAvailable = true;
        continue;
      }
      break;
    }
    if (operations > 64) {
      ++stats.scheduling.pumpBudgetYields;
      SetEvent(wake.Get());
    }
    RetireCopies();
    stats.awaitingOutput = submitted.size();
    if (drainComplete && copies.empty()) {
      if (!submitted.empty()) {
        stats.droppedAfterSubmit += submitted.size();
        submitted.clear();
        Fail("ERR_DECODER_DRAIN_LOSS", "Decoder drain omitted frames for submitted access units");
      }
      if (stopping) {
        EndPlatform();
      } else {
        Applied(transform->ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0), "ERR_DECODER_FLUSH", "Decoder rejected post-drain reset");
        Applied(transform->ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0), "ERR_DECODER_FLUSH", "Decoder rejected restart after drain");
        flushing = false;
        drainSent = false;
        drainComplete = false;
        flushCompleted = true;
        requireIdr = true;
        ++stats.flushes;
        stats.state = "running";
      }
    } else if ((!queue.empty() || !submitted.empty() || !copies.empty() || flushing || stopping) &&
               Clock::now() - lastProgress > progressTimeout) {
      Fail("ERR_DECODER_PROGRESS_TIMEOUT", "Decoder/readers did not make progress; release output leases while draining");
    }
  }

  void Abort() {
    if (aborting) return;
    aborting = true;
    stopping = true;
    stats.state = "error";
    stats.droppedInput += queue.size();
    stats.droppedAfterSubmit += submitted.size();
    queue.clear();
    submitted.clear();
    stats.pendingPackets = stats.pendingBytes = stats.awaitingOutput = 0;
    // Retain all original output samples until our submitted reads complete.
    // Re-signal once so a failure after CopySubresourceRegion cannot lose its retirement fence.
    if (!copies.empty() && !deviceLost) {
      const auto hr = context->Signal(fence.get(), copies.back().frame->readyValue);
      context->Flush();
      Require(hr, "ERR_DECODER_ABORT_FENCE", "Cannot fence decoder reads while aborting");
    }
    EndPlatform();
  }

  void WaitFence(std::uint64_t value) {
    Require(fence->SetEventOnCompletion(value, wake.Get()), "ERR_DECODER_FENCE_EVENT", "Cannot await explicit readback GPU completion");
    const auto start = Clock::now();
    for (;;) {
      CheckDevice();
      const auto completed = fence->GetCompletedValue();
      if (completed == UINT64_MAX) { deviceLost = true; Fail("ERR_DECODER_DEVICE_LOST", "Readback fence reported device loss"); }
      if (completed >= value) return;
      const auto wait = WaitForSingleObject(wake.Get(), 1000);
      if (wait != WAIT_OBJECT_0 && wait != WAIT_TIMEOUT) Fail("ERR_DECODER_WAIT", "Explicit GPU readback wait failed", HRESULT_FROM_WIN32(GetLastError()));
      if (Clock::now() - start > progressTimeout) Fail("ERR_DECODER_GPU_TIMEOUT", "Explicit diagnostic/readback GPU work timed out");
    }
  }

  void ValidateFrame(const std::shared_ptr<const GpuDecodedFrame>& frame) {
    const auto completed = fence->GetCompletedValue();
    if (completed == UINT64_MAX) {
      deviceLost = true;
      Fail("ERR_DECODER_DEVICE_LOST", "Retained-frame fence reported device loss");
    }
    if (!frame || !frame->texture || !frame->readyFence || frame->readyFence.get() != fence.get() ||
        frame->readyValue > completed) {
      throw DecoderError("ERR_DECODER_FRAME", "A completed immutable frame owned by this decoder is required");
    }
    CheckDevice();
  }

  void InitializeInspection() {
    if (inspectTarget) return;
    constexpr const char* source = R"(
cbuffer Crop : register(b0) { float4 crop; };
Texture2D<float> luma : register(t0);
SamplerState sampleLuma : register(s0);
struct Vertex { float4 position : SV_Position; float2 uv : TEXCOORD0; };
Vertex VS(uint id : SV_VertexID) {
  Vertex result;
  result.uv = float2((id << 1) & 2, id & 2);
  result.position = float4(result.uv * float2(2, -2) + float2(-1, 1), 0, 1);
  return result;
}
float PS(Vertex input) : SV_Target {
  return luma.SampleLevel(sampleLuma, crop.xy + input.uv * crop.zw, 0);
})";
    auto vs = Compile(source, "VS", "vs_5_0");
    auto ps = Compile(source, "PS", "ps_5_0");
    Require(device->CreateVertexShader(vs->GetBufferPointer(), vs->GetBufferSize(), nullptr, inspectVertex.put()), "ERR_DECODER_INSPECTION_SHADER", "Cannot create diagnostic vertex shader");
    Require(device->CreatePixelShader(ps->GetBufferPointer(), ps->GetBufferSize(), nullptr, inspectPixel.put()), "ERR_DECODER_INSPECTION_SHADER", "Cannot create diagnostic luma shader");
    D3D11_SAMPLER_DESC sampler{};
    sampler.Filter = D3D11_FILTER_MIN_MAG_MIP_LINEAR;
    sampler.AddressU = sampler.AddressV = sampler.AddressW = D3D11_TEXTURE_ADDRESS_CLAMP;
    sampler.ComparisonFunc = D3D11_COMPARISON_NEVER;
    sampler.MaxLOD = D3D11_FLOAT32_MAX;
    Require(device->CreateSamplerState(&sampler, inspectSampler.put()), "ERR_DECODER_INSPECTION", "Cannot create diagnostic sampler");
    D3D11_RASTERIZER_DESC raster{};
    raster.FillMode = D3D11_FILL_SOLID;
    raster.CullMode = D3D11_CULL_NONE;
    raster.DepthClipEnable = TRUE;
    Require(device->CreateRasterizerState(&raster, inspectRasterizer.put()), "ERR_DECODER_INSPECTION", "Cannot create diagnostic rasterizer");
    D3D11_BUFFER_DESC constant{};
    constant.ByteWidth = 16;
    constant.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
    Require(device->CreateBuffer(&constant, nullptr, inspectConstants.put()), "ERR_DECODER_INSPECTION", "Cannot create diagnostic crop constants");
    D3D11_TEXTURE2D_DESC desc{};
    desc.Width = FrameInspection::width;
    desc.Height = FrameInspection::height;
    desc.MipLevels = desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_R8_UNORM;
    desc.SampleDesc.Count = 1;
    desc.BindFlags = D3D11_BIND_RENDER_TARGET;
    Require(device->CreateTexture2D(&desc, nullptr, inspectTarget.put()), "ERR_DECODER_INSPECTION", "Cannot allocate small diagnostic target");
    Require(device->CreateRenderTargetView(inspectTarget.get(), nullptr, inspectRtv.put()), "ERR_DECODER_INSPECTION", "Cannot create small diagnostic RTV");
    desc.BindFlags = 0;
    desc.Usage = D3D11_USAGE_STAGING;
    desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    Require(device->CreateTexture2D(&desc, nullptr, inspectReadback.put()), "ERR_DECODER_INSPECTION", "Cannot allocate 24x24 diagnostic readback");
  }

  FrameInspection Inspect(const std::shared_ptr<const GpuDecodedFrame>& frame) {
    ValidateFrame(frame);
    InitializeInspection();
    auto device3 = device.as<ID3D11Device3>();
    D3D11_SHADER_RESOURCE_VIEW_DESC1 desc{};
    desc.Format = DXGI_FORMAT_R8_UNORM;
    desc.ViewDimension = D3D11_SRV_DIMENSION_TEXTURE2D;
    desc.Texture2D.MipLevels = 1;
    desc.Texture2D.PlaneSlice = 0;
    winrt::com_ptr<ID3D11ShaderResourceView1> luma;
    Require(device3->CreateShaderResourceView1(frame->texture.get(), &desc, luma.put()), "ERR_DECODER_INSPECTION", "Cannot read private NV12 luma plane on GPU");
    const float crop[]{
        static_cast<float>(frame->visibleRect.x) / frame->codedWidth,
        static_cast<float>(frame->visibleRect.y) / frame->codedHeight,
        static_cast<float>(frame->visibleRect.width) / frame->codedWidth,
        static_cast<float>(frame->visibleRect.height) / frame->codedHeight};
    context->UpdateSubresource(inspectConstants.get(), 0, nullptr, crop, 0, 0);
    auto constants = inspectConstants.get();
    auto sampler = inspectSampler.get();
    ID3D11ShaderResourceView* view = luma.get();
    auto target = inspectRtv.get();
    const D3D11_VIEWPORT viewport{0, 0, 24, 24, 0, 1};
    context->IASetInputLayout(nullptr);
    context->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    context->VSSetShader(inspectVertex.get(), nullptr, 0);
    context->PSSetShader(inspectPixel.get(), nullptr, 0);
    context->PSSetConstantBuffers(0, 1, &constants);
    context->PSSetSamplers(0, 1, &sampler);
    context->PSSetShaderResources(0, 1, &view);
    context->RSSetState(inspectRasterizer.get());
    context->RSSetViewports(1, &viewport);
    context->OMSetBlendState(nullptr, nullptr, UINT_MAX);
    context->OMSetDepthStencilState(nullptr, 0);
    context->OMSetRenderTargets(1, &target, nullptr);
    context->Draw(3, 0);
    ID3D11ShaderResourceView* empty = nullptr;
    context->PSSetShaderResources(0, 1, &empty);
    context->OMSetRenderTargets(0, nullptr, nullptr);
    context->CopyResource(inspectReadback.get(), inspectTarget.get());
    const auto value = nextFenceValue++;
    Require(context->Signal(fence.get(), value), "ERR_DECODER_INSPECTION_FENCE", "Cannot fence diagnostic GPU reduction");
    context->Flush();
    WaitFence(value);
    D3D11_MAPPED_SUBRESOURCE mapped{};
    Require(context->Map(inspectReadback.get(), 0, D3D11_MAP_READ, D3D11_MAP_FLAG_DO_NOT_WAIT, &mapped),
            "ERR_DECODER_INSPECTION_MAP", "Cannot read completed 24x24 diagnostic image");
    FrameInspection result;
    try {
      if (!mapped.pData) throw DecoderError("ERR_DECODER_INSPECTION_MAP", "Completed diagnostic mapping returned no data");
      result = InspectLuma({static_cast<const std::uint8_t*>(mapped.pData), static_cast<std::size_t>(mapped.RowPitch) * 24},
                           mapped.RowPitch);
    } catch (...) { context->Unmap(inspectReadback.get(), 0); throw; }
    context->Unmap(inspectReadback.get(), 0);
    ++stats.diagnosticReadbacks;
    stats.diagnosticReadbackBytes += 24 * 24;
    return result;
  }

  I420Image ReadI420(const std::shared_ptr<const GpuDecodedFrame>& frame) {
    ValidateFrame(frame);
    D3D11_TEXTURE2D_DESC desc{};
    frame->texture->GetDesc(&desc);
    desc.Usage = D3D11_USAGE_STAGING;
    desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    desc.BindFlags = desc.MiscFlags = 0;
    winrt::com_ptr<ID3D11Texture2D> readback;
    Require(device->CreateTexture2D(&desc, nullptr, readback.put()), "ERR_DECODER_I420", "Cannot allocate explicit I420 source readback");
    context->CopyResource(readback.get(), frame->texture.get());
    const auto value = nextFenceValue++;
    Require(context->Signal(fence.get(), value), "ERR_DECODER_I420", "Cannot fence explicit I420 readback");
    context->Flush();
    WaitFence(value);
    D3D11_MAPPED_SUBRESOURCE mapped{};
    Require(context->Map(readback.get(), 0, D3D11_MAP_READ, D3D11_MAP_FLAG_DO_NOT_WAIT, &mapped),
            "ERR_DECODER_I420", "Cannot map completed explicit NV12 readback");
    I420Image result;
    try {
      if (!mapped.pData) throw DecoderError("ERR_DECODER_I420", "Completed NV12 mapping returned no data");
      const auto size = static_cast<std::size_t>(mapped.RowPitch) * (desc.Height + desc.Height / 2);
      result = CopyNv12ToI420({static_cast<const std::uint8_t*>(mapped.pData), size},
                              mapped.RowPitch, desc.Width, desc.Height, frame->visibleRect);
    } catch (...) { context->Unmap(readback.get(), 0); throw; }
    context->Unmap(readback.get(), 0);
    ++stats.i420Readbacks;
    stats.i420ReadbackBytes += result.y.size() + result.u.size() + result.v.size();
    return result;
  }
};

MfH264Decoder::MfH264Decoder(const DecoderConfig& config, FrameSink frames,
                             AcceptedSink accepted, RetainedFrames retained)
    : impl_(std::make_unique<Impl>(config, std::move(frames), std::move(accepted), std::move(retained))) {
  impl_->Initialize();
}
MfH264Decoder::~MfH264Decoder() = default;
void MfH264Decoder::Enqueue(std::uint64_t id, EncodedPacket packet) { impl_->Enqueue(id, std::move(packet)); }
void MfH264Decoder::Pump() { impl_->Pump(); }
void MfH264Decoder::BeginFlush() {
  if (impl_->stopping || impl_->shutdown) throw DecoderError("ERR_DECODER_STOPPED", "Decoder is stopped");
  if (impl_->flushing) throw DecoderError("ERR_DECODER_STATE", "Decoder cannot start this flush");
  impl_->flushing = true;
  impl_->stats.state = "draining";
  impl_->lastProgress = Clock::now();
  SetEvent(impl_->wake.Get());
}
bool MfH264Decoder::TakeFlushCompleted() { return std::exchange(impl_->flushCompleted, false); }
void MfH264Decoder::BeginStop() {
  if (impl_->stopping || impl_->shutdown) return;
  impl_->stopping = true;
  impl_->stats.state = "stopping";
  impl_->lastProgress = Clock::now();
  SetEvent(impl_->wake.Get());
}
void MfH264Decoder::Abort() { impl_->Abort(); }
bool MfH264Decoder::Finished() const { return impl_->completionValidated; }
HANDLE MfH264Decoder::WakeEvent() const { return impl_->wake.Get(); }
DecoderStats MfH264Decoder::GetStats() const { return impl_->stats; }
FrameInspection MfH264Decoder::Inspect(const std::shared_ptr<const GpuDecodedFrame>& frame) { return impl_->Inspect(frame); }
I420Image MfH264Decoder::ReadI420(const std::shared_ptr<const GpuDecodedFrame>& frame) { return impl_->ReadI420(frame); }

}  // namespace monky::screen_video
