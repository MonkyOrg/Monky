const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const clientRoot = path.resolve(__dirname, '..');

if (process.platform !== 'win32') {
  console.log('Shortcut worker smoke skipped: Windows-specific observer isolation.');
} else if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const profile = path.join(clientRoot, 'dist-test', `shortcut-worker-profile-${process.pid}`);
  const env = { ...process.env, MONKY_SHORTCUT_WORKER_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename], { cwd: clientRoot, env, stdio: 'inherit' });
  const cleanup = () => fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  child.once('error', (error) => { console.error(error); cleanup(); process.exitCode = 1; });
  child.once('exit', (code) => { cleanup(); process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  const { GlobalInputHookProcess } = require('../dist-electron/main/globalInputHookProcess');
  const { UiohookKey } = require('uiohook-napi');
  app.setPath('userData', process.env.MONKY_SHORTCUT_WORKER_PROFILE);
  let window, hook;
  const timeout = setTimeout(() => { console.error('Shortcut worker smoke timed out'); app.exit(1); }, 30000);
  const finish = (code) => {
    clearTimeout(timeout);
    hook?.destroy();
    if (window && !window.isDestroyed()) window.destroy();
    app.exit(code);
  };
  app.whenReady().then(async () => {
    const addon = path.join(path.dirname(require.resolve('@monky/screen-audio')), 'build', 'Release', 'screen_audio.node');
    const binding = require(addon);
    assert.equal(typeof binding.getKeyboardLayout, 'function');
    const hasKeyboardLayout = binding.getKeyboardLayout('', 'q') !== null;
    window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
    hook = new GlobalInputHookProcess();
    hook.init(window);
    const original = hook.child;
    assert.ok(original);
    hook.init(window);
    assert.equal(hook.child, original, 'initialization must not spawn a second observer');

    assert.equal(await hook.setActionHotkeys([{ action: 'old', accelerator: 'F24' }]), true);
    const actions = [
      { action: 'current', accelerator: 'F23' },
      { action: 'unsupported', accelerator: 'Unknown+Q' },
    ];
    assert.equal(await hook.setActionHotkeys(actions), false);
    assert.deepEqual(hook.retained.actions, actions, 'retain actual partial registration, not obsolete successful bindings');
    assert.equal(await hook.setActionHotkeys([null]), false);
    assert.deepEqual(hook.retained.actions, actions, 'invalid renderer payload cannot replace accepted configuration');
    const sounds = [{ soundName: 'fixture', accelerator: 'F22' }];
    assert.equal(await hook.setSoundboardHotkeys(sounds), true);
    const ptt = { enabled: true, key: { code: 'F24', display: 'F24', keyType: 'keyboard', keyCode: UiohookKey.F24 } };
    assert.equal(await hook.setPttConfig(ptt), true);
    assert.equal(await hook.setShortcutCapture(true), hasKeyboardLayout,
      'capture must fail closed when the desktop has no keyboard layout');
    assert.equal(await hook.setShortcutCapture(false), true);
    const state = structuredClone(hook.retained);

    const exited = new Promise((resolve) => original.once('exit', resolve));
    original.kill();
    await exited;
    assert.equal(await hook.setShortcutCapture(false), true, 'requests recover after an observer process exits');
    assert.notEqual(hook.child, original);
    assert.deepEqual(hook.retained, state, 'restart replays actions, sounds and PTT without resurrecting invalid old bindings');

    const child = hook.child;
    const stopped = new Promise((resolve) => child.once('exit', resolve));
    const pending = hook.setActionHotkeys([]);
    hook.destroy();
    assert.equal(await pending, false, 'destroy settles requests that were waiting for a worker');
    await stopped;
    assert.equal(hook.child, null);
    assert.equal(hook.restartTimer, null);
    assert.equal(await hook.setShortcutCapture(true), false, 'destroy cannot implicitly restart an observer');
    hook.init(window);
    assert.equal(await hook.setActionHotkeys([]), true, 'a new window lifecycle can initialize again');
    const finalChild = hook.child;
    const finalExit = new Promise((resolve) => finalChild.once('exit', resolve));
    hook.destroy();
    await finalExit;
    console.log('Shortcut worker smoke passed: startup handshake, validation, capture, crash recovery and teardown.');
    finish(0);
  }).catch((error) => { console.error(error); finish(1); });
}
