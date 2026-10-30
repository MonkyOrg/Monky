#include "application_loop.hpp"

#include <chrono>
#include <future>
#include <iostream>
#include <stdexcept>
#include <thread>
#include <vector>

namespace {

using monky::light::ApplicationLoop;
using namespace std::chrono_literals;

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

void orderedCallbacks() {
  ApplicationLoop loop;
  std::vector<int> observed;
  const auto owner = std::this_thread::get_id();
  for (int index = 0; index < 20; ++index) {
    require(loop.post([&, index] {
      require(std::this_thread::get_id() == owner, "Callback left the owning application thread");
      observed.push_back(index);
      if (index == 19) loop.stop();
    }), "A normal event was rejected");
  }
  loop.run([] { return ApplicationLoop::Deadline{}; }, [](auto) {
    throw std::runtime_error("An idle loop must not poll without a deadline");
  });
  for (int index = 0; index < 20; ++index) {
    require(observed.at(static_cast<std::size_t>(index)) == index, "Events were reordered");
  }
  require(!loop.post([] {}), "A stopped loop accepted an event");
}

void wakingAndDeadline() {
  ApplicationLoop loop;
  std::promise<void> first;
  bool ticked = false;
  auto deadline = ApplicationLoop::Deadline{};
  auto producer = std::async(std::launch::async, [&] {
    first.get_future().wait();
    require(loop.post([&] { deadline = ApplicationLoop::Clock::now() + 10ms; }),
            "Cross-thread event was rejected");
  });
  require(loop.post([&] { first.set_value(); }), "Initial event was rejected");
  loop.run([&] { return deadline; }, [&](auto now) {
    require(deadline && now >= *deadline, "Deadline fired early");
    ticked = true;
    loop.stop();
  });
  producer.get();
  require(ticked, "Timed work was never dispatched");
}

void priorityAndLimits() {
  ApplicationLoop loop;
  bool callbackRan = false;
  require(loop.post([&] { callbackRan = true; }), "Initial event was rejected");
  const auto deadline = ApplicationLoop::Clock::now();
  loop.run([&] { return ApplicationLoop::Deadline{deadline}; }, [&](auto) {
    require(!callbackRan, "Pending events starved the protocol deadline");
    loop.stop();
  });
  for (const bool bytes : {false, true}) {
    ApplicationLoop bounded;
    if (bytes) {
      require(!bounded.post([] {}, 16 * 1024 * 1024 + 1), "Oversized payload entered the queue");
    } else {
      for (int index = 0; index < 256; ++index) {
        require(bounded.post([] {}), "Queue filled before its declared limit");
      }
      require(!bounded.post([] {}), "Queue accepted too many callbacks");
    }
    bool failed = false;
    try {
      bounded.run([] { return ApplicationLoop::Deadline{}; }, [](auto) {});
    } catch (const std::runtime_error&) {
      failed = true;
    }
    require(failed, "Queue overflow was silently ignored");
  }
}

// Network input that outruns the core is refused within its share, while the
// core's own work still finds room and the loop carries on.
void networkInputHasItsShare() {
  ApplicationLoop loop;
  for (std::size_t index = 0; index < ApplicationLoop::maxOfferedCallbacks; ++index) {
    require(loop.offer([] {}, 1), "Network input was refused before its share");
  }
  require(!loop.offer([] {}, 1), "Network input took more than its share");
  bool ran = false;
  require(loop.post([&] {
    ran = true;
    loop.stop();
  }), "A full share of network input left no room for the core");
  loop.run([] { return ApplicationLoop::Deadline{}; }, [](auto) {});
  require(ran, "The core's own work did not run after refused network input");

  ApplicationLoop bytes;
  require(bytes.offer([] {}, ApplicationLoop::maxOfferedBytes), "A message within the share was refused");
  require(!bytes.offer([] {}, 1), "Network input passed its share of bytes");
  require(bytes.post([&] { bytes.stop(); }, 1024), "Refused network bytes left no room for the core");
  bytes.run([] { return ApplicationLoop::Deadline{}; }, [](auto) {});
}

}  // namespace

int main() {
  try {
    orderedCallbacks();
    wakingAndDeadline();
    priorityAndLimits();
    networkInputHasItsShare();
    std::cout << "Application loop scenarios passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
