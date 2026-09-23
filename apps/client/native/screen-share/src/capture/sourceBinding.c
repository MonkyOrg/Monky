#include <obs-module.h>
#include <string.h>
#include "sourceBinding.h"

static HWND selected_window;
static DWORD selected_pid, selected_thread_id;
static uint64_t selected_creation;
static HANDLE selected_process, selected_thread;
static HMONITOR selected_monitor;
static char selected_monitor_id[128], selected_monitor_name[32];
static RECT selected_bounds;
static bool binding_retired;

static uint64_t creation_time(HANDLE process)
{
	FILETIME creation, exit, kernel, user;
	if (!process || !GetProcessTimes(process, &creation, &exit, &kernel, &user))
		return 0;
	return ((uint64_t)creation.dwHighDateTime << 32) | creation.dwLowDateTime;
}

bool monky_game_target_alive(void)
{
	DWORD process_id = 0;
	return !binding_retired && selected_process && selected_thread && IsWindow(selected_window) &&
	       GetAncestor(selected_window, GA_ROOT) == selected_window &&
	       GetWindowThreadProcessId(selected_window, &process_id) == selected_thread_id &&
	       process_id == selected_pid && WaitForSingleObject(selected_process, 0) == WAIT_TIMEOUT &&
	       WaitForSingleObject(selected_thread, 0) == WAIT_TIMEOUT &&
	       GetProcessIdOfThread(selected_thread) == selected_pid &&
	       creation_time(selected_process) == selected_creation;
}

MODULE_EXPORT bool monky_bind_game_target(uint64_t window, uint32_t process_id, uint64_t creation)
{
	if (selected_process || selected_monitor || !window || !process_id || !creation ||
	    process_id == GetCurrentProcessId())
		return false;
	selected_window = (HWND)(uintptr_t)window;
	selected_pid = process_id;
	selected_creation = creation;
	DWORD observed = 0;
	selected_thread_id = GetWindowThreadProcessId(selected_window, &observed);
	if (!selected_thread_id || observed != process_id)
		return false;
	selected_process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, false, process_id);
	selected_thread = OpenThread(THREAD_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, false, selected_thread_id);
	/* Keep both objects alive until OBS teardown: PID/TID reuse must not redirect an inject-helper. */
	return monky_game_target_alive();
}

HWND monky_game_window(void)
{
	return monky_game_target_alive() && IsWindowVisible(selected_window) && !IsIconic(selected_window)
		       ? selected_window
		       : NULL;
}

uint64_t monky_game_creation(void)
{
	return selected_creation;
}

bool monky_game_identity_matches(HWND window, DWORD process_id, HANDLE process)
{
	return monky_game_target_alive() && window == selected_window && process_id == selected_pid &&
	       (!process || (GetProcessId(process) == selected_pid && creation_time(process) == selected_creation));
}

HANDLE monky_open_bound_game_process(monky_open_process_fn open_process, DWORD access, BOOL inherit, DWORD process_id)
{
	if (!monky_game_target_alive() || process_id != selected_pid || inherit || !open_process)
		return NULL;
	HANDLE process = open_process(access, false, process_id);
	if (process && !monky_game_identity_matches(selected_window, process_id, process)) {
		CloseHandle(process);
		return NULL;
	}
	return process;
}

MODULE_EXPORT bool monky_bind_monitor_target(uint64_t monitor, const char *device_id, const char *device_name,
					   int32_t x, int32_t y, uint32_t width, uint32_t height)
{
	if (selected_monitor || selected_process || !monitor || !device_id || !device_name ||
	    strnlen_s(device_id, 128) >= 128 || strnlen_s(device_name, 32) >= 32 ||
	    !width || width > 32768 || !height || height > 32768 ||
	    (int64_t)x + width > INT32_MAX || (int64_t)y + height > INT32_MAX ||
	    strncmp(device_id, "\\\\?\\DISPLAY#", 12) != 0)
		return false;
	selected_monitor = (HMONITOR)(uintptr_t)monitor;
	strcpy_s(selected_monitor_id, sizeof(selected_monitor_id), device_id);
	strcpy_s(selected_monitor_name, sizeof(selected_monitor_name), device_name);
	selected_bounds = (RECT){x, y, x + (LONG)width, y + (LONG)height};
	return monky_monitor_matches(selected_monitor, selected_monitor_id, 2);
}

bool monky_monitor_matches(HMONITOR monitor, const char *device_id, int method)
{
	if (binding_retired || !selected_monitor || monitor != selected_monitor || method != 2 || !device_id ||
	    strcmp(device_id, selected_monitor_id) != 0)
		return false;
	MONITORINFOEXA info = {.cbSize = sizeof(info)};
	DISPLAY_DEVICEA device = {.cb = sizeof(device)};
	return GetMonitorInfoA(monitor, (MONITORINFO *)&info) &&
	       EnumDisplayDevicesA(info.szDevice, 0, &device, EDD_GET_DEVICE_INTERFACE_NAME) &&
	       strcmp(info.szDevice, selected_monitor_name) == 0 && strcmp(device.DeviceID, selected_monitor_id) == 0 &&
	       EqualRect(&info.rcMonitor, &selected_bounds);
}

void monky_retire_source_binding(void)
{
	binding_retired = true;
	/* Retain the two PID/TID leases until process exit, including while the
	 * host's kill-on-close job retires any already-started inject-helper. */
}

/* Unlike the stock installer helper, never copy hooks into ProgramData or register a global Vulkan layer. */
char *get_hook_path(bool is64bit)
{
	return obs_module_file(is64bit ? "graphics-hook64.dll" : "graphics-hook32.dll");
}
