'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fingerprint, execute } = require('./buildTools.cjs');
const { verifyMacRuntime } = require('./checkPackage.cjs');

// electron-builder only resolves identities that macOS trusts. The release
// certificate is self-signed: electron-builder imports it into a temporary
// keychain and leaves choosing the identity to this custom signer.
function signingIdentity(options) {
  if (options.identity) return options.identity;
  if (!options.keychain) {
    console.warn('[NativeScreen] No signing certificate: producing an ad-hoc build, so macOS asks again for the permissions granted to the previous version.');
    return '-';
  }
  const listed = execute('/usr/bin/security', ['find-identity', '-p', 'codesigning', options.keychain], { capture: true });
  const identities = new Set(Array.from(listed.matchAll(/^\s*\d+\)\s+([0-9A-F]{40})\s/gm), match => match[1]));
  assert.equal(identities.size, 1,
    `Expected one code signing identity in ${options.keychain}, found ${identities.size}. Check the certificate in CSC_LINK.`);
  return [...identities][0];
}

async function signMac(options) {
  const { signAsync: sign } = require('@electron/osx-sign');
  const bin = path.join(options.app, 'Contents', 'Resources', 'app', 'node_modules', '@monky', 'screen-share', 'bin');
  const directories = ['arm64', 'x64'].filter(arch => fs.existsSync(path.join(bin, `darwin-${arch}`)));
  assert.equal(directories.length, 1, 'Package exactly one native macOS architecture per application.');
  const arch = directories[0], directory = path.join(bin, `darwin-${arch}`);
  verifyMacRuntime(directory, arch);
  const identity = signingIdentity(options);
  const signing = { ...options, identity, identityValidation: false };
  if (!options.identity && identity !== '-') {
    // Only notarization needs Apple's secure timestamp, and a self-signed
    // certificate cannot be notarized. Requesting one per file would add
    // thousands of calls to timestamp.apple.com, and minutes, to each release.
    signing.optionsForFile = file => ({ ...options.optionsForFile?.(file), timestamp: 'none' });
  }
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
  if (signing.identity !== '-') {
    // macOS keeps the permissions granted to the app while its designated
    // requirement stays the same. A cdhash requirement matches this build only.
    const requirement = execute('codesign', ['--display', '--requirements', '-', options.app], { capture: true });
    assert.match(requirement, /designated => /, 'The signed app has no designated requirement.');
    assert.doesNotMatch(requirement, /cdhash/,
      `The signature ties macOS permissions to this build only, so updates would lose them: ${requirement}`);
    console.log(`[NativeScreen] ${requirement}`);
  }
  // electron-builder copies packaged files with a stripped 0644 mask, but macOS
  // refuses to spawn the capture host without the execute bit (EACCES surfaces as
  // "could not load screens"). Restore it as the final packaging step; Unix
  // permission bits are not part of the code signature, so this keeps it valid.
  const { executable } = JSON.parse(fs.readFileSync(path.join(directory, 'mac-capture-build.json'), 'utf8'));
  fs.chmodSync(path.join(directory, executable.name), 0o755);
}

module.exports = signMac;
