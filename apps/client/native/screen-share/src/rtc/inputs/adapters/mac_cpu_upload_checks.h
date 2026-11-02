#pragma once

// The macOS upload of software-decoded (AV1) frames, through the path every received frame takes in the engine.
// Before #825 an odd render size, which Windows trims to even, closed the engine and with it the screen and its audio.

#include "mac_rtc_adapters.h"
#include "receive_frame_policy.h"

#include "api/video/i420_buffer.h"
#include "api/video/nv12_buffer.h"

#include <chrono>
#include <optional>
#include <utility>

namespace monky::native_rtc::mac {

template <typename Check>
void RunCpuUploadChecks(Check check) {
  const auto frame = [](webrtc::scoped_refptr<webrtc::VideoFrameBuffer> buffer) {
    return webrtc::VideoFrame::Builder().set_video_frame_buffer(std::move(buffer)).set_timestamp_us(1).build();
  };
  const auto i420 = [&](int width, int height) {
    auto buffer = webrtc::I420Buffer::Create(width, height);
    webrtc::I420Buffer::SetBlack(buffer.get());
    return frame(buffer);
  };
  const auto refusal = [](const webrtc::VideoFrame& input) -> std::optional<MonkyEngineStatus> {
    try { (void)UploadCpuFrame(input); }
    catch (const engine::Error& error) { return error.status; }
    return std::nullopt;
  };

  const auto even = UploadCpuFrame(i420(1920, 1080));
  check(even && CVPixelBufferGetWidth(even->pixel) == 1920 && CVPixelBufferGetHeight(even->pixel) == 1080 &&
        CVPixelBufferGetPixelFormatType(even->pixel) == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange &&
        CVPixelBufferGetIOSurface(even->pixel), "An even AV1 frame was not uploaded as an NV12 IOSurface");
  const auto odd = UploadCpuFrame(i420(1919, 1079));
  check(odd && CVPixelBufferGetWidth(odd->pixel) == 1918 && CVPixelBufferGetHeight(odd->pixel) == 1078,
        "An odd AV1 render size must lose its last column and row on macOS too, not the frame");
  check(refusal(i420(3, 2)) == MONKY_ENGINE_UNSUPPORTED && refusal(i420(3842, 2160)) == MONKY_ENGINE_UNSUPPORTED,
        "An unpresentable AV1 size must be refused as an engine Error, not an adapter exception");
  check(refusal(frame(webrtc::NV12Buffer::Create(64, 64))) == MONKY_ENGINE_UNSUPPORTED,
        "A non-I420 software frame must be refused as an engine Error");

  // ReceiveFrame admits each frame like this: only an engine Error drops the frame instead of closing the engine.
  int reports = 0, closes = 0, failures = 0;
  engine::ReceivedFrameFailures receiving({[&](const engine::FrameRoute&, const engine::Error&) { ++reports; },
                                           [&](const engine::Error&) { ++closes; }, [&] { ++failures; }});
  const engine::FrameRoute route{7, 3, 1};
  const auto now = std::chrono::steady_clock::now();
  receiving.Admit(route, now, [&] { (void)UploadCpuFrame(i420(1919, 1079)); receiving.Presented(); });
  receiving.Admit(route, now, [&] { (void)UploadCpuFrame(i420(3, 2)); });
  check(reports == 1 && !closes && !failures && receiving.Rejected() == 1,
        "A refused AV1 frame closed the macOS engine instead of being dropped and reported");
}

}  // namespace monky::native_rtc::mac
