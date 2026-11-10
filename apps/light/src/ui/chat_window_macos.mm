#include "ui/chat_window_macos.hpp"

#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>

#include <algorithm>
#include <string>
#include <utility>
#include <vector>

namespace {

NSString* text(const std::string& value) {
  NSString* result = [NSString stringWithUTF8String:value.c_str()];
  return result ?: @"";
}

std::string utf8(NSString* value) {
  const char* bytes = value ? value.UTF8String : nullptr;
  return bytes ? std::string(bytes) : std::string();
}

}  // namespace

// The window delegate and action target. It holds the window's state as an
// opaque pointer so the C++ header needs no Objective-C type.
@interface MonkyLightChatTarget : NSObject <NSWindowDelegate>
- (instancetype)initWithOwner:(void*)owner;
@end

namespace monky::light::ui {

struct MacChatWindow::Impl {
  ChatController& chat;
  const Strings& strings;
  std::function<void()> onClosed;
  MonkyLightChatTarget* target = nil;
  NSWindow* window = nil;
  NSPopUpButton* channel = nil;
  NSButton* older = nil;
  NSTextView* transcript = nil;
  NSTextField* input = nil;
  NSTextField* status = nil;
  std::vector<ChatLine> shown;
  bool keepTop = false;
  bool closed = false;

  Impl(ChatController& controller, const Strings& value, std::function<void()> closedCallback)
      : chat(controller), strings(value), onClosed(std::move(closedCallback)) {}

  void build() {
    target = [[MonkyLightChatTarget alloc] initWithOwner:this];
    window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 560, 600)
                                         styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                                                   NSWindowStyleMaskResizable | NSWindowStyleMaskMiniaturizable
                                           backing:NSBackingStoreBuffered
                                             defer:NO];
    window.releasedWhenClosed = NO;
    window.title = text(strings.chatTitle);
    window.minSize = NSMakeSize(380, 300);
    window.delegate = target;
    NSView* content = window.contentView;
    const CGFloat margin = 10;
    const CGFloat width = content.bounds.size.width;
    const CGFloat height = content.bounds.size.height;

    channel = [[NSPopUpButton alloc] initWithFrame:NSMakeRect(margin, height - margin - 26, width - 220, 26)
                                         pullsDown:NO];
    channel.autoresizingMask = NSViewWidthSizable | NSViewMinYMargin;
    channel.target = target;
    channel.action = @selector(channel:);
    channel.accessibilityLabel = text(strings.textChannel);
    [content addSubview:channel];

    older = [NSButton buttonWithTitle:text(strings.loadOlder) target:target action:@selector(older:)];
    older.frame = NSMakeRect(width - margin - 200, height - margin - 26, 200, 26);
    older.autoresizingMask = NSViewMinXMargin | NSViewMinYMargin;
    older.enabled = NO;  // Until the first page arrives.
    [content addSubview:older];

    NSScrollView* scroll = [NSTextView scrollableTextView];
    scroll.frame = NSMakeRect(margin, 70, width - 2 * margin, height - 70 - margin - 34);
    scroll.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    transcript = (NSTextView*)scroll.documentView;
    transcript.editable = NO;
    transcript.selectable = YES;
    transcript.font = [NSFont systemFontOfSize:NSFont.systemFontSize];
    [content addSubview:scroll];

    input = [NSTextField textFieldWithString:@""];
    input.frame = NSMakeRect(margin, 36, width - 2 * margin - 100, 24);
    input.autoresizingMask = NSViewWidthSizable | NSViewMaxYMargin;
    input.placeholderString = text(strings.messageField);
    input.accessibilityLabel = text(strings.messageField);
    input.target = target;
    input.action = @selector(send:);  // Return sends.
    [content addSubview:input];

    NSButton* send = [NSButton buttonWithTitle:text(strings.send) target:target action:@selector(send:)];
    send.frame = NSMakeRect(width - margin - 92, 34, 92, 28);
    send.autoresizingMask = NSViewMinXMargin | NSViewMaxYMargin;
    [content addSubview:send];

    status = [NSTextField labelWithString:@""];
    status.frame = NSMakeRect(margin, 8, width - 2 * margin, 20);
    status.autoresizingMask = NSViewWidthSizable | NSViewMaxYMargin;
    [content addSubview:status];

    channels();
    [window center];
    focus();
    [window makeFirstResponder:input];
  }

  void focus() {
    // An accessory application is not active on its own.
    [NSApp activateIgnoringOtherApps:YES];
    [window makeKeyAndOrderFront:nil];
  }

  void channels() {
    const auto entries = chat.channels();
    const auto current = chat.channel();
    [channel removeAllItems];
    NSInteger selected = -1;
    for (const auto& entry : entries) {
      [channel addItemWithTitle:text(entry.name)];
      channel.lastItem.representedObject = text(entry.id);
      if (current && *current == entry.id) selected = channel.numberOfItems - 1;
    }
    if (entries.empty()) {
      status.stringValue = text(strings.noTextChannels);
      return;
    }
    // The first opening reads the first channel; a list refresh keeps the open one.
    if (selected < 0) {
      selected = 0;
      choose(0);
    }
    [channel selectItemAtIndex:selected];
  }

  void choose(NSInteger index) {
    NSMenuItem* item = [channel itemAtIndex:index];
    if (!item) return;
    shown.clear();
    transcript.string = @"";
    status.stringValue = @"";
    keepTop = false;
    chat.open(utf8((NSString*)item.representedObject));
  }

  NSAttributedString* styled(const std::string& value) {
    // labelColor follows Dark Mode; a plain string would stay black.
    return [[NSAttributedString alloc] initWithString:text(value)
                                           attributes:@{
                                             NSFontAttributeName : [NSFont systemFontOfSize:NSFont.systemFontSize],
                                             NSForegroundColorAttributeName : NSColor.labelColor,
                                           }];
  }

  // Appends when the shown lines are still a prefix of the model's; anything
  // else (an older page, an edit) rewrites the transcript once.
  void render() {
    const auto lines = chat.lines();
    const bool prefix = lines.size() >= shown.size() &&
                        std::equal(shown.begin(), shown.end(), lines.begin(), [](const ChatLine& a, const ChatLine& b) {
                          return a.id == b.id && a.text == b.text;
                        });
    if (prefix && lines.size() == shown.size()) return;
    NSTextStorage* storage = transcript.textStorage;
    [storage beginEditing];
    if (!prefix) [storage setAttributedString:[[NSAttributedString alloc] initWithString:@""]];
    for (std::size_t index = prefix ? shown.size() : 0; index < lines.size(); ++index) {
      [storage appendAttributedString:styled((index > 0 ? "\n" : "") + lines[index].text)];
    }
    [storage endEditing];
    if (!prefix && keepTop) [transcript scrollRangeToVisible:NSMakeRange(0, 0)];
    else [transcript scrollRangeToVisible:NSMakeRange(transcript.string.length, 0)];
    keepTop = false;
    shown = lines;
  }

  void update(ChatChange change) {
    if (change == ChatChange::channels) channels();
    render();
    if (auto alert = chat.takeAlert()) status.stringValue = text(*alert);
    older.enabled = chat.canLoadOlder();
  }

  void send() {
    if (chat.send(utf8(input.stringValue))) {
      input.stringValue = @"";
      status.stringValue = @"";
    }
    [window makeFirstResponder:input];
  }

  void loadOlder() {
    keepTop = true;
    older.enabled = NO;
    chat.older();
  }

  void closedByUser() {
    if (closed) return;
    closed = true;
    chat.close();
    window.delegate = nil;
    // Released by the tray after this callback returns.
    if (onClosed) onClosed();
  }
};

MacChatWindow::MacChatWindow(ChatController& chat, const Strings& text, std::function<void()> closed)
    : impl_(std::make_unique<Impl>(chat, text, std::move(closed))) {
  @autoreleasepool {
    impl_->build();
  }
}

MacChatWindow::~MacChatWindow() {
  @autoreleasepool {
    impl_->window.delegate = nil;
    [impl_->window orderOut:nil];
  }
}

bool MacChatWindow::closed() const { return impl_->closed; }

void MacChatWindow::focus() {
  @autoreleasepool {
    impl_->focus();
  }
}

void MacChatWindow::update(ChatChange change) {
  @autoreleasepool {
    impl_->update(change);
  }
}

}  // namespace monky::light::ui

@implementation MonkyLightChatTarget {
  void* _owner;
}

- (instancetype)initWithOwner:(void*)owner {
  self = [super init];
  if (self) _owner = owner;
  return self;
}

- (monky::light::ui::MacChatWindow::Impl*)chat {
  return static_cast<monky::light::ui::MacChatWindow::Impl*>(_owner);
}

- (void)send:(id)sender {
  (void)sender;
  [self chat]->send();
}

- (void)older:(id)sender {
  (void)sender;
  [self chat]->loadOlder();
}

- (void)channel:(NSPopUpButton*)sender {
  [self chat]->choose(sender.indexOfSelectedItem);
}

- (void)windowWillClose:(NSNotification*)notification {
  (void)notification;
  [self chat]->closedByUser();
}

@end
