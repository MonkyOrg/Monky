#pragma once

#include <functional>

namespace monky::light::test {

// The returned action ends the activity; invoke it once when the worker stops.
std::function<void()> BeginFixtureAudioActivity();

}  // namespace monky::light::test
