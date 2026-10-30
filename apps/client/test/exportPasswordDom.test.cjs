const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const clientRoot = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const { test } = require('node:test');
  const assert = require('node:assert/strict');
  test('export dialogs hold weak passwords back with a marked field and an alert toast', { timeout: 120000 }, async () => {
    const profile = path.join(clientRoot, 'dist-test', `export-password-profile-${process.pid}`);
    fs.mkdirSync(profile, { recursive: true });
    const env = { ...process.env, MONKY_EXPORT_PASSWORD_PROFILE: profile };
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
  app.setPath('userData', process.env.MONKY_EXPORT_PASSWORD_PROFILE);
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
        name: 'export-password-fixture',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__export_password__') return next();
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><html><head><link rel="stylesheet" href="/styles/theme.css"></head><body></body></html>');
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
    timeout = setTimeout(() => { console.error('Export password DOM regression timed out'); void finish(1); }, 90000);
    for (const language of ['pt-BR', 'en']) {
      await browser.loadURL(`${origin}/__export_password__`);
      const checks = await browser.webContents.executeJavaScript(`(${runRegression.toString()})(${JSON.stringify(language)})`, true);
      if (browser.isVisible()) throw new Error('The export password regression must remain offscreen');
      console.log(`Export password dialogs (${language}): ${checks} checks passed`);
    }
    await finish(0);
  }).catch(async (error) => { console.error(error); await finish(1); });
}

async function runRegression(language) {
  const { setLanguage, t } = await import('/i18n/index.ts');
  setLanguage(language);
  const { exportPasswordHint } = await import('/views/exportPassword.ts');
  const { showIdentityExportDialog } = await import('/views/IdentityDialogs.ts');
  const { showBackupExportDialog, showBackupImportDialog } = await import('/views/BackupDialogs.ts');
  // The hint carries the shared policy floor (SECRET_PASSWORD_MIN_LENGTH).
  const minimum = Number(exportPasswordHint().match(/\d+/)?.[0]);
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
  const openDialog = () => document.querySelector('.modal-backdrop:not([data-ui-closing])');
  const toast = () => document.querySelector('.chat-copy-toast--danger:not([data-ui-closing])');
  const dismissToast = async () => {
    toast()?.querySelector('.chat-copy-toast-close')?.click();
    await waitFor(() => !toast(), () => 'The error toast did not close');
  };
  const tooShort = t('backup.passwordTooShort', { min: minimum });
  const tooCommon = t('backup.passwordTooCommon');
  const strong = 'correct horse battery';
  check(minimum >= 8, `The policy asks for at least 8 characters, not ${minimum}`);
  const exported = [];
  const encrypted = [];
  const decrypted = [];
  window.api = {
    exportIdentity: async (password) => { exported.push(password); return 'MONKY-ID:fixture'; },
    encryptBackup: async (_contents, password) => { encrypted.push(password); return { success: true, payload: 'MONKY-BACKUP:fixture' }; },
    saveBackupFile: async () => ({ success: false }),
    openBackupFile: async () => ({ success: true, contents: 'MONKY-BACKUP:fixture' }),
    decryptBackup: async (_payload, password) => { decrypted.push(password); return { success: false, error: 'fixture stop' }; },
  };

  // Identity export: the policy runs before the password reaches the main process.
  void showIdentityExportDialog('fixture-client');
  const password = await waitFor(() => document.querySelector('#identity-export-password'), () => 'Identity export did not open');
  const compatibility = document.querySelector('#identity-export-compatibility');
  check(compatibility?.textContent === t('identity.exportCompatibility') && /monky update/.test(compatibility.textContent),
    'The dialog warns that the code needs an updated Monky and "monky update" before "monky create"');
  const hint = document.getElementById(password.getAttribute('aria-describedby') ?? '');
  check(hint?.textContent === exportPasswordHint(), 'The password is described by the policy hint');
  const exportButton = document.querySelector('#btn-run-export-identity');
  for (const [weak, message] of [['curta', tooShort], ['password123', tooCommon]]) {
    password.value = weak;
    exportButton.click();
    const alert = await waitFor(toast, () => `No error toast for ${weak}`);
    check(alert.getAttribute('role') === 'alert', 'The explanation is announced as an alert');
    check(alert.textContent.includes(message), `Wrong explanation for ${weak}: ${alert.textContent}`);
    check(password.getAttribute('aria-invalid') === 'true', `The field is marked for ${weak}`);
    check(document.activeElement === password, 'Focus returns to the password');
    check(!document.querySelector('#identity-export-error.show'), 'The explanation does not land loose in the layout');
    await dismissToast();
  }
  check(exported.length === 0, 'A weak password never reaches the main process');
  password.value = strong;
  password.dispatchEvent(new Event('input', { bubbles: true }));
  check(!password.hasAttribute('aria-invalid'), 'Typing clears the invalid mark');
  exportButton.click();
  await waitFor(() => document.querySelector('#identity-export-code')?.value === 'MONKY-ID:fixture', () => 'The code was not shown');
  check(exported.length === 1 && exported[0] === strong, 'An accepted password is exported unchanged');
  check(!toast(), 'An accepted password raises no error');
  openDialog()?.querySelector('[data-action="cancel"]')?.click();
  await waitFor(() => !openDialog(), () => 'Identity export did not close');

  // Backup export: Enter in the field goes through the same policy.
  const exporting = showBackupExportDialog();
  const backupPassword = await waitFor(() => document.querySelector('#backup-dialog-password'), () => 'Backup export did not open');
  check(document.getElementById(backupPassword.getAttribute('aria-describedby') ?? '')?.textContent === exportPasswordHint(),
    'The backup password is described by the policy hint');
  backupPassword.value = '1234567';
  backupPassword.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  check((await waitFor(toast, () => 'No toast for a short backup password')).textContent.includes(tooShort), 'Short backup password explained');
  check(backupPassword.getAttribute('aria-invalid') === 'true', 'The backup field is marked');
  check(encrypted.length === 0, 'A weak backup password never reaches the main process');
  await dismissToast();
  backupPassword.value = strong;
  backupPassword.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await exporting;
  check(encrypted.length === 1 && encrypted[0] === strong, 'The accepted backup password is used');

  // Backup import only unlocks an existing file, so no policy applies.
  await waitFor(() => !openDialog(), () => 'Backup export did not close');
  const importing = showBackupImportDialog();
  const unlock = await waitFor(() => document.querySelector('.modal-backdrop:not([data-ui-closing]) #backup-dialog-password'),
    () => 'Backup import did not open');
  check(!unlock.hasAttribute('aria-describedby') && !document.querySelector('#backup-dialog-password-hint'), 'No policy hint to unlock');
  unlock.value = 'old';
  openDialog()?.querySelector('[data-action="confirm"]')?.click();
  await waitFor(() => decrypted.length === 1, () => 'The unlock password was held back');
  check(decrypted[0] === 'old' && !toast(), 'Older, shorter passwords still unlock their files');
  const alertButton = await waitFor(() => openDialog()?.querySelector('[data-action="confirm"]'), () => 'The failure alert did not open');
  alertButton.click();
  check(await importing === null, 'A failed import resolves without applying anything');
  return checks;
}
