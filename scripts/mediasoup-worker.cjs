'use strict';

// The mediasoup SFU worker has no prebuilt binary for every CI host (darwin-x64 compiles it for
// ~8 minutes). Its cache key pins the exact npm package (version + integrity), the host and the
// compiler selection; a restored binary must pass the same checks as a fresh one before use.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const binary = `node_modules/mediasoup/worker/out/Release/mediasoup-worker${process.platform === 'win32' ? '.exe' : ''}`;

function workerKey({ base = root, platform = process.platform, arch = process.arch, image = process.env.ImageOS ?? '' } = {}) {
  const locked = JSON.parse(fs.readFileSync(path.join(base, 'package-lock.json'), 'utf8')).packages['node_modules/mediasoup'];
  assert.ok(locked?.version && locked.integrity, 'package-lock.json must pin mediasoup with its integrity.');
  const xcode = platform === 'darwin'
    ? JSON.parse(fs.readFileSync(path.join(base, 'apps', 'light', 'dependencies.json'), 'utf8')).buildTools.ciXcode : '';
  const host = crypto.createHash('sha256').update(JSON.stringify({ image, xcode })).digest('hex').slice(0, 12);
  const pinned = crypto.createHash('sha256').update(`${locked.version}\0${locked.integrity}`).digest('hex').slice(0, 16);
  return `mediasoup-worker-v1-${platform}-${arch}-${host}-${locked.version}-${pinned}`;
}

async function verifyWorker({ base = root } = {}) {
  const filename = path.join(base, ...binary.split('/'));
  assert.ok(fs.statSync(filename).isFile(), `Missing mediasoup worker: ${binary}`);
  // mediasoup's own prebuilt check: without MEDIASOUP_VERSION the worker exits with 41.
  const probe = spawnSync(filename, [], { env: {}, stdio: 'ignore', timeout: 30000 });
  assert.ifError(probe.error);
  assert.equal(probe.status, 41, 'The mediasoup worker does not run on this host.');
  // A real worker proves it matches the installed mediasoup version, which it checks on startup.
  const { createWorker } = require(path.join(base, 'node_modules', 'mediasoup'));
  const worker = await createWorker({ logLevel: 'error' });
  try {
    const router = await worker.createRouter({ mediaCodecs: [
      { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 }] });
    assert.ok(router.rtpCapabilities.codecs.length > 0);
  } finally { worker.close(); }
  return filename;
}

module.exports = { binary, workerKey, verifyWorker };
if (require.main === module) {
  const [command, ...rest] = process.argv.slice(2);
  (async () => {
    assert.equal(rest.length, 0, 'Usage: node scripts/mediasoup-worker.cjs <key|verify>');
    if (command === 'key') {
      const key = workerKey();
      console.log(JSON.stringify({ key, path: binary }));
      if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `key=${key}\npath=${binary}\n`);
    } else if (command === 'verify') {
      console.log(JSON.stringify({ mediasoupWorkerVerified: path.relative(root, await verifyWorker()) }));
    } else throw new Error('Usage: node scripts/mediasoup-worker.cjs <key|verify>');
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
