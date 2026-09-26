#pragma once
#include "videoEncoder.h"
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#include <future>

namespace monky::screen::mac {
class VideoCapture {
 public:
  VideoCapture(SCContentFilter* filter, EncoderOptions options, bool preserve_aspect_ratio,
      VideoEncoder::Output output, VideoEncoder::Failure failure,
      // Reserves one output credit on success; it is returned by the packet writer.
      std::function<bool()> writable, std::function<void()> verify_target);
  ~VideoCapture();
  VideoCapture(const VideoCapture&) = delete;
  VideoCapture& operator=(const VideoCapture&) = delete;
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
