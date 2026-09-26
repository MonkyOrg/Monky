#include "videoDecoder.h"
#include "../rtc/inputs/native_core/h264_bitstream.h"
#import <VideoToolbox/VideoToolbox.h>
#include <atomic>
#include <cmath>
#include <cstring>
#include <mutex>
#include <stdexcept>
#include <string>

namespace monky::screen::mac {
namespace {
void Check(OSStatus status, const char* code) {
  if (status != noErr) throw std::runtime_error(std::string(code) + " nativeStatus=" + std::to_string(status));
}
void Require(bool valid, const char* code) { if (!valid) throw std::runtime_error(code); }
std::vector<std::span<const uint8_t>> Nals(const std::vector<uint8_t>& bytes) {
  std::vector<std::span<const uint8_t>> result;
  const auto prefix = [&](size_t at) -> size_t {
    if (at + 3 > bytes.size() || bytes[at] || bytes[at + 1]) return 0;
    if (bytes[at + 2] == 1) return 3;
    return at + 4 <= bytes.size() && bytes[at + 2] == 0 && bytes[at + 3] == 1 ? 4 : 0;
  };
  size_t at = 0;
  while (at < bytes.size()) {
    const auto start = prefix(at);
    Require(start > 0, "ERR_MAC_DECODE_NAL");
    at += start;
    size_t end = at;
    while (end < bytes.size() && !prefix(end)) ++end;
    Require(end > at && result.size() < 4096, "ERR_MAC_DECODE_NAL");
    result.emplace_back(bytes.data() + at, end - at);
    at = end;
  }
  return result;
}
}

struct VideoDecoder::State {
  int width, height;
  Output output;
  VideoEncoder::Failure failure;
  CMVideoFormatDescriptionRef format = nullptr;
  VTDecompressionSessionRef session = nullptr;
  std::atomic<bool> failed{false};
  std::atomic<size_t> pending{0}, callbacks{0};
  screen_video::H264Bitstream bitstream;
  std::vector<uint8_t> sps, pps;
  int64_t previous_timestamp = -1;
  bool closed = false;
  State(int w, int h, Output result, VideoEncoder::Failure error)
      : width(w), height(h), output(std::move(result)), failure(std::move(error)),
        bitstream(w, h, 60, screen_video::H264Profile::AnySupported,
          screen_video::H264LevelPolicy::Maximum) {}
  void Report(const char* code, OSStatus status) noexcept {
    if (failed.exchange(true)) return;
    try { failure(code, status); } catch (...) { std::terminate(); }
  }
  static void Receive(void* owner, void*, OSStatus status, VTDecodeInfoFlags flags,
      CVImageBufferRef image, CMTime timestamp, CMTime) noexcept {
    auto& self = *static_cast<State*>(owner);
    ++self.callbacks;
    try {
      if (status != noErr) self.Report("ERR_MAC_DECODE_FRAME", status);
      else {
        Require(!(flags & kVTDecodeInfo_FrameDropped) && image &&
            CVPixelBufferGetWidth(image) == static_cast<size_t>(self.width) &&
            CVPixelBufferGetHeight(image) == static_cast<size_t>(self.height) &&
            CVPixelBufferGetPixelFormatType(image) == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange &&
            CMTIME_IS_NUMERIC(timestamp), "ERR_MAC_DECODE_OUTPUT");
        const auto pts = CMTimeConvertScale(timestamp, 1000000, kCMTimeRoundingMethod_RoundTowardZero);
        Require(pts.value >= 0 && pts.value <= 9007199254740991LL, "ERR_MAC_DECODE_TIMESTAMP");
        if (!self.failed.load()) self.output(image, pts.value);
      }
    } catch (...) { self.Report("ERR_MAC_DECODE_CALLBACK", status); }
    if (self.pending.fetch_sub(1) == 0) std::terminate();
    --self.callbacks;
  }
  void CreateFormat() {
    Require(!sps.empty() && !pps.empty() && !session, "ERR_MAC_DECODE_PARAMETER_SETS");
    const uint8_t* parameters[] = {sps.data(), pps.data()};
    const size_t sizes[] = {sps.size(), pps.size()};
    Check(CMVideoFormatDescriptionCreateFromH264ParameterSets(kCFAllocatorDefault, 2, parameters,
        sizes, 4, &format), "ERR_MAC_DECODE_FORMAT");
    NSDictionary* attributes = @{
      (__bridge NSString*)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange),
      (__bridge NSString*)kCVPixelBufferIOSurfacePropertiesKey: @{},
      (__bridge NSString*)kCVPixelBufferMetalCompatibilityKey: @YES,
    };
    VTDecompressionOutputCallbackRecord callback{&State::Receive, this};
    Check(VTDecompressionSessionCreate(kCFAllocatorDefault, format, nullptr,
        (__bridge CFDictionaryRef)attributes, &callback, &session), "ERR_MAC_DECODE_SESSION");
  }
};
VideoDecoder::VideoDecoder(int width, int height, Output output, VideoEncoder::Failure failure)
    : state_(std::make_unique<State>(width, height, std::move(output), std::move(failure))) {
  Require(width >= 4 && width <= 3840 && height >= 2 && height <= 2160 &&
      state_->output && state_->failure, "ERR_MAC_DECODE_OPTIONS");
}
VideoDecoder::~VideoDecoder() {
  try { Close(); } catch (...) { std::terminate(); }
}
void VideoDecoder::Submit(const EncodedFrame& frame) {
  auto& self = *state_;
  Require(!self.closed && !self.failed.load(), "ERR_MAC_DECODE_CLOSED");
  Require(!frame.bytes.empty() && frame.bytes.size() <= 4 * 1024 * 1024 &&
      frame.timestamp_us >= 0 && frame.timestamp_us <= 9007199254740991LL &&
      frame.timestamp_us > self.previous_timestamp && frame.duration_us > 0 &&
      frame.duration_us <= 1000000 && self.pending.load() < 8, "ERR_MAC_DECODE_INPUT");
  const auto access_unit = self.bitstream.Convert(frame.bytes);
  Require(self.bitstream.Verified() && access_unit.hasPicture && access_unit.keyFrame == frame.keyframe &&
      screen_video::IsBt709LimitedCompatible(self.bitstream.Sps()), "ERR_MAC_DECODE_BITSTREAM");
  std::vector<uint8_t> payload;
  for (const auto nal : Nals(frame.bytes)) {
    const auto type = nal.front() & 31;
    if (type == 7 || type == 8) {
      auto& current = type == 7 ? self.sps : self.pps;
      if (self.session) Require(current.size() == nal.size() &&
          std::memcmp(current.data(), nal.data(), nal.size()) == 0, "ERR_MAC_DECODE_FORMAT_CHANGED");
      else current.assign(nal.begin(), nal.end());
      continue;
    }
    const auto size = static_cast<uint32_t>(nal.size());
    for (int shift : {24, 16, 8, 0}) payload.push_back(static_cast<uint8_t>(size >> shift));
    payload.insert(payload.end(), nal.begin(), nal.end());
  }
  if (!self.session) self.CreateFormat();
  CMBlockBufferRef block = nullptr;
  CMSampleBufferRef sample = nullptr;
  try {
    Check(CMBlockBufferCreateWithMemoryBlock(kCFAllocatorDefault, nullptr, payload.size(), kCFAllocatorDefault,
        nullptr, 0, payload.size(), 0, &block), "ERR_MAC_DECODE_BLOCK");
    Check(CMBlockBufferReplaceDataBytes(payload.data(), block, 0, payload.size()), "ERR_MAC_DECODE_BLOCK_COPY");
    const size_t size = payload.size();
    const CMSampleTimingInfo timing{CMTimeMake(frame.duration_us, 1000000),
      CMTimeMake(frame.timestamp_us, 1000000), kCMTimeInvalid};
    Check(CMSampleBufferCreateReady(kCFAllocatorDefault, block, self.format, 1, 1, &timing,
        1, &size, &sample), "ERR_MAC_DECODE_SAMPLE");
    ++self.pending;
    VTDecodeInfoFlags flags{};
    const auto status = VTDecompressionSessionDecodeFrame(self.session, sample,
        kVTDecodeFrame_EnableAsynchronousDecompression, nullptr, &flags);
    if (status != noErr) { self.Report("ERR_MAC_DECODE_FRAME", status); Check(status, "ERR_MAC_DECODE_FRAME"); }
    if (flags & kVTDecodeInfo_FrameDropped) {
      self.Report("ERR_MAC_DECODE_FRAME_DROPPED", 0);
      throw std::runtime_error("ERR_MAC_DECODE_FRAME_DROPPED");
    }
  } catch (...) {
    if (sample) CFRelease(sample);
    if (block) CFRelease(block);
    throw;
  }
  CFRelease(sample); CFRelease(block);
  self.previous_timestamp = frame.timestamp_us;
}
void VideoDecoder::Close() {
  auto& self = *state_;
  if (self.closed) return;
  OSStatus drain = noErr, wait = noErr;
  if (self.session) {
    drain = VTDecompressionSessionFinishDelayedFrames(self.session);
    wait = VTDecompressionSessionWaitForAsynchronousFrames(self.session);
    VTDecompressionSessionInvalidate(self.session);
    Require(self.callbacks.load() == 0, "ERR_MAC_DECODE_CALLBACKS_PENDING");
    CFRelease(self.session); self.session = nullptr;
  }
  if (self.format) { CFRelease(self.format); self.format = nullptr; }
  self.closed = true;
  if (!self.failed.load()) Require(self.pending.load() == 0, "ERR_MAC_DECODE_FRAMES_PENDING");
  self.pending = 0;
  Check(drain, "ERR_MAC_DECODE_DRAIN");
  Check(wait, "ERR_MAC_DECODE_WAIT");
}
size_t VideoDecoderSmoke(const std::vector<EncodedFrame>& frames) {
  std::mutex mutex;
  std::vector<int64_t> decoded;
  std::string failure;
  VideoDecoder decoder(320, 180, [&](CVPixelBufferRef image, int64_t timestamp) {
    Check(CVPixelBufferLockBaseAddress(image, kCVPixelBufferLock_ReadOnly), "ERR_MAC_DECODE_TEST_LOCK");
    bool valid = true;
    for (size_t plane = 0; plane < 2; ++plane) {
      const auto* data = static_cast<const uint8_t*>(CVPixelBufferGetBaseAddressOfPlane(image, plane));
      const auto stride = CVPixelBufferGetBytesPerRowOfPlane(image, plane);
      const auto height = CVPixelBufferGetHeightOfPlane(image, plane);
      const auto width = CVPixelBufferGetWidthOfPlane(image, plane);
      const int expected = plane == 0 ? 80 : 128;
      for (const size_t row : {height / 4, height / 2, height * 3 / 4})
        for (const size_t column : {width / 4, width / 2, width * 3 / 4})
          valid &= std::abs(int(data[row * stride + column]) - expected) <= 12;
    }
    Check(CVPixelBufferUnlockBaseAddress(image, kCVPixelBufferLock_ReadOnly), "ERR_MAC_DECODE_TEST_UNLOCK");
    Require(valid, "ERR_MAC_DECODE_TEST_PIXELS");
    std::lock_guard lock(mutex); decoded.push_back(timestamp);
  }, [&](const char* code, OSStatus status) {
    std::lock_guard lock(mutex); failure = std::string(code) + " nativeStatus=" + std::to_string(status);
  });
  for (const auto& frame : frames) decoder.Submit(frame);
  decoder.Close();
  Require(failure.empty(), failure.c_str());
  Require(decoded.size() == frames.size(), "ERR_MAC_DECODE_TEST_COUNT");
  for (size_t index = 0; index < decoded.size(); ++index)
    Require(decoded[index] == frames[index].timestamp_us, "ERR_MAC_DECODE_TEST_ORDER");
  return decoded.size();
}
}
