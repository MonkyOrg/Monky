#pragma once

#include "engine_shared.h"
#include "api\field_trials_view.h"

#include <functional>

namespace monky::native_rtc::engine {

constexpr std::size_t kEncodedMaximumBytes = 8 * 1024 * 1024;
constexpr std::size_t kEncodedMaximumPacket = 4 * 1024 * 1024;
constexpr std::size_t kEncodedMaximumFrames = 16;
constexpr std::int64_t kEncodedMaximumAgeUs = 500000;
constexpr std::uint32_t kEncodedBitrateCeiling = 80000000;
constexpr std::uint8_t kEncodedH264Level = 60;

class EncodedVideoContext;
struct EncodedFactoryBundle {
  std::shared_ptr<EncodedVideoContext> context;
  std::unique_ptr<webrtc::VideoEncoderFactory> encoder_factory;
  std::unique_ptr<webrtc::FieldTrialsView> field_trials;
};

EncodedFactoryBundle CreateEncodedVideoFactory(std::uint8_t maximum_level);
std::shared_ptr<VideoSource> CreateEncodedVideoSource(
    Host& host, std::uint64_t id, const Json& options,
    const std::shared_ptr<Cancellation>& cancellation,
    const std::shared_ptr<EncodedVideoContext>& context);

void ValidateEncodedFrame(const MonkyEngineEncodedFrame& frame);
void RunEncodedVideoChecks(const std::function<void(bool, const char*)>& check);

}  // namespace monky::native_rtc::engine
