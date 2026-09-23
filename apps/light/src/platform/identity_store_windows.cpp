#include "identity_store.hpp"

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <wincrypt.h>

#include <cstddef>
#include <cstring>
#include <limits>
#include <new>
#include <stdexcept>
#include <system_error>
#include <vector>

namespace monky::light {
namespace {

constexpr DWORD kMaxProtectedSeedBytes = 16 * 1024;
constexpr wchar_t kIdentityFile[] = L"identity.dpapi";
constexpr wchar_t kPendingFile[] = L"identity.dpapi.pending";
constexpr wchar_t kLockFile[] = L".identity.lock";

// Windows-only on-disk framing: "MLI1", little-endian ciphertext length, DPAPI blob.
struct ProtectedSeedHeader {
  std::array<char, 4> magic;
  DWORD payloadBytes;
};
static_assert(sizeof(ProtectedSeedHeader) == 8);
constexpr std::array<char, 4> kFileMagic{'M', 'L', 'I', '1'};

[[noreturn]] void failWindows(const char* operation, DWORD error = GetLastError()) {
  throw std::system_error(static_cast<int>(error), std::system_category(), operation);
}

class Handle final {
 public:
  explicit Handle(HANDLE value) : value_(value) {}
  ~Handle() {
    if (value_ != INVALID_HANDLE_VALUE) CloseHandle(value_);
  }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  HANDLE get() const { return value_; }
  HANDLE release() {
    const HANDLE result = value_;
    value_ = INVALID_HANDLE_VALUE;
    return result;
  }
  void close() {
    if (!CloseHandle(value_)) failWindows("Close identity file");
    value_ = INVALID_HANDLE_VALUE;
  }

 private:
  HANDLE value_;
};

struct LocalBlob final {
  DATA_BLOB value{};
  ~LocalBlob() {
    if (value.pbData) {
      SecureZeroMemory(value.pbData, value.cbData);
      LocalFree(value.pbData);
    }
  }
  LocalBlob() = default;
  LocalBlob(const LocalBlob&) = delete;
  LocalBlob& operator=(const LocalBlob&) = delete;
};

struct TemporarySeed final {
  IdentitySeed value{};
  ~TemporarySeed() { SecureZeroMemory(value.data(), value.size()); }
};

std::filesystem::path canonicalProfile(const std::filesystem::path& profile) {
  if (!profile.is_absolute() ||
      profile.native().find(L'\0') != std::wstring::npos) {
    throw std::invalid_argument("Identity profile must be an absolute directory path");
  }
  const auto canonical = std::filesystem::canonical(profile);
  if (!std::filesystem::is_directory(canonical)) {
    throw std::runtime_error("Identity profile is not a directory");
  }
  return canonical;
}

void requireFileKind(HANDLE file, bool directory) {
  BY_HANDLE_FILE_INFORMATION info{};
  if (!GetFileInformationByHandle(file, &info)) failWindows("Inspect identity file");
  if ((info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 ||
      ((info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) != directory ||
      GetFileType(file) != FILE_TYPE_DISK) {
    throw std::runtime_error("Identity storage requires ordinary files and directories");
  }
}

bool entryExists(const std::filesystem::path& file) {
  if (GetFileAttributesW(file.c_str()) != INVALID_FILE_ATTRIBUTES) return true;
  const DWORD error = GetLastError();
  if (error == ERROR_FILE_NOT_FOUND) return false;
  failWindows("Inspect identity storage entry", error);
}

void requireNoPendingSave(const std::filesystem::path& profile) {
  if (entryExists(profile / kPendingFile)) {
    throw std::runtime_error(
        "Incomplete identity save (identity.dpapi.pending); recovery is required, "
        "not identity replacement");
  }
}

void publishWithoutReplacement(HANDLE pending, const std::filesystem::path& destination) {
  const auto& name = destination.native();
  if (name.size() > (std::numeric_limits<DWORD>::max() - sizeof(FILE_RENAME_INFO)) /
                        sizeof(wchar_t)) {
    throw std::runtime_error("Identity file path is too long");
  }
  const auto nameBytes = static_cast<DWORD>(name.size() * sizeof(wchar_t));
  const auto bufferBytes = static_cast<DWORD>(sizeof(FILE_RENAME_INFO) + nameBytes);
  const auto buffer = std::make_unique<std::byte[]>(bufferBytes);
  auto* rename = new (buffer.get()) FILE_RENAME_INFO{};
  rename->ReplaceIfExists = FALSE;
  rename->FileNameLength = nameBytes;
  std::memcpy(rename->FileName, name.data(), nameBytes);
  if (!SetFileInformationByHandle(pending, FileRenameInfo, rename, bufferBytes)) {
    failWindows("Publish identity without replacing an existing identity");
  }
}

}  // namespace

struct IdentityStore::Impl final {
  const std::filesystem::path profile;
  Handle directory;
  Handle lock;

  explicit Impl(const std::filesystem::path& path)
      : profile(canonicalProfile(path)),
        directory(CreateFileW(profile.c_str(), FILE_READ_ATTRIBUTES,
                              FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
                              FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                              nullptr)),
        lock(openLock()) {}

  HANDLE openLock() {
    if (directory.get() == INVALID_HANDLE_VALUE) failWindows("Open identity profile");
    requireFileKind(directory.get(), true);
    Handle candidate(CreateFileW((profile / kLockFile).c_str(),
                                GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_ALWAYS,
                                FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
                                nullptr));
    if (candidate.get() == INVALID_HANDLE_VALUE) {
      failWindows("Acquire exclusive identity profile lock (profile may be in use)");
    }
    requireFileKind(candidate.get(), false);
    return candidate.release();
  }
};

IdentityStore::IdentityStore(const std::filesystem::path& profileDirectory)
    : impl_(std::make_unique<Impl>(profileDirectory)) {}

IdentityStore::~IdentityStore() = default;

std::optional<IdentitySeed> IdentityStore::load() const {
  requireNoPendingSave(impl_->profile);
  Handle file(CreateFileW((impl_->profile / kIdentityFile).c_str(), GENERIC_READ,
                          FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                          FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
                          nullptr));
  if (file.get() == INVALID_HANDLE_VALUE) {
    const DWORD error = GetLastError();
    if (error == ERROR_FILE_NOT_FOUND) return std::nullopt;
    failWindows("Read protected identity", error);
  }
  requireFileKind(file.get(), false);
  LARGE_INTEGER length{};
  if (!GetFileSizeEx(file.get(), &length)) failWindows("Read protected identity size");
  if (length.QuadPart <= sizeof(ProtectedSeedHeader) ||
      length.QuadPart > kMaxProtectedSeedBytes) {
    throw std::runtime_error("Protected identity file has an invalid size");
  }
  const auto size = static_cast<DWORD>(length.QuadPart);
  std::vector<BYTE> protectedBytes(size);
  DWORD read = 0;
  if (!ReadFile(file.get(), protectedBytes.data(), size, &read, nullptr)) {
    failWindows("Read protected identity bytes");
  }
  if (read != size) throw std::runtime_error("Protected identity file was truncated");
  file.close();

  ProtectedSeedHeader header{};
  std::memcpy(&header, protectedBytes.data(), sizeof(header));
  if (header.magic != kFileMagic || header.payloadBytes != size - sizeof(header)) {
    throw std::runtime_error("Protected identity file has an invalid header or length");
  }
  DATA_BLOB encrypted{header.payloadBytes, protectedBytes.data() + sizeof(header)};
  LocalBlob plaintext;
  if (!CryptUnprotectData(&encrypted, nullptr, nullptr, nullptr, nullptr,
                          CRYPTPROTECT_UI_FORBIDDEN, &plaintext.value)) {
    failWindows("Decrypt identity with user-scoped DPAPI");
  }
  TemporarySeed seed;
  if (plaintext.value.cbData != seed.value.size() || !plaintext.value.pbData) {
    throw std::runtime_error("Decrypted identity is not a 32-byte Ed25519 seed");
  }
  std::memcpy(seed.value.data(), plaintext.value.pbData, seed.value.size());
  return seed.value;
}

void IdentityStore::save(const IdentitySeed& newSeed) {
  requireNoPendingSave(impl_->profile);
  const auto destination = impl_->profile / kIdentityFile;
  if (entryExists(destination)) {
    throw std::runtime_error("Identity already exists; refusing to replace it");
  }

  TemporarySeed plaintext{newSeed};
  DATA_BLOB input{static_cast<DWORD>(plaintext.value.size()), plaintext.value.data()};
  LocalBlob encrypted;
  if (!CryptProtectData(&input, L"Monky Light Ed25519 seed", nullptr, nullptr, nullptr,
                        CRYPTPROTECT_UI_FORBIDDEN, &encrypted.value)) {
    failWindows("Protect identity with user-scoped DPAPI");
  }
  if (!encrypted.value.pbData || encrypted.value.cbData == 0 ||
      encrypted.value.cbData > kMaxProtectedSeedBytes - sizeof(ProtectedSeedHeader)) {
    throw std::runtime_error("DPAPI returned an invalid protected identity size");
  }

  const ProtectedSeedHeader header{kFileMagic, encrypted.value.cbData};
  const auto size = static_cast<DWORD>(sizeof(header) + encrypted.value.cbData);
  std::vector<BYTE> protectedBytes(size);
  std::memcpy(protectedBytes.data(), &header, sizeof(header));
  std::memcpy(protectedBytes.data() + sizeof(header), encrypted.value.pbData,
              encrypted.value.cbData);

  // Keep a failed/interrupted staging file as a fail-closed recovery marker.
  // Renaming the open handle publishes complete ciphertext atomically, without overwrite.
  Handle pending(CreateFileW((impl_->profile / kPendingFile).c_str(),
                             GENERIC_WRITE | DELETE, 0, nullptr, CREATE_NEW,
                             FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
                             nullptr));
  if (pending.get() == INVALID_HANDLE_VALUE) failWindows("Create identity staging file");
  DWORD written = 0;
  if (!WriteFile(pending.get(), protectedBytes.data(), size, &written, nullptr)) {
    failWindows("Write protected identity");
  }
  if (written != size) {
    throw std::runtime_error("Incomplete write of protected identity");
  }
  if (!FlushFileBuffers(pending.get())) failWindows("Flush protected identity");
  publishWithoutReplacement(pending.get(), destination);
  if (!FlushFileBuffers(pending.get())) failWindows("Flush published identity");
  pending.close();
}

}  // namespace monky::light
