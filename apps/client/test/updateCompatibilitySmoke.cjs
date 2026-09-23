const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { PROTOCOL_VERSION } = require('@monky/shared');
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
        `(${runRegression.toString()})(${JSON.stringify(language)}, ${PROTOCOL_VERSION})`, true);
      console.log(`Update compatibility (${language}): ${checks} checks passed`);
    }
    await finish(0);
  }).catch(async (error) => { console.error(error); await finish(1); });
}

async function runRegression(language, currentProtocol) {
  const downloads = [];
  const version = '99.0.0-beta';
  let result = { ok: true, available: true, version };
  window.api = {
    setLanguage: async () => {},
    setUpdateChannel: async () => ({ ok: true }),
    getUpdateOutcome: async () => null,
    checkForUpdates: async () => result,
    downloadUpdate: async (target) => { downloads.push(target); return { ok: true }; },
    onUpdateProgress: () => () => {},
    onUpdateDownloaded: () => () => {},
    onUpdateError: () => () => {},
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
  const available = (protocolVersion) => ({
    status: 'available', manifest: { schemaVersion: 1, version, protocolVersion, botSdkVersion: version },
  });
  const updateButton = () => document.querySelector('.update-banner__download');
  result = { ...result, compatibility: available(currentProtocol) };
  await updateService.checkManually();
  check(!document.querySelector('.update-bot-compatibility'), 'An SDK/release version alone must not claim protocol incompatibility');
  updateButton().click();
  await settle(() => downloads.length === 1, 'Same-protocol update did not begin');
  check(!document.querySelector('[role="dialog"]'), 'Compatible update must not add a compatibility confirmation');
  downloads.length = 0;

  result = { ...result, compatibility: available(currentProtocol + 1) };
  await updateService.checkManually();
  check(document.querySelector('.update-bot-compatibility')?.textContent.includes(String(currentProtocol + 1)),
    'Changed protocol warning must be visible before download');
  setLanguage(language === 'pt-BR' ? 'en' : 'pt-BR');
  check(document.querySelector('.update-bot-compatibility')?.textContent === t('update.botCompatibilityChanged', {
    protocol: currentProtocol + 1, sdk: version,
  }), 'Visible compatibility copy must follow the selected app language');
  setLanguage(language);
  updateButton().click();
  await settle(() => document.querySelector('[role="dialog"]'), 'Compatibility confirmation did not open');
  check(downloads.length === 0, 'No package may download before confirmation');
  check(document.querySelector('.update-banner').hidden, 'The high-z-index update banner must not cover its confirmation');
  document.querySelector('[role="dialog"] [data-action="cancel"]').click();
  await settle(() => !document.querySelector('[role="dialog"]') && !document.querySelector('.update-banner').hidden,
    'Cancelled update did not restore its banner');
  check(downloads.length === 0, 'Cancellation must leave the package untouched');
  updateButton().click();
  await settle(() => document.querySelector('[role="dialog"]'), 'Second confirmation did not open');
  document.querySelector('[role="dialog"] [data-action="confirm"]').click();
  await settle(() => downloads.length === 1, 'Confirmed update did not begin');
  check(downloads[0] === version, 'Download must be pinned to the release the user reviewed');
  downloads.length = 0;

  result = { ...result, compatibility: { status: 'unavailable', reason: 'missing metadata' } };
  await updateService.checkManually();
  check(document.querySelector('.update-bot-compatibility')?.textContent === t('update.botCompatibilityUnknown'),
    'Unavailable metadata must not be presented as known compatibility');
  return checks;
}
