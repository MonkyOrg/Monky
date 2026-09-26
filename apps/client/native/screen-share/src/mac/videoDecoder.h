#pragma once
#include "videoEncoder.h"
#include <span>

namespace monky::screen::mac {
class VideoDecoder {
 public:
  // The borrowed CoreVideo image is valid only during the callback.
  using Output = std::function<void(CVPixelBufferRef, int64_t)>;
  VideoDecoder(int width, int height, Output output, VideoEncoder::Failure failure);
  ~VideoDecoder();
  VideoDecoder(const VideoDecoder&) = delete;
  VideoDecoder& operator=(const VideoDecoder&) = delete;
  void Submit(const EncodedFrame& frame);
  void Close();
 private:
  struct State;
  std::unique_ptr<State> state_;
};
size_t VideoDecoderSmoke(const std::vector<EncodedFrame>& frames);
}
