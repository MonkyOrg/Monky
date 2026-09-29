#include "av1Encoder.h"
#include "../rtc/inputs/abi/monky_av1.h"
#include <algorithm>
#include <cstdio>
#include <dlfcn.h>
#include <filesystem>
#include <mach-o/dyld.h>
#include <thread>

namespace monky::screen::mac {
namespace {
void Check(bool valid, const char* code, const char* detail = "") {
  if (valid) return;
  std::fprintf(stderr, "[NativeAV1] %s: %s\n", code, detail ? detail : "");
  throw VideoError(code, 0);
}
template <typename Function> Function Symbol(void* library, const char* name) {
  const auto symbol = dlsym(library, name);
  Check(symbol != nullptr, "ERR_MAC_AV1_RUNTIME", dlerror());
  return reinterpret_cast<Function>(symbol);
}
}
struct Av1Encoder::State {
  void* library = nullptr;
  void* encoder = nullptr;
  decltype(&MonkyAv1Destroy) destroy = nullptr;
  decltype(&MonkyAv1EncodeNv12) encode = nullptr;
  decltype(&MonkyAv1RequestKeyframe) keyframe = nullptr;
  decltype(&MonkyAv1SetBitrate) bitrate = nullptr;
  decltype(&MonkyAv1Validate) validate = nullptr;
  EncoderOptions options;
  int64_t sequence = 0;
  ~State() {
    if (encoder) destroy(encoder);
    if (library && dlclose(library) != 0) std::terminate();
  }
};
Av1Encoder::Av1Encoder(EncoderOptions options) : state_(std::make_unique<State>()) {
  auto& self = *state_;
  Check(!options.hardware, "ERR_MAC_AV1_HARDWARE_UNSUPPORTED");
  self.options = options;
  uint32_t length = 0;
  _NSGetExecutablePath(nullptr, &length);
  Check(length > 0, "ERR_MAC_AV1_RUNTIME_PATH");
  std::vector<char> executable(length);
  Check(_NSGetExecutablePath(executable.data(), &length) == 0, "ERR_MAC_AV1_RUNTIME_PATH");
  const auto filename = std::filesystem::canonical(executable.data()).parent_path() / "libmonky_av1.dylib";
  self.library = dlopen(filename.c_str(), RTLD_NOW | RTLD_LOCAL);
  Check(self.library != nullptr, "ERR_MAC_AV1_RUNTIME", dlerror());
  self.destroy = Symbol<decltype(self.destroy)>(self.library, "MonkyAv1Destroy");
  self.encode = Symbol<decltype(self.encode)>(self.library, "MonkyAv1EncodeNv12");
  self.keyframe = Symbol<decltype(self.keyframe)>(self.library, "MonkyAv1RequestKeyframe");
  self.bitrate = Symbol<decltype(self.bitrate)>(self.library, "MonkyAv1SetBitrate");
  self.validate = Symbol<decltype(self.validate)>(self.library, "MonkyAv1Validate");
  const auto create = Symbol<decltype(&MonkyAv1Create)>(self.library, "MonkyAv1Create");
  const MonkyAv1Config config{static_cast<uint32_t>(options.width), static_cast<uint32_t>(options.height),
    static_cast<uint32_t>(options.fps), static_cast<uint32_t>(options.bitrate_kbps),
    std::clamp(std::thread::hardware_concurrency(), 1u, 16u)};
  char error[512]{};
  self.encoder = create(&config, error, sizeof(error));
  Check(self.encoder != nullptr, "ERR_MAC_AV1_INITIALIZATION", error);
}
Av1Encoder::~Av1Encoder() = default;
EncodedFrame Av1Encoder::Encode(CVPixelBufferRef buffer, int64_t timestamp_us, int64_t duration_us, bool keyframe) {
  auto& self = *state_;
  Check(self.encoder != nullptr, "ERR_MAC_VIDEO_CLOSED");
  char error[512]{};
  if (keyframe) Check(self.keyframe(self.encoder, error, sizeof(error)), "ERR_MAC_AV1_KEYFRAME", error);
  Check(CVPixelBufferLockBaseAddress(buffer, kCVPixelBufferLock_ReadOnly) == kCVReturnSuccess,
    "ERR_MAC_AV1_PIXEL_LOCK");
  struct Unlock {
    CVPixelBufferRef buffer;
    ~Unlock() {
      if (CVPixelBufferUnlockBaseAddress(buffer, kCVPixelBufferLock_ReadOnly) != kCVReturnSuccess)
        std::terminate();
    }
  } unlock{buffer};
  const uint8_t* planes[2]{};
  uint32_t strides[2]{};
  Check(CVPixelBufferGetPlaneCount(buffer) == 2, "ERR_MAC_AV1_PLANES");
  for (size_t plane = 0; plane < 2; ++plane) {
    const auto stride = CVPixelBufferGetBytesPerRowOfPlane(buffer, plane);
    Check(stride >= static_cast<size_t>(self.options.width) && stride <= 65536, "ERR_MAC_AV1_STRIDE");
    planes[plane] = static_cast<const uint8_t*>(CVPixelBufferGetBaseAddressOfPlane(buffer, plane));
    strides[plane] = static_cast<uint32_t>(stride);
  }
  MonkyAv1Packet packet{};
  // libaom's timebase is frame ticks; RTP retains the original Mach capture clock.
  Check(self.encode(self.encoder, planes, strides, self.sequence, &packet, error, sizeof(error)),
    "ERR_MAC_AV1_ENCODE", error);
  Check(packet.data && packet.bytes && packet.bytes <= 4 * 1024 * 1024 && packet.pts == self.sequence &&
    (!keyframe || packet.keyframe), "ERR_MAC_AV1_OUTPUT");
  if (packet.keyframe)
    Check(self.validate(packet.data, packet.bytes, self.options.width, self.options.height, error, sizeof(error)),
      "ERR_MAC_AV1_SEQUENCE", error);
  ++self.sequence;
  return {{packet.data, packet.data + packet.bytes}, timestamp_us, duration_us, packet.keyframe != 0};
}
void Av1Encoder::SetBitrate(int bitrate_kbps) {
  char error[512]{};
  Check(state_->encoder != nullptr, "ERR_MAC_VIDEO_CLOSED");
  Check(state_->bitrate(state_->encoder, bitrate_kbps, error, sizeof(error)), "ERR_MAC_AV1_BITRATE", error);
}
void Av1Encoder::Close() {
  if (state_->encoder) { state_->destroy(state_->encoder); state_->encoder = nullptr; }
}
}
