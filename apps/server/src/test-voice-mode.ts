import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { MessageType, Permission, ProtocolErrorCode, type ProtocolMessage, type ServerSettingsUpdatedPayload, type VoiceUserJoinedPayload, type VoiceUserLeftPayload } from '@monky/shared';
import { WebSocketServer } from './infrastructure/websocket/WebSocketServer';
import { SignalingService } from './application/services/SignalingService';
import { AuthService, serverSettingsPayload } from './application/services/AuthService';
import { BotLocalExecutionService } from './application/services/BotLocalExecutionService';
import { SfuManager } from './infrastructure/sfu/SfuManager';
import type { ChannelRecord, ServerRecord, VoiceRestrictions } from './domain/entities';
import { SERVER_SETTING_DEFAULTS } from './domain/serverSettings';

test('SFU advertises AV1 forwarding limits and preserves legacy/native H264 profiles, RTX and codec order', async (t) => {
  const sfu = new SfuManager({ listenIp: '127.0.0.1', announcedIp: '127.0.0.1' });
  t.after(() => sfu.close());
  const { codecs = [] } = await sfu.getRouterRtpCapabilities('h264-profiles');
  const h264 = codecs.filter((codec) => codec.mimeType.toLowerCase() === 'video/h264');
  assert.deepEqual(h264.map((codec) => codec.parameters?.['profile-level-id']), ['42e01f', '42001f', '4d003c']);
  assert.equal(new Set(h264.map((codec) => codec.preferredPayloadType)).size, 3);
  for (const codec of h264) {
    assert.equal(codec.parameters?.['packetization-mode'], 1);
    assert.equal(codec.parameters?.['level-asymmetry-allowed'], 1);
    assert.equal(codecs.filter((repair) => repair.mimeType.toLowerCase() === 'video/rtx'
      && repair.parameters?.['apt'] === codec.preferredPayloadType).length, 1);
  }
  assert.deepEqual(codecs.filter((codec) => !/\/(h264|rtx)$/i.test(codec.mimeType))
    .map((codec) => codec.mimeType.toLowerCase()), ['audio/opus', 'video/av1', 'video/vp9', 'video/vp8']);
  const av1 = codecs.filter((codec) => codec.mimeType.toLowerCase() === 'video/av1');
  assert.equal(av1.length, 1, 'Extending forwarding limits does not register a duplicate AV1 codec.');
  assert.deepEqual(av1[0].parameters, { profile: 0, tier: 0, 'level-idx': 23 });
  assert.equal(codecs.filter((repair) => repair.mimeType.toLowerCase() === 'video/rtx'
    && repair.parameters?.['apt'] === av1[0].preferredPayloadType).length, 1);
});

function fixture(restricted = true) {
  let mode: 'sfu' | 'p2p' = 'sfu';
  let viewAllowed = true, speakAllowed = true, exists = true, closes = 0;
  let localModeChanges = 0;
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
  // Each connection knows the rooms it was told about: departures reach only those (#384).
  const session = (id: string, rooms: string[]): Session => {
    const ws = Object.create(WebSocket.prototype) as WebSocket;
    Object.defineProperty(ws, 'readyState', { value: WebSocket.OPEN });
    return {
      ws, sessionId: id, lastSeenAt: 0, ip: '127.0.0.1', messageQueue: Promise.resolve(), visibleChannelIds: new Set(rooms),
      user: { id, sessionId: id, clientId: id, nickname: id, status: 'ONLINE', joinedAt: 1 },
    };
  };
  const admin = session('admin', ['room', 'other-room']), alice = session('alice', ['room']), bob = session('bob', ['other-room']);
  const sessions = [admin, alice, bob];
  server['sessions'] = new Map(sessions.map((entry) => [entry.ws, entry]));
  server['sessionSockets'] = new Map(sessions.map((entry) => [entry.sessionId!, entry.ws]));
  server['settingsUpdateQueue'] = Promise.resolve();
  server['localAccessVersion'] = 0;
  server['pendingLocalAccessMutations'] = 0;
  server['botLocalExecution'] = Object.create(BotLocalExecutionService.prototype) as typeof server['botLocalExecution'];
  server['botLocalExecution'].voiceModeChanged = () => { localModeChanges++; };
  server['signalingService'] = signaling;
  const record = (): ServerRecord => ({
    ...SERVER_SETTING_DEFAULTS, id: 'server', name: 'Test', createdAt: 1, passwordHash: '', maxUsers: 10, voiceMode: mode,
  });
  server['serverRepo'] = { getServer: async () => record(), createServer: async () => {}, updateServer: async () => {} };
  server['channelService'] = {
    canUserAccessChannel: async (_userId: string, _channelId: string, permission = Permission.VIEW_CHANNEL) =>
      exists && viewAllowed && (permission !== Permission.SPEAK || speakAllowed),
    getAfkChannelId: async () => null,
  } as typeof server['channelService'];
  const auth = Object.create(AuthService.prototype) as AuthService;
  auth.updateServerSettings = async (payload) => {
    mode = payload.voiceMode ?? mode;
    return { success: true, settings: serverSettingsPayload(record(), { usedBytes: 0, maxTotalBytes: 1, maxFileBytes: 1 }) };
  };
  server['authService'] = auth;
  const sfu = new SfuManager();
  sfu.close = () => { closes++; };
  sfu.init = async () => true;
  sfu.checkPortAvailability = async () => null;
  server['sfuManager'] = sfu;
  server['applyTurnState'] = async () => {};
  // What each connection was told is fixed here: the rooms listed for it do not follow its presence.
  server['syncVoicePresenceVisibility'] = async () => {};
  const broadcasts: ProtocolMessage[] = [];
  const sent: Array<{ session: Session | undefined; message: ProtocolMessage }> = [];
  /** Everything sent, broadcast or not, in the order it went out. */
  const timeline: ProtocolMessage[] = [];
  server['broadcast'] = (message) => { broadcasts.push(message); timeline.push(message); };
  server['broadcastToChannel'] = async (_id, message) => { broadcasts.push(message); timeline.push(message); };
  server['send'] = (ws, message) => {
    sent.push({ session: sessions.find((entry) => entry.ws === ws), message });
    timeline.push(message);
  };
  server['requirePermission'] = async (entry, permission, id) => {
    if (permission !== Permission.SPEAK || speakAllowed) return true;
    server['sendError'](entry.ws, ProtocolErrorCode.PERMISSION_DENIED, 'Denied', id);
    return false;
  };
  server['requireChannelAccess'] = async (entry, _channelId, id) => {
    if (exists && viewAllowed) return true;
    server['sendError'](entry.ws, ProtocolErrorCode.CHANNEL_NOT_FOUND, 'Gone', id);
    return false;
  };
  /** The departures one connection was told about, as [session, room, reconnect transition]. */
  const departures = (to: Session) => sent.filter((entry) => entry.session === to && entry.message.type === MessageType.VOICE_USER_LEFT)
    .map(({ message }) => message.payload as VoiceUserLeftPayload)
    .map((left) => [left.sessionId, left.channelId, left.reconnect?.id]);
  return {
    server, signaling, admin, alice, bob, broadcasts, sent, timeline, departures,
    closes: () => closes, localModeChanges: () => localModeChanges, setMode: (next: 'p2p' | 'sfu') => { mode = next; },
    revoke: () => { viewAllowed = false; }, revokeSpeak: () => { speakAllowed = false; }, removeChannel: () => { exists = false; },
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
  assert.equal(f.localModeChanges(), 1);
  assert.equal(Object.keys(f.signaling.getAllVoiceStates()).length, 0);
  assert.deepEqual(f.departures(f.admin), [['alice', 'room', id], ['bob', 'other-room', id]],
    'whoever sees both rooms hears both departures');
  assert.deepEqual(f.departures(f.alice), [['alice', 'room', id]], 'each person hears their own, never a room they cannot see');
  assert.deepEqual(f.departures(f.bob), [['bob', 'other-room', id]]);
  const lastDeparture = f.timeline.map((message) => message.type).lastIndexOf(MessageType.VOICE_USER_LEFT);
  assert.ok(lastDeparture < f.timeline.findIndex((message) => message.type === MessageType.SERVER_SETTINGS_UPDATED),
    'the departures go out before the new mode');
  assert.equal(f.broadcasts.at(-1)?.type, MessageType.SERVER_SETTINGS_UPDATED);
  for (const [session, channelId] of [[f.alice, 'room'], [f.bob, 'other-room']] as const) {
    await f.server['voiceSessions']['handleVoiceReconnect'](session, { channelId, transitionId: id }, `rejoin-${session.sessionId}`);
    const joined = f.sent.at(-1)?.message;
    assert.equal(joined?.type, MessageType.VOICE_RECONNECTED);
    assert.equal(f.signaling.getVoiceState(session.sessionId!)?.channelId, channelId);
    assert.equal(f.signaling.getVoiceState(session.sessionId!)?.serverMuted, true);
    assert.equal(f.signaling.getVoiceState(session.sessionId!)?.serverDeafened, true);
  }
  await f.server['handleServerUpdateSettings'](f.admin, { voiceMode: 'p2p', name: 'Rename' });
  assert.equal(f.closes(), 1, 'unchanged full-form save never evicts the reconnected users');
  assert.equal(f.localModeChanges(), 1, 'unchanged saves must not terminate delegated streams');
  assert.equal(Object.keys(f.signaling.getAllVoiceStates()).length, 2);
  await f.server['voiceSessions']['handleVoiceReconnect'](f.alice, { channelId: 'room', transitionId: id }, 'repeat');
  assert.equal(f.sent.at(-1)?.message.type, MessageType.SERVER_ERROR);
  assert.equal(f.signaling.getVoiceState('alice')?.channelId, 'room');
});

test('P2P reconnect keeps visible members admitted and permission-mutes missing speakers', async () => {
  const f = fixture(false);
  const id = await switchMode(f);
  f.revokeSpeak();
  await f.server['voiceSessions']['handleVoiceReconnect'](f.alice, { channelId: 'room', transitionId: id }, 'speak-muted');
  const joined = f.sent.at(-1)?.message;
  assert.equal(joined?.type, MessageType.VOICE_RECONNECTED);
  const payload = joined?.payload as VoiceUserJoinedPayload;
  assert.equal(payload.voiceState.permissionMuted, true);
  assert.equal(f.signaling.getVoiceState('alice')?.permissionMuted, true);
});

test('concurrent settings saves observe the committed mode and tear down only once', async () => {
  const f = fixture();
  await f.signaling.joinVoiceChannel('alice', 'alice', 'room');
  await Promise.all([
    f.server['handleServerUpdateSettings'](f.admin, { voiceMode: 'p2p' }),
    f.server['handleServerUpdateSettings'](f.bob, { voiceMode: 'p2p' }),
  ]);
  assert.equal(f.closes(), 1);
  assert.equal(f.departures(f.admin).length, 1);
  assert.equal(f.departures(f.alice).length, 1);
});

test('P2P to SFU keeps membership and does not request a leave/rejoin', async () => {
  const f = fixture();
  f.setMode('p2p');
  await f.signaling.joinVoiceChannel('alice', 'alice', 'room');
  await f.server['handleServerUpdateSettings'](f.admin, { voiceMode: 'sfu' });
  assert.equal(f.signaling.getVoiceState('alice')?.channelId, 'room');
  assert.equal(f.closes(), 0);
  assert.equal(f.server['voiceSessions']['voiceReconnectGrants'].size, 0);
  assert.equal(f.timeline.filter((message) => message.type === MessageType.VOICE_USER_LEFT).length, 0);
});

test('grants reject wrong channel, stale token, another physical connection, manual leave and kick', async () => {
  const f = fixture();
  const id = await switchMode(f);
  for (const [session, channelId, token] of [
    [f.alice, 'other-room', id], [f.alice, 'room', 'stale'], [{ ...f.alice }, 'room', id],
  ] as const) {
    await f.server['voiceSessions']['handleVoiceReconnect'](session, { channelId, transitionId: token }, 'bad');
    assert.equal(f.sent.at(-1)?.message.type, MessageType.SERVER_ERROR);
    assert.equal(f.signaling.getVoiceState('alice'), undefined);
  }
  await f.server['handleMessage'](f.alice, { type: MessageType.VOICE_LEAVE, payload: { channelId: 'room' } });
  await f.server['voiceSessions']['handleVoiceReconnect'](f.alice, { channelId: 'room', transitionId: id }, 'after-leave');
  assert.equal(f.signaling.getVoiceState('alice'), undefined);
  await f.server['handleMessage'](f.admin, { type: MessageType.ADMIN_KICK_VOICE, payload: { targetSessionId: 'bob' } });
  const kicks = f.sent.filter((entry) => entry.message.type === MessageType.ADMIN_KICK_VOICE).map((entry) => entry.session);
  assert.deepEqual(kicks, [f.bob, f.admin], 'the kick reaches who was waiting to reconnect and who asked, nobody else');
  await f.server['voiceSessions']['handleVoiceReconnect'](f.bob, { channelId: 'other-room', transitionId: id }, 'after-kick');
  assert.equal(f.signaling.getVoiceState('bob'), undefined);
});

test('removed channels and revoked permission fail admission, and a later mode change invalidates grants', async () => {
  for (const mutate of ['permission', 'channel', 'mode'] as const) {
    const f = fixture();
    const id = await switchMode(f);
    if (mutate === 'permission') f.revoke();
    if (mutate === 'channel') f.removeChannel();
    if (mutate === 'mode') await f.server['handleServerUpdateSettings'](f.admin, { voiceMode: 'sfu' });
    await f.server['voiceSessions']['handleVoiceReconnect'](f.alice, { channelId: 'room', transitionId: id }, 'denied');
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
  const rejoining = f.server['voiceSessions']['handleVoiceReconnect'](f.alice, { channelId: 'room', transitionId: id }, 'racing');
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
  await f.server['voiceSessions']['handleVoiceJoin'](f.alice, { channelId: 'room', isMuted: false, isDeafened: false }, 'own-admission');
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
  await f.server['voiceSessions']['handleVoiceJoin'](f.alice, { channelId: 'room' }, 'revoked-admission');
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
    await f.server['voiceSessions']['handleVoiceReconnect'](session, { channelId, transitionId: id }, `moderated-${session.sessionId}`);
    const acknowledgement = f.sent.at(-1)?.message;
    assert.equal(acknowledgement?.type, MessageType.VOICE_RECONNECTED);
    const joined = acknowledgement?.payload as VoiceUserJoinedPayload;
    assert.equal(joined.voiceState.serverMuted, restricted);
    assert.equal(joined.voiceState.serverDeafened, restricted);
  }
});
