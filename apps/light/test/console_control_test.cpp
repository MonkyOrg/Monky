#include "application_loop.hpp"
#include "platform/console_control.hpp"

#include <iostream>
#include <string_view>

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
    if (argc == 2 && std::string_view(argv[1]) == "--stop-with-open-input") {
      loop.post([&] { loop.stop(); });
    }
    std::cout << "ready\n" << std::flush;
    loop.run([] { return monky::light::ApplicationLoop::Deadline{}; }, [](auto) {});
    return exitCode;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
