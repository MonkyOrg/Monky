#include "nvencProbe.h"

#include <functional>
#include <iostream>

using namespace monky::screen_capture;

namespace {
unsigned checks = 0, scenarios = 0;
std::size_t maximumDiagnosticBytes = 0;
std::string scenario;

void Check(bool condition, const std::string& message) {
  ++checks;
  if (!condition) throw std::runtime_error(scenario + ": " + message);
}

template <typename Value>
struct Enumeration {
  std::vector<Value> values;
  NVENCSTATUS countStatus = NV_ENC_SUCCESS, listStatus = NV_ENC_SUCCESS;
  std::optional<std::uint32_t> announced, returned;
  unsigned countCalls = 0, listCalls = 0;
  bool writeCount = true, writeReturned = true;

  std::uint32_t Count() const {
    return announced.value_or(static_cast<std::uint32_t>(values.size()));
  }
  NVENCSTATUS QueryCount(std::uint32_t* count) {
    ++countCalls;
    if (writeCount) *count = Count();
    return countStatus;
  }
  NVENCSTATUS QueryList(Value* output, std::uint32_t capacity, std::uint32_t* count) {
    ++listCalls;
    // API 12.2 requires the size returned by its count query, not a guessed capacity.
    if (countCalls != 1 || capacity != Count()) return NV_ENC_ERR_INVALID_PARAM;
    Check(capacity <= 64, "an unbounded enumeration reached the driver");
    std::copy_n(values.begin(), (std::min)(values.size(), static_cast<std::size_t>(capacity)), output);
    if (writeReturned) *count = returned.value_or(static_cast<std::uint32_t>(values.size()));
    return listStatus;
  }
};

struct Capability {
  NV_ENC_CAPS name;
  int value;
  NVENCSTATUS status = NV_ENC_SUCCESS;
  bool writeValue = true;
};

struct Model {
  Enumeration<GUID> codecs{{NV_ENC_CODEC_HEVC_GUID, NV_ENC_CODEC_AV1_GUID, NV_ENC_CODEC_H264_GUID}};
  Enumeration<GUID> profiles{{NV_ENC_CODEC_PROFILE_AUTOSELECT_GUID, NV_ENC_H264_PROFILE_HIGH_GUID,
                             NV_ENC_H264_PROFILE_MAIN_GUID}};
  Enumeration<NV_ENC_BUFFER_FORMAT> formats{{NV_ENC_BUFFER_FORMAT_ARGB, NV_ENC_BUFFER_FORMAT_NV12}};
  std::array<Capability, 4> caps{{
    {NV_ENC_CAPS_SUPPORT_DYN_BITRATE_CHANGE, 1}, {NV_ENC_CAPS_WIDTH_MAX, 8192}, {NV_ENC_CAPS_HEIGHT_MAX, 8192},
    {NV_ENC_CAPS_LEVEL_MAX, 60},
  }};
  VideoConfiguration video{1920, 1080, 120, 5000};
  NVENCSTATUS createStatus = NV_ENC_SUCCESS, openStatus = NV_ENC_SUCCESS, destroyStatus = NV_ENC_SUCCESS;
  bool libraryAvailable = true, symbolAvailable = true, returnSession = true;
  bool sessionOnOpenFailure = false, releaseSucceeds = true;
  unsigned loads = 0, resolves = 0, releases = 0, creates = 0, opens = 0, destroys = 0;
  unsigned deviceToken = 0;
  bool sessionLive = false;
  bool av1 = false;
  std::vector<NV_ENC_CAPS> queriedCaps;
  std::function<void(NV_ENCODE_API_FUNCTION_LIST&)> changeFunctions;

  ID3D11Device* Device() { return reinterpret_cast<ID3D11Device*>(&deviceToken); }
};

Model* active = nullptr;

void Session(void* session) {
  Check(session == active && active->sessionLive, "query did not use the owned live session");
}

void H264(GUID codec) {
  const auto expected = active->av1 ? NV_ENC_CODEC_AV1_GUID : NV_ENC_CODEC_H264_GUID;
  Check(std::memcmp(&codec, &expected, sizeof(GUID)) == 0, "query selected a different codec GUID");
}

NVENCSTATUS NVENCAPI Open(NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS* parameters, void** session) {
  ++active->opens;
  Check(parameters->version == NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER &&
        parameters->apiVersion == NVENCAPI_VERSION && parameters->device == active->Device() &&
        parameters->deviceType == NV_ENC_DEVICE_TYPE_DIRECTX && !parameters->reserved,
        "the SDK version or actual D3D11 device was not retained");
  Check(std::all_of(std::begin(parameters->reserved1), std::end(parameters->reserved1),
                   [](auto value) { return value == 0; }) &&
        std::all_of(std::begin(parameters->reserved2), std::end(parameters->reserved2),
                   [](auto value) { return value == nullptr; }), "open-session reserved fields are not zero");
  if (active->returnSession && (active->openStatus == NV_ENC_SUCCESS || active->sessionOnOpenFailure)) {
    active->sessionLive = true;
    *session = active;
  }
  return active->openStatus;
}

NVENCSTATUS NVENCAPI CodecCount(void* session, std::uint32_t* count) {
  Session(session);
  return active->codecs.QueryCount(count);
}
NVENCSTATUS NVENCAPI Codecs(void* session, GUID* values, std::uint32_t capacity, std::uint32_t* count) {
  Session(session);
  return active->codecs.QueryList(values, capacity, count);
}
NVENCSTATUS NVENCAPI ProfileCount(void* session, GUID codec, std::uint32_t* count) {
  Session(session); H264(codec);
  return active->profiles.QueryCount(count);
}
NVENCSTATUS NVENCAPI Profiles(void* session, GUID codec, GUID* values, std::uint32_t capacity, std::uint32_t* count) {
  Session(session); H264(codec);
  return active->profiles.QueryList(values, capacity, count);
}
NVENCSTATUS NVENCAPI FormatCount(void* session, GUID codec, std::uint32_t* count) {
  Session(session); H264(codec);
  return active->formats.QueryCount(count);
}
NVENCSTATUS NVENCAPI Formats(void* session, GUID codec, NV_ENC_BUFFER_FORMAT* values,
                             std::uint32_t capacity, std::uint32_t* count) {
  Session(session); H264(codec);
  return active->formats.QueryList(values, capacity, count);
}
NVENCSTATUS NVENCAPI Caps(void* session, GUID codec, NV_ENC_CAPS_PARAM* parameters, int* value) {
  Session(session); H264(codec);
  Check(parameters->version == NV_ENC_CAPS_PARAM_VER &&
        std::all_of(std::begin(parameters->reserved), std::end(parameters->reserved),
                    [](auto reserved) { return reserved == 0; }), "capability query ABI differs from SDK 12.2");
  const auto found = std::find_if(active->caps.begin(), active->caps.end(),
      [&](const auto& cap) { return cap.name == parameters->capsToQuery; });
  Check(found != active->caps.end(), "unexpected capability queried");
  active->queriedCaps.push_back(found->name);
  if (found->writeValue) *value = found->value;
  return found->status;
}
NVENCSTATUS NVENCAPI Destroy(void* session) {
  Session(session);
  ++active->destroys;
  if (active->destroyStatus == NV_ENC_SUCCESS) active->sessionLive = false;
  return active->destroyStatus;
}
NVENCSTATUS NVENCAPI Create(NV_ENCODE_API_FUNCTION_LIST* functions) {
  ++active->creates;
  Check(functions->version == NV_ENCODE_API_FUNCTION_LIST_VER && functions->reserved == 0 &&
        !functions->reserved1 &&
        std::all_of(std::begin(functions->reserved2), std::end(functions->reserved2),
                    [](auto reserved) { return reserved == nullptr; }), "function-list SDK ABI was not initialized");
  functions->nvEncOpenEncodeSessionEx = &Open;
  functions->nvEncGetEncodeGUIDCount = &CodecCount;
  functions->nvEncGetEncodeGUIDs = &Codecs;
  functions->nvEncGetEncodeProfileGUIDCount = &ProfileCount;
  functions->nvEncGetEncodeProfileGUIDs = &Profiles;
  functions->nvEncGetInputFormatCount = &FormatCount;
  functions->nvEncGetInputFormats = &Formats;
  functions->nvEncGetEncodeCaps = &Caps;
  functions->nvEncDestroyEncoder = &Destroy;
  if (active->changeFunctions) active->changeFunctions(*functions);
  return active->createStatus;
}
HMODULE WINAPI Load(LPCWSTR name, HANDLE file, DWORD flags) {
  ++active->loads;
  Check(std::wstring_view(name) == L"nvEncodeAPI64.dll" && file == nullptr &&
        flags == LOAD_LIBRARY_SEARCH_SYSTEM32, "NVENC was not restricted to the system driver DLL");
  SetLastError(ERROR_MOD_NOT_FOUND);
  return active->libraryAvailable ? reinterpret_cast<HMODULE>(active) : nullptr;
}
FARPROC WINAPI Resolve(HMODULE library, LPCSTR name) {
  ++active->resolves;
  Check(library == reinterpret_cast<HMODULE>(active) && std::string_view(name) == "NvEncodeAPICreateInstance",
        "unexpected driver entry point");
  SetLastError(ERROR_PROC_NOT_FOUND);
  if (!active->symbolAvailable) return nullptr;
  auto create = &Create;
  FARPROC address = nullptr;
  static_assert(sizeof(address) == sizeof(create));
  std::memcpy(&address, &create, sizeof(address));
  return address;
}
BOOL WINAPI Release(HMODULE library) {
  ++active->releases;
  Check(library == reinterpret_cast<HMODULE>(active), "released a foreign library");
  Check(!active->sessionLive, "driver DLL was unloaded while session retirement was unconfirmed");
  SetLastError(ERROR_INVALID_HANDLE);
  return active->releaseSucceeds ? TRUE : FALSE;
}

void Run(const char* name, const std::function<void(Model&)>& configure = {},
         const std::vector<std::string>& failureParts = {},
         const std::function<void(const Model&)>& verify = {}, bool unsupported = false) {
  scenario = name;
  Model model;
  if (configure) configure(model);
  active = &model;
  bool failed = false;
  try { ProbeNvencDevice(model.Device(), model.video, {&Load, &Resolve, &Release}, model.av1); }
  catch (const ContractError& error) {
    failed = true;
    Check(error.code == (unsupported ? "ERR_SCREEN_CAPTURE_ENCODER_UNSUPPORTED" : "ERR_SCREEN_CAPTURE_NVENC_UNAVAILABLE"),
          "driver failures and proven unsupported capabilities must retain distinct categories");
    const std::string message = error.what();
    maximumDiagnosticBytes = (std::max)(maximumDiagnosticBytes, message.size());
    Check(!message.empty() && message.size() <= 1024, "error exceeds the protocol diagnostic bound");
    for (const auto& part : failureParts)
      Check(message.find(part) != std::string::npos, "missing diagnostic '" + part + "' in: " + message);
    if (failureParts.empty()) throw;
  }
  Check(failed == !failureParts.empty(), "failure became capability availability");
  Check(model.loads == 1 && model.destroys <= 1 && model.releases <= 1, "duplicate loader/session ownership");
  if (model.opens && (model.openStatus == NV_ENC_SUCCESS || model.sessionOnOpenFailure) && model.returnSession)
    Check(model.destroys == 1, "owned session was not retired on exit");
  if (model.libraryAvailable && !model.sessionLive) Check(model.releases == 1, "owned DLL was not released");
  if (model.sessionLive) Check(model.releases == 0, "unretired driver ownership was lost");
  if (verify) verify(model);
  active = nullptr;
  ++scenarios;
}
}  // namespace

int main() {
  try {
    static_assert(NVENCAPI_MAJOR_VERSION == 12 && NVENCAPI_MINOR_VERSION == 2);
    static_assert(sizeof(GUID) == 16 && sizeof(NV_ENC_CAPS_PARAM) == 256);
    Run("count-first H264/Main/NV12 admission", {}, {}, [](const Model& model) {
      Check(model.codecs.countCalls == 1 && model.codecs.listCalls == 1 &&
            model.profiles.countCalls == 1 && model.profiles.listCalls == 1 &&
            model.formats.countCalls == 1 && model.formats.listCalls == 1, "enumeration was skipped or guessed");
      Check(model.queriedCaps == std::vector<NV_ENC_CAPS>{
        NV_ENC_CAPS_SUPPORT_DYN_BITRATE_CHANGE, NV_ENC_CAPS_WIDTH_MAX, NV_ENC_CAPS_HEIGHT_MAX, NV_ENC_CAPS_LEVEL_MAX},
        "capability queries were skipped or reordered");
    });
    Run("4K120 Level6 device admission", [](Model& model) { model.video = {3840, 2160, 120, 80000}; });
    Run("4K120 refuses Level5.2-only hardware", [](Model& model) {
      model.video = {3840, 2160, 120, 80000}; model.caps[3].value = 52;
    }, {"NV_ENC_CAPS_LEVEL_MAX", "value=52", "required=60"}, {}, true);
    Run("1080p120 retains Level5.1 hardware admission", [](Model& model) { model.caps[3].value = 51; });
    Run("missing H264 is not a failed cap call", [](Model& model) { model.codecs.values.pop_back(); },
        {"nvEncGetEncodeGUIDs", "H264=0", "status=0"}, [](const Model& model) {
      Check(model.profiles.countCalls == 0 && model.formats.countCalls == 0 && model.queriedCaps.empty(),
            "queries continued without a confirmed H264 GUID");
    }, true);
    Run("AV1 uses its own codec and profile GUIDs", [](Model& model) {
      model.av1 = true; model.profiles.values = {NV_ENC_AV1_PROFILE_MAIN_GUID};
    }, {}, [](const Model& model) {
      Check(model.queriedCaps.size() == 3 &&
          std::find(model.queriedCaps.begin(), model.queriedCaps.end(), NV_ENC_CAPS_LEVEL_MAX) == model.queriedCaps.end(),
          "AV1 must not apply H264 level-idc queries");
    });
    Run("missing AV1 is explicitly unsupported", [](Model& model) {
      model.av1 = true; model.codecs.values = {NV_ENC_CODEC_H264_GUID};
    }, {"AV1=0"}, {}, true);
    Run("maximum bounded enumeration", [](Model& model) {
      model.codecs.values.assign(64, GUID{}); model.codecs.values.back() = NV_ENC_CODEC_H264_GUID;
      model.profiles.values.assign(64, GUID{}); model.profiles.values.back() = NV_ENC_H264_PROFILE_MAIN_GUID;
      model.formats.values.assign(64, NV_ENC_BUFFER_FORMAT_UNDEFINED);
      model.formats.values.back() = NV_ENC_BUFFER_FORMAT_NV12;
    });
    Run("only returned entries are examined", [](Model& model) {
      std::reverse(model.codecs.values.begin(), model.codecs.values.end()); model.codecs.returned = 1;
      std::reverse(model.profiles.values.begin(), model.profiles.values.end()); model.profiles.returned = 1;
      std::reverse(model.formats.values.begin(), model.formats.values.end()); model.formats.returned = 1;
    });
    for (unsigned kind = 0; kind < 3; ++kind) {
      const auto countName = kind == 0 ? "nvEncGetEncodeGUIDCount" :
          kind == 1 ? "nvEncGetEncodeProfileGUIDCount" : "nvEncGetInputFormatCount";
      const auto listName = kind == 0 ? "nvEncGetEncodeGUIDs" :
          kind == 1 ? "nvEncGetEncodeProfileGUIDs" : "nvEncGetInputFormats";
      const auto change = [kind](Model& model, auto configure) {
        if (kind == 0) configure(model.codecs);
        else if (kind == 1) configure(model.profiles);
        else configure(model.formats);
      };
      Run("enumeration count status", [&](Model& model) {
        change(model, [](auto& value) { value.countStatus = NV_ENC_ERR_INVALID_PARAM; });
      }, {countName, "NV_ENC_ERR_INVALID_PARAM", "status=8", "count="});
      Run("enumeration list status", [&](Model& model) {
        change(model, [](auto& value) { value.listStatus = NV_ENC_ERR_INVALID_VERSION; });
      }, {listName, "NV_ENC_ERR_INVALID_VERSION", "status=15", "returned="});
      for (const auto count : {0u, 65u, (std::numeric_limits<std::uint32_t>::max)()})
        Run("bounded enumeration count", [&](Model& model) {
          change(model, [&](auto& value) { value.announced = count; });
        }, {countName, "status=0", "count=" + std::to_string(count)});
      Run("successful count without output", [&](Model& model) {
        change(model, [](auto& value) { value.writeCount = false; });
      }, {countName, "status=0", "count=0"});
      for (const auto count : {0u, 65u})
        Run("bounded returned enumeration", [&](Model& model) {
          change(model, [&](auto& value) { value.returned = count; });
        }, {listName, "status=0", "returned=" + std::to_string(count)});
      Run("successful list without output", [&](Model& model) {
        change(model, [](auto& value) { value.writeReturned = false; });
      }, {listName, "status=0", "returned=0"});
      Run("returned count exceeds announced count but fits backing array", [&](Model& model) {
        change(model, [](auto& value) { value.returned = value.Count() + 1; });
      }, {listName, "status=0", "capacity=", "returned="});
    }
    Run("unreturned GUID is not support", [](Model& model) { model.codecs.returned = 2; },
        {"nvEncGetEncodeGUIDs", "returned=2", "H264=0"}, {}, true);
    Run("missing Main profile", [](Model& model) { model.profiles.values.pop_back(); },
        {"nvEncGetEncodeProfileGUIDs", "Main=0"}, {}, true);
    Run("missing NV12 input", [](Model& model) { model.formats.values.pop_back(); },
        {"nvEncGetInputFormats", "NV12=0"}, {}, true);
    for (unsigned index = 0; index < 4; ++index) {
      const auto name = index == 0 ? "NV_ENC_CAPS_SUPPORT_DYN_BITRATE_CHANGE" :
          index == 1 ? "NV_ENC_CAPS_WIDTH_MAX" : index == 2 ? "NV_ENC_CAPS_HEIGHT_MAX" : "NV_ENC_CAPS_LEVEL_MAX";
      Run("capability API status and returned value", [&](Model& model) {
        model.caps[index].status = NV_ENC_ERR_UNSUPPORTED_PARAM; model.caps[index].value = 73;
      }, {"nvEncGetEncodeCaps", name, "NV_ENC_ERR_UNSUPPORTED_PARAM", "status=12", "value=73",
          "H264=1", "Main=1", "NV12=1"});
      Run("negative successful capability value", [&](Model& model) { model.caps[index].value = -9; },
          {name, "status=0", "value=-9"});
      Run("successful capability without output", [&](Model& model) { model.caps[index].writeValue = false; },
          {name, "status=0", "value=-1"});
      Run("unsupported required capability", [&](Model& model) { model.caps[index].value = 0; },
          {name, "status=0", "value=0"}, {}, true);
    }
    Run("insufficient maximum width", [](Model& model) { model.caps[1].value = 1280; },
        {"NV_ENC_CAPS_WIDTH_MAX", "value=1280", "required=1920"}, {}, true);
    Run("insufficient maximum height", [](Model& model) { model.caps[2].value = 720; },
        {"NV_ENC_CAPS_HEIGHT_MAX", "value=720", "required=1080"}, {}, true);
    Run("unknown driver status remains a numeric failure", [](Model& model) {
      model.caps[0].status = static_cast<NVENCSTATUS>(31);
    }, {"nvEncGetEncodeCaps", "status=31", "unknown NVENCSTATUS", "value=1"});
    Run("missing driver DLL", [](Model& model) { model.libraryAvailable = false; },
        {"LoadLibraryExW", "win32=126"});
    Run("missing create entry point", [](Model& model) { model.symbolAvailable = false; },
        {"NvEncodeAPICreateInstance", "win32=127"});
    Run("unsupported SDK function list", [](Model& model) { model.createStatus = NV_ENC_ERR_INVALID_VERSION; },
        {"NvEncodeAPICreateInstance", "status=15", "NV_ENC_ERR_INVALID_VERSION", "api=12.2"});
    Run("driver session refusal", [](Model& model) { model.openStatus = NV_ENC_ERR_UNSUPPORTED_DEVICE; },
        {"nvEncOpenEncodeSessionEx", "status=2", "NV_ENC_ERR_UNSUPPORTED_DEVICE"}, {}, true);
    Run("successful open without session", [](Model& model) { model.returnSession = false; },
        {"nvEncOpenEncodeSessionEx", "status=0", "session=0"});
    Run("failed open still owns returned session", [](Model& model) {
      model.openStatus = NV_ENC_ERR_GENERIC; model.sessionOnOpenFailure = true;
    }, {"nvEncOpenEncodeSessionEx", "status=20", "session=1"});
    const std::array<std::pair<const char*, std::function<void(NV_ENCODE_API_FUNCTION_LIST&)>>, 9> missing{{
      {"nvEncOpenEncodeSessionEx", [](auto& functions) { functions.nvEncOpenEncodeSessionEx = nullptr; }},
      {"nvEncGetEncodeGUIDCount", [](auto& functions) { functions.nvEncGetEncodeGUIDCount = nullptr; }},
      {"nvEncGetEncodeGUIDs", [](auto& functions) { functions.nvEncGetEncodeGUIDs = nullptr; }},
      {"nvEncGetEncodeProfileGUIDCount", [](auto& functions) { functions.nvEncGetEncodeProfileGUIDCount = nullptr; }},
      {"nvEncGetEncodeProfileGUIDs", [](auto& functions) { functions.nvEncGetEncodeProfileGUIDs = nullptr; }},
      {"nvEncGetInputFormatCount", [](auto& functions) { functions.nvEncGetInputFormatCount = nullptr; }},
      {"nvEncGetInputFormats", [](auto& functions) { functions.nvEncGetInputFormats = nullptr; }},
      {"nvEncGetEncodeCaps", [](auto& functions) { functions.nvEncGetEncodeCaps = nullptr; }},
      {"nvEncDestroyEncoder", [](auto& functions) { functions.nvEncDestroyEncoder = nullptr; }},
    }};
    for (const auto& [name, change] : missing)
      Run("missing required API", [&](Model& model) { model.changeFunctions = change; },
          {name, "missing"}, [](const Model& model) { Check(model.opens == 0, "session opened with incomplete API"); });
    Run("destroy refusal cannot become success", [](Model& model) { model.destroyStatus = NV_ENC_ERR_GENERIC; },
        {"nvEncDestroyEncoder", "status=20", "retirement=unconfirmed"});
    Run("unsupported AV1 with failed retirement is a driver error", [](Model& model) {
      model.av1 = true; model.codecs.values = {NV_ENC_CODEC_H264_GUID};
      model.destroyStatus = NV_ENC_ERR_GENERIC;
    }, {"AV1=0", "nvEncDestroyEncoder", "retirement=unconfirmed"});
    Run("unsupported AV1 with failed DLL release is a driver error", [](Model& model) {
      model.av1 = true; model.codecs.values = {NV_ENC_CODEC_H264_GUID};
      model.releaseSucceeds = false;
    }, {"AV1=0", "FreeLibrary", "win32=6"});
    Run("primary failure retained when destroy fails", [](Model& model) {
      model.caps[1].status = NV_ENC_ERR_INVALID_PARAM; model.caps[1].value = -9;
      model.destroyStatus = NV_ENC_ERR_GENERIC;
    }, {"nvEncGetEncodeCaps", "NV_ENC_CAPS_WIDTH_MAX", "status=8", "value=-9",
        "nvEncDestroyEncoder", "status=20", "retirement=unconfirmed"});
    Run("DLL release refusal cannot become success", [](Model& model) { model.releaseSucceeds = false; },
        {"FreeLibrary", "win32=6"});
    Run("primary failure retained when DLL release fails", [](Model& model) {
      model.codecs.listStatus = NV_ENC_ERR_INVALID_PARAM; model.releaseSucceeds = false;
    }, {"nvEncGetEncodeGUIDs", "status=8", "FreeLibrary", "win32=6"});
    std::cout << "{\"deviceFree\":true,\"modeledApi\":true,\"sdkMajor\":12,\"sdkMinor\":2,\"checks\":"
              << checks << ",\"scenarios\":" << scenarios << ",\"maximumDiagnosticBytes\":"
              << maximumDiagnosticBytes << "}\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << scenario << ": " << error.what() << '\n';
    return 1;
  }
}
