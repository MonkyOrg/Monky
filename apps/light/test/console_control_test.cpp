#include "application_loop.hpp"
#include "platform/console_control.hpp"

#include <chrono>
#include <iostream>
#include <string_view>
#include <thread>

int main(int argc, char* argv[]) {
  try {
    monky::light::ApplicationLoop loop;
    int exitCode = 0;
    monky::light::ConsoleControl control({
      [&](std::string line) {
        const auto size = line.size();
        loop.post([&, line = std::move(line)] {
          if (line == "quit") loop.stop();
          else std::cout << "line:" << line << '\n' << std::flush;
        }, size);
      },
      [&] { loop.post([&] { loop.stop(); }); },
      [&](std::string error) {
        loop.post([&, error = std::move(error)] {
          std::cerr << error << '\n';
          exitCode = 2;
          loop.stop();
        });
      },
    });
    const std::string_view mode = argc == 2 ? std::string_view(argv[1]) : std::string_view();
    if (mode == "--stop-with-open-input") {
      loop.post([&] { loop.stop(); });
    }
    std::cout << "ready\n" << std::flush;
    loop.run([] { return monky::light::ApplicationLoop::Deadline{}; }, [](auto) {});
    // Where the core leaves the call and logs out. A closed console must keep
    // the process alive meanwhile, and still let it end through main.
    if (mode == "--slow-teardown") std::this_thread::sleep_for(std::chrono::milliseconds(500));
    return exitCode;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
