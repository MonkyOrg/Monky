'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { root, execute } = require('./buildTools.cjs');
const windowsToolchain = require('./windowsToolchain.cjs');

function build(config) {
  const toolchain = windowsToolchain.resolveWindowsToolchain(config);
  const env = windowsToolchain.msvcEnvironment(toolchain);
  const directory = path.resolve(root, '..', 'screen-audio');
  const job = path.join(root, 'build', 'tools', 'monky_msvc_job.exe');
  assert.ok(fs.existsSync(job), 'Run prepare:native-screen first to build the checkout-owned MSVC job wrapper.');
  const electronVersion = require('electron/package.json').version;
  assert.match(electronVersion, /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/u, 'Invalid installed Electron version; run npm ci first.');
  console.log(JSON.stringify({ windowsToolchain: windowsToolchain.summary(toolchain), electronVersion }));
  execute(process.execPath, [require.resolve('node-gyp/bin/node-gyp.js'), 'configure', '--release',
    `--directory=${directory}`, `--target=${electronVersion}`, '--arch=x64',
    '--dist-url=https://electronjs.org/headers', `--python=${toolchain.python}`,
    `--msvs_version=${toolchain.visualStudio.path}`], { env });
  const output = execute(job, [toolchain.compilerDirectory, toolchain.msbuild,
    path.join(directory, 'build', 'binding.sln'), '/nologo', '/clp:Verbosity=minimal',
    '/m:1', '/nr:false', '/t:Rebuild', '/p:Configuration=Release;Platform=x64',
    ...windowsToolchain.msbuildArguments(toolchain)], { cwd: directory, env, capture: true });
  const cleanup = JSON.parse(output.match(/^MONKY_MSVC_CLEANUP (.+)$/mu)?.[1] ?? 'null');
  assert.equal(cleanup?.msbuildExitCode, 0);
  assert.equal(cleanup?.remainingOwnedHelpers, 0);
  const binary = path.join(directory, 'build', 'Release', 'screen_audio.node');
  assert.ok(fs.lstatSync(binary).isFile(), 'screen_audio.node was not produced.');
  console.log(JSON.stringify({ screenAudioBuilt: true, electronVersion, binary }));
}

module.exports = { build };
if (require.main === module) {
  try { build(windowsToolchain.options(process.argv.slice(2))); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
