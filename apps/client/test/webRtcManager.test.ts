import assert from 'node:assert/strict';
import { after, before, test, type TestContext } from 'node:test';
import { MessageType, QUALITY_PRESETS, type WebRtcSignalPayload } from '@monky/shared';
import { appEvents } from '../src/renderer/core/EventBus';
import { clientLog } from '../src/renderer/core/ClientLogService';
import { getActiveNetworkClient, NetworkClient, setActiveNetworkClient } from '../src/renderer/core/NetworkClient';
import { ParticipantManager } from '../src/renderer/core/ParticipantManager';
import { SessionManager, sessionManager } from '../src/renderer/core/SessionManager';
import { WebRtcManager } from '../src/renderer/core/WebRtcManager';
import type { PeerLink } from '../src/renderer/core/webrtc/p2p/PeerLink';
import type { RemoteMediaKind, RemoteTrack } from '../src/renderer/core/webrtc/RemoteMediaSink';
import { RtcDiagnosticsCollector } from '../src/renderer/core/webrtc/RtcDiagnosticsCollector';
import { averageRoundTrip, candidateRoute, diagnosticCandidateRoute } from '../src/renderer/core/webrtc/rtcStats';
import type { VoiceTransport } from '../src/renderer/core/webrtc/VoiceTransport';
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
  public oniceconnectionstatechange: (() => void) | null = null;
  public onicecandidate: ((event: { candidate: RTCIceCandidateInit | null }) => void) | null = null;
  public ontrack: ((event: { track: MediaStreamTrack; receiver: { track: MediaStreamTrack } }) => void) | null = null;
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

/** Links never time out in these tests: the recovery ladder is exercised on its own. */
function quietRecovery(manager: WebRtcManager): void {
  const recovery = manager['p2p']['recovery'];
  recovery['beginFailureCountdown'] = () => {};
  recovery['watch'] = () => {};
}

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
  quietRecovery(manager);
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
  const join = async (sessionId: string): Promise<{ session: PeerLink; pc: PeerConnection }> => {
    participants.addUser({ id: sessionId, sessionId, clientId: sessionId, nickname: sessionId, status: 'ONLINE', joinedAt: 1 });
    participants.updateVoiceState({
      sessionId, userId: sessionId, channelId: 'room', isMuted: false, isDeafened: false, serverMuted: false,
      serverDeafened: false, isSpeaking: false, isCameraOn: false, isScreenSharing: false, isSharingScreenAudio: false,
    });
    await manager.connectToPeer(sessionId, false);
    const session = manager['p2p'].peers.get(sessionId);
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
  f.manager['sfu']['attempts'] = 2;
  assert.equal(f.manager['sfu'].engine.isReady(), false);
  await f.manager.handleVoiceModeUpdate();
  appEvents.emit('server.meta_updated', {
    id: 'server', name: 'Server', createdAt: 1, maxUsers: 10, members: [], voiceStates: {}, channels: [], voiceMode: 'sfu',
  });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(teardowns.mock.callCount(), 0, 'peers, screens and cameras survive the settings change');
  assert.equal(joins.mock.callCount(), 0, 'no extra join cuts through the backoff');
  assert.equal(f.manager['sfu'].reconnectAttempts, 2, 'the rejoin ladder keeps its count');
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
  const sfu = f.manager['sfu'];
  const engine = sfu.engine;
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
  const handleFailure = sfu['connectionFailed'].bind(sfu);
  sfu['connectionFailed'] = (reason: string) => { failures++; handleFailure(reason); };
  const notices: unknown[] = [];
  appEvents.on('voice.microphone_failed', notice => notices.push(notice));
  const microphone = track('microphone', 'audio');
  microphone.stop();
  f.manager['localAudioTrack'] = microphone;

  await sfu['join']();
  assert.equal(failures, 0, 'a dead capture track is not a broken link');
  assert.equal(sfu['reconnectTimer'], null, 'no rejoin is scheduled');
  assert.equal(produced, 0, 'the dead track is not offered to the server');
  assert.equal(f.manager['localAudioTrack'], null, 'a device change can publish a fresh microphone afterwards');
  assert.equal(notices.length, 1, 'the user is told the microphone stopped');
});

test('a call whose server session is gone signals nobody, never the server on screen (R-VOICE-8)', async t => {
  appEvents.clear();
  voiceStore.reset();
  const sessions = new SessionManager();
  const call = sessions.create('rtc-call.invalid', 10301, 'Self');
  const visible = sessions.create('rtc-visible.invalid', 10302, 'Self');
  const available = new Map([[call.key, call], [visible.key, visible]]);
  t.mock.method(sessionManager, 'get', (key: string) => available.get(key));
  t.mock.method(sessionManager, 'getActive', () => visible);
  // The global proxies follow the server on screen, as after activating it.
  const previousClient = getActiveNetworkClient();
  setActiveNetworkClient(visible.client);
  const sent: string[] = [];
  for (const session of [call, visible]) {
    t.mock.method(session.client, 'send', (type: MessageType) => { sent.push(`${session.key} ${type}`); });
  }
  voiceStore.setChannel('room', call.key);
  const manager = new WebRtcManager();
  t.mock.method(manager['nativeScreens'], 'sync', async () => {});
  t.mock.method(manager['nativeScreens'], 'close', async () => {});
  quietRecovery(manager);
  manager.setCurrentSessionId('self');
  t.after(() => {
    manager.closeAllPeers();
    setActiveNetworkClient(previousClient);
    appEvents.clear();
    voiceStore.reset();
  });
  call.participants.addUser({ id: 'peer', sessionId: 'peer', clientId: 'peer', nickname: 'Peer', status: 'ONLINE', joinedAt: 1 });
  call.participants.updateVoiceState({
    sessionId: 'peer', userId: 'peer', channelId: 'room', isMuted: false, isDeafened: false, serverMuted: false,
    serverDeafened: false, isSpeaking: false, isCameraOn: false, isScreenSharing: false, isSharingScreenAudio: false,
  });
  await manager.connectToPeer('peer', false);
  const pc = PeerConnection.created.at(-1);
  assert.ok(pc?.onicecandidate);
  pc.onicecandidate({ candidate: candidate('while-connected') });
  assert.deepEqual(sent, [`${call.key} ${MessageType.RTC_SIGNAL}`], 'signalling goes to the call server');

  available.delete(call.key);
  pc.onicecandidate({ candidate: candidate('after-removal') });
  assert.deepEqual(sent, [`${call.key} ${MessageType.RTC_SIGNAL}`], 'the visible server never gets the call signalling');
});

test('peer links and SFU consumers hand their tracks to one sink, in the same shape (R-VOICE-5)', async t => {
  const f = callFixture(t);
  t.mock.method(f.manager, 'isSfuMode', () => false);
  const sink = f.manager['remoteMedia'];
  const arrived = t.mock.method(sink, 'trackArrived', (_remote: RemoteTrack) => {});
  const unmuted = t.mock.method(sink, 'trackUnmuted', (_peer: string, _kind: RemoteMediaKind, _track: MediaStreamTrack) => {});
  const ended = t.mock.method(sink, 'trackEnded', (_peer: string, _kind: RemoteMediaKind, _track: MediaStreamTrack) => {});
  const { pc } = await f.join('peer');

  const microphone = track('microphone', 'audio');
  const receiver = { track: microphone };
  pc.ontrack?.({ track: microphone, receiver });
  const camera = track('camera', 'video');
  pc.ontrack?.({ track: camera, receiver: { track: camera } });
  camera.onunmute?.(new Event('unmute'));
  camera.onended?.(new Event('ended'));
  const [p2pMic] = arrived.mock.calls.map(call => call.arguments[0]);
  assert.equal(p2pMic?.receiver?.(), receiver, 'voice activity reads the receiver of the current link');

  const consumer = track('consumer', 'video');
  const callbacks = f.manager['sfu'].engine['callbacks'];
  callbacks.onConsumerTrack({
    producerSessionId: 'peer', kind: 'video', mediaType: 'camera', track: consumer, consumerId: 'c', producerId: 'p',
  });
  callbacks.onConsumerClosed('peer', 'camera', consumer);

  assert.deepEqual(arrived.mock.calls.map(({ arguments: [remote] }) => [remote.peerSessionId, remote.kind, remote.track.id]),
    [['peer', 'mic', 'microphone'], ['peer', 'camera', 'camera'], ['peer', 'camera', 'consumer']]);
  assert.deepEqual(unmuted.mock.calls.map(call => call.arguments), [['peer', 'camera', camera]]);
  assert.deepEqual(ended.mock.calls.map(call => call.arguments), [['peer', 'camera', camera], ['peer', 'camera', consumer]]);

  f.manager.removePeer('peer');
  assert.equal(p2pMic?.receiver?.(), null, 'a removed link reads nothing');
  camera.onended?.(new Event('ended'));
  assert.equal(ended.mock.callCount(), 2, 'a removed link reports nothing');
});

test('ICE and the connection dropping together give a link one grace period, then one recovery (R-VOICE-2)', async t => {
  const f = callFixture(t);
  t.mock.method(f.manager, 'isSfuMode', () => false);
  const { pc } = await f.join('peer');
  const recovered: string[] = [];
  f.manager['p2p']['recovery']['recover'] = (_link: PeerLink, reason: string) => { recovered.push(reason); };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  pc.iceConnectionState = 'disconnected';
  pc.oniceconnectionstatechange?.();
  pc.connectionState = 'disconnected';
  pc.onconnectionstatechange?.();
  t.mock.timers.tick(3999);
  assert.deepEqual(recovered, [], 'a brief drop is waited out');
  t.mock.timers.tick(1);
  assert.deepEqual(recovered, ['ice_disconnected'], 'one grace for both states, one recovery');

  pc.iceConnectionState = 'connected';
  pc.oniceconnectionstatechange?.();
  pc.iceConnectionState = 'disconnected';
  pc.oniceconnectionstatechange?.();
  pc.iceConnectionState = 'connected';
  t.mock.timers.tick(4000);
  assert.deepEqual(recovered, ['ice_disconnected'], 'a link that came back is not recovered');
});

test('a link that never connected is flagged the moment ICE gives up; one that worked waits (#426)', async t => {
  const f = callFixture(t);
  t.mock.method(f.manager, 'isSfuMode', () => false);
  f.manager['p2p']['recovery']['recover'] = () => {};
  const failed: unknown[] = [];
  appEvents.on('remote.peer_failed', event => failed.push(event));
  const fresh = await f.join('fresh');
  fresh.pc.iceConnectionState = 'failed';
  fresh.pc.oniceconnectionstatechange?.();
  assert.deepEqual(failed, [{ sessionId: 'fresh' }]);
  assert.equal(f.participants.get('fresh')?.peerConnectionFailed, true);
  await settle();
  assert.ok(f.sent.some(({ type }) => type === MessageType.RTC_DIAGNOSTICS_REPORT), 'the server gets what the link tried');

  const seasoned = await f.join('seasoned');
  seasoned.pc.connectionState = 'connected';
  seasoned.pc.onconnectionstatechange?.();
  seasoned.pc.iceConnectionState = 'failed';
  seasoned.pc.oniceconnectionstatechange?.();
  assert.equal(failed.length, 1, 'a link that worked before waits out its grace');
  f.manager.removePeer('fresh');
  assert.equal(f.participants.get('fresh')?.peerConnectionFailed, false, 'the warning leaves with the link (#466)');
});

test('a hard reconnect retires the dead link like any other teardown and rebuilds it with its attempts (R-VOICE-2)', async t => {
  const f = callFixture(t);
  t.mock.method(f.manager, 'isSfuMode', () => false);
  const first = await f.join('peer');
  first.session.reconnectAttempts = 1;
  await f.signal('peer', { signalType: 'candidate', candidate: candidate('early') });
  assert.equal(first.session.candidateQueue.length, 1);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rebuilding = f.manager['p2p']['recovery']['hardReconnect']('peer');
  assert.equal(first.pc.signalingState, 'closed');
  assert.equal(first.pc.onconnectionstatechange, null, 'the dead link stops reacting before it closes');
  assert.equal(first.pc.oniceconnectionstatechange, null);
  assert.equal(first.session.candidateQueue.length, 0);
  assert.equal(f.manager['p2p'].peers.has('peer'), false);
  t.mock.timers.tick(2000);
  await rebuilding;
  const rebuilt = f.manager['p2p'].peers.get('peer');
  assert.ok(rebuilt && rebuilt !== first.session, 'a new link replaces it');
  assert.equal(rebuilt.reconnectAttempts, 2, 'the ladder keeps counting across rebuilds');
});

test('a quality the native shares refuse is reported with a reason the user has a message for (R-SHELL-8)', async t => {
  const f = callFixture(t);
  const notices: unknown[] = [];
  appEvents.on('native_screen.source_failed', notice => notices.push(notice));
  t.mock.method(f.manager['nativeScreens'], 'report', () => {});
  const refusals = [
    Object.assign(new Error('AMF level'), { code: 'ERR_SCREEN_CAPTURE_AMF_LEVEL_UNSUPPORTED' }),
    new Error('Native runtime gone'),
  ];
  t.mock.method(f.manager['nativeScreens'], 'applyQuality', async () => { throw refusals.shift(); });

  assert.equal(await f.manager.setQualityPreset('NORMAL'), null);
  assert.equal(await f.manager.setQualityPreset('NORMAL'), null);
  // The same reasons the native runtime reports, each with a translated notice; "runtime" had none.
  assert.deepEqual(notices, [{ reason: 'unsupported' }, { reason: 'connection-failed' }]);
});

test('the facade hands each media operation to the transport its server runs (R-VOICE-2)', async t => {
  const f = callFixture(t);
  let sfu = false;
  t.mock.method(f.manager, 'isSfuMode', () => sfu);
  const calls: string[] = [];
  for (const mode of ['p2p', 'sfu'] as const) {
    const transport: VoiceTransport = f.manager[mode];
    t.mock.method(transport, 'addParticipant', async () => { calls.push(`${mode} addParticipant`); });
    t.mock.method(transport, 'setMicrophone', async () => { calls.push(`${mode} setMicrophone`); });
    t.mock.method(transport, 'replaceMicrophone', async () => {
      calls.push(`${mode} replaceMicrophone`);
      return async () => {};
    });
    t.mock.method(transport, 'setCamera', async () => { calls.push(`${mode} setCamera`); });
    t.mock.method(transport, 'cameraSenders', () => { calls.push(`${mode} cameraSenders`); return []; });
    t.mock.method(transport, 'receiverForTrack', () => { calls.push(`${mode} receiverForTrack`); return null; });
  }
  const closedCamera = t.mock.method(f.manager['sfu'], 'closeCamera', () => {});
  const operate = async () => {
    await f.manager.connectToPeer('peer', true);
    await f.manager.setLocalAudioTrack(track('microphone', 'audio'));
    await f.manager.replaceMicrophoneTrack(track('headset', 'audio'), new AbortController().signal);
    await f.manager.setLocalCameraTrack(track('camera', 'video'));
    await f.manager.setLocalCameraTrack(null);
    f.manager.getCameraSenders();
    f.manager.getReceiverForTrack('peer', 'remote');
  };

  await operate();
  sfu = true;
  await operate();
  const operations = (mode: string, stop: string[]) => [
    `${mode} addParticipant`, `${mode} setMicrophone`, `${mode} replaceMicrophone`, `${mode} setCamera`,
    ...stop, `${mode} cameraSenders`, `${mode} receiverForTrack`,
  ];
  assert.deepEqual(calls, [...operations('p2p', ['p2p setCamera']), ...operations('sfu', [])],
    'every operation reaches only the transport of the call; on the SFU a stop is the close of its camera');
  assert.equal(closedCamera.mock.callCount(), 2, 'a stop closes the SFU camera whatever the transport');
});

/**
 * One transport under the VoiceTransport contract, with what the other side
 * receives from it: the same assertions run against the P2P mesh and the SFU
 * session (R-VOICE-2).
 */
interface TransportUnderTest {
  transport: VoiceTransport;
  /** The camera and microphone the other side receives from us. */
  camera(): MediaStreamTrack | null;
  microphone(): MediaStreamTrack | null;
  microphoneSender(): Pick<RTCRtpSender, 'getParameters'> | null;
  /** A track the transport receives, with its receiver. */
  remote: { peerSessionId: string; trackId: string; receiver: unknown };
  /** The media path reports this round trip from now on. */
  measure(ms: number): void;
}

/** A call on the mesh with one person, linked while publishing `microphone`. */
async function meshUnderTest(t: TestContext, microphone: MediaStreamTrack): Promise<TransportUnderTest> {
  const f = callFixture(t);
  t.mock.method(f.manager, 'isSfuMode', () => false);
  f.manager['localAudioTrack'] = microphone;
  const { pc } = await f.join('peer');
  const audio = pc.transceivers.find(entry => entry.receiver.track.kind === 'audio');
  assert.ok(audio);
  return {
    transport: f.manager['p2p'],
    camera: () => cameraTransceiver(pc).sender.track,
    microphone: () => audio.sender.track,
    microphoneSender: () => audio.sender,
    remote: { peerSessionId: 'peer', trackId: audio.receiver.track.id, receiver: audio.receiver },
    measure: ms => {
      pc.connectionState = 'connected';
      pc.stats = routeStats({ rtt: 0.5, local: 'host' }, { rtt: ms / 1000, local: 'host' });
    },
  };
}

/** What mediasoup hands back for a published track: a producer on its own RTP sender. */
class Producer {
  private static created = 0;
  public readonly id = `producer-${++Producer.created}`;
  public readonly rtpSender: Sender;
  public closed = false;
  constructor(public track: MediaStreamTrack) {
    this.rtpSender = new Sender(track, track.kind);
  }
  on() {}
  close() { this.closed = true; }
  async replaceTrack({ track: value }: { track: MediaStreamTrack | null }) {
    if (!value) throw new Error('the fixture never pauses a producer');
    this.track = value;
    await this.rtpSender.replaceTrack(value);
  }
}

/** A call on the SFU already in its room, publishing `microphone` and receiving one consumer. */
async function sfuUnderTest(t: TestContext, microphone: MediaStreamTrack): Promise<TransportUnderTest> {
  const f = callFixture(t);
  t.mock.method(f.manager, 'isSfuMode', () => true);
  const engine = f.manager['sfu'].engine;
  const sendTransport = {
    id: 'send',
    connectionState: 'new' as RTCPeerConnectionState,
    stats: new Map<string, object>(),
    async produce({ track: value }: { track: MediaStreamTrack }) { return new Producer(value); },
    async getStats() { return sendTransport.stats; },
    close() {},
  };
  const consumed = track('consumer', 'audio');
  const receiver = { track: consumed };
  Object.defineProperties(engine, {
    isInitialized: { configurable: true, writable: true, value: true },
    channelId: { configurable: true, writable: true, value: 'room' },
    device: { configurable: true, writable: true, value: { loaded: true, canProduce: () => true, sendRtpCapabilities: { codecs: [] } } },
    sendTransport: { configurable: true, writable: true, value: sendTransport },
    recvTransport: { configurable: true, writable: true, value: { id: 'recv', connectionState: 'new', close() {} } },
    consumers: { configurable: true, writable: true, value: new Map([
      ['remote-producer', { id: 'consumer', track: consumed, rtpReceiver: receiver, close() {} }],
    ]) },
  });
  assert.ok(await engine.produceMic(microphone));
  return {
    transport: f.manager['sfu'],
    camera: () => engine.getCameraTrack(),
    microphone: () => engine['producers'].get('mic')?.track ?? null,
    microphoneSender: () => engine['producers'].get('mic')?.rtpSender ?? null,
    remote: { peerSessionId: 'peer', trackId: consumed.id, receiver },
    measure: ms => {
      sendTransport.connectionState = 'connected';
      sendTransport.stats = routeStats({ rtt: 0.5, local: 'host' }, { rtt: ms / 1000, local: 'host' });
    },
  };
}

const cancelled = () => { throw new DOMException('cancelled', 'AbortError'); };
const live = () => {};

for (const [mode, open] of [['p2p', meshUnderTest], ['sfu', sfuUnderTest]] as const) {
  test(`VoiceTransport (${mode}): publishes, switches and takes off the camera on the senders it reports`, async t => {
    const subject = await open(t, track('microphone', 'audio'));
    assert.equal(subject.transport.mode, mode);
    assert.equal(subject.camera(), null);
    const first = track('camera', 'video');
    await subject.transport.setCamera(first, live);
    assert.equal(subject.camera(), first);
    const senders = subject.transport.cameraSenders();
    assert.ok(senders.length > 0 && senders.every(sender => sender.track === first), 'the stats read what is on air');

    const second = track('effects', 'video');
    await subject.transport.setCamera(second, live);
    assert.equal(subject.camera(), second);
    assert.deepEqual(subject.transport.cameraSenders(), senders, 'a switch replaces the track on the same senders');

    await subject.transport.detachCamera(first);
    assert.equal(subject.camera(), second, 'a camera that is no longer published has nothing to detach');
    await subject.transport.detachCamera(second);
    assert.equal(subject.camera(), null);
    assert.ok(subject.transport.cameraSenders().every(sender => !sender.track));
    assert.equal(subject.microphone()?.id, 'microphone', 'the microphone stays on air');
  });

  test(`VoiceTransport (${mode}): a stop takes the camera off the air, and a cancelled start publishes nothing`, async t => {
    const subject = await open(t, track('microphone', 'audio'));
    await assert.rejects(subject.transport.setCamera(track('camera', 'video'), cancelled), { name: 'AbortError' });
    assert.equal(subject.camera(), null);
    assert.ok(subject.transport.cameraSenders().every(sender => !sender.track));

    await subject.transport.setCamera(track('camera', 'video'), live);
    await subject.transport.setCamera(null, live);
    assert.equal(subject.camera(), null);
    assert.ok(subject.transport.cameraSenders().every(sender => !sender.track));
  });

  test(`VoiceTransport (${mode}): a microphone switch is one change that can be undone`, async t => {
    const previous = track('microphone', 'audio');
    const subject = await open(t, previous);
    const headset = track('headset', 'audio');
    const sameSession = () => true;
    const rollback = await subject.transport.replaceMicrophone({ track: headset, previous, ensureCurrent: live, sameSession });
    assert.equal(subject.microphone(), headset);
    await rollback();
    assert.equal(subject.microphone(), previous);

    // Cancelled once the new microphone is on air: the previous one goes back.
    const ensureCurrent = () => { if (subject.microphone() === headset) cancelled(); };
    await assert.rejects(subject.transport.replaceMicrophone({ track: headset, previous, ensureCurrent, sameSession }),
      { name: 'AbortError' });
    assert.equal(subject.microphone(), previous);
  });

  test(`VoiceTransport (${mode}): the quality policy reaches every published sender unless a newer one won`, async t => {
    const subject = await open(t, track('microphone', 'audio'));
    await subject.transport.setCamera(track('camera', 'video'), live);
    const [camera] = subject.transport.cameraSenders();
    const encoding = (sender: Pick<RTCRtpSender, 'getParameters'> | null | undefined) =>
      sender?.getParameters().encodings[0];
    const profile = { ...QUALITY_PRESETS.NORMAL, audioBitrateKbps: 55, cameraBitrateKbps: 777, cameraFps: 17 };
    await subject.transport.applyQuality('CUSTOM', profile, () => false);
    assert.deepEqual([encoding(subject.microphoneSender()), encoding(camera)], [{}, {}]);

    await subject.transport.applyQuality('CUSTOM', profile, () => true);
    assert.deepEqual(encoding(subject.microphoneSender()), { maxBitrate: 55_000 });
    assert.deepEqual(encoding(camera), { maxBitrate: 777_000, maxFramerate: 17 });
  });

  test(`VoiceTransport (${mode}): the ping waits for a measured path, and a receiver is found by its track`, async t => {
    const subject = await open(t, track('microphone', 'audio'));
    assert.equal(await subject.transport.samplePing(), null, 'nothing is measured before media flows');
    subject.measure(40);
    assert.equal(await subject.transport.samplePing(), 40, 'the pair carrying media, not the first one listed');

    const { peerSessionId, trackId, receiver } = subject.remote;
    assert.equal(subject.transport.receiverForTrack(peerSessionId, trackId), receiver);
    assert.equal(subject.transport.receiverForTrack(peerSessionId, 'unknown'), null);
  });
}
