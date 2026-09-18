#include "profile_identity.hpp"

#include "identity_key.hpp"
#include "platform/identity_store.hpp"

#include <json.hpp>

#include <algorithm>
#include <cstddef>
#include <cstring>
#include <limits>
#include <new>
#include <optional>
#include <set>
#include <stdexcept>
#include <system_error>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#elif defined(__APPLE__)
#include <fcntl.h>
#include <stdio.h>
#include <sys/stat.h>
#include <unistd.h>
#include <cerrno>
#else
#error Profile identity requires Windows or macOS
#endif

namespace monky::light {
namespace {

namespace fs = std::filesystem;
using Json = nlohmann::json;

constexpr char kMetadataFile[] = "monky-light.json";
constexpr char kPendingFile[] = "monky-light.json.pending";
constexpr char kFormat[] = "monky-light-profile";
constexpr std::size_t kMaxMetadataBytes = 4096;
constexpr char kSettingsFile[] = "monky-light-settings.json";
constexpr char kSettingsPendingFile[] = "monky-light-settings.json.pending";
constexpr char kSettingsFormat[] = "monky-light-settings";
constexpr std::size_t kMaxSettingsBytes = 16 * 1024;
constexpr std::size_t kMaxDeviceIdBytes = 1024;

[[noreturn]] void requireRecovery(const char* reason) {
  throw std::runtime_error(std::string(reason) + "; explicit profile recovery is required");
}

struct SeedBuffer final {
  std::optional<IdentitySeed> value;
  explicit SeedBuffer(const IdentityStore& store) : value(store.load()) {}
  ~SeedBuffer() { if (value) clearIdentitySeed(*value); }
  SeedBuffer(const SeedBuffer&) = delete;
  SeedBuffer& operator=(const SeedBuffer&) = delete;
};

void inspectProfile(const fs::path& profile) {
  for (const auto& entry : fs::directory_iterator(profile)) {
    const auto name = entry.path().filename();
    bool owned = name == ".identity.lock" || name == kMetadataFile || name == kPendingFile ||
                 name == kSettingsFile || name == kSettingsPendingFile;
#ifdef _WIN32
    owned = owned || name == "identity.dpapi" || name == "identity.dpapi.pending";
#endif
    if (!owned) {
      throw std::runtime_error("Refusing an unrelated nonempty directory as a Monky Light profile");
    }
    if (!fs::is_regular_file(entry.symlink_status())) {
      requireRecovery("Profile identity entries must be ordinary files, not links or directories");
    }
    if (name == kPendingFile || name == "identity.dpapi.pending") {
      requireRecovery("An interrupted profile identity write marker exists");
    }
  }
}

fs::path prepareProfile(const fs::path& requested) {
  if (!requested.is_absolute() ||
      requested.native().find(fs::path::value_type{}) != fs::path::string_type::npos) {
    throw std::invalid_argument("Profile identity requires an absolute directory path");
  }
#ifdef _WIN32
  if (!CreateDirectoryW(requested.c_str(), nullptr)) {
    const DWORD error = GetLastError();
    if (error != ERROR_ALREADY_EXISTS) {
      throw std::system_error(static_cast<int>(error), std::system_category(),
                              "Create Monky Light profile directory");
    }
  }
#else
  if (mkdir(requested.c_str(), 0700) == -1 && errno != EEXIST) {
    throw std::system_error(errno, std::generic_category(),
                            "Create Monky Light profile directory");
  }
#endif
  const auto profile = fs::canonical(requested);
  if (!fs::is_directory(profile)) {
    throw std::runtime_error("Monky Light profile is not a directory");
  }
  // Refuse foreign state before IdentityStore creates its lock file, then recheck locked.
  inspectProfile(profile);
  return profile;
}

#ifdef _WIN32
[[noreturn]] void failIo(const char* operation, DWORD error = GetLastError()) {
  throw std::system_error(static_cast<int>(error), std::system_category(), operation);
}

class File final {
 public:
  explicit File(HANDLE value) : value_(value) {}
  ~File() { if (value_ != INVALID_HANDLE_VALUE) CloseHandle(value_); }
  File(const File&) = delete;
  File& operator=(const File&) = delete;
  HANDLE get() const { return value_; }
  void close() {
    if (!CloseHandle(value_)) failIo("Close profile metadata file");
    value_ = INVALID_HANDLE_VALUE;
  }

 private:
  HANDLE value_;
};

void requireOrdinaryFile(HANDLE file) {
  BY_HANDLE_FILE_INFORMATION info{};
  if (!GetFileInformationByHandle(file, &info)) failIo("Inspect profile metadata file");
  if ((info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) ||
      info.nNumberOfLinks != 1 || GetFileType(file) != FILE_TYPE_DISK) {
    requireRecovery("Profile metadata must be an ordinary file with a single hard link");
  }
}

std::optional<std::string> readMetadata(const fs::path& profile) {
  const auto path = profile / kMetadataFile;
  File file(CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                        FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (file.get() == INVALID_HANDLE_VALUE) {
    const DWORD error = GetLastError();
    if (error == ERROR_FILE_NOT_FOUND) return std::nullopt;
    failIo("Open profile metadata", error);
  }
  requireOrdinaryFile(file.get());
  LARGE_INTEGER length{};
  if (!GetFileSizeEx(file.get(), &length)) failIo("Read profile metadata size");
  if (length.QuadPart <= 0 || length.QuadPart > kMaxMetadataBytes) {
    requireRecovery("Profile metadata size is invalid");
  }
  std::string contents(static_cast<std::size_t>(length.QuadPart), '\0');
  DWORD bytes = 0;
  if (!ReadFile(file.get(), contents.data(), static_cast<DWORD>(contents.size()),
                &bytes, nullptr)) {
    failIo("Read profile metadata");
  }
  if (bytes != contents.size()) requireRecovery("Profile metadata was truncated");
  file.close();
  return contents;
}

class PendingMetadata final {
 public:
  explicit PendingMetadata(const fs::path& profile)
      : destination_(profile / kMetadataFile),
        file_(CreateFileW((profile / kPendingFile).c_str(), GENERIC_WRITE | DELETE, 0,
                          nullptr, CREATE_NEW,
                          FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr)) {
    if (file_.get() == INVALID_HANDLE_VALUE) failIo("Exclusively create profile write marker");
    if (!FlushFileBuffers(file_.get())) failIo("Flush profile write marker");
  }

  void publish(const std::string& contents) {
    DWORD bytes = 0;
    if (!WriteFile(file_.get(), contents.data(), static_cast<DWORD>(contents.size()),
                   &bytes, nullptr)) {
      failIo("Write public profile metadata");
    }
    if (bytes != contents.size()) requireRecovery("Profile metadata write was incomplete");
    if (!FlushFileBuffers(file_.get())) failIo("Flush public profile metadata");

    const auto& name = destination_.native();
    if (name.size() > (std::numeric_limits<DWORD>::max() - sizeof(FILE_RENAME_INFO)) /
                          sizeof(wchar_t)) {
      throw std::runtime_error("Profile metadata path is too long");
    }
    const auto nameBytes = static_cast<DWORD>(name.size() * sizeof(wchar_t));
    const auto bufferBytes = static_cast<DWORD>(sizeof(FILE_RENAME_INFO) + nameBytes);
    const auto buffer = std::make_unique<std::byte[]>(bufferBytes);
    auto* rename = new (buffer.get()) FILE_RENAME_INFO{};
    rename->ReplaceIfExists = FALSE;
    rename->FileNameLength = nameBytes;
    std::memcpy(rename->FileName, name.data(), nameBytes);
    if (!SetFileInformationByHandle(file_.get(), FileRenameInfo, rename, bufferBytes)) {
      failIo("Publish profile metadata without replacement");
    }
    if (!FlushFileBuffers(file_.get())) failIo("Flush published profile metadata");
    file_.close();
  }

 private:
  fs::path destination_;
  File file_;
};

std::optional<std::string> readSettings(const fs::path& profile) {
  File file(CreateFileW((profile / kSettingsFile).c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
                        OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (file.get() == INVALID_HANDLE_VALUE) {
    const DWORD error = GetLastError();
    if (error == ERROR_FILE_NOT_FOUND) return std::nullopt;
    failIo("Open profile settings", error);
  }
  BY_HANDLE_FILE_INFORMATION info{};
  if (!GetFileInformationByHandle(file.get(), &info)) failIo("Inspect profile settings file");
  if ((info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) ||
      info.nNumberOfLinks != 1 || GetFileType(file.get()) != FILE_TYPE_DISK) {
    throw std::runtime_error("Profile settings must be an ordinary file with a single hard link");
  }
  LARGE_INTEGER length{};
  if (!GetFileSizeEx(file.get(), &length)) failIo("Read profile settings size");
  if (length.QuadPart <= 0 || length.QuadPart > kMaxSettingsBytes) {
    throw std::runtime_error("Profile settings size is invalid");
  }
  std::string contents(static_cast<std::size_t>(length.QuadPart), '\0');
  DWORD bytes = 0;
  if (!ReadFile(file.get(), contents.data(), static_cast<DWORD>(contents.size()), &bytes, nullptr)) {
    failIo("Read profile settings");
  }
  if (bytes != contents.size()) throw std::runtime_error("Profile settings were truncated");
  file.close();
  return contents;
}

void writeSettings(const fs::path& profile, const std::string& contents) {
  const auto pending = profile / kSettingsPendingFile;
  // A leftover marker holds no identity state; DeleteFileW removes links, not targets.
  if (!DeleteFileW(pending.c_str()) && GetLastError() != ERROR_FILE_NOT_FOUND) {
    failIo("Remove interrupted profile settings write");
  }
  File file(CreateFileW(pending.c_str(), GENERIC_WRITE | DELETE, 0, nullptr, CREATE_NEW,
                        FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (file.get() == INVALID_HANDLE_VALUE) failIo("Create profile settings write");
  DWORD bytes = 0;
  if (!WriteFile(file.get(), contents.data(), static_cast<DWORD>(contents.size()), &bytes, nullptr) ||
      bytes != contents.size() || !FlushFileBuffers(file.get())) {
    failIo("Write profile settings");
  }
  const auto name = (profile / kSettingsFile).native();
  const auto nameBytes = static_cast<DWORD>(name.size() * sizeof(wchar_t));
  const auto bufferBytes = static_cast<DWORD>(sizeof(FILE_RENAME_INFO) + nameBytes);
  const auto buffer = std::make_unique<std::byte[]>(bufferBytes);
  auto* rename = new (buffer.get()) FILE_RENAME_INFO{};
  rename->ReplaceIfExists = TRUE;
  rename->FileNameLength = nameBytes;
  std::memcpy(rename->FileName, name.data(), nameBytes);
  if (!SetFileInformationByHandle(file.get(), FileRenameInfo, rename, bufferBytes)) {
    failIo("Publish profile settings");
  }
  file.close();
}
#else
[[noreturn]] void failIo(const char* operation) {
  throw std::system_error(errno, std::generic_category(), operation);
}

class File final {
 public:
  explicit File(int value) : value_(value) {}
  ~File() { if (value_ != -1) ::close(value_); }
  File(const File&) = delete;
  File& operator=(const File&) = delete;
  int get() const { return value_; }
  void close() {
    const int value = value_;
    value_ = -1;
    if (::close(value) == -1) failIo("Close profile metadata file");
  }

 private:
  int value_;
};

struct stat ordinaryFile(int file) {
  struct stat info{};
  if (fstat(file, &info) == -1) failIo("Inspect profile metadata file");
  if (!S_ISREG(info.st_mode) || info.st_nlink != 1) {
    requireRecovery("Profile metadata must be an ordinary file with a single hard link");
  }
  return info;
}

std::optional<std::string> readMetadata(const fs::path& profile) {
  File directory(open(profile.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW));
  if (directory.get() == -1) failIo("Open profile metadata directory");
  File file(openat(directory.get(), kMetadataFile, O_RDONLY | O_CLOEXEC | O_NOFOLLOW |
                                                  O_NONBLOCK));
  if (file.get() == -1) {
    if (errno == ENOENT) return std::nullopt;
    failIo("Open profile metadata");
  }
  const auto info = ordinaryFile(file.get());
  if (info.st_size <= 0 || static_cast<std::uintmax_t>(info.st_size) > kMaxMetadataBytes) {
    requireRecovery("Profile metadata size is invalid");
  }
  std::string contents(static_cast<std::size_t>(info.st_size), '\0');
  std::size_t offset = 0;
  while (offset < contents.size()) {
    const auto count = read(file.get(), contents.data() + offset, contents.size() - offset);
    if (count == -1) {
      if (errno == EINTR) continue;
      failIo("Read profile metadata");
    }
    if (count == 0) requireRecovery("Profile metadata was truncated");
    offset += static_cast<std::size_t>(count);
  }
  char extra = 0;
  ssize_t extraBytes;
  do {
    extraBytes = read(file.get(), &extra, 1);
  } while (extraBytes == -1 && errno == EINTR);
  if (extraBytes == -1) failIo("Finish reading profile metadata");
  if (extraBytes != 0 || ordinaryFile(file.get()).st_size != info.st_size) {
    requireRecovery("Profile metadata changed while reading");
  }
  file.close();
  directory.close();
  return contents;
}

class PendingMetadata final {
 public:
  explicit PendingMetadata(const fs::path& profile)
      : directory_(open(profile.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)),
        file_(createMarker()) {
    if (fsync(file_.get()) == -1 || fsync(directory_.get()) == -1) {
      failIo("Flush profile write marker");
    }
  }

  void publish(const std::string& contents) {
    std::size_t offset = 0;
    while (offset < contents.size()) {
      const auto count = write(file_.get(), contents.data() + offset, contents.size() - offset);
      if (count == -1) {
        if (errno == EINTR) continue;
        failIo("Write public profile metadata");
      }
      if (count == 0) requireRecovery("Profile metadata write was incomplete");
      offset += static_cast<std::size_t>(count);
    }
    if (fsync(file_.get()) == -1) failIo("Flush public profile metadata");
    const auto owned = ordinaryFile(file_.get());
    struct stat named{};
    if (fstatat(directory_.get(), kPendingFile, &named, AT_SYMLINK_NOFOLLOW) == -1) {
      failIo("Inspect profile write marker before publication");
    }
    if (owned.st_dev != named.st_dev || owned.st_ino != named.st_ino) {
      requireRecovery("Profile write marker was replaced");
    }
    if (renameatx_np(directory_.get(), kPendingFile, directory_.get(), kMetadataFile,
                     RENAME_EXCL) == -1) {
      failIo("Publish profile metadata without replacement");
    }
    if (fsync(directory_.get()) == -1) failIo("Flush published profile metadata directory");
    file_.close();
    directory_.close();
  }

 private:
  int createMarker() {
    if (directory_.get() == -1) failIo("Open profile metadata directory");
    const int result = openat(directory_.get(), kPendingFile,
        O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (result == -1) failIo("Exclusively create profile write marker");
    return result;
  }
  File directory_;
  File file_;
};

std::optional<std::string> readSettings(const fs::path& profile) {
  File directory(open(profile.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW));
  if (directory.get() == -1) failIo("Open profile settings directory");
  File file(openat(directory.get(), kSettingsFile, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK));
  if (file.get() == -1) {
    if (errno == ENOENT) return std::nullopt;
    failIo("Open profile settings");
  }
  struct stat info{};
  if (fstat(file.get(), &info) == -1) failIo("Inspect profile settings file");
  if (!S_ISREG(info.st_mode) || info.st_nlink != 1) {
    throw std::runtime_error("Profile settings must be an ordinary file with a single hard link");
  }
  if (info.st_size <= 0 || static_cast<std::uintmax_t>(info.st_size) > kMaxSettingsBytes) {
    throw std::runtime_error("Profile settings size is invalid");
  }
  std::string contents(static_cast<std::size_t>(info.st_size), '\0');
  std::size_t offset = 0;
  while (offset < contents.size()) {
    const auto count = read(file.get(), contents.data() + offset, contents.size() - offset);
    if (count == -1) {
      if (errno == EINTR) continue;
      failIo("Read profile settings");
    }
    if (count == 0) throw std::runtime_error("Profile settings were truncated");
    offset += static_cast<std::size_t>(count);
  }
  file.close();
  directory.close();
  return contents;
}

void writeSettings(const fs::path& profile, const std::string& contents) {
  File directory(open(profile.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW));
  if (directory.get() == -1) failIo("Open profile settings directory");
  // A leftover marker holds no identity state; unlinkat removes links, not targets.
  if (unlinkat(directory.get(), kSettingsPendingFile, 0) == -1 && errno != ENOENT) {
    failIo("Remove interrupted profile settings write");
  }
  File file(openat(directory.get(), kSettingsPendingFile,
                   O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600));
  if (file.get() == -1) failIo("Create profile settings write");
  std::size_t offset = 0;
  while (offset < contents.size()) {
    const auto count = write(file.get(), contents.data() + offset, contents.size() - offset);
    if (count == -1) {
      if (errno == EINTR) continue;
      failIo("Write profile settings");
    }
    if (count == 0) throw std::runtime_error("Profile settings write was incomplete");
    offset += static_cast<std::size_t>(count);
  }
  if (fsync(file.get()) == -1) failIo("Flush profile settings");
  if (renameat(directory.get(), kSettingsPendingFile, directory.get(), kSettingsFile) == -1) {
    failIo("Publish profile settings");
  }
  if (fsync(directory.get()) == -1) failIo("Flush profile settings directory");
  file.close();
  directory.close();
}
#endif

bool isLowerHex(std::string_view value) {
  return std::all_of(value.begin(), value.end(), [](char digit) {
    return (digit >= '0' && digit <= '9') || (digit >= 'a' && digit <= 'f');
  });
}

bool isDeviceId(std::string_view value) {
  if (value.size() != 36 || value[14] != '4' ||
      std::string_view("89ab").find(value[19]) == std::string_view::npos) {
    return false;
  }
  for (std::size_t index = 0; index < value.size(); ++index) {
    const bool separator = index == 8 || index == 13 || index == 18 || index == 23;
    if (separator ? value[index] != '-' : !isLowerHex(value.substr(index, 1))) return false;
  }
  return true;
}

struct Metadata final {
  std::string deviceId;
  std::string publicKeyHex;
};

Metadata parseMetadata(const std::string& contents) {
  std::set<std::string> fields;
  const auto callback = [&](int depth, Json::parse_event_t event, Json& value) {
    if (event == Json::parse_event_t::array_start ||
        (event == Json::parse_event_t::object_start && depth != 0)) {
      requireRecovery("Profile metadata must be a flat JSON object");
    }
    if (event == Json::parse_event_t::key &&
        !fields.insert(value.get<std::string>()).second) {
      requireRecovery("Profile metadata contains duplicate fields");
    }
    return true;
  };
  Json data;
  try {
    data = Json::parse(contents, callback);
  } catch (const Json::exception&) {
    // Parser diagnostics may echo file contents; never propagate raw metadata values.
    requireRecovery("Profile metadata is malformed JSON");
  }
  if (!data.is_object() || data.size() != 4 ||
      !data.contains("format") || !data["format"].is_string() || data["format"] != kFormat ||
      !data.contains("version") || !data["version"].is_number_integer() || data["version"] != 1 ||
      !data.contains("deviceId") || !data["deviceId"].is_string() ||
      !data.contains("publicKeyHex") || !data["publicKeyHex"].is_string()) {
    requireRecovery("Profile metadata has an unsupported format, version or field type");
  }
  Metadata result{data["deviceId"].get<std::string>(), data["publicKeyHex"].get<std::string>()};
  // IdentityKey emits the 44-byte Ed25519 SPKI as hexadecimal; compare the entire key.
  if (!isDeviceId(result.deviceId) || result.publicKeyHex.size() != 88 ||
      !isLowerHex(result.publicKeyHex)) {
    requireRecovery("Profile metadata has an invalid device ID or public key");
  }
  return result;
}

std::string encodeMetadata(const Metadata& metadata) {
  const auto result = Json{{"format", kFormat}, {"version", 1},
                           {"deviceId", metadata.deviceId},
                           {"publicKeyHex", metadata.publicKeyHex}}.dump(2) + "\n";
  if (result.size() > kMaxMetadataBytes) {
    throw std::runtime_error("Generated profile metadata exceeds its size limit");
  }
  return result;
}

std::optional<std::string> settingsDevice(const Json& data, const char* field) {
  const auto found = data.find(field);
  if (found == data.end() || found->is_null()) return std::nullopt;
  if (!found->is_string() || found->get_ref<const std::string&>().empty() ||
      found->get_ref<const std::string&>().size() > kMaxDeviceIdBytes) {
    throw std::runtime_error("Profile settings contain an invalid audio device ID");
  }
  return found->get<std::string>();
}

ProfileSettings parseSettings(const std::string& contents) {
  Json data;
  try {
    data = Json::parse(contents, [](int depth, Json::parse_event_t event, Json&) {
      if (event == Json::parse_event_t::array_start ||
          (event == Json::parse_event_t::object_start && depth != 0)) {
        throw std::runtime_error("Profile settings must be a flat JSON object");
      }
      return true;
    });
  } catch (const Json::exception&) {
    throw std::runtime_error("Profile settings are malformed JSON");
  }
  if (!data.is_object() || data.value("format", "") != kSettingsFormat ||
      !data.contains("version") || !data["version"].is_number_integer() || data["version"] != 1) {
    throw std::runtime_error("Profile settings have an unsupported format or version");
  }
  return {settingsDevice(data, "inputDeviceId"), settingsDevice(data, "outputDeviceId")};
}

std::string encodeSettings(const ProfileSettings& settings) {
  for (const auto* id : {&settings.inputDeviceId, &settings.outputDeviceId}) {
    if (*id && ((*id)->empty() || (*id)->size() > kMaxDeviceIdBytes)) {
      throw std::invalid_argument("Audio device ID must be a nonempty string of at most 1024 bytes");
    }
  }
  const auto optional = [](const std::optional<std::string>& value) {
    return value ? Json(*value) : Json(nullptr);
  };
  std::string result;
  try {
    result = Json{{"format", kSettingsFormat}, {"version", 1},
                  {"inputDeviceId", optional(settings.inputDeviceId)},
                  {"outputDeviceId", optional(settings.outputDeviceId)}}.dump(2) + "\n";
  } catch (const Json::exception&) {
    throw std::invalid_argument("Audio device ID must be valid UTF-8");
  }
  if (result.size() > kMaxSettingsBytes) throw std::invalid_argument("Profile settings exceed their size limit");
  return result;
}

}  // namespace

struct ProfileIdentity::Impl final {
  const fs::path profile;
  IdentityStore store;
  std::unique_ptr<IdentityKey> key;
  std::string device;

  explicit Impl(const fs::path& selected)
      : profile(prepareProfile(selected)), store(profile) {
    inspectProfile(profile);
    const auto contents = readMetadata(profile);
    const auto metadata = contents ? std::optional<Metadata>(parseMetadata(*contents)) : std::nullopt;
    SeedBuffer seed(store);
    if (metadata.has_value() != seed.value.has_value()) {
      requireRecovery(metadata ? "Profile metadata exists but its seed is missing"
                               : "A profile seed exists but its metadata is missing");
    }
    if (metadata) {
      key = std::make_unique<IdentityKey>(*seed.value);
      if (key->publicKeyHex() != metadata->publicKeyHex) {
        requireRecovery("Profile metadata public key does not match its stored seed");
      }
      device = metadata->deviceId;
      return;
    }

    // Reserve a durable public marker before the Keychain/DPAPI write, so even moving
    // a half-created macOS profile cannot make it appear to be a fresh profile.
    PendingMetadata pending(profile);
    seed.value.emplace();
    generateIdentitySeed(*seed.value);
    key = std::make_unique<IdentityKey>(*seed.value);
    device = randomUuid();
    const auto encoded = encodeMetadata(Metadata{device, key->publicKeyHex()});
    store.save(*seed.value);
    pending.publish(encoded);
  }
};

ProfileIdentity::ProfileIdentity(const std::filesystem::path& profileDirectory)
    : impl_(std::make_unique<Impl>(profileDirectory)) {}

ProfileIdentity::~ProfileIdentity() = default;

const std::string& ProfileIdentity::publicKeyHex() const noexcept {
  return impl_->key->publicKeyHex();
}

const std::string& ProfileIdentity::deviceId() const noexcept {
  return impl_->device;
}

ProfileSettings ProfileIdentity::loadSettings() const {
  const auto contents = readSettings(impl_->profile);
  return contents ? parseSettings(*contents) : ProfileSettings{};
}

void ProfileIdentity::saveSettings(const ProfileSettings& settings) const {
  writeSettings(impl_->profile, encodeSettings(settings));
}

std::string ProfileIdentity::signChallenge(std::string_view nonceHex) const {
  return impl_->key->signChallenge(nonceHex);
}

std::string ProfileIdentity::signChallenge(const std::array<std::uint8_t, 32>& nonce) const {
  return impl_->key->signChallenge(nonce);
}

}  // namespace monky::light
