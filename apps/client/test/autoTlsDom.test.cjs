const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');

// Automatic secure connection of a hosted server (#860): turning it on waits for
// the CA check, asks before lifting the port restriction, explains a failure in
// the app's toast and leaves the switch off, and shows the certificate when on.
if (!process.versions.electron) {
  const { test } = require('node:test');
  const assert = require('node:assert/strict');
  test('automatic TLS of a hosted server is enabled only after the check, with consent for the port', { timeout: 120000 }, async () => {
    const profile = path.join(root, 'dist-test', `auto-tls-profile-${process.pid}`);
    fs.mkdirSync(profile, { recursive: true });
    const env = { ...process.env, MONKY_AUTO_TLS_PROFILE: profile };
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
  app.setPath('userData', process.env.MONKY_AUTO_TLS_PROFILE);
  app.on('window-all-closed', () => {});
  let vite, browser, timeout;
  const finish = async (code) => {
    clearTimeout(timeout);
    if (browser && !browser.isDestroyed()) browser.destroy();
    if (vite) await vite.close();
    app.exit(code);
  };
  app.whenReady().then(async () => {
    timeout = setTimeout(() => { console.error('Automatic TLS DOM timeout'); void finish(1); }, 100000);
    const { createServer } = await import('vite');
    vite = await createServer({
      configFile: path.join(root, 'vite.config.ts'), logLevel: 'error',
      cacheDir: path.join(app.getPath('userData'), 'vite-cache'),
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false, hmr: false, watch: null },
      plugins: [{
        name: 'auto-tls-dom',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__auto_tls__') return next();
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
      await browser.loadURL(`http://127.0.0.1:${vite.httpServer.address().port}/__auto_tls__`);
      browser.webContents.focus();
      const setup = await evaluate(`(${setupFixture.toString()})().then(() => null).catch(error => ({ failure: error.stack || String(error) }))`);
      if (setup?.failure) throw new Error(setup.failure);

      // Off by default, as a switch, with no certificate details.
      await evaluate('window.fixture.open()');
      await check(await waitFor('window.fixture.modal() && document.activeElement === window.fixture.toggle()'),
        'the modal opens with the switch focused');
      await check(await evaluate(`!window.fixture.toggle().checked && window.fixture.details().hidden
        && window.fixture.toggle().getAttribute('role') === 'switch'`), 'it starts off');

      // A closed port: the check fails, the toast explains it and the switch goes back off.
      await evaluate(`window.fixture.results.push({ ok: false, code: 'unreachable' }); null`);
      await press('Space');
      await check(await waitFor(`window.fixture.toast()?.textContent.includes('could not reach port 80')`), 'the failure is explained in a toast');
      await check(await waitFor('!window.fixture.toggle().checked && !window.fixture.toggle().disabled'), 'the switch goes back off');
      await check(await evaluate(`JSON.stringify(window.fixture.calls) === '[[3999,false]]'`), 'one attempt without consent');

      // The port restriction is lifted only after the owner agrees in the dialog.
      await evaluate(`window.fixture.results.push({ ok: false, code: 'port-permission' }, { ok: true, status: window.fixture.active }); null`);
      await evaluate('window.fixture.toggle().click()');
      await check(await waitFor('window.fixture.confirmButton()'), 'consent is asked first');
      await check(await evaluate(`window.fixture.dialog().textContent.includes('ip_unprivileged_port_start=80')`), 'the dialog names the command');
      await evaluate('window.fixture.confirmButton().click()');
      await check(await waitFor(`window.fixture.toggle().checked && !window.fixture.details().hidden
        && window.fixture.field('address') === 'wss://1.1.1.1:3999'`), 'the certificate shows once enabled');
      await check(await evaluate(`JSON.stringify(window.fixture.calls.slice(1)) === '[[3999,false],[3999,true]]'`),
        'the second attempt carries the consent');
      await check(await evaluate(`window.fixture.errorHidden()`), 'no error row without an error');

      // Turning it off goes back to ws:// only.
      await evaluate('window.fixture.toggle().click()');
      await check(await waitFor('!window.fixture.toggle().checked && window.fixture.details().hidden && window.fixture.disables === 1'),
        'turning it off hides the certificate');
      await press('Escape');
      await check(await waitFor('!window.fixture.modal()'), 'Escape closes the modal');
      console.log('Automatic TLS DOM passed');
      await finish(0);
    } catch (error) {
      console.error(error);
      await finish(1);
    }
  });
}

async function setupFixture() {
  localStorage.clear();
  const [language, { autoTlsModal }] = await Promise.all([import('/i18n/index.ts'), import('/views/AutoTlsModal.ts')]);
  language.setLanguage('en');
  const off = { enabled: false, active: false, busy: false, ip: null, validUntil: null, nextRenewalAt: null, lastError: null };
  const now = Date.now();
  const active = { enabled: true, active: true, busy: false, ip: '1.1.1.1', validUntil: now + 6 * 864e5, nextRenewalAt: now + 4 * 864e5, lastError: null };
  const calls = [];
  const results = [];
  window.api = {
    hostServerAutoTlsStatus: async () => off,
    hostServerAutoTlsEnable: async (port, grant) => {
      calls.push([port, grant]);
      return results.shift();
    },
    hostServerAutoTlsDisable: async () => {
      window.fixture.disables++;
      return off;
    },
  };
  const modal = () => document.querySelector('.auto-tls-modal');
  const dialog = () => [...document.querySelectorAll('.modal-card')].find(card => card.querySelector('[data-action="confirm"]'));
  window.fixture = {
    calls,
    results,
    active,
    disables: 0,
    modal,
    dialog,
    confirmButton: () => dialog()?.querySelector('[data-action="confirm"]'),
    toggle: () => modal()?.querySelector('#auto-tls-enabled'),
    details: () => modal()?.querySelector('#auto-tls-details'),
    field: (name) => modal()?.querySelector(`[data-auto-tls="${name}"]`)?.textContent,
    errorHidden: () => modal()?.querySelector('[data-auto-tls="error"]').hidden === true,
    toast: () => document.querySelector('.chat-copy-toast--danger[role="alert"]'),
    open: () => autoTlsModal.open(3999),
    state: () => ({
      modal: !!modal(), checked: window.fixture.toggle()?.checked, disabled: window.fixture.toggle()?.disabled,
      details: window.fixture.details()?.hidden, address: window.fixture.field('address'),
      toast: window.fixture.toast()?.textContent?.trim(), dialog: !!dialog(), calls, active: document.activeElement?.id,
    }),
  };
}
