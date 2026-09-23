#include "profile_identity.hpp"
#include "identity_key.hpp"
#include "platform/identity_store.hpp"

#include <json.hpp>

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <optional>
#include <stdexcept>
#include <string>
#include <type_traits>
#include <vector>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#elif defined(__APPLE__)
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <fcntl.h>
#include <limits.h>
#include <unistd.h>
#include <cstring>
#else
#error Profile identity tests require Windows or macOS
#endif

namespace {

namespace fs = std::filesystem;
using Json = nlohmann::json;
using monky::light::IdentityKey;
using monky::light::IdentitySeed;
using monky::light::IdentityStore;
using monky::light::ProfileIdentity;
using monky::light::ProfileSettings;

static_assert(!std::is_copy_constructible_v<ProfileIdentity>);
static_assert(!std::is_move_constructible_v<ProfileIdentity>);

int cleanupFailures = 0;

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

template <typename Action>
void requireFailure(Action action, const char* message) {
  try {
    action();
  } catch (const std::exception&) {
    return;
  }
  throw std::runtime_error(message);
}

void writeFile(const fs::path& path, const std::string& contents) {
  std::ofstream file(path, std::ios::binary | std::ios::trunc);
  file.exceptions(std::ios::failbit | std::ios::badbit);
  file.write(contents.data(), static_cast<std::streamsize>(contents.size()));
  file.close();
}

std::string readFile(const fs::path& path) {
  std::ifstream file(path, std::ios::binary);
  require(file.is_open(), "Open owned test file");
  std::string result(std::istreambuf_iterator<char>{file}, std::istreambuf_iterator<char>{});
  require(!file.bad(), "Read owned test file");
  return result;
}

struct LoadedSeed final {
  std::optional<IdentitySeed> value;
  explicit LoadedSeed(const IdentityStore& store) : value(store.load()) {}
  ~LoadedSeed() { if (value) monky::light::clearIdentitySeed(*value); }
  LoadedSeed(const LoadedSeed&) = delete;
  LoadedSeed& operator=(const LoadedSeed&) = delete;
};

#ifdef __APPLE__
std::string accountFor(const fs::path& profile) {
  const int directory = open(profile.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  require(directory != -1, "Open disposable Keychain profile");
  char name[PATH_MAX]{};
  const int result = fcntl(directory, F_GETPATH, name);
  const int closed = close(directory);
  require(result != -1 && closed == 0, "Resolve disposable Keychain account");
  return name;
}

void eraseTestKeychainEntry(const std::string& account) {
  const auto name = CFStringCreateWithBytes(kCFAllocatorDefault,
      reinterpret_cast<const UInt8*>(account.data()), static_cast<CFIndex>(account.size()),
      kCFStringEncodingUTF8, false);
  const auto query = CFDictionaryCreateMutable(kCFAllocatorDefault, 0,
      &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  if (!name || !query) {
    if (name) CFRelease(name);
    if (query) CFRelease(query);
    throw std::runtime_error("Allocate exact disposable Keychain query");
  }
  CFDictionarySetValue(query, kSecClass, kSecClassGenericPassword);
  CFDictionarySetValue(query, kSecAttrService,
                       CFSTR("org.monky.light.identity.ed25519-seed.v1"));
  CFDictionarySetValue(query, kSecAttrAccount, name);
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  CFDictionarySetValue(query, kSecUseAuthenticationUI, kSecUseAuthenticationUIFail);
#pragma clang diagnostic pop
  const OSStatus status = SecItemDelete(query);
  CFRelease(query);
  CFRelease(name);
  if (status != errSecSuccess && status != errSecItemNotFound) {
    throw std::runtime_error("Exact disposable Keychain deletion failed, OSStatus " +
                             std::to_string(status));
  }
}
#endif

class DisposableProfile final {
 public:
  explicit DisposableProfile(const fs::path& root)
      : path(root / ("profile-identity-test-" + monky::light::randomUuid())) {
    require(fs::create_directory(path), "Exclusively create disposable profile");
#ifdef __APPLE__
    accounts.push_back(accountFor(path));
#endif
  }

  ~DisposableProfile() {
#ifdef __APPLE__
    for (const auto& account : accounts) {
      try {
        eraseTestKeychainEntry(account);
      } catch (const std::exception& error) {
        ++cleanupFailures;
        std::cerr << error.what() << '\n';
      }
    }
#endif
    // Only exact test-owned names, including empty directories used for negative cases.
    for (const auto* name : {".identity.lock", "identity.dpapi", "identity.dpapi.pending",
                             "monky-light.json", "monky-light.json.pending",
                             "monky-light-settings.json", "monky-light-settings.json.pending",
                             "unrelated.txt", "unrelated-directory"}) {
      removeOwned(path / name);
    }
    removeOwned(path);
  }
  DisposableProfile(const DisposableProfile&) = delete;
  DisposableProfile& operator=(const DisposableProfile&) = delete;

  void eraseSeed() {
#ifdef _WIN32
    require(fs::remove(path / "identity.dpapi"), "Remove exact disposable DPAPI identity");
#else
    eraseTestKeychainEntry(accountFor(path));
#endif
  }

  fs::path path;
#ifdef __APPLE__
  std::vector<std::string> accounts;
#endif

 private:
  static void removeOwned(const fs::path& path) {
    std::error_code error;
    fs::remove(path, error);
    if (error) {
      ++cleanupFailures;
      std::cerr << "Owned profile cleanup failed: " << error.message() << '\n';
    }
  }
};

std::optional<std::string> storedPublicKey(const fs::path& profile) {
  IdentityStore store(profile);
  LoadedSeed seed(store);
  if (!seed.value) return std::nullopt;
  return IdentityKey(*seed.value).publicKeyHex();
}

void roundTrip(const fs::path& root) {
  DisposableProfile profile(root);
  require(fs::remove(profile.path), "Remove owned empty leaf before creation scenario");
  std::string publicKey;
  std::string device;
  std::string signature;
  const std::string nonce(64, 'a');
  std::array<std::uint8_t, 32> nonceBytes{};
  nonceBytes.fill(0xaa);
  {
    ProfileIdentity identity(profile.path);
    publicKey = identity.publicKeyHex();
    device = identity.deviceId();
    signature = identity.signChallenge(nonce);
    require(identity.signChallenge(nonceBytes) == signature,
            "Raw and hexadecimal profile nonce signatures differ");
    require(publicKey.size() == 88 && device.size() == 36 && signature.size() == 128,
            "Profile identity API returned an unexpected shape");
    requireFailure([&] { ProfileIdentity second(profile.path); },
                   "Two profile identity owners acquired the same lock");
    requireFailure([&] { ProfileIdentity alias(profile.path / "."); },
                   "Profile path alias bypassed the identity lock");
    requireFailure([&] { IdentityStore second(profile.path); },
                   "Profile identity did not retain its underlying storage lock");
    requireFailure([&] { (void)identity.signChallenge("bad"); },
                   "Profile identity did not forward nonce validation");
  }
  const auto metadataBytes = readFile(profile.path / "monky-light.json");
  const auto metadata = Json::parse(metadataBytes);
  require(metadata.is_object() && metadata.size() == 4 &&
          metadata["format"] == "monky-light-profile" && metadata["version"] == 1 &&
          metadata["deviceId"] == device && metadata["publicKeyHex"] == publicKey,
          "Public profile marker does not match the identity");
  require(!fs::exists(profile.path / "monky-light.json.pending"),
          "Successful profile initialization left its staging marker");
  {
    ProfileIdentity reopened(profile.path / ".");
    require(reopened.publicKeyHex() == publicKey && reopened.deviceId() == device,
            "Reopening changed the public key or device ID");
    require(reopened.signChallenge(nonce) == signature, "Reopening changed the signing key");
    require(reopened.signChallenge(nonceBytes) == signature,
            "Reopening changed raw nonce signing");
  }
  require(readFile(profile.path / "monky-light.json") == metadataBytes,
          "Reopening rewrote public profile metadata");
  DisposableProfile other(root);
  ProfileIdentity first(profile.path);
  ProfileIdentity second(other.path);
  require(first.publicKeyHex() != second.publicKeyHex() && first.deviceId() != second.deviceId(),
          "Independent profiles shared a key or device ID");
}

void malformedMetadata(const fs::path& root) {
  DisposableProfile profile(root);
  std::string publicKey;
  {
    ProfileIdentity identity(profile.path);
    publicKey = identity.publicKeyHex();
  }
  const auto metadataPath = profile.path / "monky-light.json";
  const auto validBytes = readFile(metadataPath);
  const auto valid = Json::parse(validBytes);
  require(validBytes.size() < 4096, "Public metadata unexpectedly exceeds its bound");
  const auto atLimit = validBytes + std::string(4096 - validBytes.size(), ' ');
  writeFile(metadataPath, atLimit);
  {
    ProfileIdentity bounded(profile.path);
    require(bounded.publicKeyHex() == publicKey, "Valid metadata at the size limit was refused");
  }
  require(readFile(metadataPath) == atLimit, "Reading bounded metadata rewrote it");
  std::vector<std::string> invalid{"", "{", "[]", "null", std::string(4097, ' '),
                                 atLimit + " ", validBytes + "{}",
                                 "{\"format\":\"monky-light-profile\",\"format\":\"again\"}"};
  for (const auto& field : {"format", "version", "deviceId", "publicKeyHex"}) {
    auto missing = valid;
    missing.erase(field);
    invalid.push_back(missing.dump());
    auto wrongType = valid;
    wrongType[field] = false;
    invalid.push_back(wrongType.dump());
  }
  for (const auto& changed : {
           Json{{"format", "monky"}}, Json{{"version", 2}}, Json{{"version", 1.0}},
           Json{{"version", -1}}, Json{{"unexpected", "field"}},
           Json{{"deviceId", "00000000-0000-0000-0000-000000000000"}},
           Json{{"deviceId", "ffffffff-ffff-4fff-ffff-ffffffffffff"}},
           Json{{"deviceId", "FFFFFFFF-FFFF-4FFF-8FFF-FFFFFFFFFFFF"}},
           Json{{"publicKeyHex", std::string(88, 'z')}},
           Json{{"publicKeyHex", std::string(86, 'a')}},
           Json{{"deviceId", Json::object()}}, Json{{"deviceId", Json::array()}}}) {
    auto modified = valid;
    modified.update(changed);
    invalid.push_back(modified.dump());
  }
  for (const auto& contents : invalid) {
    writeFile(metadataPath, contents);
    requireFailure([&] { ProfileIdentity identity(profile.path); },
                   "Malformed metadata was accepted or silently replaced");
    require(readFile(metadataPath) == contents, "Failed open modified malformed metadata");
    require(storedPublicKey(profile.path) == publicKey, "Malformed metadata changed its seed");
  }
  writeFile(metadataPath, "{\"not-json\": \"test-only-sensitive-marker");
  bool failed = false;
  try {
    ProfileIdentity identity(profile.path);
  } catch (const std::exception& error) {
    failed = true;
    require(std::string(error.what()).find("test-only-sensitive-marker") == std::string::npos,
            "Malformed metadata error echoed file contents");
  }
  require(failed, "Unterminated metadata string was accepted");
  writeFile(metadataPath, validBytes);
  ProfileIdentity reopened(profile.path);
  require(reopened.publicKeyHex() == publicKey, "Failed profile opens leaked the storage lock");
}

void inconsistentProfiles(const fs::path& root) {
  DisposableProfile profile(root);
  std::string publicKey;
  {
    ProfileIdentity identity(profile.path);
    publicKey = identity.publicKeyHex();
  }
  const auto metadataPath = profile.path / "monky-light.json";
  const auto valid = readFile(metadataPath);
  require(fs::remove(metadataPath), "Remove exact disposable metadata");
  requireFailure([&] { ProfileIdentity identity(profile.path); },
                 "Seed without metadata silently acquired a new device ID");
  require(!fs::exists(metadataPath) && storedPublicKey(profile.path) == publicKey,
          "Missing-metadata failure changed profile state");
  writeFile(metadataPath, valid);

  DisposableProfile other(root);
  {
    ProfileIdentity otherIdentity(other.path);
    auto mismatch = Json::parse(valid);
    mismatch["publicKeyHex"] = otherIdentity.publicKeyHex();
    writeFile(metadataPath, mismatch.dump());
  }
  const auto mismatchBytes = readFile(metadataPath);
  requireFailure([&] { ProfileIdentity identity(profile.path); },
                 "Metadata with another profile's public key was accepted");
  require(readFile(metadataPath) == mismatchBytes && storedPublicKey(profile.path) == publicKey,
          "Fingerprint mismatch modified the identity");
  writeFile(metadataPath, valid);

  profile.eraseSeed();
  requireFailure([&] { ProfileIdentity identity(profile.path); },
                 "Metadata without a seed silently acquired a replacement identity");
  require(!storedPublicKey(profile.path) && readFile(metadataPath) == valid,
          "Missing-seed failure changed profile state");
}

void pendingMarkers(const fs::path& root) {
  DisposableProfile profile(root);
  const auto pending = profile.path / "monky-light.json.pending";
  for (const std::string marker : {"", "interrupted-before-seed"}) {
    writeFile(pending, marker);
    requireFailure([&] { ProfileIdentity identity(profile.path); },
                   "An interrupted fresh profile was silently initialized");
    require(readFile(pending) == marker &&
            !fs::exists(profile.path / "monky-light.json") && !storedPublicKey(profile.path),
            "Fresh pending marker was overwritten or generated a seed");
  }
  require(fs::remove(pending), "Remove exact disposable pending marker");
  {
    ProfileIdentity identity(profile.path);
  }
  const auto metadata = readFile(profile.path / "monky-light.json");
  const auto publicKey = storedPublicKey(profile.path);
  writeFile(pending, "interrupted-after-seed");
  requireFailure([&] { ProfileIdentity identity(profile.path); },
                 "Existing profile's pending marker was ignored");
  require(readFile(pending) == "interrupted-after-seed" &&
          readFile(profile.path / "monky-light.json") == metadata &&
          storedPublicKey(profile.path) == publicKey, "Pending marker failure modified state");
}

void unrelatedAndInvalidPaths(const fs::path& root) {
  requireFailure([] { ProfileIdentity identity(fs::path{}); }, "Empty profile path was accepted");
  requireFailure([] { ProfileIdentity identity(fs::path{"relative-profile"}); },
                 "Relative profile path was accepted");
  DisposableProfile profile(root);
  writeFile(profile.path / "unrelated.txt", "unrelated-owned-test-content");
  requireFailure([&] { ProfileIdentity identity(profile.path); },
                 "Unrelated nonempty directory was accepted");
  require(!fs::exists(profile.path / ".identity.lock") &&
          !fs::exists(profile.path / "monky-light.json") &&
          readFile(profile.path / "unrelated.txt") == "unrelated-owned-test-content",
          "Refusing unrelated state mutated the directory");
  requireFailure([&] { ProfileIdentity identity(profile.path / "unrelated.txt"); },
                 "Regular file was accepted as a profile directory");
  requireFailure([&] { ProfileIdentity identity(profile.path / "missing-parent" / "profile"); },
                 "Missing profile ancestors were silently created");
  require(!fs::exists(profile.path / "missing-parent"), "Created an unrequested ancestor");
  require(fs::remove(profile.path / "unrelated.txt"), "Remove exact unrelated test file");
  require(fs::create_directory(profile.path / "unrelated-directory"), "Create unrelated directory");
  requireFailure([&] { ProfileIdentity identity(profile.path); },
                 "Unrelated subdirectory was accepted as profile state");
  require(!fs::exists(profile.path / ".identity.lock"),
          "Refusing unrelated subdirectory created a lock");
}

void settingsBesideIdentity(const fs::path& root) {
  DisposableProfile profile(root);
  const auto settingsPath = profile.path / "monky-light-settings.json";
  std::string publicKey;
  {
    ProfileIdentity identity(profile.path);
    publicKey = identity.publicKeyHex();
    const auto defaults = identity.loadSettings();
    require(!defaults.inputDeviceId && !defaults.outputDeviceId, "Missing settings did not yield defaults");
    identity.saveSettings({std::string("input-\xc3\xa1"), std::nullopt});
    identity.saveSettings({std::string("input-\xc3\xa1"), std::string("output")});
    require(!fs::exists(profile.path / "monky-light-settings.json.pending"), "Settings write left its marker");
    requireFailure([&] { identity.saveSettings({std::string(), std::nullopt}); },
                   "An empty device ID was saved");
    requireFailure([&] { identity.saveSettings({std::string(1025, 'a'), std::nullopt}); },
                   "An unbounded device ID was saved");
    requireFailure([&] { identity.saveSettings({std::string("\xff"), std::nullopt}); },
                   "An invalid UTF-8 device ID was saved");
  }
  const auto saved = readFile(settingsPath);
  // An interrupted settings write is not identity state and must not block the profile.
  writeFile(profile.path / "monky-light-settings.json.pending", "interrupted");
  {
    ProfileIdentity identity(profile.path);
    require(identity.publicKeyHex() == publicKey, "Settings changed the profile identity");
    const auto loaded = identity.loadSettings();
    require(loaded.inputDeviceId == std::optional<std::string>("input-\xc3\xa1") &&
            loaded.outputDeviceId == std::optional<std::string>("output"), "Settings did not round-trip");
    identity.saveSettings({std::nullopt, std::string("output")});
    require(!fs::exists(profile.path / "monky-light-settings.json.pending"),
            "Settings write did not replace an interrupted marker");
  }
  for (const auto* invalid : {"", "{", "[]", "{\"format\":\"monky-light-settings\",\"version\":2}",
                              "{\"format\":\"other\",\"version\":1}",
                              "{\"format\":\"monky-light-settings\",\"version\":1,\"inputDeviceId\":7}",
                              "{\"format\":\"monky-light-settings\",\"version\":1,\"inputDeviceId\":{}}"}) {
    writeFile(settingsPath, invalid);
    ProfileIdentity identity(profile.path);
    require(identity.publicKeyHex() == publicKey, "Invalid settings affected identity validation");
    requireFailure([&] { static_cast<void>(identity.loadSettings()); }, "Invalid settings were accepted");
    identity.saveSettings({});
    const auto replaced = identity.loadSettings();
    require(!replaced.inputDeviceId && !replaced.outputDeviceId, "Saving did not replace invalid settings");
  }
  require(saved.find("monky-light-settings") != std::string::npos, "Settings were written without their format");
}

void nonOrdinaryAndUnreadable(const fs::path& root) {
  DisposableProfile profile(root);
  {
    ProfileIdentity identity(profile.path);
  }
  const auto metadataPath = profile.path / "monky-light.json";
  const auto original = readFile(metadataPath);
#ifdef _WIN32
  {
    struct ExclusiveFile {
      HANDLE value;
      ~ExclusiveFile() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); }
    } file{CreateFileW(metadataPath.c_str(), GENERIC_READ, 0, nullptr, OPEN_EXISTING,
                      FILE_ATTRIBUTE_NORMAL, nullptr)};
    require(file.value != INVALID_HANDLE_VALUE, "Exclusively open disposable metadata");
    requireFailure([&] { ProfileIdentity identity(profile.path); },
                   "Unreadable metadata was treated as missing");
  }
#endif
  require(fs::remove(metadataPath), "Remove disposable metadata for invalid-entry test");
  require(fs::create_directory(metadataPath), "Create invalid metadata directory");
  requireFailure([&] { ProfileIdentity identity(profile.path); },
                 "A directory was accepted as public profile metadata");
  require(fs::remove(metadataPath), "Remove exact invalid metadata directory");
  DisposableProfile external(root);
  writeFile(external.path / "unrelated.txt", original);
  fs::create_hard_link(external.path / "unrelated.txt", metadataPath);
  requireFailure([&] { ProfileIdentity identity(profile.path); },
                 "A hard-linked metadata file was accepted");
  require(readFile(external.path / "unrelated.txt") == original,
          "Refusing a metadata hard link modified its other owned link");
  require(fs::remove(metadataPath), "Remove exact disposable metadata hard link");
  writeFile(metadataPath, original);
  ProfileIdentity reopened(profile.path);
}

#ifdef __APPLE__
void movedMacosProfile(const fs::path& root) {
  for (const bool interrupted : {false, true}) {
    DisposableProfile profile(root);
    {
      ProfileIdentity identity(profile.path);
    }
    const auto original = readFile(profile.path / "monky-light.json");
    if (interrupted) {
      require(fs::remove(profile.path / "monky-light.json"), "Remove exact test metadata");
      writeFile(profile.path / "monky-light.json.pending", "");
    }
    const auto moved = root / ("profile-identity-test-" + monky::light::randomUuid());
    // Only move the disposable directory into a previously absent random test name.
    require(!fs::exists(moved), "Moved disposable path already exists");
    fs::rename(profile.path, moved);
    profile.path = moved;
    profile.accounts.push_back(accountFor(moved));
    requireFailure([&] { ProfileIdentity identity(moved); },
                   "Moving a macOS profile silently generated a replacement identity");
    require(!storedPublicKey(moved), "Moved-profile failure generated a seed");
    if (interrupted) {
      require(!fs::exists(moved / "monky-light.json") &&
              readFile(moved / "monky-light.json.pending").empty(),
              "Moving an interrupted profile recreated public metadata");
    } else {
      require(readFile(moved / "monky-light.json") == original,
              "Moved-profile failure changed public metadata");
    }
  }
}
#endif

}  // namespace

int main(int argc, char** argv) {
  try {
    require(argc == 2, "Usage: profile_identity_test <existing-disposable-build-parent>");
    const auto root = fs::canonical(fs::path(argv[1]));
    require(fs::is_directory(root), "Disposable build parent is not a directory");
    roundTrip(root);
    malformedMetadata(root);
    inconsistentProfiles(root);
    pendingMarkers(root);
    unrelatedAndInvalidPaths(root);
    settingsBesideIdentity(root);
    nonOrdinaryAndUnreadable(root);
#ifdef __APPLE__
    movedMacosProfile(root);
#endif
    require(cleanupFailures == 0, "Disposable profile cleanup failed");
    std::cout << "Profile identity scenarios passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "Profile identity scenario failed: " << error.what() << '\n';
    return 1;
  }
}
