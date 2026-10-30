#pragma once

// What the host trusts before it loads OBS: its parent process, the pinned runtime files it opens without
// following links, their hashes, the owned run directory and the stock libraries with their API table.
// Part of the single host.cpp translation unit, which is the only file that includes it.

#include "win32.h"
#include "abi.h"
#include "../rtc/inputs/abi/monky_av1.h"
#include <runtime-pins.h>

#include <TlHelp32.h>
#include <bcrypt.h>

#include <vector>

namespace {
using namespace monky::screen_capture;
namespace win = monky::win;

struct Parent { Handle process; DWORD pid = 0; std::uint64_t creation = 0; };

Parent BindParent() {
  const DWORD own = GetCurrentProcessId();
  Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  Require(static_cast<bool>(snapshot), "Cannot inspect helper ancestry", "ERR_SCREEN_CAPTURE_PARENT");
  PROCESSENTRY32W entry{}; entry.dwSize = sizeof(entry);
  CheckWin(Process32FirstW(snapshot.Get(), &entry), "ERR_SCREEN_CAPTURE_PARENT", "Cannot read helper ancestry");
  Parent parent;
  do {
    if (entry.th32ProcessID == own) { parent.pid = entry.th32ParentProcessID; break; }
  } while (Process32NextW(snapshot.Get(), &entry));
  Require(parent.pid != 0 && parent.pid != own, "Helper parent identity is unavailable", "ERR_SCREEN_CAPTURE_PARENT");
  parent.process = Handle(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, parent.pid));
  Require(static_cast<bool>(parent.process) && WaitForSingleObject(parent.process.Get(), 0) == WAIT_TIMEOUT,
      "Helper parent is not live", "ERR_SCREEN_CAPTURE_PARENT");
  parent.creation = ProcessCreation(parent.process.Get());
  Require(parent.creation <= ProcessCreation(GetCurrentProcess()), "Helper parent PID was reused", "ERR_SCREEN_CAPTURE_PARENT");
  return parent;
}

void CheckComponents(const std::wstring& path, bool directory) {
  Require(SafeAbsolutePath(path), "Unsafe absolute path", "ERR_SCREEN_CAPTURE_PATH");
  for (std::size_t end = 3; end <= path.size(); ++end) {
    if (end != path.size() && path[end] != L'\\') continue;
    const auto prefix = path.substr(0, end);
    const DWORD attributes = GetFileAttributesW(prefix.c_str());
    const bool requireDirectory = end < path.size() || directory;
    Require(attributes != INVALID_FILE_ATTRIBUTES && !(attributes & FILE_ATTRIBUTE_REPARSE_POINT) &&
        static_cast<bool>(attributes & FILE_ATTRIBUTE_DIRECTORY) == requireDirectory,
        "Path contains a missing, redirected or wrong-kind component", "ERR_SCREEN_CAPTURE_PATH");
  }
}

void CheckRealPath(HANDLE handle, const std::wstring& expected) {
  std::array<wchar_t, 32768> text{};
  const auto length = GetFinalPathNameByHandleW(handle, text.data(), static_cast<DWORD>(text.size()), FILE_NAME_NORMALIZED);
  Require(length > 4 && length < text.size(), "Cannot obtain bounded realpath", "ERR_SCREEN_CAPTURE_PATH");
  const std::wstring_view actual(text.data(), length);
  Require(actual.starts_with(L"\\\\?\\") && SamePath(actual.substr(4), expected),
      "Handle realpath does not match the explicit canonical path", "ERR_SCREEN_CAPTURE_PATH");
}

BY_HANDLE_FILE_INFORMATION FileInfo(HANDLE handle) {
  BY_HANDLE_FILE_INFORMATION info{};
  CheckWin(GetFileInformationByHandle(handle, &info), "ERR_SCREEN_CAPTURE_PATH", "Cannot inspect opened file");
  return info;
}

Handle OpenRegular(const std::wstring& path) {
  CheckComponents(path, false);
  Handle file(CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
      FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  Require(static_cast<bool>(file), "Cannot lock ordinary input file", "ERR_SCREEN_CAPTURE_PATH");
  const auto info = FileInfo(file.Get());
  Require(!(info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) &&
      info.nNumberOfLinks == 1, "Input file is redirected or hardlinked", "ERR_SCREEN_CAPTURE_PATH");
  CheckRealPath(file.Get(), path);
  return file;
}

class Sha256 {
 public:
  Sha256() {
    Require(BCryptOpenAlgorithmProvider(&algorithm_, BCRYPT_SHA256_ALGORITHM, nullptr, 0) >= 0,
        "Cannot open SHA256 provider", "ERR_SCREEN_CAPTURE_RUNTIME_INTEGRITY");
  }
  ~Sha256() { if (algorithm_) BCryptCloseAlgorithmProvider(algorithm_, 0); }
  Sha256(const Sha256&) = delete;
  Sha256& operator=(const Sha256&) = delete;

  std::string File(HANDLE file, std::uint64_t expectedBytes) const {
    const auto before = FileInfo(file);
    Require(((static_cast<std::uint64_t>(before.nFileSizeHigh) << 32) | before.nFileSizeLow) == expectedBytes,
        "Pinned file size changed", "ERR_SCREEN_CAPTURE_RUNTIME_INTEGRITY");
    LARGE_INTEGER zero{};
    CheckWin(SetFilePointerEx(file, zero, nullptr, FILE_BEGIN), "ERR_SCREEN_CAPTURE_RUNTIME_INTEGRITY", "Cannot rewind hash input");
    BCRYPT_HASH_HANDLE hash = nullptr;
    Require(BCryptCreateHash(algorithm_, &hash, nullptr, 0, nullptr, 0, 0) >= 0,
        "Cannot create SHA256 hash", "ERR_SCREEN_CAPTURE_RUNTIME_INTEGRITY");
    try {
      std::array<std::uint8_t, 65536> bytes{};
      std::uint64_t offset = 0;
      while (offset < expectedBytes) {
        const auto count = static_cast<DWORD>((std::min)(expectedBytes - offset, static_cast<std::uint64_t>(bytes.size())));
        DWORD read = 0;
        CheckWin(ReadFile(file, bytes.data(), count, &read, nullptr), "ERR_SCREEN_CAPTURE_RUNTIME_INTEGRITY", "Cannot hash stock file");
        Require(read > 0 && BCryptHashData(hash, bytes.data(), read, 0) >= 0,
            "Truncated stock file or SHA256 failure", "ERR_SCREEN_CAPTURE_RUNTIME_INTEGRITY");
        offset += read;
      }
      std::array<std::uint8_t, 32> digest{};
      Require(BCryptFinishHash(hash, digest.data(), static_cast<ULONG>(digest.size()), 0) >= 0,
          "SHA256 finish failed", "ERR_SCREEN_CAPTURE_RUNTIME_INTEGRITY");
      BCryptDestroyHash(hash); hash = nullptr;
      const auto after = FileInfo(file);
      Require(before.nFileSizeHigh == after.nFileSizeHigh && before.nFileSizeLow == after.nFileSizeLow &&
          FileTimeValue(before.ftLastWriteTime) == FileTimeValue(after.ftLastWriteTime),
          "Stock input changed during hashing", "ERR_SCREEN_CAPTURE_RUNTIME_INTEGRITY");
      constexpr char hex[] = "0123456789abcdef";
      std::string result;
      for (const auto byte : digest) { result += hex[byte >> 4]; result += hex[byte & 15]; }
      return result;
    } catch (...) {
      if (hash) BCryptDestroyHash(hash);
      throw;
    }
  }
 private:
  BCRYPT_ALG_HANDLE algorithm_ = nullptr;
};

void EnsureDataParents(const std::wstring& directory, std::wstring_view relative) {
  for (std::size_t i = 0; i < relative.size(); ++i) {
    if (relative[i] != L'\\') continue;
    const auto path = directory + L"\\" + std::wstring(relative.substr(0, i));
    if (!CreateDirectoryW(path.c_str(), nullptr) && GetLastError() != ERROR_ALREADY_EXISTS)
      CheckWin(FALSE, "ERR_SCREEN_CAPTURE_RUN_DIRECTORY", "Cannot create private data parent");
    CheckComponents(path, true);
  }
}

class OwnedRun {
 public:
  OwnedRun(const Arguments& arguments, DWORD parentPid) : directory(arguments.runDirectory), runId(arguments.runId) {
    ValidateRunPath(arguments);
    CheckComponents(directory, true);
    directoryHandle_ = Handle(CreateFileW(directory.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE,
        nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    Require(static_cast<bool>(directoryHandle_), "Cannot bind owned run directory", "ERR_SCREEN_CAPTURE_RUN_DIRECTORY");
    CheckRealPath(directoryHandle_.Get(), directory);
    WIN32_FIND_DATAW item{};
    const HANDLE find = FindFirstFileW((directory + L"\\*").c_str(), &item);
    Require(find != INVALID_HANDLE_VALUE, "Cannot inspect run directory", "ERR_SCREEN_CAPTURE_RUN_DIRECTORY");
    bool empty = true;
    do {
      const std::wstring_view name(item.cFileName);
      if (name != L"." && name != L"..") empty = false;
    } while (FindNextFileW(find, &item));
    const DWORD enumerationError = GetLastError();
    FindClose(find);
    Require(enumerationError == ERROR_NO_MORE_FILES && empty, "Run directory must be newly created and empty",
        "ERR_SCREEN_CAPTURE_RUN_DIRECTORY");
    const auto markerPath = directory + L"\\.monky-screen-capture-owner";
    marker_ = Handle(CreateFileW(markerPath.c_str(), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_NEW,
        FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    Require(static_cast<bool>(marker_), "Cannot exclusively create run ownership marker", "ERR_SCREEN_CAPTURE_RUN_DIRECTORY");
    CheckRealPath(marker_.Get(), markerPath);
    Require(FileInfo(marker_.Get()).nNumberOfLinks == 1, "Ownership marker must be ordinary", "ERR_SCREEN_CAPTURE_RUN_DIRECTORY");
    markerText_ = "{\"schemaVersion\":1,\"runId\":" + JsonString(runId) +
        ",\"helperProcessId\":" + std::to_string(GetCurrentProcessId()) +
        ",\"parentProcessId\":" + std::to_string(parentPid) + "}\n";
    WriteText(marker_.Get(), markerText_, "ERR_SCREEN_CAPTURE_RUN_DIRECTORY");
    CheckWin(FlushFileBuffers(marker_.Get()), "ERR_SCREEN_CAPTURE_RUN_DIRECTORY", "Cannot persist run ownership");
    ValidatePathEvidence({true, true, true, empty, true, markerText_.find(runId) != std::string::npos});
    CreatePrivateDirectory(L"config");
    CreatePrivateDirectory(L"data");
  }

  void Verify() const {
    CheckComponents(directory, true);
    CheckRealPath(directoryHandle_.Get(), directory);
    CheckRealPath(marker_.Get(), directory + L"\\.monky-screen-capture-owner");
    LARGE_INTEGER zero{};
    CheckWin(SetFilePointerEx(marker_.Get(), zero, nullptr, FILE_BEGIN), "ERR_SCREEN_CAPTURE_RUN_DIRECTORY", "Cannot verify ownership nonce");
    std::array<char, 1024> bytes{};
    DWORD count = 0;
    CheckWin(ReadFile(marker_.Get(), bytes.data(), static_cast<DWORD>(bytes.size()), &count, nullptr),
        "ERR_SCREEN_CAPTURE_RUN_DIRECTORY", "Cannot read ownership nonce");
    Require(std::string_view(bytes.data(), count) == markerText_, "Run ownership nonce changed", "ERR_SCREEN_CAPTURE_RUN_DIRECTORY");
  }

  void CreatePrivateDirectory(std::wstring_view relative) const {
    const auto path = directory + L"\\" + std::wstring(relative);
    CheckWin(CreateDirectoryW(path.c_str(), nullptr), "ERR_SCREEN_CAPTURE_RUN_DIRECTORY", "Cannot exclusively create private directory");
    CheckComponents(path, true);
  }

  void EnsureParents(std::wstring_view relative) const {
    EnsureDataParents(directory, relative);
  }

  std::wstring directory;
  std::string runId;
 private:
  Handle directoryHandle_, marker_;
  std::string markerText_;
};

template <typename Function>
Function Symbol(HMODULE module, const char* name) {
  const auto address = GetProcAddress(module, name);
  if (!address) throw ContractError("ERR_SCREEN_CAPTURE_ABI", std::string("Missing pinned export: ") + name);
  static_assert(sizeof(Function) == sizeof(address));
  Function function;
  std::memcpy(&function, &address, sizeof(function));
  return function;
}

struct Libraries {
  abi::Api api;
  decltype(&MonkyAv1Validate) validateAv1 = nullptr;
  // Retain every explicit image reference, search cookie, and input lock until
  // process exit. obs_shutdown alone is not evidence of driver/hook GPU drain.
  std::vector<HMODULE> images;
  std::vector<Handle> inputs;
  std::wstring captureDataDirectory;
  DLL_DIRECTORY_COOKIE cookie = nullptr;

  Handle OpenPinned(const std::wstring& path, const RuntimePin& pin, const Sha256& hash) {
    auto file = OpenRegular(path);
    Require(hash.File(file.Get(), pin.bytes) == pin.sha256,
        "Capture data SHA256 differs from its compiled pin", "ERR_SCREEN_CAPTURE_RUNTIME_INTEGRITY");
    return file;
  }

  Handle CacheCaptureData(const std::wstring& source, const RuntimePin& pin, const Sha256& hash, const OwnedRun& run) {
    EnsureDataParents(captureDataDirectory, pin.relative);
    const auto destination = captureDataDirectory + L"\\" + pin.relative;
    if (GetFileAttributesW(destination.c_str()) != INVALID_FILE_ATTRIBUTES) return OpenPinned(destination, pin, hash);
    Require(GetLastError() == ERROR_FILE_NOT_FOUND || GetLastError() == ERROR_PATH_NOT_FOUND,
        "Cannot inspect pinned capture data cache", "ERR_SCREEN_CAPTURE_RUNTIME_INTEGRITY");
    const auto staging = run.directory + L"\\hook-data-copy";
    CheckWin(CopyFileW(source.c_str(), staging.c_str(), TRUE), "ERR_SCREEN_CAPTURE_RUNTIME_INTEGRITY",
        "Cannot exclusively stage pinned capture data");
    { const auto verified = OpenPinned(staging, pin, hash); }
    if (!MoveFileExW(staging.c_str(), destination.c_str(), MOVEFILE_WRITE_THROUGH)) {
      // Another helper may have published the same pin. Never replace an image
      // that a game can still have mapped after the original helper exits.
      auto published = OpenPinned(destination, pin, hash);
      CheckWin(DeleteFileW(staging.c_str()), "ERR_SCREEN_CAPTURE_RUNTIME_INTEGRITY", "Cannot retire owned cache staging file");
      return published;
    }
    return OpenPinned(destination, pin, hash);
  }

  void VerifyAndCopy(const Arguments& arguments, const OwnedRun& run) {
    CheckComponents(arguments.runtime, true);
    captureDataDirectory = CaptureDataCacheDirectory(run.directory, kCaptureDataDigest);
    if (!CreateDirectoryW(captureDataDirectory.c_str(), nullptr) && GetLastError() != ERROR_ALREADY_EXISTS)
      CheckWin(FALSE, "ERR_SCREEN_CAPTURE_RUN_DIRECTORY", "Cannot create pinned capture data cache");
    CheckComponents(captureDataDirectory, true);
    Handle cache(CreateFileW(captureDataDirectory.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE,
        nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    Require(static_cast<bool>(cache), "Cannot bind pinned capture data cache", "ERR_SCREEN_CAPTURE_RUN_DIRECTORY");
    CheckRealPath(cache.Get(), captureDataDirectory);
    inputs.push_back(std::move(cache));
    Sha256 hash;
    for (const auto& pin : kRuntimeFiles) {
      const auto source = arguments.runtime + L"\\" + pin.relative;
      auto input = OpenRegular(source);
      Require(hash.File(input.Get(), pin.bytes) == pin.sha256, "Required stock file SHA256 differs from its pin",
          "ERR_SCREEN_CAPTURE_RUNTIME_INTEGRITY");
      inputs.push_back(std::move(input));
      const std::wstring_view relative(pin.relative);
      if (relative == L"bin\\64bit\\obs-amf-test.exe" || relative == L"bin\\64bit\\obs-nvenc-test.exe") {
        auto probe = OpenRegular(StockProbePath(HostImagePath(), relative.substr(10)));
        Require(hash.File(probe.Get(), pin.bytes) == pin.sha256,
            "Adjacent stock hardware probe differs from the compiled runtime pin", "ERR_SCREEN_CAPTURE_RUNTIME_INTEGRITY");
        inputs.push_back(std::move(probe));
      }
      if (relative.starts_with(L"data\\obs-plugins\\win-capture\\")) {
        inputs.push_back(CacheCaptureData(source, pin, hash, run));
      } else if (relative.starts_with(L"data\\")) {
        run.EnsureParents(relative);
        const auto destination = run.directory + L"\\" + pin.relative;
        CheckWin(CopyFileW(source.c_str(), destination.c_str(), TRUE), "ERR_SCREEN_CAPTURE_RUNTIME_INTEGRITY",
            "Cannot exclusively snapshot private module/core data");
        auto copy = OpenRegular(destination);
        Require(hash.File(copy.Get(), pin.bytes) == pin.sha256, "Private data snapshot SHA256 changed",
            "ERR_SCREEN_CAPTURE_RUNTIME_INTEGRITY");
        inputs.push_back(std::move(copy));
      }
    }
  }

  HMODULE LoadImage(const Arguments& arguments, const wchar_t* relative) {
    const auto path = arguments.runtime + L"\\" + relative;
    bool pinned = false;
    for (const auto& pin : kRuntimeFiles) if (std::wstring_view(pin.relative) == relative) pinned = true;
    Require(pinned, "Library is outside the compiled required-file pin set", "ERR_SCREEN_CAPTURE_RUNTIME_INTEGRITY");
    const auto image = LoadLibraryExW(path.c_str(), nullptr,
        LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32 | LOAD_LIBRARY_SEARCH_USER_DIRS);
    if (!image) throw ContractError("ERR_SCREEN_CAPTURE_LIBRARY_LOAD", "Cannot load verified private stock library: " + Hex(GetLastError()));
    images.push_back(image);
    return image;
  }

  void LoadCore(const Arguments& arguments) {
    CheckWin(SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32 | LOAD_LIBRARY_SEARCH_USER_DIRS),
        "ERR_SCREEN_CAPTURE_DLL_SEARCH", "Cannot restrict helper DLL search");
    cookie = AddDllDirectory((arguments.runtime + L"\\bin\\64bit").c_str());
    Require(cookie != nullptr, "Cannot add private stock dependency directory", "ERR_SCREEN_CAPTURE_DLL_SEARCH");
    const auto core = LoadImage(arguments, L"bin\\64bit\\obs.dll");
    if (IsAv1(arguments.encoder)) {
      const auto image = HostImagePath();
      const auto path = image.substr(0, image.find_last_of(L'\\') + 1) + L"monky_av1.dll";
      inputs.push_back(OpenPinned(path, kAv1Runtime, Sha256{}));
      const auto av1 = LoadLibraryExW(path.c_str(), nullptr,
          LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
      Require(av1 != nullptr, "Cannot load verified AV1 runtime", "ERR_SCREEN_CAPTURE_LIBRARY_LOAD");
      images.push_back(av1);
      validateAv1 = Symbol<decltype(validateAv1)>(av1, "MonkyAv1Validate");
    }
    LoadImage(arguments, L"bin\\64bit\\libobs-d3d11.dll");
    LoadImage(arguments, L"bin\\64bit\\libobs-winrt.dll");
#define LOAD_API(name) api.name = Symbol<decltype(api.name)>(core, #name)
    LOAD_API(obs_startup); LOAD_API(obs_shutdown); LOAD_API(obs_get_version_string);
    LOAD_API(base_set_log_handler); LOAD_API(obs_add_data_path);
    LOAD_API(obs_reset_video); LOAD_API(obs_get_video_info); LOAD_API(obs_get_video);
    LOAD_API(obs_get_total_frames); LOAD_API(obs_get_lagged_frames); LOAD_API(obs_nv12_tex_active);
    LOAD_API(obs_enter_graphics); LOAD_API(obs_leave_graphics); LOAD_API(gs_get_device_obj);
    LOAD_API(obs_open_module); LOAD_API(obs_init_module); LOAD_API(obs_post_load_modules); LOAD_API(obs_queue_task);
    LOAD_API(obs_get_module); LOAD_API(obs_get_module_file_name); LOAD_API(obs_get_module_binary_path);
    LOAD_API(obs_get_module_data_path); LOAD_API(obs_module_get_config_path);
    LOAD_API(obs_get_main_canvas); LOAD_API(obs_get_canvas_by_uuid); LOAD_API(obs_canvas_get_uuid);
    LOAD_API(obs_canvas_get_flags); LOAD_API(obs_canvas_release); LOAD_API(obs_canvas_get_video);
    LOAD_API(obs_canvas_get_video_info); LOAD_API(obs_canvas_set_channel); LOAD_API(obs_canvas_get_channel);
    LOAD_API(obs_load_private_source); LOAD_API(obs_obj_is_private);
    LOAD_API(obs_source_create_private); LOAD_API(obs_source_release);
    LOAD_API(obs_source_set_enabled); LOAD_API(obs_source_get_width); LOAD_API(obs_source_get_height);
    LOAD_API(obs_source_get_proc_handler); LOAD_API(obs_get_source_properties);
    LOAD_API(obs_source_get_display_name);
    LOAD_API(obs_scene_from_source); LOAD_API(obs_scene_get_source); LOAD_API(obs_scene_add);
    LOAD_API(obs_sceneitem_get_source); LOAD_API(obs_scene_release);
    LOAD_API(obs_sceneitem_set_pos); LOAD_API(obs_sceneitem_set_alignment); LOAD_API(obs_sceneitem_set_bounds_type);
    LOAD_API(obs_sceneitem_set_bounds_alignment); LOAD_API(obs_sceneitem_set_bounds);
    LOAD_API(obs_data_create); LOAD_API(obs_data_create_from_json); LOAD_API(obs_data_release); LOAD_API(obs_data_set_string);
    LOAD_API(obs_data_set_int); LOAD_API(obs_data_set_bool); LOAD_API(obs_data_get_string);
    LOAD_API(obs_data_get_int); LOAD_API(obs_data_get_bool);
    LOAD_API(obs_properties_destroy); LOAD_API(obs_properties_get); LOAD_API(obs_properties_apply_settings);
    LOAD_API(obs_property_get_type); LOAD_API(obs_property_enabled); LOAD_API(obs_property_list_format);
    LOAD_API(obs_property_list_item_count); LOAD_API(obs_property_list_item_disabled);
    LOAD_API(obs_property_list_item_string); LOAD_API(obs_property_list_item_int);
    LOAD_API(obs_property_int_min); LOAD_API(obs_property_int_max); LOAD_API(obs_property_int_step);
    LOAD_API(obs_encoder_defaults); LOAD_API(obs_get_encoder_properties); LOAD_API(obs_get_encoder_codec);
    LOAD_API(obs_get_encoder_type); LOAD_API(obs_get_encoder_caps); LOAD_API(obs_video_encoder_create);
    LOAD_API(obs_encoder_update); LOAD_API(obs_encoder_release); LOAD_API(obs_encoder_set_video); LOAD_API(obs_encoder_video);
    LOAD_API(obs_encoder_active); LOAD_API(obs_encoder_get_extra_data);
    LOAD_API(obs_encoder_get_settings); LOAD_API(obs_encoder_get_id); LOAD_API(obs_encoder_get_last_error);
    LOAD_API(obs_register_output_s); LOAD_API(obs_output_create); LOAD_API(obs_output_release);
    LOAD_API(obs_output_start); LOAD_API(obs_output_force_stop); LOAD_API(obs_output_active);
    LOAD_API(obs_output_set_video_encoder); LOAD_API(obs_output_get_video_encoder); LOAD_API(obs_output_can_begin_data_capture);
    LOAD_API(obs_output_initialize_encoders); LOAD_API(obs_output_begin_data_capture); LOAD_API(obs_output_end_data_capture);
    LOAD_API(proc_handler_call); LOAD_API(calldata_get_data); LOAD_API(calldata_get_string); LOAD_API(bfree);
    LOAD_API(ms_build_window_strings);
#undef LOAD_API
  }
};

}  // namespace
