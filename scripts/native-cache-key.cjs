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

module.exports = { cacheKey, inputs, inputsHash, toolchain };
if (require.main === module) {
  const [platform, ...rest] = process.argv.slice(2);
  if (rest.length) throw new Error('Usage: node scripts/native-cache-key.cjs <mac|win>');
  const tools = toolchain(platform);
  const key = cacheKey(platform, { tools });
  console.log(JSON.stringify({ key, toolchain: tools }, null, 2));
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `key=${key}\n`);
}
