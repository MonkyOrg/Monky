'use strict';

// Exact content key for compiled native outputs. Any change to sources, recipes, pins or the
// compiling toolchain selects another key, so a cache hit can only return what a rebuild produces.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const native = 'apps/client/native/screen-share';
const inputs = {
  mac: [`${native}/src/mac`, `${native}/src/rtc`, `${native}/scripts`],
  win: [`${native}/src`, `${native}/scripts`, 'scripts/legal.cjs', 'LICENSE'],
};
// Corresponding-source archives hold the pinned upstream trees plus these checkout files (maintained
// patches, the native README and legal notices). They do not depend on the compiling toolchain.
const sourceInputs = {
  mac: [...inputs.mac, `${native}/README.md`, `${native}/README.en.md`, 'scripts/legal.cjs', 'LICENSE'],
  win: [...inputs.win, `${native}/README.md`, `${native}/README.en.md`, 'patches/h264-profile-level-id+2.3.3.patch'],
};
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function files(relative, base = root) {
  const filename = path.join(base, ...relative.split('/'));
  const stat = fs.lstatSync(filename);
  if (stat.isSymbolicLink()) throw new Error(`Native cache inputs cannot be aliases: ${relative}`);
  if (stat.isFile()) return [relative];
  return fs.readdirSync(filename).sort().flatMap(name => files(`${relative}/${name}`, base));
}

function inputsHash(platform, base = root) {
  const entries = inputs[platform].flatMap(relative => files(relative, base)).sort();
  return sha256(entries.map(relative =>
    `${relative}\0${sha256(fs.readFileSync(path.join(base, ...relative.split('/'))))}\n`).join(''));
}

function output(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function toolchain(platform, env = process.env) {
  if (!Object.hasOwn(inputs, platform)) throw new Error('Choose the mac or win native cache key.');
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const common = { platform, builderArch: process.arch, image: env.ImageOS ?? '', node: process.version,
    nodeGyp: lock.packages['node_modules/node-gyp']?.version ?? '' };
  if (platform === 'mac') return { ...common, xcode: output('xcodebuild', ['-version']),
    sdk: output('xcrun', ['--sdk', 'macosx', '--show-sdk-version']), python: output('python3.11', ['--version']) };
  return { ...common, vs: env.VSCMD_VER ?? '', msvc: env.VCToolsVersion ?? '', windowsSdk: env.WindowsSDKVersion ?? '',
    python: output(env.PYTHON || 'python', ['--version']) };
}

function cacheKey(platform, { tools, base = root } = {}) {
  if (!Object.hasOwn(inputs, platform)) throw new Error('Choose the mac or win native cache key.');
  return `native-${platform}-v1-${sha256(JSON.stringify(tools ?? toolchain(platform))).slice(0, 16)}-${inputsHash(platform, base)}`;
}

// Git tree/blob ids of the committed inputs: identical on every OS (no CRLF/LF difference), so the
// Ubuntu release gate computes the same key as the Windows and macOS jobs that packed the archive.
function sourcesKey(platform, { base = root, revision = 'HEAD' } = {}) {
  if (!Object.hasOwn(sourceInputs, platform)) throw new Error('Choose the mac or win native sources key.');
  const ids = sourceInputs[platform].map(relative => `${relative}\0${execFileSync('git', ['rev-parse', '--verify',
    `${revision}:${relative}`], { cwd: base, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()}`);
  return `native-sources-${platform}-v1-${sha256(ids.join('\n'))}`;
}

const SOURCES_KEY = /^native-sources-(mac|win)-v1-[a-f0-9]{64}$/u;

module.exports = { cacheKey, inputs, inputsHash, toolchain, sourceInputs, sourcesKey, SOURCES_KEY };
if (require.main === module) {
  const [platform, ...rest] = process.argv.slice(2);
  if (rest.length) throw new Error('Usage: node scripts/native-cache-key.cjs <mac|win>');
  const tools = toolchain(platform);
  const key = cacheKey(platform, { tools }), sources = sourcesKey(platform);
  console.log(JSON.stringify({ key, sourcesKey: sources, toolchain: tools }, null, 2));
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `key=${key}\nsources_key=${sources}\n`);
}
