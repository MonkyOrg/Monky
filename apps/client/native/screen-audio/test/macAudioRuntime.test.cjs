'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const { test } = require('node:test');

test('macOS audio exclusion enumerates our children and grandchildren without inspecting unrelated processes', {
  skip: process.platform !== 'darwin',
  timeout: 20000,
}, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-audio-process-tree-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const executable = path.join(directory, 'process-tree');
  execFileSync('xcrun', ['clang++', '-std=c++17', path.join(__dirname, 'mac_process_tree.cpp'),
    '-lproc', '-o', executable], { timeout: 10000 });
  const child = spawn(process.execPath, ['-e', `
    const leaf = require('node:child_process').spawn('/bin/sleep', ['30']);
    process.on('message', () => leaf.kill('SIGTERM'));
    process.on('disconnect', () => leaf.kill('SIGTERM'));
    leaf.once('exit', () => process.exit(0));
    process.send({ pid: leaf.pid });
  `], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  t.after(async () => {
    if (child.exitCode !== null) return;
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(5000) });
    child.send('stop');
    await exited;
  });
  const [grandchild] = await once(child, 'message', { signal: AbortSignal.timeout(5000) });
  const inspect = root => JSON.parse(execFileSync(executable, [String(root)], { encoding: 'utf8', timeout: 5000 }));
  const own = inspect(process.pid);
  for (const pid of [process.pid, child.pid, grandchild.pid]) assert.ok(own.includes(pid), `Missing descendant ${pid}`);
  assert.ok(!own.includes(process.ppid));
  assert.ok(!own.includes(1));
  const descendants = inspect(child.pid);
  assert.ok(descendants.includes(child.pid) && descendants.includes(grandchild.pid));
  assert.ok(!descendants.includes(process.pid), 'Parent processes are not captured as children.');
  assert.throws(() => inspect(0), /Invalid audio process tree root/);
});

test('compiled macOS packet capture rejects a Node-only host and drains its native worker', {
  skip: process.platform !== 'darwin',
  timeout: 10000,
}, async () => {
  const audio = require('..');
  assert.equal(audio.isPacketCaptureSupported(), true, 'Build the production audio addon before this test.');
  const errors = [];
  const capture = audio.createPacketCapture({ excludePid: process.pid }, event => {
    if (event.type === 'error') errors.push(event.error);
  });
  try {
    await assert.rejects(capture.ready, { code: 'ERR_AUDIO_RUNTIME' });
    const closed = await capture.closed;
    assert.equal(closed.state, 'failed');
    assert.equal(closed.error.code, 'ERR_AUDIO_RUNTIME');
    assert.ok(errors.some(error => error.code === 'ERR_AUDIO_RUNTIME'));
  } finally { await capture.stop(); }
});
