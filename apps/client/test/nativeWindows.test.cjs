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
  const excluded = new Set();
  let state = { processId: 456, processCreationTime100ns: '789', isVisible: true, isIconic: false, isTopLevel: true };
  const sources = new module.NativeDesktopSources({
    windows: () => windows, windowState: () => state, monitors: () => monitors,
    monitorState: id => monitors.find(value => value.deviceId === id) ?? null,
    isWindowExcluded: hwnd => excluded.has(hwnd),
  });
  return { sources, excluded, setWindows: value => { windows = value; }, setMonitors: value => { monitors = value; },
    setState: value => { state = value; } };
}

function desktopEnumerator(sources, { previewError, platform = 'win32', chromiumSources = [],
  isScreenShareSource = () => false } = {}) {
  const handlerFile = path.resolve(__dirname, '..', 'src', 'main', 'ipcHandlers.ts');
  const source = ts.createSourceFile(handlerFile, fs.readFileSync(handlerFile, 'utf8'), ts.ScriptTarget.Latest, true);
  let declaration;
  const find = node => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'enumerateDesktopSources') declaration = node;
    ts.forEachChild(node, find);
  };
  find(source);
  assert.ok(declaration, 'The actual IPC enumeration implementation must be tested.');
  const body = ts.transpileModule(declaration.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const calls = [], warnings = [], logs = [], captures = [];
  const native = moduleFor();
  const load = vm.runInThisContext(`(function(nativeSources, nativeMonitorDesktopSources,
    nativeWindowIdFromSourceId, isGhostWindow, desktopCapturer, screen, resolveMacAppIcons,
    resolveWindowsAppIcons, process, console, options, NativeThumbnailCapturer, loadThumbnailRuntime, overlayManager) {
      let desktopSourcesFrozen = false, nativeThumbnails;
      ${body}; return enumerateDesktopSources; })`, { filename: handlerFile });
  const enumerate = load(sources, native.nativeMonitorDesktopSources, native.nativeWindowIdFromSourceId,
    native.isGhostWindow, {
      async getSources(options) {
        calls.push(options);
        if (platform === 'win32') throw new Error('Chromium must not enumerate or capture Windows picker sources');
        return chromiumSources;
      },
    }, {
      getAllDisplays: () => assert.fail('Metadata listing must not inspect preview displays.'),
      screenToDipRect: () => assert.fail('Metadata listing must not convert preview coordinates.'),
    }, async () => new Map(), async () => new Map(), { platform, pid: 999 },
    { warn: (...args) => warnings.push(args) }, { clientLogger: { write: entry => logs.push(entry) } },
    class {
      async capture(target) {
        captures.push(target);
        if (previewError) throw previewError;
        return Buffer.from('owned-native-image');
      }
    }, () => ({}), { isScreenShareSource });
  return { enumerate, calls, warnings, logs, captures };
}

test('Windows lists screens and windows and captures native previews without consulting Chromium', async () => {
  const f = fixture(), e = desktopEnumerator(f.sources);
  const result = await e.enumerate(true);
  assert.deepEqual(result.map(source => source.type), ['window', 'screen']);
  assert.deepEqual(e.calls, []);
  const selected = result.find(source => source.type === 'screen');
  assert.equal(selected.thumbnailState, 'pending');
  assert.equal(selected.thumbnailDataUrl, '');
  assert.equal(f.sources.resolve(selected.id, 'monitor').deviceId, monitor.deviceId);
  const previews = await e.enumerate(false, 'screen', [selected.id]);
  assert.equal(previews[0].thumbnailDataUrl, `data:image/png;base64,${Buffer.from('owned-native-image').toString('base64')}`);
  assert.equal(e.captures[0].deviceId, monitor.deviceId);
  assert.deepEqual(e.calls, []);
  assert.equal(f.sources.resolve(selected.id, 'monitor').deviceId, monitor.deviceId);
  assert.deepEqual(e.warnings, []);
});

test('screen-only metadata needs no Chromium enumeration or preview display API', async () => {
  const f = fixture(), e = desktopEnumerator(f.sources);
  const result = await e.enumerate(true, 'screen');
  assert.equal(result.length, 1);
  assert.equal(result[0].type, 'screen');
  assert.deepEqual(e.calls, []);
});

test('overlay exclusion removes metadata and previews and rejects a previously selected native source', async () => {
  const f = fixture(), e = desktopEnumerator(f.sources);
  const selected = (await e.enumerate(true)).find(source => source.type === 'window');
  f.excluded.add(window.hwnd);
  for (const kind of ['window', 'game']) assert.throws(() => f.sources.resolve(selected.id, kind), /unavailable/);
  assert.deepEqual((await e.enumerate(true)).map(source => source.type), ['screen']);
  assert.deepEqual(await e.enumerate(false, 'window', [selected.id]), []);
  assert.equal(e.captures.length, 0, 'An excluded overlay must never reach the native thumbnail capturer');
  f.excluded.clear();
  assert.throws(() => f.sources.resolve(selected.id, 'window'), /unavailable/, 'Excluded selections are revoked on refresh');
  assert.equal((await e.enumerate(true)).filter(source => source.type === 'window').length, 1);
});

test('legacy capture propagates rejected window preparation without acquiring or falling back', async () => {
  const file = path.resolve(__dirname, '..', 'src', 'renderer', 'core', 'VideoService.ts');
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  let method;
  const visit = node => {
    if (ts.isMethodDeclaration(node) && node.name.getText(source) === 'startScreenShare') method = node;
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(method);
  const compiled = ts.transpileModule(`class CaptureFixture {
    screenCaptureEpoch = 0;
    getProfile() { return { screenWidth: 640, screenHeight: 360, screenFps: 30 }; }
    ${method.getText(source)}
  }; new CaptureFixture();`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const denied = new Error('Owned overlay cannot be shared');
  const warnings = [];
  const capture = vm.runInNewContext(compiled, {
    window: { api: { prepareScreenShareWindow: async () => { throw denied; } } },
    clientLog: { info() {}, warn: (...args) => warnings.push(args) },
    navigator: { mediaDevices: { getUserMedia: () => assert.fail('A rejected source cannot be captured') } },
    Error,
  });
  await assert.rejects(capture.startScreenShare('window:123:0'), denied);
  assert.equal(warnings.length, 1, 'The rejection remains visible in standard capture diagnostics');
});

for (const platform of ['darwin', 'linux']) {
  test(`${platform} metadata and previews exclude only the exact overlay ID, not identically titled windows`, async () => {
    const image = { isEmpty: () => false, toDataURL: () => 'data:image/png;base64,owned' };
    const chromiumSources = ['window:123:0', 'window:124:0', 'screen:123:0'].map(id =>
      ({ id, name: 'Monky', thumbnail: image, appIcon: image }));
    const e = desktopEnumerator(fixture().sources, {
      platform, chromiumSources, isScreenShareSource: id => id.startsWith('window:123:'),
    });
    for (const metadata of [true, false]) {
      assert.deepEqual((await e.enumerate(metadata)).map(source => source.id), ['window:124:0', 'screen:123:0']);
    }
  });
}

test('native identity enumeration failure cannot masquerade as an empty successful Screens tab', async () => {
  const f = fixture(), e = desktopEnumerator(f.sources);
  const failure = new Error('PRIVATE_IDENTITY_DETAILS');
  f.sources.listMonitors = () => { throw failure; };
  await assert.rejects(e.enumerate(true), failure);
  assert.equal(e.warnings.length, 1);
  assert.equal(e.logs[0].message, 'Native desktop source enumeration failed');
  assert.equal(e.logs[0].data.phase, 'native-source-identities');
  assert.doesNotMatch(JSON.stringify(e.logs), /PRIVATE_/);
});

test('identical monitor names get stable numbers without any Electron DPI or thumbnail dependency', () => {
  const { nativeMonitorDesktopSources } = moduleFor();
  const physical = [
    { x: 0, y: 0, width: 1920, height: 1080 },
    { x: 1920, y: 0, width: 2560, height: 1440 },
    { x: -1080, y: 0, width: 1080, height: 1920 },
    { x: 0, y: -2160, width: 3840, height: 2160 },
  ];
  const dips = [
    physical[0], { x: 1920, y: 0, width: 2048, height: 1152 },
    { x: -864, y: 0, width: 864, height: 1536 }, { x: 0, y: -1440, width: 2560, height: 1440 },
  ];
  const displayIds = [441, -12, 0, 991];
  const selected = physical.map((bounds, index) => ({
    id: `native-monitor:${String(index + 1).repeat(64)}`,
    monitor: { ...monitor, name: 'Generic PnP Monitor', deviceName: `\\\\.\\DISPLAY${index + 1}`, bounds },
  }));
  const displays = dips.map((bounds, index) => ({ id: displayIds[index], bounds })).reverse();
  const previews = [2, 0, 3, 1].map(index => ({
    id: `screen:${index}:0`, display_id: String(displayIds[index]),
    thumbnail: { isEmpty: () => false, toDataURL: () => `data:image/png;base64,owned-${index + 1}` },
  }));
  const converted = [], warnings = [];
  const shuffled = [selected[3], selected[1], selected[2], selected[0]];
  const result = nativeMonitorDesktopSources(shuffled, previews, displays, bounds => {
    converted.push(bounds);
    return dips[physical.findIndex(value => JSON.stringify(value) === JSON.stringify(bounds))];
  }, warning => warnings.push(warning));
  assert.deepEqual(result.map(source => source.displayNumber), [1, 2, 3, 4]);
  assert.deepEqual(result.map(source => source.id), selected.map(source => source.id));
  assert.deepEqual(result.map(source => source.thumbnailDataUrl),
    ['', '', '', '']);
  assert.deepEqual(converted, []);
  assert.deepEqual(warnings, []);
  assert.equal(shuffled[0], selected[3], 'Presentation ordering must not mutate native identity enumeration.');
});

test('monitor metadata never imports Chromium images by ordinal, name or ambiguous identity', () => {
  const { nativeMonitorDesktopSources } = moduleFor();
  const selected = [{ id: `native-monitor:${'a'.repeat(64)}`, monitor }];
  const display = { id: 55, bounds: monitor.bounds };
  const preview = { id: 'screen:0:0', display_id: '55',
    thumbnail: { isEmpty: () => false, toDataURL: () => 'data:image/png;base64,owned' } };
  for (const [displays, previews] of [
    [[], [preview]], [[{ ...display, bounds: { ...monitor.bounds, x: 0 } }], [preview]],
    [[display, { ...display, id: 56 }], [preview]], [[display], [preview, preview]],
    [[display], [{ ...preview, display_id: '' }]], [[display], [{ ...preview, id: 'window:55:0' }]],
    [[display], [{ ...preview, thumbnail: { isEmpty: () => true, toDataURL: () => assert.fail('Empty thumbnail') } }]],
  ]) {
    const warnings = [];
    const [source] = nativeMonitorDesktopSources(selected, previews, displays, bounds => bounds,
      warning => warnings.push(warning));
    assert.equal(source.id, selected[0].id);
    assert.equal(source.displayNumber, 1);
    assert.equal(source.thumbnailDataUrl, '');
    assert.equal(warnings.length, 0);
  }
});

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

test('metadata-only monitor listing does not depend on Electron preview conversion or image access', () => {
  const { nativeMonitorDesktopSources } = moduleFor();
  const f = fixture(), selected = f.sources.listMonitors();
  const warnings = [];
  const result = nativeMonitorDesktopSources(selected, [], [],
    () => assert.fail('Metadata-only listing must not convert preview coordinates'),
    warning => warnings.push(warning), false);
  assert.deepEqual(result.map(source => [source.id, source.thumbnailDataUrl]), [[selected[0].id, '']]);
  assert.deepEqual(warnings, []);
  assert.deepEqual(f.sources.resolve(result[0].id, 'monitor'), {
    kind: 'monitor', deviceId: monitor.deviceId, deviceName: monitor.deviceName, bounds: monitor.bounds,
  });
});

test('monitor metadata does not call failing Electron preview helpers or substitute another display', () => {
  const { nativeMonitorDesktopSources } = moduleFor();
  for (const stage of ['coordinates', 'isEmpty', 'toDataURL']) {
    const f = fixture();
    const other = { ...monitor, deviceId: String.raw`\\?\DISPLAY#OTHER#TWO`, deviceName: String.raw`\\.\DISPLAY3`,
      bounds: { x: 0, y: 0, width: 2560, height: 1440 } };
    f.setMonitors([monitor, other]);
    const selected = f.sources.listMonitors(), warnings = [];
    const fail = () => { throw new Error(`Synthetic ${stage} failure`); };
    const displays = [monitor, other].map((value, index) => ({ id: index + 10, bounds: value.bounds }));
    const previews = displays.map((display, index) => ({
      id: `screen:${index}:0`, display_id: String(display.id),
      thumbnail: {
        isEmpty: () => { if (index === 0 && stage === 'isEmpty') fail(); return false; },
        toDataURL: () => { if (index === 0 && stage === 'toDataURL') fail(); return `owned-${index}`; },
      },
    }));
    const result = nativeMonitorDesktopSources(selected, previews, displays,
      bounds => { if (bounds.x === monitor.bounds.x && stage === 'coordinates') fail(); return bounds; },
      warning => warnings.push(warning));
    assert.deepEqual(result.map(source => source.id), selected.map(source => source.id));
    assert.deepEqual(result.map(source => source.thumbnailDataUrl), ['', '']);
    assert.equal(warnings.length, 0);
    for (const [index, expected] of [monitor, other].entries())
      assert.deepEqual(f.sources.resolve(result[index].id, 'monitor'), {
        kind: 'monitor', deviceId: expected.deviceId, deviceName: expected.deviceName, bounds: expected.bounds,
      });
    f.setMonitors([other]);
    assert.throws(() => f.sources.resolve(result[0].id, 'monitor'), /Select it again/);
  }
});

test('native preview requests capture only requested identities and minimized windows remain listed without capture', async () => {
  const f = fixture();
  f.setWindows([window, { ...window, hwnd: 124, title: 'Minimized', isIconic: true }]);
  const e = desktopEnumerator(f.sources), metadata = await e.enumerate(true, 'window');
  assert.equal(metadata.length, 2);
  assert.deepEqual(metadata.map(source => source.thumbnailState), ['pending', 'unavailable']);
  await e.enumerate(false, 'window', [metadata[1].id]);
  assert.equal(e.captures.length, 0);
  const result = await e.enumerate(false, 'window', [metadata[0].id]);
  assert.deepEqual(result.map(source => source.id), [metadata[0].id]);
  assert.equal(e.captures.length, 1);
  assert.equal(e.captures[0].hwnd, window.hwnd);
  assert.equal(e.calls.length, 0);
});

test('native preview failure stays visible without dropping the selected source or leaking native details', async () => {
  const f = fixture(), previewError = Object.assign(new Error('PRIVATE_DRIVER_DETAILS'), { code: 'ERR_DESKTOP_PREVIEW_CAPTURE' });
  const e = desktopEnumerator(f.sources, { previewError });
  const [source] = await e.enumerate(true, 'screen');
  const [preview] = await e.enumerate(false, 'screen', [source.id]);
  assert.equal(preview.id, source.id);
  assert.equal(preview.thumbnailState, 'unavailable');
  assert.equal(preview.thumbnailDataUrl, '');
  assert.equal(f.sources.resolve(source.id, 'monitor').deviceId, monitor.deviceId);
  assert.equal(e.logs[0].data.code, previewError.code);
  assert.doesNotMatch(JSON.stringify(e.logs), /PRIVATE_/);
});

for (const code of ['ERR_DESKTOP_PREVIEW_BORDER_UNSUPPORTED', 'ERR_DESKTOP_PREVIEW_BORDER_PERMISSION',
  'ERR_DESKTOP_PREVIEW_BORDER_REQUIRED']) {
  test(`${code}: missing borderless access keeps screen and window choices without a Chromium retry`, async () => {
    for (const type of ['screen', 'window']) {
      const f = fixture();
      const e = desktopEnumerator(f.sources, { previewError: Object.assign(new Error('PRIVATE_DETAILS'), { code }) });
      const [source] = await e.enumerate(true, type);
      const [preview] = await e.enumerate(false, type, [source.id]);
      assert.equal(preview.id, source.id);
      assert.equal(preview.thumbnailState, 'unavailable');
      assert.equal(preview.thumbnailDataUrl, '');
      assert.equal(e.captures.length, 1);
      assert.equal(e.logs[0].data.code, code);
      assert.deepEqual(e.calls, []);
      assert.doesNotMatch(JSON.stringify(e.logs), /PRIVATE_DETAILS/);
    }
  });
}

test('native window enumeration failures are not silently converted to an empty list', async () => {
  const f = fixture(), e = desktopEnumerator(f.sources);
  f.sources.listWindows = () => { throw new Error('Enumeration failed'); };
  await assert.rejects(e.enumerate(true, 'window'), /Enumeration failed/);
  assert.equal(e.logs[0].data.type, 'window');
  assert.equal(e.captures.length, 0);
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
