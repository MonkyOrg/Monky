'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const runtimeDirectory = process.argv.find(value => value.startsWith('--runtime='))?.slice('--runtime='.length)
  ?? path.join(root, 'bin', 'win32-x64');
assert.ok(path.isAbsolute(runtimeDirectory));
const host = path.join(runtimeDirectory, 'monky-screen-thumbnail.exe');

function invoke(args, expected) {
  return new Promise((resolve, reject) => {
    execFile(host, args, { windowsHide: true, encoding: 'buffer', timeout: 5000, maxBuffer: 1024 * 1024 + 1024 },
      (error, stdout, stderr) => {
        try {
          if (expected) {
            assert.equal(error?.code, 1, `Expected owned helper failure: ${stderr}`);
            assert.equal(error.killed, false);
            assert.equal(stdout.length, 0, 'Failure must not publish partial pixels.');
            assert.match(stderr.toString('ascii'), new RegExp(`^${expected}\\r?\\n$`));
            assert.ok(stderr.length < 128);
          } else {
            if (error) throw new Error(`Native thumbnail failed: ${stderr}`, { cause: error });
            assert.equal(stderr.length, 0);
            assert.ok(stdout.length > 8 && stdout.length <= 1024 * 1024);
            assert.equal(stdout.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
          }
          resolve(stdout);
        } catch (failure) { reject(failure); }
      });
  });
}
async function invalidInputs() {
  const base = ['--window', '1', '1', '1', '320', '180'];
  const invalid = [[], ['--unknown'], [...base, 'extra'],
    ...['0', '-1', '+1', '01', '1e3', '9007199254740992'].map(value => [base[0], value, ...base.slice(2)]),
    ...['0', '4294967296'].map(value => [...base.slice(0, 2), value, ...base.slice(3)]),
    ...['0', '18446744073709551616'].map(value => [...base.slice(0, 3), value, ...base.slice(4)]),
    [...base.slice(0, 4), '641', '180'], [...base.slice(0, 4), '320', '361'],
    ['--monitor', 'screen:0', String.raw`\\.\DISPLAY2`, '0', '0', '1920', '1080', '320', '180'],
    ['--monitor', String.raw`\\?\DISPLAY#SYNTHETIC`, String.raw`\\.\DISPLAY2`, '-0', '0', '1920', '1080', '320', '180'],
  ];
  for (const args of invalid) await invoke(args, 'ERR_DESKTOP_PREVIEW_ARGUMENT');
  await invoke(base, 'ERR_DESKTOP_PREVIEW_IDENTITY');
  return invalid.length + 1;
}
async function synthetic() {
  const { app, BrowserWindow, screen, nativeImage } = require('electron');
  const profile = process.argv.find(value => value.startsWith('--profile='))?.slice('--profile='.length);
  assert.ok(profile && path.isAbsolute(profile));
  app.setPath('userData', profile);
  app.on('window-all-closed', () => {});
  await app.whenReady();
  const { installTestDisplay } = require('../../../test/fixtures/testDisplay.cjs');
  const placement = installTestDisplay({ app, BrowserWindow, screen });
  assert.ok(placement, 'An explicitly selected left non-primary display is mandatory.');
  let window;
  try {
    window = placement.createWindow({ width: 640, height: 360, frame: false, show: false,
      title: 'Monky owned thumbnail fixture', backgroundColor: '#e02040',
      webPreferences: { contextIsolation: true, nodeIntegration: false } });
    await window.loadURL('data:text/html,' + encodeURIComponent('<!doctype html><html><body style="margin:0;width:100vw;height:100vh;background:linear-gradient(to right,#e02040 50%,#2050d0 50%)"></body></html>'));
    window.showInactive();
    await new Promise(resolve => setTimeout(resolve, 350));
    placement.place(window);
    const hwnd = window.getNativeWindowHandle().readBigUInt64LE().toString();
    const { getWindowState } = require('../../screen-audio');
    const state = getWindowState(Number(hwnd));
    assert.equal(state.processId, process.pid);
    assert.ok(state.processCreationTime100ns);
    const args = ['--window', hwnd, String(process.pid), state.processCreationTime100ns, '320', '180'];
    const png = await invoke(args);
    const image = nativeImage.createFromBuffer(png), size = image.getSize();
    assert.ok(size.width > 0 && size.width <= 320 && size.height > 0 && size.height <= 180);
    const pixels = image.toBitmap();
    for (const [fraction, expected] of [[0.25, [0x40, 0x20, 0xe0]], [0.75, [0xd0, 0x50, 0x20]]]) {
      const offset = (Math.floor(size.height / 2) * size.width + Math.floor(size.width * fraction)) * 4;
      for (let channel = 0; channel < 3; ++channel)
        assert.ok(Math.abs(pixels[offset + channel] - expected[channel]) <= 12,
          `Owned colour pattern mismatch at ${fraction}, channel ${channel}: ${pixels[offset + channel]}`);
    }
    const { NativeThumbnailCapturer, loadThumbnailRuntime } = require('../index.cjs');
    const capturer = new NativeThumbnailCapturer(loadThumbnailRuntime(runtimeDirectory));
    try {
      for (let cycle = 0; cycle < 6; ++cycle) {
        const received = await capturer.capture({
          kind: 'window', hwnd: Number(hwnd), expectedProcessId: process.pid,
          expectedProcessCreationTime100ns: state.processCreationTime100ns,
        });
        const decoded = nativeImage.createFromBuffer(received);
        assert.deepEqual(decoded.getSize(), size);
        const actual = decoded.toBitmap();
        for (const fraction of [0.25, 0.75]) {
          const offset = (Math.floor(size.height / 2) * size.width + Math.floor(size.width * fraction)) * 4;
          assert.deepEqual(actual.subarray(offset, offset + 3), pixels.subarray(offset, offset + 3));
        }
      }
    } finally { await capturer.close(); }
    assert.equal(capturer.active.size, 0);
    assert.equal(capturer.queue.length, 0);
    await invoke([...args.slice(0, 3), (BigInt(state.processCreationTime100ns) + 1n).toString(), ...args.slice(4)],
      'ERR_DESKTOP_PREVIEW_IDENTITY');
    window.setContentProtection(true);
    await invoke(args, 'ERR_DESKTOP_PREVIEW_PROTECTED');
    window.setContentProtection(false);
    window.minimize();
    await new Promise(resolve => setTimeout(resolve, 100));
    await invoke(args, 'ERR_DESKTOP_PREVIEW_UNAVAILABLE');
    window.destroy(); window = undefined;
    await invoke(args, 'ERR_DESKTOP_PREVIEW_IDENTITY');
    console.log(JSON.stringify({ nativeThumbnail: true, ownWindowOnly: true, personalSourcesCaptured: false,
      persistedImages: false, pngBytes: png.length, width: size.width, height: size.height, scenarios: 5,
      helperExitObserved: true, forcedTermination: false, bridgeCycles: 6, bridgeActive: capturer.active.size }));
  } finally {
    if (window && !window.isDestroyed()) window.destroy();
    placement.dispose();
    app.quit();
  }
}
async function main() {
  assert.equal(process.platform, 'win32');
  assert.ok(fs.existsSync(host), 'Run buildThumbnails.cjs first.');
  if (process.argv.includes('--synthetic-child')) return synthetic();
  const cases = await invalidInputs();
  console.log(JSON.stringify({ nativeThumbnail: true, deviceFree: true, cases, stdoutEmptyOnFailure: true }));
  if (process.argv.includes('--synthetic')) {
    const profile = path.join(root, 'build', `thumbnail-smoke-${randomUUID()}`);
    fs.mkdirSync(profile);
    try {
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const result = spawnSync(require('electron'), [__filename, '--synthetic-child', `--profile=${profile}`,
        `--runtime=${runtimeDirectory}`],
        { windowsHide: true, stdio: 'inherit', timeout: 30000, env });
      if (result.error) throw result.error;
      assert.equal(result.status, 0, 'Owned synthetic thumbnail smoke failed.');
    } finally { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
  }
}
main().catch(error => {
  console.error(error);
  if (process.versions.electron) require('electron').app.exit(1);
  else process.exitCode = 1;
});
