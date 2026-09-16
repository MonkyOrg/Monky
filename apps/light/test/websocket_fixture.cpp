#include "platform/websocket.hpp"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <iostream>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

using namespace monky::light;
using namespace std::chrono_literals;

int main(int argc, char** argv) {
  if (argc != 3) {
    std::cerr << "Usage: websocket-fixture <url> <scenario>\n";
    return 2;
  }
  const std::string scenario = argv[2];
  try {
    if (scenario == "invalid") {
      for (const auto* url : {"http://localhost", "ftp://localhost", "ws://",
                              "ws://user:secret@localhost", "ws://localhost/#fragment",
                              "ws://localhost/has space", "ws://localhost\\evil",
                              "ws://localhost:0", "ws://localhost:99999"}) {
        WebSocket socket({});
        bool rejected = false;
        try { socket.connect(url); }
        catch (const std::invalid_argument&) { rejected = true; }
        if (!rejected) { std::cerr << "Invalid URL accepted\n"; return 1; }
      }
      WebSocket socket({});
      if (socket.send("offline") != WebSocketSendResult::notOpen) return 1;
      socket.close();
      socket.close();
      bool rejected = false;
      try { socket.connect("ws://127.0.0.1:1"); }
      catch (const std::logic_error&) { rejected = true; }
      return rejected ? 0 : 1;
    }

    std::mutex mutex;
    std::condition_variable condition;
    bool done = false;
    bool failed = false;
    bool echo = false;
    bool pong = false;
    std::atomic<unsigned> callbackCount{0};
    std::unique_ptr<WebSocket> socket;
    auto complete = [&](bool success) {
      std::lock_guard lock(mutex);
      failed = failed || !success;
      done = true;
      condition.notify_all();
    };
    WebSocketCallbacks callbacks;
    callbacks.opened = [&] {
      ++callbackCount;
      if (scenario == "handshake-cancel") { complete(false); return; }
      if (scenario == "exchange") {
        if (socket->send(std::string("\xff", 1)) != WebSocketSendResult::invalidUtf8 ||
            socket->send(std::string(1024 * 1024 + 1, 'x')) != WebSocketSendResult::tooLarge ||
            socket->send("hello") != WebSocketSendResult::queued)
          complete(false);
      }
    };
    callbacks.text = [&](std::string text) {
      ++callbackCount;
      if (scenario == "exchange") {
        if (text == "echo:ol\xc3\xa1 \xf0\x9f\x90\x92") echo = true;
        else if (text == "pong-observed") pong = true;
        else { complete(false); return; }
        if (echo && pong) complete(true);
      } else if (scenario == "close" && text == "close-now") {
        socket->close();
        complete(socket->send("after-close") == WebSocketSendResult::notOpen);
      } else if (scenario == "destroy" && text == "close-now") {
        socket.reset();
        complete(true);
      } else if (scenario == "race" && text == "close-now") {
        std::thread sender([&] {
          for (unsigned i = 0; i < 128; ++i) {
            const auto result = socket->send("race");
            if (result != WebSocketSendResult::queued &&
                result != WebSocketSendResult::notOpen) {
              complete(false);
              return;
            }
          }
        });
        socket->close();
        sender.join();
        complete(true);
      } else if (scenario == "large") {
        complete(text.size() == 8 * 1024 * 1024 &&
                 text.find_first_not_of('x') == std::string::npos);
      } else {
        complete(false);
      }
    };
    callbacks.closed = [&](WebSocketClose close) {
      ++callbackCount;
      std::cerr << "closed kind=" << static_cast<int>(close.kind)
                << " code=" << close.code << " native=" << close.nativeError << '\n';
      complete((scenario == "oversized" &&
                close.kind == WebSocketCloseKind::messageTooLarge && close.code == 1009) ||
               (scenario == "remote-close" &&
                close.kind == WebSocketCloseKind::peerClosed && close.code == 1000) ||
               (scenario == "binary" && close.kind == WebSocketCloseKind::invalidMessage) ||
               (scenario == "failure" && close.kind == WebSocketCloseKind::transportError));
    };
    if (scenario == "large")
      socket = std::make_unique<WebSocket>(std::move(callbacks));
    else
      socket = std::make_unique<WebSocket>(std::move(callbacks), 1024);
    socket->connect(argv[1]);
    if (scenario == "handshake-cancel") {
      std::this_thread::sleep_for(50ms);
      const auto start = std::chrono::steady_clock::now();
      socket->close();
      socket.reset();
      if (std::chrono::steady_clock::now() - start > 2s || callbackCount != 0)
        return 1;
      return 0;
    }
    {
      std::unique_lock lock(mutex);
      if (!condition.wait_for(lock, 8s, [&] { return done; })) {
        std::cerr << "WebSocket fixture timed out\n";
        failed = true;
      }
    }
    if (socket) socket->close();
    if (scenario == "destroy") {
      const auto count = callbackCount.load();
      std::this_thread::sleep_for(300ms);
      if (callbackCount != count) failed = true;
    }
    if (failed) std::cerr << "WebSocket fixture scenario failed: " << scenario << '\n';
    return failed ? 1 : 0;
  } catch (const std::exception& error) {
    std::cerr << "WebSocket fixture exception: " << error.what() << '\n';
    return 1;
  }
}
