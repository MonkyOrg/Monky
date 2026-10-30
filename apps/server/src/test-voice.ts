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
import { SfuManager, SfuProducerClosedError, SfuProducerLimitError } from './infrastructure/sfu/SfuManager';
import { WebSocketServer } from './infrastructure/websocket/WebSocketServer';
import { Logger } from './infrastructure/logger/Logger';
import { createFixture, record, records as recordList, text } from './testFixtures/bots';
import './test-screen-subscriptions';

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

test('changing voice channels turns the camera off, while a same-channel rejoin keeps it', async () => {
  const service = signaling();
  await service.joinVoiceChannel('alice', 'alice', 'room');
  assert.equal(service.updateVoiceState('alice', { isCameraOn: true })?.isCameraOn, true);
  const rejoined = await service.joinVoiceChannel('alice', 'alice', 'room');
  assert.equal(rejoined.voiceState?.isCameraOn, true, 'reconnecting into the same room keeps the camera');
  const moved = await service.joinVoiceChannel('alice', 'alice', 'other-room');
  assert.equal(moved.previousVoiceState?.isCameraOn, true);
  assert.equal(moved.voiceState?.isCameraOn, false, 'the camera does not follow the user into another room');
  assert.equal(service.getVoiceState('alice')?.isCameraOn, false);
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
  server['dmRelay'] = { register: () => {}, unregister: () => {} } as unknown as WebSocketServer['dmRelay'];
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
  server['sfuManager'] = new SfuManager();
  const grants = { bits: Permission.MUTE_MEMBERS | Permission.DEAFEN_MEMBERS };
  const permissions = Object.create(PermissionService.prototype) as PermissionService;
  permissions.getUserPermissions = async (id) => id === 'moderator' ? grants.bits : 0;
  permissions.checkPermission = async (id, permission) => hasPermission(await permissions.getUserPermissions(id), permission);
  server['permissionService'] = permissions;
  const users = Object.create(UserService.prototype) as UserService;
  users.isMember = async (id) => ['alice', 'bob', 'offline', 'moderator'].includes(id);
  server['userService'] = users;
  const messages: Parameters<WebSocketServer['broadcast']>[0][] = [];
  const channelBroadcasts: string[] = [];
  server['broadcast'] = (message) => { messages.push(message); };
  server['broadcastToChannel'] = async (channelId, message, _ignoreWs, canSend) => {
    if (!canSend || canSend()) {
      channelBroadcasts.push(channelId);
      messages.push(message);
    }
  };
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
  return { server, service, grants, users, clients, session, messages, channelBroadcasts, direct, request };
}

test('administrative identity changes cover every voice and idle device without exposing other users', async () => {
  const f = moderationFixture();
  await f.service.joinVoiceChannel('one', 'alice', 'room');
  await f.service.joinVoiceChannel('two', 'alice', 'room');
  const response = await f.request(MessageType.ADMIN_MUTE_USER, { targetUserId: 'alice', muted: true });
  assert.equal(response.type, MessageType.VOICE_RESTRICTIONS_UPDATED);
  assert.deepEqual(response.payload, { userId: 'alice', serverMuted: true, serverDeafened: false });
  assert.equal(f.messages.filter((message) => message.type === MessageType.VOICE_STATE_CHANGED).length, 2);
  assert.deepEqual(f.channelBroadcasts, ['room', 'room']);
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

test('voice restrictions reach the affected devices before room audience resolution completes', async (t) => {
  const f = moderationFixture();
  await f.service.joinVoiceChannel('one', 'alice', 'room');
  const original = f.server['broadcastToChannel'].bind(f.server);
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const waiting = new Promise<void>((resolve) => { started = resolve; });
  t.after(release);
  f.server['broadcastToChannel'] = async (...args) => {
    started();
    await gate;
    await original(...args);
  };
  const pending = f.request(MessageType.ADMIN_MUTE_USER, { targetUserId: 'alice', muted: true });
  await waiting;
  const notifications = f.direct.filter(({ message }) => !message.requestId);
  assert.equal(notifications.length, 3);
  for (const { message } of notifications) {
    assert.equal(message.type, MessageType.VOICE_RESTRICTIONS_UPDATED);
    assert.deepEqual(message.payload, { userId: 'alice', serverMuted: true, serverDeafened: false });
  }
  assert.equal(f.messages.length, 0);
  release();
  assert.equal((await pending).type, MessageType.VOICE_RESTRICTIONS_UPDATED);
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
  server['requirePermission'] = async () => true;
  server['requireChannelAccess'] = async () => true;
  const service = signaling();
  const sfu = new SfuManager();
  server['signalingService'] = service;
  server['sfuManager'] = sfu;
  server['channelService'] = {
    canUserAccessChannel: async () => true, getAfkChannelId: async () => null,
  } as unknown as WebSocketServer['channelService'];
  server['serverRepo'] = {
    getServer: async () => ({ id: 'server', name: 'Voice', passwordHash: '', createdAt: 1, maxUsers: 10, voiceMode: 'sfu' }),
    createServer: async () => {}, updateServer: async () => {},
  };
  type Session = Parameters<WebSocketServer['handleVoiceJoin']>[0];
  const makeSession = (id: string): Session => {
    const ws = Object.create(WebSocket.prototype) as WebSocket;
    Object.defineProperty(ws, 'readyState', { value: WebSocket.OPEN });
    return {
      ws, sessionId: id, isAlive: true, ip: '127.0.0.1', messageQueue: Promise.resolve(),
      user: { id, sessionId: id, clientId: id, nickname: id, status: 'ONLINE', joinedAt: 1 },
    };
  };
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
  sfu['transports'].set('send', { transport: send, sessionId: 'peer', channelId: 'room', direction: 'send', purpose: 'call' });
  sfu['transports'].set('recv', { transport: recv, sessionId: 'peer', channelId: 'room', direction: 'recv', purpose: 'call' });
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

test('a listen-only member with nothing to receive (the AFK room) is not shown connecting forever', async () => {
  const server = Object.create(WebSocketServer.prototype) as WebSocketServer;
  const sfu = new SfuManager();
  server['sfuManager'] = sfu;
  server['signalingService'] = signaling();
  await server['signalingService'].joinVoiceChannel('afk-member', 'afk-member', 'room', true, false, true);
  await server['signalingService'].joinVoiceChannel('speaker', 'speaker', 'room');
  const transport = (id: string) => ({ id, closed: false, iceState: 'new', dtlsState: 'new', close() {} } as MediasoupTypes.WebRtcTransport);
  for (const sessionId of ['afk-member', 'speaker']) {
    for (const direction of ['send', 'recv'] as const) {
      const id = `${sessionId}-${direction}`;
      sfu['transports'].set(id, { transport: transport(id), sessionId, channelId: 'room', direction, purpose: 'call', healthState: 'new' });
    }
  }
  assert.equal(sfu.getConnectionHealth('afk-member', 'room'), 'connecting');
  assert.equal(server['sfuCallHealth']('afk-member', 'room'), 'idle', 'no media to carry, so connectivity is untested');
  assert.equal(server['sfuCallHealth']('speaker', 'room'), 'connecting', 'a member who may speak is still about to publish');

  sfu['consumers'].set('consumer', {
    consumer: { id: 'consumer', close() {} } as MediasoupTypes.Consumer,
    transportId: 'afk-member-recv', sessionId: 'afk-member', channelId: 'room', producerId: 'producer',
  });
  assert.equal(server['sfuCallHealth']('afk-member', 'room'), 'connecting', 'something to receive needs a real negotiation');
  sfu['consumers'].clear();
  sfu['transports'].get('afk-member-recv')!.healthState = 'failed';
  assert.equal(server['sfuCallHealth']('afk-member', 'room'), 'failed', 'a real failure is never masked');
  sfu.close();
});

test('real missing-producer consume path replies before the delayed close broadcast without reporting transport failure', async () => {
  const server = Object.create(WebSocketServer.prototype) as WebSocketServer;
  const sfu = new SfuManager();
  server['sfuManager'] = sfu;
  server['signalingService'] = signaling();
  await server['signalingService'].joinVoiceChannel('self', 'self', 'room');
  await server['signalingService'].joinVoiceChannel('peer', 'peer', 'room');
  const transport = { id: 'recv', closed: false, close() {} } as MediasoupTypes.WebRtcTransport;
  sfu['transports'].set('recv', { transport, sessionId: 'self', channelId: 'room', direction: 'recv', purpose: 'call' });
  sfu['producers'].set('producer', {
    producer: { id: 'producer', close() {} } as MediasoupTypes.Producer,
    transportId: 'send-peer',
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
  assert.ok(server['projectScreenMessage'](session, {
    type: MessageType.SFU_NEW_PRODUCER,
    payload: { channelId: 'room', producerId: 'producer', producerSessionId: 'peer',
      kind: 'video', appData: { mediaType: 'camera' } },
  }), 'the consumer request must follow a producer advertised to this client');
  let releaseBroadcast = () => {};
  const pendingPermission = new Promise<void>((resolve) => { releaseBroadcast = resolve; });
  server['broadcastToChannel'] = async (_channelId, message) => {
    await pendingPermission;
    broadcasts.push(message);
  };
  server['handleSfuProducerClosed']({ ...session, sessionId: 'peer' }, { channelId: 'room', producerId: 'producer' });
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

test('permission-muted SFU participants can publish video but not microphone or screen audio', async () => {
  const server = Object.create(WebSocketServer.prototype) as WebSocketServer;
  const sfu = new SfuManager();
  const service = signaling();
  server['sfuManager'] = sfu;
  server['signalingService'] = service;
  server['closing'] = false;
  const ws = Object.create(WebSocket.prototype) as WebSocket;
  Object.defineProperty(ws, 'readyState', { value: WebSocket.OPEN });
  const session: Parameters<WebSocketServer['handleSfuProduce']>[0] = {
    ws, sessionId: 'self', isAlive: true, ip: '127.0.0.1', messageQueue: Promise.resolve(),
    user: { id: 'self', sessionId: 'self', clientId: 'self', nickname: 'Self', status: 'ONLINE', joinedAt: 1 },
  };
  server['sessions'] = new Map([[ws, session]]);
  server['sessionSockets'] = new Map([['self', ws]]);
  server['isCurrentSession'] = () => true;
  const messages: Parameters<WebSocketServer['send']>[1][] = [];
  server['send'] = (_ws, message) => { messages.push(message); };
  server['broadcast'] = (message) => { messages.push(message); };
  sfu.produce = async (_sessionId, _channelId, _transportId, _kind, _rtp, appData) =>
    ({ id: `${appData?.mediaType ?? 'unknown'}-producer` });
  sfu.setMicrophonesMuted = async () => {};
  await service.joinVoiceChannel('self', 'self', 'room', false, false, true);
  service.updateVoiceState('self', { screenShareIds: ['share'] });

  await server['handleSfuProduce'](session, {
    channelId: 'room', transportId: 'send', kind: 'audio', rtpParameters: { codecs: [] }, appData: { mediaType: 'mic' },
  }, 'mic');
  await server['handleSfuProduce'](session, {
    channelId: 'room', transportId: 'send', kind: 'audio', rtpParameters: { codecs: [] }, appData: { mediaType: 'screen_audio', shareId: 'share' },
  }, 'screen-audio');
  await server['handleSfuProduce'](session, {
    channelId: 'room', transportId: 'send', kind: 'video', rtpParameters: { codecs: [] }, appData: { mediaType: 'camera' },
  }, 'camera');
  await server['handleSfuProduce'](session, {
    channelId: 'room', transportId: 'send', kind: 'video', rtpParameters: { codecs: [] }, appData: { mediaType: 'screen_video', shareId: 'share' },
  }, 'screen-video');

  assert.equal(messages.find(message => message.requestId === 'mic')?.type, MessageType.SERVER_ERROR);
  assert.equal((messages.find(message => message.requestId === 'mic')?.payload as ServerErrorPayload).code, ProtocolErrorCode.PERMISSION_DENIED);
  assert.equal(messages.find(message => message.requestId === 'screen-audio')?.type, MessageType.SERVER_ERROR);
  assert.equal((messages.find(message => message.requestId === 'screen-audio')?.payload as ServerErrorPayload).code, ProtocolErrorCode.PERMISSION_DENIED);
  assert.equal(messages.find(message => message.requestId === 'camera')?.type, MessageType.SFU_PRODUCED);
  assert.equal(messages.find(message => message.requestId === 'screen-video')?.type, MessageType.SFU_PRODUCED);
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
    sfu['transports'].set('recv', { transport: transport as MediasoupTypes.WebRtcTransport, sessionId: 'self', channelId: 'room', direction: 'recv', purpose: 'call' });
    sfu['producers'].set('producer', {
      producer: { id: 'producer', closed: false, close() {} } as MediasoupTypes.Producer,
      transportId: 'send-peer',
      sessionId: 'peer', channelId: 'room', kind: 'video', appData: { mediaType: 'screen_video', shareId: 'share' },
    });

    const router: Partial<MediasoupTypes.Router> = { canConsume: () => true };
    t.mock.method(sfu, 'getOrCreateRouter', async () => router as MediasoupTypes.Router);
    await assert.rejects(sfu.consume('self', 'room', 'recv', 'producer', {}), (actual: unknown) => {
      return disappearance ? actual instanceof SfuProducerClosedError : actual === error;
    });
    sfu.close();
  }
});

test('SFU pause and resume tolerate retired consumers but propagate failures of live media', async () => {
  for (const paused of [false, true]) {
    for (const disappearance of ['before', 'producer', 'consumer', 'none']) {
      const sfu = new SfuManager();
      const error = new Error('Worker consumer state failed');
      let calls = 0;
      const changeState = async () => {
        calls++;
        if (disappearance === 'producer') sfu.closeProducer('producer');
        if (disappearance === 'consumer') sfu['consumers'].delete('consumer');
        throw error;
      };
      const consumer: Partial<MediasoupTypes.Consumer> = {
        id: 'consumer', closed: false, close() {}, pause: changeState, resume: changeState,
      };
      sfu['consumers'].set('consumer', {
        consumer: consumer as MediasoupTypes.Consumer, transportId: 'recv',
        sessionId: 'self', channelId: 'room', producerId: 'producer',
      });
      sfu['producers'].set('producer', {
        producer: { id: 'producer', closed: false, close() {} } as MediasoupTypes.Producer,
        transportId: 'send-peer',
        sessionId: 'peer', channelId: 'room', kind: 'audio', appData: { mediaType: 'mic' },
      });
      if (disappearance === 'before') sfu.closeProducer('producer');
      try {
        if (disappearance === 'none') {
          await assert.rejects(sfu.setConsumerPaused('self', 'room', 'consumer', paused), actual => actual === error);
        } else {
          await sfu.setConsumerPaused('self', 'room', 'consumer', paused);
        }
        assert.equal(calls, disappearance === 'before' ? 0 : 1);
      } finally {
        sfu.close();
      }
    }
  }
});

test('SFU allocations completing after a human reconnect are reaped without touching the replacement session', async (t) => {
  for (const allocation of ['initialization', 'transport', 'producer', 'consumer'] as const) {
    await t.test(allocation, async () => {
      const server = Object.create(WebSocketServer.prototype) as WebSocketServer;
      const sfu = new SfuManager();
      const service = signaling();
      server['sfuManager'] = sfu;
      server['signalingService'] = service;
      server['closing'] = false;
      const makeSocket = () => {
        const ws = Object.create(WebSocket.prototype) as WebSocket;
        Object.defineProperty(ws, 'readyState', { value: WebSocket.OPEN });
        return ws;
      };
      const session: Parameters<WebSocketServer['handleSfuCreateWebRtcTransport']>[0] = {
        ws: makeSocket(), sessionId: 'self', isAlive: true, ip: '127.0.0.1', messageQueue: Promise.resolve(),
        user: { id: 'self', sessionId: 'self', clientId: 'self', nickname: 'Self', status: 'ONLINE', joinedAt: 1 },
      };
      server['sessions'] = new Map([[session.ws, session]]);
      server['sessionSockets'] = new Map([['self', session.ws]]);
      const messages: Parameters<WebSocketServer['send']>[1][] = [];
      server['send'] = (_ws, message) => { messages.push(message); };
      server['broadcast'] = message => { messages.push(message); };
      await service.joinVoiceChannel('self', 'self', 'room');

      const resource = (id: string) => ({ id, closed: false, close() { this.closed = true; } });
      const abandoned = resource('abandoned');
      const replacement = resource('replacement');
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const register = (entry: ReturnType<typeof resource>) => {
        if (allocation === 'transport' || allocation === 'initialization') {
          sfu['transports'].set(entry.id, {
            transport: entry as MediasoupTypes.WebRtcTransport,
            sessionId: 'self', channelId: 'room', direction: 'send', purpose: 'call',
          });
        } else if (allocation === 'producer') {
          sfu['producers'].set(entry.id, {
            producer: entry as MediasoupTypes.Producer,
            transportId: 'old-transport',
            sessionId: 'self', channelId: 'room', kind: 'audio', appData: { mediaType: 'mic' },
          });
        } else {
          sfu['consumers'].set(entry.id, {
            consumer: entry as MediasoupTypes.Consumer,
            transportId: 'old-transport',
            sessionId: 'self', channelId: 'room', producerId: 'peer-producer',
          });
        }
      };
      let pending: Promise<void>;
      if (allocation === 'transport' || allocation === 'initialization') {
        sfu.isReady = () => allocation !== 'initialization';
        sfu.init = async () => { await gate; return true; };
        sfu.createWebRtcTransport = async () => {
          await gate;
          register(abandoned);
          return {
            id: abandoned.id, iceParameters: { usernameFragment: 'fixture', password: 'fixture' },
            iceCandidates: [], dtlsParameters: { fingerprints: [] },
          };
        };
        pending = server['handleSfuCreateWebRtcTransport'](session, { channelId: 'room', direction: 'send' }, 'old-request');
      } else if (allocation === 'producer') {
        sfu.produce = async () => {
          await gate;
          register(abandoned);
          return { id: abandoned.id };
        };
        pending = server['handleSfuProduce'](session, {
          channelId: 'room', transportId: 'old-transport', kind: 'audio', rtpParameters: { codecs: [] }, appData: { mediaType: 'mic' },
        }, 'old-request');
      } else {
        await service.joinVoiceChannel('peer', 'peer', 'room');
        sfu['producers'].set('peer-producer', {
          producer: resource('peer-producer') as MediasoupTypes.Producer,
          transportId: 'peer-transport', sessionId: 'peer', channelId: 'room',
          kind: 'audio', appData: { mediaType: 'mic' },
        });
        let consumeStarted = false;
        sfu.consume = async () => {
          consumeStarted = true;
          await gate;
          register(abandoned);
          return {
            id: abandoned.id, producerId: 'peer-producer', producerSessionId: 'peer',
            kind: 'audio', rtpParameters: { codecs: [] }, appData: { mediaType: 'mic' },
          };
        };
        pending = server['handleSfuConsume'](session, {
          channelId: 'room', transportId: 'old-transport', producerId: 'peer-producer', rtpCapabilities: {},
        }, 'old-request');
        assert.equal(consumeStarted, true, 'the authorized producer must reach allocation before the reconnect race');
      }
      const replacementSession = { ...session, ws: makeSocket() };
      session.replaced = true;
      server['sessions'].delete(session.ws);
      server['sessions'].set(replacementSession.ws, replacementSession);
      server['sessionSockets'].set('self', replacementSession.ws);
      register(replacement);
      release();
      await pending;
      assert.equal(abandoned.closed, allocation !== 'initialization',
        'late initialization must not allocate, and late allocations must be closed');
      assert.equal(replacement.closed, false, 'the logical session ID cannot authorize closing the replacement allocation');
      assert.equal(messages.length, 0, 'obsolete producers must never be announced to the room');
      const records = allocation === 'transport' || allocation === 'initialization' ? sfu['transports']
        : allocation === 'producer' ? sfu['producers'] : sfu['consumers'];
      assert.deepEqual([...records.keys()], ['replacement']);
      sfu.close();
    });
  }
});

test('human voice payloads keep only known fields of the right type, and kicks relay only what the server built', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Voice owner');
  const member = await f.human('Voice member');
  const voiceId = text(recordList(record(owner.auth.payload.server).channels).find((channel) => channel.type === 'VOICE')?.id);
  const memberSession = text(record(member.auth.payload.currentUser).sessionId);

  for (const invalid of [{ channelId: voiceId, isMuted: 'yes' }, { channelId: 7 }, null]) {
    await member.peer.error(MessageType.VOICE_JOIN, invalid, ProtocolErrorCode.BAD_REQUEST);
  }
  const joined = await member.peer.request(MessageType.VOICE_JOIN, { channelId: voiceId, isMuted: false, junk: 'x' });
  assert.equal(joined.type, MessageType.VOICE_USER_JOINED);
  assert.equal(Object.hasOwn(record(joined.payload.voiceState), 'junk'), false);
  assert.equal((await owner.peer.request(MessageType.VOICE_JOIN, { channelId: voiceId })).type, MessageType.VOICE_USER_JOINED);

  for (const invalid of [
    { isMuted: 'yes' }, { isCameraOn: {} }, { screenShareIds: 'one' }, { screenShareIds: Array(65).fill('a') }, null,
  ]) {
    await member.peer.error(MessageType.VOICE_STATE_UPDATE, invalid, ProtocolErrorCode.BAD_REQUEST);
  }
  const since = owner.peer.messages.length;
  member.peer.send(MessageType.VOICE_STATE_UPDATE, { isMuted: true, junk: 'x'.repeat(64 * 1024), connectionHealth: 'failed' });
  const changed = await owner.peer.wait((message) => message.type === MessageType.VOICE_STATE_CHANGED
    && record(message.payload.voiceState).sessionId === memberSession, since);
  const state = record(changed.payload.voiceState);
  assert.equal(state.isMuted, true);
  assert.equal(Object.hasOwn(state, 'junk'), false, 'an unknown key never reaches the room');
  assert.notEqual(state.connectionHealth, 'failed', 'health stays server-observed');
  assert.equal(Object.hasOwn(f.signalingService.getVoiceState(memberSession) ?? {}, 'junk'), false);

  await owner.peer.error(MessageType.ADMIN_KICK_VOICE, { targetSessionId: 7 }, ProtocolErrorCode.BAD_REQUEST);
  await owner.peer.error(MessageType.ADMIN_MOVE_USER, { targetSessionId: memberSession }, ProtocolErrorCode.BAD_REQUEST);
  const kickSince = member.peer.messages.length;
  const kicked = await owner.peer.request(MessageType.ADMIN_KICK_VOICE, { targetSessionId: memberSession, junk: 'x'.repeat(1024) });
  assert.equal(kicked.type, MessageType.ADMIN_KICK_VOICE);
  assert.deepEqual(kicked.payload, { targetSessionId: memberSession });
  const relayed = await member.peer.wait((message) => message.type === MessageType.ADMIN_KICK_VOICE, kickSince);
  assert.deepEqual(relayed.payload, { targetSessionId: memberSession }, 'the client payload is never relayed as is');
});

test('RTC diagnostic reports become one bounded log line, never a forged one, and are rate limited', async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const reporter = await f.human('Diagnostics member');
  const peer = await f.human('Diagnostics peer');
  const report = {
    targetSessionId: text(record(peer.auth.payload.currentUser).sessionId),
    reason: 'ice_restart=2, hard_reconnect=1', iceGatheringState: 'complete', signalingState: 'stable',
    iceRestartAttempts: 2, hardReconnectAttempts: 1,
    localCandidate: { type: 'srflx', address: '203.0.113.7', port: 50000, protocol: 'udp' }, remoteCandidate: null,
  };
  const lines = () => Logger.getRecent().filter((entry) => entry.message.includes('P2P connection failed: Diagnostics member'));
  // Queued behind the reports, unlike PING, so it proves they were handled.
  const settle = () => reporter.peer.request(MessageType.COMMANDS_LIST);
  const before = lines().length;
  reporter.peer.send(MessageType.RTC_DIAGNOSTICS_REPORT, report);
  await settle();
  assert.equal(lines().length, before + 1);
  assert.match(lines().at(-1)?.message ?? '', /Diagnostics member → Diagnostics peer/u);

  for (const invalid of [
    { ...report, reason: 'ok\n[ERROR:SECURITY] forged' },
    { ...report, iceGatheringState: 'x'.repeat(1024 * 1024) },
    { ...report, localCandidate: { ...report.localCandidate, port: 70_000 } },
  ]) reporter.peer.send(MessageType.RTC_DIAGNOSTICS_REPORT, invalid);
  await settle();
  assert.equal(lines().length, before + 1, 'an invalid report leaves no log line');
  assert.equal(reporter.peer.messages.some((message) => message.type === MessageType.SERVER_ERROR), false,
    'a report is never answered');

  for (let i = 0; i < 10; i++) reporter.peer.send(MessageType.RTC_DIAGNOSTICS_REPORT, report);
  await settle();
  assert.equal(lines().length, before + 7, 'ten reports a minute, invalid ones included');
});

test('SFU media parameters are bounded before mediasoup and real client shapes pass through intact', async () => {
  const server = Object.create(WebSocketServer.prototype) as WebSocketServer;
  const sfu = new SfuManager();
  const service = signaling();
  server['sfuManager'] = sfu;
  server['signalingService'] = service;
  server['closing'] = false;
  const ws = Object.create(WebSocket.prototype) as WebSocket;
  Object.defineProperty(ws, 'readyState', { value: WebSocket.OPEN });
  const session: Parameters<WebSocketServer['handleSfuProduce']>[0] = {
    ws, sessionId: 'self', isAlive: true, ip: '127.0.0.1', messageQueue: Promise.resolve(),
    user: { id: 'self', sessionId: 'self', clientId: 'self', nickname: 'Self', status: 'ONLINE', joinedAt: 1 },
  };
  server['sessions'] = new Map([[ws, session]]);
  server['sessionSockets'] = new Map([['self', ws]]);
  server['isCurrentSession'] = () => true;
  const messages: Parameters<WebSocketServer['send']>[1][] = [];
  server['send'] = (_ws, message) => { messages.push(message); };
  server['broadcast'] = (message) => { messages.push(message); };
  const produced: unknown[] = [];
  sfu.produce = async (_sessionId, _channelId, _transportId, _kind, rtpParameters) => {
    produced.push(rtpParameters);
    return { id: `producer-${produced.length}` };
  };
  const connected: unknown[] = [];
  sfu.connectWebRtcTransport = async (_transportId, dtlsParameters) => { connected.push(dtlsParameters); };
  sfu.ownsTransport = () => true;
  sfu.setMicrophonesMuted = async () => {};
  await service.joinVoiceChannel('self', 'self', 'room');
  const reply = (requestId: string) => messages.find((message) => message.requestId === requestId);

  const opus = {
    mimeType: 'audio/opus', payloadType: 111, clockRate: 48000, channels: 2,
    parameters: { minptime: 10, useinbandfec: 1, usedtx: 1 }, rtcpFeedback: [{ type: 'transport-cc', parameter: '' }],
  };
  const extension = (uri: string, id: number) => ({ uri, id, encrypt: false, parameters: {} });
  const shapes = {
    // mediasoup-client (desktop), with the fields its encodings and RTCP may carry.
    desktopMicrophone: {
      mid: '0', codecs: [opus], msid: '- 6e1c0bfa',
      headerExtensions: [extension('urn:ietf:params:rtp-hdrext:sdes:mid', 1),
        extension('urn:ietf:params:rtp-hdrext:ssrc-audio-level', 10)],
      encodings: [{ ssrc: 1111, dtx: true }], rtcp: { cname: 'desktop', reducedSize: true },
    },
    desktopCamera: {
      mid: '1',
      codecs: [{ mimeType: 'video/VP8', payloadType: 96, clockRate: 90000, parameters: {},
        rtcpFeedback: [{ type: 'nack', parameter: '' }, { type: 'nack', parameter: 'pli' }, { type: 'ccm', parameter: 'fir' }] },
      { mimeType: 'video/rtx', payloadType: 97, clockRate: 90000, parameters: { apt: 96 }, rtcpFeedback: [] }],
      headerExtensions: [extension('http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time', 4)],
      encodings: [{ ssrc: 2222, rtx: { ssrc: 3333 }, maxBitrate: 1_500_000, scaleResolutionDownBy: 1,
        maxFramerate: 30, priority: 'high', networkPriority: 'high', scalabilityMode: 'L1T3' }],
      rtcp: { cname: 'desktop', reducedSize: true },
    },
    // libmediasoupclient, as used by the native screen engine and Monky Light.
    nativeScreen: {
      mid: '0',
      codecs: [{ mimeType: 'video/H264', payloadType: 125, clockRate: 90000,
        parameters: { 'packetization-mode': 1, 'profile-level-id': '4d003c', 'level-asymmetry-allowed': 1 },
        rtcpFeedback: [{ type: 'goog-remb', parameter: '' }, { type: 'transport-cc', parameter: '' }] },
      { mimeType: 'video/rtx', payloadType: 107, clockRate: 90000, parameters: { apt: 125 }, rtcpFeedback: [] }],
      headerExtensions: [
        extension('http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01', 3),
        extension('http://www.webrtc.org/experiments/rtp-hdrext/abs-capture-time', 13)],
      encodings: [{ ssrc: 4444, rtx: { ssrc: 5555 }, scalabilityMode: 'L1T1' }],
      rtcp: { cname: 'native', reducedSize: true, mux: true },
    },
    // The SDK builds its microphone parameters by hand (OpusPeer.prepareSfu).
    sdkMicrophone: {
      codecs: [{ mimeType: 'audio/opus', payloadType: 111, clockRate: 48000, channels: 2,
        parameters: { useinbandfec: 1, stereo: 1 }, rtcpFeedback: [] }],
      encodings: [{ ssrc: 6666 }], rtcp: { cname: 'bot', reducedSize: true }, headerExtensions: [],
    },
  };
  for (const [name, rtpParameters] of Object.entries(shapes)) {
    const video = name === 'desktopCamera' || name === 'nativeScreen';
    await server['handleSfuProduce'](session, {
      channelId: 'room', transportId: 'send', kind: video ? 'video' : 'audio', rtpParameters,
      appData: { mediaType: video ? 'camera' : 'mic' },
    }, name);
    assert.equal(reply(name)?.type, MessageType.SFU_PRODUCED, `${name} is accepted`);
    assert.deepEqual(produced.at(-1), rtpParameters, `${name} reaches mediasoup intact`);
  }

  const microphone = shapes.desktopMicrophone;
  for (const [name, rtpParameters] of Object.entries({
    tooManyCodecs: { ...microphone, codecs: Array(33).fill(opus) },
    tooManyEncodings: { ...microphone, encodings: Array(17).fill({ ssrc: 1 }) },
    unknownExtension: { ...microphone, headerExtensions: [extension('urn:example:not-in-mediasoup', 2)] },
    nestedCodecParameter: { ...microphone, codecs: [{ ...opus, parameters: { nested: { value: 1 } } }] },
    longCname: { ...microphone, rtcp: { cname: 'x'.repeat(257) } },
    missingCodecs: {},
    notAnObject: 'parameters',
  })) {
    await server['handleSfuProduce'](session, {
      channelId: 'room', transportId: 'send', kind: 'audio', rtpParameters, appData: { mediaType: 'mic' },
    }, name);
    assert.equal((reply(name)?.payload as ServerErrorPayload | undefined)?.code, ProtocolErrorCode.BAD_REQUEST, name);
  }
  assert.equal(produced.length, Object.keys(shapes).length, 'nothing refused reaches mediasoup');

  const fingerprint = { algorithm: 'sha-256', value: 'AB:CD:EF' };
  await server['handleSfuConnectWebRtcTransport'](session, {
    channelId: 'room', transportId: 'send', dtlsParameters: { role: 'client', fingerprints: [fingerprint] },
  }, 'connect');
  assert.equal(reply('connect')?.type, MessageType.SFU_WEBRTC_TRANSPORT_CONNECTED);
  assert.deepEqual(connected, [{ role: 'client', fingerprints: [fingerprint] }]);
  for (const [name, dtlsParameters] of Object.entries({
    tooManyFingerprints: { fingerprints: Array(9).fill(fingerprint) },
    unknownAlgorithm: { fingerprints: [{ ...fingerprint, algorithm: 'md5' }] },
    unknownRole: { role: 'both', fingerprints: [fingerprint] },
    longValue: { fingerprints: [{ ...fingerprint, value: 'A'.repeat(257) }] },
    noFingerprints: {},
  })) {
    await server['handleSfuConnectWebRtcTransport'](session, { channelId: 'room', transportId: 'send', dtlsParameters }, name);
    assert.equal((reply(name)?.payload as ServerErrorPayload | undefined)?.code, ProtocolErrorCode.BAD_REQUEST, name);
  }
  assert.equal(connected.length, 1);

  // A second live producer in one slot is a client error, not a server failure.
  sfu.produce = async () => { throw new SfuProducerLimitError('This session already publishes mic on this transport'); };
  await server['handleSfuProduce'](session, {
    channelId: 'room', transportId: 'send', kind: 'audio', rtpParameters: shapes.desktopMicrophone, appData: { mediaType: 'mic' },
  }, 'second-microphone');
  assert.equal((reply('second-microphone')?.payload as ServerErrorPayload | undefined)?.code, ProtocolErrorCode.BAD_REQUEST);
  sfu.close();
});
