#include <mediasoupclient.hpp>
#include <sdp/Utils.hpp>
#include <sdptransform.hpp>
#include <api/audio/builtin_audio_processing_builder.h>
#include <api/audio/audio_processing.h>
#include <api/audio_codecs/builtin_audio_decoder_factory.h>
#include <api/audio_codecs/builtin_audio_encoder_factory.h>
#include <api/create_peerconnection_factory.h>
#include <api/environment/environment_factory.h>
#include <openssl/bytestring.h>
#include <openssl/curve25519.h>
#include <openssl/evp.h>
#include <openssl/mem.h>
#include <openssl/rand.h>

#include <array>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <stdexcept>

namespace {

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

struct MediaRuntime final {
  MediaRuntime() { mediasoupclient::Initialize(); }
  ~MediaRuntime() { mediasoupclient::Cleanup(); }
};

struct TestKey final {
  std::array<std::uint8_t, 32> seed{};
  std::array<std::uint8_t, 32> publicKey{};
  std::array<std::uint8_t, 64> privateKey{};
  ~TestKey() {
    OPENSSL_cleanse(seed.data(), seed.size());
    OPENSSL_cleanse(privateKey.data(), privateKey.size());
  }
};

struct DerBuilder final {
  CBB value{};
  ~DerBuilder() { CBB_cleanup(&value); }
};

struct OpenSslBytes final {
  std::uint8_t* value = nullptr;
  ~OpenSslBytes() { OPENSSL_free(value); }
};

void checkIdentityCrypto() {
  TestKey key;
  require(RAND_bytes(key.seed.data(), key.seed.size()) == 1, "Native random generation failed");
  ED25519_keypair_from_seed(key.publicKey.data(), key.privateKey.data(), key.seed.data());
  std::array<std::uint8_t, 32> nonce{};
  std::array<std::uint8_t, 64> signature{};
  require(RAND_bytes(nonce.data(), nonce.size()) == 1, "Native nonce generation failed");
  require(ED25519_sign(signature.data(), nonce.data(), nonce.size(), key.privateKey.data()) == 1,
          "Native Ed25519 signing failed");
  require(ED25519_verify(nonce.data(), nonce.size(), signature.data(), key.publicKey.data()) == 1,
          "Native Ed25519 signature did not verify");
  nonce[0] ^= 1;
  require(ED25519_verify(nonce.data(), nonce.size(), signature.data(), key.publicKey.data()) == 0,
          "Native Ed25519 accepted a different nonce");

  bssl::UniquePtr<EVP_PKEY> publicKey(EVP_PKEY_new_raw_public_key(
      EVP_PKEY_ED25519, nullptr, key.publicKey.data(), key.publicKey.size()));
  require(publicKey != nullptr, "Native Ed25519 public key import failed");
  DerBuilder der;
  require(CBB_init(&der.value, 64) == 1, "DER builder initialization failed");
  require(EVP_marshal_public_key(&der.value, publicKey.get()) == 1, "SPKI serialization failed");
  OpenSslBytes encoded;
  std::size_t length = 0;
  require(CBB_finish(&der.value, &encoded.value, &length) == 1, "SPKI serialization did not finish");
  constexpr std::array<std::uint8_t, 12> prefix{
      0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00};
  require(length == prefix.size() + key.publicKey.size(), "Unexpected Ed25519 SPKI length");
  require(std::memcmp(encoded.value, prefix.data(), prefix.size()) == 0 &&
              std::memcmp(encoded.value + prefix.size(), key.publicKey.data(), key.publicKey.size()) == 0,
          "SPKI encoding does not match the Monky identity format");
}

void checkAudioOnlyCapabilities() {
  for (int iteration = 0; iteration < 64; ++iteration) {
    const bool feedback = (iteration % 2) != 0;
    const bool extensions = (iteration % 4) >= 2;
    const auto sdp = std::string(
        "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n"
        "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\na=rtpmap:111 opus/48000/2\r\n") +
        (feedback ? "a=rtcp-fb:111 transport-cc\r\n" : "") +
        (extensions ? "a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level\r\n" : "") +
        "m=video 0 UDP/TLS/RTP/SAVPF 0\r\na=mid:1\r\na=inactive\r\n";
    const auto parsed = sdptransform::parse(sdp);
    require(!parsed.at("media").at(1).contains("rtcpFb") &&
                !parsed.at("media").at(1).contains("ext"),
            "Rejected codec-less video should have no optional SDP feedback/extensions");
    const auto capabilities = mediasoupclient::Sdp::Utils::extractRtpCapabilities(parsed);
    require(capabilities.at("codecs").size() == 1 &&
                capabilities.at("codecs").at(0).at("mimeType") == "audio/opus",
            "Audio-only capabilities must not invent video codecs");
    require(capabilities.at("headerExtensions").size() == (extensions ? 1u : 0u),
            "Absent optional SDP extensions must produce an empty capability list");
    require(capabilities.at("codecs").at(0).at("rtcpFeedback").size() == (feedback ? 1u : 0u),
            "Absent optional SDP feedback must produce an empty capability list");
  }
}

}  // namespace

int main() {
  try {
    MediaRuntime runtime;
    checkAudioOnlyCapabilities();
    checkIdentityCrypto();
    const auto environment = webrtc::CreateEnvironment();
    webrtc::AudioProcessing::Config config;
    config.noise_suppression.enabled = true;
    config.noise_suppression.level =
        webrtc::AudioProcessing::Config::NoiseSuppression::kModerate;
    auto processing = webrtc::BuiltinAudioProcessingBuilder(config).Build(environment);
    require(processing != nullptr, "Native audio processing could not be constructed");
    require(processing->GetConfig().noise_suppression.enabled, "Audio processing configuration was lost");
    auto encoders = webrtc::CreateBuiltinAudioEncoderFactory();
    auto decoders = webrtc::CreateBuiltinAudioDecoderFactory();
    require(encoders != nullptr && decoders != nullptr, "Native audio codec factories are unavailable");
    mediasoupclient::Device device;
    require(!device.IsLoaded(), "A new media device unexpectedly reports loaded capabilities");

    // Force this public entry point to link, without constructing a physical audio device.
    auto volatile factoryEntry = &webrtc::CreatePeerConnectionFactory;
    require(factoryEntry != nullptr, "Native PeerConnectionFactory entry point is unavailable");
    std::cout << "Native SDK and identity crypto linked successfully (mediasoup "
              << mediasoupclient::Version() << "). No microphone or media connection was started.\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "Native SDK qualification failed: " << error.what() << '\n';
    return 1;
  }
}
