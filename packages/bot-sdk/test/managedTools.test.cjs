const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { test } = require('node:test');
const {
  ManagedToolDownloadError,
  MANAGED_NODE_VERSION,
  findManagedToolAsset,
  findManagedNodeAsset,
  downloadManagedToolAsset,
  managedNodeArtifact,
  managedFfmpegArchiveEntry,
} = require('../dist/managedTools');

const checksum = (value) => createHash('sha256').update(value).digest('hex');
const signal = () => new AbortController().signal;
const failure = (code) => (error) => error instanceof ManagedToolDownloadError && error.code === code;

async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'monky-managed-tools-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function fixtureAsset(value = Buffer.from('controlled executable fixture')) {
  return {
    name: 'yt-dlp.exe',
    url: 'https://github.com/yt-dlp/yt-dlp/releases/download/fixture/yt-dlp.exe',
    size: value.length,
    sha256: checksum(value),
    version: 'fixture',
  };
}

test('portable Node recipes select exact artifacts without system lookup or arbitrary architecture paths', () => {
  assert.deepEqual(managedNodeArtifact('win32', 'x64'), { name: 'win-x64/node.exe', entry: null });
  assert.deepEqual(managedNodeArtifact('win32', 'arm64'), { name: 'win-arm64/node.exe', entry: null });
  for (const platform of ['linux', 'darwin']) {
    for (const arch of ['x64', 'arm64']) {
      const root = `node-v${MANAGED_NODE_VERSION}-${platform}-${arch}`;
      assert.deepEqual(managedNodeArtifact(platform, arch), { name: `${root}.tar.gz`, entry: `${root}/bin/node` });
    }
  }
  assert.throws(() => managedNodeArtifact('linux', '../../other'), failure('assetInvalid'));
  assert.throws(() => managedNodeArtifact('win32', 'ia32'), failure('assetInvalid'));
  assert.throws(() => managedNodeArtifact('aix', 'x64'), failure('assetInvalid'));
});

test('Node integrity comes from the official release manifest and a bounded exact-size HEAD response', async (t) => {
  const { name } = managedNodeArtifact('win32', 'x64');
  const prefix = `https://nodejs.org/dist/v${MANAGED_NODE_VERSION}/`;
  const digest = 'a'.repeat(64);
  const calls = [];
  t.mock.method(global, 'fetch', async (input, options) => {
    calls.push(String(input));
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Authorization, undefined);
    if (String(input) === `${prefix}SHASUMS256.txt`) return new Response(`${digest}  ${name}\n`);
    assert.equal(String(input), `${prefix}${name}`);
    assert.equal(options.method, 'HEAD');
    return new Response(null, { headers: { 'Content-Length': '12345' } });
  });
  assert.deepEqual(await findManagedNodeAsset('win32', 'x64', signal()), {
    name, url: `${prefix}${name}`, size: 12345, sha256: digest, version: `v${MANAGED_NODE_VERSION}`,
  });
  assert.equal(calls.length, 2);
});

test('Node rejects ambiguous checksums and missing or oversized asset size', async (t) => {
  const name = managedNodeArtifact('win32', 'x64').name;
  let duplicate = true;
  let length = null;
  t.mock.method(global, 'fetch', async (input) => {
    if (String(input).endsWith('SHASUMS256.txt')) {
      return new Response(`${'a'.repeat(64)}  ${name}\n`.repeat(duplicate ? 2 : 1));
    }
    return new Response(null, { headers: length === null ? {} : { 'Content-Length': length } });
  });
  await assert.rejects(findManagedNodeAsset('win32', 'x64', signal()), failure('checksumAmbiguous'));
  duplicate = false;
  await assert.rejects(findManagedNodeAsset('win32', 'x64', signal()), failure('assetInvalid'));
  length = String(400 * 1024 * 1024);
  await assert.rejects(findManagedNodeAsset('win32', 'x64', signal()), failure('assetInvalid'));
});

test('GitHub assets require an approved repository, exact release URL and unique metadata', async (t) => {
  const asset = fixtureAsset();
  let duplicate = false;
  let url = asset.url;
  t.mock.method(global, 'fetch', async (_input, options) => {
    assert.equal(options.headers.Authorization, undefined);
    const entry = { name: asset.name, browser_download_url: url, size: asset.size, digest: `sha256:${asset.sha256}` };
    return new Response(JSON.stringify({
      draft: false, prerelease: false, tag_name: 'fixture', assets: duplicate ? [entry, entry] : [entry],
    }));
  });
  assert.deepEqual(await findManagedToolAsset('yt-dlp/yt-dlp', asset.name, signal()), asset);
  await assert.rejects(findManagedToolAsset('unapproved/repository', asset.name, signal()), failure('downloadOrigin'));
  duplicate = true;
  await assert.rejects(findManagedToolAsset('yt-dlp/yt-dlp', asset.name, signal()), failure('assetInvalid'));
  duplicate = false;
  url = 'https://github.com/other/project/releases/download/fixture/yt-dlp.exe';
  await assert.rejects(findManagedToolAsset('yt-dlp/yt-dlp', asset.name, signal()), failure('assetInvalid'));
});

test('portable macOS FFmpeg requires upstream integrity metadata rather than an unchecked binary or Homebrew', async (t) => {
  let digest = null;
  t.mock.method(global, 'fetch', async () => new Response(JSON.stringify({
    draft: false, prerelease: false, tag_name: 'fixture',
    assets: [{
      name: 'ffmpeg-darwin-arm64',
      browser_download_url: 'https://github.com/eugeneware/ffmpeg-static/releases/download/fixture/ffmpeg-darwin-arm64',
      size: 100,
      digest,
    }],
  })));
  await assert.rejects(findManagedToolAsset('eugeneware/ffmpeg-static', 'ffmpeg-darwin-arm64', signal()), failure('checksumMissing'));
  digest = `sha256:${'a'.repeat(64)}`;
  assert.equal((await findManagedToolAsset('eugeneware/ffmpeg-static', 'ffmpeg-darwin-arm64', signal())).sha256, 'a'.repeat(64));
});

test('downloads stream to exclusive files and only finish after matching byte count and SHA256', async (t) => {
  const root = await directory(t);
  const value = Buffer.from('controlled executable fixture');
  const asset = fixtureAsset(value);
  const destination = path.join(root, 'candidate');
  let verified = 0;
  const progress = [];
  t.mock.method(global, 'fetch', async (input, options) => {
    assert.equal(String(input), asset.url);
    assert.equal(options.headers.Authorization, undefined);
    return new Response(value);
  });
  await downloadManagedToolAsset(asset, destination, signal(), {
    onProgress: (update) => progress.push(update),
    onVerify: () => verified++,
  });
  assert.deepEqual(await fs.readFile(destination), value);
  assert.equal(verified, 1);
  assert.equal(progress.at(-1).receivedBytes, value.length);
  await assert.rejects(downloadManagedToolAsset(asset, destination, signal()), { code: 'EEXIST' });
  const badHash = path.join(root, 'bad-hash');
  await assert.rejects(downloadManagedToolAsset({ ...asset, sha256: '0'.repeat(64) }, badHash, signal()), failure('downloadMismatch'));
  await fs.unlink(badHash);
  await assert.rejects(downloadManagedToolAsset({ ...asset, size: value.length - 1 }, path.join(root, 'large'), signal()), failure('downloadTooLarge'));
});

test('redirects cannot leave approved HTTPS origins or attach credentials', async (t) => {
  const root = await directory(t);
  const asset = fixtureAsset();
  let target = 'https://unapproved.example/tool.exe';
  t.mock.method(global, 'fetch', async () => new Response(null, { status: 302, headers: { location: target } }));
  await assert.rejects(downloadManagedToolAsset(asset, path.join(root, 'outside'), signal()), failure('downloadOrigin'));
  target = 'https://user:secret@github.com/tool.exe';
  await assert.rejects(downloadManagedToolAsset(asset, path.join(root, 'credentials'), signal()), failure('downloadOrigin'));
  target = 'http://github.com/tool.exe';
  await assert.rejects(downloadManagedToolAsset(asset, path.join(root, 'insecure'), signal()), failure('downloadOrigin'));
});

test('cancellation closes partial output and never emits a verified success', async (t) => {
  const root = await directory(t);
  const value = Buffer.from('controlled executable fixture');
  const asset = fixtureAsset(value);
  const controller = new AbortController();
  const destination = path.join(root, 'cancelled');
  let verified = false;
  t.mock.method(global, 'fetch', async () => new Response(value));
  await assert.rejects(downloadManagedToolAsset(asset, destination, controller.signal, {
    onProgress: (progress) => {
      if (progress.receivedBytes > 0) controller.abort(new Error('Cancelled fixture'));
    },
    onVerify: () => { verified = true; },
  }), /Cancelled fixture/);
  assert.equal(verified, false);
  await fs.unlink(destination);
});

test('archive selection cannot extract arbitrary or traversal members', () => {
  assert.equal(managedFfmpegArchiveEntry('ffmpeg-master-latest-linux64-gpl.tar.xz'), 'ffmpeg-master-latest-linux64-gpl/bin/ffmpeg');
  assert.equal(managedFfmpegArchiveEntry('ffmpeg-master-latest-winarm64-gpl.zip'), 'ffmpeg-master-latest-winarm64-gpl/bin/ffmpeg.exe');
  for (const name of ['../../file.tar.xz', 'unknown.zip', 'ffmpeg-master-latest-win64-gpl.zip\n']) {
    assert.throws(() => managedFfmpegArchiveEntry(name), failure('archiveUnsupported'));
  }
});
