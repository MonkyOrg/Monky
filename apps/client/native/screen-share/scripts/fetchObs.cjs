'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { finished, pipeline } = require('node:stream/promises');
const { root, execute, write, verify, fingerprint } = require('./buildTools.cjs');

const repository = path.resolve(root, '..', '..', '..', '..');
const cache = path.join(repository, '.native-screen');
const obs = require('../src/vendor/obs/sources.json');
const runtime = require('../src/vendor/obs/runtime-inputs.json');
const recipesRevision = '21e25b2b508598ce8239de9ecd68400e45559399';
const recipeFiles = [
  'deps.ffmpeg/10-zlib.ps1', 'deps.ffmpeg/20-opus.ps1', 'deps.ffmpeg/30-libogg.ps1',
  'deps.ffmpeg/30-libvorbis.ps1', 'deps.ffmpeg/30-libvpx.ps1', 'deps.ffmpeg/30-svt-av1.ps1',
  'deps.ffmpeg/40-aom.ps1', 'deps.ffmpeg/40-x264.ps1', 'deps.ffmpeg/50-libtheora.ps1',
  'deps.ffmpeg/60-lame.ps1', 'deps.ffmpeg/60-mbedtls.ps1', 'deps.ffmpeg/60-srt.ps1',
  'deps.ffmpeg/70-librist.ps1', 'deps.ffmpeg/70-nv-codec.ps1', 'deps.ffmpeg/80-amf.ps1',
  'deps.ffmpeg/99-ffmpeg.ps1', 'deps.windows/30-curl.ps1', 'deps.windows/30-jansson.ps1',
  'deps.windows/40-detours.ps1', 'deps.windows/60-nlohmann-json.ps1',
  'deps.windows/60-simde.ps1', 'deps.windows/60-uthash.ps1',
  'deps.windows/70-vpl.ps1', 'deps.windows/80-wil.ps1',
];

function gitEnvironment() {
  const configuration = path.join(cache, 'empty-gitconfig');
  if (!fs.existsSync(configuration)) fs.writeFileSync(configuration, '', { flag: 'wx' });
  assert.ok(fs.lstatSync(configuration).isFile() && fs.statSync(configuration).size === 0,
    'Native source Git configuration must remain empty.');
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_/iu.test(key)) delete env[key];
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: configuration, GIT_TERMINAL_PROMPT: '0' };
}

function git(directory, args) {
  const hooks = path.join(cache, 'empty-git-hooks');
  if (!fs.existsSync(hooks)) fs.mkdirSync(hooks);
  assert.ok(fs.lstatSync(hooks).isDirectory() && !fs.lstatSync(hooks).isSymbolicLink() &&
    fs.readdirSync(hooks).length === 0, 'Native source Git hooks must remain disabled.');
  return execute('git', ['-c', 'core.longpaths=true', '-c', 'core.autocrlf=false', '-c', 'core.eol=lf',
    '-c', 'core.hooksPath=' + hooks, '-c', 'core.fsmonitor=false',
    '-c', 'protocol.file.allow=never', '-C', directory, ...args],
  { env: gitEnvironment(), capture: true });
}

function assertPinnedSubmodules(state) {
  for (const line of state.split(/\r?\n/u).filter(Boolean))
    assert.match(line, /^ ?[a-f0-9]{40} .+$/u, 'Missing or modified source submodule.');
}

function checkout(url, revision, directory, { submodules = true } = {}) {
  assert.ok(url.startsWith('https://') && url.endsWith('.git'));
  assert.match(revision, /^[a-f0-9]{40}$/u);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
    console.log(`Source: ${url} @ ${revision}`);
    git(directory, ['-c', 'init.templateDir=', 'init', '--quiet']);
    for (const [name, value] of [['core.autocrlf', 'false'], ['core.eol', 'lf'], ['core.fsmonitor', 'false']])
      git(directory, ['config', '--local', name, value]);
    git(directory, ['remote', 'add', 'origin', url]);
    git(directory, ['fetch', '--quiet', '--depth=1', 'origin', revision]);
    git(directory, ['checkout', '--quiet', '--detach', 'FETCH_HEAD']);
    if (submodules) git(directory, ['submodule', 'update', '--quiet', '--init', '--recursive', '--depth=1']);
  }
  assert.ok(fs.lstatSync(directory).isDirectory() && !fs.lstatSync(directory).isSymbolicLink());
  assert.ok(fs.lstatSync(path.join(directory, '.git')).isDirectory());
  assert.equal(git(directory, ['remote', 'get-url', 'origin']), url);
  assert.equal(git(directory, ['rev-parse', 'HEAD']), revision, `Source revision changed: ${directory}`);
  assert.equal(git(directory, ['status', '--porcelain', '--untracked-files=normal']), '',
    `Source tree is not clean: ${directory}`);
  if (submodules) {
    const state = git(directory, ['submodule', 'status', '--recursive']);
    assertPinnedSubmodules(state);
  }
  return directory;
}

function readRecipe(directory, relative) {
  const filename = path.join(directory, ...relative.split('/'));
  const contents = fs.readFileSync(filename, 'utf8').split(/\r?\nfunction /u)[0];
  const literal = name => {
    const match = contents.match(new RegExp(`\\[string\\]\\s+\\$${name}\\s*=\\s*(['"])([^'"\\r\\n]*)\\1`, 'u'));
    if (!match && name === 'Hash') {
      const platformHashes = contents.match(/\[hashtable\]\s+\$Hashes\s*=\s*@\{([^}]+)\}/u)?.[1];
      const x64 = platformHashes?.match(/^\s*x64\s*=\s*['"]([a-f0-9]{40})['"]\s*$/mu)?.[1];
      assert.ok(x64, `Missing literal x64 source Hash: ${relative}`);
      return x64;
    }
    assert.ok(match, `Missing literal ${name}: ${relative}`);
    return match[2];
  };
  const name = literal('Name'), version = literal('Version'), url = literal('Uri'), hash = literal('Hash');
  assert.match(name, /^[a-z0-9-]+$/iu);
  assert.equal(new URL(url).protocol, 'https:');
  if (url.endsWith('.git')) {
    assert.match(hash, /^[a-f0-9]{40}$/u);
    return { name, version, url, revision: hash, recipe: relative };
  }
  const checksum = hash.match(/^\$\{PSScriptRoot\}\/checksums\/([a-z0-9_.-]+\.sha256)$/iu);
  assert.ok(checksum, `Unsupported source checksum format: ${relative}`);
  const xml = fs.readFileSync(path.join(path.dirname(filename), 'checksums', checksum[1]), 'utf8');
  assert.ok(xml.includes('<S N="Algorithm">SHA256</S>'));
  const sha256 = xml.match(/<S N="Hash">([a-f0-9]{64})<\/S>/iu)?.[1].toLowerCase();
  assert.ok(sha256, `Missing source SHA-256: ${relative}`);
  return { name, version, url, sha256, recipe: relative };
}

async function archiveResponse(url, signal, redirects = 0) {
  const address = new URL(url);
  assert.ok(address.protocol === 'https:' && !address.username && !address.password,
    'Native archives require HTTPS without URL credentials.');
  // Node 22 fetch can terminate the process with an undici parser assertion on SourceForge.
  const response = await new Promise((resolve, reject) => {
    const request = https.get(address, {
      signal, headers: { 'User-Agent': 'Monky-native-source-builder', 'Accept-Encoding': 'identity' },
    }, value => {
      value.once('error', reject);
      resolve(value);
    });
    request.once('error', reject);
  });
  if (response.statusCode === 200) return response;
  response.resume();
  await finished(response, { cleanup: true });
  assert.ok([301, 302, 303, 307, 308].includes(response.statusCode),
    `Native archive download failed (${response.statusCode}): ${address}`);
  assert.ok(redirects < 10 && typeof response.headers.location === 'string',
    'Native archive redirect is missing its location or exceeds its limit.');
  return archiveResponse(new URL(response.headers.location, address), signal, redirects + 1);
}

async function download(record) {
  const extension = new URL(record.url).pathname.match(/\.(?:tar\.gz|tar\.xz|zip)$/u)?.[0];
  assert.ok(extension, `Unsupported native archive: ${record.url}`);
  const directory = path.join(cache, 'downloads');
  fs.mkdirSync(directory, { recursive: true });
  const filename = path.join(directory, record.sha256 + extension);
  if (fs.existsSync(filename)) {
    const actual = fingerprint(filename);
    assert.equal(actual.sha256, record.sha256);
    if (record.bytes !== undefined) assert.equal(actual.bytes, record.bytes);
    return filename;
  }
  const temporary = filename + '.' + crypto.randomUUID() + '.part';
  console.log(`Archive: ${record.url}`);
  try {
    const response = await archiveResponse(record.url, AbortSignal.timeout(600_000));
    await pipeline(response, fs.createWriteStream(temporary, { flags: 'wx' }));
    const actual = fingerprint(temporary);
    assert.equal(actual.sha256, record.sha256, `Archive checksum mismatch: ${record.url}`);
    if (record.bytes !== undefined) assert.equal(actual.bytes, record.bytes);
    fs.renameSync(temporary, filename);
    return filename;
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function safeArchiveEntries(listing) {
  const entries = listing.split(/\r?\n/u).filter(Boolean);
  assert.ok(entries.length > 0, 'Empty native source archive.');
  for (const entry of entries) {
    const components = entry.replaceAll('\\', '/').split('/');
    assert.ok(!entry.startsWith('/') && !entry.startsWith('\\') && !entry.includes(':') &&
      !components.includes('..'), `Unsafe native archive entry: ${entry}`);
  }
  return entries;
}

async function extract(record, directory) {
  const archive = await download(record);
  const marker = path.join(directory, '.monky-archive.json');
  const expected = { url: record.url, sha256: record.sha256 };
  if (fs.existsSync(directory)) {
    assert.ok(fs.lstatSync(directory).isDirectory() && !fs.lstatSync(directory).isSymbolicLink());
    assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), expected, `Unowned extraction: ${directory}`);
    return directory;
  }
  safeArchiveEntries(execute('tar', ['-tf', archive], { capture: true }));
  fs.mkdirSync(directory, { recursive: true });
  execute('tar', ['-xf', archive, '-C', directory], { capture: true });
  write(marker, JSON.stringify(expected) + '\n');
  return directory;
}

async function fetchObs({ sources = true } = {}) {
  fs.mkdirSync(cache, { recursive: true });
  const stock = await extract(runtime.archive, path.join(cache, 'obs-runtime'));
  const dependencies = await extract(obs.dependencies, path.join(cache, 'obs-dependencies'));
  for (const file of runtime.files) verify(path.join(stock, file.path), file);
  for (const file of obs.dependencies.files) verify(path.join(dependencies, file.path), file);
  if (!sources) return { stock, dependencies };
  const studio = checkout('https://github.com/obsproject/obs-studio.git', obs.revision,
    path.join(cache, 'obs-studio'), { submodules: false });
  for (const file of obs.files) verify(path.join(studio, file.path), file);
  const recipes = checkout('https://github.com/obsproject/obs-deps.git', recipesRevision, path.join(cache, 'obs-deps'));
  const acquired = [];
  for (const relative of recipeFiles) {
    const record = readRecipe(recipes, relative);
    if (record.revision) {
      const directory = path.join(cache, 'obs-sources', record.name);
      checkout(record.url, record.revision, directory);
      acquired.push({ ...record, directory: path.relative(cache, directory) });
    } else {
      const archive = await download(record);
      acquired.push({ ...record, archive: path.relative(cache, archive) });
    }
  }
  const manifest = {
    schemaVersion: 1, obsRevision: obs.revision, recipesRevision,
    sources: acquired,
  };
  write(path.join(cache, 'obs-sources.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { stock, dependencies, studio, recipes, manifest };
}

module.exports = { cache, checkout, readRecipe, archiveResponse, download, extract, safeArchiveEntries, assertPinnedSubmodules, fetchObs, recipeFiles };
if (require.main === module) {
  const args = process.argv.slice(2);
  assert.ok(args.length === 0 || (args.length === 1 && args[0] === '--runtime-only'));
  fetchObs({ sources: args.length === 0 }).then(result => {
    console.log(JSON.stringify({ obsInputsReady: true, sources: result.manifest?.sources.length ?? 0 }));
  }).catch(error => { console.error(error); process.exitCode = 1; });
}
