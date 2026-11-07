#include "ui/startup.hpp"

#import <Foundation/Foundation.h>

#include <stdexcept>

namespace monky::light::ui {
namespace {

// A per-user LaunchAgent works from macOS 12; SMAppService needs macOS 13.
NSString* const kLabel = @"org.monky.light";

NSURL* agentFile() {
  NSURL* library = [[NSFileManager defaultManager] URLsForDirectory:NSLibraryDirectory
                                                          inDomains:NSUserDomainMask].firstObject;
  if (!library) throw std::runtime_error("Could not find the Library folder");
  return [[library URLByAppendingPathComponent:@"LaunchAgents" isDirectory:YES]
      URLByAppendingPathComponent:[kLabel stringByAppendingString:@".plist"]];
}

NSString* executable() {
  NSString* path = [NSBundle mainBundle].executablePath;
  if (!path) throw std::runtime_error("Could not find the Monky Light executable");
  return path;
}

bool enabled() {
  @autoreleasepool {
    NSDictionary* agent = [NSDictionary dictionaryWithContentsOfURL:agentFile() error:nil];
    NSArray* arguments = agent[@"ProgramArguments"];
    return [arguments isKindOfClass:[NSArray class]] && arguments.count == 1 &&
           [arguments.firstObject isEqual:executable()];
  }
}

void set(bool wanted) {
  @autoreleasepool {
    NSURL* file = agentFile();
    NSError* error = nil;
    if (!wanted) {
      if (![[NSFileManager defaultManager] removeItemAtURL:file error:&error] &&
          !(error.domain == NSCocoaErrorDomain && error.code == NSFileNoSuchFileError)) {
        throw std::runtime_error("macOS refused to stop starting Monky Light at login");
      }
      return;
    }
    if (![[NSFileManager defaultManager] createDirectoryAtURL:file.URLByDeletingLastPathComponent
                                  withIntermediateDirectories:YES
                                                   attributes:nil
                                                        error:&error]) {
      throw std::runtime_error("Could not create the LaunchAgents folder");
    }
    // Takes effect at the next login; nothing is started now.
    NSDictionary* agent = @{
      @"Label" : kLabel,
      @"ProgramArguments" : @[ executable() ],
      @"RunAtLoad" : @YES,
      @"ProcessType" : @"Interactive",
      @"LimitLoadToSessionType" : @"Aqua",
    };
    if (![agent writeToURL:file error:&error]) {
      throw std::runtime_error("macOS refused to start Monky Light at login");
    }
  }
}

}  // namespace

Startup systemStartup() { return {&enabled, &set}; }

}  // namespace monky::light::ui
