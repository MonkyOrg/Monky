#include "../src/mac/videoCapture.mm"
#import <AppKit/AppKit.h>
#include <chrono>
#include <iostream>
#include <thread>
#include <unistd.h>

using namespace std::chrono_literals;
namespace monky::screen::mac {
NSInteger InterruptedStatus() {
  if (@available(macOS 15.0, *)) return SCStreamErrorSystemStoppedStream;
  return SCStreamErrorUserStopped;
}
struct VideoCaptureTestAccess {
  static std::future<void> SystemStop(VideoCapture& capture) {
    auto result = std::make_shared<std::promise<void>>();
    auto future = result->get_future();
    const auto owner = capture.state_;
    dispatch_async(owner->control, ^{
      // Stop only this test-owned SCStream, then deliver the OS delegate event.
      // Never induce real disk/memory pressure or stop the shared system service.
      [owner->stream stopCaptureWithCompletionHandler:^(NSError* error) {
        if (error) { result->set_exception(Failure("ERR_TEST_SYSTEM_STOP", error.code)); return; }
        [owner->delegate stream:owner->stream didStopWithError:
          [NSError errorWithDomain:SCStreamErrorDomain code:InterruptedStatus() userInfo:nil]];
        dispatch_async(owner->control, ^{ result->set_value(); });
      }];
    });
    return future;
  }
};
}
using namespace monky::screen::mac;
namespace {
void Require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}
template <typename Future> void Wait(Future future) {
  Require(future.wait_for(10s) == std::future_status::ready, "Native capture operation timed out.");
  future.get();
}
void Frames(std::atomic<unsigned>& frames, unsigned count, std::atomic<unsigned>& errors) {
  const auto deadline = std::chrono::steady_clock::now() + 10s;
  while (frames < count && !errors && std::chrono::steady_clock::now() < deadline)
    std::this_thread::sleep_for(20ms);
  Require(!errors && frames >= count, "The owned stream did not deliver real encoded frames.");
}
SCContentFilter* Filter(unsigned window, int pid) {
  __block SCContentFilter* selected = nil;
  auto result = std::make_shared<std::promise<void>>();
  auto future = result->get_future();
  [SCShareableContent getShareableContentExcludingDesktopWindows:YES onScreenWindowsOnly:NO
    completionHandler:^(SCShareableContent* content, NSError* error) {
      if (!error) for (SCWindow* source in content.windows) {
        if (source.windowID == window && source.owningApplication.processID == pid) {
          selected = [[SCContentFilter alloc] initWithDesktopIndependentWindow:source];
          result->set_value();
          return;
        }
      }
      result->set_exception(std::make_exception_ptr(std::runtime_error("Owned fixture not available.")));
    }];
  Require(future.wait_for(10s) == std::future_status::ready, "Source lookup timed out.");
  future.get();
  return selected;
}
void Run(unsigned window, int pid) {
  SCContentFilter* filter = Filter(window, pid);
  std::atomic<unsigned> victim_frames{0}, survivor_frames{0}, victim_errors{0}, survivor_errors{0};
  std::atomic<OSStatus> status{0};
  const EncoderOptions options{640, 480, 30, 1000, false, false};
  const auto verify = [window, pid] {
    NSArray* rows = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, window));
    Require(rows.count == 1 && [rows[0][(__bridge NSString*)kCGWindowOwnerPID] intValue] == pid,
      "The test-owned source changed identity.");
  };
  VideoCapture victim(filter, options, true, [&](EncodedFrame) { ++victim_frames; },
    [&](const char* code, OSStatus value) {
      std::cerr << code << " status=" << value << std::endl;
      status = value; ++victim_errors;
    }, [] { return true; }, verify);
  auto hardware = options;
  hardware.hardware = true;
  VideoCapture survivor(Filter(window, pid), hardware, true, [&](EncodedFrame) { ++survivor_frames; },
    [&](const char* code, OSStatus value) {
      std::cerr << code << " status=" << value << std::endl;
      ++survivor_errors;
    }, [] { return true; }, verify);
  try {
    Wait(victim.Start()); Wait(survivor.Start());
    Frames(victim_frames, 5, victim_errors); Frames(survivor_frames, 5, survivor_errors);
    Wait(VideoCaptureTestAccess::SystemStop(victim));
    Require(victim_errors == 1 && status == InterruptedStatus(), "Stream interruption was not reported exactly once.");
    Wait(victim.Close());
    Require([victim.Snapshot()[@"nativeClosed"] boolValue], "Stopped capture retained native ownership.");
    Frames(survivor_frames, survivor_frames + 30, survivor_errors);
    Wait(victim.Close());
    Require(victim_errors == 1, "Retirement fabricated another failure after the native stop acknowledgement.");
    Wait(survivor.Close());
    Require([survivor.Snapshot()[@"nativeClosed"] boolValue], "Surviving capture did not retire.");
    std::cout << "{\"passed\":true,\"interruptionReported\":true,\"nativeClosed\":true,\"nativeStatus\":" << status << ","
      "\"survivorFrames\":" << survivor_frames << ",\"survivorErrors\":" << survivor_errors
      << ",\"personalSourcesCaptured\":false}" << std::endl;
  } catch (...) {
    std::cerr << "victim=" << victim.Snapshot().description.UTF8String
      << "\nsurvivor=" << survivor.Snapshot().description.UTF8String << std::endl;
    auto error = std::current_exception();
    try { Wait(victim.Close()); Wait(survivor.Close()); }
    catch (const std::exception& failure) { std::cerr << failure.what() << std::endl; }
    std::rethrow_exception(error);
  }
}
}
int main(int argc, const char** argv) {
  if (argc != 3) return 2;
  [NSApplication sharedApplication];
  [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
  std::thread([window = static_cast<unsigned>(std::stoul(argv[1])), pid = std::stoi(argv[2])] {
    @autoreleasepool {
      try { Run(window, pid); exit(0); }
      catch (const std::exception& error) { std::cerr << error.what() << std::endl; exit(1); }
    }
  }).detach();
  CFRunLoopRun();
  return 1;
}
