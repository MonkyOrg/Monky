import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { MessageType, Permission, ProtocolErrorCode, type ProtocolMessage, type ServerSettingsUpdatedPayload, type VoiceUserJoinedPayload, type VoiceUserLeftPayload } from '@monky/shared';
import { WebSocketServer } from './infrastructure/websocket/WebSocketServer';
import { SignalingService } from './application/services/SignalingService';
import { AuthService } from './application/services/AuthService';
import { SfuManager } from './infrastructure/sfu/SfuManager';
import type { ChannelRecord, ServerRecord, VoiceRestrictions } from './domain/entities';

test('SFU advertises both H264 profiles with distinct RTX and preserves the legacy first profile', async (t) => {
  const sfu = new SfuManager({ listenIp: '127.0.0.1', announcedIp: '127.0.0.1' });
  t.after(() => sfu.close());
  const { codecs = [] } = await sfu.getRouterRtpCapabilities('h264-profiles');
  const h264 = codecs.filter((codec) => codec.mimeType.toLowerCase() === 'video/h264');
  assert.deepEqual(h264.map((codec) => codec.parameters?.['profile-level-id']), ['42e01f', '42001f']);
  assert.equal(new Set(h264.map((codec) => codec.preferredPayloadType)).size, 2);
  for (const codec of h264) {
    assert.equal(codec.parameters?.['packetization-mode'], 1);
    assert.equal(codec.parameters?.['level-asymmetry-allowed'], 1);
    assert.equal(codecs.filter((repair) => repair.mimeType.toLowerCase() === 'video/rtx'
      && repair.parameters?.['apt'] === codec.preferredPayloadType).length, 1);
  }
  assert.deepEqual(codecs.filter((codec) => !/\/(h264|rtx)$/i.test(codec.mimeType))
    .map((codec) => codec.mimeType.toLowerCase()), ['audio/opus', 'video/av1', 'video/vp9', 'video/vp8']);
});

function fixture(restricted = true) {
  let mode: 'sfu' | 'p2p' = 'sfu';
  let allowed = true, exists = true, closes = 0;
  const channel: ChannelRecord = {
    id: 'room', serverId: 'server', name: 'Voice', type: 'VOICE', position: 0,
    createdAt: 1, maxParticipants: 10, isPrivate: false, allowedRoleIds: [], botCommandsEnabled: false,
  };
  const restrictions = new Map<string, VoiceRestrictions>();
  const signaling = new SignalingService({
    findById: async (id) => exists ? { ...channel, id } : null, listByServerId: async () => [channel],
    create: async () => {}, update: async () => {}, delete: async () => {}, updatePosition: async () => {},
  }, {
    getForUser: (userId) => ({ ...(restrictions.get(userId) ?? { serverMuted: restricted, serverDeafened: restricted }) }),
    save: (userId, state) => { restrictions.set(userId, { ...state }); },
  });
  const server = Object.create(WebSocketServer.prototype) as WebSocketServer;
  type Session = Parameters<WebSocketServer['handleServerUpdateSettings']>[0];
  const session = (id: string): Session => {
    const ws = Object.create(WebSocket.prototype) as WebSocket;
    Object.defineProperty(ws, 'readyState', { value: WebSocket.OPEN });
    return {
      ws, sessionId: id, isAlive: true, ip: '127.0.0.1', messageQueue: Promise.resolve(),
      user: { id, sessionId: id, clientId: id, nickname: id, status: 'ONLINE', joinedAt: 1 },
    };
  };
  const admin = session('admin'), alice = session('alice'), bob = session('bob');
  const sessions = [admin, alice, bob];
  server['sessions'] = new Map(sessions.map((entry) => [entry.ws, entry]));
  server['sessionSockets'] = new Map(sessions.map((entry) => [entry.sessionId!, entry.ws]));
  server['voiceReconnectGrants'] = new Map();
  server['settingsUpdateQueue'] = Promise.resolve();
  server['signalingService'] = signaling;
  const record = (): ServerRecord => ({ id: 'server', name: 'Test', createdAt: 1, passwordHash: '', maxUsers: 10, voiceMode: mode });
  server['serverRepo'] = { getServer: async () => record(), createServer: async () => {}, updateServer: async () => {} };
  const auth = Object.create(AuthService.prototype) as AuthService;
  auth.updateServerSettings = async (payload) => {
    mode = payload.voiceMode ?? mode;
    return { success: true, name: 'Test', hasPassword: false, voiceMode: mode };
  };
  server['authService'] = auth;
  const sfu = new SfuManager();
  sfu.close = () => { closes++; };
  sfu.init = async () => true;
  sfu.checkPortAvailability = async () => null;
  server['sfuManager'] = sfu;
  server['applyTurnState'] = async () => {};
  const broadcasts: ProtocolMessage[] = [];
  const sent: Array<{ session: Session | undefined; message: ProtocolMessage }> = [];
  server['broadcast'] = (message) => { broadcasts.push(message); };
  server['broadcastToChannel'] = async (_id, message) => { broadcasts.push(message); };
  server['send'] = (ws, message) => { sent.push({ session: sessions.find((entry) => entry.ws === ws), message }); };
  server['requirePermission'] = async (entry, permission, id) => {
    if (permission !== Permission.SPEAK || allowed) return true;
    server['sendError'](entry.ws, ProtocolErrorCode.PERMISSION_DENIED, 'Denied', id);
    return false;
  };
  server['requireChannelAccess'] = async (entry, _channelId, id) => {
    if (exists) return true;
    server['sendError'](entry.ws, ProtocolErrorCode.CHANNEL_NOT_FOUND, 'Gone', id);
    return false;
  };
  return {
    server, signaling, admin, alice, bob, broadcasts, sent,
    closes: () => closes, setMode: (next: 'p2p' | 'sfu') => { mode = next; },
    revoke: () => { allowed = false; }, removeChannel: () => { exists = false; },
  };
}

async function switchMode(f: ReturnType<typeof fixture>) {
  await f.signaling.joinVoiceChannel('alice', 'alice', 'room');
  await f.signaling.joinVoiceChannel('bob', 'bob', 'other-room');
  await f.server['handleServerUpdateSettings'](f.admin, { voiceMode: 'p2p' }, 'save');
  const settings = f.broadcasts.find((message) => message.type === MessageType.SERVER_SETTINGS_UPDATED)?.payload as ServerSettingsUpdatedPayload;
  assert.ok(settings.voiceTransition);
  return settings.voiceTransition.id;
}

test('only a real SFU to P2P change fully closes media and grants one reconnect to each original channel', async () => {
  const f = fixture();
  const id = await switchMode(f);
  assert.equal(f.closes(), 1);
  assert.equal(Object.keys(f.signaling.getAllVoiceStates()).length, 0);
  const left = f.broadcasts.filter((message) => message.type === MessageType.VOICE_USER_LEFT).map((message) => message.payload as VoiceUserLeftPayload);
  assert.deepEqual(left.map((entry) => [entry.sessionId, entry.channelId, entry.reconnect?.id]),
    [['alice', 'room', id], ['bob', 'other-room', id]]);
  assert.equal(f.broadcasts.at(-1)?.type, MessageType.SERVER_SETTINGS_UPDATED);
  for (const [session, channelId] of [[f.alice, 'room'], [f.bob, 'other-room']] as const) {
    await f.server['handleVoiceReconnect'](session, { channelId, transitionId: id }, `rejoin-${session.sessionId}`);
    const joined = f.sent.at(-1)?.message;
    assert.equal(joined?.type, MessageType.VOICE_RECONNECTED);
    assert.equal(f.signaling.getVoiceState(session.sessionId!)?.channelId, channelId);
    assert.equal(f.signaling.getVoiceState(session.sessionId!)?.serverMuted, true);
    assert.equal(f.signaling.getVoiceState(session.sessionId!)?.serverDeafened, true);
  }
  await f.server['handleServerUpdateSettings'](f.admin, { voiceMode: 'p2p', name: 'Rename' });
  assert.equal(f.closes(), 1, 'unchanged full-form save never evicts the reconnected users');
  assert.equal(Object.keys(f.signaling.getAllVoiceStates()).length, 2);
  await f.server['handleVoiceReconnect'](f.alice, { channelId: 'room', transitionId: id }, 'repeat');
  assert.equal(f.sent.at(-1)?.message.type, MessageType.SERVER_ERROR);
  assert.equal(f.signaling.getVoiceState('alice')?.channelId, 'room');
});

test('concurrent settings saves observe the committed mode and tear down only once', async () => {
  const f = fixture();
  await f.signaling.joinVoiceChannel('alice', 'alice', 'room');
  await Promise.all([
    f.server['handleServerUpdateSettings'](f.admin, { voiceMode: 'p2p' }),
    f.server['handleServerUpdateSettings'](f.bob, { voiceMode: 'p2p' }),
  ]);
  assert.equal(f.closes(), 1);
  assert.equal(f.broadcasts.filter((message) => message.type === MessageType.VOICE_USER_LEFT).length, 1);
});

test('P2P to SFU keeps membership and does not request a leave/rejoin', async () => {
  const f = fixture();
  f.setMode('p2p');
  await f.signaling.joinVoiceChannel('alice', 'alice', 'room');
  await f.server['handleServerUpdateSettings'](f.admin, { voiceMode: 'sfu' });
  assert.equal(f.signaling.getVoiceState('alice')?.channelId, 'room');
  assert.equal(f.closes(), 0);
  assert.equal(f.server['voiceReconnectGrants'].size, 0);
  assert.equal(f.broadcasts.filter((message) => message.type === MessageType.VOICE_USER_LEFT).length, 0);
});

test('grants reject wrong channel, stale token, another physical connection, manual leave and kick', async () => {
  const f = fixture();
  const id = await switchMode(f);
  for (const [session, channelId, token] of [
    [f.alice, 'other-room', id], [f.alice, 'room', 'stale'], [{ ...f.alice }, 'room', id],
  ] as const) {
    await f.server['handleVoiceReconnect'](session, { channelId, transitionId: token }, 'bad');
    assert.equal(f.sent.at(-1)?.message.type, MessageType.SERVER_ERROR);
    assert.equal(f.signaling.getVoiceState('alice'), undefined);
  }
  await f.server['handleMessage'](f.alice, { type: MessageType.VOICE_LEAVE, payload: { channelId: 'room' } });
  await f.server['handleVoiceReconnect'](f.alice, { channelId: 'room', transitionId: id }, 'after-leave');
  assert.equal(f.signaling.getVoiceState('alice'), undefined);
  await f.server['handleMessage'](f.admin, { type: MessageType.ADMIN_KICK_VOICE, payload: { targetSessionId: 'bob' } });
  assert.ok(f.broadcasts.some((message) => message.type === MessageType.ADMIN_KICK_VOICE));
  await f.server['handleVoiceReconnect'](f.bob, { channelId: 'other-room', transitionId: id }, 'after-kick');
  assert.equal(f.signaling.getVoiceState('bob'), undefined);
});

test('removed channels and revoked permission fail admission, and a later mode change invalidates grants', async () => {
  for (const mutate of ['permission', 'channel', 'mode'] as const) {
    const f = fixture();
    const id = await switchMode(f);
    if (mutate === 'permission') f.revoke();
    if (mutate === 'channel') f.removeChannel();
    if (mutate === 'mode') await f.server['handleServerUpdateSettings'](f.admin, { voiceMode: 'sfu' });
    await f.server['handleVoiceReconnect'](f.alice, { channelId: 'room', transitionId: id }, 'denied');
    assert.equal(f.sent.at(-1)?.message.type, MessageType.SERVER_ERROR);
    assert.equal(f.signaling.getVoiceState('alice'), undefined);
  }
});

test('kick during an awaited rejoin cancels its exact grant and cleans a late admission before acknowledgement', async (t) => {
  const f = fixture();
  const id = await switchMode(f);
  let release = () => {};
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const join = f.signaling.joinVoiceChannel.bind(f.signaling);
  t.mock.method(f.signaling, 'joinVoiceChannel', async (...args: Parameters<SignalingService['joinVoiceChannel']>) => {
    await blocked;
    return join(...args);
  });
  const rejoining = f.server['handleVoiceReconnect'](f.alice, { channelId: 'room', transitionId: id }, 'racing');
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await f.server['handleMessage'](f.admin, { type: MessageType.ADMIN_KICK_VOICE, payload: { targetSessionId: 'alice' } });
  release();
  await rejoining;
  assert.equal(f.signaling.getVoiceState('alice'), undefined);
  assert.equal(f.sent.filter((entry) => entry.message.type === MessageType.VOICE_RECONNECTED).length, 0);
});

test('ordinary admission correlates only the final own roster, including moderation changed during the broadcast', async () => {
  const f = fixture(false);
  f.setMode('p2p');
  f.server['broadcastToChannel'] = async (_channelId, message) => {
    f.broadcasts.push(message);
    f.signaling.setServerMuted('alice', true);
  };
  await f.server['handleVoiceJoin'](f.alice, { channelId: 'room', isMuted: false, isDeafened: false }, 'own-admission');
  const announcement = f.broadcasts.find((message) => message.type === MessageType.VOICE_USER_JOINED);
  assert.ok(announcement);
  assert.equal((announcement.payload as VoiceUserJoinedPayload).voiceState.serverMuted, false);
  assert.equal(announcement.requestId, undefined, 'an earlier broadcast must never release the client admission gate');
  const acknowledgement = f.sent.find((entry) => entry.session === f.alice && entry.message.requestId === 'own-admission')?.message;
  assert.equal(acknowledgement?.type, MessageType.VOICE_USER_JOINED);
  const joined = acknowledgement?.payload as VoiceUserJoinedPayload;
  assert.equal(joined.voiceState.serverMuted, true);
  assert.equal(joined.participants?.find((entry) => entry.user.sessionId === 'alice')?.voiceState.serverMuted, true);
});

test('ordinary admission revoked during the scoped broadcast fails instead of acknowledging the old membership', async () => {
  const f = fixture();
  f.setMode('p2p');
  f.server['broadcastToChannel'] = async (_channelId, message) => {
    f.broadcasts.push(message);
    f.signaling.leaveVoiceChannel('alice');
  };
  await f.server['handleVoiceJoin'](f.alice, { channelId: 'room' }, 'revoked-admission');
  const acknowledgement = f.sent.find((entry) => entry.message.requestId === 'revoked-admission')?.message;
  assert.equal(acknowledgement?.type, MessageType.SERVER_ERROR);
  assert.equal(f.signaling.getVoiceState('alice'), undefined);
});

test('mode reconnection reloads saved user moderation after full teardown without restricting other users', async () => {
  const f = fixture(false);
  await f.signaling.joinVoiceChannel('alice', 'alice', 'room');
  f.signaling.setServerMuted('alice', true);
  f.signaling.setServerDeafened('alice', true);
  const id = await switchMode(f);
  assert.equal(Object.keys(f.signaling.getAllVoiceStates()).length, 0);
  for (const [session, channelId, restricted] of [[f.alice, 'room', true], [f.bob, 'other-room', false]] as const) {
    await f.server['handleVoiceReconnect'](session, { channelId, transitionId: id }, `moderated-${session.sessionId}`);
    const acknowledgement = f.sent.at(-1)?.message;
    assert.equal(acknowledgement?.type, MessageType.VOICE_RECONNECTED);
    const joined = acknowledgement?.payload as VoiceUserJoinedPayload;
    assert.equal(joined.voiceState.serverMuted, restricted);
    assert.equal(joined.voiceState.serverDeafened, restricted);
  }
});
