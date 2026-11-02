#pragma once

// What the macOS VideoToolbox decoder reports when it refuses input. Before #825 every refusal became
// ERR_RTC_MAC_DECODER_INPUT with a fixed message, hiding which check failed. No VideoToolbox session is opened.

#include "mac_rtc_adapters.h"
#include "codec_policy.h"

#include "api/environment/environment_factory.h"
#include "api/video/encoded_image.h"

#include <chrono>
#include <cstring>
#include <string>

namespace monky::native_rtc::mac {

template <typename Check>
void RunDecoderDiagnosticChecks(Check check) {
  auto bundle = CreateFactoryBundle({});
  const auto formats = bundle.decoder_factory->GetSupportedFormats();
  check(!formats.empty(), "The macOS decoder offers no H.264 format");
  auto decoder = bundle.decoder_factory->Create(webrtc::CreateEnvironment(), formats.front());
  check(decoder != nullptr, "The macOS decoder factory refused its own format");
  check(decoder->Decode(webrtc::EncodedImage(), 0) == WEBRTC_VIDEO_CODEC_ERROR,
        "An unconfigured macOS decoder accepted input");
  const auto diagnostics = bundle.context->TakeDiagnostics();
  check(diagnostics.size() == 1, "A refused decode must report exactly one diagnostic");
  const auto& diagnostic = diagnostics.front();
  check(std::string(diagnostic.code.data()) == "ERR_RTC_MAC_DECODER_STATE",
        "A refused decode must report the check that failed, not a generic input error");
  check(std::strcmp(diagnostic.message.data(), "Native VideoToolbox decoding failed") != 0,
        "A refused decode must report its own message");
  check(diagnostic.codec_status == WEBRTC_VIDEO_CODEC_ERR_PARAMETER && !diagnostic.terminal,
        "A refused decode must carry the adapter's codec status and leave the engine open");
  decoder.reset();
  check(bundle.context->WaitForIdle(std::chrono::seconds(1)), "The refused macOS decoder left work behind");
}

}  // namespace monky::native_rtc::mac
