#include "videoEncoder.h"
#include "videoDecoder.h"
#include "../rtc/inputs/native_core/h264_bitstream.h"
#import <VideoToolbox/VideoToolbox.h>
#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstring>
#include <limits>
#include <mutex>
#include <stdexcept>
#include <string>
#include <unordered_map>

namespace monky::screen::mac {
namespace {
constexpr size_t kMaximumPacket = 4 * 1024 * 1024;
struct EncoderError : std::runtime_error {
  std::string code;
  OSStatus status;
  EncoderError(const char* operation, OSStatus value)
      : std::runtime_error(std::string(operation) + " nativeStatus=" + std::to_string(value)),
        code(operation), status(value) {}
};
void Check(OSStatus status, const char* operation) {
  if (status != noErr) throw EncoderError(operation, status);
}
void Require(bool valid, const char* message) {
  if (!valid) throw EncoderError(message, 0);
}
int64_t Microseconds(CMTime time) {
  Require(CMTIME_IS_NUMERIC(time) && time.timescale > 0, "ERR_MAC_VIDEO_TIMESTAMP");
  const auto result = CMTimeConvertScale(time, 1000000, kCMTimeRoundingMethod_RoundTowardZero);
  Require(CMTIME_IS_NUMERIC(result) && result.value >= 0 &&
      result.value <= 9007199254740991LL, "ERR_MAC_VIDEO_TIMESTAMP");
  return result.value;
}
void AppendNal(std::vector<uint8_t>& bytes, const uint8_t* data, size_t size) {
  Require(data && size > 0 && size <= kMaximumPacket - 4 &&
      bytes.size() <= kMaximumPacket - size - 4, "ERR_MAC_VIDEO_PACKET_SIZE");
  constexpr uint8_t start[] = {0, 0, 0, 1};
  bytes.insert(bytes.end(), std::begin(start), std::end(start));
  bytes.insert(bytes.end(), data, data + size);
}
EncodedFrame Packet(CMSampleBufferRef sample, int64_t duration_us) {
  Require(sample && CMSampleBufferDataIsReady(sample) &&
      CMSampleBufferGetNumSamples(sample) == 1, "ERR_MAC_VIDEO_SAMPLE");
  EncodedFrame frame;
  frame.timestamp_us = Microseconds(CMSampleBufferGetPresentationTimeStamp(sample));
  frame.duration_us = duration_us;
  const auto decode = CMSampleBufferGetDecodeTimeStamp(sample);
  Require(!CMTIME_IS_NUMERIC(decode) || Microseconds(decode) == frame.timestamp_us,
      "ERR_MAC_VIDEO_FRAME_REORDERING");
  const auto format = CMSampleBufferGetFormatDescription(sample);
  Require(format && CMFormatDescriptionGetMediaSubType(format) == kCMVideoCodecType_H264,
      "ERR_MAC_VIDEO_CODEC");
  int nal_length = 0;
  size_t count = 0;
  Check(CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, 0, nullptr, nullptr,
      &count, &nal_length), "ERR_MAC_VIDEO_PARAMETER_SETS");
  Require(nal_length >= 1 && nal_length <= 4 && count >= 2 && count <= 8,
      "ERR_MAC_VIDEO_PARAMETER_SETS");
  const auto block = CMSampleBufferGetDataBuffer(sample);
  Require(block != nullptr, "ERR_MAC_VIDEO_BLOCK");
  const size_t size = CMBlockBufferGetDataLength(block);
  Require(size > 0 && size <= kMaximumPacket, "ERR_MAC_VIDEO_PACKET_SIZE");
  std::vector<uint8_t> data(size);
  Check(CMBlockBufferCopyDataBytes(block, 0, size, data.data()), "ERR_MAC_VIDEO_BLOCK");
  std::vector<std::pair<size_t, size_t>> nals;
  size_t at = 0;
  while (at < size) {
    Require(size - at >= static_cast<size_t>(nal_length), "ERR_MAC_VIDEO_NAL");
    uint32_t bytes = 0;
    for (int i = 0; i < nal_length; ++i) bytes = (bytes << 8) | data[at++];
    Require(bytes && bytes <= size - at && nals.size() < 4096, "ERR_MAC_VIDEO_NAL");
    frame.keyframe |= (data[at] & 31) == 5;
    nals.emplace_back(at, bytes);
    at += bytes;
  }
  // Decoder configuration is taken from this actual output sample, not an
  // encoder setting or pre-frame placeholder.
  if (frame.keyframe) {
    for (size_t index = 0; index < count; ++index) {
      const uint8_t* parameter = nullptr;
      size_t bytes = 0;
      Check(CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, index, &parameter,
          &bytes, nullptr, nullptr), "ERR_MAC_VIDEO_PARAMETER_SETS");
      AppendNal(frame.bytes, parameter, bytes);
    }
  }
  for (const auto& [offset, bytes] : nals) AppendNal(frame.bytes, data.data() + offset, bytes);
  return frame;
}
}

struct VideoEncoder::State {
  EncoderOptions options;
  Output output;
  Failure failure;
  VTCompressionSessionRef session = nullptr;
  std::mutex pending_mutex;
  std::unordered_map<uintptr_t, int64_t> pending;
  uintptr_t next_frame = 0;
  std::atomic<size_t> active_callbacks{0};
  std::atomic<bool> failed{false};
  std::mutex output_mutex;
  std::unique_ptr<screen_video::H264Bitstream> bitstream;
  bool hardware = false, keyframe = true, closed = false;
  int64_t last_timestamp = -1;

  void Report(const char* code, OSStatus status) noexcept {
    if (failed.exchange(true)) return;
    try { failure(code, status); } catch (...) { std::terminate(); }
  }
  void Property(CFStringRef name, CFTypeRef value) {
    Check(VTSessionSetProperty(session, name, value), "ERR_MAC_VIDEO_PROPERTY");
  }
  void Integer(CFStringRef name, int value) {
    Property(name, (__bridge CFNumberRef)@(value));
  }
  static void Receive(void* owner, void* context, OSStatus status, VTEncodeInfoFlags flags,
                      CMSampleBufferRef sample) noexcept {
    auto& self = *static_cast<State*>(owner);
    ++self.active_callbacks;
    const auto id = reinterpret_cast<uintptr_t>(context);
    try {
      int64_t duration;
      {
        std::lock_guard lock(self.pending_mutex);
        const auto found = self.pending.find(id);
        Require(found != self.pending.end(), "ERR_MAC_VIDEO_CALLBACK_IDENTITY");
        duration = found->second;
      }
      Check(status, "ERR_MAC_VIDEO_ENCODE");
      Require(!(flags & kVTEncodeInfo_FrameDropped), "ERR_MAC_VIDEO_FRAME_DROPPED");
      if (!self.failed.load()) {
        auto frame = Packet(sample, duration);
        std::lock_guard lock(self.output_mutex);
        const auto unit = self.bitstream->Convert(frame.bytes);
        Require(unit.hasPicture && unit.keyFrame == frame.keyframe &&
            self.bitstream->Verified() && screen_video::IsBt709LimitedCompatible(self.bitstream->Sps()),
            "ERR_MAC_VIDEO_BITSTREAM");
        self.output(std::move(frame));
      }
    } catch (const EncoderError& error) { self.Report(error.code.c_str(), error.status); }
    catch (...) { self.Report("ERR_MAC_VIDEO_CALLBACK", 0); }
    { std::lock_guard lock(self.pending_mutex); self.pending.erase(id); }
    --self.active_callbacks;
  }
};

VideoEncoder::VideoEncoder(EncoderOptions options, Output output, Failure failure)
    : state_(std::make_unique<State>()) {
  auto& self = *state_;
  Require(options.width >= 4 && options.width <= 3840 && options.width % 4 == 0 &&
      options.height >= 2 && options.height <= 2160 && options.height % 2 == 0 &&
      options.fps >= 1 && options.fps <= (options.width == 3840 || options.height == 2160 ? 120 : 240) &&
      options.bitrate_kbps >= 50 && options.bitrate_kbps <= 80000 &&
      options.bitrate_kbps % 50 == 0 && output && failure, "ERR_MAC_VIDEO_OPTIONS");
  self.options = options;
  const auto level = screen_video::RequiredH264Level(options.width, options.height, options.fps,
      options.bitrate_kbps * 1000);
  self.bitstream = std::make_unique<screen_video::H264Bitstream>(options.width, options.height, level,
      screen_video::H264Profile::Main, screen_video::H264LevelPolicy::Exact);
  self.output = std::move(output);
  self.failure = std::move(failure);
  NSDictionary* specification = options.hardware
      ? @{(__bridge NSString*)kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: @YES}
      : @{(__bridge NSString*)kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder: @NO};
  NSDictionary* attributes = @{
    (__bridge NSString*)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange),
    (__bridge NSString*)kCVPixelBufferWidthKey: @(options.width),
    (__bridge NSString*)kCVPixelBufferHeightKey: @(options.height),
    (__bridge NSString*)kCVPixelBufferIOSurfacePropertiesKey: @{},
  };
  try {
    Check(VTCompressionSessionCreate(kCFAllocatorDefault, options.width, options.height,
        kCMVideoCodecType_H264, (__bridge CFDictionaryRef)specification,
        (__bridge CFDictionaryRef)attributes, nullptr, &State::Receive, &self, &self.session),
        "ERR_MAC_VIDEO_SESSION");
    self.Property(kVTCompressionPropertyKey_RealTime, kCFBooleanTrue);
    self.Property(kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse);
    NSString* profile = [NSString stringWithFormat:@"H264_Main_%u_%u",
      static_cast<unsigned>(level / 10), static_cast<unsigned>(level % 10)];
    self.Property(kVTCompressionPropertyKey_ProfileLevel, (__bridge CFStringRef)profile);
    self.Property(kVTCompressionPropertyKey_ColorPrimaries, kCVImageBufferColorPrimaries_ITU_R_709_2);
    self.Property(kVTCompressionPropertyKey_TransferFunction, kCVImageBufferTransferFunction_ITU_R_709_2);
    self.Property(kVTCompressionPropertyKey_YCbCrMatrix, kCVImageBufferYCbCrMatrix_ITU_R_709_2);
    self.Integer(kVTCompressionPropertyKey_ExpectedFrameRate, options.fps);
    self.Integer(kVTCompressionPropertyKey_MaxKeyFrameInterval, options.fps);
    self.Integer(kVTCompressionPropertyKey_AverageBitRate, options.bitrate_kbps * 1000);
    Check(VTCompressionSessionPrepareToEncodeFrames(self.session), "ERR_MAC_VIDEO_PREPARE");
    if (options.hardware) {
      CFTypeRef using_hardware = nullptr;
      Check(VTSessionCopyProperty(self.session, kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder,
          kCFAllocatorDefault, &using_hardware), "ERR_MAC_VIDEO_HARDWARE_PROBE");
      const bool known = using_hardware && CFGetTypeID(using_hardware) == CFBooleanGetTypeID();
      self.hardware = known && CFBooleanGetValue(static_cast<CFBooleanRef>(using_hardware));
      if (using_hardware) CFRelease(using_hardware);
      Require(known && self.hardware, "ERR_MAC_VIDEO_MODE_CHANGED");
    } else {
      // Apple's software encoder need not implement the hardware-selection
      // property. EnableHardware=false forbids that execution path outright.
      self.hardware = false;
    }
  } catch (...) {
    if (self.session) { VTCompressionSessionInvalidate(self.session); CFRelease(self.session); self.session = nullptr; }
    throw;
  }
}
VideoEncoder::~VideoEncoder() {
  if (state_->session) {
    // The owner must close before destroying callback storage.
    try { Close(); } catch (...) { std::terminate(); }
  }
}
bool VideoEncoder::Hardware() const { return state_->hardware; }
void VideoEncoder::Submit(CVPixelBufferRef buffer, CMTime timestamp, CMTime duration) {
  auto& self = *state_;
  Require(!self.closed && !self.failed.load(), "ERR_MAC_VIDEO_CLOSED");
  Require(buffer && CVPixelBufferGetWidth(buffer) == static_cast<size_t>(self.options.width) &&
      CVPixelBufferGetHeight(buffer) == static_cast<size_t>(self.options.height) &&
      CVPixelBufferGetPixelFormatType(buffer) == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
      "ERR_MAC_VIDEO_PIXEL_FORMAT");
  const auto pts = Microseconds(timestamp), interval = Microseconds(duration);
  Require(pts > self.last_timestamp && interval > 0 && interval <= 1000000, "ERR_MAC_VIDEO_TIMESTAMP_ORDER");
  uintptr_t id;
  {
    std::lock_guard lock(self.pending_mutex);
    Require(self.pending.size() < 8, "ERR_MAC_VIDEO_BACKPRESSURE");
    Require(self.next_frame < 9007199254740991ULL, "ERR_MAC_VIDEO_IDENTIFIERS");
    id = ++self.next_frame;
    self.pending.emplace(id, interval);
  }
  NSDictionary* properties = self.keyframe
      ? @{(__bridge NSString*)kVTEncodeFrameOptionKey_ForceKeyFrame: @YES} : @{};
  VTEncodeInfoFlags flags{};
  const auto result = VTCompressionSessionEncodeFrame(self.session, buffer, timestamp, duration,
      (__bridge CFDictionaryRef)properties, reinterpret_cast<void*>(id), &flags);
  if (result != noErr || (flags & kVTEncodeInfo_FrameDropped)) {
    self.Report(result != noErr ? "ERR_MAC_VIDEO_ENCODE" : "ERR_MAC_VIDEO_FRAME_DROPPED", result);
    throw EncoderError("ERR_MAC_VIDEO_ENCODE", result);
  }
  self.keyframe = false;
  self.last_timestamp = pts;
}
void VideoEncoder::SetBitrate(int bitrate_kbps) {
  auto& self = *state_;
  Require(!self.closed && !self.failed.load() && bitrate_kbps >= 50 &&
      bitrate_kbps <= 80000 && bitrate_kbps % 50 == 0, "ERR_MAC_VIDEO_BITRATE");
  self.Integer(kVTCompressionPropertyKey_AverageBitRate, bitrate_kbps * 1000);
  self.options.bitrate_kbps = bitrate_kbps;
}
void VideoEncoder::RequestKeyframe() {
  Require(!state_->closed && !state_->failed.load(), "ERR_MAC_VIDEO_CLOSED");
  state_->keyframe = true;
}
void VideoEncoder::Close() {
  auto& self = *state_;
  if (self.closed) return;
  // CompleteFrames waits for the original output callbacks, including failed
  // ones, before their state or the underlying pixel-buffer leases disappear.
  const auto completed = VTCompressionSessionCompleteFrames(self.session, kCMTimeInvalid);
  VTCompressionSessionInvalidate(self.session);
  Require(self.active_callbacks.load() == 0, "ERR_MAC_VIDEO_CALLBACKS_PENDING");
  CFRelease(self.session);
  self.session = nullptr;
  self.closed = true;
  {
    std::lock_guard lock(self.pending_mutex);
    if (completed == noErr && !self.failed.load())
      Require(self.pending.empty(), "ERR_MAC_VIDEO_CALLBACKS_PENDING");
    self.pending.clear();
  }
  Check(completed, "ERR_MAC_VIDEO_DRAIN");
}

NSDictionary* VideoEncoderSmoke(bool hardware) {
  std::mutex mutex;
  std::vector<EncodedFrame> frames;
  std::string failure;
  OSStatus failure_status = 0;
  std::unique_ptr<VideoEncoder> encoder;
  try {
    encoder = std::make_unique<VideoEncoder>(EncoderOptions{320, 180, 30, 1000, hardware},
      [&](EncodedFrame frame) { std::lock_guard lock(mutex); frames.push_back(std::move(frame)); },
      [&](const char* code, OSStatus status) { std::lock_guard lock(mutex); failure = code; failure_status = status; });
  } catch (const EncoderError& error) {
    if (hardware && (error.status == kVTCouldNotFindVideoEncoderErr ||
        error.status == kVTCouldNotCreateInstanceErr || error.status == kVTVideoEncoderNotAvailableNowErr))
      return @{@"hardwareRequested": @YES, @"available": @NO, @"nativeStatus": @(error.status),
        @"probeOutcome": error.status == kVTCouldNotFindVideoEncoderErr ? @"unsupported" : @"unavailable"};
    throw;
  }
  CVPixelBufferRef buffer = nullptr;
  NSDictionary* attributes = @{(__bridge NSString*)kCVPixelBufferIOSurfacePropertiesKey: @{}};
  Check(CVPixelBufferCreate(kCFAllocatorDefault, 320, 180, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
      (__bridge CFDictionaryRef)attributes, &buffer), "ERR_MAC_VIDEO_TEST_BUFFER");
  try {
    Check(CVPixelBufferLockBaseAddress(buffer, 0), "ERR_MAC_VIDEO_TEST_LOCK");
    for (size_t plane = 0; plane < 2; ++plane)
      std::memset(CVPixelBufferGetBaseAddressOfPlane(buffer, plane), plane == 0 ? 80 : 128,
          CVPixelBufferGetBytesPerRowOfPlane(buffer, plane) * CVPixelBufferGetHeightOfPlane(buffer, plane));
    Check(CVPixelBufferUnlockBaseAddress(buffer, 0), "ERR_MAC_VIDEO_TEST_UNLOCK");
    for (int frame = 0; frame < 3; ++frame)
      encoder->Submit(buffer, CMTimeMake(frame, 30), CMTimeMake(1, 30));
    encoder->Close();
  } catch (...) { CVPixelBufferRelease(buffer); throw; }
  CVPixelBufferRelease(buffer);
  Require(failure.empty(), failure.empty() ? "ERR_MAC_VIDEO_TEST_CALLBACK" : failure.c_str());
  Require(frames.size() == 3 && frames.front().keyframe, "ERR_MAC_VIDEO_TEST_OUTPUT");
  size_t bytes = 0;
  for (size_t index = 0; index < frames.size(); ++index) {
    Require(!frames[index].bytes.empty() && frames[index].timestamp_us == static_cast<int64_t>(index) * 1000000 / 30,
        "ERR_MAC_VIDEO_TEST_TIMESTAMPS");
    bytes += frames[index].bytes.size();
  }
  const auto decoded = VideoDecoderSmoke(frames);
  return @{@"hardwareRequested": @(hardware),
    @"hardwareObserved": hardware ? @(encoder->Hardware()) : [NSNull null],
    @"softwareEnforced": @(!hardware),
    @"available": @YES, @"actualEncodedFrames": @(frames.size()), @"actualEncodedBytes": @(bytes),
    @"actualDecodedFrames": @(decoded), @"decodedPixelsVerified": @YES,
    @"nativeCallbacksRetired": @YES, @"captureValidated": @NO, @"realtimeThroughputValidated": @NO,
    @"nativeStatus": @(failure_status)};
}
}
