#include "microphone_access.hpp"

#import <AVFoundation/AVFoundation.h>

#include <memory>
#include <mutex>
#include <stdexcept>
#include <utility>

#if !__has_feature(objc_arc)
#error "microphone_access_macos.mm requires Objective-C ARC (-fobjc-arc)"
#endif

namespace monky::light {
namespace {

struct Request final {
  std::mutex mutex;
  MicrophoneAccessCallback callback;

  void complete(MicrophoneAccess access) {
    std::lock_guard lock(mutex);
    if (callback) {
      auto notify = std::move(callback);
      notify(access);
    }
  }
  void cancel() {
    std::lock_guard lock(mutex);
    callback = {};
  }
};

}  // namespace

CancelMicrophoneAccess requestMicrophoneAccess(MicrophoneAccessCallback callback) {
  if (!callback) throw std::invalid_argument("Microphone access requires a completion callback");
  const auto request = std::make_shared<Request>();
  request->callback = std::move(callback);
  @autoreleasepool {
    switch ([AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio]) {
      case AVAuthorizationStatusAuthorized:
        request->complete(MicrophoneAccess::granted);
        break;
      case AVAuthorizationStatusDenied:
        request->complete(MicrophoneAccess::denied);
        break;
      case AVAuthorizationStatusRestricted:
        request->complete(MicrophoneAccess::restricted);
        break;
      case AVAuthorizationStatusNotDetermined:
        [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio completionHandler:^(BOOL granted) {
          request->complete(granted ? MicrophoneAccess::granted : MicrophoneAccess::denied);
        }];
        break;
      default:
        throw std::runtime_error("macOS returned an unknown microphone authorization state");
    }
  }
  return [request] { request->cancel(); };
}

}  // namespace monky::light
