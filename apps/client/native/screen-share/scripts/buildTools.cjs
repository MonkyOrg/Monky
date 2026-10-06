'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function execute(executable, args, { cwd = root, env = process.env, capture = false,
  windowsVerbatimArguments = false, timeout } = {}) {
  const result = spawnSync(executable, args, {
    cwd, env, windowsHide: true, encoding: 'utf8', windowsVerbatimArguments, timeout,
    stdio: capture ? 'pipe' : 'inherit', maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${path.basename(executable)} exited ${result.status}: ${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  return result.stdout?.trim() ?? '';
}

// Upstream source hosts (GitHub, googlesource, gitlab.xiph.org) intermittently answer 5xx or drop
// connections. Pinned fetches are idempotent and verified afterwards, so only these transient
// transport failures are retried; missing revisions, auth and certificate errors fail at once.
const TRANSIENT_NETWORK_FAILURE = new RegExp([
  'RPC failed', 'returned error: (?:408|429|5\\d\\d)', 'HTTP (?:408|429|5\\d\\d)\\b', 'Could not resolve host',
  'Failed to connect', 'Connection (?:timed out|reset|refused)', 'Operation timed out', 'early EOF',
  'unexpected disconnect', 'expected flush after ref listing', 'remote end hung up', 'Recv failure',
  'TLS connection was non-properly terminated', 'gnutls_handshake\\(\\) failed',
].join('|'), 'iu');

function transientNetworkFailure(error) {
  return TRANSIENT_NETWORK_FAILURE.test(String(error?.message ?? error ?? ''));
}

const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function withNetworkRetries(run, { label, attempts = 4, delaysMs = [10_000, 30_000, 60_000],
  sleep = sleepSync, log = console.warn } = {}) {
  assert.ok(Number.isInteger(attempts) && attempts >= 1 && delaysMs.length > 0);
  for (let attempt = 1; ; attempt++) {
    try { return run(); }
    catch (error) {
      if (attempt >= attempts || !transientNetworkFailure(error)) throw error;
      const delay = delaysMs[Math.min(attempt - 1, delaysMs.length - 1)];
      log(`${label}: transient network failure on attempt ${attempt}/${attempts}; retrying in ${delay / 1000}s.`);
      sleep(delay);
    }
  }
}

function write(filename, bytes) {
  if (fs.existsSync(filename) && fs.readFileSync(filename).equals(Buffer.from(bytes))) return;
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, bytes);
}

function fingerprint(filename) {
  assert.ok(fs.lstatSync(filename).isFile(), 'Native input must be a regular file.');
  const bytes = fs.readFileSync(filename);
  return { bytes: bytes.length, sha256: digest(bytes) };
}

function verify(filename, expected) {
  assert.deepEqual(fingerprint(filename), { bytes: expected.bytes, sha256: expected.sha256 },
    `Native build input differs from its pin: ${filename}`);
}

function redistributableCrt(visualStudio, io = fs) {
  const version = io.readFileSync(path.join(visualStudio, 'VC', 'Auxiliary', 'Build',
    'Microsoft.VCRedistVersion.default.txt'), 'utf8').trim();
  assert.match(version, /^14\.\d+\.\d+$/u, 'Invalid Visual C++ redistributable version.');
  const directory = path.join(visualStudio, 'VC', 'Redist', 'MSVC', version, 'x64', 'Microsoft.VC143.CRT');
  const files = new Map(io.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^[a-z0-9_]+\.dll$/u.test(entry.name))
    .map(entry => [entry.name, path.join(directory, entry.name)]));
  for (const name of ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'])
    assert.ok(files.has(name), `Missing release CRT redistributable: ${name}`);
  return { version, files };
}

function regularFiles(directory, base = directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    assert.ok(!entry.isSymbolicLink(), `Unexpected alias in native inputs: ${filename}`);
    if (entry.isDirectory()) return regularFiles(filename, base);
    assert.ok(entry.isFile(), `Native input must be a regular file: ${filename}`);
    return [path.relative(base, filename)];
  }).sort();
}

module.exports = { root, execute, write, digest, fingerprint, verify, redistributableCrt, regularFiles,
  transientNetworkFailure, withNetworkRetries };
