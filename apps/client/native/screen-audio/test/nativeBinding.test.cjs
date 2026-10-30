'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { loadBinding, createScreenAudio } = require('../native_binding');

const absent = (path) => Object.assign(new Error(`Cannot find module '${path}'`), { code: 'MODULE_NOT_FOUND' });
const broken = () => Object.assign(new Error('The specified module could not be found.'), { code: 'ERR_DLOPEN_FAILED' });

function loader(results) {
  const requested = [];
  const load = (path) => {
    requested.push(path);
    const result = results[path.includes('Release') ? 'release' : 'debug'];
    if (result instanceof Error) throw result;
    return result;
  };
  return { load, requested };
}

test('the load error is why the Release build failed, not the usual absence of a Debug build', () => {
  const failure = broken();
  const { load, requested } = loader({ release: failure, debug: absent('./build/Debug/screen_audio.node') });
  assert.deepEqual(loadBinding(load), { binding: null, loadError: failure });
  assert.deepEqual(requested, ['./build/Release/screen_audio.node', './build/Debug/screen_audio.node']);

  const debugFailure = broken();
  assert.equal(loadBinding(loader({ release: absent('release'), debug: debugFailure }).load).loadError, debugFailure,
    'A developer build that exists but cannot load explains more than the missing Release build');
  const release = absent('release');
  assert.equal(loadBinding(loader({ release, debug: absent('debug') }).load).loadError, release);

  const binding = { isSupported: () => true };
  const loaded = loader({ release: binding, debug: broken() });
  assert.deepEqual(loadBinding(loaded.load), { binding, loadError: null });
  assert.deepEqual(loaded.requested, ['./build/Release/screen_audio.node'], 'Debug is never tried after Release loads');
  const thrownString = loadBinding(() => { throw 'not an Error'; }).loadError;
  assert.ok(thrownString instanceof Error && thrownString.message === 'not an Error');
});

test('on Windows, a module that did not load fails window and monitor functions with its cause', async () => {
  const loadError = broken();
  const audio = createScreenAudio({ binding: null, loadError }, 'win32');
  assert.equal(audio.getLoadError(), loadError);
  for (const [name, args] of [['listWindows', []], ['listMonitors', []], ['getWindowState', [1]],
    ['getMonitorState', ['monitor']], ['getProcessAncestry', [[1]]], ['setWindowResizeAspect', [Buffer.alloc(8), 1, 0, 0]]]) {
    assert.throws(() => audio[name](...args), (error) => {
      assert.equal(error.code, 'ERR_SCREEN_AUDIO_UNAVAILABLE', name);
      assert.equal(error.cause, loadError, name);
      assert.match(error.message, /did not load/u);
      return true;
    }, name);
  }
  // Optional probes keep their documented unknown answer, as before.
  assert.equal(audio.restoreWindow(1), false);
  assert.equal(audio.getWindowOcclusion(1), null);
  assert.equal(audio.startWindowFrameProbe(1), null);
  assert.equal(audio.getWindowFrameProbe(1), null);
  assert.equal(audio.stopWindowFrameProbe(1), false);
  assert.equal(audio.getKeyboardLayout(), null);
  assert.deepEqual(audio.listWindowOwners(), [], 'Only macOS lists window owners');
  assert.equal(audio.isSupported(), false);
  assert.equal(audio.isPacketCaptureSupported(), false);
  const events = [];
  const capture = audio.createPacketCapture({}, (event) => events.push(event.type));
  await assert.rejects(capture.ready, (error) => error.code === 'ERR_AUDIO_UNAVAILABLE' && error.cause === loadError);
  assert.equal((await capture.closed).state, 'failed');
  await new Promise(setImmediate);
  assert.deepEqual(events, ['error', 'closed']);
});

test('each platform answers only for what it implements', async () => {
  const loadError = broken();
  const mac = createScreenAudio({ binding: null, loadError }, 'darwin');
  assert.throws(() => mac.listWindowOwners(), (error) => error.cause === loadError);
  assert.deepEqual(mac.listWindows(), [], 'Window enumeration is Windows-only');
  const linux = createScreenAudio({ binding: null, loadError }, 'linux');
  assert.deepEqual([linux.listWindows(), linux.listWindowOwners()], [[], []]);
  const capture = linux.createPacketCapture({}, () => {});
  await assert.rejects(capture.ready, (error) => error.code === 'ERR_AUDIO_UNSUPPORTED' && error.cause === undefined);
  await capture.closed;
});

test('a loaded module answers directly, and a function this build lacks names the module instead of a load error', () => {
  const calls = [];
  const binding = {
    isSupported: () => true,
    listWindows: () => ['window'],
    getKeyboardLayout: (...args) => { calls.push(args); return { id: 'layout' }; },
    getWindowOcclusion: () => true,
  };
  const audio = createScreenAudio({ binding, loadError: null }, 'win32');
  assert.equal(audio.getLoadError(), null);
  assert.deepEqual(audio.listWindows(), ['window']);
  assert.deepEqual(audio.getKeyboardLayout(), { id: 'layout' });
  assert.deepEqual(audio.getKeyboardLayout('previous', 'é'), { id: 'layout' });
  assert.deepEqual(calls, [['', ''], ['previous', 'é']]);
  assert.equal(audio.getWindowOcclusion(1), true);
  assert.equal(audio.isPacketCaptureSupported(), false, 'Packet capture requires its native entry point');
  assert.throws(() => audio.listMonitors(), (error) =>
    error.code === 'ERR_SCREEN_AUDIO_UNAVAILABLE' && error.cause === undefined && /does not provide it/u.test(error.message));
});
