#pragma once
#include "videoCapture.h"

namespace monky::screen::mac {
class VideoCaptureHost {
 public:
  VideoCaptureHost(SCContentFilter* filter, EncoderOptions options, bool preserve_aspect_ratio,
      std::function<void()> verify_target, VideoEncoder::Failure on_failure);
  ~VideoCaptureHost();
  std::future<void> Start();
  std::future<void> SetBitrate(int bitrate_kbps);
  std::future<void> RequestKeyframe();
  std::shared_future<void> Close();
  NSDictionary* Snapshot() const;
 private:
  struct State;
  std::shared_ptr<State> state_;
};
}
