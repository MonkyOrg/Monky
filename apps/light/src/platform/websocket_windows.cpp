#include "websocket.hpp"

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <winhttp.h>

#include <array>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <deque>
#include <mutex>
#include <optional>
#include <thread>
#include <utility>

namespace monky::light {
namespace {

class InternetHandle {
 public:
  InternetHandle() = default;
  ~InternetHandle() { reset(); }
  InternetHandle(const InternetHandle&) = delete;
  InternetHandle& operator=(const InternetHandle&) = delete;
  HINTERNET get() const { return handle_; }
  void reset(HINTERNET value = nullptr) {
    if (handle_) WinHttpCloseHandle(handle_);
    handle_ = value;
  }
 private:
  HINTERNET handle_ = nullptr;
};

struct ParsedUrl {
  std::wstring host;
  std::wstring path;
  INTERNET_PORT port;
  bool secure;
};

ParsedUrl parseUrl(const std::string& url) {
  websocket_detail::validateUrl(url);
  const auto mapped = (url.starts_with("wss:") ? "https:" : "http:") +
                      url.substr(url.find(':') + 1);
  const auto count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, mapped.data(),
                                       static_cast<int>(mapped.size()), nullptr, 0);
  if (!count) throw std::invalid_argument("Invalid WebSocket URL encoding");
  std::wstring wide(count, L'\0');
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, mapped.data(),
                      static_cast<int>(mapped.size()), wide.data(), count);
  URL_COMPONENTS parts{};
  parts.dwStructSize = sizeof(parts);
  parts.dwHostNameLength = parts.dwUrlPathLength = parts.dwExtraInfoLength =
      parts.dwUserNameLength = parts.dwPasswordLength = static_cast<DWORD>(-1);
  if (!WinHttpCrackUrl(wide.c_str(), static_cast<DWORD>(wide.size()), 0, &parts) ||
      !parts.dwHostNameLength || parts.dwUserNameLength || parts.dwPasswordLength ||
      !parts.nPort)
    throw std::invalid_argument("Invalid WebSocket URL");
  ParsedUrl result{std::wstring(parts.lpszHostName, parts.dwHostNameLength),
                   std::wstring(parts.lpszUrlPath, parts.dwUrlPathLength),
                   parts.nPort, parts.nScheme == INTERNET_SCHEME_HTTPS};
  if (result.path.empty()) result.path = L"/";
  if (parts.dwExtraInfoLength)
    result.path.append(parts.lpszExtraInfo, parts.dwExtraInfoLength);
  return result;
}

}  // namespace

struct WebSocket::Impl : std::enable_shared_from_this<WebSocket::Impl> {
  struct Event {
    DWORD status;
    DWORD error = 0;
    DWORD bytes = 0;
    WINHTTP_WEB_SOCKET_BUFFER_TYPE type = WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE;
    bool websocket = false;
  };
  // WinHTTP may invoke callbacks after CloseHandle returns. Each handle retains
  // the state until HANDLE_CLOSING, including the in-flight receive/send buffers.
  struct Context {
    std::shared_ptr<Impl> owner;
    bool websocket;
  };

  explicit Impl(WebSocketCallbacks value, std::size_t limit)
      : callbacks(std::move(value)), maxIncoming(limit) {}

  std::recursive_mutex callbackMutex;
  WebSocketCallbacks callbacks;
  const std::size_t maxIncoming;
  std::mutex mutex;
  std::condition_variable condition;
  bool started = false;
  bool stopping = false;
  bool opened = false;
  bool finished = false;
  std::thread::id workerId;
  std::deque<Event> events;
  std::deque<std::string> outgoing;
  std::size_t outgoingBytes = 0;
  std::size_t outgoingCount = 0;
  std::array<char, 16 * 1024> receiveBuffer{};
  std::string assembled;
  std::string sending;
  bool sendPending = false;
  bool receivePending = false;
  InternetHandle session;
  InternetHandle connection;
  InternetHandle request;
  InternetHandle socket;

  static void CALLBACK statusCallback(HINTERNET, DWORD_PTR context, DWORD status,
                                      void* info, DWORD) noexcept {
    if (!context) return;
    auto* binding = reinterpret_cast<Context*>(context);
    auto self = binding->owner;
    if (status == WINHTTP_CALLBACK_STATUS_HANDLE_CLOSING) {
      delete binding;
      return;
    }
    Event event{status};
    event.websocket = binding->websocket;
    if (status == WINHTTP_CALLBACK_STATUS_REQUEST_ERROR) {
      event.error = static_cast<WINHTTP_ASYNC_RESULT*>(info)->dwError;
    } else if (status == WINHTTP_CALLBACK_STATUS_READ_COMPLETE && binding->websocket) {
      const auto* result = static_cast<WINHTTP_WEB_SOCKET_STATUS*>(info);
      event.bytes = result->dwBytesTransferred;
      event.type = result->eBufferType;
    }
    if (status != WINHTTP_CALLBACK_STATUS_REQUEST_ERROR &&
        status != WINHTTP_CALLBACK_STATUS_SENDREQUEST_COMPLETE &&
        status != WINHTTP_CALLBACK_STATUS_HEADERS_AVAILABLE &&
        status != WINHTTP_CALLBACK_STATUS_READ_COMPLETE &&
        status != WINHTTP_CALLBACK_STATUS_WRITE_COMPLETE &&
        status != WINHTTP_CALLBACK_STATUS_SHUTDOWN_COMPLETE)
      return;
    std::lock_guard lock(self->mutex);
    if (!self->finished) {
      self->events.push_back(event);
      self->condition.notify_one();
    }
  }

  bool notifyOpened() {
    std::lock_guard gate(callbackMutex);
    auto callback = callbacks.opened;
    if (!callback) return true;
    try { callback(); return true; }
    catch (...) { return false; }
  }

  bool notifyText(std::string text) {
    std::lock_guard gate(callbackMutex);
    auto callback = callbacks.text;
    if (!callback) return true;
    try { callback(std::move(text)); return true; }
    catch (...) { return false; }
  }

  void notifyClosed(WebSocketClose result) noexcept {
    std::lock_guard gate(callbackMutex);
    auto callback = std::move(callbacks.closed);
    callbacks = {};
    // The callback contract forbids throwing. A terminal callback cannot report
    // another failure; do not allow an exception to escape the OS/worker boundary.
    if (callback) {
      try { callback(result); }
      catch (...) { std::fputs("Monky Light: terminal WebSocket callback threw\n", stderr); }
    }
  }

  bool isStopping() {
    std::lock_guard lock(mutex);
    return stopping;
  }

  DWORD receive() {
    const auto error = WinHttpWebSocketReceive(socket.get(), receiveBuffer.data(),
        static_cast<DWORD>(receiveBuffer.size()), nullptr, nullptr);
    receivePending = error == NO_ERROR;
    return error;
  }

  void run(ParsedUrl url) noexcept {
    {
      std::lock_guard lock(mutex);
      workerId = std::this_thread::get_id();
    }
    WebSocketClose result;
    try { result = runConnection(url); }
    catch (const std::bad_alloc&) {
      result = {WebSocketCloseKind::transportError, 1006, ERROR_NOT_ENOUGH_MEMORY};
    } catch (...) {
      std::fputs("Monky Light: unexpected exception in the native WebSocket worker\n", stderr);
      result = {WebSocketCloseKind::transportError, 1006, ERROR_UNHANDLED_EXCEPTION};
    }
    {
      std::lock_guard lock(mutex);
      opened = false;
    }
    if (socket.get() && !sendPending &&
        (result.kind == WebSocketCloseKind::messageTooLarge ||
         result.kind == WebSocketCloseKind::invalidMessage ||
         result.kind == WebSocketCloseKind::callbackError)) {
      const auto error = WinHttpWebSocketShutdown(socket.get(), result.code, nullptr, 0);
      if (error == NO_ERROR) {
        std::unique_lock lock(mutex);
        condition.wait_for(lock, std::chrono::milliseconds(250), [&] {
          for (const auto& event : events) {
            if (event.status == WINHTTP_CALLBACK_STATUS_SHUTDOWN_COMPLETE ||
                event.status == WINHTTP_CALLBACK_STATUS_REQUEST_ERROR)
              return true;
          }
          return false;
        });
      }
    }
    // All handle operations occur on this worker. Closing an asynchronous handle
    // aborts pending handshake/receive/send without racing a later API call.
    socket.reset();
    request.reset();
    connection.reset();
    session.reset();
    notifyClosed(result);
    {
      std::lock_guard lock(mutex);
      finished = true;
      events.clear();
      outgoing.clear();
      condition.notify_all();
    }
  }

  WebSocketClose runConnection(const ParsedUrl& url) {
    const auto failure = [](DWORD error) {
      return WebSocketClose{WebSocketCloseKind::transportError, 1006, error};
    };
    if (isStopping()) return failure(ERROR_OPERATION_ABORTED);
    session.reset(WinHttpOpen(L"Monky-Light", WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
                             WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS,
                             WINHTTP_FLAG_ASYNC));
    if (!session.get()) return failure(GetLastError());
    if (!WinHttpSetTimeouts(session.get(), 10000, 10000, 10000, 15000))
      return failure(GetLastError());
    if (WinHttpSetStatusCallback(session.get(), statusCallback,
        WINHTTP_CALLBACK_FLAG_ALL_COMPLETIONS | WINHTTP_CALLBACK_FLAG_HANDLES,
        0) == WINHTTP_INVALID_STATUS_CALLBACK)
      return failure(GetLastError());
    connection.reset(WinHttpConnect(session.get(), url.host.c_str(), url.port, 0));
    if (!connection.get()) return failure(GetLastError());
    request.reset(WinHttpOpenRequest(connection.get(), L"GET", url.path.c_str(), nullptr,
                                    WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES,
                                    url.secure ? WINHTTP_FLAG_SECURE : 0));
    if (!request.get()) return failure(GetLastError());
    // Never follow redirects: a redirect could silently cross origins or
    // downgrade wss. Default TLS certificate and hostname checks remain enabled.
    DWORD redirects = WINHTTP_OPTION_REDIRECT_POLICY_NEVER;
    DWORD autologon = WINHTTP_AUTOLOGON_SECURITY_LEVEL_HIGH;
    if (!WinHttpSetOption(request.get(), WINHTTP_OPTION_REDIRECT_POLICY,
                          &redirects, sizeof(redirects)) ||
        !WinHttpSetOption(request.get(), WINHTTP_OPTION_AUTOLOGON_POLICY,
                          &autologon, sizeof(autologon)) ||
        !WinHttpSetOption(request.get(), WINHTTP_OPTION_UPGRADE_TO_WEB_SOCKET, nullptr, 0))
      return failure(GetLastError());
    auto context = std::make_unique<Context>(Context{shared_from_this(), false});
    DWORD_PTR contextValue = reinterpret_cast<DWORD_PTR>(context.get());
    if (!WinHttpSetOption(request.get(), WINHTTP_OPTION_CONTEXT_VALUE,
                          &contextValue, sizeof(contextValue)))
      return failure(GetLastError());
    context.release();
    if (!WinHttpSendRequest(request.get(), WINHTTP_NO_ADDITIONAL_HEADERS, 0,
                            WINHTTP_NO_REQUEST_DATA, 0, 0, contextValue))
      return failure(GetLastError());
    auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(20);
    bool upgraded = false;
    bool gracefulStopping = false;
    while (true) {
      Event event{};
      bool hasEvent = false;
      {
        std::unique_lock lock(mutex);
        condition.wait_until(lock, deadline, [&] {
          return (!gracefulStopping && stopping) || !events.empty() ||
                 (opened && !sendPending && !outgoing.empty());
        });
        if (stopping && !gracefulStopping) {
          opened = false;
          if (!upgraded || sendPending) return failure(ERROR_OPERATION_ABORTED);
          gracefulStopping = true;
          deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(250);
          lock.unlock();
          const auto error = WinHttpWebSocketShutdown(socket.get(),
              WINHTTP_WEB_SOCKET_SUCCESS_CLOSE_STATUS, nullptr, 0);
          if (error != NO_ERROR) return failure(error);
          if (!receivePending) {
            if (const auto receiveError = receive(); receiveError != NO_ERROR)
              return failure(receiveError);
          }
          continue;
        }
        if (std::chrono::steady_clock::now() >= deadline)
          return failure(gracefulStopping ? ERROR_OPERATION_ABORTED : ERROR_TIMEOUT);
        if (!events.empty()) {
          event = events.front();
          events.pop_front();
          hasEvent = true;
        }
        if (opened && !sendPending && !outgoing.empty()) {
          sending = std::move(outgoing.front());
          outgoing.pop_front();
          sendPending = true;
          lock.unlock();
          const auto error = WinHttpWebSocketSend(socket.get(),
              WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE, sending.data(),
              static_cast<DWORD>(sending.size()));
          if (error != NO_ERROR) return failure(error);
        }
      }
      if (!hasEvent) continue;
      if (event.status == WINHTTP_CALLBACK_STATUS_REQUEST_ERROR)
        return failure(event.error);
      if (event.status == WINHTTP_CALLBACK_STATUS_SENDREQUEST_COMPLETE) {
        if (!WinHttpReceiveResponse(request.get(), nullptr)) return failure(GetLastError());
      } else if (event.status == WINHTTP_CALLBACK_STATUS_HEADERS_AVAILABLE) {
        DWORD status = 0;
        DWORD size = sizeof(status);
        if (!WinHttpQueryHeaders(request.get(), WINHTTP_QUERY_STATUS_CODE |
            WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_HEADER_NAME_BY_INDEX, &status, &size,
            WINHTTP_NO_HEADER_INDEX))
          return failure(GetLastError());
        if (status != 101) return failure(ERROR_WINHTTP_INVALID_SERVER_RESPONSE);
        // RECEIVE_TIMEOUT is an HTTP-request option, not a WebSocket-handle
        // option. The upgraded socket inherits it from the request.
        DWORD timeout = 0;
        if (!WinHttpSetOption(request.get(), WINHTTP_OPTION_RECEIVE_TIMEOUT,
                              &timeout, sizeof(timeout)))
          return failure(GetLastError());
        auto binding = std::make_unique<Context>(Context{shared_from_this(), true});
        socket.reset(WinHttpWebSocketCompleteUpgrade(request.get(),
            reinterpret_cast<DWORD_PTR>(binding.get())));
        if (!socket.get()) return failure(GetLastError());
        binding.release();
        request.reset();
        // A quiet connection is valid; cancellation is event-driven, not a
        // receive timeout. WinHTTP automatically responds to control ping frames.
        upgraded = true;
        deadline = std::chrono::steady_clock::time_point::max();
        {
          std::lock_guard lock(mutex);
          opened = !stopping;
        }
        if (!notifyOpened()) return {WebSocketCloseKind::callbackError, 1011, 0};
        if (const auto error = receive(); error != NO_ERROR) return failure(error);
      } else if (event.status == WINHTTP_CALLBACK_STATUS_WRITE_COMPLETE && event.websocket) {
        std::lock_guard lock(mutex);
        outgoingBytes -= sending.size();
        --outgoingCount;
        sending.clear();
        sendPending = false;
      } else if (event.status == WINHTTP_CALLBACK_STATUS_READ_COMPLETE && event.websocket) {
        receivePending = false;
        if (event.type == WINHTTP_WEB_SOCKET_CLOSE_BUFFER_TYPE) {
          USHORT code = 1005;
          DWORD consumed = 0;
          std::array<char, 123> reason{};
          const auto error = WinHttpWebSocketQueryCloseStatus(socket.get(), &code,
              reason.data(), static_cast<DWORD>(reason.size()), &consumed);
          if (error != NO_ERROR) return failure(error);
          if (!gracefulStopping) {
            const auto shutdownError = WinHttpWebSocketShutdown(socket.get(),
                code == 1005 ? WINHTTP_WEB_SOCKET_SUCCESS_CLOSE_STATUS : code, nullptr, 0);
            if (shutdownError != NO_ERROR) return failure(shutdownError);
            // Wait for asynchronous shutdown to flush the close response.
            gracefulStopping = true;
            deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(250);
            pendingPeerClose = {WebSocketCloseKind::peerClosed, code, 0};
            {
              std::lock_guard lock(mutex);
              opened = false;
            }
          } else {
            return {WebSocketCloseKind::peerClosed, code, 0};
          }
        } else if (!gracefulStopping) {
          if (event.type != WINHTTP_WEB_SOCKET_UTF8_FRAGMENT_BUFFER_TYPE &&
              event.type != WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE)
            return {WebSocketCloseKind::invalidMessage, 1003, 0};
          if (event.bytes > maxIncoming - assembled.size()) {
            return {WebSocketCloseKind::messageTooLarge, 1009, 0};
          }
          assembled.append(receiveBuffer.data(), event.bytes);
          if (event.type == WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE) {
            if (!websocket_detail::validUtf8(assembled))
              return {WebSocketCloseKind::invalidMessage, 1007, 0};
            auto text = std::move(assembled);
            assembled.clear();
            if (!notifyText(std::move(text)))
              return {WebSocketCloseKind::callbackError, 1011, 0};
          }
          if (!isStopping()) {
            if (const auto error = receive(); error != NO_ERROR) return failure(error);
          }
        } else {
          if (const auto error = receive(); error != NO_ERROR) return failure(error);
        }
      } else if (event.status == WINHTTP_CALLBACK_STATUS_SHUTDOWN_COMPLETE &&
                 pendingPeerClose) {
        return *pendingPeerClose;
      }
    }
  }

  std::optional<WebSocketClose> pendingPeerClose;

  void stop() noexcept {
    {
      std::lock_guard gate(callbackMutex);
      callbacks = {};
    }
    std::unique_lock lock(mutex);
    stopping = true;
    opened = false;
    condition.notify_one();
    if (started && workerId != std::this_thread::get_id())
      condition.wait(lock, [&] { return finished; });
  }
};

WebSocket::WebSocket(WebSocketCallbacks callbacks, std::size_t maxIncomingMessageBytes) {
  if (!maxIncomingMessageBytes)
    throw std::invalid_argument("WebSocket incoming message limit must be positive");
  impl_ = std::make_shared<Impl>(std::move(callbacks), maxIncomingMessageBytes);
}

WebSocket::~WebSocket() { close(); }

void WebSocket::connect(const std::string& url) {
  auto parsed = parseUrl(url);
  auto self = impl_;
  std::lock_guard lock(self->mutex);
  if (self->started || self->stopping)
    throw std::logic_error("WebSocket instances cannot be reused");
  self->started = true;
  try { std::thread([self, parsed = std::move(parsed)] { self->run(parsed); }).detach(); }
  catch (...) { self->started = false; throw; }
}

WebSocketSendResult WebSocket::send(std::string text) {
  auto self = impl_;
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
  self->condition.notify_one();
  return WebSocketSendResult::queued;
}

bool WebSocket::hasPendingSends() const {
  const auto self = impl_;
  std::lock_guard lock(self->mutex);
  return !self->stopping && self->outgoingCount != 0;
}

void WebSocket::close() noexcept {
  auto self = impl_;
  if (self) self->stop();
}

}  // namespace monky::light
