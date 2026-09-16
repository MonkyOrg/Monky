import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import {
  LOCAL_EXECUTION_PROTOCOL_LIMITS,
  LOCAL_MEDIA_CHANNEL_LABEL,
  LOCAL_MEDIA_CHANNEL_OPTIONS,
  LOCAL_MEDIA_FORMAT,
  LOCAL_MEDIA_MAX_RECORD_BYTES,
  LOCAL_MEDIA_PROTOCOL,
  decodeLocalMediaRecord,
  encodeLocalMediaRecord,
  isLocalMediaSdp,
  isLocalOpusPacket,
  type LocalExecutionFailure,
  type LocalExecutionFailureDetails,
  type LocalExecutionMutationResult,
  type LocalFrameProgress,
  type LocalFrameReadInput,
  type LocalFrameReadResult,
  type LocalMediaGeneration,
  type LocalMediaRecord,
  type LocalMediaSignal,
  type LocalRuntimeSourceFailure,
  type LocalTaskPause,
} from '@monky/shared';
import {
  LocalAudioSender,
  type LocalAudioChannel,
  type LocalAudioChannelEventMap,
  type LocalAudioPeer,
  type LocalAudioPeerEventMap,
  type LocalAudioSenderOptions,
  type LocalAudioSenderTransport,
} from '../src/renderer/core/LocalAudioSender';
import { LocalExecutionError } from '../src/renderer/core/localExecutionSupport';

const TASK_ID = 'wire-task';
const MAIN_ID = '45d1e2ad-ef98-4e7d-9ac8-97a20bf7d97e';
const GENERATION = 7;
const SDP = 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:0\r\n';
const MAX_BUFFERED_BYTES = LOCAL_MEDIA_FORMAT.creditWindowFrames * LOCAL_MEDIA_MAX_RECORD_BYTES +
  encodeLocalMediaRecord({ kind: 'end', finalSequence: 0 }).byteLength;
// Controlled 20 ms TOC bytes exercise the shared packet contract, not audible provider playback.
const OPUS = Uint8Array.of(0xf8, 0xff, 0xfe);

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => { throw new Error('Deferred was not initialized'); };
  let reject: (error: unknown) => void = () => { throw new Error('Deferred was not initialized'); };
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class ControlledEvents<Events> {
  private readonly listeners: { [K in keyof Events]?: Set<(event: Events[K]) => void> } = {};
  listenerCount = 0;

  addEventListener<K extends keyof Events>(type: K, listener: (event: Events[K]) => void): void {
    const listeners = this.listeners[type] ?? new Set<(event: Events[K]) => void>();
    this.listeners[type] = listeners;
    if (!listeners.has(listener)) this.listenerCount++;
    listeners.add(listener);
  }

  removeEventListener<K extends keyof Events>(type: K, listener: (event: Events[K]) => void): void {
    if (this.listeners[type]?.delete(listener)) this.listenerCount--;
  }

  listenersFor<K extends keyof Events>(type: K): Array<(event: Events[K]) => void> {
    return [...(this.listeners[type] ?? [])];
  }

  emit<K extends keyof Events>(type: K, event: Events[K]): void {
    for (const listener of this.listenersFor(type)) listener(event);
  }
}

class ControlledChannel extends ControlledEvents<LocalAudioChannelEventMap> implements LocalAudioChannel {
  label: string = LOCAL_MEDIA_CHANNEL_LABEL;
  protocol: string = LOCAL_MEDIA_PROTOCOL;
  ordered = true;
  maxPacketLifeTime: number | null = null;
  maxRetransmits: number | null = null;
  readyState: RTCDataChannelState = 'connecting';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType: BinaryType = 'blob';
  closeCalls = 0;
  maxBufferedAmount = 0;
  sendError: Error | null = null;
  readonly sent: Uint8Array[] = [];

  open(): void {
    this.readyState = 'open';
    this.emit('open', new Event('open'));
  }

  send(data: Uint8Array<ArrayBuffer>): void {
    assert.equal(this.readyState, 'open');
    if (this.sendError) throw this.sendError;
    this.sent.push(Uint8Array.from(data));
    this.bufferedAmount += data.byteLength;
    this.maxBufferedAmount = Math.max(this.maxBufferedAmount, this.bufferedAmount);
  }

  drainBuffer(amount = 0): void {
    const previous = this.bufferedAmount;
    this.bufferedAmount = amount;
    if (previous > this.bufferedAmountLowThreshold && amount <= this.bufferedAmountLowThreshold) {
      this.emit('bufferedamountlow', new Event('bufferedamountlow'));
    }
  }

  receive(record: LocalMediaRecord): void {
    this.receiveBytes(Uint8Array.from(encodeLocalMediaRecord(record)).buffer);
  }

  receiveBytes(data: unknown): void {
    this.emit('message', { data });
  }

  records(): LocalMediaRecord[] {
    return this.sent.map(decodeLocalMediaRecord);
  }

  frameCount(): number {
    return this.records().filter((record) => record.kind === 'frame').length;
  }

  close(): void {
    this.closeCalls++;
    this.readyState = 'closed';
    this.emit('close', new Event('close'));
  }
}

class ControlledPeer extends ControlledEvents<LocalAudioPeerEventMap> implements LocalAudioPeer {
  connectionState: RTCPeerConnectionState = 'new';
  localDescription: RTCSessionDescriptionInit | null = null;
  localDescriptionOverride: RTCSessionDescriptionInit | null = null;
  offer: RTCSessionDescriptionInit = { type: 'offer', sdp: SDP };
  offerGate: Deferred<RTCSessionDescriptionInit> | null = null;
  localGate: Deferred<void> | null = null;
  remoteGate: Deferred<void> | null = null;
  iceGate: Deferred<void> | null = null;
  onCreateChannel: (() => void) | null = null;
  closeCalls = 0;
  addedTracks = 0;
  readonly channel = new ControlledChannel();
  readonly channels: Array<{ label: string; options: RTCDataChannelInit }> = [];
  readonly remoteDescriptions: RTCSessionDescriptionInit[] = [];
  readonly candidates: Array<RTCIceCandidateInit | null> = [];
  readonly operations: string[] = [];

  createDataChannel(label: string, options: RTCDataChannelInit): LocalAudioChannel {
    this.channels.push({ label, options: { ...options } });
    this.onCreateChannel?.();
    return this.channel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    this.operations.push('offer');
    return this.offerGate?.promise ?? this.offer;
  }

  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.operations.push('local');
    if (this.localGate) await this.localGate.promise;
    this.localDescription = { ...(this.localDescriptionOverride ?? description) };
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.operations.push('remote');
    this.remoteDescriptions.push({ ...description });
    if (this.remoteGate) await this.remoteGate.promise;
  }

  async addIceCandidate(candidate: RTCIceCandidateInit | null): Promise<void> {
    this.operations.push(candidate === null ? 'ice:null' : `ice:${candidate.candidate}`);
    this.candidates.push(candidate);
    if (this.iceGate) await this.iceGate.promise;
  }

  addTrack(): never {
    this.addedTracks++;
    throw new Error('Private local execution must never add a track');
  }

  setConnectionState(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    this.emit('connectionstatechange', new Event('connectionstatechange'));
  }

  close(): void {
    this.closeCalls++;
    this.setConnectionState('closed');
  }
}

type SenderApi = LocalAudioSenderOptions['api'];

class ControlledApi implements SenderApi {
  readonly reads: Array<{ input: LocalFrameReadInput; reply: Deferred<LocalFrameReadResult> }> = [];
  readonly acknowledgments: LocalFrameProgress[] = [];
  readonly pauses: LocalTaskPause[] = [];
  readonly mutations: string[] = [];
  readonly ackReplies: Array<Deferred<LocalExecutionMutationResult>> = [];
  readonly pauseReplies: Array<Deferred<LocalExecutionMutationResult>> = [];

  readLocalExecutionFrames(input: LocalFrameReadInput): Promise<LocalFrameReadResult> {
    const reply = deferred<LocalFrameReadResult>();
    this.reads.push({ input: { ...input }, reply });
    return reply.promise;
  }

  acknowledgeLocalExecutionFrames(input: LocalFrameProgress): Promise<LocalExecutionMutationResult> {
    this.acknowledgments.push({ ...input });
    this.mutations.push(`played:${input.playedFrames}`);
    return this.ackReplies.shift()?.promise ?? Promise.resolve({ status: 'completed' });
  }

  setLocalExecutionPaused(input: LocalTaskPause): Promise<LocalExecutionMutationResult> {
    this.pauses.push({ ...input });
    this.mutations.push(`paused:${input.paused}`);
    return this.pauseReplies.shift()?.promise ?? Promise.resolve({ status: 'completed' });
  }

  replyFrames(index: number, count?: number, done = false, packet = OPUS): void {
    const read = this.reads[index];
    assert.ok(read, `Expected read ${index}`);
    read.reply.resolve({
      status: 'frames',
      frames: Array.from({ length: count ?? read.input.count }, () => Uint8Array.from(packet)),
      done,
    });
  }
}

function answer(sdp = SDP): LocalMediaSignal {
  return { taskId: TASK_ID, mediaGeneration: GENERATION, signal: { signalType: 'answer', sdp: { type: 'answer', sdp } } };
}

function candidate(value: string | null): LocalMediaSignal {
  return {
    taskId: TASK_ID,
    mediaGeneration: GENERATION,
    signal: {
      signalType: 'candidate',
      candidate: value === null ? null : { candidate: value, sdpMid: '0', sdpMLineIndex: 0 },
    },
  };
}

function fixture(t: TestContext, media: LocalMediaGeneration = {
  protocol: LOCAL_MEDIA_PROTOCOL, generation: GENERATION, iceServers: [],
}) {
  const peer = new ControlledPeer();
  const api = new ControlledApi();
  const signals: LocalMediaSignal[] = [];
  const failures: LocalExecutionFailure[] = [];
  const failureDetails: LocalExecutionFailureDetails[] = [];
  const drains: number[] = [];
  const configurations: RTCConfiguration[] = [];
  const sender: LocalAudioSenderTransport = new LocalAudioSender({
    taskId: TASK_ID,
    media,
    api,
    sendSignal: (signal) => signals.push(signal),
    onFailure: (reason, sourceFailure) => {
      failures.push(reason);
      failureDetails.push({ reason, ...(sourceFailure ? { sourceFailure } : {}) });
    },
    onDrained: (playedFrames) => drains.push(playedFrames),
    createPeer: (configuration) => {
      configurations.push(configuration);
      return peer;
    },
  });
  t.after(() => sender.close());
  return { sender, peer, channel: peer.channel, api, signals, failures, failureDetails, drains, configurations };
}

type Fixture = ReturnType<typeof fixture>;

async function turn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function connect(f: Fixture): Promise<void> {
  const connecting = f.sender.connect();
  await turn();
  await f.sender.acceptSignal(answer());
  f.peer.setConnectionState('connected');
  f.channel.open();
  await connecting;
}

function start(f: Fixture, windowEnd: number = LOCAL_MEDIA_FORMAT.creditWindowFrames): void {
  f.sender.start(MAIN_ID);
  f.sender.markReady();
  f.channel.receive({ kind: 'credit', consumedFrames: 0, windowEnd });
}

function hasReason(reason: LocalExecutionFailure): (error: unknown) => boolean {
  return (error) => error instanceof Error && 'reason' in error && error.reason === reason;
}

function assertClosedOnce(f: Fixture): void {
  assert.equal(f.peer.closeCalls, 1);
  assert.equal(f.channel.closeCalls, 1);
  assert.equal(f.peer.listenerCount, 0);
  assert.equal(f.channel.listenerCount, 0);
}

test('offers one authorized, data-only transport and requires both connection and channel readiness', async (t) => {
  for (const channelFirst of [true, false]) {
    await t.test(channelFirst ? 'channel first' : 'peer first', async (t) => {
      const media: LocalMediaGeneration = {
        protocol: LOCAL_MEDIA_PROTOCOL, generation: GENERATION,
        iceServers: [{ urls: ['stun:authorized.invalid:3478'] }],
      };
      const f = fixture(t, media);
      media.iceServers[0].urls.push('stun:not-in-the-snapshot.invalid');
      f.sender.start(MAIN_ID);
      f.sender.markReady();
      const connecting = f.sender.connect();
      assert.equal(f.sender.connect(), connecting);
      let ready = false;
      void connecting.then(() => { ready = true; });
      await turn();
      assert.deepEqual(f.configurations, [{ iceServers: [{ urls: ['stun:authorized.invalid:3478'] }] }]);
      assert.deepEqual(f.peer.channels, [{ label: LOCAL_MEDIA_CHANNEL_LABEL, options: LOCAL_MEDIA_CHANNEL_OPTIONS }]);
      assert.equal(f.peer.addedTracks, 0);
      assert.equal(f.channel.binaryType, 'arraybuffer');
      assert.equal(f.signals.length, 1);
      assert.deepEqual(f.signals[0], {
        taskId: TASK_ID, mediaGeneration: GENERATION,
        signal: { signalType: 'offer', sdp: { type: 'offer', sdp: SDP } },
      });
      assert.ok(isLocalMediaSdp(f.peer.localDescription?.sdp ?? ''));
      await f.sender.acceptSignal(answer());
      if (channelFirst) {
        f.channel.open();
        f.channel.receive({ kind: 'credit', consumedFrames: 0, windowEnd: 25 });
      } else {
        f.peer.setConnectionState('connected');
      }
      await turn();
      assert.equal(ready, false);
      assert.equal(f.api.reads.length, 0);
      if (channelFirst) f.peer.setConnectionState('connected');
      else f.channel.open();
      await connecting;
      if (!channelFirst) f.channel.receive({ kind: 'credit', consumedFrames: 0, windowEnd: 25 });
      await turn();
      assert.equal(ready, true);
      assert.equal(f.api.reads[0]?.input.taskId, MAIN_ID);
      f.sender.start(MAIN_ID);
      assert.equal(f.api.reads.length, 1);
      f.peer.emit('icecandidate', { candidate: null });
      assert.deepEqual(f.signals[1], candidate(null));
      assert.deepEqual(f.failures, []);
    });
  }
});

test('does not introduce ICE fallbacks when the authorized server list is empty', async (t) => {
  const f = fixture(t);
  await connect(f);
  assert.deepEqual(f.configurations, [{ iceServers: [] }]);
});

test('close prevents connecting or reusing a previously connected generation', async (t) => {
  const beforeConnect = fixture(t);
  beforeConnect.sender.close();
  await assert.rejects(beforeConnect.sender.connect(), hasReason('cancelled'));
  assert.deepEqual(beforeConnect.configurations, []);
  const connected = fixture(t);
  await connect(connected);
  connected.sender.close();
  await assert.rejects(connected.sender.connect(), hasReason('cancelled'));
  assert.equal(connected.configurations.length, 1);
  assert.deepEqual(connected.failures, []);
  assertClosedOnce(connected);
});

test('reentrant cancellation during channel creation cannot leave resources or a timer behind', async (t) => {
  const f = fixture(t);
  f.peer.onCreateChannel = () => f.sender.close();
  await assert.rejects(f.sender.connect(), hasReason('cancelled'));
  await turn();
  assert.deepEqual(f.peer.operations, []);
  assert.deepEqual(f.signals, []);
  assert.deepEqual(f.failures, []);
  assertClosedOnce(f);
});

test('buffers early ICE, including final null, and serializes it after the answer', async (t) => {
  const f = fixture(t);
  await f.sender.acceptSignal(candidate('early-before-connect'));
  const connecting = f.sender.connect();
  await turn();
  await f.sender.acceptSignal(candidate('early-before-answer'));
  await f.sender.acceptSignal(candidate(null));
  assert.deepEqual(f.peer.candidates, []);
  await f.sender.acceptSignal(answer());
  await f.sender.acceptSignal(answer());
  assert.deepEqual(f.peer.operations, [
    'offer', 'local', 'remote', 'ice:early-before-connect', 'ice:early-before-answer', 'ice:null',
  ]);
  f.channel.open();
  f.peer.setConnectionState('connected');
  await connecting;
  await f.sender.acceptSignal(candidate('late'));
  assert.equal(f.peer.candidates.length, 4);
  assert.deepEqual(f.failures, []);
});

test('ignores stale identities and generations and cancels a pending offer without late side effects', async (t) => {
  const f = fixture(t);
  const offer = f.peer.offerGate = deferred<RTCSessionDescriptionInit>();
  const connecting = f.sender.connect();
  const rejected = assert.rejects(connecting, hasReason('cancelled'));
  await turn();
  await f.sender.acceptSignal({ ...answer('m=audio 9 UDP/TLS/RTP/SAVPF 111'), taskId: 'old-task' });
  await f.sender.acceptSignal({ ...answer('m=video 9 UDP/TLS/RTP/SAVPF 96'), mediaGeneration: GENERATION - 1 });
  const queued = f.sender.acceptSignal(candidate('queued'));
  f.sender.close();
  f.sender.close();
  await rejected;
  offer.resolve({ type: 'offer', sdp: SDP });
  await queued;
  await turn();
  assert.deepEqual(f.peer.operations, ['offer']);
  assert.deepEqual(f.signals, []);
  assert.deepEqual(f.failures, []);
  assertClosedOnce(f);
  await assert.rejects(f.sender.connect(), hasReason('cancelled'));
});

test('cancelled local/remote descriptions and ICE cannot continue negotiation when they settle late', async (t) => {
  for (const stage of ['local', 'remote', 'ice']) {
    await t.test(stage, async (t) => {
      const f = fixture(t);
      const gate = deferred<void>();
      if (stage === 'local') f.peer.localGate = gate;
      else if (stage === 'remote') f.peer.remoteGate = gate;
      else f.peer.iceGate = gate;
      const connecting = f.sender.connect();
      const rejected = assert.rejects(connecting, hasReason('cancelled'));
      await turn();
      const first = f.sender.acceptSignal(candidate('first'));
      const second = f.sender.acceptSignal(candidate('second'));
      const answering = f.sender.acceptSignal(answer());
      await turn();
      f.sender.close();
      await rejected;
      gate.resolve();
      await Promise.all([first, second, answering]);
      await turn();
      assert.equal(f.peer.candidates.length, stage === 'ice' ? 1 : 0);
      assert.equal(f.signals.length, stage === 'local' ? 0 : 1);
      assert.deepEqual(f.failures, []);
      assertClosedOnce(f);
    });
  }
});

test('times out with the shared connection limit and releases its timer and listeners', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  const rejected = assert.rejects(f.sender.connect(), hasReason('timeout'));
  await turn();
  t.mock.timers.tick(LOCAL_EXECUTION_PROTOCOL_LIMITS.mediaConnectTimeoutMs - 1);
  assert.deepEqual(f.failures, []);
  t.mock.timers.tick(1);
  await rejected;
  assert.deepEqual(f.failures, ['timeout']);
  assertClosedOnce(f);
  t.mock.timers.tick(LOCAL_EXECUTION_PROTOCOL_LIMITS.mediaConnectTimeoutMs);
  assert.deepEqual(f.failures, ['timeout']);
});

test('native acceptance and early credit cannot release media before authoritative server readiness', async (t) => {
  const f = fixture(t);
  await connect(f);
  f.sender.start(MAIN_ID);
  f.channel.receive({ kind: 'credit', consumedFrames: 0, windowEnd: 25 });
  await turn();
  assert.equal(f.api.reads.length, 0);
  assert.equal(f.channel.frameCount(), 0);
  f.sender.markReady();
  await turn();
  assert.deepEqual(f.api.reads.map((read) => read.input), [{ taskId: MAIN_ID, count: 8 }]);
  f.sender.markReady();
  assert.equal(f.api.reads.length, 1);
  assert.deepEqual(f.failures, []);
});

test('native pause remains effective while authoritative readiness is pending', async (t) => {
  const f = fixture(t);
  await connect(f);
  f.sender.start(MAIN_ID);
  f.channel.receive({ kind: 'credit', consumedFrames: 0, windowEnd: 25 });
  await f.sender.setPaused(true);
  assert.deepEqual(f.api.mutations, ['paused:true']);
  f.sender.markReady();
  await turn();
  assert.equal(f.api.reads.length, 0);
  await f.sender.setPaused(false);
  assert.deepEqual(f.api.mutations, ['paused:true', 'paused:false']);
  assert.equal(f.api.reads.length, 1);
});

test('bounds credit and actual unplayed source lead to 25, reads at most 8, and ACKs only PLAYED', async (t) => {
  const f = fixture(t);
  await connect(f);
  f.sender.start(MAIN_ID);
  f.sender.markReady();
  await turn();
  assert.equal(f.api.reads.length, 0);
  f.channel.receive({ kind: 'credit', consumedFrames: 0, windowEnd: 25 });
  for (let index = 0; index < 4; index++) {
    f.api.replyFrames(index);
    await turn();
  }
  assert.deepEqual(f.api.reads.map((read) => read.input.count), [8, 8, 8, 1]);
  assert.equal(f.channel.frameCount(), 25);
  f.channel.receive({ kind: 'credit', consumedFrames: 25, windowEnd: 50 });
  await turn();
  assert.equal(f.api.reads.length, 4);
  assert.deepEqual(f.api.acknowledgments, []);
  f.channel.receive({ kind: 'played', playedFrames: 10 });
  await turn();
  assert.deepEqual(f.api.acknowledgments, [{ taskId: MAIN_ID, playedFrames: 10 }]);
  f.api.replyFrames(4);
  await turn();
  f.api.replyFrames(5);
  await turn();
  assert.deepEqual(f.api.reads.map((read) => read.input.count), [8, 8, 8, 1, 8, 2]);
  assert.equal(f.channel.frameCount() - f.sender.playedFrames, 25);
  f.channel.receive({ kind: 'credit', consumedFrames: 35, windowEnd: 60 });
  f.channel.receive({ kind: 'played', playedFrames: 10 });
  await turn();
  assert.equal(f.api.reads.length, 6);
  assert.equal(f.api.acknowledgments.length, 1);
  assert.deepEqual(f.failures, []);
});

test('PLAYED advances the native checkpoint without granting more absolute credit', async (t) => {
  const f = fixture(t);
  await connect(f);
  start(f, 8);
  f.api.replyFrames(0);
  await turn();
  f.channel.receive({ kind: 'credit', consumedFrames: 8, windowEnd: 8 });
  f.channel.receive({ kind: 'played', playedFrames: 8 });
  await turn();
  assert.equal(f.api.reads.length, 1);
  assert.deepEqual(f.api.acknowledgments, [{ taskId: MAIN_ID, playedFrames: 8 }]);
  f.channel.receive({ kind: 'credit', consumedFrames: 8, windowEnd: 16 });
  assert.equal(f.api.reads[1]?.input.count, 8);
  assert.deepEqual(f.failures, []);
});

test('uses bufferedamountlow rather than reads or polling to release bounded RTC backpressure', async (t) => {
  const f = fixture(t);
  await connect(f);
  f.channel.bufferedAmount = MAX_BUFFERED_BYTES;
  start(f);
  await turn();
  assert.equal(f.api.reads.length, 0);
  f.channel.drainBuffer();
  assert.equal(f.api.reads[0]?.input.count, 8);
  const packet = new Uint8Array(LOCAL_MEDIA_FORMAT.maxPacketBytes).fill(OPUS[0]);
  assert.ok(isLocalOpusPacket(packet));
  f.channel.bufferedAmount = MAX_BUFFERED_BYTES - 3 * LOCAL_MEDIA_MAX_RECORD_BYTES;
  f.api.replyFrames(0, 8, false, packet);
  await turn();
  assert.equal(f.channel.frameCount(), 3);
  assert.equal(f.channel.bufferedAmount, MAX_BUFFERED_BYTES);
  assert.equal(f.api.reads.length, 1);
  await turn();
  assert.equal(f.channel.frameCount(), 3);
  f.channel.drainBuffer();
  await turn();
  assert.equal(f.channel.frameCount(), 8);
  assert.equal(f.api.reads.length, 2);
  f.api.replyFrames(1, 0, true);
  await turn();
  assert.deepEqual(f.channel.records().at(-1), { kind: 'end', finalSequence: 8 });
  assert.ok(f.channel.maxBufferedAmount <= MAX_BUFFERED_BYTES);
  assert.deepEqual(f.failures, []);
});

test('pause synchronously holds an in-flight batch and resume waits for serialized native mutations', async (t) => {
  const f = fixture(t);
  await connect(f);
  start(f);
  const pauseReply = deferred<LocalExecutionMutationResult>();
  const resumeReply = deferred<LocalExecutionMutationResult>();
  f.api.pauseReplies.push(pauseReply, resumeReply);
  const paused = f.sender.setPaused(true);
  f.api.replyFrames(0);
  await turn();
  assert.equal(f.channel.frameCount(), 0);
  assert.equal(f.api.reads.length, 1);
  assert.deepEqual(f.api.pauses, [{ taskId: MAIN_ID, paused: true }]);
  f.channel.receive({ kind: 'credit', consumedFrames: 0, windowEnd: 25 });
  f.channel.receive({ kind: 'played', playedFrames: 0 });
  const resumed = f.sender.setPaused(false);
  await turn();
  assert.equal(f.channel.frameCount(), 0);
  assert.equal(f.api.pauses.length, 1);
  pauseReply.resolve({ status: 'completed' });
  await paused;
  await turn();
  assert.deepEqual(f.api.mutations, ['paused:true', 'paused:false']);
  assert.equal(f.channel.frameCount(), 0);
  resumeReply.resolve({ status: 'completed' });
  await resumed;
  await turn();
  assert.equal(f.channel.frameCount(), 8);
  assert.equal(f.api.reads.length, 2);
  assert.deepEqual(f.api.acknowledgments, []);
  assert.deepEqual(f.failures, []);
});

test('validates PLAYED during pause and does not read on paused credit or an empty paused read', async (t) => {
  const f = fixture(t);
  await connect(f);
  start(f);
  f.api.replyFrames(0);
  await turn();
  f.channel.receive({ kind: 'credit', consumedFrames: 8, windowEnd: 33 });
  await f.sender.setPaused(true);
  f.channel.receive({ kind: 'played', playedFrames: 4 });
  f.api.replyFrames(1, 0);
  await turn();
  assert.deepEqual(f.api.acknowledgments, [{ taskId: MAIN_ID, playedFrames: 4 }]);
  f.channel.receive({ kind: 'credit', consumedFrames: 8, windowEnd: 33 });
  await turn();
  assert.equal(f.api.reads.length, 2);
  assert.equal(f.channel.frameCount(), 8);
  f.channel.receive({ kind: 'played', playedFrames: 3 });
  assert.deepEqual(f.failures, ['transport_failed']);
  assertClosedOnce(f);
});

test('an empty non-EOF batch retries at the frame cadence rather than stalling or busy-looping', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  await connect(f);
  start(f);
  f.api.replyFrames(0, 0);
  await turn();
  assert.equal(f.api.reads.length, 1);
  t.mock.timers.tick(LOCAL_MEDIA_FORMAT.frameDurationMs - 1);
  await turn();
  assert.equal(f.api.reads.length, 1);
  t.mock.timers.tick(1);
  await turn();
  assert.equal(f.api.reads.length, 2);
  f.api.replyFrames(1, 3, true);
  await turn();
  assert.equal(f.channel.frameCount(), 3);
  assert.equal(f.sender.sourceEnded, true);
  assert.deepEqual(f.failures, []);
});

test('pause and cancellation release a pending empty-batch retry without requiring more credit', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  await connect(f);
  start(f);
  f.api.replyFrames(0, 0);
  await turn();
  await f.sender.setPaused(true);
  t.mock.timers.tick(LOCAL_MEDIA_FORMAT.frameDurationMs * 2);
  await turn();
  assert.equal(f.api.reads.length, 1);
  await f.sender.setPaused(false);
  await turn();
  assert.equal(f.api.reads.length, 2);
  f.api.replyFrames(1, 0);
  await turn();
  f.sender.close();
  t.mock.timers.tick(LOCAL_MEDIA_FORMAT.frameDurationMs * 2);
  await turn();
  assert.equal(f.api.reads.length, 2);
  assert.deepEqual(f.failures, []);
  assertClosedOnce(f);
});

test('forwards every increasing PLAYED while serializing native acknowledgments with pause', async (t) => {
  const f = fixture(t);
  await connect(f);
  start(f);
  f.api.replyFrames(0);
  await turn();
  f.channel.receive({ kind: 'credit', consumedFrames: 8, windowEnd: 33 });
  const ack = deferred<LocalExecutionMutationResult>();
  const pause = deferred<LocalExecutionMutationResult>();
  f.api.ackReplies.push(ack);
  f.api.pauseReplies.push(pause);
  f.channel.receive({ kind: 'played', playedFrames: 1 });
  await turn();
  const pausing = f.sender.setPaused(true);
  for (const playedFrames of [2, 3, 4]) f.channel.receive({ kind: 'played', playedFrames });
  ack.resolve({ status: 'completed' });
  await turn();
  assert.deepEqual(f.api.mutations, ['played:1', 'paused:true']);
  pause.resolve({ status: 'completed' });
  await pausing;
  await turn();
  assert.deepEqual(f.api.mutations, ['played:1', 'paused:true', 'played:2', 'played:3', 'played:4']);
  assert.equal(f.api.reads.length, 2);
  assert.deepEqual(f.failures, []);
});

test('native EOF still sends its final batch and same-channel exclusive END before exact drain acknowledgment', async (t) => {
  const f = fixture(t);
  await connect(f);
  start(f);
  f.api.replyFrames(0, 3, true);
  await turn();
  assert.equal(f.sender.sourceEnded, true);
  assert.equal(f.sender.nativePlaybackComplete, false);
  assert.equal(f.sender.completed, false);
  assert.equal(f.channel.frameCount(), 3);
  assert.deepEqual(f.channel.records().at(-1), { kind: 'end', finalSequence: 3 });
  assert.deepEqual(f.channel.records().filter((record) => record.kind === 'frame').map((record) => record.sequence), [0, 1, 2]);
  assert.deepEqual(f.drains, []);
  await f.sender.setPaused(true);
  await f.sender.setPaused(false);
  f.channel.receive({ kind: 'credit', consumedFrames: 3, windowEnd: 28 });
  f.channel.receive({ kind: 'played', playedFrames: 3 });
  await turn();
  assert.equal(f.api.reads.length, 1);
  assert.deepEqual(f.api.mutations, ['paused:true', 'paused:false', 'played:3']);
  assert.equal(f.sender.nativePlaybackComplete, true);
  await f.sender.setPaused(true);
  await f.sender.setPaused(false);
  f.channel.receive({ kind: 'played', playedFrames: 3 });
  await turn();
  assert.deepEqual(f.api.mutations, ['paused:true', 'paused:false', 'played:3'], 'The final confirmed ACK retires native mutations');
  assert.deepEqual(f.drains, []);
  f.channel.receive({ kind: 'drainAck', finalSequence: 3 });
  f.channel.receive({ kind: 'drainAck', finalSequence: 3 });
  assert.deepEqual(f.drains, [3]);
  assert.equal(f.sender.playedFrames, 3);
  assert.equal(f.sender.completed, true);
  assert.deepEqual(f.failures, []);
  assertClosedOnce(f);
});

test('drain ACK keeps the peer and Main lease until the final native PLAYED confirmation completes', async (t) => {
  const f = fixture(t);
  await connect(f);
  start(f);
  f.api.replyFrames(0, 3, true);
  await turn();
  const firstAck = deferred<LocalExecutionMutationResult>();
  const finalAck = deferred<LocalExecutionMutationResult>();
  f.api.ackReplies.push(firstAck, finalAck);
  f.channel.receive({ kind: 'credit', consumedFrames: 3, windowEnd: 28 });
  f.channel.receive({ kind: 'played', playedFrames: 1 });
  await turn();
  f.channel.receive({ kind: 'played', playedFrames: 3 });
  f.channel.receive({ kind: 'played', playedFrames: 3 });
  f.channel.receive({ kind: 'drainAck', finalSequence: 3 });
  await turn();
  assert.deepEqual(f.api.acknowledgments, [{ taskId: MAIN_ID, playedFrames: 1 }], 'The final ACK remains queued behind the first');
  assert.equal(f.sender.nativePlaybackComplete, false, 'Reserving an ACK is not confirmation from Main');
  assert.equal(f.sender.completed, false);
  assert.equal(f.peer.closeCalls, 0);
  assert.deepEqual(f.drains, []);
  firstAck.resolve({ status: 'completed' });
  await turn();
  assert.deepEqual(f.api.acknowledgments.map((ack) => ack.playedFrames), [1, 3]);
  assert.equal(f.sender.nativePlaybackComplete, false);
  assert.equal(f.peer.closeCalls, 0, 'The final ACK is now in flight, not confirmed');
  finalAck.resolve({ status: 'completed' });
  await turn();
  assert.equal(f.sender.nativePlaybackComplete, true);
  assert.equal(f.sender.completed, true);
  assert.deepEqual(f.drains, [3]);
  assertClosedOnce(f);
});

test('confirmed native progress bounds the pending ACK queue and source lead to 25 frames', async (t) => {
  const f = fixture(t);
  await connect(f);
  start(f);
  for (let index = 0; index < 4; index++) {
    f.api.replyFrames(index);
    await turn();
  }
  const firstAck = deferred<LocalExecutionMutationResult>();
  f.api.ackReplies.push(firstAck);
  f.channel.receive({ kind: 'credit', consumedFrames: 25, windowEnd: 50 });
  for (let playedFrames = 1; playedFrames <= 25; playedFrames++) f.channel.receive({ kind: 'played', playedFrames });
  await turn();
  assert.equal(f.api.reads.length, 4, 'Unconfirmed native ACK reservations cannot release more source reads');
  assert.deepEqual(f.api.acknowledgments, [{ taskId: MAIN_ID, playedFrames: 1 }]);
  firstAck.resolve({ status: 'completed' });
  await turn();
  assert.deepEqual(f.api.acknowledgments.map((ack) => ack.playedFrames), Array.from({ length: 25 }, (_, index) => index + 1));
  assert.equal(f.api.reads.length, 5);
  assert.equal(f.api.reads[4].input.count, 1, 'Only confirmed progress releases the first new frame slot');
  assert.deepEqual(f.failures, []);
});

test('a failed final native ACK after drain remains a failure with its exact source detail', async (t) => {
  const f = fixture(t);
  await connect(f);
  start(f);
  f.api.replyFrames(0, 1, true);
  await turn();
  const finalAck = deferred<LocalExecutionMutationResult>();
  f.api.ackReplies.push(finalAck);
  f.channel.receive({ kind: 'credit', consumedFrames: 1, windowEnd: 26 });
  f.channel.receive({ kind: 'played', playedFrames: 1 });
  f.channel.receive({ kind: 'drainAck', finalSequence: 1 });
  await turn();
  finalAck.resolve({ status: 'failed', reason: 'worker_failed', sourceFailure: { code: 'recovery_failed', attempts: 37 } });
  await turn();
  assert.equal(f.sender.nativePlaybackComplete, false);
  assert.deepEqual(f.drains, []);
  assert.deepEqual(f.failureDetails, [{ reason: 'worker_failed', sourceFailure: { code: 'recovery_failed', attempts: 37 } }]);
  assertClosedOnce(f);
});

test('explicit cancellation during final native ACK prevents a late drain success', async (t) => {
  const f = fixture(t);
  await connect(f);
  start(f);
  f.api.replyFrames(0, 1, true);
  await turn();
  const finalAck = deferred<LocalExecutionMutationResult>();
  f.api.ackReplies.push(finalAck);
  f.channel.receive({ kind: 'credit', consumedFrames: 1, windowEnd: 26 });
  f.channel.receive({ kind: 'played', playedFrames: 1 });
  f.channel.receive({ kind: 'drainAck', finalSequence: 1 });
  await turn();
  f.sender.close();
  finalAck.resolve({ status: 'completed' });
  await turn();
  assert.deepEqual(f.drains, []);
  assert.deepEqual(f.failures, []);
  assert.equal(f.sender.nativePlaybackComplete, false);
  assertClosedOnce(f);
});

test('empty native EOF sends END zero and drains without fabricated playback', async (t) => {
  const f = fixture(t);
  await connect(f);
  start(f, 1);
  f.api.replyFrames(0, 0, true);
  await turn();
  assert.deepEqual(f.channel.records(), [{ kind: 'end', finalSequence: 0 }]);
  f.channel.receive({ kind: 'drainAck', finalSequence: 0 });
  assert.deepEqual(f.drains, [0]);
  assert.equal(f.sender.sourceEnded, true);
  assert.deepEqual(f.api.mutations, []);
});

test('EOF retains queued native ACK and pause work without losing its paused final batch', async (t) => {
  const f = fixture(t);
  await connect(f);
  start(f);
  f.api.replyFrames(0);
  await turn();
  f.channel.receive({ kind: 'credit', consumedFrames: 8, windowEnd: 33 });
  const ack = deferred<LocalExecutionMutationResult>();
  f.api.ackReplies.push(ack);
  f.channel.receive({ kind: 'played', playedFrames: 2 });
  await turn();
  assert.deepEqual(f.api.mutations, ['played:2']);
  const paused = f.sender.setPaused(true);
  f.channel.receive({ kind: 'played', playedFrames: 4 });
  f.api.replyFrames(1, 2, true);
  await turn();
  assert.equal(f.sender.sourceEnded, true);
  assert.equal(f.channel.frameCount(), 8);
  const resumed = f.sender.setPaused(false);
  await turn();
  assert.equal(f.channel.frameCount(), 8, 'Resume waits for the live playback lease mutation queue');
  ack.resolve({ status: 'completed' });
  await Promise.all([paused, resumed]);
  await turn();
  assert.equal(f.channel.frameCount(), 10);
  assert.deepEqual(f.channel.records().at(-1), { kind: 'end', finalSequence: 10 });
  assert.deepEqual(f.api.mutations, ['played:2', 'paused:true', 'paused:false', 'played:4']);
  assert.equal(f.api.reads.length, 2);
  f.channel.receive({ kind: 'credit', consumedFrames: 10, windowEnd: 35 });
  f.channel.receive({ kind: 'played', playedFrames: 10 });
  f.channel.receive({ kind: 'drainAck', finalSequence: 10 });
  await turn();
  assert.equal(f.api.acknowledgments.at(-1)?.playedFrames, 10);
  assert.deepEqual(f.drains, [10]);
  assert.deepEqual(f.failures, []);
});

test('EOF does not hide a failure of the still-live native playback lease', async (t) => {
  const f = fixture(t);
  await connect(f);
  start(f);
  f.api.replyFrames(0);
  await turn();
  f.channel.receive({ kind: 'credit', consumedFrames: 8, windowEnd: 33 });
  const pause = deferred<LocalExecutionMutationResult>();
  f.api.pauseReplies.push(pause);
  const pausing = f.sender.setPaused(true);
  const rejected = assert.rejects(pausing, hasReason('transport_failed'));
  await turn();
  f.channel.receive({ kind: 'played', playedFrames: 4 });
  f.api.replyFrames(1, 2, true);
  await turn();
  assert.equal(f.sender.sourceEnded, true);
  assert.equal(f.channel.frameCount(), 8);
  const resumed = f.sender.setPaused(false);
  assert.equal(f.channel.frameCount(), 8);
  pause.reject(new Error('Private native details must not escape'));
  await rejected;
  await resumed;
  await turn();
  assert.deepEqual(f.api.mutations, ['paused:true']);
  assert.equal(f.api.reads.length, 2);
  assert.deepEqual(f.failures, ['transport_failed']);
  assert.equal(f.channel.frameCount(), 8);
  assert.equal(f.channel.records().some((record) => record.kind === 'end'), false);
  assert.equal(f.sender.nativePlaybackComplete, false);
  assertClosedOnce(f);
});

test('requires exact END and actual PLAYED rather than credit or a premature/mismatched drain ACK', async (t) => {
  for (const invalid of ['before-end', 'wrong-count', 'not-played']) {
    await t.test(invalid, async (t) => {
      const f = fixture(t);
      await connect(f);
      start(f);
      f.api.replyFrames(0, 3, invalid !== 'before-end');
      await turn();
      f.channel.receive({ kind: 'credit', consumedFrames: 3, windowEnd: 28 });
      if (invalid !== 'not-played') f.channel.receive({ kind: 'played', playedFrames: 3 });
      f.channel.receive({ kind: 'drainAck', finalSequence: invalid === 'wrong-count' ? 2 : 3 });
      assert.deepEqual(f.drains, []);
      assert.deepEqual(f.failures, ['transport_failed']);
      assertClosedOnce(f);
    });
  }
});

test('malformed, oversized, wrong-direction and invalid credit/PLAYED records fail exactly once', async (t) => {
  const overCredit = encodeLocalMediaRecord({ kind: 'credit', consumedFrames: 0, windowEnd: 25 });
  overCredit[8] = 26;
  const cases: Array<{ name: string; data: unknown }> = [
    { name: 'text', data: 'not binary' },
    { name: 'short', data: Uint8Array.of(2, 0) },
    { name: 'control length', data: new Uint8Array(10).fill(2) },
    { name: 'oversized record', data: new Uint8Array(LOCAL_MEDIA_MAX_RECORD_BYTES + 1) },
    { name: 'wrong sender', data: encodeLocalMediaRecord({ kind: 'frame', sequence: 0, opus: OPUS }) },
    { name: 'credit exceeds 25', data: overCredit },
    { name: 'credit consumes unsent data', data: encodeLocalMediaRecord({ kind: 'credit', consumedFrames: 1, windowEnd: 26 }) },
    { name: 'PLAYED exceeds consumption', data: encodeLocalMediaRecord({ kind: 'played', playedFrames: 1 }) },
  ];
  for (const invalid of cases) {
    await t.test(invalid.name, async (t) => {
      const f = fixture(t);
      await connect(f);
      const lateListeners = f.channel.listenersFor('message');
      f.channel.receiveBytes(invalid.data);
      for (const listener of lateListeners) listener({ data: invalid.data });
      assert.deepEqual(f.failures, ['transport_failed']);
      assertClosedOnce(f);
      assert.deepEqual(f.api.mutations, []);
    });
  }
});

test('rejects invalid/oversized native Opus packets and batches larger than the requested maximum', async (t) => {
  for (const invalid of ['duration', 'empty-packet', 'oversized-packet', 'oversized-batch']) {
    await t.test(invalid, async (t) => {
      const f = fixture(t);
      await connect(f);
      start(f);
      const packet = invalid === 'duration' ? Uint8Array.of(0) : invalid === 'empty-packet' ? new Uint8Array(0)
        : invalid === 'oversized-packet' ? new Uint8Array(LOCAL_MEDIA_FORMAT.maxPacketBytes + 1).fill(OPUS[0]) : OPUS;
      f.api.replyFrames(0, invalid === 'oversized-batch' ? 9 : 1, false, packet);
      await turn();
      assert.deepEqual(f.failures, ['transport_failed']);
      assert.equal(f.channel.frameCount(), 0);
      assertClosedOnce(f);
    });
  }
});

test('rejects offers from the bot, media SDP, non-strict signals, oversized ICE and contradictory answers', async (t) => {
  const invalidSignals: Array<{ name: string; value: LocalMediaSignal }> = [
    {
      name: 'bot offer',
      value: { taskId: TASK_ID, mediaGeneration: GENERATION, signal: { signalType: 'offer', sdp: { type: 'offer', sdp: SDP } } },
    },
    { name: 'audio', value: answer(`${SDP}m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n`) },
    { name: 'video', value: answer(`${SDP}m=video 9 UDP/TLS/RTP/SAVPF 96\r\n`) },
    { name: 'unknown property', value: Object.assign(answer(), { unexpected: true }) },
    { name: 'oversized candidate', value: candidate('x'.repeat(4097)) },
    { name: 'contradictory answer', value: answer(`${SDP}a=ice-ufrag:changed\r\n`) },
  ];
  for (const invalid of invalidSignals) {
    await t.test(invalid.name, async (t) => {
      const f = fixture(t);
      await connect(f);
      await f.sender.acceptSignal(invalid.value);
      await f.sender.acceptSignal(invalid.value);
      assert.deepEqual(f.failures, ['transport_failed']);
      assertClosedOnce(f);
    });
  }
});

test('validates both the created offer and the applied local SDP before signaling', async (t) => {
  for (const applied of [false, true]) {
    await t.test(applied ? 'applied SDP' : 'created offer', async (t) => {
      const f = fixture(t);
      const invalid: RTCSessionDescriptionInit = { type: 'offer', sdp: `${SDP}m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n` };
      if (applied) f.peer.localDescriptionOverride = invalid;
      else f.peer.offer = invalid;
      await assert.rejects(f.sender.connect(), hasReason('transport_failed'));
      assert.deepEqual(f.failures, ['transport_failed']);
      assert.deepEqual(f.signals, []);
      assertClosedOnce(f);
    });
  }
});

test('bounds early candidates and pending serialized signals', async (t) => {
  await t.test('early candidates', async (t) => {
    const f = fixture(t);
    const rejected = assert.rejects(f.sender.connect(), hasReason('transport_failed'));
    await turn();
    for (let index = 0; index <= LOCAL_EXECUTION_PROTOCOL_LIMITS.iceCandidates; index++) {
      await f.sender.acceptSignal(candidate(`candidate-${index}`));
    }
    await rejected;
    assert.equal(f.peer.candidates.length, 0);
    assert.deepEqual(f.failures, ['transport_failed']);
    assertClosedOnce(f);
  });
  await t.test('blocked signal queue', async (t) => {
    const f = fixture(t);
    const offer = f.peer.offerGate = deferred<RTCSessionDescriptionInit>();
    const rejected = assert.rejects(f.sender.connect(), hasReason('transport_failed'));
    await turn();
    const pending: Promise<void>[] = [];
    for (let index = 0; index <= LOCAL_EXECUTION_PROTOCOL_LIMITS.queuedSignals; index++) {
      pending.push(f.sender.acceptSignal(candidate(`candidate-${index}`)));
    }
    await rejected;
    offer.resolve({ type: 'offer', sdp: SDP });
    await Promise.all(pending);
    assert.deepEqual(f.failures, ['transport_failed']);
    assert.deepEqual(f.signals, []);
    assertClosedOnce(f);
  });
});

test('rejects unexpected tracks/channels, unreliable channel options and transport failures', async (t) => {
  const mismatches: Array<{ name: string; change: (channel: ControlledChannel) => void }> = [
    { name: 'label', change: (channel) => { channel.label = 'room-audio'; } },
    { name: 'protocol', change: (channel) => { channel.protocol = 'other'; } },
    { name: 'unordered', change: (channel) => { channel.ordered = false; } },
    { name: 'lifetime', change: (channel) => { channel.maxPacketLifeTime = 1; } },
    { name: 'retransmits', change: (channel) => { channel.maxRetransmits = 0; } },
  ];
  for (const mismatch of mismatches) {
    await t.test(mismatch.name, async (t) => {
      const f = fixture(t);
      mismatch.change(f.channel);
      await assert.rejects(f.sender.connect(), hasReason('transport_failed'));
      assert.deepEqual(f.failures, ['transport_failed']);
      assertClosedOnce(f);
    });
  }
  await t.test('track', async (t) => {
    const f = fixture(t);
    await connect(f);
    let stops = 0;
    f.peer.emit('track', { track: { stop: () => { stops++; } } });
    assert.equal(stops, 1);
    assert.deepEqual(f.failures, ['transport_failed']);
    assertClosedOnce(f);
  });
  await t.test('unexpected channel', async (t) => {
    const f = fixture(t);
    await connect(f);
    const extra = new ControlledChannel();
    f.peer.emit('datachannel', { channel: extra });
    assert.equal(extra.closeCalls, 1);
    assert.deepEqual(f.failures, ['transport_failed']);
    assertClosedOnce(f);
  });
  for (const state of ['failed', 'disconnected', 'closed'] satisfies RTCPeerConnectionState[]) {
    await t.test(`peer ${state}`, async (t) => {
      const f = fixture(t);
      await connect(f);
      f.peer.setConnectionState(state);
      assert.deepEqual(f.failures, ['transport_failed']);
      assertClosedOnce(f);
    });
  }
  await t.test('channel error', async (t) => {
    const f = fixture(t);
    await connect(f);
    f.channel.emit('error', new Event('error'));
    assert.deepEqual(f.failures, ['transport_failed']);
    assertClosedOnce(f);
  });
});

test('close drops queued frames and ignores late native results, saved callbacks and signals', async (t) => {
  const f = fixture(t);
  await connect(f);
  start(f);
  const pause = deferred<LocalExecutionMutationResult>();
  f.api.pauseReplies.push(pause);
  const pausing = f.sender.setPaused(true);
  await turn();
  const messages = f.channel.listenersFor('message');
  const candidates = f.peer.listenersFor('icecandidate');
  f.sender.close();
  f.sender.close();
  f.api.replyFrames(0, 8, true);
  pause.reject(new Error('Late native failure'));
  await pausing;
  await f.sender.setPaused(false);
  await f.sender.acceptSignal(answer());
  for (const listener of messages) listener({ data: 'late invalid data' });
  for (const listener of candidates) listener({ candidate: null });
  await turn();
  assert.equal(f.channel.frameCount(), 0);
  assert.equal(f.sender.completed, false);
  assert.equal(f.api.reads.length, 1);
  assert.deepEqual(f.api.mutations, ['paused:true']);
  assert.deepEqual(f.failures, []);
  assert.equal(f.signals.length, 1);
  assertClosedOnce(f);
});

test('cancellation drops an already-held paused batch and cannot resume it', async (t) => {
  const f = fixture(t);
  await connect(f);
  start(f);
  await f.sender.setPaused(true);
  f.api.replyFrames(0);
  await turn();
  assert.equal(f.channel.frameCount(), 0);
  f.sender.close();
  await f.sender.setPaused(false);
  await turn();
  assert.equal(f.channel.frameCount(), 0);
  assert.equal(f.api.reads.length, 1);
  assert.deepEqual(f.api.mutations, ['paused:true']);
  assert.deepEqual(f.failures, []);
  assertClosedOnce(f);
});

test('reports only known local failure reasons for native and RTC exceptions', async (t) => {
  await t.test('native read status', async (t) => {
    const f = fixture(t);
    await connect(f);
    start(f);
    f.api.reads[0].reply.resolve({ status: 'failed', reason: 'provider_unavailable' });
    await turn();
    assert.deepEqual(f.failures, ['provider_unavailable']);
    assertClosedOnce(f);
  });
  await t.test('native pause status', async (t) => {
    const f = fixture(t);
    await connect(f);
    start(f);
    const pause = deferred<LocalExecutionMutationResult>();
    f.api.pauseReplies.push(pause);
    const rejected = assert.rejects(f.sender.setPaused(true), hasReason('permission_revoked'));
    pause.resolve({ status: 'failed', reason: 'permission_revoked' });
    await rejected;
    assert.deepEqual(f.failures, ['permission_revoked']);
    assertClosedOnce(f);
  });
  await t.test('RTC send exception', async (t) => {
    const f = fixture(t);
    await connect(f);
    f.channel.sendError = new Error('Untrusted RTC details');
    start(f);
    f.api.replyFrames(0, 1);
    await turn();
    assert.deepEqual(f.failures, ['transport_failed']);
    assertClosedOnce(f);
  });
});

for (const operation of ['read', 'pause', 'played'] as const) {
  test(`${operation} failures retain exact source details through sender callbacks and mutation queues`, async (t) => {
    const f = fixture(t);
    const sourceFailure: LocalRuntimeSourceFailure = { code: 'recovery_failed', attempts: 37 };
    await connect(f);
    start(f);
    if (operation === 'read') {
      f.api.reads[0].reply.resolve({ status: 'failed', reason: 'worker_failed', sourceFailure });
    } else {
      const reply = deferred<LocalExecutionMutationResult>();
      if (operation === 'pause') {
        f.api.pauseReplies.push(reply);
        const rejected = assert.rejects(f.sender.setPaused(true), (error: unknown) =>
          error instanceof LocalExecutionError && error.sourceFailure?.code === 'recovery_failed'
          && error.sourceFailure.attempts === 37);
        reply.resolve({ status: 'failed', reason: 'worker_failed', sourceFailure });
        await rejected;
      } else {
        f.api.replyFrames(0, 1);
        await turn();
        f.api.ackReplies.push(reply);
        f.channel.receive({ kind: 'credit', consumedFrames: 1, windowEnd: 26 });
        f.channel.receive({ kind: 'played', playedFrames: 1 });
        await turn();
        reply.resolve({ status: 'failed', reason: 'worker_failed', sourceFailure });
      }
    }
    await turn();
    assert.deepEqual(f.failureDetails, [{ reason: 'worker_failed', sourceFailure }]);
    assertClosedOnce(f);
  });
}

test('cancellation suppresses late native source details from in-flight reads and pause mutations', async (t) => {
  const f = fixture(t);
  await connect(f);
  start(f);
  const reply = deferred<LocalExecutionMutationResult>();
  f.api.pauseReplies.push(reply);
  const pausing = f.sender.setPaused(true);
  await turn();
  f.sender.close();
  const failure = {
    status: 'failed', reason: 'worker_failed', sourceFailure: { code: 'recovery_failed', attempts: 37 },
  } satisfies LocalExecutionMutationResult;
  reply.resolve(failure);
  f.api.reads[0].reply.resolve(failure);
  await pausing;
  await turn();
  assert.deepEqual(f.failureDetails, []);
  assertClosedOnce(f);
});

test('known renderer source errors survive a rejected native mutation without exposing its exception message', async (t) => {
  const f = fixture(t);
  await connect(f);
  start(f);
  const reply = deferred<LocalExecutionMutationResult>();
  f.api.pauseReplies.push(reply);
  const rejected = assert.rejects(f.sender.setPaused(true), LocalExecutionError);
  reply.reject(new LocalExecutionError('worker_failed', { code: 'runtime' }));
  await rejected;
  await turn();
  assert.deepEqual(f.failureDetails, [{ reason: 'worker_failed', sourceFailure: { code: 'runtime' } }]);
  assertClosedOnce(f);
});
