#pragma once

#include <array>
#include <cstdint>
#include <filesystem>
#include <memory>
#include <optional>

namespace monky::light {

using IdentitySeed = std::array<std::uint8_t, 32>;

// Requires an existing absolute profile directory; does not change its permissions.
// Holds an exclusive OS profile lock until destruction. Calls must be serialized.
// Invalid path arguments throw std::invalid_argument. Other failures throw
// std::runtime_error (including std::system_error/filesystem_error).
class IdentityStore final {
 public:
  explicit IdentityStore(const std::filesystem::path& profileDirectory);
  ~IdentityStore();

  IdentityStore(const IdentityStore&) = delete;
  IdentityStore& operator=(const IdentityStore&) = delete;
  IdentityStore(IdentityStore&&) = delete;
  IdentityStore& operator=(IdentityStore&&) = delete;

  // nullopt means absent, never corrupt, inaccessible, locked or ambiguous.
  // The caller owns and must wipe returned seeds and the input to save().
  std::optional<IdentitySeed> load() const;
  // Create only. An existing identity (even an unreadable one) is never replaced.
  void save(const IdentitySeed& newSeed);

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace monky::light
