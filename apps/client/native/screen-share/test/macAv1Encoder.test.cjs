'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');
const available = process.platform === 'darwin'
  && fs.existsSync(path.join(root, 'bin', `darwin-${process.arch}`, 'libmonky_av1.dylib'));

test('native AV1 C ABI preserves I420 and admits NV12 with real keyframes, references and rate changes',
  { skip: !available }, t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-av1-abi-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const binary = path.join(directory, 'av1-probe');
    const libraries = path.join(root, 'bin', `darwin-${process.arch}`);
    execFileSync('xcrun', ['clang++', '-std=c++20', '-mmacosx-version-min=14.0',
      '-arch', process.arch === 'x64' ? 'x86_64' : 'arm64',
      path.join(__dirname, 'av1RuntimeProbe.cc'), path.join(libraries, 'libmonky_av1.dylib'),
      `-Wl,-rpath,${libraries}`, '-o', binary], { stdio: 'pipe' });
    const result = JSON.parse(execFileSync(binary, { encoding: 'utf8', timeout: 30000 }));
    assert.equal(result.passed, true);
    assert.equal(result.i420Frames, 8);
    assert.equal(result.nv12Frames, 8);
    for (const key of ['forcedKeyframes', 'dependentFrames', 'paddedStrides', 'bitrateChange'])
      assert.equal(result[key], true);
  });

test('real macOS AV1 probe validates native software through 4K120 and closes without capturing a source',
  { skip: !available, timeout: 60000 }, async () => {
    const runtime = require('../runtime/runtimeFiles.cjs').loadCaptureRuntime();
    const { probeCaptureCapabilities } = require('../runtime/mac/captureBridge.cjs');
    for (const video of [
      { width: 848, height: 480, fps: 30, bitrateKbps: 2000 },
      { width: 1920, height: 1080, fps: 60, bitrateKbps: 15000 },
      { width: 3840, height: 2160, fps: 60, bitrateKbps: 40000 },
      { width: 3840, height: 2160, fps: 120, bitrateKbps: 80000 },
    ]) {
      const result = await probeCaptureCapabilities({ ...runtime, video, encoder: 'monky_aom_av1' });
      assert.equal(result.codec, 'av1');
      assert.equal(result.mode, 'software');
      assert.equal(result.probeVerified, true);
      assert.equal(result.textureInput, false);
      assert.equal(result.hardwareQualified, false);
      assert.equal(result.hardwareSessionConfirmed, false);
      assert.equal(result.sourceCaptured, false);
    }
  });
