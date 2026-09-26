'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { root, execute, write, fingerprint, regularFiles } = require('./buildTools.cjs');

function build({ arch = process.arch } = {}) {
  assert.equal(process.platform, 'darwin', 'ScreenCaptureKit must be compiled with the macOS SDK on a Mac.');
  assert.ok(['arm64', 'x64'].includes(arch), 'Native macOS capture supports arm64 or x64.');
  const source = path.join(root, 'src', 'mac'), output = path.join(root, 'bin', `darwin-${arch}`);
  const buildDirectory = path.join(root, 'build', `mac-${arch}`);
  fs.mkdirSync(buildDirectory, { recursive: true });
  const lock = path.join(buildDirectory, 'compile.lock'), owner = fs.openSync(lock, 'wx');
  try {
    const sdk = execute('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { capture: true });
    const executable = path.join(buildDirectory, 'monky-screen-mac');
    execute('xcrun', ['--sdk', 'macosx', 'clang++', '-std=c++20', '-fobjc-arc', '-fblocks', '-O2',
      '-Wall', '-Wextra', '-Werror', '-mmacosx-version-min=14.0',
      '-arch', arch === 'x64' ? 'x86_64' : 'arm64', '-isysroot', sdk,
      path.join(source, 'host.mm'), '-framework', 'Foundation', '-framework', 'AppKit',
      '-framework', 'ScreenCaptureKit', '-framework', 'CoreGraphics', '-o', executable]);
    const tests = arch === process.arch
      ? JSON.parse(execute(executable, ['--self-test'], { capture: true })) : null;
    if (tests) assert.equal(tests.deviceFree, true);
    execute('codesign', ['--force', '--sign', '-', executable]);
    write(path.join(output, 'monky-screen-mac'), fs.readFileSync(executable));
    fs.chmodSync(path.join(output, 'monky-screen-mac'), 0o755);
    const manifest = {
      schemaVersion: 1, platform: 'darwin', arch, minimumMacOS: '14.0',
      executable: { name: 'monky-screen-mac', ...fingerprint(executable) },
      sourceFiles: regularFiles(source).map(name => ({ path: name, ...fingerprint(path.join(source, name)) })),
      sourceRecipe: fingerprint(__filename), tests,
    };
    write(path.join(output, 'mac-capture-build.json'), JSON.stringify(manifest, null, 2) + '\n');
    console.log(JSON.stringify(manifest));
    return manifest;
  } finally { fs.closeSync(owner); fs.unlinkSync(lock); }
}
module.exports = { build };
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    assert.ok(args.length <= 1 && (!args.length || /^--arch=(x64|arm64)$/.test(args[0])));
    build(args.length ? { arch: args[0].slice(7) } : {});
  } catch (error) { console.error(error); process.exitCode = 1; }
}
