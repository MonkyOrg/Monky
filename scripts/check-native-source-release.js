import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileHash } from '../apps/client/native/screen-share/scripts/packSources.cjs';
import { sourcesKey, SOURCES_KEY } from './native-cache-key.cjs';

export async function checkNativeSourceRelease(directory, version, commit, platform = 'win32',
  { sourcesKeyFor = sourcesKey } = {}) {
  assert.match(version, /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/iu);
  assert.match(commit, /^[a-f0-9]{40}$/u);
  assert.ok(['win32', 'darwin'].includes(platform));
  const basename = `monky-native-${platform === 'darwin' ? 'macos-' : ''}sources-${version}`;
  const metadata = JSON.parse(fs.readFileSync(path.join(directory, `${basename}.json`), 'utf8'));
  assert.ok([1, 2].includes(metadata.schemaVersion), 'Unsupported source manifest schema.');
  assert.equal(metadata.version, version);
  assert.equal(metadata.publicationReady, true, 'Never publish corresponding sources from a dirty worktree.');
  assert.equal(metadata.sourceCommit, commit, 'Native sources were built from another Monky commit.');
  if (metadata.schemaVersion === 2) {
    assert.match(metadata.builtFromCommit, /^[a-f0-9]{40}$/u);
    assert.match(metadata.sourceTree, /^[a-f0-9]{40}$/u);
    const { archive, archiveManifest, builtFromCommit, ...releaseManifest } = metadata;
    const otherTree = archiveManifest?.sourceTree !== metadata.sourceTree;
    if (otherTree) {
      // An archive packed at another commit is only publishable when the committed native inputs match.
      assert.match(archiveManifest?.sourceTree ?? '', /^[a-f0-9]{40}$/u, 'Reused source provenance has no source tree.');
      assert.ok(SOURCES_KEY.test(metadata.nativeSourceKey ?? ''),
        'Reused source provenance does not match the released source tree and dependencies.');
      assert.equal(metadata.nativeSourceKey, sourcesKeyFor(platform === 'darwin' ? 'mac' : 'win'),
        'Reused source provenance does not match the released native inputs.');
    }
    assert.deepEqual(archiveManifest, { ...releaseManifest, schemaVersion: 1, version: '0.0.0-ci',
      sourceCommit: builtFromCommit, monkySource: `https://github.com/MonkyOrg/Monky/tree/${builtFromCommit}`,
      ...(otherTree ? { sourceTree: archiveManifest.sourceTree } : {}) },
    'Reused source provenance does not match the released source tree and dependencies.');
  }
  assert.equal(metadata.webrtcRevision, '36ea4535a500ac137dbf1f577ce40dc1aaa774ef');
  if (platform === 'darwin') {
    assert.equal(metadata.platform, 'darwin');
    assert.deepEqual(metadata.architectures, ['arm64', 'x64']);
    const pins = JSON.parse(fs.readFileSync(new URL('../apps/client/native/screen-share/scripts/native-rtc/pins.json',
      import.meta.url), 'utf8'));
    for (const [name, pin] of Object.entries(pins.repositories)) {
      assert.equal(metadata.repositories?.[name]?.commit, pin.commit);
      assert.equal(metadata.repositories?.[name]?.url, pin.url);
    }
  } else {
    assert.equal(metadata.obsRevision, '7272af1375b38bc3cf4e0f98a5d999e8b76e9309');
    assert.ok(Array.isArray(metadata.repositories) && metadata.repositories.length >= 40);
    assert.ok(Array.isArray(metadata.libraries) && metadata.libraries.length >= 24);
  }
  assert.ok(Number.isSafeInteger(metadata.sourceFiles) && metadata.sourceFiles > 1000);
  assert.equal(metadata.archive.name, `${basename}.tar.xz`);
  const filename = path.join(directory, metadata.archive.name);
  const stat = fs.lstatSync(filename);
  assert.ok(stat.isFile() && stat.size > 1_000_000 && stat.size < 2_000_000_000);
  assert.equal(stat.size, metadata.archive.bytes);
  assert.equal(await fileHash(filename), metadata.archive.sha256, 'Corresponding-source archive checksum mismatch.');
  return metadata;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!(process.argv.length === 5 || process.argv.length === 6 && process.argv[5] === '--mac'))
    throw new Error('Usage: node scripts/check-native-source-release.js <directory> <version> <commit> [--mac]');
  const metadata = await checkNativeSourceRelease(path.resolve(process.argv[2]), process.argv[3], process.argv[4],
    process.argv[5] === '--mac' ? 'darwin' : 'win32');
  console.log(`Corresponding Source verified for ${metadata.version}, commit ${metadata.sourceCommit}.`);
}
