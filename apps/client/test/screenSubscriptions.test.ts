import assert from 'node:assert/strict';
import { after, before, test, type TestContext } from 'node:test';
import type { types as SfuTypes } from 'mediasoup-client';
import { MessageType, type SfuConsumedPayload, type SfuConsumePayload, type SfuNewProducerPayload } from '@monky/shared';
import { appEvents } from '../src/renderer/core/EventBus';
import { NetworkClient } from '../src/renderer/core/NetworkClient';
import { ParticipantManager } from '../src/renderer/core/ParticipantManager';
import { sessionManager } from '../src/renderer/core/SessionManager';
import { WebRtcManager } from '../src/renderer/core/WebRtcManager';
import { SfuClientEngine } from '../src/renderer/core/webrtc/SfuClientEngine';
import { RemoteMediaRouter } from '../src/renderer/core/webrtc/RemoteMediaRouter';
import { VoiceStore, voiceStore } from '../src/renderer/stores/voiceStore';

function gate() {
  let release = () => {};
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

function track(id: string, kind: 'audio' | 'video'): MediaStreamTrack {
  return {
    id, kind, enabled: true, readyState: 'live', onended: null,
    stop() { Object.defineProperty(this, 'readyState', { value: 'ended' }); },
  } as MediaStreamTrack;
}

class Stream extends EventTarget implements MediaStream {
  public id = 'stream';
  public active = true;
  public onaddtrack: MediaStream['onaddtrack'] = null;
  public onremovetrack: MediaStream['onremovetrack'] = null;
  constructor(private tracks: MediaStreamTrack[] = []) { super(); }
  clone() { return new Stream([...this.tracks]); }
  getTracks() { return [...this.tracks]; }
  getVideoTracks() { return this.tracks.filter((entry): entry is MediaStreamVideoTrack => entry.kind === 'video'); }
  getAudioTracks() { return this.tracks.filter((entry): entry is MediaStreamAudioTrack => entry.kind === 'audio'); }
  getTrackById(id: string) { return this.tracks.find(entry => entry.id === id) ?? null; }
  addTrack(value: MediaStreamTrack) { this.tracks.push(value); }
  removeTrack(value: MediaStreamTrack) { this.tracks = this.tracks.filter(entry => entry !== value); }
}

class Sender implements RTCRtpSender {
  public dtmf = null;
  public transform = null;
  public transport = null;
  public replacements: Array<MediaStreamTrack | null> = [];
  public writes: RTCRtpSendParameters[] = [];
  public parameters: RTCRtpSendParameters;
  constructor(public track: MediaStreamTrack | null, kind: string, encodings: RTCRtpEncodingParameters[] = [{}]) {
    this.parameters = {
      transactionId: 'fixture', codecs: [{ mimeType: kind === 'video' ? 'video/VP8' : 'audio/opus',
        payloadType: kind === 'video' ? 96 : 111, clockRate: kind === 'video' ? 90000 : 48000 }],
      headerExtensions: [], rtcp: {}, encodings,
    };
  }
  getParameters() { return structuredClone(this.parameters); }
  async getStats(): Promise<RTCStatsReport> { return new Map(); }
  async setParameters(value: RTCRtpSendParameters) {
    this.writes.push(structuredClone(value));
    this.parameters = structuredClone(value);
  }
  async replaceTrack(value: MediaStreamTrack | null) { this.replacements.push(value); this.track = value; }
  setStreams() {}
}

class PeerConnection {
  public signalingState: RTCSignalingState = 'stable';
  public connectionState = 'new';
  public transceivers: RTCRtpTransceiver[] = [];
  getTransceivers() { return this.transceivers; }
  getSenders() { return this.transceivers.map(entry => entry.sender); }
  addTransceiver(value: string | MediaStreamTrack, init?: RTCRtpTransceiverInit) {
    const kind = typeof value === 'string' ? value : value.kind;
    const sender = new Sender(typeof value === 'string' ? null : value, kind, init?.sendEncodings);
    const receiver: Partial<RTCRtpReceiver> = { track: track(`remote-${this.transceivers.length}`, kind === 'audio' ? 'audio' : 'video') };
    const transceiver: RTCRtpTransceiver = {
      sender, receiver: receiver as RTCRtpReceiver,
      mid: String(this.transceivers.length), direction: init?.direction ?? 'sendrecv',
      currentDirection: init?.direction ?? 'sendrecv', stop() {}, setCodecPreferences() {},
    };
    this.transceivers.push(transceiver);
    return transceiver;
  }
  addTrack(value: MediaStreamTrack) { return this.addTransceiver(value).sender; }
  removeTrack(sender: RTCRtpSender) { Object.assign(sender, { track: null }); }
  close() { this.signalingState = 'closed'; }
}

function installMediaFakes(): () => void {
  const restore: Array<() => void> = [];
  for (const [name, value] of [['MediaStream', Stream], ['RTCPeerConnection', PeerConnection]] as const) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    restore.push(() => {
      if (original) Object.defineProperty(globalThis, name, original);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  return () => { for (const reset of restore.reverse()) reset(); };
}

let restoreMediaFakes: (() => void) | undefined;
before(() => { restoreMediaFakes = installMediaFakes(); });
after(() => { restoreMediaFakes?.(); });

async function p2pFixture(t: TestContext) {
  appEvents.clear();
  voiceStore.setChannel('room');
  const manager = new WebRtcManager();
  const client = new NetworkClient();
  const participants = new ParticipantManager();
  const sent: Array<{ type: MessageType; payload: unknown }> = [];
  t.mock.method(client, 'send', (type: MessageType, payload: unknown) => { sent.push({ type, payload }); });
  Object.defineProperty(manager, 'signalClient', { configurable: true, get: () => client });
  Object.defineProperty(manager, 'voiceParticipants', { configurable: true, get: () => participants });
  t.mock.method(manager, 'isSfuMode', () => false);
  manager['beginPeerFailureCountdown'] = () => {};
  manager['startConnectionWatchdog'] = () => {};
  manager.setCurrentSessionId('publisher');
  const microphone = track('microphone', 'audio');
  const camera = track('camera', 'video');
  manager['localAudioTrack'] = microphone;
  manager['localCameraTrack'] = camera;
  t.after(() => {
    manager.closeAllPeers();
    manager['localAudioTrack'] = null;
    manager['localCameraTrack'] = null;
    manager.setCurrentSessionId('');
    appEvents.clear();
    voiceStore.reset();
    client.dispose();
  });
  return { manager, client, participants, microphone, camera, sent };
}

test('viewer queries are source-bound and reject stale call/source responses', async t => {
  const f = await p2pFixture(t);
  const user = { id: 'publisher', sessionId: 'publisher', clientId: 'publisher',
    nickname: 'Publisher', status: 'ONLINE' as const, joinedAt: 1 };
  f.participants.addUser(user);
  const state = { sessionId: 'publisher', userId: 'publisher', channelId: 'room', isMuted: false,
    isDeafened: false, isSpeaking: false, isCameraOn: false, isScreenSharing: true, screenShareIds: ['screen-one'],
    isSharingScreenAudio: false, serverMuted: false, serverDeafened: false };
  f.participants.updateVoiceState(state);
  let current = true;
  f.manager['nativeScreenContext'] = () => ({
    client: f.client, participants: f.participants, sessionId: 'viewer-one', channelId: 'room', mode: 'p2p',
    isCurrent: () => current, announceSources() {},
  });
  let beforeReply = () => {};
  let publisherSessionId = 'publisher';
  t.mock.method(f.client, 'sendRequest', async (type: MessageType, query: { publisherSessionId: string; channelId: string;
    shareId: string; sourceInstanceId: string | null }) => {
    assert.equal(type, MessageType.SCREEN_VIEWERS_GET);
    assert.deepEqual(query, { publisherSessionId: 'publisher', channelId: 'room', shareId: 'screen-one', sourceInstanceId: null });
    beforeReply();
    return { ...query, publisherSessionId, viewerSessionIds: ['viewer-one', 'viewer-two'] };
  });
  assert.deepEqual(await f.manager.getScreenViewers('publisher', 'screen-one'), ['viewer-one', 'viewer-two']);
  publisherSessionId = 'someone-else';
  await assert.rejects(f.manager.getScreenViewers('publisher', 'screen-one'), /another source/);
  publisherSessionId = 'publisher';
  beforeReply = () => { current = false; };
  await assert.rejects(f.manager.getScreenViewers('publisher', 'screen-one'), { name: 'AbortError' });
  current = true;
  beforeReply = () => f.participants.updateVoiceState({ ...state, screenShareIds: [] });
  await assert.rejects(f.manager.getScreenViewers('publisher', 'screen-one'), { name: 'AbortError' });
  await assert.rejects(f.manager.getScreenViewers('publisher', 'missing'), { name: 'AbortError' });
});

test('a bot authorized to receive microphones is never offered camera media', async t => {
  const f = await p2pFixture(t);
  const sessionId = 'bot:listener';
  f.participants.addUser({
    id: 'bot-listener', sessionId, clientId: sessionId, nickname: 'Listener',
    status: 'ONLINE', joinedAt: 1, isBot: true,
  });
  f.participants.updateVoiceState({
    sessionId, userId: 'bot-listener', channelId: 'room', receivesVoice: true,
    isMuted: true, isDeafened: false, serverMuted: false, serverDeafened: false,
    isSpeaking: false, isCameraOn: false, isScreenSharing: false, isSharingScreenAudio: false,
  });
  await f.manager.connectToPeer(sessionId, false);
  const peer = f.manager['peers'].get(sessionId)!;
  assert.equal(peer.botPeer, true);
  assert.equal(peer.receiveOnly, false);
  assert.equal(peer.audioSender, undefined, 'an answerer attaches the authorized microphone after the offer');
  assert.equal(peer.videoSender, undefined);
  assert.equal(peer.pc.getTransceivers().some(entry => entry.receiver.track.kind === 'video'), false,
    'a listening bot never gets a camera m-line');
});

test('screen watch intent follows the voice-call session, not a foreground server with the same IDs', async t => {
  const f = await p2pFixture(t);
  const call = sessionManager.create('watch-call.invalid', 3000, 'fixture');
  const foreground = sessionManager.create('watch-foreground.invalid', 3000, 'fixture');
  t.after(() => { sessionManager.remove(call.key); sessionManager.remove(foreground.key); });
  const user = { id: 'remote-publisher', sessionId: 'remote-publisher', clientId: 'remote-publisher',
    nickname: 'Remote publisher', status: 'ONLINE' as const, joinedAt: 1 };
  const state = { sessionId: 'remote-publisher', userId: 'remote-publisher', channelId: 'room', isMuted: false,
    isDeafened: false, isSpeaking: false, isCameraOn: false, isScreenSharing: true, screenShareIds: ['remote-screen'],
    isSharingScreenAudio: false, serverMuted: false, serverDeafened: false };
  for (const session of [call, foreground]) {
    session.participants.addUser(user);
    session.participants.updateVoiceState(state);
  }
  voiceStore.setChannel('room', call.key);
  sessionManager.activate(foreground.key);
  Reflect.deleteProperty(f.manager, 'voiceParticipants');
  f.manager.setRemoteScreenWatching('remote-publisher', 'remote-screen', true);
  assert.equal(voiceStore.isWatchingScreen('remote-publisher', 'remote-screen'), true);
  foreground.participants.updateVoiceState({ ...state, screenShareIds: [], isScreenSharing: false });
  f.manager.reconcileScreenSources();
  assert.equal(voiceStore.isWatchingScreen('remote-publisher', 'remote-screen'), true,
    'a foreground server dropping the same IDs cannot end the call source');
  call.participants.updateVoiceState({ ...state, screenShareIds: [], isScreenSharing: false });
  f.manager.reconcileScreenSources();
  assert.equal(voiceStore.isWatchingScreen('remote-publisher', 'remote-screen'), false,
    'the call retiring its source also retires the Watch');
});

test('screen watch intent is call-scoped, source-specific, view-independent and separate from audio mute', () => {
  const store = new VoiceStore();
  store.setChannel('room', 'server-a');
  store.setScreenWatching('publisher', 'one', true);
  store.setScreenWatching('publisher', 'two', true);
  store.setScreenAudioMuted('publisher', true);
  store.setChannel('room', 'server-a');
  assert.equal(store.isWatchingScreen('publisher', 'one'), true, 'same-call view/admission rebuild retains explicit intent');
  store.setScreenWatching('publisher', 'one', false);
  assert.equal(store.isWatchingAnyScreen('publisher'), true);
  assert.equal(store.isScreenAudioMuted('publisher'), true);
  store.setScreenWatching('publisher', 'one', true);
  assert.equal(store.isScreenAudioMuted('publisher'), true, 'Watch is not an audio-unmute action');
  store.retainScreenShares('publisher', ['two', 'new-source']);
  assert.equal(store.isWatchingScreen('publisher', 'one'), false);
  assert.equal(store.isWatchingScreen('publisher', 'new-source'), false);
  store.setChannel('room', 'server-b');
  assert.equal(store.isWatchingAnyScreen('publisher'), false, 'the same participant ID on another server cannot inherit consent');
  store.setScreenWatching('publisher', 'two', true);
  store.reset();
  store.setChannel('room', 'server-b');
  assert.equal(store.isWatchingAnyScreen('publisher'), false, 'a new call never inherits the previous call');
});

test('screen watch intent follows a publisher switching sources, but never jumps to a pre-existing share', async () => {
  const store = new VoiceStore();
  const handoffs: unknown[] = [];
  const unbind = appEvents.on('voice.screen_watch_handoff', (event: unknown) => handoffs.push(event));
  try {
    store.setChannel('room', 'server-a');
    const roster = (ids: string[], others: string[] = []) => new Map([['publisher', ids], ['other', others]]);
    store.reconcileScreenShares(roster(['one']), 1_000);
    store.setScreenWatching('publisher', 'one', true);
    store.setScreenQuality('publisher', 'one', '720p60');
    store.reconcileScreenShares(roster(['two'], ['unrelated']), 2_000);
    assert.equal(store.isWatchingScreen('publisher', 'one'), false);
    assert.equal(store.isWatchingScreen('publisher', 'two'), true, 'a switch in one update keeps watching');
    assert.equal(store.getScreenQuality('publisher', 'two'), '720p60', 'the chosen quality moves with the watch');
    assert.equal(store.isWatchingScreen('other', 'unrelated'), false, 'other publishers never inherit intent');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(handoffs, [{ sessionId: 'publisher', fromShareId: 'one', shareId: 'two' }]);

    store.reconcileScreenShares(roster([]), 3_000);
    assert.equal(store.isWatchingAnyScreen('publisher'), false);
    store.reconcileScreenShares(roster(['three']), 3_000 + VoiceStore.SCREEN_WATCH_HANDOFF_MS);
    assert.equal(store.isWatchingScreen('publisher', 'three'), true, 'retire-then-publish within the window keeps watching');

    store.reconcileScreenShares(roster([]), 20_000);
    store.reconcileScreenShares(roster(['late']), 20_001 + VoiceStore.SCREEN_WATCH_HANDOFF_MS);
    assert.equal(store.isWatchingScreen('publisher', 'late'), false, 'a later new broadcast needs a new Watch');

    store.reconcileScreenShares(roster(['a', 'b']), 40_000);
    store.setScreenWatching('publisher', 'a', true);
    store.reconcileScreenShares(roster(['b']), 40_001);
    assert.equal(store.isWatchingScreen('publisher', 'b'), false, 'stopping one of two shares never watches the other');
    store.reconcileScreenShares(new Map([['other', []]]), 40_002);
    store.reconcileScreenShares(roster(['c']), 40_003);
    assert.equal(store.isWatchingScreen('publisher', 'c'), true, 'a rejoin within the window still counts as the switch');

    store.setScreenWatching('publisher', 'c', true);
    store.reconcileScreenShares(roster([]), 50_000);
    store.setChannel('room', 'server-b');
    store.setChannel('room', 'server-b');
    store.reconcileScreenShares(roster(['d']), 50_001);
    assert.equal(store.isWatchingAnyScreen('publisher'), false, 'a new call never inherits a pending switch');
  } finally {
    unbind();
  }
});

test('a replaced screen audio track cannot remove its successor when its late ended event arrives', () => {
  const participants = new ParticipantManager();
  participants.addUser({ id: 'publisher', sessionId: 'publisher', clientId: 'publisher', nickname: 'Publisher', status: 'ONLINE', joinedAt: 1 });
  const router = new RemoteMediaRouter(() => participants);
  let removed = false;
  const element: Partial<HTMLAudioElement> = {
    srcObject: null, play: async () => {}, pause() {}, remove() { removed = true; },
  };
  router['screenAudioElements'].set('publisher', element as HTMLAudioElement);
  router['applyVolumeToElement'] = () => {};
  router['playRemoteAudio'] = async () => {};
  const oldAudio = track('old-audio', 'audio'), newAudio = track('new-audio', 'audio');
  router.routeScreenAudioTrack('publisher', oldAudio);
  router.routeScreenAudioTrack('publisher', newAudio);
  oldAudio.onended?.call(oldAudio, new Event('ended'));
  assert.equal(removed, false);
  assert.equal((element.srcObject as MediaStream).getAudioTracks()[0], newAudio);
  router.cleanupScreenAudio('publisher', newAudio);
  assert.equal(removed, true);
});


test('the call SFU consumes microphones and cameras, never screen producers', async t => {
  const client = new NetworkClient();
  const requested: string[] = [];
  const delivered: string[] = [];
  const engine = new SfuClientEngine(() => client, () => 'viewer', {
    onHealthChanged() {}, onRoster() {}, onConsumerClosed() {},
    onConsumerTrack: event => delivered.push(`${event.mediaType}:${event.producerId}`),
    onConnectionFailed: reason => { throw new Error(reason); }, onConnected() {},
  });
  t.mock.method(client, 'send', () => {});
  const producers: SfuNewProducerPayload[] = [
    { channelId: 'room', producerSessionId: 'publisher', producerId: 'screen', kind: 'video', appData: { mediaType: 'screen_video', shareId: 'one' } },
    { channelId: 'room', producerSessionId: 'publisher', producerId: 'screen-audio', kind: 'audio', appData: { mediaType: 'screen_audio', shareId: 'one' } },
    { channelId: 'room', producerSessionId: 'publisher', producerId: 'mic', kind: 'audio', appData: { mediaType: 'mic' } },
    { channelId: 'room', producerSessionId: 'publisher', producerId: 'camera', kind: 'video', appData: { mediaType: 'camera' } },
  ];
  Object.defineProperty(client, 'sendRequest', { value: async (_type: MessageType, payload: SfuConsumePayload): Promise<SfuConsumedPayload> => {
    requested.push(payload.producerId);
    const producer = producers.find(entry => entry.producerId === payload.producerId)!;
    return { ...producer, id: `consumer-${payload.producerId}`, rtpParameters: { codecs: [] } };
  } });
  const transport: Partial<SfuTypes.Transport> = {
    id: 'recv', close() {},
    async consume<AppData extends SfuTypes.AppData>(options: SfuTypes.ConsumerOptions<AppData>) {
      const consumer: Partial<SfuTypes.Consumer<AppData>> = {
        id: options.id, producerId: options.producerId, track: track(options.id, options.kind), close() {}, closed: false,
      };
      Object.defineProperty(consumer, 'on', { value() {} });
      return consumer as SfuTypes.Consumer<AppData>;
    },
  };
  engine['recvTransport'] = transport as SfuTypes.Transport;
  engine['device'] = { rtpCapabilities: {} } as SfuTypes.Device;
  engine['channelId'] = 'room';
  t.after(() => { engine.leave(); client.dispose(); });
  for (const producer of producers) await engine['consumeRemoteProducer'](producer);
  assert.deepEqual(requested, ['mic', 'camera'], 'screens reach viewers through the native screen receiver only');
  assert.deepEqual(delivered, ['mic:mic', 'camera:camera']);
});

test('screen audio mute follows the native owner, so unmuting while deafened never opens the output', async t => {
  appEvents.clear();
  voiceStore.reset();
  voiceStore.setChannel('room');
  const manager = new WebRtcManager();
  t.after(() => { manager.closeAllPeers(); appEvents.clear(); voiceStore.reset(); });
  const router = manager['mediaRouter'];
  router['applyVolumeToElement'] = () => {};
  const element: Partial<HTMLAudioElement> = { muted: true, srcObject: null, pause() {}, remove() {} };
  router['screenAudioElements'].set('publisher\u0000share', element as HTMLAudioElement);
  let nativeUpdates = 0;
  t.mock.method(manager['nativeScreens'], 'updateAudio', async () => { nativeUpdates++; });
  t.mock.method(voiceStore, 'getEffectiveDeafened', () => true);
  voiceStore.setScreenAudioMuted('publisher', true);
  voiceStore.setScreenWatching('publisher', 'share', true);
  await new Promise(resolve => setTimeout(resolve, 0));
  const before = nativeUpdates;
  manager.setScreenAudioMuted('publisher', false);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(element.muted, true, 'the deafened listener hears nothing while the native owner applies the change');
  assert.ok(nativeUpdates > before, 'the native owner re-applies mute, deafen and volume together');
});
