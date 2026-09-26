import assert from 'node:assert/strict';
import { after, before, test, type TestContext } from 'node:test';
import type { types as SfuTypes } from 'mediasoup-client';
import { MessageType, QUALITY_PRESETS, screenMetadataSignalSchema, screenWatchSignalSchema, type SfuConsumedPayload, type SfuConsumePayload, type SfuNewProducerPayload, type VoiceStateUpdatePayload } from '@monky/shared';
import { appEvents } from '../src/renderer/core/EventBus';
import { NetworkClient } from '../src/renderer/core/NetworkClient';
import { ParticipantManager } from '../src/renderer/core/ParticipantManager';
import { sessionManager } from '../src/renderer/core/SessionManager';
import { WebRtcManager, webRtcManager, type PeerSession } from '../src/renderer/core/WebRtcManager';
import { notifyScreenShareState } from '../src/renderer/core/screenShareControls';
import { SfuClientEngine } from '../src/renderer/core/webrtc/SfuClientEngine';
import { RemoteMediaRouter } from '../src/renderer/core/webrtc/RemoteMediaRouter';
import { settingsStore } from '../src/renderer/stores/settingsStore';
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

async function p2pFixture(t: TestContext, options: { manager?: WebRtcManager; screenAudio?: boolean } = {}) {
  appEvents.clear();
  const oldCodec = settingsStore.preferredVideoCodec;
  settingsStore.preferredVideoCodec = 'auto';
  voiceStore.setChannel('room');
  const manager = options.manager ?? new WebRtcManager();
  if (options.manager) manager['setupSignalListeners']();
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
  const screens = ['screen-one', 'screen-two'].map(id => {
    const stream = new Stream([track(id, 'video')]);
    stream.id = id;
    const share = { stream, track: stream.getVideoTracks()[0], pending: false };
    manager['localScreenShares'].set(id, share);
    return share;
  });
  const microphone = track('microphone', 'audio');
  const camera = track('camera', 'video');
  const audio = track('system-audio', 'audio');
  manager['localAudioTrack'] = microphone;
  manager['localCameraTrack'] = camera;
  if (options.screenAudio !== false) {
    manager['localScreenAudioTrack'] = audio;
    manager['screenAudioStream'] = new Stream([audio]);
    manager['screenAudioStreamId'] = 'system-stream';
  }
  const peers: PeerSession[] = [];
  for (const id of ['viewer-one', 'viewer-two']) {
    participants.addUser({ id, sessionId: id, clientId: id, nickname: id, status: 'ONLINE', joinedAt: 1 });
    participants.updateVoiceState({
      sessionId: id, userId: id, channelId: 'room', isMuted: false, isDeafened: false, serverMuted: false,
      serverDeafened: false, isSpeaking: false, isCameraOn: false, isScreenSharing: false, isSharingScreenAudio: false,
    });
    await manager.connectToPeer(id, false);
    const peer = manager['peers'].get(id)!;
    const negotiation = { preferred: 'auto' as const };
    peer.screenNegotiation = negotiation;
    peer.negotiatedScreenNegotiation = negotiation;
    peer.remoteSubscriptionId = `remote-${id}`;
    peers.push(peer);
  }
  t.after(() => {
    manager.closeAllPeers();
    manager.clearLocalScreenTracks();
    manager['localAudioTrack'] = null;
    manager['localCameraTrack'] = null;
    manager['localScreenAudioTrack'] = null;
    manager['screenAudioStream'] = null;
    manager['screenAudioStreamId'] = null;
    manager.setCurrentSessionId('');
    Reflect.deleteProperty(manager, 'signalClient');
    Reflect.deleteProperty(manager, 'voiceParticipants');
    Reflect.deleteProperty(manager, 'beginPeerFailureCountdown');
    Reflect.deleteProperty(manager, 'startConnectionWatchdog');
    appEvents.clear();
    voiceStore.reset();
    client.dispose();
    settingsStore.preferredVideoCodec = oldCodec;
  });
  const watch = (peer: PeerSession, shareId: string, watching: boolean, revision: number, subscriptionId = peer.screenSubscriptionId) =>
    manager['handleIncomingSignal']({
      fromSessionId: peer.peerSessionId, targetSessionId: 'publisher', signalType: 'screen-watch',
      streamId: shareId, watching, subscriptionId, subscriptionRevision: revision,
      watcherSubscriptionId: peer.remoteSubscriptionId,
    });
  return { manager, client, participants, peers, screens, microphone, camera, audio, sent, watch };
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

test('a bot authorized to receive microphones is never offered camera or screen media', async t => {
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
  assert.equal(peer.screenAudioSender, undefined);
  assert.equal(peer.screenVideoSenders.size, 0);
  const sent = f.sent.length;
  f.manager['announceScreenSources'](peer);
  assert.equal(f.sent.length, sent, 'microphone consent does not authorize screen descriptions');
});

test('screen P2P discovery attaches no screen payload source before Watch; microphone/camera stay attached', async t => {
  const f = await p2pFixture(t);
  for (const peer of f.peers) {
    assert.equal(peer.audioSender?.track, f.microphone);
    assert.equal(peer.videoSender?.track, f.camera);
    assert.equal(peer.screenAudioSender?.track, null);
    assert.equal(peer.screenAudioSender?.getParameters().encodings[0].active, false);
    for (const sender of peer.screenVideoSenders.values()) {
      assert.equal(sender.track, null, 'no capture source is attached to the remote sender');
      assert.equal(sender.getParameters().encodings[0].active, false);
    }
    await f.manager['checkSessionScreenCodecs'](peer);
    assert.equal(peer.screenVideoSenders.get('screen-one')?.track, null, 'an SDP completion alone cannot subscribe');
  }
  assert.equal(f.sent.length, 6, 'two screen descriptions and the shared audio description per peer');
  f.sent.length = 0;
  f.manager['announceScreenSources'](f.peers[0]);
  assert.deepEqual(f.sent, [
    { signalType: 'screen-video-meta', streamId: 'screen-one' },
    { signalType: 'screen-video-meta', streamId: 'screen-two' },
    { signalType: 'screen-audio-meta', streamId: 'system-stream' },
  ].map(payload => ({
    type: MessageType.RTC_SIGNAL,
    payload: {
      ...payload, targetSessionId: 'viewer-one', fromSessionId: 'publisher',
      subscriptionId: f.peers[0].screenSubscriptionId,
    },
  })), 'fresh offers/answers rediscover audio as well as video without attaching sources');
});

test('screen P2P a delayed track event from a replaced peer never restores retired media', async t => {
  const f = await p2pFixture(t);
  const [peer] = f.peers;
  const oldTrackHandler = peer.pc.ontrack!;
  f.manager.removePeer(peer.peerSessionId, true);
  await f.manager.connectToPeer(peer.peerSessionId, false);
  const delayedTrack = track('retired-screen', 'video');
  const stream = new Stream([delayedTrack]);
  f.manager['screenVideoStreamIds'].add(stream.id);
  let routed = 0;
  f.manager['routeScreenVideoTrack'] = () => { routed++; };
  const transceiver = peer.pc.getTransceivers()[0];
  const event = Object.assign(new Event('track'), {
    track: delayedTrack, streams: [stream], receiver: transceiver.receiver, transceiver,
  });
  oldTrackHandler.call(peer.pc, event);
  assert.equal(routed, 0);
  assert.equal(delayedTrack.readyState, 'ended');
  assert.equal(f.manager['peers'].get(peer.peerSessionId)?.screenVideoSenders.get('screen-one')?.track, null);
});

test('screen P2P Watch/Stop selects only that recipient and retains shared audio until their last watched screen stops', async t => {
  const f = await p2pFixture(t);
  const [one, two] = f.peers;
  await f.watch(one, 'screen-one', true, 1);
  assert.equal(one.screenVideoSenders.get('screen-one')?.track, f.screens[0].track);
  assert.equal(one.screenVideoSenders.get('screen-one')?.getParameters().encodings[0].active, true);
  assert.equal(one.screenVideoSenders.get('screen-two')?.track, null);
  assert.equal(one.screenAudioSender?.track, f.audio);
  assert.equal(two.screenAudioSender?.track, null);
  await f.watch(one, 'screen-two', true, 1);
  await f.watch(two, 'screen-one', true, 1);
  await f.watch(one, 'screen-one', false, 2);
  assert.equal(one.screenVideoSenders.get('screen-one')?.track, null);
  assert.equal(one.screenAudioSender?.track, f.audio, 'the other watched screen still needs publisher audio');
  assert.equal(two.screenVideoSenders.get('screen-one')?.track, f.screens[0].track);
  await f.watch(one, 'screen-two', false, 2);
  assert.equal(one.screenAudioSender?.track, null);
  assert.equal(one.screenAudioSender?.getParameters().encodings[0].active, false);
  assert.equal(two.screenAudioSender?.track, f.audio);
  assert.equal(f.audio.readyState, 'live', 'Stop watching never stops publisher capture');
  assert.equal(one.audioSender?.track, f.microphone);
  assert.equal(one.videoSender?.track, f.camera);
});

test('screen P2P rejects stale epochs, old revisions, removed sources and late codec activation after Stop', async t => {
  const f = await p2pFixture(t);
  const [peer] = f.peers;
  await f.watch(peer, 'screen-one', true, 1, 'previous-connection');
  assert.equal(peer.screenVideoSenders.get('screen-one')?.track, null);
  await f.watch(peer, 'screen-one', true, 1);
  await f.watch(peer, 'screen-one', false, 3);
  await f.watch(peer, 'screen-one', true, 2);
  assert.equal(peer.screenVideoSenders.get('screen-one')?.track, null);
  await f.watch(peer, 'screen-one', true, 4);
  const writing = gate(), release = gate();
  const sender = peer.screenVideoSenders.get('screen-one')!;
  const originalSet = sender.setParameters.bind(sender);
  let hold = true;
  t.mock.method(sender, 'setParameters', async (parameters: RTCRtpSendParameters) => {
    if (hold && parameters.encodings[0].active) {
      hold = false;
      writing.release();
      await release.promise;
    }
    await originalSet(parameters);
  });
  const lateAnswer = f.manager['checkSessionScreenCodecs'](peer);
  await writing.promise;
  const stopping = f.watch(peer, 'screen-one', false, 5);
  release.release();
  await Promise.all([lateAnswer, stopping]);
  assert.equal(sender.track, null);
  assert.equal(sender.getParameters().encodings[0].active, false);
  f.manager['localScreenShares'].delete('screen-one');
  await f.watch(peer, 'screen-one', true, 6);
  assert.equal(sender.track, null);
});

test('screen P2P Watch renegotiates a dormant screen m-line omitted from an earlier answer', async t => {
  const f = await p2pFixture(t);
  const [peer] = f.peers;
  const sender = peer.screenVideoSenders.get('screen-one')!;
  const transceiver = peer.pc.getTransceivers().find(entry => entry.sender === sender)!;
  Object.defineProperty(transceiver, 'mid', { value: null });
  let offers = 0;
  f.manager['sendOffer'] = async () => { offers++; };
  assert.equal(f.manager['hasUnnegotiatedSenders'](peer.pc), false, 'unwatched screens carry no source');
  await f.watch(peer, 'screen-one', true, 1);
  assert.equal(offers, 1, 'attaching a newly watched screen must negotiate its own sending m-line');
  assert.equal(sender.getParameters().encodings[0].active, false, 'encoding waits for the negotiated answer');
});

test('screen P2P Watch applies the latest shared quality policy to senders detached during a settings change', async t => {
  const f = await p2pFixture(t);
  const [peer] = f.peers;
  f.manager['currentPreset'] = 'GAMING';
  await f.watch(peer, 'screen-one', true, 1);
  const parameters = peer.screenVideoSenders.get('screen-one')!.getParameters();
  assert.equal(parameters.encodings[0].active, true);
  assert.equal(parameters.encodings[0].maxBitrate, QUALITY_PRESETS.GAMING.screenBitrateKbps * 1000);
  assert.equal(parameters.encodings[0].maxFramerate, QUALITY_PRESETS.GAMING.screenFps);
  assert.equal(peer.screenAudioSender!.getParameters().encodings[0].maxBitrate, QUALITY_PRESETS.GAMING.audioBitrateKbps * 1000);
});

test('screen P2P a late replaceTrack cannot revive a cancelled subscription; failed pause detaches instead of leaking', async t => {
  const f = await p2pFixture(t);
  const [peer] = f.peers;
  const sender = peer.screenVideoSenders.get('screen-one')!;
  const replacing = gate(), release = gate();
  const originalReplace = sender.replaceTrack.bind(sender);
  let hold = true;
  t.mock.method(sender, 'replaceTrack', async (value: MediaStreamTrack | null) => {
    if (hold && value) { hold = false; replacing.release(); await release.promise; }
    await originalReplace(value);
  });
  const starting = f.watch(peer, 'screen-one', true, 1);
  await replacing.promise;
  const stopping = f.watch(peer, 'screen-one', false, 2);
  release.release();
  await Promise.all([starting, stopping]);
  assert.equal(sender.track, null);
  assert.equal(sender.getParameters().encodings[0].active, false);
  await f.watch(peer, 'screen-one', true, 3);
  t.mock.method(sender, 'setParameters', async () => { throw new Error('sender is closing'); });
  await f.watch(peer, 'screen-one', false, 4);
  assert.equal(sender.track, null, 'removeTrack is the fail-closed fallback, not a UI mute');
  assert.equal(peer.screenAudioSender?.track, null, 'failure to pause video must not skip audio teardown');
});

test('screen P2P a new remote connection epoch revokes old consent before applying SDP, even for a reused session ID', async t => {
  const f = await p2pFixture(t);
  const [peer] = f.peers;
  await f.watch(peer, 'screen-one', true, 1);
  const previousViewerEpoch = peer.remoteSubscriptionId;
  let descriptions = 0;
  f.manager['applyIncomingSignal'] = async () => {
    descriptions++;
    assert.equal(peer.screenVideoSenders.get('screen-one')?.track, null);
    assert.equal(peer.screenAudioSender?.track, null);
    return false;
  };
  await f.manager['handleIncomingSignal']({
    signalType: 'offer', fromSessionId: peer.peerSessionId, targetSessionId: 'publisher',
    subscriptionId: 'replacement-viewer-epoch', sdp: { type: 'offer', sdp: '' },
  });
  assert.equal(descriptions, 1);
  await f.manager['handleIncomingSignal']({
    signalType: 'screen-watch', fromSessionId: peer.peerSessionId, targetSessionId: 'publisher',
    streamId: 'screen-one', subscriptionId: peer.screenSubscriptionId,
    watcherSubscriptionId: previousViewerEpoch, subscriptionRevision: 2, watching: true,
  });
  assert.equal(peer.screenVideoSenders.get('screen-one')?.track, null);
  await f.watch(peer, 'screen-one', true, 1);
  assert.equal(peer.screenVideoSenders.get('screen-one')?.track, f.screens[0].track,
    'only fresh explicit consent from the new epoch can restore delivery');
});

test('screen P2P source metadata survives intermediate voice-state updates until publication, then expires on source removal', async t => {
  const f = await p2pFixture(t);
  const [peer] = f.peers;
  const metadata = {
    signalType: 'screen-video-meta' as const, fromSessionId: peer.peerSessionId, targetSessionId: 'publisher',
    streamId: 'remote-screen', subscriptionId: peer.remoteSubscriptionId,
  };
  await f.manager['handleIncomingSignal'](metadata);
  f.manager.reconcileScreenSources();
  assert.equal(f.manager['remoteScreenSubscriptions'].get(peer.peerSessionId)?.has('remote-screen'), true,
    'capture/SDP announces the source before VOICE_STATE_UPDATE publishes its tile');
  const participant = f.participants.get(peer.peerSessionId)!;
  f.participants.updateVoiceState({ ...participant.voiceState!, screenShareIds: ['remote-screen'], isScreenSharing: true });
  f.manager.reconcileScreenSources();
  f.manager.setRemoteScreenWatching(peer.peerSessionId, 'remote-screen', true);
  assert.equal(voiceStore.isWatchingScreen(peer.peerSessionId, 'remote-screen'), true);
  f.participants.updateVoiceState({ ...participant.voiceState!, screenShareIds: [], isScreenSharing: false });
  f.manager.reconcileScreenSources();
  assert.equal(voiceStore.isWatchingScreen(peer.peerSessionId, 'remote-screen'), false);
  assert.equal(f.manager['remoteScreenSubscriptions'].has(peer.peerSessionId), false);
});

test('screen P2P pending source announcements are bounded and never imply a Watch', async t => {
  const f = await p2pFixture(t);
  const [peer] = f.peers;
  for (let index = 0; index < 20; index++) {
    await f.manager['handleIncomingSignal']({
      signalType: 'screen-video-meta', fromSessionId: peer.peerSessionId, targetSessionId: 'publisher',
      streamId: `pending-${index}`, subscriptionId: peer.remoteSubscriptionId,
    });
  }
  assert.equal(f.manager['remoteScreenSubscriptions'].get(peer.peerSessionId)?.size, 2);
  assert.equal(voiceStore.isWatchingAnyScreen(peer.peerSessionId), false);
});

for (const scenario of [
  { name: 'two screens to one', retained: [], added: ['replacement'], cancelBeforeMetadata: false },
  { name: 'two screens to two', retained: [], added: ['replacement', 'replacement-two'], cancelBeforeMetadata: false },
  { name: 'one screen while keeping the other', retained: ['screen-two'], added: ['replacement'], cancelBeforeMetadata: true },
]) {
  test(`screen P2P replacing ${scenario.name} without audio republishes discovery after the roster, not consent`, async t => {
    const f = await p2pFixture(t, { manager: webRtcManager, screenAudio: false });
    const [publisherPeer, otherViewer] = f.peers;
    const viewer = new WebRtcManager();
    const viewerClient = new NetworkClient();
    const viewerParticipants = new ParticipantManager();
    const commands: Array<ReturnType<typeof screenWatchSignalSchema.parse>> = [];
    Object.defineProperty(viewer, 'signalClient', { get: () => viewerClient });
    Object.defineProperty(viewer, 'voiceParticipants', { get: () => viewerParticipants });
    t.mock.method(viewer, 'isSfuMode', () => false);
    t.mock.method(viewerClient, 'send', (type: MessageType, payload: unknown) => {
      if (type === MessageType.RTC_SIGNAL) commands.push(screenWatchSignalSchema.parse(payload));
    });
    viewer['beginPeerFailureCountdown'] = () => {};
    viewer['startConnectionWatchdog'] = () => {};
    viewer.setCurrentSessionId('viewer-one');
    viewerParticipants.addUser({
      id: 'publisher', sessionId: 'publisher', clientId: 'publisher', nickname: 'Publisher', status: 'ONLINE', joinedAt: 1,
    });
    viewerParticipants.updateVoiceState({
      ...f.participants.get('viewer-one')!.voiceState!, sessionId: 'publisher', userId: 'publisher',
      screenShareIds: ['screen-one', 'screen-two'], isScreenSharing: true,
    });
    await viewer.connectToPeer('publisher', false);
    const viewerPeer = viewer['peers'].get('publisher')!;
    viewerPeer.remoteSubscriptionId = publisherPeer.screenSubscriptionId;
    publisherPeer.remoteSubscriptionId = viewerPeer.screenSubscriptionId;
    t.after(() => { viewer.closeAllPeers(); viewerClient.dispose(); });

    // Only the browser's SDP completion is faked; publication, discovery,
    // bounded caching, Watch signaling and sender attachment run their real code.
    Object.defineProperty(f.manager, 'sendOffer', {
      configurable: true,
      value: async (peer: PeerSession) => {
        f.manager['announceScreenSources'](peer);
        peer.negotiatedScreenNegotiation = peer.screenNegotiation;
      },
    });
    t.after(() => { Reflect.deleteProperty(f.manager, 'sendOffer'); });

    const deliver = async (messages: typeof f.sent) => {
      for (const message of messages) {
        if (message.type === MessageType.VOICE_STATE_UPDATE) {
          const update = message.payload as VoiceStateUpdatePayload;
          viewerParticipants.updateVoiceState({ ...viewerParticipants.get('publisher')!.voiceState!, ...update });
          viewer.reconcileScreenSources();
          if (scenario.cancelBeforeMetadata) {
            viewer.setRemoteScreenWatching('publisher', 'replacement', true);
            viewer.setRemoteScreenWatching('publisher', 'replacement', false);
          }
        } else if (message.type === MessageType.RTC_SIGNAL) {
          const metadata = screenMetadataSignalSchema.parse(message.payload);
          if (metadata.targetSessionId === 'viewer-one') await viewer['handleIncomingSignal'](metadata);
        }
        assert.ok((viewer['remoteScreenSubscriptions'].get('publisher')?.size ?? 0) <= 2,
          'replacement never relaxes the two-announcement bound');
      }
    };
    const deliverCommands = async () => {
      for (const command of commands.splice(0)) await f.manager['handleIncomingSignal'](command);
    };
    const initialMetadata = f.sent.splice(0);
    await deliver(initialMetadata);
    for (const share of f.screens) voiceStore.addScreenShare(share.stream.id);
    viewer.setRemoteScreenWatching('publisher', 'screen-one', true);
    const oldWatch = commands.find(command => command.streamId === 'screen-one' && command.watching)!;
    if (scenario.retained.length) viewer.setRemoteScreenWatching('publisher', 'screen-two', true);
    await deliverCommands();
    await f.watch(otherViewer, 'screen-two', true, 1);
    assert.equal(publisherPeer.screenVideoSenders.get('screen-one')?.track, f.screens[0].track);

    const removed = f.screens.map(share => share.stream.id).filter(id => !scenario.retained.includes(id));
    const retiredSenders = removed.map(id => publisherPeer.screenVideoSenders.get(id)!);
    for (const id of removed) {
      voiceStore.removeScreenShare(id);
      await f.manager.removeLocalScreenTrack(id, false);
    }
    const replacements = scenario.added.map(id => {
      const stream = new Stream([track(id, 'video')]);
      stream.id = id;
      return stream;
    });
    for (const stream of replacements) await f.manager.addLocalScreenTrack(stream);
    await deliver(f.sent.splice(0));
    assert.deepEqual([...viewer['remoteScreenSubscriptions'].get('publisher')!.keys()], ['screen-one', 'screen-two'],
      'the old authoritative roster still fills both slots while new metadata/SDP arrives');
    assert.equal(voiceStore.isWatchingScreen('publisher', 'replacement'), false);

    for (const stream of replacements) voiceStore.addScreenShare(stream.id);
    notifyScreenShareState({ client: f.client, isCurrent: () => true });
    const publication = f.sent.splice(0);
    assert.equal(publication[0].type, MessageType.VOICE_STATE_UPDATE);
    await deliver(publication);
    await deliverCommands();
    for (const stream of replacements) {
      assert.equal(publisherPeer.screenVideoSenders.get(stream.id)?.track, null);
      assert.equal(publisherPeer.screenVideoSenders.get(stream.id)?.getParameters().encodings[0].active, false);
      assert.equal(otherViewer.screenVideoSenders.get(stream.id)?.track, null);
    }
    assert.equal(publisherPeer.screenAudioSender, undefined, 'there is no audio publication to repair discovery accidentally');

    for (const stream of replacements) {
      viewer.setRemoteScreenWatching('publisher', stream.id, true);
      assert.ok(commands.some(command => command.streamId === stream.id && command.watching
        && command.subscriptionId === publisherPeer.screenSubscriptionId
        && command.watcherSubscriptionId === viewerPeer.screenSubscriptionId),
      'Watch must emit an authenticated subscription without another offer or an audio track');
      await deliverCommands();
      assert.equal(publisherPeer.screenVideoSenders.get(stream.id)?.track, stream.getVideoTracks()[0]);
      assert.equal(publisherPeer.screenVideoSenders.get(stream.id)?.getParameters().encodings[0].active, true);
      assert.equal(otherViewer.screenVideoSenders.get(stream.id)?.track, null);
    }

    await deliver(initialMetadata.filter(message => {
      const metadata = screenMetadataSignalSchema.parse(message.payload);
      return removed.includes(metadata.streamId);
    }));
    for (const id of removed) {
      viewer.setRemoteScreenWatching('publisher', id, true);
      assert.equal(voiceStore.isWatchingScreen('publisher', id), false);
      assert.equal(f.manager['localScreenShares'].has(id), false);
      assert.equal(publisherPeer.screenVideoSenders.has(id), false);
    }
    assert.ok(commands.every(command => !removed.includes(command.streamId) || !command.watching),
      'late announcements cannot restore consent for a withdrawn source');
    await deliverCommands();
    await f.manager['handleIncomingSignal'](oldWatch);
    assert.ok(retiredSenders.every(sender => sender.track === null));
    for (const stream of replacements) {
      assert.equal(publisherPeer.screenVideoSenders.get(stream.id)?.track, stream.getVideoTracks()[0]);
    }
    if (scenario.retained.length) {
      assert.equal(publisherPeer.screenVideoSenders.get('screen-two')?.track, f.screens[1].track);
      assert.equal(otherViewer.screenVideoSenders.get('screen-two')?.track, f.screens[1].track);
    }
    for (const peer of f.peers) {
      assert.equal(peer.audioSender?.track, f.microphone);
      assert.equal(peer.videoSender?.track, f.camera);
    }
  });
}

test('screen P2P state publication only reannounces published sources and never follows a stale call', async t => {
  const f = await p2pFixture(t, { manager: webRtcManager, screenAudio: false });
  const call = { client: f.client, isCurrent: () => true };
  f.sent.length = 0;
  voiceStore.addScreenShare('screen-one');
  notifyScreenShareState(call);
  assert.equal(f.sent[0].type, MessageType.VOICE_STATE_UPDATE);
  assert.deepEqual(f.sent.slice(1).map(message => screenMetadataSignalSchema.parse(message.payload).streamId),
    ['screen-one', 'screen-one'], 'unpublished local tracks are not part of the committed roster');

  f.sent.length = 0;
  voiceStore.removeScreenShare('screen-one');
  notifyScreenShareState(call);
  assert.deepEqual(f.sent.map(message => message.type), [MessageType.VOICE_STATE_UPDATE],
    'a slow transport removal cannot reannounce the last retired capture');

  f.sent.length = 0;
  voiceStore.addScreenShare('screen-two');
  notifyScreenShareState({ client: f.client, isCurrent: () => false });
  assert.equal(f.sent.length, 0);

  let current = true;
  const send = f.client.send.bind(f.client);
  t.mock.method(f.client, 'send', (type: MessageType, payload: unknown) => {
    send(type, payload);
    current = false;
  });
  notifyScreenShareState({ client: f.client, isCurrent: () => current });
  assert.deepEqual(f.sent.map(message => message.type), [MessageType.VOICE_STATE_UPDATE],
    'recheck call ownership between publishing its state and announcing media');
});

test('screen Watch and source removal target the voice-call session, not a foreground server with the same IDs', async t => {
  const f = await p2pFixture(t);
  const call = sessionManager.create('watch-call.invalid', 3000, 'fixture');
  const foreground = sessionManager.create('watch-foreground.invalid', 3000, 'fixture');
  t.after(() => { sessionManager.remove(call.key); sessionManager.remove(foreground.key); });
  const callSignals: unknown[] = [], foregroundSignals: unknown[] = [];
  t.mock.method(call.client, 'send', (_type: MessageType, payload: unknown) => { callSignals.push(payload); });
  t.mock.method(foreground.client, 'send', (_type: MessageType, payload: unknown) => { foregroundSignals.push(payload); });
  const entry = f.participants.get('viewer-one')!;
  for (const session of [call, foreground]) {
    session.participants.addUser(entry.user);
    session.participants.updateVoiceState({ ...entry.voiceState!, screenShareIds: ['remote-screen'], isScreenSharing: true });
  }
  voiceStore.setChannel('room', call.key);
  sessionManager.activate(foreground.key);
  Reflect.deleteProperty(f.manager, 'signalClient');
  Reflect.deleteProperty(f.manager, 'voiceParticipants');
  f.manager['remoteScreenSubscriptions'].set('viewer-one', new Map([['remote-screen', {
    id: f.peers[0].remoteSubscriptionId!, revision: 0, published: true,
  }]]));
  f.manager.setRemoteScreenWatching('viewer-one', 'remote-screen', true);
  assert.equal(callSignals.length, 1);
  assert.equal(foregroundSignals.length, 0);
  call.participants.updateVoiceState({ ...entry.voiceState!, screenShareIds: [], isScreenSharing: false });
  f.manager.reconcileScreenSources();
  assert.equal(voiceStore.isWatchingScreen('viewer-one', 'remote-screen'), false);
  assert.equal(callSignals.length, 2, 'Stop must go to the original call even when source metadata changes off-screen');
  assert.equal(foregroundSignals.length, 0);
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

test('screen replacement ignores late old-consumer video/audio cleanup and never stops its successor', t => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { getElementById: () => null } });
  t.after(() => {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  });
  const participants = new ParticipantManager();
  participants.addUser({ id: 'publisher', sessionId: 'publisher', clientId: 'publisher', nickname: 'Publisher', status: 'ONLINE', joinedAt: 1 });
  const router = new RemoteMediaRouter(() => participants);
  const first = track('old-video', 'video'), replacement = track('new-video', 'video');
  router.routeScreenVideoTrack('publisher', first, 'one', undefined);
  router.routeScreenVideoTrack('publisher', replacement, 'one', undefined);
  router.cleanupScreenVideo('publisher', 'one', first);
  assert.equal(replacement.readyState, 'live');
  assert.equal(participants.get('publisher')?.remoteScreenStreams.get('one')?.getVideoTracks()[0], replacement);
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
  const oldEndedHandler = replacement.onended;
  router.cleanupPeerMedia('publisher');
  const rejoined = track('rejoined-video', 'video');
  router.routeScreenVideoTrack('publisher', rejoined, 'one', undefined);
  oldEndedHandler?.call(replacement, new Event('ended'));
  assert.equal(participants.get('publisher')?.remoteScreenStreams.get('one')?.getVideoTracks()[0], rejoined,
    'a queued ended event from before reconnect cannot erase a new peer stream');
  router.cleanupScreenVideo('publisher', 'one', rejoined);
  router.cleanupScreenAudio('publisher', newAudio);
  assert.equal(replacement.readyState, 'ended');
  assert.equal(rejoined.readyState, 'ended');
  assert.equal(removed, true);
});

function sfuFixture(t: TestContext) {
  const watched = new Set<string>();
  const client = new NetworkClient();
  const sent: Array<{ type: MessageType; payload: unknown }> = [];
  const requests: SfuConsumePayload[] = [];
  const remoteTracks: string[] = [];
  const closed: string[] = [];
  let sequence = 0;
  let beforeResponse: () => Promise<void> = async () => {};
  let beforeConsume: () => Promise<void> = async () => {};
  const engine = new SfuClientEngine(() => client, () => 'viewer', {
    onHealthChanged() {}, onRoster() {}, onConsumerClosed() {},
    onConsumerTrack: event => remoteTracks.push(event.producerId),
    onConnectionFailed: reason => { throw new Error(reason); }, onConnected() {},
    isScreenWatched: (_sessionId, shareId) => shareId ? watched.has(shareId) : watched.size > 0,
  });
  t.mock.method(client, 'send', (type: MessageType, payload: unknown) => { sent.push({ type, payload }); });
  const producers: SfuNewProducerPayload[] = [
    { channelId: 'room', producerSessionId: 'publisher', producerId: 'video-one', kind: 'video', appData: { mediaType: 'screen_video', shareId: 'one' } },
    { channelId: 'room', producerSessionId: 'publisher', producerId: 'video-two', kind: 'video', appData: { mediaType: 'screen_video', shareId: 'two' } },
    { channelId: 'room', producerSessionId: 'publisher', producerId: 'system-audio', kind: 'audio', appData: { mediaType: 'screen_audio', shareId: 'default' } },
    { channelId: 'room', producerSessionId: 'publisher', producerId: 'mic', kind: 'audio', appData: { mediaType: 'mic' } },
    { channelId: 'room', producerSessionId: 'publisher', producerId: 'camera', kind: 'video', appData: { mediaType: 'camera' } },
  ];
  Object.defineProperty(client, 'sendRequest', { value: async (_type: MessageType, payload: SfuConsumePayload): Promise<SfuConsumedPayload> => {
    requests.push(payload);
    const id = `consumer-${++sequence}`;
    await beforeResponse();
    const producer = producers.find(entry => entry.producerId === payload.producerId)!;
    return { ...producer, id, rtpParameters: { codecs: [] } };
  } });
  const transport: Partial<SfuTypes.Transport> = {
    id: 'recv', close() {},
    async consume<AppData extends SfuTypes.AppData>(options: SfuTypes.ConsumerOptions<AppData>) {
      await beforeConsume();
      const consumer: Partial<SfuTypes.Consumer<AppData>> = {
        id: options.id, producerId: options.producerId, track: track(options.id, options.kind),
        close() { closed.push(options.id); }, closed: false,
      };
      Object.defineProperty(consumer, 'on', { value() {} });
      return consumer as SfuTypes.Consumer<AppData>;
    },
  };
  engine['recvTransport'] = transport as SfuTypes.Transport;
  engine['device'] = { rtpCapabilities: {} } as SfuTypes.Device;
  engine['channelId'] = 'room';
  t.after(() => { engine.leave(); client.dispose(); });
  return {
    engine, watched, sent, requests, remoteTracks, closed, producers,
    delayResponse: (callback: () => Promise<void>) => { beforeResponse = callback; },
    delayConsume: (callback: () => Promise<void>) => { beforeConsume = callback; },
    discover: async () => { for (const producer of producers) await engine['consumeRemoteProducer'](producer); },
  };
}

test('screen SFU discovery never consumes screen RTP before Watch; Stop closes only selected server consumers', async t => {
  const f = sfuFixture(t);
  await f.discover();
  assert.deepEqual(f.requests.map(request => request.producerId), ['mic', 'camera']);
  assert.deepEqual(f.remoteTracks, ['mic', 'camera']);
  f.watched.add('one');
  await f.engine.syncScreenSubscriptions();
  assert.deepEqual(f.requests.map(request => request.producerId), ['mic', 'camera', 'video-one', 'system-audio']);
  assert.equal(f.sent.filter(message => message.type === MessageType.SFU_CONSUMER_SET_PAUSED).length, 2);
  f.watched.add('two');
  await f.engine.syncScreenSubscriptions();
  const audio = f.engine['consumers'].get('system-audio');
  const videoOne = f.engine['consumers'].get('video-one')!;
  const videoTwo = f.engine['consumers'].get('video-two')!;
  f.watched.delete('one');
  await f.engine.syncScreenSubscriptions();
  assert.equal(f.engine['consumers'].has('video-one'), false);
  assert.equal(f.engine['consumers'].get('system-audio'), audio);
  assert.ok(f.sent.some(message => message.type === MessageType.SFU_CONSUMER_CLOSED
    && (message.payload as { consumerId: string }).consumerId === videoOne.id));
  f.watched.delete('two');
  await f.engine.syncScreenSubscriptions();
  assert.equal(f.engine['consumers'].has('system-audio'), false);
  assert.equal(f.engine['consumers'].has('mic'), true);
  assert.equal(f.engine['consumers'].has('camera'), true);
  assert.ok(f.closed.includes(videoTwo.id));
  assert.equal(f.sent.some(message => message.type === MessageType.SFU_PRODUCER_CLOSED), false,
    'a viewer never closes the publisher or other viewers');
});

test('screen SFU cancellation before consume response closes the paused server consumer without consuming or resuming', async t => {
  const f = sfuFixture(t);
  f.watched.add('one');
  const pending = gate();
  f.delayResponse(() => pending.promise);
  const consuming = f.engine['consumeRemoteProducer'](f.producers[0]);
  f.watched.clear();
  await f.engine.syncScreenSubscriptions();
  pending.release();
  await consuming;
  assert.deepEqual(f.remoteTracks, []);
  assert.deepEqual(f.sent.map(message => message.type), [MessageType.SFU_CONSUMER_CLOSED]);
  assert.equal(f.engine['consumers'].size, 0);
});

test('screen SFU Stop during client SDP setup closes both sides and a subsequent Watch gets a distinct consumer', async t => {
  const f = sfuFixture(t);
  f.watched.add('one');
  const entered = gate(), pending = gate();
  f.delayConsume(async () => { entered.release(); await pending.promise; });
  const consuming = f.engine['consumeRemoteProducer'](f.producers[0]);
  await entered.promise;
  f.watched.clear();
  await f.engine.syncScreenSubscriptions();
  f.watched.add('one');
  f.delayConsume(async () => {});
  await f.engine.syncScreenSubscriptions();
  const current = f.engine['consumers'].get('video-one')!;
  pending.release();
  await consuming;
  assert.equal(f.engine['consumers'].get('video-one'), current);
  assert.ok(f.sent.some(message => message.type === MessageType.SFU_CONSUMER_CLOSED
    && (message.payload as { consumerId: string }).consumerId !== current.id));
  assert.deepEqual(f.remoteTracks, ['video-one'], 'the stale setup must never reach playback or resume');
});

test('screen SFU producer removal and transport leave cancel pending consumption without reviving it', async t => {
  const f = sfuFixture(t);
  f.watched.add('one');
  const pending = gate();
  f.delayResponse(() => pending.promise);
  const consuming = f.engine['consumeRemoteProducer'](f.producers[0]);
  f.engine['handleRemoteProducerClosed']('video-one');
  f.engine.leave();
  pending.release();
  await consuming;
  assert.deepEqual(f.remoteTracks, []);
  assert.equal(f.sent.some(message => message.type === MessageType.SFU_CONSUMER_SET_PAUSED), false);
  assert.equal(f.engine['remoteProducers'].size, 0);
  assert.equal(f.engine['pendingConsumers'].size, 0);
});
