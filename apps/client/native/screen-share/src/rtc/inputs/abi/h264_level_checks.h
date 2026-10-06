#pragma once

#include "api/video_codecs/h264_profile_level_id.h"
#include "../native_core/h264_bitstream.h"

namespace monky::native_rtc {

template <typename Check>
void RunH264LevelChecks(Check check) {
  const auto main6 = webrtc::ParseH264ProfileLevelId("4d003c");
  check(main6 && main6->profile == webrtc::H264Profile::kProfileMain &&
      main6->level == webrtc::H264Level::kLevel6, "Pinned SDP parser must recognize Main Level6");
  check(main6 && webrtc::H264ProfileLevelIdToString(*main6) == "4d003c", "Level6 SDP must round-trip honestly");
  for (const auto* unsupported : {"4d0035", "4d003b", "4d003d", "4d003e", "4d00ff"})
    check(!webrtc::ParseH264ProfileLevelId(unsupported), "Unsupported levels must remain unsupported");
  const webrtc::CodecParameterMap level6{{"profile-level-id", "4d003c"}};
  const webrtc::CodecParameterMap level52{{"profile-level-id", "4d0034"}};
  check(webrtc::H264IsSameProfile(level6, level52), "Level6 must not change the meaning of Main profile");
  check(!webrtc::H264IsSameProfileAndLevel(level6, level52), "Level5.2 must not become Level6 support");
  check(webrtc::H264SupportedLevel(139264 * 256, 30) == webrtc::H264Level::kLevel6,
      "Level6's exact MaxFS/MaxMBPS boundary must be retained");
  check(webrtc::H264SupportedLevel(139264 * 256, 29) == webrtc::H264Level::kLevel5_1,
      "Level6 must not be advertised without its macroblock-rate capacity");
  check(screen_video::RequiredH264Level(3840, 2160, 120, 20000000) == 60,
      "4K120 requires Level6 even at the unchanged20Mbps ceiling");
  check(screen_video::RequiredH264Level(3840, 2160, 60, 20000000) == 52, "4K60 requires Level5.2");
  check(screen_video::RequiredH264Level(1920, 1080, 120, 20000000) == 51, "1080p120 remains Level5.1");
  check(screen_video::RequiredH264Level(1920, 1080, 240, 20000000) == 52, "1080p240 requires Level5.2");
  check(screen_video::H264LevelMaxBitrate(60) == 240000000, "H264 standard limit must not redefine Monky's20Mbps cap");
}

}  // namespace monky::native_rtc
