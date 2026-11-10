#include "ui/connect.hpp"

#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>

#include <cstdlib>
#include <stdexcept>
#include <string>

namespace monky::light::ui {
namespace {

NSString* text(const std::string& value) {
  NSString* result = [NSString stringWithUTF8String:value.c_str()];
  return result ?: @"";
}

std::string utf8(NSString* value) {
  const char* bytes = value ? value.UTF8String : nullptr;
  return bytes ? std::string(bytes) : std::string();
}

NSTextField* field(NSTextField* control, NSString* placeholder, NSString* value, CGFloat y) {
  control.frame = NSMakeRect(0, y, 340, 24);
  control.placeholderString = placeholder;
  control.stringValue = value;
  // Placeholders disappear once typed, so the purpose stays readable to VoiceOver.
  control.accessibilityLabel = placeholder;
  return control;
}

// An accessory application is not active on its own; a window it shows would
// open behind the frontmost application.
void bringForward() {
  NSApplication* application = [NSApplication sharedApplication];
  [application setActivationPolicy:NSApplicationActivationPolicyAccessory];
  [application activateIgnoringOtherApps:YES];
}

}  // namespace

std::optional<Connection> askConnection(const Connection& current, std::optional<ConnectionIssue> issue,
                                        Language language) {
  const auto& strings = textFor(language);
  @autoreleasepool {
    bringForward();
    NSAlert* alert = [[NSAlert alloc] init];
    alert.messageText = text(strings.connectTitle);
    alert.informativeText = text(issue ? issueText(*issue, strings) : strings.connectPrompt);
    if (issue) alert.alertStyle = NSAlertStyleWarning;
    [alert addButtonWithTitle:text(strings.connect)];
    [alert addButtonWithTitle:text(strings.cancel)];
    NSView* fields = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, 340, 88)];
    NSTextField* server = field([[NSTextField alloc] init], text(strings.serverField), text(current.server), 64);
    NSTextField* nickname = field([[NSTextField alloc] init], text(strings.nicknameField), text(current.nickname), 32);
    NSTextField* password = field([[NSSecureTextField alloc] init], text(strings.passwordField),
                                  text(current.password.value_or("")), 0);
    [fields addSubview:server];
    [fields addSubview:nickname];
    [fields addSubview:password];
    // Return moves through the fields in reading order, then connects.
    server.nextKeyView = nickname;
    nickname.nextKeyView = password;
    alert.accessoryView = fields;
    [alert layout];
    const auto target = fieldFor(issue, current);
    alert.window.initialFirstResponder = target == Field::password ? password
                                         : target == Field::nickname ? nickname
                                                                     : server;
    if ([alert runModal] != NSAlertFirstButtonReturn) return std::nullopt;
    auto secret = utf8(password.stringValue);
    return Connection{utf8(server.stringValue), utf8(nickname.stringValue),
                      secret.empty() ? std::nullopt : std::optional<std::string>(std::move(secret))};
  }
}

void showProfileUnavailable(const std::string& detail, Language language) {
  const auto& strings = textFor(language);
  @autoreleasepool {
    bringForward();
    NSAlert* alert = [[NSAlert alloc] init];
    alert.alertStyle = NSAlertStyleWarning;
    alert.messageText = text(strings.application);
    alert.informativeText = text(std::string(strings.profileUnavailable) + "\n\n" + detail);
    [alert runModal];
  }
}

std::filesystem::path defaultProfileDirectory() {
  @autoreleasepool {
    NSArray<NSURL*>* folders = [[NSFileManager defaultManager] URLsForDirectory:NSApplicationSupportDirectory
                                                                      inDomains:NSUserDomainMask];
    NSURL* folder = folders.firstObject;
    if (!folder || !folder.fileSystemRepresentation) {
      throw std::runtime_error("Could not find the Application Support folder");
    }
    return std::filesystem::path(folder.fileSystemRepresentation) / "Monky Light" / "Profile";
  }
}

}  // namespace monky::light::ui
