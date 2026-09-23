#pragma once

#include "abi.h"

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <optional>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace monky::screen_capture {

constexpr std::uint64_t kMaxSafeInteger = 9007199254740991ULL;
constexpr std::size_t kMaxCommandLine = 80;
constexpr std::uint64_t kMaxCommands = kMaxSafeInteger;
constexpr std::size_t kMaxOutputLine = 16384;
constexpr std::size_t kMaxStderrBytes = 65536;
constexpr std::size_t kMaxPacketBytes = 4194304;
constexpr std::size_t kMaxWindowCandidates = 4096;
constexpr std::uint64_t kPrepareTimeoutMs = 15000;
constexpr std::uint64_t kFirstAuTimeoutMs = 10000;
constexpr std::uint64_t kRetirementTimeoutMs = 10000;
constexpr std::uint64_t kWatchdogGraceMs = 250;
constexpr std::uint64_t kMainStallTimeoutMs = 15000;
constexpr char kEncoderId[] = "h264_texture_amf";
constexpr char kNvencEncoderId[] = "obs_nvenc_h264_tex";
constexpr char kMainCanvasUuid[] = "6c69626f-6273-4c00-9d88-c5136d61696e";
constexpr std::uint32_t kObsApiVersion = (32u << 24) | (1u << 16) | 1u;
constexpr char kObsCommit[] = "7272af1375b38bc3cf4e0f98a5d999e8b76e9309";

class ContractError : public std::runtime_error {
 public:
  ContractError(std::string errorCode, std::string message)
      : std::runtime_error(std::move(message)), code(std::move(errorCode)) {}
  std::string code;
};

inline void Require(bool condition, const char* message, const char* code = "ERR_SCREEN_CAPTURE_PROTOCOL") {
  if (!condition) throw ContractError(code, message);
}

enum class ScaleMode { Stretch, Fit };
inline const char* ScaleModeName(ScaleMode mode) { return mode == ScaleMode::Fit ? "fit" : "stretch"; }

struct VideoConfiguration {
  std::uint32_t width = 1920, height = 1080, fps = 120, bitrateKbps = 5000;
  ScaleMode scaleMode = ScaleMode::Stretch;
};

inline void ValidateVideoConfiguration(const VideoConfiguration& video) {
  Require(video.scaleMode == ScaleMode::Stretch || video.scaleMode == ScaleMode::Fit,
          "Unsupported capture scaling mode", "ERR_SCREEN_CAPTURE_VIDEO");
  // obs_reset_video aligns output width to four pixels; reject implicit resizing.
  Require(video.width >= 4 && video.width <= 1920 && video.width % 4 == 0 &&
      video.height >= 2 && video.height <= 1080 && video.height % 2 == 0 &&
      video.fps > 0 && video.fps <= 120 &&
      video.bitrateKbps >= 50 && video.bitrateKbps <= 20000 && video.bitrateKbps % 50 == 0,
      "Unsupported native capture resolution, framerate or bitrate", "ERR_SCREEN_CAPTURE_VIDEO");
}

inline bool ExactVideoConfiguration(const abi::VideoInfo& video, const VideoConfiguration& expected,
                                    std::uint32_t adapterIndex = 0) {
  return video.fps_num == expected.fps && video.fps_den == 1 &&
      video.base_width == expected.width && video.base_height == expected.height &&
      video.output_width == expected.width && video.output_height == expected.height &&
      video.output_format == abi::VideoFormat::Nv12 && video.adapter == adapterIndex && video.gpu_conversion &&
      video.colorspace == abi::ColorSpace::Bt709 && video.range == abi::Range::Partial &&
      video.scale_type == abi::Scale::Bicubic;
}

inline void ValidateMainCanvasVideo(bool isMain, bool sameCoreVideo, const abi::VideoInfo& video,
                                    const VideoConfiguration& expected, std::uint32_t adapterIndex = 0) {
  Require(isMain && sameCoreVideo && ExactVideoConfiguration(video, expected, adapterIndex),
          "Explicit main canvas does not match the admitted core video pipeline", "ERR_SCREEN_CAPTURE_CANVAS");
}

inline void ValidatePrivateScene(bool isPrivate, bool sourceRoundTripMatches, std::uint32_t width, std::uint32_t height,
                                const VideoConfiguration& expected) {
  Require(isPrivate && sourceRoundTripMatches && width == expected.width && height == expected.height,
          "Scene must remain private and use the admitted main canvas dimensions", "ERR_SCREEN_CAPTURE_SOURCE_INITIALIZATION");
}

template <typename Character>
std::uint64_t Decimal(std::basic_string_view<Character> text, std::uint64_t maximum) {
  Require(!text.empty() && text.size() <= 20 && (text.size() == 1 || text.front() != '0'),
          "Expected a canonical unsigned decimal integer");
  std::uint64_t result = 0;
  for (const auto c : text) {
    Require(c >= '0' && c <= '9', "Integer contains a non-decimal character");
    const auto digit = static_cast<std::uint64_t>(c - '0');
    Require(digit <= maximum && result <= (maximum - digit) / 10, "Integer exceeds its bound");
    result = result * 10 + digit;
  }
  return result;
}

inline bool ValidRunId(std::string_view value) {
  if (value.size() != 32) return false;
  for (const auto c : value) if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  return true;
}

inline wchar_t Fold(wchar_t c) {
  return c >= L'A' && c <= L'Z' ? static_cast<wchar_t>(c + (L'a' - L'A')) : c;
}

inline bool SamePath(std::wstring_view a, std::wstring_view b) {
  if (a.size() != b.size()) return false;
  for (std::size_t i = 0; i < a.size(); ++i) if (Fold(a[i]) != Fold(b[i])) return false;
  return true;
}

inline bool SafeAbsolutePath(std::wstring_view value) {
  if (value.size() < 4 || value.size() > 240 || !((Fold(value[0]) >= L'a') && (Fold(value[0]) <= L'z')) ||
      value[1] != L':' || value[2] != L'\\' || value.back() == L'\\') return false;
  std::size_t start = 3;
  for (std::size_t i = 3; i <= value.size(); ++i) {
    if (i < value.size() && value[i] != L'\\') {
      const auto c = value[i];
      if (c < 0x20 || c == L'/' || c == L':' || c == L'"' || c == L'<' || c == L'>' ||
          c == L'|' || c == L'?' || c == L'*' || c == L'~') return false;
      continue;
    }
    const auto part = value.substr(start, i - start);
    if (part.empty() || part == L"." || part == L".." || part.back() == L'.' || part.back() == L' ') return false;
    std::wstring stem(part.substr(0, part.find(L'.')));
    std::transform(stem.begin(), stem.end(), stem.begin(), Fold);
    if (stem == L"con" || stem == L"prn" || stem == L"aux" || stem == L"nul" ||
        stem == L"conin$" || stem == L"conout$" ||
        (stem.size() == 4 && (stem.starts_with(L"com") || stem.starts_with(L"lpt")) &&
         stem.back() >= L'1' && stem.back() <= L'9')) return false;
    start = i + 1;
  }
  return true;
}

inline std::wstring StockProbePath(std::wstring_view hostExecutable, std::wstring_view basename) {
  Require(SafeAbsolutePath(hostExecutable), "Host image must have an ordinary absolute Windows path",
          "ERR_SCREEN_CAPTURE_RUNTIME_PATH");
  const auto separator = hostExecutable.find_last_of(L'\\');
  Require(hostExecutable.substr(separator + 1) == L"monky-screen-capture.exe",
          "Unexpected host image basename for stock AMF probe resolution", "ERR_SCREEN_CAPTURE_RUNTIME_PATH");
  Require(basename == L"obs-amf-test.exe" || basename == L"obs-nvenc-test.exe",
          "Only pinned hardware probe basenames are admitted", "ERR_SCREEN_CAPTURE_RUNTIME_PATH");
  auto result = std::wstring(hostExecutable.substr(0, separator + 1)) + std::wstring(basename);
  Require(SafeAbsolutePath(result), "Adjacent AMF probe path exceeds the admitted Windows path bounds",
          "ERR_SCREEN_CAPTURE_RUNTIME_PATH");
  return result;
}
inline std::wstring StockAmfProbePath(std::wstring_view hostExecutable) {
  return StockProbePath(hostExecutable, L"obs-amf-test.exe");
}

enum class Method { Wgc, GameHook };
inline const char* MethodName(Method method) { return method == Method::Wgc ? "wgc" : "game-hook"; }
enum class CaptureKind { Window, Monitor, Game };
inline const char* KindName(CaptureKind kind) {
  return kind == CaptureKind::Monitor ? "monitor" : kind == CaptureKind::Game ? "game" : "window";
}
enum class EncoderKind { Auto, Amf, Nvenc };
inline const char* EncoderId(EncoderKind kind) { return kind == EncoderKind::Nvenc ? kNvencEncoderId : kEncoderId; }
inline const char* EncoderRateControl(EncoderKind kind) { return kind == EncoderKind::Nvenc ? "CBR" : "VBR_LAT"; }
// OBS supplies the output colour description; AMF's input primaries otherwise default to undefined.
inline const char* EncoderExtraOptions(EncoderKind kind) { return kind == EncoderKind::Nvenc ? "" : "InColorPrimaries=1"; }
inline const char* SourceId(CaptureKind kind) {
  return kind == CaptureKind::Monitor ? "monitor_capture" : kind == CaptureKind::Game ? "game_capture" : "window_capture";
}

struct MonitorIdentity {
  std::wstring deviceId, deviceName;
  std::int32_t x = 0, y = 0;
  std::uint32_t width = 0, height = 0;
};

inline void ValidateMonitorIdentity(const MonitorIdentity& monitor) {
  Require(monitor.deviceId.starts_with(L"\\\\?\\DISPLAY#") && monitor.deviceId.size() < 128 &&
          monitor.deviceId.size() > 12 && monitor.deviceName.starts_with(L"\\\\.\\DISPLAY") &&
          monitor.deviceName.size() > 11 && monitor.deviceName.size() < 32 &&
          monitor.width > 0 && monitor.width <= 32768 && monitor.height > 0 && monitor.height <= 32768 &&
          static_cast<std::int64_t>(monitor.x) + monitor.width <= INT32_MAX &&
          static_cast<std::int64_t>(monitor.y) + monitor.height <= INT32_MAX,
          "An exact monitor device interface, name and physical bounds are required", "ERR_SCREEN_CAPTURE_MONITOR_IDENTITY");
  for (const auto character : monitor.deviceId)
    Require(character >= 0x20 && character < 0x7f, "Monitor interface identity must be bounded ASCII",
            "ERR_SCREEN_CAPTURE_MONITOR_IDENTITY");
  for (const auto character : monitor.deviceName.substr(11))
    Require(character >= L'0' && character <= L'9', "Invalid display device name", "ERR_SCREEN_CAPTURE_MONITOR_IDENTITY");
  Require(monitor.deviceName[11] != L'0', "Invalid display device name", "ERR_SCREEN_CAPTURE_MONITOR_IDENTITY");
}

struct Arguments {
  std::wstring runtime, runDirectory;
  std::string runId;
  std::uint64_t hwnd = 0;
  std::uint32_t processId = 0;
  std::uint64_t expectedCreation = 0;
  CaptureKind kind = CaptureKind::Window;
  EncoderKind encoder = EncoderKind::Auto;
  bool encoderProbe = false;
  MonitorIdentity monitor;
  Method method = Method::Wgc;
  VideoConfiguration video;
};

inline void ValidateRunPath(const Arguments& value) {
  Require(SafeAbsolutePath(value.runDirectory), "Run directory must be an ordinary absolute Windows path",
          "ERR_SCREEN_CAPTURE_RUN_DIRECTORY");
  const std::wstring name = L"monky-screen-capture-" + std::wstring(value.runId.begin(), value.runId.end());
  Require(value.runDirectory.substr(value.runDirectory.find_last_of(L'\\') + 1) == name,
          "Run directory basename must bind the exact run-id nonce", "ERR_SCREEN_CAPTURE_RUN_DIRECTORY");
}

struct PathEvidence {
  bool ordinaryDirectory = false, noReparseComponents = false, canonicalRealPath = false;
  bool initiallyEmpty = false, exclusiveOwnerMarker = false, nonceMatches = false;
};

inline void ValidatePathEvidence(const PathEvidence& value) {
  Require(value.ordinaryDirectory && value.noReparseComponents && value.canonicalRealPath &&
          value.initiallyEmpty && value.exclusiveOwnerMarker && value.nonceMatches,
          "Run directory ownership, realpath or exclusive nonce validation failed", "ERR_SCREEN_CAPTURE_RUN_DIRECTORY");
}

inline Arguments ParseArguments(std::span<const std::wstring_view> input) {
  Require(input.size() >= 9 && input.size() <= 16, "Expected capture identity and explicit video configuration",
          "ERR_SCREEN_CAPTURE_ARGUMENT");
  Arguments value;
  unsigned seen = 0;
  for (const auto argument : input) {
    unsigned bit = 0;
    {
      const auto split = argument.find(L'=');
      Require(split != std::wstring_view::npos, "Named options require name=value", "ERR_SCREEN_CAPTURE_ARGUMENT");
      const auto name = argument.substr(0, split), text = argument.substr(split + 1);
      if (name == L"--runtime") { bit = 1; value.runtime = text; }
      else if (name == L"--run-directory") { bit = 2; value.runDirectory = text; }
      else if (name == L"--run-id") {
        bit = 4;
        Require(text.size() == 32, "run-id must be32 lowercase hex characters", "ERR_SCREEN_CAPTURE_ARGUMENT");
        for (const auto c : text) {
          Require((c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f'), "Invalid run-id", "ERR_SCREEN_CAPTURE_ARGUMENT");
          value.runId.push_back(static_cast<char>(c));
        }
      } else if (name == L"--hwnd") { bit = 8; value.hwnd = Decimal(text, kMaxSafeInteger); }
      else if (name == L"--pid") {
        bit = 16; value.processId = static_cast<std::uint32_t>(Decimal(text, UINT32_MAX));
      } else if (name == L"--width") {
        bit = 32; value.video.width = static_cast<std::uint32_t>(Decimal(text, 1920));
      } else if (name == L"--height") {
        bit = 64; value.video.height = static_cast<std::uint32_t>(Decimal(text, 1080));
      } else if (name == L"--fps") {
        bit = 128; value.video.fps = static_cast<std::uint32_t>(Decimal(text, 120));
      } else if (name == L"--bitrate") {
        bit = 256; value.video.bitrateKbps = static_cast<std::uint32_t>(Decimal(text, 20000));
      } else if (name == L"--kind") {
        bit = 512;
        Require(text == L"window" || text == L"monitor" || text == L"game", "Unknown capture kind");
        value.kind = text == L"monitor" ? CaptureKind::Monitor : text == L"game" ? CaptureKind::Game : CaptureKind::Window;
        value.method = value.kind == CaptureKind::Game ? Method::GameHook : Method::Wgc;
      } else if (name == L"--process-created") {
        bit = 1024; value.expectedCreation = Decimal(text, UINT64_MAX);
        Require(value.expectedCreation > 0, "Expected process creation time is zero");
      } else if (name == L"--encoder") {
        bit = 2048;
        Require(text == L"auto" || text == L"h264_texture_amf" || text == L"obs_nvenc_h264_tex",
                "Only admitted hardware H264 encoders may be requested", "ERR_SCREEN_CAPTURE_ENCODER_UNAVAILABLE");
        value.encoder = text == L"auto" ? EncoderKind::Auto : text == L"h264_texture_amf" ? EncoderKind::Amf : EncoderKind::Nvenc;
      } else if (name == L"--monitor-id") { bit = 4096; value.monitor.deviceId = text;
      } else if (name == L"--monitor-name") { bit = 8192; value.monitor.deviceName = text;
      } else if (name == L"--monitor-x" || name == L"--monitor-y") {
        bit = name == L"--monitor-x" ? 16384 : 32768;
        const bool negative = text.starts_with(L"-");
        const auto magnitude = Decimal(negative ? text.substr(1) : text, negative ? 2147483648ULL : 2147483647ULL);
        Require(!negative || magnitude != 0, "Coordinates must be canonical decimal integers");
        const auto coordinate = static_cast<std::int32_t>(negative ? -static_cast<std::int64_t>(magnitude) :
                                                                   static_cast<std::int64_t>(magnitude));
        (name == L"--monitor-x" ? value.monitor.x : value.monitor.y) = coordinate;
      } else if (name == L"--monitor-width") {
        bit = 65536; value.monitor.width = static_cast<std::uint32_t>(Decimal(text, 32768));
      } else if (name == L"--monitor-height") {
        bit = 131072; value.monitor.height = static_cast<std::uint32_t>(Decimal(text, 32768));
      } else if (name == L"--probe") {
        bit = 262144;
        Require(text == L"encoder", "Only the source-free encoder probe is supported", "ERR_SCREEN_CAPTURE_ARGUMENT");
        value.encoderProbe = true;
      } else if (name == L"--scale-mode") {
        bit = 524288;
        Require(text == L"stretch" || text == L"fit", "Unsupported capture scaling mode", "ERR_SCREEN_CAPTURE_VIDEO");
        value.video.scaleMode = text == L"fit" ? ScaleMode::Fit : ScaleMode::Stretch;
      } else throw ContractError("ERR_SCREEN_CAPTURE_ARGUMENT", "Unknown native host option");
    }
    Require((seen & bit) == 0, "Duplicate native host option", "ERR_SCREEN_CAPTURE_ARGUMENT");
    seen |= bit;
  }
  ValidateVideoConfiguration(value.video);
  const auto targetOptions = seen & ~524288u;
  if (value.encoderProbe) {
    Require(targetOptions == ((511u & ~24u) | 2048u | 262144u),
            "Encoder probing must not select a window, monitor or game", "ERR_SCREEN_CAPTURE_ARGUMENT");
  } else if (value.kind == CaptureKind::Monitor) {
    Require(targetOptions == ((511u & ~24u) | 512u | 2048u | 258048u),
            "Incomplete or mixed monitor target arguments", "ERR_SCREEN_CAPTURE_ARGUMENT");
    ValidateMonitorIdentity(value.monitor);
  } else {
    Require((targetOptions == 511 || targetOptions == (511u | 2048u) ||
            targetOptions == (511u | 512u | 1024u | 2048u)) &&
            value.hwnd > 0 && value.processId > 0,
            "Incomplete or mixed window target identity", "ERR_SCREEN_CAPTURE_ARGUMENT");
    Require(value.kind != CaptureKind::Game || value.expectedCreation > 0,
            "Game Capture requires explicit process creation identity", "ERR_SCREEN_CAPTURE_ARGUMENT");
  }
  Require(ValidRunId(value.runId), "Incomplete run identity", "ERR_SCREEN_CAPTURE_ARGUMENT");
  Require(SafeAbsolutePath(value.runtime), "Runtime must have an ordinary absolute path", "ERR_SCREEN_CAPTURE_RUNTIME_PATH");
  ValidateRunPath(value);
  return value;
}

enum class Verb { Start, Stats, Stop };
struct Command { std::uint64_t sequence; Verb verb; };

inline void ValidateCommandMode(const Arguments& arguments, const Command& command) {
  Require(!arguments.encoderProbe || command.verb == Verb::Stop,
          "A source-free encoder probe accepts only STOP, never capture commands", "ERR_SCREEN_CAPTURE_PROTOCOL");
}

inline Command ParseCommand(std::string_view line) {
  Require(!line.empty() && line.size() + 1 <= kMaxCommandLine, "Empty or overlong command");
  for (const unsigned char c : line) Require(c >= 0x20 && c <= 0x7e, "Commands must contain only printable ASCII");
  const auto split = line.find(' ');
  Require(split != std::string_view::npos && line.find(' ', split + 1) == std::string_view::npos,
          "Command must be '<contiguous-sequence> <start|stats|stop>\\n'");
  const auto sequence = Decimal(line.substr(0, split), kMaxCommands);
  Require(sequence > 0, "Command sequences start at1");
  const auto verb = line.substr(split + 1);
  if (verb == "start") return {sequence, Verb::Start};
  if (verb == "stats") return {sequence, Verb::Stats};
  if (verb == "stop") return {sequence, Verb::Stop};
  throw ContractError("ERR_SCREEN_CAPTURE_PROTOCOL", "Unknown command verb");
}

class CommandFramer {
 public:
  std::optional<Command> Push(unsigned char c) {
    if (c == '\n') {
      const auto result = ParseCommand(line_);
      line_.clear();
      return result;
    }
    Require(c >= 0x20 && c <= 0x7e && line_.size() + 2 <= kMaxCommandLine,
            "Command has a non-ASCII/control byte or exceeds80 bytes");
    line_ += static_cast<char>(c);
    return std::nullopt;
  }
  void Finish() const { Require(line_.empty(), "EOF split a command"); }
 private:
  std::string line_;
};

enum class Phase { Preparing, Prepared, Starting, Running, Stopping, Stopped };
enum class Deadline { None, Preparation, FirstAu, Retirement };

enum class NativeStage {
  Admission, RuntimeVerification, StaInitialization, CoreLoad, CoreStartup, CoreDataPath, VideoReset, VideoVerification,
  WinCaptureImage, WinCaptureOpen, WinCaptureIdentity, WinCaptureInit,
  FfmpegImage, FfmpegOpen, FfmpegIdentity, FfmpegInit, ModulesPostLoad, SourceSettings, EncoderSettings, OutputRegistration,
  NvencImage, NvencOpen, NvencIdentity, NvencInit,
  EncoderProbe, Prepared, SourceStart, EncoderStart, Capture, Retirement, OutputStop, SourceRelease,
  EncoderRelease, ObsShutdown, ComShutdown, Terminal
};

inline const char* NativeStageName(NativeStage stage) {
  switch (stage) {
    case NativeStage::Admission: return "admission";
    case NativeStage::RuntimeVerification: return "prepare.runtime-verification";
    case NativeStage::StaInitialization: return "prepare.sta-initialization";
    case NativeStage::CoreLoad: return "prepare.core-load";
    case NativeStage::CoreStartup: return "prepare.obs-startup";
    case NativeStage::CoreDataPath: return "prepare.core-data-path";
    case NativeStage::VideoReset: return "prepare.obs-reset-video";
    case NativeStage::VideoVerification: return "prepare.video-verification";
    case NativeStage::WinCaptureImage: return "prepare.win-capture.image-load";
    case NativeStage::WinCaptureOpen: return "prepare.win-capture.obs-open-module";
    case NativeStage::WinCaptureIdentity: return "prepare.win-capture.module-identity";
    case NativeStage::WinCaptureInit: return "prepare.win-capture.obs-init-module";
    case NativeStage::FfmpegImage: return "prepare.obs-ffmpeg.image-load";
    case NativeStage::FfmpegOpen: return "prepare.obs-ffmpeg.obs-open-module";
    case NativeStage::FfmpegIdentity: return "prepare.obs-ffmpeg.module-identity";
    case NativeStage::FfmpegInit: return "prepare.obs-ffmpeg.obs-init-module";
    case NativeStage::NvencImage: return "prepare.obs-nvenc.image-load";
    case NativeStage::NvencOpen: return "prepare.obs-nvenc.obs-open-module";
    case NativeStage::NvencIdentity: return "prepare.obs-nvenc.module-identity";
    case NativeStage::NvencInit: return "prepare.obs-nvenc.obs-init-module";
    case NativeStage::ModulesPostLoad: return "prepare.obs-post-load-modules";
    case NativeStage::SourceSettings: return "prepare.source-settings";
    case NativeStage::EncoderSettings: return "prepare.encoder-settings";
    case NativeStage::OutputRegistration: return "prepare.output-registration";
    case NativeStage::EncoderProbe: return "prepare.encoder-probe";
    case NativeStage::Prepared: return "prepare.prepared-envelope";
    case NativeStage::SourceStart: return "start.source";
    case NativeStage::EncoderStart: return "start.encoder-output";
    case NativeStage::Capture: return "capture";
    case NativeStage::Retirement: return "retire.begin";
    case NativeStage::OutputStop: return "retire.output";
    case NativeStage::SourceRelease: return "retire.sources";
    case NativeStage::EncoderRelease: return "retire.encoder-settings";
    case NativeStage::ObsShutdown: return "retire.obs-shutdown";
    case NativeStage::ComShutdown: return "retire.com-uninitialize";
    case NativeStage::Terminal: return "retire.terminal-envelope";
  }
  throw ContractError("ERR_SCREEN_CAPTURE_DIAGNOSTIC", "Unknown native diagnostic stage");
}

inline const char* PhaseName(Phase phase) {
  switch (phase) {
    case Phase::Preparing: return "preparing";
    case Phase::Prepared: return "prepared";
    case Phase::Starting: return "starting";
    case Phase::Running: return "running";
    case Phase::Stopping: return "stopping";
    case Phase::Stopped: return "stopped";
  }
  throw ContractError("ERR_SCREEN_CAPTURE_DIAGNOSTIC", "Unknown native diagnostic phase");
}

inline bool FatalStockLog(int level, bool strictWarnings) noexcept {
  return level <= abi::kLogError || (strictWarnings && level <= abi::kLogWarning);
}

inline const char* StockFailureCode(Phase phase, NativeStage stage) {
  return phase == Phase::Preparing ? "ERR_SCREEN_CAPTURE_INITIALIZATION" :
      phase == Phase::Stopping ? "ERR_SCREEN_CAPTURE_RETIREMENT" :
      stage == NativeStage::SourceStart ? "ERR_SCREEN_CAPTURE_SOURCE_INITIALIZATION" : "ERR_SCREEN_CAPTURE_ENCODER_INITIALIZATION";
}

struct NativeFailure {
  std::string code, message;
  NativeStage stage = NativeStage::Admission;
};

inline bool HeartbeatStalled(std::uint64_t now, std::uint64_t progress) {
  return now >= progress && now - progress >= kMainStallTimeoutMs + kWatchdogGraceMs;
}

inline Deadline ExpiredDeadline(Phase phase, std::uint64_t now, std::uint64_t processStarted,
                                std::uint64_t captureStarted, std::uint64_t stopStarted) {
  Require(now >= processStarted && (captureStarted == 0 || now >= captureStarted) &&
          (stopStarted == 0 || now >= stopStarted), "Monotonic clock regressed", "ERR_SCREEN_CAPTURE_CLOCK");
  if (phase == Phase::Preparing && now - processStarted >= kPrepareTimeoutMs) return Deadline::Preparation;
  if (phase == Phase::Stopping && now - stopStarted >= kRetirementTimeoutMs) return Deadline::Retirement;
  if (phase == Phase::Starting && now - captureStarted >= kFirstAuTimeoutMs) return Deadline::FirstAu;
  return Deadline::None;
}

class Lifecycle {
 public:
  Phase phase = Phase::Preparing;
  std::uint64_t lastSequence = 0, startSequence = 0, stopSequence = 0;
  std::uint64_t captureStartedMs = 0, stopStartedMs = 0;
  std::uint64_t startupObservedMs = 0;
  bool startupPaused = false;
  bool failed = false;

  bool Prepared() {
    if (phase == Phase::Stopping) return false;
    Require(phase == Phase::Preparing, "PREPARED may be emitted only once");
    phase = Phase::Prepared;
    return true;
  }
  void Accept(Command command, std::uint64_t now) {
    Require(lastSequence < kMaxCommands && command.sequence == lastSequence + 1,
            "Command sequences must be contiguous safe integers");
    Require(phase != Phase::Stopping && phase != Phase::Stopped, "Command follows STOP");
    if (command.verb == Verb::Start) {
      Require(phase == Phase::Prepared && startSequence == 0, "START requires PREPARED and is accepted once");
      phase = Phase::Starting; startSequence = command.sequence; captureStartedMs = now; startupObservedMs = now;
    } else if (command.verb == Verb::Stats) {
      Require(phase == Phase::Prepared || phase == Phase::Running, "STATS requires PREPARED or READY");
    } else {
      phase = Phase::Stopping; stopSequence = command.sequence; stopStartedMs = now;
    }
    lastSequence = command.sequence;
  }
  void ObserveStartupAvailability(std::uint64_t now, bool paused) {
    if (phase != Phase::Starting) return;
    Require(now >= startupObservedMs, "Startup availability clock regressed", "ERR_SCREEN_CAPTURE_CLOCK");
    if (paused || startupPaused) captureStartedMs += now - startupObservedMs;
    startupObservedMs = now;
    startupPaused = paused;
  }
  bool Ready(bool attached, bool actualAccessUnit) {
    if (phase == Phase::Stopping) return false;
    Require(phase == Phase::Starting && attached && actualAccessUnit,
            "READY requires attachment and an actual H264 access unit, not dimensions or configured ticks");
    phase = Phase::Running;
    return true;
  }
  void Fail(std::uint64_t now) {
    failed = true;
    if (phase != Phase::Stopping) { phase = Phase::Stopping; stopStartedMs = now; }
  }
  bool EofIsClean() const { return stopSequence != 0 && (phase == Phase::Stopping || phase == Phase::Stopped); }
  void Stopped() {
    Require(!failed && phase == Phase::Stopping && stopSequence > 0, "Clean STOPPED requires explicit STOP without failure");
    phase = Phase::Stopped;
  }
};

struct SourceKey {
  std::string title, className, executable;
  bool operator==(const SourceKey&) const = default;
};

inline void ValidateKey(const SourceKey& key) {
  Require(!key.title.empty() && key.title.size() <= 512 && !key.className.empty() && key.className.size() <= 256 &&
          !key.executable.empty() && key.executable.size() <= 260 &&
          key.executable.find_first_of("/\\:") == std::string::npos,
          "Selected window key is missing, overlong or not an executable basename", "ERR_SCREEN_CAPTURE_SOURCE_IDENTITY");
}

inline void ValidateSelectionEvidence(std::size_t matchingTuples, std::size_t matchingTitles,
                                     bool hwndPidCreationLive, bool stockFinderMatches) {
  Require(hwndPidCreationLive && stockFinderMatches, "Selected HWND/PID/creation time or stock finder changed",
          "ERR_SCREEN_CAPTURE_SOURCE_LOST");
  // WINDOW_PRIORITY_TITLE matches title alone in the pinned stock source.
  Require(matchingTuples == 1 && matchingTitles == 1,
          "Stock title matching is ambiguous even if a title/class/executable tuple is unique",
          "ERR_SCREEN_CAPTURE_SOURCE_AMBIGUOUS");
}

inline void ValidateHookEvidence(const SourceKey& selected, const SourceKey& observed) {
  ValidateKey(selected); ValidateKey(observed);
  Require(selected == observed, "Stock get_hooked tuple differs from the explicitly selected source",
          "ERR_SCREEN_CAPTURE_HOOK_IDENTITY");
}

inline void ValidateEncoderAdmission(bool registeredH264, bool passTexture, bool matchingDevice, bool nv12Textures,
                                     bool initializationError, bool rejectedSetting,
                                     EncoderKind encoder = EncoderKind::Amf, bool verifiedProbe = true) {
  Require(encoder != EncoderKind::Auto && registeredH264 && passTexture && matchingDevice && nv12Textures && verifiedProbe,
          "Pinned hardware H264 texture encoder, verified capability probe or matching NV12 device is unavailable",
          encoder == EncoderKind::Nvenc ? "ERR_SCREEN_CAPTURE_NVENC_UNAVAILABLE" : "ERR_SCREEN_CAPTURE_AMF_UNAVAILABLE");
  Require(!initializationError && !rejectedSetting,
          "Stock encoder initialization error, reroute or rejected setting invalidates capture",
          "ERR_SCREEN_CAPTURE_ENCODER_INITIALIZATION");
}

class BitReader {
 public:
  explicit BitReader(std::span<const std::uint8_t> bytes) : bytes_(bytes) {}
  std::uint32_t Read(unsigned bits) {
    Require(bits <= 32, "H264 field exceeds32 bits", "ERR_SCREEN_CAPTURE_H264");
    std::uint32_t value = 0;
    for (unsigned i = 0; i < bits; ++i) {
      if (remaining_ == 0) {
        Require(offset_ < bytes_.size(), "Truncated H264 RBSP", "ERR_SCREEN_CAPTURE_H264");
        std::uint8_t next = bytes_[offset_++];
        if (zeros_ >= 2 && next == 3) {
          Require(offset_ < bytes_.size() && bytes_[offset_] <= 3, "Invalid H264 emulation prevention",
                  "ERR_SCREEN_CAPTURE_H264");
          zeros_ = 0;
          next = bytes_[offset_++];
        }
        zeros_ = next == 0 ? zeros_ + 1 : 0;
        byte_ = next; remaining_ = 8;
      }
      --remaining_;
      value = (value << 1) | ((byte_ >> remaining_) & 1u);
    }
    return value;
  }
  std::uint32_t Ue(std::uint32_t maximum = UINT32_MAX - 1) {
    unsigned zeros = 0;
    while (Read(1) == 0) Require(++zeros < 32, "H264 Exp-Golomb overflow", "ERR_SCREEN_CAPTURE_H264");
    const auto value = ((std::uint32_t{1} << zeros) - 1) + Read(zeros);
    Require(value <= maximum, "H264 Exp-Golomb field exceeds bound", "ERR_SCREEN_CAPTURE_H264");
    return value;
  }
 private:
  std::span<const std::uint8_t> bytes_;
  std::size_t offset_ = 0;
  unsigned remaining_ = 0, zeros_ = 0;
  std::uint8_t byte_ = 0;
};

inline void ValidateSps(std::span<const std::uint8_t> nal, const VideoConfiguration& video) {
  Require(nal.size() >= 5, "Truncated SPS", "ERR_SCREEN_CAPTURE_H264");
  BitReader bits(nal.subspan(1));
  Require(bits.Read(8) == 77, "Encoded SPS did not accept H264 main profile", "ERR_SCREEN_CAPTURE_H264");
  bits.Read(8);
  const auto level = bits.Read(8);
  Require(level > 0 && level <= 51, "SPS exceeds the negotiated H264 level", "ERR_SCREEN_CAPTURE_H264");
  bits.Ue(31);
  bits.Ue(12);
  const auto order = bits.Ue(2);
  if (order == 0) bits.Ue(12);
  else if (order == 1) {
    bits.Read(1); bits.Ue(); bits.Ue();
    const auto count = bits.Ue(255);
    for (std::uint32_t i = 0; i < count; ++i) bits.Ue();
  }
  bits.Ue(16); bits.Read(1);
  const auto columns = bits.Ue(4095) + 1, rows = bits.Ue(4095) + 1;
  Require(bits.Read(1) == 1, "Interlaced SPS is outside the progressive OBS contract", "ERR_SCREEN_CAPTURE_H264");
  bits.Read(1);
  std::uint32_t left = 0, right = 0, top = 0, bottom = 0;
  if (bits.Read(1)) { left = bits.Ue(8192); right = bits.Ue(8192); top = bits.Ue(8192); bottom = bits.Ue(8192); }
  const auto cropX = (left + right) * 2, cropY = (top + bottom) * 2;
  Require(columns * 16 > cropX && rows * 16 > cropY && columns * 16 - cropX == video.width &&
          rows * 16 - cropY == video.height, "Encoded SPS dimensions differ from the selected rendition", "ERR_SCREEN_CAPTURE_H264");
}

struct AnnexBInfo { bool sps = false, pps = false, accessUnit = false, idr = false; };

inline std::size_t StartCodeBytes(std::span<const std::uint8_t> data, std::size_t i) {
  if (i + 3 <= data.size() && data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1) return 3;
  if (i + 4 <= data.size() && data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 0 && data[i + 3] == 1) return 4;
  return 0;
}

inline AnnexBInfo InspectAnnexB(std::span<const std::uint8_t> bytes, const VideoConfiguration& video) {
  Require(!bytes.empty() && bytes.size() <= kMaxPacketBytes, "H264 buffer exceeds packet bound or is empty",
          "ERR_SCREEN_CAPTURE_H264");
  AnnexBInfo result;
  std::size_t cursor = 0, units = 0;
  while (cursor < bytes.size() && StartCodeBytes(bytes, cursor) == 0) {
    Require(bytes[cursor++] == 0, "Expected Annex B start code, not AVCC", "ERR_SCREEN_CAPTURE_H264");
  }
  Require(cursor < bytes.size(), "H264 buffer contains no NAL", "ERR_SCREEN_CAPTURE_H264");
  while (cursor < bytes.size()) {
    const auto prefix = StartCodeBytes(bytes, cursor);
    Require(prefix != 0 && ++units <= 4096, "Malformed or excessive Annex B NAL units", "ERR_SCREEN_CAPTURE_H264");
    const auto begin = cursor + prefix;
    auto end = begin;
    while (end < bytes.size() && StartCodeBytes(bytes, end) == 0) ++end;
    auto payloadEnd = end;
    while (payloadEnd > begin && bytes[payloadEnd - 1] == 0) --payloadEnd;
    Require(payloadEnd > begin && (bytes[begin] & 0x80u) == 0, "Empty or forbidden H264 NAL header", "ERR_SCREEN_CAPTURE_H264");
    const auto nal = bytes.subspan(begin, payloadEnd - begin);
    const auto type = nal.front() & 0x1fu;
    Require(type >= 1 && type <= 12 && type != 2 && type != 3 && type != 4,
            "Unsupported H264 NAL type", "ERR_SCREEN_CAPTURE_H264");
    if (type == 7) { ValidateSps(nal, video); result.sps = true; }
    else if (type == 8) {
      BitReader bits(nal.subspan(1)); bits.Ue(255); bits.Ue(31); result.pps = true;
    } else if (type == 1 || type == 5) {
      BitReader bits(nal.subspan(1));
      const auto firstMb = bits.Ue(32767), slice = bits.Ue(9);
      bits.Ue(255);
      Require(slice % 5 != 1, "Encoded B slice contradicts bFrames=0", "ERR_SCREEN_CAPTURE_H264");
      Require(result.accessUnit ? firstMb != 0 && result.idr == (type == 5) : firstMb == 0,
              "Packet must contain one H264 access unit beginning at macroblock0", "ERR_SCREEN_CAPTURE_H264");
      result.accessUnit = true; result.idr = type == 5;
    }
    cursor = end;
  }
  return result;
}

inline std::vector<std::uint8_t> CompleteH264Keyframe(std::span<const std::uint8_t> accessUnit,
    std::span<const std::uint8_t> parameterSets, const VideoConfiguration& video) {
  const auto picture = InspectAnnexB(accessUnit, video);
  const auto parameters = InspectAnnexB(parameterSets, video);
  Require(picture.accessUnit && picture.idr && parameters.sps && parameters.pps && !parameters.accessUnit,
          "An independently decodable keyframe requires its encoder's SPS/PPS and a real IDR", "ERR_SCREEN_CAPTURE_H264");
  Require(parameterSets.size() <= kMaxPacketBytes - accessUnit.size(),
          "H264 keyframe and parameter sets exceed the packet bound", "ERR_SCREEN_CAPTURE_BUFFER_LIMIT");
  std::vector<std::uint8_t> result;
  result.reserve(parameterSets.size() + accessUnit.size());
  result.insert(result.end(), parameterSets.begin(), parameterSets.end());
  result.insert(result.end(), accessUnit.begin(), accessUnit.end());
  return result;
}

struct PacketInput {
  std::span<const std::uint8_t> bytes;
  std::int64_t pts = 0, dts = 0;
  std::uint32_t timebaseNumerator = 0, timebaseDenominator = 0;
  bool keyframe = false;
  std::uint64_t observedAtQpc = 0;
};

struct Packet {
  std::int64_t pts = 0, dts = 0;
  std::uint32_t timebaseNumerator = 0, timebaseDenominator = 0;
  bool keyframe = false;
  std::uint64_t observedAtQpc = 0;
};

class PacketStatistics {
 public:
  explicit PacketStatistics(VideoConfiguration video) : video_(video) { ValidateVideoConfiguration(video_); }
  void SetPrefix(std::span<const std::uint8_t> prefix) {
    Require(!prefixValid_ && count_ == 0, "Encoder extra data may be installed exactly once before output");
    const auto info = InspectAnnexB(prefix, video_);
    Require(info.sps && info.pps && !info.accessUnit, "Extra data must contain Annex B SPS/PPS, not access units",
            "ERR_SCREEN_CAPTURE_H264");
    prefixValid_ = true;
  }
  void Add(const PacketInput& input) {
    Require(prefixValid_, "Encoded output preceded valid SPS/PPS", "ERR_SCREEN_CAPTURE_H264");
    Require(!input.bytes.empty() && input.bytes.size() <= kMaxPacketBytes &&
        count_ < kMaxSafeInteger && outputBytes_ <= kMaxSafeInteger - input.bytes.size(),
        "Encoded packet/counters exceed their bounds", "ERR_SCREEN_CAPTURE_BUFFER_LIMIT");
    Require(input.timebaseNumerator > 0 && input.timebaseNumerator <= INT32_MAX &&
            input.timebaseDenominator > 0 && input.timebaseDenominator <= INT32_MAX && input.observedAtQpc > 0,
            "Invalid encoded packet timebase or observation clock", "ERR_SCREEN_CAPTURE_TIMESTAMP");
    Require(static_cast<std::uint64_t>(input.timebaseNumerator) * video_.fps == input.timebaseDenominator,
        "Encoder timebase differs from the selected rendition", "ERR_SCREEN_CAPTURE_TIMESTAMP");
    const auto info = InspectAnnexB(input.bytes, video_);
    Require(info.accessUnit && info.idr == input.keyframe, "Packet is not a matching H264 AU/keyframe",
            "ERR_SCREEN_CAPTURE_H264");
    if (!last_) Require(input.keyframe, "Output must begin with an IDR access unit", "ERR_SCREEN_CAPTURE_H264");
    else {
      const auto& previous = *last_;
      Require(input.pts > previous.pts && input.dts > previous.dts &&
              input.observedAtQpc >= previous.observedAtQpc &&
              input.timebaseNumerator == previous.timebaseNumerator &&
              input.timebaseDenominator == previous.timebaseDenominator,
              "PTS/DTS/QPC regressed or packet timebase changed", "ERR_SCREEN_CAPTURE_TIMESTAMP");
    }
    Packet packet;
    packet.pts = input.pts; packet.dts = input.dts;
    packet.timebaseNumerator = input.timebaseNumerator; packet.timebaseDenominator = input.timebaseDenominator;
    packet.keyframe = input.keyframe; packet.observedAtQpc = input.observedAtQpc;
    if (!first_) first_ = packet;
    last_ = packet;
    ++count_;
    outputBytes_ += input.bytes.size();
    if (input.keyframe) ++keyframes_;
  }
  std::uint64_t Count() const { return count_; }
  const std::optional<Packet>& First() const { return first_; }
  const std::optional<Packet>& Last() const { return last_; }
  std::uint64_t OutputBytes() const { return outputBytes_; }
  std::uint64_t Keyframes() const { return keyframes_; }
 private:
  const VideoConfiguration video_;
  bool prefixValid_ = false;
  std::optional<Packet> first_, last_;
  std::uint64_t count_ = 0, outputBytes_ = 0, keyframes_ = 0;
};

inline bool ValidUtf8(std::string_view text) {
  for (std::size_t i = 0; i < text.size();) {
    const auto c = static_cast<unsigned char>(text[i++]);
    if (c < 0x80) continue;
    const unsigned count = c >= 0xc2 && c <= 0xdf ? 1u : c >= 0xe0 && c <= 0xef ? 2u :
        c >= 0xf0 && c <= 0xf4 ? 3u : 0u;
    if (count == 0 || i + count > text.size()) return false;
    std::uint32_t cp = c & (count == 1 ? 0x1fu : count == 2 ? 0x0fu : 0x07u);
    for (unsigned j = 0; j < count; ++j) {
      const auto next = static_cast<unsigned char>(text[i++]);
      if ((next & 0xc0u) != 0x80u) return false;
      cp = (cp << 6) | (next & 0x3fu);
    }
    if (cp < (count == 1 ? 0x80u : count == 2 ? 0x800u : 0x10000u) ||
        cp > 0x10ffffu || (cp >= 0xd800u && cp <= 0xdfffu)) return false;
  }
  return true;
}

inline std::string ObsApiPath(std::string_view windowsUtf8Path) {
  Require(windowsUtf8Path.size() >= 4 && windowsUtf8Path.size() <= 960 && ValidUtf8(windowsUtf8Path) &&
          ((windowsUtf8Path[0] >= 'A' && windowsUtf8Path[0] <= 'Z') ||
           (windowsUtf8Path[0] >= 'a' && windowsUtf8Path[0] <= 'z')) &&
          windowsUtf8Path[1] == ':' && windowsUtf8Path[2] == '\\' && windowsUtf8Path.back() != '\\',
          "OBS API requires a bounded UTF-8 encoding of an absolute Windows path", "ERR_SCREEN_CAPTURE_MODULE_PATH");
  for (std::size_t i = 0; i < windowsUtf8Path.size(); ++i) {
    const auto c = static_cast<unsigned char>(windowsUtf8Path[i]);
    Require(c >= 0x20 && c != '/' && (c != ':' || i == 1),
            "OBS path conversion must not admit NUL, controls, mixed separators or another drive",
            "ERR_SCREEN_CAPTURE_MODULE_PATH");
  }
  // OBS32.1.1 obs_open_module splits the filename on '/' only. Filesystem
  // admission, canonical pins and Win32 calls keep their original wide paths.
  std::string result(windowsUtf8Path);
  std::replace(result.begin(), result.end(), '\\', '/');
  return result;
}

struct ModuleIdentity {
  std::string binaryPath, dataPath, fileName, moduleName, configPath;
};

inline std::string CaptureDataCacheName(std::string_view digest) {
  Require(digest.size() == 64 && std::all_of(digest.begin(), digest.end(), [](char value) {
    return (value >= '0' && value <= '9') || (value >= 'a' && value <= 'f');
  }), "Capture data cache requires the complete pinned-set SHA256", "ERR_SCREEN_CAPTURE_RUNTIME_INTEGRITY");
  return "hooks-" + std::string(digest.substr(0, 32));
}

inline std::wstring CaptureDataCacheDirectory(std::wstring_view runDirectory, std::string_view digest) {
  Require(SafeAbsolutePath(runDirectory), "Capture cache requires an admitted run path", "ERR_SCREEN_CAPTURE_MODULE_PATH");
  const auto separator = runDirectory.rfind(L'\\');
  const auto name = CaptureDataCacheName(digest);
  return std::wstring(runDirectory.substr(0, separator + 1)) + std::wstring(name.begin(), name.end());
}

inline ModuleIdentity ExpectedModuleIdentity(std::string_view name, std::string_view windowsBinaryPath,
                                             std::string_view windowsDataPath, std::string_view windowsConfigRoot,
                                             std::string_view captureDataDigest = {}) {
  Require(name == "win-capture" || name == "obs-ffmpeg" || name == "obs-nvenc", "Only required pinned modules are admitted",
          "ERR_SCREEN_CAPTURE_MODULE_PATH");
  ModuleIdentity value{ObsApiPath(windowsBinaryPath), ObsApiPath(windowsDataPath), std::string(name) + ".dll",
                       std::string(name), ObsApiPath(windowsConfigRoot)};
  Require(value.binaryPath.ends_with("/obs-plugins/64bit/" + value.fileName) &&
          value.dataPath.ends_with("/data/obs-plugins/" + value.moduleName) && value.configPath.ends_with("/config"),
          "Required DLL filename, module data and private config root do not match", "ERR_SCREEN_CAPTURE_MODULE_PATH");
  auto dataRoot = value.configPath.substr(0, value.configPath.size() - 7);
  if (!captureDataDigest.empty()) {
    Require(name == "win-capture", "Only pinned win-capture data can outlive the capture run",
            "ERR_SCREEN_CAPTURE_MODULE_PATH");
    dataRoot = dataRoot.substr(0, dataRoot.rfind('/') + 1) + CaptureDataCacheName(captureDataDigest);
  }
  Require(value.dataPath == dataRoot + "/data/obs-plugins/" + value.moduleName,
          "Module data escaped its private run or pinned capture cache", "ERR_SCREEN_CAPTURE_MODULE_PATH");
  value.configPath += "/" + value.moduleName + "/";
  return value;
}

inline void ValidateModuleIdentity(const ModuleIdentity& expected, std::string_view fileName,
                                    std::string_view binaryPath, std::string_view dataPath,
                                    std::string_view configPath, bool nameResolvesSameModule) {
  Require(fileName == expected.fileName, "Stock module filename is not the expected DLL basename",
          "ERR_SCREEN_CAPTURE_MODULE_PATH");
  Require(nameResolvesSameModule, "Stock module name does not resolve to the opened module",
          "ERR_SCREEN_CAPTURE_MODULE_PATH");
  Require(binaryPath == expected.binaryPath && dataPath == expected.dataPath,
          "Stock module binary/data paths differ from their verified private paths", "ERR_SCREEN_CAPTURE_MODULE_PATH");
  Require(configPath == expected.configPath, "Stock module config path escaped its expected private namespace",
          "ERR_SCREEN_CAPTURE_MODULE_PATH");
}

inline std::string JsonString(std::string_view text) {
  Require(ValidUtf8(text), "Invalid UTF-8 cannot be serialized as identity evidence");
  constexpr char hex[] = "0123456789abcdef";
  std::string result = "\"";
  for (const unsigned char c : text) {
    if (c == '\\' || c == '"') { result += '\\'; result += static_cast<char>(c); }
    else if (c < 0x20) { result += "\\u00"; result += hex[c >> 4]; result += hex[c & 15]; }
    else result += static_cast<char>(c);
  }
  result += '"';
  return result;
}

inline std::string PrivateSceneSeed(std::string_view canvasUuid, bool resolvesToHeldMainCanvas) {
  Require(resolvesToHeldMainCanvas && canvasUuid == kMainCanvasUuid,
          "Private scene requires the explicitly resolved pinned main canvas; fallback is forbidden", "ERR_SCREEN_CAPTURE_CANVAS");
  // The public private-source loader passes canvas_uuid into its canvas-aware
  // constructor. The legacy private-scene constructor always passes NULL.
  return "{\"id\":\"scene\",\"versioned_id\":\"scene\",\"name\":\"Monky explicit private capture scene\","
      "\"canvas_uuid\":" + JsonString(canvasUuid) + ",\"prev_ver\":" + std::to_string(kObsApiVersion) + ",\"settings\":{}}";
}

inline const char* Boolean(bool value) { return value ? "true" : "false"; }
template <typename T>
std::string OptionalNumber(const std::optional<T>& value) { return value ? std::to_string(*value) : "null"; }
template <typename T>
std::string OptionalDecimalString(const std::optional<T>& value) {
  return value ? JsonString(std::to_string(*value)) : "null";
}

enum class ObservationState { Prepared, Running, Stopped, Failed };
struct Observation {
  ObservationState state = ObservationState::Prepared;
  bool sourceAttached = false;
  std::optional<std::uint32_t> sourceWidth, sourceHeight;
  std::uint64_t outputPackets = 0, outputBytes = 0, keyframes = 0, bufferedBytes = 0;
  std::optional<std::int64_t> firstPts, lastPts, lastDts;
  std::optional<std::uint32_t> timebaseNumerator, timebaseDenominator;
  std::optional<std::uint64_t> firstPacketQpc;
  std::uint32_t obsTotalFrames = 0, obsLaggedFrames = 0;
};

inline void UpdateSourceDimensions(Observation& observation, Phase phase, std::uint32_t width, std::uint32_t height) {
  Require(width <= 32768 && height <= 32768, "Attached source dimensions exceed bounds", "ERR_SCREEN_CAPTURE_SOURCE");
  if (width == 0 || height == 0) {
    // WGC reports its attached session before the first frame supplies dimensions.
    Require(phase == Phase::Starting && !observation.sourceWidth && !observation.sourceHeight,
            "Initialized source lost positive dimensions", "ERR_SCREEN_CAPTURE_SOURCE");
    return;
  }
  observation.sourceWidth = width; observation.sourceHeight = height;
}

inline bool SourceReadyForEncoder(Phase phase, const Observation& observation) {
  return phase == Phase::Starting && observation.sourceAttached && observation.sourceWidth &&
      observation.sourceHeight && *observation.sourceWidth > 0 && *observation.sourceHeight > 0;
}

struct CoreFrameCounters { std::uint32_t total; std::uint32_t lagged; };

template <typename Reader>
void SnapshotCoreFrames(Observation& observation, bool coreActive, Reader&& readCounters) {
  if (coreActive) {
    const auto counters = readCounters();
    observation.obsTotalFrames = counters.total;
    observation.obsLaggedFrames = counters.lagged;
  }
}

inline void ObservePackets(Observation& observation, const PacketStatistics& buffer) {
  observation.outputPackets = buffer.Count(); observation.outputBytes = buffer.OutputBytes();
  observation.bufferedBytes = 0; observation.keyframes = buffer.Keyframes();
  if (buffer.First()) {
    const auto& first = *buffer.First();
    const auto& last = *buffer.Last();
    observation.firstPts = first.pts; observation.lastPts = last.pts; observation.lastDts = last.dts;
    observation.timebaseNumerator = first.timebaseNumerator; observation.timebaseDenominator = first.timebaseDenominator;
    observation.firstPacketQpc = first.observedAtQpc;
  }
}

struct Common {
  std::string runId;
  std::uint32_t helperProcessId = 0, processId = 0;
  std::uint64_t hwnd = 0, processCreationTime100ns = 0, qpc = 0, qpcFrequency = 0;
};

inline std::string SerializeNativeDiagnostic(const Common& common, NativeStage stage, bool returned, Phase phase,
                                             std::uint64_t elapsedMs, const NativeFailure* failure = nullptr) {
  Require(ValidRunId(common.runId) && common.helperProcessId > 0 && common.qpc > 0 && common.qpcFrequency > 0 &&
          elapsedMs <= kMaxSafeInteger, "Incomplete bounded native diagnostic identity", "ERR_SCREEN_CAPTURE_DIAGNOSTIC");
  const auto limit = phase == Phase::Preparing ? kPrepareTimeoutMs : phase == Phase::Starting ? kFirstAuTimeoutMs :
      phase == Phase::Stopping ? kRetirementTimeoutMs : 0;
  auto result = "{\"schemaVersion\":1,\"kind\":\"screen-capture-stage\",\"runId\":" + JsonString(common.runId) +
      ",\"helperProcessId\":" + std::to_string(common.helperProcessId) + ",\"qpc\":" + JsonString(std::to_string(common.qpc)) +
      ",\"qpcFrequency\":" + JsonString(std::to_string(common.qpcFrequency)) +
      ",\"stage\":" + JsonString(NativeStageName(stage)) + ",\"boundary\":" + JsonString(returned ? "returned" : "entered") +
      ",\"phase\":" + JsonString(PhaseName(phase)) + ",\"elapsedMs\":" + std::to_string(elapsedMs) +
      ",\"phaseLimitMs\":" + (limit ? std::to_string(limit) : "null") + ",\"failure\":";
  if (failure) {
    Require(!failure->code.empty() && failure->code.size() <= 96 && !failure->message.empty() &&
            failure->message.size() <= 1024, "Native diagnostic failure exceeds its bounds", "ERR_SCREEN_CAPTURE_DIAGNOSTIC");
    result += "{\"code\":" + JsonString(failure->code) + ",\"message\":" + JsonString(failure->message) +
        ",\"stage\":" + JsonString(NativeStageName(failure->stage)) + "}";
  } else result += "null";
  result += "}\n";
  Require(result.size() <= 8192, "Native diagnostic exceeds8KiB", "ERR_SCREEN_CAPTURE_DIAGNOSTIC");
  return result;
}

struct Retirement {
  bool outputStopped = false, callbacksQuiesced = false, sourceReleased = false;
  bool encoderReleased = false, obsShutdownReturned = false;
};

inline bool RetirementComplete(const Retirement& value) {
  return value.outputStopped && value.callbacksQuiesced && value.sourceReleased &&
      value.encoderReleased && value.obsShutdownReturned;
}

inline std::string KeyJson(const SourceKey& key) {
  ValidateKey(key);
  return "{\"title\":" + JsonString(key.title) + ",\"className\":" + JsonString(key.className) +
      ",\"executable\":" + JsonString(key.executable) + "}";
}

inline std::string ConfigurationJson(Method method, const VideoConfiguration& video,
                                     EncoderKind encoder = EncoderKind::Amf) {
  ValidateVideoConfiguration(video);
  return "{\"obsVersion\":\"32.1.1\",\"method\":" + JsonString(MethodName(method)) +
      ",\"width\":" + std::to_string(video.width) + ",\"height\":" + std::to_string(video.height) +
      ",\"fpsNumerator\":" + std::to_string(video.fps) + ",\"fpsDenominator\":1,"
      "\"initialBitrateKbps\":" + std::to_string(video.bitrateKbps) +
      ",\"scaleMode\":" + JsonString(ScaleModeName(video.scaleMode)) +
      ",\"rateControl\":" + JsonString(EncoderRateControl(encoder)) +
      ",\"codec\":\"h264\",\"encoderId\":" + JsonString(EncoderId(encoder)) +
      ",\"profile\":\"main\",\"bFrames\":0,\"keyframeIntervalSeconds\":1}";
}

inline std::string CommonJson(const Common& common, std::string_view type, std::uint64_t sequence,
                             bool monitor = false, bool extended = false) {
  Require(ValidRunId(common.runId) && common.helperProcessId > 0 &&
          (monitor ? common.hwnd == 0 && common.processId == 0 && common.processCreationTime100ns == 0 :
          common.processId > 0 && common.hwnd > 0 && common.hwnd <= kMaxSafeInteger && common.processCreationTime100ns > 0) &&
          common.qpc > 0 && common.qpcFrequency > 0 && sequence <= kMaxCommands, "Incomplete JSONL common identity");
  return std::string("{\"schemaVersion\":") + (extended ? "2" : "1") + ",\"type\":" + JsonString(type) + ",\"runId\":" + JsonString(common.runId) +
      ",\"sequence\":" + std::to_string(sequence) + ",\"helperProcessId\":" + std::to_string(common.helperProcessId) +
      ",\"hwnd\":" + std::to_string(common.hwnd) + ",\"processId\":" + std::to_string(common.processId) +
      ",\"processCreationTime100ns\":" + JsonString(std::to_string(common.processCreationTime100ns)) +
      ",\"qpc\":" + JsonString(std::to_string(common.qpc)) +
      ",\"qpcFrequency\":" + JsonString(std::to_string(common.qpcFrequency));
}

inline std::string ObservationJson(const Observation& value, std::uint64_t qpc) {
  Require(value.outputPackets <= kMaxSafeInteger && value.outputBytes <= kMaxSafeInteger &&
          value.bufferedBytes == 0 &&
          value.keyframes <= value.outputPackets && value.sourceWidth.has_value() == value.sourceHeight.has_value(),
          "Observation counters/dimensions are invalid");
  if (value.sourceWidth) Require(*value.sourceWidth > 0 && *value.sourceHeight > 0 &&
      *value.sourceWidth <= 32768 && *value.sourceHeight <= 32768, "Source dimensions are outside bounds");
  const bool packets = value.outputPackets > 0;
  Require(packets == value.firstPts.has_value() && packets == value.lastPts.has_value() &&
          packets == value.lastDts.has_value() && packets == value.timebaseNumerator.has_value() &&
          packets == value.timebaseDenominator.has_value() && packets == value.firstPacketQpc.has_value(),
          "Observation timestamp population differs from encoded packet population");
  if (packets) Require(*value.lastPts >= *value.firstPts && *value.timebaseNumerator > 0 &&
      *value.timebaseDenominator > 0 && *value.firstPacketQpc > 0 && *value.firstPacketQpc <= qpc &&
      value.keyframes > 0, "Observation packet timing/keyframes are invalid");
  else Require(value.outputBytes == 0 && value.keyframes == 0, "Empty output has nonzero counters");
  const char* state = value.state == ObservationState::Prepared ? "prepared" :
      value.state == ObservationState::Running ? "running" : value.state == ObservationState::Stopped ? "stopped" : "failed";
  if (value.state == ObservationState::Prepared) Require(!value.sourceAttached && !value.sourceWidth && !packets &&
      value.bufferedBytes == 0, "PREPARED cannot contain capture or active encoder evidence");
  if (value.state == ObservationState::Running) Require(value.sourceWidth && packets,
      "Running must have observed dimensions and actual output, not just a configured framerate");
  if (value.state == ObservationState::Stopped) Require(!value.sourceAttached, "Stopped source remains attached");
  return "{\"state\":" + JsonString(state) + ",\"sourceAttached\":" + Boolean(value.sourceAttached) +
      ",\"sourceWidth\":" + OptionalNumber(value.sourceWidth) + ",\"sourceHeight\":" + OptionalNumber(value.sourceHeight) +
      ",\"outputPackets\":" + std::to_string(value.outputPackets) + ",\"outputBytes\":" + std::to_string(value.outputBytes) +
      ",\"keyframes\":" + std::to_string(value.keyframes) + ",\"bufferedBytes\":" + std::to_string(value.bufferedBytes) +
      ",\"firstPts\":" + OptionalDecimalString(value.firstPts) + ",\"lastPts\":" + OptionalDecimalString(value.lastPts) +
      ",\"lastDts\":" + OptionalDecimalString(value.lastDts) +
      ",\"timebaseNumerator\":" + OptionalNumber(value.timebaseNumerator) +
      ",\"timebaseDenominator\":" + OptionalNumber(value.timebaseDenominator) +
      ",\"firstPacketQpc\":" + OptionalDecimalString(value.firstPacketQpc) +
      ",\"obsTotalFrames\":" + std::to_string(value.obsTotalFrames) +
      ",\"obsLaggedFrames\":" + std::to_string(value.obsLaggedFrames) +
      ",\"sourceFrames\":null,\"sourceFrameTimestamp\":null,\"sourceContinuity\":null}";
}

inline std::string FinishLine(std::string result) {
  result += "}\n";
  Require(result.size() <= kMaxOutputLine, "JSONL exceeds16KiB", "ERR_SCREEN_CAPTURE_STDOUT_LIMIT");
  return result;
}

inline std::string RetirementJson(const Retirement& value) {
  return std::string("{\"outputStopped\":") + Boolean(value.outputStopped) +
      ",\"callbacksQuiesced\":" + Boolean(value.callbacksQuiesced) +
      ",\"sourceReleased\":" + Boolean(value.sourceReleased) +
      ",\"encoderReleased\":" + Boolean(value.encoderReleased) +
      ",\"obsShutdownReturned\":" + Boolean(value.obsShutdownReturned) + "}";
}

inline std::string SerializeEvent(const Common& common, Method method, const VideoConfiguration& video,
                                  std::string_view type, std::uint64_t sequence,
                                  const Observation& observation, const SourceKey& selected,
                                  const std::optional<SourceKey>& hooked, const Retirement* retirement = nullptr) {
  const bool prepared = type == "prepared", stopped = type == "stopped";
  Require(prepared || stopped || type == "ready" || type == "stats", "Unknown JSONL event type");
  Require(prepared ? sequence == 0 && observation.state == ObservationState::Prepared : sequence > 0,
          "Event sequence/state mismatch");
  Require(stopped ? observation.state == ObservationState::Stopped && retirement && RetirementComplete(*retirement) :
      retirement == nullptr, "STOPPED requires complete retirement");
  if (type == "ready") Require(observation.state == ObservationState::Running, "READY lacks running observation");
  if (type == "stats") Require(observation.state == ObservationState::Prepared ||
      observation.state == ObservationState::Running, "STATS is outside prepared/running");
  if (hooked) ValidateHookEvidence(selected, *hooked);
  Require(!observation.sourceAttached || hooked.has_value(), "Attached source lacks observed get_hooked tuple");
  if (prepared) Require(!hooked, "PREPARED cannot invent hooked evidence");
  auto result = CommonJson(common, type, sequence) + ",\"configuration\":" + ConfigurationJson(method, video) +
      ",\"observation\":" + ObservationJson(observation, common.qpc) + ",\"sourceKey\":" + KeyJson(selected) +
      ",\"hookedKey\":" + (hooked ? KeyJson(*hooked) : "null");
  if (stopped) {
    result += ",\"retirement\":" + RetirementJson(*retirement);
  }
  return FinishLine(std::move(result));
}

inline std::string SerializeError(const Common& common, Method method, const VideoConfiguration& video, std::uint64_t sequence,
                                  const Observation& observation, const SourceKey& selected,
                                  const std::optional<SourceKey>& hooked, std::string_view code, std::string_view message,
                                  const Retirement& retirement) {
  Require(observation.state == ObservationState::Failed && !code.empty() && code.size() <= 96 &&
          !message.empty() && message.size() <= 1024, "Invalid bounded error envelope");
  return FinishLine(CommonJson(common, "error", sequence) + ",\"configuration\":" + ConfigurationJson(method, video) +
      ",\"observation\":" + ObservationJson(observation, common.qpc) + ",\"sourceKey\":" + KeyJson(selected) +
      ",\"hookedKey\":" + (hooked ? KeyJson(*hooked) : "null") +
      ",\"error\":{\"code\":" + JsonString(code) + ",\"message\":" + JsonString(message) + "}" +
      ",\"retirement\":" + RetirementJson(retirement));
}

class OutputBudget {
 public:
  void Add(std::size_t bytes) {
    Require(bytes > 0 && bytes <= kMaxOutputLine && bytes <= kMaxSafeInteger - bytes_,
            "JSONL output line/counter exceeded its bound", "ERR_SCREEN_CAPTURE_STDOUT_LIMIT");
    bytes_ += bytes;
  }
  std::size_t Bytes() const { return bytes_; }
 private:
  std::size_t bytes_ = 0;
};

}  // namespace monky::screen_capture
