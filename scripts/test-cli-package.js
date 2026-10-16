/**
 * Installs the packed CLI tarball the way install.sh does — a global install
 * into an empty prefix — and proves every runtime dependency is delivered.
 *
 * Bundled packages make npm skip fetching their dependencies, so a tarball can
 * pack and install cleanly yet crash on first run (missing `debug` in 39.3.7).
 * Nothing pre-installed can mask such a gap here.
 *
 * Usage: node scripts/test-cli-package.js <monky-cli-*.tgz>
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { runNpm } from '../packages/bot-sdk/dist/tooling/process.js';

const tarball = path.resolve(process.argv[2] || '');
assert.ok(process.argv[2] && fs.statSync(tarball).isFile(), 'Pass the CLI tarball to test.');
const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'monky-cli-package-')));
const prefix = path.join(workspace, 'prefix');
const env = {
  ...process.env, NODE_PATH: '', NODE_OPTIONS: '', MONKY_HOME: path.join(workspace, 'home'),
  npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false',
};

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** Mirrors Node's lookup, but only accepts packages delivered inside the install prefix. */
function findInstalled(packageDir, name) {
  for (const directory of createRequire(path.join(packageDir, 'package.json')).resolve.paths(name) ?? []) {
    const candidate = path.join(directory, name);
    if (inside(prefix, candidate) && fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
  }
  return null;
}

function installedPackages(root) {
  const packages = [root];
  const modules = path.join(root, 'node_modules');
  if (!fs.existsSync(modules)) return packages;
  for (const entry of fs.readdirSync(modules)) {
    if (entry.startsWith('.')) continue;
    const dirs = entry.startsWith('@')
      ? fs.readdirSync(path.join(modules, entry)).map(scoped => path.join(modules, entry, scoped))
      : [path.join(modules, entry)];
    for (const dir of dirs) if (fs.existsSync(path.join(dir, 'package.json'))) packages.push(...installedPackages(dir));
  }
  return packages;
}

try {
  runNpm(['install', '--global', '--prefix', prefix, '--prefer-offline', '--ignore-scripts', tarball],
    { cwd: workspace, env, timeout: 300_000 });
  const globalModules = process.platform === 'win32' ? path.join(prefix, 'node_modules') : path.join(prefix, 'lib', 'node_modules');
  const cliRoot = path.join(globalModules, '@monky', 'server');
  const manifest = readJson(path.join(cliRoot, 'package.json'));

  const missing = [];
  for (const packageDir of installedPackages(cliRoot)) {
    const pkg = readJson(path.join(packageDir, 'package.json'));
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      if (!findInstalled(packageDir, name)) missing.push(`${pkg.name} -> ${name}`);
    }
  }
  assert.deepEqual(missing, [], 'Every runtime dependency of the installed CLI must be delivered.');
  for (const name of manifest.bundleDependencies) {
    assert.ok(fs.existsSync(path.join(cliRoot, 'node_modules', name, 'package.json')), `${name} must ship in the tarball.`);
  }

  // The reported crash: mediasoup's logger requiring `debug` on every command.
  const mediasoup = findInstalled(cliRoot, 'mediasoup');
  assert.ok(mediasoup, 'mediasoup must be installed.');
  const debug = createRequire(path.join(mediasoup, 'node', 'lib', 'Logger.js')).resolve('debug');
  assert.ok(inside(prefix, debug), `debug resolved outside the install: ${debug}`);
  assert.equal(readJson(path.join(findInstalled(cliRoot, 'h264-profile-level-id'), 'package.json')).version, '2.3.3');

  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.monky;
  const output = execFileSync(process.execPath, ['--no-global-search-paths', path.join(cliRoot, bin), '--version'], {
    cwd: workspace, env, encoding: 'utf8', timeout: 30_000,
  }).trim();
  assert.equal(output, `monky ${manifest.version}`);
  console.log(`CLI tarball installed into an empty prefix with all runtime dependencies; "${output}" ran.`);
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}
