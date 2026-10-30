'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { loadRuntime, loadRuntimeAsync, verifiedFile, verifiedFileAsync } = require('../runtime/runtimeFiles.cjs');

const runtimeDirectory = path.resolve(__dirname, '..', 'bin', `${process.platform}-${process.arch}`);
const runtimePrepared = ['win32-x64', 'darwin-arm64', 'darwin-x64'].includes(`${process.platform}-${process.arch}`)
  && fs.existsSync(path.join(runtimeDirectory, 'rtc-build.json'));
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function pinnedFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-runtime-files-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  // Spans several hash slices, so the last slice is a partial one.
  const bytes = crypto.randomBytes(3 * 1024 * 1024 + 5);
  fs.writeFileSync(path.join(directory, 'pinned.bin'), bytes);
  return { directory, filename: path.join(directory, 'pinned.bin'), record: { path: 'pinned.bin', bytes: bytes.length, sha256: digest(bytes) } };
}

async function rejectsBoth(directory, record, expected) {
  assert.throws(() => verifiedFile(directory, record), expected);
  await assert.rejects(verifiedFileAsync(directory, record), expected);
}

test('a pinned file passes only with its exact size and digest, whole or hashed in slices', async t => {
  const { directory, filename, record } = pinnedFixture(t);
  assert.equal(verifiedFile(directory, record), filename);
  assert.equal(await verifiedFileAsync(directory, record), filename);
  await rejectsBoth(directory, { ...record, bytes: record.bytes + 1 }, /size or type changed/);
  await rejectsBoth(directory, { ...record, bytes: record.bytes - 1 }, /size or type changed/);
  await rejectsBoth(directory, { ...record, sha256: '0'.repeat(64) }, /hash changed/);
  const changed = fs.readFileSync(filename);
  changed[changed.length - 1] ^= 1;
  fs.writeFileSync(filename, changed);
  await rejectsBoth(directory, record, /hash changed/);
});

test('links, directories, traversal and absolute paths are never pinned files', async t => {
  const { directory, filename, record } = pinnedFixture(t);
  await rejectsBoth(directory, { ...record, path: filename }, assert.AssertionError);
  await rejectsBoth(path.join(directory, 'nested'), { ...record, path: path.join('..', 'pinned.bin') }, assert.AssertionError);
  fs.mkdirSync(path.join(directory, 'folder'));
  await rejectsBoth(directory, { ...record, path: 'folder' }, /size or type changed/);
  try {
    fs.symlinkSync(filename, path.join(directory, 'linked.bin'), 'file');
  } catch (error) {
    // Windows creates file symbolic links only with Developer Mode or elevation.
    if (error.code !== 'EPERM') throw error;
    t.diagnostic('File symbolic links are unavailable here; directory links stand in for them.');
    fs.symlinkSync(path.join(directory, 'folder'), path.join(directory, 'linked.bin'), 'junction');
  }
  await rejectsBoth(directory, { ...record, path: 'linked.bin' }, /size or type changed/);
});

test('hashing in slices returns to the event loop between slices', async t => {
  const { directory, record } = pinnedFixture(t);
  let turns = 0, running = true;
  const turn = () => { if (running) { turns++; setImmediate(turn); } };
  setImmediate(turn);
  try { await verifiedFileAsync(directory, record); }
  finally { running = false; }
  assert.ok(turns >= 3, `Only ${turns} event loop turns ran while 3 MiB were verified`);
});

test('the prepared runtime verifies the same way whole or in slices, hashing each pinned file once',
  { skip: !runtimePrepared && 'The native runtime is not prepared on this machine.' }, async t => {
    const opened = new Map();
    const open = fs.promises.open;
    t.mock.method(fs.promises, 'open', (filename, ...rest) => {
      const key = path.resolve(String(filename)).toLowerCase();
      opened.set(key, (opened.get(key) ?? 0) + 1);
      return open.call(fs.promises, filename, ...rest);
    });
    const sliced = await loadRuntimeAsync(runtimeDirectory);
    const whole = loadRuntime(runtimeDirectory);
    assert.deepEqual({ host: sliced.host, obs: sliced.obs, capture: sliced.capture },
      { host: whole.host, obs: whole.obs, capture: whole.capture });
    assert.deepEqual(sliced.rtc.capabilities(), whole.rtc.capabilities());
    assert.ok(opened.size > 0);
    assert.deepEqual([...opened].filter(([, count]) => count !== 1), [], 'Every pinned file is read once');
    const av1 = path.join(runtimeDirectory, process.platform === 'darwin' ? 'libmonky_av1.dylib' : 'monky_av1.dll');
    assert.equal(opened.get(av1.toLowerCase()), 1, 'Both manifests pin the AV1 library; it is verified once');
  });
