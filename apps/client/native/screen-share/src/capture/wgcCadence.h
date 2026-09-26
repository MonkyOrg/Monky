#pragma once
#include <obs.h>
#include <winrt/Windows.Foundation.Metadata.h>
#include <winrt/Windows.Graphics.Capture.h>

inline void MonkyConfigureWgcCadence(const winrt::Windows::Graphics::Capture::GraphicsCaptureSession& session) {
  if (!winrt::Windows::Foundation::Metadata::ApiInformation::IsPropertyPresent(
      L"Windows.Graphics.Capture.GraphicsCaptureSession", L"MinUpdateInterval")) {
    blog(LOG_INFO, "[Monky WGC] MinUpdateInterval unavailable; frame delivery remains controlled by Windows");
    return;
  }
  obs_video_info video{};
  if (!obs_get_video_info(&video) || !video.fps_num || !video.fps_den) {
    blog(LOG_ERROR, "[Monky WGC] Cannot configure capture cadence without the active video rate");
    throw winrt::hresult_invalid_argument();
  }
  // WGC's default can cap unique frames at 60 Hz. A half-frame interval allows
  // capture/encoder phase jitter without replacing the encoder's own clock.
  const auto interval = static_cast<int64_t>(10000000ULL * video.fps_den / video.fps_num / 2);
  session.MinUpdateInterval(winrt::Windows::Foundation::TimeSpan{interval});
  blog(LOG_INFO, "[Monky WGC] requested_fps=%u/%u min_update_interval_100ns=%lld",
       video.fps_num, video.fps_den, static_cast<long long>(interval));
}
