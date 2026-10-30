import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { ParticipantManager } from '../src/renderer/core/ParticipantManager';
import {
  RemoteMediaSink, type RemoteAudioPlayback, type RemoteTrack, type RemoteVoiceActivity,
} from '../src/renderer/core/webrtc/RemoteMediaSink';
import type { AudioLevelReceiver } from '../src/renderer/core/webrtc/RemoteVadMonitor';

function track(id: string, kind: 'audio' | 'video'): MediaStreamTrack {
  let state: MediaStreamTrackState = 'live';
  return {
    id, kind, enabled: true,
    get readyState() { return state; },
    stop() { state = 'ended'; },
  } as MediaStreamTrack;
}

class Stream extends EventTarget implements MediaStream {
  private static next = 0;
  public readonly id = `stream-${Stream.next++}`;
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

let restoreStream: (() => void) | undefined;
before(() => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'MediaStream');
  Object.defineProperty(globalThis, 'MediaStream', { configurable: true, writable: true, value: Stream });
  restoreStream = () => {
    if (original) Object.defineProperty(globalThis, 'MediaStream', original);
    else Reflect.deleteProperty(globalThis, 'MediaStream');
  };
});
after(() => restoreStream?.());

/** A sink whose playback and voice activity record what they are asked to do. */
function fixture(ownOtherDevices: string[] = []) {
  const participants = new ParticipantManager();
  for (const sessionId of ['peer', 'own-phone']) {
    participants.addUser({ id: sessionId, sessionId, clientId: sessionId, nickname: sessionId, status: 'ONLINE', joinedAt: 1 });
  }
  const played: Array<{ peer: string; stream: MediaStream }> = [];
  const log: string[] = [];
  const playback: RemoteAudioPlayback = {
    ensureVoiceAudioElement(peer, stream) { played.push({ peer, stream }); },
    removeVoiceAudio(peer) { log.push(`removeVoiceAudio ${peer}`); },
    cleanupPeerMedia(peer) { log.push(`cleanupPeerMedia ${peer}`); },
    closeAllMedia() { log.push('closeAllMedia'); },
    async setOutputDeviceIds(voice, screen) { log.push(`output ${voice} ${screen}`); },
  };
  const vads = new Map<string, () => AudioLevelReceiver | null | undefined>();
  const activity: RemoteVoiceActivity = {
    setupRemoteReceiverVad(peer, receiver) { vads.set(peer, receiver); log.push(`vad ${peer}`); },
    cleanupRemoteVad(peer) { vads.delete(peer); log.push(`vadCleanup ${peer}`); },
    cleanupAll() { vads.clear(); log.push('vadCleanupAll'); },
  };
  const sink = new RemoteMediaSink(() => participants, playback, activity,
    peer => ownOtherDevices.includes(peer), async deviceId => { log.push(`screens ${deviceId}`); });
  const camera = (peer = 'peer') => participants.get(peer)?.remoteStream;
  return { sink, participants, played, log, vads, camera };
}

/** What a view, the speakers and the voice activity see of a call's remote media. */
function snapshot(f: ReturnType<typeof fixture>) {
  return {
    playing: f.played.at(-1)?.stream.getTracks().map(entry => entry.id),
    camera: f.camera()?.getTracks().map(entry => entry.id),
    voiceActivity: [...f.vads.keys()],
  };
}

test('P2P receivers and SFU consumers leave the same remote media (R-VOICE-5)', () => {
  const mic = track('mic', 'audio');
  const camera = track('camera', 'video');
  const receiver = () => null;
  const remote = (kind: RemoteTrack['kind'], value: MediaStreamTrack): RemoteTrack =>
    ({ peerSessionId: 'peer', kind, track: value, receiver });

  // A peer link reports its tracks at negotiation, then again as media starts flowing.
  const p2p = fixture();
  p2p.sink.trackArrived(remote('mic', mic));
  p2p.sink.trackArrived(remote('camera', camera));
  p2p.sink.trackUnmuted('peer', 'camera', camera);
  p2p.sink.trackUnmuted('peer', 'mic', mic);
  // The SFU reports each consumer once.
  const sfu = fixture();
  sfu.sink.trackArrived(remote('mic', mic));
  sfu.sink.trackArrived(remote('camera', camera));

  assert.deepEqual(snapshot(p2p), snapshot(sfu));
  assert.deepEqual(snapshot(sfu), { playing: ['mic'], camera: ['camera'], voiceActivity: ['peer'] },
    'the microphone plays alone, and the camera stream carries only the camera');
  assert.equal(p2p.log.filter(entry => entry === 'vad peer').length, 1, 'voice activity is set up once per track');
});

test('the microphone of our own other device is never played (#309)', () => {
  const f = fixture(['own-phone']);
  f.sink.trackArrived({ peerSessionId: 'own-phone', kind: 'mic', track: track('echo', 'audio') });
  f.sink.trackArrived({ peerSessionId: 'own-phone', kind: 'camera', track: track('own-camera', 'video') });
  assert.deepEqual(f.played, []);
  assert.deepEqual([...f.vads.keys()], []);
  assert.deepEqual(f.camera('own-phone')?.getTracks().map(entry => entry.id), ['own-camera'], 'its camera still shows');
});

test('a microphone that ends stops playing, unless a newer one already took its place (R-VOICE-5)', () => {
  const f = fixture();
  const first = track('first', 'audio');
  const second = track('second', 'audio');
  f.sink.trackArrived({ peerSessionId: 'peer', kind: 'mic', track: first });
  const firstStream = f.played.at(-1)?.stream;
  f.sink.trackArrived({ peerSessionId: 'peer', kind: 'mic', track: first });
  assert.equal(f.played.at(-1)?.stream, firstStream, 'the same track keeps its stream');
  f.sink.trackArrived({ peerSessionId: 'peer', kind: 'mic', track: second });
  assert.notEqual(f.played.at(-1)?.stream, firstStream);

  f.sink.trackEnded('peer', 'mic', first);
  assert.equal(f.log.includes('removeVoiceAudio peer'), false, 'a replaced consumer closing late changes nothing');
  assert.equal(f.vads.has('peer'), true);
  f.sink.trackEnded('peer', 'mic', second);
  assert.deepEqual(f.log.slice(-2), ['vadCleanup peer', 'removeVoiceAudio peer'],
    'the element, its playback graph and its voice activity go with the microphone');
  assert.equal(second.readyState, 'ended');
});

test('a camera keeps its stream for its track, gets a new one for a new track and empties it when it ends', () => {
  const f = fixture();
  const first = track('first', 'video');
  const second = track('second', 'video');
  f.sink.trackArrived({ peerSessionId: 'peer', kind: 'camera', track: first });
  const firstStream = f.camera();
  f.sink.trackArrived({ peerSessionId: 'peer', kind: 'camera', track: first });
  assert.equal(f.camera(), firstStream);
  f.sink.trackArrived({ peerSessionId: 'peer', kind: 'camera', track: second });
  const secondStream = f.camera();
  assert.notEqual(secondStream, firstStream);
  assert.deepEqual(secondStream?.getTracks(), [second]);

  f.sink.trackEnded('peer', 'camera', first);
  assert.deepEqual(f.camera()?.getTracks(), [second], 'a stale end leaves the newer camera alone');
  f.sink.trackEnded('peer', 'camera', second);
  assert.equal(f.camera(), secondStream, 'the stream stays, so the stage keeps its element');
  assert.deepEqual(secondStream?.getTracks(), []);
  assert.equal(second.readyState, 'ended');
});

test('leaving releases the person, closing releases everyone, and one call sets every output device', async () => {
  const f = fixture();
  const mic = track('mic', 'audio');
  const camera = track('camera', 'video');
  f.sink.trackArrived({ peerSessionId: 'peer', kind: 'mic', track: mic });
  f.sink.trackArrived({ peerSessionId: 'peer', kind: 'camera', track: camera });
  f.sink.peerGone('peer');
  assert.deepEqual(f.log.slice(-2), ['vadCleanup peer', 'cleanupPeerMedia peer']);
  assert.deepEqual([mic.readyState, camera.readyState], ['ended', 'ended']);
  f.sink.trackEnded('peer', 'mic', mic);
  assert.equal(f.log.includes('removeVoiceAudio peer'), false, 'a departed person has nothing left to end');

  const late = track('late', 'audio');
  f.sink.trackArrived({ peerSessionId: 'peer', kind: 'mic', track: late });
  f.sink.closeAll();
  assert.deepEqual(f.log.slice(-2), ['closeAllMedia', 'vadCleanupAll']);
  assert.equal(late.readyState, 'ended');

  await f.sink.setOutputDevices('headset', 'speakers');
  assert.deepEqual(f.log.slice(-2), ['output headset speakers', 'screens speakers']);
});
