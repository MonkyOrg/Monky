import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import type { types as MediasoupTypes } from 'mediasoup';
import { MessageType, VoiceConnectionHealth, VoiceUserJoinedPayload, SfuProducersListPayload } from '@monky/shared';
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
  assert.equal(service.setServerMuted('one', true)?.length, 2);
  assert.equal(service.setServerDeafened('two', true)?.length, 2);
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

  service.setServerMuted('after-mode-switch', false);
  assert.equal(service.getVoiceState('after-mode-switch')?.serverDeafened, true, 'unmute does not clear deafen');
  service.setServerDeafened('after-mode-switch', false);
  service.leaveVoiceChannel('after-mode-switch');
  const cleared = await service.joinVoiceChannel('cleared', 'alice', 'room');
  assert.equal(cleared.voiceState?.serverMuted, false);
  assert.equal(cleared.voiceState?.serverDeafened, false, 'explicit administrative removal persists too');
});

test('moderation applied while admission awaits a channel cannot be bypassed by that join', async (t) => {
  const service = signaling();
  await service.joinVoiceChannel('one', 'alice', 'room');
  const channel = await service['channelRepo'].findById('room');
  let release = () => {};
  const pending = new Promise<void>((resolve) => { release = resolve; });
  t.mock.method(service['channelRepo'], 'findById', async () => { await pending; return channel; });
  const joining = service.joinVoiceChannel('two', 'alice', 'room', false, false);
  service.setServerMuted('one', true);
  service.setServerDeafened('one', true);
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
  assert.throws(() => service.setServerMuted('one', true), (error) => error === failure);
  assert.equal(service.getVoiceState('one')?.serverMuted, false);
  assert.equal(service.setServerMuted('missing', true), null);
});

test('administrative mute and deafen broadcasts cover all connections of the target user', async () => {
  const service = signaling();
  await service.joinVoiceChannel('one', 'alice', 'room');
  await service.joinVoiceChannel('two', 'alice', 'room');
  const server = Object.create(WebSocketServer.prototype) as WebSocketServer;
  server['signalingService'] = service;
  const messages: Parameters<WebSocketServer['broadcast']>[0][] = [];
  server['broadcast'] = (message) => { messages.push(message); };
  const session: Parameters<WebSocketServer['handleAdminMuteUser']>[0] = {
    ws: Object.create(WebSocket.prototype) as WebSocket, isAlive: true, ip: '127.0.0.1', messageQueue: Promise.resolve(),
  };
  await server['handleAdminMuteUser'](session, { targetSessionId: 'one', muted: true }, 'mute-request');
  assert.deepEqual(messages.filter((message) => message.type === MessageType.ADMIN_MUTE_USER).map((message) => message.payload), [
    { targetSessionId: 'one', muted: true }, { targetSessionId: 'two', muted: true },
  ]);
  assert.equal(messages.filter((message) => message.type === MessageType.VOICE_STATE_CHANGED).length, 2);
  messages.length = 0;
  await server['handleAdminDeafenUser'](session, { targetSessionId: 'two', deafened: true }, 'deafen-request');
  assert.deepEqual(messages.filter((message) => message.type === MessageType.ADMIN_DEAFEN_USER).map((message) => message.payload), [
    { targetSessionId: 'one', deafened: true }, { targetSessionId: 'two', deafened: true },
  ]);
  assert.equal(messages.filter((message) => message.type === MessageType.VOICE_STATE_CHANGED).length, 2);
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
    service.setServerMuted('one', true);
    service.setServerDeafened('one', true);
    service.leaveVoiceChannel('one');
    database.close();
    database = undefined;
    database = await DatabaseConnection.create(filename);
    const restrictions = new SqliteVoiceRestrictionRepository(database.getDb());
    const restored = signaling(restrictions);
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
