#include "identity_key.hpp"

#include <openssl/bytestring.h>
#include <openssl/curve25519.h>
#include <openssl/evp.h>
#include <openssl/mem.h>
#include <openssl/rand.h>

#include <array>
#include <cstddef>
#include <stdexcept>

namespace monky::light {
namespace {

std::string hex(const std::uint8_t* bytes, std::size_t length) {
  constexpr char alphabet[] = "0123456789abcdef";
  std::string output(length * 2, '\0');
  for (std::size_t index = 0; index < length; ++index) {
    output[index * 2] = alphabet[bytes[index] >> 4];
    output[index * 2 + 1] = alphabet[bytes[index] & 15];
  }
  return output;
}

unsigned hexDigit(char value) {
  if (value >= '0' && value <= '9') return static_cast<unsigned>(value - '0');
  if (value >= 'a' && value <= 'f') return static_cast<unsigned>(value - 'a') + 10;
  if (value >= 'A' && value <= 'F') return static_cast<unsigned>(value - 'A') + 10;
  throw std::invalid_argument("Authentication nonce contains a non-hexadecimal character");
}

struct PrivateKey final {
  std::array<std::uint8_t, ED25519_PRIVATE_KEY_LEN> bytes{};
  ~PrivateKey() { OPENSSL_cleanse(bytes.data(), bytes.size()); }
  PrivateKey() = default;
  PrivateKey(const PrivateKey&) = delete;
  PrivateKey& operator=(const PrivateKey&) = delete;
};

struct DerBuilder final {
  CBB value{};
  ~DerBuilder() { CBB_cleanup(&value); }
};

struct DerBytes final {
  std::uint8_t* value = nullptr;
  ~DerBytes() { OPENSSL_free(value); }
};

std::string publicKeyDerHex(const std::array<std::uint8_t, ED25519_PUBLIC_KEY_LEN>& raw) {
  bssl::UniquePtr<EVP_PKEY> key(EVP_PKEY_new_raw_public_key(
      EVP_PKEY_ED25519, nullptr, raw.data(), raw.size()));
  if (!key) throw std::runtime_error("Ed25519 public key construction failed");
  DerBuilder builder;
  if (CBB_init(&builder.value, 64) != 1 ||
      EVP_marshal_public_key(&builder.value, key.get()) != 1) {
    throw std::runtime_error("Ed25519 SPKI serialization failed");
  }
  DerBytes bytes;
  std::size_t length = 0;
  if (CBB_finish(&builder.value, &bytes.value, &length) != 1) {
    throw std::runtime_error("Ed25519 SPKI serialization did not finish");
  }
  return hex(bytes.value, length);
}

}  // namespace

struct IdentityKey::Impl final {
  PrivateKey privateKey;
  std::string publicKey;

  explicit Impl(const IdentitySeed& seed) {
    std::array<std::uint8_t, ED25519_PUBLIC_KEY_LEN> rawPublic{};
    ED25519_keypair_from_seed(rawPublic.data(), privateKey.bytes.data(), seed.data());
    publicKey = publicKeyDerHex(rawPublic);
  }
};

void clearIdentitySeed(IdentitySeed& seed) noexcept {
  OPENSSL_cleanse(seed.data(), seed.size());
}

void generateIdentitySeed(IdentitySeed& output) {
  if (RAND_bytes(output.data(), output.size()) != 1) {
    clearIdentitySeed(output);
    throw std::runtime_error("Native identity randomness is unavailable");
  }
}

std::string randomUuid() {
  std::array<std::uint8_t, 16> bytes{};
  if (RAND_bytes(bytes.data(), bytes.size()) != 1) {
    throw std::runtime_error("Native identifier randomness is unavailable");
  }
  bytes[6] = static_cast<std::uint8_t>((bytes[6] & 15) | 0x40);
  bytes[8] = static_cast<std::uint8_t>((bytes[8] & 63) | 0x80);
  const auto encoded = hex(bytes.data(), bytes.size());
  return encoded.substr(0, 8) + "-" + encoded.substr(8, 4) + "-" +
      encoded.substr(12, 4) + "-" + encoded.substr(16, 4) + "-" + encoded.substr(20);
}

IdentityKey::IdentityKey(const IdentitySeed& seed) : impl_(std::make_unique<Impl>(seed)) {}
IdentityKey::~IdentityKey() = default;

const std::string& IdentityKey::publicKeyHex() const noexcept {
  return impl_->publicKey;
}

std::string IdentityKey::signChallenge(std::string_view nonceHex) const {
  std::array<std::uint8_t, 32> nonce{};
  if (nonceHex.size() != nonce.size() * 2) {
    throw std::invalid_argument("Authentication nonce must contain 64 hexadecimal characters");
  }
  for (std::size_t index = 0; index < nonce.size(); ++index) {
    nonce[index] = static_cast<std::uint8_t>(
        hexDigit(nonceHex[index * 2]) * 16 + hexDigit(nonceHex[index * 2 + 1]));
  }
  return signChallenge(nonce);
}

std::string IdentityKey::signChallenge(const std::array<std::uint8_t, 32>& nonce) const {
  std::array<std::uint8_t, ED25519_SIGNATURE_LEN> signature{};
  if (ED25519_sign(signature.data(), nonce.data(), nonce.size(), impl_->privateKey.bytes.data()) != 1) {
    throw std::runtime_error("Native authentication signing failed");
  }
  return hex(signature.data(), signature.size());
}

}  // namespace monky::light
