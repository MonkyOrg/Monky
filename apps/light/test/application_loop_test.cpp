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

}  // namespace

int main() {
  try {
    orderedCallbacks();
    wakingAndDeadline();
    priorityAndLimits();
    std::cout << "Application loop scenarios passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
