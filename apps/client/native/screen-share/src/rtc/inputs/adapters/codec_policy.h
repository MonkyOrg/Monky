#pragma once

#include "encoder_config.h"
#include "api/video/color_space.h"
#include "api/video_codecs/video_encoder.h"
#include "api/video_codecs/sdp_video_format.h"
#include "modules/video_coding/include/video_error_codes.h"

#include <cstdint>
#include <atomic>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <thread>
#include <utility>
#include <vector>

namespace monky::native_rtc::codec_policy {
class AdapterError : public std::runtime_error {
 public:
  AdapterError(const char* code, const char* message,
               std::int32_t status = WEBRTC_VIDEO_CODEC_ERR_PARAMETER,
               std::int32_t hr = 0)
      : std::runtime_error(message), code(code), status(status), hresult(hr) {}
  const char* code;
  std::int32_t status;
  std::int32_t hresult;
};

template <typename Callback>
class CallbackGate {
 public:
  void Register(Callback* callback) {
    std::lock_guard lock(mutex_);
    callback_ = callback;
  }
  void Clear() {
    std::lock_guard lock(mutex_);
    active_ = false;
    callback_ = nullptr;
  }
  std::uint64_t Activate() {
    std::lock_guard lock(mutex_);
    if (++generation_ == 0)
      throw AdapterError("ERR_RTC_CALLBACK_GENERATION", "Callback generation exhausted");
    active_ = true;
    return generation_;
  }
  void Deactivate(std::uint64_t generation) {
    std::lock_guard lock(mutex_);
    if (generation == generation_) active_ = false;
  }
  bool HasCallback(std::uint64_t generation) const {
    std::lock_guard lock(mutex_);
    return active_ && generation == generation_ && callback_;
  }
  bool IsInvokingOnCurrentThread() const {
    return invoking_thread_.load() == std::this_thread::get_id();
  }
  template <typename Function>
  void Synchronize(Function&& function) {
    std::lock_guard lock(mutex_);
    std::forward<Function>(function)();
  }
  template <typename Function>
  bool Invoke(std::uint64_t generation, Function&& function) {
    std::lock_guard lock(mutex_);
    if (!active_ || generation != generation_ || !callback_) return false;
    const auto previous = invoking_thread_.exchange(std::this_thread::get_id());
    struct Restore {
      std::atomic<std::thread::id>& thread;
      std::thread::id previous;
      ~Restore() { thread.store(previous); }
    } restore{invoking_thread_, previous};
    std::forward<Function>(function)(*callback_);
    return true;
  }
 private:
  mutable std::recursive_mutex mutex_;
  Callback* callback_ = nullptr;
  std::atomic<std::thread::id> invoking_thread_{std::thread::id{}};
  std::uint64_t generation_ = 0;
  bool active_ = false;
};

struct NegotiatedH264 {
  screen_video::H264Profile profile;
  std::uint8_t level;
};
bool IsSupportedLevel(std::uint8_t level);
std::optional<NegotiatedH264> ParseFormat(const webrtc::SdpVideoFormat&, std::uint8_t maximum_level);
std::vector<webrtc::SdpVideoFormat> SupportedFormats(std::uint8_t maximum_level);
webrtc::ColorSpace Bt709Limited();
bool IsBt709Limited(const webrtc::ColorSpace&);

struct EncoderSetup {
  screen_video::EncoderConfig core;
  std::uint32_t initial_bitrate = 0;
  std::uint32_t maximum_bitrate = 0;
  std::uint32_t keyframe_interval = 0;
  webrtc::VideoContentType content_type = webrtc::VideoContentType::UNSPECIFIED;
};
EncoderSetup MakeEncoderSetup(const webrtc::VideoCodec&, const webrtc::VideoEncoder::Settings&,
                             NegotiatedH264, std::uint32_t maximum_in_flight);
}
