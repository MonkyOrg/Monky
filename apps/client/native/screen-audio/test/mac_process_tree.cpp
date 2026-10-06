#include "../src/mac/process_tree.h"
#include <iostream>

int main(int argc, char** argv) {
  try {
    if (argc != 2) return 2;
    const auto tree = screen_audio::ProcessTree(std::stoul(argv[1]));
    std::cout << '[';
    bool first = true;
    for (const auto pid : tree) {
      if (!first) std::cout << ',';
      std::cout << pid;
      first = false;
    }
    std::cout << "]\n";
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
