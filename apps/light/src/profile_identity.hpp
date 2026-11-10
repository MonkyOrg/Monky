#pragma once

#include <array>
#include <cstdint>
#include <filesystem>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace monky::light {

// User preferences stored beside the identity. They never influence identity
// validation; unreadable settings are reported and can be replaced by a save.
struct ProfileSettings {
  std::optional<std::string> inputDeviceId;   // nullopt: system default
  std::optional<std::string> outputDeviceId;  // nullopt: system default
  bool pushToTalk = false;                    // false: voice activity
  // Playback volume per voice session, 0-200 percent like the full client.
  // 100 is the default and is never stored.
  std::map<std::string, int> userVolumes{};
  // A name accepted by parsePushToTalkKey; nullopt until the user picks one.
  std::optional<std::string> pushToTalkKey{};
  // The last server joined without a command line, as a ws(s):// address (an
  // invitation's password is never stored), and the nickname used there.
  std::optional<std::string> server{};
  std::optional<std::string> nickname{};
};

constexpr std::size_t kMaxSavedServerBytes = 2048;
constexpr std::size_t kMaxSavedNicknameBytes = 256;

constexpr int kDefaultUserVolume = 100;
constexpr int kMaxUserVolume = 200;
// Bounds the settings file; setting a volume back to 100 frees its entry.
constexpr std::size_t kMaxUserVolumes = 256;
constexpr std::size_t kMaxVolumeSessionBytes = 256;

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
  std::string signServerChallenge(const std::array<std::uint8_t, 32>& nonce, std::string_view serverKeyHex) const;
  // server-key-auth (#821): the identity key pinned for each server address this profile signed in to.
  // An unreadable pin file throws and requires explicit recovery, like the identity itself.
  std::optional<std::string> serverKey(const std::string& server) const;
  std::vector<std::string> serverKeysExcept(const std::string& server) const;
  // Atomically records the key of the first protected sign-in to this server.
  void pinServerKey(const std::string& server, const std::string& key) const;
  // Throws for unreadable or invalid settings; a missing file yields defaults.
  ProfileSettings loadSettings() const;
  // Atomically replaces the settings file under the held profile lock.
  void saveSettings(const ProfileSettings& settings) const;

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace monky::light
