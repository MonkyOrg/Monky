import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const client = path.join(root, 'apps', 'client');
const require = createRequire(path.join(client, 'package.json'));

if (process.platform !== 'win32') throw new Error('Use the platform-specific electron-builder targets for macOS.');

const electron = require('electron');
const installed = JSON.parse(execFileSync(electron, ['-p',
  'JSON.stringify({version:process.versions.electron,platform:process.platform,arch:process.arch})',
], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' }));
assert.deepEqual(installed, {
  version: require(path.join(client, 'package.json')).build.electronVersion,
  platform: 'win32',
  arch: 'x64',
}, 'The installed Electron distribution must match the Windows x64 packaging target.');

execFileSync(process.execPath, [
  require.resolve('electron-builder/out/cli/cli.js'),
  '--projectDir', client, '--win', 'zip', '--x64', '--publish', 'never',
  // Reuse pinned Electron and Node-based cleanup; Go unpack can stall on existing Windows outputs.
  `-c.electronDist=${path.dirname(electron)}`,
  '-c.win.artifactName=Monky-Windows.zip',
], { cwd: client, stdio: 'inherit' });

console.log(`Portable application: ${path.join(root, 'release', 'win-unpacked', 'Monky.exe')}`);
console.log(`Archive: ${path.join(root, 'release', 'Monky-Windows.zip')}`);
