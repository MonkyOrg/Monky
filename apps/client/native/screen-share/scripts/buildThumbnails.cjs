'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { root, execute, write, fingerprint, regularFiles, verify } = require('./buildTools.cjs');
const windows = require('./windowsToolchain.cjs');
const quote = value => {
  assert.equal(/["%!\r\n]/u.test(value), false);
  return `"${value}"`;
};
function options(argv) {
  const result = { buildDirectory: path.join(root, 'build', 'thumbnail-production'),
    output: path.join(root, 'bin', 'win32-x64'), job: path.join(root, 'build', 'tools', 'monky_msvc_job.exe') };
  const seen = new Set();
  for (const argument of argv) {
    const at = argument.indexOf('='), key = argument.slice(0, at), value = argument.slice(at + 1);
    assert.ok(at > 0 && value && !seen.has(key), 'Expected unique --option=absolute-path arguments.');
    seen.add(key);
    if (key === '--build-root') result.buildDirectory = value;
    else if (key === '--out') result.output = value;
    else if (key === '--job') result.job = value;
    else if (!windows.selectionOption(result, key, value)) throw new Error(`Unknown thumbnail build option: ${key}`);
  }
  for (const value of Object.values(result)) assert.ok(path.isAbsolute(value));
  return result;
}
function build(config) {
  assert.equal(process.platform, 'win32'); assert.equal(process.arch, 'x64');
  const toolchain = windows.resolveWindowsToolchain(config), env = windows.msvcEnvironment(toolchain);
  const source = path.join(root, 'src', 'thumbnail');
  const sourceFiles = regularFiles(source).map(file => ({ path: file, ...fingerprint(path.join(source, file)) }));
  const sourceRecipe = fingerprint(__filename);
  fs.mkdirSync(config.buildDirectory, { recursive: true });
  const lock = path.join(config.buildDirectory, 'thumbnail.lock'), handle = fs.openSync(lock, 'wx');
  try {
    const commands = [];
    for (const [name, input, output] of [
      ['host', 'host.cpp', 'monky-screen-thumbnail.exe'],
      ['contracts', 'contractTest.cpp', 'thumbnail-contract-test.exe'],
    ]) {
      const response = path.join(config.buildDirectory, `${name}.rsp`);
      const args = ['/nologo', '/std:c++20', '/EHsc', '/MT', '/W4', '/WX', '/O2', '/utf-8', '/Brepro',
        quote(path.join(source, input)), `/Fo${quote(path.join(config.buildDirectory, `${name}.obj`))}`,
        `/Fe${quote(path.join(config.buildDirectory, output))}`,
        '/link', '/INCREMENTAL:NO', 'd3d11.lib', 'dxgi.lib', 'dwmapi.lib', 'windowsapp.lib',
        'windowscodecs.lib', 'ole32.lib', 'user32.lib'];
      write(response, args.join(' ') + '\n');
      const log = execute(config.job, [toolchain.compilerDirectory,
        path.join(toolchain.compilerDirectory, 'cl.exe'), `@${response}`],
      { cwd: config.buildDirectory, env, capture: true, timeout: 120000 });
      write(path.join(config.buildDirectory, `${name}.log`), log + '\n');
      const cleanup = JSON.parse(log.match(/^MONKY_MSVC_CLEANUP (.+)$/mu)?.[1] ?? 'null');
      assert.equal(cleanup?.msbuildExitCode, 0); assert.equal(cleanup?.remainingOwnedHelpers, 0);
      commands.push(name);
    }
    const contracts = JSON.parse(execute(path.join(config.buildDirectory, 'thumbnail-contract-test.exe'), [],
      { env, capture: true, timeout: 5000 }));
    assert.equal(contracts.deviceFree, true); assert.ok(contracts.checks >= 35);
    const started = Date.now();
    const watchdog = spawnSync(path.join(config.buildDirectory, 'thumbnail-contract-test.exe'), ['--watchdog-probe'],
      { env, windowsHide: true, encoding: 'utf8', timeout: 8000 });
    if (watchdog.error) throw watchdog.error;
    assert.equal(watchdog.status, 124);
    assert.equal(watchdog.stdout, ''); assert.equal(watchdog.stderr, '');
    assert.ok(Date.now() - started >= 4000 && Date.now() - started < 8000);
    contracts.watchdog = { deviceFree: true, forcedOwnProcessExit: 124, maximumLifetimeMs: 4500 };
    for (const file of sourceFiles) verify(path.join(source, file.path), file);
    verify(__filename, sourceRecipe);
    const host = path.join(config.buildDirectory, 'monky-screen-thumbnail.exe');
    write(path.join(config.output, 'monky-screen-thumbnail.exe'), fs.readFileSync(host));
    const report = { schemaVersion: 1, host: { path: 'monky-screen-thumbnail.exe', ...fingerprint(host) },
      sourceFiles, sourceRecipe, contracts, commands, staticCrt: true };
    write(path.join(config.output, 'thumbnail-build.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
    return report;
  } finally { fs.closeSync(handle); fs.unlinkSync(lock); }
}
module.exports = { build, options };
if (require.main === module) {
  try { build(options(process.argv.slice(2))); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
