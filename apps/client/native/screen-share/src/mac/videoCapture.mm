#include "videoCapture.h"
#import <CoreGraphics/CoreGraphics.h>
#include <atomic>
#include <cmath>
#include <mutex>
#include <stdexcept>
#include <string>

@interface MonkyNativeVideoOutput : NSObject <SCStreamOutput, SCStreamDelegate>
@property(nonatomic, copy) void (^sample)(CMSampleBufferRef);
@property(nonatomic, copy) void (^failure)(NSError*);
@end
@implementation MonkyNativeVideoOutput
- (void)stream:(SCStream*)stream didOutputSampleBuffer:(CMSampleBufferRef)sample ofType:(SCStreamOutputType)type {
  (void)stream;
  if (type == SCStreamOutputTypeScreen) self.sample(sample);
}
- (void)stream:(SCStream*)stream didStopWithError:(NSError*)error {
  (void)stream;
  self.failure(error);
}
@end

namespace monky::screen::mac {
namespace {
enum class Phase { Created, Starting, Running, Stopping, Closed };
std::exception_ptr Failure(const char* code, NSInteger status = 0) {
  return std::make_exception_ptr(std::runtime_error(std::string(code) + " nativeStatus=" + std::to_string(status)));
}
}
struct VideoCapture::State : std::enable_shared_from_this<State> {
  SCContentFilter* filter;
  SCStream* stream = nil;
  MonkyNativeVideoOutput* delegate = nil;
  dispatch_queue_t control = dispatch_queue_create("com.monky.capture.control", DISPATCH_QUEUE_SERIAL);
  dispatch_queue_t video = dispatch_queue_create("com.monky.capture.video", DISPATCH_QUEUE_SERIAL);
  EncoderOptions options;
  bool preserve_aspect_ratio, output_registered = false, start_pending = false, stop_pending = false;
  std::atomic<Phase> phase{Phase::Created};
  std::atomic<bool> failed{false};
  std::atomic<uint64_t> samples{0}, encoded{0}, idle{0}, backpressured{0};
  VideoEncoder::Output output;
  VideoEncoder::Failure failure;
  std::function<bool()> writable;
  std::function<void()> verify_target;
  std::unique_ptr<VideoEncoder> encoder;
  std::mutex close_mutex;
  std::shared_ptr<std::promise<void>> closing;
  std::shared_future<void> closed;

  State(SCContentFilter* selected, EncoderOptions configured, bool aspect,
      VideoEncoder::Output packet, VideoEncoder::Failure error,
      std::function<bool()> available, std::function<void()> verify)
      : filter(selected), options(configured), preserve_aspect_ratio(aspect),
        output(std::move(packet)), failure(std::move(error)), writable(std::move(available)),
        verify_target(std::move(verify)) {
    if (!filter || !output || !failure || !writable || !verify_target)
      throw std::runtime_error("ERR_MAC_CAPTURE_OPTIONS");
  }
  void Report(const char* code, NSInteger status) noexcept {
    if (failed.exchange(true)) return;
    try { failure(code, static_cast<OSStatus>(status)); } catch (...) { std::terminate(); }
  }
  void Sample(CMSampleBufferRef sample) noexcept {
    if (phase != Phase::Running || failed) return;
    try {
      if (!sample || !CMSampleBufferDataIsReady(sample)) throw std::runtime_error("ERR_MAC_CAPTURE_SAMPLE");
      const auto attachments = CMSampleBufferGetSampleAttachmentsArray(sample, false);
      if (!attachments || CFArrayGetCount(attachments) != 1)
        throw std::runtime_error("ERR_MAC_CAPTURE_ATTACHMENTS");
      NSDictionary* information = (__bridge NSDictionary*)CFArrayGetValueAtIndex(attachments, 0);
      NSNumber* status = information[SCStreamFrameInfoStatus];
      if (![status isKindOfClass:NSNumber.class]) throw std::runtime_error("ERR_MAC_CAPTURE_FRAME_STATUS");
      if (status.integerValue != SCFrameStatusComplete) { ++idle; return; }
      ++samples;
      // Drop only before encoding: an encoded reference chain is never cut to
      // make space for a newer access unit.
      if (!encoder->Writable() || !writable()) { ++backpressured; return; }
      verify_target();
      const auto image = CMSampleBufferGetImageBuffer(sample);
      const auto pts = CMSampleBufferGetPresentationTimeStamp(sample);
      encoder->Submit(image, pts, CMTimeMake(1, options.fps));
    } catch (const VideoError& error) { Report(error.code.c_str(), error.status); }
    catch (...) { Report("ERR_MAC_CAPTURE_FRAME", 0); }
  }
  void Start(const std::shared_ptr<std::promise<void>>& result) {
    if (phase != Phase::Created) { result->set_exception(Failure("ERR_MAC_CAPTURE_STATE")); return; }
    phase = Phase::Starting;
    const auto owner = shared_from_this();
    try {
      verify_target();
      encoder = std::make_unique<VideoEncoder>(options,
        [this](EncodedFrame packet) { output(std::move(packet)); ++encoded; },
        [this](const char* code, OSStatus status) { Report(code, status); });
      delegate = [MonkyNativeVideoOutput new];
      const std::weak_ptr<State> weak = owner;
      delegate.sample = ^(CMSampleBufferRef sample) {
        if (const auto current = weak.lock()) current->Sample(sample);
        else std::terminate();
      };
      delegate.failure = ^(NSError* error) {
        if (const auto current = weak.lock()) current->Report("ERR_MAC_CAPTURE_STOPPED", error.code);
        else std::terminate();
      };
      SCStreamConfiguration* config = [SCStreamConfiguration new];
      config.width = options.width;
      config.height = options.height;
      config.minimumFrameInterval = CMTimeMake(1, options.fps);
      config.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange;
      config.colorSpaceName = kCGColorSpaceITUR_709;
      config.colorMatrix = kCGDisplayStreamYCbCrMatrix_ITU_R_709_2;
      config.scalesToFit = YES;
      config.preservesAspectRatio = preserve_aspect_ratio;
      config.showsCursor = YES;
      config.capturesAudio = NO;
      config.queueDepth = 3;
      stream = [[SCStream alloc] initWithFilter:filter configuration:config delegate:delegate];
      NSError* error = nil;
      if (![stream addStreamOutput:delegate type:SCStreamOutputTypeScreen sampleHandlerQueue:video error:&error])
        throw std::runtime_error("ERR_MAC_CAPTURE_OUTPUT");
      output_registered = true;
      start_pending = true;
      [stream startCaptureWithCompletionHandler:^(NSError* error) {
        dispatch_async(owner->control, ^{
          owner->start_pending = false;
          if (error) {
            owner->Report("ERR_MAC_CAPTURE_START", error.code);
            result->set_exception(Failure("ERR_MAC_CAPTURE_START", error.code));
          } else if (owner->phase == Phase::Stopping) {
            result->set_exception(Failure("ERR_MAC_CAPTURE_CANCELLED"));
          } else {
            try {
              owner->verify_target();
              owner->phase = Phase::Running;
              result->set_value();
            } catch (...) {
              owner->Report("ERR_MAC_CAPTURE_SOURCE_CHANGED", 0);
              result->set_exception(std::current_exception());
            }
          }
          if (owner->phase == Phase::Stopping) owner->Stop();
        });
      }];
    } catch (const VideoError& error) {
      Report(error.code.c_str(), error.status);
      result->set_exception(std::current_exception());
    } catch (...) {
      Report("ERR_MAC_CAPTURE_START", 0);
      result->set_exception(std::current_exception());
    }
  }
  void Drain(NSInteger stop_status) {
    const auto owner = shared_from_this();
    NSError* error = nil;
    NSInteger removal_status = 0;
    if (output_registered) {
      if ([stream removeStreamOutput:delegate type:SCStreamOutputTypeScreen error:&error])
        output_registered = false;
      else removal_status = error.code;
    }
    dispatch_async(video, ^{
      try {
        if (owner->encoder) { owner->encoder->Close(); owner->encoder.reset(); }
        dispatch_async(owner->control, ^{
          if (owner->output_registered) {
            owner->closing->set_exception(Failure("ERR_MAC_CAPTURE_OUTPUT_RETIREMENT", removal_status));
            return;
          }
          owner->stream = nil;
          owner->delegate = nil;
          owner->filter = nil;
          owner->phase = Phase::Closed;
          if (stop_status) {
            owner->Report("ERR_MAC_CAPTURE_STOP", stop_status);
            owner->closing->set_exception(Failure("ERR_MAC_CAPTURE_STOP", stop_status));
          } else owner->closing->set_value();
        });
      } catch (...) {
        owner->Report("ERR_MAC_CAPTURE_ENCODER_RETIREMENT", 0);
        owner->closing->set_exception(std::current_exception());
      }
    });
  }
  void Stop() {
    if (stop_pending || start_pending) return;
    stop_pending = true;
    const auto owner = shared_from_this();
    if (!stream) { Drain(0); return; }
    [stream stopCaptureWithCompletionHandler:^(NSError* error) {
      dispatch_async(owner->control, ^{ owner->Drain(error.code); });
    }];
  }
};

VideoCapture::VideoCapture(SCContentFilter* filter, EncoderOptions options, bool aspect,
    VideoEncoder::Output output, VideoEncoder::Failure failure,
    std::function<bool()> writable, std::function<void()> verify)
    : state_(std::make_shared<State>(filter, options, aspect, std::move(output),
        std::move(failure), std::move(writable), std::move(verify))) {}
VideoCapture::~VideoCapture() {
  if (state_->phase != Phase::Closed && state_->phase != Phase::Created) std::terminate();
}
std::future<void> VideoCapture::Start() {
  const auto owner = state_;
  auto result = std::make_shared<std::promise<void>>();
  auto future = result->get_future();
  dispatch_async(owner->control, ^{ owner->Start(result); });
  return future;
}
std::shared_future<void> VideoCapture::Close() {
  const auto owner = state_;
  std::lock_guard lock(owner->close_mutex);
  if (owner->closed.valid()) return owner->closed;
  owner->closing = std::make_shared<std::promise<void>>();
  owner->closed = owner->closing->get_future().share();
  dispatch_async(owner->control, ^{
    owner->phase = Phase::Stopping;
    owner->Stop();
  });
  return owner->closed;
}
std::future<void> VideoCapture::SetBitrate(int bitrate_kbps) {
  const auto owner = state_;
  auto result = std::make_shared<std::promise<void>>();
  auto future = result->get_future();
  dispatch_async(owner->video, ^{
    try {
      if (owner->phase != Phase::Running) throw std::runtime_error("ERR_MAC_CAPTURE_STATE");
      owner->encoder->SetBitrate(bitrate_kbps);
      result->set_value();
    } catch (...) { result->set_exception(std::current_exception()); }
  });
  return future;
}
std::future<void> VideoCapture::RequestKeyframe() {
  const auto owner = state_;
  auto result = std::make_shared<std::promise<void>>();
  auto future = result->get_future();
  dispatch_async(owner->video, ^{
    try {
      if (owner->phase != Phase::Running) throw std::runtime_error("ERR_MAC_CAPTURE_STATE");
      owner->encoder->RequestKeyframe();
      result->set_value();
    } catch (...) { result->set_exception(std::current_exception()); }
  });
  return future;
}
NSDictionary* VideoCapture::Snapshot() const {
  return @{@"completeSourceFrames": @(state_->samples.load()),
    @"encodedFrames": @(state_->encoded.load()), @"nonCompleteSourceFrames": @(state_->idle.load()),
    @"rawBackpressureDrops": @(state_->backpressured.load()),
    @"nativeClosed": @(state_->phase == Phase::Closed), @"audioAvailable": @NO};
}
}
