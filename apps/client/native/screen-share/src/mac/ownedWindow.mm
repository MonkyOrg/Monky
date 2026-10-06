#include "ownedWindow.h"
#import <AppKit/AppKit.h>
#include <cmath>
#include <stdexcept>
#include <thread>
#include <unistd.h>

@interface MonkyCaptureFixtureView : NSView
@property(nonatomic) unsigned tick;
@end
@implementation MonkyCaptureFixtureView
- (void)drawRect:(NSRect)dirty {
  (void)dirty;
  [[NSColor colorWithSRGBRed:1 green:0 blue:0 alpha:1] setFill];
  NSRectFill(NSMakeRect(0, 0, self.bounds.size.width / 2, self.bounds.size.height));
  [[NSColor colorWithSRGBRed:0 green:0 blue:1 alpha:1] setFill];
  NSRectFill(NSMakeRect(self.bounds.size.width / 2, 0, self.bounds.size.width / 2, self.bounds.size.height));
  [NSColor.greenColor setFill];
  NSRectFill(NSMakeRect(self.tick % 600, 0, 16, 8));
}
@end

namespace monky::screen::mac {
int RunOwnedWindow(const std::function<void(uint32_t)>& ready) {
  @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    NSScreen* display = NSScreen.screens.firstObject;
    if (!display || display.visibleFrame.size.width < 640 || display.visibleFrame.size.height < 360)
      throw std::runtime_error("ERR_MAC_TEST_DISPLAY");
    const NSRect area = display.visibleFrame;
    const NSRect frame = NSMakeRect(area.origin.x + std::floor((area.size.width - 640) / 2),
      area.origin.y + std::floor((area.size.height - 360) / 2), 640, 360);
    NSWindow* window = [[NSWindow alloc] initWithContentRect:frame styleMask:NSWindowStyleMaskBorderless
      backing:NSBackingStoreBuffered defer:NO screen:display];
    window.releasedWhenClosed = NO;
    window.title = @"Monky owned capture fixture";
    MonkyCaptureFixtureView* view = [[MonkyCaptureFixtureView alloc] initWithFrame:NSMakeRect(0, 0, 640, 360)];
    window.contentView = view;
    [window orderFrontRegardless];
    [window displayIfNeeded];
    if (window.windowNumber <= 0 || window.windowNumber > UINT32_MAX)
      throw std::runtime_error("ERR_MAC_TEST_WINDOW");
    ready(static_cast<uint32_t>(window.windowNumber));
    NSTimer* timer = [NSTimer scheduledTimerWithTimeInterval:1.0 / 30 repeats:YES block:^(NSTimer*) {
      ++view.tick;
      view.needsDisplay = YES;
    }];
    std::thread([] {
      uint8_t input[32];
      for (;;) {
        const auto count = read(STDIN_FILENO, input, sizeof(input));
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) _exit(0);
      }
    }).detach();
    [NSApp run];
    [timer invalidate];
    [window close];
    return 0;
  }
}
}
