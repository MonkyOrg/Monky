const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');

// A panel the user opens inside a modal scrolls into view once it has expanded;
// a panel that appears on its own (data arriving) never moves the view.
if (!process.versions.electron) {
  const { test } = require('node:test');
  const assert = require('node:assert/strict');
  test('panels opened inside modals are scrolled into view only when the user opened them', { timeout: 120000 }, async () => {
    const profile = path.join(root, 'dist-test', `modal-reveal-profile-${process.pid}`);
    fs.mkdirSync(profile, { recursive: true });
    const env = { ...process.env, MONKY_MODAL_REVEAL_PROFILE: profile };
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
  app.setPath('userData', process.env.MONKY_MODAL_REVEAL_PROFILE);
  app.on('window-all-closed', () => {});
  let vite, browser, timeout;
  const finish = async (code) => {
    clearTimeout(timeout);
    if (browser && !browser.isDestroyed()) browser.destroy();
    if (vite) await vite.close();
    app.exit(code);
  };
  app.whenReady().then(async () => {
    timeout = setTimeout(() => { console.error('Modal reveal DOM timeout'); void finish(1); }, 100000);
    const { createServer } = await import('vite');
    vite = await createServer({
      configFile: path.join(root, 'vite.config.ts'), logLevel: 'error',
      cacheDir: path.join(app.getPath('userData'), 'vite-cache'),
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false, hmr: false, watch: null },
      plugins: [{
        name: 'modal-reveal-regression',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__modal_reveal__') return next();
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><html><head><link rel="stylesheet" href="/styles/fonts.css"><link rel="stylesheet" href="/styles/theme.css"></head>'
              + '<body><div id="app"></div></body></html>');
          });
        },
      }],
    });
    await new Promise((resolve, reject) => {
      vite.httpServer.once('error', reject);
      vite.httpServer.listen(0, '127.0.0.1', resolve);
    });
    // Short on purpose: the custom status editor opens below the fold.
    browser = new BrowserWindow({ show: false, width: 1000, height: 560, webPreferences: {
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true,
    } });
    // Never a user gesture: activation must come from real input only.
    const evaluate = (code) => browser.webContents.executeJavaScript(code, false);
    const frames = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const waitFor = async (expression, timeoutMs = 4000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await evaluate(expression)) return true;
        await frames();
      }
      return false;
    };
    const check = async (condition, message) => {
      if (!condition) throw new Error(`${message}: ${JSON.stringify(await evaluate('window.revealState()'))}`);
    };
    try {
      await browser.loadURL(`http://127.0.0.1:${vite.httpServer.address().port}/__modal_reveal__`);
      const setup = await evaluate(`(${setupFixture.toString()})().then(() => null).catch(error => ({ failure: error.stack || String(error) }))`);
      if (setup?.failure) throw new Error(setup.failure);
      await check(await evaluate('navigator.userActivation.isActive === false'), 'the page starts without user activation');

      // Opened by code alone (as when data arrives): the view stays put.
      await evaluate('window.fixture.pencil().click()');
      await check(await waitFor('window.fixture.editorOpen() && window.fixture.settled()'), 'the editor opens from code');
      await new Promise(resolve => setTimeout(resolve, 400));
      await check(await evaluate('window.fixture.scroller().scrollTop === 0'), 'an opening without user action does not scroll');
      await check(await evaluate('!window.fixture.editorVisible()'), 'the editor really is below the fold in this window');
      await evaluate('window.fixture.pencil().click()');
      await check(await waitFor('window.fixture.editorClosed()'), 'the editor closes again');

      // Opened with a real click: once expanded, the editor is scrolled into view.
      const point = await evaluate(`(() => {
        const box = window.fixture.pencil().getBoundingClientRect();
        return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
      })()`);
      browser.webContents.sendInputEvent({ type: 'mouseMove', ...point });
      browser.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
      browser.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
      await check(await waitFor('window.fixture.editorOpen()'), 'a real click opens the editor');
      await check(await waitFor('window.fixture.editorVisible() && window.fixture.scroller().scrollTop > 0', 4000),
        'the opened editor is scrolled fully into view');
      console.log('Modal reveal DOM passed');
      await finish(0);
    } catch (error) {
      console.error(error);
      await finish(1);
    }
  });
}

async function setupFixture() {
  localStorage.clear();
  const [{ sessionManager }, { serverStore }, language, { settingsModal }, { settingsStore }] = await Promise.all([
    import('/core/SessionManager.ts'), import('/stores/serverStore.ts'), import('/i18n/index.ts'),
    import('/views/SettingsModal.ts'), import('/stores/settingsStore.ts'),
  ]);
  language.setLanguage('en');
  Object.assign(settingsStore, { customStatus: null, customStatusActive: false });
  sessionManager.install();
  const session = sessionManager.create('reveal.test', 7892, 'Self');
  sessionManager.activate(session.key);
  session.client.getStatus = () => 'CONNECTED';
  session.client.send = () => {};
  const self = { id: 'self', sessionId: 'self-s', clientId: 'self-c', nickname: 'Self', status: 'ONLINE', joinedAt: 1 };
  serverStore.setServerDetails({
    id: 'reveal-server', name: 'Reveal', createdAt: 1, maxUsers: 10, voiceStates: {}, channels: [],
    members: [self], knownMembers: [self], roles: [], userRoles: [], myPermissions: 2147483647, ownerId: self.id,
    protocol: { version: 40, minimumVersion: 35, features: ['custom-status'] },
  }, self);
  await settingsModal.open();
  await new Promise(resolve => setTimeout(resolve, 300));
  const host = () => document.querySelector('[data-presence-custom-editor]');
  const scroller = () => {
    for (let node = host()?.parentElement; node; node = node.parentElement) {
      const overflow = getComputedStyle(node).overflowY;
      if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) return node;
    }
    return null;
  };
  const pencil = () => document.querySelector('[data-presence-custom-edit]');
  // Keep the pencil on screen, near the bottom, so the editor unfolds below the fold.
  const view = scroller() ?? host().closest('.settings-content-body');
  view.scrollTop = 0;
  window.fixture = {
    pencil,
    scroller: () => scroller() ?? view,
    editorOpen: () => !host().hidden && !!host().querySelector('form'),
    editorClosed: () => host().hidden,
    settled: () => host().getAnimations().length === 0,
    editorVisible: () => {
      const container = scroller() ?? view;
      const box = host().getBoundingClientRect();
      const viewBox = container.getBoundingClientRect();
      return box.top >= viewBox.top - 1 && box.bottom <= viewBox.top + container.clientHeight + 1;
    },
  };
  window.revealState = () => {
    const container = scroller() ?? view;
    return {
      scrollTop: container?.scrollTop, clientHeight: container?.clientHeight, scrollHeight: container?.scrollHeight,
      editor: host()?.getBoundingClientRect().toJSON(), pencil: pencil()?.getBoundingClientRect().toJSON(),
      activation: navigator.userActivation.isActive,
    };
  };
}
