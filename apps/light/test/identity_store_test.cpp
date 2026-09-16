#include "platform/identity_store.hpp"

#include <algorithm>
#include <chrono>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <initializer_list>
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

void requireKeychain(OSStatus status, const char* operation) {
  if (status != errSecSuccess) {
    throw std::runtime_error(std::string(operation) + " (Keychain OSStatus " +
                             std::to_string(status) + ")");
  }
}

void checkKeychainCleanup(OSStatus status, const char* operation) {
  if (status != errSecSuccess) {
    ++cleanupFailures;
    std::cerr << operation << ": " << status << '\n';
  }
}

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
class KeychainInteractionGuard final {
 public:
  KeychainInteractionGuard() {
    requireKeychain(SecKeychainGetUserInteractionAllowed(&previous_), "Read Keychain interaction policy");
    requireKeychain(SecKeychainSetUserInteractionAllowed(false), "Disable UI in Keychain scenarios");
  }
  ~KeychainInteractionGuard() {
    checkKeychainCleanup(SecKeychainSetUserInteractionAllowed(previous_), "Restore Keychain interaction policy");
  }
  KeychainInteractionGuard(const KeychainInteractionGuard&) = delete;
  KeychainInteractionGuard& operator=(const KeychainInteractionGuard&) = delete;
 private:
  Boolean previous_ = true;
};

class KeychainSettingsGuard final {
 public:
  KeychainSettingsGuard() {
    requireKeychain(SecKeychainCopyDefault(&default_), "Save test's default Keychain");
    const OSStatus status = SecKeychainCopySearchList(&searchList_);
    if (status != errSecSuccess) {
      CFRelease(default_);
      requireKeychain(status, "Save test's Keychain search list");
    }
  }
  ~KeychainSettingsGuard() {
    checkKeychainCleanup(SecKeychainSetSearchList(searchList_), "Restore Keychain search list");
    checkKeychainCleanup(SecKeychainSetDefault(default_), "Restore default Keychain");
    CFRelease(searchList_);
    CFRelease(default_);
  }
  KeychainSettingsGuard(const KeychainSettingsGuard&) = delete;
  KeychainSettingsGuard& operator=(const KeychainSettingsGuard&) = delete;

  void select(SecKeychainRef keychain) {
    requireKeychain(SecKeychainSetDefault(keychain), "Select disposable default Keychain");
  }

  void search(std::initializer_list<SecKeychainRef> keychains) {
    CFMutableArrayRef list = CFArrayCreateMutable(
        kCFAllocatorDefault, 0, &kCFTypeArrayCallBacks);
    require(list != nullptr, "Allocate disposable Keychain search list");
    for (const auto keychain : keychains) CFArrayAppendValue(list, keychain);
    const OSStatus status = SecKeychainSetSearchList(list);
    CFRelease(list);
    requireKeychain(status, "Set disposable Keychain search list");
  }

 private:
  SecKeychainRef default_ = nullptr;
  CFArrayRef searchList_ = nullptr;
};

class DisposableKeychain final {
 public:
  explicit DisposableKeychain(const fs::path& root) {
    static unsigned sequence = 0;
    const auto stamp = std::chrono::steady_clock::now().time_since_epoch().count();
    const auto path = root / ("identity-keychain-test-" + std::to_string(getpid()) + "-" +
                              std::to_string(stamp) + "-" +
                              std::to_string(sequence++) + ".keychain-db");
    requireKeychain(SecKeychainCreate(path.c_str(), sizeof(kPassword) - 1, kPassword,
                                      false, nullptr, &keychain_),
                    "Create exclusive disposable Keychain");
  }
  ~DisposableKeychain() {
    checkKeychainCleanup(SecKeychainDelete(keychain_), "Delete disposable Keychain");
    CFRelease(keychain_);
  }
  DisposableKeychain(const DisposableKeychain&) = delete;
  DisposableKeychain& operator=(const DisposableKeychain&) = delete;
  SecKeychainRef get() const { return keychain_; }

  void unlock() {
    requireKeychain(SecKeychainUnlock(keychain_, sizeof(kPassword) - 1, kPassword, true),
                    "Unlock disposable Keychain");
  }
  void lock() {
    requireKeychain(SecKeychainLock(keychain_), "Lock disposable Keychain");
    SecKeychainStatus status = 0;
    requireKeychain(SecKeychainGetStatus(keychain_, &status), "Inspect disposable Keychain");
    require((status & kSecUnlockStateStatus) == 0, "Disposable Keychain did not lock");
  }

 private:
  static constexpr char kPassword[] = "monky-light-disposable-keychain-test";
  SecKeychainRef keychain_ = nullptr;
};

class TestKeychainQuery final {
 public:
  explicit TestKeychainQuery(const fs::path& profile, SecKeychainRef keychain = nullptr) {
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
    if (keychain) {
      keychain_ = keychain;
      CFRetain(keychain_);
    } else {
      const OSStatus status = SecKeychainCopyDefault(&keychain_);
      if (status != errSecSuccess) {
        release();
        requireKeychain(status, "Open default test Keychain");
      }
    }
    const void* selected = keychain_;
    CFArrayRef searchList = CFArrayCreate(
        kCFAllocatorDefault, &selected, 1, &kCFTypeArrayCallBacks);
    if (!searchList) {
      release();
      throw std::runtime_error("Allocate scoped test Keychain query");
    }
    CFDictionarySetValue(query_, kSecClass, kSecClassGenericPassword);
    CFDictionarySetValue(query_, kSecAttrService, service_);
    CFDictionarySetValue(query_, kSecAttrAccount, account_);
    CFDictionarySetValue(query_, kSecMatchSearchList, searchList);
    CFRelease(searchList);
    CFDictionarySetValue(query_, kSecUseAuthenticationUI, kSecUseAuthenticationUIFail);
  }
  ~TestKeychainQuery() { release(); }
  TestKeychainQuery(const TestKeychainQuery&) = delete;
  TestKeychainQuery& operator=(const TestKeychainQuery&) = delete;
  CFMutableDictionaryRef get() const { return query_; }

  OSStatus add(const UInt8* bytes, CFIndex length) const {
    CFDataRef data = CFDataCreate(kCFAllocatorDefault, bytes, length);
    CFMutableDictionaryRef creation = CFDictionaryCreateMutableCopy(
        kCFAllocatorDefault, 0, query_);
    if (!data || !creation) {
      if (data) CFRelease(data);
      if (creation) CFRelease(creation);
      throw std::runtime_error("Allocate exact test Keychain entry");
    }
    CFDictionaryRemoveValue(creation, kSecMatchSearchList);
    CFDictionarySetValue(creation, kSecUseKeychain, keychain_);
    CFDictionarySetValue(creation, kSecValueData, data);
    const OSStatus status = SecItemAdd(creation, nullptr);
    CFRelease(creation);
    CFRelease(data);
    return status;
  }

 private:
  void release() {
    if (query_) CFRelease(query_);
    if (service_) CFRelease(service_);
    if (account_) CFRelease(account_);
    if (keychain_) CFRelease(keychain_);
  }
  CFStringRef account_ = nullptr;
  CFStringRef service_ = nullptr;
  CFMutableDictionaryRef query_ = nullptr;
  SecKeychainRef keychain_ = nullptr;
};
#pragma clang diagnostic pop
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
void macosKeychainIsolation(const fs::path& root) {
  // Only disposable stores are locked; restore the user's settings on every exit.
  KeychainSettingsGuard settings;
  std::cerr << "Keychain fixture: creating isolated stores\n";
  DisposableKeychain selected(root);
  DisposableKeychain unrelated(root);
  selected.unlock();
  unrelated.unlock();
  settings.select(selected.get());
  settings.search({unrelated.get(), selected.get()});
  DisposableProfile profile(root);
  DisposableProfile emptyProfile(root);
  const auto seed = testSeed();
  auto otherSeed = seed;
  otherSeed[0] ^= 0xff;
  TestKeychainQuery otherEntry(profile.path, unrelated.get());
  requireKeychain(otherEntry.add(otherSeed.data(), static_cast<CFIndex>(otherSeed.size())),
                  "Create same-account entry in unrelated Keychain");
  unrelated.lock();
  std::cerr << "Keychain fixture: unrelated locked store\n";

  {
    IdentityStore store(profile.path);
    IdentityStore empty(emptyProfile.path);
    require(!store.load(), "Identity lookup escaped the selected Keychain");
    require(!empty.load(), "Unrelated locked Keychain hid a missing identity");
    store.save(seed);
    require(store.load() == seed, "Unrelated locked Keychain prevented identity persistence");
    requireFailure([&] { store.save(otherSeed); }, "Scoped duplicate save was accepted");

    selected.lock();
    std::cerr << "Keychain fixture: selected locked store\n";
    requireFailure([&] { (void)store.load(); }, "Locked identity was treated as readable/absent");
    requireFailure([&] { (void)empty.load(); }, "Locked empty Keychain was treated as absence");
    requireFailure([&] { store.save(otherSeed); }, "Locked identity was replaced");
    requireFailure([&] { empty.save(otherSeed); }, "Locked Keychain accepted a new identity");
    selected.unlock();
    require(store.load() == seed, "A locked-store failure changed the identity");
    require(!empty.load(), "A locked-store failure created an identity");

    {
      std::cerr << "Keychain fixture: switching default while stores remain open\n";
      KeychainSettingsGuard changedDefault;
      changedDefault.select(unrelated.get());
      changedDefault.search({unrelated.get()});
      require(store.load() == seed, "An open identity store followed a changed default");
      require(!empty.load(), "An open empty store followed a changed default");
      empty.save(otherSeed);
      require(empty.load() == otherSeed, "save did not use the store's selected Keychain");
    }
  }
  {
    IdentityStore reopened(profile.path);
    IdentityStore reopenedEmpty(emptyProfile.path);
    require(reopened.load() == seed && reopenedEmpty.load() == otherSeed,
            "Scoped identities did not persist in the selected default Keychain");
  }
  unrelated.unlock();
  std::cerr << "Keychain fixture: checking the untouched second store\n";
  {
    KeychainSettingsGuard otherDefault;
    otherDefault.select(unrelated.get());
    IdentityStore untouched(profile.path);
    IdentityStore unwritten(emptyProfile.path);
    require(untouched.load() == otherSeed, "Operations changed an unrelated Keychain entry");
    require(!unwritten.load(), "save also wrote to the changed default Keychain");
  }
}

void macosFailures(const fs::path& root) {
  for (const CFIndex length : {0, 31, 33}) {
    DisposableProfile profile(root);
    IdentityStore store(profile.path);
    TestKeychainQuery query(profile.path);
    const std::vector<UInt8> invalid(static_cast<std::size_t>(length), 0x5a);
    requireKeychain(query.add(invalid.data(), length), "Create exact malformed test Keychain entry");
    requireFailure([&] { (void)store.load(); }, "Malformed Keychain seed was accepted");
    requireFailure([&] { store.save(testSeed()); }, "Malformed Keychain seed was replaced");
    requireFailure([&] { (void)store.load(); }, "Failed save changed the malformed seed");
  }
}
#endif

}  // namespace

int main(int argc, char** argv) {
  try {
    require(argc <= 2, "Usage: identity_store_test [existing-disposable-parent-directory]");
    const auto root = fs::canonical(argc == 2 ? fs::path{argv[1]} : fs::current_path());
    require(fs::is_directory(root), "Test artifact parent must be a directory");
#ifdef __APPLE__
    KeychainInteractionGuard interaction;
#endif
    std::cerr << "Identity fixture: round-trip and profile lock\n";
    roundTripAndLock(root);
    std::cerr << "Identity fixture: invalid profiles\n";
    invalidProfiles(root);
#ifdef _WIN32
    windowsFailures(root);
#else
    macosKeychainIsolation(root);
    std::cerr << "Identity fixture: malformed key data\n";
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
