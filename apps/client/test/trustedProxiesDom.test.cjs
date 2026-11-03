const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');

// Trusted reverse proxies of a server hosted by the app (#829): off by default,
// checked by the shared rule, reported through the app's toast and handed to
// the hosted server on start.
if (!process.versions.electron) {
  const { test } = require('node:test');
  const assert = require('node:assert/strict');
  test('trusted proxies of a hosted server are off by default, validated and sent on start', { timeout: 120000 }, async () => {
    const profile = path.join(root, 'dist-test', `trusted-proxies-profile-${process.pid}`);
    fs.mkdirSync(profile, { recursive: true });
    const env = { ...process.env, MONKY_TRUSTED_PROXIES_PROFILE: profile };
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
  app.setPath('userData', process.env.MONKY_TRUSTED_PROXIES_PROFILE);
  app.on('window-all-closed', () => {});
  let vite, browser, timeout;
  const finish = async (code) => {
    clearTimeout(timeout);
    if (browser && !browser.isDestroyed()) browser.destroy();
    if (vite) await vite.close();
    app.exit(code);
  };
  app.whenReady().then(async () => {
    timeout = setTimeout(() => { console.error('Trusted proxies DOM timeout'); void finish(1); }, 100000);
    const { createServer } = await import('vite');
    vite = await createServer({
      configFile: path.join(root, 'vite.config.ts'), logLevel: 'error',
      cacheDir: path.join(app.getPath('userData'), 'vite-cache'),
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false, hmr: false, watch: null },
      plugins: [{
        name: 'trusted-proxies-dom',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__trusted_proxies__') return next();
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
    browser = new BrowserWindow({ show: false, width: 1000, height: 700, webPreferences: {
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true,
    } });
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
      if (!condition) throw new Error(`${message}: ${JSON.stringify(await evaluate('window.fixture.state()'))}`);
    };
    const press = async (keyCode) => {
      browser.webContents.sendInputEvent({ type: 'keyDown', keyCode });
      if (keyCode === 'Space') browser.webContents.sendInputEvent({ type: 'char', keyCode: ' ' });
      browser.webContents.sendInputEvent({ type: 'keyUp', keyCode });
      await frames();
    };
    try {
      await browser.loadURL(`http://127.0.0.1:${vite.httpServer.address().port}/__trusted_proxies__`);
      browser.webContents.focus();
      const setup = await evaluate(`(${setupFixture.toString()})().then(() => null).catch(error => ({ failure: error.stack || String(error) }))`);
      if (setup?.failure) throw new Error(setup.failure);

      // Off by default: the switch is off, the list hidden, and nothing reaches the server.
      await evaluate('window.fixture.open()');
      await check(await waitFor('window.fixture.modal() && document.activeElement === window.fixture.toggle()'),
        'the modal opens with the switch focused');
      await check(await evaluate(`!window.fixture.toggle().checked && window.fixture.group().hidden
        && window.fixture.toggle().getAttribute('role') === 'switch'`), 'the option starts off');
      await evaluate('window.fixture.start()');
      await check(await evaluate('window.fixture.starts.at(-1).trustedProxies === undefined'), 'off sends no proxy to the server');

      // The keyboard turns it on and the list unfolds.
      await evaluate('window.fixture.toggle().focus()');
      await press('Space');
      await check(await waitFor('window.fixture.toggle().checked && !window.fixture.group().hidden && window.fixture.settled()'),
        'Space turns the switch on and reveals the list');

      // An empty list and an entry trusting everyone are refused in the app's toast, the modal stays.
      await evaluate('window.fixture.submit()');
      await check(await waitFor(`window.fixture.toast()?.textContent.includes(${JSON.stringify('at least one proxy')})`),
        'an empty list is refused in a toast');
      await check(await evaluate(`window.fixture.list().getAttribute('aria-invalid') === 'true'
        && document.activeElement === window.fixture.list() && window.fixture.modal()`), 'the list is marked and focused');
      await evaluate(`window.fixture.type('127.0.0.1\\n0.0.0.0/0')`);
      await check(await evaluate(`window.fixture.list().getAttribute('aria-invalid') === null`), 'editing clears the mark');
      await evaluate('window.fixture.submit()');
      await check(await waitFor(`window.fixture.toast()?.textContent.includes('"0.0.0.0/0" would trust every address')`),
        'a list trusting everyone is refused');
      await check(await evaluate('window.fixture.saved().trustedProxies === undefined'), 'nothing was saved');

      // A valid list is saved in one spelling each and reaches the server on start.
      await evaluate(`window.fixture.type('127.0.0.1, ::ffff:10.0.0.1\\n172.16.0.0/12 127.0.0.1')`);
      await evaluate('window.fixture.submit()');
      await check(await waitFor('!window.fixture.modal()'), 'saving closes the modal');
      await check(await evaluate(`JSON.stringify(window.fixture.saved().trustedProxies) === '["127.0.0.1","10.0.0.1","172.16.0.0/12"]'`),
        'the list is stored canonically');
      await evaluate('window.fixture.start()');
      await check(await evaluate(`JSON.stringify(window.fixture.starts.at(-1).trustedProxies) === '["127.0.0.1","10.0.0.1","172.16.0.0/12"]'`),
        'the list is sent with the start');

      // Reopened, it shows what was saved; Escape discards edits.
      await evaluate('window.fixture.open()');
      await check(await waitFor(`window.fixture.modal() && window.fixture.toggle().checked && !window.fixture.group().hidden
        && window.fixture.list().value === '127.0.0.1\\n10.0.0.1\\n172.16.0.0/12'`), 'reopening shows the saved list');
      await evaluate(`window.fixture.type('203.0.113.1')`);
      await evaluate('window.fixture.toggle().focus()');
      await press('Escape');
      await check(await waitFor('!window.fixture.modal()'), 'Escape closes the modal');
      await check(await evaluate('window.fixture.saved().trustedProxies.length === 3'), 'Escape keeps the saved list');

      // Turning it off removes the list.
      await evaluate('window.fixture.open()');
      await check(await waitFor('window.fixture.modal()'), 'reopens');
      await evaluate('window.fixture.toggle().click()');
      await check(await waitFor('window.fixture.group().hidden'), 'the list folds away when off');
      await evaluate('window.fixture.submit()');
      await check(await waitFor('!window.fixture.modal()'), 'saving off closes the modal');
      await check(await evaluate('window.fixture.saved().trustedProxies === undefined'), 'off removes the list');

      // Saved while a start is still pending: finishing the start must not bring the old list back.
      await evaluate(`window.fixture.gate = new Promise(resolve => { window.fixture.release = resolve; });
        window.fixture.pending = window.fixture.start(); null`);
      await evaluate('window.fixture.open()');
      await check(await waitFor('window.fixture.modal()'), 'opens during a pending start');
      await evaluate('window.fixture.toggle().click()');
      await evaluate(`window.fixture.type('127.0.0.1')`);
      await evaluate('window.fixture.submit()');
      await check(await waitFor('!window.fixture.modal()'), 'saves during a pending start');
      await evaluate('window.fixture.release(); window.fixture.gate = null; window.fixture.pending');
      await check(await evaluate(`JSON.stringify(window.fixture.saved().trustedProxies) === '["127.0.0.1"]'`),
        'the edit made during the start survives it');
      await evaluate('window.fixture.open()');
      await check(await waitFor('window.fixture.modal()'), 'reopens to turn it off');
      await evaluate('window.fixture.toggle().click()');
      await evaluate('window.fixture.submit()');
      await check(await waitFor('!window.fixture.modal() && window.fixture.saved().trustedProxies === undefined'), 'off again');

      // A stored list the server would refuse is dropped on load rather than blocking every start.
      await check(await evaluate('window.fixture.reloadWith(["0.0.0.0/0"]) === undefined'), 'an unreadable stored list is dropped');
      await check(await evaluate(`JSON.stringify(window.fixture.reloadWith(["127.0.0.1"])) === '["127.0.0.1"]'`), 'a valid one is kept');
      console.log('Trusted proxies DOM passed');
      await finish(0);
    } catch (error) {
      console.error(error);
      await finish(1);
    }
  });
}

async function setupFixture() {
  localStorage.clear();
  const [language, { connectionStore }, { trustedProxiesModal }, { ensureHostedServerStarted }] = await Promise.all([
    import('/i18n/index.ts'), import('/stores/connectionStore.ts'), import('/views/TrustedProxiesModal.ts'),
    import('/core/hostedServerStart.ts'),
  ]);
  language.setLanguage('en');
  const id = 'hosted-proxy-fixture';
  connectionStore.saveCreatedServer({
    id, name: 'Proxy fixture', port: 3999, voiceChannel: 'Geral', textChannel: 'geral', createdAt: 1, lastStarted: 1,
  });
  const starts = [];
  window.api = {
    hostServerStatus: async () => ({ servers: [] }),
    hostServerStart: async (options) => {
      starts.push(structuredClone(options));
      if (window.fixture.gate) await window.fixture.gate;
      return { success: true };
    },
  };
  const modal = () => document.querySelector('.trusted-proxies-modal');
  const list = () => modal()?.querySelector('#trusted-proxies-list');
  const group = () => modal()?.querySelector('#trusted-proxies-list-group');
  const saved = () => connectionStore.createdServers.find(server => server.id === id);
  window.fixture = {
    starts,
    modal,
    list,
    group,
    saved,
    toggle: () => modal()?.querySelector('#trusted-proxies-enabled'),
    toast: () => document.querySelector('.chat-copy-toast--danger[role="alert"]'),
    settled: () => !group() || group().getAnimations().length === 0,
    open: () => trustedProxiesModal.open(id),
    start: () => ensureHostedServerStarted(saved()),
    submit: () => modal().querySelector('[data-trusted-proxies-save]').click(),
    type: (value) => {
      list().value = value;
      list().dispatchEvent(new Event('input', { bubbles: true }));
    },
    reloadWith: (trustedProxies) => {
      localStorage.setItem('monky_created_servers', JSON.stringify([{ ...saved(), trustedProxies }]));
      connectionStore.loadCreatedServers();
      return saved().trustedProxies;
    },
    state: () => ({
      modal: !!modal(), checked: window.fixture.toggle()?.checked, hidden: group()?.hidden, list: list()?.value,
      invalid: list()?.getAttribute('aria-invalid'), toast: window.fixture.toast()?.textContent?.trim(),
      active: document.activeElement?.id, saved: saved(), starts,
    }),
  };
}
