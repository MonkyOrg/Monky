'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { randomBytes } = require('node:crypto');
const { CaptureBridge, loadCaptureRuntime } = require('..');
const { within } = require('../runtime/nativeDeadline.cjs');

const artifacts = process.argv.find(value => value.startsWith('--artifacts='))?.slice('--artifacts='.length);
const contracts = process.argv.find(value => value.startsWith('--contracts='))?.slice('--contracts='.length)
  ?? path.resolve(__dirname, '..', 'build', 'capture-production', 'capture-contract-test.exe');
assert.ok(artifacts && path.isAbsolute(artifacts));
assert.equal(fs.existsSync(artifacts), false, 'Never reuse source-identity smoke artifacts.');
assert.ok(path.isAbsolute(contracts) && fs.existsSync(contracts), 'Build native capture contracts first.');
fs.mkdirSync(artifacts);
const owners = new Set();
const report = { probes: [], personalWindowsCaptured: false, videoRecorded: false, forcedTermination: false };

async function fixture(className, nonce = randomBytes(16).toString('hex'), parent) {
  const child = spawn(contracts, ['--window-fixture', className, nonce, ...(parent ? [String(parent)] : [])],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', value => { stderr += value; });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const owner = {
    child, nonce,
    async close() {
      child.stdin.end();
      const result = await within(closed, 5000, 'Owned fixture did not close after stdin EOF.');
      assert.deepEqual(result, { code: 0, signal: null }, stderr);
      owners.delete(owner);
    },
    async rename(command) {
      const acknowledged = nextLine();
      child.stdin.write(command);
      assert.deepEqual(JSON.parse(await within(acknowledged, 5000, `Owned fixture did not rename (${command}).`)),
        { renamed: true });
    },
  };
  owners.add(owner);
  const lines = createInterface({ input: child.stdout });
  const pending = [];
  lines.on('line', line => pending.shift()?.(line));
  const nextLine = () => new Promise(resolve => pending.push(resolve));
  const [line] = await within(Promise.race([
    nextLine().then(value => [value]),
    closed.then(result => { throw new Error(`Fixture exited before readiness: ${JSON.stringify(result)} ${stderr}`); }),
  ]), 5000, 'Owned fixture did not prove its HWND.');
  owner.target = { kind: 'window', ...JSON.parse(line) };
  assert.equal(owner.target.expectedProcessId, child.pid);
  return owner;
}

async function packetsAfter(read, minimum, label) {
  const deadline = Date.now() + 5000;
  while (read() < minimum) {
    assert.ok(Date.now() < deadline, `${label}: capture stopped delivering packets.`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function probe(runtime, target, label, expectedError, capture = false, renameOwner) {
  const runId = randomBytes(16).toString('hex');
  const runDirectory = path.join(artifacts, `monky-screen-capture-${runId}`);
  fs.mkdirSync(runDirectory);
  let packets = 0;
  const runtimeErrors = [];
  const bridge = new CaptureBridge({
    host: runtime.host, runtime: runtime.obs, runId, runDirectory, encoder: 'obs_x264',
    video: { width: 1280, height: 720, fps: 30, bitrateKbps: 3000, scaleMode: 'fit' },
    onError(error) { runtimeErrors.push(error); console.error(`${label}: ${error.code}: ${error.message}`); },
    onPacket() {
      assert.equal(capture, true, 'Source identity preflight must never capture pixels.');
      packets++;
    },
    onNotice() {},
  });
  let failure;
  try {
    await bridge.prepare(target);
    assert.equal(bridge.getCapabilities()?.probeVerified, true);
    if (capture) {
      const ready = await bridge.start(target);
      assert.equal(ready.observation.sourceAttached, true);
      assert.ok(ready.observation.outputPackets > 0);
      assert.deepEqual(ready.hookedKey, ready.sourceKey);
      assert.equal(ready.sourceKey.className, label.split(':')[0]);
      // A shared window is identified by HWND/process birth; a page change renaming it must not end the share.
      for (const command of renameOwner ? ['r', 'l', 'e', 'r'] : []) {
        const before = packets;
        await renameOwner.rename(command);
        await packetsAfter(() => packets, before + 30, `${label}:${command}`);
        assert.deepEqual(runtimeErrors, [], `${label}: renaming the shared window failed the capture.`);
      }
    }
  } catch (error) { failure = error; }
  try { await bridge.stop(); }
  catch (error) {
    assert.ok(failure && error.code === failure.code && error.message === failure.message,
      `Independent retirement failure: ${error.stack}`);
  }
  assert.equal(bridge.snapshot().nativeClosed, true);
  assert.equal(bridge.snapshot().forcedTermination, false);
  if (expectedError) assert.equal(failure?.code, expectedError);
  else if (failure) throw failure;
  if (capture) assert.ok(packets > 0, 'The owned WinUI window must deliver actual encoded frames.');
  else assert.equal(packets, 0);
  report.probes.push({ label, admitted: !failure, error: failure?.code ?? null, packets, nativeClosed: true });
}

async function main() {
  try {
    const runtime = loadCaptureRuntime();
    for (const className of ['WinUIDesktopWin32WindowClass', 'ApplicationFrameWindow']) {
      const selected = await fixture(className);
      await probe(runtime, selected.target, `${className}:same-process-child`, undefined, true);
      const duplicate = await fixture(className, selected.nonce);
      await probe(runtime, selected.target, `${className}:duplicate-title`, undefined, true);
      await probe(runtime, duplicate.target, `${className}:duplicate-title-second-window`, undefined, true);
      await duplicate.close();
      const foreign = await fixture(className, undefined, selected.target.hwnd);
      await probe(runtime, selected.target, `${className}:foreign-child-remapping`, 'ERR_SCREEN_CAPTURE_SOURCE_IDENTITY');
      await foreign.close();
      await probe(runtime, selected.target, `${className}:original-window-restored`);
      await probe(runtime, { ...selected.target, expectedProcessCreationTime100ns: '1' },
        `${className}:process-identity-changed`, 'ERR_SCREEN_CAPTURE_PROCESS_IDENTITY');
      await probe(runtime, selected.target, `${className}:renamed-while-shared`, undefined, true, selected);
      await selected.close();
    }
    console.log(JSON.stringify(report));
  } finally {
    const cleanup = await Promise.allSettled([...owners].map(owner => owner.close()));
    fs.writeFileSync(path.join(artifacts, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    const errors = cleanup.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Owned source fixture retirement failed.');
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
