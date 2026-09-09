import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import type { types as MediasoupTypes } from 'mediasoup';
import { AuthSuccessPayload, MessageType, Permission, ProtocolErrorCode, ServerDetails, ServerErrorPayload, UserSummary, VoiceConnectionHealth, VoiceUserJoinedPayload, SfuProducersListPayload, hasPermission } from '@monky/shared';
import { AuthService } from './application/services/AuthService';
import { PermissionService } from './application/services/PermissionService';
import { UserService } from './application/services/UserService';
import { SignalingService } from './application/services/SignalingService';
import { ChannelRecord, VoiceRestrictions } from './domain/entities';
import type { IVoiceRestrictionRepository } from './domain/repositories';
import { DatabaseConnection } from './infrastructure/database/DatabaseConnection';
import { SqliteVoiceRestrictionRepository } from './infrastructure/database/SqliteVoiceRestrictionRepository';
import { SfuManager, SfuProducerClosedError } from './infrastructure/sfu/SfuManager';
import { WebSocketServer } from './infrastructure/websocket/WebSocketServer';

function memoryRestrictions(): IVoiceRestrictionRepository {
  const saved = new Map<string, VoiceRestrictions>();
  return {
    getForUser: (id) => ({ ...(saved.get(id) ?? { serverMuted: false, serverDeafened: false }) }),
    save: (id, restrictions) => { saved.set(id, { ...restrictions }); },
  };
}

function signaling(restrictions: IVoiceRestrictionRepository = memoryRestrictions()) {
  const channel: ChannelRecord = {
    id: 'room', serverId: 'server', name: 'Voice', type: 'VOICE', position: 0,
    createdAt: 1, maxParticipants: 10, isPrivate: false, allowedRoleIds: [], botCommandsEnabled: false,
  };
  return new SignalingService({
    findById: async (id) => ({ ...channel, id }), listByServerId: async () => [channel],
    create: async () => {}, update: async () => {}, delete: async () => {}, updatePosition: async () => {},
  }, restrictions);
}

test('administrative voice restrictions belong to the user on this server, not a disposable connection', async () => {
  const service = signaling();
  await service.joinVoiceChannel('one', 'alice', 'room');
  await service.joinVoiceChannel('two', 'alice', 'other-room');
  await service.joinVoiceChannel('bob', 'bob', 'room');
  assert.equal(service.setServerMuted('alice', true).length, 2);
  assert.equal(service.setServerDeafened('alice', true).length, 2);
  assert.equal(service.getVoiceState('two')?.serverMuted, true);
  assert.equal(service.getVoiceState('one')?.serverDeafened, true);
  assert.equal(service.getVoiceState('bob')?.serverMuted, false);
  assert.equal(service.getVoiceState('bob')?.serverDeafened, false);

  const forged = service.updateVoiceState('one', { serverMuted: false, serverDeafened: false, isSpeaking: true });
  assert.equal(forged?.serverMuted, true, 'ordinary voice updates cannot clear administrative restrictions');
  assert.equal(forged?.serverDeafened, true);
  assert.equal(forged?.isSpeaking, false);
  service.leaveVoiceChannel('one');
  service.leaveVoiceChannel('two');
  assert.deepEqual(service.getVoiceRestrictions('alice'), { serverMuted: true, serverDeafened: true });
  const rejoined = await service.joinVoiceChannel('new-session', 'alice', 'room', false, false);
  assert.equal(rejoined.voiceState?.serverMuted, true, 'fresh connection does not bypass mute');
  assert.equal(rejoined.voiceState?.serverDeafened, true, 'fresh connection does not bypass deafen');
  assert.equal(rejoined.voiceState?.isMuted, false, 'manual preferences remain independent');

  service.clearAllVoiceStates();
  const switchedMode = await service.joinVoiceChannel('after-mode-switch', 'alice', 'room');
  assert.equal(switchedMode.voiceState?.serverMuted, true, 'transport teardown does not clear moderation');
  assert.equal(switchedMode.voiceState?.serverDeafened, true);
  const otherServer = signaling();
  const elsewhere = await otherServer.joinVoiceChannel('elsewhere', 'alice', 'room');
  assert.equal(elsewhere.voiceState?.serverMuted, false);
  assert.equal(elsewhere.voiceState?.serverDeafened, false);

  service.setServerMuted('alice', false);
  assert.equal(service.getVoiceState('after-mode-switch')?.serverDeafened, true, 'unmute does not clear deafen');
  service.setServerDeafened('alice', false);
  service.leaveVoiceChannel('after-mode-switch');
  const cleared = await service.joinVoiceChannel('cleared', 'alice', 'room');
  assert.equal(cleared.voiceState?.serverMuted, false);
  assert.equal(cleared.voiceState?.serverDeafened, false, 'explicit administrative removal persists too');
});

test('authentication supplies the current identity restriction before voice, after asynchronous ICE setup', async () => {
  const restrictions = memoryRestrictions();
  const service = signaling(restrictions);
  const server = Object.create(WebSocketServer.prototype) as WebSocketServer;
  const auth = Object.create(AuthService.prototype) as AuthService;
  server['authService'] = auth;
  server['signalingService'] = service;
  server['sessions'] = new Map();
  server['sessionSockets'] = new Map();
  server['reconnectTimers'] = new Map();
  server['closing'] = false;
  server['broadcastRolesState'] = async () => {};
  server['handleCommandsList'] = () => {};
  const messages: Parameters<WebSocketServer['send']>[1][] = [];
  server['send'] = (_socket, message) => { messages.push(message); };
  server['broadcast'] = () => {};
  const details: ServerDetails = {
    id: 'server', name: 'Policy fixture', createdAt: 1, maxUsers: 10,
    channels: [], members: [], voiceStates: {},
  };

  for (const blocked of [true, false]) {
    const user: UserSummary = {
      id: 'alice', sessionId: `alice-${blocked}`, clientId: 'alice-client',
      nickname: 'Alice', status: 'ONLINE', joinedAt: 1,
    };
    const socket = Object.create(WebSocket.prototype) as WebSocket;
    Object.defineProperty(socket, 'readyState', { value: WebSocket.OPEN });
    const session: Parameters<WebSocketServer['handleAuthChallengeResponse']>[0] = {
      ws: socket, isAlive: true, ip: '127.0.0.1', messageQueue: Promise.resolve(),
    };
    server['sessions'].set(socket, session);
    auth.verifyChallengeResponse = async () => ({ success: true, user, serverDetails: details });
    server['buildIceServersFor'] = async () => {
      await Promise.resolve();
      restrictions.save(user.id, { serverMuted: blocked, serverDeafened: blocked });
      return [];
    };
    await server['handleAuthChallengeResponse'](session, { signature: 'fixture' }, `auth-${blocked}`);
    const response = messages.find((message) => message.requestId === `auth-${blocked}`);
    assert.equal(response?.type, MessageType.AUTH_SUCCESS);
    const payload = response?.payload as AuthSuccessPayload;
    assert.deepEqual(payload.voiceRestrictions, { serverMuted: blocked, serverDeafened: blocked },
      'the login snapshot must include the latest persisted policy, not a pre-ICE or previous-login value');
    assert.deepEqual(payload.server.voiceStates, {}, 'restrictions do not require or create voice membership');
    assert.equal(payload.currentUser.id, 'alice');
    const beforeDisconnect = messages.length;
    server['buildIceServersFor'] = async () => {
      server['sessions'].delete(socket);
      return [];
    };
    await server['handleAuthChallengeResponse'](session, { signature: 'fixture' }, 'disconnected-during-ice');
    assert.equal(messages.length, beforeDisconnect, 'a departed connection must not receive a late auth snapshot');
  }
  assert.deepEqual(service.getVoiceRestrictions('bob'), { serverMuted: false, serverDeafened: false });
});

test('moderation applied while admission awaits a channel cannot be bypassed by that join', async (t) => {
  const service = signaling();
  await service.joinVoiceChannel('one', 'alice', 'room');
  const channel = await service['channelRepo'].findById('room');
  let release = () => {};
  const pending = new Promise<void>((resolve) => { release = resolve; });
  t.mock.method(service['channelRepo'], 'findById', async () => { await pending; return channel; });
  const joining = service.joinVoiceChannel('two', 'alice', 'room', false, false);
  service.setServerMuted('alice', true);
  service.setServerDeafened('alice', true);
  release();
  const result = await joining;
  assert.equal(result.voiceState?.serverMuted, true);
  assert.equal(result.voiceState?.serverDeafened, true);
});

test('failed moderation persistence never updates the live roster or reports successful moderation', async () => {
  const failure = new Error('Unable to persist voice restriction');
  const service = signaling({
    getForUser: () => ({ serverMuted: false, serverDeafened: false }),
    save: () => { throw failure; },
  });
  await service.joinVoiceChannel('one', 'alice', 'room');
  assert.throws(() => service.setServerMuted('alice', true), (error) => error === failure);
  assert.equal(service.getVoiceState('one')?.serverMuted, false);
  service.leaveVoiceChannel('one');
  assert.throws(() => service.setServerMuted('alice', true), (error) => error === failure);
  assert.deepEqual(service.getAllVoiceStates(), {});
});

function moderationFixture() {
  const service = signaling();
  const server = Object.create(WebSocketServer.prototype) as WebSocketServer;
  server['signalingService'] = service;
  server['closing'] = false;
  const grants = { bits: Permission.MUTE_MEMBERS | Permission.DEAFEN_MEMBERS };
  const permissions = Object.create(PermissionService.prototype) as PermissionService;
  permissions.getUserPermissions = async (id) => id === 'moderator' ? grants.bits : 0;
  permissions.checkPermission = async (id, permission) => hasPermission(await permissions.getUserPermissions(id), permission);
  server['permissionService'] = permissions;
  const users = Object.create(UserService.prototype) as UserService;
  users.isMember = async (id) => ['alice', 'bob', 'offline', 'moderator'].includes(id);
  server['userService'] = users;
  const messages: Parameters<WebSocketServer['broadcast']>[0][] = [];
  server['broadcast'] = (message) => { messages.push(message); };
  type Session = Parameters<WebSocketServer['handleMessage']>[0];
  const clients = ['moderator', 'one', 'two', 'idle', 'bob'].map((id): Session => {
    const ws = Object.create(WebSocket.prototype) as WebSocket;
    Object.defineProperty(ws, 'readyState', { value: WebSocket.OPEN });
    return {
      ws, sessionId: id, isAlive: true, ip: '127.0.0.1', messageQueue: Promise.resolve(),
      user: { id: ['moderator', 'bob'].includes(id) ? id : 'alice', clientId: id, sessionId: id, nickname: id, status: 'ONLINE', joinedAt: 1 },
    };
  });
  server['sessions'] = new Map(clients.map((client) => [client.ws, client]));
  server['sessionSockets'] = new Map(clients.map((client) => [client.sessionId!, client.ws]));
  const direct: Array<{ socket: WebSocket; message: Parameters<WebSocketServer['send']>[1] }> = [];
  server['send'] = (socket, message) => { direct.push({ socket, message }); };
  const session = clients[0];
  let sequence = 0;
  const request = async (type: MessageType, payload: unknown) => {
    const requestId = `moderation-${++sequence}`;
    await server['handleMessage'](session, { type, payload, requestId });
    const response = direct.find(({ socket, message }) => socket === session.ws && message.requestId === requestId)?.message;
    assert.ok(response, 'every valid connection receives a correlated response, including outside voice');
    return response;
  };
  return { server, service, grants, users, clients, session, messages, direct, request };
}

test('administrative identity changes cover every voice and idle device without exposing other users', async () => {
  const f = moderationFixture();
  await f.service.joinVoiceChannel('one', 'alice', 'room');
  await f.service.joinVoiceChannel('two', 'alice', 'room');
  const response = await f.request(MessageType.ADMIN_MUTE_USER, { targetUserId: 'alice', muted: true });
  assert.equal(response.type, MessageType.VOICE_RESTRICTIONS_UPDATED);
  assert.deepEqual(response.payload, { userId: 'alice', serverMuted: true, serverDeafened: false });
  assert.equal(f.messages.filter((message) => message.type === MessageType.VOICE_STATE_CHANGED).length, 2);
  const notifications = f.direct.filter(({ message }) => !message.requestId);
  assert.deepEqual(notifications.map(({ socket }) => f.clients.find((client) => client.ws === socket)?.sessionId), ['one', 'two', 'idle'],
    'identity-policy notifications include idle devices and exclude other users');
  for (const { message } of notifications) {
    assert.equal(message.type, MessageType.VOICE_RESTRICTIONS_UPDATED);
    assert.deepEqual(message.payload, { userId: 'alice', serverMuted: true, serverDeafened: false });
  }
  f.messages.length = 0;
  f.direct.length = 0;
  await f.request(MessageType.ADMIN_DEAFEN_USER, { targetUserId: 'alice', deafened: true });
  assert.equal(f.messages.length, 2);
  assert.equal(f.direct.filter(({ message }) => !message.requestId).length, 3);
  assert.equal(f.service.getVoiceState('two')?.serverDeafened, true);
  assert.equal(f.service.getVoiceState('one')?.serverMuted, true);
});

test('administrators can apply and remove restrictions while a member is idle or fully offline', async () => {
  const f = moderationFixture();
  for (const userId of ['alice', 'offline']) {
    for (const enabled of [true, false]) {
      await f.request(MessageType.ADMIN_MUTE_USER, { targetUserId: userId, muted: enabled });
      await f.request(MessageType.ADMIN_DEAFEN_USER, { targetUserId: userId, deafened: enabled });
      const response = await f.request(MessageType.ADMIN_GET_VOICE_RESTRICTIONS, { targetUserId: userId });
      assert.deepEqual(response.payload, { userId, serverMuted: enabled, serverDeafened: enabled });
      assert.deepEqual(f.service.getAllVoiceStates(), {}, 'moderating a member must not fabricate voice membership');
    }
  }
  assert.equal(f.messages.length, 0, 'idle moderation does not broadcast fake voice participants');
  await f.request(MessageType.ADMIN_MUTE_USER, { targetUserId: 'offline', muted: true });
  const joined = await f.service.joinVoiceChannel('later-device', 'offline', 'room', false, false);
  assert.equal(joined.voiceState?.serverMuted, true, 'a later join observes the restriction set while offline');
  assert.equal(joined.voiceState?.isMuted, false, 'personal preferences are not rewritten');
});

test('voice-policy reads and writes preserve permissions and reject invalid or missing identities', async () => {
  const f = moderationFixture();
  const error = (message: Awaited<ReturnType<typeof f.request>>, code: ProtocolErrorCode) => {
    assert.equal(message.type, MessageType.SERVER_ERROR);
    assert.equal((message.payload as ServerErrorPayload).code, code);
  };
  f.grants.bits = 0;
  for (const [type, payload] of [
    [MessageType.ADMIN_GET_VOICE_RESTRICTIONS, { targetUserId: 'alice' }],
    [MessageType.ADMIN_MUTE_USER, { targetUserId: 'alice', muted: true }],
    [MessageType.ADMIN_DEAFEN_USER, { targetUserId: 'alice', deafened: true }],
  ] as const) {
    error(await f.request(type, payload), ProtocolErrorCode.PERMISSION_DENIED);
  }
  f.grants.bits = Permission.MUTE_MEMBERS;
  assert.equal((await f.request(MessageType.ADMIN_GET_VOICE_RESTRICTIONS, { targetUserId: 'alice' })).type, MessageType.VOICE_RESTRICTIONS_UPDATED);
  error(await f.request(MessageType.ADMIN_DEAFEN_USER, { targetUserId: 'alice', deafened: true }), ProtocolErrorCode.PERMISSION_DENIED);
  f.grants.bits = Permission.DEAFEN_MEMBERS;
  assert.equal((await f.request(MessageType.ADMIN_GET_VOICE_RESTRICTIONS, { targetUserId: 'alice' })).type, MessageType.VOICE_RESTRICTIONS_UPDATED);
  error(await f.request(MessageType.ADMIN_MUTE_USER, { targetUserId: 'alice', muted: true }), ProtocolErrorCode.PERMISSION_DENIED);
  f.grants.bits = Permission.MUTE_MEMBERS | Permission.DEAFEN_MEMBERS;
  for (const [type, payload] of [
    [MessageType.ADMIN_GET_VOICE_RESTRICTIONS, { targetUserId: 'missing' }],
    [MessageType.ADMIN_MUTE_USER, { targetUserId: 'missing', muted: true }],
    [MessageType.ADMIN_DEAFEN_USER, { targetUserId: 'missing', deafened: false }],
    [MessageType.ADMIN_MUTE_USER, { targetSessionId: 'one', muted: true }],
    [MessageType.ADMIN_MUTE_USER, { targetUserId: 'alice', muted: 'false' }],
    [MessageType.ADMIN_DEAFEN_USER, { targetUserId: 'alice', deafened: 1 }],
  ] as const) {
    error(await f.request(type, payload), ProtocolErrorCode.BAD_REQUEST);
  }
  assert.deepEqual(f.service.getVoiceRestrictions('alice'), { serverMuted: false, serverDeafened: false });
  assert.equal(f.messages.length, 0);
});

test('leaving voice during an administrative request does not cancel the identity restriction', async () => {
  const f = moderationFixture();
  await f.service.joinVoiceChannel('one', 'alice', 'room');
  f.users.isMember = async (id) => {
    f.service.leaveVoiceChannel('one');
    return id === 'alice';
  };
  const response = await f.request(MessageType.ADMIN_MUTE_USER, { targetUserId: 'alice', muted: true });
  assert.equal(response.type, MessageType.VOICE_RESTRICTIONS_UPDATED);
  assert.equal(f.service.getVoiceRestrictions('alice').serverMuted, true);
  assert.deepEqual(f.service.getAllVoiceStates(), {});
});

test('permissions revoked during member lookup prevent the pending moderation write', async () => {
  const f = moderationFixture();
  f.users.isMember = async () => {
    f.grants.bits = 0;
    return true;
  };
  const response = await f.request(MessageType.ADMIN_MUTE_USER, { targetUserId: 'alice', muted: true });
  assert.equal(response.type, MessageType.SERVER_ERROR);
  assert.equal((response.payload as ServerErrorPayload).code, ProtocolErrorCode.PERMISSION_DENIED);
  assert.equal(f.service.getVoiceRestrictions('alice').serverMuted, false);
  assert.equal(f.messages.length, 0);
  assert.equal(f.direct.filter(({ message }) => !message.requestId).length, 0);
});

test('SQLite voice restrictions survive restart, stay server-scoped and cascade with membership deletion', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-voice-restrictions-'));
  const filename = path.join(directory, 'server-a.db');
  let database: DatabaseConnection | undefined;
  let otherDatabase: DatabaseConnection | undefined;
  try {
    database = await DatabaseConnection.create(filename);
    database.getDb().prepare(
      'INSERT INTO users (id, client_id, nickname, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)'
    ).run('alice', 'alice-device', 'Alice', 1, 1);
    const service = signaling(new SqliteVoiceRestrictionRepository(database.getDb()));
    await service.joinVoiceChannel('one', 'alice', 'room');
    service.setServerMuted('alice', true);
    service.setServerDeafened('alice', true);
    service.leaveVoiceChannel('one');
    database.close();
    database = undefined;
    database = await DatabaseConnection.create(filename);
    const restrictions = new SqliteVoiceRestrictionRepository(database.getDb());
    const restored = signaling(restrictions);
    assert.deepEqual(restored.getVoiceRestrictions('alice'), { serverMuted: true, serverDeafened: true },
      'a restarted server can report the policy before the user joins voice');
    assert.deepEqual(restored.getAllVoiceStates(), {});
    const joined = await restored.joinVoiceChannel('new-session', 'alice', 'room');
    assert.equal(joined.voiceState?.serverMuted, true);
    assert.equal(joined.voiceState?.serverDeafened, true);
    otherDatabase = await DatabaseConnection.create(path.join(directory, 'server-b.db'));
    assert.deepEqual(new SqliteVoiceRestrictionRepository(otherDatabase.getDb()).getForUser('alice'), {
      serverMuted: false, serverDeafened: false,
    });
    assert.throws(() => restrictions.save('missing', { serverMuted: true, serverDeafened: false }), /FOREIGN KEY/);
    database.getDb().prepare('DELETE FROM users WHERE id = ?').run('alice');
    assert.deepEqual(restrictions.getForUser('alice'), { serverMuted: false, serverDeafened: false });
  } finally {
    database?.close();
    otherDatabase?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('voice join snapshot is captured after async broadcast and includes peers who arrived during it', async () => {
  const server = Object.create(WebSocketServer.prototype) as WebSocketServer;
  const service = signaling();
  const sfu = new SfuManager();
  server['signalingService'] = service;
  server['sfuManager'] = sfu;
  server['serverRepo'] = {
    getServer: async () => ({ id: 'server', name: 'Voice', passwordHash: '', createdAt: 1, maxUsers: 10, voiceMode: 'sfu' }),
    createServer: async () => {}, updateServer: async () => {},
  };
  type Session = Parameters<WebSocketServer['handleVoiceJoin']>[0];
  const makeSession = (id: string): Session => ({
    ws: Object.create(WebSocket.prototype) as WebSocket, sessionId: id, isAlive: true, ip: '127.0.0.1',
    messageQueue: Promise.resolve(),
    user: { id, sessionId: id, clientId: id, nickname: id, status: 'ONLINE', joinedAt: 1 },
  });
  const self = makeSession('self');
  const peer = makeSession('peer');
  const late = makeSession('late');
  const departed = makeSession('departed');
  peer.invisible = true;
  peer.user!.invisible = true;
  server['sessions'] = new Map([self, peer, late, departed].map((session) => [session.ws, session]));
  server['sessionSockets'] = new Map([self, peer, late, departed].map((session) => [session.sessionId!, session.ws]));
  await service.joinVoiceChannel('peer', 'peer', 'room');
  await service.joinVoiceChannel('departed', 'departed', 'room');
  server['broadcastToChannel'] = async (_channelId, message) => {
    assert.equal(message.type, MessageType.VOICE_USER_JOINED);
    assert.equal(message.requestId, undefined, 'the initial broadcast must not settle admission');
    assert.equal((message.payload as VoiceUserJoinedPayload).user?.id, 'self');
    service.updateVoiceState('self', { isMuted: false });
    service.setServerMuted('self', true);
    service.setServerDeafened('self', true);
    await service.joinVoiceChannel('late', 'late', 'room');
    service.leaveVoiceChannel('departed');
  };
  const messages: Parameters<WebSocketServer['send']>[1][] = [];
  server['send'] = (_ws, message) => { messages.push(message); };
  await server['handleVoiceJoin'](self, { channelId: 'room' }, 'current-admission');
  assert.equal(messages[0].requestId, 'current-admission', 'only the final direct response confirms admission');
  assert.equal((messages[0].payload as VoiceUserJoinedPayload).voiceState.serverMuted, true);
  assert.equal((messages[0].payload as VoiceUserJoinedPayload).voiceState.serverDeafened, true);
  const roster = (messages[0].payload as VoiceUserJoinedPayload).participants!;
  assert.deepEqual(roster.map((p) => p.voiceState.sessionId).sort(), ['late', 'peer', 'self']);
  assert.equal(roster.find((p) => p.user.id === 'self')?.voiceState.connectionHealth, 'connecting');
  const maskedPeer = roster.find((p) => p.user.id === 'peer')!;
  assert.equal(maskedPeer.user.status, 'DISCONNECTED');
  assert.equal(maskedPeer.user.invisible, undefined);
  assert.equal(maskedPeer.user.sessionId, 'peer', 'voice keeps the physical session address');
  assert.equal(server['getVoiceRoster']('room', 'peer').find((p) => p.user.id === 'peer')?.user.invisible, true);
  await server['handleSfuGetProducers'](self, { channelId: 'room' });
  const resync = messages[1].payload as SfuProducersListPayload;
  assert.deepEqual(resync.participants, roster, 'media rejoin reconciles even muted/listen-only peers with no producer');
  assert.equal(service.getParticipantsInChannel('room').length, 3, 'media resync never evicts live participants');
  server['broadcastToChannel'] = async () => { service.leaveVoiceChannel('self'); };
  await server['handleVoiceJoin'](self, { channelId: 'room' }, 'interrupted-admission');
  assert.equal(messages.at(-1)?.type, MessageType.SERVER_ERROR, 'interrupted admission rejects instead of leaving the request pending');
  assert.equal(messages.at(-1)?.requestId, 'interrupted-admission');
});

test('SFU health is derived from both server ICE/DTLS transports, not signaling or producer presence', () => {
  const sfu = new SfuManager();
  const reports: VoiceConnectionHealth[] = [];
  sfu.setHealthListener((_sessionId, _channelId, health) => reports.push(health));
  const transport = (id: string) => ({
    id, closed: false, iceState: 'new', dtlsState: 'new', close() {},
  } as MediasoupTypes.WebRtcTransport);
  const send = transport('send');
  const recv = transport('recv');
  sfu['transports'].set('send', { transport: send, sessionId: 'peer', channelId: 'room', direction: 'send' });
  sfu['transports'].set('recv', { transport: recv, sessionId: 'peer', channelId: 'room', direction: 'recv' });
  const state = (target: MediasoupTypes.WebRtcTransport, ice: string, dtls: string, closed = false) => {
    Object.defineProperties(target, {
      iceState: { configurable: true, value: ice }, dtlsState: { configurable: true, value: dtls },
      closed: { configurable: true, value: closed },
    });
    sfu['updateTransportHealth'](target.id);
  };
  state(send, 'new', 'new');
  assert.equal(reports.at(-1), 'connecting');
  state(recv, 'completed', 'connected');
  assert.equal(reports.at(-1), 'connected', 'a receive-only client can be healthy');
  state(recv, 'disconnected', 'connected');
  assert.equal(reports.at(-1), 'reconnecting');
  state(send, 'completed', 'connected');
  assert.equal(reports.at(-1), 'reconnecting', 'one healthy direction cannot clear the other outage');
  state(recv, 'completed', 'connected');
  assert.equal(reports.at(-1), 'connected');
  state(recv, 'completed', 'failed', true);
  assert.equal(reports.at(-1), 'failed');
  state(send, 'completed', 'connected');
  assert.equal(reports.at(-1), 'failed', 'a closed direction remains failed until explicitly replaced');
  sfu.close();
});

test('real missing-producer consume path replies before the delayed close broadcast without reporting transport failure', async () => {
  const server = Object.create(WebSocketServer.prototype) as WebSocketServer;
  const sfu = new SfuManager();
  server['sfuManager'] = sfu;
  const transport = { id: 'recv', closed: false, close() {} } as MediasoupTypes.WebRtcTransport;
  sfu['transports'].set('recv', { transport, sessionId: 'self', channelId: 'room', direction: 'recv' });
  sfu['producers'].set('producer', {
    producer: { id: 'producer', close() {} } as MediasoupTypes.Producer,
    sessionId: 'peer', channelId: 'room', kind: 'video', appData: { mediaType: 'camera' },
  });
  const session: Parameters<WebSocketServer['handleSfuConsume']>[0] = {
    ws: Object.create(WebSocket.prototype) as WebSocket, sessionId: 'self', isAlive: true, ip: '127.0.0.1',
    messageQueue: Promise.resolve(),
    user: { id: 'self', sessionId: 'self', clientId: 'self', nickname: 'Self', status: 'ONLINE', joinedAt: 1 },
  };
  const sent: Parameters<WebSocketServer['send']>[1][] = [];
  const broadcasts: Parameters<WebSocketServer['send']>[1][] = [];
  server['send'] = (_ws, message) => { sent.push(message); };
  let releaseBroadcast = () => {};
  const pendingPermission = new Promise<void>((resolve) => { releaseBroadcast = resolve; });
  server['broadcastToChannel'] = async (_channelId, message) => {
    await pendingPermission;
    broadcasts.push(message);
  };
  server['handleSfuProducerClosed'](session, { channelId: 'room', producerId: 'producer' });
  await server['handleSfuConsume'](session, {
    channelId: 'room', transportId: 'recv', producerId: 'producer', rtpCapabilities: {},
  }, 'consume-request');
  assert.deepEqual(sent, [{
    type: MessageType.SFU_PRODUCER_CLOSED, requestId: 'consume-request',
    payload: { channelId: 'room', producerId: 'producer' },
  }]);
  assert.equal(broadcasts.length, 0, 'the terminal reply is independent of slow broadcast authorization');
  assert.equal(sfu['transports'].size, 1);
  releaseBroadcast();
  await pendingPermission;
  assert.equal(broadcasts.length, 1);
  sfu.close();
});

test('producer disappearance during worker consume is obsolete work, but transport errors stay genuine', async (t) => {
  for (const disappearance of [false, true]) {
    const sfu = new SfuManager();
    const error = new Error('Worker consume failed');
    const transport: Partial<MediasoupTypes.WebRtcTransport> = {
      id: 'recv', close() {}, async consume() {
        if (disappearance) sfu.closeProducer('producer');
        throw error;
      },
    };
    sfu['transports'].set('recv', { transport: transport as MediasoupTypes.WebRtcTransport, sessionId: 'self', channelId: 'room', direction: 'recv' });
    sfu['producers'].set('producer', {
      producer: { id: 'producer', closed: false, close() {} } as MediasoupTypes.Producer,
      sessionId: 'peer', channelId: 'room', kind: 'video', appData: { mediaType: 'screen_video' },
    });
    const router: Partial<MediasoupTypes.Router> = { canConsume: () => true };
    t.mock.method(sfu, 'getOrCreateRouter', async () => router as MediasoupTypes.Router);
    await assert.rejects(sfu.consume('self', 'room', 'recv', 'producer', {}), (actual: unknown) => {
      return disappearance ? actual instanceof SfuProducerClosedError : actual === error;
    });
    sfu.close();
  }
});
