#pragma once

#include "monky_rtc_engine.h"
#include "mf_rtc_adapters.h"
#include "frame_route.h"

#include "api\peer_connection_interface.h"
#include "api\video\video_frame.h"
#include "rtc_base\thread.h"
#include "json.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <functional>
#include <memory>
#include <stdexcept>
#include <string>
#include <string_view>

namespace monky::native_rtc::engine {

using Json = nlohmann::json;
constexpr std::uint64_t kMaxId = 9007199254740991ull;
constexpr std::size_t kMaxJson = 1024 * 1024;

class Error : public std::runtime_error {
 public:
  Error(std::string code, std::string message, MonkyEngineStatus status = MONKY_ENGINE_FAILURE,
        HRESULT hr = S_OK)
      : std::runtime_error(std::move(message)), code(std::move(code)), status(status), hr(hr) {}
  std::string code;
  MonkyEngineStatus status;
  HRESULT hr;
};

struct Cancellation {
  std::uint64_t request_id = 0, target = 0;
  std::atomic<bool> cancelled{false};
  // Only the host operation mutex reads/writes this completion linearization flag.
  bool committed = false;
  bool closes_resource = false;
  std::chrono::steady_clock::time_point deadline;
  void Check() const {
    if (cancelled.load()) throw Error("ERR_RTC_CANCELLED", "Operation was cancelled", MONKY_ENGINE_CANCELLED);
    if (std::chrono::steady_clock::now() >= deadline)
      throw Error("ERR_RTC_TIMEOUT", "Operation deadline expired", MONKY_ENGINE_TIMEOUT);
  }
};

class VideoSource;
class CaptureClock;
namespace audio { class AudioSource; }
class Host {
 public:
  virtual ~Host() = default;
  virtual std::uint64_t AllocateHandle() = 0;
  virtual void RegisterResource(std::uint64_t id, std::uint64_t parent = 0,
                                std::uint64_t source = 0) = 0;
  virtual void ForgetResource(std::uint64_t id) noexcept = 0;
  virtual std::uint32_t MaxResources() const = 0;
  virtual std::chrono::milliseconds Timeout() const = 0;
  virtual webrtc::scoped_refptr<webrtc::PeerConnectionFactoryInterface> Factory() const = 0;
  virtual webrtc::Thread* SignalingThread() const = 0;
  virtual std::shared_ptr<mf::NativeRtcContext> MfContext() const = 0;
  virtual std::shared_ptr<CaptureClock> CaptureTimebase() const = 0;
  virtual std::shared_ptr<VideoSource> FindSource(std::uint64_t id) const = 0;
  virtual std::shared_ptr<audio::AudioSource> FindAudioSource(std::uint64_t id) const = 0;
  virtual bool AudioOutputReady(std::uint64_t expected_epoch = 0) const = 0;
  // Event data is always nested under data; target and type are added by Host.
  virtual bool Emit(std::string_view type, std::uint64_t target, Json data) noexcept = 0;
  virtual Json RequestServer(std::string_view method, std::uint64_t target, Json data,
                             const std::shared_ptr<Cancellation>& cancellation) = 0;
  virtual void ActivateReceiveRoute(const FrameRoute& route) = 0;
  virtual void RetireReceiveRoute(const FrameRoute& route) noexcept = 0;
  virtual void ReceiveFrame(const FrameRoute& route, const webrtc::VideoFrame& frame) noexcept = 0;
};

struct InputFrame {
  HANDLE texture = nullptr;
  std::uint64_t id = 0;
  std::int64_t timestamp_us = 0, duration_us = 0, ntp_time_ms = -1;
  ~InputFrame() { if (texture) CloseHandle(texture); }
  InputFrame() = default;
  InputFrame(const InputFrame&) = delete;
  InputFrame& operator=(const InputFrame&) = delete;
};

class VideoSource {
 public:
  virtual ~VideoSource() = default;
  virtual webrtc::scoped_refptr<webrtc::VideoTrackSourceInterface> TrackSource() const = 0;
  virtual const std::string& SyncGroup() const = 0;
  virtual bool Enabled() const = 0;
  virtual void SetEnabled(bool enabled) = 0;
  virtual bool AcceptsSendCodec(const webrtc::SdpVideoFormat&) const { return true; }
  virtual void Submit(std::shared_ptr<InputFrame>) {
    throw Error("ERR_RTC_INPUT_MODE", "This source does not accept raw GPU frames", MONKY_ENGINE_UNSUPPORTED);
  }
  virtual void SubmitEncoded(const MonkyEngineEncodedFrame&) {
    throw Error("ERR_RTC_INPUT_MODE", "This source does not accept externally encoded H264", MONKY_ENGINE_UNSUPPORTED);
  }
  virtual void Close() = 0;
  virtual Json Snapshot() const = 0;
};
std::shared_ptr<VideoSource> CreateGpuSource(
    Host& host, std::uint64_t id, const Json& options, const std::shared_ptr<Cancellation>& cancellation);

class PeerController {
 public:
  virtual ~PeerController() = default;
  virtual Json Execute(std::string_view operation, std::uint64_t target, const Json& data,
                       const std::shared_ptr<Cancellation>& cancellation) = 0;
  virtual bool Contains(std::uint64_t target) const = 0;
  virtual bool UsesSource(std::uint64_t source) const = 0;
  virtual void SourceEnabledChanged(std::uint64_t source) = 0;
  virtual void Close(std::uint64_t target) = 0;
  virtual void CloseAll() = 0;
  virtual Json Snapshot() const = 0;
};
std::unique_ptr<PeerController> CreatePeerController(Host& host);

class SfuController {
 public:
  virtual ~SfuController() = default;
  virtual Json Execute(std::string_view operation, std::uint64_t target, const Json& data,
                       const std::shared_ptr<Cancellation>& cancellation) = 0;
  virtual bool Contains(std::uint64_t target) const = 0;
  virtual bool UsesSource(std::uint64_t source) const = 0;
  virtual void SourceEnabledChanged(std::uint64_t source) = 0;
  virtual void Close(std::uint64_t target) = 0;
  virtual void CloseAll() = 0;
  virtual Json Snapshot() const = 0;
};
std::unique_ptr<SfuController> CreateSfuController(Host& host);

inline std::string Text(const Json& data, const char* key, std::size_t maximum = 512) {
  if (!data.is_object() || !data.contains(key) || !data.at(key).is_string())
    throw Error("ERR_RTC_ARGUMENT", std::string("Missing string: ") + key, MONKY_ENGINE_INVALID);
  auto result = data.at(key).get<std::string>();
  if (result.empty() || result.size() > maximum || result.find('\0') != std::string::npos)
    throw Error("ERR_RTC_ARGUMENT", std::string("Invalid bounded string: ") + key, MONKY_ENGINE_INVALID);
  return result;
}
inline std::string SyncGroup(const Json& data) {
  auto result = Text(data, "syncGroup", 128);
  if (!std::all_of(result.begin(), result.end(), [](unsigned char c) {
        return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
               (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == ':';
      }))
    throw Error("ERR_RTC_ARGUMENT", "syncGroup must be an SDP-safe stream identifier",
                MONKY_ENGINE_INVALID);
  return result;
}
inline std::uint64_t Id(const Json& data, const char* key) {
  if (!data.contains(key) || !data.at(key).is_number_unsigned())
    throw Error("ERR_RTC_ARGUMENT", std::string("Missing positive identifier: ") + key, MONKY_ENGINE_INVALID);
  auto value = data.at(key).get<std::uint64_t>();
  if (!value || value > kMaxId)
    throw Error("ERR_RTC_ARGUMENT", "Identifier is outside its safe range", MONKY_ENGINE_INVALID);
  return value;
}
inline bool Boolean(const Json& data, const char* key, bool fallback = false) {
  if (!data.contains(key)) return fallback;
  if (!data.at(key).is_boolean())
    throw Error("ERR_RTC_ARGUMENT", std::string("Expected boolean: ") + key, MONKY_ENGINE_INVALID);
  return data.at(key).get<bool>();
}

}  // namespace monky::native_rtc::engine
