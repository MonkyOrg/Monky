const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

const windowActivitySlice = () => {
  const file = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipcHandlers.ts'), 'utf8');
  const start = file.indexOf('const isWindowAway =');
  const end = file.indexOf("ipcMain.handle('window:minimize'", start);
  assert.ok(start >= 0 && end > start);
  return ts.transpileModule(file.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
};

const loadWindowModule = (screen, globals = {}) => {
  const file = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'screenPictureInPictureWindow.ts'), 'utf8');
  const code = ts.transpileModule(file, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, ...globals,
    require: name => {
      assert.equal(name, 'electron');
      return { screen };
    },
  });
  return module.exports;
};

const flush = () => new Promise(resolve => setImmediate(resolve));
// Objects created inside the vm realm have foreign prototypes.
const plain = value => JSON.parse(JSON.stringify(value));

test('screen PiP popups are authorized only for the main frame, and automatic ones only while Monky is away', async () => {
  const requestId = '0bb2238a-3560-4dc1-bb1c-72b6978aa96a';
  let focused = true, minimized = false, visible = true, destroyed = false;
  const events = new Map(), notifications = [], handlers = new Map(), grants = [], owners = [];
  const mainWindow = {
    isDestroyed: () => destroyed, isFocused: () => focused, isMinimized: () => minimized, isVisible: () => visible,
    on: (name, callback) => events.set(name, callback),
    webContents: { isDestroyed: () => destroyed, send: name => notifications.push(name), mainFrame: {} },
  };
  class ScreenPictureInPictureWindows {
    constructor(owner) { owners.push(owner); }
    authorize(id, aspectRatio) { grants.push([id, aspectRatio]); }
  }
  vm.runInNewContext(windowActivitySlice(), {
    mainWindow, ScreenPictureInPictureWindows,
    ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) },
  });
  assert.deepEqual([...handlers.keys()], ['screen-pip:open', 'screen-pip:return']);
  assert.deepEqual(owners, [mainWindow], 'Only the main window owns screen PiP popups');
  const handler = handlers.get('screen-pip:open');
  const event = { sender: mainWindow.webContents, senderFrame: mainWindow.webContents.mainFrame };
  assert.equal(events.has('blur'), false, 'Losing focus is never a reason for automatic PiP');
  focused = false;
  events.get('focus')();
  assert.deepEqual(notifications, [], 'A visible, unfocused window is still on screen');
  minimized = true;
  events.get('minimize')();
  events.get('hide')();
  assert.deepEqual(notifications, ['window:inactive'], 'Minimize and hide are one inactive period');
  focused = true;
  events.get('focus')();
  assert.equal(notifications.length, 1, 'Minimized windows never announce a visible stage return');
  minimized = false;
  events.get('restore')();
  events.get('show')();
  assert.deepEqual(notifications, ['window:inactive', 'window:active'], 'Restore and show are one return');
  visible = false;
  events.get('hide')();
  assert.deepEqual(notifications, ['window:inactive', 'window:active', 'window:inactive'], 'Hiding to the tray leaves the screen');
  visible = true;
  events.get('show')();
  assert.equal(notifications.length, 4);
  assert.equal(handler(event, requestId, true, 16 / 9), false, 'A focused window is not away');
  focused = false;
  assert.equal(handler(event, requestId, true, 16 / 9), false, 'Alt+Tab keeps the window on screen');
  assert.deepEqual(grants, []);
  minimized = true;
  assert.equal(handler(event, requestId, true, 16 / 9), true);
  minimized = false; visible = false;
  assert.equal(handler(event, requestId, true, 4 / 3), true);
  visible = true; focused = true;
  assert.equal(handler(event, requestId, false, 0.5), true, 'Navigation and the PiP button work while the app is focused');
  assert.deepEqual(grants, [[requestId, 16 / 9], [requestId, 4 / 3], [requestId, 0.5]]);
  for (const [sender, token, inactive, aspect] of [
    [{ ...event, sender: {} }, requestId, false, 1],
    [{ ...event, senderFrame: {} }, requestId, false, 1],
    [event, 'invalid"); alert(1)', false, 1],
    [event, requestId, 'false', 1],
    [event, requestId, false, '1.7'],
    [event, requestId, false, 0],
    [event, requestId, false, -1],
    [event, requestId, false, Number.NaN],
    [event, requestId, false, Number.POSITIVE_INFINITY],
  ]) assert.throws(() => handler(sender, token, inactive, aspect), /Invalid screen/);
  destroyed = true;
  events.get('minimize')();
  events.get('restore')();
  assert.equal(notifications.length, 4, 'Destroyed windows never send activity notifications');
  assert.throws(() => handler(event, requestId, false, 1), /Invalid screen/);
  assert.equal(grants.length, 3, 'Invalid requests never authorize a popup');
});

test('PiP back to Monky restores, shows and focuses only the owning main window', async () => {
  let minimized = true, visible = true, focused = false, destroyed = false;
  const calls = [], handlers = new Map();
  const mainWindow = {
    isDestroyed: () => destroyed, isMinimized: () => minimized, isVisible: () => visible, isFocused: () => focused,
    on: () => {},
    restore: () => { calls.push('restore'); minimized = false; },
    show: () => { calls.push('show'); visible = true; },
    focus: () => { calls.push('focus'); focused = true; },
    webContents: { isDestroyed: () => destroyed, send: () => {}, mainFrame: {} },
  };
  vm.runInNewContext(windowActivitySlice(), {
    mainWindow, ScreenPictureInPictureWindows: class { authorize() {} },
    ipcMain: { handle: (channel, callback) => handlers.set(channel, callback) },
  });
  const returnToMonky = handlers.get('screen-pip:return');
  const event = { sender: mainWindow.webContents, senderFrame: mainWindow.webContents.mainFrame };
  await returnToMonky(event);
  assert.deepEqual(calls, ['restore', 'focus'], 'A minimized window is restored and focused');
  minimized = false; visible = false; focused = false; calls.length = 0;
  await returnToMonky(event);
  assert.deepEqual(calls, ['show', 'focus'], 'A window hidden in the tray is shown and focused');
  calls.length = 0;
  await returnToMonky(event);
  assert.deepEqual(calls, ['focus'], 'A visible window is only focused');
  calls.length = 0;
  for (const invalid of [{ ...event, sender: {} }, { ...event, senderFrame: {} }]) {
    assert.throws(() => returnToMonky(invalid), /Invalid screen/);
  }
  destroyed = true;
  assert.throws(() => returnToMonky(event), /Invalid screen/);
  assert.deepEqual(calls, [], 'Foreign frames or a destroyed window never move the main window');
});

test('the PiP popup is single-use, sandboxed, floating, never steals focus and remembers where the user left it', async () => {
  const displays = [
    { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
    { id: 2, workArea: { x: 1920, y: 0, width: 1280, height: 984 } },
  ];
  let cursor = { x: 0, y: 0 }, now = 1000, ownerDestroyed = false;
  const screen = {
    getDisplayMatching: rect => displays.find(({ workArea: area }) => rect.x >= area.x && rect.x < area.x + area.width) ?? displays[0],
    getCursorScreenPoint: () => cursor,
  };
  const intervals = [], cleared = [];
  const { ScreenPictureInPictureWindows, handleScreenPictureInPictureOpen, SCREEN_PIP_FRAME_PREFIX } = loadWindowModule(screen, {
    setInterval: (callback, ms) => intervals.push({ callback, ms }),
    clearInterval: id => cleared.push(id),
  });
  assert.equal(SCREEN_PIP_FRAME_PREFIX, 'monky-screen-pip-');
  const ownerEvents = new Map();
  const owner = {
    isDestroyed: () => ownerDestroyed,
    getNormalBounds: () => ({ x: 100, y: 100, width: 1200, height: 800 }),
    webContents: { on: (name, callback) => ownerEvents.set(name, callback) },
  };
  const windows = new ScreenPictureInPictureWindows(owner, () => now);
  const details = (id, overrides = {}) => ({
    url: 'about:blank', frameName: `monky-screen-pip-${id}`, disposition: 'new-window', ...overrides,
  });
  const open = (id, overrides) => plain(handleScreenPictureInPictureOpen(owner.webContents, details(id, overrides)));

  assert.equal(handleScreenPictureInPictureOpen(owner.webContents,
    { url: 'https://example.com/', frameName: '', disposition: 'foreground-tab' }), null, 'Links keep the regular handler');
  assert.deepEqual(plain(handleScreenPictureInPictureOpen({}, details('a'))), { action: 'deny' }, 'Other web contents own no PiP');
  assert.deepEqual(open('never-authorized'), { action: 'deny' });
  windows.authorize('url', 16 / 9);
  assert.deepEqual(open('url', { url: 'https://example.com/' }), { action: 'deny' }, 'Only an empty popup is allowed');
  assert.deepEqual(open('url'), { action: 'deny' }, 'A rejected attempt consumes the authorization');
  windows.authorize('tab', 16 / 9);
  assert.deepEqual(open('tab', { disposition: 'foreground-tab' }), { action: 'deny' });
  windows.authorize('late', 16 / 9);
  now += 10_000;
  assert.deepEqual(open('late'), { action: 'deny' }, 'Authorizations expire');
  windows.authorize('gone', 16 / 9);
  ownerDestroyed = true;
  assert.deepEqual(open('gone'), { action: 'deny' });
  ownerDestroyed = false;

  windows.authorize('first', 16 / 9);
  const allowed = open('first');
  assert.equal(allowed.action, 'allow');
  assert.equal(allowed.outlivesOpener, false, 'The popup closes with the window that owns the stream');
  const options = allowed.overrideBrowserWindowOptions;
  assert.deepEqual({ x: options.x, y: options.y, width: options.width, height: options.height },
    { x: 1520, y: 808, width: 384, height: 216 }, 'The first PiP sits at the bottom right of the Monky display');
  assert.deepEqual({ minWidth: options.minWidth, minHeight: options.minHeight }, { minWidth: 192, minHeight: 108 });
  assert.deepEqual({
    show: options.show, frame: options.frame, alwaysOnTop: options.alwaysOnTop, skipTaskbar: options.skipTaskbar,
    resizable: options.resizable, minimizable: options.minimizable, maximizable: options.maximizable,
    fullscreenable: options.fullscreenable,
  }, {
    show: false, frame: false, alwaysOnTop: true, skipTaskbar: true,
    resizable: true, minimizable: false, maximizable: false, fullscreenable: false,
  });
  assert.deepEqual(options.webPreferences, {
    sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false,
    webviewTag: false, backgroundThrottling: false, spellcheck: false,
  }, 'The popup has no preload, Node or extra privileges');
  assert.deepEqual(open('first'), { action: 'deny' }, 'Authorizations are single-use');

  const createChild = () => {
    const events = new Map(), contentsEvents = new Map(), calls = [], css = [];
    let bounds = { x: 1520, y: 808, width: 384, height: 216 }, destroyed = false, openHandler;
    const on = (name, callback) => events.set(name, [...events.get(name) ?? [], callback]);
    const child = {
      calls, css,
      emit: name => (events.get(name) ?? []).forEach(callback => callback()),
      moveTo: next => { bounds = next; child.emit('moved'); },
      isDestroyed: () => destroyed, isMinimized: () => false, isVisible: () => true, getBounds: () => bounds,
      removeMenu: () => calls.push('removeMenu'),
      setAspectRatio: ratio => { calls.push(`aspect:${ratio}`); bounds = { ...bounds, width: bounds.width - 2 }; },
      setBounds: next => { calls.push(`bounds:${next.width}x${next.height}`); bounds = { ...next }; },
      showInactive: () => calls.push('showInactive'),
      show: () => calls.push('show'), focus: () => calls.push('focus'),
      close: () => { calls.push('close'); child.emit('close'); destroyed = true; child.emit('closed'); },
      on, once: on,
      webContents: {
        isDestroyed: () => destroyed,
        setWindowOpenHandler: handler => { openHandler = handler; },
        on: (name, callback) => contentsEvents.set(name, callback),
        insertCSS: async text => { css.push(['insert', text]); return `key-${css.length}`; },
        removeInsertedCSS: async key => { css.push(['remove', key]); },
      },
      openHandler: () => openHandler,
      contentsEvent: name => contentsEvents.get(name),
    };
    return child;
  };
  const first = createChild();
  ownerEvents.get('did-create-window')(first, { frameName: 'monky-screen-pip-first' });
  assert.deepEqual(first.calls, ['removeMenu', `aspect:${16 / 9}`, 'bounds:384x216', 'showInactive'],
    'The size trimmed by the Windows aspect-ratio constraint is restored before showing');
  const unrelated = createChild();
  ownerEvents.get('did-create-window')(unrelated, { frameName: 'monky-screen-pip-first' });
  assert.deepEqual(unrelated.calls, [], 'A window is adopted only once per authorization');
  assert.equal(first.calls.includes('show') || first.calls.includes('focus'), false, 'PiP never takes focus from a game');
  assert.deepEqual(plain(first.openHandler()()), { action: 'deny' }, 'The popup cannot open more windows');
  let prevented = false;
  first.contentsEvent('will-navigate')({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true, 'The popup cannot navigate away from its own document');

  assert.equal(intervals.length, 1);
  cursor = { x: 1600, y: 900 };
  intervals[0].callback();
  intervals[0].callback();
  await flush();
  assert.deepEqual(first.css, [['insert', ':root { --monky-pip-hover: 1; }']], 'Hovering reveals the controls once');
  cursor = { x: 10, y: 10 };
  intervals[0].callback();
  await flush();
  assert.deepEqual(first.css.at(-1), ['remove', 'key-1'], 'Leaving hides them again');

  first.moveTo({ x: 1700, y: 900, width: 400, height: 225 });
  windows.authorize('second', 9 / 16);
  const portrait = open('second').overrideBrowserWindowOptions;
  assert.deepEqual({ x: portrait.x, y: portrait.y, width: portrait.width, height: portrait.height },
    { x: 1520, y: 329, width: 400, height: 711 }, 'The next PiP keeps the user width and stays inside the work area');
  assert.deepEqual({ minWidth: portrait.minWidth, minHeight: portrait.minHeight }, { minWidth: 108, minHeight: 192 });
  const second = createChild();
  ownerEvents.get('did-create-window')(second, { frameName: 'monky-screen-pip-second' });
  assert.ok(first.calls.includes('close'), 'Only one screen PiP exists at a time');
  assert.equal(cleared.length, 1, 'A closed PiP stops polling the cursor');
  second.close();

  windows.authorize('wide', 100);
  const wide = open('wide').overrideBrowserWindowOptions;
  assert.equal(wide.width / wide.height, 4, 'Extreme aspect ratios are clamped');
  windows.authorize('other-display', 16 / 9);
  const moved = createChild();
  ownerEvents.get('did-create-window')(moved, { frameName: 'monky-screen-pip-wide' });
  moved.moveTo({ x: 3000, y: 50, width: 640, height: 360 });
  const onSecondDisplay = open('other-display').overrideBrowserWindowOptions;
  assert.deepEqual({ x: onSecondDisplay.x, y: onSecondDisplay.y, width: onSecondDisplay.width, height: onSecondDisplay.height },
    { x: 2560, y: 50, width: 640, height: 360 }, 'A PiP moved to another monitor reopens there');
});
