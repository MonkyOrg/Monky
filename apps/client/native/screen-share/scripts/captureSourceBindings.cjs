'use strict';

const assert = require('node:assert/strict');

function replaceOnce(source, before, after) {
  assert.equal(source.split(before).length, 2, 'Pinned capture source specialization anchor changed.');
  return source.replace(before, after);
}

function bindGameSource(source) {
  source = '#include "sourceBinding.h"\n' + source;
  source = replaceOnce(source, 'return open_process_proc(desired_access, inherit_handle, process_id);',
    'return monky_open_bound_game_process(open_process_proc, desired_access, inherit_handle, process_id);');
  const start = source.indexOf('static void get_selected_window(struct game_capture *gc)\n');
  const end = source.indexOf('\nstatic void try_hook(struct game_capture *gc)\n', start);
  assert.ok(start > 0 && end > start);
  source = source.slice(0, start) + `static void get_selected_window(struct game_capture *gc)
{
\tHWND window = monky_selected_window();
\tif (window)
\t\tsetup_window(gc, window);
\telse
\t\tgc->wait_for_target_startup = true;
}
` + source.slice(end);
  for (const name of ['init_hook', 'inject_hook']) {
    const signature = name === 'inject_hook' ? 'static inline bool' : 'static bool';
    const anchor = `${signature} ${name}(struct game_capture *gc)\n{`;
    source = replaceOnce(source, anchor, anchor + `
\tif (!monky_window_identity_matches(gc->next_window, gc->process_id, gc->target_process))
\t\treturn false;`);
  }
  source = replaceOnce(source, 'static void game_capture_tick(void *data, float seconds)\n{\n\tstruct game_capture *gc = data;',
    `static void game_capture_tick(void *data, float seconds)
{
\tstruct game_capture *gc = data;
\tif (!monky_window_target_alive()) {
\t\tif (gc->active) stop_capture(gc);
\t\treturn;
\t}
\tif (!monky_selected_window()) return;`);
  source = replaceOnce(source, 'static void *game_capture_create(obs_data_t *settings, obs_source_t *source)\n{',
    `static void *game_capture_create(obs_data_t *settings, obs_source_t *source)
{
\tif (!monky_window_target_alive() ||
\t    strcmp(obs_data_get_string(settings, "capture_mode"), "window") != 0 ||
\t    !obs_data_get_bool(settings, "anti_cheat_hook") || obs_data_get_bool(settings, "capture_audio"))
\t\treturn NULL;`);
  source = replaceOnce(source, '\tcalldata_set_bool(cd, "hooked", gc->capturing);',
    `\tHWND hook_window = gc->global_hook_info && gc->global_hook_info->window
\t\t? (HWND)(uintptr_t)gc->global_hook_info->window : gc->window;
\tbool identity = gc->capturing && monky_window_identity_matches(gc->window, gc->process_id, gc->target_process) &&
\t\tmonky_window_identity_matches(hook_window, gc->process_id, gc->target_process);
\tcalldata_set_bool(cd, "hooked", gc->capturing);
\tcalldata_set_bool(cd, "identity_valid", identity);
\tcalldata_set_int(cd, "hwnd", (int64_t)(uintptr_t)hook_window);
\tcalldata_set_int(cd, "process_id", gc->process_id);
\tcalldata_set_int(cd, "process_creation", (int64_t)monky_window_creation());`);
  source = replaceOnce(source,
    '"void get_hooked(out bool hooked, out string title, out string class, out string executable)"',
    '"void get_hooked(out bool hooked, out string title, out string class, out string executable, ' +
      'out bool identity_valid, out int hwnd, out int process_id, out int process_creation)"');
  source = replaceOnce(source, '\tif (!gc->texture || !gc->active)\n',
    `\tHWND hook_window = gc->global_hook_info && gc->global_hook_info->window
\t\t? (HWND)(uintptr_t)gc->global_hook_info->window : gc->window;
\tif (!monky_selected_window() || !monky_window_identity_matches(hook_window, gc->process_id, gc->target_process))
\t\treturn;
\tif (!gc->texture || !gc->active)
`);
  return source;
}

function bindWindowSource(source) {
  source = '#include "sourceBinding.h"\n' + source;
  const finderStart = source.indexOf('\t\twc->window = (wc->method == METHOD_WGC) ? ms_find_window_top_level(');
  const finderEnd = source.indexOf('\n\t\tif (!wc->window)', finderStart);
  assert.ok(finderStart > 0 && finderEnd > finderStart, 'Pinned WGC selection anchor changed.');
  source = source.slice(0, finderStart) + '\t\twc->window = monky_selected_window();' + source.slice(finderEnd);
  source = replaceOnce(source, 'static void *wc_create(obs_data_t *settings, obs_source_t *source)\n{',
    `static void *wc_create(obs_data_t *settings, obs_source_t *source)
{
\tif (!monky_window_target_alive() || obs_data_get_int(settings, "method") != 2 ||
\t    obs_data_get_bool(settings, "capture_audio"))
\t\treturn NULL;`);
  source = replaceOnce(source, '\tif (wc->hooked && wc->window) {',
    `\tDWORD process_id = 0;
\tGetWindowThreadProcessId(wc->window, &process_id);
\tbool identity = monky_window_identity_matches(wc->window, process_id, NULL);
\tcalldata_set_bool(cd, "identity_valid", identity);
\tcalldata_set_int(cd, "hwnd", (int64_t)(uintptr_t)wc->window);
\tcalldata_set_int(cd, "process_id", process_id);
\tcalldata_set_int(cd, "process_creation", (int64_t)monky_window_creation());
\tif (wc->hooked && identity) {`);
  source = replaceOnce(source,
    '"void get_hooked(out bool hooked, out string title, out string class, out string executable)"',
    '"void get_hooked(out bool hooked, out string title, out string class, out string executable, ' +
      'out bool identity_valid, out int hwnd, out int process_id, out int process_creation)"');
  source = replaceOnce(source, 'static void wc_tick(void *data, float seconds)\n{\n\tstruct window_capture *wc = data;',
    `static void wc_tick(void *data, float seconds)
{
\tstruct window_capture *wc = data;
\tif (!monky_window_target_alive()) {
\t\tforce_reset(wc);
\t\treturn;
\t}
\tif (!monky_selected_window()) return;`);
  source = replaceOnce(source, '\t\tif (wc->window && (wc->capture_winrt == NULL)) {',
    '\t\tif (wc->window == monky_selected_window() && (wc->capture_winrt == NULL)) {');
  source = replaceOnce(source, 'static void wc_render(void *data, gs_effect_t *effect)\n{\n\tstruct window_capture *wc = data;',
    `static void wc_render(void *data, gs_effect_t *effect)
{
\tstruct window_capture *wc = data;
\tif (!monky_selected_window() || wc->window != monky_selected_window())
\t\treturn;`);
  return source;
}

function bindMonitorSource(source) {
  source = '#include "sourceBinding.h"\n' + source;
  const create = 'static void *duplicator_capture_create(obs_data_t *settings, obs_source_t *source)';
  source = replaceOnce(source, create, `static void monky_monitor_get_hooked(void *data, calldata_t *cd)
{
\tstruct duplicator_capture *capture = data;
\tbool identity = monky_monitor_matches(capture->handle, capture->monitor_id, capture->method);
\tbool attached = identity && capture->capture_winrt &&
\t\tcapture->exports.winrt_capture_active(capture->capture_winrt);
\tcalldata_set_bool(cd, "hooked", attached);
\tcalldata_set_bool(cd, "identity_valid", identity);
}

${create}`);
  source = replaceOnce(source, '\tcapture->source = source;', `\tcapture->source = source;
\tproc_handler_add(obs_source_get_proc_handler(source),
\t\t"void get_hooked(out bool hooked, out bool identity_valid)", monky_monitor_get_hooked, capture);`);
  source = replaceOnce(source,
    'static void duplicator_capture_tick(void *data, float seconds)\n{\n\tstruct duplicator_capture *capture = data;',
    `static void duplicator_capture_tick(void *data, float seconds)
{
\tstruct duplicator_capture *capture = data;
\tif (!monky_monitor_matches(capture->handle, capture->monitor_id, capture->method)) return;`);
  source = replaceOnce(source,
    'static void duplicator_capture_render(void *data, gs_effect_t *unused)\n{\n\tUNUSED_PARAMETER(unused);\n\n\tstruct duplicator_capture *capture = data;',
    `static void duplicator_capture_render(void *data, gs_effect_t *unused)
{
\tUNUSED_PARAMETER(unused);
\tstruct duplicator_capture *capture = data;
\tif (!monky_monitor_matches(capture->handle, capture->monitor_id, capture->method)) return;`);
  return source;
}

function configureWinrtSource(source) {
  const anchor = '\tconst winrt::Windows::Graphics::Capture::GraphicsCaptureSession session = frame_pool.CreateCaptureSession(item);';
  assert.equal(source.split(anchor).length, 3, 'Pinned WGC initialization/device-recovery anchors changed.');
  return '#include "wgcCadence.h"\n' + source.replaceAll(anchor, anchor + '\n\tMonkyConfigureWgcCadence(session);');
}

module.exports = { bindGameSource, bindWindowSource, bindMonitorSource, configureWinrtSource };
