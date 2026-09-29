'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { test } = require('node:test');
const { fingerprint, regularFiles } = require('../scripts/buildTools.cjs');
const { verifyMacRuntime, detachPackagedHardLinks } = require('../scripts/checkPackage.cjs');

test('the Mac GPL notice is a bundle resource, while other desktop platforms keep their root notice', () => {
  const { build } = require('../../../package.json');
  const license = { from: '../../LICENSE', to: 'LICENSE' };
  assert.equal(build.extraFiles, undefined, 'Files directly under Contents are treated as nested code by codesign.');
  assert.deepEqual(build.mac.extraResources, [license]);
  assert.deepEqual(build.win.extraFiles, [license]);
  assert.deepEqual(build.linux.extraFiles, [license]);
  assert.ok(build.files.includes('!node_modules/**/build/node_gyp_bins{,/**/*}'),
    'Generated node-gyp interpreter symlinks must never escape into the distributed application.');
});

test('CI hard links become independent package files before license refresh and signing', t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-package-hardlinks-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, 'source'), packaged = path.join(temporary, 'packaged');
  const files = ['licenses/libsdptransform/LICENSE', 'bin/darwin-arm64/rtc-build.json',
    'bin/darwin-arm64/monky-screen-mac'];
  for (const relative of files) {
    const original = path.join(source, relative), destination = path.join(packaged, relative);
    fs.mkdirSync(path.dirname(original), { recursive: true });
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(original, `original ${relative}`, { mode: 0o755 });
    fs.linkSync(original, destination);
    assert.ok(fs.lstatSync(destination).nlink > 1);
  }
  detachPackagedHardLinks(packaged);
  for (const relative of files) {
    const original = path.join(source, relative), destination = path.join(packaged, relative);
    assert.equal(fs.lstatSync(destination).nlink, 1);
    assert.deepEqual(fingerprint(destination), fingerprint(original));
    assert.equal(fs.statSync(destination).mode & 0o777, fs.statSync(original).mode & 0o777);
  }
  fs.cpSync(path.join(source, 'licenses'), path.join(packaged, 'licenses'), { recursive: true });
  for (const relative of files) {
    fs.appendFileSync(path.join(packaged, relative), ' packaged update');
    assert.equal(fs.readFileSync(path.join(source, relative), 'utf8'), `original ${relative}`);
  }
  const before = files.map(relative => fs.statSync(path.join(packaged, relative), { bigint: true }).ino);
  detachPackagedHardLinks(packaged);
  assert.deepEqual(files.map(relative => fs.statSync(path.join(packaged, relative), { bigint: true }).ino), before);
  assert.deepEqual(regularFiles(packaged), files.map(relative => path.normalize(relative)).sort());
});

function fixture(t) {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-mac-distribution-'));
  t.after(() => fs.rmSync(app, { recursive: true, force: true }));
  const directory = path.join(app, 'Contents', 'Resources', 'app', 'node_modules', '@monky',
    'screen-share', 'bin', 'darwin-arm64');
  fs.mkdirSync(directory, { recursive: true });
  const binary = name => {
    fs.writeFileSync(path.join(directory, name), `owned fixture ${name}`);
    return { name, ...fingerprint(path.join(directory, name)) };
  };
  const capture = { schemaVersion: 1, platform: 'darwin', arch: 'arm64', minimumMacOS: '14.0',
    executable: binary('monky-screen-mac') };
  const rtc = { schemaVersion: 1, platform: 'darwin', arch: 'arm64', minimumMacOS: '14.0',
    webrtcRevision: '36ea4535a500ac137dbf1f577ce40dc1aaa774ef',
    binaries: ['libmonky_av1.dylib', 'libmonky_screen_rtc.dylib', 'monky_native_surfaces.node', 'monky_screen_rtc.node'].map(binary),
    capabilities: { abiVersion: 2, contractRevision: 8, externallyEncodedH264: true, externallyEncodedAV1: true,
      encodedInputCopied: true, encodedFeedback: true, encodedProfileLevelId: '4d003c',
      encodedBitrateCeilingBps: 80000000, pairedCaptureClock: true, p2pReceiverRouting: true,
      inputLeaseCorrelation: true, decodedOutput: 'NV12_IOSURFACE_LEASE', runtimeQualified: false,
      hardwareExecutionObserved: null, inputFormat: null, inputTimebase: 'mach-host-us' },
  };
  fs.writeFileSync(path.join(directory, 'mac-capture-build.json'), JSON.stringify(capture));
  fs.writeFileSync(path.join(directory, 'rtc-build.json'), JSON.stringify(rtc));
  return { app, directory, records: [capture.executable, ...rtc.binaries] };
}

test('packaged macOS binaries require matching architecture, hashes and compiled capabilities', t => {
  const f = fixture(t);
  verifyMacRuntime(f.directory, 'arm64');
  assert.throws(() => verifyMacRuntime(f.directory, 'x64'));
  fs.appendFileSync(path.join(f.directory, 'monky_screen_rtc.node'), 'modified');
  assert.throws(() => verifyMacRuntime(f.directory, 'arm64'), /size or type changed/);
});

test('code signing refreshes native hashes before sealing the outer app without signing binaries twice', async t => {
  const f = fixture(t), executions = [];
  const filename = path.resolve(__dirname, '..', 'scripts', 'signMac.cjs');
  const localRequire = createRequire(filename), module = { exports: {} };
  const calls = [];
  const signAsync = async options => {
    calls.push(options);
    if (calls.length === 1) {
      for (const record of f.records) fs.appendFileSync(path.join(f.directory, record.name), 'signed');
    } else {
      assert.equal(options.ignore(f.app), false);
      for (const record of f.records) assert.equal(options.ignore(path.join(f.directory, record.name)), true);
      verifyMacRuntime(f.directory, 'arm64');
    }
  };
  const requireForTest = name => {
    if (name === './buildTools.cjs') return { fingerprint, execute: (...args) => executions.push(args) };
    if (name === '@electron/osx-sign') return { signAsync };
    return localRequire(name);
  };
  vm.runInThisContext(`(function(require, module, exports) { ${fs.readFileSync(filename, 'utf8')}\n})`,
    { filename })(requireForTest, module, module.exports);
  await module.exports({ app: f.app, identity: 'owned-signing-fixture', platform: 'darwin' },
    { appInfo: { productFilename: 'Fixture' } });
  assert.equal(calls.length, 2);
  assert.equal(executions.length, 6);
  assert.equal(fs.statSync(path.join(f.directory, 'monky-screen-mac')).mode & 0o111, 0o111,
    'The packaged macOS capture host must keep the execute bit or macOS refuses to spawn it.');
  const rtc = JSON.parse(fs.readFileSync(path.join(f.directory, 'rtc-build.json')));
  for (const record of rtc.binaries) {
    assert.equal(record.buildSha256, f.records.find(before => before.name === record.name).sha256);
    assert.notEqual(record.buildSha256, record.sha256);
  }
});
