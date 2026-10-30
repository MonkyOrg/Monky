// Runs a program attached to a console that is never shown, and closes that
// console on request, as a user closing its window does. Windows then delivers
// CTRL_CLOSE_EVENT on a thread of its own, holding the lock that guards the
// handler list, and ends the process once the handler returns: a test that
// calls the handler itself reproduces neither.
//
// monky-light-console-host [--console-stdio] <program> [arguments...]
//   Lines on stdin go to the program, except "#close", which closes the
//   console, "#close-abruptly", which closes it as Windows 10 and Windows
//   Server 2022 do, and "#interrupt", which types Ctrl+C into it. The program
//   writes to the host's stdout and stderr; with --console-stdio it uses the
//   console for all three, and the host prints what the console renders. The
//   host exits with the program's exit code.
//
// Closed, the console server of current Windows sends CTRL_CLOSE_EVENT and
// goes on serving the console until its programs exit. Before
// microsoft/terminal#14282 (Windows 10, Windows Server 2022) it sent the event
// and exited at once: a program may get the event before or after its console
// stops working, and anything it then reads or writes there fails.
// "#close-abruptly" ends the server before it sends the event at all.

#ifndef NOMINMAX
#define NOMINMAX
#endif
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <tlhelp32.h>

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdio>
#include <cwchar>
#include <mutex>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

namespace {

constexpr int kHostFailure = 125;

int fail(const char* step) {
  std::fprintf(stderr, "console host: %s failed (%lu)\n", step, GetLastError());
  return kHostFailure;
}

// The quoting that CommandLineToArgvW and the C runtime both undo.
std::wstring quote(const std::wstring& argument) {
  if (!argument.empty() && argument.find_first_of(L" \t\n\v\"") == std::wstring::npos) return argument;
  std::wstring result = L"\"";
  for (auto at = argument.begin();; ++at) {
    std::size_t slashes = 0;
    while (at != argument.end() && *at == L'\\') {
      ++at;
      ++slashes;
    }
    if (at == argument.end()) {
      result.append(slashes * 2, L'\\');
      break;
    }
    result.append(*at == L'"' ? slashes * 2 + 1 : slashes, L'\\');
    result.push_back(*at);
  }
  result.push_back(L'"');
  return result;
}

bool writeAll(HANDLE target, std::string_view bytes) {
  while (!bytes.empty()) {
    DWORD written = 0;
    if (!WriteFile(target, bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr)) return false;
    bytes.remove_prefix(written);
  }
  return true;
}

// The console servers running as children of this host. CreatePseudoConsole
// starts one, so the new entry after it is the one serving the program.
std::vector<DWORD> consoleServers() {
  std::vector<DWORD> result;
  const auto snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) return result;
  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof(entry);
  for (auto more = Process32FirstW(snapshot, &entry); more; more = Process32NextW(snapshot, &entry)) {
    if (entry.th32ParentProcessID == GetCurrentProcessId() &&
        (_wcsicmp(entry.szExeFile, L"conhost.exe") == 0 || _wcsicmp(entry.szExeFile, L"OpenConsole.exe") == 0)) {
      result.push_back(entry.th32ProcessID);
    }
  }
  CloseHandle(snapshot);
  return result;
}

HANDLE inheritable(HANDLE source) {
  HANDLE result = nullptr;
  if (!DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), &result, 0, TRUE,
                       DUPLICATE_SAME_ACCESS)) {
    return nullptr;
  }
  return result;
}

}  // namespace

int wmain(int argc, wchar_t* argv[]) {
  int first = 1;
  const bool consoleStdio = argc > first && std::wstring_view(argv[first]) == L"--console-stdio";
  if (consoleStdio) ++first;
  if (argc <= first) {
    std::fprintf(stderr, "usage: monky-light-console-host [--console-stdio] <program> [arguments...]\n");
    return kHostFailure;
  }
  std::wstring commandLine;
  for (int index = first; index < argc; ++index) {
    if (!commandLine.empty()) commandLine.push_back(L' ');
    commandLine += quote(argv[index]);
  }

  HANDLE consoleInput = nullptr;
  HANDLE typed = nullptr;
  HANDLE rendered = nullptr;
  HANDLE consoleOutput = nullptr;
  if (!CreatePipe(&consoleInput, &typed, nullptr, 0) || !CreatePipe(&rendered, &consoleOutput, nullptr, 0)) {
    return fail("CreatePipe");
  }
  HPCON console = nullptr;
  const auto running = consoleServers();
  if (FAILED(CreatePseudoConsole(COORD{120, 40}, consoleInput, consoleOutput, 0, &console))) {
    return fail("CreatePseudoConsole");
  }
  CloseHandle(consoleInput);
  CloseHandle(consoleOutput);
  HANDLE server = nullptr;
  for (const auto id : consoleServers()) {
    if (std::find(running.begin(), running.end(), id) == running.end()) {
      server = OpenProcess(PROCESS_TERMINATE | SYNCHRONIZE, FALSE, id);
      break;
    }
  }

  SIZE_T size = 0;
  InitializeProcThreadAttributeList(nullptr, 2, 0, &size);
  std::vector<std::byte> storage(size);
  const auto attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
  if (!InitializeProcThreadAttributeList(attributes, 2, 0, &size) ||
      !UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, console, sizeof(console),
                                 nullptr, nullptr)) {
    return fail("PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE");
  }
  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.lpAttributeList = attributes;
  // Without handles of its own, a console program receives the redirected ones
  // of whoever starts it, even uninherited: none at all leaves it the console's.
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  HANDLE relay = nullptr;
  std::array<HANDLE, 3> inherited{};
  if (!consoleStdio) {
    SECURITY_ATTRIBUTES inherit{sizeof(inherit), nullptr, TRUE};
    if (!CreatePipe(&inherited[0], &relay, &inherit, 0) || !SetHandleInformation(relay, HANDLE_FLAG_INHERIT, 0)) {
      return fail("CreatePipe for the program's input");
    }
    inherited[1] = inheritable(GetStdHandle(STD_OUTPUT_HANDLE));
    inherited[2] = inheritable(GetStdHandle(STD_ERROR_HANDLE));
    if (!inherited[1] || !inherited[2]) return fail("DuplicateHandle");
    // Only the three standard handles, never whatever else this host holds.
    if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited.data(),
                                   sizeof(inherited), nullptr, nullptr)) {
      return fail("PROC_THREAD_ATTRIBUTE_HANDLE_LIST");
    }
    startup.StartupInfo.hStdInput = inherited[0];
    startup.StartupInfo.hStdOutput = inherited[1];
    startup.StartupInfo.hStdError = inherited[2];
  }

  // A test that gives up on the host must not leave the program behind.
  const auto job = CreateJobObjectW(nullptr, nullptr);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!job || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
    return fail("CreateJobObject");
  }
  PROCESS_INFORMATION program{};
  if (!CreateProcessW(nullptr, commandLine.data(), nullptr, nullptr, consoleStdio ? FALSE : TRUE,
                      EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, nullptr,
                      nullptr, &startup.StartupInfo, &program)) {
    return fail("CreateProcess");
  }
  DeleteProcThreadAttributeList(attributes);
  for (const auto handle : inherited) {
    if (handle) CloseHandle(handle);
  }
  if (!AssignProcessToJobObject(job, program.hProcess) || ResumeThread(program.hThread) == static_cast<DWORD>(-1)) {
    TerminateProcess(program.hProcess, kHostFailure);
    return fail("Starting the program in its job");
  }
  CloseHandle(program.hThread);

  std::once_flag closing;
  const auto closeConsole = [&] { std::call_once(closing, [&] { ClosePseudoConsole(console); }); };
  // The console blocks once nobody reads what it renders, so it is always read.
  const auto output = GetStdHandle(STD_OUTPUT_HANDLE);
  std::thread drain([&] {
    std::array<char, 4096> bytes{};
    DWORD count = 0;
    while (ReadFile(rendered, bytes.data(), static_cast<DWORD>(bytes.size()), &count, nullptr) && count > 0) {
      if (consoleStdio) writeAll(output, std::string_view(bytes.data(), count));
    }
  });
  std::thread commands([&] {
    const auto input = GetStdHandle(STD_INPUT_HANDLE);
    std::string pending;
    std::array<char, 4096> bytes{};
    DWORD count = 0;
    while (ReadFile(input, bytes.data(), static_cast<DWORD>(bytes.size()), &count, nullptr) && count > 0) {
      pending.append(bytes.data(), count);
      for (auto end = pending.find('\n'); end != std::string::npos; end = pending.find('\n')) {
        const auto line = pending.substr(0, end + 1);
        pending.erase(0, end + 1);
        const auto command = std::string_view(line).substr(0, line.find_last_not_of("\r\n") + 1);
        if (command == "#close") {
          // Both ends go, as when a terminal closes its tab.
          if (typed) CloseHandle(std::exchange(typed, nullptr));
          closeConsole();
        } else if (command == "#close-abruptly") {
          // The server goes first, so the program learns of the close only from
          // its console failing: the order a late CTRL_CLOSE_EVENT leaves it in.
          if (!server) {
            // The job takes the program along.
            std::fprintf(stderr, "console host: the console server was not found\n");
            ExitProcess(kHostFailure);
          }
          TerminateProcess(server, ERROR_BROKEN_PIPE);
          WaitForSingleObject(server, 5000);
          if (typed) CloseHandle(std::exchange(typed, nullptr));
          closeConsole();
        } else if (command == "#interrupt") {
          if (typed) writeAll(typed, "\x03");
        } else if (relay) {
          writeAll(relay, line);
        } else if (typed) {
          writeAll(typed, line);
        }
      }
    }
    // The end of the host's input is the end of the program's, as without a host.
    if (relay) CloseHandle(std::exchange(relay, nullptr));
  });

  WaitForSingleObject(program.hProcess, INFINITE);
  DWORD exitCode = kHostFailure;
  GetExitCodeProcess(program.hProcess, &exitCode);
  CloseHandle(program.hProcess);
  // The controller may keep the host's input open. Cancellation can race the
  // next blocking read, so it is repeated until the thread is gone.
  while (WaitForSingleObject(commands.native_handle(), 0) == WAIT_TIMEOUT) {
    CancelSynchronousIo(commands.native_handle());
    WaitForSingleObject(commands.native_handle(), 10);
  }
  commands.join();
  if (relay) CloseHandle(relay);
  if (typed) CloseHandle(typed);
  closeConsole();
  drain.join();
  CloseHandle(rendered);
  if (server) CloseHandle(server);
  CloseHandle(job);
  return static_cast<int>(exitCode);
}
