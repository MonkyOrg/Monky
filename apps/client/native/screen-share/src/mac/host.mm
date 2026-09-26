#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#include <libproc.h>
#include <arpa/inet.h>
#include <signal.h>
#include <unistd.h>

#include <atomic>
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <climits>
#include <charconv>
#include <condition_variable>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

namespace {
constexpr size_t kMaximumCommand = 65536;
constexpr size_t kMaximumJson = 1024 * 1024;
constexpr size_t kMaximumImage = 1024 * 1024;
constexpr uint32_t kMagic = 0x4d435331;
std::mutex outputMutex;
std::atomic<bool> closing{false};
std::atomic<unsigned> operations{0};
std::atomic<uint64_t> latestCommand{0};

struct Failure : std::runtime_error {
  explicit Failure(const char* code) : std::runtime_error(code) {}
};
void Require(bool condition, const char* code = "ERR_MAC_ARGUMENT") {
  if (!condition) throw Failure(code);
}
int64_t Number(id value, int64_t minimum, int64_t maximum) {
  Require([value isKindOfClass:NSNumber.class] && CFGetTypeID((__bridge CFTypeRef)value) != CFBooleanGetTypeID());
  double number = [value doubleValue];
  Require(std::isfinite(number) && number >= minimum && number <= maximum && number == std::floor(number));
  return [value longLongValue];
}
NSString* Text(id value, NSUInteger maximum) {
  Require([value isKindOfClass:NSString.class] && [value length] > 0 && [value length] <= maximum);
  Require([value rangeOfString:[NSString stringWithFormat:@"%C", (unichar)0]].location == NSNotFound);
  return value;
}
void Exact(NSDictionary* value, NSArray<NSString*>* keys) {
  Require([value isKindOfClass:NSDictionary.class] &&
      [[NSSet setWithArray:value.allKeys] isEqualToSet:[NSSet setWithArray:keys]]);
}
void WriteBytes(const uint8_t* data, size_t size) {
  while (size) {
    const auto written = write(STDOUT_FILENO, data, size);
    if (written < 0 && errno == EINTR) continue;
    if (written <= 0) _exit(74);
    data += static_cast<size_t>(written);
    size -= static_cast<size_t>(written);
  }
}
void Output(NSDictionary* message, NSData* image = nil) {
  NSError* error = nil;
  NSData* json = [NSJSONSerialization dataWithJSONObject:message options:0 error:&error];
  if (!json || error || json.length > kMaximumJson || image.length > kMaximumImage) _exit(74);
  uint32_t prefix[] = {htonl(kMagic), htonl(static_cast<uint32_t>(json.length)), htonl(static_cast<uint32_t>(image.length))};
  std::lock_guard lock(outputMutex);
  WriteBytes(reinterpret_cast<const uint8_t*>(prefix), sizeof(prefix));
  WriteBytes(static_cast<const uint8_t*>(json.bytes), json.length);
  if (image.length) WriteBytes(static_cast<const uint8_t*>(image.bytes), image.length);
}
void Error(uint64_t request, const char* code, NSInteger status = 0) {
  Output(@{@"type": @"result", @"id": @(request),
      @"error": @{@"code": @(code), @"nativeStatus": @(status), @"nativeOwnershipRetained": @NO}});
}
NSString* ProcessStart(pid_t pid) {
  proc_bsdinfo info{};
  Require(proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) == static_cast<int>(sizeof(info)), "ERR_MAC_SOURCE_IDENTITY");
  const uint64_t value = info.pbi_start_tvsec * uint64_t{1000000} + info.pbi_start_tvusec;
  Require(value > 0, "ERR_MAC_SOURCE_IDENTITY");
  return [NSString stringWithFormat:@"%llu", static_cast<unsigned long long>(value)];
}
NSString* DisplayUuid(CGDirectDisplayID id) {
  CFUUIDRef uuid = CGDisplayCreateUUIDFromDisplayID(id);
  Require(uuid != nullptr, "ERR_MAC_SOURCE_IDENTITY");
  NSString* text = CFBridgingRelease(CFUUIDCreateString(kCFAllocatorDefault, uuid));
  CFRelease(uuid);
  return text.lowercaseString;
}
NSDictionary* WindowTarget(SCWindow* window) {
  const pid_t pid = window.owningApplication.processID;
  Require(pid > 0 && window.windowID > 0, "ERR_MAC_SOURCE_IDENTITY");
  return @{@"platform": @"darwin", @"kind": @"window", @"windowId": @(window.windowID),
      @"expectedProcessId": @(pid), @"expectedProcessStartTimeUs": ProcessStart(pid)};
}
NSDictionary* MonitorTarget(SCDisplay* display) {
  const CGRect frame = CGDisplayBounds(display.displayID);
  return @{@"platform": @"darwin", @"kind": @"monitor", @"displayId": @(display.displayID),
      @"displayUuid": DisplayUuid(display.displayID),
      @"bounds": @{@"x": @(frame.origin.x), @"y": @(frame.origin.y),
        @"width": @(display.width), @"height": @(display.height)}};
}
SCContentFilter* Resolve(SCShareableContent* content, NSDictionary* target) {
  Require([target isKindOfClass:NSDictionary.class] && [target[@"platform"] isEqual:@"darwin"]);
  if ([target[@"kind"] isEqual:@"window"]) {
    Exact(target, @[@"platform", @"kind", @"windowId", @"expectedProcessId", @"expectedProcessStartTimeUs"]);
    const auto id = Number(target[@"windowId"], 1, UINT32_MAX);
    Number(target[@"expectedProcessId"], 1, INT32_MAX);
    Text(target[@"expectedProcessStartTimeUs"], 20);
    for (SCWindow* window in content.windows) {
      if (window.windowID != id) continue;
      Require([WindowTarget(window) isEqualToDictionary:target], "ERR_MAC_SOURCE_CHANGED");
      return [[SCContentFilter alloc] initWithDesktopIndependentWindow:window];
    }
  } else if ([target[@"kind"] isEqual:@"monitor"]) {
    Exact(target, @[@"platform", @"kind", @"displayId", @"displayUuid", @"bounds"]);
    const auto id = Number(target[@"displayId"], 1, UINT32_MAX);
    Text(target[@"displayUuid"], 36);
    for (SCDisplay* display in content.displays) {
      if (display.displayID != id) continue;
      Require([MonitorTarget(display) isEqualToDictionary:target], "ERR_MAC_SOURCE_CHANGED");
      return [[SCContentFilter alloc] initWithDisplay:display excludingWindows:@[]];
    }
  } else throw Failure("ERR_MAC_ARGUMENT");
  throw Failure("ERR_MAC_SOURCE_LOST");
}
void VerifyTarget(NSDictionary* target) {
  if ([target[@"kind"] isEqual:@"window"]) {
    const auto pid = static_cast<pid_t>(Number(target[@"expectedProcessId"], 1, INT32_MAX));
    Require([ProcessStart(pid) isEqual:target[@"expectedProcessStartTimeUs"]], "ERR_MAC_SOURCE_CHANGED");
    const auto id = static_cast<CGWindowID>(Number(target[@"windowId"], 1, UINT32_MAX));
    NSArray* windows = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, id));
    Require(windows.count == 1 &&
        [windows[0][(__bridge NSString*)kCGWindowOwnerPID] intValue] == pid, "ERR_MAC_SOURCE_CHANGED");
  } else {
    const auto id = static_cast<CGDirectDisplayID>(Number(target[@"displayId"], 1, UINT32_MAX));
    Require(CGDisplayIsActive(id) && [DisplayUuid(id) isEqual:target[@"displayUuid"]], "ERR_MAC_SOURCE_CHANGED");
    NSDictionary* bounds = target[@"bounds"];
    const CGRect frame = CGDisplayBounds(id);
    Require(frame.origin.x == [bounds[@"x"] doubleValue] && frame.origin.y == [bounds[@"y"] doubleValue] &&
        frame.size.width == [bounds[@"width"] doubleValue] &&
        frame.size.height == [bounds[@"height"] doubleValue], "ERR_MAC_SOURCE_CHANGED");
  }
}
void Finish() {
  Require(operations > 0, "ERR_MAC_OWNERSHIP");
  --operations;
}
void Snapshot(uint64_t request, SCShareableContent* content, NSDictionary* arguments) {
  Exact(arguments, @[@"target", @"width", @"height"]);
  const auto width = Number(arguments[@"width"], 1, 640);
  const auto height = Number(arguments[@"height"], 1, 360);
  NSDictionary* target = arguments[@"target"];
  SCContentFilter* filter = Resolve(content, target);
  const double scale = filter.pointPixelScale;
  const CGRect frame = filter.contentRect;
  Require(frame.size.width > 0 && frame.size.height > 0 && scale > 0, "ERR_MAC_SOURCE_UNAVAILABLE");
  const double factor = std::min(width / (frame.size.width * scale), height / (frame.size.height * scale));
  SCStreamConfiguration* config = [SCStreamConfiguration new];
  config.width = std::max(1, static_cast<int>(std::floor(frame.size.width * scale * factor)));
  config.height = std::max(1, static_cast<int>(std::floor(frame.size.height * scale * factor)));
  config.showsCursor = NO;
  config.capturesAudio = NO;
  [SCScreenshotManager captureImageWithFilter:filter configuration:config
      completionHandler:^(CGImageRef image, NSError* error) {
    @autoreleasepool {
      try {
        if (error || !image) throw Failure("ERR_MAC_THUMBNAIL_CAPTURE");
        if (closing) throw Failure("ERR_MAC_CANCELLED");
        Require(CGImageGetWidth(image) <= static_cast<size_t>(width) &&
            CGImageGetHeight(image) <= static_cast<size_t>(height), "ERR_MAC_THUMBNAIL_SIZE");
        NSBitmapImageRep* bitmap = [[NSBitmapImageRep alloc] initWithCGImage:image];
        NSData* png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
        Require(png.length > 8 && png.length <= kMaximumImage, "ERR_MAC_THUMBNAIL_SIZE");
        VerifyTarget(target);
        Output(@{@"type": @"result", @"id": @(request), @"value": @{@"mimeType": @"image/png"}}, png);
      } catch (const Failure& failure) {
        Error(request, failure.what(), error.code);
      } catch (...) { Error(request, "ERR_MAC_NATIVE"); }
      Finish();
    }
  }];
}
void Content(uint64_t request, NSString* method, NSDictionary* arguments) {
  if (!CGPreflightScreenCaptureAccess()) {
    Error(request, "ERR_MAC_SCREEN_PERMISSION");
    Finish();
    return;
  }
  [SCShareableContent getShareableContentExcludingDesktopWindows:YES onScreenWindowsOnly:NO
      completionHandler:^(SCShareableContent* content, NSError* error) {
    @autoreleasepool {
      bool screenshotPending = false;
      try {
        if (error || !content) throw Failure("ERR_MAC_ENUMERATION");
        if (closing) throw Failure("ERR_MAC_CANCELLED");
        if ([method isEqual:@"list"]) {
          Exact(arguments, @[]);
          NSMutableArray* sources = [NSMutableArray new];
          for (SCDisplay* display in content.displays) {
            NSMutableDictionary* row = [MonitorTarget(display) mutableCopy];
            row[@"name"] = @"Display";
            row[@"width"] = @(display.width);
            row[@"height"] = @(display.height);
            [sources addObject:row];
          }
          for (SCWindow* window in content.windows) {
            if (!window.owningApplication || window.windowLayer != 0 || window.frame.size.width < 1 ||
                window.frame.size.height < 1 || window.title.length == 0) continue;
            NSMutableDictionary* row = [WindowTarget(window) mutableCopy];
            row[@"processId"] = row[@"expectedProcessId"];
            row[@"processStartTimeUs"] = row[@"expectedProcessStartTimeUs"];
            row[@"name"] = [window.title substringToIndex:std::min(NSUInteger{512}, window.title.length)];
            row[@"width"] = @(static_cast<int>(window.frame.size.width));
            row[@"height"] = @(static_cast<int>(window.frame.size.height));
            [sources addObject:row];
          }
          Require(sources.count <= 512, "ERR_MAC_SOURCE_LIMIT");
          Output(@{@"type": @"result", @"id": @(request), @"value": @{@"sources": sources}});
        } else if ([method isEqual:@"resolve"]) {
          Exact(arguments, @[@"target"]);
          Resolve(content, arguments[@"target"]);
          Output(@{@"type": @"result", @"id": @(request), @"value": @{@"target": arguments[@"target"]}});
        } else if ([method isEqual:@"thumbnail"]) {
          Snapshot(request, content, arguments);
          screenshotPending = true;
        } else throw Failure("ERR_MAC_ARGUMENT");
      } catch (const Failure& failure) { Error(request, failure.what(), error.code); }
      catch (...) { Error(request, "ERR_MAC_NATIVE"); }
      if (!screenshotPending) Finish();
    }
  }];
}
void Command(NSData* bytes) {
  NSError* error = nil;
  NSDictionary* command = [NSJSONSerialization JSONObjectWithData:bytes options:0 error:&error];
  Require(command && !error);
  Exact(command, @[@"id", @"method", @"data"]);
  const auto request = static_cast<uint64_t>(Number(command[@"id"], 1, 9007199254740991LL));
  NSString* method = Text(command[@"method"], 32);
  NSDictionary* arguments = command[@"data"];
  Require([arguments isKindOfClass:NSDictionary.class]);
  const auto previous = latestCommand.exchange(request);
  Require(request > previous);
  if ([method isEqual:@"close"]) {
    Exact(arguments, @[]);
    closing = true;
    std::thread([request] {
      for (int i = 0; i < 150 && operations; ++i) usleep(100000);
      if (operations) _exit(124);
      Output(@{@"type": @"result", @"id": @(request), @"value": @{@"nativeClosed": @YES}});
      _exit(0);
    }).detach();
    return;
  }
  Require(!closing, "ERR_MAC_CLOSED");
  if ([method isEqual:@"capabilities"]) {
    Exact(arguments, @[]);
    Output(@{@"type": @"result", @"id": @(request), @"value": @{
      @"platform": @"darwin", @"minimumMacOS": @"14.0", @"enumeration": @"ScreenCaptureKit",
      @"thumbnails": @"SCScreenshotManager", @"capture": @NO, @"encoder": [NSNull null],
      @"transport": @NO, @"receive": @NO, @"audio": @NO}});
    return;
  }
  if ([method isEqual:@"permission"]) {
    Exact(arguments, @[]);
    const bool allowed = CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess();
    Output(@{@"type": @"result", @"id": @(request), @"value": @{@"granted": @(allowed)}});
    return;
  }
  Require([method isEqual:@"list"] || [method isEqual:@"resolve"] || [method isEqual:@"thumbnail"]);
  Require(operations.load() < 16, "ERR_MAC_CREDITS");
  ++operations;
  dispatch_async(dispatch_get_main_queue(), ^{
    @autoreleasepool {
      try { Content(request, method, arguments); }
      catch (const Failure& failure) { Error(request, failure.what()); Finish(); }
      catch (...) { Error(request, "ERR_MAC_NATIVE"); Finish(); }
    }
  });
}
}

int main(int argc, const char* argv[]) {
  @autoreleasepool {
    if (@available(macOS 14.0, *)) {
      if (argc == 2 && std::string_view(argv[1]) == "--self-test") {
        Require(ProcessStart(getpid()).length > 0);
        std::puts("{\"deviceFree\":true,\"checks\":1}");
        return 0;
      }
      if (argc != 1) return 64;
      signal(SIGPIPE, SIG_IGN);
      const pid_t owner = getppid();
      std::thread([owner] {
        for (;;) {
          if (getppid() != owner) _exit(125);
          usleep(250000);
        }
      }).detach();
      Output(@{@"type": @"hello", @"protocol": @1, @"pid": @(getpid()), @"platform": @"darwin"});
      std::thread([] {
        std::vector<uint8_t> line;
        uint8_t buffer[4096];
        for (;;) {
          const auto count = read(STDIN_FILENO, buffer, sizeof(buffer));
          if (count < 0 && errno == EINTR) continue;
          if (count <= 0) _exit(125);
          for (ssize_t index = 0; index < count; ++index) {
            if (buffer[index] == '\n') {
              @autoreleasepool {
                try { Command([NSData dataWithBytes:line.data() length:line.size()]); }
                catch (const Failure& failure) {
                  Output(@{@"type": @"failure", @"code": @(failure.what()), @"nativeStatus": @0});
                  _exit(65);
                } catch (...) { _exit(70); }
              }
              line.clear();
            } else {
              if (line.size() == kMaximumCommand) _exit(65);
              line.push_back(buffer[index]);
            }
          }
        }
      }).detach();
      dispatch_main();
    }
    return 69;
  }
}
