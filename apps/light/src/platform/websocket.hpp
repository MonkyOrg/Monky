#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <stdexcept>
#include <string>
#include <string_view>

namespace monky::light {

enum class WebSocketCloseKind {
  peerClosed,
  transportError,
  messageTooLarge,
  invalidMessage,
  callbackError,
};

struct WebSocketClose {
  WebSocketCloseKind kind = WebSocketCloseKind::transportError;
  std::uint16_t code = 1006;
  std::int64_t nativeError = 0;
};

enum class WebSocketSendResult { queued, notOpen, tooLarge, invalidUtf8, queueFull };

struct WebSocketCallbacks {
  std::function<void()> opened;
  std::function<void(std::string)> text;
  std::function<void(WebSocketClose)> closed;
};

// One instance = one connection. connect validates synchronously (invalid_argument;
// logic_error on reuse), then starts asynchronous I/O. Native failures use closed.
// Callbacks are serialized on a private worker/operation queue, never the main
// thread; they must not throw. They may send, close, or destroy this instance.
// send reports queue acceptance, NOT delivery; subsequent I/O failures use closed.
// Pending outgoing data is bounded to 4 MiB and 256 messages (1 MiB per message).
// close/destruction cancel I/O and retire callbacks, silently: local cancellation
// is not a transport failure. On return no callback can access the owner, except
// the currently executing callback when close/destruction is called from it.
class WebSocket final {
 public:
  explicit WebSocket(WebSocketCallbacks callbacks,
                     std::size_t maxIncomingMessageBytes = 8 * 1024 * 1024);
  ~WebSocket();
  WebSocket(const WebSocket&) = delete;
  WebSocket& operator=(const WebSocket&) = delete;
  WebSocket(WebSocket&&) = delete;
  WebSocket& operator=(WebSocket&&) = delete;

  void connect(const std::string& url);
  WebSocketSendResult send(std::string text);
  // Includes the in-flight write. Empty means handed to the native transport,
  // not acknowledged by the server. Useful for bounded graceful logout.
  bool hasPendingSends() const;
  void close() noexcept;

 private:
  struct Impl;
  std::shared_ptr<Impl> impl_;
};

namespace websocket_detail {

inline bool validUtf8(std::string_view text) {
  for (std::size_t i = 0; i < text.size();) {
    const auto first = static_cast<unsigned char>(text[i++]);
    if (first <= 0x7f) continue;
    unsigned count = 0;
    std::uint32_t value = 0;
    std::uint32_t minimum = 0;
    if (first >= 0xc2 && first <= 0xdf) {
      count = 1; value = first & 0x1f; minimum = 0x80;
    } else if (first >= 0xe0 && first <= 0xef) {
      count = 2; value = first & 0x0f; minimum = 0x800;
    } else if (first >= 0xf0 && first <= 0xf4) {
      count = 3; value = first & 0x07; minimum = 0x10000;
    } else {
      return false;
    }
    if (text.size() - i < count) return false;
    while (count--) {
      const auto next = static_cast<unsigned char>(text[i++]);
      if ((next & 0xc0) != 0x80) return false;
      value = (value << 6) | (next & 0x3f);
    }
    if (value < minimum || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff))
      return false;
  }
  return true;
}

inline void validateUrl(const std::string& url) {
  const auto scheme = url.find("://");
  if (scheme == std::string::npos ||
      (url.substr(0, scheme) != "ws" && url.substr(0, scheme) != "wss") ||
      url.size() > 16 * 1024 || !validUtf8(url))
    throw std::invalid_argument("WebSocket requires a valid ws or wss URL");
  for (const unsigned char c : url) {
    if (c <= 0x20 || c == 0x7f || c == '\\' || c == '#')
      throw std::invalid_argument("WebSocket URL contains a forbidden character");
  }
  const auto start = scheme + 3;
  const auto end = url.find_first_of("/?", start);
  const auto authority = url.substr(start, end - start);
  if (authority.empty() || authority.find('@') != std::string::npos ||
      authority.find('%') != std::string::npos)
    throw std::invalid_argument("WebSocket URL requires a host without userinfo");
}

inline constexpr std::size_t maxOutgoingMessageBytes = 1024 * 1024;
inline constexpr std::size_t maxOutgoingQueueBytes = 4 * 1024 * 1024;
inline constexpr std::size_t maxOutgoingQueueMessages = 256;

}  // namespace websocket_detail
}  // namespace monky::light
