import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aggregateTransportHealth, VoiceConnectionHealth, VoiceRosterParticipant, SfuConsumedPayload, MessageType } from '@monky/shared';
import { ParticipantManager } from '../src/renderer/core/ParticipantManager';
import { NetworkClient } from '../src/renderer/core/NetworkClient';
import { SfuClientEngine } from '../src/renderer/core/webrtc/SfuClientEngine';
import { RemoteMediaRouter } from '../src/renderer/core/webrtc/RemoteMediaRouter';
import { settingsStore } from '../src/renderer/stores/settingsStore';
import { VoiceStore, voiceStore } from '../src/renderer/stores/voiceStore';
import { appEvents } from '../src/renderer/core/EventBus';
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
  assert.deepEqual(voiceConnectionIndicator(null, false, true), { quality: 'connecting', icon: 'sync' });
  for (const ping of [null, -1, NaN, 0, 49, 50, 119, 120, 200]) {
    assert.equal(voiceConnectionIndicator(ping).icon, 'rss_feed');
  }
});

test('initial voice connection is distinct from recovery and never starts the reconnection cue', () => {
  const store = new VoiceStore();
  const cues: boolean[] = [];
  let updates = 0;
  const offCue = appEvents.on('voice.reconnecting_changed', (value: boolean) => cues.push(value));
  const offUpdate = appEvents.on('voice.connection_changed', () => updates++);
  try {
    store.setChannel('room');
    store.setConnectionHealth('connecting');
    assert.equal(store.isConnecting, true);
    assert.equal(store.isReconnecting, false);
    assert.equal(updates, 1);
    assert.deepEqual(cues, []);
    store.setConnectionHealth('connected');
    assert.equal(store.isConnecting, false);
    assert.deepEqual(cues, []);
    store.setConnectionHealth('reconnecting');
    store.setConnectionHealth('connecting');
    assert.equal(store.isReconnecting, true, 'rebuilding transports keeps the recovery state');
    assert.equal(store.isConnecting, false);
    assert.deepEqual(cues, [true]);
    store.setConnectionHealth('connected');
    assert.deepEqual(cues, [true, false]);
    store.setConnectionHealth('failed');
    assert.equal(store.isReconnecting, true);
    store.reset();
    assert.equal(store.isReconnecting, false);
    assert.equal(store.isConnecting, false);
    assert.deepEqual(cues, [true, false, true, false]);
    store.setConnectionHealth('connecting');
    assert.equal(store.isConnecting, false, 'late callbacks cannot resurrect a left call');
    store.setChannel('next-room');
    store.setConnectionHealth('connecting');
    assert.equal(store.isConnecting, true);
    store.setConnectionHealth('failed');
    store.setChannel('another-room');
    store.setConnectionHealth('connecting');
    assert.equal(store.isReconnecting, false, 'switching rooms does not inherit recovery from the old call');
    assert.equal(store.isConnecting, true);
    store.setChannel(null);
    assert.equal(store.isConnecting, false);
  } finally {
    offCue();
    offUpdate();
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
  const track = { id: 'capture', kind: 'audio', readyState: 'live', stop: () => { stops++; } } as MediaStreamTrack;
  const cameraTrack = { ...track, id: 'camera-capture', kind: 'video' };
  Object.defineProperty(engine, 'sendTransport', { writable: true, value: {
    close() {},
    async produce(options: { stopTracks?: boolean; track?: MediaStreamTrack }) {
      return { id: 'producer', track: options.track, closed: false, on() {}, close() {
        if (this.closed) return;
        this.closed = true;
        closes++;
        if (options.stopTracks !== false) options.track?.stop();
      } };
    },
  } });
  assert.ok(await engine.produceMic(track));
  assert.ok(await engine.produceCamera(cameraTrack));
  assert.ok(await engine.produceScreenVideo(cameraTrack, 'share'));
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
  isConnected = true;
  srcObject: unknown = null;
  attributes = new Set<string>();
  setAttribute(name: string) { this.attributes.add(name); }
  hasAttribute(name: string) { return this.attributes.has(name); }
  async play() {}
  pause() {}
  remove() { this.isConnected = false; }
}
class Stream {
  constructor(private tracks: MediaStreamTrack[]) {}
  getAudioTracks() { return this.tracks; }
  getTracks() { return this.tracks; }
}

test('remote WebRTC output changes keep default voice separate from screen speakers at every volume', async (t) => {
  const contexts: Context[] = [];
  let nativeSinkChanges = 0;
  class RemoteAudioElement extends AudioElement {
    sinkId = '';
    async setSinkId(id: string) {
      this.sinkId = id;
      nativeSinkChanges++;
    }
  }
  class Context {
    state = 'running';
    sinkId: string | { type: string };
    destination = {};
    gains: Array<{ gain: { value: number }; connect: () => void; disconnect: () => void }> = [];
    streams: MediaStream[] = [];
    constructor(options: { sinkId: string | { type: string } }) {
      this.sinkId = options.sinkId;
      contexts.push(this);
    }
    createMediaStreamSource(stream: MediaStream) {
      this.streams.push(stream);
      return { connect() {}, disconnect() {} };
    }
    createGain() {
      const gain = { gain: { value: 1 }, connect() {}, disconnect() {} };
      this.gains.push(gain);
      return gain;
    }
    async close() { this.state = 'closed'; }
    async setSinkId(id: string) { this.sinkId = id; }
  }
  for (const [key, value] of Object.entries({
    document: { createElement: () => new RemoteAudioElement(), body: { appendChild() {} } },
    MediaStream: Stream, AudioContext: Context,
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : Reflect.deleteProperty(globalThis, key));
  }
  const previousSettings = {
    selectedSpeakerId: settingsStore.selectedSpeakerId,
    advancedAudioOutputs: settingsStore.advancedAudioOutputs,
    audioOutputDevices: settingsStore.audioOutputDevices,
    userVolumes: settingsStore.userVolumes,
    screenAudioVolumes: settingsStore.screenAudioVolumes,
  };
  const previousDeafened = voiceStore.isDeafened;
  const manager = new ParticipantManager();
  const router = new RemoteMediaRouter(() => manager);
  t.after(() => {
    router.closeAllMedia();
    Object.assign(settingsStore, previousSettings);
    voiceStore.isDeafened = previousDeafened;
  });
  settingsStore.selectedSpeakerId = '';
  settingsStore.advancedAudioOutputs = false;
  settingsStore.userVolumes = {};
  settingsStore.screenAudioVolumes = {};
  voiceStore.isDeafened = false;
  const microphone = { id: 'microphone', kind: 'audio', stop() {} } as MediaStreamTrack;
  const otherMicrophone = { id: 'other-microphone', kind: 'audio', stop() {} } as MediaStreamTrack;
  const screen = { id: 'screen-sound', kind: 'audio', stop() {} } as MediaStreamTrack;
  const voice = router.ensureVoiceAudioElement('peer', new MediaStream([microphone]));
  const otherVoice = router.ensureVoiceAudioElement('other-peer', new MediaStream([otherMicrophone]));
  router.routeScreenAudioTrack('peer', screen);
  router.setScreenAudioMuted('peer', false);
  await router.setOutputDeviceIds('', 'screen-speakers');

  assert.equal(nativeSinkChanges, 0, 'screen selection never switches the shared native renderer to screen speakers');
  assert.equal(contexts.length, 2, 'all volumes use independent voice/screen AudioContexts');
  assert.deepEqual(contexts.map(context => context.sinkId), ['', 'screen-speakers']);
  assert.deepEqual(contexts[0].streams.map(stream => stream.getAudioTracks()[0].id), ['microphone', 'other-microphone']);
  assert.deepEqual(contexts[1].streams.map(stream => stream.getAudioTracks()[0].id), ['screen-sound']);
  for (const volume of [0, 50, 100, 150, 200]) {
    router.setPeerVolume('peer', volume);
    router.setScreenAudioVolume('peer', volume);
    assert.equal(contexts[0].gains[0].gain.value, volume / 100);
    assert.equal(contexts[1].gains[0].gain.value, volume / 100);
    assert.equal(voice.volume, 0, 'the microphone decoder element never becomes an audible second path');
    assert.equal(otherVoice.volume, 0);
    assert.equal(router.getScreenAudioElement('peer')?.volume, 0);
  }
  await router.setOutputDeviceIds('', 'other-screen-speakers');
  assert.deepEqual(contexts.map(context => context.sinkId), ['', 'other-screen-speakers']);
  await router.setOutputDeviceIds('voice-headset', 'other-screen-speakers');
  assert.deepEqual(contexts.map(context => context.sinkId), ['voice-headset', 'other-screen-speakers']);
  assert.deepEqual([voice.sinkId, otherVoice.sinkId, router.getScreenAudioElement('peer')?.sinkId],
    ['voice-headset', 'voice-headset', 'voice-headset'],
    'the shared native renderer aligns echo cancellation with voice, never the screen device');
  let releaseFirst!: () => void;
  let startedFirst!: () => void;
  const started = new Promise<void>(resolve => { startedFirst = resolve; });
  const delayed = new Promise<void>(resolve => { releaseFirst = resolve; });
  const nativeVoiceSink = voice.setSinkId.bind(voice);
  voice.setSinkId = async id => {
    if (id === 'first-headset') {
      startedFirst();
      await delayed;
    }
    await nativeVoiceSink(id);
  };
  const firstChange = router.setOutputDeviceIds('first-headset', 'first-screen');
  await started;
  const latestChange = router.setOutputDeviceIds('latest-headset', 'latest-screen');
  releaseFirst();
  await Promise.all([firstChange, latestChange]);
  assert.deepEqual(contexts.map(context => context.sinkId), ['latest-headset', 'latest-screen']);
  assert.deepEqual([voice.sinkId, otherVoice.sinkId, router.getScreenAudioElement('peer')?.sinkId],
    ['latest-headset', 'latest-headset', 'latest-headset'],
    'delayed native switches across different elements all finish on the latest voice device');
  router.cleanupScreenAudio('peer');
  assert.equal(router.getAudioElement('peer'), voice, 'ending a share preserves both voice players');
  assert.equal(router.getAudioElement('other-peer'), otherVoice);
  await router.setOutputDeviceIds('', '');
  assert.deepEqual(contexts.map(context => context.sinkId), ['', '']);
  const contextCount = contexts.length;
  const closingRouter = new RemoteMediaRouter(() => manager);
  closingRouter.ensureVoiceAudioElement('closing', new MediaStream([microphone]));
  closingRouter.closeAllMedia();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closingRouter['audioContexts'].size, 0, 'pending decoder routing cannot recreate contexts after leaving');
  assert.equal(contexts.slice(contextCount).every(context => context.state === 'closed'), true);
});

test('screen audio opt-in and 0–200% volume stay independent of voice deafen in the shared P2P/SFU router', (t) => {
  const gains: Array<{ gain: { value: number }; connect: () => void; disconnect: () => void }> = [];
  class Context {
    state = 'running';
    sinkId = '';
    destination = {};
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createMediaStreamDestination() { return {}; }
    createGain() {
      const gain = { gain: { value: 1 }, connect() {}, disconnect() {} };
      gains.push(gain);
      return gain;
    }
    async close() { this.state = 'closed'; }
    async setSinkId(sinkId: string) { this.sinkId = sinkId; }
  }
  for (const [key, value] of Object.entries({
    document: { createElement: () => new AudioElement(), body: { appendChild() {} } },
    MediaStream: Stream, AudioContext: Context, window: { AudioContext: Context },
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
  assert.equal(gains[0].gain.value, 0.75);
  assert.equal(router.getScreenAudioElement('peer')?.volume, 0);
  assert.equal(router.getScreenAudioElement('peer')?.muted, false);
  router.setScreenAudioMuted('peer', true);
  voiceStore.isDeafened = false;
  router.setDeafened(false);
  assert.equal(voice.muted, false);
  assert.equal(router.getScreenAudioElement('peer')?.muted, true, 'undeafen preserves screen mute');
});
