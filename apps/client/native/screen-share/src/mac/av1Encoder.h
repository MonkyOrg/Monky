#pragma once
#include "videoEncoder.h"

namespace monky::screen::mac {
class Av1Encoder {
 public:
  explicit Av1Encoder(EncoderOptions options);
  ~Av1Encoder();
  Av1Encoder(const Av1Encoder&) = delete;
  Av1Encoder& operator=(const Av1Encoder&) = delete;
  EncodedFrame Encode(CVPixelBufferRef buffer, int64_t timestamp_us, int64_t duration_us, bool keyframe);
  void SetBitrate(int bitrate_kbps);
  void Close();
 private:
  struct State;
  std::unique_ptr<State> state_;
};
}
