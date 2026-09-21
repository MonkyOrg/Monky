/*
 * Derived from OBS Studio's GPL-2.0-or-later win-capture/plugin-main.c.
 * Monky changes (2026), GPL-3.0-or-later: explicit source-bound startup.
 * Game hooks are opt-in; compatibility downloads/global hook installers are absent.
 */
#include <windows.h>
#include <obs-module.h>
#include <util/windows/win-version.h>
#include "compat-helpers.h"
#include "sourceBinding.h"

OBS_DECLARE_MODULE()
OBS_MODULE_USE_DEFAULT_LOCALE("win-capture", "en-US")
MODULE_EXPORT const char *obs_module_description(void)
{
	return "Monky explicitly bound Windows window/monitor/game capture";
}

extern struct obs_source_info duplicator_capture_info;
extern struct obs_source_info window_capture_info;
extern struct obs_source_info game_capture_info;
extern bool load_graphics_offsets(bool is32bit, bool use_hook_address_cache, const char *config_path);

static bool mode_configured, load_entered, game_enabled, hooks_initialized;
bool graphics_uses_d3d11 = false;
bool wgc_supported = false;

MODULE_EXPORT bool monky_configure_capture_startup(bool enable_game_hooks)
{
	if (mode_configured || load_entered)
		return false;
	game_enabled = enable_game_hooks;
	mode_configured = true;
	return true;
}

MODULE_EXPORT bool monky_configure_wgc_only_startup(bool enabled)
{
	return enabled && monky_configure_capture_startup(false);
}

void wait_for_hook_initialization(void)
{
	if (!game_enabled || !hooks_initialized)
		blog(LOG_ERROR, "[Monky screen capture] Game Capture was not explicitly prepared");
}

bool obs_module_load(void)
{
	load_entered = true;
	if (!mode_configured)
		return false;
	struct win_version_info version;
	const struct win_version_info minimum = {.major = 10, .minor = 0, .build = 18362, .revis = 0};
	get_win_ver(&version);
	obs_enter_graphics();
	graphics_uses_d3d11 = gs_get_device_type() == GS_DEVICE_DIRECT3D_11;
	obs_leave_graphics();
	wgc_supported = graphics_uses_d3d11 && win_version_compare(&version, &minimum) >= 0;
	if (!wgc_supported)
		return false;
	obs_register_source(&duplicator_capture_info);
	obs_register_source(&window_capture_info);
	if (game_enabled) {
		if (!monky_game_target_alive())
			return false;
		/* Only pinned, privately copied offset helpers. No updater, cache or global Vulkan registration. */
		if (!load_graphics_offsets(false, false, NULL) || !load_graphics_offsets(true, false, NULL)) {
			blog(LOG_ERROR, "[Monky screen capture] Pinned Game Capture offset helpers failed");
			return false;
		}
		hooks_initialized = true;
		obs_register_source(&game_capture_info);
	}
	blog(LOG_INFO, "[Monky screen capture] explicit_game_hooks=%s compatibility_updater=false",
	     game_enabled ? "true" : "false");
	return true;
}

void obs_module_unload(void)
{
	compat_json_free();
	monky_retire_source_binding();
}
