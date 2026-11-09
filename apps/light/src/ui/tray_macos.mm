#include "ui/tray.hpp"
#include "ui/tray_controller.hpp"

#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Foundation/Foundation.h>

#include <cstdint>
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
constexpr NSInteger kPushToTalk = 9;
constexpr NSInteger kVolume = 10;
constexpr NSInteger kSwitchServer = 11;
constexpr NSInteger kStartup = 12;

// Device-dependent modifier bits (NX_DEVICER*KEYMASK): a right-hand modifier
// arrives as flagsChanged, and only these bits tell it from the left one.
std::optional<NSUInteger> rightModifierMask(std::uint16_t code) {
  if (code == 0x3C) return 0x00000004;  // Right Shift
  if (code == 0x3E) return 0x00002000;  // Right Control
  if (code == 0x3D) return 0x00000040;  // Right Option
  return std::nullopt;
}

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
  MacTray(CoreCommands core, Language language, std::optional<Startup> startup)
      : controller_(std::move(core), language, std::move(startup)), text_(textFor(language)) {
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
      unhook();
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
    // Opening the menu is when someone returns after granting Accessibility.
    watch(view.hotkey);
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
    add(menu, view.pushToTalkLabel, kPushToTalk, view.connected, view.pushToTalkChecked, nil);
    if (!view.people.empty()) {
      [menu addItem:[NSMenuItem separatorItem]];
      NSMenu* people = [[NSMenu alloc] init];
      people.autoenablesItems = NO;
      for (const auto& person : view.people) {
        NSMenu* volumes = [[NSMenu alloc] init];
        volumes.autoenablesItems = NO;
        for (const auto preset : kVolumePresets) {
          add(volumes, std::to_string(preset) + "%", kVolume, true, person.volume == preset,
              @[ text(person.sessionId), @(preset) ]);
        }
        auto label = person.name;
        if (person.volume != 100) label += " · " + std::to_string(person.volume) + "%";
        if (person.speaking) label += " (" + std::string(text_.speaking) + ")";
        submenu(people, label, volumes, true);
      }
      submenu(menu, text_.inThisCall, people, true);
    }
    [menu addItem:[NSMenuItem separatorItem]];
    NSMenu* devices = [[NSMenu alloc] init];
    devices.autoenablesItems = NO;
    submenu(devices, text_.input, rows(view.inputs, kInput), true);
    submenu(devices, text_.output, rows(view.outputs, kOutput), true);
    submenu(menu, text_.audioDevices, devices, true);
    [menu addItem:[NSMenuItem separatorItem]];
    add(menu, text_.reconnectNow, kReconnect, true, false, nil);
    if (view.canSwitchServer) add(menu, text_.switchServer, kSwitchServer, true, false, nil);
    if (view.startupAvailable) add(menu, text_.startWithSystem, kStartup, true, view.startupChecked, nil);
    add(menu, text_.quit, kQuit, true, false, nil);
  }

  void activate(NSMenuItem* item) {
    if (item.tag == kVolume) {
      NSArray* choice = item.representedObject;
      if (choice.count == 2) controller_.setVolume(utf8(choice[0]), [choice[1] intValue]);
      return;
    }
    const auto identifier = utf8((NSString*)item.representedObject);
    const auto wanted = item.state != NSControlStateValueOn;
    switch (item.tag) {
      case kQuit: controller_.quit(); break;
      case kLeave: controller_.leave(); break;
      case kMute: controller_.setMuted(wanted); break;
      case kDeafen: controller_.setDeafened(wanted); break;
      case kReconnect: controller_.reconnect(); break;
      case kPushToTalk: controller_.setPushToTalk(wanted); break;
      case kSwitchServer: controller_.switchServer(); break;
      case kStartup:
        controller_.setStartup(wanted);
        refresh();  // A refusal arrives as an alert.
        break;
      case kJoin: controller_.join(identifier); break;
      case kInput: controller_.selectInput(identifier); break;
      case kOutput: controller_.selectOutput(identifier); break;
      default: break;
    }
  }

 private:
  void add(NSMenu* menu, const std::string& label, NSInteger tag, bool enabled, bool checked,
           id represented) {
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
    watch(view.hotkey);
    @autoreleasepool {
      NSString* symbol = !view.connected  ? @"bolt.horizontal.circle"
                         : view.silenced  ? @"mic.slash.fill"
                         : view.speaking  ? @"speaker.wave.2.circle.fill"
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

  // A global monitor sees input meant for other applications. It is added only
  // while push-to-talk can transmit and never consumes the event. Keys need the
  // Accessibility permission; without it macOS delivers no key events at all,
  // so the monitor is added again once the user grants it.
  void watch(const std::optional<PushToTalkKey>& key) {
    const bool keyboard = key && key->kind == PushToTalkKey::Kind::keyboard;
    const bool trusted = !keyboard || AXIsProcessTrusted();
    const auto wanted = key ? std::optional<std::string>(key->name) : std::nullopt;
    if (wanted == watched_ && trusted == trusted_) return;
    unhook();
    if (!key || !key->mac) return;
    if (!trusted && !prompted_) {
      prompted_ = true;
      // Shows the system prompt once; the setting itself stays the user's.
      NSDictionary* options = @{(__bridge NSString*)kAXTrustedCheckOptionPrompt : @YES};
      AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)options);
      alert_ = std::string(text_.accessibilityRequired);
    }
    const auto code = *key->mac;
    const auto modifier = rightModifierMask(code);
    NSEventMask mask = keyboard ? (modifier ? NSEventMaskFlagsChanged : (NSEventMaskKeyDown | NSEventMaskKeyUp))
                                : (NSEventMaskOtherMouseDown | NSEventMaskOtherMouseUp);
    TrayController* controller = &controller_;
    const bool mouse = !keyboard;
    monitor_ = [NSEvent addGlobalMonitorForEventsMatchingMask:mask
                                                      handler:^(NSEvent* event) {
      if (mouse) {
        if (event.buttonNumber == code) controller->pushToTalk(event.type == NSEventTypeOtherMouseDown);
      } else if (event.keyCode == code) {
        if (modifier) controller->pushToTalk((event.modifierFlags & *modifier) != 0);
        else if (!event.isARepeat) controller->pushToTalk(event.type == NSEventTypeKeyDown);
      }
    }];
    watched_ = wanted;
    trusted_ = trusted;
  }

  void unhook() {
    if (!monitor_) return;
    [NSEvent removeMonitor:monitor_];
    monitor_ = nil;
    watched_.reset();
    controller_.releasePushToTalk();
  }

  TrayController controller_;
  const Strings& text_;
  id monitor_ = nil;
  std::optional<std::string> watched_;
  bool trusted_ = false;
  bool prompted_ = false;
  MonkyLightTrayTarget* target_ = nil;
  NSStatusItem* item_ = nil;
  NSMenu* menu_ = nil;
  std::optional<std::string> alert_;
};

std::unique_ptr<CoreInterface> createTray(CoreCommands core, Language language, std::optional<Startup> startup) {
  return std::make_unique<MacTray>(std::move(core), language, std::move(startup));
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
