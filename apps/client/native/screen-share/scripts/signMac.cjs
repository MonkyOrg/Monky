'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fingerprint, execute } = require('./buildTools.cjs');
const { verifyMacRuntime } = require('./checkPackage.cjs');

async function signMac(options) {
  const { signAsync: sign } = require('@electron/osx-sign');
  const bin = path.join(options.app, 'Contents', 'Resources', 'app', 'node_modules', '@monky', 'screen-share', 'bin');
  const directories = ['arm64', 'x64'].filter(arch => fs.existsSync(path.join(bin, `darwin-${arch}`)));
  assert.equal(directories.length, 1, 'Package exactly one native macOS architecture per application.');
  const arch = directories[0], directory = path.join(bin, `darwin-${arch}`);
  verifyMacRuntime(directory, arch);
  const signing = { ...options, identity: options.identity ?? '-', identityValidation: false };
  if (!options.identity)
    console.warn('[NativeScreen] No Developer ID: producing an ad-hoc local build, not a notarized release.');
  await sign(signing);
  for (const [name, key] of [['mac-capture-build.json', 'executable'], ['rtc-build.json', 'binaries']]) {
    const filename = path.join(directory, name), manifest = JSON.parse(fs.readFileSync(filename, 'utf8'));
    const records = Array.isArray(manifest[key]) ? manifest[key] : [manifest[key]];
    for (const record of records) {
      const binary = path.join(directory, record.name);
      execute('codesign', ['--verify', '--strict', binary]);
      record.buildSha256 ??= record.sha256;
      Object.assign(record, fingerprint(binary));
    }
    fs.writeFileSync(filename, JSON.stringify(manifest, null, 2) + '\n');
  }
  verifyMacRuntime(directory, arch);
  // Nested code is already signed. Seal the updated manifests without signing
  // those binaries again; electron-builder notarizes only after this returns.
  await sign({ ...signing, ignore: file => file !== options.app });
  execute('codesign', ['--verify', '--deep', '--strict', options.app]);
}

module.exports = signMac;
