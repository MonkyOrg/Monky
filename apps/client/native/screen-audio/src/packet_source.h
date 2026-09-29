#pragma once
#include "packet_core.h"
#include <functional>

namespace screen_audio {
struct PacketCaptureSink {
  std::function<bool(const Format&)> ready;
  std::function<bool(const uint8_t*, uint32_t, uint32_t, std::optional<uint64_t>, uint64_t)> packet;
};
struct PacketCaptureSelection {
  uint32_t excludedPid = 0;
  int64_t windowId = 0;
  uint32_t expectedPid = 0;
  std::string expectedProcessStartTimeUs;
};
}

#if defined(_WIN32)
#include "win/wasapi_capture.h"
namespace screen_audio {
inline void RunPacketCapture(const PacketCaptureSelection& selection, std::atomic<bool>& stop,
                             const PacketCaptureSink& sink) {
  const auto target = ResolvePacketTarget(selection.excludedPid, selection.windowId);
  if (selection.expectedPid && target.pid != selection.expectedPid)
    throw Failure("ERR_AUDIO_TARGET", "The selected window no longer belongs to the expected process");
  CaptureSink native;
  native.ready = [&](const WAVEFORMATEX* wave) {
    return sink.ready(ParseWasapiFormat(wave, sizeof(WAVEFORMATEX) + wave->cbSize));
  };
  native.packet = sink.packet;
  RunWasapiCapture(target, stop, native);
}
}
#else
namespace screen_audio {
void RunPacketCapture(const PacketCaptureSelection& selection, std::atomic<bool>& stop,
                      const PacketCaptureSink& sink);
}
#endif
