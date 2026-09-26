'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const shared = require('@monky/shared');
const filename = path.resolve(__dirname, '..', 'src', 'main', 'overlayManager.ts');
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;

function fixture(platform = process.platform) {
  const windows = [], notifications = [], timers = new Set(), intervals = new Set();
  class Window extends EventEmitter {
    constructor(options) {
      super();
      this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
      this.moves = [];
      this.aspects = [];
      this.events = [];
      this.webContents = { id: windows.length + 1, send: (type, value) => this.events.push({ type, value }) };
      this.destroyed = false;
      windows.push(this);
    }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    setAspectRatio(ratio, extraSize) { this.aspects.push({ ratio, extraSize }); }
    setMinimumSize(width, height) { this.minimumSize = { width, height }; }
    showInactive() {}
    loadURL() {}
    isDestroyed() { return this.destroyed; }
    getBounds() { return { ...this.bounds }; }
    getMediaSourceId() { return `window:${this.webContents.id}:0`; }
    getNativeWindowHandle() { const buffer = Buffer.alloc(8); buffer.writeUInt32LE(this.webContents.id); return buffer; }
    setPosition(x, y) {
      this.moves.push({ x, y });
      this.bounds = { ...this.bounds, x, y };
      this.emit('moved');
    }
    setBounds(bounds) {
      this.bounds = { ...bounds };
      this.emit('resized');
    }
    userBounds(bounds, resize = false, edge = 'bottom-right') {
      let prevented = false;
      this.emit(resize ? 'will-resize' : 'will-move', { preventDefault() { prevented = true; } }, bounds, { edge });
      if (!prevented) this.bounds = { ...bounds };
      this.emit(resize ? 'resized' : 'moved');
    }
    close() {
      this.emit('close');
      if (!this.deferClosed) {
        this.destroyed = true;
        this.emit('closed');
      }
    }
  }
  const display = { workArea: { x: -2560, y: -144, width: 2560, height: 1392 } };
  const electron = { BrowserWindow: Window, screen: {
    getPrimaryDisplay: () => display, getDisplayNearestPoint: () => display,
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  } };
  const module = { exports: {} };
  vm.runInThisContext(`(function(require, module, exports, __dirname, setTimeout, clearTimeout, setInterval, clearInterval, process) {
    ${compiled}\n})`, { filename })(
    name => name === 'electron' ? electron : name === '@monky/screen-audio' ? {
      setWindowResizeAspect(handle, ratio, width, height) {
        windows[handle.readUInt32LE() - 1].aspects.push({ ratio, extraSize: { width, height } });
      },
    } : require(name), module, module.exports, path.dirname(filename),
    callback => { timers.add(callback); return callback; }, timer => timers.delete(timer),
    callback => { intervals.add(callback); return callback; }, timer => intervals.delete(timer),
    { ...process, platform },
  );
  const manager = new module.exports.OverlayManager({
    isDestroyed: () => false, getBounds: () => ({ x: -1600, y: 100, width: 700, height: 900 }),
    webContents: { send: (type, value) => notifications.push({ type, value: structuredClone(value) }) },
  });
  manager.open({ mode: 'cameras-only', layout: 'grid', position: 'bottom-right', cardOpacity: 0.85, focusActiveSpeaker: false });
  return { manager, windows, notifications, timers, intervals, flush() {
    for (const timer of [...timers]) { timers.delete(timer); timer(); }
  } };
}

test('manual movement and resize preserve exact bounds through all unrelated option updates', t => {
  const f = fixture();
  t.after(() => f.manager.close());
  const window = f.windows[0];
  for (const resize of [false, true]) {
    const bounds = { x: -2120, y: 120, width: resize ? 500 : 340, height: resize ? 360 : 240 };
    window.userBounds(bounds, resize);
    assert.equal(f.manager.getConfig().position, 'custom', 'User geometry is custom before the debounce expires');
    for (const update of [
      { cardOpacity: 0.5 }, { layout: 'horizontal' }, { layout: 'vertical' }, { layout: 'grid' },
      { mode: 'cameras-and-screens' }, { preserveAspectRatio: false }, { hideSelf: true },
      { minimalistMode: true }, { focusActiveSpeaker: true }, { autoOpenOnLeaveStage: true },
    ]) {
      f.manager.setConfig(update);
      assert.deepEqual(window.getBounds(), bounds);
      assert.deepEqual(f.manager.getConfig().bounds, bounds);
      assert.equal(f.manager.getConfig().position, 'custom');
    }
    assert.equal(window.moves.length, 0);
    f.flush();
    assert.equal(f.notifications.filter(event => event.type === 'overlay:config-updated').at(-1).value.position, 'custom');
  }
});

test('only exact overlay identities are excluded, including native IDs and retiring windows', t => {
  const f = fixture();
  t.after(() => f.manager.close());
  for (const id of ['window:1:0', 'window:1:12', `window:1:${'a'.repeat(64)}`]) {
    assert.equal(f.manager.isScreenShareSource(id), true);
  }
  for (const id of ['window:10:0', 'screen:1:0', 'window:2:0', 'Monky', 'window:0:0']) {
    assert.equal(f.manager.isScreenShareSource(id), false, 'Other windows remain selectable regardless of their titles');
  }
  const oldWindow = f.windows[0];
  oldWindow.deferClosed = true;
  f.manager.close();
  f.manager.open(f.manager.getConfig());
  assert.equal(f.manager.isScreenShareSource('window:1:0'), true, 'Closing overlay remains excluded until native destruction');
  assert.equal(f.manager.isScreenShareSource('window:2:0'), true, 'Replacement is excluded immediately');
  oldWindow.emit('closed');
  assert.equal(f.manager.isScreenShareSource('window:1:0'), false, 'Retired handles are not retained for a different future window');
  assert.equal(f.manager.isScreenShareSource('window:2:0'), true);
});

test('explicit corner selection moves once and remains a preset after programmatic move events', t => {
  const f = fixture();
  t.after(() => f.manager.close());
  const window = f.windows[0];
  window.userBounds({ ...window.getBounds(), x: -2000, y: 100 });
  f.manager.setConfig({ position: 'top-left' });
  assert.deepEqual(window.moves, [{ x: -2536, y: -120 }]);
  f.flush();
  assert.equal(f.manager.getConfig().position, 'top-left');
  f.manager.setConfig({ cardOpacity: 0.6 });
  assert.equal(window.moves.length, 1);
});

test('closing before debounce preserves manual bounds for reopening and retires all timers', () => {
  const f = fixture();
  const bounds = { x: -2120, y: 150, width: 470, height: 320 };
  f.windows[0].userBounds(bounds);
  assert.equal(f.timers.size, 1);
  f.manager.close();
  assert.equal(f.timers.size, 0);
  assert.equal(f.intervals.size, 0);
  const saved = f.notifications.filter(event => event.type === 'overlay:config-updated').at(-1).value;
  assert.deepEqual(saved.bounds, bounds);
  assert.equal(saved.position, 'custom');
  f.manager.open(saved);
  assert.deepEqual(f.windows[1].getBounds(), bounds);
  f.manager.close();
});

test('resetting only the size preserves manual coordinates, including while the overlay is hidden', () => {
  const f = fixture();
  const bounds = { x: -2120, y: 150, width: 470, height: 320 };
  f.windows[0].userBounds(bounds, true);
  f.manager.resetBounds();
  const expected = { ...bounds, width: shared.OVERLAY_DEFAULT_WIDTH, height: shared.OVERLAY_DEFAULT_HEIGHT };
  assert.deepEqual(f.windows[0].getBounds(), expected);
  assert.equal(f.manager.getConfig().position, 'custom');
  f.windows[0].userBounds(bounds, true);
  f.manager.close();
  f.manager.resetBounds();
  assert.deepEqual(f.manager.getConfig().bounds, expected);
  f.manager.open(f.manager.getConfig());
  assert.deepEqual(f.windows[1].getBounds(), expected);
  f.manager.close();
});

test('content layout resizes only the window, retaining coordinates and card dimensions', t => {
  const f = fixture();
  t.after(() => f.manager.close());
  const window = f.windows[0], cardSize = { width: 148, height: 83.25 };
  window.userBounds({ x: -2100, y: 200, width: 340, height: 400 });
  for (const [width, height] of [[176, 410], [638, 142], [330, 231]]) {
    const actual = f.manager.layoutCards(window.webContents.id, { cardSize, width, height });
    assert.deepEqual(actual, { x: -2100, y: 200, width, height });
    assert.deepEqual(f.manager.getConfig().cardSize, cardSize);
    assert.equal(f.manager.getConfig().position, 'custom');
  }
  window.userBounds({ ...window.getBounds(), x: -2000 }, false);
  assert.deepEqual(f.manager.getConfig().cardSize, cardSize, 'Moving never invalidates the card dimensions');
  window.userBounds({ ...window.getBounds(), width: 400 }, true);
  assert.equal(f.manager.getConfig().cardSize, undefined, 'Only an explicit user resize recalculates card dimensions');
});

test('oversized layouts are bounded without moving or shrinking the cards; non-owner/invalid requests fail', t => {
  const f = fixture();
  t.after(() => f.manager.close());
  const window = f.windows[0], cardSize = { width: 148, height: 83.25 };
  window.userBounds({ x: -1000, y: 400, width: 340, height: 400 });
  const actual = f.manager.layoutCards(window.webContents.id, { cardSize, width: 10000, height: 10000 });
  assert.deepEqual(actual, { x: -1000, y: 400, width: 1000, height: 848 });
  assert.deepEqual(f.manager.getConfig().cardSize, cardSize);
  assert.throws(() => f.manager.layoutCards(999, { cardSize, width: 300, height: 200 }), /Only the current overlay/);
  for (const bad of [null, {}, { cardSize, width: NaN, height: 2 }, { cardSize: { width: -1, height: 3 }, width: 300, height: 200 }])
    assert.throws(() => f.manager.layoutCards(window.webContents.id, bad), /Invalid overlay card layout/);
});

test('automatic content resizing retires a corner preset so reopening cannot reanchor the window', () => {
  const f = fixture(), window = f.windows[0];
  const before = window.getBounds();
  f.manager.layoutCards(window.webContents.id, { cardSize: { width: 140, height: 78.75 }, width: 170, height: 150 });
  const saved = structuredClone(f.manager.getConfig());
  assert.equal(saved.position, 'custom');
  assert.equal(saved.bounds.x, before.x);
  assert.equal(saved.bounds.y, before.y);
  f.manager.close();
  f.manager.open(saved);
  assert.deepEqual(f.windows[1].getBounds(), saved.bounds);
  assert.deepEqual(f.manager.getConfig().cardSize, saved.cardSize);
  f.manager.close();
});

test('late events from a closing overlay cannot retire or mutate its replacement', t => {
  const f = fixture(), oldWindow = f.windows[0];
  t.after(() => f.manager.close());
  oldWindow.deferClosed = true;
  oldWindow.userBounds({ x: -2100, y: 180, width: 340, height: 400 });
  f.manager.close();
  f.manager.open(structuredClone(f.manager.getConfig()));
  const replacement = f.windows[1], expected = structuredClone(f.manager.getConfig());
  oldWindow.emit('will-resize', {}, { x: 0, y: 0, width: 100, height: 100 });
  oldWindow.emit('resized');
  oldWindow.emit('ready-to-show');
  oldWindow.emit('closed');
  assert.equal(f.manager.isOpen(), true, 'An old closed event must not clear the new native window');
  assert.deepEqual(f.manager.getConfig(), expected);
  assert.equal(f.intervals.size, 1, 'The replacement keeps its hover observer');
  assert.doesNotThrow(() => f.manager.layoutCards(replacement.webContents.id,
    { cardSize: { width: 148, height: 83.25 }, width: 330, height: 231 }));
});

test('native aspect follows the card grid with fixed chrome, and toggles never resize the cards', t => {
  const f = fixture('darwin'), window = f.windows[0];
  t.after(() => f.manager.close());
  const cardSize = { width: 148, height: 83.25 };
  const resizeAspect = { ratio: 4 * 16 / 9, extraSize: { width: 46, height: 58 } };
  f.manager.layoutCards(window.webContents.id, { cardSize, width: 638, height: 142, resizeAspect });
  assert.deepEqual(window.aspects.at(-1), { ratio: resizeAspect.ratio, extraSize: resizeAspect.extraSize });
  const before = window.getBounds();
  for (const update of [{ preserveAspectRatio: false }, { preserveAspectRatio: false, minimalistMode: true }]) {
    f.manager.setConfig(update);
    assert.equal(window.aspects.at(-1).ratio, 0, 'Native resize is free when preservation is disabled');
    assert.deepEqual(window.getBounds(), before);
    assert.deepEqual(f.manager.getConfig().cardSize, cardSize);
  }
  f.manager.setConfig({ minimalistMode: false, preserveAspectRatio: true });
  assert.equal(window.aspects.at(-1).ratio, resizeAspect.ratio);
  assert.deepEqual(window.getBounds(), before);
  f.manager.sendSyncState({ participants: [] });
  assert.equal(window.aspects.at(-1).ratio, 0, 'An empty overlay has no stale card aspect');
  f.manager.close();
  f.manager.open(f.manager.getConfig());
  f.manager.setConfig({ preserveAspectRatio: true });
  assert.equal(f.windows[1].aspects.at(-1).ratio, 0, 'The replacement waits for its own layout measurement');
});

test('Windows installs content constraints once, without aspect/bounds writes during gestures', t => {
  const f = fixture('win32'), window = f.windows[0];
  t.after(() => f.manager.close());
  const base = { x: -2100, y: 150, width: 638, height: 142 };
  const resizeAspect = { ratio: 64 / 9, extraSize: { width: 46, height: 58 } };
  f.manager.layoutCards(window.webContents.id, {
    cardSize: { width: 148, height: 83.25 }, width: base.width, height: base.height, resizeAspect,
  });
  let writes = 0;
  const setBounds = window.setBounds.bind(window);
  window.setBounds = bounds => { writes++; setBounds(bounds); };
  for (const edge of ['top', 'bottom', 'left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right']) {
    const proposed = { ...base, width: 750, height: 170 };
    for (let i = 0; i < 5; i++) {
      window.emit('will-resize', { preventDefault() { assert.fail('Must not cancel native sizing'); } }, proposed, { edge });
    }
    assert.deepEqual(window.aspects, [resizeAspect]);
    const events = window.events.filter(event => event.type === 'overlay:resize-state-changed');
    assert.equal(events.at(-1).value, true);
    assert.equal(events.filter(event => event.value).length, events.filter(event => !event.value).length + 1);
    f.manager.layoutCards(window.webContents.id, {
      cardSize: { width: 100, height: 60 }, width: 480, height: 120, resizeAspect,
    });
    assert.equal(writes, 0, 'Even queued renderer layouts cannot set bounds during native sizing');
    assert.equal(f.manager.getConfig().cardSize, undefined);
    window.emit('resized');
    assert.equal(window.events.at(-1).value, false);
  }
  f.manager.setConfig({ preserveAspectRatio: false });
  window.userBounds(base, true);
  assert.deepEqual(window.getBounds(), base);
});

test('invalid native aspect requests are rejected before changing geometry or constraints', t => {
  const f = fixture(), window = f.windows[0];
  t.after(() => f.manager.close());
  const before = window.getBounds();
  for (const resizeAspect of [null, {}, { ratio: 0, extraSize: { width: 28, height: 58 } },
    { ratio: Infinity, extraSize: { width: 28, height: 58 } },
    { ratio: 1, extraSize: { width: -1, height: 58 } }, { ratio: 1, extraSize: { width: 28.5, height: 58 } }]) {
    assert.throws(() => f.manager.layoutCards(window.webContents.id,
      { cardSize: { width: 148, height: 83.25 }, width: 638, height: 142, resizeAspect }), /Invalid overlay resize aspect/);
  }
  assert.deepEqual(window.getBounds(), before);
  assert.equal(window.aspects.length, 0);
});

test('enabling aspect corrects existing sizes immediately while keeping separate regular/minimalist dimensions', t => {
  const f = fixture(), window = f.windows[0];
  t.after(() => f.manager.close());
  f.manager.setConfig({ preserveAspectRatio: false, cardSize: { width: 320, height: 250 } });
  const bounds = window.getBounds();
  f.manager.setConfig({ preserveAspectRatio: true });
  assert.deepEqual(f.manager.getConfig().cardSize, { width: 320, height: 180 });
  assert.deepEqual(window.getBounds(), bounds, 'Card layout, not a corner preset, sizes the outer window');
  f.manager.setConfig({ minimalistMode: true });
  assert.deepEqual(f.manager.getConfig().minimalistCardSize, { width: 240, height: 36 });
  const miniBefore = structuredClone(f.manager.getConfig());
  f.manager.layoutCards(window.webContents.id, {
    cardSize: { width: 320, height: 180 }, width: 668, height: 424, minimalistMode: false, preserveAspectRatio: true,
  });
  assert.deepEqual(f.manager.getConfig(), miniBefore, 'An old regular-mode layout cannot overwrite minimalist dimensions');
  f.manager.setConfig({ preserveAspectRatio: false, minimalistCardSize: { width: 320, height: 100 } });
  f.manager.setConfig({ preserveAspectRatio: true });
  assert.deepEqual(f.manager.getConfig().minimalistCardSize, { width: 320, height: 48 });
  const preserved = structuredClone(f.manager.getConfig());
  f.manager.layoutCards(window.webContents.id, {
    cardSize: { width: 320, height: 100 }, width: 668, height: 264, minimalistMode: true, preserveAspectRatio: false,
  });
  assert.deepEqual(f.manager.getConfig(), preserved, 'A queued free-size request cannot undo aspect activation');
  assert.deepEqual(f.manager.getConfig().cardSize, { width: 320, height: 180 });
  f.manager.setConfig({ minimalistMode: false });
  assert.deepEqual(f.manager.getConfig().cardSize, { width: 320, height: 180 });
  f.manager.setConfig({ minimalistMode: true });
  f.manager.resetBounds();
  assert.equal(f.manager.getConfig().minimalistCardSize, undefined);
  assert.deepEqual(f.manager.getConfig().cardSize, { width: 320, height: 180 }, 'Reset only affects the active mode');
});
