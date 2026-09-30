#include "../packet_source.h"
#include "process_tree.h"
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <CoreMedia/CoreMedia.h>
#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#include <libproc.h>
#include <unistd.h>
#include <memory>
#include <limits>
#include <type_traits>
#include <cerrno>

namespace screen_audio {
namespace {
struct Capture {
  Capture(const PacketCaptureSelection& selection, std::atomic<bool>& stop, const PacketCaptureSink& sink)
      : selection(selection), stop(stop), sink(sink) {
    format.sampleRate = 48000;
    format.channels = 2;
    format.bits = format.validBits = 32;
    format.blockAlign = 8;
    format.averageBytesPerSecond = 384000;
    format.floatingPoint = true;
  }
  PacketCaptureSelection selection;
  std::atomic<bool>& stop;
  PacketCaptureSink sink;
  Format format;
  std::mutex mutex;
  std::condition_variable changed;
  bool startDone = false, startRequested = false, started = false, stopped = false, retired = false;
  bool audioAttached = false, screenAttached = false;
  std::string errorCode, errorMessage, processBirth;
  SCStream* stream = nil;
  id<SCStreamOutput, SCStreamDelegate> delegate = nil;
  dispatch_queue_t queue = dispatch_queue_create("com.monky.audio-packets", DISPATCH_QUEUE_SERIAL);

  void Fail(const char* code, const std::string& message) {
    std::lock_guard lock(mutex);
    if (errorCode.empty()) { errorCode = code; errorMessage = message; }
    stop.store(true);
    changed.notify_all();
  }
  void Fail(NSError* error, const char* context) {
    Fail("ERR_AUDIO_CAPTURE", std::string(context) + ": " +
        (error.localizedDescription.UTF8String ?: "ScreenCaptureKit operation failed"));
  }
};

proc_bsdinfo Process(uint32_t pid) {
  proc_bsdinfo info{};
  if (!pid || proc_pidinfo(static_cast<int>(pid), PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info))
    throw Failure("ERR_AUDIO_TARGET", "Cannot verify audio process " + std::to_string(pid) +
        ": " + std::strerror(errno));
  return info;
}
std::string Birth(const proc_bsdinfo& info) {
  if (info.pbi_start_tvsec > (UINT64_MAX - info.pbi_start_tvusec) / 1000000)
    throw Failure("ERR_AUDIO_TARGET", "Invalid process birth timestamp");
  return std::to_string(info.pbi_start_tvsec * 1000000 + info.pbi_start_tvusec);
}
void CheckProcess(Capture& capture) {
  if (!capture.selection.windowId) return;
  if (Birth(Process(capture.selection.expectedPid)) != capture.processBirth)
    throw Failure("ERR_AUDIO_TARGET", "The selected audio process has exited or changed");
}
void CheckWindow(Capture& capture) {
  CheckProcess(capture);
  if (!capture.selection.windowId) return;
  const auto windows = CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow,
      static_cast<CGWindowID>(capture.selection.windowId));
  bool found = false;
  for (NSDictionary* window in (__bridge NSArray*)windows) {
    NSNumber* pid = window[(__bridge NSString*)kCGWindowOwnerPID];
    NSNumber* id = window[(__bridge NSString*)kCGWindowNumber];
    if (id.unsignedIntValue == capture.selection.windowId &&
        pid.unsignedIntValue == capture.selection.expectedPid) found = true;
  }
  if (windows) CFRelease(windows);
  if (!found) throw Failure("ERR_AUDIO_TARGET", "The selected audio window has closed or changed its owner");
}
void Samples(Capture& capture, CMSampleBufferRef sample) {
  if (capture.stop.load()) return;
  CheckProcess(capture);
  if (!CMSampleBufferIsValid(sample) || !CMSampleBufferDataIsReady(sample))
    throw Failure("ERR_AUDIO_PACKET", "ScreenCaptureKit delivered an invalid audio sample");
  const auto description = CMSampleBufferGetFormatDescription(sample);
  const auto* format = description ? CMAudioFormatDescriptionGetStreamBasicDescription(description) : nullptr;
  if (!format || format->mFormatID != kAudioFormatLinearPCM ||
      !(format->mFormatFlags & kAudioFormatFlagIsFloat) ||
      (format->mFormatFlags & kAudioFormatFlagIsBigEndian) ||
      !(format->mFormatFlags & kAudioFormatFlagIsPacked) ||
      format->mBitsPerChannel != 32 || format->mChannelsPerFrame != capture.format.channels ||
      format->mSampleRate != capture.format.sampleRate)
    throw Failure("ERR_AUDIO_FORMAT", "ScreenCaptureKit audio does not match its configured float PCM format");
  const auto count = CMSampleBufferGetNumSamples(sample);
  if (count <= 0 || count > UINT32_MAX)
    throw Failure("ERR_AUDIO_PACKET_SIZE", "Invalid ScreenCaptureKit audio sample count");
  const auto frames = static_cast<uint32_t>(count);
  PacketBytes(capture.format, frames);
  size_t size = 0;
  auto status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
      sample, &size, nullptr, 0, kCFAllocatorDefault, kCFAllocatorDefault, 0, nullptr);
  if (status != noErr || size < sizeof(AudioBufferList) || size > 4096)
    throw Failure("ERR_AUDIO_PACKET", "Cannot measure the ScreenCaptureKit audio buffer list");
  std::vector<uint8_t> storage(size);
  auto* buffers = reinterpret_cast<AudioBufferList*>(storage.data());
  CMBlockBufferRef retained = nullptr;
  status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
      sample, nullptr, buffers, size, kCFAllocatorDefault, kCFAllocatorDefault,
      kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment, &retained);
  const auto release = [](CMBlockBufferRef value) { if (value) CFRelease(value); };
  std::unique_ptr<std::remove_pointer_t<CMBlockBufferRef>, decltype(release)> block(retained, release);
  if (status != noErr) throw Failure("ERR_AUDIO_PACKET", "Cannot retain the ScreenCaptureKit PCM samples");
  const bool planar = format->mFormatFlags & kAudioFormatFlagIsNonInterleaved;
  const uint32_t channels = capture.format.channels;
  if (buffers->mNumberBuffers != (planar ? channels : 1) ||
      size < offsetof(AudioBufferList, mBuffers) + buffers->mNumberBuffers * sizeof(AudioBuffer))
    throw Failure("ERR_AUDIO_FORMAT", "Unexpected ScreenCaptureKit PCM plane layout");
  std::vector<float> pcm(static_cast<size_t>(frames) * channels);
  for (uint32_t plane = 0; plane < buffers->mNumberBuffers; ++plane) {
    const auto& buffer = buffers->mBuffers[plane];
    const uint32_t planeChannels = planar ? 1 : channels;
    if (buffer.mNumberChannels != planeChannels || !buffer.mData ||
        buffer.mDataByteSize != static_cast<size_t>(frames) * planeChannels * sizeof(float))
      throw Failure("ERR_AUDIO_PACKET_SIZE", "ScreenCaptureKit PCM plane length does not match its frames");
    if (!planar) std::memcpy(pcm.data(), buffer.mData, pcm.size() * sizeof(float));
    else {
      for (uint32_t frame = 0; frame < frames; ++frame) {
        float value;
        std::memcpy(&value, static_cast<const uint8_t*>(buffer.mData) + frame * sizeof(float), sizeof(value));
        pcm[static_cast<size_t>(frame) * channels + plane] = value;
      }
    }
  }
  const auto presentation = CMSampleBufferGetPresentationTimeStamp(sample);
  const bool valid = CMTIME_IS_NUMERIC(presentation) && presentation.value >= 0 && presentation.epoch == 0;
  const auto timestamp = valid
      ? CMTimeConvertScale(presentation, 10000000, kCMTimeRoundingMethod_RoundTowardZero) : kCMTimeInvalid;
  if (valid && (!CMTIME_IS_NUMERIC(timestamp) || timestamp.value < 0))
    throw Failure("ERR_AUDIO_TIMESTAMP", "ScreenCaptureKit presentation timestamp is out of range");
  if (!capture.sink.packet(reinterpret_cast<const uint8_t*>(pcm.data()), frames,
          valid ? 0 : kTimestampError, std::nullopt, valid ? static_cast<uint64_t>(timestamp.value) : 0))
    capture.stop.store(true);
}
}
}

@interface MonkyPacketAudioOutput : NSObject <SCStreamOutput, SCStreamDelegate> {
 @public
  std::shared_ptr<screen_audio::Capture> capture;
}
@end

@implementation MonkyPacketAudioOutput
- (void)stream:(SCStream*)stream didOutputSampleBuffer:(CMSampleBufferRef)sample ofType:(SCStreamOutputType)type {
  if (type != SCStreamOutputTypeAudio) return;
  try { screen_audio::Samples(*capture, sample); }
  catch (const screen_audio::Failure& error) { capture->Fail(error.code.c_str(), error.what()); }
  catch (const std::exception& error) { capture->Fail("ERR_AUDIO_CAPTURE", error.what()); }
}
- (void)stream:(SCStream*)stream didStopWithError:(NSError*)error {
  capture->Fail(error, "Audio stream stopped");
  std::lock_guard lock(capture->mutex);
  capture->stopped = true;
  capture->changed.notify_all();
}
@end

namespace screen_audio {
namespace {
void Start(std::shared_ptr<Capture> capture, SCShareableContent* content) {
  if (capture->stop.load()) return;
  // Inspect our descendants, not protected or disappearing unrelated applications.
  const auto ownProcesses = ProcessTree(getpid());
  SCContentFilter* filter = nil;
  if (capture->selection.windowId) {
    SCWindow* target = nil;
    for (SCWindow* window in content.windows)
      if (window.windowID == capture->selection.windowId) { target = window; break; }
    SCRunningApplication* owner = target.owningApplication;
    if (!owner || owner.processID <= 0 ||
        (capture->selection.expectedPid && static_cast<uint32_t>(owner.processID) != capture->selection.expectedPid))
      throw Failure("ERR_AUDIO_TARGET", "The selected audio window has exited or changed its owner");
    if (ownProcesses.count(owner.processID))
      throw Failure("ERR_AUDIO_TARGET", "Capturing Monky's own process tree is not allowed");
    capture->selection.expectedPid = owner.processID;
    capture->processBirth = Birth(Process(owner.processID));
    if (!capture->selection.expectedProcessStartTimeUs.empty() &&
        capture->processBirth != capture->selection.expectedProcessStartTimeUs)
      throw Failure("ERR_AUDIO_TARGET", "The selected audio process birth identity has changed");
    SCDisplay* display = content.displays.firstObject;
    for (SCDisplay* candidate in content.displays)
      if (CGRectIntersectsRect(candidate.frame, target.frame)) { display = candidate; break; }
    if (!display) throw Failure("ERR_AUDIO_TARGET", "No display is available for application audio capture");
    filter = [[SCContentFilter alloc] initWithDisplay:display includingApplications:@[owner] exceptingWindows:@[]];
  } else {
    SCDisplay* display = content.displays.firstObject;
    if (!display) throw Failure("ERR_AUDIO_TARGET", "No display is available for system audio capture");
    NSMutableArray<SCRunningApplication*>* excluded = [NSMutableArray array];
    for (SCRunningApplication* application in content.applications)
      if (ownProcesses.count(application.processID)) [excluded addObject:application];
    filter = [[SCContentFilter alloc] initWithDisplay:display excludingApplications:excluded exceptingWindows:@[]];
  }
  SCStreamConfiguration* config = [[SCStreamConfiguration alloc] init];
  config.capturesAudio = YES;
  config.excludesCurrentProcessAudio = YES;
  config.sampleRate = capture->format.sampleRate;
  config.channelCount = capture->format.channels;
  config.width = config.height = 2;
  config.showsCursor = NO;
  config.queueDepth = 3;
  config.minimumFrameInterval = CMTimeMake(10, 1);
  MonkyPacketAudioOutput* output = [[MonkyPacketAudioOutput alloc] init];
  output->capture = capture;
  capture->delegate = output;
  capture->stream = [[SCStream alloc] initWithFilter:filter configuration:config delegate:output];
  NSError* error = nil;
  capture->screenAttached = [capture->stream addStreamOutput:output type:SCStreamOutputTypeScreen
                                         sampleHandlerQueue:capture->queue error:&error];
  if (!capture->screenAttached) { capture->Fail(error, "Attach audio maintenance output"); return; }
  capture->audioAttached = [capture->stream addStreamOutput:output type:SCStreamOutputTypeAudio
                                        sampleHandlerQueue:capture->queue error:&error];
  if (!capture->audioAttached) { capture->Fail(error, "Attach PCM output"); return; }
  capture->startRequested = true;
  [capture->stream startCaptureWithCompletionHandler:^(NSError* failure) {
    if (failure) capture->Fail(failure, "Start audio capture");
    std::lock_guard lock(capture->mutex);
    capture->started = !failure;
    capture->startDone = true;
    capture->changed.notify_all();
  }];
}
}

void RunPacketCapture(const PacketCaptureSelection& selection, std::atomic<bool>& stop,
                      const PacketCaptureSink& sink) {
  @autoreleasepool {
    if (@available(macOS 13.0, *)) {
      if (!NSApp)
        throw Failure("ERR_AUDIO_RUNTIME", "ScreenCaptureKit packet audio requires a running AppKit application");
      if (selection.excludedPid && selection.excludedPid != static_cast<uint32_t>(getpid()))
        throw Failure("ERR_AUDIO_TARGET", "System capture must exclude the current Monky process");
      if (selection.windowId < 0 || static_cast<uint64_t>(selection.windowId) > UINT32_MAX)
        throw Failure("ERR_AUDIO_TARGET", "Invalid macOS window identity");
      auto capture = std::make_shared<Capture>(selection, stop, sink);
      dispatch_async(capture->queue, ^{
        {
          std::unique_lock lock(capture->mutex);
          capture->changed.wait(lock, [&] { return capture->startDone; });
        }
        if (capture->started && !stop.load()) {
          try { if (!capture->sink.ready(capture->format)) stop.store(true); }
          catch (const Failure& failure) { capture->Fail(failure.code.c_str(), failure.what()); }
          catch (const std::exception& failure) { capture->Fail("ERR_AUDIO_CAPTURE", failure.what()); }
        }
      });
      // SCK operations run off Main so Node's cleanup hook can drain acquisition
      // even after AppKit stops dispatching UI work during application shutdown.
      [SCShareableContent getShareableContentWithCompletionHandler:^(SCShareableContent* content, NSError* error) {
            if (error || !content) capture->Fail(error, "Resolve audio source");
            else {
              try { Start(capture, content); }
              catch (const Failure& failure) { capture->Fail(failure.code.c_str(), failure.what()); }
              catch (const std::exception& failure) { capture->Fail("ERR_AUDIO_CAPTURE", failure.what()); }
            }
            std::lock_guard lock(capture->mutex);
            if (!capture->startRequested) {
              capture->startDone = true;
              capture->changed.notify_all();
            }
      }];
      {
        std::unique_lock lock(capture->mutex);
        capture->changed.wait(lock, [&] { return capture->startDone; });
      }
      {
        std::unique_lock lock(capture->mutex);
        auto checked = std::chrono::steady_clock::now();
        while (!stop.load()) {
          capture->changed.wait_for(lock, std::chrono::milliseconds(20));
          const auto now = std::chrono::steady_clock::now();
          if (now - checked < std::chrono::milliseconds(250)) continue;
          checked = now;
          lock.unlock();
          try { CheckWindow(*capture); }
          catch (const Failure& failure) { capture->Fail(failure.code.c_str(), failure.what()); }
          catch (const std::exception& failure) { capture->Fail("ERR_AUDIO_TARGET", failure.what()); }
          lock.lock();
        }
      }
      {
        bool needsStop;
        {
          std::lock_guard lock(capture->mutex);
          needsStop = capture->started && !capture->stopped;
          if (!needsStop) { capture->stopped = true; capture->changed.notify_all(); }
        }
        if (needsStop) [capture->stream stopCaptureWithCompletionHandler:^(NSError* error) {
          if (error) {
            capture->Fail(error, "Stop audio capture (awaiting native stop confirmation)");
            return;
          }
          std::lock_guard lock(capture->mutex);
          capture->stopped = true;
          capture->changed.notify_all();
        }];
      }
      {
        std::unique_lock lock(capture->mutex);
        capture->changed.wait(lock, [&] { return capture->stopped; });
      }
      dispatch_sync(capture->queue, ^{});
      {
        NSError* error = nil;
        if (capture->audioAttached &&
            ![capture->stream removeStreamOutput:capture->delegate type:SCStreamOutputTypeAudio error:&error])
          capture->Fail(error, "Detach PCM output");
        if (capture->screenAttached &&
            ![capture->stream removeStreamOutput:capture->delegate type:SCStreamOutputTypeScreen error:&error])
          capture->Fail(error, "Detach audio maintenance output");
        capture->stream = nil;
        capture->delegate = nil;
        std::lock_guard lock(capture->mutex);
        capture->retired = true;
        capture->changed.notify_all();
      }
      {
        std::unique_lock lock(capture->mutex);
        capture->changed.wait(lock, [&] { return capture->retired; });
        if (!capture->errorCode.empty()) throw Failure(capture->errorCode.c_str(), capture->errorMessage);
      }
    } else {
      throw Failure("ERR_AUDIO_UNSUPPORTED", "Timestamped ScreenCaptureKit audio requires macOS 13 or later");
    }
  }
}
}
