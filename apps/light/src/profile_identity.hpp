#pragma once

#include <array>
#include <cstdint>
#include <filesystem>
#include <memory>
#include <string>
#include <string_view>

namespace monky::light {

// Owns the signing key and exclusive profile lock for its entire lifetime.
// Requires an absolute path and an existing parent; creates only the profile leaf.
// Existing directories must contain only this component's identity files.
// Incomplete/inconsistent profiles throw and require explicit recovery, never reset.
class ProfileIdentity final {
 public:
  explicit ProfileIdentity(const std::filesystem::path& profileDirectory);
  ~ProfileIdentity();

  ProfileIdentity(const ProfileIdentity&) = delete;
  ProfileIdentity& operator=(const ProfileIdentity&) = delete;
  ProfileIdentity(ProfileIdentity&&) = delete;
  ProfileIdentity& operator=(ProfileIdentity&&) = delete;

  const std::string& publicKeyHex() const noexcept;
  const std::string& deviceId() const noexcept;
  std::string signChallenge(const std::array<std::uint8_t, 32>& nonce) const;
  std::string signChallenge(std::string_view nonceHex) const;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace monky::light
