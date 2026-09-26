'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const encoded = require('./nativeRtc/engine/node/encoded.cjs');

function verifiedFile(directory, record) {
  assert.ok(record && typeof record.path === 'string' && !path.isAbsolute(record.path));
  assert.ok(record.path.split(/[\\/]/u).every(part => part && part !== '.' && part !== '..'));
  assert.ok(Number.isSafeInteger(record.bytes) && record.bytes > 0 && /^[a-f0-9]{64}$/u.test(record.sha256));
  const filename = path.join(directory, record.path), stat = fs.lstatSync(filename);
  assert.ok(stat.isFile() && stat.size === record.bytes, `Native media file size or type changed: ${record.path}`);
  const bytes = fs.readFileSync(filename);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), record.sha256,
    `Native media file hash changed: ${record.path}`);
  return filename;
}

// Hash verification only: neither this loader nor its support descriptor opens a
// graphics device. probeCaptureCapabilities() or a selected CaptureBridge.prepare()
// performs hardware probing; only the source-free probe also initializes an encoder.
function loadCaptureRuntime(directory = path.resolve(__dirname, '..', 'bin', 'win32-x64')) {
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
  for (const file of capture.crt.files) verifiedFile(directory, file);
  const executable = verifiedFile(directory, capture.host);
  assert.equal(capture.av1Runtime?.path, 'monky_av1.dll');
  verifiedFile(directory, capture.av1Runtime);
  verifiedFile(directory, capture.module);
  const stockDirectory = path.join(directory, 'obs');
  assert.ok(Array.isArray(capture.runtime) && capture.runtime.length > 0 && capture.runtime.length <= 256);
  for (const file of capture.runtime) verifiedFile(stockDirectory, file);
  for (const probe of ['obs-amf-test.exe', 'obs-nvenc-test.exe']) {
    const file = capture.runtime.find(file => file.path === path.join('bin', '64bit', probe));
    assert.ok(file, `Missing pinned hardware probe: ${probe}`);
    verifiedFile(directory, { ...file, path: probe });
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
  return Object.freeze({
    host: Object.freeze({ kind: 'verified-native-screen-capture-host', executable, sha256: capture.host.sha256 }),
    obs: Object.freeze({
      kind: 'verified-stock-obs-runtime', version: capture.obsVersion, stockDirectory,
      binaryDirectory: path.join(stockDirectory, 'bin', '64bit'),
    }),
    capture: Object.freeze({ captureKinds: Object.freeze([...capture.configuration.captureKinds]),
      encoders: Object.freeze([...capture.configuration.encoders]), requiresHardwareProbe: true, hardwareQualified: false }),
  });
}

function loadRuntime(directory = path.resolve(__dirname, '..', 'bin', 'win32-x64')) {
  const capture = loadCaptureRuntime(directory);
  const rtcBuild = JSON.parse(fs.readFileSync(path.join(directory, 'rtc-build.json'), 'utf8'));
  assert.equal(rtcBuild.schemaVersion, 1);
  assert.equal(rtcBuild.webrtcRevision, '36ea4535a500ac137dbf1f577ce40dc1aaa774ef');
  assert.ok(Array.isArray(rtcBuild.binaries) && rtcBuild.binaries.length === 3);
  for (const name of ['monky_screen_rtc.dll', 'monky_screen_rtc.node', 'monky_av1.dll']) {
    const file = rtcBuild.binaries.find(binary => binary.name === name);
    assert.ok(file); verifiedFile(directory, { ...file, path: name });
  }
  return Object.freeze({ ...capture, rtc: encoded.load(path.join(directory, 'monky_screen_rtc.node')) });
}

module.exports = { loadRuntime, loadCaptureRuntime, verifiedFile };
