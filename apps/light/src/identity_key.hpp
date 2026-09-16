#pragma once

#include "platform/identity_store.hpp"

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

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace monky::light
