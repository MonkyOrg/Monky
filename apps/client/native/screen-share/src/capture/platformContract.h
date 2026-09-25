#pragma once
#include "contract.h"

namespace monky::screen_capture {

struct EncoderCapability {
  EncoderKind encoder = EncoderKind::Amf;
  std::uint32_t adapterIndex = 0, vendorId = 0, deviceId = 0;
  std::uint64_t adapterLuid = 0;
  bool verified = false;
};

inline void ValidateNvencProbeEvidence(bool openedOnSelectedD3d11Device, bool h264, bool mainProfile,
                                      bool nv12, bool dynamicBitrate, std::uint32_t maximumWidth,
                                      std::uint32_t maximumHeight, const VideoConfiguration& video) {
  Require(openedOnSelectedD3d11Device && h264 && mainProfile && nv12 && dynamicBitrate &&
          maximumWidth >= video.width && maximumHeight >= video.height,
          "NVENC capability probe did not confirm H264 Main/NV12/dynamic bitrate on the selected D3D11 device",
          "ERR_SCREEN_CAPTURE_NVENC_UNAVAILABLE");
}

inline void ValidateAmfLevelCapability(std::int64_t maximum, const VideoConfiguration& video) {
  Require(maximum >= 10 && maximum <= 62, "AMF returned an invalid H264 MaxLevel capability",
          "ERR_SCREEN_CAPTURE_AMF_UNAVAILABLE");
  const auto required = RequiredCaptureH264Level(video);
  if (required > maximum)
    throw ContractError("ERR_SCREEN_CAPTURE_AMF_LEVEL_UNSUPPORTED",
        "AMF H264 requires level_idc=" + std::to_string(required) + " for " +
        std::to_string(video.width) + "x" + std::to_string(video.height) + "@" + std::to_string(video.fps) +
        "; selected adapter/runtime reports MaxLevel=" + std::to_string(maximum) +
        ". This rendition is unsupported; no lower-level or software fallback was applied.");
}

inline std::string CapabilityJson(const EncoderCapability& capability) {
  if (!capability.verified) return "null";
  Require(capability.encoder != EncoderKind::Auto && capability.adapterIndex == 0 &&
          (IsSoftware(capability.encoder) ||
          capability.vendorId == (IsNvenc(capability.encoder) ? 0x10deu : 0x1002u)),
          "Verified encoder capability has inconsistent device identity", "ERR_SCREEN_CAPTURE_DEVICE");
  return "{\"encoderId\":" + JsonString(EncoderId(capability.encoder)) +
      ",\"codec\":" + JsonString(EncoderCodec(capability.encoder)) +
      ",\"adapterIndex\":" + std::to_string(capability.adapterIndex) +
      ",\"adapterLuid\":" + JsonString(std::to_string(capability.adapterLuid)) +
      ",\"vendorId\":" + std::to_string(capability.vendorId) +
      ",\"deviceId\":" + std::to_string(capability.deviceId) +
      ",\"probe\":" + JsonString(IsSoftware(capability.encoder) ? "software-encoder" :
          IsNvenc(capability.encoder) ? "nvenc-d3d11-session" : "obs-amf-test") +
      ",\"probeVerified\":true,\"textureInput\":" + Boolean(!IsSoftware(capability.encoder)) +
      ",\"dynamicBitrate\":true}";
}

inline std::string TargetJson(const Arguments& arguments, const Common& common) {
  Require(!arguments.encoderProbe, "An encoder probe cannot serialize a selected source");
  if (arguments.kind != CaptureKind::Monitor)
    return "{\"kind\":" + JsonString(KindName(arguments.kind)) + ",\"hwnd\":" + std::to_string(common.hwnd) +
        ",\"expectedProcessId\":" + std::to_string(common.processId) +
        ",\"expectedProcessCreationTime100ns\":" + JsonString(std::to_string(common.processCreationTime100ns)) + "}";
  const auto& monitor = arguments.monitor;
  ValidateMonitorIdentity(monitor);
  const auto ascii = [](std::wstring_view text) {
    std::string result;
    result.reserve(text.size());
    for (const auto character : text) result.push_back(static_cast<char>(character));
    return result;
  };
  return "{\"kind\":\"monitor\",\"deviceId\":" + JsonString(ascii(monitor.deviceId)) +
      ",\"deviceName\":" + JsonString(ascii(monitor.deviceName)) +
      ",\"bounds\":{\"x\":" + std::to_string(monitor.x) + ",\"y\":" + std::to_string(monitor.y) +
      ",\"width\":" + std::to_string(monitor.width) + ",\"height\":" + std::to_string(monitor.height) + "}}";
}

inline std::string SerializeAdmissionFailure(const Arguments& arguments, const Common& common,
                                             std::uint64_t sequence, const Observation& observation,
                                             const Retirement& retirement, const NativeFailure& failure) {
  Require(!arguments.encoderProbe && ValidRunId(common.runId) && common.runId == arguments.runId &&
          common.helperProcessId > 0 && common.processId == arguments.processId && common.hwnd == arguments.hwnd &&
          common.processCreationTime100ns == arguments.expectedCreation &&
          common.qpc > 0 && common.qpcFrequency > 0 && sequence <= kMaxCommands,
          "Incomplete source admission ownership");
  Require(!observation.sourceAttached && observation.outputPackets == 0 && observation.outputBytes == 0 &&
          observation.obsTotalFrames == 0 && observation.state == ObservationState::Failed &&
          !failure.code.empty() && failure.code.size() <= 96 && !failure.message.empty() && failure.message.size() <= 1024,
          "Source admission failure cannot claim initialized capture");
  ValidateVideoConfiguration(arguments.video);
  const auto target = arguments.kind == CaptureKind::Window && arguments.expectedCreation == 0
      ? "{\"hwnd\":" + std::to_string(arguments.hwnd) +
          ",\"expectedProcessId\":" + std::to_string(arguments.processId) + "}"
      : TargetJson(arguments, common);
  const auto& video = arguments.video;
  return FinishLine(std::string{"{\"schemaVersion\":1,\"kind\":\"capture-admission-error\",\"type\":\"error\",\"runId\":"} +
      JsonString(common.runId) + ",\"sequence\":" + std::to_string(sequence) +
      ",\"helperProcessId\":" + std::to_string(common.helperProcessId) +
      ",\"qpc\":" + JsonString(std::to_string(common.qpc)) +
      ",\"qpcFrequency\":" + JsonString(std::to_string(common.qpcFrequency)) +
      ",\"target\":" + target +
      ",\"video\":{\"width\":" + std::to_string(video.width) + ",\"height\":" + std::to_string(video.height) +
      ",\"fps\":" + std::to_string(video.fps) + ",\"bitrateKbps\":" + std::to_string(video.bitrateKbps) +
      ",\"scaleMode\":" + JsonString(ScaleModeName(video.scaleMode)) + "}" +
      ",\"encoder\":" + JsonString(arguments.encoder == EncoderKind::Auto ? "auto" : EncoderId(arguments.encoder)) +
      ",\"captureStarted\":false,\"observation\":{\"outputPackets\":0}" +
      ",\"error\":{\"code\":" + JsonString(failure.code) + ",\"message\":" + JsonString(failure.message) + "}" +
      ",\"retirement\":" + RetirementJson(retirement));
}

inline std::string SerializePlatformEvent(const Arguments& arguments, const Common& common,
                                          const EncoderCapability& capability, std::string_view type,
                                          std::uint64_t sequence, const Observation& observation,
                                          const SourceKey& selected, const std::optional<SourceKey>& hooked,
                                          const Retirement* retirement = nullptr, const NativeFailure* failure = nullptr) {
  Require(!arguments.encoderProbe, "An encoder probe cannot emit capture events");
  const bool monitor = arguments.kind == CaptureKind::Monitor;
  Require(type == "prepared" || type == "ready" || type == "stats" || type == "stopped" || type == "error",
          "Unknown capture platform event");
  Require((type == "error") == (failure != nullptr), "Error event lacks its native failure");
  if (type == "prepared") Require(sequence == 0 && observation.state == ObservationState::Prepared &&
      !hooked && capability.verified, "Preparation requires verified hardware capability and no captured source");
  if (type == "ready" || type == "stats") Require(sequence > 0 && observation.state == ObservationState::Running &&
      capability.verified, "Running event lacks verified preparation");
  if (type == "ready") Require(observation.sourceAttached, "Ready requires an actually attached source");
  if (type == "stopped") Require(sequence > 0 && observation.state == ObservationState::Stopped &&
      retirement && RetirementComplete(*retirement), "Stopped requires complete retirement");
  if (!monitor) {
    if (hooked) ValidateHookEvidence(selected, *hooked);
    Require(!observation.sourceAttached || hooked.has_value(), "Attached window/game lacks exact hook evidence");
  } else Require(!hooked, "A monitor must not claim a window hook identity");
  auto result = CommonJson(common, type, sequence, monitor, true) +
      ",\"target\":" + TargetJson(arguments, common) +
      ",\"capability\":" + CapabilityJson(capability) +
      ",\"configuration\":" + ConfigurationJson(arguments.method, arguments.video, capability.encoder) +
      ",\"observation\":" + ObservationJson(observation, common.qpc) +
      ",\"sourceKey\":" + (monitor ? "null" : KeyJson(selected)) +
      ",\"hookedKey\":" + (hooked ? KeyJson(*hooked) : "null");
  if (failure) {
    Require(observation.state == ObservationState::Failed && retirement && !failure->code.empty() &&
            failure->code.size() <= 96 && !failure->message.empty() && failure->message.size() <= 1024,
            "Invalid platform error envelope");
    result += ",\"error\":{\"code\":" + JsonString(failure->code) + ",\"message\":" + JsonString(failure->message) + "}";
  }
  if (retirement) result += ",\"retirement\":" + RetirementJson(*retirement);
  return FinishLine(std::move(result));
}

inline void ValidateEncoderProbeIsolation(bool targetBound, bool sourceCreated, bool sceneCreated,
                                         bool livePipeCreated, bool encoderActive, bool outputActive,
                                         std::uint64_t outputPackets) {
  Require(!targetBound && !sourceCreated && !sceneCreated && !livePipeCreated &&
          !encoderActive && !outputActive && outputPackets == 0,
          "Encoder probing must not select, capture or encode a source", "ERR_SCREEN_CAPTURE_PROBE_ISOLATION");
}

inline std::string SerializeEncoderProbeEvent(const Arguments& arguments, const Common& common,
                                              const EncoderCapability& capability, std::string_view type,
                                              std::uint64_t sequence, bool sourcePlatformVerified,
                                              bool encoderInitialized, const Retirement* retirement = nullptr,
                                              const NativeFailure* failure = nullptr) {
  Require(arguments.encoderProbe && arguments.hwnd == 0 && arguments.processId == 0 &&
          arguments.expectedCreation == 0 && arguments.monitor.deviceId.empty() &&
          common.hwnd == 0 && common.processId == 0 && common.processCreationTime100ns == 0,
          "Encoder probe evidence must not contain a selected source");
  Require(ValidRunId(common.runId) && common.helperProcessId > 0 && common.qpc > 0 && common.qpcFrequency > 0 &&
          common.runId == arguments.runId && sequence <= kMaxSafeInteger, "Invalid encoder probe ownership");
  Require(type == "prepared" || type == "stopped" || type == "error", "Unknown encoder probe event");
  Require((type == "error") == (failure != nullptr), "Encoder probe error lacks its failure");
  if (type == "prepared")
    Require(sequence == 0 && sourcePlatformVerified && encoderInitialized && capability.verified && !retirement,
            "Encoder probe preparation requires an initialized hardware encoder and source platform");
  if (type == "stopped")
    Require(sequence > 0 && retirement && RetirementComplete(*retirement),
            "Encoder probe completion requires verified retirement");
  Require(!encoderInitialized || (sourcePlatformVerified && capability.verified),
          "Initialized encoder probe lacks verified capability");
  ValidateVideoConfiguration(arguments.video);
  const auto& video = arguments.video;
  auto result = std::string{"{\"schemaVersion\":1,\"kind\":\"encoder-probe\",\"type\":"} + JsonString(type) +
      ",\"runId\":" + JsonString(common.runId) + ",\"sequence\":" + std::to_string(sequence) +
      ",\"helperProcessId\":" + std::to_string(common.helperProcessId) +
      ",\"qpc\":" + JsonString(std::to_string(common.qpc)) +
      ",\"qpcFrequency\":" + JsonString(std::to_string(common.qpcFrequency)) +
      ",\"video\":{\"width\":" + std::to_string(video.width) + ",\"height\":" + std::to_string(video.height) +
      ",\"fps\":" + std::to_string(video.fps) + ",\"bitrateKbps\":" + std::to_string(video.bitrateKbps) +
      ",\"scaleMode\":" + JsonString(ScaleModeName(video.scaleMode)) + "}" +
      ",\"captureKinds\":" + (sourcePlatformVerified ? "[\"window\",\"monitor\",\"game\"]" : "[]") +
      ",\"capability\":" + CapabilityJson(capability) +
      ",\"encoderInitialized\":" + Boolean(encoderInitialized) + ",\"sourceCaptured\":false,\"outputPackets\":0";
  if (failure) {
    Require(retirement && !failure->code.empty() && failure->code.size() <= 96 &&
            !failure->message.empty() && failure->message.size() <= 1024, "Invalid encoder probe error");
    result += ",\"error\":{\"code\":" + JsonString(failure->code) + ",\"message\":" + JsonString(failure->message) + "}";
  }
  if (retirement) result += ",\"retirement\":" + RetirementJson(*retirement);
  return FinishLine(std::move(result));
}
}  // namespace monky::screen_capture
