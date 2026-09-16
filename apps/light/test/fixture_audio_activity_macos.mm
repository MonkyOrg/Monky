#include "fixture_audio_activity.hpp"

#import <Foundation/Foundation.h>

#include <new>
#include <stdexcept>

namespace monky::light::test {

std::function<void()> BeginFixtureAudioActivity() {
  @autoreleasepool {
    NSProcessInfo* process = [NSProcessInfo processInfo];
    id<NSObject> activity = [process
        beginActivityWithOptions:NSActivityLatencyCritical |
                                 NSActivityUserInitiatedAllowingIdleSystemSleep
        reason:@"Maintain the synthetic audio device clock while its worker is active"];
    if (!activity) throw std::runtime_error("Unable to begin synthetic audio timing activity");
    try {
      return [process, activity] {
        @autoreleasepool {
          [process endActivity:activity];
        }
      };
    } catch (const std::bad_alloc&) {
      [process endActivity:activity];
      throw;
    }
  }
}

}  // namespace monky::light::test
