#pragma once

#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <Foundation/Foundation.h>
#include <cstdint>
#include <functional>
#include <memory>
#include <vector>

namespace monky::screen::mac {
struct EncodedFrame {
  std::vector<uint8_t> bytes;
  int64_t timestamp_us = 0, duration_us = 0;
  bool keyframe = false;
};
struct EncoderOptions {
  int width = 0, height = 0, fps = 0, bitrate_kbps = 0;
  bool hardware = false;
};
class VideoEncoder {
 public:
  using Output = std::function<void(EncodedFrame)>;
  using Failure = std::function<void(const char*, OSStatus)>;
  VideoEncoder(EncoderOptions options, Output output, Failure failure);
  ~VideoEncoder();
  VideoEncoder(const VideoEncoder&) = delete;
  VideoEncoder& operator=(const VideoEncoder&) = delete;
  void Submit(CVPixelBufferRef buffer, CMTime timestamp, CMTime duration);
  void SetBitrate(int bitrate_kbps);
  void RequestKeyframe();
  void Close();
  bool Hardware() const;
 private:
  struct State;
  std::unique_ptr<State> state_;
};
NSDictionary* VideoEncoderSmoke(bool hardware);
}
