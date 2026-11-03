'use strict';

// The FFmpeg the local execution E2E hands to the real worker (MONKY_WORKER_TEST_FFMPEG). It is
// one pinned Windows build, verified by the hash of its archive before extraction and by the hash
// of its executable whenever it is reused, so a cache or a stale download can never stand in for it.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { spawnSync } = require('node:child_process');

const FFMPEG = Object.freeze({
  version: '8.0',
  url: 'https://github.com/GyanD/codexffmpeg/releases/download/8.0/ffmpeg-8.0-essentials_build.zip',
  archiveSha256: '647e467caf82b9fa200a562769b5ff4d736aaf725804ed2c64ea9752106fa569',
  member: 'ffmpeg-8.0-essentials_build/bin/ffmpeg.exe',
  executableSha256: '1fcb0cb525085cc5be3ad4be16799d60786b65cc36951622a018d00f78c0fb5d',
});

/** Shared by every checkout of this computer; CI points it at the directory it caches. */
function fixtureRoot(env = process.env) {
  if (env.MONKY_TEST_FIXTURES) return path.resolve(env.MONKY_TEST_FIXTURES);
  return path.join(env.LOCALAPPDATA ?? path.join(os.homedir(), '.cache'), 'Monky-test-fixtures');
}

function fixtureKey() {
  return `fixture-ffmpeg-v1-win32-x64-${FFMPEG.version}-${FFMPEG.archiveSha256.slice(0, 16)}`;
}

function fixtureDirectory(root = fixtureRoot()) {
  return path.join(root, `ffmpeg-${FFMPEG.version}-${FFMPEG.executableSha256.slice(0, 12)}`);
}

function executablePath(root = fixtureRoot()) {
  return path.join(fixtureDirectory(root), 'ffmpeg.exe');
}

function sha256(filename) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(filename, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1 << 20);
    for (let read; (read = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0;) hash.update(buffer.subarray(0, read));
  } finally { fs.closeSync(descriptor); }
  return hash.digest('hex');
}

/** The pinned executable when it is present and intact, otherwise null. */
function verifiedExecutable(root = fixtureRoot()) {
  const filename = executablePath(root);
  try {
    return fs.statSync(filename).isFile() && sha256(filename) === FFMPEG.executableSha256 ? filename : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`Fixture FFmpeg download failed: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destination, { flags: 'wx' }));
}

// Windows ships libarchive's bsdtar, which reads zip archives; GNU tar from Git Bash cannot.
function extract(archive, member, directory) {
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  const result = spawnSync(tar, ['-xf', archive, '-C', directory, member], { encoding: 'utf8', timeout: 120_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `Could not extract the fixture FFmpeg: ${result.stderr}`);
  return path.join(directory, ...member.split('/'));
}

/** Returns the verified executable, downloading and checking the pinned archive only when it is missing. */
async function ensureExecutable({ root = fixtureRoot(), platform = process.platform, fetchTo = download, unpack = extract } = {}) {
  const present = verifiedExecutable(root);
  if (present) return present;
  assert.equal(platform, 'win32', 'The pinned fixture FFmpeg is a Windows build; elsewhere set MONKY_WORKER_TEST_FFMPEG.');
  fs.mkdirSync(root, { recursive: true });
  const staging = fs.mkdtempSync(path.join(root, '.stage-ffmpeg-'));
  try {
    const archive = path.join(staging, 'ffmpeg.zip');
    await fetchTo(FFMPEG.url, archive);
    const archiveSha256 = sha256(archive);
    assert.equal(archiveSha256, FFMPEG.archiveSha256, 'The downloaded fixture FFmpeg archive does not match its pinned hash.');
    const extracted = unpack(archive, FFMPEG.member, staging);
    assert.equal(sha256(extracted), FFMPEG.executableSha256, 'The extracted fixture FFmpeg does not match its pinned hash.');
    const directory = fixtureDirectory(root);
    // A concurrent checkout may have finished first; only an intact executable is kept.
    fs.rmSync(directory, { recursive: true, force: true });
    fs.mkdirSync(directory, { recursive: true });
    const temporary = path.join(directory, `.ffmpeg-${process.pid}.exe`);
    fs.copyFileSync(extracted, temporary);
    fs.renameSync(temporary, executablePath(root));
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  const verified = verifiedExecutable(root);
  assert.ok(verified, 'The fixture FFmpeg changed while it was being installed.');
  return verified;
}

module.exports = { FFMPEG, fixtureRoot, fixtureKey, fixtureDirectory, executablePath, verifiedExecutable, ensureExecutable };
if (require.main === module) {
  const usage = 'Usage: node scripts/fixture-ffmpeg.cjs <key|ensure>';
  const [command, ...rest] = process.argv.slice(2);
  (async () => {
    assert.equal(rest.length, 0, usage);
    const output = values => {
      console.log(JSON.stringify(values));
      if (process.env.GITHUB_OUTPUT) {
        fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([name, value]) => `${name}=${value}\n`).join(''));
      }
    };
    if (command === 'key') output({ key: fixtureKey(), path: fixtureDirectory() });
    else if (command === 'ensure') output({ executable: await ensureExecutable() });
    else throw new Error(usage);
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
