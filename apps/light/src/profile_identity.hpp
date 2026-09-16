#pragma once

#include <array>
#include <cstdint>
#include <filesystem>
#include <memory>
#include <optional>
#include <string>
#include <string_view>

namespace monky::light {

// User preferences stored beside the identity. They never influence identity
// validation; unreadable settings are reported and can be replaced by a save.
struct ProfileSettings {
  std::optional<std::string> inputDeviceId;   // nullopt: system default
  std::optional<std::string> outputDeviceId;  // nullopt: system default
};

// Owns the signing key and exclusive profile lock for its entire lifetime.
// Requires an absolute path and an existing parent; creates only the profile leaf.
// Existing directories must contain only this component's identity and settings files.
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
  // Throws for unreadable or invalid settings; a missing file yields defaults.
  ProfileSettings loadSettings() const;
  // Atomically replaces the settings file under the held profile lock.
  void saveSettings(const ProfileSettings& settings) const;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace monky::light
