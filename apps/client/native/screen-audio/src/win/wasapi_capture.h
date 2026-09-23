#pragma once

#include "../packet_core.h"
#include <windows.h>
#include <mmreg.h>
#include <atomic>
#include <functional>

namespace screen_audio {

struct CaptureTarget {
  uint32_t pid;
  bool include;
};

// Synchronous on the calling worker; all COM/resources stay in that MTA.
// Returning false from either sink callback requests orderly shutdown.
struct CaptureSink {
  std::function<bool(const WAVEFORMATEX*)> ready;
  std::function<bool(const uint8_t*, uint32_t, uint32_t, std::optional<uint64_t>, uint64_t)> packet;
};

Format ParseWasapiFormat(const WAVEFORMATEX* format, size_t bytes);
void RunWasapiCapture(CaptureTarget target, std::atomic<bool>& stop, const CaptureSink& sink);
CaptureTarget ResolvePacketTarget(uint32_t excludedPid, int64_t windowId);

}  // namespace screen_audio
