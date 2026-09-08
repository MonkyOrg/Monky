import assert from 'node:assert/strict';
import test from 'node:test';
import WebSocket from 'ws';
import type { types as MediasoupTypes } from 'mediasoup';
import { MessageType, VoiceConnectionHealth, VoiceUserJoinedPayload, SfuProducersListPayload } from '@monky/shared';
import { SignalingService } from './application/services/SignalingService';
import { ChannelRecord } from './domain/entities';
import { SfuManager, SfuProducerClosedError } from './infrastructure/sfu/SfuManager';
import { WebSocketServer } from './infrastructure/websocket/WebSocketServer';

function signaling() {
  const channel: ChannelRecord = {
    id: 'room', serverId: 'server', name: 'Voice', type: 'VOICE', position: 0,
    createdAt: 1, maxParticipants: 10, isPrivate: false, allowedRoleIds: [], botCommandsEnabled: false,
  };
  return new SignalingService({
    findById: async () => channel, listByServerId: async () => [channel],
    create: async () => {}, update: async () => {}, delete: async () => {}, updatePosition: async () => {},
  });
}

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
    assert.equal((message.payload as VoiceUserJoinedPayload).user?.id, 'self');
    await service.joinVoiceChannel('late', 'late', 'room');
    service.leaveVoiceChannel('departed');
  };
  const messages: Parameters<WebSocketServer['send']>[1][] = [];
  server['send'] = (_ws, message) => { messages.push(message); };
  await server['handleVoiceJoin'](self, { channelId: 'room' });
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
