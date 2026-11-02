#pragma once

#include "platform/identity_store.hpp"

#include <array>
#include <cstdint>
#include <memory>
#include <string>
#include <string_view>

namespace monky::light {

void generateIdentitySeed(IdentitySeed& output);
void clearIdentitySeed(IdentitySeed& seed) noexcept;
std::string randomUuid();

class IdentityKey final {
 public:
  explicit IdentityKey(const IdentitySeed& seed);
  ~IdentityKey();

  IdentityKey(const IdentityKey&) = delete;
  IdentityKey& operator=(const IdentityKey&) = delete;
  IdentityKey(IdentityKey&&) = delete;
  IdentityKey& operator=(IdentityKey&&) = delete;

  const std::string& publicKeyHex() const noexcept;
  std::string signChallenge(std::string_view nonceHex) const;
  std::string signChallenge(const std::array<std::uint8_t, 32>& nonce) const;
  // server-key-auth (#821): signs "monky-auth:v2:<serverKey>:<nonce>", valid only for that server.
  std::string signServerChallenge(const std::array<std::uint8_t, 32>& nonce, std::string_view serverKeyHex) const;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

// Whether `signatureHex` is the server's Ed25519 signature of "monky-server-auth:v1:<serverKey>:<nonce>",
// i.e. the server holds the key it presents. `serverKeyHex` is its lowercase SPKI DER hex.
bool verifyServerChallenge(const std::array<std::uint8_t, 32>& nonce, std::string_view serverKeyHex,
                           std::string_view signatureHex);
// A lowercase Ed25519 SPKI DER key in hexadecimal, the form servers present.
bool isServerKeyHex(std::string_view value);

}  // namespace monky::light
