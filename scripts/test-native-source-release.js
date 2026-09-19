import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkNativeSourceRelease } from './check-native-source-release.js';

test('release source gate requires the same clean commit and actual matching source bytes', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-source-release-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const version = '9.0.0-beta', commit = 'a'.repeat(40);
  const name = `monky-native-sources-${version}`;
  const payload = Buffer.alloc(1_000_001, 42);
  const metadata = {
    schemaVersion: 1, version, sourceCommit: commit, publicationReady: true,
    webrtcRevision: '36ea4535a500ac137dbf1f577ce40dc1aaa774ef',
    obsRevision: '7272af1375b38bc3cf4e0f98a5d999e8b76e9309',
    sourceFiles: 1001, repositories: Array.from({ length: 40 }, () => ({})),
    libraries: Array.from({ length: 24 }, () => ({})),
    archive: { name: `${name}.tar.xz`, bytes: payload.length, sha256: crypto.createHash('sha256').update(payload).digest('hex') },
  };
  const save = value => fs.writeFileSync(path.join(directory, `${name}.json`), JSON.stringify(value));
  fs.writeFileSync(path.join(directory, metadata.archive.name), payload);
  save(metadata);
  assert.equal((await checkNativeSourceRelease(directory, version, commit)).sourceCommit, commit);
  save({ ...metadata, publicationReady: false });
  await assert.rejects(checkNativeSourceRelease(directory, version, commit), /dirty worktree/);
  save(metadata);
  await assert.rejects(checkNativeSourceRelease(directory, version, 'b'.repeat(40)), /another Monky commit/);
  payload[0] = 0;
  fs.writeFileSync(path.join(directory, metadata.archive.name), payload);
  await assert.rejects(checkNativeSourceRelease(directory, version, commit), /checksum mismatch/);
  fs.unlinkSync(path.join(directory, metadata.archive.name));
  await assert.rejects(checkNativeSourceRelease(directory, version, commit), /ENOENT/);
});
