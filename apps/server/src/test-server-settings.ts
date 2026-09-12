import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { MessageType, ProtocolErrorCode, type ProtocolMessage, type ServerSettingsUpdatedPayload } from '@monky/shared';
import { WebSocketServer } from './infrastructure/websocket/WebSocketServer';
import { AuthService } from './application/services/AuthService';
import { CoturnManager } from './infrastructure/turn/CoturnManager';
import { SfuManager } from './infrastructure/sfu/SfuManager';
import type { ServerRecord } from './domain/entities';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const flush = async () => { for (let index = 0; index < 16; index++) await Promise.resolve(); };

function fixture() {
  const server = Object.create(WebSocketServer.prototype) as WebSocketServer;
  const ws = Object.create(WebSocket.prototype) as WebSocket;
  Object.defineProperty(ws, 'readyState', { value: WebSocket.OPEN });
  const session: Parameters<WebSocketServer['handleServerUpdateSettings']>[0] = {
    ws, sessionId: 'admin-session', isAlive: true, ip: '127.0.0.1', messageQueue: Promise.resolve(),
    user: { id: 'admin', clientId: 'admin-key', sessionId: 'admin-session', nickname: 'Admin', status: 'ONLINE', joinedAt: 1 },
  };
  const record: ServerRecord = {
    id: 'server', name: 'Server', createdAt: 1, maxUsers: 0, passwordHash: '',
    voiceMode: 'p2p', turnEnabled: false, turnSecret: 'test-secret',
  };
  let allowed = true;
  let running = false;
  let writes = 0;
  const messages: ProtocolMessage[] = [];
  server['sessions'] = new Map([[ws, session]]);
  server['sessionSockets'] = new Map([['admin-session', ws]]);
  server['settingsUpdateQueue'] = Promise.resolve();
  server['voiceReconnectGrants'] = new Map();
  server['serverRepo'] = {
    getServer: async () => ({ ...record }), createServer: async () => {},
    updateServer: async (patch) => { Object.assign(record, patch); },
  };
  const auth = Object.create(AuthService.prototype) as AuthService;
  auth.updateServerSettings = async (patch) => {
    writes++;
    if (patch.name !== undefined) record.name = patch.name;
    if (patch.voiceMode !== undefined) record.voiceMode = patch.voiceMode;
    if (patch.turnEnabled !== undefined) record.turnEnabled = patch.turnEnabled;
    if (record.voiceMode === 'sfu') record.turnEnabled = false;
    return { success: true, name: record.name, hasPassword: false, voiceMode: record.voiceMode, turnEnabled: record.turnEnabled };
  };
  server['authService'] = auth;
  const turn = Object.create(CoturnManager.prototype) as CoturnManager;
  turn.start = async () => { running = true; return true; };
  turn.stop = async () => { running = false; };
  turn.isRunning = () => running;
  server['coturnManager'] = turn;
  server['ensureRelayCanRun'] = async () => null;
  const sfu = new SfuManager();
  sfu.checkPortAvailability = async () => null;
  sfu.init = async () => true;
  server['sfuManager'] = sfu;
  server['requirePermission'] = async (_session, _permission, requestId) => {
    if (!allowed) server['sendError'](ws, ProtocolErrorCode.PERMISSION_DENIED, 'Permission revoked', requestId);
    return allowed;
  };
  server['broadcast'] = (message) => { messages.push(message); };
  server['send'] = (_socket, message) => { messages.push(message); };
  return {
    server, session, record, messages, turn, sfu, writes: () => writes,
    revoke: () => { allowed = false; },
  };
}

test('settings acknowledgement waits for TURN installation and actual activation, not progress or persistence', async () => {
  const f = fixture();
  const installation = deferred();
  const activation = deferred();
  f.server['ensureRelayCanRun'] = async () => { await installation.promise; return null; };
  f.server['applyTurnState'] = async () => { await activation.promise; };
  const pending = f.server['handleServerUpdateSettings'](f.session, { turnEnabled: true }, 'turn-request');
  await flush();
  assert.equal(f.writes(), 0);
  assert.equal(f.messages.length, 0);
  installation.resolve();
  await flush();
  assert.equal(f.record.turnEnabled, true);
  assert.equal(f.messages.length, 0, 'persistence is not runtime completion');
  activation.resolve();
  await pending;
  assert.equal(f.messages.at(-1)?.type, MessageType.SERVER_SETTINGS_UPDATED);
  assert.equal(f.messages.at(-1)?.requestId, 'turn-request');
});

test('failed TURN startup publishes persisted false before a correlated error, and allows a real retry', async (t) => {
  const f = fixture();
  f.turn.start = async () => false;
  t.mock.method(CoturnManager, 'checkPortReachability', async () => null);
  await f.server['handleServerUpdateSettings'](f.session, { turnEnabled: true }, 'failed-start');
  assert.equal(f.record.turnEnabled, false);
  assert.equal(f.messages[0]?.type, MessageType.SERVER_SETTINGS_UPDATED);
  assert.equal(f.messages[0]?.requestId, undefined);
  assert.equal((f.messages[0]?.payload as ServerSettingsUpdatedPayload).turnEnabled, false);
  assert.equal(f.messages.at(-1)?.type, MessageType.SERVER_ERROR);
  assert.equal(f.messages.at(-1)?.requestId, 'failed-start');
  f.turn.start = async () => true;
  f.turn.isRunning = () => true;
  await f.server['handleServerUpdateSettings'](f.session, { turnEnabled: true }, 'retry-start');
  assert.equal(f.record.turnEnabled, true);
  assert.equal(f.messages.at(-1)?.type, MessageType.SERVER_SETTINGS_UPDATED);
  assert.equal(f.messages.at(-1)?.requestId, 'retry-start');
});

test('a spawned relay that died before acknowledgement cannot report success', async () => {
  const f = fixture();
  f.turn.start = async () => true;
  f.turn.isRunning = () => false;
  await f.server['handleServerUpdateSettings'](f.session, { turnEnabled: true }, 'dead-process');
  assert.equal(f.record.turnEnabled, false);
  assert.equal(f.messages.at(-1)?.type, MessageType.SERVER_ERROR);
  assert.equal(f.messages.at(-1)?.requestId, 'dead-process');
});

test('SFU initialization failures reject the request before mode persistence and remain retryable', async () => {
  const f = fixture();
  f.sfu.init = async () => false;
  f.sfu.getLastError = () => 'Worker unavailable';
  await f.server['handleServerUpdateSettings'](f.session, { voiceMode: 'sfu' }, 'sfu-failed');
  assert.equal(f.record.voiceMode, 'p2p');
  assert.equal(f.writes(), 0);
  assert.equal(f.messages.at(-1)?.type, MessageType.SERVER_ERROR);
  assert.equal(f.messages.at(-1)?.requestId, 'sfu-failed');
  f.sfu.init = async () => true;
  await f.server['handleServerUpdateSettings'](f.session, { voiceMode: 'sfu' }, 'sfu-retry');
  assert.equal(f.record.voiceMode, 'sfu');
  assert.equal(f.messages.at(-1)?.type, MessageType.SERVER_SETTINGS_UPDATED);
  assert.equal(f.messages.at(-1)?.requestId, 'sfu-retry');
});

test('permission loss and replaced sessions during installation cannot commit a stale queued edit', async () => {
  for (const invalidation of ['permission', 'session']) {
    const f = fixture();
    const installation = deferred();
    f.server['ensureRelayCanRun'] = async () => { await installation.promise; return null; };
    const pending = f.server['handleServerUpdateSettings'](f.session, { turnEnabled: true }, 'stale');
    await flush();
    if (invalidation === 'permission') f.revoke();
    else f.session.replaced = true;
    installation.resolve();
    await pending;
    assert.equal(f.writes(), 0);
    assert.equal(f.record.turnEnabled, false);
    assert.equal(f.messages.some((message) => message.type === MessageType.SERVER_SETTINGS_UPDATED), false);
  }
});

test('TURN in already-persisted SFU mode is refused before attempting an installation', async () => {
  const f = fixture();
  f.record.voiceMode = 'sfu';
  let installs = 0;
  f.server['ensureRelayCanRun'] = async () => { installs++; return null; };
  await f.server['handleServerUpdateSettings'](f.session, { turnEnabled: true }, 'incompatible');
  assert.equal(installs, 0);
  assert.equal(f.writes(), 0);
  assert.equal(f.messages.at(-1)?.type, MessageType.SERVER_ERROR);
  assert.equal(f.messages.at(-1)?.requestId, 'incompatible');
});

test('application heartbeat bypasses a long activation without reordering queued configuration changes', async () => {
  const f = fixture();
  const activation = deferred();
  f.server['applyTurnState'] = async () => { await activation.promise; };
  const receive = (type: MessageType, payload: object, requestId: string) =>
    f.server['receiveMessage'](f.session, Buffer.from(JSON.stringify({ type, payload, requestId })));
  receive(MessageType.SERVER_UPDATE_SETTINGS, { turnEnabled: true }, 'activation');
  await flush();
  receive(MessageType.SERVER_UPDATE_SETTINGS, { name: 'After activation' }, 'rename');
  receive(MessageType.PING, { timestamp: 1 }, 'heartbeat');
  await flush();
  assert.equal(f.record.name, 'Server');
  assert.deepEqual(f.messages.map((message) => [message.type, message.requestId]), [[MessageType.PONG, 'heartbeat']]);
  activation.resolve();
  await f.session.messageQueue;
  assert.equal(f.record.name, 'After activation');
  assert.deepEqual(f.messages.filter((message) => message.type === MessageType.SERVER_SETTINGS_UPDATED).map((message) => message.requestId), ['activation', 'rename']);
});

test('unexpected asynchronous handler failure sends a correlated error and does not poison the socket queue', async () => {
  const f = fixture();
  const update = f.server['authService'].updateServerSettings;
  f.server['authService'].updateServerSettings = async () => { throw new Error('Persistence failed'); };
  f.server['receiveMessage'](f.session, Buffer.from(JSON.stringify({
    type: MessageType.SERVER_UPDATE_SETTINGS, payload: { name: 'Rejected name' }, requestId: 'failed-write',
  })));
  await f.session.messageQueue;
  assert.equal(f.record.name, 'Server');
  assert.equal(f.messages.at(-1)?.type, MessageType.SERVER_ERROR);
  assert.equal(f.messages.at(-1)?.requestId, 'failed-write');
  f.server['authService'].updateServerSettings = update;
  f.server['receiveMessage'](f.session, Buffer.from(JSON.stringify({
    type: MessageType.SERVER_UPDATE_SETTINGS, payload: { name: 'Retry' }, requestId: 'retried-write',
  })));
  await f.session.messageQueue;
  assert.equal(f.record.name, 'Retry');
  assert.equal(f.messages.at(-1)?.type, MessageType.SERVER_SETTINGS_UPDATED);
  assert.equal(f.messages.at(-1)?.requestId, 'retried-write');
});
