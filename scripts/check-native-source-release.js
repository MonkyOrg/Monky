import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileHash } from '../apps/client/native/screen-share/scripts/packSources.cjs';

export async function checkNativeSourceRelease(directory, version, commit) {
  assert.match(version, /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/iu);
  assert.match(commit, /^[a-f0-9]{40}$/u);
  const basename = `monky-native-sources-${version}`;
  const metadata = JSON.parse(fs.readFileSync(path.join(directory, `${basename}.json`), 'utf8'));
  assert.equal(metadata.schemaVersion, 1);
  assert.equal(metadata.version, version);
  assert.equal(metadata.publicationReady, true, 'Never publish corresponding sources from a dirty worktree.');
  assert.equal(metadata.sourceCommit, commit, 'Native sources were built from another Monky commit.');
  assert.equal(metadata.webrtcRevision, '36ea4535a500ac137dbf1f577ce40dc1aaa774ef');
  assert.equal(metadata.obsRevision, '7272af1375b38bc3cf4e0f98a5d999e8b76e9309');
  assert.ok(Number.isSafeInteger(metadata.sourceFiles) && metadata.sourceFiles > 1000);
  assert.ok(Array.isArray(metadata.repositories) && metadata.repositories.length >= 40);
  assert.ok(Array.isArray(metadata.libraries) && metadata.libraries.length >= 24);
  assert.equal(metadata.archive.name, `${basename}.tar.xz`);
  const filename = path.join(directory, metadata.archive.name);
  const stat = fs.lstatSync(filename);
  assert.ok(stat.isFile() && stat.size > 1_000_000 && stat.size < 2_000_000_000);
  assert.equal(stat.size, metadata.archive.bytes);
  assert.equal(await fileHash(filename), metadata.archive.sha256, 'Corresponding-source archive checksum mismatch.');
  return metadata;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 5) throw new Error('Usage: node scripts/check-native-source-release.js <directory> <version> <commit>');
  const metadata = await checkNativeSourceRelease(path.resolve(process.argv[2]), process.argv[3], process.argv[4]);
  console.log(`Corresponding Source verified for ${metadata.version}, commit ${metadata.sourceCommit}.`);
}
