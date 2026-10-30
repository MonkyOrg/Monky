import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import * as mediasoup from 'mediasoup';
import type { types as MediasoupTypes } from 'mediasoup';
import { AuthSuccessPayload, ChannelSummary, DEFAULT_PERMISSIONS, MessageType, Permission, ProtocolErrorCode, ServerDetails, ServerErrorPayload, UserSummary, VoiceConnectionHealth, VoiceUserJoinedPayload, SfuProducersListPayload, hasPermission } from '@monky/shared';
import { AuthService } from './application/services/AuthService';
import { PermissionService } from './application/services/PermissionService';
import { UserService } from './application/services/UserService';
import { SignalingService } from './application/services/SignalingService';
import { ChannelRecord, VoiceRestrictions } from './domain/entities';
import { SERVER_SETTING_DEFAULTS } from './domain/serverSettings';
import type { IVoiceRestrictionRepository } from './domain/repositories';
import { DatabaseConnection } from './infrastructure/database/DatabaseConnection';
import { SqliteVoiceRestrictionRepository } from './infrastructure/database/SqliteVoiceRestrictionRepository';
import { SfuManager, SfuProducerClosedError, SfuProducerLimitError } from './infrastructure/sfu/SfuManager';
import { WebSocketServer } from './infrastructure/websocket/WebSocketServer';
import type { ClientSession } from './infrastructure/websocket/ClientSession';
import { VoiceSessionHandler } from './infrastructure/websocket/voice/VoiceSessionHandler';
import { Logger } from './infrastructure/logger/Logger';
import { createFixture, record, records as recordList, text, type Received } from './testFixtures/bots';
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

test('a screen share announced twice is relayed once, before the share limit applies', async () => {
  const service = signaling();
  await service.joinVoiceChannel('alice', 'alice', 'room');
  const repeated = service.updateVoiceState('alice', { screenShareIds: ['one', 'one', 'two', 'one'] });
  assert.deepEqual(repeated?.screenShareIds, ['one', 'two'], 'viewers draw one tile per share, so each id goes out once');
  assert.equal(repeated?.isScreenSharing, true);
  const padded = service.updateVoiceState('alice', { screenShareIds: [...Array(8).fill('one'), 'two'] });
  assert.deepEqual(padded?.screenShareIds, ['one', 'two'], 'repeats cannot push a real share past the limit');
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
  server['roleAdmin'].broadcastState = async () => {};
  // The login compares the access versions read before and after its snapshot.
  const permissions = Object.create(PermissionService.prototype) as PermissionService;
  permissions.getRoleAccessVersion = () => 0;
  server['permissionService'] = permissions;
  server['botManagement'].sendCommands = () => {};
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
    const session: ClientSession = {
      ws: socket, lastSeenAt: 0, ip: '127.0.0.1', messageQueue: Promise.resolve(),
    };
    server['sessions'].set(socket, session);
    auth.verifyChallengeResponse = async () => ({ success: true, user, serverDetails: details });
    server['authentication']['buildIceServersFor'] = async () => {
      await Promise.resolve();
      restrictions.save(user.id, { serverMuted: blocked, serverDeafened: blocked });
      return [];
    };
    await server['authentication']['answerChallenge'](session, { signature: 'fixture' }, `auth-${blocked}`);
    const response = messages.find((message) => message.requestId === `auth-${blocked}`);
    assert.equal(response?.type, MessageType.AUTH_SUCCESS);
    const payload = response?.payload as AuthSuccessPayload;
    assert.deepEqual(payload.voiceRestrictions, { serverMuted: blocked, serverDeafened: blocked },
      'the login snapshot must include the latest persisted policy, not a pre-ICE or previous-login value');
    assert.deepEqual(payload.server.voiceStates, {}, 'restrictions do not require or create voice membership');
    assert.equal(payload.currentUser.id, 'alice');
    const beforeDisconnect = messages.length;
    server['authentication']['buildIceServersFor'] = async () => {
      server['sessions'].delete(socket);
      return [];
    };
    await server['authentication']['answerChallenge'](session, { signature: 'fixture' }, 'disconnected-during-ice');
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
      ws, sessionId: id, lastSeenAt: 0, ip: '127.0.0.1', messageQueue: Promise.resolve(),
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
  server['authorizer'].requirePermission = async () => true;
  server['authorizer'].requireChannelAccess = async () => true;
  const service = signaling();
  const sfu = new SfuManager();
  server['signalingService'] = service;
  server['sfuManager'] = sfu;
  server['channelService'] = {
    canUserAccessChannel: async () => true, getAfkChannelId: async () => null,
  } as unknown as WebSocketServer['channelService'];
  server['serverRepo'] = {
    getServer: async () => ({
      ...SERVER_SETTING_DEFAULTS, id: 'server', name: 'Voice', passwordHash: '', createdAt: 1, maxUsers: 10, voiceMode: 'sfu',
    }),
    createServer: async () => {}, updateServer: async () => {},
  };
  type Session = Parameters<WebSocketServer['handleMessage']>[0];
  const makeSession = (id: string): Session => {
    const ws = Object.create(WebSocket.prototype) as WebSocket;
    Object.defineProperty(ws, 'readyState', { value: WebSocket.OPEN });
    return {
      ws, sessionId: id, lastSeenAt: 0, ip: '127.0.0.1', messageQueue: Promise.resolve(),
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
  await server['voiceSessions']['handleVoiceJoin'](self, { channelId: 'room' }, 'current-admission');
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
  assert.equal(server['voiceSessions'].getVoiceRoster('room', 'peer').find((p) => p.user.id === 'peer')?.user.invisible, true);
  await server['sfuSignaling']['handleSfuGetProducers'](self, { channelId: 'room' });
  const resync = messages[1].payload as SfuProducersListPayload;
  assert.deepEqual(resync.participants, roster, 'media rejoin reconciles even muted/listen-only peers with no producer');
  assert.equal(service.getParticipantsInChannel('room').length, 3, 'media resync never evicts live participants');
  server['broadcastToChannel'] = async () => { service.leaveVoiceChannel('self'); };
  await server['voiceSessions']['handleVoiceJoin'](self, { channelId: 'room' }, 'interrupted-admission');
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
  assert.equal(server['sfuSignaling'].sfuCallHealth('afk-member', 'room'), 'idle', 'no media to carry, so connectivity is untested');
  assert.equal(server['sfuSignaling'].sfuCallHealth('speaker', 'room'), 'connecting', 'a member who may speak is still about to publish');

  sfu['consumers'].set('consumer', {
    consumer: { id: 'consumer', close() {} } as MediasoupTypes.Consumer,
    transportId: 'afk-member-recv', sessionId: 'afk-member', channelId: 'room', producerId: 'producer',
  });
  assert.equal(server['sfuSignaling'].sfuCallHealth('afk-member', 'room'), 'connecting', 'something to receive needs a real negotiation');
  sfu['consumers'].clear();
  sfu['transports'].get('afk-member-recv')!.healthState = 'failed';
  assert.equal(server['sfuSignaling'].sfuCallHealth('afk-member', 'room'), 'failed', 'a real failure is never masked');
  sfu.close();
});

test('a consume crossing a producer close gets the terminal reply, and the close goes out at once, without reporting transport failure', async () => {
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
  const session: Parameters<WebSocketServer['handleMessage']>[0] = {
    ws: Object.create(WebSocket.prototype) as WebSocket, sessionId: 'self', lastSeenAt: 0, ip: '127.0.0.1',
    messageQueue: Promise.resolve(),
    user: { id: 'self', sessionId: 'self', clientId: 'self', nickname: 'Self', status: 'ONLINE', joinedAt: 1 },
  };
  const sent: Parameters<WebSocketServer['send']>[1][] = [];
  const broadcasts: Parameters<WebSocketServer['send']>[1][] = [];
  server['send'] = (_ws, message) => { sent.push(message); };
  assert.ok(server['screens'].projectScreenMessage(session, {
    type: MessageType.SFU_NEW_PRODUCER,
    payload: { channelId: 'room', producerId: 'producer', producerSessionId: 'peer',
      kind: 'video', appData: { mediaType: 'camera' } },
  }), 'the consumer request must follow a producer advertised to this client');
  server['broadcast'] = (message) => { broadcasts.push(message); };
  server['sfuSignaling']['handleSfuProducerClosed']({ ...session, sessionId: 'peer' }, { channelId: 'room', producerId: 'producer' });
  // Its projection keeps it to whoever was told of the producer, so no room
  // audience is resolved first: nothing for the close to wait on (S-VOICE-5).
  assert.deepEqual(broadcasts, [{
    type: MessageType.SFU_PRODUCER_CLOSED, payload: { channelId: 'room', producerId: 'producer' },
  }], 'the close is announced before the request returns');
  await server['sfuSignaling']['handleSfuConsume'](session, {
    channelId: 'room', transportId: 'recv', producerId: 'producer', rtpCapabilities: {},
  }, 'consume-request');
  assert.deepEqual(sent, [{
    type: MessageType.SFU_PRODUCER_CLOSED, requestId: 'consume-request',
    payload: { channelId: 'room', producerId: 'producer' },
  }]);
  assert.equal(sfu['transports'].size, 1);
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
  const session: Parameters<WebSocketServer['handleMessage']>[0] = {
    ws, sessionId: 'self', lastSeenAt: 0, ip: '127.0.0.1', messageQueue: Promise.resolve(),
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

  await server['sfuSignaling']['handleSfuProduce'](session, {
    channelId: 'room', transportId: 'send', kind: 'audio', rtpParameters: { codecs: [] }, appData: { mediaType: 'mic' },
  }, 'mic');
  await server['sfuSignaling']['handleSfuProduce'](session, {
    channelId: 'room', transportId: 'send', kind: 'audio', rtpParameters: { codecs: [] }, appData: { mediaType: 'screen_audio', shareId: 'share' },
  }, 'screen-audio');
  await server['sfuSignaling']['handleSfuProduce'](session, {
    channelId: 'room', transportId: 'send', kind: 'video', rtpParameters: { codecs: [] }, appData: { mediaType: 'camera' },
  }, 'camera');
  await server['sfuSignaling']['handleSfuProduce'](session, {
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
      const session: Parameters<WebSocketServer['handleMessage']>[0] = {
        ws: makeSocket(), sessionId: 'self', lastSeenAt: 0, ip: '127.0.0.1', messageQueue: Promise.resolve(),
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
        pending = server['sfuSignaling']['handleSfuCreateWebRtcTransport'](session, { channelId: 'room', direction: 'send' }, 'old-request');
      } else if (allocation === 'producer') {
        sfu.produce = async () => {
          await gate;
          register(abandoned);
          return { id: abandoned.id };
        };
        pending = server['sfuSignaling']['handleSfuProduce'](session, {
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
        pending = server['sfuSignaling']['handleSfuConsume'](session, {
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
  const session: Parameters<WebSocketServer['handleMessage']>[0] = {
    ws, sessionId: 'self', lastSeenAt: 0, ip: '127.0.0.1', messageQueue: Promise.resolve(),
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
    await server['sfuSignaling']['handleSfuProduce'](session, {
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
    await server['sfuSignaling']['handleSfuProduce'](session, {
      channelId: 'room', transportId: 'send', kind: 'audio', rtpParameters, appData: { mediaType: 'mic' },
    }, name);
    assert.equal((reply(name)?.payload as ServerErrorPayload | undefined)?.code, ProtocolErrorCode.BAD_REQUEST, name);
  }
  assert.equal(produced.length, Object.keys(shapes).length, 'nothing refused reaches mediasoup');

  const fingerprint = { algorithm: 'sha-256', value: 'AB:CD:EF' };
  await server['sfuSignaling']['handleSfuConnectWebRtcTransport'](session, {
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
    await server['sfuSignaling']['handleSfuConnectWebRtcTransport'](session, { channelId: 'room', transportId: 'send', dtlsParameters }, name);
    assert.equal((reply(name)?.payload as ServerErrorPayload | undefined)?.code, ProtocolErrorCode.BAD_REQUEST, name);
  }
  assert.equal(connected.length, 1);

  // A second live producer in one slot is a client error, not a server failure.
  sfu.produce = async () => { throw new SfuProducerLimitError('This session already publishes mic on this transport'); };
  await server['sfuSignaling']['handleSfuProduce'](session, {
    channelId: 'room', transportId: 'send', kind: 'audio', rtpParameters: shapes.desktopMicrophone, appData: { mediaType: 'mic' },
  }, 'second-microphone');
  assert.equal((reply('second-microphone')?.payload as ServerErrorPayload | undefined)?.code, ProtocolErrorCode.BAD_REQUEST);
  sfu.close();
});

test('a dead SFU worker marks the calls failed and closes their producers, without taking anyone out of the channel', async (t) => {
  const worker = Object.create(EventEmitter.prototype) as MediasoupTypes.Worker;
  Object.defineProperty(worker, 'died', { value: false });
  worker.close = () => {};
  t.mock.method(mediasoup, 'createWorker', () => Promise.resolve(worker));
  t.mock.method(Logger, 'error', () => {});
  const f = await createFixture();
  t.after(() => f.dispose());
  const member = await f.human('SFU member');
  const witness = await f.human('SFU witness');
  const outside = await f.human('Not in the call');
  const voiceId = text(recordList(record(member.auth.payload.server).channels).find((channel) => channel.type === 'VOICE')?.id);
  await f.serverRepo.updateServer({ voiceMode: 'sfu' });
  for (const user of [member, witness]) {
    assert.equal((await user.peer.request(MessageType.VOICE_JOIN, { channelId: voiceId })).type, MessageType.VOICE_USER_JOINED);
  }
  assert.equal(await f.wsServer['sfuManager'].init(), true);
  const sessionOf = (user: typeof member) => {
    const found = [...f.wsServer['sessions'].values()].find((session) => session.user?.id === user.id);
    assert.ok(found);
    return found;
  };
  // Producers each client was told about before the crash.
  for (const user of [witness, outside]) sessionOf(user).knownProducerIds = new Set(['lost-microphone']);
  const since = new Map([witness, outside].map((user) => [user, user.peer.messages.length]));

  worker.emit('died', new Error('Synthetic worker crash'));
  const closed = await witness.peer.wait((message) => message.type === MessageType.SFU_PRODUCER_CLOSED, since.get(witness));
  assert.deepEqual(closed.payload, { channelId: voiceId, producerId: 'lost-microphone' });
  assert.equal(sessionOf(witness).knownProducerIds?.size, 0);
  const memberSessionId = text(record(member.auth.payload.currentUser).sessionId);
  const failed = await witness.peer.wait((message) => message.type === MessageType.VOICE_STATE_CHANGED &&
    record(message.payload.voiceState).sessionId === memberSessionId, since.get(witness));
  assert.equal(record(failed.payload.voiceState).connectionHealth, 'failed', 'failed is what makes clients rebuild');

  await Promise.all([witness, outside].map((user) => user.peer.request(MessageType.PING)));
  assert.equal(outside.peer.messages.slice(since.get(outside))
    .some((message) => message.type === MessageType.SFU_PRODUCER_CLOSED), false, 'nobody outside the call is told');
  assert.equal(witness.peer.messages.slice(since.get(witness))
    .some((message) => message.type === MessageType.VOICE_USER_LEFT), false);
  assert.equal(f.signalingService.getParticipantsInChannel(voiceId).length, 2, 'membership survives the media server');
});

test('the address a client reached the server by is announced to ICE only in a form ICE can dial', (t) => {
  t.mock.method(os, 'networkInterfaces', () => ({}));
  const announced = (listenIp: string, host: string) => new SfuManager({ listenIp })['getListenInfos'](host)
    .flatMap((info) => info.protocol === 'udp' && info.announcedAddress ? [info.announcedAddress] : []);
  assert.deepEqual(announced('0.0.0.0', 'monky.example.com'), ['monky.example.com', '127.0.0.1']);
  assert.deepEqual(announced('0.0.0.0', '[2001:db8::1]'), ['127.0.0.1'],
    'IPv4 sockets cannot be reached on an IPv6 address, bracketed or not');
  assert.deepEqual(announced('::', '[2001:db8::1]'), ['2001:db8::1', '127.0.0.1'], 'no brackets in a candidate');
  assert.deepEqual(announced('0.0.0.0', 'localhost'), ['127.0.0.1']);
});

/**
 * Connections that receive through the real fan-out (`publish`, `send` and its
 * projections), each told about the rooms given (#384). `joining` is still
 * signing in: it has no snapshot yet. An access change is in progress
 * throughout, which drops anything that waits on a room's audience.
 */
function departureFixture() {
  const service = signaling();
  const sfu = new SfuManager();
  const server = Object.create(WebSocketServer.prototype) as WebSocketServer;
  server['signalingService'] = service;
  server['sfuManager'] = sfu;
  server['closing'] = false;
  // A change to channel access is running: departures go out whatever access is doing.
  void server['epoch'].change(() => new Promise<void>(() => {}));
  const permissions = Object.create(PermissionService.prototype) as PermissionService;
  permissions.getRoleAccessVersion = () => 0;
  server['permissionService'] = permissions;
  const frames: Array<{ to: string; message: Record<string, unknown> }> = [];
  type Session = Parameters<WebSocketServer['handleMessage']>[0];
  const connect = (sessionId: string, userId: string, rooms?: string[], extra: Partial<Session> = {}): Session => {
    const ws = Object.create(WebSocket.prototype) as WebSocket;
    Object.defineProperty(ws, 'readyState', { value: WebSocket.OPEN });
    Object.defineProperty(ws, 'bufferedAmount', { value: 0 });
    ws.send = (...args: unknown[]) => { frames.push({ to: sessionId, message: record(JSON.parse(String(args[0]))) }); };
    return {
      ws, sessionId, lastSeenAt: 0, ip: '127.0.0.1', messageQueue: Promise.resolve(), visibleChannelIds: rooms && new Set(rooms),
      user: { id: userId, sessionId, clientId: sessionId, nickname: userId, status: 'ONLINE', joinedAt: 1 }, ...extra,
    };
  };
  const clients = {
    alice: connect('alice', 'alice', ['room']),
    // The same person on a device that was never told about the room.
    alicePhone: connect('alice-phone', 'alice', ['lobby']),
    bob: connect('bob', 'bob', ['room']),
    outsider: connect('outsider', 'outsider', ['lobby']),
    joining: connect('joining', 'joining'),
    moderator: connect('moderator', 'moderator', ['lobby']),
    // Admitted into the room by a command, without seeing it.
    bot: connect('bot:helper', 'helper', ['lobby'], {
      isBot: true, botId: 'helper',
      botVoiceGrant: { channelId: 'room', creatorUserId: 'bob', originChannelId: 'text', accessVersion: 0 },
    }),
  };
  const all = Object.values(clients);
  server['sessions'] = new Map(all.map((client) => [client.ws, client]));
  server['sessionSockets'] = new Map(all.map((client) => [client.sessionId!, client.ws]));
  const received = (client: Session, type: MessageType) =>
    frames.filter((frame) => frame.to === client.sessionId && frame.message.type === type).map((frame) => frame.message);
  return { server, service, sfu, clients, frames, received };
}

test('a voice departure reaches who knows the room and every device of who left, at once and whatever access is doing (S-VOICE-5)', async () => {
  for (const exit of ['leave', 'eviction'] as const) {
    const f = departureFixture();
    for (const [sessionId, userId] of [['alice', 'alice'], ['bob', 'bob'], ['bot:helper', 'helper']]) {
      await f.service.joinVoiceChannel(sessionId, userId, 'room');
    }
    if (exit === 'leave') await f.server['voiceSessions']['handleVoiceLeave'](f.clients.alice, { channelId: 'room' }, 'leave');
    else f.server['voiceSessions'].evictFromVoiceChannel('alice', 'room');
    assert.equal(f.service.getVoiceState('alice'), undefined);
    const { alice, alicePhone, bob, bot, outsider, joining, moderator } = f.clients;
    for (const client of [alice, alicePhone, bob, bot]) {
      const left = f.received(client, MessageType.VOICE_USER_LEFT);
      assert.equal(left.length, 1, `${exit}: ${client.sessionId} hears it once`);
      assert.deepEqual(left[0].payload, { channelId: 'room', userId: 'alice', sessionId: 'alice' });
    }
    if (exit === 'leave') assert.equal(f.received(alice, MessageType.VOICE_USER_LEFT)[0].requestId, 'leave', 'it answers the leave');
    for (const client of [outsider, joining, moderator]) {
      assert.equal(f.received(client, MessageType.VOICE_USER_LEFT).length, 0, `${exit}: ${client.sessionId} never knew the room`);
    }
    f.server['voiceSessions'].evictFromVoiceChannel('bob', 'other-room');
    assert.equal(f.service.getVoiceState('bob')?.channelId, 'room', 'an eviction names the room it is for');
    f.sfu.close();
  }
});

test('a voice kick reaches only who it names and who asked, before the room hears of the departure (S-VOICE-5)', async () => {
  const f = departureFixture();
  const { alice, alicePhone, bob, bot, outsider, joining, moderator } = f.clients;
  for (const [sessionId, userId] of [['alice', 'alice'], ['bob', 'bob'], ['bot:helper', 'helper']]) {
    await f.service.joinVoiceChannel(sessionId, userId, 'room');
  }
  await f.server['voiceSessions']['handleAdminKickVoice'](moderator, { targetSessionId: 'alice' }, 'kick');
  assert.equal(f.service.getVoiceState('alice'), undefined);
  const kicked = f.received(moderator, MessageType.ADMIN_KICK_VOICE);
  assert.deepEqual(kicked.map((message) => [message.requestId, message.payload]), [['kick', { targetSessionId: 'alice' }]]);
  assert.equal(f.received(alice, MessageType.ADMIN_KICK_VOICE).length, 1);
  for (const client of [alicePhone, bob, bot, outsider, joining]) {
    assert.equal(f.received(client, MessageType.ADMIN_KICK_VOICE).length, 0, `${client.sessionId} is not told of the kick`);
  }
  const toAlice = f.frames.filter((frame) => frame.to === 'alice').map((frame) => frame.message.type);
  assert.deepEqual(toAlice, [MessageType.ADMIN_KICK_VOICE, MessageType.VOICE_USER_LEFT], 'the kick first, then the departure');
  for (const client of [alicePhone, bob, bot]) assert.equal(f.received(client, MessageType.VOICE_USER_LEFT).length, 1);
  for (const client of [outsider, joining, moderator]) {
    assert.equal(f.received(client, MessageType.VOICE_USER_LEFT).length, 0, `${client.sessionId} never knew the room`);
  }
  await f.server['voiceSessions']['handleAdminKickVoice'](moderator, { targetSessionId: 'alice' }, 'again');
  assert.equal(f.received(moderator, MessageType.SERVER_ERROR).length, 1, 'nobody left to kick');
  f.sfu.close();
});

test('a closed SFU producer reaches whoever was told of it, at once and whatever access is doing (S-VOICE-5)', async () => {
  const f = departureFixture();
  const { alice, bob, outsider, joining } = f.clients;
  for (const id of ['alice', 'bob']) await f.service.joinVoiceChannel(id, id, 'room');
  f.sfu['producers'].set('camera', {
    producer: { id: 'camera', closed: false, close() {} } as MediasoupTypes.Producer,
    transportId: 'send-alice', sessionId: 'alice', channelId: 'room', kind: 'video', appData: { mediaType: 'camera' },
  });
  bob.knownProducerIds = new Set(['camera']);
  f.server['sfuSignaling']['handleSfuProducerClosed'](alice, { channelId: 'room', producerId: 'camera' }, 'close');
  assert.deepEqual(f.received(alice, MessageType.SFU_PRODUCER_CLOSED).map((message) => message.requestId), ['close']);
  assert.deepEqual(f.received(bob, MessageType.SFU_PRODUCER_CLOSED).map((message) => message.payload),
    [{ channelId: 'room', producerId: 'camera' }], 'who consumed it learns it is gone');
  for (const client of [outsider, joining]) assert.equal(f.received(client, MessageType.SFU_PRODUCER_CLOSED).length, 0);
  f.sfu.close();
});

test('a private voice room keeps its departures, kicks and moves to whoever may see it; a deleted one loses its router (S-VOICE-5)', { timeout: 30_000 }, async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Room owner');
  const insider = await f.human('Room insider');
  const outsider = await f.human('Room outsider');
  const role = { id: randomUUID(), name: 'Room members', color: null, position: 1,
    permissions: DEFAULT_PERMISSIONS, isDefault: false, createdAt: Date.now() };
  await f.roleRepo.create(role);
  const publicId = text(recordList(record(owner.auth.payload.server).channels).find((channel) => channel.type === 'VOICE')?.id);
  const roomId = text(record((await owner.peer.request(MessageType.CHANNEL_CREATE, {
    name: 'private-room', type: 'VOICE', isPrivate: true, allowedRoleIds: [role.id],
  })).payload.channel).id);
  const sessionOf = (joined: Awaited<ReturnType<typeof f.human>>) => text(record(joined.auth.payload.currentUser).sessionId);
  const member = async (name: string) => {
    const joined = await f.human(name);
    await owner.peer.request(MessageType.ROLE_ASSIGN, { userId: joined.id, roleId: role.id });
    return { ...joined, sessionId: sessionOf(joined) };
  };
  await owner.peer.request(MessageType.ROLE_ASSIGN, { userId: insider.id, roleId: role.id });
  await insider.peer.wait((message) => message.type === MessageType.CHANNEL_CREATED && record(message.payload.channel).id === roomId);
  const outsiderSince = outsider.peer.messages.length;
  const left = (sessionId: string, channelId = roomId) => (message: Received) =>
    message.type === MessageType.VOICE_USER_LEFT && message.payload.sessionId === sessionId && message.payload.channelId === channelId;

  // Brought in by someone allowed and taken out again: the destination and the
  // departure stay with those who see the room, and with the guest.
  const guest = await f.human('Moved guest');
  const guestSessionId = sessionOf(guest);
  await guest.peer.request(MessageType.VOICE_JOIN, { channelId: publicId });
  const movedIn = await owner.peer.request(MessageType.ADMIN_MOVE_USER, { targetSessionId: guestSessionId, channelId: roomId });
  assert.equal(movedIn.type, MessageType.ADMIN_MOVE_USER, 'whoever asked gets the move as its answer');
  await guest.peer.wait((message) => message.type === MessageType.ADMIN_MOVE_USER && message.payload.channelId === roomId);
  let since = guest.peer.messages.length;
  await owner.peer.request(MessageType.ADMIN_MOVE_USER, { targetSessionId: guestSessionId, channelId: publicId });
  await insider.peer.wait(left(guestSessionId));
  await guest.peer.wait(left(guestSessionId), since);

  const participant = await member('Room participant');
  await participant.peer.request(MessageType.VOICE_JOIN, { channelId: roomId });
  since = insider.peer.messages.length;
  assert.equal((await owner.peer.request(MessageType.ADMIN_KICK_VOICE, { targetSessionId: participant.sessionId })).type,
    MessageType.ADMIN_KICK_VOICE);
  await participant.peer.wait((message) => message.type === MessageType.ADMIN_KICK_VOICE);
  await insider.peer.wait(left(participant.sessionId), since);

  const removed = await member('Removed member');
  await removed.peer.request(MessageType.VOICE_JOIN, { channelId: roomId });
  await owner.peer.request(MessageType.MEMBER_KICK, { targetUserId: removed.id });
  await insider.peer.wait(left(removed.sessionId));

  const dropped = await member('Dropped member');
  await dropped.peer.request(MessageType.VOICE_JOIN, { channelId: roomId });
  await dropped.peer.close();
  await insider.peer.wait(left(dropped.sessionId));

  await participant.peer.request(MessageType.VOICE_JOIN, { channelId: roomId });
  await f.serverRepo.updateServer({ voiceMode: 'sfu' });
  since = insider.peer.messages.length;
  assert.equal((await owner.peer.request(MessageType.SERVER_UPDATE_SETTINGS, { voiceMode: 'p2p' })).type,
    MessageType.SERVER_SETTINGS_UPDATED);
  const switched = await insider.peer.wait(left(participant.sessionId), since);
  assert.ok(record(switched.payload.reconnect).id, 'the mode switch departure carries the way back in');
  const leaks = async () => {
    await outsider.peer.barrier();
    return outsider.peer.messages.slice(outsiderSince).filter((message) =>
      message.type === MessageType.ADMIN_KICK_VOICE || message.type === MessageType.ADMIN_MOVE_USER
      || JSON.stringify(message.payload).includes(roomId)).map((message) => message.type);
  };
  assert.deepEqual(await leaks(), [], 'an outsider learns nothing of the private room');

  // Deleting the room ends the call inside it and closes its router, whose
  // last producers are announced to whoever was told of them.
  await participant.peer.request(MessageType.VOICE_JOIN, { channelId: roomId });
  const sfu = f.wsServer['sfuManager'];
  let routerClosed = false;
  sfu['routers'].set(roomId, { closed: false, close: () => { routerClosed = true; } } as MediasoupTypes.Router);
  sfu['producers'].set('straggler', {
    producer: { id: 'straggler', closed: false, close() {} } as MediasoupTypes.Producer,
    transportId: 'straggler-send', sessionId: 'straggler', channelId: roomId, kind: 'audio', appData: { mediaType: 'mic' },
  });
  const insiderSession = [...f.wsServer['sessions'].values()].find((session) => session.user?.id === insider.id);
  assert.ok(insiderSession);
  insiderSession.knownProducerIds = new Set(['straggler']);
  since = insider.peer.messages.length;
  await owner.peer.request(MessageType.CHANNEL_DELETE, { channelId: roomId });
  await insider.peer.wait(left(participant.sessionId), since);
  const closed = await insider.peer.wait((message) => message.type === MessageType.SFU_PRODUCER_CLOSED, since);
  assert.deepEqual(closed.payload, { channelId: roomId, producerId: 'straggler' });
  assert.equal(routerClosed, true, 'nothing else would ever close the router of a deleted room');
  assert.equal(sfu['routers'].has(roomId), false);
  assert.deepEqual(await leaks(), [], 'nor of its deletion');
});

test('a voice room that leaves or joins a connection\'s list takes or brings who is inside, but not its own person nor whom a command keeps a bot hearing (S-VOICE-5)', async () => {
  const f = departureFixture();
  for (const [sessionId, userId] of [['alice', 'alice'], ['bob', 'bob'], ['bot:helper', 'helper']]) {
    await f.service.joinVoiceChannel(sessionId, userId, 'room');
  }
  const { alicePhone, bob, bot, outsider } = f.clients;
  type Client = typeof bob;
  alicePhone.visibleChannelIds = new Set(['room', 'lobby']);
  bot.visibleChannelIds = new Set(['room', 'lobby']);
  const room: ChannelSummary = {
    id: 'room', serverId: 'server', name: 'room', type: 'VOICE', position: 0, createdAt: 0, botCommandsEnabled: false,
    isPrivate: false, allowedRoleIds: [],
  };
  const list = (client: Client, userId: string, visible: string[]) => f.server['visibility'].sendChannels(client, new Set(visible),
    [room], [], { userId, permissions: 0, roleIds: [], isBot: client.isBot }, false);
  const withdraw = (client: Client, userId: string) => list(client, userId, ['lobby']);
  const show = (client: Client, userId: string) => list(client, userId, ['lobby', 'room']);
  const story = (client: Client) => f.frames.filter((frame) => frame.to === client.sessionId).map(({ message }) =>
    message.type === MessageType.VOICE_USER_LEFT ? `left:${text(record(message.payload).sessionId)}`
      : message.type === MessageType.VOICE_USER_JOINED ? `joined:${text(record(message.payload).sessionId)}` : text(message.type))
    .filter((entry) => entry !== MessageType.CATEGORIES_UPDATED);

  withdraw(bob, 'bob');
  assert.deepEqual(story(bob), ['left:alice', 'left:bot:helper', MessageType.CHANNEL_DELETED],
    'everyone still inside goes before the room, or the client keeps them there for good');
  show(bob, 'bob');
  assert.deepEqual(story(bob).slice(3), [MessageType.CHANNEL_CREATED, 'joined:alice', 'joined:bot:helper'],
    'shown again, the room comes back with them, or it would look empty');
  withdraw(alicePhone, 'alice');
  show(alicePhone, 'alice');
  assert.deepEqual(story(alicePhone), ['left:bob', 'left:bot:helper', MessageType.CHANNEL_DELETED,
    MessageType.CHANNEL_CREATED, 'joined:bob', 'joined:bot:helper'],
  'its own person is left out: their departure and arrival reach every device of theirs, from any room');
  show(outsider, 'outsider');
  assert.deepEqual(story(outsider), [MessageType.CHANNEL_CREATED, 'joined:alice', 'joined:bob', 'joined:bot:helper'],
    'a room shown for the first time comes with whoever was already inside');
  const arrival = f.received(outsider, MessageType.VOICE_USER_JOINED)[0];
  assert.equal(arrival.requestId, undefined);
  assert.equal(record(record(arrival.payload).user).id, 'alice');
  assert.equal(record(record(arrival.payload).voiceState).channelId, 'room');
  assert.equal(record(arrival.payload).participants, undefined, 'a roster goes only to the connection that joins');

  withdraw(bot, 'helper');
  show(bot, 'helper');
  assert.deepEqual(story(bot), [MessageType.CHANNEL_DELETED, MessageType.CHANNEL_CREATED],
    'the command that admitted it still lets it hear of the room');
  bot.botVoiceGrant = undefined;
  withdraw(bot, 'helper');
  show(bot, 'helper');
  assert.deepEqual(story(bot).slice(2), ['left:alice', 'left:bob', MessageType.CHANNEL_DELETED,
    MessageType.CHANNEL_CREATED, 'joined:alice', 'joined:bob'],
  'without the command, the bot is just another connection that stops and starts seeing the room');
  assert.equal(f.service.getParticipantsInChannel('room').length, 3, 'a room going in or out of a list moves nobody');
  f.sfu.close();
});

test('a connection that stops seeing a voice room is told who was inside left, whoever the reconciliation reaches first (S-VOICE-5)', { timeout: 30_000 }, async (t) => {
  const f = await createFixture({ approvedBotCapabilities: ['publish_voice'] });
  t.after(() => f.dispose());
  const owner = await f.human('Room manager');
  // Connected before the bot, so the reconciliation reaches the watcher first,
  // and the bot is evicted only after the room left the watcher's list.
  const watcher = await f.human('Room watcher');
  const insider = await f.human('Room insider');
  const roomId = text(record((await owner.peer.request(MessageType.CHANNEL_CREATE, { name: 'closing-room', type: 'VOICE' }))
    .payload.channel).id);
  const created = await owner.peer.request(MessageType.BOT_CREATE, {});
  const bot = await f.bot(text(created.payload.token));
  const insiderSessionId = text(record(insider.auth.payload.currentUser).sessionId);
  const botSessionId = text(record(bot.auth.payload.currentUser).sessionId);
  await insider.peer.request(MessageType.VOICE_JOIN, { channelId: roomId });
  assert.equal((await bot.peer.request(MessageType.VOICE_JOIN, { channelId: roomId })).type, MessageType.VOICE_USER_JOINED);
  for (const sessionId of [insiderSessionId, botSessionId]) {
    await watcher.peer.wait((message) => message.type === MessageType.VOICE_USER_JOINED && message.payload.sessionId === sessionId);
  }
  const story = (peer: typeof watcher.peer, since: number) => peer.messages.slice(since)
    .filter((message) => JSON.stringify(message.payload).includes(roomId))
    .map((message) => message.type === MessageType.VOICE_USER_LEFT ? `left:${text(message.payload.sessionId)}` : message.type);
  const deleted = (message: Received) => message.type === MessageType.CHANNEL_DELETED && message.payload.channelId === roomId;

  // Managers only: the watcher and the bot lose the room in the same pass. The
  // insider stays, as someone inside a room keeps seeing it.
  const watcherSince = watcher.peer.messages.length;
  const botSince = bot.peer.messages.length;
  assert.equal((await owner.peer.request(MessageType.CHANNEL_UPDATE, { channelId: roomId, isPrivate: true, allowedRoleIds: [] })).type,
    MessageType.CHANNEL_UPDATED);
  await watcher.peer.wait(deleted, watcherSince);
  await bot.peer.wait(deleted, botSince);
  assert.deepEqual(story(watcher.peer, watcherSince), [`left:${insiderSessionId}`, `left:${botSessionId}`, MessageType.CHANNEL_DELETED],
    'both go before the room, the bot too though its eviction comes after');
  assert.deepEqual(story(bot.peer, botSince), [`left:${botSessionId}`, `left:${insiderSessionId}`, MessageType.CHANNEL_DELETED],
    'the evicted bot hears of its own departure first');
  assert.equal(f.wsServer['signalingService'].getVoiceState(insiderSessionId)?.channelId, roomId);

  const after = watcher.peer.messages.length;
  await owner.peer.request(MessageType.ADMIN_KICK_VOICE, { targetSessionId: insiderSessionId });
  await insider.peer.close();
  await watcher.peer.barrier();
  assert.deepEqual(story(watcher.peer, after), [], 'nothing about the room reaches it any more');
});

test('a voice room shown to a connection brings whoever is already inside, the first time and every time after (S-VOICE-5)', { timeout: 30_000 }, async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Room manager');
  const watcher = await f.human('Room watcher');
  const roomId = text(record((await owner.peer.request(MessageType.CHANNEL_CREATE, {
    name: 'appearing-room', type: 'VOICE', isPrivate: true, allowedRoleIds: [],
  })).payload.channel).id);
  const ownerSessionId = text(record(owner.auth.payload.currentUser).sessionId);
  await owner.peer.request(MessageType.VOICE_JOIN, { channelId: roomId });
  const tracked = new Set<string>([MessageType.CHANNEL_CREATED, MessageType.CHANNEL_DELETED,
    MessageType.VOICE_USER_JOINED, MessageType.VOICE_USER_LEFT]);
  const story = (since: number) => watcher.peer.messages.slice(since)
    .filter((message) => tracked.has(message.type) && JSON.stringify(message.payload).includes(roomId))
    .map((message) => message.type === MessageType.VOICE_USER_JOINED ? `joined:${text(message.payload.sessionId)}`
      : message.type === MessageType.VOICE_USER_LEFT ? `left:${text(message.payload.sessionId)}` : message.type);
  // Managers only, or open to everyone: the watcher loses or gains the room.
  const setPrivate = async (isPrivate: boolean) => {
    const since = watcher.peer.messages.length;
    assert.equal((await owner.peer.request(MessageType.CHANNEL_UPDATE, { channelId: roomId, isPrivate, allowedRoleIds: [] })).type,
      MessageType.CHANNEL_UPDATED);
    await watcher.peer.wait((message) => message.type === (isPrivate ? MessageType.CHANNEL_DELETED : MessageType.CHANNEL_CREATED)
      && JSON.stringify(message.payload).includes(roomId), since);
    await watcher.peer.barrier();
    return since;
  };

  let since = await setPrivate(false);
  assert.deepEqual(story(since), [MessageType.CHANNEL_CREATED, `joined:${ownerSessionId}`], 'the first time it is shown');
  const arrival = watcher.peer.messages.slice(since).find((message) => message.type === MessageType.VOICE_USER_JOINED);
  assert.equal(record(arrival?.payload.user).id, owner.id);
  assert.equal(record(arrival?.payload.voiceState).channelId, roomId);
  since = await setPrivate(true);
  assert.deepEqual(story(since), [`left:${ownerSessionId}`, MessageType.CHANNEL_DELETED]);
  since = await setPrivate(false);
  assert.deepEqual(story(since), [MessageType.CHANNEL_CREATED, `joined:${ownerSessionId}`],
    'and every time again: shown empty, it would stay so until each of them changed something');
});

test('whoever saw a voice room only from inside is told of the move or the leave before the room goes, and who stayed in it with the room (S-VOICE-5)', { timeout: 30_000 }, async (t) => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Room manager');
  const guest = await f.human('Moved guest');
  const publicId = text(recordList(record(owner.auth.payload.server).channels).find((channel) => channel.type === 'VOICE')?.id);
  const roomId = text(record((await owner.peer.request(MessageType.CHANNEL_CREATE, {
    name: 'managers-room', type: 'VOICE', isPrivate: true, allowedRoleIds: [],
  })).payload.channel).id);
  const ownerSessionId = text(record(owner.auth.payload.currentUser).sessionId);
  const guestSessionId = text(record(guest.auth.payload.currentUser).sessionId);
  await owner.peer.request(MessageType.VOICE_JOIN, { channelId: roomId });
  await guest.peer.request(MessageType.VOICE_JOIN, { channelId: publicId });
  // The move out names only the destination, so it is kept by its type.
  const tracked = new Set<string>([MessageType.CHANNEL_CREATED, MessageType.CHANNEL_DELETED,
    MessageType.VOICE_USER_JOINED, MessageType.VOICE_USER_LEFT]);
  const story = (since: number) => guest.peer.messages.slice(since)
    .filter((message) => message.type === MessageType.ADMIN_MOVE_USER
      || (tracked.has(message.type) && JSON.stringify(message.payload).includes(roomId)))
    .map((message) => message.type === MessageType.VOICE_USER_LEFT ? `left:${text(message.payload.sessionId)}`
      : message.type === MessageType.VOICE_USER_JOINED ? `joined:${text(message.payload.sessionId)}` : message.type);

  for (const exit of ['move', 'leave'] as const) {
    const movedIn = guest.peer.messages.length;
    await owner.peer.request(MessageType.ADMIN_MOVE_USER, { targetSessionId: guestSessionId, channelId: roomId });
    await guest.peer.wait((message) => message.type === MessageType.VOICE_USER_JOINED &&
      message.payload.sessionId === guestSessionId && message.payload.channelId === roomId, movedIn);
    // Already inside when the room is shown, the guest is told who else is,
    // but not of itself: its client is still in the old call, and follows
    // only once told of the move.
    assert.deepEqual(story(movedIn), [MessageType.CHANNEL_CREATED, `joined:${ownerSessionId}`, MessageType.ADMIN_MOVE_USER,
      `joined:${guestSessionId}`], `${exit}: the room, who is inside, the move, then its own arrival`);
    const since = guest.peer.messages.length;
    if (exit === 'move') await owner.peer.request(MessageType.ADMIN_MOVE_USER, { targetSessionId: guestSessionId, channelId: publicId });
    else await guest.peer.request(MessageType.VOICE_LEAVE, { channelId: roomId });
    await guest.peer.wait((message) => message.type === MessageType.CHANNEL_DELETED && message.payload.channelId === roomId, since);
    // Withdrawn before the move, the owner's departure would reach a client
    // still in the call: it would hear them leave and drop their connection.
    assert.deepEqual(story(since), [
      ...(exit === 'move' ? [MessageType.ADMIN_MOVE_USER] : []),
      `left:${guestSessionId}`, `left:${ownerSessionId}`, MessageType.CHANNEL_DELETED,
    ], `${exit}: its own departure, then who stayed, then the room`);
  }

  const after = guest.peer.messages.length;
  await owner.peer.request(MessageType.VOICE_LEAVE, { channelId: roomId });
  await guest.peer.barrier();
  assert.deepEqual(story(after), [], 'nothing about the room reaches it any more');
});

test('a person moved by the server keeps the call when their client follows by leaving the old room first, as Light does (S-VOICE-5)', { timeout: 30_000 }, async (t) => {
  const follow = VoiceSessionHandler.FOLLOW_MOVE_MS;
  VoiceSessionHandler.FOLLOW_MOVE_MS = 500;
  t.after(() => { VoiceSessionHandler.FOLLOW_MOVE_MS = follow; });
  const f = await createFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Room manager');
  const guest = await f.human('Light guest');
  const lobbyId = text(recordList(record(owner.auth.payload.server).channels).find((channel) => channel.type === 'VOICE')?.id);
  const create = async (name: string, isPrivate: boolean) => text(record((await owner.peer.request(MessageType.CHANNEL_CREATE, {
    name, type: 'VOICE', isPrivate, allowedRoleIds: [],
  })).payload.channel).id);
  const hiddenId = await create('managers-room', true);
  const openId = await create('open-room', false);
  const guestSessionId = text(record(guest.auth.payload.currentUser).sessionId);
  await guest.peer.request(MessageType.VOICE_JOIN, { channelId: lobbyId });

  // Into a room the guest cannot see, where its leave used to take away the
  // access its join then needed, and into one it sees, where the room heard
  // it leave and come back.
  let from = lobbyId;
  for (const [label, to] of [['hidden', hiddenId], ['visible', openId]] as const) {
    await owner.peer.request(MessageType.VOICE_JOIN, { channelId: to });
    const ownerSince = owner.peer.messages.length;
    const guestSince = guest.peer.messages.length;
    await owner.peer.request(MessageType.ADMIN_MOVE_USER, { targetSessionId: guestSessionId, channelId: to });
    await guest.peer.wait((message) => message.type === MessageType.ADMIN_MOVE_USER && message.payload.channelId === to, guestSince);
    // What Light does on a move: a leave of the room it was in, with no requestId, then the join.
    guest.peer.send(MessageType.VOICE_LEAVE, { channelId: from });
    const joined = await guest.peer.request(MessageType.VOICE_JOIN, { channelId: to });
    assert.equal(joined.type, MessageType.VOICE_USER_JOINED, `${label}: ${JSON.stringify(joined.payload)}`);
    assert.ok(recordList(joined.payload.participants).some((participant) => record(participant.voiceState).sessionId === guestSessionId));
    // Past the wait for that join, the leave it cancelled must not take effect.
    await delay(VoiceSessionHandler.FOLLOW_MOVE_MS * 2);
    assert.equal(f.wsServer['signalingService'].getVoiceState(guestSessionId)?.channelId, to, `${label}: still in the call`);
    await owner.peer.barrier();
    assert.equal(owner.peer.messages.slice(ownerSince).some((message) => message.type === MessageType.VOICE_USER_LEFT
      && message.payload.sessionId === guestSessionId && message.payload.channelId === to), false, `${label}: the room never hears it leave`);
    from = to;
  }
});

test('a hang-up that crossed one move or two, or named a room it never reached, still ends the call where it is (S-VOICE-5)', { timeout: 30_000 }, async (t) => {
  const follow = VoiceSessionHandler.FOLLOW_MOVE_MS;
  t.after(() => { VoiceSessionHandler.FOLLOW_MOVE_MS = follow; });
  const f = await createFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Room manager');
  const guest = await f.human('Desktop guest');
  const lobbyId = text(recordList(record(owner.auth.payload.server).channels).find((channel) => channel.type === 'VOICE')?.id);
  const create = async (name: string) => text(record((await owner.peer.request(MessageType.CHANNEL_CREATE, { name, type: 'VOICE' }))
    .payload.channel).id);
  const roomId = await create('other-room');
  const thirdId = await create('third-room');
  const guestSessionId = text(record(guest.auth.payload.currentUser).sessionId);
  const state = () => f.wsServer['signalingService'].getVoiceState(guestSessionId);
  await owner.peer.request(MessageType.VOICE_JOIN, { channelId: roomId });
  await guest.peer.request(MessageType.VOICE_JOIN, { channelId: lobbyId });

  // The desktop hung up before reading the move: its leave names the lobby,
  // and no join follows, as it is no longer in a call to take along.
  VoiceSessionHandler.FOLLOW_MOVE_MS = 2000;
  const ownerSince = owner.peer.messages.length;
  const guestSince = guest.peer.messages.length;
  await owner.peer.request(MessageType.ADMIN_MOVE_USER, { targetSessionId: guestSessionId, channelId: roomId });
  guest.peer.send(MessageType.VOICE_LEAVE, { channelId: lobbyId }, 'hang-up');
  await guest.peer.barrier();
  assert.equal(state()?.channelId, roomId, 'the leave waits for a join that would follow the move');
  const ended = await guest.peer.wait((message) => message.type === MessageType.VOICE_USER_LEFT && message.requestId === 'hang-up',
    guestSince);
  assert.deepEqual(ended.payload, { channelId: roomId, userId: guest.id, sessionId: guestSessionId },
    'none came: the call ends where it is, answering the hang-up');
  assert.equal(state(), undefined, 'nobody is left in a call their client hung up');
  await owner.peer.wait((message) => message.type === MessageType.VOICE_USER_LEFT && message.payload.sessionId === guestSessionId
    && message.payload.channelId === roomId, ownerSince);

  // Moved again while that leave waits: the desktop follows neither move, so
  // the hang-up still ends the call, in the room the second one took it to.
  await guest.peer.request(MessageType.VOICE_JOIN, { channelId: lobbyId });
  const againSince = guest.peer.messages.length;
  await owner.peer.request(MessageType.ADMIN_MOVE_USER, { targetSessionId: guestSessionId, channelId: roomId });
  guest.peer.send(MessageType.VOICE_LEAVE, { channelId: lobbyId }, 'hang-up-again');
  await guest.peer.barrier();
  await owner.peer.request(MessageType.ADMIN_MOVE_USER, { targetSessionId: guestSessionId, channelId: thirdId });
  assert.equal(state()?.channelId, thirdId, 'the second move went through while the leave waited');
  const endedAgain = await guest.peer.wait((message) => message.type === MessageType.VOICE_USER_LEFT
    && message.requestId === 'hang-up-again', againSince);
  assert.deepEqual(endedAgain.payload, { channelId: thirdId, userId: guest.id, sessionId: guestSessionId },
    'a later move keeps the waiting hang-up, which ends the call where it took it');
  assert.equal(state(), undefined);

  // Switching rooms and hanging up before the join went out: the leave names
  // a room the connection never reached, and ends the call at once.
  VoiceSessionHandler.FOLLOW_MOVE_MS = 60_000;
  await guest.peer.request(MessageType.VOICE_JOIN, { channelId: lobbyId });
  const left = await guest.peer.request(MessageType.VOICE_LEAVE, { channelId: roomId });
  assert.equal(left.type, MessageType.VOICE_USER_LEFT);
  assert.equal(left.payload.channelId, lobbyId);
  assert.equal(state(), undefined);
});
