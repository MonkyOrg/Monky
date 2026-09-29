#pragma once
#include "videoEncoder.h"

namespace monky::screen::mac {
class VideoScaler {
 public:
  VideoScaler(int width, int height, bool preserve_aspect_ratio);
  ~VideoScaler();
  VideoScaler(const VideoScaler&) = delete;
  VideoScaler& operator=(const VideoScaler&) = delete;
  CVPixelBufferRef Render(CVPixelBufferRef input, CGRect content) CF_RETURNS_RETAINED;
 private:
  struct State;
  std::unique_ptr<State> state_;
};
}
