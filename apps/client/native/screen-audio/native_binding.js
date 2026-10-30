'use strict';

const { createPacketCaptureFactory } = require('./packet_capture');

const absent = (error) => error?.code === 'MODULE_NOT_FOUND';
const asError = (value) => value instanceof Error ? value : new Error(String(value));

/**
 * Loads the compiled addon. Only the Release build ships, so its failure is the one worth reporting
 * (a missing system library, a damaged file) rather than the usual absence of a Debug build.
 */
function loadBinding(load) {
  let release;
  try { return { binding: load('./build/Release/screen_audio.node'), loadError: null }; }
  catch (error) { release = asError(error); }
  try { return { binding: load('./build/Debug/screen_audio.node'), loadError: null }; }
  catch (error) {
    const debug = asError(error);
    return { binding: null, loadError: absent(release) && !absent(debug) ? debug : release };
  }
}

/**
 * The package API over a binding that may be missing. Where this platform implements a function, a
 * missing module is an explicit error with the load failure as its cause, never an empty answer.
 * Optional probes keep their documented "unknown" result, and so does every function on a platform
 * that does not implement it.
 */
function createScreenAudio({ binding, loadError }, platform = process.platform) {
  const provides = (name) => !!binding && typeof binding[name] === 'function';
  function call(name, feature, ...args) {
    if (provides(name)) return binding[name](...args);
    const reason = binding ? 'the native screen-audio module does not provide it on this system'
      : 'the native screen-audio module did not load';
    throw Object.assign(new Error(`${feature} is unavailable: ${reason}.`, loadError ? { cause: loadError } : undefined),
      { code: 'ERR_SCREEN_AUDIO_UNAVAILABLE' });
  }
  const probe = (name, unknown, ...args) => provides(name) ? binding[name](...args) : unknown;
  const captureSupported = platform === 'win32' || platform === 'darwin';

  return {
    getLoadError: () => loadError,
    isSupported: () => provides('isSupported') && binding.isSupported(),
    isPacketCaptureSupported: () => captureSupported && provides('createPacketCapture') && binding.isSupported(),
    createPacketCapture: createPacketCaptureFactory(binding, platform, loadError),
    listWindowOwners: () => platform === 'darwin' ? call('listWindowOwners', 'Native window owner listing') : [],
    listWindows: () => platform === 'win32' ? call('listWindows', 'Native window enumeration') : [],
    restoreWindow: (hwnd) => probe('restoreWindow', false, hwnd),
    getWindowState: (hwnd) => call('getWindowState', 'Native window lifecycle inspection', hwnd),
    getProcessAncestry: (processIds) => call('getProcessAncestry', 'Native process inspection', processIds),
    getWindowOcclusion: (hwnd) => probe('getWindowOcclusion', null, hwnd),
    startWindowFrameProbe: (hwnd) => probe('startWindowFrameProbe', null, hwnd),
    getWindowFrameProbe: (id) => probe('getWindowFrameProbe', null, id),
    stopWindowFrameProbe: (id) => probe('stopWindowFrameProbe', false, id),
    listMonitors: () => call('listMonitors', 'Native monitor enumeration'),
    getMonitorState: (deviceId) => call('getMonitorState', 'Native monitor lifecycle inspection', deviceId),
    getKeyboardLayout: (previousId = '', characters = '') => probe('getKeyboardLayout', null, previousId, characters),
    setWindowResizeAspect(handle, ratio, extraWidth, extraHeight) {
      call('setWindowResizeAspect', 'Native window resize constraints', handle, ratio, extraWidth, extraHeight);
    },
  };
}

module.exports = { loadBinding, createScreenAudio };
