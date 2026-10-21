const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const clientRoot = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const test = require('node:test');
  test('desktop compatibility warnings precede download and honor cancellation and locale', {
    timeout: 120_000,
  }, async () => {
    const profile = path.join(clientRoot, 'dist-test', `update-compatibility-profile-${process.pid}`);
    fs.mkdirSync(profile, { recursive: true });
    const env = { ...process.env, MONKY_UPDATE_COMPAT_PROFILE: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    try {
      const code = await new Promise((resolve, reject) => {
        const child = spawn(require('electron'), [__filename], { env, cwd: clientRoot, stdio: 'inherit' });
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
  app.setPath('userData', process.env.MONKY_UPDATE_COMPAT_PROFILE);
  app.on('window-all-closed', () => {});
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
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false },
      plugins: [{
        name: 'update-compatibility-fixture',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url?.startsWith('/__update_metadata__/')) {
              if (request.url.endsWith('/redirect')) {
                response.writeHead(302, { Location: '/__update_metadata__/payload' });
                response.end();
              } else if (request.url.endsWith('/large')) {
                response.end('x'.repeat(16 * 1024 + 1));
              } else if (!request.url.endsWith('/wait')) {
                response.setHeader('Content-Type', 'application/json');
                response.end(JSON.stringify({ version: '99.0.0-beta' }));
              }
              return;
            }
            if (request.url !== '/__update_compatibility__') return next();
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/styles/theme.css"></head><body></body></html>');
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
    const { requestUpdateMetadata } = require('../dist-electron/main/updateMetadataRequest');
    const metadataUrl = `http://127.0.0.1:${address.port}/__update_metadata__`;
    const redirect = await requestUpdateMetadata(`${metadataUrl}/redirect`, { signal: AbortSignal.timeout(5000) });
    assert.equal(redirect.status, 302, 'Chromium metadata transport must expose manual redirects rather than reject them');
    assert.ok(redirect.headers.get('location')?.endsWith('/__update_metadata__/payload'));
    const metadata = await requestUpdateMetadata(`${metadataUrl}/payload`, { signal: AbortSignal.timeout(5000) });
    assert.deepEqual(await metadata.json(), { version: '99.0.0-beta' });
    await assert.rejects(requestUpdateMetadata(`${metadataUrl}/large`, { signal: AbortSignal.timeout(5000) }), /size limit/);
    const controller = new AbortController();
    const stalled = requestUpdateMetadata(`${metadataUrl}/wait`, { signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(stalled, /abort/i);
    console.log('Chromium metadata: manual redirect, bounded body and network cancellation passed');
    browser = new BrowserWindow({
      show: false, width: 700, height: 650, useContentSize: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true },
    });
    browser.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    timeout = setTimeout(() => { console.error('Update compatibility smoke timed out'); void finish(1); }, 90_000);
    for (const language of ['pt-BR', 'en']) {
      await browser.loadURL(`http://127.0.0.1:${address.port}/__update_compatibility__`);
      await browser.webContents.executeJavaScript('localStorage.clear(); sessionStorage.clear();', true);
      const checks = await browser.webContents.executeJavaScript(
        `(${runRegression.toString()})(${JSON.stringify(language)})`, true);
      console.log(`Update compatibility (${language}): ${checks} checks passed`);
    }
    await finish(0);
  }).catch(async (error) => { console.error(error); await finish(1); });
}

async function runRegression(language) {
  const downloads = [];
  const version = '99.0.0-beta';
  let result = { ok: true, available: true, version };
  let assessment = { ok: true, warnings: [] };
  let checkGate = null;
  let downloadGate = null;
  let preflightGate = null;
  let boundary = false;
  const callbacks = {};
  const cancelled = [];
  const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
  };
  window.api = {
    setLanguage: async () => {},
    setUpdateChannel: async () => ({ ok: true }),
    getUpdateOutcome: async () => null,
    getAutoStart: async () => false,
    getAppVersion: async () => '40.0.0',
    checkForUpdates: async id => {
      if (checkGate) { checkGate.id = id; return checkGate.promise; }
      return result;
    },
    checkUpdateCompatibility: async (_version, id) => {
      if (preflightGate) { preflightGate.id = id; return preflightGate.promise; }
      return assessment;
    },
    downloadUpdate: async (target, id) => {
      downloads.push(target);
      downloadGate = { ...deferred(), id };
      return downloadGate.promise;
    },
    cancelUpdate: async id => {
      if (boundary) return { ok: true, cancelled: false };
      cancelled.push(id);
      for (const gate of [checkGate, downloadGate, preflightGate]) {
        if (gate?.id === id && !gate.ignoreCancel) gate.resolve({ ok: false, cancelled: true });
      }
      return { ok: true, cancelled: true };
    },
    onUpdateProgress: callback => { callbacks.progress = callback; return () => {}; },
    onUpdateDownloaded: callback => { callbacks.downloaded = callback; return () => {}; },
    onUpdateError: callback => { callbacks.error = callback; return () => {}; },
  };
  const { setLanguage, t } = await import('/i18n/index.ts');
  setLanguage(language);
  const { updateService } = await import('/core/UpdateService.ts');
  await updateService.init();
  let checks = 0;
  const check = (value, message) => { if (!value) throw new Error(message); checks++; };
  const settle = async (predicate, message) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(message);
  };
  const banner = () => document.querySelector('.update-banner:not([data-ui-closing])');
  const updateButton = () => banner()?.querySelector('.update-banner__download');
  const openDialog = () => document.querySelector('.modal-backdrop:not([data-ui-closing]) .update-compatibility-card');
  await updateService.checkManually();
  check(!document.querySelector('.update-bot-compatibility'), 'General banner must never mention bots');
  updateButton().click();
  await settle(() => downloads.length === 1, 'Same-protocol update did not begin');
  check(!document.querySelector('[role="dialog"]'), 'Compatible update must not add a compatibility confirmation');
  callbacks.progress(35);
  check(banner().querySelector('.update-banner__text').textContent.includes('35'), 'Progress was not displayed');
  check(updateButton().textContent === t('common.cancel'), 'Download needs a cancel button');
  banner().querySelector('.update-banner__dismiss').click();
  await settle(() => !document.querySelector('.update-banner:not([data-ui-closing])'), 'Download X did not cancel and close');
  check(cancelled.length === 1, 'Download close must cancel the real operation, not just hide it');
  check(!localStorage.getItem('monky_dismissed_update'), 'Cancelling must allow a later retry of the same release');
  downloadGate = null;
  await settle(() => !updateService.startingDownload, 'Cancelled download did not settle');
  callbacks.error(new Error('Late cancelled download error'));
  check(!banner(), 'A late download error must not recreate the cancelled banner');

  checkGate = { ...deferred(), ignoreCancel: true };
  const pendingCheck = updateService.checkManually();
  banner().querySelector('.update-banner__dismiss').click();
  checkGate.resolve(result);
  check((await pendingCheck).status === 'cancelled', 'A late successful check must still report cancellation');
  checkGate = null;
  await new Promise(resolve => setTimeout(resolve, 20));
  check(!document.querySelector('.update-banner:not([data-ui-closing])'), 'A late check result must not recreate a cancelled banner');

  const { AboutTab } = await import('/views/settings/tabs/AboutTab.ts');
  const about = new AboutTab();
  const root = document.createElement('main');
  root.innerHTML = about.renderHtml();
  document.body.appendChild(root);
  about.attachEvents(root);
  checkGate = deferred();
  const settingsCheck = root.querySelector('#btn-check-updates');
  settingsCheck.click();
  check(settingsCheck.textContent === t('common.cancel'), 'Settings check must turn into Cancel');
  settingsCheck.click();
  await settle(() => settingsCheck.textContent === t('settings.checkUpdates'), 'Settings cancellation did not restore the action');
  check(root.querySelector('#settings-update-status').textContent === '', 'Cancellation must not claim everything is up to date');
  checkGate = null;
  about.cleanup();
  root.remove();

  assessment = { ok: true, warnings: [{ serverName: '<Local server>', bots: [{ name: '<Music bot>', status: 'incompatible' }] }] };
  await updateService.checkManually();
  check(!document.querySelector('.update-bot-compatibility'), 'Local incompatibility must not leak into the general banner');
  setLanguage(language === 'pt-BR' ? 'en' : 'pt-BR');
  check(banner().querySelector('.update-banner__text').innerHTML === t('update.available', { version }),
    'The general banner must follow the selected app language');
  setLanguage(language);
  updateButton().click();
  await settle(openDialog, 'Compatibility confirmation did not open');
  check(downloads.length === 1, 'No package may download before confirmation');
  check(openDialog().textContent.includes('<Music bot>'), 'Warning must name the actual bot as escaped text');
  check(openDialog().textContent.includes('<Local server>'), 'Warning must name the actual local server');
  check(!openDialog().querySelector('music'), 'Bot names must never be interpreted as HTML');
  check(document.activeElement.dataset.action === 'cancel', 'The safe action must receive initial focus');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  check(document.activeElement === openDialog().querySelector('.modal-close-btn'), 'Tab must wrap within the warning');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
  check(document.activeElement === openDialog().querySelector('.modal-footer [data-action="cancel"]'), 'Shift+Tab must wrap back to the safe action');
  check(banner()?.hidden ||
    !banner(),
  'The high-z-index update banner must not cover its confirmation');
  openDialog().querySelector('.modal-close-btn').click();
  await settle(() => !document.querySelector('[role="dialog"]') && !banner().hidden,
    'Cancelled update did not restore its banner');
  check(document.activeElement === updateButton(), 'Closing the warning must restore keyboard focus to the update action');
  check(downloads.length === 1, 'Closing the warning must leave the package untouched');
  updateButton().click();
  await settle(openDialog, 'Second confirmation did not open');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await settle(() => !document.querySelector('[role="dialog"]'), 'Escape must dismiss the warning');
  await settle(() => !updateService.startingDownload, 'Dismissed warning did not settle');

  assessment = { ok: true, warnings: [{ serverName: 'Stopped', bots: [{ name: 'Unknown', status: 'unknown' }] }] };
  await updateService.checkManually();
  updateButton().click();
  await settle(openDialog, 'Unknown compatibility dialog did not open');
  check(openDialog().textContent.includes(t('update.localBotsUnknownTitle')), 'Missing metadata must not claim incompatibility');
  assessment = { ok: true, warnings: [] };
  openDialog().querySelector('[data-action="retry"]').click();
  await settle(() => downloadGate, 'A successful compatibility retry did not continue');
  updateButton().click();
  await settle(() => !updateService.startingDownload, 'Retried download did not cancel');
  downloadGate = null;

  preflightGate = deferred();
  await updateService.checkManually();
  updateButton().click();
  await settle(() => preflightGate.id, 'Preflight did not begin');
  banner().querySelector('.update-banner__dismiss').click();
  await settle(() => !updateService.startingDownload, 'Preflight cancellation did not settle');
  preflightGate = null;
  check(downloads.length === 2, 'Cancelled preflight must not start a download');

  assessment = { ok: true, warnings: [{ serverName: 'Local', bots: [{ name: 'Old bot', status: 'incompatible' }] }] };
  await updateService.checkManually();
  updateButton().click();
  await settle(openDialog, 'Final compatibility confirmation did not open');
  openDialog().querySelector('[data-action="install"]').click();
  await settle(() => downloadGate, 'Explicit install consent did not begin download');
  check(downloads.at(-1) === version, 'Download must remain pinned to the reviewed release');
  boundary = true;
  callbacks.downloaded({ manual: false });
  downloadGate.resolve({ ok: true });
  await settle(() => !updateService.startingDownload, 'Completed download did not settle');
  check(banner().querySelector('.update-banner__text').textContent === t('update.installing'), 'Installation must clearly announce the safe cancellation boundary');
  check(banner().querySelectorAll('button').length === 0, 'Installation must not offer unsafe cancellation');
  return checks;
}
