#import <AppKit/AppKit.h>
#import <AVFoundation/AVFoundation.h>
#include <atomic>
#include <cmath>
#include <iostream>
#include <memory>
#include <thread>
#include <sstream>
#include <unistd.h>

@interface MonkyAudioFixtureView : NSView
@property(nonatomic) NSUInteger tick;
@end
@implementation MonkyAudioFixtureView
- (void)drawRect:(NSRect)rect {
  [[NSColor blackColor] setFill]; NSRectFill(self.bounds);
  [[NSColor redColor] setFill]; NSRectFill(NSMakeRect(0, self.bounds.size.height * .8, self.bounds.size.width, self.bounds.size.height * .2));
  [[NSColor blueColor] setFill]; NSRectFill(NSMakeRect(0, 0, self.bounds.size.width, self.bounds.size.height * .2));
  [[NSColor magentaColor] setFill];
  NSRectFill(NSMakeRect(0, self.bounds.size.height * .2, self.bounds.size.width * .1, self.bounds.size.height * .6));
  NSRectFill(NSMakeRect(self.bounds.size.width * .9, self.bounds.size.height * .2, self.bounds.size.width * .1, self.bounds.size.height * .6));
  [[NSColor whiteColor] setFill];
  NSRectFill(NSMakeRect(self.tick % static_cast<NSUInteger>(self.bounds.size.width - 20), 0, 20, self.bounds.size.height));
}
@end

struct WindowOwner {
  NSWindow* window = nil;
};

int main() {
  @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    NSWindow* window = [[NSWindow alloc] initWithContentRect:NSMakeRect(40, 40, 800, 600)
        styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    window.title = @"Monky synthetic stereo audio";
    window.backgroundColor = [NSColor colorWithRed:0.1 green:0.2 blue:0.4 alpha:1];
    MonkyAudioFixtureView* view = [[MonkyAudioFixtureView alloc] initWithFrame:window.contentView.bounds];
    window.contentView = view;
    NSTimer* timer = [NSTimer scheduledTimerWithTimeInterval:1.0 / 60 repeats:YES block:^(NSTimer*) {
      view.tick++; view.needsDisplay = YES;
    }];
    [window makeKeyAndOrderFront:nil];
    auto windowOwner = std::make_shared<WindowOwner>();
    windowOwner->window = window;
    AVAudioEngine* engine = [[AVAudioEngine alloc] init];
    AVAudioFormat* format = [[AVAudioFormat alloc] initStandardFormatWithSampleRate:48000 channels:2];
    auto frameIndex = std::make_shared<uint64_t>(0);
    auto audible = std::make_shared<std::atomic<int>>(0);
    AVAudioSourceNode* source = [[AVAudioSourceNode alloc] initWithFormat:format
        renderBlock:^OSStatus(BOOL* silent, const AudioTimeStamp*, AVAudioFrameCount frames, AudioBufferList* data) {
      if (data->mNumberBuffers != 2) return kAudio_ParamError;
      const int mode = audible->load();
      *silent = mode == 0;
      for (uint32_t channel = 0; channel < 2; ++channel) {
        if (!data->mBuffers[channel].mData || data->mBuffers[channel].mDataByteSize < frames * sizeof(float))
          return kAudio_ParamError;
        auto* samples = static_cast<float*>(data->mBuffers[channel].mData);
        const double frequency = mode == 2 ? 440 : channel == 0 ? 880 : 1320;
        const double amplitude = mode == 2 ? (channel == 0 ? .01 : -.01) : .02;
        for (uint32_t frame = 0; frame < frames; ++frame)
          samples[frame] = mode ? static_cast<float>(amplitude * std::sin(
              2 * 3.141592653589793 * frequency * (*frameIndex + frame) / 48000)) : 0;
      }
      *frameIndex += frames;
      return noErr;
    }];
    [engine attachNode:source];
    [engine connect:source to:engine.mainMixerNode format:format];
    NSError* error = nil;
    if (![engine startAndReturnError:&error]) {
      std::cerr << "Cannot start owned synthetic audio: " << error.localizedDescription.UTF8String << std::endl;
      return 1;
    }
    std::thread controls([audible, engine, windowOwner] {
      std::string line;
      while (std::getline(std::cin, line)) {
        if (line == "play") audible->store(1);
        else if (line == "close") break;
        else {
          std::istringstream input(line);
          std::string id, command;
          input >> id >> command;
          if (id.size() != 36 || id.find_first_not_of("0123456789abcdef-") != std::string::npos ||
              (command != "tone-start" && command != "tone-stop" && command != "close-source")) {
            std::cerr << "Invalid synthetic source command" << std::endl;
            break;
          }
          dispatch_async(dispatch_get_main_queue(), ^{
            audible->store(command == "tone-start" ? 2 : 0);
            if (command == "close-source") {
              [windowOwner->window close];
              windowOwner->window = nil;
            }
            std::cout << "MONKY_SOURCE {\"type\":\"result\",\"id\":\"" << id << "\",\"ok\":true,"
                      << "\"sourceDestroyed\":" << (command == "close-source" ? "true" : "false") << "}" << std::endl;
          });
        }
      }
      dispatch_async(dispatch_get_main_queue(), ^{
        [engine stop];
        [NSApp stop:nil];
        NSEvent* wake = [NSEvent otherEventWithType:NSEventTypeApplicationDefined location:NSZeroPoint
            modifierFlags:0 timestamp:0 windowNumber:0 context:nil subtype:0 data1:0 data2:0];
        [NSApp postEvent:wake atStart:YES];
      });
    });
    std::cout << "MONKY_SOURCE {\"type\":\"ready\",\"pid\":" << getpid()
              << ",\"hwnd\":" << window.windowNumber << "}" << std::endl;
    window = nil;
    [NSApp run];
    controls.join();
    [timer invalidate];
    [engine disconnectNodeOutput:source];
    [engine detachNode:source];
    [windowOwner->window orderOut:nil];
  }
  return 0;
}
