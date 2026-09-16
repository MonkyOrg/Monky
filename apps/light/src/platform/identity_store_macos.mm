#include "identity_store.hpp"

#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <fcntl.h>
#include <limits.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cerrno>
#include <cstring>
#include <stdexcept>
#include <string>
#include <system_error>

namespace monky::light {
namespace {

constexpr char kLockFile[] = ".identity.lock";
constexpr char kService[] = "org.monky.light.identity.ed25519-seed.v1";

[[noreturn]] void failPosix(const char* operation) {
  throw std::system_error(errno, std::generic_category(), operation);
}

[[noreturn]] void failKeychain(const char* operation, OSStatus status) {
  throw std::runtime_error(std::string(operation) + " (Keychain OSStatus " +
                           std::to_string(status) + ")");
}

template <typename T>
class CfOwner final {
 public:
  explicit CfOwner(T value) : value_(value) {
    if (!value_) throw std::runtime_error("Unable to allocate Keychain query");
  }
  ~CfOwner() { if (value_) CFRelease(value_); }
  CfOwner(const CfOwner&) = delete;
  CfOwner& operator=(const CfOwner&) = delete;
  T get() const { return value_; }
  T release() {
    const T result = value_;
    value_ = nullptr;
    return result;
  }

 private:
  T value_;
};

class FileDescriptor final {
 public:
  explicit FileDescriptor(int value) : value_(value) {
    if (value_ == -1) failPosix("Open identity profile or lock file");
  }
  ~FileDescriptor() { close(value_); }
  FileDescriptor(const FileDescriptor&) = delete;
  FileDescriptor& operator=(const FileDescriptor&) = delete;
  int get() const { return value_; }

 private:
  int value_;
};

struct TemporarySeed final {
  IdentitySeed value{};
  ~TemporarySeed() {
    volatile std::uint8_t* bytes = value.data();
    for (std::size_t i = 0; i < value.size(); ++i) bytes[i] = 0;
  }
};

std::filesystem::path canonicalProfile(const std::filesystem::path& profile) {
  if (!profile.is_absolute() ||
      profile.native().find('\0') != std::string::npos) {
    throw std::invalid_argument("Identity profile must be an absolute directory path");
  }
  const auto canonical = std::filesystem::canonical(profile);
  if (!std::filesystem::is_directory(canonical)) {
    throw std::runtime_error("Identity profile is not a directory");
  }
  return canonical;
}

CFStringRef profileAccount(int directory) {
  // F_GETPATH uses the filesystem's spelling, also on case-insensitive volumes.
  char path[PATH_MAX]{};
  if (fcntl(directory, F_GETPATH, path) == -1) failPosix("Resolve identity profile account");
  return CFStringCreateWithBytes(kCFAllocatorDefault,
                                 reinterpret_cast<const UInt8*>(path),
                                 static_cast<CFIndex>(std::strlen(path)),
                                 kCFStringEncodingUTF8, false);
}

// The file-based Keychain is available to a headless CLI without app entitlements.
// Check only the selected store: unrelated search-list entries may be locked.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
void requireUsableKeychain(SecKeychainRef keychain, bool writing = false) {
  SecKeychainStatus keychainStatus = 0;
  const OSStatus result = SecKeychainGetStatus(keychain, &keychainStatus);
  if (result != errSecSuccess) failKeychain("Inspect selected identity Keychain", result);
  if ((keychainStatus & kSecUnlockStateStatus) == 0 ||
      (keychainStatus & kSecReadPermStatus) == 0) {
    throw std::runtime_error("Selected identity Keychain is locked or unreadable");
  }
  if (writing && (keychainStatus & kSecWritePermStatus) == 0) {
    throw std::runtime_error("Selected identity Keychain is not writable");
  }
}

SecKeychainRef defaultKeychain() {
  SecKeychainRef raw = nullptr;
  const OSStatus status = SecKeychainCopyDefault(&raw);
  if (status != errSecSuccess) failKeychain("Open default identity Keychain", status);
  CfOwner<SecKeychainRef> keychain(raw);
  return keychain.release();
}
#pragma clang diagnostic pop

// Keep UI suppression local to these queries, not a process-wide Keychain setting.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
CFMutableDictionaryRef identityQuery(CFStringRef account) {
  CfOwner<CFMutableDictionaryRef> query(CFDictionaryCreateMutable(
      kCFAllocatorDefault, 0, &kCFTypeDictionaryKeyCallBacks,
      &kCFTypeDictionaryValueCallBacks));
  CfOwner<CFStringRef> service(CFStringCreateWithCString(
      kCFAllocatorDefault, kService, kCFStringEncodingUTF8));
  CFDictionarySetValue(query.get(), kSecClass, kSecClassGenericPassword);
  CFDictionarySetValue(query.get(), kSecAttrService, service.get());
  CFDictionarySetValue(query.get(), kSecAttrAccount, account);
  CFDictionarySetValue(query.get(), kSecUseAuthenticationUI, kSecUseAuthenticationUIFail);
  return query.release();
}
#pragma clang diagnostic pop

CFArrayRef findIdentity(CFStringRef account, SecKeychainRef keychain) {
  requireUsableKeychain(keychain);
  const void* selected = keychain;
  CfOwner<CFArrayRef> searchList(CFArrayCreate(
      kCFAllocatorDefault, &selected, 1, &kCFTypeArrayCallBacks));
  CfOwner<CFMutableDictionaryRef> query(identityQuery(account));
  CFDictionarySetValue(query.get(), kSecMatchSearchList, searchList.get());
  CFDictionarySetValue(query.get(), kSecMatchLimit, kSecMatchLimitAll);
  // Count references before decrypting, so an inaccessible duplicate cannot be skipped.
  CFDictionarySetValue(query.get(), kSecReturnRef, kCFBooleanTrue);
  CFTypeRef raw = nullptr;
  const OSStatus status = SecItemCopyMatching(query.get(), &raw);
  if (status == errSecItemNotFound) {
    requireUsableKeychain(keychain);
    return nullptr;
  }
  if (status != errSecSuccess) failKeychain("Find identity without prompting", status);
  CfOwner<CFTypeRef> result(raw);
  if (CFGetTypeID(result.get()) != CFArrayGetTypeID()) {
    throw std::runtime_error("Keychain returned an unexpected identity result");
  }
  const auto matches = static_cast<CFArrayRef>(result.get());
  if (CFArrayGetCount(matches) != 1) {
    throw std::runtime_error("Keychain identity is ambiguous; expected exactly one entry");
  }
  return static_cast<CFArrayRef>(result.release());
}

std::optional<IdentitySeed> readSeed(CFStringRef account, SecKeychainRef keychain) {
  CFArrayRef found = findIdentity(account, keychain);
  if (!found) return std::nullopt;
  CfOwner<CFArrayRef> item(found);
  CfOwner<CFMutableDictionaryRef> query(identityQuery(account));
  CFDictionarySetValue(query.get(), kSecMatchItemList, item.get());
  CFDictionarySetValue(query.get(), kSecMatchLimit, kSecMatchLimitOne);
  CFDictionarySetValue(query.get(), kSecReturnData, kCFBooleanTrue);
  CFTypeRef raw = nullptr;
  const OSStatus status = SecItemCopyMatching(query.get(), &raw);
  if (status != errSecSuccess) failKeychain("Load existing identity without prompting", status);
  CfOwner<CFTypeRef> result(raw);
  if (CFGetTypeID(result.get()) != CFDataGetTypeID()) {
    throw std::runtime_error("Keychain returned unexpected identity data");
  }
  const auto data = static_cast<CFDataRef>(result.get());
  if (CFDataGetLength(data) != static_cast<CFIndex>(IdentitySeed{}.size())) {
    throw std::runtime_error("Keychain identity is not a 32-byte Ed25519 seed");
  }
  TemporarySeed seed;
  std::memcpy(seed.value.data(), CFDataGetBytePtr(data), seed.value.size());
  // The immutable Security-framework CFData is released, not illegally mutated.
  return seed.value;
}

}  // namespace

struct IdentityStore::Impl final {
  FileDescriptor directory;
  FileDescriptor lock;
  CfOwner<CFStringRef> account;
  CfOwner<SecKeychainRef> keychain;

  explicit Impl(const std::filesystem::path& profile)
      : directory(open(canonicalProfile(profile).c_str(),
                       O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)),
        lock(openat(directory.get(), kLockFile,
                    O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK, 0600)),
        account(profileAccount(directory.get())),
        keychain(defaultKeychain()) {
    requireLockFile();
    if (flock(lock.get(), LOCK_EX | LOCK_NB) == -1) {
      failPosix("Acquire exclusive identity profile lock (profile may be in use)");
    }
    requireLockFile();
  }

  void requireLockFile() const {
    struct stat owned{};
    struct stat named{};
    if (fstat(lock.get(), &owned) == -1 ||
        fstatat(directory.get(), kLockFile, &named, AT_SYMLINK_NOFOLLOW) == -1) {
      failPosix("Inspect identity profile lock");
    }
    if (!S_ISREG(owned.st_mode) || owned.st_nlink != 1 ||
        owned.st_uid != geteuid() || (owned.st_mode & 0022) != 0 ||
        owned.st_dev != named.st_dev || owned.st_ino != named.st_ino) {
      throw std::runtime_error("Identity profile lock is unsafe or was replaced");
    }
  }
};

IdentityStore::IdentityStore(const std::filesystem::path& profileDirectory)
    : impl_(std::make_unique<Impl>(profileDirectory)) {}

IdentityStore::~IdentityStore() = default;

std::optional<IdentitySeed> IdentityStore::load() const {
  impl_->requireLockFile();
  return readSeed(impl_->account.get(), impl_->keychain.get());
}

void IdentityStore::save(const IdentitySeed& newSeed) {
  impl_->requireLockFile();
  requireUsableKeychain(impl_->keychain.get(), true);
  CFArrayRef existing = findIdentity(impl_->account.get(), impl_->keychain.get());
  if (existing) {
    CFRelease(existing);
    throw std::runtime_error("Identity already exists; refusing to replace it");
  }
  // Do not copy plaintext into a CFData allocation; it borrows the wiped temporary.
  TemporarySeed plaintext{newSeed};
  CfOwner<CFMutableDictionaryRef> query(identityQuery(impl_->account.get()));
  CfOwner<CFDataRef> data(CFDataCreateWithBytesNoCopy(
      kCFAllocatorDefault, plaintext.value.data(),
      static_cast<CFIndex>(plaintext.value.size()), kCFAllocatorNull));
  CFDictionarySetValue(query.get(), kSecValueData, data.get());
  CFDictionarySetValue(query.get(), kSecUseKeychain, impl_->keychain.get());
  requireUsableKeychain(impl_->keychain.get(), true);
  const OSStatus status = SecItemAdd(query.get(), nullptr);
  if (status != errSecSuccess) failKeychain("Create identity without replacement or UI", status);
}

}  // namespace monky::light
