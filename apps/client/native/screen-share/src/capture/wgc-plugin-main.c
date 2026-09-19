/*
 * Derived from OBS Studio's GPL-2.0-or-later win-capture/plugin-main.c.
 * Monky changes (2026), GPL-3.0-or-later: explicitly owned WGC-only startup,
 * without the game-hook initialization or compatibility-update worker.
 */
#include <windows.h>
#include <obs-module.h>
#include <util/dstr.h>
#include <util/windows/win-version.h>
#include <util/platform.h>

#include <file-updater/file-updater.h>

#include "compat-helpers.h"
#include "compat-format-ver.h"
#ifdef OBS_LEGACY
#include "compat-config.h"
#endif

#define WIN_CAPTURE_LOG_STRING "[win-capture plugin] "
#define WIN_CAPTURE_VER_STRING "win-capture plugin (libobs " OBS_VERSION ")"

OBS_DECLARE_MODULE()
OBS_MODULE_USE_DEFAULT_LOCALE("win-capture", "en-US")
MODULE_EXPORT const char *obs_module_description(void)
{
	return "Windows game/screen/window capture";
}

extern struct obs_source_info duplicator_capture_info;
extern struct obs_source_info monitor_capture_info;
extern struct obs_source_info window_capture_info;
extern struct obs_source_info game_capture_info;

static HANDLE init_hooks_thread = NULL;
static update_info_t *update_info = NULL;
static bool monky_mode_configured = false;
static bool monky_load_entered = false;
static bool monky_wgc_only_startup = false;

MODULE_EXPORT bool monky_configure_wgc_only_startup(bool enabled)
{
	if (monky_mode_configured || monky_load_entered)
		return false;
	monky_wgc_only_startup = enabled;
	monky_mode_configured = true;
	return true;
}

extern bool cached_versions_match(void);
extern bool load_cached_graphics_offsets(bool is32bit, const char *config_path);
extern bool load_graphics_offsets(bool is32bit, bool use_hook_address_cache, const char *config_path);

/* temporary, will eventually be erased once we figure out how to create both
 * 32bit and 64bit versions of the helpers/hook */
#ifdef _WIN64
#define IS32BIT false
#else
#define IS32BIT true
#endif

static const bool use_hook_address_cache = false;

static DWORD WINAPI init_hooks(LPVOID param)
{
	char *config_path = param;

	if (use_hook_address_cache && cached_versions_match() && load_cached_graphics_offsets(IS32BIT, config_path)) {

		load_cached_graphics_offsets(!IS32BIT, config_path);
		obs_register_source(&game_capture_info);

	} else if (load_graphics_offsets(IS32BIT, use_hook_address_cache, config_path)) {
		load_graphics_offsets(!IS32BIT, use_hook_address_cache, config_path);
	}

	bfree(config_path);
	return 0;
}

void wait_for_hook_initialization(void)
{
	static bool initialized = false;

	if (!initialized) {
		if (init_hooks_thread) {
			WaitForSingleObject(init_hooks_thread, INFINITE);
			CloseHandle(init_hooks_thread);
			init_hooks_thread = NULL;
		}
		initialized = true;
	}
}

static bool confirm_compat_file(void *param, struct file_download_data *file)
{
	if (astrcmpi(file->name, "compatibility.json") == 0) {
		obs_data_t *data;
		int format_version;

		data = obs_data_create_from_json((char *)file->buffer.array);
		if (!data)
			return false;

		format_version = (int)obs_data_get_int(data, "format_version");
		obs_data_release(data);

		if (format_version != COMPAT_FORMAT_VERSION)
			return false;
	}

	UNUSED_PARAMETER(param);
	return true;
}

void init_hook_files(void);

bool graphics_uses_d3d11 = false;
bool wgc_supported = false;

bool obs_module_load(void)
{
	monky_load_entered = true;
	if (!monky_mode_configured) {
		blog(LOG_ERROR, "[Monky screen capture] startup mode was not explicitly configured");
		return false;
	}
	struct win_version_info ver;
	bool win8_or_above = false;
	char *local_dir;
	char *config_dir;

	char update_url[128];
	snprintf(update_url, sizeof(update_url), "%s/v%d", COMPAT_URL, COMPAT_FORMAT_VERSION);

	struct win_version_info win1903 = {.major = 10, .minor = 0, .build = 18362, .revis = 0};

	local_dir = obs_module_file(NULL);
	config_dir = obs_module_config_path(NULL);
	if (config_dir) {
		os_mkdirs(config_dir);

		if (local_dir) {
			update_info = update_info_create(WIN_CAPTURE_LOG_STRING, WIN_CAPTURE_VER_STRING, update_url,
							 local_dir, config_dir, confirm_compat_file, NULL);
		}
	}
	bfree(config_dir);
	bfree(local_dir);

	get_win_ver(&ver);

	win8_or_above = ver.major > 6 || (ver.major == 6 && ver.minor >= 2);

	obs_enter_graphics();
	graphics_uses_d3d11 = gs_get_device_type() == GS_DEVICE_DIRECT3D_11;
	obs_leave_graphics();

	if (graphics_uses_d3d11)
		wgc_supported = win_version_compare(&ver, &win1903) >= 0;

	if (win8_or_above && graphics_uses_d3d11)
		obs_register_source(&duplicator_capture_info);
	else
		obs_register_source(&monitor_capture_info);

	obs_register_source(&window_capture_info);

	if (!monky_wgc_only_startup) {
		char *config_path = obs_module_config_path(NULL);
		init_hook_files();
		init_hooks_thread = CreateThread(NULL, 0, init_hooks, config_path, 0, NULL);
		if (!init_hooks_thread) {
			bfree(config_path);
			blog(LOG_ERROR, "[Monky screen capture] Game Capture preparation thread failed");
			return false;
		}
		obs_register_source(&game_capture_info);
	}
	blog(LOG_INFO, "[Monky screen capture] wgc_only_startup=%s game_capture_registered=%s hook_thread_started=%s",
	     monky_wgc_only_startup ? "true" : "false", monky_wgc_only_startup ? "false" : "true",
	     init_hooks_thread ? "true" : "false");

	return true;
}

void obs_module_unload(void)
{
	wait_for_hook_initialization();
	update_info_destroy(update_info);
	compat_json_free();
}
