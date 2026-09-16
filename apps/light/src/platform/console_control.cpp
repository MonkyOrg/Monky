#include "console_control.hpp"

#include <array>
#include <atomic>
#include <cerrno>
#include <cstring>
#include <stdexcept>
#include <thread>
#include <utility>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#else
#include <csignal>
#include <fcntl.h>
#include <poll.h>
#include <unistd.h>
#endif

namespace monky::light {
namespace {

#ifdef _WIN32
std::atomic<HANDLE> controlEvent = nullptr;

BOOL WINAPI onConsoleSignal(DWORD signal) {
  if (signal != CTRL_C_EVENT && signal != CTRL_BREAK_EVENT && signal != CTRL_CLOSE_EVENT &&
      signal != CTRL_LOGOFF_EVENT && signal != CTRL_SHUTDOWN_EVENT) {
    return FALSE;
  }
  const auto event = controlEvent.load();
  return event && SetEvent(event) ? TRUE : FALSE;
}
#else
volatile std::sig_atomic_t controlPipe = -1;

void onConsoleSignal(int) {
  const auto saved = errno;
  const auto descriptor = controlPipe;
  if (descriptor >= 0) {
    const char value = 1;
    const auto written = write(descriptor, &value, 1);
    (void)written;
  }
  errno = saved;
}
#endif

}  // namespace

struct ConsoleControl::Impl final {
  Callbacks callbacks;
  std::atomic_bool stopping = false;
  std::atomic_flag quitNotified = ATOMIC_FLAG_INIT;
  std::thread reader;
  std::string pending;
#ifdef _WIN32
  HANDLE event = nullptr;
  std::thread signals;
  bool registered = false;
#else
  std::array<int, 2> descriptors{-1, -1};
  struct sigaction previousInterrupt {};
  struct sigaction previousTerminate {};
  bool interruptInstalled = false;
  bool terminateInstalled = false;
#endif

  explicit Impl(Callbacks value) : callbacks(std::move(value)) {
    if (!callbacks.line || !callbacks.quit || !callbacks.error) {
      throw std::invalid_argument("Console control requires line, quit and error callbacks");
    }
    try {
      initialize();
      reader = std::thread([this] { readInput(); });
#ifdef _WIN32
      signals = std::thread([this] {
        const auto result = WaitForSingleObject(event, INFINITE);
        if (!stopping) {
          if (result == WAIT_OBJECT_0) notifyQuit();
          else callbacks.error("Console signal wait failed: " + std::to_string(GetLastError()));
        }
      });
#endif
    } catch (...) {
      close();
      throw;
    }
  }

  ~Impl() { close(); }

  void notifyQuit() {
    if (!stopping && !quitNotified.test_and_set()) callbacks.quit();
  }

  bool append(const char* bytes, std::size_t size) {
    constexpr std::size_t maxLineBytes = 64 * 1024;
    for (std::size_t index = 0; index < size && !stopping; ++index) {
      if (bytes[index] == '\n') {
        if (!pending.empty() && pending.back() == '\r') pending.pop_back();
        callbacks.line(std::move(pending));
        pending.clear();
      } else {
        if (pending.size() == maxLineBytes) {
          callbacks.error("Console command exceeded 64 KiB");
          return false;
        }
        pending.push_back(bytes[index]);
      }
    }
    return !stopping;
  }

  void endOfInput() {
    if (!stopping && !pending.empty()) callbacks.line(std::move(pending));
    notifyQuit();
  }

  void initialize() {
#ifdef _WIN32
    event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!event) throw std::runtime_error("Unable to create the console shutdown event");
    HANDLE empty = nullptr;
    if (!controlEvent.compare_exchange_strong(empty, event)) {
      throw std::logic_error("Another console control already owns process signals");
    }
    if (!SetConsoleCtrlHandler(onConsoleSignal, TRUE)) {
      controlEvent = nullptr;
      throw std::runtime_error("Unable to register native console shutdown handling");
    }
    registered = true;
#else
    if (controlPipe >= 0) throw std::logic_error("Another console control already owns process signals");
    if (pipe(descriptors.data()) != 0) throw std::runtime_error("Unable to create the console shutdown pipe");
    for (const auto descriptor : descriptors) {
      if (fcntl(descriptor, F_SETFD, FD_CLOEXEC) != 0 ||
          fcntl(descriptor, F_SETFL, O_NONBLOCK) != 0) {
        throw std::runtime_error("Unable to configure the console shutdown pipe");
      }
    }
    controlPipe = descriptors[1];
    struct sigaction action {};
    action.sa_handler = onConsoleSignal;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGINT, &action, &previousInterrupt) != 0) {
      throw std::runtime_error("Unable to register SIGINT handling");
    }
    interruptInstalled = true;
    if (sigaction(SIGTERM, &action, &previousTerminate) != 0) {
      throw std::runtime_error("Unable to register SIGTERM handling");
    }
    terminateInstalled = true;
#endif
  }

  void readInput() {
    std::array<char, 4096> bytes{};
#ifdef _WIN32
    const auto input = GetStdHandle(STD_INPUT_HANDLE);
    if (!input || input == INVALID_HANDLE_VALUE) {
      callbacks.error("Standard input is unavailable");
      return;
    }
    while (!stopping) {
      DWORD count = 0;
      if (!ReadFile(input, bytes.data(), static_cast<DWORD>(bytes.size()), &count, nullptr)) {
        const auto error = GetLastError();
        if (stopping) return;
        if (error == ERROR_BROKEN_PIPE || error == ERROR_HANDLE_EOF) endOfInput();
        else callbacks.error("Console input read failed: " + std::to_string(error));
        return;
      }
      if (count == 0) {
        endOfInput();
        return;
      }
      if (!append(bytes.data(), count)) return;
    }
#else
    std::array<pollfd, 2> watched{{{STDIN_FILENO, POLLIN, 0}, {descriptors[0], POLLIN, 0}}};
    while (!stopping) {
      const auto ready = poll(watched.data(), watched.size(), -1);
      if (ready < 0) {
        if (errno == EINTR) continue;
        callbacks.error("Console input wait failed: " + std::string(std::strerror(errno)));
        return;
      }
      if (watched[1].revents != 0) {
        notifyQuit();
        return;
      }
      if ((watched[0].revents & POLLNVAL) != 0) {
        callbacks.error("Standard input is not a valid descriptor");
        return;
      }
      if (watched[0].revents != 0) {
        const auto count = read(STDIN_FILENO, bytes.data(), bytes.size());
        if (count < 0) {
          if (errno == EINTR || errno == EAGAIN) continue;
          callbacks.error("Console input read failed: " + std::string(std::strerror(errno)));
          return;
        }
        if (count == 0) {
          endOfInput();
          return;
        }
        if (!append(bytes.data(), static_cast<std::size_t>(count))) return;
      }
    }
#endif
  }

  void close() noexcept {
    stopping = true;
#ifdef _WIN32
    if (event) SetEvent(event);
    if (signals.joinable()) signals.join();
    if (reader.joinable()) {
      // Cancellation can race the next blocking ReadFile; retry only during teardown.
      while (WaitForSingleObject(reader.native_handle(), 0) == WAIT_TIMEOUT) {
        CancelSynchronousIo(reader.native_handle());
        WaitForSingleObject(reader.native_handle(), 10);
      }
      reader.join();
    }
    if (registered) {
      SetConsoleCtrlHandler(onConsoleSignal, FALSE);
      controlEvent = nullptr;
    }
    if (event) CloseHandle(event);
#else
    if (controlPipe == descriptors[1]) controlPipe = -1;
    if (terminateInstalled) sigaction(SIGTERM, &previousTerminate, nullptr);
    if (interruptInstalled) sigaction(SIGINT, &previousInterrupt, nullptr);
    if (descriptors[1] >= 0) {
      const char value = 1;
      const auto written = write(descriptors[1], &value, 1);
      (void)written;
    }
    if (reader.joinable()) reader.join();
    for (const auto descriptor : descriptors) if (descriptor >= 0) ::close(descriptor);
#endif
  }
};

ConsoleControl::ConsoleControl(Callbacks callbacks) : impl_(std::make_unique<Impl>(std::move(callbacks))) {}
ConsoleControl::~ConsoleControl() = default;

}  // namespace monky::light
