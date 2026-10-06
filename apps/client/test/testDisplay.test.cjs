'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { localDisplayPreference, displayPosition, selectWindowsDisplay, installTestDisplay } = require('./fixtures/testDisplay.cjs');

const physical = { x: -2560, y: -144, width: 2560, height: 1440 };
const workArea = { ...physical, height: 1392 };
const target = { id: 83, bounds: physical, workArea, scaleFactor: 1, displayFrequency: 144 };
const primary = { id: 1, bounds: { x: 0, y: 0, width: 2560, height: 1440 } };
const monitors = [{ deviceName: '\\\\.\\DISPLAY2', bounds: physical }];
const screen = { getAllDisplays: () => [target], dipToScreenRect: (_window, bounds) => bounds,
  screenToDipRect: (_window, bounds) => bounds, getPrimaryDisplay: () => primary };

for (const file of ['nativeCaptureSmoke.cjs', 'nativeAvSmoke.cjs', 'nativeAvSource.cjs']) {
  test(`${file} rejects display setup errors without Electron's uncaught-exception dialog`, () => {
    const filename = path.resolve(__dirname, '..', 'native', 'screen-share', 'test', file);
    const actualRequire = createRequire(filename);
    const errors = [], exits = [];
    const failure = new Error('Requested test display is unavailable');
    const requireFixture = request => {
      if (request === 'electron') return { app: { exit: code => exits.push(code) },
        BrowserWindow: class { constructor() { assert.fail('No window may be created on placement failure.'); } } };
      if (request.endsWith('test/fixtures/testDisplay.cjs'))
        return { installTestDisplay() { throw failure; } };
      return actualRequire(request);
    };
    const run = new Function('require', 'process', 'console', fs.readFileSync(filename, 'utf8'));
    run(requireFixture, { versions: { electron: 'fixture' },
      argv: ['electron', filename, `--artifacts=${path.join(__dirname, 'unused-display-fixture')}`] },
    { error: (...args) => errors.push(args) });
    assert.deepEqual(exits, [1]);
    assert.equal(errors.length, 1);
    assert.match(errors[0][0], /\[TestDisplay\].*launch rejected/);
    assert.equal(errors[0][1], failure);
  });
  test(`${file} preserves unconfigured environments without bypassing a configured display`, () => {
    const filename = path.resolve(__dirname, '..', 'native', 'screen-share', 'test', file);
    const source = fs.readFileSync(filename, 'utf8');
    const expression = source.match(file === 'nativeAvSmoke.cjs'
      ? /const window = (placement \?[^\r\n;]+);/
      : /const createWindow = options => (placement \?[^\r\n;]+);/)?.[1];
    assert.ok(expression, 'The actual smoke must use the shared placement or its original constructor.');
    const construct = new Function('placement', 'BrowserWindow', 'options', `return ${expression};`);
    let defaults = 0, placed = 0;
    class DefaultWindow { constructor() { defaults++; } }
    const placement = { createWindow() { placed++; return {}; } };
    construct(placement, DefaultWindow, { show: false });
    assert.equal(placed, 1);
    assert.equal(defaults, 0);
    const failure = new Error('Configured display is unavailable');
    assert.throws(() => construct({ createWindow() { throw failure; } }, DefaultWindow, {}),
      error => error === failure);
    assert.equal(defaults, 0);
    construct(null, DefaultWindow, { show: false });
    assert.equal(defaults, 1);
  });
}

test('monitor identity is DISPLAY2, not array index, primary status or Electron ID', () => {
  const unrelated = { id: 2, bounds: { x: 0, y: 0, width: 2560, height: 1440 } };
  const selected = selectWindowsDisplay({ ...screen, getAllDisplays: () => [target, unrelated] }, monitors, '2');
  assert.equal(selected.id, 83);
  assert.equal(selected.deviceName, '\\\\.\\DISPLAY2');
});

test('display matching compares physical bounds while placement retains Electron DIP coordinates', () => {
  const dip = { x: -2048, y: -115, width: 2048, height: 1152 };
  const logicalWorkArea = { ...dip, height: 1114 };
  const selected = selectWindowsDisplay({
    ...screen,
    getAllDisplays: () => [{ ...target, bounds: dip, workArea: logicalWorkArea, scaleFactor: 1.25 }],
    screenToDipRect: (window, bounds) => { assert.equal(window, null); assert.deepEqual(bounds, physical); return dip; },
    dipToScreenRect: (window, bounds) => {
      assert.equal(window, null);
      if (bounds === primary.bounds) return bounds;
      assert.deepEqual(bounds, dip);
      return physical;
    },
  }, monitors, '2');
  assert.deepEqual(selected.bounds, dip);
  assert.equal(selected.scaleFactor, 1.25);
  assert.deepEqual(selected.workArea, logicalWorkArea);
});

for (const reason of ['primary', 'not-left']) {
  test(`a numbered display that is ${reason} is rejected instead of opening on the wrong monitor`, () => {
    assert.throws(() => selectWindowsDisplay({
      ...screen, getPrimaryDisplay: () => reason === 'primary' ? target
        : { ...primary, bounds: { ...primary.bounds, x: -5120 } },
    }, monitors, '2'), /must be non-primary and entirely left/);
  });
}

for (const reason of ['missing', 'ambiguous', 'mismatched']) {
  test(`a ${reason} second display fails explicitly rather than falling back to the primary`, () => {
    assert.throws(() => selectWindowsDisplay({
      ...screen, getAllDisplays: () => reason === 'ambiguous' ? [target, target] : [],
    }, reason === 'missing' ? [] : monitors, '2'), /MONKY_TEST_DISPLAY=2.*DISPLAY2/);
  });
}

test('an oversized source is rejected instead of resized or allowed to overlap the primary monitor', () => {
  const requested = { x: 100, y: 100, width: 3840, height: 2160 };
  assert.throws(() => displayPosition(requested, workArea), /does not fit.*Refusing to resize/);
  assert.deepEqual(requested, { x: 100, y: 100, width: 3840, height: 2160 });
});

test('constructor coordinates precede native creation and visibility never precedes placement', () => {
  const app = new EventEmitter(), constructions = [], logs = [];
  app.exit = code => { throw new Error(`Unexpected placement failure: ${code}`); };
  class CreatedWindow extends EventEmitter {
    constructor(options) {
      super();
      this.id = constructions.length + 1;
      const proof = logs.at(-1);
      assert.equal(proof.phase, 'before-construction');
      assert.deepEqual(proof.bounds, { x: options.x, y: options.y, width: options.width, height: options.height });
      constructions.push(options);
      assert.equal(options.show, false);
      assert.equal(options.center, false);
      assert.ok(options.x < 0, 'The constructor itself must never default to the primary monitor.');
      this.bounds = { ...options };
      app.emit('browser-window-created', {}, this);
    }
    isDestroyed() { return false; }
    isMinimized() { return false; }
    getBounds() { return { ...this.bounds }; }
    getContentSize() { return [this.bounds.width, this.bounds.height]; }
    getTitle() { return 'Owned constructor fixture'; }
    showInactive() {
      assert.ok(this.bounds.x + this.bounds.width <= 0);
      this.shown = true;
      this.emit('show');
    }
  }
  const placement = installTestDisplay({ app, screen, BrowserWindow: CreatedWindow }, {
    value: '2', platform: 'win32', readDisplays: () => monitors,
    log: line => logs.push(JSON.parse(line.slice('[TestDisplay] '.length))),
  });
  const options = { x: 10, y: 20, width: 1100, height: 850, center: true };
  const visible = placement.createWindow(options);
  assert.equal(visible.shown, true);
  const hidden = placement.createWindow({ ...options, show: false });
  assert.equal(hidden.shown, undefined);
  assert.deepEqual(options, { x: 10, y: 20, width: 1100, height: 850, center: true });
  assert.throws(() => placement.createWindow({ width: 3840, height: 2160 }), /does not fit/);
  assert.equal(constructions.length, 2, 'An oversized window must be rejected before native creation.');
  placement.dispose();
});

test('test placement is inactive without either an environment or local preference', () => {
  const previous = process.env.MONKY_TEST_DISPLAY;
  delete process.env.MONKY_TEST_DISPLAY;
  try {
    const app = new EventEmitter();
    assert.equal(installTestDisplay({ app, screen }, {
      readPreference: () => undefined,
      readDisplays: () => { throw new Error('Unconfigured tests must not inspect displays.'); },
    }), null);
    assert.equal(app.listenerCount('browser-window-created'), 0);
  } finally {
    if (previous !== undefined) process.env.MONKY_TEST_DISPLAY = previous;
  }
});

test('disposing placement releases even constructors cached by the manual application', t => {
  const Module = require('node:module');
  const originalLoad = Module._load;
  class NativeWindow { constructor(options) { this.options = options; } }
  const electron = { BrowserWindow: NativeWindow };
  Module._load = function (request, ...args) {
    return request === 'electron' ? electron : Reflect.apply(originalLoad, this, [request, ...args]);
  };
  const placement = installTestDisplay({ app: new EventEmitter(), screen, BrowserWindow: NativeWindow }, {
    value: '2', platform: 'win32', readDisplays: () => monitors, log: () => {},
  });
  t.after(() => { placement.dispose(); Module._load = originalLoad; });
  placement.interceptElectronImports();
  const CachedWindow = require('electron').BrowserWindow;
  placement.dispose();
  const options = { x: 1200, y: 100, width: 500, height: 300, show: true };
  assert.deepEqual(new CachedWindow(options).options, options,
    'Later overlays must retain the user position instead of being forced onto the test monitor again.');
});

test('a persisted local preference still selects the secondary display when a launcher omits the environment', t => {
  const previous = process.env.MONKY_TEST_DISPLAY;
  delete process.env.MONKY_TEST_DISPLAY;
  t.after(() => {
    if (previous !== undefined) process.env.MONKY_TEST_DISPLAY = previous;
    else delete process.env.MONKY_TEST_DISPLAY;
  });
  const app = new EventEmitter();
  const placement = installTestDisplay({ app, screen }, {
    readPreference: () => '2', platform: 'win32', readDisplays: () => monitors, log: () => {},
  });
  t.after(() => placement.dispose());
  assert.ok(placement.windowOptions({ width: 800, height: 600 }).x < 0);
  process.env.MONKY_TEST_DISPLAY = '3';
  assert.throws(() => installTestDisplay({ app, screen }, {
    platform: 'win32', readDisplays: () => monitors,
    readPreference: () => assert.fail('An explicit environment choice must take precedence.'),
  }), /DISPLAY3 is unavailable/);
});

test('local display preferences reject malformed files instead of silently restoring default placement', t => {
  const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'monky-test-display-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'test-display.json');
  assert.equal(localDisplayPreference(filename), undefined);
  fs.writeFileSync(filename, '{"display":2}');
  assert.equal(localDisplayPreference(filename), '2');
  for (const content of ['{', '{}', '{"display":0}', '{"display":"2"}', '{"display":2.5}']) {
    fs.writeFileSync(filename, content);
    assert.throws(() => localDisplayPreference(filename));
  }
});

test('invalid display options and non-Windows platforms are rejected without probing', () => {
  for (const value of ['', '0', '-1', '2;exit', '2.5'])
    assert.throws(() => installTestDisplay({}, { value }), /positive Windows DISPLAY number/);
  assert.throws(() => installTestDisplay({}, { value: '2', platform: 'darwin' }), /requires Windows/);
  assert.throws(() => installTestDisplay({}, { value: '2', platform: 'win32', readDisplays: () => [] }),
    /DISPLAY2 is unavailable.*fallback/);
});

class Window extends EventEmitter {
  constructor(id) { super(); this.id = id; this.bounds = { x: 100, y: 50, width: 1100, height: 850 }; }
  isDestroyed() { return false; }
  isMinimized() { return this.minimized ?? false; }
  getTitle() { return `Owned fixture ${this.id}`; }
  getBounds() { return { ...this.bounds }; }
  getContentSize() { return [this.bounds.width, this.bounds.height]; }
  setBounds(position) {
    assert.deepEqual(Object.keys(position).sort(), ['x', 'y'], 'Placement cannot change requested quality or window dimensions.');
    Object.assign(this.bounds, position);
    this.emit('move');
  }
}

test('oversized source windows fail without being resized or permitted to spill onto another display', () => {
  const app = new EventEmitter();
  const placement = installTestDisplay({ app, screen }, {
    value: '2', platform: 'win32', readDisplays: () => monitors,
  });
  try {
    for (const [width, height] of [[3840, 2160], [2561, 1080], [1920, 1393]]) {
      const source = new Window(1);
      source.bounds = { x: 100, y: 50, width, height };
      source.setBounds = () => assert.fail('An oversized request must fail before any position or size change.');
      assert.throws(() => placement.place(source), /DISPLAY2.*Refusing to resize or spill/);
      assert.deepEqual(source.bounds, { x: 100, y: 50, width, height });
    }
  } finally { placement.dispose(); }
});

test('owned windows remain on DISPLAY2 through show, move, resize, restore and replacement; cleanup removes hooks', () => {
  const app = new EventEmitter(), logs = [], windows = [];
  app.exit = code => { throw new Error(`Unexpected placement failure: ${code}`); };
  const placement = installTestDisplay({ app, screen }, {
    value: '2', platform: 'win32', readDisplays: () => monitors, log: message => logs.push(message),
  });
  const open = id => {
    const window = new Window(id);
    app.emit('browser-window-created', {}, window);
    windows.push(window);
    return window;
  };
  const source = open(1), receiver = open(2);
  for (const event of ['show', 'move', 'resize', 'ready-to-show', 'restore']) {
    Object.assign(source.bounds, { x: 20, y: 20 });
    source.emit(event);
    assert.ok(source.bounds.x < 0);
    assert.equal(source.bounds.width, 1100);
    assert.equal(source.bounds.height, 850);
  }
  Object.assign(source.bounds, { width: 1920, height: 1080 });
  source.emit('resize');
  assert.deepEqual(source.bounds, { x: -1920, y: 20, width: 1920, height: 1080 });
  const snapshot = placement.snapshot()[0];
  assert.equal(snapshot.oversized, false);
  assert.ok(snapshot.bounds.x + snapshot.bounds.width <= workArea.x + workArea.width
    && snapshot.bounds.y + snapshot.bounds.height <= workArea.y + workArea.height);
  receiver.minimized = true;
  receiver.emit('move');
  receiver.minimized = false;
  receiver.bounds.x = 100;
  receiver.emit('restore');
  assert.ok(receiver.bounds.x < 0);
  source.emit('closed');
  const replacement = open(3);
  assert.deepEqual(placement.snapshot().map(window => window.windowId), [2, 3]);
  assert.ok(replacement.bounds.x < 0);
  assert.ok(logs.every(line => line.includes('DISPLAY2')));
  app.emit('will-quit');
  assert.equal(app.listenerCount('browser-window-created'), 0);
  for (const window of [receiver, replacement])
    for (const event of ['show', 'move', 'resize', 'ready-to-show', 'restore'])
      assert.equal(window.listenerCount(event), 0);
});

test('production-style Electron imports cannot bypass constructor placement or create a window with unresolved bounds', t => {
  const Module = require('node:module'), originalLoad = Module._load;
  const app = new EventEmitter(), constructions = [];
  app.exit = code => assert.fail(`Unexpected test-process exit: ${code}`);
  class NativeWindow extends Window {
    constructor(options) {
      super(constructions.length + 1);
      assert.equal(options.show, false, 'Native creation must remain hidden.');
      assert.equal(options.center, false);
      assert.ok(options.x >= workArea.x && options.x + options.width <= workArea.x + workArea.width);
      assert.ok(options.y >= workArea.y && options.y + options.height <= workArea.y + workArea.height);
      constructions.push(options);
      this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
      app.emit('browser-window-created', {}, this);
    }
    showInactive() { this.shown = true; this.emit('show'); }
  }
  const electron = { app, screen, BrowserWindow: NativeWindow };
  t.mock.method(Module, '_load', function (request, ...args) {
    return request === 'electron' ? electron : Reflect.apply(originalLoad, this, [request, ...args]);
  });
  const unwrappedLoad = Module._load;
  let resolved = true;
  const placement = installTestDisplay({ ...electron, screen: {
    ...screen, getAllDisplays: () => resolved ? [target] : [],
  } }, { value: '2', platform: 'win32', readDisplays: () => monitors, log: () => {} });
  try {
    placement.interceptElectronImports();
    const { BrowserWindow: ImportedWindow } = require('electron');
    assert.notEqual(ImportedWindow, NativeWindow);
    const main = new ImportedWindow({ width: 700, height: 950, show: true });
    const reopened = new ImportedWindow({ width: 640, height: 440, show: false, center: true, x: 100, y: 100 });
    assert.equal(main.shown, true);
    assert.equal(reopened.shown, undefined);
    assert.ok(main instanceof NativeWindow);
    assert.ok(main instanceof ImportedWindow);
    resolved = false;
    assert.throws(() => new ImportedWindow({ width: 700, height: 950 }), /could not uniquely match/);
    assert.equal(constructions.length, 2, 'Missing display proof must fail before native construction.');
  } finally { placement.dispose(); }
  assert.equal(Module._load, unwrappedLoad);
  assert.equal(require('electron').BrowserWindow, NativeWindow);
});
