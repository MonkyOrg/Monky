'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');

test('VideoToolbox hardware observation stays unknown only for an unsupported property',
  { skip: process.platform !== 'darwin', timeout: 60000 }, t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-decoder-hardware-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const binary = path.join(directory, 'decoder-hardware-probe');
    execFileSync('xcrun', ['clang++', '-std=c++20', '-fobjc-arc', '-mmacosx-version-min=14.0',
      '-arch', process.arch === 'x64' ? 'x86_64' : 'arm64',
      path.join(__dirname, 'macDecoderHardwareProbe.mm'),
      path.join(__dirname, '..', 'src', 'rtc', 'inputs', 'native_core', 'h264_bitstream.cc'),
      '-framework', 'Foundation', '-framework', 'VideoToolbox',
      '-framework', 'CoreMedia', '-framework', 'CoreVideo', '-o', binary],
    { stdio: 'pipe', timeout: 45000 });
    assert.deepEqual(JSON.parse(execFileSync(binary, { encoding: 'utf8', timeout: 10000 })),
      { passed: true, unsupportedIsUnknown: true, otherErrorsRejected: true });
  });
