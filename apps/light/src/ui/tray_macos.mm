#include "ui/tray.hpp"
#include "ui/tray_controller.hpp"

#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>

#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace monky::light::ui {
namespace {

// Menu tags. Which row was chosen travels in representedObject, so the tag only
// has to say what kind of activation it is.
constexpr NSInteger kQuit = 1;
constexpr NSInteger kLeave = 2;
constexpr NSInteger kMute = 3;
constexpr NSInteger kDeafen = 4;
constexpr NSInteger kReconnect = 5;
constexpr NSInteger kJoin = 6;
constexpr NSInteger kInput = 7;
constexpr NSInteger kOutput = 8;

NSString* text(const std::string& value) {
  NSString* result = [NSString stringWithUTF8String:value.c_str()];
  return result ?: @"";
}

std::string utf8(NSString* value) {
  const char* bytes = value ? value.UTF8String : nullptr;
  return bytes ? std::string(bytes) : std::string();
}

}  // namespace
}  // namespace monky::light::ui

// The menu delegate and the action target have to be an Objective-C object. It
// holds the tray as an opaque pointer so this declaration needs no C++ type.
@interface MonkyLightTrayTarget : NSObject <NSMenuDelegate>
- (instancetype)initWithOwner:(void*)owner;
@end

namespace monky::light::ui {

class MacTray final : public CoreInterface {
 public:
  MacTray(CoreCommands core, Language language)
      : controller_(std::move(core), language), text_(textFor(language)) {
    @autoreleasepool {
      NSApplication* application = [NSApplication sharedApplication];
      // An accessory application has no Dock tile and no window; the status item
      // is the whole interface, so nothing keeps rendering between activations.
      [application setActivationPolicy:NSApplicationActivationPolicyAccessory];
      target_ = [[MonkyLightTrayTarget alloc] initWithOwner:this];
      item_ = [[NSStatusBar systemStatusBar] statusItemWithLength:NSVariableStatusItemLength];
      if (!item_) throw std::runtime_error("Could not add Monky Light to the status bar");
      menu_ = [[NSMenu alloc] init];
      // The rows are rebuilt by the delegate when the menu opens, and the states
      // below are ours to decide, not AppKit's to infer from a responder chain.
      menu_.autoenablesItems = NO;
      menu_.delegate = target_;
      item_.menu = menu_;
      refresh();
    }
  }

  ~MacTray() override {
    @autoreleasepool {
      menu_.delegate = nil;
      if (item_) [[NSStatusBar systemStatusBar] removeStatusItem:item_];
    }
  }

  void observe(const Json& event) override {
    if (!controller_.observe(event)) return;
    // The main queue is the interface thread. Blocks queued after the run loop
    // stops simply never execute, which is why this never blocks on a result.
    dispatch_async(dispatch_get_main_queue(), ^{ refresh(); });
  }

  void stopped() override {
    dispatch_async(dispatch_get_main_queue(), ^{
      [NSApp stop:nil];
      // stop: is only honoured once the next event is processed, so post one.
      [NSApp postEvent:[NSEvent otherEventWithType:NSEventTypeApplicationDefined
                                          location:NSZeroPoint
                                     modifierFlags:0
                                         timestamp:0
                                      windowNumber:0
                                           context:nil
                                           subtype:0
                                            data1:0
                                            data2:0]
               atStart:YES];
    });
  }

  int run() override {
    @autoreleasepool {
      [NSApp run];
    }
    return 0;
  }

  void build(NSMenu* menu) {
    const auto view = controller_.presentation();
    [menu removeAllItems];
    add(menu, view.status, 0, false, false, nil);
    // macOS notifications need an authorized, signed bundle, which belongs to
    // the distribution step, so the last failure stays readable here instead.
    if (alert_) add(menu, *alert_, 0, false, false, nil);
    [menu addItem:[NSMenuItem separatorItem]];
    if (view.channels.empty()) {
      add(menu, text_.noChannels, 0, false, false, nil);
    } else {
      NSMenu* channels = [[NSMenu alloc] init];
      channels.autoenablesItems = NO;
      for (const auto& channel : view.channels) {
        add(channels, channel.name, kJoin, true, channel.selected, text(channel.id));
      }
      submenu(menu, text_.channels, channels, view.canJoin);
    }
    add(menu, text_.leaveChannel, kLeave, view.canLeave, false, nil);
    [menu addItem:[NSMenuItem separatorItem]];
    add(menu, view.muteLabel, kMute, view.muteEnabled, view.muteChecked, nil);
    add(menu, view.deafenLabel, kDeafen, view.deafenEnabled, view.deafenChecked, nil);
    [menu addItem:[NSMenuItem separatorItem]];
    NSMenu* devices = [[NSMenu alloc] init];
    devices.autoenablesItems = NO;
    submenu(devices, text_.input, rows(view.inputs, kInput), true);
    submenu(devices, text_.output, rows(view.outputs, kOutput), true);
    submenu(menu, text_.audioDevices, devices, true);
    [menu addItem:[NSMenuItem separatorItem]];
    add(menu, text_.reconnectNow, kReconnect, true, false, nil);
    add(menu, text_.quit, kQuit, true, false, nil);
  }

  void activate(NSMenuItem* item) {
    const auto identifier = utf8((NSString*)item.representedObject);
    const auto wanted = item.state != NSControlStateValueOn;
    switch (item.tag) {
      case kQuit: controller_.quit(); break;
      case kLeave: controller_.leave(); break;
      case kMute: controller_.setMuted(wanted); break;
      case kDeafen: controller_.setDeafened(wanted); break;
      case kReconnect: controller_.reconnect(); break;
      case kJoin: controller_.join(identifier); break;
      case kInput: controller_.selectInput(identifier); break;
      case kOutput: controller_.selectOutput(identifier); break;
      default: break;
    }
  }

 private:
  void add(NSMenu* menu, const std::string& label, NSInteger tag, bool enabled, bool checked,
           NSString* represented) {
    NSMenuItem* item = [[NSMenuItem alloc] initWithTitle:text(label) action:nil keyEquivalent:@""];
    if (tag != 0) {
      item.action = @selector(activate:);
      item.target = target_;
    }
    item.tag = tag;
    item.enabled = enabled;
    item.state = checked ? NSControlStateValueOn : NSControlStateValueOff;
    item.representedObject = represented;
    [menu addItem:item];
  }

  NSMenu* rows(const std::vector<MenuEntry>& entries, NSInteger tag) {
    NSMenu* result = [[NSMenu alloc] init];
    result.autoenablesItems = NO;
    for (const auto& entry : entries) {
      add(result, entry.name, tag, true, entry.selected, text(entry.id));
    }
    return result;
  }

  void submenu(NSMenu* menu, const std::string& label, NSMenu* attached, bool enabled) {
    NSMenuItem* item = [[NSMenuItem alloc] initWithTitle:text(label) action:nil keyEquivalent:@""];
    item.submenu = attached;
    item.enabled = enabled;
    [menu addItem:item];
  }

  void refresh() {
    const auto view = controller_.presentation();
    if (auto alert = controller_.takeAlert()) alert_ = std::move(alert);
    @autoreleasepool {
      NSString* symbol = !view.connected  ? @"bolt.horizontal.circle"
                         : view.silenced  ? @"mic.slash.fill"
                         : view.inCall    ? @"waveform.circle.fill"
                                          : @"mic.fill";
      NSImage* image = [NSImage imageWithSystemSymbolName:symbol
                                accessibilityDescription:text(view.status)];
      if (image) {
        // A template image follows the menu bar appearance and Dark Mode.
        [image setTemplate:YES];
        item_.button.image = image;
        item_.button.title = @"";
      } else {
        item_.button.image = nil;
        item_.button.title = @"M";
      }
      item_.button.toolTip = text(view.tooltip);
      // The icon carries no text, so VoiceOver reads the state from here.
      item_.button.accessibilityLabel = text(view.tooltip);
    }
  }

  TrayController controller_;
  const Strings& text_;
  MonkyLightTrayTarget* target_ = nil;
  NSStatusItem* item_ = nil;
  NSMenu* menu_ = nil;
  std::optional<std::string> alert_;
};

std::unique_ptr<CoreInterface> createTray(CoreCommands core, Language language) {
  return std::make_unique<MacTray>(std::move(core), language);
}

Language systemLanguage() {
  @autoreleasepool {
    NSString* preferred = [NSLocale preferredLanguages].firstObject;
    if (preferred && [preferred hasPrefix:@"pt"]) return Language::portuguese;
  }
  return Language::english;
}

}  // namespace monky::light::ui

@implementation MonkyLightTrayTarget {
  void* _owner;
}

- (instancetype)initWithOwner:(void*)owner {
  self = [super init];
  if (self) _owner = owner;
  return self;
}

- (monky::light::ui::MacTray*)tray {
  return static_cast<monky::light::ui::MacTray*>(_owner);
}

- (void)menuNeedsUpdate:(NSMenu*)menu {
  [self tray]->build(menu);
}

- (void)activate:(NSMenuItem*)item {
  [self tray]->activate(item);
}

@end
