#pragma once

#include <functional>

namespace monky::light {

enum class MicrophoneAccess { granted, denied, restricted };
using MicrophoneAccessCallback = std::function<void(MicrophoneAccess)>;
using CancelMicrophoneAccess = std::function<void()>;
using RequestMicrophoneAccess = std::function<CancelMicrophoneAccess(MicrophoneAccessCallback)>;

#ifdef __APPLE__
// The returned cancellation retires callbacks, not the operating system prompt.
CancelMicrophoneAccess requestMicrophoneAccess(MicrophoneAccessCallback callback);
#endif

}  // namespace monky::light
