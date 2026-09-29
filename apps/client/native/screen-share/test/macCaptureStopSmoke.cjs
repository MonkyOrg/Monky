'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const { within } = require('../runtime/nativeDeadline.cjs');
const { createMacAudioSource } = require('../../screen-audio/test/macAudioSource.cjs');

async function main() {
  assert.equal(process.platform, 'darwin');
  const directory = process.argv.find(value => value.startsWith('--artifacts='))?.slice('--artifacts='.length);
  const arch = process.argv.find(value => value.startsWith('--arch='))?.slice('--arch='.length) ?? process.arch;
  assert.ok(directory && path.isAbsolute(directory) && !fs.existsSync(directory), 'Use a new absolute artifact directory.');
  assert.ok(['arm64', 'x64'].includes(arch));
  fs.mkdirSync(directory, { recursive: true });
  const root = path.resolve(__dirname, '..'), binary = path.join(directory, 'capture-stop-probe');
  execFileSync('xcrun', ['clang++', '-std=c++20', '-fobjc-arc', '-fblocks', '-O2', '-Wall', '-Wextra', '-Werror',
    '-mmacosx-version-min=14.0', '-arch', arch === 'x64' ? 'x86_64' : 'arm64',
    path.join(__dirname, 'macCaptureStopProbe.mm'),
    ...['videoEncoder.mm', 'videoDecoder.mm', 'av1Encoder.mm', 'videoScaler.mm']
      .map(name => path.join(root, 'src', 'mac', name)),
    path.join(root, 'src', 'rtc', 'inputs', 'native_core', 'h264_bitstream.cc'),
    ...['Foundation', 'AppKit', 'ScreenCaptureKit', 'CoreGraphics', 'VideoToolbox', 'CoreMedia', 'CoreVideo', 'CoreImage', 'Metal']
      .flatMap(name => ['-framework', name]),
    '-o', binary], { stdio: 'pipe' });
  const source = createMacAudioSource(path.join(directory, 'source'));
  const sourceExit = once(source, 'exit');
  let child, childExit;
  try {
    const [ready] = await within(once(source, 'message'), 15000, 'Owned source did not open.');
    assert.equal(ready.pid, source.pid);
    child = spawn(binary, [String(ready.hwnd), String(ready.pid)]);
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.pipe(process.stderr);
    childExit = once(child, 'exit');
    const [code] = await within(childExit, 60000, 'Native system-stop regression timed out.');
    assert.equal(code, 0, output);
    const report = JSON.parse(output);
    assert.equal(report.passed, true);
    assert.equal(report.survivorErrors, 0);
    assert.ok(report.survivorFrames >= 35);
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await childExit;
    }
    source.disconnect();
    try { await within(sourceExit, 10000, 'Owned source did not retire.'); }
    catch (error) { source.kill('SIGKILL'); await sourceExit; throw error; }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
