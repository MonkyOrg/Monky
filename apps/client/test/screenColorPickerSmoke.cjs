const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const clientRoot = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const profile = path.join(clientRoot, 'dist-test', `screen-color-profile-${process.pid}`);
  fs.mkdirSync(profile, { recursive: true });
  const env = { ...process.env, MONKY_SCREEN_COLOR_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename], { cwd: clientRoot, env, stdio: 'inherit' });
  const cleanup = () => fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  child.once('error', error => { console.error(error); cleanup(); process.exitCode = 1; });
  child.once('exit', code => { cleanup(); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  const profile = process.env.MONKY_SCREEN_COLOR_PROFILE;
  if (!profile) throw new Error('The isolated fixture must be launched with Node');
  app.setPath('userData', profile);
  app.setPath('sessionData', profile);
  app.setPath('crashDumps', path.join(profile, 'crashes'));
  app.on('window-all-closed', () => {});
  let window;
  const timeout = setTimeout(() => { console.error('Screen color smoke timed out'); finish(1); }, 60000);
  const finish = code => {
    clearTimeout(timeout);
    if (window && !window.isDestroyed()) window.destroy();
    app.exit(code);
  };
  app.whenReady().then(async () => {
    const { build } = await import('vite');
    const output = path.join(profile, 'fixture-build');
    await build({
      configFile: false, root: clientRoot, base: './', logLevel: 'error',
      cacheDir: path.join(profile, 'vite-cache'),
      build: {
        outDir: output, emptyOutDir: true, target: 'esnext',
        rollupOptions: { input: path.join(clientRoot, 'test', 'fixtures', 'screenColorPicker.html') },
      },
    });
    window = new BrowserWindow({
      show: false, focusable: false, skipTaskbar: true,
      webPreferences: {
        contextIsolation: true, nodeIntegration: false, sandbox: true,
        backgroundThrottling: false, partition: `screen-color-fixture-${process.pid}`,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const requests = [];
    let permissionRequests = 0;
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
      permissionRequests++;
      callback(false);
    });
    window.webContents.session.setPermissionCheckHandler(() => false);
    window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      const local = new URL(details.url).protocol === 'file:';
      if (!local) requests.push(details.url);
      callback({ cancel: !local });
    });
    await window.loadFile(path.join(output, 'test', 'fixtures', 'screenColorPicker.html'));
    assert.equal(window.isVisible(), false);
    assert.equal(window.isFocused(), false);
    assert.equal(window.webContents.isFocused(), false);

    // These native calls cannot reach capture: Blink checks user activation and
    // an already-aborted signal before binding its browser-side chooser.
    const noGesture = await window.webContents.executeJavaScript(`(async () => {
      if (navigator.userActivation.isActive) throw new Error('Unexpected user activation');
      try { await new EyeDropper().open(); return 'unexpected-success'; }
      catch (error) { return error.name; }
    })()`);
    assert.equal(noGesture, 'NotAllowedError');
    const native = await window.webContents.executeJavaScript(`(async () => {
      const probe = {
        secure: isSecureContext, constructor: typeof EyeDropper,
        activation: navigator.userActivation.isActive, focused: document.hasFocus(),
        available: window.screenColorPickerFixture.isScreenColorPickerAvailable(),
      };
      const controller = new AbortController();
      controller.abort();
      try { await new EyeDropper().open({ signal: controller.signal }); probe.result = 'unexpected-success'; }
      catch (error) { probe.result = error.name; }
      return probe;
    })()`, true);
    assert.deepEqual(native, {
      secure: true, constructor: 'function', activation: true, focused: false,
      available: true, result: 'AbortError',
    });
    console.log('Screen color native preflight: ' + JSON.stringify({
      electron: process.versions.electron, chromium: process.versions.chrome,
      noGesture, ...native, desktopCapture: 'not invoked',
    }));

    const checks = await window.webContents.executeJavaScript(`(${syntheticPickerChecks.toString()})()`);
    let ownerAborted = false;
    const onConsole = (_event, _level, message) => {
      if (message === 'screen-color-fixture-owner-aborted') ownerAborted = true;
    };
    window.webContents.on('console-message', onConsole);
    await window.webContents.executeJavaScript(`(() => {
      Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
      window.EyeDropper = class {
        open({ signal }) {
          signal.addEventListener('abort', () => console.log('screen-color-fixture-owner-aborted'), { once: true });
          return new Promise(() => {});
        }
      };
      window.screenColorPickerFixture.pickScreenColor(new AbortController().signal);
    })()`);
    await window.loadFile(path.join(output, 'test', 'fixtures', 'screenColorPicker.html'));
    window.webContents.removeListener('console-message', onConsole);
    assert.equal(ownerAborted, true, 'Real document teardown must abort its pending synthetic picker');
    assert.equal(permissionRequests, 0);
    assert.deepEqual(requests, []);
    const destroyed = new Promise(resolve => window.once('closed', resolve));
    window.destroy();
    await destroyed;
    assert.equal(BrowserWindow.getAllWindows().length, 0);
    console.log(`Screen color smoke: ${checks} synthetic checks passed; native preconditions and pending document teardown verified; hidden owner destroyed; no capture, permissions or external requests`);
    finish(0);
  }).catch(error => { console.error(error); finish(1); });
}

async function syntheticPickerChecks() {
  const { pickScreenColor, isScreenColorPickerAvailable, ScreenColorPickerError } = window.screenColorPickerFixture;
  const originalEyeDropper = Object.getOwnPropertyDescriptor(window, 'EyeDropper');
  const originalFocus = Object.getOwnPropertyDescriptor(document, 'hasFocus');
  const requests = [];
  let checks = 0;
  const check = (condition, message) => { if (!condition) throw new Error(message); checks++; };
  const expectError = async (action, code) => {
    let error;
    try { await action(); } catch (reason) { error = reason; }
    check(error instanceof ScreenColorPickerError && error.code === code, `Expected ${code} failure`);
  };
  class SyntheticEyeDropper {
    open({ signal }) {
      return new Promise((resolve, reject) => requests.push({ signal, resolve, reject }));
    }
  }
  Object.defineProperty(window, 'EyeDropper', { configurable: true, value: SyntheticEyeDropper });
  Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
  try {
    check(isScreenColorPickerAvailable(), 'Synthetic capability');
    check(requests.length === 0, 'Capability is side-effect free');
    const canvas = document.createElement('canvas');
    canvas.width = 4;
    canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const pixels = new Uint8ClampedArray([0, 255, 0, 255, 1, 2, 3, 255, 162, 179, 196, 255, 255, 255, 255, 255]);
    context.putImageData(new ImageData(pixels, 4, 1), 0, 0);
    for (let x = 0; x < 4; x++) {
      const controller = new AbortController();
      const result = pickScreenColor(controller.signal);
      const [r, g, b] = context.getImageData(x, 0, 1, 1).data;
      const color = '#' + [r, g, b].map(value => value.toString(16).padStart(2, '0')).join('');
      requests.at(-1).resolve({ sRGBHex: color.toUpperCase() });
      check(await result === color, `Exact synthetic pixel ${x}`);
    }
    const cancelled = new AbortController();
    const cancelledResult = pickScreenColor(cancelled.signal);
    const old = requests.at(-1);
    cancelled.abort();
    check(old.signal.aborted, 'Component closure aborts native signal');
    check(await cancelledResult === null, 'Component closure is deliberate cancellation');
    const current = new AbortController();
    const currentResult = pickScreenColor(current.signal);
    const active = requests.at(-1);
    old.resolve({ sRGBHex: '#ff0000' });
    await Promise.resolve();
    await expectError(() => pickScreenColor(new AbortController().signal), 'busy');
    active.resolve({ sRGBHex: '#010203' });
    check(await currentResult === '#010203', 'Stale reply cannot replace current pick');
    const page = pickScreenColor(new AbortController().signal);
    const owner = requests.at(-1);
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    check(owner.signal.aborted, 'Owner closure aborts native signal');
    check(await page === null, 'Owner closure cancels');
    owner.reject(new Error('Late owner failure'));
    await Promise.resolve();
    const escape = pickScreenColor(new AbortController().signal);
    requests.at(-1).reject(new DOMException('User cancelled', 'AbortError'));
    check(await escape === null, 'Native Escape cancels');
    for (const [name, code] of [
      ['NotAllowedError', 'permission'], ['NotSupportedError', 'unsupported'],
      ['OperationError', 'capture'], ['InvalidStateError', 'busy'],
    ]) {
      const result = pickScreenColor(new AbortController().signal);
      requests.at(-1).reject(new DOMException('Synthetic failure', name));
      await expectError(() => result, code);
    }
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false });
    await expectError(() => pickScreenColor(new AbortController().signal), 'permission');
    Object.defineProperty(window, 'EyeDropper', { configurable: true, value: undefined });
    check(!isScreenColorPickerAvailable(), 'Missing capability');
    await expectError(() => pickScreenColor(new AbortController().signal), 'unsupported');
    const preAborted = new AbortController();
    preAborted.abort();
    check(await pickScreenColor(preAborted.signal) === null, 'Already-aborted call does not need capability');
  } finally {
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    Object.defineProperty(window, 'EyeDropper', originalEyeDropper);
    if (originalFocus) Object.defineProperty(document, 'hasFocus', originalFocus);
    else delete document.hasFocus;
  }
  return checks;
}
