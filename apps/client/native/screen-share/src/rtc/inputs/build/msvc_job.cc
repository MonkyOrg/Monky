#include <Windows.h>

#include <cwchar>
#include <iostream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace {

class Handle {
 public:
  explicit Handle(HANDLE value = nullptr) : value_(value) {}
  ~Handle() { Reset(); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  Handle(Handle&& other) noexcept : value_(std::exchange(other.value_, nullptr)) {}
  void Reset() {
    if (value_ && value_ != INVALID_HANDLE_VALUE) CloseHandle(std::exchange(value_, nullptr));
  }
  HANDLE get() const { return value_; }
 private:
  HANDLE value_;
};

void Require(BOOL success, const char* operation) {
  if (!success) throw std::runtime_error(std::string(operation) + " failed: " + std::to_string(GetLastError()));
}

std::wstring Quote(const wchar_t* argument) {
  std::wstring result = L"\"";
  size_t slashes = 0;
  for (const wchar_t* current = argument; *current; ++current) {
    if (*current == L'\\') { ++slashes; continue; }
    result.append(slashes * (*current == L'\"' ? 2 : 1), L'\\');
    if (*current == L'\"') result += L'\\';
    result += *current;
    slashes = 0;
  }
  result.append(slashes * 2, L'\\');
  return result + L'\"';
}

struct Pids {
  DWORD assigned;
  DWORD count;
  ULONG_PTR ids[128];
};

std::vector<DWORD> Remaining(HANDLE job) {
  Pids list{};
  Require(QueryInformationJobObject(job, JobObjectBasicProcessIdList, &list, sizeof(list), nullptr),
          "Query private compiler job");
  if (list.count > 128) throw std::runtime_error("Compiler process bound exceeded");
  return std::vector<DWORD>(list.ids, list.ids + list.count);
}

std::wstring Image(HANDLE process) {
  wchar_t path[4096];
  DWORD count = 4096;
  Require(QueryFullProcessImageNameW(process, 0, path, &count), "Identify owned compiler helper");
  return std::wstring(path, count);
}

int Run(int argc, wchar_t** argv) {
  if (argc < 4) throw std::runtime_error("Usage: msvc_job.exe <verified compiler bin> <MSBuild.exe> <arguments>");
  const std::wstring compiler_bin = argv[1];
  const std::wstring expected_helper = compiler_bin + L"\\vctip.exe";
  std::wstring command;
  for (int index = 2; index < argc; ++index) {
    if (!command.empty()) command += L' ';
    command += Quote(argv[index]);
  }
  Handle job(CreateJobObjectW(nullptr, nullptr));
  if (!job.get()) throw std::runtime_error("Cannot create private compiler job");
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  Require(SetInformationJobObject(job.get(), JobObjectExtendedLimitInformation, &limits, sizeof(limits)),
          "Configure private compiler job");
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  PROCESS_INFORMATION process{};
  Require(CreateProcessW(argv[2], command.data(), nullptr, nullptr, TRUE,
                         CREATE_SUSPENDED | CREATE_NO_WINDOW, nullptr, nullptr, &startup, &process),
          "Launch owned MSBuild suspended");
  Handle main_process(process.hProcess), main_thread(process.hThread);
  if (!AssignProcessToJobObject(job.get(), main_process.get())) {
    const DWORD error = GetLastError();
    TerminateProcess(main_process.get(), 125);
    WaitForSingleObject(main_process.get(), INFINITE);
    throw std::runtime_error("Assign private compiler job failed: " + std::to_string(error));
  }
  Require(ResumeThread(main_thread.get()) != static_cast<DWORD>(-1), "Resume owned MSBuild");
  Require(WaitForSingleObject(main_process.get(), INFINITE) == WAIT_OBJECT_0, "Wait for owned MSBuild");
  DWORD code = 0;
  Require(GetExitCodeProcess(main_process.get(), &code), "Read MSBuild result");
  if (code != 0) return static_cast<int>(code);

  const ULONGLONG deadline = GetTickCount64() + 2000;
  auto remaining = Remaining(job.get());
  while (!remaining.empty() && GetTickCount64() < deadline) {
    Sleep(25);
    remaining = Remaining(job.get());
  }
  std::vector<Handle> helpers;
  std::vector<DWORD> helper_ids;
  for (const DWORD pid : remaining) {
    Handle helper(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid));
    if (!helper.get()) {
      if (GetLastError() == ERROR_INVALID_PARAMETER) continue;
      throw std::runtime_error("Cannot open an owned compiler helper");
    }
    BOOL belongs = FALSE;
    Require(IsProcessInJob(helper.get(), job.get(), &belongs), "Verify compiler helper ownership");
    if (!belongs) continue;
    const auto alive = WaitForSingleObject(helper.get(), 0);
    if (alive == WAIT_OBJECT_0) continue;
    Require(alive == WAIT_TIMEOUT, "Observe owned compiler helper");
    const auto image = Image(helper.get());
    if (_wcsicmp(image.c_str(), expected_helper.c_str()) != 0) {
      std::wcerr << L"Unexpected live descendant in private MSBuild job: " << image << L"\n";
      return 125;
    }
    helper_ids.push_back(pid);
    helpers.push_back(std::move(helper));
  }
  // VCTIP is a persistent compiler telemetry service. End ONLY this command's
  // verified instance with its private job, never a process-name/global kill.
  job.Reset();
  for (const auto& helper : helpers) {
    Require(WaitForSingleObject(helper.get(), 5000) == WAIT_OBJECT_0, "Retire owned compiler helper");
  }
  std::cout << "MONKY_MSVC_CLEANUP {\"msbuildExitCode\":0,\"ownedVctipTerminated\":[";
  for (size_t index = 0; index < helper_ids.size(); ++index) {
    if (index) std::cout << ',';
    std::cout << helper_ids[index];
  }
  std::cout << "],\"remainingOwnedHelpers\":0}\n";
  return 0;
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  try {
    return Run(argc, argv);
  } catch (const std::exception& error) {
    std::cerr << "ERR_RTC_MSVC_JOB: " << error.what() << '\n';
    return 125;
  }
}
