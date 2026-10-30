import assert from 'node:assert/strict';
import { after, before, test, type TestContext } from 'node:test';
import { MessageType, type WebRtcSignalPayload } from '@monky/shared';
import { appEvents } from '../src/renderer/core/EventBus';
import { clientLog } from '../src/renderer/core/ClientLogService';
import { NetworkClient } from '../src/renderer/core/NetworkClient';
import { ParticipantManager } from '../src/renderer/core/ParticipantManager';
import { WebRtcManager, type PeerSession } from '../src/renderer/core/WebRtcManager';
import { RtcDiagnosticsCollector } from '../src/renderer/core/webrtc/RtcDiagnosticsCollector';
import { averageRoundTrip, candidateRoute, diagnosticCandidateRoute } from '../src/renderer/core/webrtc/rtcStats';
import { voiceStore } from '../src/renderer/stores/voiceStore';
import { voiceConnectionIndicator } from '../src/renderer/utils/voiceConnection';

function track(id: string, kind: 'audio' | 'video'): MediaStreamTrack {
  let state: MediaStreamTrackState = 'live';
  return {
    id, kind, enabled: true, onended: null,
    get readyState() { return state; },
    stop() { state = 'ended'; },
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

class Sender {
  public parameters: RTCRtpSendParameters;
  constructor(public track: MediaStreamTrack | null, kind: string) {
    this.parameters = {
      transactionId: 'fixture', codecs: [{ mimeType: kind === 'video' ? 'video/VP8' : 'audio/opus',
        payloadType: kind === 'video' ? 96 : 111, clockRate: kind === 'video' ? 90000 : 48000 }],
      headerExtensions: [], rtcp: {}, encodings: [{}],
    };
  }
  getParameters() { return structuredClone(this.parameters); }
  async setParameters(value: RTCRtpSendParameters) { this.parameters = structuredClone(value); }
  async replaceTrack(value: MediaStreamTrack | null) { this.track = value; }
}

interface Transceiver {
  mid: string | null;
  direction: RTCRtpTransceiverDirection;
  sender: Sender;
  receiver: { track: MediaStreamTrack };
  setCodecPreferences(): void;
}

/** Peer connection whose signaling the tests drive by hand. */
class PeerConnection extends EventTarget {
  public static created: PeerConnection[] = [];
  private signaling: RTCSignalingState = 'stable';
  public connectionState: RTCPeerConnectionState = 'new';
  public iceConnectionState: RTCIceConnectionState = 'new';
  public iceGatheringState: RTCIceGatheringState = 'complete';
  public localDescription: RTCSessionDescriptionInit | null = null;
  public remoteDescription: RTCSessionDescriptionInit | null = null;
  public onconnectionstatechange: (() => void) | null = null;
  public transceivers: Transceiver[] = [];
  /** Remote descriptions and candidates in the order they reached the connection. */
  public applied: string[] = [];
  public stats = new Map<string, object>();
  public statsReads = 0;
  public descriptionGate: Promise<void> | null = null;
  public rejectCandidates = false;
  constructor() {
    super();
    PeerConnection.created.push(this);
  }
  get signalingState(): RTCSignalingState { return this.signaling; }
  set signalingState(state: RTCSignalingState) {
    this.signaling = state;
    this.dispatchEvent(new Event('signalingstatechange'));
  }
  addTransceiver(value: string | MediaStreamTrack, init?: RTCRtpTransceiverInit): Transceiver {
    const kind = typeof value === 'string' ? value : value.kind;
    const transceiver: Transceiver = {
      mid: String(this.transceivers.length), direction: init?.direction ?? 'sendrecv',
      sender: new Sender(typeof value === 'string' ? null : value, kind),
      receiver: { track: track(`remote-${kind}-${this.transceivers.length}`, kind === 'audio' ? 'audio' : 'video') },
      setCodecPreferences() {},
    };
    this.transceivers.push(transceiver);
    return transceiver;
  }
  addTrack(value: MediaStreamTrack) { return this.addTransceiver(value).sender; }
  getTransceivers() { return this.transceivers; }
  getSenders() { return this.transceivers.map(entry => entry.sender); }
  getReceivers() { return this.transceivers.map(entry => entry.receiver); }
  async createOffer() { return { type: 'offer', sdp: 'local offer' }; }
  async createAnswer() { return { type: 'answer', sdp: 'local answer' }; }
  async setLocalDescription(description: RTCSessionDescriptionInit) {
    if (description.type === 'rollback') {
      this.signalingState = 'stable';
      this.localDescription = null;
      return;
    }
    this.localDescription = description;
    this.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable';
  }
  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    if (this.descriptionGate) await this.descriptionGate;
    this.remoteDescription = description;
    this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable';
    this.applied.push(`${description.type}:${description.sdp}`);
  }
  async addIceCandidate(candidate: RTCIceCandidateInit) {
    this.applied.push(`candidate:${candidate.candidate}`);
    if (this.rejectCandidates) throw new DOMException('Unknown ICE username fragment', 'OperationError');
  }
  async getStats() {
    this.statsReads++;
    return this.stats;
  }
  close() {
    this.signalingState = 'closed';
    this.connectionState = 'closed';
  }
}

class SessionDescription {
  public readonly type: RTCSdpType;
  public readonly sdp: string;
  constructor(init: RTCSessionDescriptionInit) {
    this.type = init.type;
    this.sdp = init.sdp ?? '';
  }
}

let restoreGlobals: (() => void) | undefined;
before(() => {
  const restore: Array<() => void> = [];
  for (const [name, value] of [
    ['MediaStream', Stream], ['RTCPeerConnection', PeerConnection], ['RTCSessionDescription', SessionDescription],
  ] as const) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    restore.push(() => {
      if (original) Object.defineProperty(globalThis, name, original);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  restoreGlobals = () => { for (const reset of restore.reverse()) reset(); };
});
after(() => restoreGlobals?.());

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
};

function callFixture(t: TestContext) {
  appEvents.clear();
  voiceStore.reset();
  voiceStore.setChannel('room');
  const manager = new WebRtcManager();
  const client = new NetworkClient();
  const participants = new ParticipantManager();
  const sent: Array<{ type: MessageType; payload: unknown }> = [];
  t.mock.method(client, 'send', (type: MessageType, payload: unknown) => { sent.push({ type, payload }); });
  t.mock.method(client, 'getStatus', () => 'CONNECTED' as const);
  Object.defineProperty(manager, 'signalClient', { configurable: true, get: () => client });
  Object.defineProperty(manager, 'voiceParticipants', { configurable: true, get: () => participants });
  t.mock.method(manager['nativeScreens'], 'sync', async () => {});
  t.mock.method(manager['nativeScreens'], 'close', async () => {});
  manager['beginPeerFailureCountdown'] = () => {};
  manager['startConnectionWatchdog'] = () => {};
  manager.setCurrentSessionId('self');
  t.after(() => {
    manager.closeAllPeers();
    manager.setCurrentSessionId('');
    appEvents.clear();
    voiceStore.reset();
    client.dispose();
  });
  const offersTo = (peer: string) => sent.filter(({ payload }) =>
    field(payload, 'signalType') === 'offer' && field(payload, 'targetSessionId') === peer).length;
  const join = async (sessionId: string): Promise<{ session: PeerSession; pc: PeerConnection }> => {
    participants.addUser({ id: sessionId, sessionId, clientId: sessionId, nickname: sessionId, status: 'ONLINE', joinedAt: 1 });
    participants.updateVoiceState({
      sessionId, userId: sessionId, channelId: 'room', isMuted: false, isDeafened: false, serverMuted: false,
      serverDeafened: false, isSpeaking: false, isCameraOn: false, isScreenSharing: false, isSharingScreenAudio: false,
    });
    await manager.connectToPeer(sessionId, false);
    const session = manager['peers'].get(sessionId);
    const pc = PeerConnection.created.at(-1);
    assert.ok(session && pc);
    return { session, pc };
  };
  const signal = (from: string, payload: Partial<WebRtcSignalPayload>) => manager['handleIncomingSignal']({
    fromSessionId: from, targetSessionId: 'self', signalType: 'candidate', ...payload,
  });
  return { manager, client, participants, sent, offersTo, join, signal };
}

function field(payload: unknown, key: string): unknown {
  return typeof payload === 'object' && payload !== null ? Reflect.get(payload, key) : undefined;
}

function cameraTransceiver(pc: PeerConnection): Transceiver {
  const transceiver = pc.transceivers.find(entry => entry.receiver.track.kind === 'video');
  assert.ok(transceiver);
  return transceiver;
}

function within<T>(operation: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    operation,
    new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

function candidate(id: string): RTCIceCandidateInit {
  return { candidate: `candidate:${id} 1 udp 2122260223 192.0.2.1 50000 typ host`, sdpMid: '0' };
}

function routeStats(idle: { rtt: number; local: string }, selected: { rtt: number; local: string }): Map<string, object> {
  // The idle pair succeeded too and is listed first, but carries nothing.
  return new Map<string, object>([
    ['idle-pair', { type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: idle.rtt,
      localCandidateId: 'idle-local', remoteCandidateId: 'remote' }],
    ['idle-local', { type: 'local-candidate', candidateType: idle.local, address: '192.0.2.10', port: 1, protocol: 'udp' }],
    ['selected-pair', { type: 'candidate-pair', state: 'succeeded', nominated: true, currentRoundTripTime: selected.rtt,
      localCandidateId: 'selected-local', remoteCandidateId: 'remote' }],
    ['selected-local', { type: 'local-candidate', candidateType: selected.local, address: '192.0.2.20', port: 2, protocol: 'udp' }],
    ['remote', { type: 'remote-candidate', candidateType: 'host', address: '198.51.100.1', port: 3, protocol: 'udp' }],
    ['transport', { type: 'transport', selectedCandidatePairId: 'selected-pair' }],
  ]);
}

test('the route is read from the pair carrying media, wherever the engine lists it (R-VOICE-6)', () => {
  const stats = routeStats({ rtt: 0.012, local: 'host' }, { rtt: 0.09, local: 'relay' });
  assert.deepEqual(candidateRoute(stats), {
    rttMs: 90, relayed: true,
    local: { type: 'relay', address: '192.0.2.20', port: 2, protocol: 'udp' },
    remote: { type: 'host', address: '198.51.100.1', port: 3, protocol: 'udp' },
  });
  stats.delete('transport');
  assert.equal(candidateRoute(stats)?.rttMs, 90, 'engines without the transport report flag the nominated pair');
  stats.set('selected-pair', { type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.09 });
  assert.equal(candidateRoute(stats), null, 'a pair that merely succeeded is not the one in use');

  const failedLink = new Map<string, object>([
    ['tried', { type: 'candidate-pair', state: 'failed', localCandidateId: 'host', remoteCandidateId: 'remote' }],
    ['nominated', { type: 'candidate-pair', state: 'in-progress', nominated: true,
      localCandidateId: 'relay', remoteCandidateId: 'remote' }],
    ['host', { type: 'local-candidate', candidateType: 'host' }],
    ['relay', { type: 'local-candidate', candidateType: 'relay' }],
    ['remote', { type: 'remote-candidate', candidateType: 'srflx' }],
  ]);
  assert.equal(diagnosticCandidateRoute(failedLink)?.local?.type, 'relay', 'the nominated pair beats one listed earlier');
  failedLink.delete('nominated');
  assert.equal(diagnosticCandidateRoute(failedLink)?.local?.type, 'host', 'a failed attempt is still worth reporting');
  assert.equal(averageRoundTrip([20, null, 41]), 31);
  assert.equal(averageRoundTrip([null]), null);
});

test('the diagnostics report describes the route in use, not the first pair listed (R-VOICE-6)', async t => {
  const f = callFixture(t);
  const { session, pc } = await f.join('peer');
  pc.stats = new Map<string, object>([
    ['failed-first', { type: 'candidate-pair', state: 'failed', localCandidateId: 'idle-local', remoteCandidateId: 'remote' }],
    ...routeStats({ rtt: 0.01, local: 'host' }, { rtt: 0.05, local: 'relay' }),
  ]);
  await new RtcDiagnosticsCollector().sendDiagnosticsReport('peer', session, f.client);
  const report = f.sent.find(({ type }) => type === MessageType.RTC_DIAGNOSTICS_REPORT)?.payload;
  assert.deepEqual(field(report, 'localCandidate'), { type: 'relay', address: '192.0.2.20', port: 2, protocol: 'udp' });
  assert.deepEqual(field(report, 'remoteCandidate'), { type: 'host', address: '198.51.100.1', port: 3, protocol: 'udp' });
});

test('one measurement per cycle feeds every ping view and the relay badges (R-VOICE-6, R-VOICEUI-7)', async t => {
  const f = callFixture(t);
  const relayed = await f.join('relayed');
  const direct = await f.join('direct');
  relayed.pc.connectionState = direct.pc.connectionState = 'connected';
  relayed.pc.stats = routeStats({ rtt: 0.01, local: 'host' }, { rtt: 0.08, local: 'relay' });
  direct.pc.stats = routeStats({ rtt: 0.3, local: 'relay' }, { rtt: 0.04, local: 'host' });
  const stage: Array<number | null> = [];
  const sidebar: Array<number | null> = [];
  appEvents.on('voice.ping_updated', (ping: number | null) => stage.push(ping));
  appEvents.on('voice.ping_updated', (ping: number | null) => sidebar.push(ping));
  t.mock.timers.enable({ apis: ['setInterval'] });
  f.manager['startCallStats']();
  f.manager['startCallStats']();
  await settle();
  assert.deepEqual([relayed.pc.statsReads, direct.pc.statsReads], [1, 1],
    'measured at once, with one getStats per link however many views listen');
  assert.deepEqual(stage, [60], 'the average of the pairs carrying media');
  assert.deepEqual(sidebar, stage, 'the stage and the sidebar show the same sample');
  assert.equal(f.manager.getCallPing(), 60);
  assert.equal(f.participants.get('relayed')?.isRelayed, true);
  assert.equal(f.participants.get('direct')?.isRelayed, false);
  t.mock.timers.tick(2000);
  await settle();
  assert.deepEqual([relayed.pc.statsReads, direct.pc.statsReads], [2, 2], 'a single timer, started once');
  f.manager.closeAllPeers();
  assert.equal(f.manager.getCallPing(), null);
  assert.equal(stage.at(-1), null, 'views stop showing the ping of a call that ended');
});

test('the call is measured from admission, so a link stuck connecting takes the ping out of the solo state', async t => {
  const f = callFixture(t);
  t.mock.method(f.manager, 'isSfuMode', () => false);
  t.mock.timers.enable({ apis: ['setInterval'] });
  f.participants.addUser({ id: 'self', sessionId: 'self', clientId: 'self', nickname: 'self', status: 'ONLINE', joinedAt: 1 });
  f.participants.updateVoiceState({
    sessionId: 'self', userId: 'self', channelId: 'room', isMuted: false, isDeafened: false, serverMuted: false,
    serverDeafened: false, isSpeaking: false, isCameraOn: false, isScreenSharing: false, isSharingScreenAudio: false,
  });
  // What the stage and the sidebar show whenever a sample arrives: alone on P2P
  // is "0 ms"; with anyone else it is the measured ping, or "establishing".
  const shown: string[] = [];
  appEvents.on('voice.ping_updated', () => {
    const alone = f.participants.getInVoiceChannel('room').length <= 1;
    shown.push(voiceConnectionIndicator(alone ? 0 : f.manager.getCallPing()).quality);
  });

  f.manager.resumeAfterVoiceReconnect();
  await settle();
  assert.deepEqual(shown, ['good'], 'admission measures at once: alone, the call shows 0 ms');

  // Somebody joins, but the link never leaves `new`, as behind a NAT without TURN (#426).
  const { pc } = await f.join('peer');
  t.mock.timers.tick(2000);
  await settle();
  assert.equal(shown.at(-1), 'unknown', 'within one sample the views leave the solo state for "establishing"');
  t.mock.timers.tick(2500);
  await settle();
  assert.equal(shown.length, 3, 'the views keep being refreshed while the link is stuck');
  assert.equal(pc.statsReads, 0, 'a link that never connected is not measured');

  // The link connects: its ping shows at once instead of one interval later.
  pc.stats = routeStats({ rtt: 0.3, local: 'relay' }, { rtt: 0.04, local: 'host' });
  pc.connectionState = 'connected';
  pc.onconnectionstatechange?.();
  await settle();
  assert.equal(f.manager.getCallPing(), 40);
  assert.equal(shown.at(-1), 'good');

  f.manager.closeAllPeers();
  const ended = shown.length;
  t.mock.timers.tick(4000);
  await settle();
  assert.equal(shown.length, ended, 'the measurement stops with the call');
});

test('a server settings change during an SFU join or rejoin never "migrates" the call (R-VOICE-3)', async t => {
  const f = callFixture(t);
  let voiceMode = 'sfu';
  Object.defineProperty(f.manager, 'voiceServerStore', { configurable: true, get: () => ({ serverDetails: { voiceMode } }) });
  const teardowns = t.mock.method(f.manager, 'closeAllPeers');
  const joins = t.mock.method(f.manager, 'initSfuForCurrentChannel', async () => {});
  const switched: unknown[] = [];
  appEvents.on('voice.mode_switched', event => switched.push(event));

  // The SFU call was admitted, but its engine is still joining (or between rejoin rungs).
  f.manager.resumeAfterVoiceReconnect();
  f.manager['sfuReconnectAttempts'] = 2;
  assert.equal(f.manager['sfuEngine'].isReady(), false);
  await f.manager.handleVoiceModeUpdate();
  appEvents.emit('server.meta_updated', {});
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(teardowns.mock.callCount(), 0, 'peers, screens and cameras survive the settings change');
  assert.equal(joins.mock.callCount(), 0, 'no extra join cuts through the backoff');
  assert.equal(f.manager['sfuReconnectAttempts'], 2, 'the rejoin ladder keeps its count');
  assert.deepEqual(switched, []);

  // A call that really runs on P2P still moves to the SFU, once.
  voiceMode = 'p2p';
  f.manager.closeAllPeers();
  f.manager.resumeAfterVoiceReconnect();
  voiceMode = 'sfu';
  const before = teardowns.mock.callCount();
  await f.manager.handleVoiceModeUpdate();
  assert.equal(teardowns.mock.callCount(), before + 1);
  assert.equal(joins.mock.callCount(), 1);
  assert.deepEqual(switched, [{ mode: 'sfu' }]);
  await f.manager.handleVoiceModeUpdate();
  assert.equal(joins.mock.callCount(), 1, 'the migrated call already runs on the SFU');
});

test('a peer that never answers holds up the camera only on its own link (R-VOICE-4)', async t => {
  const f = callFixture(t);
  t.mock.method(f.manager, 'isSfuMode', () => false);
  const healthy = await f.join('healthy');
  const stuck = await f.join('stuck');
  const failed = await f.join('failed');
  // The camera was on and off already; the last offer to `stuck` was never answered.
  for (const peer of [healthy, stuck, failed]) cameraTransceiver(peer.pc).direction = 'recvonly';
  stuck.pc.signalingState = 'have-local-offer';
  failed.pc.connectionState = 'failed';

  const camera = track('camera', 'video');
  await within(f.manager.setLocalCameraTrack(camera), 1000, 'the camera waited on a peer that is not answering');
  for (const peer of [healthy, stuck, failed]) {
    assert.equal(cameraTransceiver(peer.pc).direction, 'sendrecv');
    assert.equal(cameraTransceiver(peer.pc).sender.track, camera);
  }
  assert.equal(f.offersTo('healthy'), 1, 'a healthy peer is told right away');
  assert.equal(f.offersTo('stuck'), 0);
  assert.equal(f.offersTo('failed'), 0, 'a failed link is left to its recovery');
  assert.equal(stuck.session.negotiationNeeded, true);
  assert.equal(failed.session.negotiationNeeded, true);

  // The stuck link settles: the change goes out on it, and on it alone.
  await f.signal('stuck', { signalType: 'answer', sdp: { type: 'answer', sdp: 'remote answer' }, subscriptionId: 'remote' });
  assert.equal(f.offersTo('stuck'), 1);
  assert.equal(stuck.session.negotiationNeeded, false);
  // The failed link comes back and renegotiates what it missed.
  failed.pc.connectionState = 'connected';
  failed.pc.onconnectionstatechange?.();
  await settle();
  assert.equal(f.offersTo('failed'), 1);
  assert.equal(f.offersTo('healthy'), 1);

  // Turning the camera off is not held up by the links still awaiting answers either.
  await within(f.manager.setLocalCameraTrack(null), 1000, 'turning the camera off waited on a stuck peer');
  for (const peer of [healthy, stuck, failed]) {
    assert.equal(cameraTransceiver(peer.pc).direction, 'recvonly');
    assert.equal(cameraTransceiver(peer.pc).sender.track, null);
  }
});

test('a bot still waiting for its own offer does not fail a microphone switch for everyone (R-VOICE-4)', async t => {
  const f = callFixture(t);
  t.mock.method(f.manager, 'isSfuMode', () => false);
  const human = await f.join('human');
  f.participants.addUser({ id: 'bot', sessionId: 'bot:listener', clientId: 'bot:listener', nickname: 'Bot',
    status: 'ONLINE', joinedAt: 1, isBot: true });
  f.participants.updateVoiceState({
    sessionId: 'bot:listener', userId: 'bot', channelId: 'room', receivesVoice: true, isMuted: true, isDeafened: false,
    serverMuted: false, serverDeafened: false, isSpeaking: false, isCameraOn: false, isScreenSharing: false,
    isSharingScreenAudio: false,
  });
  await f.manager.connectToPeer('bot:listener', false);
  const microphone = track('microphone', 'audio');
  await f.manager.replaceMicrophoneTrack(microphone, new AbortController().signal);
  assert.equal(human.pc.transceivers.find(entry => entry.receiver.track.kind === 'audio')?.sender.track, microphone);
  assert.equal(f.manager['localAudioTrack'], microphone);
});

test('ICE candidates wait behind their description, are bounded and fail visibly (R-VOICE-7)', async t => {
  const f = callFixture(t);
  t.mock.method(f.manager, 'isSfuMode', () => false);
  const warnings = t.mock.method(clientLog, 'warn', () => {});
  const dropped = () => warnings.mock.calls.filter(call => String(call.arguments[1]).startsWith('Dropping ICE')).length;
  const { session, pc } = await f.join('peer');

  for (let i = 0; i < 300; i++) await f.signal('peer', { signalType: 'candidate', candidate: candidate(`early-${i}`) });
  assert.equal(session.candidateQueue.length, 256, 'candidates before any description are bounded');
  assert.equal(dropped(), 1, 'the overflow is logged once');

  await f.signal('peer', { signalType: 'offer', sdp: { type: 'offer', sdp: 'first' }, subscriptionId: 'remote' });
  assert.equal(pc.applied[0], 'offer:first');
  assert.equal(pc.applied.filter(entry => entry.startsWith('candidate:')).length, 256);
  assert.equal(session.candidateQueue.length, 0);

  // A renegotiation (say, an ICE restart) still applying when its candidate arrives.
  let release = () => {};
  pc.descriptionGate = new Promise<void>(resolve => { release = resolve; });
  const restart = f.signal('peer', { signalType: 'offer', sdp: { type: 'offer', sdp: 'restart' }, subscriptionId: 'remote' });
  const late = f.signal('peer', { signalType: 'candidate', candidate: candidate('restart') });
  await settle();
  assert.equal(pc.applied.some(entry => entry.includes('candidate:restart')), false,
    'a candidate never reaches the connection ahead of the offer it follows');
  pc.descriptionGate = null;
  release();
  await Promise.all([restart, late]);
  const applied = pc.applied.slice(-2);
  assert.equal(applied[0], 'offer:restart');
  assert.match(applied[1] ?? '', /candidate:restart/);

  pc.rejectCandidates = true;
  await f.signal('peer', { signalType: 'candidate', candidate: candidate('rejected') });
  const failure = warnings.mock.calls.find(call => String(call.arguments[1]).startsWith('Could not apply an ICE candidate'));
  assert.ok(failure, 'a real ICE failure is logged, not swallowed');
  assert.equal(failure.arguments[2]?.type, 'host');
  assert.equal(failure.arguments[2]?.sdpMid, '0');
  const logged = warnings.mock.callCount();
  // An impolite peer keeps its own offer: candidates of the dropped one are expected to fail.
  session.isPolite = false;
  session.makingOffer = true;
  await f.signal('peer', { signalType: 'offer', sdp: { type: 'offer', sdp: 'colliding' }, subscriptionId: 'remote' });
  assert.equal(session.ignoreOffer, true);
  await f.signal('peer', { signalType: 'candidate', candidate: candidate('collision') });
  assert.equal(warnings.mock.callCount(), logged);

  const waiting = await f.join('waiting');
  await f.signal('waiting', { signalType: 'candidate', candidate: candidate('pending') });
  assert.equal(waiting.session.candidateQueue.length, 1);
  f.manager.removePeer('waiting');
  assert.equal(waiting.session.candidateQueue.length, 0, 'leaving drops the queue with the link');
});

test('an SFU rejoin with a dead microphone stays listen-only instead of rejoining forever (R-VOICE-12)', async t => {
  const f = callFixture(t);
  t.mock.method(f.manager, 'isSfuMode', () => true);
  const engine = f.manager['sfuEngine'];
  t.mock.method(engine, 'join', async () => true);
  t.mock.method(engine, 'canProduceKind', () => true);
  let produced = 0;
  Object.defineProperties(engine, {
    channelId: { configurable: true, writable: true, value: 'room' },
    sendTransport: { configurable: true, writable: true, value: {
      close() {},
      async produce() { produced++; throw new DOMException('track ended', 'InvalidStateError'); },
    } },
  });
  let failures = 0;
  const handleFailure = f.manager['handleSfuConnectionFailure'].bind(f.manager);
  f.manager['handleSfuConnectionFailure'] = (reason: string) => { failures++; handleFailure(reason); };
  const notices: unknown[] = [];
  appEvents.on('voice.microphone_failed', notice => notices.push(notice));
  const microphone = track('microphone', 'audio');
  microphone.stop();
  f.manager['localAudioTrack'] = microphone;

  await f.manager['performSfuJoin']();
  assert.equal(failures, 0, 'a dead capture track is not a broken link');
  assert.equal(f.manager['sfuReconnectTimer'], null, 'no rejoin is scheduled');
  assert.equal(produced, 0, 'the dead track is not offered to the server');
  assert.equal(f.manager['localAudioTrack'], null, 'a device change can publish a fresh microphone afterwards');
  assert.equal(notices.length, 1, 'the user is told the microphone stopped');
});
