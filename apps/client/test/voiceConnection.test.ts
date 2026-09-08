import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aggregateTransportHealth, VoiceConnectionHealth, VoiceRosterParticipant, SfuConsumedPayload, MessageType } from '@monky/shared';
import { ParticipantManager } from '../src/renderer/core/ParticipantManager';
import { NetworkClient } from '../src/renderer/core/NetworkClient';
import { SfuClientEngine } from '../src/renderer/core/webrtc/SfuClientEngine';
import { RemoteMediaRouter } from '../src/renderer/core/webrtc/RemoteMediaRouter';
import { settingsStore } from '../src/renderer/stores/settingsStore';
import { voiceStore } from '../src/renderer/stores/voiceStore';
import { participantConnectionIndicators, voiceConnectionIndicator } from '../src/renderer/utils/voiceConnection';

function participant(sessionId: string, channelId = 'room'): VoiceRosterParticipant {
  return {
    user: { id: sessionId, sessionId, clientId: sessionId, nickname: sessionId, status: 'ONLINE', joinedAt: 1 },
    voiceState: {
      sessionId, userId: sessionId, channelId, isMuted: false, isDeafened: false,
      serverMuted: false, serverDeafened: false, isSpeaking: false, isCameraOn: false,
      isScreenSharing: false, isSharingScreenAudio: false, connectionHealth: 'connected',
    },
  };
}

test('authoritative join/rejoin roster repairs missing users and ghosts without removing live peers or another channel', () => {
  const manager = new ParticipantManager();
  manager.reconcileVoiceChannel('room', [participant('self'), participant('ghost'), participant('live')]);
  manager.reconcileVoiceChannel('other', [participant('elsewhere', 'other')]);
  const live = manager.get('live');
  manager.reconcileVoiceChannel('room', [participant('self'), participant('live'), participant('missing')]);
  assert.deepEqual(manager.getInVoiceChannel('room').map((p) => p.user.id).sort(), ['live', 'missing', 'self']);
  assert.equal(manager.get('live'), live, 'keep existing media-bearing view models');
  assert.equal(manager.get('ghost')?.voiceState, undefined);
  assert.equal(manager.getInVoiceChannel('other').length, 1);
});

test('SFU health badges are visible to local users, remote users and observers, independently of signaling', () => {
  const manager = new ParticipantManager();
  for (const health of ['connecting', 'connected', 'reconnecting', 'failed'] satisfies VoiceConnectionHealth[]) {
    const entry = participant('peer');
    entry.voiceState.connectionHealth = health;
    manager.reconcileVoiceChannel('room', [entry]);
    const model = manager.get('peer')!;
    model.isReconnecting = false;
    for (const local of [false, true]) {
      const indicator = participantConnectionIndicators(model, true, local);
      assert.equal(indicator.isConnecting, health === 'connecting' || health === 'reconnecting');
      assert.equal(indicator.isPeerFailed, health === 'failed');
    }
  }
});

test('logical offline presence and subsequent SFU reconciliation preserve the physical voice session and streams', () => {
  const manager = new ParticipantManager();
  const entry = participant('peer');
  manager.reconcileVoiceChannel('room', [entry]);
  const original = manager.get('peer')!;
  const stream = { id: 'live-stream' } as MediaStream;
  manager.setRemoteStream('peer', stream);
  manager.setRemoteScreenStream('peer', 'share', stream);
  manager.updateUser({ ...entry.user, status: 'DISCONNECTED', sessionId: undefined, invisible: undefined });
  assert.equal(manager.getInVoiceChannel('room')[0], original);
  assert.equal(original.user.sessionId, 'peer');
  assert.equal(original.user.status, 'DISCONNECTED');
  manager.reconcileVoiceChannel('room', [{
    ...entry, user: { ...entry.user, status: 'DISCONNECTED', invisible: undefined },
  }]);
  assert.equal(manager.get('peer'), original);
  assert.equal(original.remoteStream, stream);
  assert.equal(original.remoteScreenStreams.get('share'), stream);
  assert.equal(original.voiceState?.connectionHealth, 'connected');
});

test('RSS glyph is preserved while quality thresholds agree with the call stage, including unavailable RTT', () => {
  assert.equal(voiceConnectionIndicator(0).quality, 'good');
  assert.equal(voiceConnectionIndicator(49).quality, 'good');
  assert.equal(voiceConnectionIndicator(50).quality, 'medium');
  assert.equal(voiceConnectionIndicator(119).quality, 'medium');
  assert.equal(voiceConnectionIndicator(120).quality, 'bad');
  for (const ping of [null, -1, NaN]) assert.equal(voiceConnectionIndicator(ping).quality, 'unknown');
  assert.deepEqual(voiceConnectionIndicator(20, true), { quality: 'reconnecting', icon: 'signal_wifi_bad' });
  for (const ping of [null, -1, NaN, 0, 49, 50, 119, 120, 200]) {
    assert.equal(voiceConnectionIndicator(ping).icon, 'rss_feed');
  }
});

function engineFixture() {
  const client = new NetworkClient();
  const health: VoiceConnectionHealth[] = [];
  let failures = 0;
  let connected = 0;
  const engine = new SfuClientEngine(() => client, () => 'self', {
    onConsumerTrack: () => {}, onConsumerClosed: () => {}, onRoster: () => {},
    onHealthChanged: (state) => health.push(state),
    onConnectionFailed: () => { failures++; },
    onConnected: () => { connected++; },
  });
  return { engine, client, health, failures: () => failures, connected: () => connected };
}

test('aggregate health never hides a failed/disconnected direction behind a healthy one', () => {
  assert.equal(aggregateTransportHealth(['new', 'new']), 'connecting');
  assert.equal(aggregateTransportHealth(['new', 'connected']), 'connected');
  assert.equal(aggregateTransportHealth(['connected', 'connecting']), 'connecting');
  assert.equal(aggregateTransportHealth(['connected', 'disconnected']), 'reconnecting');
  assert.equal(aggregateTransportHealth(['failed', 'connected']), 'failed');
  assert.equal(aggregateTransportHealth(['closed', 'connected']), 'failed');
});

test('SFU disconnected state is immediate, recovers during grace, and retries persistent loss; leave clears timers', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { engine, client, health, failures, connected } = engineFixture();
  t.after(() => { engine.leave(); client.dispose(); });
  engine['sendTransportState'] = 'connected';
  engine['recvTransportState'] = 'disconnected';
  engine['notifyIfHealthy']();
  assert.equal(health.at(-1), 'reconnecting');
  assert.equal(engine.isChannelConnected(), false);
  assert.equal(connected(), 0);
  t.mock.timers.tick(2000);
  engine['recvTransportState'] = 'connected';
  engine['notifyIfHealthy']();
  t.mock.timers.tick(2000);
  assert.equal(failures(), 0);
  assert.equal(connected(), 1);
  assert.equal(engine.isChannelConnected(), true);
  engine['sendTransportState'] = 'disconnected';
  engine['notifyIfHealthy']();
  t.mock.timers.tick(3000);
  assert.equal(failures(), 1);
  engine['notifyIfHealthy']();
  engine.leave();
  t.mock.timers.tick(20000);
  assert.equal(failures(), 1);
});

test('SFU ping samples receive-only clients and uses the worse active direction', async (t) => {
  const { engine, client } = engineFixture();
  t.after(() => { engine.leave(); client.dispose(); });
  const transport = (state: string, rtt: number) => ({
    connectionState: state, close: () => {},
    getStats: async () => new Map([['pair', { type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: rtt }]]),
  });
  Object.defineProperties(engine, {
    sendTransport: { value: transport('new', 0), writable: true },
    recvTransport: { value: transport('connected', 0.075), writable: true },
  });
  assert.equal(await engine.getPing(), 75);
  Object.defineProperty(engine, 'sendTransport', { value: transport('connected', 0.15), writable: true });
  assert.equal(await engine.getPing(), 150);
});

test('rebuilding SFU producers does not stop caller-owned capture tracks', async (t) => {
  const { engine, client } = engineFixture();
  t.after(() => { engine.leave(); client.dispose(); });
  t.mock.method(engine, 'canProduceKind', () => true);
  let stops = 0;
  let closes = 0;
  const track = { id: 'capture', kind: 'audio', stop: () => { stops++; } } as MediaStreamTrack;
  Object.defineProperty(engine, 'sendTransport', { writable: true, value: {
    close() {},
    async produce(options: { stopTracks?: boolean; track?: MediaStreamTrack }) {
      return { id: 'producer', on() {}, close() {
        closes++;
        if (options.stopTracks !== false) options.track?.stop();
      } };
    },
  } });
  assert.ok(await engine.produceMic(track));
  assert.ok(await engine.produceCamera(track));
  assert.ok(await engine.produceScreenVideo(track, 'share'));
  assert.ok(await engine.produceScreenAudio(track, 'share'));
  engine.leave();
  assert.equal(closes, 4);
  assert.equal(stops, 0, 'capture ownership remains with AudioProcessor/VideoService across reconnect');
});

test('duplicate producer announcements and a leave during consume cannot resurrect stale media', async (t) => {
  const { engine, client } = engineFixture();
  t.after(() => { engine.leave(); client.dispose(); });
  let resolveRequest: (payload: SfuConsumedPayload) => void = () => { throw new Error('No pending request'); };
  let requests = 0;
  let consumes = 0;
  Object.defineProperty(client, 'sendRequest', { value: () => {
    requests++;
    return new Promise<SfuConsumedPayload>((resolve) => { resolveRequest = resolve; });
  } });
  Object.defineProperties(engine, {
    recvTransport: { writable: true, value: { id: 'recv', close() {}, async consume() { consumes++; } } },
    device: { writable: true, value: { rtpCapabilities: {} } },
    channelId: { writable: true, value: 'room' },
  });
  const announcement = {
    channelId: 'room', producerId: 'producer', producerSessionId: 'peer',
    kind: 'audio' as const, appData: { mediaType: 'mic' },
  };
  const pending = engine['consumeRemoteProducer'](announcement);
  await engine['consumeRemoteProducer'](announcement);
  assert.equal(requests, 1);
  engine.leave();
  resolveRequest({ channelId: 'room', id: 'consumer', producerId: 'producer', producerSessionId: 'peer', kind: 'audio', rtpParameters: {}, appData: {} });
  await pending;
  assert.equal(consumes, 0);
  assert.equal(engine['consumers'].size, 0);
  assert.equal(engine['pendingConsumers'].size, 0);
});

test('a failed consumer setup cannot be masked by the sending transport connecting later', async (t) => {
  const { engine, client, failures, connected } = engineFixture();
  t.after(() => { engine.leave(); client.dispose(); });
  Object.defineProperty(client, 'sendRequest', { value: async () => { throw new Error('Request timed out'); } });
  Object.defineProperties(engine, {
    recvTransport: { writable: true, value: { id: 'recv', close() {} } },
    device: { writable: true, value: { rtpCapabilities: {} } },
    channelId: { writable: true, value: 'room' },
  });
  await engine['consumeRemoteProducer']({
    channelId: 'room', producerId: 'producer', producerSessionId: 'peer', kind: 'audio', appData: { mediaType: 'mic' },
  });
  assert.equal(failures(), 1);
  engine['sendTransportState'] = 'connected';
  engine['notifyIfHealthy']();
  assert.equal(connected(), 0);
  assert.equal(engine.isChannelConnected(), false);
});

test('missing-producer request completion before the close broadcast never poisons a healthy SFU session', async (t) => {
  const { engine, client, failures, health } = engineFixture();
  t.after(() => { engine.leave(); client.dispose(); });
  let requestId: string | undefined;
  let consumes = 0;
  t.mock.method(client, 'send', (_type: MessageType, _payload: unknown, id?: string) => { requestId = id; });
  Object.defineProperties(engine, {
    recvTransport: { writable: true, value: { id: 'recv', close() {}, async consume() { consumes++; } } },
    device: { writable: true, value: { rtpCapabilities: {} } },
    channelId: { writable: true, value: 'room' },
  });
  engine['sendTransportState'] = 'connected';
  engine['recvTransportState'] = 'connected';
  engine['subscribeNetworkEvents']();
  const pending = engine['consumeRemoteProducer']({
    channelId: 'room', producerId: 'producer', producerSessionId: 'peer', kind: 'video', appData: { mediaType: 'camera' },
  });
  assert.ok(requestId);
  const close = { channelId: 'room', producerId: 'producer' };
  client['handleIncomingMessage']({ type: MessageType.SFU_PRODUCER_CLOSED, requestId, payload: close });
  await pending;
  assert.equal(failures(), 0);
  assert.equal(engine.isChannelConnected(), true);
  assert.equal(engine['pendingConsumers'].size, 0);
  assert.equal(consumes, 0);
  client['handleIncomingMessage']({ type: MessageType.SFU_PRODUCER_CLOSED, payload: close });
  assert.equal(failures(), 0);
  assert.equal(engine.isChannelConnected(), true);
  assert.equal(health.includes('failed'), false);
});

class AudioElement {
  muted = false;
  volume = 1;
  autoplay = false;
  srcObject: unknown = null;
  attributes = new Set<string>();
  setAttribute(name: string) { this.attributes.add(name); }
  hasAttribute(name: string) { return this.attributes.has(name); }
  async play() {}
  pause() {}
  remove() {}
}
class Stream {
  constructor(private tracks: MediaStreamTrack[]) {}
  getAudioTracks() { return this.tracks; }
  getTracks() { return this.tracks; }
}

test('screen audio opt-in and 0–200% volume stay independent of voice deafen in the shared P2P/SFU router', (t) => {
  const gains: Array<{ gain: { value: number }; connect: () => void; disconnect: () => void }> = [];
  class Context {
    state = 'running';
    destination = {};
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createMediaStreamDestination() { return {}; }
    createGain() {
      const gain = { gain: { value: 1 }, connect() {}, disconnect() {} };
      gains.push(gain);
      return gain;
    }
    async close() { this.state = 'closed'; }
  }
  for (const [key, value] of Object.entries({
    document: { createElement: () => new AudioElement(), body: { appendChild() {} } },
    MediaStream: Stream, window: { AudioContext: Context },
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : Reflect.deleteProperty(globalThis, key));
  }
  const manager = new ParticipantManager();
  const router = new RemoteMediaRouter(() => manager);
  const track = { id: 'screen-track', kind: 'audio', stop() {} } as MediaStreamTrack;
  t.after(() => { router.closeAllMedia(); settingsStore.screenAudioVolumes = {}; voiceStore.isDeafened = false; });
  settingsStore.screenAudioVolumes = { peer: 150 };
  voiceStore.isDeafened = true;
  router.setDeafened(true);
  router.routeScreenAudioTrack('peer', track);
  assert.equal(router.getScreenAudioElement('peer')?.muted, true);
  assert.equal(gains[0].gain.value, 0, 'amplification must not bypass screen opt-in');
  router.setScreenAudioMuted('peer', false);
  assert.equal(router.getScreenAudioElement('peer')?.muted, false);
  assert.equal(gains[0].gain.value, 1.5);
  const voice = router.ensureVoiceAudioElement('peer', new MediaStream([track]));
  assert.equal(voice.muted, true);
  router.setDeafened(true);
  assert.equal(gains[0].gain.value, 1.5, 'deafen does not change screen amplification');
  router.setScreenAudioMuted('peer', true);
  assert.equal(gains[0].gain.value, 0);
  router.setScreenAudioVolume('peer', 180);
  assert.equal(gains[0].gain.value, 0, 'changing volume must not bypass explicit screen mute');
  router.setScreenAudioMuted('peer', false);
  assert.equal(gains[0].gain.value, 1.5, 'unmute restores configured amplified volume');
  router.setScreenAudioVolume('peer', 75);
  assert.equal(router.getScreenAudioElement('peer')?.volume, 0.75);
  assert.equal(router.getScreenAudioElement('peer')?.muted, false);
  router.setScreenAudioMuted('peer', true);
  voiceStore.isDeafened = false;
  router.setDeafened(false);
  assert.equal(voice.muted, false);
  assert.equal(router.getScreenAudioElement('peer')?.muted, true, 'undeafen preserves screen mute');
});
