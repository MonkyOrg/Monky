const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const test = require('node:test');
const { sourceLoader, client } = require('./crashRecoveryFixture.cjs');

function fixture() {
  const windows = [];
  const handlers = new Map();
  const timers = new Map();
  const actions = { urls: [], copies: [], logs: [], native: [], errors: [], relaunches: 0, quits: 0, entered: 0 };
  const flags = { quitting: false, browserFails: false, copyFails: false, restartFails: false, windowFails: false };
  class Contents extends EventEmitter {
    constructor() { super(); this.mainFrame = { url: 'file:///monky/index.html' }; }
    setWindowOpenHandler(handler) { this.openHandler = handler; }
    getURL() { return this.mainFrame.url; }
  }
  class Window extends EventEmitter {
    constructor(options) {
      super();
      if (flags.windowFails) throw new Error('fixture window creation failed');
      this.options = options; this.webContents = new Contents();
      this.destroyed = false; this.visible = false; this.focused = false; windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    restore() {}
    show() { this.visible = true; }
    focus() { this.focused = true; }
    hide() { this.visible = false; }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.webContents.emit('destroyed');
      this.emit('closed');
    }
    loadURL(url) { this.webContents.mainFrame.url = url; return Promise.resolve(); }
  }
  const electron = {
    BrowserWindow: Window,
    ipcMain: {
      handle: (channel, callback) => { assert.ok(!handlers.has(channel), `Duplicate ${channel}`); handlers.set(channel, callback); },
      removeHandler: (channel) => handlers.delete(channel),
    },
    app: { getVersion: () => '18.4.2-beta', relaunch: () => {
      if (flags.restartFails) throw new Error('fixture');
      actions.relaunches++;
    } },
    clipboard: { writeText: async (text) => {
      if (flags.copyWait) await flags.copyWait;
      if (flags.copyFails) throw new Error('fixture');
      actions.copies.push(text);
    } },
    shell: { openExternal: async (url) => {
      if (flags.browserFails) throw new Error('fixture');
      actions.urls.push(url);
    } },
    dialog: {
      showMessageBox: (options) => new Promise(resolve => actions.native.push({ options, resolve })),
      showErrorBox: (...args) => actions.errors.push(args),
    },
  };
  const loader = sourceLoader(new Map([['electron', electron]]), {
    console: { ...console, error: (...args) => actions.errors.push(args) },
    setTimeout: (callback, delay) => { const token = { unref() {} }; timers.set(token, { callback, delay }); return token; },
    clearTimeout: (token) => timers.delete(token),
  });
  const shared = loader.shared('ipc');
  const recovery = new (loader.main('crashRecovery').CrashRecovery)({
    logger: () => ({ write: (entry) => actions.logs.push(entry) }),
    isQuitting: () => flags.quitting,
    onRecovery: () => actions.entered++,
    quit: () => { actions.quits++; flags.quitting = true; },
  });
  const main = new Window({});
  recovery.watch(main);
  const event = (window, child = false) => ({
    sender: window.webContents,
    senderFrame: child ? { url: window.webContents.getURL() } : window.webContents.mainFrame,
  });
  return {
    recovery, main, windows, handlers, timers, actions, flags, loader, shared, event,
    invoke: (key, window, ...args) => handlers.get(shared.CRASH_RECOVERY_IPC[key])(event(window), ...args),
    tick: (delay) => {
      for (const [token, timer] of [...timers]) {
        if (timer.delay !== delay) continue;
        timers.delete(token); timer.callback();
      }
    },
  };
}

function fatal(f) {
  f.main.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 139 });
  return f.windows[1];
}

test('fatal diagnostics retain actionable metadata, never exception messages or private paths', () => {
  const loader = sourceLoader();
  const { createCrashDiagnostic, formatCrashDiagnostic, parseBootstrapFailure } = loader.main('crashDiagnostics');
  const secret = 'super-secret-token-987';
  const error = {
    name: 'TypeError',
    stack: `TypeError: token=${secret}, alice@example.com\n`
      + '    at startup (file:///C:/Users/Alice/Monky/assets/index-ABcd1234.js:23:7)\n'
      + `    at request (https://private.example/assets/session.js?token=${secret}:15:2)\n`
      + '    at initialize (C:\\Users\\Alice\\Monky\\src\\renderer\\main.ts:50:9)\n'
      + '    at AlicePrivateFunction (file:///C:/Users/Alice/private.js:2:1)',
  };
  const diagnostic = createCrashDiagnostic({ kind: 'renderer-bootstrap', reason: 'initialization', error }, '18.4.2-beta');
  const text = formatCrashDiagnostic(diagnostic);
  assert.match(text, /TypeError/);
  assert.match(text, /index-ABcd1234\.js:23:7/);
  assert.match(text, /main\.ts:50:9/);
  for (const value of [secret, 'Alice', 'private.example', 'alice@example.com', 'request', 'token=']) {
    assert.equal(JSON.stringify(diagnostic).includes(value), false);
  }
  assert.equal(createCrashDiagnostic({ kind: 'renderer-gone', reason: secret, code: NaN }, secret).reason, undefined);
  assert.equal(createCrashDiagnostic({ kind: 'renderer-gone' }, secret).appVersion, 'unknown');
  for (const input of [null, 'fatal', {}, { phase: 'runtime', errorName: 'Error' },
    { phase: 'constructor', errorName: 'x'.repeat(101) },
    { phase: 'initialization', errorName: 'Error', stack: 'x'.repeat(12001) }]) {
    assert.equal(parseBootstrapFailure(input), null);
  }
  assert.equal(parseBootstrapFailure({ phase: 'constructor', errorName: secret }).errorName, 'Error');
});

test('reports reuse the existing category without sending diagnostics in the URL', () => {
  const loader = sourceLoader();
  const { BUG_REPORT_URL } = loader.shared('bugReport');
  const form = fs.readFileSync(path.resolve(client, '..', '..', '.github', 'DISCUSSION_TEMPLATE', 'bug-reports.yml'), 'utf8');
  const url = new URL(BUG_REPORT_URL);
  assert.equal(url.origin, 'https://github.com');
  assert.equal(url.pathname, '/MonkyOrg/Monky/discussions/new');
  assert.deepEqual([...url.searchParams], [['category', 'bug-reports']]);
  assert.match(form, /id: contexto\b/);
  assert.match(form, /label: Contexto adicional/);
  const about = fs.readFileSync(path.join(client, 'src', 'renderer', 'views', 'settings', 'tabs', 'AboutTab.ts'), 'utf8');
  assert.match(about, /openLink\(BUG_REPORT_URL\)/);
});

test('the startup boundary covers synchronous and async failures once, but not ordinary runtime errors', async () => {
  for (const phase of ['constructor', 'initialization']) {
    const failures = [];
    const loader = sourceLoader(new Map(), {
      window: { api: { reportFatalBootstrap: async (value) => { failures.push(value); return true; } } },
    });
    const { runFatalBootstrap } = loader.renderer('fatalBootstrap');
    await runFatalBootstrap(() => {}, phase);
    assert.equal(failures.length, 0);
    await runFatalBootstrap(() => phase === 'constructor'
      ? (() => { throw new TypeError('private-value'); })()
      : Promise.reject(new TypeError('private-value')), phase);
    await runFatalBootstrap(() => { throw new Error('second'); }, phase);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].phase, phase);
    assert.equal(failures[0].errorName, 'TypeError');
    assert.equal('message' in failures[0], false);
  }
});

test('a broken bootstrap bridge surfaces its failure rather than reporting success', async () => {
  for (const bridge of [undefined, async () => false, async () => { throw new Error('fixture IPC failure'); }]) {
    const errors = [];
    const loader = sourceLoader(new Map(), {
      window: { api: { reportFatalBootstrap: bridge } },
      console: { ...console, error: (...args) => errors.push(args) },
    });
    await loader.renderer('fatalBootstrap').runFatalBootstrap(() => {
      throw new TypeError('fixture fatal startup');
    }, 'constructor');
    assert.equal(errors.length, 1);
    assert.match(errors[0][0], /\[Bootstrap\]/);
  }
});

test('no recovery for healthy onboarding, subframe failures, aborted loads or normal shutdown', () => {
  const f = fixture();
  f.main.webContents.emit('did-fail-load', {}, -105, 'DNS failure', 'https://embedded.example', false);
  f.main.webContents.emit('did-fail-load', {}, -3, 'aborted', '', true);
  f.main.webContents.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 });
  assert.equal(f.windows.length, 1);
  assert.equal(f.handlers.get(f.shared.CRASH_RECOVERY_IPC.ready)(f.event(f.main, true)), false);
  assert.equal(f.timers.size, 1);
  assert.equal(f.invoke('ready', f.main), true);
  f.main.webContents.emit('did-start-navigation', {}, 'https://embedded.example', false, false);
  f.main.webContents.emit('did-start-navigation', {}, '#settings', true, true);
  f.tick(45000);
  assert.equal(f.windows.length, 1);
  assert.equal(f.timers.size, 0);
  f.main.webContents.emit('did-start-navigation', {}, 'file:///monky/index.html', false, true);
  assert.equal(f.timers.size, 1, 'a full reload arms a new startup deadline');
  assert.equal(f.invoke('ready', f.main), true);
  f.flags.quitting = true;
  f.main.webContents.emit('render-process-gone', {}, { reason: 'killed', exitCode: 9 });
  assert.equal(f.windows.length, 1);
  f.recovery.dispose();
  assert.equal(f.handlers.size, 0);
  assert.equal(f.main.webContents.listenerCount('render-process-gone'), 0);
});

test('renderer death replaces the broken window once, with no automatic report or restart', async () => {
  const f = fixture();
  const window = fatal(f);
  assert.equal(f.main.isDestroyed(), true);
  assert.equal(f.recovery.isActive(), true);
  assert.equal(window.options.webPreferences.contextIsolation, true);
  assert.equal(window.options.webPreferences.nodeIntegration, false);
  assert.equal(window.options.webPreferences.nodeIntegrationInSubFrames, false);
  assert.equal(window.options.webPreferences.partition, 'monky-crash-recovery');
  assert.equal(window.options.titleBarStyle, 'hidden');
  if (process.platform === 'darwin') {
    assert.equal(window.options.trafficLightPosition.x, 14);
    assert.equal(window.options.titleBarOverlay, undefined);
  } else {
    assert.equal(window.options.titleBarOverlay.color, '#11151c');
    assert.equal(window.options.titleBarOverlay.symbolColor, '#9da7b3');
    assert.equal(window.options.titleBarOverlay.height, 32);
  }
  assert.equal(window.webContents.openHandler({ url: 'https://untrusted.example' }).action, 'deny');
  assert.equal(f.actions.urls.length + f.actions.copies.length + f.actions.relaunches, 0);
  assert.equal(f.actions.logs[0].data.kind, 'renderer-gone');
  assert.equal(f.actions.logs[0].data.code, 139);
  assert.equal(f.recovery.show({ kind: 'renderer-gone' }), false);
  assert.equal(f.windows.length, 2);
  assert.equal(f.invoke('ready', window), true);
  assert.equal(window.visible, true);
  assert.equal(f.timers.size, 0);
  assert.equal((await f.invoke('report', f.main)).ok, false);
  assert.equal((await f.handlers.get(f.shared.CRASH_RECOVERY_IPC.report)(f.event(window, true))).ok, false);
  assert.equal((await f.invoke('report', window, 'https://untrusted.example')).ok, false);
  const reporting = f.invoke('report', window);
  assert.equal((await f.invoke('report', window)).ok, false, 'duplicate in-flight actions are rejected');
  assert.equal((await reporting).ok, true);
  assert.equal(f.actions.urls.length, 1);
  assert.equal(f.actions.copies.length, 1);
  const url = new URL(f.actions.urls[0]);
  assert.equal(url.searchParams.get('category'), 'bug-reports');
  assert.deepEqual([...url.searchParams], [['category', 'bug-reports']]);
  assert.match(f.actions.copies[0], /Incidente:/);
  assert.match(f.actions.copies[0], /renderer-gone/);
  assert.equal(f.actions.relaunches, 0, 'report does not hide the screen by restarting');
  assert.equal(f.invoke('reopen', window).ok, true);
  assert.equal(f.invoke('reopen', window).ok, false);
  assert.equal(f.actions.relaunches, 1);
  assert.equal(f.actions.quits, 1);
  f.recovery.dispose();
  assert.equal(f.timers.size, 0);
  assert.equal(f.handlers.size, 0);
  assert.equal(window.webContents.listenerCount('render-process-gone'), 0);
});

test('bootstrap fatal IPC validates its sender and payload before replacing the main renderer', () => {
  const f = fixture();
  const invoke = f.handlers.get(f.shared.CRASH_RECOVERY_IPC.bootstrapFailed);
  const input = { phase: 'initialization', errorName: 'TypeError', stack: 'TypeError: token=private' };
  assert.equal(invoke(f.event(f.main, true), input), false);
  assert.equal(invoke(f.event(f.main), { ...input, phase: 'runtime' }), false);
  assert.equal(invoke(f.event(f.main), input, 'extra'), false);
  assert.equal(f.windows.length, 1);
  assert.equal(invoke(f.event(f.main), input), true);
  assert.equal(f.actions.logs[0].data.kind, 'renderer-bootstrap');
  assert.equal(JSON.stringify(f.actions.logs).includes('token=private'), false);
  f.recovery.dispose();
});

test('missing startup JS and main-document/preload failures remain recoverable outside the bundle', () => {
  const f = fixture();
  f.tick(45000);
  assert.equal(f.actions.logs[0].data.kind, 'bootstrap-timeout');
  assert.equal(f.actions.relaunches, 0);
  f.recovery.dispose();
  for (const kind of ['document-load', 'preload', 'main-bootstrap']) {
    const next = fixture();
    if (kind === 'document-load') next.main.webContents.emit('did-fail-load', {}, -6, 'file missing', 'secret', true);
    else if (kind === 'preload') next.main.webContents.emit('preload-error', {}, 'private-path', new Error('secret'));
    else next.recovery.show({ kind, error: new Error('secret') });
    assert.equal(next.actions.logs[0].data.kind, kind);
    assert.equal(JSON.stringify(next.actions.logs).includes('secret'), false);
    next.recovery.dispose();
  }
});

test('report/copy/reopen failures are contained and permit another explicit attempt', async () => {
  const f = fixture();
  const window = fatal(f);
  f.flags.browserFails = true;
  const report = await f.invoke('report', window);
  assert.equal(report.reason, 'open-failed');
  assert.equal(report.copied, true);
  f.flags.copyFails = true;
  assert.equal((await f.invoke('copy', window)).reason, 'copy-failed');
  f.flags.browserFails = false;
  const withoutCopy = await f.invoke('report', window);
  assert.equal(withoutCopy.ok, true);
  assert.equal(withoutCopy.copied, false);
  f.flags.restartFails = true;
  assert.equal(f.invoke('reopen', window).reason, 'restart-failed');
  assert.equal(f.actions.quits, 0);
  f.flags.restartFails = false;
  assert.equal(f.invoke('reopen', window).ok, true);
  assert.equal(f.actions.quits, 1);
  f.recovery.dispose();
});

test('clipboard completion is awaited and shutdown prevents a late browser launch', async () => {
  for (const shutdown of [null, 'dispose', 'close']) {
    const f = fixture();
    const window = fatal(f);
    let finishCopy;
    f.flags.copyWait = new Promise(resolve => { finishCopy = resolve; });
    let completed = false;
    const reporting = f.invoke('report', window).then(result => { completed = true; return result; });
    await Promise.resolve();
    assert.equal(completed, false);
    assert.equal(f.actions.copies.length, 0);
    assert.equal(f.actions.urls.length, 0);
    if (shutdown === 'dispose') f.recovery.dispose();
    if (shutdown === 'close') assert.equal(f.invoke('close', window), true);
    finishCopy();
    const result = await reporting;
    assert.equal(result.copied, true);
    assert.equal(result.ok, shutdown === null);
    if (shutdown) assert.equal(result.reason, 'unavailable');
    assert.equal(f.actions.copies.length, 1);
    assert.equal(f.actions.urls.length, shutdown ? 0 : 1);
    f.recovery.dispose();
  }
});

test('a dead recovery renderer falls back to a native consent dialog without a recovery loop', async () => {
  const f = fixture();
  f.loader.main('i18n').setMainLanguage('en');
  const window = fatal(f);
  window.webContents.emit('render-process-gone', {}, { reason: 'oom', exitCode: -1 });
  f.tick(10000);
  assert.equal(f.actions.native.length, 1);
  assert.equal(f.windows.length, 2);
  assert.equal(f.actions.native[0].options.buttons[0], 'Report a bug');
  assert.equal(f.actions.urls.length + f.actions.relaunches, 0);
  f.actions.native[0].resolve({ response: 0 });
  await new Promise(setImmediate);
  assert.equal(f.actions.native.length, 2);
  assert.equal(f.actions.urls.length, 1);
  assert.equal(f.actions.relaunches, 0);
  f.actions.native[1].resolve({ response: 1 });
  await new Promise(setImmediate);
  assert.equal(f.actions.quits, 1);
  f.recovery.dispose();
  assert.equal(f.timers.size, 0);
});

test('a recovery-window allocation failure still retires the original renderer before native fallback', async () => {
  const f = fixture();
  f.flags.windowFails = true;
  f.recovery.show({ kind: 'renderer-bootstrap', reason: 'initialization' });
  assert.equal(f.main.isDestroyed(), true);
  assert.equal(f.actions.native.length, 1);
  assert.equal(f.actions.urls.length + f.actions.relaunches + f.actions.quits, 0);
  assert.match(f.actions.errors[0][0], /Could not create the recovery window/);
  f.actions.native[0].resolve({ response: 2 });
  await new Promise(setImmediate);
  assert.equal(f.actions.quits, 1);
  f.recovery.dispose();
});

test('recovery preload failure/timeout and ordinary close have bounded, distinct lifecycles', async () => {
  for (const fail of ['preload', 'timeout']) {
    const f = fixture();
    const window = fatal(f);
    if (fail === 'preload') window.webContents.emit('preload-error', {}, 'private-path', new Error('fixture'));
    else f.tick(10000);
    assert.equal(f.actions.native.length, 1);
    f.recovery.dispose();
    f.actions.native[0].resolve({ response: 0 });
    await new Promise(setImmediate);
    assert.equal(f.actions.urls.length + f.actions.relaunches, 0, 'no deferred action after disposal');
  }
  const f = fixture();
  fatal(f).destroy();
  assert.equal(f.actions.quits, 1, 'recovery closes the app, not to the tray');
  f.recovery.dispose();
});

test('the alternate page uses the saved chosen language, remains offline and escapes diagnostic text', (t) => {
  const profile = path.join(client, `.crash-recovery-test-${randomUUID()}`);
  fs.mkdirSync(profile, { recursive: true });
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const loader = sourceLoader();
  const i18n = loader.main('i18n');
  i18n.initializeMainLanguage(profile, ['en-US']);
  assert.equal(i18n.getMainLanguage(), 'en');
  i18n.setMainLanguage('pt-BR');
  const next = sourceLoader();
  next.main('i18n').initializeMainLanguage(profile, ['en-US']);
  assert.equal(next.main('i18n').getMainLanguage(), 'pt-BR');
  next.main('i18n').setMainLanguage('not-a-language');
  assert.equal(next.main('i18n').getMainLanguage(), 'pt-BR');
  const diagnostic = next.main('crashDiagnostics').createCrashDiagnostic({ kind: 'renderer-gone' }, '1.2.3');
  diagnostic.incident = '<img src=x onerror=alert(1)>';
  const page = next.main('crashRecoveryPage').buildCrashRecoveryPage(diagnostic);
  assert.match(page, /lang="pt-BR"/);
  assert.match(page, /Reabrir Monky/);
  assert.match(page, /role="status"/);
  assert.match(page, /default-src 'none'/);
  assert.match(page, /font-src data:/);
  assert.match(page, /font-family: 'Inter'/);
  assert.match(page, /data:font\/woff2;base64,/);
  assert.match(page, /<svg class="mascot"[^>]+stroke="currentColor"/);
  assert.doesNotMatch(page, /\p{Extended_Pictographic}/u);
  assert.equal(page.includes('<script'), false);
  assert.equal(page.includes('<img'), false);
  assert.match(page, /&lt;img/);
  next.main('i18n').setMainLanguage('en');
  assert.match(next.main('crashRecoveryPage').buildCrashRecoveryPage(diagnostic), /Reopen Monky/);
});

test('missing font assets do not prevent an offline recovery page or its vector mascot', () => {
  const warnings = [];
  const loader = sourceLoader(new Map([['fs', {
    ...fs,
    readFileSync(file, ...args) {
      if (String(file).endsWith('.woff2')) throw new Error('fixture missing bundled font');
      return fs.readFileSync(file, ...args);
    },
  }]]), { console: { ...console, warn: (...args) => warnings.push(args) } });
  const diagnostic = loader.main('crashDiagnostics').createCrashDiagnostic({ kind: 'renderer-gone' }, '1.2.3');
  const page = loader.main('crashRecoveryPage').buildCrashRecoveryPage(diagnostic);
  assert.match(page, /id="recovery-report"/);
  assert.match(page, /id="recovery-reopen"/);
  assert.match(page, /<svg class="mascot"/);
  assert.doesNotMatch(page, /data:font\/woff2/);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /using system fonts/);
});
