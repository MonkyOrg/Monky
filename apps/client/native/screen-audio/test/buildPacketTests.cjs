'use strict';

// Builds the device-free PCM capture double and core_controls.exe that packetCapture.test.cjs loads,
// for the Node running this script. Uses the MSVC already on PATH (CI) or finds it with vswhere.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const screenAudio = path.resolve(__dirname, '..');
const output = process.env.MONKY_PACKET_CAPTURE_TEST_DIR || path.join(screenAudio, 'build', 'packet-tests');
const common = ['/nologo', '/EHsc', '/std:c++17', '/MD', '/O1', '/DNOMINMAX', '/DWIN32_LEAN_AND_MEAN',
  '/D_WIN32_WINNT=0x0A00', '/DWINVER=0x0A00'];

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(executable)} failed with exit ${result.status ?? result.signal}`);
}

function msvcEnvironment() {
  if (process.env.VCINSTALLDIR && spawnSync('where', ['cl'], { stdio: 'ignore' }).status === 0) return process.env;
  const vswhere = path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
    'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (!fs.existsSync(vswhere)) throw new Error('MSVC not found: run from a Developer prompt or install Visual Studio Build Tools.');
  const found = spawnSync(vswhere, ['-latest', '-products', '*', '-requires',
    'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8' });
  const installation = found.stdout?.trim().split(/\r?\n/u)[0];
  const vcvars = installation && path.join(installation, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
  if (!vcvars || !fs.existsSync(vcvars)) throw new Error('vcvars64.bat not found: install the MSVC x64 build tools.');
  const dump = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"call "${vcvars}" >nul && set"`],
    { encoding: 'utf8', windowsVerbatimArguments: true, maxBuffer: 16 * 1024 * 1024 });
  if (dump.status !== 0) throw new Error(`vcvars64.bat failed: ${dump.stderr}`);
  const env = {};
  for (const line of dump.stdout.split(/\r?\n/u)) {
    const separator = line.indexOf('=', 1);
    if (separator > 0) env[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return env;
}

function nodeHeaders() {
  if (process.env.MONKY_PCM_TEST_NODE) return process.env.MONKY_PCM_TEST_NODE;
  const devdir = path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'node-gyp', 'Cache');
  const nodeGyp = require.resolve('node-gyp/bin/node-gyp.js', { paths: [screenAudio] });
  // --ensure reuses the cached headers and import library; it downloads only when they are missing.
  run(process.execPath, [nodeGyp, 'install', process.versions.node, '--ensure', `--devdir=${devdir}`]);
  return path.join(devdir, process.versions.node);
}

function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw new Error('The packet capture double is built only on Windows x64.');
  const env = msvcEnvironment();
  const headers = nodeHeaders();
  const addonApi = path.dirname(require.resolve('node-addon-api/package.json', { paths: [screenAudio] }));
  const source = (...parts) => path.join(screenAudio, ...parts);
  fs.rmSync(output, { recursive: true, force: true });
  for (const name of ['capture_double', 'core_controls']) fs.mkdirSync(path.join(output, name, 'obj'), { recursive: true });
  run('cl', [...common, '/DNAPI_DISABLE_CPP_EXCEPTIONS', '/DNAPI_VERSION=8', '/D_HAS_EXCEPTIONS=1',
    '/DMONKY_PACKET_CAPTURE_TEST', `/I${path.join(headers, 'include', 'node')}`, `/I${addonApi}`, '/LD',
    source('test', 'capture_double.cpp'), source('src', 'packet_capture.cpp'), source('src', 'win', 'wasapi_format.cpp'),
    `/Fo${path.join(output, 'capture_double', 'obj')}\\`, `/Fe${path.join(output, 'capture_double', 'capture_double.node')}`,
    '/link', '/INCREMENTAL:NO', path.join(headers, 'x64', 'node.lib'), 'ksuser.lib'], { env });
  run('cl', [...common, source('test', 'core_controls.cpp'), source('src', 'win', 'wasapi_format.cpp'),
    `/Fo${path.join(output, 'core_controls', 'obj')}\\`, `/Fe${path.join(output, 'core_controls', 'core_controls.exe')}`,
    '/link', '/INCREMENTAL:NO', 'ksuser.lib'], { env });
  fs.writeFileSync(path.join(output, 'build-report.json'), `${JSON.stringify({
    nodeVersion: process.versions.node, hardwareUsed: false, functionalAddonLoaded: false, productionAddonUnchanged: true,
  }, null, 2)}\n`);
  console.log(`Packet capture double built for Node ${process.versions.node} in ${output}`);
}

try { main(); }
catch (error) { console.error(error.message ?? error); process.exitCode = 1; }
