#pragma once
#include <cstdint>
#include <functional>
namespace monky::screen::mac {
int RunOwnedWindow(const std::function<void(uint32_t)>& ready);
}
