#include "platform/identity_store.hpp"

#include <algorithm>
#include <chrono>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <stdexcept>
#include <string>
#include <type_traits>
#include <vector>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <wincrypt.h>
#elif defined(__APPLE__)
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <fcntl.h>
#include <limits.h>
#include <unistd.h>
#else
#error Identity storage tests require Windows or macOS
#endif

namespace {

using monky::light::IdentitySeed;
using monky::light::IdentityStore;
namespace fs = std::filesystem;

static_assert(!std::is_copy_constructible_v<IdentityStore>);
static_assert(!std::is_move_constructible_v<IdentityStore>);
static_assert(sizeof(IdentitySeed) == 32);

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

#ifdef __APPLE__
constexpr char kTestService[] = "org.monky.light.identity.ed25519-seed.v1";

class TestKeychainQuery final {
 public:
  explicit TestKeychainQuery(const fs::path& profile) {
    const int directory = open(profile.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    require(directory != -1, "Open test profile for Keychain cleanup");
    char path[PATH_MAX]{};
    const int result = fcntl(directory, F_GETPATH, path);
    const int closed = close(directory);
    require(result != -1 && closed == 0, "Resolve test Keychain account");
    account_ = CFStringCreateWithBytes(kCFAllocatorDefault,
        reinterpret_cast<const UInt8*>(path), static_cast<CFIndex>(std::strlen(path)),
        kCFStringEncodingUTF8, false);
    service_ = CFStringCreateWithCString(kCFAllocatorDefault, kTestService,
                                        kCFStringEncodingUTF8);
    query_ = CFDictionaryCreateMutable(kCFAllocatorDefault, 0,
        &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    if (!account_ || !service_ || !query_) {
      release();
      throw std::runtime_error("Allocate exact test Keychain query");
    }
    CFDictionarySetValue(query_, kSecClass, kSecClassGenericPassword);
    CFDictionarySetValue(query_, kSecAttrService, service_);
    CFDictionarySetValue(query_, kSecAttrAccount, account_);
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    CFDictionarySetValue(query_, kSecUseAuthenticationUI, kSecUseAuthenticationUIFail);
#pragma clang diagnostic pop
  }
  ~TestKeychainQuery() { release(); }
  TestKeychainQuery(const TestKeychainQuery&) = delete;
  TestKeychainQuery& operator=(const TestKeychainQuery&) = delete;
  CFMutableDictionaryRef get() const { return query_; }

 private:
  void release() {
    if (query_) CFRelease(query_);
    if (service_) CFRelease(service_);
    if (account_) CFRelease(account_);
  }
  CFStringRef account_ = nullptr;
  CFStringRef service_ = nullptr;
  CFMutableDictionaryRef query_ = nullptr;
};
#endif

class DisposableProfile final {
 public:
  explicit DisposableProfile(const fs::path& root) {
    const auto stamp = std::chrono::steady_clock::now().time_since_epoch().count();
#ifdef _WIN32
    const auto pid = GetCurrentProcessId();
#else
    const auto pid = getpid();
#endif
    static unsigned sequence = 0;
    path = root / ("identity-store-test-" + std::to_string(pid) + "-" +
                   std::to_string(stamp) + "-" + std::to_string(sequence++));
    require(fs::create_directory(path), "Create exclusive disposable test profile");
  }

  ~DisposableProfile() {
#ifdef __APPLE__
    try {
      TestKeychainQuery query(path);
      const OSStatus status = SecItemDelete(query.get());
      if (status != errSecSuccess && status != errSecItemNotFound) {
        ++cleanupFailures;
        std::cerr << "Exact test Keychain cleanup failed: " << status << '\n';
      }
    } catch (const std::exception& error) {
      ++cleanupFailures;
      std::cerr << "Test Keychain cleanup failed: " << error.what() << '\n';
    }
#endif
    // No recursive removal: delete only the names these tests/component own.
    for (const auto* name : {"identity.dpapi", "identity.dpapi.pending", ".identity.lock"}) {
      removeOwned(path / name);
    }
    removeOwned(path);
  }
  DisposableProfile(const DisposableProfile&) = delete;
  DisposableProfile& operator=(const DisposableProfile&) = delete;
  fs::path path;

 private:
  static void removeOwned(const fs::path& owned) {
    std::error_code error;
    fs::remove(owned, error);
    if (error) {
      ++cleanupFailures;
      std::cerr << "Disposable profile cleanup failed: " << error.message() << '\n';
    }
  }
};

IdentitySeed testSeed() {
  IdentitySeed seed{};
  for (std::size_t i = 0; i < seed.size(); ++i) {
    seed[i] = static_cast<std::uint8_t>(i + 1);
  }
  return seed;
}

void roundTripAndLock(const fs::path& root) {
  DisposableProfile profile(root);
  const auto seed = testSeed();
  auto otherSeed = seed;
  otherSeed[0] ^= 0xff;
  {
    IdentityStore store(profile.path);
    require(!store.load(), "A newly created profile must have no identity");
    requireFailure([&] { IdentityStore second(profile.path); },
                   "Two owners acquired the same profile");
    requireFailure([&] { IdentityStore alias(profile.path / "."); },
                   "A canonical path alias bypassed the profile lock");
    store.save(seed);
    require(seed == testSeed(), "save changed its caller's seed");
    require(store.load() == seed, "Saved seed did not round-trip");
    requireFailure([&] { store.save(otherSeed); }, "Duplicate save was accepted");
    require(store.load() == seed, "Duplicate save changed the stored identity");
  }
  {
    IdentityStore reopened(profile.path);
    require(reopened.load() == seed, "Seed did not persist after releasing the owner");
  }
  {
    DisposableProfile independent(root);
    IdentityStore first(profile.path);
    IdentityStore second(independent.path);
    require(!second.load(), "Different profiles shared an identity");
    second.save(otherSeed);
    require(first.load() == seed && second.load() == otherSeed,
            "Independent profile identities interfered");
  }
}

void invalidProfiles(const fs::path& root) {
  requireFailure([] { IdentityStore store(fs::path{}); }, "Empty profile was accepted");
  requireFailure([] { IdentityStore store(fs::path{"relative-profile"}); },
                 "Relative profile was accepted");
  DisposableProfile profile(root);
  requireFailure([&] { IdentityStore store(profile.path / "does-not-exist"); },
                 "Missing profile directory was accepted");
  require(fs::create_directory(profile.path / ".identity.lock"), "Create invalid lock");
  requireFailure([&] { IdentityStore store(profile.path); },
                 "Directory was accepted as a profile lock");
  require(fs::remove(profile.path / ".identity.lock"), "Remove invalid lock");
  IdentityStore recovered(profile.path);
  require(!recovered.load(), "Failed construction leaked the profile lock");
}

#ifdef _WIN32
void writeBytes(const fs::path& path, const std::vector<std::uint8_t>& bytes) {
  std::ofstream output(path, std::ios::binary | std::ios::trunc);
  output.exceptions(std::ios::failbit | std::ios::badbit);
  if (!bytes.empty()) {
    output.write(reinterpret_cast<const char*>(bytes.data()),
                 static_cast<std::streamsize>(bytes.size()));
  }
  output.close();
}

std::vector<std::uint8_t> readBytes(const fs::path& path) {
  std::ifstream input(path, std::ios::binary);
  require(input.is_open(), "Open disposable protected identity");
  std::vector<std::uint8_t> bytes(std::istreambuf_iterator<char>{input},
                                  std::istreambuf_iterator<char>{});
  require(!input.bad(), "Read disposable protected identity");
  return bytes;
}

std::vector<std::uint8_t> protectWrongLength(DWORD length) {
  std::vector<BYTE> fakeSeed(length, 0x5a);
  DATA_BLOB input{length, fakeSeed.data()};
  struct ProtectedBlob {
    DATA_BLOB data{};
    ~ProtectedBlob() {
      if (data.pbData) LocalFree(data.pbData);
    }
  } encrypted;
  const BOOL success = CryptProtectData(&input, nullptr, nullptr, nullptr, nullptr,
      CRYPTPROTECT_UI_FORBIDDEN, &encrypted.data);
  SecureZeroMemory(fakeSeed.data(), fakeSeed.size());
  require(success != FALSE, "Protect malformed-length test seed");
  std::vector<std::uint8_t> framed(8 + encrypted.data.cbData);
  const char magic[] = "MLI1";
  std::memcpy(framed.data(), magic, 4);
  std::memcpy(framed.data() + 4, &encrypted.data.cbData, 4);
  std::memcpy(framed.data() + 8, encrypted.data.pbData, encrypted.data.cbData);
  return framed;
}

void windowsFailures(const fs::path& root) {
  DisposableProfile profile(root);
  IdentityStore store(profile.path);
  const auto identity = profile.path / "identity.dpapi";
  const auto pending = profile.path / "identity.dpapi.pending";
  const auto seed = testSeed();
  store.save(seed);
  const auto valid = readBytes(identity);
  require(std::search(valid.begin(), valid.end(), seed.begin(), seed.end()) == valid.end(),
          "Protected file contains the plaintext test seed");
  auto corrupted = valid;
  corrupted.back() ^= 0x80;
  auto truncated = valid;
  truncated.pop_back();
  auto trailing = valid;
  trailing.push_back(0);
  for (const auto& bytes : {std::vector<std::uint8_t>{},
                           std::vector<std::uint8_t>{1, 2, 3},
                           std::vector<std::uint8_t>(16 * 1024 + 1, 0),
                           corrupted, truncated, trailing,
                           protectWrongLength(31), protectWrongLength(33)}) {
    writeBytes(identity, bytes);
    requireFailure([&] { (void)store.load(); }, "Invalid identity was treated as usable/absent");
    requireFailure([&] { store.save(seed); }, "save replaced an invalid identity");
    require(readBytes(identity) == bytes, "A failed operation modified invalid identity data");
  }
  writeBytes(identity, valid);
  {
    struct ExclusiveFile {
      HANDLE value;
      ~ExclusiveFile() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); }
    } unreadable{CreateFileW(identity.c_str(), GENERIC_READ, 0, nullptr,
                            OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr)};
    require(unreadable.value != INVALID_HANDLE_VALUE, "Open identity exclusively for test");
    requireFailure([&] { (void)store.load(); }, "Unreadable identity was treated as absent");
  }
  require(store.load() == seed, "Read failure changed the identity");
  writeBytes(pending, {1, 2, 3});
  requireFailure([&] { (void)store.load(); }, "Pending save alongside identity was ignored");
  requireFailure([&] { store.save(seed); }, "Pending save was overwritten");
  require(fs::remove(identity), "Remove owned identity to simulate interrupted save");
  requireFailure([&] { (void)store.load(); }, "Interrupted first save was treated as absence");
  requireFailure([&] { store.save(seed); }, "Interrupted first save was replaced");
  require(fs::remove(pending), "Remove owned interrupted-save marker");
  require(fs::create_directory(identity), "Create invalid identity directory");
  requireFailure([&] { (void)store.load(); }, "Identity directory was treated as absence");
  requireFailure([&] { store.save(seed); }, "Identity directory was overwritten");
}
#else
void macosFailures(const fs::path& root) {
  for (const CFIndex length : {0, 31, 33}) {
    DisposableProfile profile(root);
    IdentityStore store(profile.path);
    TestKeychainQuery query(profile.path);
    const std::vector<UInt8> invalid(static_cast<std::size_t>(length), 0x5a);
    CFDataRef data = CFDataCreate(kCFAllocatorDefault, invalid.data(), length);
    require(data != nullptr, "Allocate malformed test seed");
    CFDictionarySetValue(query.get(), kSecValueData, data);
    CFRelease(data);
    const OSStatus status = SecItemAdd(query.get(), nullptr);
    require(status == errSecSuccess, "Create exact malformed test Keychain entry");
    requireFailure([&] { (void)store.load(); }, "Malformed Keychain seed was accepted");
    requireFailure([&] { store.save(testSeed()); }, "Malformed Keychain seed was replaced");
  }
}
#endif

}  // namespace

int main(int argc, char** argv) {
  try {
    require(argc <= 2, "Usage: identity_store_test [existing-disposable-parent-directory]");
    const auto root = fs::canonical(argc == 2 ? fs::path{argv[1]} : fs::current_path());
    require(fs::is_directory(root), "Test artifact parent must be a directory");
    roundTripAndLock(root);
    invalidProfiles(root);
#ifdef _WIN32
    windowsFailures(root);
#else
    macosFailures(root);
#endif
    require(cleanupFailures == 0, "Disposable test cleanup failed");
    std::cout << "Identity storage tests passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "Identity storage test failed: " << error.what() << '\n';
    return 1;
  }
}
