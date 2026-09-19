'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function execute(executable, args, { cwd = root, env = process.env, capture = false,
  windowsVerbatimArguments = false } = {}) {
  const result = spawnSync(executable, args, {
    cwd, env, windowsHide: true, encoding: 'utf8', windowsVerbatimArguments,
    stdio: capture ? 'pipe' : 'inherit', maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${path.basename(executable)} exited ${result.status}: ${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  return result.stdout?.trim() ?? '';
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

function redistributableCrt(visualStudio) {
  const version = fs.readFileSync(path.join(visualStudio, 'VC', 'Auxiliary', 'Build',
    'Microsoft.VCRedistVersion.default.txt'), 'utf8').trim();
  assert.match(version, /^14\.\d+\.\d+$/u, 'Invalid Visual C++ redistributable version.');
  const directory = path.join(visualStudio, 'VC', 'Redist', 'MSVC', version, 'x64', 'Microsoft.VC143.CRT');
  const files = new Map(fs.readdirSync(directory, { withFileTypes: true })
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

module.exports = { root, execute, write, digest, fingerprint, verify, redistributableCrt, regularFiles };
