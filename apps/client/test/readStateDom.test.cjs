const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');

// Unread markers, "mark as read" menus and per-server notifications on the
// server rail, plus the lazily loaded changelog history, in real Chromium.
if (!process.versions.electron) {
  const { test } = require('node:test');
  const assert = require('node:assert/strict');
  test('rail read state, server notifications and changelog history work with real input', { timeout: 120000 }, async () => {
    const profile = path.join(root, 'dist-test', `read-state-profile-${process.pid}`);
    fs.mkdirSync(profile, { recursive: true });
    const env = { ...process.env, MONKY_READ_STATE_PROFILE: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    try {
      const result = await new Promise((resolve, reject) => {
        const child = spawn(require('electron'), [__filename], { cwd: root, env, stdio: 'inherit' });
        child.once('error', reject);
        child.once('exit', resolve);
      });
      assert.equal(result, 0);
    } finally {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
} else {
  const { app, BrowserWindow } = require('electron');
  app.setPath('userData', process.env.MONKY_READ_STATE_PROFILE);
  app.on('window-all-closed', () => {});
  let vite, browser, timeout;
  const finish = async (code) => {
    clearTimeout(timeout);
    if (browser && !browser.isDestroyed()) browser.destroy();
    if (vite) await vite.close();
    app.exit(code);
  };
  app.whenReady().then(async () => {
    timeout = setTimeout(() => { console.error('Read state DOM timeout'); void finish(1); }, 100000);
    const { createServer } = await import('vite');
    vite = await createServer({
      configFile: path.join(root, 'vite.config.ts'), logLevel: 'error',
      cacheDir: path.join(app.getPath('userData'), 'vite-cache'),
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false },
      plugins: [{
        name: 'read-state-regression',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__read_state__') return next();
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><html><head><link rel="stylesheet" href="/styles/theme.css"></head>' +
              '<body><div class="server-rail" id="server-rail" style="height: 560px"></div></body></html>');
          });
        },
      }],
    });
    await new Promise((resolve, reject) => {
      vite.httpServer.once('error', reject);
      vite.httpServer.listen(0, '127.0.0.1', resolve);
    });
    browser = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: {
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true,
    } });
    const evaluate = (code) => browser.webContents.executeJavaScript(code, true);
    const frames = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const waitFor = async (expression, timeoutMs = 4000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await evaluate(expression)) return true;
        await frames();
      }
      return false;
    };
    const center = (selector) => evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return null;
      const box = node.getBoundingClientRect();
      return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
    })()`);
    const press = async (point, button) => {
      browser.webContents.sendInputEvent({ type: 'mouseMove', ...point });
      browser.webContents.sendInputEvent({ type: 'mouseDown', button, clickCount: 1, ...point });
      browser.webContents.sendInputEvent({ type: 'mouseUp', button, clickCount: 1, ...point });
      await frames();
    };
    const check = async (condition, message) => {
      if (!condition) throw new Error(`${message}: ${JSON.stringify(await evaluate('window.readState()'))}`);
    };
    const openMenu = async (selector) => {
      const point = await center(selector);
      await check(point, `${selector} is on screen`);
      await press(point, 'right');
      await check(await waitFor(`!!document.querySelector('.floating-context-menu:not([data-ui-closing])')`), `${selector} opens a menu`);
    };
    // Marks the wanted item so it can be clicked with the real pointer.
    const menuItem = (label) => evaluate(`(() => {
      document.querySelectorAll('[data-test-item]').forEach(node => node.removeAttribute('data-test-item'));
      const item = [...document.querySelectorAll('.floating-context-menu:not([data-ui-closing]) [role^="menuitem"]')]
        .find(node => node.textContent.includes(window.label(${JSON.stringify(label)})));
      if (!item) return null;
      item.setAttribute('data-test-item', '');
      return { disabled: item.disabled, checked: item.getAttribute('aria-checked') };
    })()`);
    const choose = async (label) => {
      const item = await menuItem(label);
      await check(item && !item.disabled, `${label} is offered`);
      await press(await center('[data-test-item]'), 'left');
      await frames();
    };
    // Empty space at the end of the server list, below the add button.
    const openListMenu = async () => {
      const point = await evaluate(`(() => {
        const box = document.querySelector('.server-rail-list').getBoundingClientRect();
        return { x: Math.round(box.left + box.width / 2), y: Math.round(box.bottom - 6) };
      })()`);
      await press(point, 'right');
      await check(await waitFor(`!!document.querySelector('.floating-context-menu:not([data-ui-closing])')`), 'the server list opens a menu');
    };
    const closeMenu = () => evaluate(`import('/views/ContextMenu.ts').then(({ contextMenu }) => contextMenu.close())`);
    try {
      await browser.loadURL(`http://127.0.0.1:${vite.httpServer.address().port}/__read_state__`);
      const setup = await evaluate(`(${setupFixture.toString()})().then(() => null).catch(error => ({ failure: error.stack || String(error) }))`);
      if (setup?.failure) throw new Error(setup.failure);

      // Background servers show their state; the one on screen never does.
      await check(await evaluate(`!document.querySelector('.server-rail-item.active .server-rail-badge')`), 'the current server has no rail badge');
      await check(await evaluate(`document.querySelector('[data-port="5102"] .server-rail-badge')?.dataset.kind === 'mention'`), 'a mention shows the red badge');
      await check(await evaluate(`document.querySelector('[data-port="5103"] .server-rail-badge')?.dataset.kind === 'unread'`), 'plain unread shows the white badge');
      await check(await evaluate(`document.querySelector('.server-rail-item[data-port="5103"]').classList.contains('server-rail-item--unread')`), 'unread servers show the side pill');

      // Mark a single server as read: its own connection clears the mention.
      await openMenu('.server-rail-avatar[data-port="5102"]');
      await choose('serverRail.markServerRead');
      await check(await evaluate(`!document.querySelector('[data-port="5102"] .server-rail-badge')`), 'the server badge disappears');
      await check(await evaluate(`JSON.stringify(window.sent) === JSON.stringify([{ server: 'b', type: 'CHAT_MENTIONS_READ', channelId: 'b-1' }])`),
        'the mention is cleared on the server that owns it');
      await check(await evaluate(`window.sessions.b.chatStore.hasAnyUnread() === false && window.sessions.c.chatStore.hasAnyUnread() === true`),
        'other servers keep their unread state');

      // Silence a server and choose a specific mode from the submenu.
      await openMenu('.server-rail-avatar[data-port="5102"]');
      await choose('serverRail.mute');
      await check(await evaluate(`window.settings.getServerChatSoundOverride('server-b') === 'none'`), 'muting saves the per-server preference');
      await check(await evaluate(`!!document.querySelector('[data-port="5102"] .server-rail-muted')`), 'a muted server is marked on the rail');
      await openMenu('.server-rail-avatar[data-port="5102"]');
      await check(await menuItem('serverRail.unmute'), 'a muted server offers to unmute');
      const submenu = await center('.floating-context-menu:not([data-ui-closing]) [aria-haspopup="menu"]');
      await press(submenu, 'left');
      await check(await waitFor(`document.querySelectorAll('.floating-context-menu:not([data-ui-closing])').length === 2`), 'the notification submenu opens');
      await check((await menuItem('chatSound.none'))?.checked === 'true', 'the current mode is checked');
      await choose('chatSound.mentions');
      await check(await evaluate(`window.settings.getServerChatSoundOverride('server-b') === 'mentions'`), 'the submenu changes only this server');
      await check(await evaluate(`!document.querySelector('[data-port="5102"] .server-rail-muted') && window.settings.getServerChatSoundOverride('server-c') === 'inherit'`),
        'the marker follows the mode and other servers keep theirs');

      // A collapsed folder summarizes its servers and can be cleared at once.
      await evaluate(`window.folderize()`);
      await check(await evaluate(`document.querySelector('.server-rail-folder-badge')?.dataset.kind === 'unread'`), 'a collapsed folder shows unread servers inside');
      await openMenu('.server-rail-folder-header');
      await choose('serverRail.markFolderRead');
      await check(await evaluate(`!document.querySelector('.server-rail-folder-badge') && !window.sessions.c.chatStore.hasAnyUnread()`), 'the folder is marked as read');

      // Nothing left: the global entries stay visible but disabled.
      await evaluate(`window.sessions.c.chatStore.markMention('c-2')`);
      await openListMenu();
      await choose('serverRail.markAllServersRead');
      await check(await evaluate(`!window.sessions.c.chatStore.hasAnyUnread() && window.sent.some(item => item.server === 'c' && item.channelId === 'c-2')`),
        'mark all clears every server');
      await openListMenu();
      await check((await menuItem('serverRail.markAllServersRead'))?.disabled === true, 'mark all is disabled when nothing is unread');
      await closeMenu();
      await openMenu('#server-rail-home');
      await check((await menuItem('serverRail.markAllDmsRead'))?.disabled === true, 'Home offers to mark conversations as read');
      await closeMenu();

      // Changelog: older releases load as the list is scrolled, without duplicates.
      await evaluate(`window.openChangelog()`);
      await check(await waitFor(`document.querySelectorAll('.changelog-release').length > 0`), 'the first older releases load on their own');
      await check(await evaluate(`window.historyCalls[0]?.before === '40.3.2' && window.historyCalls[0]?.page === 1`), 'history starts after the version on screen');
      const scrollToEnd = () => evaluate(`(() => { const body = document.querySelector('.changelog-body'); body.scrollTop = body.scrollHeight; })()`);
      await scrollToEnd();
      await check(await waitFor(`!!document.querySelector('[data-history-retry]')`), 'a failed page offers a retry');
      await check(await evaluate(`!!document.querySelector('.chat-copy-toast--danger[role="alert"]')`), 'the failure is reported in a toast');
      await press(await center('[data-history-retry]'), 'left');
      for (let attempt = 0; attempt < 20 && !(await evaluate(`!!document.querySelector('.changelog-history-note:not([role])')`)); attempt++) {
        await scrollToEnd();
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      const versions = await evaluate(`[...document.querySelectorAll('.changelog-release')].map(node => node.dataset.version)`);
      await check(JSON.stringify(versions) === JSON.stringify(expectedVersions()), `every older release shows once, stable before beta (${versions})`);
      await check(await evaluate(`document.querySelectorAll('.changelog-history-heading').length === 1`), 'one "previous versions" heading');
      await evaluate(`window.closeChangelog()`);
      console.log('Read state DOM passed');
      await finish(0);
    } catch (error) {
      console.error(error);
      await finish(1);
    }
  });
}

function expectedVersions() {
  return ['40.2.0', '40.1.1', '40.0.0', '39.0.0', '38.0.0', '37.0.0', '36.0.0'];
}

async function setupFixture() {
  localStorage.clear();
  const saved = (host, port, lastConnected) => ({ host, port, name: host, lastConnected });
  localStorage.setItem('monky_saved_servers', JSON.stringify([
    saved('a.test', 5101, 3), saved('b.test', 5102, 2), saved('c.test', 5103, 1),
  ]));
  window.fetch = async () => { throw new Error('offline fixture'); };
  const [{ connectionStore }, { sessionManager }, { serverRailView }, { settingsStore }, { t }, { changelogModal }] = await Promise.all([
    import('/stores/connectionStore.ts'), import('/core/SessionManager.ts'), import('/views/ServerRailView.ts'),
    import('/stores/settingsStore.ts'), import('/i18n/index.ts'), import('/views/ChangelogModal.ts'),
  ]);
  window.label = (key) => t(key);
  window.settings = settingsStore;
  connectionStore.loadSavedServers();
  connectionStore.loadRailLayout();
  window.sent = [];
  window.sessions = {};
  const details = (id) => ({ id, name: id, channels: [], categories: [], members: [], knownMembers: [], voiceStates: {}, roles: [], userRoles: [] });
  for (const [name, port] of [['a', 5101], ['b', 5102], ['c', 5103]]) {
    const session = sessionManager.create(`${name}.test`, port, 'Fixture');
    session.serverStore.serverDetails = details(`server-${name}`);
    session.client.getStatus = () => 'CONNECTED';
    session.client.send = (type, payload) => { window.sent.push({ server: name, type, channelId: payload.channelId }); };
    window.sessions[name] = session;
  }
  sessionManager.activate(window.sessions.a.key);
  window.sessions.a.chatStore.markUnread('a-1');
  window.sessions.b.chatStore.markMention('b-1');
  window.sessions.b.chatStore.markUnread('b-2');
  window.sessions.c.chatStore.markUnread('c-1');
  serverRailView.connectToSavedServer = async () => {};
  window.folderize = () => {
    connectionStore.createFolder('Group');
    const folder = connectionStore.railLayout.find(node => node.type === 'folder');
    connectionStore.moveServerToFolder('c.test', 5103, folder.id);
    const moved = connectionStore.railLayout.find(node => node.type === 'folder');
    if (!moved.collapsed) connectionStore.toggleFolderCollapsed(moved.id);
    window.sessions.c.chatStore.markUnread('c-1');
    serverRailView.render();
  };
  window.readState = () => ({
    rail: document.querySelector('#server-rail')?.innerHTML.slice(0, 500),
    menu: [...document.querySelectorAll('.floating-context-menu')].map(menu => menu.textContent),
    sent: window.sent,
    history: document.querySelector('.changelog-body')?.textContent.slice(0, 400),
  });
  const { appEvents } = await import('/core/EventBus.ts');
  appEvents.on('connection.saved_servers_changed', () => serverRailView.render());

  const notes = '<!-- monky-client-notes:v1\n' + JSON.stringify({ schemaVersion: 1, groups: {
    novidades: [{ 'pt-BR': 'Novidade', en: 'New thing' }], correcoes: [], outros: [],
  } }) + '\n-->';
  const entry = (version) => ({ version, body: notes, url: `https://example.test/${version}`, publishedAt: '2026-10-01T12:00:00Z' });
  const pages = [
    [entry('40.2.0'), entry('40.2.0-beta'), entry('40.1.1')],
    [entry('40.1.1-beta'), entry('40.0.0'), entry('39.0.0')],
    [entry('38.0.0'), entry('37.0.0'), entry('36.0.0')],
  ];
  window.historyCalls = [];
  let failedOnce = false;
  window.api = {
    getReleaseNotes: async () => ({ ok: true, version: '40.3.2', body: notes, url: 'https://example.test/40.3.2' }),
    getReleaseHistory: async (page, before) => {
      window.historyCalls.push({ page, before });
      if (page === 2 && !failedOnce) { failedOnce = true; return { ok: false, error: 'HTTP 403' }; }
      return { ok: true, entries: pages[page - 1] ?? [], hasMore: page < pages.length };
    },
    openExternal: async () => ({ success: true }),
  };
  window.openChangelog = () => { void changelogModal.open(); };
  window.closeChangelog = () => changelogModal.close();
  serverRailView.render();
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}
