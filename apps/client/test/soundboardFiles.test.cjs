const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID, createHash } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { test } = require('node:test');
const shared = require('@monky/shared');
const { SoundboardFiles } = require('../dist-electron/main/soundboardFiles.js');
const { SoundboardDownloads } = require('../dist-electron/main/soundboardDownload.js');
const { createSoundboardEncoder } = require('../dist-electron/main/soundboardEncoder.js');
const { authoredOggPreview } = require('./fixtures/authoredAudio.cjs');

const rate = 48000;
const times = { start: 0.25, end: 1.25, fadeIn: 0.2, fadeOut: 0.3 };
const channels = [new Float32Array(rate * 2).fill(0.5), new Float32Array(rate * 2).fill(-0.25)];
const original = Buffer.from(shared.encodeSoundboardEdit(channels, rate, { start: 0, end: 2, fadeIn: 0, fadeOut: 0 }).bytes);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = reason => ({ status: 'failed', reason });

async function fixture(t) {
  const root = path.resolve(__dirname, '..', 'dist-test', `soundboard-files-${randomUUID()}`);
  await fs.mkdir(root, { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const folders = new SoundboardDownloads(path.join(root, 'folder.json'));
  const folder = await folders.getDefaultFolder();
  await fs.writeFile(path.join(folder, 'source.wav'), original);
  return { root, folder, folders, files: new SoundboardFiles(folders), input: { folder, fileName: 'source.wav' } };
}

test('real disk rename/delete update names and bytes, never overwrite another file', async t => {
  const { files, folder, input } = await fixture(t);
  const read = await files.read(input);
  assert.equal(read.status, 'ok'); assert.equal(hash(read.value), hash(original));
  await fs.writeFile(path.join(folder, 'existing.wav'), Buffer.from('untouched'));
  assert.deepEqual(await files.rename({ ...input, newFileName: 'existing.wav' }), fail('exists'));
  assert.equal(await fs.readFile(path.join(folder, 'existing.wav'), 'utf8'), 'untouched');
  const renamed = await files.rename({ ...input, newFileName: 'renamed.wav' });
  assert.deepEqual(renamed, { status: 'ok', value: { fileName: 'renamed.wav', filePath: path.join(folder, 'renamed.wav') } });
  await assert.rejects(fs.stat(path.join(folder, 'source.wav')), { code: 'ENOENT' });
  assert.equal(hash(await fs.readFile(renamed.value.filePath)), hash(original));
  assert.deepEqual(await files.delete({ ...input, fileName: 'renamed.wav' }), { status: 'ok', value: null });
  await assert.rejects(fs.stat(renamed.value.filePath), { code: 'ENOENT' });
  assert.deepEqual(await files.delete(input), fail('missing'));
});

test('filesystem operations reject traversal, unsupported/reserved names and unconfirmed folders', async t => {
  const { files, root, folder, input } = await fixture(t);
  for (const fileName of ['..\\source.wav', '../source.wav', path.join(folder, 'source.wav'), 'NUL.wav', 'source.txt', 'audio.wav:stream', '.wav', 'a.wav ', 'x\0.wav']) {
    for (const method of ['read', 'rename', 'delete', 'edit']) {
      assert.deepEqual(await files[method]({ ...input, fileName, newFileName: 'safe.wav' }), fail('invalid_request'), `${method} ${fileName}`);
    }
  }
  for (const newFileName of ['../escaped.wav', 'renamed.mp3', 'CON.wav']) {
    assert.deepEqual(await files.rename({ ...input, newFileName }), fail('invalid_request'));
  }
  await fs.writeFile(path.join(root, 'outside.wav'), original);
  assert.deepEqual(await files.delete({ folder: root, fileName: 'outside.wav' }), fail('no_folder'));
  assert.equal(hash(await fs.readFile(path.join(root, 'outside.wav'))), hash(original));
  assert.equal(hash(await fs.readFile(path.join(folder, 'source.wav'))), hash(original));
});

test('symlink/junction folders, linked entries and hardlinked files are never mutated', async t => {
  const { files, root, folder, input } = await fixture(t);
  const alias = path.join(root, 'alias');
  await fs.symlink(folder, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(await files.delete({ folder: alias, fileName: 'source.wav' }), fail('no_folder'));
  const linked = path.join(folder, 'directory.wav');
  await fs.symlink(root, linked, process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(await files.delete({ ...input, fileName: 'directory.wav' }), fail('invalid_request'));
  await fs.link(path.join(folder, 'source.wav'), path.join(root, 'hardlink.wav'));
  assert.deepEqual(await files.delete(input), fail('invalid_request'));
  assert.deepEqual(await files.rename({ ...input, newFileName: 'new.wav' }), fail('invalid_request'));
  assert.equal(hash(await fs.readFile(path.join(root, 'hardlink.wav'))), hash(original));
  await fs.unlink(linked);
  await fs.unlink(alias);
});

test('real edited PCM24 WAV has exact duration, linear fades, preserved stereo and unchanged original', async t => {
  const { files, folder, input } = await fixture(t);
  const saved = await files.edit({ ...input, newFileName: 'copy.wav', sampleRate: rate, channels, ...times });
  assert.equal(saved.status, 'ok'); assert.equal(saved.value.duration, 1);
  const wav = await fs.readFile(saved.value.filePath);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt32LE(4) + 8, wav.length);
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 2);
  assert.equal(wav.readUInt32LE(24), rate);
  assert.equal(wav.readUInt16LE(34), 24);
  assert.equal(wav.readUInt32LE(40) / 6 / rate, 1);
  const sample = (frame, channel) => wav.readIntLE(44 + (frame * 2 + channel) * 3, 3) / 8388608;
  assert.equal(sample(0, 0), 0); assert.equal(sample(rate - 1, 0), 0);
  assert.ok(Math.abs(sample(rate * 0.1, 0) - 0.25) < 2e-7);
  assert.ok(Math.abs(sample(rate * 0.2, 0) - 0.5) < 2e-7);
  assert.ok(Math.abs(sample(rate - 1 - rate * 0.15, 0) - 0.25) < 2e-7);
  assert.ok(Math.abs(sample(rate / 2, 1) + 0.25) < 2e-7);
  assert.equal(hash(await fs.readFile(path.join(folder, 'source.wav'))), hash(original));
  assert.deepEqual(await files.edit({ ...input, newFileName: 'copy.wav', sampleRate: rate, channels, ...times }), fail('exists'));
  assert.deepEqual(await files.edit({ ...input, newFileName: 'source.wav', sampleRate: rate, channels, ...times }), fail('exists'));
  assert.equal(hash(await fs.readFile(path.join(folder, 'source.wav'))), hash(original));
});

test('trim boundaries select the actual samples; mono odd-sized WAV has valid RIFF padding', () => {
  const ramp = Float32Array.from({ length: 100 }, (_, index) => index / 100);
  const result = shared.encodeSoundboardEdit([ramp], rate, { start: 10 / rate, end: 13 / rate, fadeIn: 0, fadeOut: 0 });
  const bytes = Buffer.from(result.bytes);
  assert.equal(result.duration, 3 / rate);
  assert.equal(bytes.length, 54); assert.equal(bytes.readUInt32LE(40), 9);
  for (let index = 0; index < 3; index++) {
    assert.ok(Math.abs(bytes.readIntLE(44 + index * 3, 3) / 8388608 - (10 + index) / 100) < 2e-7);
  }
});

test('PCM24 representable samples round-trip exactly when neither trimmed nor faded', () => {
  const samples = [1, 1048576, 4194304, 8388607, -4194304, -8388608];
  const pcm = Float32Array.from(samples, value => value / 8388608);
  const wav = Buffer.from(shared.encodeSoundboardEdit([pcm], rate, {
    start: 0, end: samples.length / rate, fadeIn: 0, fadeOut: 0,
  }).bytes);
  assert.deepEqual(samples.map((_, index) => wav.readIntLE(44 + index * 3, 3)), samples);
});

test('finite bounds and supported channels remain enforced independently of file size or duration', async t => {
  const { files, folder, input } = await fixture(t);
  const base = { ...input, newFileName: 'invalid.wav', sampleRate: rate, channels, ...times };
  for (const extra of [
    { start: NaN }, { end: Infinity }, { fadeIn: -1 }, { start: -0.1 }, { end: 3 }, { end: times.start },
    { fadeIn: 0.8, fadeOut: 0.8 }, { channels: [new Float32Array([NaN])] , start: 0, end: 1 / rate, fadeIn: 0, fadeOut: 0 },
  ]) assert.deepEqual(await files.edit({ ...base, ...extra }), fail('invalid_request'));
  for (const extra of [
    { sampleRate: 44100 }, { channels: [] }, { channels: [channels[0], new Float32Array(2)] },
    { channels: [...channels, channels[0]] },
  ]) assert.deepEqual(await files.edit({ ...base, ...extra }), fail('unsupported'));
  await assert.rejects(fs.stat(path.join(folder, 'invalid.wav')), { code: 'ENOENT' });
});

test('editor reads, copies and overwrites real files above 3 MiB and 120 seconds without network caps', async t => {
  const { files, folder, input } = await fixture(t);
  const longChannels = [new Float32Array(rate * 131).fill(0.125)];
  const longSource = Buffer.from(shared.encodeSoundboardEdit(longChannels, rate, {
    start: 0, end: 131, fadeIn: 0, fadeOut: 0,
  }).bytes);
  assert.ok(longSource.length > shared.LIMITS.MAX_SOUNDBOARD_FILE_SIZE);
  await fs.writeFile(path.join(folder, input.fileName), longSource);
  const opened = await files.openEditor(input);
  assert.equal(opened.status, 'ok');
  assert.deepEqual(Buffer.from(opened.value.bytes), longSource);
  const request = { ...input, channels: longChannels, sampleRate: rate, start: 0.5, end: 130.5, fadeIn: 2, fadeOut: 3 };
  const saved = await files.edit({ ...request, newFileName: 'long-copy.wav' });
  assert.equal(saved.status, 'ok');
  assert.equal(saved.value.duration, 130);
  const copy = await fs.readFile(saved.value.filePath);
  assert.equal(copy.readUInt32LE(40), rate * 130 * 3);
  assert.ok(copy.length > shared.LIMITS.MAX_SOUNDBOARD_FILE_SIZE);
  assert.equal(copy.readIntLE(44, 3), 0);
  assert.equal(copy.readIntLE(copy.length - 3, 3), 0);
  assert.deepEqual(await fs.readFile(path.join(folder, input.fileName)), longSource);
  const replaced = await files.overwrite({ ...request, revision: opened.value.revision });
  assert.equal(replaced.status, 'ok');
  assert.deepEqual(await fs.readFile(replaced.value.filePath), copy);
});

test('concurrent mutations cannot race the source or lose a destination', async t => {
  const { files, input, folder } = await fixture(t);
  const results = await Promise.all([
    files.rename({ ...input, newFileName: 'first.wav' }), files.rename({ ...input, newFileName: 'second.wav' }),
  ]);
  assert.equal(results[0].status, 'ok'); assert.deepEqual(results[1], fail('locked'));
  assert.equal(hash(await fs.readFile(path.join(folder, 'first.wav'))), hash(original));
  await assert.rejects(fs.stat(path.join(folder, 'second.wav')), { code: 'ENOENT' });
});

test('volumes without hard links use exclusive copy; failed source removal rolls back only the new destination', async t => {
  const { files, input, folder } = await fixture(t);
  const originalLink = fs.link;
  const originalUnlink = fs.unlink;
  fs.link = async () => { throw Object.assign(new Error('Hard links unsupported'), { code: 'ENOTSUP' }); };
  try {
    const saved = await files.rename({ ...input, newFileName: 'copied.wav' });
    assert.equal(saved.status, 'ok');
    assert.equal(hash(await fs.readFile(saved.value.filePath)), hash(original));
    await assert.rejects(fs.stat(path.join(folder, 'source.wav')), { code: 'ENOENT' });
    await fs.writeFile(path.join(folder, 'source.wav'), original);
    fs.unlink = async file => {
      if (file === path.join(folder, 'source.wav')) throw Object.assign(new Error('Source locked'), { code: 'EBUSY' });
      return originalUnlink(file);
    };
    assert.deepEqual(await files.rename({ ...input, newFileName: 'rollback.wav' }), fail('locked'));
    assert.equal(hash(await fs.readFile(path.join(folder, 'source.wav'))), hash(original));
    assert.equal(hash(await fs.readFile(saved.value.filePath)), hash(original));
    await assert.rejects(fs.stat(path.join(folder, 'rollback.wav')), { code: 'ENOENT' });
  } finally { fs.link = originalLink; fs.unlink = originalUnlink; }
});

test('Windows OS sharing lock reports locked, retaining original and no rename destination', { skip: process.platform !== 'win32', timeout: 15000 }, async t => {
  const { files, input, folder } = await fixture(t);
  const child = spawn('powershell.exe', ['-NoProfile', '-Command',
    '$f=[System.IO.File]::Open($env:MONKY_LOCK_FIXTURE,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::None); [Console]::WriteLine("LOCKED"); [Console]::ReadLine() | Out-Null; $f.Dispose()'],
  { env: { ...process.env, MONKY_LOCK_FIXTURE: path.join(folder, 'source.wav') }, stdio: ['pipe', 'pipe', 'pipe'] });
  const exit = once(child, 'exit');
  t.after(async () => { child.stdin.end('\n'); await exit; });
  const [chunk] = await once(child.stdout, 'data');
  assert.equal(chunk.toString().trim(), 'LOCKED');
  assert.deepEqual(await files.read(input), fail('locked'));
  assert.deepEqual(await files.delete(input), fail('locked'));
  assert.deepEqual(await files.rename({ ...input, newFileName: 'locked-copy.wav' }), fail('locked'));
  await assert.rejects(fs.stat(path.join(folder, 'locked-copy.wav')), { code: 'ENOENT' });
  child.stdin.end('\n'); await exit;
  assert.equal(hash(await fs.readFile(path.join(folder, 'source.wav'))), hash(original));
});

test('atomic overwrite keeps filename and valid PCM, rejects stale revisions and never overwrites a concurrent edit', async t => {
  const { files, folder, input } = await fixture(t);
  const opened = await files.openEditor(input);
  assert.equal(opened.status, 'ok');
  assert.equal(opened.value.overwriteAvailable, true);
  const request = { ...input, revision: opened.value.revision, sampleRate: rate, channels, ...times };
  assert.deepEqual(await files.overwrite({ ...request, revision: '0'.repeat(64) }), fail('source_changed'));
  assert.deepEqual(await fs.readFile(path.join(folder, 'source.wav')), original);
  const saved = await files.overwrite(request);
  assert.deepEqual(saved, { status: 'ok', value: { fileName: 'source.wav', filePath: path.join(folder, 'source.wav'), duration: 1 } });
  const updated = await fs.readFile(saved.value.filePath);
  assert.equal(updated.readUInt32LE(40) / 6 / rate, 1);
  assert.equal(updated.readIntLE(44, 3), 0);
  assert.equal(updated.readIntLE(updated.length - 6, 3), 0);
  assert.notEqual(hash(updated), hash(original));
  assert.deepEqual(await files.overwrite(request), fail('source_changed'));
  assert.deepEqual(await fs.readFile(saved.value.filePath), updated);
  assert.deepEqual(await fs.readdir(folder), ['source.wav']);
});

test('failed atomic replacement and invalid edits leave the original unchanged and remove staging output', async t => {
  const { files, folder, input } = await fixture(t);
  const opened = await files.openEditor(input);
  const request = { ...input, revision: opened.value.revision, sampleRate: rate, channels, ...times };
  assert.deepEqual(await files.overwrite({ ...request, fadeIn: 5 }), fail('invalid_request'));
  const rename = fs.rename;
  fs.rename = async () => { throw Object.assign(new Error('Sharing lock'), { code: 'EBUSY' }); };
  try { assert.deepEqual(await files.overwrite(request), fail('locked')); }
  finally { fs.rename = rename; }
  assert.deepEqual(await fs.readFile(path.join(folder, 'source.wav')), original);
  assert.deepEqual(await fs.readdir(folder), ['source.wav']);
});

test('compressed overwrite fails closed when encoder is missing, fails, or source changes during encoding', async t => {
  const { folder, folders } = await fixture(t);
  const input = { folder, fileName: 'source.ogg' };
  const file = path.join(folder, input.fileName), ogg = authoredOggPreview();
  await fs.writeFile(file, ogg);
  const unavailable = new SoundboardFiles(folders);
  const opened = await unavailable.openEditor(input);
  assert.equal(opened.value.overwriteAvailable, false);
  const request = { ...input, revision: opened.value.revision, sampleRate: rate, channels, ...times };
  assert.deepEqual(await unavailable.overwrite(request), fail('encoder_unavailable'));
  assert.deepEqual(await fs.readFile(file), ogg);
  const broken = new SoundboardFiles(folders, {
    available: async () => true,
    encode: async () => { throw new Error('Controlled encoder failure'); },
  });
  assert.deepEqual(await broken.overwrite(request), fail('encode_failed'));
  assert.deepEqual(await fs.readFile(file), ogg);
  const changed = Buffer.concat([ogg, Buffer.from('changed externally')]);
  const racing = new SoundboardFiles(folders, {
    available: async () => true,
    encode: async () => { await fs.writeFile(file, changed); return { bytes: ogg, duration: 0.5 }; },
  });
  assert.deepEqual(await racing.overwrite(request), fail('source_changed'));
  assert.deepEqual(await fs.readFile(file), changed);
  assert.ok(!(await fs.readdir(folder)).some(name => name.startsWith('.monky-edit-')));
});

const ffmpeg = process.env.MONKY_SOUNDBOARD_TEST_FFMPEG || 'ffmpeg';
const hasEncoder = spawnSync(ffmpeg, ['-version'], { windowsHide: true, timeout: 5000 }).status === 0;
test('real compressed replacement can exceed 3 MiB and 120 seconds', {
  skip: hasEncoder ? false : 'FFmpeg not provisioned; set MONKY_SOUNDBOARD_TEST_FFMPEG to exercise real codecs',
}, async t => {
  const { folder, folders } = await fixture(t);
  let seed = 17;
  const duration = 200;
  const stereo = Array.from({ length: 2 }, () => Float32Array.from({ length: rate * duration }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    return seed / 0x80000000 * 0.125;
  }));
  const pcm = shared.encodeSoundboardEdit(stereo, rate, { start: 0, end: duration, fadeIn: 0, fadeOut: 0 });
  const encoder = createSoundboardEncoder(async () => ffmpeg);
  const source = await encoder.encode(pcm.bytes, '.webm', duration, 2);
  assert.ok(source.bytes.length > shared.LIMITS.MAX_SOUNDBOARD_FILE_SIZE, `Encoded source: ${source.bytes.length} bytes`);
  const input = { folder, fileName: 'long.webm' };
  await fs.writeFile(path.join(folder, input.fileName), source.bytes);
  const files = new SoundboardFiles(folders, encoder);
  const opened = await files.openEditor(input);
  assert.equal(opened.status, 'ok');
  const saved = await files.overwrite({ ...input, revision: opened.value.revision, sampleRate: rate,
    channels: stereo, start: 0, end: duration, fadeIn: 1, fadeOut: 1 });
  assert.equal(saved.status, 'ok', JSON.stringify(saved));
  assert.ok(Math.abs(saved.value.duration - duration) < 0.25);
  assert.ok((await fs.stat(saved.value.filePath)).size > shared.LIMITS.MAX_SOUNDBOARD_FILE_SIZE);
});

for (const extension of ['.mp3', '.ogg', '.aac', '.m4a', '.webm']) {
  test(`real ${extension} overwrite retains a matching playable codec, source name and bounded duration`, {
    skip: hasEncoder ? false : 'FFmpeg not provisioned; set MONKY_SOUNDBOARD_TEST_FFMPEG to exercise real codecs',
  }, async t => {
    const { folder, folders } = await fixture(t);
    const encoder = createSoundboardEncoder(async () => ffmpeg);
    const source = await encoder.encode(original, extension, 2, 2);
    const input = { folder, fileName: `source${extension}` };
    const file = path.join(folder, input.fileName);
    await fs.writeFile(file, source.bytes);
    const files = new SoundboardFiles(folders, encoder);
    const opened = await files.openEditor(input);
    assert.equal(opened.value.overwriteAvailable, true);
    const saved = await files.overwrite({ ...input, revision: opened.value.revision, sampleRate: rate, channels, ...times });
    assert.equal(saved.status, 'ok', JSON.stringify(saved));
    assert.equal(saved.value.filePath, file);
    assert.ok(Math.abs(saved.value.duration - 1) < 0.25);
    const bytes = await fs.readFile(file);
    assert.notEqual(bytes.toString('ascii', 0, 4), 'RIFF', 'Never disguise WAV as another codec');
    assert.notEqual(hash(bytes), hash(source.bytes));
    assert.ok(bytes.length <= shared.LIMITS.MAX_SOUNDBOARD_FILE_SIZE);
    assert.ok(!(await fs.readdir(folder)).some(name => name.startsWith('.monky-edit-')));
  });
}

test('production IPC handlers reject foreign frames and cleanly unregister; preload routes exact typed channels', async t => {
  const handlers = new Map();
  const source = await fs.readFile(path.resolve(__dirname, '..', 'dist-electron', 'main', 'soundboardFilesIpc.js'), 'utf8');
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, require(name) {
    if (name === 'electron') return { ipcMain: {
      handle: (channel, callback) => { assert.equal(handlers.has(channel), false); handlers.set(channel, callback); },
      removeHandler: channel => handlers.delete(channel),
    } };
    if (name === '@monky/shared') return shared;
    throw new Error(name);
  } });
  const { files, input } = await fixture(t);
  let destroyed = false;
  const contents = { mainFrame: {}, isDestroyed: () => destroyed };
  const dispose = module.exports.setupSoundboardFilesIpc({ webContents: contents }, files);
  const owner = { sender: contents, senderFrame: contents.mainFrame };
  for (const callback of handlers.values()) {
    assert.equal((await callback({ ...owner, senderFrame: {} }, input)).reason, 'invalid_request');
    assert.equal((await callback({ ...owner, sender: {} }, input)).reason, 'invalid_request');
  }
  assert.equal((await handlers.get(shared.SOUNDBOARD_FILES_IPC.read)(owner, input)).status, 'ok');
  destroyed = true;
  assert.equal((await handlers.get(shared.SOUNDBOARD_FILES_IPC.read)(owner, input)).reason, 'invalid_request');
  dispose(); dispose(); assert.equal(handlers.size, 0);
  const preload = await fs.readFile(path.resolve(__dirname, '..', 'src', 'preload', 'preload.ts'), 'utf8');
  for (const [method, channel] of Object.entries({
    readSoundboardEdit: 'read', renameSoundboardFile: 'rename', deleteSoundboardFile: 'delete', saveSoundboardEdit: 'edit',
    openSoundboardEditor: 'open', overwriteSoundboardAudio: 'overwrite',
  })) assert.ok(preload.includes(`${method}: (input) => ipcRenderer.invoke(SOUNDBOARD_FILES_IPC.${channel}, input)`));
});
