'use strict';

// Corresponding sources restored from the cache, or about to be shared by the release, must be the
// exact archive CI packed for these committed native inputs before anything uses or shares them.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sourcesKey, SOURCES_KEY } = require('./native-cache-key.cjs');
const { fileHash } = require('../apps/client/native/screen-share/scripts/packSources.cjs');
const { verifyLegalFiles } = require('../apps/client/native/screen-share/scripts/checkPackage.cjs');

const root = path.resolve(__dirname, '..');
const native = 'apps/client/native/screen-share';
const archives = { win: 'release/monky-native-sources-0.0.0-ci', mac: 'release/monky-native-macos-sources-0.0.0-ci' };
// Windows notices belong to the cached runtime; macOS notices come from the same GN graph as its sources.
const cachePaths = {
  win: [`${archives.win}.json`, `${archives.win}.tar.xz`],
  mac: [`${archives.mac}.json`, `${archives.mac}.tar.xz`, `${native}/licenses`, `${native}/LICENSE`,
    `${native}/THIRD_PARTY_NOTICES`],
};

async function verifySources(platform, { base = root, key, legacyOk = false } = {}) {
  assert.ok(Object.hasOwn(archives, platform), 'Choose the mac or win corresponding sources.');
  const input = path.join(base, ...archives[platform].split('/'));
  const manifest = JSON.parse(fs.readFileSync(`${input}.json`, 'utf8'));
  assert.equal(manifest.schemaVersion, 1, 'Cached sources must be an unbound CI archive.');
  assert.equal(manifest.version, '0.0.0-ci');
  assert.equal(manifest.publicationReady, true, 'Cached sources were packed from a dirty checkout.');
  if (manifest.nativeSourceKey === undefined && legacyOk) return { key: '', legacy: true };
  assert.ok(SOURCES_KEY.test(manifest.nativeSourceKey ?? ''), 'Corresponding sources have no native source key.');
  assert.equal(manifest.nativeSourceKey, key ?? sourcesKey(platform, { base }),
    'Corresponding sources belong to other committed native inputs.');
  if (platform === 'mac') {
    assert.equal(manifest.platform, 'darwin');
    assert.deepEqual(manifest.architectures, ['arm64', 'x64']);
    verifyLegalFiles(path.join(base, ...native.split('/')), 'darwin');
  }
  assert.equal(manifest.archive?.name, `${path.basename(input)}.tar.xz`);
  assert.equal(fs.statSync(`${input}.tar.xz`).size, manifest.archive.bytes, 'Corresponding-source archive size mismatch.');
  assert.equal(await fileHash(`${input}.tar.xz`), manifest.archive.sha256, 'Corresponding-source archive checksum mismatch.');
  return { key: manifest.nativeSourceKey, legacy: false };
}

module.exports = { archives, cachePaths, verifySources };
if (require.main === module) {
  const [command, platform, ...flags] = process.argv.slice(2);
  (async () => {
    assert.ok(command === 'verify' && flags.every(flag => flag === '--legacy-ok') && flags.length <= 1,
      'Usage: node scripts/native-sources-cache.cjs verify <win|mac> [--legacy-ok]');
    const result = await verifySources(platform, { legacyOk: flags.includes('--legacy-ok') });
    console.log(JSON.stringify({ correspondingSourcesVerified: !result.legacy, platform, ...result }));
    if (result.legacy) console.log('::notice::CI artifact predates native source keys; it is not shared with later CI.');
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `key=${result.key}\n`);
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
