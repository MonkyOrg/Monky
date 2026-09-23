#include "websocket.hpp"

#import <Foundation/Foundation.h>
#import <dispatch/dispatch.h>

#include <cerrno>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <deque>
#include <mutex>
#include <utility>

#if !__has_feature(objc_arc)
#error "websocket_macos.mm requires Objective-C ARC (-fobjc-arc)"
#endif

@interface MonkyLightWebSocketDelegate : NSObject <NSURLSessionWebSocketDelegate> {
 @public
  std::function<void()> opened;
  std::function<void(NSInteger)> closed;
  std::function<void(NSError*)> failed;
  std::function<void()> completed;
}
@end

@implementation MonkyLightWebSocketDelegate
- (void)URLSession:(NSURLSession*)session
    webSocketTask:(NSURLSessionWebSocketTask*)task
    didOpenWithProtocol:(NSString*)protocol {
  if (opened) opened();
}
- (void)URLSession:(NSURLSession*)session
    webSocketTask:(NSURLSessionWebSocketTask*)task
    didCloseWithCode:(NSURLSessionWebSocketCloseCode)code
    reason:(NSData*)reason {
  if (closed) closed(code);
}
- (void)URLSession:(NSURLSession*)session task:(NSURLSessionTask*)task
    didCompleteWithError:(NSError*)error {
  if (error && failed) failed(error);
  if (completed) completed();
}
- (void)URLSession:(NSURLSession*)session task:(NSURLSessionTask*)task
    willPerformHTTPRedirection:(NSHTTPURLResponse*)response
    newRequest:(NSURLRequest*)request
    completionHandler:(void (^)(NSURLRequest*))completionHandler {
  completionHandler(nil);
}
- (void)URLSession:(NSURLSession*)session task:(NSURLSessionTask*)task
    didReceiveChallenge:(NSURLAuthenticationChallenge*)challenge
    completionHandler:(void (^)(NSURLSessionAuthChallengeDisposition,
                                NSURLCredential*))completionHandler {
  // Trust uses the OS default chain AND hostname verification. Never supply
  // credentials or accept a custom trust object on behalf of the caller.
  if ([challenge.protectionSpace.authenticationMethod
          isEqualToString:NSURLAuthenticationMethodServerTrust]) {
    completionHandler(NSURLSessionAuthChallengePerformDefaultHandling, nil);
  } else {
    completionHandler(NSURLSessionAuthChallengeRejectProtectionSpace, nil);
  }
}
@end

namespace monky::light {
namespace {

NSURL* parseUrl(const std::string& url) {
  websocket_detail::validateUrl(url);
  NSString* value = [[NSString alloc] initWithBytes:url.data() length:url.size()
                                         encoding:NSUTF8StringEncoding];
  NSURLComponents* parts = [NSURLComponents componentsWithString:value];
  if (!parts || parts.host.length == 0 || parts.user || parts.password ||
      parts.fragment || (parts.port && (parts.port.longLongValue <= 0 ||
                                       parts.port.longLongValue > 65535)) ||
      !parts.URL)
    throw std::invalid_argument("Invalid WebSocket URL");
  return parts.URL;
}

}  // namespace

struct WebSocket::Impl : std::enable_shared_from_this<WebSocket::Impl> {
  explicit Impl(WebSocketCallbacks value, std::size_t limit)
      : callbacks(std::move(value)), maxIncoming(limit) {}

  std::recursive_mutex callbackMutex;
  WebSocketCallbacks callbacks;
  std::mutex mutex;
  std::condition_variable completion;
  const std::size_t maxIncoming;
  bool started = false;
  bool stopping = false;
  bool opened = false;
  bool sendPending = false;
  bool nativeFinished = false;
  std::deque<std::string> outgoing;
  std::size_t outgoingBytes = 0;
  std::size_t outgoingCount = 0;
  NSOperationQueue* queue = nil;
  NSURLSession* session = nil;
  NSURLSessionWebSocketTask* task = nil;

  void didFinish() {
    std::lock_guard lock(mutex);
    nativeFinished = true;
    queue = nil;
    completion.notify_all();
  }

  bool active() {
    std::lock_guard lock(mutex);
    return !stopping;
  }

  void finish(WebSocketClose result) {
    std::lock_guard gate(callbackMutex);
    auto callback = std::move(callbacks.closed);
    callbacks = {};
    stop(result.kind == WebSocketCloseKind::transportError ? 1000 : result.code);
    if (callback) {
      try { callback(result); }
      catch (...) { std::fputs("Monky Light: terminal WebSocket callback threw\n", stderr); }
    }
  }

  void fail(NSError* error) {
    if (!active()) return;
    NSURLSessionWebSocketTask* current;
    {
      std::lock_guard lock(mutex);
      current = task;
    }
    const bool oversized =
        current.closeCode == NSURLSessionWebSocketCloseCodeMessageTooBig ||
        ([error.domain isEqualToString:NSURLErrorDomain] &&
         error.code == NSURLErrorDataLengthExceedsMaximum) ||
        ([error.domain isEqualToString:NSPOSIXErrorDomain] && error.code == EMSGSIZE);
    const auto code = current.closeCode;
    if (!oversized && code >= 1000 && code <= 4999 &&
        code != 1005 && code != 1006 && code != 1015) {
      finish({WebSocketCloseKind::peerClosed, static_cast<std::uint16_t>(code), 0});
      return;
    }
    finish({oversized ? WebSocketCloseKind::messageTooLarge :
                       WebSocketCloseKind::transportError,
            static_cast<std::uint16_t>(oversized ? 1009 : 1006),
            static_cast<std::int64_t>(error.code)});
  }

  void didOpen() {
    std::lock_guard gate(callbackMutex);
    {
      std::lock_guard lock(mutex);
      if (stopping) return;
      opened = true;
    }
    auto callback = callbacks.opened;
    try { if (callback) callback(); }
    catch (...) {
      finish({WebSocketCloseKind::callbackError, 1011, 0});
      return;
    }
    receive();
  }

  void receive() {
    NSURLSessionWebSocketTask* current;
    NSOperationQueue* targetQueue;
    {
      std::lock_guard lock(mutex);
      if (stopping) return;
      current = task;
      targetQueue = queue;
    }
    std::weak_ptr<Impl> weak = shared_from_this();
    [current receiveMessageWithCompletionHandler:^(NSURLSessionWebSocketMessage* message,
                                                    NSError* error) {
      [targetQueue addOperationWithBlock:^{
        auto self = weak.lock();
        if (!self || !self->active()) return;
        if (error) { self->fail(error); return; }
        if (!message || message.type != NSURLSessionWebSocketMessageTypeString) {
          self->finish({WebSocketCloseKind::invalidMessage, 1003, 0});
          return;
        }
        // Foundation assembles fragments under maximumMessageSize before
        // delivering the NSString; check the UTF-8 byte count again at the edge.
        NSData* utf8 = [message.string dataUsingEncoding:NSUTF8StringEncoding
                                  allowLossyConversion:NO];
        if (!utf8) {
          self->finish({WebSocketCloseKind::invalidMessage, 1007, 0});
          return;
        }
        if (utf8.length > self->maxIncoming) {
          self->finish({WebSocketCloseKind::messageTooLarge, 1009, 0});
          return;
        }
        std::string text;
        if (utf8.length)
          text.assign(static_cast<const char*>(utf8.bytes), utf8.length);
        {
          std::lock_guard gate(self->callbackMutex);
          auto callback = self->callbacks.text;
          try { if (callback) callback(std::move(text)); }
          catch (...) {
            self->finish({WebSocketCloseKind::callbackError, 1011, 0});
            return;
          }
        }
        self->receive();
      }];
    }];
  }

  void sendNext() {
    NSURLSessionWebSocketTask* current;
    NSOperationQueue* targetQueue;
    std::string text;
    {
      std::lock_guard lock(mutex);
      if (stopping || !opened || sendPending || outgoing.empty()) return;
      text = std::move(outgoing.front());
      outgoing.pop_front();
      sendPending = true;
      current = task;
      targetQueue = queue;
    }
    NSString* value = [[NSString alloc] initWithBytes:text.data() length:text.size()
                                           encoding:NSUTF8StringEncoding];
    NSURLSessionWebSocketMessage* message =
        [[NSURLSessionWebSocketMessage alloc] initWithString:value];
    const auto bytes = text.size();
    std::weak_ptr<Impl> weak = shared_from_this();
    [current sendMessage:message completionHandler:^(NSError* error) {
      [targetQueue addOperationWithBlock:^{
        auto self = weak.lock();
        if (!self || !self->active()) return;
        if (error) { self->fail(error); return; }
        {
          std::lock_guard lock(self->mutex);
          self->outgoingBytes -= bytes;
          --self->outgoingCount;
          self->sendPending = false;
        }
        self->sendNext();
      }];
    }];
  }

  void start(NSURL* url) {
    std::lock_guard lock(mutex);
    if (started || stopping)
      throw std::logic_error("WebSocket instances cannot be reused");
    started = true;
    queue = [[NSOperationQueue alloc] init];
    queue.maxConcurrentOperationCount = 1;
    queue.name = @"Monky.Light.WebSocket";
    MonkyLightWebSocketDelegate* delegate = [[MonkyLightWebSocketDelegate alloc] init];
    std::weak_ptr<Impl> weak = shared_from_this();
    delegate->opened = [weak] {
      if (auto self = weak.lock()) self->didOpen();
    };
    delegate->closed = [weak](NSInteger code) {
      if (auto self = weak.lock(); self && self->active())
        self->finish({code == 1009 ? WebSocketCloseKind::messageTooLarge :
                                    WebSocketCloseKind::peerClosed,
                      static_cast<std::uint16_t>(code), 0});
    };
    delegate->failed = [weak](NSError* error) {
      if (auto self = weak.lock()) self->fail(error);
    };
    delegate->completed = [weak] {
      if (auto self = weak.lock()) self->didFinish();
    };
    NSURLSessionConfiguration* config =
        [NSURLSessionConfiguration ephemeralSessionConfiguration];
    config.URLCredentialStorage = nil;
    config.HTTPCookieStorage = nil;
    config.HTTPShouldSetCookies = NO;
    config.timeoutIntervalForRequest = 20;
    // Do not impose a short resource deadline on a long-lived WebSocket.
    config.timeoutIntervalForResource = 60 * 60 * 24 * 365;
    session = [NSURLSession sessionWithConfiguration:config delegate:delegate
                                      delegateQueue:queue];
    task = [session webSocketTaskWithURL:url];
    task.maximumMessageSize = maxIncoming;
    [task resume];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 20 * NSEC_PER_SEC),
                   dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
      auto self = weak.lock();
      if (!self) return;
      NSOperationQueue* targetQueue;
      {
        std::lock_guard stateLock(self->mutex);
        if (self->stopping || self->opened) return;
        targetQueue = self->queue;
      }
      [targetQueue addOperationWithBlock:^{
        {
          std::lock_guard stateLock(self->mutex);
          if (self->stopping || self->opened) return;
        }
        self->finish({WebSocketCloseKind::transportError, 1006, NSURLErrorTimedOut});
      }];
    });
  }

  void stop(std::uint16_t code = 1000) noexcept {
    NSURLSessionWebSocketTask* current = nil;
    NSURLSession* currentSession = nil;
    NSOperationQueue* closingQueue;
    {
      std::lock_guard gate(callbackMutex);
      callbacks = {};
      std::lock_guard lock(mutex);
      closingQueue = queue;
      if (!stopping) {
        stopping = true;
        opened = false;
        outgoing.clear();
        current = task;
        currentSession = session;
        nativeFinished = !task;
        task = nil;
        session = nil;
      }
    }
    // Foundation sends the close frame and cancels outstanding work. Delegate
    // and completion blocks retain only weak C++ state, so late work is harmless.
    const auto closeCode = code == 1005 || code == 1006
        ? NSURLSessionWebSocketCloseCodeNormalClosure
        : static_cast<NSURLSessionWebSocketCloseCode>(code);
    if (currentSession) {
      [current cancelWithCloseCode:closeCode reason:nil];
      [currentSession finishTasksAndInvalidate];
      // A peer that ignores close cannot retain the session forever.
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 250 * NSEC_PER_MSEC),
                     dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        [currentSession invalidateAndCancel];
      });
    }
    // The delegate must finish the handshake before an external owner exits.
    // Waiting on the delegate queue itself would deadlock close-from-callback.
    if (closingQueue && [NSOperationQueue currentQueue] != closingQueue) {
      std::unique_lock lock(mutex);
      completion.wait_for(lock, std::chrono::milliseconds(500), [&] { return nativeFinished; });
    }
  }
};

WebSocket::WebSocket(WebSocketCallbacks callbacks, std::size_t maxIncomingMessageBytes) {
  if (!maxIncomingMessageBytes)
    throw std::invalid_argument("WebSocket incoming message limit must be positive");
  impl_ = std::make_shared<Impl>(std::move(callbacks), maxIncomingMessageBytes);
}

WebSocket::~WebSocket() { close(); }

void WebSocket::connect(const std::string& url) {
  @autoreleasepool {
    auto self = impl_;
    self->start(parseUrl(url));
  }
}

WebSocketSendResult WebSocket::send(std::string text) {
  auto self = impl_;
  NSOperationQueue* queue;
  {
    std::lock_guard lock(self->mutex);
    if (!self->opened || self->stopping) return WebSocketSendResult::notOpen;
    if (text.size() > websocket_detail::maxOutgoingMessageBytes)
      return WebSocketSendResult::tooLarge;
    if (!websocket_detail::validUtf8(text)) return WebSocketSendResult::invalidUtf8;
    if (self->outgoingCount >= websocket_detail::maxOutgoingQueueMessages ||
        text.size() > websocket_detail::maxOutgoingQueueBytes - self->outgoingBytes)
      return WebSocketSendResult::queueFull;
    const auto bytes = text.size();
    self->outgoing.push_back(std::move(text));
    self->outgoingBytes += bytes;
    ++self->outgoingCount;
    queue = self->queue;
  }
  [queue addOperationWithBlock:^{ self->sendNext(); }];
  return WebSocketSendResult::queued;
}

bool WebSocket::hasPendingSends() const {
  const auto self = impl_;
  std::lock_guard lock(self->mutex);
  return !self->stopping && self->outgoingCount != 0;
}

void WebSocket::close() noexcept {
  @autoreleasepool {
    auto self = impl_;
    if (self) self->stop();
  }
}

}  // namespace monky::light
