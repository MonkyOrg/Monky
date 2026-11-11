'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { loadMain } = require('./mainModules.cjs');

function fixture(ownerUrl = 'https://trusted.monky.example/app') {
  const sessions = [], views = [], contents = [], roots = [];
  class Session extends EventEmitter {
    constructor() {
      super(); this.webRequest = { onBeforeRequest() {} }; this.cleared = false; sessions.push(this);
    }
    getStoragePath() { return null; }
    setPermissionCheckHandler(callback) { this.check = callback; }
    setPermissionRequestHandler(callback) { this.request = callback; }
    setDevicePermissionHandler(callback) { this.device = callback; }
    setDisplayMediaRequestHandler(callback) { this.display = callback; }
    async clearStorageData() { this.cleared = true; }
    async clearCache() {}
    async clearAuthCache() {}
    async closeAllConnections() {}
  }
  class Contents extends EventEmitter {
    constructor(session) {
      super(); this.session = session; this.url = ''; this.dead = false; this.scripts = []; contents.push(this);
      this.navigationHistory = { canGoBack: () => false, canGoForward: () => false };
    }
    isDestroyed() { return this.dead; }
    isFocused() { return this.focused === true; }
    focus() { contents.forEach(value => { value.focused = value === this; }); }
    getURL() { return this.url; }
    getZoomFactor() { return 1; }
    setZoomFactor() {}
    setBackgroundThrottling(value) { this.throttling = value; }
    setAudioMuted() {}
    setWindowOpenHandler() {}
    isLoading() { return false; }
    getMediaSourceId(capturer) { this.capturer = capturer; return 'owner-scoped-token'; }
    async loadURL(url) { this.url = url; this.throttlingAtLoad = this.throttling; }
    async loadFile() { this.url = 'file:///trusted/toolbar.html'; }
    async executeJavaScript(script) { this.scripts.push(script); }
    stop() {}
    close() { this.dead = true; this.emit('destroyed'); }
  }
  class View {
    children = [];
    constructor() { this.bounds = { x: 0, y: 0, width: 0, height: 0 }; views.push(this); }
    addChildView(view) { this.children.push(view); }
    removeChildView(view) { this.children = this.children.filter(value => value !== view); this.onRemove?.(); }
    setVisible(value) { this.visible = value; }
    setBounds(value) { this.bounds = value; }
    getBounds() { return this.bounds; }
  }
  class WebContentsView extends View {
    constructor(options) { super(); this.options = options; this.webContents = new Contents(options.webPreferences.session); }
  }
  class BaseWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.contentView = new View();
      this.size = options.useContentSize ? [options.width, options.height] : [options.width - 16, options.height - 39];
      this.resizes = [];
      roots.push(this);
    }
    getContentSize() { return this.size; }
    setContentSize(width, height) { this.size = [width, height]; this.resizes.push([width, height]); }
    isDestroyed() { return this.dead === true; }
    destroy() { this.dead = true; this.emit('closed'); }
  }
  const owner = new EventEmitter();
  owner.webContents = new Contents(new Session()); owner.webContents.url = ownerUrl;
  owner.contentView = new View(); owner.isDestroyed = () => false; owner.getContentSize = () => [800,600];
  owner.visible = true; owner.isVisible = () => owner.visible; owner.isMinimized = () => false;
  const { MiniappBrowserWindows } = loadMain('miniappBrowserWindows', {
    packages: { electron: { BaseWindow, View, WebContentsView, session: { fromPartition: () => new Session() } } },
    local: { 'ipc/registry': { sendEvent() {} }, webContentsPolicy: { allowPersonalBrowserNavigation() {} },
      windowPreferences: { isolatedWebPreferences: (_name, options) => ({ ...options, sandbox: true, contextIsolation: true, nodeIntegration: false }) } },
  });

  const closed = [], manager = new MiniappBrowserWindows(owner, id => closed.push(id));
  const input = {
    requestId: randomUUID(), serverKey: 'server', channelId: 'room', screenId: 'browser',
    instanceId: randomUUID(), botId: 'bot', viewerId: 'host', viewerSessionId: 'host:device',
    policyVersion: 1, title: 'Browser', locale: 'en',
  };
  return { manager, owner, input, sessions, contents, views, roots, closed };
}

test('browser media permissions admit only one owner-origin tab acquisition, never website devices', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  for (const ownerUrl of ['https://trusted.monky.example/app', 'file:///trusted/app.html']) {
    const f = fixture(ownerUrl); t.after(() => f.manager.dispose());
    await f.manager.open(f.input);
    const site = f.contents.at(-1), browserSession = site.session;
    const details = {
      isMainFrame: true, mediaTypes: [], requestingUrl: 'about:blank',
      securityOrigin: new URL(ownerUrl).protocol === 'file:' ? 'file://' : new URL(ownerUrl).origin,
    };
    const request = (changes = {}, requester = site, permission = 'media') => {
      let allowed;
      browserSession.request(requester, permission, value => { allowed = value; }, { ...details, ...changes });
      return allowed;
    };
    assert.equal(browserSession.check(), false);
    assert.equal(browserSession.device(), false);
    assert.equal(request(), false, 'No owner token has been acquired');
    assert.equal(f.manager.captureSourceId(f.input.requestId), 'owner-scoped-token');
    assert.equal(site.capturer, f.owner.webContents);
    for (const invalid of [
      { isMainFrame: false }, { mediaTypes: ['video'] }, { mediaTypes: ['audio'] },
      { mediaTypes: ['audio','video'] }, { mediaTypes: undefined },
      { securityOrigin: 'https://visited.example' }, { securityOrigin: undefined },
      { securityOrigin: 'not a URL' }, { requestingUrl: 'https://visited.example' },
    ]) assert.equal(request(invalid), false);
    assert.equal(request({}, f.owner.webContents), false);
    assert.equal(request({}, site, 'geolocation'), false);
    assert.equal(request({}, site, 'clipboard-read'), false);
    assert.equal(request(), true);
    assert.equal(request(), false, 'The admitted token is one-use');
    assert.throws(() => f.manager.captureSourceId(f.input.requestId), /already/);
    assert.equal(f.owner.webContents.session.request, undefined, 'The application session handlers are untouched');
    const siteOptions = f.views.find(view => view.webContents === site).options.webPreferences;
    assert.equal(siteOptions.sandbox, true);
    assert.equal(siteOptions.contextIsolation, true);
    assert.equal(siteOptions.nodeIntegration, false);
    assert.equal(siteOptions.preload, undefined);
  }
});

test('browser capture expires and closed native contents cannot acquire or admit it', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const f = fixture(); t.after(() => f.manager.dispose());
  await f.manager.open(f.input);
  const site = f.contents.at(-1), request = site.session.request;
  f.manager.captureSourceId(f.input.requestId);
  t.mock.timers.tick(10001);
  const details = { isMainFrame: true, mediaTypes: [], requestingUrl: 'about:blank', securityOrigin: 'https://trusted.monky.example' };
  let allowed;
  request(site, 'media', value => { allowed = value; }, details);
  assert.equal(allowed, false);
  f.manager.close(f.input.requestId);
  request(site, 'media', value => { allowed = value; }, details);
  assert.equal(allowed, false);
  assert.throws(() => f.manager.captureSourceId(f.input.requestId), /retired/);
  await f.manager.closeAll();
  assert.equal(site.dead, true);
  assert.equal(site.session.cleared, true);
  assert.equal(site.session.request, null);
  assert.deepEqual(f.closed, [f.input.requestId]);
});

test('the same native site has an independent painting root before presentation and while its owner is hidden', async t => {
  const f = fixture(); t.after(() => f.manager.dispose());
  f.owner.visible = false;
  await f.manager.open(f.input);
  const entry = f.manager.entries.get(f.input.requestId), { view, site, session } = entry;
  const root = f.roots[0], contents = view.webContents;
  assert.equal(root.options.show, false);
  assert.equal(root.options.focusable, false);
  assert.equal(view.options.webPreferences.backgroundThrottling, undefined,
    'Hidden-but-painting is activated after attachment and the initial renderer load, not during construction');
  assert.equal(contents.throttlingAtLoad, undefined);
  assert.equal(contents.throttling, false);
  assert.deepEqual(root.resizes, [], 'Initial content dimensions are established before loading, not resized after the renderer starts');
  assert.deepEqual(root.contentView.children, [view]);
  assert.ok(view.bounds.width > 0 && view.bounds.height > 0);
  const bounds = { x: 20, y: 60, width: 700, height: 480 };
  f.manager.placement(f.input.requestId, bounds, bounds, true);
  f.manager.visibility(f.input.requestId, true);
  assert.equal(site, entry.site);
  assert.equal(root.contentView.children.includes(view), true, 'An initially hidden main window cannot own the painting site');
  f.owner.visible = true; f.owner.emit('show');
  assert.equal(entry.container.children.includes(view), true);
  assert.equal(root.contentView.children.includes(view), false);
  assert.equal(view.webContents, contents);
  assert.equal(contents.session, session);
  contents.focus();
  f.owner.visible = false; f.owner.emit('hide');
  assert.equal(entry.container.visible, false);
  assert.equal(f.owner.webContents.isFocused(), true, 'Hidden sites cannot keep application keyboard focus');
  assert.equal(root.contentView.children.includes(view), true);
  assert.equal(view.bounds.x, 0); assert.equal(view.bounds.y, 0);
  assert.deepEqual(root.getContentSize(), [view.bounds.width, view.bounds.height]);
  f.owner.visible = true; f.owner.emit('show');
  assert.equal(entry.container.children.includes(view), true);
  assert.equal(view.webContents, contents);
  assert.equal(contents.session, session);
  f.manager.close(f.input.requestId);
  await f.manager.closeAll();
  assert.equal(contents.isDestroyed(), true);
  assert.equal(root.isDestroyed(), true);
});

for (const transition of ['present', 'park']) test(`revocation during native ${transition} cannot reattach a closed site or close another source`, async t => {
  const f = fixture(); t.after(() => f.manager.dispose());
  await f.manager.open(f.input);
  const a = f.manager.entries.get(f.input.requestId);
  const other = { ...f.input, requestId: randomUUID(), instanceId: randomUUID() };
  await f.manager.open(other);
  const b = f.manager.entries.get(other.requestId);
  const bounds = { x: 20, y: 60, width: 700, height: 480 };
  f.manager.placement(f.input.requestId, bounds, bounds, true);
  if (transition === 'park') f.manager.visibility(f.input.requestId, true);
  const parent = transition === 'park' ? a.container : a.site.root.contentView;
  parent.onRemove = () => f.manager.close(f.input.requestId);
  f.manager.visibility(f.input.requestId, transition === 'present');
  await Promise.all([...f.manager.cleanups]);
  assert.equal(f.manager.entries.has(f.input.requestId), false);
  assert.equal(a.view.webContents.isDestroyed(), true);
  assert.equal(a.site.root.isDestroyed(), true);
  assert.equal(a.container.children.includes(a.view), false);
  assert.equal(b.view.webContents.isDestroyed(), false);
  assert.equal(b.site.root.isDestroyed(), false);
  assert.notEqual(a.session, b.session);
  f.manager.visibility(f.input.requestId, true);
  assert.equal(a.container.children.includes(a.view), false, 'Stale layout cannot revive the revoked native view');
});

test('unexpected capture-root close retires its site and disposing closes all independent native roots', async t => {
  const f = fixture(); t.after(() => f.manager.dispose());
  await f.manager.open(f.input);
  const a = f.manager.entries.get(f.input.requestId);
  const other = { ...f.input, requestId: randomUUID(), instanceId: randomUUID() };
  await f.manager.open(other);
  a.site.root.destroy();
  await Promise.all([...f.manager.cleanups]);
  assert.equal(a.view.webContents.isDestroyed(), true);
  assert.equal(f.manager.entries.size, 1);
  await f.manager.dispose();
  assert.ok(f.roots.every(root => root.isDestroyed()));
  assert.ok(f.sessions.every(value => value === f.owner.webContents.session || value.cleared));
  assert.equal(f.owner.listenerCount('hide'), 0);
  assert.equal(f.owner.listenerCount('show'), 0);
});

test('destroyed native view getters cannot strand browser or toolbar session cleanup', async t => {
  for (const surface of ['site', 'toolbar']) {
    const f = fixture(); t.after(() => f.manager.dispose());
    await f.manager.open(f.input);
    const entry = f.manager.entries.get(f.input.requestId);
    const contents = entry.view.webContents, toolbar = entry.toolbar.webContents;
    const view = surface === 'site' ? entry.view : entry.toolbar;
    const target = surface === 'site' ? contents : toolbar;
    Object.defineProperty(view, 'webContents', { get: () => target.dead ? undefined : target });
    if (surface === 'site') entry.site.root.destroy();
    else toolbar.close();
    await f.manager.closeAll();
    assert.equal(f.manager.entries.size, 0);
    assert.equal(f.manager.cleanups.size, 0);
    assert.equal(contents.dead, true);
    assert.equal(toolbar.dead, true);
    assert.equal(contents.session.cleared, true);
    assert.equal(toolbar.session.cleared, true);
  }
});

test('home appearance and language updates never execute against a navigated site or a retired instance', async t => {
  const f = fixture(); t.after(() => f.manager.dispose());
  await f.manager.open(f.input);
  const site = f.contents.at(-1), originalScripts = site.scripts.length;
  f.manager.locale(f.input.requestId, 'pt-BR');
  f.manager.appearance(f.input.requestId, { fontFamily: 'Inter', colors: { '--bg-sidebar': '#11151c' } });
  assert.equal(site.scripts.length, originalScripts + 2);
  site.url = 'https://visited.example/';
  f.manager.locale(f.input.requestId, 'en');
  f.manager.appearance(f.input.requestId, { fontFamily: 'Arial', colors: { '--bg-sidebar': '#ffffff' } });
  site.emit('did-finish-load');
  assert.equal(site.scripts.length, originalScripts + 2, 'Remote pages do not receive home scripts or app theme/text');
  f.manager.close(f.input.requestId);
  f.manager.locale(f.input.requestId, 'pt-BR');
  f.manager.appearance(f.input.requestId, { fontFamily: 'Inter', colors: {} });
  assert.equal(site.scripts.length, originalScripts + 2, 'Late updates cannot revive a closed document');
});
