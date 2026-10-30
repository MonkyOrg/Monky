'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { redistributableCrt, transientNetworkFailure, withNetworkRetries, withBuildLock } = require('../scripts/buildTools.cjs');

test('app-local CRT comes from the release redistributable, never System32 or debug_nonredist', t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-screen-crt-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const metadata = path.join(fixture, 'VC', 'Auxiliary', 'Build');
  fs.mkdirSync(metadata, { recursive: true });
  fs.writeFileSync(path.join(metadata, 'Microsoft.VCRedistVersion.default.txt'), '14.44.35112\r\n');
  const directory = path.join(fixture, 'VC', 'Redist', 'MSVC', '14.44.35112', 'x64', 'Microsoft.VC143.CRT');
  fs.mkdirSync(directory, { recursive: true });
  for (const name of ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll', 'unrelated.txt'])
    fs.writeFileSync(path.join(directory, name), name);
  const result = redistributableCrt(fixture);
  assert.equal(result.version, '14.44.35112');
  assert.equal(result.files.size, 3);
  for (const filename of result.files.values()) assert.equal(path.dirname(filename), directory);
  fs.unlinkSync(path.join(directory, 'vcruntime140_1.dll'));
  assert.throws(() => redistributableCrt(fixture), /Missing release CRT/);
  fs.writeFileSync(path.join(metadata, 'Microsoft.VCRedistVersion.default.txt'), '..\\debug_nonredist');
  assert.throws(() => redistributableCrt(fixture), /Invalid Visual C\+\+/);
});
test('only transient transport failures from upstream source hosts are retryable', () => {
  for (const message of [
    // Observed in CI: gitlab.xiph.org 504 and a googlesource 503 during pinned source fetches.
    'git exited 128: \nerror: RPC failed; HTTP 504 curl 22 The requested URL returned error: 504\nfatal: expected flush after ref listing',
    'error: RPC failed; HTTP 503 curl 22 The requested URL returned error: 503',
    'fatal: unable to access \'https://github.com/x/y.git/\': Could not resolve host: github.com',
    'fatal: unable to access \'https://github.com/x/y.git/\': Failed to connect to github.com port 443',
    'error: RPC failed; curl 56 Recv failure: Connection reset by peer\nfatal: early EOF',
    'fatal: the remote end hung up unexpectedly',
    'The requested URL returned error: 429',
  ]) assert.equal(transientNetworkFailure(new Error(message)), true, message);
  for (const message of [
    'fatal: remote error: upload-pack: not our ref 0123456789abcdef0123456789abcdef01234567',
    'The requested URL returned error: 404',
    'remote: Repository not found.',
    'fatal: unable to access \'https://x/\': SSL certificate problem: unable to get local issuer certificate',
    'fatal: Authentication failed for \'https://github.com/x/y.git/\'',
    'Source revision changed: D:/a/source',
  ]) assert.equal(transientNetworkFailure(new Error(message)), false, message);
});

test('network retries back off on transient failures and stop immediately on real errors', () => {
  const sleeps = [], logs = [];
  const transient = () => new Error('error: RPC failed; HTTP 504 curl 22 The requested URL returned error: 504');
  let calls = 0;
  assert.equal(withNetworkRetries(() => { if (++calls < 3) throw transient(); return 'fetched'; },
    { label: 'Source fetch', sleep: ms => sleeps.push(ms), log: line => logs.push(line) }), 'fetched');
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [10_000, 30_000]);
  assert.match(logs[0], /^Source fetch: transient network failure on attempt 1\/4; retrying in 10s\.$/u);

  calls = 0; sleeps.length = 0;
  assert.throws(() => withNetworkRetries(() => { calls++; throw transient(); },
    { label: 'Source fetch', sleep: ms => sleeps.push(ms), log: () => {} }), /HTTP 504/u);
  assert.equal(calls, 4, 'Retries are bounded.');
  assert.deepEqual(sleeps, [10_000, 30_000, 60_000]);

  calls = 0; sleeps.length = 0;
  assert.throws(() => withNetworkRetries(() => { calls++; throw new Error('upload-pack: not our ref'); },
    { label: 'Source fetch', sleep: ms => sleeps.push(ms), log: () => {} }), /not our ref/u);
  assert.equal(calls, 1, 'A missing pinned revision is never retried.');
  assert.deepEqual(sleeps, []);
});

test('pinned source fetches on Windows and macOS go through the bounded network retry', () => {
  const scripts = path.join(__dirname, '..', 'scripts');
  const obs = fs.readFileSync(path.join(scripts, 'fetchObs.cjs'), 'utf8');
  assert.match(obs, /withNetworkRetries\(\(\) => git\(directory, \['fetch', '--quiet', '--depth=1', 'origin', revision\]\)/u);
  assert.match(obs, /withNetworkRetries\(\(\) => git\(directory, \['submodule', 'update'/u);
  const mac = fs.readFileSync(path.join(scripts, 'prepareMacRtc.cjs'), 'utf8');
  // capture: true puts git's stderr into the error so its transport failure can be classified.
  assert.match(mac, /withNetworkRetries\(\(\) => execute\('git', \['-C', directory, 'fetch'[\s\S]{0,120}capture: true/u);
});

test('a build lock records its owner and replaces only a lock whose build is gone', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-screen-lock-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const lock = path.join(directory, 'rtc.lock'), logs = [], running = new Set([4242]);
  const options = { isRunning: pid => running.has(pid), log: line => logs.push(line) };

  const owner = withBuildLock(lock, () => JSON.parse(fs.readFileSync(lock, 'utf8')), options);
  assert.equal(owner.pid, process.pid);
  assert.equal(fs.existsSync(lock), false, 'A finished build releases its lock.');
  assert.throws(() => withBuildLock(lock, () => { throw new Error('Compiler failed.'); }, options), /Compiler failed/u);
  assert.equal(fs.existsSync(lock), false, 'A failed build releases its lock.');

  fs.writeFileSync(lock, JSON.stringify({ pid: 4242 }));
  assert.throws(() => withBuildLock(lock, () => assert.fail('Two builds cannot share a directory.'), options),
    /Another native build \(PID 4242\) holds/u);
  assert.deepEqual(JSON.parse(fs.readFileSync(lock, 'utf8')), { pid: 4242 });

  running.delete(4242);
  assert.equal(withBuildLock(lock, () => 'built after Ctrl+C', options), 'built after Ctrl+C');
  assert.equal(fs.existsSync(lock), false);
  assert.match(logs.at(-1), /stale build lock .* of the finished PID 4242\.$/u);

  // An older script left empty locks; a fresh one may still be getting its owner written.
  fs.writeFileSync(lock, '');
  const modified = fs.statSync(lock).mtimeMs;
  assert.throws(() => withBuildLock(lock, () => assert.fail('A fresh unowned lock is held.'),
    { ...options, now: () => modified + 5000 }), /Another native build holds/u);
  assert.equal(withBuildLock(lock, () => 'built', { ...options, now: () => modified + 20000 }), 'built');
  assert.equal(fs.existsSync(lock), false);

  assert.throws(() => withBuildLock(lock, async () => 'not awaited', options), /synchronous build/u);
  assert.equal(fs.existsSync(lock), false);
});

test('every native build and preparation takes its lock through withBuildLock', () => {
  const scripts = path.join(__dirname, '..', 'scripts');
  // buildThumbnails, buildMac and buildMacRtc keep their old lock: each built runtime pins their exact bytes
  // (sourceRecipe), so editing them invalidates installed and cached runtimes. Move them with the next rebuild.
  for (const name of ['buildRtc.cjs', 'buildCapture.cjs', 'prepareMacRtc.cjs']) {
    const script = fs.readFileSync(path.join(scripts, name), 'utf8');
    assert.match(script, /return withBuildLock\(path\.join\([^)]+\.lock'\), \(\) => \{/u, name);
    assert.doesNotMatch(script, /openSync\(/u, name);
  }
});
