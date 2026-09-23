const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const clientRoot = path.resolve(__dirname, '..');
const output = path.join(clientRoot, 'dist-test');

if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const profile = path.join(output, `shortcuts-dom-profile-${process.pid}`);
  const env = { ...process.env, MONKY_SHORTCUTS_DOM_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename], { cwd: clientRoot, env, stdio: 'inherit' });
  const cleanup = () => fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  child.once('error', (error) => { console.error(error); cleanup(); process.exitCode = 1; });
  child.once('exit', (code) => { cleanup(); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const { EventEmitter } = require('node:events');
  const { GlobalInputHook } = require('../dist-test/src/main/globalInputHook');
  const { WindowsKeyboardLayout } = require('../dist-test/src/main/windowsKeyboardLayout');
  const { SHORTCUT_IPC } = require('@monky/shared');
  const { UiohookKey: K, EventType } = require('uiohook-napi');
  app.setPath('userData', process.env.MONKY_SHORTCUTS_DOM_PROFILE);
  let window, vite, hook, timeout;
  const finish = async (code) => {
    clearTimeout(timeout);
    hook?.destroy();
    if (window && !window.isDestroyed()) window.destroy();
    await vite?.close();
    app.exit(code);
  };
  app.whenReady().then(async () => {
    if (process.platform === 'win32') {
      const addon = path.join(path.dirname(require.resolve('@monky/screen-audio')), 'build', 'Release', 'screen_audio.node');
      const binding = require(addon);
      assert.equal(typeof binding.getKeyboardLayout, 'function', 'packaged native bridge must expose keyboard layout');
      if (!binding.getKeyboardLayout('', 'q')) {
        console.log('No interactive Windows keyboard layout; DOM capture uses its deterministic layout fixture.');
      }
    }
    timeout = setTimeout(() => { console.error('Shortcut DOM smoke timed out'); void finish(1); }, 30000);
    const { createServer } = await import('vite');
    vite = await createServer({
      configFile: path.join(clientRoot, 'vite.config.ts'),
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, strictPort: true, open: false },
      plugins: [{ name: 'shortcut-fixture', configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url !== '/__shortcuts__') return next();
          res.setHeader('Content-Type', 'text/html');
          res.end('<!doctype html><body><div id="app"></div></body>');
        });
      } }],
    });
    await vite.listen();
    const address = vite.httpServer.address();
    assert.ok(address && typeof address !== 'string');
    window = new BrowserWindow({ show: false, webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: false,
      backgroundThrottling: false, offscreen: true,
      preload: path.join(output, 'src/preload/preload.js'),
    } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    // Inject native events and their layout: hosted desktops need not have an input locale.
    // The renderer, settings tab, preload, IPC transport and matcher are real.
    class Native extends EventEmitter { start() {} stop() {} }
    const native = new Native();
    const layout = process.platform === 'win32' ? new WindowsKeyboardLayout(() => ({
      id: 'fixture-us', scanCodeToVirtualKey: { [K.Q]: 0x51 }, characterToVirtualKey: { q: 0x51 },
    })) : null;
    hook = new GlobalInputHook(native, layout);
    hook.init(window);
    const registrations = [];
    for (const [channel, method] of [
      [SHORTCUT_IPC.registerActions, 'setActionHotkeys'],
      [SHORTCUT_IPC.registerSoundboard, 'setSoundboardHotkeys'],
      [SHORTCUT_IPC.setCapture, 'setShortcutCapture'],
      [SHORTCUT_IPC.setPttConfig, 'setPttConfig'],
    ]) ipcMain.handle(channel, (_, data) => {
      const result = hook[method](data);
      registrations.push({ channel, data, result });
      return result;
    });
    await window.loadURL(`http://127.0.0.1:${address.port}/__shortcuts__`);
    window.focus();
    window.webContents.focus();
    await window.webContents.executeJavaScript(`(async () => {
      const [{ KeybindsTab }, { keybindService }, { appEvents }, { settingsStore }, controls, { voiceStore }, { clientLog }, { soundEffects }] = await Promise.all([
        import('/views/settings/tabs/KeybindsTab.ts'), import('/core/KeybindService.ts'),
        import('/core/EventBus.ts'), import('/stores/settingsStore.ts'),
        import('/core/voiceControls.ts'), import('/stores/voiceStore.ts'),
        import('/core/ClientLogService.ts'), import('/core/SoundEffects.ts')
      ]);
      clientLog.setEnabled(false);
      soundEffects.play = () => {};
      window.results = [];
      voiceStore.isMuted = voiceStore.isDeafened = false;
      voiceStore.currentVoiceChannelId = null;
      appEvents.on('keybind.toggle_mute', () => window.results.push('mute'));
      appEvents.on('keybind.toggle_mute', controls.toggleMicrophoneMute);
      window.api.onPttStateChanged(value => window.results.push(value));
      keybindService.init();
      const tab = new KeybindsTab();
      const container = document.querySelector('#app');
      container.innerHTML = tab.renderHtml();
      tab.attachEvents(container);
      container.querySelector('[data-action-id="toggle_mute"]').click();
      window.reloadShortcuts = () => {
        settingsStore.keybindShortcuts = {};
        settingsStore.load();
        keybindService.init();
      };
    })()`);
    const waitFor = async (predicate) => {
      for (let i = 0; i < 100; i++) {
        if (await predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error('Expected shortcut state was not reached');
    };
    await waitFor(() => registrations.some(row => row.channel === SHORTCUT_IPC.setCapture && row.data === true));
    // A completed IPC round trip is a barrier for the recorder's preceding invoke response.
    assert.equal(await window.webContents.executeJavaScript('window.api.setShortcutCapture(true)'), true,
      'native capture must be ready before dispatching the recorded chord');
    await window.webContents.executeJavaScript(`(() => {
      for (const type of ['keydown', 'keyup']) window.dispatchEvent(new KeyboardEvent(type, {
        code: '', key: 'q', keyCode: 81, bubbles: true, cancelable: true
      }));
    })()`);
    await waitFor(() => registrations.some(row => row.channel === SHORTCUT_IPC.setCapture && row.data === false));
    const saved = await window.webContents.executeJavaScript('JSON.parse(localStorage.getItem("monky_settings")).keybindShortcuts');
    assert.deepEqual(saved.toggle_mute, { accelerator: 'Q', display: 'Q' });
    await window.webContents.executeJavaScript('window.reloadShortcuts()');
    await waitFor(() => registrations.filter(row => row.channel === SHORTCUT_IPC.registerActions && row.data.length).length === 2);
    assert.ok(registrations.every(row => row.result), 'all registrations must be supported');
    await window.webContents.executeJavaScript(`window.api.setPttConfig({
      enabled: true, key: { keyType: 'keyboard', code: 'Q', display: 'Q', keyCode: 16 }
    })`);
    for (const down of [true, false]) native.emit(down ? 'keydown' : 'keyup', {
      type: down ? EventType.EVENT_KEY_PRESSED : EventType.EVENT_KEY_RELEASED,
      time: Date.now(), keycode: K.Q, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
    });
    await waitFor(async () => await window.webContents.executeJavaScript('window.results.length') === 3);
    assert.deepEqual(await window.webContents.executeJavaScript('window.results'), [true, 'mute', false]);
    assert.equal(await window.webContents.executeJavaScript('JSON.parse(localStorage.getItem("monky_settings")).isMuted'), true,
      'a captured shortcut must persist microphone pre-mute even outside a call');
    console.log('Shortcut DOM smoke passed: capture → persistence/reload → preload/IPC → main → action; PTT preserved.');
    await finish(0);
  }).catch(async error => { console.error(error); await finish(1); });
}
