'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const shared = require('@monky/shared');
const filename = path.resolve(__dirname, '..', 'src', 'main', 'nativeWindows.ts');
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
function moduleFor(crypto = require('node:crypto')) {
  const module = { exports: {} };
  vm.runInThisContext(`(function(require, module, exports) { ${compiled}\n})`, { filename })(
    name => name === 'node:crypto' ? crypto : require(name), module, module.exports);
  return module.exports;
}
const window = {
  hwnd: 123, title: 'Selected', processId: 456, processCreationTime100ns: '789', processPath: 'C:\\selected.exe',
  isIconic: false, isVisible: true, isCloaked: false, isToolWindow: false, isLayered: false,
  isTransparent: false, isNoActivate: false, isAppWindow: true, width: 1920, height: 1080,
};
const monitor = {
  deviceId: String.raw`\\?\DISPLAY#SELECTED#ONE`, deviceName: String.raw`\\.\DISPLAY2`, name: 'Selected display',
  bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, isPrimary: false,
};
function fixture(module = moduleFor()) {
  let windows = [structuredClone(window)], monitors = [structuredClone(monitor)];
  let state = { processId: 456, processCreationTime100ns: '789', isVisible: true, isIconic: false, isTopLevel: true };
  const sources = new module.NativeDesktopSources({
    windows: () => windows, windowState: () => state, monitors: () => monitors,
    monitorState: id => monitors.find(value => value.deviceId === id) ?? null,
  });
  return { sources, setWindows: value => { windows = value; }, setMonitors: value => { monitors = value; },
    setState: value => { state = value; } };
}

test('native monitor IDs bind exact device and physical geometry, independent of order and primary flags', () => {
  const f = fixture();
  const [selected] = f.sources.listMonitors();
  assert.match(selected.id, /^native-monitor:[a-f0-9]{64}$/);
  const other = { ...monitor, deviceId: String.raw`\\?\DISPLAY#OTHER#TWO`, deviceName: String.raw`\\.\DISPLAY1`,
    bounds: { x: 0, y: 0, width: 2560, height: 1440 }, isPrimary: true };
  f.setMonitors([other, { ...monitor, isPrimary: true }]);
  const listed = f.sources.listMonitors();
  assert.equal(listed[1].id, selected.id);
  const target = f.sources.resolve(selected.id, 'monitor');
  assert.deepEqual(target, { kind: 'monitor', deviceId: monitor.deviceId, deviceName: monitor.deviceName, bounds: monitor.bounds });
  target.bounds.x = 5;
  assert.equal(f.sources.resolve(selected.id, 'monitor').bounds.x, -1920);
  assert.throws(() => f.sources.resolve('screen:0:0', 'monitor'), /Select it again/);
  assert.throws(() => f.sources.resolve(selected.id, 'window'), /unavailable/);
  const command = {
    action: 'source-add', callId: require('node:crypto').randomUUID(), shareId: 'share', captureKind: 'monitor',
    desktopSourceId: selected.id, video: { width: 1920, height: 1080, fps: 60, maxBitrateKbps: 5000 },
    audio: true, audioBitrateKbps: 128,
  };
  assert.equal(shared.nativeScreenCommandSchema.safeParse(command).success, true);
  assert.equal(shared.nativeScreenCommandSchema.safeParse({ ...command, desktopSourceId: `${selected.id}x` }).success, false);
});

test('monitor disconnect, replacement, mode and topology changes require explicit reselection', () => {
  for (const changed of [
    [], [{ ...monitor, bounds: { ...monitor.bounds, x: 0 } }],
    [{ ...monitor, bounds: { ...monitor.bounds, width: 1280 } }],
    [{ ...monitor, deviceName: String.raw`\\.\DISPLAY3` }],
    [{ ...monitor, deviceId: String.raw`\\?\DISPLAY#REPLACED#ONE` }],
  ]) {
    const f = fixture(), [{ id }] = f.sources.listMonitors();
    f.setMonitors(changed);
    assert.throws(() => f.sources.resolve(id, 'monitor'), /Select it again/);
    f.sources.listMonitors();
    assert.throws(() => f.sources.resolve(id, 'monitor'), /Select it again/);
  }
});

test('ambiguous native monitor identities and digest collisions are rejected, not mapped by ordinal', () => {
  const f = fixture();
  f.setMonitors([monitor, structuredClone(monitor)]);
  assert.throws(() => f.sources.listMonitors(), /ambiguous/);
  const hash = { createHash: () => ({ update() { return this; }, digest: () => '0'.repeat(64) }) };
  const collided = fixture(moduleFor(hash));
  collided.sources.listMonitors();
  collided.setMonitors([{ ...monitor, bounds: { ...monitor.bounds, x: 0 } }]);
  assert.throws(() => collided.sources.listMonitors(), /collision/);
});

test('window and game choices retain exact HWND, PID and process birth, including minimized windows', () => {
  const f = fixture();
  const [{ id }] = f.sources.listWindows();
  assert.match(id, /^window:123:[a-f0-9]{64}$/);
  for (const kind of ['window', 'game']) {
    assert.deepEqual(f.sources.resolve(id, kind), {
      kind, hwnd: 123, expectedProcessId: 456, expectedProcessCreationTime100ns: '789',
    });
  }
  f.setWindows([{ ...window, isIconic: true, isVisible: false }]);
  f.setState({ processId: 456, processCreationTime100ns: '789', isVisible: false, isIconic: true, isTopLevel: true });
  assert.equal(f.sources.resolve(id, 'window').hwnd, 123);
  assert.equal(f.sources.listWindows()[0].id, id);
  f.setState({ processId: 456, processCreationTime100ns: '999', isVisible: false, isIconic: true, isTopLevel: true });
  assert.throws(() => f.sources.resolve(id, 'game'), /replaced/);
  f.setState(null);
  assert.throws(() => f.sources.resolve(id, 'window'), /unavailable/);
});

test('a stale picker ID never adopts a new HWND owner, even after enumeration refresh', () => {
  for (const changed of [{ processId: 999 }, { processCreationTime100ns: '999' }]) {
    const f = fixture(), [{ id }] = f.sources.listWindows();
    const replacement = { ...window, ...changed };
    f.setWindows([replacement]);
    f.setState({ ...replacement, isTopLevel: true });
    assert.throws(() => f.sources.resolve(id, 'window'), /replaced/);
    const [fresh] = f.sources.listWindows();
    assert.notEqual(fresh.id, id);
    assert.throws(() => f.sources.resolve(id, 'game'), /unavailable/);
    assert.equal(f.sources.resolve(fresh.id, 'game').expectedProcessCreationTime100ns, replacement.processCreationTime100ns);
  }
});

test('window identity hash collisions are rejected rather than replacing an old selection', () => {
  const hash = { createHash: () => ({ update() { return this; }, digest: () => '0'.repeat(64) }) };
  const f = fixture(moduleFor(hash));
  f.sources.listWindows();
  f.setWindows([{ ...window, processCreationTime100ns: '999' }]);
  assert.throws(() => f.sources.listWindows(), /collision/);
});

test('refreshing the picker preserves an already selected hidden window until its real identity disappears', () => {
  const f = fixture(), [{ id }] = f.sources.listWindows();
  f.setWindows([]);
  f.setState({ processId: 456, processCreationTime100ns: '789', isVisible: false, isIconic: false, isTopLevel: true });
  assert.deepEqual(f.sources.listWindows(), []);
  assert.equal(f.sources.resolve(id, 'game').expectedProcessCreationTime100ns, '789');
  f.setState(null);
  f.sources.listWindows();
  assert.throws(() => f.sources.resolve(id, 'window'), /unavailable/);
});

test('unknown process births, ghost windows and malformed Electron IDs cannot become capture targets', () => {
  const { nativeWindowIdFromSourceId } = moduleFor();
  for (const id of ['window:0:0', 'window:123', 'window:123:0:extra', 'window:1e3:0', 'window:9007199254740992:0', 'screen:0:0'])
    assert.equal(nativeWindowIdFromSourceId(id), null);
  for (const changed of [{ processCreationTime100ns: null }, { isToolWindow: true }, { isCloaked: true },
    { isLayered: true, isTransparent: true }]) {
    const f = fixture();
    f.setWindows([{ ...window, ...changed }]);
    assert.deepEqual(f.sources.listWindows(), []);
    assert.throws(() => f.sources.resolve('window:123:0', 'window'), /unavailable/);
  }
});
