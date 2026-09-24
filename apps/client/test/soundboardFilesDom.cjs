const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { authoredOggPreview } = require('./fixtures/authoredAudio.cjs');
const clientRoot = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const profile = path.join(clientRoot, 'dist-test', `soundboard-files-dom-${process.pid}`);
  fs.mkdirSync(profile, { recursive: true });
  const env = { ...process.env, MONKY_SOUNDBOARD_FILES_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, `--user-data-dir=${profile}`], { cwd: clientRoot, env, stdio: 'inherit' });
  child.once('error', error => { console.error(error); process.exitCode = 1; });
  child.once('exit', code => {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    process.exitCode = code ?? 1;
  });
} else {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const { SoundboardDownloads } = require('../dist-electron/main/soundboardDownload.js');
  const { SoundboardFiles } = require('../dist-electron/main/soundboardFiles.js');
  const { setupSoundboardFilesIpc } = require('../dist-electron/main/soundboardFilesIpc.js');
  const { SOUNDBOARD_FILES_IPC, SOUND_DOWNLOAD_IPC, SHORTCUT_IPC, encodeSoundboardEdit } = require('@monky/shared');
  app.setPath('userData', process.env.MONKY_SOUNDBOARD_FILES_PROFILE);
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  app.on('window-all-closed', () => {});
  let vite, browser, timeout, dispose;
  const artifacts = process.env.MONKY_SOUNDBOARD_ARTIFACTS || path.join(clientRoot, 'dist-test', 'soundboard-artifacts');
  fs.mkdirSync(artifacts, { recursive: true });
  const finish = async code => {
    clearTimeout(timeout);
    dispose?.();
    if (browser && !browser.isDestroyed()) browser.destroy();
    if (vite) await vite.close();
    app.exit(code);
  };
  app.whenReady().then(async () => {
    const folders = new SoundboardDownloads(path.join(app.getPath('userData'), 'folder.json'));
    const folder = await folders.getDefaultFolder();
    const files = new SoundboardFiles(folders);
    const pcm = [Float32Array.from({ length: 48000 * 3 }, (_, i) => 0.5 * Math.sin(2 * Math.PI * 100 * i / 48000)),
      Float32Array.from({ length: 48000 * 3 }, (_, i) => -0.25 * Math.sin(2 * Math.PI * 100 * i / 48000))];
    const original = Buffer.from(encodeSoundboardEdit(pcm, 48000, { start: 0, end: 3, fadeIn: 0, fadeOut: 0 }).bytes);
    const reset = () => {
      for (const name of fs.readdirSync(folder)) fs.unlinkSync(path.join(folder, name));
      for (const name of ['tone.wav', 'other.wav', 'rename-me.wav']) fs.writeFileSync(path.join(folder, name), original);
      fs.writeFileSync(path.join(folder, 'authored.ogg'), authoredOggPreview());
      fs.writeFileSync(path.join(folder, 'corrupt.mp3'), 'not an audio file');
    };
    reset();
    const { createServer } = await import('vite');
    vite = await createServer({
      configFile: path.join(clientRoot, 'vite.config.ts'), logLevel: 'error',
      cacheDir: path.join(app.getPath('userData'), 'vite-cache'),
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false, hmr: false, watch: null },
      plugins: [{
        name: 'soundboard-files-fixture',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__soundboard_files__') return next();
            response.setHeader('Content-Type', 'text/html');
            response.end('<!doctype html><html><head><link rel="stylesheet" href="/styles/fonts.css"><link rel="stylesheet" href="/styles/theme.css"></head><body><div id="sidebar"></div></body></html>');
          });
        },
      }],
    });
    await new Promise((resolve, reject) => {
      vite.httpServer.once('error', reject);
      vite.httpServer.listen(0, '127.0.0.1', resolve);
    });
    const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
    browser = new BrowserWindow({
      show: false, width: 1000, height: 850, useContentSize: true,
      webPreferences: {
        contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false, offscreen: true,
        preload: path.join(clientRoot, 'dist-electron', 'preload', 'preload.js'),
      },
    });
    const errors = [];
    browser.webContents.on('preload-error', (_event, _path, error) => errors.push(error.message));
    browser.webContents.setAudioMuted(true);
    browser.webContents.debugger.attach('1.3');
    browser.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    browser.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    browser.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url);
      callback({ cancel: url.origin !== origin && !['data:', 'blob:'].includes(url.protocol) });
    });
    dispose = setupSoundboardFilesIpc(browser, files);
    ipcMain.handle(SOUND_DOWNLOAD_IPC.defaultFolder, () => folder);
    ipcMain.handle('app:set-language', () => {});
    ipcMain.handle(SHORTCUT_IPC.registerSoundboard, () => true);
    ipcMain.handle(SHORTCUT_IPC.setPttConfig, () => true);
    ipcMain.handle('soundboard:list-sounds', () => fs.readdirSync(folder).map(fileName => ({
      fileName, filePath: path.join(folder, fileName), ext: path.extname(fileName),
      name: path.basename(fileName, path.extname(fileName)), sizeBytes: fs.statSync(path.join(folder, fileName)).size,
    })));
    ipcMain.handle('soundboard:read-sound', async (_event, filePath) => {
      assert.equal(path.dirname(filePath), folder);
      const result = await files.read({ folder, fileName: path.basename(filePath) });
      if (result.status !== 'ok') return null;
      const bytes = Buffer.from(result.value), fileName = path.basename(filePath);
      const mimeType = fileName.endsWith('.ogg') ? 'audio/ogg' : 'audio/wav';
      return { fileName, soundName: path.basename(fileName, path.extname(fileName)), base64: bytes.toString('base64'),
        dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}`, mimeType, sizeBytes: bytes.length };
    });
    timeout = setTimeout(() => { console.error('Soundboard file DOM test timed out'); void finish(1); }, 120000);
    const nativeClick = async selector => {
      const box = await browser.webContents.executeJavaScript(`(() => {
        const b=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        return {x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)};
      })()`);
      browser.webContents.sendInputEvent({ type: 'mouseDown', ...box, button: 'left', clickCount: 1 });
      browser.webContents.sendInputEvent({ type: 'mouseUp', ...box, button: 'left', clickCount: 1 });
    };
    const nativeDrag = async (handle, fraction, cancel = false) => {
      const box = await browser.webContents.executeJavaScript(`(() => {
        const b=document.querySelector('[data-handle="${handle}"]').getBoundingClientRect();
        const c=document.querySelector('.sb-timeline canvas').getBoundingClientRect();
        return {x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2),to:Math.round(c.x+18+${fraction}*(c.width-36))};
      })()`);
      browser.webContents.focus();
      browser.webContents.sendInputEvent({ type: 'mouseDown', x: box.x, y: box.y, button: 'left', clickCount: 1 });
      browser.webContents.sendInputEvent({ type: 'mouseMove', x: box.to, y: box.y, modifiers: ['leftButtonDown'] });
      await new Promise(resolve => setTimeout(resolve, 30));
      if (cancel) {
        browser.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
        browser.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      }
      browser.webContents.sendInputEvent({ type: 'mouseUp', x: box.to, y: box.y, button: 'left', clickCount: 1 });
      await new Promise(resolve => setTimeout(resolve, 30));
    };
    const sharedUrl = '/@fs/' + path.resolve(clientRoot, '..', '..', 'packages', 'shared', 'src', 'index.ts').replaceAll('\\', '/');
    for (const language of ['pt-BR', 'en']) {
      reset();
      await browser.loadURL(`${origin}/__soundboard_files__`);
      await browser.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
      assert.deepEqual(errors, [], 'Production preload must load');
      const initial = await browser.webContents.executeJavaScript(`(${runDom.toString()})(${JSON.stringify({ folder, language, sharedUrl })})`, true);
      console.log(`Soundboard DOM ${language}: initial ${initial} exact checks passed`);
      browser.webContents.focus();
      await browser.webContents.executeJavaScript('window.soundboardFilesQa.menuNativePrepare()', true);
      browser.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
      browser.webContents.sendInputEvent({ type: 'char', keyCode: ' ' });
      browser.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
      await browser.webContents.executeJavaScript('window.soundboardFilesQa.menuNativeOpened()', true);
      fs.writeFileSync(path.join(artifacts, `soundboard-actions-${language}.png`), (await browser.webContents.capturePage()).toPNG());
      browser.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      browser.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      await browser.webContents.executeJavaScript('window.soundboardFilesQa.menuNativeClosed()', true);
      await browser.webContents.executeJavaScript('window.soundboardFilesQa.openEditor()', true);
      await browser.webContents.executeJavaScript('window.soundboardFilesQa.waveformChecks()', true);
      for (const [handle, fraction] of [['start', 0.1], ['end', 0.9], ['fadeIn', 0.2], ['fadeOut', 0.8]]) {
        await nativeDrag(handle, fraction);
      }
      const dragged = await browser.webContents.executeJavaScript('window.soundboardFilesQa.waveformState()');
      assert.ok(Math.abs(dragged.start - 0.3) < 0.01 && Math.abs(dragged.end - 2.7) < 0.01, JSON.stringify(dragged));
      assert.ok(Math.abs(dragged.fadeIn - 0.3) < 0.02 && Math.abs(dragged.fadeOut - 0.3) < 0.02, JSON.stringify(dragged));
      await nativeDrag('start', 0.4, true);
      assert.deepEqual(await browser.webContents.executeJavaScript('window.soundboardFilesQa.waveformState()'), dragged,
        'Escape rolls back the real captured pointer drag without closing the editor');
      browser.setContentSize(700, 850);
      await new Promise(resolve => setTimeout(resolve, 100));
      await nativeDrag('end', 0.95);
      assert.ok(Math.abs((await browser.webContents.executeJavaScript('window.soundboardFilesQa.waveformState()')).end - 2.85) < 0.015);
      browser.setContentSize(1000, 850);
      await new Promise(resolve => setTimeout(resolve, 100));
      await browser.webContents.executeJavaScript('window.soundboardFilesQa.setExactSelection()', true);
      await browser.webContents.executeJavaScript('window.soundboardFilesQa.playerChecks()', true);
      await browser.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))', true);
      await new Promise(resolve => setTimeout(resolve, 150));
      fs.writeFileSync(path.join(artifacts, `soundboard-editor-${language}.png`), (await browser.webContents.capturePage()).toPNG());
      const complete = await browser.webContents.executeJavaScript('window.soundboardFilesQa.complete()', true);
      console.log(`Soundboard DOM ${language}: ${complete} total exact checks passed (production preload/IPC, real filesystem/decoder, private preview, progress/stop, lifecycle)`);
      assert.deepEqual(fs.readFileSync(path.join(folder, 'other.wav')), original, 'Original other file unchanged');
      assert.deepEqual(fs.readFileSync(path.join(folder, 'tone.wav')), original, 'Edited original unchanged');
      const edited = fs.readFileSync(path.join(folder, `copy-${language}.wav`));
      assert.equal(edited.readUInt16LE(22), 2);
      assert.equal(edited.readUInt16LE(34), 24);
      assert.equal(edited.readUInt32LE(40) / 6 / 48000, 1.5);
      assert.equal(edited.readIntLE(44, 3), 0);
      assert.equal(edited.readIntLE(44 + (72000 - 1) * 6, 3), 0);
      assert.ok(!fs.existsSync(path.join(folder, 'renamed.wav')), 'Confirmed deletion removed actual OS file');
      await browser.webContents.executeJavaScript('window.soundboardFilesQa.prepareOverwrite()', true);
      assert.deepEqual(fs.readFileSync(path.join(folder, 'other.wav')), original, 'Cancelled overwrite preserves bytes');
      await nativeClick('.dialog-card [data-action="confirm"]');
      await browser.webContents.executeJavaScript('window.soundboardFilesQa.finishOverwrite()', true);
      const replacement = fs.readFileSync(path.join(folder, 'other.wav'));
      assert.equal(replacement.readUInt32LE(40) / 6 / 48000, 1);
      assert.equal(replacement.readIntLE(44, 3), 0);
      assert.equal(replacement.readIntLE(replacement.length - 6, 3), 0);
      assert.deepEqual(fs.readFileSync(path.join(folder, 'tone.wav')), original);
      const longPcm = [Float32Array.from({ length: 48000 * 131 }, (_, i) => 0.125 * Math.sin(2 * Math.PI * 200 * i / 48000))];
      const longWav = Buffer.from(encodeSoundboardEdit(longPcm, 48000, { start: 0, end: 131, fadeIn: 0, fadeOut: 0 }).bytes);
      fs.writeFileSync(path.join(folder, 'long.wav'), longWav);
      await browser.webContents.executeJavaScript('window.soundboardFilesQa.largePlayer()', true);
      const longCopy = fs.readFileSync(path.join(folder, `long-copy-${language}.wav`));
      assert.equal(longCopy.readUInt32LE(40), 48000 * 130 * 3);
      assert.ok(longCopy.length > 3 * 1024 * 1024);
      assert.deepEqual(fs.readFileSync(path.join(folder, 'long.wav')), longWav, 'Large-file editing preserves the original');
      await browser.webContents.executeJavaScript('window.soundboardFilesQa.openFinal()', true);
      fs.writeFileSync(path.join(artifacts, `soundboard-modal-${language}.png`), (await browser.webContents.capturePage()).toPNG());
      await browser.webContents.executeJavaScript('window.soundboardFilesQa.dispose()', true);
    }
    assert.equal(Object.keys(SOUNDBOARD_FILES_IPC).length, 6);
    console.log(`Soundboard integration: native waveform drags, 1.500000 s copies, confirmed 1.000000 s overwrite, source isolation verified. Screenshots: ${artifacts}`);
    await finish(0);
  }).catch(async error => {
    console.error(error);
    if (browser && !browser.isDestroyed()) fs.writeFileSync(path.join(artifacts, 'soundboard-files-failure.png'), (await browser.webContents.capturePage()).toPNG());
    await finish(1);
  });
}

async function runDom(fixture) {
  let checks = 0;
  const check = (value, message) => { if (!value) throw new Error(message); checks++; };
  const until = async (probe, message) => {
    const deadline = Date.now() + 8000;
    while (!probe()) { if (Date.now() > deadline) throw new Error(message); await new Promise(resolve => setTimeout(resolve, 15)); }
  };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  check(typeof window.api.saveSoundboardEdit === 'function', 'Real preload exposes editing');
  const [{ settingsStore }, { soundboardService }, { SoundboardModal }, { SoundboardPlayersBar }, { favoritesStore },
    { appEvents }, { setLanguage, t }, library, { voiceStore }, { serverStore }, { sessionManager }, shared] = await Promise.all([
    import('/stores/settingsStore.ts'), import('/core/SoundboardService.ts'), import('/views/SoundboardModal.ts'),
    import('/views/SoundboardPlayersBar.ts'), import('/stores/favoritesStore.ts'), import('/core/EventBus.ts'),
    import('/i18n/index.ts'), import('/core/SoundboardLibrary.ts'), import('/stores/voiceStore.ts'),
    import('/stores/serverStore.ts'), import('/core/SessionManager.ts'), import(fixture.sharedUrl),
  ]);
  setLanguage(fixture.language);
  settingsStore.soundboardFolderPath = fixture.folder;
  settingsStore.soundboardMuted = false;
  settingsStore.soundboardVolume = 37;
  settingsStore.soundboardLimiterEnabled = false;
  settingsStore.soundboardLoudnessLimit = 6;
  settingsStore.soundboardViewMode = 'grid';
  settingsStore.save();
  const modal = new SoundboardModal();
  const sidebar = new SoundboardPlayersBar();
  sidebar.mount(document.querySelector('#sidebar'));
  await modal.open();
  const root = () => document.querySelector('.soundboard-modal-card');
  const menuTrigger = fileName => [...root().querySelectorAll('[data-file-menu]')]
    .find(button => button.dataset.filepath.endsWith(fileName));
  const popup = () => document.querySelector('.floating-context-menu');
  const openMenu = fileName => {
    const trigger = menuTrigger(fileName);
    if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click();
    return popup();
  };
  const actions = (action, fileName) => [...openMenu(fileName).querySelectorAll('[role="menuitem"]')]
    .find(button => button.lastElementChild.textContent === t(action === 'edit' ? 'common.edit' : `soundboard.${action}`));
  const input = (selector, value) => {
    const field = document.querySelector(selector); field.value = String(value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    return field;
  };
  const exactStatus = text => document.querySelector('#sb-file-status')?.textContent === text;
  const name = fileName => soundboardService.getSounds().find(sound => sound.fileName === fileName);
  const key = (handle, keyName, count = 1, shiftKey = false) => {
    for (let index = 0; index < count; index++) document.querySelector(`[data-handle="${handle}"]`)
      .dispatchEvent(new KeyboardEvent('keydown', { key: keyName, shiftKey, bubbles: true }));
  };
  const waveformState = () => Object.fromEntries(['start', 'end', 'fadeIn', 'fadeOut'].map(handle =>
    [handle, Number(document.querySelector(`[data-handle="${handle}"]`).getAttribute('aria-valuenow'))]));
  check(soundboardService.getActivePlaybacks(true).length === 0, 'Opening the modal never plays audio');
  const listenerTotal = () => [...appEvents.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0);
  const closedMenuListeners = listenerTotal();
  for (const mode of ['grid', 'list']) {
    root().querySelector(`#sb-btn-view-${mode}`).click();
    const trigger = menuTrigger('tone.wav');
    check(root().querySelectorAll('[data-file-menu]').length === 5 && !root().querySelector('[data-file-action]'), `${mode}: one menu replaces three inline actions per audio`);
    check([...root().querySelectorAll('[data-file-menu]')].every(button =>
      button.querySelector('.material-symbols-outlined').textContent === 'more_vert'), `${mode}: options use vertical dots`);
    if (mode === 'list') check([...root().querySelectorAll('.sb-sound-row')].every(row => {
      const menu = row.querySelector('[data-file-menu]');
      const shortcut = row.querySelector('.sb-btn-add-shortcut, .sb-shortcut-badge');
      return row.lastElementChild === menu && menu.getBoundingClientRect().left >= shortcut.getBoundingClientRect().right;
    }), 'List options are the last control at the far right, after the shortcut');
    check(trigger.getAttribute('aria-label') === t('soundboard.moreActions', { name: 'tone' }) &&
      trigger.getAttribute('aria-haspopup') === 'menu', `${mode}: trigger has localized file-specific accessible name`);
    trigger.click();
    const menu = popup(), items = [...menu.querySelectorAll('[role="menuitem"]')];
    check(items.length === 3 && items.map(item => item.lastElementChild.textContent).join('|') ===
      [t('common.edit'), t('soundboard.rename'), t('soundboard.delete')].join('|'), `${mode}: exact localized edit/rename/delete actions`);
    check(items[2].classList.contains('danger') && !items[0].classList.contains('danger'), `${mode}: deletion keeps danger styling`);
    check(document.activeElement === items[0] && trigger.getAttribute('aria-expanded') === 'true', `${mode}: opening focuses first item`);
    const bounds = menu.getBoundingClientRect();
    check(bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight, `${mode}: floating dropdown fits viewport`);
    for (const item of items) {
      const box = item.getBoundingClientRect();
      check(item.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)), `${mode}: dropdown is not clipped or covered by modal`);
    }
    for (const [key, index] of [['ArrowDown', 1], ['End', 2], ['Home', 0]]) {
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      check(document.activeElement === items[index], `${mode}: menu navigates with ${key}`);
    }
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    check(!popup() && document.activeElement === trigger && trigger.getAttribute('aria-expanded') === 'false', `${mode}: Escape restores trigger focus without closing modal`);
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    check(!!popup(), `${mode}: ArrowDown opens dropdown`);
    trigger.click();
    check(!popup(), `${mode}: clicking open trigger toggles dropdown closed`);
    openMenu('tone.wav'); openMenu('other.wav');
    check(document.querySelectorAll('.floating-context-menu').length === 1 && trigger.getAttribute('aria-expanded') === 'false', `${mode}: switching sounds cannot leave multiple menus`);
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    check(!popup(), `${mode}: outside pointer dismisses dropdown`);
    openMenu('tone.wav');
    root().querySelector('.sb-modal-body').dispatchEvent(new Event('scroll'));
    check(!popup(), `${mode}: scrolling dismisses stale dropdown`);
    openMenu('tone.wav');
    input('#sb-search-input', 'tone');
    check(!popup(), `${mode}: filtering closes stale dropdown`);
    input('#sb-search-input', '');
    check(soundboardService.getActivePlaybacks(true).length === 0, `${mode}: menu interactions never trigger row playback`);
    check(listenerTotal() === closedMenuListeners, `${mode}: closed menus remove all event-bus subscriptions`);
  }
  openMenu('tone.wav'); root().querySelector('#sb-btn-view-grid').click();
  check(!popup(), 'Switching view modes closes dropdown');
  root().querySelector('#sb-btn-view-list').click();
  openMenu('tone.wav'); modal.close();
  check(!popup(), 'Closing parent removes dropdown');
  await modal.open();
  check(!root().querySelector('input[type="radio"], input[type="checkbox"]:not([role="switch"])'), 'No standalone native choices');
  const volume = settingsStore.soundboardVolume;
  root().querySelector('#sb-btn-settings').click();
  const quickSettings = document.querySelector('#sb-settings-section');
  const limiterToggle = quickSettings.querySelector('[data-limiter-toggle]');
  const ceiling = quickSettings.querySelector('[data-limiter-ceiling]');
  check(ceiling.disabled, 'Collapsed ceiling cannot be changed while limiting is disabled');
  limiterToggle.click();
  await until(() => !ceiling.disabled, 'Limiter preparation did not complete');
  ceiling.value = '4'; ceiling.dispatchEvent(new Event('input', { bubbles: true }));
  for (const [mode, fileName] of [['grid', 'tone.wav'], ['list', 'rename-me.wav']]) {
    root().querySelector(`#sb-btn-view-${mode}`).click();
    const sound = name(fileName);
    const button = [...root().querySelectorAll('.sb-sound-btn')].find(element => element.dataset.filepath === sound.filePath);
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    button.focus({ preventScroll: true });
    button.click();
    await until(() => soundboardService.getActivePlaybacks().some(entry => entry.soundName === sound.name),
      'Library click did not start the selected sound');
    check(root().querySelector('#sb-btn-settings').getAttribute('aria-expanded') === 'true' && !quickSettings.inert,
      `${mode}: playback and focus changes keep inline settings open`);
    check(soundboardService.audioOutput.graph.limiter.parameters.get('limitLevel').value === 4,
      `${mode}: live playback uses the ceiling being adjusted`);
  }
  root().querySelector('#sb-modal-players .sb-notice-stop-btn').click();
  check(soundboardService.getActivePlaybacks().length === 0 && !quickSettings.inert,
    'Stopping playback from the modal also keeps inline settings open');
  limiterToggle.click();
  check(settingsStore.soundboardLoudnessLimit === 4 && !settingsStore.soundboardLimiterEnabled, 'Disabling limiting preserves the chosen ceiling');
  check(settingsStore.soundboardVolume === volume, 'Ceiling leaves volume unchanged');
  check(!quickSettings.querySelector('.sb-limiter-legend'), 'Colored legend removed');
  check(quickSettings.querySelector('[data-limiter-value]').textContent === '4 / 10', 'Ceiling numeric label exact');
  root().querySelector('#sb-btn-settings').click();
  const tone = name('rename-me.wav');
  favoritesStore.toggleSound(tone.filePath);
  settingsStore.soundboardShortcuts = { 'rename-me': { accelerator: 'Ctrl+Shift+1', display: 'Ctrl + Shift + 1' } };
  settingsStore.save();
  await soundboardService.playSound(tone.filePath);
  check(soundboardService.getActivePlaybacks().some(entry => entry.soundName === 'rename-me'), 'Rename fixture is actually playing');
  actions('rename', 'rename-me.wav').click();
  await until(() => document.querySelector('[data-dialog-input]'), 'Rename dialog missing');
  check(document.querySelector('.dialog-text-suffix').textContent === '.wav', 'Rename preserves extension');
  input('[data-dialog-input]', '../escape');
  check(document.querySelector('[data-action="confirm"]').disabled, 'Traversal rejected before IPC');
  input('[data-dialog-input]', 'renamed');
  document.querySelector('[data-action="confirm"]').click();
  await until(() => name('renamed.wav') && exactStatus(t('soundboard.fileRenamed')), 'Rename did not update list/status');
  check(!name('rename-me.wav'), 'Old filename removed from list');
  const renamed = name('renamed.wav');
  check(favoritesStore.isSoundFavorite(renamed.filePath) && !favoritesStore.isSoundFavorite(tone.filePath), 'Favorite follows actual renamed path');
  check(settingsStore.soundboardShortcuts.renamed?.accelerator === 'Ctrl+Shift+1' && !settingsStore.soundboardShortcuts['rename-me'], 'Shortcut follows rename');
  check(soundboardService.getActivePlaybacks(true).length === 0, 'File actions never trigger row playback');
  actions('rename', 'renamed.wav').click();
  input('[data-dialog-input]', 'other');
  document.querySelector('[data-action="confirm"]').click();
  await until(() => exactStatus(t('soundboard.fileError.exists')), 'Duplicate rename must show exact localized error');
  check(!!name('renamed.wav') && !!name('other.wav'), 'Duplicate rename retains both list entries');
  actions('delete', 'renamed.wav').click();
  check(document.querySelector('.dialog-message').textContent === t('soundboard.deleteConfirm', { name: 'renamed.wav' }), 'Permanent deletion warning exact');
  document.querySelector('[data-action="cancel"]').click();
  await wait(30);
  check(!!name('renamed.wav'), 'Cancelled delete preserves file');
  actions('delete', 'renamed.wav').click();
  document.querySelector('[data-action="confirm"]').click();
  await until(() => !name('renamed.wav') && exactStatus(t('soundboard.fileDeleted')), 'Confirmed delete must refresh list and status');
  check(!favoritesStore.isSoundFavorite(renamed.filePath) && !settingsStore.soundboardShortcuts.renamed, 'Delete cleans favorite and shortcut');
  // Real browser decoding feeds the shared encoder; no microphone or external audio.
  const other = library.soundboardFileValue(await window.api.readSoundboardEdit({ folder: fixture.folder, fileName: 'other.wav' }));
  const decoded = await library.decodeSoundboardEdit(other, new AbortController().signal);
  const originalChannels = [decoded.getChannelData(0), decoded.getChannelData(1)];
  let heardBytes;
  const ogg = library.soundboardFileValue(await window.api.readSoundboardEdit({ folder: fixture.folder, fileName: 'authored.ogg' }));
  const oggDecoded = await library.decodeSoundboardEdit(ogg, new AbortController().signal);
  check(Math.abs(oggDecoded.duration - 0.5) < 1 / 48000 && oggDecoded.numberOfChannels === 2, 'Actual Ogg Opus decoder supports authored fixture');
  actions('edit', 'corrupt.mp3').click();
  await until(() => document.querySelector('[data-editor-status]')?.textContent === t('soundboard.fileError.unsupported'), 'Unsupported input requires exact error');
  document.querySelector('[data-editor-close]').click();
  await wait(30);
  const baselineListeners = () => [...appEvents.listeners.entries()].reduce((sum, [key, value]) =>
    sum + (key.startsWith('soundboard.') ? value.size : 0), 0);
  // Real media progression; both views must bind the same element and stop controller.
  await soundboardService.playSound(name('tone.wav').filePath);
  await until(() => root().querySelector('#sb-modal-players .sb-notice-bar') && soundboardService.getActivePlaybacks().length === 1, 'Modal progress did not appear');
  const playback = soundboardService.getActivePlaybacks()[0];
  await until(() => playback.audio.duration === 3, 'Real media duration unavailable');
  playback.audio.currentTime = 1.25;
  await until(() => root().querySelector('.sb-notice-time')?.textContent === '0:01 / 0:03', 'Elapsed/duration label not synchronized');
  check(root().querySelector('.sb-notice-text').textContent.includes('tone'), 'Current sound label exact');
  playback.audio.pause();
  await until(() => root().querySelector('.sb-notice-bar.is-paused'), 'Paused playback should retain a stoppable progress bar');
  const pausedTime = root().querySelector('.sb-notice-time').textContent;
  await wait(100);
  check(root().querySelector('.sb-notice-time').textContent === pausedTime, 'Paused time does not advance');
  check(root().querySelector('[role="progressbar"]').getAttribute('aria-valuenow') === String(playback.audio.currentTime / 3 * 100), 'Accessible progress reflects real currentTime');
  root().querySelector('.sb-notice-stop-btn').click();
  await until(() => !root().querySelector('.sb-notice-bar'), 'Stop did not remove modal bar');
  check(playback.audio.paused && !playback.audio.getAttribute('src'), 'Stop releases real media source');
  check(soundboardService.getActivePlaybacks(true).length === 0, 'Stop clears shared controller');
  await soundboardService.playSound(name('tone.wav').filePath);
  await until(() => soundboardService.getActivePlaybacks().length === 1, 'Playback restart failed');
  await soundboardService.playSound(name('other.wav').filePath);
  await until(() => root().querySelector('.sb-notice-bar')?.dataset.sound === 'other', 'Selected file change leaves stale progress');
  check(soundboardService.getActivePlaybacks(true).length === 1, 'Switching files reuses one local playback slot');
  const continuing = soundboardService.getActivePlaybacks()[0];
  continuing.audio.loop = true;
  const listenersWithModal = baselineListeners();
  modal.close();
  check(!continuing.audio.paused, 'Closing modal preserves ordinary playback');
  check(baselineListeners() < listenersWithModal, 'Modal teardown removes playback subscriptions');
  await modal.open();
  check(root().querySelector('.sb-notice-bar')?.dataset.sound === 'other', 'Reopened modal hydrates existing player without restarting');
  continuing.audio.loop = false; continuing.audio.currentTime = 2.9;
  await until(() => soundboardService.getActivePlaybacks(true).length === 0 && !root().querySelector('.sb-notice-bar'), 'Natural end must clear controller and view');
  // Simulate a voice connection without networking: only the controller's send spy is used.
  const sent = [];
  const priorGet = sessionManager.get;
  const session = { client: { send: (...args) => sent.push(args) }, serverStore: { currentUser: { id: 'self' }, serverDetails: {}, hasPermission: () => true } };
  sessionManager.get = () => session;
  voiceStore.currentVoiceChannelId = 'qa-channel';
  voiceStore.voiceSessionKey = 'qa-session';
  try {
    await soundboardService.playSound(name('tone.wav').filePath);
    check(sent.length === 1 && sent[0][0] === shared.MessageType.SOUNDBOARD_PLAY && sent[0][1].channelId === 'qa-channel', 'Normal playback still broadcasts exact soundboard message');
    const incoming = await window.api.readSoundboardSound(name('tone.wav').filePath);
    await soundboardService.handleIncomingSound({ userId: 'self', userName: 'QA', soundName: 'tone', audioBase64: incoming.base64, mimeType: incoming.mimeType });
    await until(() => soundboardService.getActivePlaybacks().some(entry => entry.userId === 'self'), 'Own incoming audio did not play');
    soundboardService.stopSoundFromUi('self');
    check(sent.at(-1)[0] === shared.MessageType.SOUNDBOARD_STOP, 'Explicit own stop still broadcasts');
    const before = sent.length;
    const preview = shared.encodeSoundboardEdit(originalChannels, 48000, { start: 0, end: 1, fadeIn: 0.1, fadeOut: 0.1 });
    await soundboardService.previewEditedSound(preview.bytes, 'private');
    await until(() => soundboardService.getActivePlaybacks().some(entry => entry.userId === 'editor-preview'), 'Private preview did not start');
    soundboardService.stopSoundFromUi('editor-preview');
    check(sent.length === before, 'Editor preview and stop never send anything to the channel');
  } finally {
    sessionManager.get = priorGet; voiceStore.currentVoiceChannelId = null; voiceStore.voiceSessionKey = null;
    soundboardService.stopSound();
  }
  window.soundboardFilesQa = {
    waveformState,
    async menuNativePrepare() {
      const trigger = menuTrigger('tone.wav');
      trigger.scrollIntoView({ block: 'center', behavior: 'instant' });
      trigger.focus({ preventScroll: true });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    },
    async menuNativeOpened() {
      await until(() => popup(), 'Native Space must open the file dropdown');
      await Promise.all(popup().getAnimations().map(animation => animation.finished));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      check(!!popup(), 'Native dropdown remains open after layout and painting');
      check(document.activeElement === popup().querySelector('button'), 'Native menu opening focuses first item');
      check(soundboardService.getActivePlaybacks(true).length === 0, 'Native menu activation never starts sound');
    },
    async menuNativeClosed() {
      await until(() => !popup(), 'Native Escape must dismiss dropdown');
      check(document.activeElement === menuTrigger('tone.wav'), 'Native Escape returns focus to the file menu trigger');
    },
    async openEditor() {
      actions('edit', 'tone.wav').click();
      await until(() => document.querySelector('[data-editor-form] fieldset')?.disabled === false, 'Editor did not decode source');
      check(document.querySelector('#sb-editor-title').textContent === t('soundboard.edit'), 'Editor title localized exactly');
      check(document.querySelector('[data-handle="start"]').getAttribute('aria-label') === t('soundboard.waveform.start'), 'Trim start slider label exact');
      check(document.querySelector('[data-editor-save]').textContent === t('soundboard.saveCopy'), 'Save-new action localized');
      check(document.querySelector('[data-editor-overwrite]').textContent === t('soundboard.overwrite'), 'Separate overwrite action localized');
      check(document.querySelector('.sb-editor-help').textContent === t('soundboard.editorHelp'), 'Encoding and preservation disclosure exact');
      check(soundboardService.getActivePlaybacks(true).length === 0, 'Opening editor does not start playback');
    },
    async waveformChecks() {
      const { soundboardPeaks } = await import('/views/SoundboardTimeline.ts');
      const peaks = soundboardPeaks(decoded);
      check(peaks.length === 2 && peaks[0].length === 4096, 'Real waveform preserves channels with bounded bins');
      check(peaks[0].some(value => value > 0.49) && peaks[1].some(value => value < -0.24), 'Waveform peaks reflect decoded source amplitudes');
      const silent = new AudioBuffer({ length: 480, sampleRate: 48000, numberOfChannels: 1 });
      check(soundboardPeaks(silent)[0].every(value => value === 0), 'Silence is a flat waveform, not decoration');
      check(!document.querySelector('.sb-editor-card input[type="number"]'), 'No numeric entry required');
      check(document.querySelectorAll('.sb-timeline [role="slider"]').length === 4, 'Four accessible drag handles');
      const handleBox = handle => document.querySelector(`[data-handle="${handle}"]`).getBoundingClientRect();
      const aligned = (first, second) => Math.abs(handleBox(first).top - handleBox(second).top) < 0.1;
      const separate = (first, second) => {
        const a = handleBox(first), b = handleBox(second);
        return a.bottom <= b.top || b.bottom <= a.top || a.right <= b.left || b.right <= a.left;
      };
      const reachable = handle => {
        const box = handleBox(handle);
        return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('[data-handle]')?.dataset.handle === handle;
      };
      check(aligned('start', 'end') && aligned('fadeIn', 'fadeOut'), 'Distant crop and fade handles are aligned in pairs');
      key('fadeIn', 'End');
      check(separate('fadeIn', 'fadeOut') && reachable('fadeIn') && reachable('fadeOut'), 'Coincident fade handles remain independently clickable');
      key('start', 'ArrowRight', 1, true);
      check(document.querySelector('[data-fade-adjustment]').textContent === t('soundboard.fadesAdjusted'), 'Shrinking cut explains proportional fade clamping');
      check(Math.abs(waveformState().fadeIn - 2.9) < 1e-9, 'Fade remains within shortened selection');
      key('fadeIn', 'Home'); key('fadeOut', 'Home'); key('start', 'Home'); key('end', 'End');
      key('start', 'End');
      check(separate('start', 'end') && reachable('start') && reachable('end'), 'One-frame crop handles cannot overlap');
      key('start', 'Home');
      const timeline = document.querySelector('.sb-timeline');
      timeline.style.width = '70px';
      await until(() => timeline.classList.contains('has-crop-overlap'), 'Resize must recompute handle collisions');
      check(separate('start', 'end') && separate('fadeIn', 'fadeOut'), 'Narrow tracks keep both handle pairs usable');
      timeline.style.removeProperty('width');
      await until(() => aligned('start', 'end') && aligned('fadeIn', 'fadeOut'), 'Widening track must restore aligned handles');
      check(soundboardService.getActivePlaybacks(true).length === 0, 'Moving handles never starts audio');
    },
    setExactSelection() {
      key('fadeIn', 'Home'); key('fadeOut', 'Home'); key('start', 'Home'); key('end', 'End');
      key('start', 'ArrowRight', 5, true); key('end', 'ArrowLeft', 10, true);
      key('fadeIn', 'ArrowRight', 2, true); key('fadeIn', 'ArrowRight', 5);
      key('fadeOut', 'ArrowRight', 5, true);
      const selected = waveformState();
      check(selected.start === 0.5 && selected.end === 2 && selected.fadeIn === 0.25 && selected.fadeOut === 0.5,
        'Keyboard-accessible handles set exact crop and fade times');
      input('#sb-edit-name', `copy-${fixture.language}`);
      check(document.querySelector('[data-editor-summary]').textContent === t('soundboard.editSummary', { duration: '1.500', channels: 2, size: '0.41' }), 'Accurate duration/channel/size preview');
    },
    async complete() {
      key('fadeOut', 'End');
      check(waveformState().fadeOut === 1.25, 'Drag/keyboard bound prevents overlapping fades');
      key('fadeOut', 'Home'); key('fadeOut', 'ArrowRight', 5, true);
      document.querySelector('[data-player-play]').click();
      await until(() => soundboardService.getActivePlaybacks().some(entry => entry.userId === 'editor-preview'), 'Editor preview did not start');
      const preview = soundboardService.getActivePlaybacks().find(entry => entry.userId === 'editor-preview');
      await until(() => preview.audio.duration === 1.5, 'Actual preview duration must match cut');
      await until(() => !document.querySelector('[data-editor-form] fieldset').disabled, 'Preview controls must settle before saving');
      check(document.querySelector('[data-player-stop]').title === t('soundboard.player.stop'), 'Edited player has its own localized stop');
      document.querySelector('[data-player-stop]').click();
      check(preview.audio.paused && !preview.audio.getAttribute('src'), 'Preview stop releases media');
      input('#sb-edit-name', 'tone');
      document.querySelector('[data-editor-save]').click();
      await until(() => document.querySelector('[data-editor-status]').textContent === t('soundboard.fileError.exists'), 'Original overwrite must fail visibly');
      input('#sb-edit-name', `copy-${fixture.language}`);
      document.querySelector('[data-editor-save]').click();
      await until(() => !document.querySelector('.sb-editor-card') && name(`copy-${fixture.language}.wav`), 'Save must write copy and refresh library');
      check(exactStatus(t('soundboard.copySaved', { name: `copy-${fixture.language}.wav` })), 'Saved copy success text exact');
      check(!!name('tone.wav'), 'Original remains in library');
      const copy = library.soundboardFileValue(await window.api.readSoundboardEdit({ folder: fixture.folder, fileName: `copy-${fixture.language}.wav` }));
      check(copy.length === heardBytes.length && copy.every((value, index) => value === heardBytes[index]), 'Player audio is byte-identical to the saved final cut with fades');
      const edited = await library.decodeSoundboardEdit(copy, new AbortController().signal);
      check(edited.duration === 1.5 && edited.numberOfChannels === 2 && edited.sampleRate === 48000, 'Actual saved WAV decodes to exact format/duration');
      const left = edited.getChannelData(0), right = edited.getChannelData(1);
      const source = decoded.getChannelData(0);
      check(left[0] === 0 && left[left.length - 1] === 0, 'Saved real samples begin/end at silence');
      for (const frame of [120, 6000, 12000, 24120, 60000, 71880]) {
        const gain = Math.min(1, frame / 12000, (left.length - 1 - frame) / 24000);
        check(Math.abs(left[frame] - source[24000 + frame] * gain) < 3e-7, `Saved sample ${frame} matches exact cut/fade`);
        check(Math.abs(right[frame] + left[frame] / 2) < 3e-7, `Stereo ratio preserved at ${frame}`);
      }
      actions('edit', 'tone.wav').click();
      await until(() => document.querySelector('[data-editor-form] fieldset')?.disabled === false, 'Reopened editor not ready');
      document.querySelector('[data-player-play]').click();
      await until(() => soundboardService.getActivePlaybacks().some(entry => entry.userId === 'editor-preview'), 'Preview before close missing');
      const closingPreview = soundboardService.getActivePlaybacks().find(entry => entry.userId === 'editor-preview');
      document.querySelector('[data-editor-close]').click();
      check(closingPreview.audio.paused && !closingPreview.audio.getAttribute('src'), 'Closing editor releases its preview immediately');
      check(!soundboardService.getActivePlaybacks(true).some(entry => entry.userId === 'editor-preview'), 'Closing editor removes managed preview');
      const nativePlay = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = () => Promise.reject(new Error('Controlled playback rejection'));
      try {
        check(await soundboardService.previewEditedSound(copy, 'failed preview') === false, 'Real play rejection is not success-shaped');
        check(!soundboardService.getActivePlaybacks(true).some(entry => entry.userId === 'editor-preview'), 'Play failure disposes managed preview');
      } finally { HTMLMediaElement.prototype.play = nativePlay; }
      // Confirm closing during decoding and pending dialogs cannot mutate a stale modal.
      const listenerCount = baselineListeners();
      for (let index = 0; index < 3; index++) {
        actions('edit', 'tone.wav').click(); modal.close(); await wait(50); await modal.open();
      }
      check(baselineListeners() === listenerCount, 'Repeated editor/modal teardown leaves exact listener baseline');
      actions('delete', 'tone.wav').click(); modal.close();
      check(!document.querySelector('.dialog-card'), 'Closing parent aborts delete confirmation');
      await modal.open(); check(!!name('tone.wav'), 'Aborted confirmation preserves original');
      check(settingsStore.soundboardVolume === 37 && settingsStore.soundboardLoudnessLimit === 4 && !settingsStore.soundboardLimiterEnabled, 'All file operations preserve volume/limiter preferences');
      check(JSON.parse(localStorage.getItem('monky_settings')).soundboardLoudnessLimit === 4, 'Ceiling remains persisted');
      return checks;
    },
    async playerChecks() {
      const button = name => document.querySelector(`[data-player-${name}]`);
      const audio = () => soundboardService.getActivePlaybacks(true).find(entry => entry.userId === 'editor-preview')?.audio;
      const seek = position => input('[data-player-seek]', position);
      const progress = () => parseFloat(getComputedStyle(button('seek')).getPropertyValue('--slider-progress'));
      check(progress() === 0, 'Stopped player starts with zero filled track, never the inherited 50 percent');
      check(!document.querySelector('[data-editor-preview]') && !document.querySelector('[data-editor-players]'), 'Old preview button and duplicate player removed');
      check(document.querySelectorAll('.sb-editor-buttons button').length === 2, 'Footer contains only overwrite and save-new actions');
      check(Number(button('seek').max) === 1.5, 'Transport duration is the edited segment, not the original');
      input('#sb-edit-name', '');
      button('play').click();
      await until(() => audio() && !audio().paused && !button('play').disabled, 'Edited player failed with an empty copy name');
      const first = audio();
      heardBytes = new Uint8Array(await (await fetch(first.src)).arrayBuffer());
      input('#sb-edit-name', `copy-${fixture.language}`);
      check(audio() === first && !first.paused, 'Renaming the new copy does not reset playback');
      button('play').click();
      await until(() => first.paused, 'Pause did not pause real media');
      const pausedTime = first.currentTime;
      await wait(120);
      check(first.currentTime === pausedTime, 'Paused playback does not advance');
      check(Math.abs(progress() - pausedTime / 1.5 * 100) < 0.001, 'Filled track follows actual playback position');
      check(button('play').getAttribute('aria-label') === t('soundboard.player.play'), 'Paused play action localized');
      seek(0.9);
      await until(() => Math.abs(first.currentTime - 0.9) < 0.001 && !first.seeking, 'Paused seek did not update real media');
      check(first.paused, 'Seeking paused audio must not autoplay');
      check(Math.abs(progress() - 60) < 0.001 && getComputedStyle(button('seek')).backgroundImage.includes('60%'), 'Paused seek fills the actual CSS gradient to 60 percent');
      const track = document.querySelector('.sb-waveform-track');
      check(Math.abs(parseFloat(document.querySelector('.sb-waveform-playhead').style.left) -
        (18 + 1.4 / 3 * (track.clientWidth - 36))) < 0.1, 'Playhead maps edited position to source crop offset');
      button('restart').click();
      check(first.currentTime === 0 && first.paused, 'Back to start preserves paused state');
      check(progress() === 0, 'Back to start clears track fill');
      seek(0.65); button('play').click();
      await until(() => !first.paused && first.currentTime > 0.7, 'Play did not resume from sought position');
      check(audio() === first, 'Pause/resume reuses the same processed media');
      button('restart').click();
      check(first.currentTime < 0.05 && !first.paused, 'Back to start during playback keeps playing');
      button('stop').click();
      check(!audio() && !first.getAttribute('src') && Number(button('seek').value) === 0, 'Stop frees source and resets transport');
      check(progress() === 0, 'Stop clears track fill');
      seek(0.75); button('play').click();
      await until(() => audio() && !audio().paused && !button('play').disabled, 'Seek-before-play did not start');
      check(audio().currentTime >= 0.75 && audio().currentTime < 1, 'Fresh playback starts at requested position, never briefly at zero');
      button('play').click();
      key('fadeIn', 'ArrowRight');
      check(!audio() && Number(button('seek').value) === 0, 'Changing fades invalidates paused final-result audio');
      check(progress() === 0, 'Changing edits clears track fill');
      key('fadeIn', 'ArrowLeft');
      // Exercise cancellation while the actual shared output graph is still preparing.
      const output = soundboardService.audioOutput, connect = output.connect;
      let release, entered = false;
      output.connect = async function(...args) {
        entered = true;
        await new Promise(resolve => { release = resolve; });
        return connect.apply(this, args);
      };
      try {
        button('play').click();
        await until(() => entered, 'Deferred player preparation did not begin');
        key('fadeIn', 'ArrowRight'); release();
        await wait(100);
        check(!audio() && !button('play').disabled && Number(button('seek').value) === 0, 'Stale pending playback cannot start after changing edits');
      } finally { output.connect = connect; }
      key('fadeIn', 'ArrowLeft');
      seek(1.35); button('play').click();
      await until(() => Number(button('seek').value) === 1.5 && !audio(), 'Natural end must retain final position and enable replay');
      check(progress() === 100, 'Natural end fills track completely');
      button('play').click();
      await until(() => audio() && !button('play').disabled, 'Replay after natural end failed');
      check(audio().currentTime < 0.25, 'Replay starts at the beginning of the edited segment');
      button('stop').click();
      const nativePlay = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = () => Promise.reject(new Error('Controlled player rejection'));
      try {
        button('play').click();
        await until(() => document.querySelector('[data-editor-status]').textContent === t('soundboard.previewFailed'), 'Playback error must be localized and visible');
        check(!audio() && !button('play').disabled, 'Failed play leaves usable controls and no active source');
      } finally { HTMLMediaElement.prototype.play = nativePlay; }
      seek(0.65); button('play').click();
      await until(() => audio() && !button('play').disabled, 'Player did not recover after failure');
      button('play').click();
      check(button('restart').title === t('soundboard.player.restart') && button('seek').getAttribute('aria-label') === t('soundboard.player.seek'), 'Transport labels follow selected language');
    },
    async largePlayer() {
      await soundboardService.loadSounds();
      actions('edit', 'long.wav').click();
      await until(() => document.querySelector('[data-editor-form] fieldset')?.disabled === false, 'Source above 3 MiB/120 seconds must open');
      key('start', 'ArrowRight', 5, true); key('end', 'ArrowLeft', 5, true);
      key('fadeIn', 'ArrowRight', 2, true); key('fadeOut', 'ArrowRight', 3, true);
      check(Number(document.querySelector('[data-player-seek]').max) === 130, 'Large selection has uncapped player duration');
      input('[data-player-seek]', 128);
      document.querySelector('[data-player-play]').click();
      await until(() => soundboardService.getActivePlaybacks().some(entry => entry.userId === 'editor-preview') &&
        !document.querySelector('[data-player-play]').disabled, 'Large edited audio must play locally');
      const audio = soundboardService.getActivePlaybacks().find(entry => entry.userId === 'editor-preview').audio;
      check(audio.duration === 130 && audio.currentTime >= 128, 'Real large-media transport honors edited duration and seek');
      document.querySelector('[data-player-play]').click();
      input('#sb-edit-name', `long-copy-${fixture.language}`);
      document.querySelector('[data-editor-save]').click();
      await until(() => !document.querySelector('.sb-editor-card') && name(`long-copy-${fixture.language}.wav`), 'Large output must save via production IPC');
      check(audio.paused && !audio.getAttribute('src'), 'Saving releases large paused media');
    },
    async prepareOverwrite() {
      const otherSound = name('other.wav');
      if (!favoritesStore.isSoundFavorite(otherSound.filePath)) favoritesStore.toggleSound(otherSound.filePath);
      settingsStore.soundboardShortcuts = { ...settingsStore.soundboardShortcuts, other: { accelerator: 'Ctrl+Shift+2', display: 'Ctrl + Shift + 2' } };
      settingsStore.save();
      actions('edit', 'other.wav').click();
      await until(() => document.querySelector('[data-editor-form] fieldset')?.disabled === false, 'Overwrite source not ready');
      key('end', 'ArrowLeft', 20, true);
      key('fadeIn', 'ArrowRight', 2, true); key('fadeOut', 'ArrowRight', 3, true);
      check(waveformState().end === 1, 'Overwrite selection exact');
      document.querySelector('[data-editor-overwrite]').click();
      await until(() => document.querySelector('.dialog-card'), 'Overwrite confirmation missing');
      check(document.querySelector('.dialog-message').textContent === t('soundboard.overwriteConfirm', { name: 'other.wav' }), 'Irreversible replacement warning localized');
      document.querySelector('[data-action="cancel"]').click();
      await until(() => !document.querySelector('[data-editor-form] fieldset').disabled, 'Cancelled overwrite must re-enable editor');
      check(!!document.querySelector('.sb-editor-card'), 'Cancelled overwrite leaves editor open');
      document.querySelector('[data-editor-overwrite]').click();
      await until(() => document.querySelector('.dialog-card'), 'Second overwrite confirmation missing');
    },
    async finishOverwrite() {
      await until(() => !document.querySelector('.sb-editor-card') && exactStatus(t('soundboard.originalSaved', { name: 'other.wav' })), 'Confirmed overwrite did not finish');
      check(favoritesStore.isSoundFavorite(name('other.wav').filePath), 'Overwrite preserves favorite path');
      check(settingsStore.soundboardShortcuts.other?.accelerator === 'Ctrl+Shift+2', 'Overwrite preserves shortcut identity');
      const bytes = library.soundboardFileValue(await window.api.readSoundboardEdit({ folder: fixture.folder, fileName: 'other.wav' }));
      const result = await library.decodeSoundboardEdit(bytes, new AbortController().signal);
      check(result.duration === 1, 'Actual overwritten file decodes with new duration');
      actions('edit', 'authored.ogg').click();
      await until(() => document.querySelector('[data-editor-form] fieldset')?.disabled === false, 'Compressed editor not ready');
      check(document.querySelector('[data-editor-overwrite]').disabled, 'Missing encoder blocks overwrite, not a mislabeled WAV');
      check(!document.querySelector('[data-overwrite-unavailable]').hidden, 'Missing encoder has an explicit prerequisite notice');
      check(!document.querySelector('[data-editor-save]').disabled, 'New WAV copy remains available without the encoder');
      document.querySelector('[data-editor-close]').click();
    },
    async openFinal() {
      await modal.open();
      await soundboardService.playSound(name(`copy-${fixture.language}.wav`).filePath);
      await until(() => root().querySelector('.sb-notice-bar') && soundboardService.getActivePlaybacks().length === 1, 'Final screenshot playback missing');
      soundboardService.getActivePlaybacks()[0].audio.loop = true;
      await wait(100);
    },
    dispose() { modal.close(); sidebar.unmount(); soundboardService.stopSound(); },
  };
  return checks;
}
