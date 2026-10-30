'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const encoded = require('./nativeRtc/engine/node/encoded.cjs');
const defaultDirectory = () => path.resolve(__dirname, '..', 'bin', `${process.platform}-${process.arch}`);
const HASH_SLICE_BYTES = 1024 * 1024;
const PARALLEL_FILES = 2;

function pinnedFile(directory, record) {
  assert.ok(record && typeof record.path === 'string' && !path.isAbsolute(record.path));
  assert.ok(record.path.split(/[\\/]/u).every(part => part && part !== '.' && part !== '..'));
  assert.ok(Number.isSafeInteger(record.bytes) && record.bytes > 0 && /^[a-f0-9]{64}$/u.test(record.sha256));
  return { path: record.path, filename: path.join(directory, record.path), bytes: record.bytes, sha256: record.sha256 };
}

const assertPinnedSize = (file, stat) =>
  assert.ok(stat.isFile() && stat.size === file.bytes, `Native media file size or type changed: ${file.path}`);
const assertPinnedHash = (file, sha256) => assert.equal(sha256, file.sha256, `Native media file hash changed: ${file.path}`);

function checkFile(file) {
  assertPinnedSize(file, fs.lstatSync(file.filename));
  assertPinnedHash(file, crypto.createHash('sha256').update(fs.readFileSync(file.filename)).digest('hex'));
}

// Hashes in slices, reading the next one while this one is digested, so the caller's event loop keeps running.
async function checkFileAsync(file) {
  assertPinnedSize(file, await fs.promises.lstat(file.filename));
  const handle = await fs.promises.open(file.filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    assertPinnedSize(file, await handle.stat());
    const digest = crypto.createHash('sha256');
    const length = Math.min(HASH_SLICE_BYTES, file.bytes);
    const buffers = [Buffer.allocUnsafe(length), Buffer.allocUnsafe(length)];
    let size = 0, filling = 0;
    let reading = handle.read(buffers[filling], 0, length, 0);
    try {
      for (;;) {
        const { bytesRead } = await reading;
        if (!bytesRead) break;
        size += bytesRead;
        assert.ok(size <= file.bytes, `Native media file size or type changed: ${file.path}`);
        const slice = buffers[filling].subarray(0, bytesRead);
        filling ^= 1;
        reading = handle.read(buffers[filling], 0, length, size);
        digest.update(slice);
      }
    } finally {
      // The read issued ahead settles before the handle closes; it never replaces the first failure.
      await reading.catch(() => undefined);
    }
    assert.equal(size, file.bytes, `Native media file size or type changed: ${file.path}`);
    assertPinnedHash(file, digest.digest('hex'));
  } finally {
    await handle.close();
  }
}

function verifiedFile(directory, record) {
  const file = pinnedFile(directory, record);
  checkFile(file);
  return file.filename;
}

async function verifiedFileAsync(directory, record) {
  const file = pinnedFile(directory, record);
  await checkFileAsync(file);
  return file.filename;
}

/** Collects every pinned file once: manifests that name the same file must agree on it. */
function pinSet() {
  const files = new Map();
  const pin = (directory, record) => {
    const file = pinnedFile(directory, record);
    const key = process.platform === 'win32' ? file.filename.toLowerCase() : file.filename;
    const known = files.get(key);
    if (!known) files.set(key, file);
    else assert.ok(known.bytes === file.bytes && known.sha256 === file.sha256, `Native media manifests disagree: ${file.path}`);
    return file.filename;
  };
  return { pin, files: () => [...files.values()] };
}

// Hash verification only: neither this loader nor its support descriptor opens a
// graphics device. probeCaptureCapabilities() or a selected CaptureBridge.prepare()
// performs hardware probing; only the source-free probe also initializes an encoder.
// The manifests are validated and their files pinned here; the returned builder runs only after those files pass.
// On macOS the small capture host is still hashed inside loadMacCaptureRuntime.
function capturePlan(directory, pin) {
  if (process.platform === 'darwin') {
    const host = require('./mac/index.cjs').loadMacCaptureRuntime(directory);
    const rtc = JSON.parse(fs.readFileSync(path.join(directory, 'rtc-build.json'), 'utf8'));
    assert.equal(rtc.platform, 'darwin');
    assert.equal(rtc.arch, process.arch);
    const av1 = rtc.binaries.find(file => file.name === 'libmonky_av1.dylib');
    assert.ok(av1, 'Rebuild the native macOS runtime with its AV1 encoder.');
    pin(directory, { ...av1, path: av1.name });
    return () => Object.freeze({ host, obs: null, capture: Object.freeze({
      captureKinds: Object.freeze(['window', 'monitor']),
      encoders: Object.freeze(['apple_vt_h264', 'apple_vt_h264_software', 'monky_aom_av1']),
      requiresHardwareProbe: true, hardwareQualified: false,
    }) });
  }
  assert.equal(process.platform, 'win32', 'Native screen capture requires Windows.');
  assert.equal(process.arch, 'x64', 'Native screen capture requires x64.');
  const capture = JSON.parse(fs.readFileSync(path.join(directory, 'capture-build.json'), 'utf8'));
  assert.equal(capture.schemaVersion, 5, 'Rebuild native capture for hardware/software H264 and AV1.');
  assert.equal(capture.obsVersion, '32.1.1');
  assert.equal(capture.obsRevision, '7272af1375b38bc3cf4e0f98a5d999e8b76e9309');
  assert.equal(capture.host.path, 'monky-screen-capture.exe');
  assert.equal(capture.module.path, 'obs-plugins\\64bit\\win-capture.dll');
  assert.match(capture.crt?.version ?? '', /^14\.\d+\.\d+$/u);
  assert.ok(Array.isArray(capture.crt.files) && capture.crt.files.length >= 6 && capture.crt.files.length <= 20);
  for (const name of ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'])
    for (const relative of [name, path.join('obs', 'bin', '64bit', name)])
      assert.ok(capture.crt.files.some(file => file.path === relative), `Missing app-local CRT: ${relative}`);
  for (const file of capture.crt.files) pin(directory, file);
  const executable = pin(directory, capture.host);
  assert.equal(capture.av1Runtime?.path, 'monky_av1.dll');
  pin(directory, capture.av1Runtime);
  pin(directory, capture.module);
  const stockDirectory = path.join(directory, 'obs');
  assert.ok(Array.isArray(capture.runtime) && capture.runtime.length > 0 && capture.runtime.length <= 256);
  for (const file of capture.runtime) pin(stockDirectory, file);
  for (const probe of ['obs-amf-test.exe', 'obs-nvenc-test.exe']) {
    const file = capture.runtime.find(file => file.path === path.join('bin', '64bit', probe));
    assert.ok(file, `Missing pinned hardware probe: ${probe}`);
    pin(directory, { ...file, path: probe });
  }
  for (const relative of ['obs-plugins\\64bit\\obs-nvenc.dll',
    'data\\obs-plugins\\obs-nvenc\\locale\\en-US.ini',
    ...['32', '64'].flatMap(arch => ['graphics-hook' + arch + '.dll',
      'inject-helper' + arch + '.exe', 'get-graphics-offsets' + arch + '.exe']
      .map(name => path.join('data', 'obs-plugins', 'win-capture', name)))])
    assert.ok(capture.runtime.some(file => file.path === relative), `Missing pinned capture dependency: ${relative}`);
  assert.deepEqual(capture.configuration, {
    captureKinds: ['window', 'monitor', 'game'],
    encoders: ['h264_texture_amf', 'obs_nvenc_h264_tex', 'obs_x264', 'av1_texture_amf', 'obs_nvenc_av1_tex', 'monky_aom_av1'],
    encoderProbe: 'source-free-hardware-initialization',
    gameCaptureStartup: 'explicit-game-target-only', compatibilityUpdater: false,
    globalVulkanHook: false, hardwareQualified: false, scaleModes: ['stretch', 'fit'],
    captureDataStorage: 'pinned-profile-cache',
    wgcCadence: 'requested-half-frame-interval-when-supported',
  });
  return () => Object.freeze({
    host: Object.freeze({ kind: 'verified-native-screen-capture-host', executable, sha256: capture.host.sha256 }),
    obs: Object.freeze({
      kind: 'verified-stock-obs-runtime', version: capture.obsVersion, stockDirectory,
      binaryDirectory: path.join(stockDirectory, 'bin', '64bit'),
    }),
    capture: Object.freeze({ captureKinds: Object.freeze([...capture.configuration.captureKinds]),
      encoders: Object.freeze([...capture.configuration.encoders]), requiresHardwareProbe: true, hardwareQualified: false }),
  });
}

function loadCaptureRuntime(directory = defaultDirectory()) {
  const { pin, files } = pinSet();
  const build = capturePlan(directory, pin);
  for (const file of files()) checkFile(file);
  return build();
}

// Both manifests pin the AV1 encoder library; the pin set verifies each file once.
function runtimePlan(directory) {
  const { pin, files } = pinSet();
  const capture = capturePlan(directory, pin);
  const rtcBuild = JSON.parse(fs.readFileSync(path.join(directory, 'rtc-build.json'), 'utf8'));
  assert.equal(rtcBuild.schemaVersion, 1);
  assert.equal(rtcBuild.webrtcRevision, '36ea4535a500ac137dbf1f577ce40dc1aaa774ef');
  const apple = process.platform === 'darwin';
  if (apple) {
    assert.equal(rtcBuild.platform, 'darwin');
    assert.equal(rtcBuild.arch, process.arch);
    assert.equal(rtcBuild.minimumMacOS, '14.0');
  }
  const binaries = apple ? ['libmonky_screen_rtc.dylib', 'libmonky_av1.dylib', 'monky_screen_rtc.node', 'monky_native_surfaces.node']
    : ['monky_screen_rtc.dll', 'monky_screen_rtc.node', 'monky_av1.dll', 'monky_native_handles.node'];
  assert.ok(Array.isArray(rtcBuild.binaries) && rtcBuild.binaries.length === binaries.length);
  for (const name of binaries) {
    const file = rtcBuild.binaries.find(binary => binary.name === name);
    assert.ok(file); pin(directory, { ...file, path: name });
  }
  return {
    files: files(),
    build: () => Object.freeze({ ...capture(), rtc: encoded.load(path.join(directory, 'monky_screen_rtc.node'), {
      capabilities: rtcBuild.capabilities,
      handlesFile: path.join(directory, apple ? 'monky_native_surfaces.node' : 'monky_native_handles.node'),
    }) }),
  };
}

/** Synchronous: for build scripts, package checks and smokes, never for the app's event loop. */
function loadRuntime(directory = defaultDirectory()) {
  const plan = runtimePlan(directory);
  for (const file of plan.files) checkFile(file);
  return plan.build();
}

/** The same verification as loadRuntime, without one long synchronous read and hash of every pinned file. */
async function loadRuntimeAsync(directory = defaultDirectory()) {
  const plan = runtimePlan(directory);
  const pending = [...plan.files];
  let failed = false;
  await Promise.all(Array.from({ length: PARALLEL_FILES }, async () => {
    while (pending.length && !failed) {
      try { await checkFileAsync(pending.shift()); }
      catch (error) { failed = true; throw error; }
    }
  }));
  return plan.build();
}

function loadThumbnailRuntime(directory = path.resolve(__dirname, '..', 'bin', 'win32-x64')) {
  assert.equal(process.platform, 'win32');
  assert.equal(process.arch, 'x64');
  const build = JSON.parse(fs.readFileSync(path.join(directory, 'thumbnail-build.json'), 'utf8'));
  assert.equal(build.schemaVersion, 1);
  assert.equal(build.host.path, 'monky-screen-thumbnail.exe');
  return Object.freeze({ kind: 'verified-native-thumbnail-host', executable: verifiedFile(directory, build.host) });
}

module.exports = { loadRuntime, loadRuntimeAsync, loadCaptureRuntime, loadThumbnailRuntime, verifiedFile, verifiedFileAsync };
