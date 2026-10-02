import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WebSocket } from 'ws';
import { MessageType, ProtocolErrorCode, type ProtocolMessage } from '@monky/shared';
import { RecentSoundCacheService } from './application/services/RecentSoundCacheService';
import { DatabaseConnection } from './infrastructure/database/DatabaseConnection';
import { SqliteServerRepository } from './infrastructure/database/SqliteRepositories';
import { WebSocketServer } from './infrastructure/websocket/WebSocketServer';
import { RateLimiter } from './infrastructure/security/RateLimiter';

async function fixture(maxTotalBytes = 1024) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'monky-recent-sounds-'));
  const service = new RecentSoundCacheService(root, maxTotalBytes);
  await service.initialize();
  await service.configure(true, 10);
  return { root, service, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

function sound(soundName: string, bytes: string) {
  return {
    soundName,
    mimeType: 'audio/mpeg' as const,
    bytes: Buffer.from(bytes),
    userId: 'user-1',
    userName: 'QA Tester',
  };
}

test('moves repeated bytes to the front as one entry, including across users', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const first = await f.service.record(sound('First', 'same-bytes'));
  const second = await f.service.record({
    ...sound('Second', 'same-bytes'),
    userId: 'user-2',
    userName: 'Another Tester',
  });
  assert.ok(first && second);
  assert.equal(first.id, second.id);
  assert.deepEqual(await f.service.list(), [second]);
  assert.equal((await fs.readdir(path.join(f.root, 'recent-sounds', 'blobs'))).length, 1);
  assert.equal((await f.service.download(first.id))?.audioBase64, Buffer.from('same-bytes').toString('base64'));
});

test('trims FIFO entries and deletes a blob only after its final reference', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.service.configure(true, 2);
  await f.service.record(sound('First', 'shared'));
  await f.service.record(sound('Second', 'shared'));
  await f.service.record(sound('Third', 'unique'));
  assert.deepEqual((await f.service.list()).map((entry) => entry.soundName), ['Third', 'Second']);
  assert.equal((await fs.readdir(path.join(f.root, 'recent-sounds', 'blobs'))).length, 2);
  await f.service.record(sound('Fourth', 'other'));
  assert.deepEqual((await f.service.list()).map((entry) => entry.soundName), ['Fourth', 'Third']);
  assert.equal((await fs.readdir(path.join(f.root, 'recent-sounds', 'blobs'))).length, 2);
});

test('persists entries across restart and enforces the defensive disk cap', async (t) => {
  const f = await fixture(10);
  t.after(f.cleanup);
  await f.service.record(sound('First', '12345678'));
  await f.service.record(sound('Second', 'abcdefgh'));
  assert.deepEqual((await f.service.list()).map((entry) => entry.soundName), ['Second']);
  const reopened = new RecentSoundCacheService(f.root, 10);
  await reopened.initialize();
  assert.deepEqual((await reopened.list()).map((entry) => entry.soundName), ['Second']);
});

test('disabling clears the index and blobs', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.service.record(sound('First', 'bytes'));
  await f.service.configure(false, 10);
  assert.deepEqual(await f.service.list(), []);
  assert.deepEqual(await fs.readdir(path.join(f.root, 'recent-sounds', 'blobs')), []);
  assert.equal(await f.service.record(sound('Ignored', 'disabled')), null);
});

test('recovers a corrupt index without exposing invalid entries', async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await fs.writeFile(path.join(f.root, 'recent-sounds', 'index.json'), '{broken', 'utf8');
  const reopened = new RecentSoundCacheService(f.root);
  const result = await reopened.initialize();
  assert.equal(result.recoveredCorruptIndex, true);
  assert.deepEqual(await reopened.list(), []);
  assert.ok((await fs.readdir(path.join(f.root, 'recent-sounds')))
    .some((file) => file.startsWith('index.json.corrupt-')));
});

test('persists cache settings through database reopen', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'monky-recent-settings-'));
  let reopened: DatabaseConnection | null = null;
  t.after(async () => {
    reopened?.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const file = path.join(root, 'server.db');
  const first = await DatabaseConnection.create(file);
  const repository = new SqliteServerRepository(first.getDb());
  await repository.createServer({
    id: 'server', name: 'Server', passwordHash: '', createdAt: Date.now(), maxUsers: 0,
  });
  await repository.updateServer({ recentSoundCacheEnabled: true, recentSoundCacheLimit: 7 });
  first.close();
  reopened = await DatabaseConnection.create(file);
  const stored = await new SqliteServerRepository(reopened.getDb()).getServer();
  assert.equal(stored?.recentSoundCacheEnabled, true);
  assert.equal(stored?.recentSoundCacheLimit, 7);
});

test('allows human members to list and download but denies bots', async () => {
  const server = Object.create(WebSocketServer.prototype) as WebSocketServer;
  const ws = Object.create(WebSocket.prototype) as WebSocket;
  Object.defineProperty(ws, 'readyState', { value: WebSocket.OPEN });
  const messages: ProtocolMessage[] = [];
  const entry = {
    id: 'ef9f2a9a-8e6f-4392-b47a-579af4ed571c',
    soundName: 'Recent sound',
    mimeType: 'audio/mpeg' as const,
    sizeBytes: 5,
    playedAt: Date.now(),
    userId: 'user-1',
    userName: 'QA Tester',
  };
  server['serverRepo'] = {
    getServer: async () => ({
      id: 'server', name: 'Server', passwordHash: '', createdAt: 1, maxUsers: 0,
      recentSoundCacheEnabled: true, recentSoundCacheLimit: 20,
    }),
    createServer: async () => {},
    updateServer: async () => {},
  };
  let recorded = 0;
  Object.defineProperty(server, 'recentSoundCache', { value: {
    record: async () => { recorded++; return entry; },
    list: async () => [entry],
    download: async (id: string) => id === entry.id
      ? { ...entry, audioBase64: Buffer.from('audio').toString('base64') } : null,
  } as unknown as RecentSoundCacheService });
  server['send'] = (_socket, message) => { messages.push(message); };
  Object.defineProperty(server, 'rateLimiter', { value: new RateLimiter() });
  const session: Parameters<WebSocketServer['handleRecentSoundsList']>[0] = {
    ws, sessionId: 'session', isAlive: true, ip: '127.0.0.1', messageQueue: Promise.resolve(),
    protocol: { version: 34, minimumVersion: 31, features: ['recent-sounds'] },
    user: {
      id: 'user-1', clientId: 'client', sessionId: 'session',
      nickname: 'QA Tester', status: 'ONLINE', joinedAt: 1,
    },
  };
  server['sessions'] = new Map([[ws, session]]);
  server['requirePermission'] = async () => true;
  await server['handleRecentSoundRecord'](session, {
    soundName: 'Local preview',
    mimeType: 'audio/mpeg',
    audioBase64: Buffer.from('audio').toString('base64'),
  }, 'record-request');
  assert.equal(recorded, 1);
  assert.equal(messages.at(-1)?.type, MessageType.RECENT_SOUND_ADDED);
  await server['handleRecentSoundsList'](session, 'list-request');
  assert.equal(messages.at(-1)?.type, MessageType.RECENT_SOUNDS_RESULT);
  assert.deepEqual((messages.at(-1)?.payload as { items: unknown[] }).items, [entry]);
  await server['handleRecentSoundDownload'](session, { id: entry.id }, 'download-request');
  assert.equal(messages.at(-1)?.type, MessageType.RECENT_SOUND_DATA);
  for (let index = 0; index < 9; index++) {
    await server['handleRecentSoundDownload'](session, { id: entry.id }, `download-${index}`);
    assert.equal(messages.at(-1)?.type, MessageType.RECENT_SOUND_DATA);
  }
  await server['handleRecentSoundDownload'](session, { id: entry.id }, 'download-limited');
  assert.equal(messages.at(-1)?.type, MessageType.SERVER_ERROR);
  assert.equal((messages.at(-1)?.payload as { code: ProtocolErrorCode }).code, ProtocolErrorCode.RATE_LIMITED);

  session.isBot = true;
  await server['handleRecentSoundsList'](session, 'bot-request');
  assert.equal(messages.at(-1)?.type, MessageType.SERVER_ERROR);
  assert.equal((messages.at(-1)?.payload as { code: ProtocolErrorCode }).code, ProtocolErrorCode.PERMISSION_DENIED);
});
