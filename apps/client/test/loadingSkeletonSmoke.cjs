const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const clientRoot = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const { test } = require('node:test');
  test('loading interfaces open before their data and ignore cancelled/stale responses', { timeout: 120000 }, async (t) => {
    const parent = path.join(clientRoot, 'dist-test');
    fs.mkdirSync(parent, { recursive: true });
    const profile = fs.mkdtempSync(path.join(parent, 'loading-skeleton-'));
    const env = { ...process.env, MONKY_LOADING_PROFILE: profile, MONKY_HOME: path.join(profile, 'cli') };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'), [__filename], {
      cwd: clientRoot, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const log = chunk => { output = (output + chunk.toString()).slice(-18000); };
    child.stdout.on('data', log);
    child.stderr.on('data', log);
    const deadline = setTimeout(() => child.kill(), 105000);
    t.after(async () => {
      clearTimeout(deadline);
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    });
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, output);
    for (const line of output.split(/\r?\n/).filter(line => line.startsWith('Loading UI'))) t.diagnostic(line);
  });
} else {
  const { app, BrowserWindow } = require('electron');
  app.disableHardwareAcceleration();
  app.setPath('userData', process.env.MONKY_LOADING_PROFILE);
  app.setPath('sessionData', process.env.MONKY_LOADING_PROFILE);
  app.on('window-all-closed', () => {});
  let vite;
  let browser;
  let deadline;
  const finish = async code => {
    clearTimeout(deadline);
    if (browser && !browser.isDestroyed()) browser.destroy();
    await vite?.close();
    app.exit(code);
  };
  app.whenReady().then(async () => {
    const { createServer } = await import('vite');
    vite = await createServer({
      configFile: path.join(clientRoot, 'vite.config.ts'), logLevel: 'error',
      cacheDir: path.join(app.getPath('userData'), 'vite-cache'),
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false },
      plugins: [{
        name: 'loading-skeleton-fixture',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__loading_skeleton__') return next();
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><html><head><link rel="stylesheet" href="/styles/theme.css"></head><body><div id="app"></div></body></html>');
          });
        },
      }],
    });
    const http = vite.httpServer;
    if (!http) throw new Error('Missing fixture HTTP server');
    await new Promise((resolve, reject) => {
      http.once('error', reject);
      http.listen(0, '127.0.0.1', () => { http.removeListener('error', reject); resolve(); });
    });
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    browser = new BrowserWindow({
      show: false, width: 1050, height: 850, useContentSize: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true },
    });
    browser.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    deadline = setTimeout(() => { console.error('Loading UI smoke timed out'); void finish(1); }, 90000);
    browser.webContents.debugger.attach('1.3');
    for (const language of ['pt-BR', 'en']) {
      await browser.loadURL(`http://127.0.0.1:${address.port}/__loading_skeleton__`);
      const checks = await browser.webContents.executeJavaScript(`(${runLoadingSmoke.toString()})(${JSON.stringify(language)})`);
      console.log(`Loading UI (${language}): ${checks} checks passed`);
    }
    await browser.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    await browser.webContents.executeJavaScript(`(async () => {
      const { renderLoadingSkeleton } = await import('/utils/loadingSkeleton.ts');
      document.body.innerHTML = renderLoadingSkeleton();
      await new Promise(requestAnimationFrame);
      const style = getComputedStyle(document.querySelector('.skeleton'), '::after');
      if (style.animationName !== 'none') throw new Error('Reduced motion must stop skeleton animation');
    })()`);
    console.log('Loading UI: reduced motion respected');
    await finish(0);
  }).catch(async error => { console.error(error); await finish(1); });
}

async function runLoadingSmoke(language) {
  let checks = 0;
  const check = (condition, message) => { if (!condition) throw new Error(message); checks++; };
  const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  };
  const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
  const [{ setLanguage, t }, { ScreenSharePickerModal }, { appEvents }, { webRtcManager }] = await Promise.all([
    import('/i18n/index.ts'), import('/views/ScreenSharePickerModal.ts'), import('/core/EventBus.ts'),
    import('/core/WebRtcManager.ts'),
  ]);
  setLanguage(language);
  let availability = deferred();
  let enumeration = deferred();
  let enumerations = 0;
  const originalCapabilities = webRtcManager.getNativeScreenCapabilities;
  webRtcManager.getNativeScreenCapabilities = async () => {
    const capture = await availability.promise;
    return { capture, captureAudio: capture, receive: true, captureKinds: capture ? ['window', 'monitor', 'game'] : [],
      backend: capture ? 'libobs-amf' : null, reason: capture ? null : 'platform' };
  };
  window.api = {
    platform: 'win32',
    nativeScreenCommand: async () => { throw new Error('The loading fixture must not start native capture.'); },
    getDesktopSources: () => { enumerations++; return enumeration.promise; },
  };
  const source = (id, type = 'screen') => ({
    id, type, name: id, thumbnailDataUrl: '', appIconDataUrl: null,
  });
  const picker = new ScreenSharePickerModal();
  let opened = 0;
  let closed = 0;
  const offOpen = appEvents.on('modal.screenshare_picker_opened', () => opened++);
  const offClose = appEvents.on('modal.screenshare_picker_closed', () => closed++);
  const panel = () => document.querySelector('#share-sources-panel');
  const pending = () => {
    check(!!panel(), 'the picker must be in the DOM before capabilities or enumeration resolve');
    check(panel().getAttribute('aria-busy') === 'true', 'pending sources are announced as busy');
    check(panel().querySelector('[role="status"]').getAttribute('aria-label') === t('common.loading'), 'localized loading announcement');
    check(panel().querySelectorAll('.loading-skeleton-card').length === 2, 'source-shaped skeleton cards');
    check(document.querySelector('#btn-share').disabled, 'sharing requires a loaded, selected source');
    check(!document.querySelector('#btn-cancel').disabled, 'cancel remains available during loading');
    check(!document.querySelector('#modal-close').disabled, 'close remains available during loading');
    check(!panel().textContent.includes(t('screenShare.noScreens')), 'pending is not an empty result');
  };

  try {
    let opening = picker.open();
    pending();
    check(opened === 1 && enumerations === 0, 'opened event is emitted before the capability response');
    document.querySelector('#share-tab-window').click();
    pending();
    await new Promise(requestAnimationFrame);
    check(panel().querySelector('.loading-skeleton-thumbnail').getBoundingClientRect().height === 110, 'skeleton has a painted thumbnail-sized layout');
    availability.resolve(true);
    await flush();
    check(enumerations === 1, 'enumeration starts only after capture support is confirmed');
    document.querySelector('#share-tab-screen').click();
    document.querySelector('#share-tab-window').click();
    check(document.querySelector('#share-window-methods').hidden && document.querySelector('#share-method-game').disabled,
      'methods require a loaded, explicitly selected window');
    pending();
    enumeration.resolve([source(`native-monitor:${'1'.repeat(64)}`), source('window:2', 'window')]);
    await opening;
    check(panel().getAttribute('aria-busy') === 'false', 'loaded sources are no longer busy');
    check(!panel().querySelector('.skeleton'), 'loaded data replaces placeholders');
    check(document.querySelector('#share-tab-window').classList.contains('active'), 'source type chosen during enumeration is preserved');
    check(panel().querySelector('[data-source-id="window:2"]'), 'the selected tab receives its sources');
    panel().querySelector('.source-item').click();
    check(!document.querySelector('#btn-share').disabled, 'selection enables sharing after loading');
    check(document.querySelector('#share-method-window').getAttribute('aria-pressed') === 'true',
      'new window selections default to WGC instead of inheriting a hook');
    document.querySelector('#share-method-game').click();
    check(picker.selectedSourceId === 'window:2' && document.querySelector('#share-game-tip').textContent.includes(t('screenShare.gameCompatibility')),
      'the explicit hook method retains the same candidate window and explains compatibility');
    document.querySelector('#share-tab-window').click();
    picker.close();
    check(closed === 1 && !panel(), 'close retires the picker');
    check(!('sources' in picker.sourceState), 'closing releases the source thumbnails instead of retaining them in the singleton');

    availability = deferred();
    opening = picker.open();
    document.querySelector('#btn-cancel').click();
    availability.resolve(true);
    await opening;
    check(!panel() && enumerations === 1, 'cancel during capabilities never starts enumeration or reopens');

    availability = { promise: Promise.resolve(true) };
    enumeration = deferred();
    const oldEnumeration = enumeration;
    const oldOpening = picker.open();
    await flush();
    picker.close();
    enumeration = deferred();
    opening = picker.open();
    await flush();
    const currentPanel = panel();
    oldEnumeration.resolve([source('window:stale', 'window')]);
    await oldOpening;
    check(panel() === currentPanel && panel().querySelector('.skeleton'), 'late response cannot replace the next opening');
    check(!panel().querySelector('[data-source-id="window:stale"]'), 'stale sources never appear');
    enumeration.resolve([source('window:current', 'window')]);
    await opening;
    check(panel().querySelector('[data-source-id="window:current"]'), 'current response hydrates its own opening');
    check(document.querySelector('#share-tab-window').classList.contains('active'), 'window-only sources select the correct tab');
    picker.close();

    enumeration = deferred();
    opening = picker.open();
    await flush();
    enumeration.reject(new Error('Expected source enumeration failure'));
    await opening;
    check(panel().getAttribute('aria-busy') === 'false', 'errors stop the busy state');
    check(panel().querySelector('[role="alert"]').textContent.includes(t('screenShare.loadFailed')), 'load error is visible and localized');
    check(panel().querySelector('[data-loading-retry]'), 'failed enumeration can be retried');
    const retryPanel = panel();
    const openedBeforeRetry = opened;
    enumeration = deferred();
    panel().querySelector('[data-loading-retry]').click();
    pending();
    enumeration.resolve([source('window:retry', 'window')]);
    await flush();
    check(panel() === retryPanel && opened === openedBeforeRetry, 'retry updates the existing picker rather than reopening it');
    check(panel().querySelector('[data-source-id="window:retry"]'), 'retry restores real source choices');
    picker.close();

    enumeration = deferred();
    opening = picker.open();
    await flush();
    picker.close();
    enumeration.reject(new Error('Expected stale failure'));
    await opening;
    check(!panel() && !document.querySelector('.loading-error'), 'late errors do not resurrect a closed picker');

    const previousEnumerations = enumerations;
    availability = { promise: Promise.resolve(false) };
    await picker.open();
    check(panel() && enumerations === previousEnumerations && !panel().querySelector('.source-item'),
      'Unsupported capture never enumerates or offers a source.');
    check([...document.querySelectorAll('.share-source-tabs [role="tab"]')].every(tab => tab.disabled) &&
      document.querySelector('#share-method-reasons').textContent.includes(t('screenShare.platformSoon')),
    'Unavailable methods must remain disabled with a localized reason.');
    picker.close();

    availability = { promise: Promise.resolve(true) };
    enumeration = { promise: Promise.resolve([]) };
    await picker.open();
    check(!panel().querySelector('.skeleton') && !panel().querySelector('[role="alert"]'), 'a successful empty result is not an error or perpetual loading');
    check(panel().textContent.includes(t('screenShare.noWindows')), 'empty results use the existing localized message');
    picker.close();

    delete window.api.getDesktopSources;
    await picker.open();
    check(panel().querySelector('[role="alert"]'), 'an unavailable API is not mistaken for an empty desktop');
    check(opened === closed + 1, 'each completed/abandoned opening emitted one close event');
    picker.close();

    window.api.getDesktopSources = () => { enumerations++; return enumeration.promise; };
    const beforeImmediateClose = enumerations;
    const closeOnOpen = appEvents.on('modal.screenshare_picker_opened', () => picker.close());
    await picker.open();
    closeOnOpen();
    check(!panel() && enumerations === beforeImmediateClose, 'an opening cancelled by its own event does not start a stale request');
  } finally {
    picker.close();
    offOpen();
    offClose();
    webRtcManager.getNativeScreenCapabilities = originalCapabilities;
  }
  check(!panel(), 'all picker instances and placeholders are removed');

  const until = async (condition, message) => {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (condition()) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(message);
  };
  const [{ SoundboardModal }, { soundboardService }, { SoundboardTab }, { settingsStore }] = await Promise.all([
    import('/views/SoundboardModal.ts'), import('/core/SoundboardService.ts'),
    import('/views/settings/tabs/SoundboardTab.ts'), import('/stores/settingsStore.ts'),
  ]);
  const soundboard = new SoundboardModal();
  const soundTab = new SoundboardTab();
  const soundSettings = document.createElement('div');
  const previousFolder = settingsStore.soundboardFolderPath;
  settingsStore.soundboardFolderPath = 'C:\\fixture\\sounds';
  let soundRead = deferred();
  window.api.listSoundboardSounds = () => soundRead.promise;
  window.api.registerSoundboardShortcuts = async () => true;
  soundSettings.innerHTML = soundTab.renderHtml();
  document.body.appendChild(soundSettings);
  soundTab.attachEvents(soundSettings);
  const sound = name => ({
    name, fileName: `${name}.wav`, filePath: `C:\\fixture\\sounds\\${name}.wav`, sizeBytes: 48, ext: '.wav',
  });
  try {
    let opening = soundboard.open();
    const sounds = document.querySelector('#sb-sounds-container');
    check(sounds?.querySelector('.skeleton'), 'soundboard opens before reading its folder');
    check(soundSettings.querySelector('.skeleton'), 'settings sound list shares the same pending state');
    check(sounds.getAttribute('aria-busy') === 'true', 'soundboard announces loading');
    const search = document.querySelector('#sb-search-input');
    search.value = 'beep';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    check(sounds.querySelector('.skeleton'), 'search during loading does not claim no files');
    soundRead.resolve([sound('beep'), sound('other')]);
    await opening;
    check(sounds.querySelectorAll('.sb-sound-btn').length === 1, 'search made during loading applies to the result');
    check(soundSettings.querySelectorAll('.sb-shortcut-row').length === 2, 'settings hydrate independently');
    check(!sounds.querySelector('.skeleton'), 'soundboard replaces placeholders with available sounds');
    soundboard.close();

    soundRead = deferred();
    const staleRead = soundRead;
    const staleOpening = soundboard.open();
    document.querySelector('#sb-btn-close').click();
    soundRead = deferred();
    opening = soundboard.open();
    const current = document.querySelector('#sb-sounds-container');
    staleRead.resolve([sound('stale')]);
    await staleOpening;
    check(current.querySelector('.skeleton'), 'a previous soundboard read cannot overwrite a new opening');
    soundRead.reject(new Error('Expected folder read failure'));
    await opening;
    check(current.querySelector('[role="alert"]'), 'soundboard failure is distinct from an empty folder');
    check(soundSettings.querySelector('[role="alert"]'), 'settings surface the same folder failure');
    soundRead = deferred();
    current.querySelector('[data-loading-retry]').click();
    check(current.querySelector('.skeleton'), 'soundboard retry reuses the existing modal');
    soundRead.resolve([]);
    await flush();
    check(!current.querySelector('.skeleton') && current.textContent.includes(t('soundboard.noAudioFilesTitle')), 'successful empty folder ends loading');
  } finally {
    soundboard.close();
    soundTab.cleanup();
    soundSettings.remove();
    settingsStore.soundboardFolderPath = previousFolder;
    window.api.listSoundboardSounds = async () => [];
    await soundboardService.loadSounds();
  }

  const { ChangelogModal } = await import('/views/ChangelogModal.ts');
  const changelog = new ChangelogModal();
  let notes = deferred();
  window.api.getReleaseNotes = () => notes.promise;
  try {
    let opening = changelog.open();
    check(document.querySelector('.changelog-body .skeleton'), 'manual changelog opens before release notes arrive');
    changelog.close();
    notes.resolve({ ok: false, error: 'Expected stale response' });
    await opening;
    check(!changelog.isOpen(), 'release notes do not reopen a closed changelog');
    notes = deferred();
    opening = changelog.open({ requireContent: true });
    check(!changelog.isOpen(), 'automatic changelog remains gated on real content');
    notes.resolve({ ok: true, version: '1.2.3', body: '' });
    check(!await opening && !changelog.isOpen(), 'empty automatic notes do not flash a modal');
    notes = deferred();
    opening = changelog.open();
    notes.resolve({ ok: false, error: 'Expected release failure' });
    await opening;
    check(document.querySelector('.changelog-body [role="alert"]'), 'manual changelog failure replaces the skeleton');
    notes = deferred();
    document.querySelector('#changelog-retry').click();
    check(document.querySelector('.changelog-body .skeleton'), 'changelog retries visibly');
    notes.resolve({ ok: true, version: '1.2.3', body: '' });
    await flush();
    check(!document.querySelector('.changelog-body .skeleton'), 'empty successful notes finish loading');
  } finally { changelog.close(); }

  const { SettingsModal } = await import('/views/SettingsModal.ts');
  const settings = new SettingsModal();
  const enumerate = navigator.mediaDevices.enumerateDevices;
  let devices = deferred();
  let autoStart = deferred();
  let version = { promise: Promise.resolve('1.2.3') };
  navigator.mediaDevices.enumerateDevices = () => devices.promise;
  window.api.getAppVersion = () => version.promise;
  window.api.getAutoStart = () => autoStart.promise;
  window.api.getClientLogConfig = async () => ({ enabled: false, categories: {} });
  const device = (id, kind) => ({ deviceId: id, groupId: 'fixture', kind, label: id });
  try {
    let opening = settings.open();
    check(document.querySelector('[data-device-loading] .skeleton'), 'device lists have placeholders immediately');
    check(document.querySelector('#checkbox-auto-start').disabled, 'unknown startup preference is not editable');
    await flush();
    check(document.querySelector('#settings-app-version').textContent === 'v1.2.3', 'app version loads without waiting for media enumeration');
    check(!document.querySelector('#settings-app-version').classList.contains('skeleton'), 'available metadata removes its placeholder independently');
    const oldDevices = devices;
    const oldAutoStart = autoStart;
    document.querySelector('#btn-settings-close').click();
    check(!document.querySelector('.modal-backdrop--settings'), 'settings can close while native data is pending');
    devices = deferred();
    autoStart = deferred();
    version = deferred();
    const nextOpening = settings.open();
    const current = document.querySelector('.modal-backdrop--settings');
    oldDevices.resolve([device('obsolete-output', 'audiooutput')]);
    oldAutoStart.resolve(false);
    await opening;
    check(!current.querySelector('option[value="obsolete-output"]'), 'old enumeration cannot mutate the new advanced output controls');
    check(current.querySelector('#checkbox-auto-start').disabled, 'old startup response cannot unlock a new preference control');
    devices.resolve([device('new-mic', 'audioinput'), device('new-output', 'audiooutput'), device('new-cam', 'videoinput')]);
    autoStart.resolve(true);
    version.resolve('2.3.4');
    await nextOpening;
    check(current.querySelector('#select-mic').value !== 'obsolete-output', 'current devices are selected from current state');
    check(current.querySelector('#select-audio-output-voice option[value="new-output"]'), 'current response fills advanced output lists');
    check([...current.querySelectorAll('[data-device-loading]')].every(element => element.hidden), 'all device placeholders disappear on completion');
    check(current.querySelector('#checkbox-auto-start').checked && !current.querySelector('#checkbox-auto-start').disabled, 'startup switch reflects the real asynchronous setting');
    check(current.querySelector('#settings-app-version').textContent === 'v2.3.4', 'reopened settings own their version');
  } finally {
    settings.close();
    navigator.mediaDevices.enumerateDevices = enumerate;
  }

  const [{ InviteModal }, { getActiveNetworkClient }] = await Promise.all([
    import('/views/InviteModal.ts'), import('/core/NetworkClient.ts'),
  ]);
  const invite = new InviteModal();
  const client = getActiveNetworkClient();
  const saved = { sendRequest: client.sendRequest, cancelRequest: client.cancelRequest,
    getCurrentServerUrl: client.getCurrentServerUrl, getHttpBaseUrl: client.getHttpBaseUrl };
  const originalFetch = window.fetch;
  let inviteRead = deferred();
  let cancelledRequests = 0;
  client.sendRequest = () => inviteRead.promise;
  client.getCurrentServerUrl = () => 'ws://127.0.0.1:3456';
  client.getHttpBaseUrl = () => '';
  client.cancelRequest = () => { cancelledRequests++; return true; };
  const inviteInfo = name => ({
    serverName: name, port: 3456,
    networkInterfaces: [{ name: 'fixture', address: '127.0.0.1', family: 'IPv4', type: 'loopback', description: name }],
  });
  try {
    const stale = inviteRead;
    const staleOpening = invite.open();
    check(document.querySelector('#invite-loading-tag .skeleton'), 'invite shows pending network metadata as a skeleton');
    check(document.querySelector('#btn-copy-invite').disabled, 'unknown invite data cannot be copied');
    invite.close();
    inviteRead = deferred();
    const opening = invite.open();
    stale.resolve(inviteInfo('Stale'));
    await staleOpening;
    check(document.querySelector('#btn-copy-invite').disabled, 'old invite metadata cannot finish a new opening');
    inviteRead.resolve(inviteInfo('Current'));
    await opening;
    check(document.querySelector('#invite-server-name').textContent === 'Current', 'invite hydrates the current server metadata');
    check(!document.querySelector('#btn-copy-invite').disabled, 'ready invite is copyable');
    invite.close();
    inviteRead = deferred();
    const failed = invite.open();
    inviteRead.reject(new Error('Expected invite failure'));
    await failed;
    check(document.querySelector('#invite-network-error [role="alert"]'), 'connected-address fallback is explicitly explained rather than silent');
    check(!document.querySelector('#btn-copy-invite').disabled, 'known connected address remains usable after discovery failure');
    invite.close();
    inviteRead = deferred();
    const changing = invite.open();
    appEvents.emit('session.changed', {});
    inviteRead.resolve(inviteInfo('Old session'));
    await changing;
    check(!document.querySelector('#invite-ip-control') && cancelledRequests >= 2, 'leaving the server cancels pending invite work');
    inviteRead = deferred();
    const malformed = invite.open();
    inviteRead.resolve({ ...inviteInfo('Invalid'), port: 'not-a-number' });
    await malformed;
    check(document.querySelector('#invite-network-error [role="alert"]'), 'invalid metadata is not accepted as a ready invite');
    check(document.querySelector('#invite-port').textContent === '3456', 'invalid port does not replace the known connection port');
    invite.close();

    let httpStarted = false;
    let httpAborted = false;
    client.getHttpBaseUrl = () => 'http://127.0.0.1:3456';
    client.sendRequest = async () => { throw new Error('Expected WebSocket fallback'); };
    window.fetch = (url, options) => new Promise((_resolve, reject) => {
      check(url === 'http://127.0.0.1:3456/invite-info', 'HTTP fallback stays bound to the captured server');
      httpStarted = true;
      options.signal.addEventListener('abort', () => {
        httpAborted = true;
        reject(options.signal.reason);
      }, { once: true });
    });
    const httpOpening = invite.open();
    await flush();
    check(httpStarted, 'WebSocket failure uses the existing HTTP metadata fallback');
    invite.close();
    await httpOpening;
    check(httpAborted && !document.querySelector('#invite-ip-control'), 'close aborts the HTTP fallback instead of leaving a background request');
  } finally {
    invite.close();
    Object.assign(client, saved);
    window.fetch = originalFetch;
  }

  const { openImageCropper } = await import('/views/ImageCropModal.ts');
  const OriginalImage = window.Image;
  const imageUrl = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="320"><rect width="640" height="320" fill="red"/></svg>')}`;
  let pendingImage;
  window.Image = function () {
    const image = new OriginalImage();
    Object.defineProperty(image, 'src', { configurable: true, set() {} });
    pendingImage = image;
    return image;
  };
  try {
    const opening = openImageCropper(imageUrl);
    check(document.querySelector('.crop-loading.skeleton'), 'cropper opens before decoding its image');
    check(document.querySelector('[data-action="confirm"]').disabled, 'crop cannot confirm before image dimensions exist');
    document.querySelector('[data-action="cancel"]').click();
    check(await opening === null, 'cropper cancels during image loading');
    check(pendingImage.onload === null && pendingImage.onerror === null, 'cancel detaches pending image callbacks');
    pendingImage.dispatchEvent(new Event('load'));
    check(!document.querySelector('.crop-modal-card'), 'late image load does not resurrect the cropper');
  } finally { window.Image = OriginalImage; }
  let cropping = openImageCropper(imageUrl);
  await until(() => !document.querySelector('[data-action="confirm"]')?.disabled, 'image decode did not finish');
  check(document.querySelector('.crop-loading').hidden, 'decoded image replaces its skeleton');
  check(document.querySelector('.crop-viewport').getAttribute('aria-busy') === 'false', 'crop viewport exits loading');
  document.querySelector('[data-action="confirm"]').click();
  const cropped = await cropping;
  check(cropped.startsWith('data:image/png;base64,'), 'crop still exports PNG');
  const decoded = new OriginalImage();
  const ready = new Promise((resolve, reject) => { decoded.onload = resolve; decoded.onerror = reject; });
  decoded.src = cropped;
  await ready;
  check(decoded.naturalWidth === 512 && decoded.naturalHeight === 512, 'crop output stays exactly 512 by 512');
  cropping = openImageCropper('data:image/png;base64,not-an-image');
  await until(() => document.querySelector('.crop-loading [role="alert"]'), 'invalid image did not show an error');
  check(document.querySelector('[data-action="confirm"]').disabled, 'failed image stays unavailable for confirmation');
  document.querySelector('[data-action="cancel"]').click();
  check(await cropping === null, 'invalid image is not silently returned as a successful crop');
  check(!document.querySelector('.modal-backdrop'), 'all exercised loading surfaces are removed');
  return checks;
}
