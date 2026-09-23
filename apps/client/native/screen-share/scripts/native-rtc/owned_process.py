"""Run an explicitly selected tool in a private kill-on-close Windows job."""

import argparse
import ctypes
from ctypes import wintypes
import json
import os
import subprocess
import sys
import time


SIZE_T = ctypes.c_size_t
LARGE_INTEGER = ctypes.c_longlong


class BasicLimit(ctypes.Structure):
    _fields_ = [("PerProcessUserTimeLimit", LARGE_INTEGER), ("PerJobUserTimeLimit", LARGE_INTEGER),
                ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", SIZE_T),
                ("MaximumWorkingSetSize", SIZE_T), ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", SIZE_T), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)]


class IoCounters(ctypes.Structure):
    _fields_ = [(name, ctypes.c_ulonglong) for name in
                ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                 "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]


class ExtendedLimit(ctypes.Structure):
    _fields_ = [("BasicLimitInformation", BasicLimit), ("IoInfo", IoCounters),
                ("ProcessMemoryLimit", SIZE_T), ("JobMemoryLimit", SIZE_T),
                ("PeakProcessMemoryUsed", SIZE_T), ("PeakJobMemoryUsed", SIZE_T)]


class Accounting(ctypes.Structure):
    _fields_ = [("TotalUserTime", LARGE_INTEGER), ("TotalKernelTime", LARGE_INTEGER),
                ("ThisPeriodTotalUserTime", LARGE_INTEGER), ("ThisPeriodTotalKernelTime", LARGE_INTEGER),
                ("TotalPageFaultCount", wintypes.DWORD), ("TotalProcesses", wintypes.DWORD),
                ("ActiveProcesses", wintypes.DWORD), ("TotalTerminatedProcesses", wintypes.DWORD)]


class StartupInfo(ctypes.Structure):
    _fields_ = [("cb", wintypes.DWORD), ("lpReserved", wintypes.LPWSTR), ("lpDesktop", wintypes.LPWSTR),
                ("lpTitle", wintypes.LPWSTR), ("dwX", wintypes.DWORD), ("dwY", wintypes.DWORD),
                ("dwXSize", wintypes.DWORD), ("dwYSize", wintypes.DWORD),
                ("dwXCountChars", wintypes.DWORD), ("dwYCountChars", wintypes.DWORD),
                ("dwFillAttribute", wintypes.DWORD), ("dwFlags", wintypes.DWORD),
                ("wShowWindow", wintypes.WORD), ("cbReserved2", wintypes.WORD),
                ("lpReserved2", ctypes.c_void_p), ("hStdInput", wintypes.HANDLE),
                ("hStdOutput", wintypes.HANDLE), ("hStdError", wintypes.HANDLE)]


class ProcessInfo(ctypes.Structure):
    _fields_ = [("hProcess", wintypes.HANDLE), ("hThread", wintypes.HANDLE),
                ("dwProcessId", wintypes.DWORD), ("dwThreadId", wintypes.DWORD)]


def api():
    kernel = ctypes.WinDLL("kernel32.dll", winmode=0x00000800, use_last_error=True)
    definitions = {
        "CreateJobObjectW": ([ctypes.c_void_p, wintypes.LPCWSTR], wintypes.HANDLE),
        "SetInformationJobObject": ([wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD], wintypes.BOOL),
        "QueryInformationJobObject": ([wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD,
                                      ctypes.POINTER(wintypes.DWORD)], wintypes.BOOL),
        "AssignProcessToJobObject": ([wintypes.HANDLE, wintypes.HANDLE], wintypes.BOOL),
        "CreateProcessW": ([wintypes.LPCWSTR, wintypes.LPWSTR, ctypes.c_void_p, ctypes.c_void_p,
                           wintypes.BOOL, wintypes.DWORD, ctypes.c_void_p, wintypes.LPCWSTR,
                           ctypes.POINTER(StartupInfo), ctypes.POINTER(ProcessInfo)], wintypes.BOOL),
        "GetStdHandle": ([wintypes.DWORD], wintypes.HANDLE),
        "GetFileType": ([wintypes.HANDLE], wintypes.DWORD),
        "SetHandleInformation": ([wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD], wintypes.BOOL),
        "CreateFileW": ([wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p,
                        wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE], wintypes.HANDLE),
        "ResumeThread": ([wintypes.HANDLE], wintypes.DWORD),
        "WaitForSingleObject": ([wintypes.HANDLE, wintypes.DWORD], wintypes.DWORD),
        "GetExitCodeProcess": ([wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)], wintypes.BOOL),
        "TerminateProcess": ([wintypes.HANDLE, wintypes.UINT], wintypes.BOOL),
        "PeekNamedPipe": ([wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p,
                           ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p], wintypes.BOOL),
        "CloseHandle": ([wintypes.HANDLE], wintypes.BOOL),
    }
    for name, (arguments, result) in definitions.items():
        function = getattr(kernel, name)
        function.argtypes = arguments
        function.restype = result
    return kernel


def checked(value, message):
    if not value:
        raise OSError(ctypes.get_last_error(), message)
    return value


def parent_pipe_alive(kernel, pipe):
    available = wintypes.DWORD()
    if kernel.PeekNamedPipe(pipe, None, 0, None, ctypes.byref(available), None):
        if available.value:
            raise ValueError("The guardian stdin pipe is a lifetime signal, not a tool input channel")
        return True
    error = ctypes.get_last_error()
    if error in (109, 233):
        return False
    raise OSError(error, "Cannot inspect the owned parent lifetime pipe")


def run(arguments):
    if sys.platform != "win32" or ctypes.sizeof(ctypes.c_void_p) != 8:
        raise ValueError("The process guardian requires Windows x64")
    command = arguments.command
    if command and command[0] == "--":
        command = command[1:]
    if not command or not os.path.isabs(command[0]) or not command[0].lower().endswith(".exe"):
        raise ValueError("An absolute .exe and separate argument vector are required; no shell is supported")
    if not os.path.isabs(arguments.cwd) or not 1 <= arguments.timeout_seconds <= 7200:
        raise ValueError("Invalid working directory or command deadline")
    kernel = api()
    invalid = ctypes.c_void_p(-1).value
    guardian_input = kernel.GetStdHandle(wintypes.DWORD(-10))
    if not guardian_input or guardian_input == invalid or kernel.GetFileType(guardian_input) != 3:
        raise ValueError("A private parent lifetime pipe is required")
    checked(kernel.SetHandleInformation(guardian_input, 1, 0), "Cannot isolate guardian stdin")
    job = None
    null_input = None
    process = ProcessInfo()
    assigned = False
    try:
        job = checked(kernel.CreateJobObjectW(None, None), "Cannot create private process job")
        limits = ExtendedLimit()
        limits.BasicLimitInformation.LimitFlags = 0x00002000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.
        checked(kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)),
                "Cannot configure kill-on-close ownership")
        null_input = kernel.CreateFileW("NUL", 0x80000000, 3, None, 3, 0, None)
        if not null_input or null_input == invalid:
            raise OSError(ctypes.get_last_error(), "Cannot create noninteractive tool stdin")
        startup = StartupInfo()
        startup.cb = ctypes.sizeof(startup)
        startup.dwFlags = 0x00000100
        startup.hStdInput = null_input
        startup.hStdOutput = kernel.GetStdHandle(wintypes.DWORD(-11))
        startup.hStdError = kernel.GetStdHandle(wintypes.DWORD(-12))
        for handle in (startup.hStdInput, startup.hStdOutput, startup.hStdError):
            if not handle or handle == invalid:
                raise ValueError("Tool output pipes are unavailable")
            checked(kernel.SetHandleInformation(handle, 1, 1), "Cannot inherit owned tool I/O")
        command_line = ctypes.create_unicode_buffer(subprocess.list2cmdline(command))
        checked(kernel.CreateProcessW(command[0], command_line, None, None, True,
                                      0x00000004 | 0x08000000, None, arguments.cwd,
                                      ctypes.byref(startup), ctypes.byref(process)),
                "Cannot create suspended owned tool process")
        checked(kernel.AssignProcessToJobObject(job, process.hProcess),
                "Cannot contain the tool; refusing to run it outside a private job")
        assigned = True
        if kernel.ResumeThread(process.hThread) == 0xFFFFFFFF:
            raise OSError(ctypes.get_last_error(), "Cannot resume contained tool")
        deadline = time.monotonic() + arguments.timeout_seconds
        while True:
            waited = kernel.WaitForSingleObject(process.hProcess, 50)
            if waited == 0:
                break
            if waited != 258:
                raise OSError(ctypes.get_last_error(), "Cannot wait for the owned tool")
            if time.monotonic() >= deadline:
                raise TimeoutError("Owned tool exceeded its command deadline")
            if not parent_pipe_alive(kernel, guardian_input):
                raise RuntimeError("Bootstrap parent exited or cancelled its owned tool")
        exit_code = wintypes.DWORD()
        checked(kernel.GetExitCodeProcess(process.hProcess, ctypes.byref(exit_code)), "Cannot read tool result")
        drain_deadline = time.monotonic() + 2
        while True:
            counters = Accounting()
            checked(kernel.QueryInformationJobObject(job, 1, ctypes.byref(counters), ctypes.sizeof(counters), None),
                    "Cannot reconcile owned descendant processes")
            if not counters.ActiveProcesses:
                break
            if time.monotonic() >= drain_deadline:
                raise RuntimeError("Tool exited with live descendants; its private job will be closed")
            time.sleep(0.025)
        return exit_code.value
    finally:
        if process.hProcess and not assigned:
            kernel.TerminateProcess(process.hProcess, 125)
        if job:
            kernel.CloseHandle(job)
        if process.hProcess:
            kernel.WaitForSingleObject(process.hProcess, 5000)
        for handle in (process.hThread, process.hProcess, null_input):
            if handle and handle != invalid:
                kernel.CloseHandle(handle)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--timeout-seconds", required=True, type=int)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    return run(parser.parse_args())


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError, TimeoutError) as error:
        print(json.dumps({"code": "ERR_RTC_OWNED_PROCESS", "message": str(error)}), file=sys.stderr)
        sys.exit(125)
