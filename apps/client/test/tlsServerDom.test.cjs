const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');

// Servers behind a TLS reverse proxy (#829): a typed wss:// address and a TLS
// invitation open wss:// sockets and https:// resources; no scheme stays ws://.
if (!process.versions.electron) {
  const { test } = require('node:test');
  const assert = require('node:assert/strict');
  test('typed wss:// addresses and TLS invitations connect over TLS, plain ones stay ws://', { timeout: 120000 }, async () => {
    const profile = path.join(root, 'dist-test', `tls-server-profile-${process.pid}`);
    fs.mkdirSync(profile, { recursive: true });
    const env = { ...process.env, MONKY_TLS_SERVER_PROFILE: profile };
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
  app.setPath('userData', process.env.MONKY_TLS_SERVER_PROFILE);
  app.on('window-all-closed', () => {});
  let vite, browser, timeout;
  const finish = async (code) => {
    clearTimeout(timeout);
    if (browser && !browser.isDestroyed()) browser.destroy();
    if (vite) await vite.close();
    app.exit(code);
  };
  app.whenReady().then(async () => {
    timeout = setTimeout(() => { console.error('TLS server DOM timeout'); void finish(1); }, 100000);
    const { createServer } = await import('vite');
    vite = await createServer({
      configFile: path.join(root, 'vite.config.ts'), logLevel: 'error',
      cacheDir: path.join(app.getPath('userData'), 'vite-cache'),
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false, hmr: false, watch: null },
      plugins: [{
        name: 'tls-server-dom',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__tls_server__') return next();
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
    browser = new BrowserWindow({ show: false, width: 1000, height: 760, webPreferences: {
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true,
    } });
    const evaluate = (code) => browser.webContents.executeJavaScript(code, false);
    const frames = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const waitFor = async (expression, timeoutMs = 6000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await evaluate(expression)) return true;
        await frames();
      }
      return false;
    };
    const check = async (condition, message) => {
      if (!condition) throw new Error(`${message}: ${JSON.stringify(await evaluate('window.fixture.state()'))}`);
    };
    try {
      await browser.loadURL(`http://127.0.0.1:${vite.httpServer.address().port}/__tls_server__`);
      const setup = await evaluate(`(${setupFixture.toString()})().then(() => null).catch(error => ({ failure: error.stack || String(error) }))`);
      if (setup?.failure) throw new Error(setup.failure);

      // A TLS invitation: reviewed with its scheme, joined over wss.
      await evaluate('window.fixture.openInvite(true)');
      await check(await waitFor(`document.querySelector('[data-invite-host]')?.textContent === 'wss://proxy.example'`),
        'the review shows the TLS address');
      await evaluate(`document.querySelector('[data-invite-join]').click()`);
      await check(await waitFor(`window.fixture.sockets.includes('wss://proxy.example:443')`), 'the TLS invitation opens wss');
      await check(await evaluate(`window.fixture.httpBase('proxy.example', 443) === 'https://proxy.example:443'`),
        'its avatars and previews come over https');

      // The same invitation without the flag stays plain.
      await evaluate('window.fixture.closeAll()');
      await check(await waitFor('window.fixture.closed()'), 'the dialog closes');
      await evaluate('window.fixture.openInvite(false, 3001)');
      await check(await waitFor(`document.querySelector('[data-invite-host]')?.textContent === 'proxy.example'`), 'plain review');
      await evaluate(`document.querySelector('[data-invite-join]').click()`);
      await check(await waitFor(`window.fixture.sockets.includes('ws://proxy.example:3001')`), 'a plain invitation opens ws');

      // Typed in the join form: wss:// asks for TLS on port 443; no scheme stays ws.
      for (const [typed, port, expected] of [
        ['wss://typed.example', '443', 'wss://typed.example:443'],
        ['typed-plain.example', '3002', 'ws://typed-plain.example:3002'],
      ]) {
        await evaluate('window.fixture.closeAll()');
        await check(await waitFor('window.fixture.closed()'), 'the dialog closes');
        await evaluate('window.fixture.openJoinForm()');
        await check(await waitFor(`!!document.querySelector('#add-server-host')`), 'the join form opens');
        await evaluate(`window.fixture.fillJoin(${JSON.stringify(typed)}, ${JSON.stringify(port)})`);
        await check(await waitFor(`window.fixture.sockets.includes(${JSON.stringify(expected)})`), `${typed} opens ${expected}`);
      }
      console.log('TLS server DOM passed');
      await finish(0);
    } catch (error) {
      console.error(error);
      await finish(1);
    }
  });
}

async function setupFixture() {
  localStorage.clear();
  const sockets = [];
  // Records the address and fails like an unreachable server: no network is touched.
  class RecordingWebSocket extends EventTarget {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 0;
      sockets.push(url);
      setTimeout(() => {
        this.readyState = 3;
        this.onerror?.(new Event('error'));
        this.dispatchEvent(new Event('error'));
        const close = new CloseEvent('close', { code: 1006 });
        this.onclose?.(close);
        this.dispatchEvent(close);
      }, 0);
    }
    send() {}
    close() { this.readyState = 3; }
  }
  window.WebSocket = RecordingWebSocket;
  const identity = { clientId: 'c'.repeat(32), publicKey: 'p'.repeat(88) };
  window.api = {
    getIdentity: async () => identity,
    stopLanDiscovery: async () => {},
    maximize: async () => {},
  };
  const [language, { connectionStore }, { joinInviteModal }, { addServerModal }, address, { sessionManager }] = await Promise.all([
    import('/i18n/index.ts'), import('/stores/connectionStore.ts'), import('/views/JoinInviteModal.ts'),
    import('/views/addServer/AddServerModal.ts'), import('/utils/serverAddress.ts'), import('/core/SessionManager.ts'),
  ]);
  language.setLanguage('en');
  sessionManager.install();
  connectionStore.setIdentity(identity);
  connectionStore.saveUserProfile('Tester');
  window.fixture = {
    sockets,
    openInvite: (tls, port = 443) => {
      void joinInviteModal.open({ v: 1, host: 'proxy.example', port, name: 'Proxy', ...(tls ? { tls: true } : {}) });
    },
    openJoinForm: () => addServerModal.open('join'),
    fillJoin: (host, port) => {
      document.querySelector('#add-server-host').value = host;
      document.querySelector('#add-server-port').value = port;
      document.querySelector('#add-server-join-form').requestSubmit();
    },
    closeAll: () => {
      for (const button of document.querySelectorAll('.modal-backdrop:not([data-ui-closing]) [data-modal-close]')) button.click();
    },
    closed: () => !document.querySelector('.modal-backdrop'),
    httpBase: (host, port) => address.toHttpBase({ host, port }),
    state: () => ({ sockets, modals: [...document.querySelectorAll('.modal-backdrop')].length,
      host: document.querySelector('[data-invite-host]')?.textContent }),
  };
}
