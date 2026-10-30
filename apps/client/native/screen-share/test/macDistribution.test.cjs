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
      decodedOutput: 'NV12_IOSURFACE_LEASE', runtimeQualified: false,
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

const leaf = 'DEC3889A0A2B3B2FEF11F31ACAC90AB68BE5B108';
const signedRequirement = `designated => identifier "com.monky.app" and certificate leaf = H"${leaf.toLowerCase()}"`;

// Output of `security find-identity -p codesigning <keychain>`. An identity macOS
// trusts is listed twice: once as matching and once as valid.
function identityListing(matching, valid = []) {
  const entries = (hashes, suffix) => hashes.map((hash, index) => `  ${index + 1}) ${hash} "Monky Code Signing"${suffix}`);
  return ['Policy: Code Signing', '  Matching identities',
    ...entries(matching, valid.length ? '' : ' (CSSMERR_TP_NOT_TRUSTED)'), `     ${matching.length} identities found`, '',
    '  Valid identities only', ...entries(valid, ''), `     ${valid.length} valid identities found`].join('\n');
}

function loadSigner(f, { identities = '', requirement = signedRequirement } = {}) {
  const filename = path.resolve(__dirname, '..', 'scripts', 'signMac.cjs');
  const localRequire = createRequire(filename), module = { exports: {} };
  const calls = [], executions = [], chmods = [];
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
  const execute = (file, args, options) => {
    executions.push([file, args, options]);
    if (file === '/usr/bin/security') return identities;
    if (args[0] === '--display') return requirement;
  };
  const requireForTest = name => {
    if (name === './buildTools.cjs') return { fingerprint, execute };
    if (name === '@electron/osx-sign') return { signAsync };
    if (name === 'node:fs') return {
      ...fs,
      chmodSync(filename, mode) {
        chmods.push([filename, mode]);
        fs.chmodSync(filename, mode);
      },
    };
    return localRequire(name);
  };
  vm.runInThisContext(`(function(require, module, exports) { ${fs.readFileSync(filename, 'utf8')}\n})`,
    { filename })(requireForTest, module, module.exports);
  const sign = options => module.exports({ app: f.app, platform: 'darwin', ...options },
    { appInfo: { productFilename: 'Fixture' } });
  return { sign, calls, executions, chmods };
}

test('code signing refreshes native hashes before sealing the outer app without signing binaries twice', async t => {
  t.mock.method(console, 'log', () => {});
  const f = fixture(t), { sign, calls, executions, chmods } = loadSigner(f);
  const optionsForFile = () => ({ hardenedRuntime: true });
  await sign({ identity: 'owned-signing-fixture', optionsForFile });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(options => [options.identity, options.optionsForFile]),
    [['owned-signing-fixture', optionsForFile], ['owned-signing-fixture', optionsForFile]],
    'An identity electron-builder resolved, such as a Developer ID, keeps its timestamp for notarization.');
  assert.equal(executions.length, 7);
  assert.deepEqual(executions.at(-1), ['codesign', ['--display', '--requirements', '-', f.app], { capture: true }]);
  const executable = path.join(f.directory, 'monky-screen-mac');
  assert.deepEqual(chmods, [[executable, 0o755]]);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(executable).mode & 0o111, 0o111,
      'The packaged macOS capture host must keep the execute bit or macOS refuses to spawn it.');
  }
  const rtc = JSON.parse(fs.readFileSync(path.join(f.directory, 'rtc-build.json')));
  for (const record of rtc.binaries) {
    assert.equal(record.buildSha256, f.records.find(before => before.name === record.name).sha256);
    assert.notEqual(record.buildSha256, record.sha256);
  }
});

test('without a release certificate the app stays ad-hoc signed and the build warns that permissions will be asked again', async t => {
  const warn = t.mock.method(console, 'warn', () => {});
  const { sign, calls, executions } = loadSigner(fixture(t));
  await sign({});
  assert.deepEqual(calls.map(options => options.identity), ['-', '-']);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /ad-hoc build, so macOS asks again for the permissions/);
  assert.equal(executions.length, 6);
  assert.ok(executions.every(([file, args]) => file === 'codesign' && args[0] === '--verify'));
});

test('the self-signed release certificate is selected by hash from the keychain electron-builder imported it into', async t => {
  t.mock.method(console, 'log', () => {});
  const keychain = '/tmp/monky-release-fixture.keychain';
  const optionsForFile = file => ({ entitlements: `${file}.plist`, hardenedRuntime: true, timestamp: undefined });
  for (const identities of [identityListing([leaf]), identityListing([leaf], [leaf])]) {
    const f = fixture(t), { sign, calls, executions } = loadSigner(f, { identities });
    await sign({ keychain, optionsForFile });
    assert.deepEqual(executions[0], ['/usr/bin/security', ['find-identity', '-p', 'codesigning', keychain], { capture: true }]);
    assert.deepEqual(calls.map(options => [options.identity, options.keychain, options.identityValidation]),
      [[leaf, keychain, false], [leaf, keychain, false]]);
    // Without notarization nothing reads Apple's timestamp, and requesting it per file slows every release.
    for (const options of calls)
      assert.deepEqual(options.optionsForFile(f.app), { entitlements: `${f.app}.plist`, hardenedRuntime: true, timestamp: 'none' });
    assert.deepEqual(executions.at(-1), ['codesign', ['--display', '--requirements', '-', f.app], { capture: true }]);
  }
});

test('a release keychain without exactly one signing identity fails the build instead of falling back to ad-hoc', async t => {
  const other = '0123456789ABCDEF0123456789ABCDEF01234567';
  for (const [identities, found] of [[identityListing([]), 0], [identityListing([leaf, other]), 2]]) {
    const { sign, calls } = loadSigner(fixture(t), { identities });
    await assert.rejects(sign({ keychain: '/tmp/monky-release-fixture.keychain' }),
      new RegExp(`found ${found}\\. Check the certificate in CSC_LINK`));
    assert.equal(calls.length, 0);
  }
});

test('a certificate signature whose designated requirement only matches this build is rejected', async t => {
  t.mock.method(console, 'log', () => {});
  for (const [requirement, message] of [
    ['# designated => cdhash H"0123456789abcdef0123456789abcdef01234567"', /updates would lose them/],
    ['', /no designated requirement/],
  ]) {
    const { sign, chmods } = loadSigner(fixture(t), { identities: identityListing([leaf]), requirement });
    await assert.rejects(sign({ keychain: '/tmp/monky-release-fixture.keychain' }), message);
    assert.deepEqual(chmods, []);
  }
});
