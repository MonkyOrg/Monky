#include "../src/rtc/inputs/abi/monky_av1.h"
#include <cstdio>
#include <memory>
#include <stdexcept>
#include <vector>

namespace {
void Require(bool value, const char* message) {
  if (!value) throw std::runtime_error(message);
}
void Exercise(bool nv12) {
  constexpr uint32_t width = 320, height = 180, stride = 384;
  const MonkyAv1Config config{width, height, 30, 1000, 2};
  char error[512]{};
  std::unique_ptr<void, decltype(&MonkyAv1Destroy)> encoder(
    MonkyAv1Create(&config, error, sizeof(error)), &MonkyAv1Destroy);
  Require(encoder != nullptr, error);
  std::vector<uint8_t> y(stride * height, 80), uv(stride * height / 2, 128);
  const uint8_t* planes[]{y.data(), uv.data(), uv.data()};
  const uint32_t strides[]{stride, stride, stride};
  MonkyAv1Packet packet{};
  for (int64_t frame = 0; frame < 8; ++frame) {
    if (frame == 3) {
      Require(MonkyAv1SetBitrate(encoder.get(), 500, error, sizeof(error)), error);
      Require(MonkyAv1RequestKeyframe(encoder.get(), error, sizeof(error)), error);
    }
    const auto result = nv12
      ? MonkyAv1EncodeNv12(encoder.get(), planes, strides, frame, &packet, error, sizeof(error))
      : MonkyAv1Encode(encoder.get(), planes, strides, frame, &packet, error, sizeof(error));
    Require(result, error);
    Require(packet.data && packet.bytes && packet.pts == frame, "Zero-lag AV1 frame identity changed.");
    Require(packet.keyframe == (frame == 0 || frame == 3), "AV1 keyframe request was lost or remained sticky.");
    if (packet.keyframe)
      Require(MonkyAv1Validate(packet.data, packet.bytes, width, height, error, sizeof(error)), error);
  }
  const uint32_t invalid[]{width - 1, stride, stride};
  Require(!MonkyAv1EncodeNv12(encoder.get(), planes, invalid, 8, &packet, error, sizeof(error)),
    "AV1 accepted an undersized NV12 row.");
  Require(!MonkyAv1SetBitrate(encoder.get(), 0, error, sizeof(error)), "AV1 accepted an invalid bitrate.");
}
}
int main() {
  try {
    Exercise(false);
    Exercise(true);
    char error[512]{};
    Require(!MonkyAv1RequestKeyframe(nullptr, error, sizeof(error)), "AV1 accepted a missing owner.");
    std::puts("{\"passed\":true,\"i420Frames\":8,\"nv12Frames\":8,\"forcedKeyframes\":true,\"dependentFrames\":true,\"paddedStrides\":true,\"bitrateChange\":true}");
    return 0;
  } catch (const std::exception& error) {
    std::fprintf(stderr, "AV1 ABI regression: %s\n", error.what());
    return 1;
  }
}
