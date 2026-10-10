const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const sourcePath = path.resolve(__dirname, '../src/main/compositorRefresh.ts');
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loaded = new Module(sourcePath, module);
loaded.filename = sourcePath;
loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
loaded._compile(compiled, sourcePath);
const {
  bindCompositorRefresh, COMPOSITOR_REFRESH_INTERVAL_MS, COMPOSITOR_REFRESH_SETTLE_MS, COMPOSITOR_REFRESH_CAPTURE_TIMEOUT_MS,
} = loaded.exports;

const flush = () => new Promise((resolve) => setImmediate(resolve));

function fixture({ capture = 'resolve' } = {}) {
  const calls = [];
  const captures = [];
  const contents = {
    destroyed: false, crashed: false, throttling: false,
    isDestroyed() { return this.destroyed; },
    isCrashed() { return this.crashed; },
    getBackgroundThrottling() { return this.throttling; },
    setBackgroundThrottling(value) { this.throttling = value; calls.push(`throttling:${value}`); },
    capturePage() {
      calls.push('capture');
      if (capture === 'throw') throw new Error('capture threw');
      return new Promise((resolve, reject) => {
        const entry = { resolve, reject };
        captures.push(entry);
        if (capture === 'resolve') resolve({});
        if (capture === 'reject') reject(new Error('capture failed'));
      });
    },
  };
  class Window extends EventEmitter {
    constructor() { super(); this.destroyed = false; this.visible = true; this.minimized = false; this.focused = false; this.webContents = contents; }
    isDestroyed() { return this.destroyed; }
    // Like Electron on Windows: a minimized window does not count as visible.
    isVisible() { return this.visible && !this.minimized; }
    isMinimized() { return this.minimized; }
    isFocused() { return this.focused; }
  }
  return { window: new Window(), contents, calls, captures };
}

test.beforeEach(() => test.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] }));
test.afterEach(() => test.mock.timers.reset());

test('compositor refresh allows throttling only around one capture after the window leaves the user', async () => {
  const f = fixture();
  const errors = [];
  bindCompositorRefresh(f.window, { platform: 'win32', onError: (error) => errors.push(error) });

  f.window.minimized = true;
  f.window.emit('minimize');
  test.mock.timers.tick(COMPOSITOR_REFRESH_SETTLE_MS - 1);
  assert.deepEqual(f.calls, [], 'Chromium needs time to apply the minimized/occluded visibility first');
  test.mock.timers.tick(1);
  assert.deepEqual(f.calls, ['throttling:true', 'capture']);
  await flush();
  assert.deepEqual(f.calls, ['throttling:true', 'capture', 'throttling:false']);
  assert.equal(f.contents.throttling, false);
  assert.deepEqual(errors, []);
});

test('compositor refresh debounces window events and also runs periodically while out of focus', async () => {
  const f = fixture();
  bindCompositorRefresh(f.window, { platform: 'win32' });

  f.window.emit('blur');
  test.mock.timers.tick(COMPOSITOR_REFRESH_SETTLE_MS / 2);
  f.window.emit('minimize');
  test.mock.timers.tick(COMPOSITOR_REFRESH_SETTLE_MS);
  await flush();
  assert.equal(f.calls.filter((call) => call === 'capture').length, 1);

  test.mock.timers.tick(COMPOSITOR_REFRESH_INTERVAL_MS);
  await flush();
  assert.equal(f.calls.filter((call) => call === 'capture').length, 2);
  assert.equal(f.contents.throttling, false);
});

test('compositor refresh never touches a window in front of the user, in the tray, already throttled or gone', async () => {
  for (const [label, mutate] of [
    ['focused', (f) => { f.window.focused = true; }],
    ['hidden in the tray', (f) => { f.window.emit('hide'); f.window.visible = false; }],
    ['minimized, then hidden in the tray', (f) => { f.window.minimized = true; f.window.emit('hide'); f.window.visible = false; }],
    ['created hidden', (f) => { f.window.visible = false; }],
    ['throttling already allowed', (f) => { f.contents.throttling = true; }],
    ['crashed renderer', (f) => { f.contents.crashed = true; }],
    ['destroyed contents', (f) => { f.contents.destroyed = true; }],
    ['destroyed window', (f) => { f.window.destroyed = true; }],
  ]) {
    const f = fixture();
    bindCompositorRefresh(f.window, { platform: 'win32' });
    mutate(f);
    f.window.emit('minimize');
    test.mock.timers.tick(COMPOSITOR_REFRESH_INTERVAL_MS);
    await flush();
    assert.deepEqual(f.calls, [], label);
  }
});

test('compositor refresh resumes once a tray-hidden window is shown again', async () => {
  const f = fixture();
  bindCompositorRefresh(f.window, { platform: 'win32' });
  f.window.emit('hide');
  f.window.visible = false;
  test.mock.timers.tick(COMPOSITOR_REFRESH_INTERVAL_MS);
  await flush();
  assert.deepEqual(f.calls, []);

  f.window.visible = true;
  f.window.emit('show');
  test.mock.timers.tick(COMPOSITOR_REFRESH_INTERVAL_MS);
  await flush();
  assert.deepEqual(f.calls, ['throttling:true', 'capture', 'throttling:false']);
});

test('compositor refresh restores throttling even when a capture never settles, without stacking captures', async () => {
  const f = fixture({ capture: 'pending' });
  bindCompositorRefresh(f.window, { platform: 'win32' });

  test.mock.timers.tick(COMPOSITOR_REFRESH_INTERVAL_MS);
  assert.deepEqual(f.calls, ['throttling:true', 'capture']);
  test.mock.timers.tick(COMPOSITOR_REFRESH_CAPTURE_TIMEOUT_MS);
  assert.deepEqual(f.calls, ['throttling:true', 'capture', 'throttling:false']);

  test.mock.timers.tick(COMPOSITOR_REFRESH_INTERVAL_MS * 3);
  await flush();
  assert.equal(f.calls.filter((call) => call === 'capture').length, 1, 'a stuck capture keeps further refreshes off');

  f.captures[0].resolve({});
  await flush();
  assert.deepEqual(f.calls, ['throttling:true', 'capture', 'throttling:false'], 'a late capture does not toggle throttling again');
  test.mock.timers.tick(COMPOSITOR_REFRESH_INTERVAL_MS);
  await flush();
  assert.equal(f.calls.filter((call) => call === 'capture').length, 2, 'refreshes resume once the capture settles');
  f.captures[1].resolve({});
  await flush();
  assert.equal(f.contents.throttling, false);
});

test('compositor refresh reports failed captures and restores throttling', async () => {
  for (const capture of ['reject', 'throw']) {
    const f = fixture({ capture });
    const errors = [];
    bindCompositorRefresh(f.window, { platform: 'win32', onError: (error) => errors.push(error.message) });
    test.mock.timers.tick(COMPOSITOR_REFRESH_INTERVAL_MS);
    await flush();
    assert.equal(f.contents.throttling, false, capture);
    assert.deepEqual(errors, [capture === 'reject' ? 'capture failed' : 'capture threw']);
    test.mock.timers.tick(COMPOSITOR_REFRESH_INTERVAL_MS);
    await flush();
    assert.equal(f.calls.filter((call) => call === 'capture').length, 2, `${capture}: the next refresh still runs`);
  }
});

test('compositor refresh disposal removes listeners and timers; other platforms are left untouched', async () => {
  const f = fixture();
  const dispose = bindCompositorRefresh(f.window, { platform: 'win32' });
  for (const event of ['blur', 'minimize', 'hide', 'show']) assert.equal(f.window.listenerCount(event), 1, event);
  f.window.emit('minimize');
  dispose();
  dispose();
  for (const event of ['blur', 'minimize', 'hide', 'show']) assert.equal(f.window.listenerCount(event), 0, event);
  test.mock.timers.tick(COMPOSITOR_REFRESH_INTERVAL_MS * 2);
  await flush();
  assert.deepEqual(f.calls, []);

  for (const platform of ['darwin', 'linux']) {
    const other = fixture();
    bindCompositorRefresh(other.window, { platform })();
    assert.equal(other.window.listenerCount('blur'), 0, platform);
    other.window.emit('minimize');
    test.mock.timers.tick(COMPOSITOR_REFRESH_INTERVAL_MS);
    await flush();
    assert.deepEqual(other.calls, [], platform);
  }
});
