import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test, type TestContext } from 'node:test';
import {
  LIMITS, MessageType, type SlashCommand, type CommandSoundDownloadReceivedPayload,
  type SoundboardDownloadInput, type SoundboardDownloadProgress, type SoundDownloadResult,
} from '@monky/shared';
import { SoundboardDownloads, soundDownloadUrl, isPublicSoundAddress, type SoundDownloadTransport } from '../src/main/soundboardDownload';
import { isSoundAudio, isSoundFileName } from '../src/main/soundAudioValidation';
import { AudioPreviews } from '../src/main/audioPreviews';
import type { SoundDownloadApproval, SoundDownloadConfirmationDetails } from '../src/renderer/utils/soundDownloadConfirmation';
import { LocalSoundDownloadService } from '../src/renderer/core/LocalSoundDownloadService';
import type { ElectronApi } from '../src/preload/preload';
import { createChatStore, setActiveChatStore } from '../src/renderer/stores/chatStore';
import { createServerStore } from '../src/renderer/stores/serverStore';
import { createNetworkClient } from '../src/renderer/core/NetworkClient';
import { EventBus } from '../src/renderer/core/EventBus';
import { silentBus } from '../src/renderer/core/activeProxy';
import { renderBotInvocation } from '../src/renderer/views/BotChatView';

const flush = async () => { for (let count = 0; count < 10; count++) await Promise.resolve(); };
// Authored structural fixtures: no downloaded or copyrighted audio.
function mp3(id3 = false): Buffer {
  const frame = Buffer.alloc(417);
  frame.set([0xff, 0xfb, 0x90, 0x64]);
  return Buffer.concat([...(id3 ? [Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0])] : []), frame, frame]);
}
function wav(): Buffer {
  const bytes = Buffer.alloc(48);
  bytes.write('RIFF'); bytes.writeUInt32LE(40, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(4, 40);
  return bytes;
}
async function fixture(context: TestContext, overrides: Partial<SoundDownloadTransport> = {}) {
  const root = path.join(__dirname, `sound-fixture-${randomUUID()}`);
  const folder = path.join(root, 'sounds');
  await fs.mkdir(folder, { recursive: true });
  const requests: string[] = [];
  const transport: SoundDownloadTransport = {
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    request: async (url, address) => {
      requests.push(url.href);
      assert.equal(address.address, '93.184.216.34', 'the resolved public address is passed to the connection');
      return { status: 200, headers: { 'content-type': 'audio/mpeg', 'content-length': String(mp3(true).length) }, body: Readable.from([mp3(true)]) };
    },
    ...overrides,
  };
  const manager = new SoundboardDownloads(path.join(root, 'soundboard-folder.json'), transport);
  context.after(async () => { manager.cancelOwner(1); await fs.rm(root, { recursive: true, force: true }); });
  const request = async (extra: Partial<SoundboardDownloadInput> = {}) => {
    const invocationId = randomUUID();
    const permit = await manager.authorize(1, {
      connectionId: 'connection', invocationId, configuredFolder: folder, expiresAt: Date.now() + 60_000,
    });
    assert.equal(permit.status, 'authorized');
    if (permit.status !== 'authorized') throw new Error('Missing permit');
    return {
      connectionId: 'connection', invocationId, downloadId: randomUUID(), token: permit.token,
      url: 'https://audio.example/sound.mp3', fileName: 'sound.mp3', title: 'An authored sound',
      expiresAt: Date.now() + 60_000, ...extra,
    };
  };
  return { root, folder, manager, request, requests, transport };
}

test('a previously selected folder alias resolves to the confirmed directory without another picker', async (context) => {
  const f = await fixture(context);
  const alias = path.join(f.root, 'folder-alias');
  await fs.symlink(f.folder, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await f.manager.confirmFolder(alias);
  assert.equal(await f.manager.availability(alias), 'ready');
  assert.equal(await f.manager.availability(f.folder), 'ready');
  const restored = new SoundboardDownloads(path.join(f.root, 'soundboard-folder.json'), f.transport);
  context.after(() => restored.cancelOwner(1));
  assert.equal(await restored.availability(alias), 'ready');
  const permit = await restored.authorize(1, {
    connectionId: 'alias-connection', invocationId: 'alias-command',
    configuredFolder: alias, expiresAt: Date.now() + 60_000,
  });
  assert.equal(permit.status, 'authorized');
  await fs.unlink(alias);
  const other = path.join(f.root, 'different-folder');
  await fs.mkdir(other);
  await fs.symlink(other, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await restored.availability(alias), 'confirmation_required');
});

test('audio previews infer a supported MIME, return only authored bytes and never create files or require a sound folder', async (context) => {
  const f = await fixture(context, { request: async () => ({
    status: 200, headers: { 'content-type': 'audio/x-wav; charset=binary' }, body: Readable.from([wav()]),
  }) });
  const previews = new AudioPreviews(f.transport);
  context.after(() => previews.cancelOwner(1));
  const result = await previews.load(1, { requestId: 'preview', url: 'https://audio.example/asset?id=1' });
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') throw new Error('Expected authored audio');
  assert.equal(result.mimeType, 'audio/wav');
  assert.deepEqual(Buffer.from(result.data), wav());
  assert.deepEqual(await fs.readdir(f.root), ['sounds']);
  assert.deepEqual(await fs.readdir(f.folder), []);
});

test('changing folders during authorization, including A-to-B-to-A, cannot redirect a confirmed download', async (context) => {
  for (const returnToOriginal of [false, true]) {
    const f = await fixture(context);
    const confirmed = await f.manager.confirmFolder(f.folder);
    const other = path.join(f.root, 'other-sounds');
    await fs.mkdir(other);
    const access = fs.access;
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const resume = new Promise<void>((resolve) => { release = resolve; });
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    context.after(() => release());
    let paused = false;
    const check = context.mock.method(fs, 'access', async (file: Parameters<typeof fs.access>[0], mode?: number) => {
      if (!paused && file === confirmed) {
        paused = true;
        entered();
        await resume;
      }
      return access(file, mode);
    });
    const authorization = {
      connectionId: 'folder-race', invocationId: 'folder-race-command',
      configuredFolder: f.folder, expiresAt: Date.now() + 60_000,
    };
    const pending = f.manager.authorize(1, authorization);
    await waiting;
    await f.manager.confirmFolder(other);
    if (returnToOriginal) await f.manager.confirmFolder(f.folder);
    release();
    assert.deepEqual(await pending, { status: 'failed', reason: 'no_folder' });
    check.mock.restore();
    assert.equal(f.requests.length, 0);
    assert.deepEqual(await fs.readdir(f.folder), []);
    assert.deepEqual(await fs.readdir(other), []);
    const selected = returnToOriginal ? f.folder : other;
    const fresh = await f.manager.authorize(1, { ...authorization, configuredFolder: selected });
    assert.equal(fresh.status, 'authorized');
    if (fresh.status !== 'authorized') throw new Error('Expected fresh authorization');
    assert.deepEqual(await f.manager.download(1, {
      connectionId: authorization.connectionId, invocationId: authorization.invocationId,
      downloadId: 'fresh-download', token: fresh.token, url: 'https://audio.example/sound.mp3',
      fileName: 'sound.mp3', title: 'Authored sound', expiresAt: authorization.expiresAt,
    }, () => {}), { status: 'downloaded' });
    assert.deepEqual(await fs.readdir(selected), ['sound.mp3']);
    assert.deepEqual(await fs.readdir(returnToOriginal ? other : f.folder), []);
  }
});

test('preview requests use the same private-address and redirect defenses as saved downloads', async (context) => {
  const f = await fixture(context);
  const previews = new AudioPreviews(f.transport);
  context.after(() => previews.cancelOwner(1));
  for (const url of ['http://audio.example/a.mp3', 'https://127.0.0.1/a.mp3', 'https://[::1]/a.mp3', 'https://audio.example:8443/a.mp3']) {
    assert.deepEqual(await previews.load(1, { requestId: randomUUID(), url }), { status: 'failed', reason: 'blocked_url' });
  }
  assert.equal(f.requests.length, 0);
  let requests = 0;
  const redirected = new AudioPreviews({
    ...f.transport,
    request: async () => {
      requests++;
      return { status: 302, headers: { location: 'https://169.254.169.254/metadata' }, body: Readable.from([]) };
    },
  });
  assert.deepEqual(await redirected.load(1, { requestId: 'redirect', url: 'https://audio.example/a.mp3' }),
    { status: 'failed', reason: 'blocked_url' });
  assert.equal(requests, 1);
  const mixedDns = new AudioPreviews({
    ...f.transport, resolve: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }],
  });
  assert.deepEqual(await mixedDns.load(1, { requestId: 'mixed', url: 'https://audio.example/a.mp3' }),
    { status: 'failed', reason: 'blocked_url' });
  assert.equal(f.requests.length, 0);
});

test('preview MIME, signature and size limits fail explicitly without filesystem side effects', async (context) => {
  const scenarios = [
    { mime: 'text/html', bytes: mp3(), reason: 'unsupported_audio' },
    { mime: 'audio/mpeg', bytes: Buffer.from('<html>not audio</html>'), reason: 'unsupported_audio' },
    { mime: 'audio/mpeg', bytes: Buffer.alloc(LIMITS.MAX_SOUNDBOARD_FILE_SIZE + 1), reason: 'too_large' },
    { mime: 'audio/mpeg', bytes: mp3(), length: String(LIMITS.MAX_SOUNDBOARD_FILE_SIZE + 1), reason: 'too_large' },
    { mime: 'audio/mpeg', bytes: mp3(), length: '99999', reason: 'network_error' },
  ];
  for (const scenario of scenarios) {
    const f = await fixture(context, { request: async () => ({
      status: 200, headers: { 'content-type': scenario.mime, 'content-length': scenario.length },
      body: Readable.from([scenario.bytes]),
    }) });
    const previews = new AudioPreviews(f.transport);
    assert.deepEqual(await previews.load(1, { requestId: 'preview', url: 'https://audio.example/a' }),
      { status: 'failed', reason: scenario.reason });
    assert.deepEqual(await fs.readdir(f.folder), []);
  }
});

test('preview replacement, explicit cancellation and timeout dispose only the matching owner and request', async (context) => {
  const body = new Readable({ read() {} });
  let signalStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const f = await fixture(context, { request: async (url) => {
    if (url.pathname === '/waiting.mp3') {
      signalStarted();
      return { status: 200, headers: { 'content-type': 'audio/mpeg' }, body };
    }
    return { status: 200, headers: { 'content-type': 'audio/mpeg' }, body: Readable.from([mp3()]) };
  } });
  const previews = new AudioPreviews(f.transport);
  context.after(() => previews.cancelOwner(1));
  const pending = previews.load(1, { requestId: 'old', url: 'https://audio.example/waiting.mp3' });
  await started;
  await flush();
  assert.equal(previews.cancel(2, { requestId: 'old' }), false);
  assert.equal(previews.cancel(1, { requestId: 'other' }), false);
  assert.deepEqual(await previews.load(1, { requestId: 'old', url: 'https://audio.example/next.mp3' }),
    { status: 'failed', reason: 'invalid_request' });
  assert.equal(body.destroyed, false);
  const next = previews.load(1, { requestId: 'new', url: 'https://audio.example/next.mp3' });
  assert.deepEqual(await pending, { status: 'cancelled' });
  assert.equal(body.destroyed, true);
  assert.equal(previews.cancel(1, { requestId: 'old' }), false);
  assert.equal((await next).status, 'ready');

  const timeout = new AudioPreviews({
    ...f.transport,
    resolve: async (_host, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  }, 10);
  assert.deepEqual(await timeout.load(1, { requestId: 'timeout', url: 'https://audio.example/a.mp3' }),
    { status: 'failed', reason: 'timeout' });
});

function confirmationFixture(
  context: TestContext,
  confirm: (details: SoundDownloadConfirmationDetails, signal: AbortSignal) => Promise<SoundDownloadApproval | null>
) {
  const command: SlashCommand = { name: 'fetch', description: 'Generic audio', botId: 'generic-bot', botName: 'Generic Bot', downloadsSound: true };
  const store = createChatStore();
  store.bus = silentBus;
  store.setCommands([command]);
  const client = createNetworkClient();
  client.getStatus = () => 'CONNECTED';
  client.getCurrentServerUrl = () => 'ws://example.test:46332';
  const sent: unknown[] = [];
  client.send = (_type, payload: unknown) => { sent.push(payload); };
  const server = createServerStore();
  server.currentUser = { id: 'caller', clientId: 'identity', nickname: 'Caller', status: 'ONLINE', joinedAt: 1 };
  const ack = { invocationId: randomUUID(), channelId: 'text', botId: command.botId, commandName: command.name };
  const invocation = store.acknowledgeCommand(ack);
  const request: CommandSoundDownloadReceivedPayload = {
    ...ack, downloadId: randomUUID(), botName: command.botName, invokerId: 'caller', invokerNickname: 'Caller',
    url: 'https://audio.example/file.wav', fileName: 'file.wav', title: 'Authored option',
    createdAt: Date.now(), expiresAt: Date.now() + 30_000,
  };
  let downloads = 0;
  let cancels = 0;
  const inputs: SoundboardDownloadInput[] = [];
  const api: Pick<ElectronApi, 'authorizeSoundDownload' | 'downloadSound' | 'cancelSoundDownload' | 'onSoundDownloadProgress'> = {
    authorizeSoundDownload: async () => ({ status: 'authorized', token: 'native-permit' }),
    downloadSound: async (input) => { downloads++; inputs.push(input); return { status: 'downloaded' }; },
    cancelSoundDownload: async () => { cancels++; return true; },
    onSoundDownloadProgress: () => () => {},
  };
  const service = new LocalSoundDownloadService(() => api, async () => {}, confirm);
  context.after(() => { service.disconnect(client); client.dispose(); });
  service.authorize(client, store, server, command, ack, client.getConnectionId(), 'chosen-folder', true);
  return { service, client, invocation, request, sent, inputs, downloads: () => downloads, cancels: () => cancels };
}

test('a generic bot download waits for confirmation of its real metadata before native I/O', async (context) => {
  let decide: (approval: SoundDownloadApproval | null) => void = () => {};
  let calls = 0;
  const f = confirmationFixture(context, async (details, signal) => {
    calls++;
    assert.equal(details.botId, 'generic-bot');
    assert.equal(details.folder, 'chosen-folder');
    assert.equal(details.request.fileName, 'file.wav');
    assert.equal(details.request.title, 'Authored option');
    assert.equal(signal.aborted, false);
    return new Promise((resolve) => { decide = resolve; });
  });
  f.service.receive(f.client, f.request);
  f.service.receive(f.client, { ...f.request, downloadId: 'duplicate' });
  await flush();
  assert.equal(calls, 1);
  assert.equal(f.downloads(), 0);
  assert.equal(f.invocation.soundDownload?.phase, 'confirming');
  decide({ fileName: 'file.wav' });
  await flush();
  assert.equal(f.downloads(), 1);
  assert.equal(f.invocation.soundDownload?.phase, 'downloading');
  assert.equal(f.invocation.soundDownload?.result?.status, 'downloaded');
});

test('declining confirmation consumes the request without opening a picker or starting a transfer', async (context) => {
  const f = confirmationFixture(context, async () => null);
  f.service.receive(f.client, f.request);
  await flush();
  assert.equal(f.downloads(), 0);
  assert.equal(f.invocation.soundDownload?.result?.status, 'cancelled');
  assert.equal(f.cancels(), 1);
  assert.deepEqual(f.sent, [{
    invocationId: f.request.invocationId, downloadId: f.request.downloadId, result: { status: 'cancelled' },
  }]);
});

test('cancelling a waiting confirmation aborts the modal and ignores a late acceptance', async (context) => {
  let decide: (approval: SoundDownloadApproval | null) => void = () => {};
  let pendingSignal: AbortSignal | undefined;
  const f = confirmationFixture(context, async (_details, signal) => {
    pendingSignal = signal;
    return new Promise((resolve) => { decide = resolve; });
  });
  f.service.receive(f.client, f.request);
  await flush();
  f.service.cancelInvocation(f.client, f.request.invocationId);
  assert.equal(pendingSignal?.aborted, true);
  decide({ fileName: 'renamed.wav' });
  await flush();
  assert.equal(f.downloads(), 0);
  assert.equal(f.invocation.soundDownload?.result?.status, 'cancelled');
});

test('synchronous confirmation errors are surfaced as failure instead of escaping an event handler', async (context) => {
  const warning = context.mock.method(console, 'warn', () => {});
  const f = confirmationFixture(context, () => { throw new Error('Fixture confirmation failure'); });
  f.service.receive(f.client, f.request);
  await flush();
  assert.equal(f.downloads(), 0);
  assert.equal(f.invocation.soundDownload?.result?.status, 'failed');
  assert.equal(warning.mock.callCount(), 1);
});

test('the locally chosen name reaches native I/O and the chat card, never the bot or server', async (context) => {
  const f = confirmationFixture(context, async () => ({ fileName: 'My local file.wav' }));
  f.service.receive(f.client, f.request);
  await flush();
  assert.equal(f.inputs[0]?.fileName, 'My local file.wav');
  assert.equal(f.inputs[0]?.url, f.request.url);
  assert.equal(f.invocation.soundDownload?.fileName, 'My local file.wav');
  assert.equal(f.request.fileName, 'file.wav');
  assert.deepEqual(f.sent, [{
    invocationId: f.request.invocationId, downloadId: f.request.downloadId, result: { status: 'downloaded' },
  }]);
});

test('a malformed rename or changed audio extension cannot start native I/O', async (context) => {
  for (const fileName of ['../file.wav', 'CON.wav', 'another.mp3', 'a'.repeat(125) + '.wav']) {
    const f = confirmationFixture(context, async () => ({ fileName }));
    f.service.receive(f.client, f.request);
    await flush();
    assert.equal(f.downloads(), 0);
    assert.deepEqual(f.invocation.soundDownload?.result, { status: 'failed', reason: 'invalid_file_name' });
  }
});

test('disconnecting or expiring while awaiting consent aborts the modal and cannot start a late transfer', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  for (const end of ['disconnect', 'timeout'] as const) {
    let decide: (approval: SoundDownloadApproval | null) => void = () => {};
    let signal: AbortSignal | undefined;
    const f = confirmationFixture(context, async (_details, pendingSignal) => {
      signal = pendingSignal;
      return new Promise((resolve) => { decide = resolve; });
    });
    f.service.receive(f.client, f.request);
    await flush();
    if (end === 'disconnect') {
      f.client.getStatus = () => 'DISCONNECTED';
      f.service.disconnect(f.client);
    } else context.mock.timers.tick(30_001);
    assert.equal(signal?.aborted, true);
    decide({ fileName: 'file.wav' });
    await flush();
    assert.equal(f.downloads(), 0);
    assert.equal(f.invocation.soundDownload?.result?.status, end === 'disconnect' ? 'cancelled' : 'failed');
  }
});

test('native-confirmed folder persists; forged paths/owners/keys and replay cannot start I/O', async (context) => {
  const f = await fixture(context);
  assert.equal(await f.manager.availability(f.folder), 'confirmation_required');
  assert.deepEqual(await f.manager.authorize(1, {
    connectionId: 'connection', invocationId: 'invocation', configuredFolder: f.folder, expiresAt: Date.now() + 1000,
  }), { status: 'failed', reason: 'no_folder' });
  await f.manager.confirmFolder(f.folder);
  assert.equal(await new SoundboardDownloads(path.join(f.root, 'soundboard-folder.json')).availability(f.folder), 'ready');
  assert.equal(await f.manager.availability(f.root), 'confirmation_required');
  const request = await f.request();
  assert.deepEqual(await f.manager.download(2, request, () => {}), { status: 'failed', reason: 'invalid_request' });
  assert.deepEqual(await f.manager.download(1, { ...request, invocationId: 'other' }, () => {}), { status: 'failed', reason: 'invalid_request' });
  assert.equal(f.requests.length, 0);
  assert.deepEqual(await f.manager.download(1, request, () => {}), { status: 'downloaded' });
  assert.deepEqual(await f.manager.download(1, request, () => {}), { status: 'failed', reason: 'invalid_request' });
  assert.equal(f.requests.length, 1);
});

test('writer publishes complete authored bytes exclusively; existing file does not even cause DNS/network', async (context) => {
  const f = await fixture(context);
  await f.manager.confirmFolder(f.folder);
  const progress: SoundboardDownloadProgress[] = [];
  assert.deepEqual(await f.manager.download(1, await f.request(), (event) => progress.push(event)), { status: 'downloaded' });
  assert.deepEqual(await fs.readFile(path.join(f.folder, 'sound.mp3')), mp3(true));
  assert.equal(progress.at(-1)?.receivedBytes, mp3(true).length);
  assert.deepEqual(await fs.readdir(f.folder), ['sound.mp3']);
  assert.deepEqual(await f.manager.download(1, await f.request(), () => {}), { status: 'exists' });
  assert.equal(f.requests.length, 1);
  assert.deepEqual(await fs.readFile(path.join(f.folder, 'sound.mp3')), mp3(true));
});

test('volumes without hardlinks use an exclusive final copy, never an overwriting mode', async (context) => {
  const f = await fixture(context);
  await f.manager.confirmFolder(f.folder);
  const copyFile = fs.copyFile;
  context.mock.method(fs, 'link', async () => { throw Object.assign(new Error('Unsupported links'), { code: 'EPERM' }); });
  const copy = context.mock.method(fs, 'copyFile', async (
    source: Parameters<typeof fs.copyFile>[0], destination: Parameters<typeof fs.copyFile>[1], mode?: number
  ) => {
    assert.equal(mode, constants.COPYFILE_EXCL);
    await copyFile(source, destination, mode);
  });
  assert.deepEqual(await f.manager.download(1, await f.request(), () => {}), { status: 'downloaded' });
  assert.equal(copy.mock.callCount(), 1);
  assert.deepEqual(await fs.readFile(path.join(f.folder, 'sound.mp3')), mp3(true));
  assert.deepEqual(await fs.readdir(f.folder), ['sound.mp3']);
});

test('exclusive copy also preserves a destination created immediately before publication', async (context) => {
  const f = await fixture(context);
  await f.manager.confirmFolder(f.folder);
  const copyFile = fs.copyFile;
  context.mock.method(fs, 'link', async () => { throw Object.assign(new Error('Unsupported links'), { code: 'ENOTSUP' }); });
  context.mock.method(fs, 'copyFile', async (
    source: Parameters<typeof fs.copyFile>[0], destination: Parameters<typeof fs.copyFile>[1], mode?: number
  ) => {
    await fs.writeFile(destination, 'concurrent owner', { flag: 'wx' });
    await copyFile(source, destination, mode);
  });
  assert.deepEqual(await f.manager.download(1, await f.request(), () => {}), { status: 'exists' });
  assert.equal(await fs.readFile(path.join(f.folder, 'sound.mp3'), 'utf8'), 'concurrent owner');
  assert.deepEqual(await fs.readdir(f.folder), ['sound.mp3']);
});

test('cancellation before an exclusive fallback cannot begin another filesystem write', async (context) => {
  const f = await fixture(context);
  await f.manager.confirmFolder(f.folder);
  context.mock.method(fs, 'link', async () => {
    f.manager.cancelOwner(1);
    throw Object.assign(new Error('Unsupported links'), { code: 'EPERM' });
  });
  const copy = context.mock.method(fs, 'copyFile', async () => assert.fail('Cancelled publication must not copy.'));
  assert.deepEqual(await f.manager.download(1, await f.request(), () => {}), { status: 'cancelled' });
  assert.equal(copy.mock.callCount(), 0);
  assert.deepEqual(await fs.readdir(f.folder), []);
});

test('temporary cleanup locks are retried without changing a persisted download to failure', async (context) => {
  const f = await fixture(context);
  await f.manager.confirmFolder(f.folder);
  const unlink = fs.unlink;
  let attempts = 0;
  context.mock.method(fs, 'unlink', async (file: Parameters<typeof fs.unlink>[0]) => {
    if (String(file).endsWith('.part') && attempts++ === 0) {
      throw Object.assign(new Error('Temporary file lock'), { code: 'EBUSY' });
    }
    await unlink(file);
  });
  assert.deepEqual(await f.manager.download(1, await f.request(), () => {}), { status: 'downloaded' });
  assert.equal(attempts, 2);
  assert.deepEqual(await fs.readdir(f.folder), ['sound.mp3']);
});

test('a persistent staging cleanup failure is reported without lying about the saved file', async (context) => {
  const f = await fixture(context);
  await f.manager.confirmFolder(f.folder);
  const warning = context.mock.method(console, 'warn', () => {});
  context.mock.method(fs, 'unlink', async () => { throw Object.assign(new Error('Locked staging'), { code: 'EPERM' }); });
  assert.deepEqual(await f.manager.download(1, await f.request(), () => {}), { status: 'downloaded' });
  assert.deepEqual(await fs.readFile(path.join(f.folder, 'sound.mp3')), mp3(true));
  assert.equal(warning.mock.callCount(), 1);
});

test('an unwritable confirmed folder is blocked before issuing a download capability', async (context) => {
  const f = await fixture(context);
  await f.manager.confirmFolder(f.folder);
  context.mock.method(fs, 'access', async () => { throw Object.assign(new Error('No write access'), { code: 'EACCES' }); });
  assert.equal(await f.manager.availability(f.folder), 'unavailable');
  assert.deepEqual(await f.manager.authorize(1, {
    connectionId: 'connection', invocationId: 'invocation', configuredFolder: f.folder, expiresAt: Date.now() + 60_000,
  }), { status: 'failed', reason: 'no_folder' });
  assert.equal(f.requests.length, 0);
});

test('concurrent authorization still respects the global capability bound after asynchronous folder checks', async (context) => {
  const f = await fixture(context);
  await f.manager.confirmFolder(f.folder);
  const permits = await Promise.all(Array.from({ length: 70 }, (_, index) => f.manager.authorize(1, {
    connectionId: 'connection', invocationId: `invocation-${index}`, configuredFolder: f.folder, expiresAt: Date.now() + 60_000,
  })));
  assert.equal(permits.filter((permit) => permit.status === 'authorized').length, 64);
  assert.equal(permits.filter((permit) => permit.status === 'failed').length, 6);
});

test('filenames, URL schemes and public IPv4/IPv6 checks reject traversal, devices, credentials and special networks', () => {
  for (const name of ['../escape.mp3', '..\\escape.mp3', 'CON.mp3', 'COM¹.mp3', 'LPT9.mp3', 'file:stream.mp3', 'sound.mp3 ', '.hidden.mp3', 'bad.exe']) {
    assert.equal(isSoundFileName(name), false, name);
  }
  assert.equal(isSoundFileName('Som autoral.mp3'), true);
  for (const address of ['127.0.0.1', '10.2.3.4', '172.16.0.2', '192.168.0.1', '100.64.0.1', '169.254.169.254',
    '0.0.0.0', '224.0.0.1', '::1', '::ffff:127.0.0.1', '0:0:0:0:0:ffff:7f00:1', 'fc00::1', 'fe80::1', '2001:db8::1']) {
    assert.equal(isPublicSoundAddress(address), false, address);
  }
  assert.equal(isPublicSoundAddress('93.184.216.34'), true);
  assert.equal(isPublicSoundAddress('2606:4700:4700::1111'), true);
  for (const url of ['http://audio.example/a.mp3', 'https://user:pass@audio.example/a.mp3', 'https://127.1/a.mp3',
    'https://[::ffff:127.0.0.1]/a.mp3', 'https://localhost/a.mp3', 'file:///sound.mp3']) assert.throws(() => soundDownloadUrl(url));
});

test('all DNS answers and every redirect are validated before another connection', async (context) => {
  let resolutions = 0;
  let connections = 0;
  const f = await fixture(context, {
    resolve: async () => {
      resolutions++;
      return resolutions === 1 ? [{ address: '93.184.216.34', family: 4 }] :
        [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }];
    },
    request: async () => {
      connections++;
      return { status: 302, headers: { location: 'https://rebound.example/audio.mp3' }, body: Readable.from([]) };
    },
  });
  await f.manager.confirmFolder(f.folder);
  assert.deepEqual(await f.manager.download(1, await f.request(), () => {}), { status: 'failed', reason: 'blocked_url' });
  assert.equal(connections, 1);
  assert.equal(resolutions, 2);
  assert.deepEqual(await fs.readdir(f.folder), []);
});

test('audio signatures support MP3 frames/ID3 and PCM WAV, not HTML disguised by MIME or extension', () => {
  assert.equal(isSoundAudio(mp3(), 'sound.mp3'), true);
  assert.equal(isSoundAudio(mp3(true), 'sound.mp3'), true);
  assert.equal(isSoundAudio(wav(), 'sound.wav'), true);
  assert.equal(isSoundAudio(Buffer.from('<html>Not audio</html>'), 'sound.mp3'), false);
  assert.equal(isSoundAudio(Buffer.concat([mp3(true).subarray(0, 10), Buffer.from('<html>Not audio</html>')]), 'sound.mp3'), false);
  assert.equal(isSoundAudio(mp3().subarray(0, 420), 'sound.mp3'), false);
  assert.equal(isSoundAudio(wav().subarray(0, 43), 'sound.wav'), false);
});

test('supported AAC, Ogg, M4A and WebM containers require an audio signature, not a video-only header', () => {
  const adts = Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x01, 0x3f, 0xfc, 0, 0]);
  assert.equal(isSoundAudio(Buffer.concat([adts, adts]), 'authored.aac'), true);
  const oggPage = (payload: Buffer) => {
    const header = Buffer.alloc(28);
    header.write('OggS');
    header[26] = 1; header[27] = payload.length;
    return Buffer.concat([header, payload]);
  };
  const opusHead = Buffer.alloc(19);
  opusHead.write('OpusHead'); opusHead[8] = 1; opusHead[9] = 1;
  const ogg = Buffer.concat([oggPage(opusHead), oggPage(Buffer.from([0xf8, 0xff, 0xfe]))]);
  assert.equal(isSoundAudio(ogg, 'authored.ogg'), true);
  assert.equal(isSoundAudio(oggPage(Buffer.from('<html>not audio</html>')), 'authored.ogg'), false);
  const box = (name: string, ...payloads: Buffer[]) => {
    const data = Buffer.concat(payloads);
    const header = Buffer.alloc(8);
    header.writeUInt32BE(data.length + 8); header.write(name, 4, 'ascii');
    return Buffer.concat([header, data]);
  };
  const m4a = Buffer.concat([
    box('ftyp', Buffer.from('M4A '), Buffer.alloc(4)),
    box('moov', box('trak', box('mdia', box('hdlr', Buffer.alloc(8), Buffer.from('soun')),
      box('minf', box('stbl', box('stsd', Buffer.alloc(8), box('mp4a', Buffer.alloc(28)))))))),
    box('mdat', Buffer.from([0, 1, 2, 3])),
  ]);
  assert.equal(isSoundAudio(m4a, 'authored.m4a'), true);
  const videoM4a = Buffer.from(m4a);
  videoM4a.write('vide', videoM4a.indexOf('soun'), 'ascii');
  assert.equal(isSoundAudio(videoM4a, 'video.m4a'), false);
  const ebml = (id: string, ...payloads: Buffer[]) => {
    const data = Buffer.concat(payloads);
    assert.ok(data.length < 127);
    return Buffer.concat([Buffer.from(id, 'hex'), Buffer.from([data.length | 0x80]), data]);
  };
  const webm = (type: number) => Buffer.concat([
    ebml('1a45dfa3', ebml('4282', Buffer.from('webm'))),
    ebml('18538067',
      ebml('1654ae6b', ebml('ae', ebml('83', Buffer.from([type])), ebml('86', Buffer.from('A_OPUS')))),
      ebml('1f43b675', ebml('a3', Buffer.from([0x81, 0, 0, 0x80, 0xf8, 0xff, 0xfe])))),
  ]);
  assert.equal(isSoundAudio(webm(2), 'authored.webm'), true);
  assert.equal(isSoundAudio(webm(1), 'video.webm'), false);
});

test('the exact 3 MiB ceiling is accepted without increasing the existing read limit', async (context) => {
  const bytes = Buffer.alloc(LIMITS.MAX_SOUNDBOARD_FILE_SIZE);
  mp3().copy(bytes);
  const f = await fixture(context, { request: async () => ({
    status: 200, headers: { 'content-type': 'audio/mpeg', 'content-length': String(bytes.length) },
    body: Readable.from([bytes]),
  }) });
  await f.manager.confirmFolder(f.folder);
  assert.deepEqual(await f.manager.download(1, await f.request(), () => {}), { status: 'downloaded' });
  assert.equal((await fs.stat(path.join(f.folder, 'sound.mp3'))).size, 3 * 1024 * 1024);
});

test('a file created during transfer wins the exclusive publication race unchanged', async (context) => {
  const f = await fixture(context, { request: async () => {
    await fs.writeFile(path.join(f.folder, 'sound.mp3'), 'existing content', { flag: 'wx' });
    return { status: 200, headers: { 'content-type': 'audio/mpeg' }, body: Readable.from([mp3()]) };
  } });
  await f.manager.confirmFolder(f.folder);
  assert.deepEqual(await f.manager.download(1, await f.request(), () => {}), { status: 'exists' });
  assert.equal(await fs.readFile(path.join(f.folder, 'sound.mp3'), 'utf8'), 'existing content');
  assert.deepEqual(await fs.readdir(f.folder), ['sound.mp3']);
});

test('expired authorization and renderer teardown revoke I/O even before the stream has started', async (context) => {
  const f = await fixture(context, { resolve: async (_host, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  await f.manager.confirmFolder(f.folder);
  const request = await f.request({ expiresAt: Date.now() + 30 });
  assert.deepEqual(await f.manager.download(1, request, () => {}), { status: 'failed', reason: 'timeout' });
  assert.deepEqual(await fs.readdir(f.folder), []);
  const next = await f.request();
  f.manager.cancelOwner(1);
  assert.deepEqual(await f.manager.download(1, next, () => {}), { status: 'failed', reason: 'invalid_request' });
  assert.equal(f.requests.length, 0);
});

test('Main authorization follows the invocation, while a late transfer gets at most 120s and never exceeds that invocation', async (context) => {
  for (const elapsed of [150_000, 250_000]) {
    await context.test(`download starts ${elapsed}ms after invocation`, async (nested) => {
      nested.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
      const body = new Readable({ read() {} });
      let started: () => void = () => {};
      const began = new Promise<void>((resolve) => { started = resolve; });
      const f = await fixture(nested, { request: async () => {
        started();
        return { status: 200, headers: { 'content-type': 'audio/mpeg' }, body };
      } });
      await f.manager.confirmFolder(f.folder);
      const invocationDeadline = LIMITS.BOT_INTERACTION_TIMEOUT_MS;
      const permit = await f.manager.authorize(1, {
        connectionId: 'connection', invocationId: 'delayed', configuredFolder: f.folder, expiresAt: invocationDeadline,
      });
      assert.equal(permit.status, 'authorized');
      if (permit.status !== 'authorized') throw new Error('Missing permit');
      nested.mock.timers.tick(elapsed);
      const pending = f.manager.download(1, {
        connectionId: 'connection', invocationId: 'delayed', downloadId: 'download', token: permit.token,
        url: 'https://audio.example/authored.mp3', fileName: 'authored.mp3', title: 'Authored',
        expiresAt: Date.now() + LIMITS.BOT_INTERACTION_TIMEOUT_MS,
      }, () => {});
      const first = await Promise.race([began.then(() => 'started' as const), pending]);
      assert.equal(first, 'started', 'the capability must not expire 120s after the original ACK');
      await flush();
      const duration = Math.min(LIMITS.BOT_SOUND_DOWNLOAD_TIMEOUT_MS, invocationDeadline - Date.now());
      nested.mock.timers.tick(duration - 1);
      assert.equal(body.destroyed, false, 'pre-download command work must not consume the transfer budget');
      nested.mock.timers.tick(1);
      assert.equal(body.destroyed, true, 'the shorter transfer/invocation deadline must stop the stream');
      assert.deepEqual(await pending, { status: 'failed', reason: 'timeout' });
      assert.deepEqual(await fs.readdir(f.folder), []);
    });
  }
});

test('renderer retains the original authorization for a download requested after two minutes', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const command: SlashCommand = { name: 'query', botId: 'bot', botName: 'Bot', description: 'Sound', downloadsSound: true };
  const store = createChatStore();
  store.bus = silentBus;
  store.setCommands([command]);
  const client = createNetworkClient();
  client.getStatus = () => 'CONNECTED';
  client.send = () => {};
  const server = createServerStore();
  server.currentUser = { id: 'caller', clientId: 'identity', nickname: 'Caller', status: 'ONLINE', joinedAt: 1 };
  const ack = { invocationId: 'delayed', channelId: 'text', botId: command.botId, commandName: command.name };
  const invocation = store.acknowledgeCommand(ack);
  let allowedUntil = 0;
  let downloads = 0;
  let downloadDeadline = 0;
  let listeners = 0;
  const api: Pick<ElectronApi, 'authorizeSoundDownload' | 'downloadSound' | 'cancelSoundDownload' | 'onSoundDownloadProgress'> = {
    authorizeSoundDownload: async (input) => {
      allowedUntil = input.expiresAt;
      return { status: 'authorized', token: 'one-shot' };
    },
    downloadSound: async (input) => { downloads++; downloadDeadline = input.expiresAt; return { status: 'exists' }; },
    cancelSoundDownload: async () => true,
    onSoundDownloadProgress: () => { listeners++; return () => { listeners--; }; },
  };
  const service = new LocalSoundDownloadService(() => api, async () => {}, async (details) => ({ fileName: details.request.fileName }));
  context.after(() => { service.disconnect(client); client.dispose(); });
  service.authorize(client, store, server, command, ack, client.getConnectionId(), 'confirmed', true);
  await flush();
  assert.equal(allowedUntil, invocation.expiresAt);
  context.mock.timers.tick(150_000);
  assert.equal(listeners, 1);
  service.receive(client, {
    ...ack, downloadId: 'download', botName: 'Bot', invokerId: 'caller', invokerNickname: 'Caller',
    url: 'https://audio.example/authored.mp3', fileName: 'authored.mp3', title: 'Authored',
    createdAt: Date.now(), expiresAt: Date.now() + LIMITS.BOT_SOUND_DOWNLOAD_TIMEOUT_MS,
  });
  await flush();
  assert.equal(downloads, 1);
  assert.equal(downloadDeadline, 270_000);
  assert.equal(invocation.soundDownload?.result?.status, 'exists');
  assert.equal(listeners, 0);
});

test('bad MIME/signature, oversized declared/actual bytes and truncated transfers leave no files', async (context) => {
  for (const scenario of ['mime', 'html', 'declared', 'actual', 'truncated'] as const) {
    await context.test(scenario, async (nested) => {
      const f = await fixture(nested, { request: async () => ({
        status: 200,
        headers: { 'content-type': scenario === 'mime' ? 'text/html' : 'audio/mpeg',
          ...(scenario === 'declared' ? { 'content-length': String(LIMITS.MAX_SOUNDBOARD_FILE_SIZE + 1) } :
            scenario === 'truncated' ? { 'content-length': '999' } : {}) },
        body: Readable.from([scenario === 'html' ? Buffer.from('<html>Not audio</html>') :
          scenario === 'actual' ? Buffer.alloc(LIMITS.MAX_SOUNDBOARD_FILE_SIZE + 1) : mp3()]),
      }) });
      await f.manager.confirmFolder(f.folder);
      const reason = scenario === 'declared' || scenario === 'actual' ? 'too_large' :
        scenario === 'truncated' ? 'network_error' : 'unsupported_audio';
      assert.deepEqual(await f.manager.download(1, await f.request(), () => {}), { status: 'failed', reason });
      assert.deepEqual(await fs.readdir(f.folder), []);
    });
  }
});

test('cancellation destroys a stalled stream and cleans only this operation', async (context) => {
  const body = new Readable({ read() {} });
  let started: () => void = () => {};
  const began = new Promise<void>((resolve) => { started = resolve; });
  const f = await fixture(context, { request: async () => {
    started();
    return { status: 200, headers: { 'content-type': 'audio/mpeg' }, body };
  } });
  await f.manager.confirmFolder(f.folder);
  await fs.writeFile(path.join(f.folder, 'unrelated.part'), 'keep');
  const request = await f.request();
  const pending = f.manager.download(1, request, () => {});
  await began;
  await flush();
  assert.equal(f.manager.cancel(1, request), true);
  assert.deepEqual(await pending, { status: 'cancelled' });
  assert.equal(body.destroyed, true);
  assert.deepEqual(await fs.readdir(f.folder), ['unrelated.part']);
});

test('download completion stays in the captured background store and only actual Main result completes the card', async (context) => {
  const command: SlashCommand = { name: 'query', botId: 'bot', botName: 'Bot', description: 'Sound', downloadsSound: true };
  const foreground = createChatStore();
  foreground.bus = new EventBus();
  const background = createChatStore();
  background.bus = silentBus;
  background.setCommands([command]);
  const client = createNetworkClient();
  client.getStatus = () => 'CONNECTED';
  const sent: Array<{ type: MessageType; payload: unknown }> = [];
  client.send = (type, payload: unknown) => { sent.push({ type, payload }); };
  const server = createServerStore();
  server.currentUser = { id: 'caller', clientId: 'identity', nickname: 'Caller', status: 'ONLINE', joinedAt: 1 };
  const ack = { invocationId: 'invocation', channelId: 'text', commandName: command.name, botId: command.botId };
  background.acknowledgeCommand(ack);
  const request: CommandSoundDownloadReceivedPayload = {
    ...ack, downloadId: 'download', botName: 'Bot', invokerId: 'caller', invokerNickname: 'Caller',
    url: 'https://audio.example/sound.mp3', fileName: 'sound.mp3', title: 'Authored',
    createdAt: Date.now(), expiresAt: Date.now() + 60_000,
  };
  let downloads = 0;
  let reloads = 0;
  let subscriptions = 0;
  let report: (progress: SoundboardDownloadProgress) => void = () => {};
  let finish: (result: SoundDownloadResult) => void = () => {};
  const api: Pick<ElectronApi, 'authorizeSoundDownload' | 'downloadSound' | 'cancelSoundDownload' | 'onSoundDownloadProgress'> = {
    authorizeSoundDownload: async () => ({ status: 'authorized', token: 'local-only-token' }),
    downloadSound: async () => {
      downloads++;
      return new Promise((resolve) => { finish = resolve; });
    },
    cancelSoundDownload: async () => true,
    onSoundDownloadProgress: (callback) => { report = callback; subscriptions++; return () => { subscriptions--; }; },
  };
  const service = new LocalSoundDownloadService(() => api, async () => { reloads++; }, async (details) => ({ fileName: details.request.fileName }));
  context.after(() => { service.disconnect(client); client.dispose(); setActiveChatStore(createChatStore()); });
  service.receive(client, request);
  assert.equal(downloads, 0, 'unsolicited event is not authorization');
  service.authorize(client, background, server, command, ack, client.getConnectionId(), 'confirmed-folder', false);
  service.receive(client, request);
  assert.equal(subscriptions, 0, 'synthetic/no gesture cannot authorize');
  service.authorize(client, background, server, command, ack, client.getConnectionId(), 'confirmed-folder', true);
  const otherDevice = createNetworkClient();
  otherDevice.getConnectionId = () => client.getConnectionId();
  service.receive(otherDevice, request);
  assert.equal(downloads, 0, 'even an identical tuple on another connection cannot inherit authorization');
  otherDevice.dispose();
  service.receive(client, { ...request, invocationId: 'other' });
  service.receive(client, request);
  service.receive(client, request);
  await flush();
  assert.equal(downloads, 1);
  setActiveChatStore(foreground);
  report({ connectionId: client.getConnectionId(), ...ack, downloadId: request.downloadId, receivedBytes: 417, totalBytes: 834 });
  assert.equal(background.getInvocation(ack.invocationId)?.soundDownload?.receivedBytes, 417);
  assert.equal(foreground.getInvocations('text').length, 0);
  assert.equal(background.getInvocation(ack.invocationId)?.soundDownload?.result, undefined);
  finish({ status: 'downloaded' });
  await flush();
  assert.deepEqual(background.getInvocation(ack.invocationId)?.soundDownload?.result, { status: 'downloaded' });
  assert.equal(subscriptions, 0);
  assert.equal(reloads, 1);
  assert.equal(sent.filter((event) => event.type === MessageType.COMMAND_SOUND_DOWNLOAD_RESULT).length, 1);
  background.finishInvocation({ ...ack, reason: 'completed' });
  const invocation = background.getInvocation(ack.invocationId);
  assert.ok(invocation);
  invocation.hasResponse = true;
  assert.ok(renderBotInvocation(invocation).includes('bot-sound-download'), 'download card survives an attributed bot reply');
});

test('network lifecycle revokes I/O but cannot discard its real Main outcome or update a replacement invocation', async (context) => {
  for (const action of ['finish', 'cancel', 'expire', 'disconnect', 'before-permit', 'replaced'] as const) {
    await context.test(action, async (nested) => {
      const command: SlashCommand = { name: 'query', botId: 'bot', botName: 'Bot', description: 'Sound', downloadsSound: true };
      const store = createChatStore();
      store.bus = silentBus;
      store.setCommands([command]);
      const client = createNetworkClient();
      client.getStatus = () => 'CONNECTED';
      client.send = () => {};
      const server = createServerStore();
      server.currentUser = { id: 'caller', clientId: 'identity', nickname: 'Caller', status: 'ONLINE', joinedAt: 1 };
      const ack = { invocationId: 'invocation', channelId: 'text', commandName: command.name, botId: command.botId };
      const original = store.acknowledgeCommand(ack);
      const request: CommandSoundDownloadReceivedPayload = {
        ...ack, downloadId: 'download', botName: 'Bot', invokerId: 'caller', invokerNickname: 'Caller',
        url: 'https://audio.example/sound.mp3', fileName: 'sound.mp3', title: 'Authored',
        createdAt: Date.now(), expiresAt: Date.now() + 60_000,
      };
      let allow: () => void = () => {};
      let finish: (result: SoundDownloadResult) => void = () => {};
      let downloads = 0;
      let cancels = 0;
      let subscriptions = 0;
      let progress: (value: SoundboardDownloadProgress) => void = () => {};
      const api: Pick<ElectronApi, 'authorizeSoundDownload' | 'downloadSound' | 'cancelSoundDownload' | 'onSoundDownloadProgress'> = {
        authorizeSoundDownload: () => new Promise((resolve) => { allow = () => resolve({ status: 'authorized', token: 'one-shot' }); }),
        downloadSound: () => { downloads++; return new Promise((resolve) => { finish = resolve; }); },
        cancelSoundDownload: async () => { cancels++; return true; },
        onSoundDownloadProgress: (callback) => { progress = callback; subscriptions++; return () => { subscriptions--; }; },
      };
      const service = new LocalSoundDownloadService(() => api, async () => {}, async (details) => ({ fileName: details.request.fileName }));
      nested.after(() => { service.disconnect(client); client.dispose(); });
      service.authorize(client, store, server, command, ack, client.getConnectionId(), 'confirmed', true);
      service.receive(client, request);
      if (action === 'before-permit') store.finishInvocation({ ...ack, reason: 'completed' });
      allow();
      await flush();
      if (action === 'finish') store.finishInvocation({ ...ack, reason: 'completed' });
      if (action === 'expire') store.expireInvocations(Date.now() + LIMITS.BOT_INTERACTION_TIMEOUT_MS + 1);
      if (action === 'cancel') {
        store.setCancelPending(ack.invocationId, true);
        service.cancelInvocation(client, ack.invocationId);
      }
      if (action === 'disconnect') {
        client.getStatus = () => 'DISCONNECTED';
        service.disconnect(client);
      }
      if (action === 'replaced') {
        store.clear();
        store.setCommands([command]);
        store.acknowledgeCommand(ack);
        store.updateSoundDownload(ack.invocationId, {
          downloadId: request.downloadId, title: 'Replacement', fileName: 'replacement.mp3', receivedBytes: 99,
        });
      }
      assert.equal(downloads, action === 'before-permit' ? 0 : 1);
      assert.equal(subscriptions, 0);
      assert.ok(cancels >= 1);
      assert.deepEqual(original.soundDownload?.result, { status: 'cancelled' });
      assert.equal(original.soundDownload?.resultOrigin, 'client');
      const terminalStatus = original.status;
      const cancellationsBeforeReply = cancels;
      progress({ ...request, connectionId: client.getConnectionId(), receivedBytes: 800, totalBytes: 834 });
      const nativeResult: SoundDownloadResult = action === 'cancel' ? { status: 'exists' } :
        action === 'expire' ? { status: 'failed', reason: 'timeout' } : { status: 'downloaded' };
      finish(nativeResult);
      await flush();
      assert.equal(subscriptions, 0);
      assert.equal(cancels, cancellationsBeforeReply);
      assert.equal(original.status, terminalStatus, 'a Main result never reopens the command');
      assert.equal(original.soundDownload?.receivedBytes, 0, 'late progress remains discarded');
      if (action === 'replaced') {
        assert.equal(store.getInvocation(ack.invocationId)?.soundDownload?.title, 'Replacement');
        assert.equal(store.getInvocation(ack.invocationId)?.soundDownload?.receivedBytes, 99);
        assert.equal(store.getInvocation(ack.invocationId)?.soundDownload?.result, undefined);
      } else if (action === 'before-permit') {
        assert.deepEqual(original.soundDownload?.result, { status: 'cancelled' });
        assert.equal(original.soundDownload?.resultOrigin, 'client', 'no download call means no native evidence');
      } else {
        assert.deepEqual(original.soundDownload?.result, nativeResult);
        assert.equal(original.soundDownload?.resultOrigin, 'main');
      }
    });
  }
});

test('only the exact Main completion can correct a provisional timeout; command completed is not file evidence', () => {
  const store = createChatStore();
  store.bus = silentBus;
  const invocation = store.acknowledgeCommand({
    invocationId: 'invocation', channelId: 'text', botId: 'bot', commandName: 'query',
  });
  store.updateSoundDownload(invocation.invocationId, {
    downloadId: 'download', title: 'Authored', fileName: 'authored.mp3', receivedBytes: 834,
    result: { status: 'failed', reason: 'timeout' }, resultOrigin: 'client',
  });
  store.finishInvocation({ invocationId: invocation.invocationId, channelId: 'text', reason: 'completed' });
  assert.deepEqual(invocation.soundDownload?.result, { status: 'failed', reason: 'timeout' });
  assert.equal(store.completeSoundDownload(invocation, 'other-download', { status: 'downloaded' }), false);
  assert.equal(store.completeSoundDownload(invocation, 'download', { status: 'downloaded' }), true);
  assert.equal(store.getInvocation(invocation.invocationId)?.soundDownload?.result?.status, 'downloaded');
  assert.equal(invocation.soundDownload?.resultOrigin, 'main');
  assert.equal(store.completeSoundDownload(invocation, 'download', { status: 'cancelled' }), false);
  assert.equal(store.getInvocation(invocation.invocationId)?.soundDownload?.result?.status, 'downloaded');
  assert.equal(invocation.status, 'completed');
});

test('remote acknowledgements cannot inject local download state or masquerade as a Main result', () => {
  const store = createChatStore();
  store.bus = silentBus;
  const payload = {
    invocationId: 'invocation', channelId: 'text', botId: 'bot', commandName: 'query',
    soundDownload: {
      downloadId: 'forged', fileName: 'forged.mp3', title: 'Not downloaded', receivedBytes: 999,
      result: { status: 'downloaded' }, resultOrigin: 'main',
    },
  };
  const invocation = store.acknowledgeCommand(payload);
  assert.equal(invocation.soundDownload, undefined);
  store.finishInvocation({ invocationId: invocation.invocationId, channelId: 'text', reason: 'completed' });
  assert.equal(invocation.soundDownload, undefined);
});
