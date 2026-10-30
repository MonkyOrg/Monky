const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const clientRoot = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const { test } = require('node:test');
  const assert = require('node:assert/strict');
  test('an unreadable identity offers recovery, and creating or importing another identity always asks first', { timeout: 120000 }, async () => {
    const profile = path.join(clientRoot, 'dist-test', `identity-onboarding-profile-${process.pid}`);
    fs.mkdirSync(profile, { recursive: true });
    const env = { ...process.env, MONKY_IDENTITY_ONBOARDING_PROFILE: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    try {
      const code = await new Promise((resolve, reject) => {
        const child = spawn(require('electron'), [__filename], { cwd: clientRoot, env, stdio: 'inherit' });
        child.once('error', reject);
        child.once('exit', resolve);
      });
      assert.equal(code, 0);
    } finally {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
} else {
  const { app, BrowserWindow } = require('electron');
  app.on('window-all-closed', () => {});
  app.setPath('userData', process.env.MONKY_IDENTITY_ONBOARDING_PROFILE);
  let vite;
  let browser;
  let timeout;
  const finish = async (code) => {
    clearTimeout(timeout);
    if (browser && !browser.isDestroyed()) browser.destroy();
    if (vite) await vite.close();
    app.exit(code);
  };
  app.whenReady().then(async () => {
    const { createServer } = await import('vite');
    vite = await createServer({
      configFile: path.join(clientRoot, 'vite.config.ts'), logLevel: 'error',
      cacheDir: path.join(app.getPath('userData'), 'vite-cache'),
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false, hmr: false, watch: null },
      plugins: [{
        name: 'identity-onboarding-fixture',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__identity_onboarding__') return next();
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><html><head><link rel="stylesheet" href="/styles/theme.css"></head><body><div id="app"></div></body></html>');
          });
        },
      }],
    });
    const http = vite.httpServer;
    if (!http) throw new Error('Missing Vite HTTP server');
    await new Promise((resolve, reject) => {
      http.once('error', reject);
      http.listen(0, '127.0.0.1', () => { http.removeListener('error', reject); resolve(); });
    });
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Missing Vite address');
    const origin = `http://127.0.0.1:${address.port}`;
    browser = new BrowserWindow({
      show: false, width: 1000, height: 900,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true },
    });
    browser.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    browser.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: new URL(details.url).origin !== origin });
    });
    timeout = setTimeout(() => { console.error('Identity onboarding DOM regression timed out'); void finish(1); }, 90000);
    for (const language of ['pt-BR', 'en']) {
      await browser.loadURL(`${origin}/__identity_onboarding__`);
      const checks = await browser.webContents.executeJavaScript(`(${runRegression.toString()})(${JSON.stringify(language)})`, true);
      if (browser.isVisible()) throw new Error('The identity onboarding regression must remain offscreen');
      console.log(`Identity onboarding (${language}): ${checks} checks passed`);
    }
    await finish(0);
  }).catch(async (error) => { console.error(error); await finish(1); });
}

async function runRegression(language) {
  const { setLanguage, t } = await import('/i18n/index.ts');
  setLanguage(language);
  const { showIdentityOnboarding } = await import('/views/IdentityOnboarding.ts');
  let checks = 0;
  const check = (value, message) => { if (!value) throw new Error(message); checks++; };
  const waitFor = (predicate, describeFailure) => new Promise((resolve, reject) => {
    let frame;
    const timer = setTimeout(() => {
      cancelAnimationFrame(frame);
      reject(new Error(describeFailure()));
    }, 5000);
    const poll = () => {
      const value = predicate();
      if (value) {
        clearTimeout(timer);
        resolve(value);
      } else {
        frame = requestAnimationFrame(poll);
      }
    };
    poll();
  });
  const container = document.getElementById('app');
  const dialog = () => document.querySelector('.modal-backdrop:not([data-ui-closing])');
  const toast = () => document.querySelector('.chat-copy-toast--danger:not([data-ui-closing])');
  const dismissToast = async () => {
    toast()?.querySelector('.chat-copy-toast-close')?.click();
    await waitFor(() => !toast(), () => 'The error toast did not close');
  };
  const button = (id) => container.querySelector(`#${id}`);
  const fixture = { publicKey: 'fixture-public-key', clientId: 'fixture-client' };
  const calls = { status: 0, create: 0, get: 0 };
  let nextStatus = { state: 'unreadable', reason: 'locked' };
  window.api = {
    getIdentityStatus: async () => { calls.status++; return nextStatus; },
    createIdentity: async () => { calls.create++; return fixture; },
    getIdentity: async () => { calls.get++; return fixture; },
  };

  // Unreadable: the reason, a promise that nothing was deleted, and "try again" ready for Enter.
  let painted = 0;
  let settled = null;
  void showIdentityOnboarding(container, { state: 'unreadable', reason: 'locked' }, () => { painted++; })
    .then((identity) => { settled = identity; });
  check(painted === 1, 'The first paint is reported once');
  check(container.querySelector('h1')?.textContent === t('identity.unreadableTitle'), 'The screen says the identity could not be opened');
  check(container.querySelector('#identity-unreadable-reason')?.textContent === t('identity.unreadableLocked'), 'The reason is explained');
  check(container.textContent.includes(t('identity.unreadableKept')), 'The user learns that nothing was deleted');
  check(document.activeElement === button('btn-onboard-retry'), 'Try again has the focus');
  check(button('btn-onboard-import') && button('btn-onboard-create'), 'Import and create stay available');

  // Trying again while it is still locked keeps the screen and explains it in an alert toast.
  button('btn-onboard-retry').click();
  const still = await waitFor(toast, () => 'No toast after a failed retry');
  check(still.getAttribute('role') === 'alert' && still.textContent.includes(t('identity.unreadableStill')), 'The failed retry is announced');
  check(settled === null && calls.create === 0, 'A failed retry never creates an identity');
  await dismissToast();

  // A different reason updates the explanation.
  nextStatus = { state: 'unreadable', reason: 'io' };
  button('btn-onboard-retry').click();
  await waitFor(() => container.querySelector('#identity-unreadable-reason')?.textContent === t('identity.unreadableIo'),
    () => 'The new reason was not shown');
  await waitFor(toast, () => 'No toast after the second failed retry');
  await dismissToast();

  // Creating another identity asks first, and cancelling keeps everything as it is.
  button('btn-onboard-create').click();
  const confirm = await waitFor(dialog, () => 'Creating did not ask for confirmation');
  check(confirm.textContent.includes(t('identity.replaceMessage')), 'The confirmation explains what is lost');
  check(confirm.querySelector('[data-action="confirm"]')?.classList.contains('btn-danger'), 'Confirming is marked as dangerous');
  check(document.activeElement === confirm.querySelector('[data-action="cancel"]'), 'Cancel has the focus');
  confirm.querySelector('[data-action="cancel"]').click();
  await waitFor(() => !dialog(), () => 'The confirmation did not close');
  await new Promise((resolve) => setTimeout(resolve, 50));
  check(calls.create === 0 && settled === null, 'Cancelling creates nothing');

  button('btn-onboard-create').click();
  (await waitFor(dialog, () => 'The confirmation did not open again')).querySelector('[data-action="confirm"]').click();
  await waitFor(() => settled, () => 'Confirming did not finish the onboarding');
  check(calls.create === 1 && settled.publicKey === fixture.publicKey, 'The explicit choice creates the identity once');

  // Trying again once the keychain opens hands over the stored identity.
  settled = null;
  nextStatus = { state: 'ready' };
  void showIdentityOnboarding(container, { state: 'unreadable', reason: 'locked' }, () => {}).then((identity) => { settled = identity; });
  button('btn-onboard-retry').click();
  await waitFor(() => settled, () => 'A successful retry did not finish the onboarding');
  check(calls.get === 1 && calls.create === 1, 'A successful retry reads the identity and creates nothing');

  // No identity yet: creating needs no confirmation.
  settled = null;
  void showIdentityOnboarding(container, { state: 'missing' }, () => {}).then((identity) => { settled = identity; });
  check(!button('btn-onboard-retry'), 'Without an identity there is nothing to try again');
  button('btn-onboard-create').click();
  await waitFor(() => settled, () => 'Creating the first identity did not finish the onboarding');
  check(!dialog() && calls.create === 2, 'The first identity is created without a warning');

  // Importing a code of another identity (Settings) asks first; nothing is replaced until the user confirms.
  const { showIdentityImportDialog } = await import('/views/IdentityDialogs.ts');
  const other = { publicKey: 'other-public-key', clientId: 'other-client' };
  const imports = [];
  window.api.importIdentity = async (code, password, replace) => {
    imports.push({ code, password, replace });
    return replace === other.publicKey ? { status: 'imported', ...other } : { status: 'confirm-replace', ...other };
  };
  const backdrops = () => [...document.querySelectorAll('.modal-backdrop:not([data-ui-closing])')];
  const replaceConfirm = () => backdrops().find((backdrop) => backdrop.querySelector('.dialog-message'));
  let imported;
  void showIdentityImportDialog().then((identity) => { imported = identity; });
  const code = await waitFor(() => document.querySelector('#identity-import-code'), () => 'The import dialog did not open');
  code.value = 'MONKY-ID2:fixture';
  document.querySelector('#identity-import-password').value = 'correct horse battery';
  const importButton = document.querySelector('#btn-import-identity-run');
  importButton.click();
  const asked = await waitFor(replaceConfirm, () => 'Importing another identity did not ask first');
  check(asked.querySelector('.dialog-message')?.textContent === t('identity.importReplaceMessage'), 'The confirmation explains what is lost');
  check(asked.querySelector('[data-action="confirm"]')?.classList.contains('btn-danger'), 'Switching is marked as dangerous');
  check(document.activeElement === asked.querySelector('[data-action="cancel"]'), 'Cancel has the focus');
  check(imports.length === 1 && imports[0].replace === undefined, 'The first try only asks');
  asked.querySelector('[data-action="cancel"]').click();
  await waitFor(() => !replaceConfirm() && !importButton.disabled, () => 'Cancelling did not return to the import dialog');
  check(imported === undefined && document.querySelector('#identity-import-code') === code, 'Cancelling keeps the dialog and imports nothing');
  check(importButton.textContent === t('identity.importAction'), 'The import button is ready again');

  importButton.click();
  (await waitFor(replaceConfirm, () => 'The confirmation did not open again')).querySelector('[data-action="confirm"]').click();
  await waitFor(() => imported, () => 'Confirming did not import the identity');
  check(imports.length === 3 && imports[2].replace === other.publicKey, 'The confirmed import names the key it replaces with');
  check(imports[2].code === 'MONKY-ID2:fixture' && imports[2].password === 'correct horse battery', 'The same code is imported');
  check(imported.publicKey === other.publicKey && imported.clientId === other.clientId, 'The dialog hands over the new identity');
  await waitFor(() => backdrops().length === 0, () => 'The dialogs did not close');
  return checks;
}
