import {
  LOCAL_EXECUTION_PROTOCOL_LIMITS,
  LOCAL_EXECUTION_RUNTIME_LIMITS,
  LOCAL_MEDIA_CHANNEL_LABEL,
  LOCAL_MEDIA_CHANNEL_OPTIONS,
  LOCAL_MEDIA_FORMAT,
  LOCAL_MEDIA_MAX_RECORD_BYTES,
  advanceLocalMediaFlow,
  assertLocalMediaChannel,
  createLocalMediaFlowState,
  decodeLocalMediaRecord,
  encodeLocalMediaRecord,
  isLocalMediaSdp,
  isLocalOpusPacket,
  localFrameReadInputSchema,
  localMediaGenerationSchema,
  localMediaSignalSchema,
  type LocalExecutionFailure,
  type LocalExecutionMutationResult,
  type LocalMediaChannelParameters,
  type LocalMediaGeneration,
  type LocalMediaRecord,
  type LocalMediaSignal,
  type LocalRuntimeSourceFailure,
} from '@monky/shared';
import {
  LocalExecutionError,
  requireLocalMutation,
  toLocalExecutionError,
  type LocalExecutionApi,
} from './localExecutionSupport';

type MediaCandidate = Extract<LocalMediaSignal['signal'], { signalType: 'candidate' }>['candidate'];

export interface LocalAudioChannelEventMap {
  open: Event;
  close: Event;
  error: Event;
  bufferedamountlow: Event;
  message: { readonly data: unknown };
}

export interface LocalAudioChannel extends LocalMediaChannelParameters {
  readonly readyState: RTCDataChannelState;
  readonly bufferedAmount: number;
  binaryType: BinaryType;
  bufferedAmountLowThreshold: number;
  addEventListener<K extends keyof LocalAudioChannelEventMap>(
    type: K, listener: (event: LocalAudioChannelEventMap[K]) => void
  ): void;
  removeEventListener<K extends keyof LocalAudioChannelEventMap>(
    type: K, listener: (event: LocalAudioChannelEventMap[K]) => void
  ): void;
  send(data: Uint8Array<ArrayBuffer>): void;
  close(): void;
}

export interface LocalAudioPeerEventMap {
  connectionstatechange: Event;
  icecandidate: { readonly candidate: MediaCandidate };
  datachannel: { readonly channel: LocalAudioChannel };
  track: { readonly track: Pick<MediaStreamTrack, 'stop'> };
}

export interface LocalAudioPeer {
  readonly connectionState: RTCPeerConnectionState;
  readonly localDescription: RTCSessionDescriptionInit | null;
  createDataChannel(label: string, options: RTCDataChannelInit): LocalAudioChannel;
  createOffer(): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(description: RTCSessionDescriptionInit): Promise<void>;
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
  addIceCandidate(candidate: RTCIceCandidateInit | null): Promise<void>;
  addEventListener<K extends keyof LocalAudioPeerEventMap>(
    type: K, listener: (event: LocalAudioPeerEventMap[K]) => void
  ): void;
  removeEventListener<K extends keyof LocalAudioPeerEventMap>(
    type: K, listener: (event: LocalAudioPeerEventMap[K]) => void
  ): void;
  close(): void;
}

export interface LocalAudioSenderOptions {
  taskId: string;
  media: LocalMediaGeneration;
  api: Pick<LocalExecutionApi,
    'readLocalExecutionFrames' | 'acknowledgeLocalExecutionFrames' | 'setLocalExecutionPaused'>;
  sendSignal: (signal: LocalMediaSignal) => void;
  onFailure: (reason: LocalExecutionFailure, sourceFailure?: LocalRuntimeSourceFailure) => void;
  onDrained: (playedFrames: number) => void;
  createPeer?: (configuration: RTCConfiguration) => LocalAudioPeer;
}

export interface LocalAudioSenderTransport {
  readonly sourceEnded: boolean;
  readonly nativePlaybackComplete: boolean;
  readonly completed: boolean;
  readonly playedFrames: number;
  connect(): Promise<void>;
  acceptSignal(signal: LocalMediaSignal): Promise<void>;
  start(mainTaskId: string): void;
  markReady(): void;
  setPaused(paused: boolean): Promise<void>;
  close(): void;
}

const MAX_BUFFERED_BYTES = LOCAL_MEDIA_FORMAT.creditWindowFrames * LOCAL_MEDIA_MAX_RECORD_BYTES +
  encodeLocalMediaRecord({ kind: 'end', finalSequence: 0 }).byteLength;

export class LocalAudioSender implements LocalAudioSenderTransport {
  private readonly media: LocalMediaGeneration | null;
  private readonly taskId: string;
  private peer: LocalAudioPeer | null = null;
  private channel: LocalAudioChannel | null = null;
  private readonly listeners: Array<() => void> = [];
  private connectPromise: Promise<void> | null = null;
  private resolveConnect: (() => void) | null = null;
  private rejectConnect: ((error: Error) => void) | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private readRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = false;
  private closed = false;
  private offerSent = false;
  private answerSdp: string | null = null;
  private answerApplied = false;
  private negotiation: Promise<void> = Promise.resolve();
  private pendingSignals = 0;
  private remoteCandidates = 0;
  private localCandidates = 0;
  private earlyCandidates: MediaCandidate[] = [];
  private flow = createLocalMediaFlowState();
  private mainTaskId: string | null = null;
  private mediaReady = false;
  private ended = false;
  private finalFrameCount: number | null = null;
  private paused = false;
  private pendingPauses = 0;
  private frames: Uint8Array<ArrayBuffer>[] = [];
  private pumping = false;
  private pumpRequested = false;
  private mutations: Promise<void> = Promise.resolve();
  private ackPending = false;
  private nativeAcknowledgedFrames = 0;
  private playedQueue: number[] = [];

  constructor(private readonly options: LocalAudioSenderOptions) {
    const media = localMediaGenerationSchema.safeParse(options.media);
    this.media = media.success ? media.data : null;
    this.taskId = options.taskId;
  }

  get sourceEnded(): boolean { return this.ended; }
  get nativePlaybackComplete(): boolean {
    return this.finalFrameCount !== null && this.nativeAcknowledgedFrames === this.finalFrameCount;
  }
  get completed(): boolean { return this.flow.drained && this.nativePlaybackComplete; }
  get playedFrames(): number { return this.flow.playedFrames; }

  connect(): Promise<void> {
    if (this.closed) return Promise.reject(new LocalExecutionError('cancelled'));
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
    });
    try {
      if (!this.media || !localMediaSignalSchema.shape.taskId.safeParse(this.taskId).success) {
        throw new LocalExecutionError('transport_failed');
      }
      const createPeer = this.options.createPeer ?? ((configuration: RTCConfiguration) => new RTCPeerConnection(configuration));
      const peer = createPeer({ iceServers: this.media.iceServers });
      if (this.closed) {
        this.cleanup(() => peer.close());
        return this.connectPromise;
      }
      this.peer = peer;
      this.listenPeer(peer, 'connectionstatechange', () => this.checkConnection());
      this.listenPeer(peer, 'icecandidate', (event) => this.sendCandidate(event.candidate));
      this.listenPeer(peer, 'datachannel', (event) => {
        if (this.closed) return;
        if (event.channel !== this.channel) this.cleanup(() => event.channel.close());
        this.fail('transport_failed');
      });
      this.listenPeer(peer, 'track', (event) => {
        if (this.closed) return;
        this.cleanup(() => event.track.stop());
        this.fail('transport_failed');
      });
      const channel = peer.createDataChannel(LOCAL_MEDIA_CHANNEL_LABEL, { ...LOCAL_MEDIA_CHANNEL_OPTIONS });
      if (this.closed) {
        this.cleanup(() => channel.close());
        return this.connectPromise;
      }
      this.channel = channel;
      assertLocalMediaChannel(channel);
      channel.binaryType = 'arraybuffer';
      channel.bufferedAmountLowThreshold = MAX_BUFFERED_BYTES - LOCAL_MEDIA_MAX_RECORD_BYTES;
      this.listenChannel(channel, 'open', () => this.checkConnection());
      this.listenChannel(channel, 'close', () => this.fail('transport_failed'));
      this.listenChannel(channel, 'error', () => this.fail('transport_failed'));
      this.listenChannel(channel, 'message', (event) => this.receiveRecord(event.data));
      this.listenChannel(channel, 'bufferedamountlow', () => this.requestPump());
      this.connectTimer = setTimeout(() => this.fail('timeout'), LOCAL_EXECUTION_PROTOCOL_LIMITS.mediaConnectTimeoutMs);
      this.negotiate(async () => {
        const offer = await peer.createOffer();
        if (this.closed) return;
        if (offer.type !== 'offer' || typeof offer.sdp !== 'string' || !isLocalMediaSdp(offer.sdp)) {
          throw new LocalExecutionError('transport_failed');
        }
        localMediaSignalSchema.parse({
          taskId: this.taskId, mediaGeneration: this.media?.generation,
          signal: { signalType: 'offer', sdp: offer },
        });
        await peer.setLocalDescription(offer);
        if (this.closed) return;
        const description = peer.localDescription;
        if (description?.type !== 'offer' || typeof description.sdp !== 'string' || !isLocalMediaSdp(description.sdp)) {
          throw new LocalExecutionError('transport_failed');
        }
        this.emitSignal({ signalType: 'offer', sdp: { type: 'offer', sdp: description.sdp } });
        if (this.closed) return;
        this.offerSent = true;
        this.checkConnection();
      });
    } catch (error: unknown) {
      this.failError(error);
    }
    return this.connectPromise;
  }

  acceptSignal(signal: LocalMediaSignal): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (!signal || typeof signal !== 'object') {
      this.fail('transport_failed');
      return Promise.resolve();
    }
    if (signal.taskId !== this.taskId || signal.mediaGeneration !== this.media?.generation) return Promise.resolve();
    const parsed = localMediaSignalSchema.safeParse(signal);
    if (!parsed.success || parsed.data.signal.signalType === 'offer') {
      this.fail('transport_failed');
      return Promise.resolve();
    }
    const incoming = parsed.data.signal;
    if (++this.pendingSignals > LOCAL_EXECUTION_PROTOCOL_LIMITS.queuedSignals ||
        (incoming.signalType === 'candidate' && ++this.remoteCandidates > LOCAL_EXECUTION_PROTOCOL_LIMITS.iceCandidates)) {
      this.fail('transport_failed');
      return Promise.resolve();
    }
    return this.negotiate(async () => {
      try {
        if (incoming.signalType === 'candidate') {
          if (!this.answerApplied) {
            if (this.earlyCandidates.length >= LOCAL_EXECUTION_PROTOCOL_LIMITS.iceCandidates) {
              throw new LocalExecutionError('transport_failed');
            }
            this.earlyCandidates.push(incoming.candidate);
          } else {
            await this.peer?.addIceCandidate(incoming.candidate);
          }
          return;
        }
        if (this.answerSdp !== null) {
          if (this.answerSdp !== incoming.sdp.sdp) throw new LocalExecutionError('transport_failed');
          return;
        }
        const peer = this.peer;
        if (!peer || !this.offerSent || !isLocalMediaSdp(incoming.sdp.sdp)) {
          throw new LocalExecutionError('transport_failed');
        }
        this.answerSdp = incoming.sdp.sdp;
        await peer.setRemoteDescription(incoming.sdp);
        if (this.closed) return;
        this.answerApplied = true;
        const candidates = this.earlyCandidates.splice(0);
        for (const candidate of candidates) {
          if (this.closed) return;
          await peer.addIceCandidate(candidate);
        }
        this.checkConnection();
      } finally {
        this.pendingSignals--;
      }
    });
  }

  start(mainTaskId: string): void {
    if (this.closed) return;
    if (!localFrameReadInputSchema.shape.taskId.safeParse(mainTaskId).success ||
        (this.mainTaskId !== null && this.mainTaskId !== mainTaskId)) {
      this.fail('invalid_request');
      return;
    }
    if (this.mainTaskId !== null) return;
    this.mainTaskId = mainTaskId;
    if (this.paused) {
      void this.setPaused(true).catch((error: unknown) => this.failError(error));
    } else {
      this.requestPump();
    }
  }

  /** Only the server's authoritative ready event releases media, not connection or Main acceptance. */
  markReady(): void {
    if (this.closed || this.mediaReady) return;
    this.mediaReady = true;
    this.requestPump();
  }

  setPaused(paused: boolean): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.paused = paused;
    if (paused) this.clearReadRetry();
    if (this.nativePlaybackComplete || this.mainTaskId === null) {
      this.requestPump();
      return Promise.resolve();
    }
    this.pendingPauses++;
    const mutation = this.mutate((taskId) => this.options.api.setLocalExecutionPaused({ taskId, paused }));
    return mutation.finally(() => {
      this.pendingPauses--;
      this.requestPump();
    });
  }

  close(): void {
    this.dispose(new LocalExecutionError('cancelled'));
  }

  private listenPeer<K extends keyof LocalAudioPeerEventMap>(
    peer: LocalAudioPeer, type: K, listener: (event: LocalAudioPeerEventMap[K]) => void
  ): void {
    peer.addEventListener(type, listener);
    this.listeners.push(() => peer.removeEventListener(type, listener));
  }

  private listenChannel<K extends keyof LocalAudioChannelEventMap>(
    channel: LocalAudioChannel, type: K, listener: (event: LocalAudioChannelEventMap[K]) => void
  ): void {
    channel.addEventListener(type, listener);
    this.listeners.push(() => channel.removeEventListener(type, listener));
  }

  private negotiate(operation: () => Promise<void>): Promise<void> {
    this.negotiation = this.negotiation.then(async () => {
      if (!this.closed) await operation();
    }).catch((error: unknown) => this.failError(error));
    return this.negotiation;
  }

  private emitSignal(signal: LocalMediaSignal['signal']): void {
    if (this.closed || !this.media) return;
    this.options.sendSignal(localMediaSignalSchema.parse({
      taskId: this.taskId, mediaGeneration: this.media.generation, signal,
    }));
  }

  private sendCandidate(candidate: MediaCandidate): void {
    if (this.closed) return;
    try {
      if (++this.localCandidates > LOCAL_EXECUTION_PROTOCOL_LIMITS.iceCandidates) {
        throw new LocalExecutionError('transport_failed');
      }
      this.emitSignal({
        signalType: 'candidate',
        candidate: candidate === null ? null : {
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid,
          sdpMLineIndex: candidate.sdpMLineIndex,
          usernameFragment: candidate.usernameFragment,
        },
      });
    } catch (error: unknown) {
      this.failError(error);
    }
  }

  private checkConnection(): void {
    if (this.closed) return;
    try {
      const peer = this.peer;
      const channel = this.channel;
      if (!peer || !channel) return;
      assertLocalMediaChannel(channel);
      if (peer.connectionState === 'failed' || peer.connectionState === 'disconnected' ||
          peer.connectionState === 'closed' || channel.readyState === 'closed' || channel.readyState === 'closing') {
        throw new LocalExecutionError('transport_failed');
      }
      if (!this.connected && this.offerSent && this.answerApplied &&
          peer.connectionState === 'connected' && channel.readyState === 'open') {
        this.connected = true;
        this.clearConnectTimer();
        this.resolveConnect?.();
        this.resolveConnect = null;
        this.rejectConnect = null;
        this.requestPump();
      }
    } catch (error: unknown) {
      this.failError(error);
    }
  }

  private receiveRecord(data: unknown): void {
    if (this.closed) return;
    try {
      if (!this.channel || this.channel.readyState !== 'open') throw new LocalExecutionError('transport_failed');
      assertLocalMediaChannel(this.channel);
      const bytes = data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : null;
      if (!bytes) throw new LocalExecutionError('transport_failed');
      const record = decodeLocalMediaRecord(bytes);
      const previousPlayed = this.flow.playedFrames;
      this.flow = advanceLocalMediaFlow(this.flow, record, 'bot');
      if (record.kind === 'played' && this.flow.playedFrames > previousPlayed) {
        this.playedQueue.push(this.flow.playedFrames);
        this.acknowledgePlayed();
      }
      if (record.kind === 'drainAck') {
        this.finishDrain();
        return;
      }
      this.requestPump();
    } catch (error: unknown) {
      this.failError(error);
    }
  }

  private canPump(): boolean {
    return !this.closed && this.connected && this.mediaReady && this.mainTaskId !== null && !this.paused &&
      this.pendingPauses === 0 && this.channel?.readyState === 'open' &&
      this.peer?.connectionState === 'connected';
  }

  private requestPump(): void {
    if (!this.canPump() || this.readRetryTimer !== null) return;
    if (this.pumping) {
      this.pumpRequested = true;
      return;
    }
    void this.pump();
  }

  private bufferCapacity(): number {
    const amount = this.channel?.bufferedAmount;
    if (amount === undefined || !Number.isFinite(amount) || amount < 0) throw new LocalExecutionError('transport_failed');
    return Math.max(0, MAX_BUFFERED_BYTES - amount);
  }

  private sendRecord(record: LocalMediaRecord): boolean {
    const channel = this.channel;
    if (!channel) return false;
    assertLocalMediaChannel(channel);
    const bytes = encodeLocalMediaRecord(record);
    if (bytes.byteLength > this.bufferCapacity()) return false;
    this.flow = advanceLocalMediaFlow(this.flow, record, 'executor');
    channel.send(Uint8Array.from(bytes));
    return true;
  }

  private async pump(): Promise<void> {
    this.pumping = true;
    try {
      while (this.canPump()) {
        const frame = this.frames[0];
        if (frame) {
          if (this.flow.nextSequence >= this.flow.windowEnd ||
              this.flow.nextSequence - this.nativeAcknowledgedFrames >= LOCAL_MEDIA_FORMAT.creditWindowFrames ||
              !this.sendRecord({ kind: 'frame', sequence: this.flow.nextSequence, opus: frame })) return;
          this.frames.shift();
          continue;
        }
        if (this.ended) {
          if (this.flow.finalSequence === null) this.sendRecord({ kind: 'end', finalSequence: this.flow.nextSequence });
          return;
        }
        // Confirmed PLAYED bounds both the media tail and pending native acknowledgements.
        const count = Math.min(
          LOCAL_EXECUTION_RUNTIME_LIMITS.frameBatch,
          this.flow.windowEnd - this.flow.nextSequence,
          LOCAL_MEDIA_FORMAT.creditWindowFrames - (this.flow.nextSequence - this.nativeAcknowledgedFrames),
          Math.floor(this.bufferCapacity() / LOCAL_MEDIA_MAX_RECORD_BYTES),
        );
        const taskId = this.mainTaskId;
        if (count <= 0 || taskId === null) return;
        const result = await this.options.api.readLocalExecutionFrames({ taskId, count });
        if (this.closed) return;
        if (result.status === 'failed') throw new LocalExecutionError(result.reason, result.sourceFailure);
        if (result.status === 'cancelled') throw new LocalExecutionError('cancelled');
        // Decoder EOF does not retire Main's playback lease.
        if (result.done === true) this.ended = true;
        if (!Array.isArray(result.frames) || result.frames.length > count ||
            typeof result.done !== 'boolean' || !result.frames.every(isLocalOpusPacket)) {
          throw new LocalExecutionError('transport_failed');
        }
        this.frames = result.frames.map((packet) => Uint8Array.from(packet));
        if (this.ended) this.finalFrameCount = this.flow.nextSequence + this.frames.length;
        if (this.frames.length === 0 && !this.ended) {
          // An underrun is not EOF. Retry at the frame cadence without a microtask busy loop.
          if (this.canPump()) this.readRetryTimer = setTimeout(() => {
            this.readRetryTimer = null;
            this.requestPump();
          }, LOCAL_MEDIA_FORMAT.frameDurationMs);
          return;
        }
      }
    } catch (error: unknown) {
      this.failError(error);
    } finally {
      this.pumping = false;
      if (this.pumpRequested) {
        this.pumpRequested = false;
        this.requestPump();
      }
    }
  }

  private mutate(
    operation: (taskId: string) => Promise<LocalExecutionMutationResult>, confirmed?: () => void,
  ): Promise<void> {
    const mutation = this.mutations.then(async () => {
      const taskId = this.mainTaskId;
      if (this.closed || this.nativePlaybackComplete || taskId === null) return;
      try {
        const result = await operation(taskId);
        if (!this.closed && !this.nativePlaybackComplete) requireLocalMutation(result);
        if (!this.closed && result.status === 'completed') confirmed?.();
      } catch (error: unknown) {
        if (!this.closed && !this.nativePlaybackComplete) throw toLocalExecutionError(error);
      }
    });
    this.mutations = mutation.catch((error: unknown) => this.failError(error));
    return mutation;
  }

  private acknowledgePlayed(): void {
    if (this.closed || this.nativePlaybackComplete || this.mainTaskId === null || this.ackPending) return;
    const playedFrames = this.playedQueue.shift();
    if (playedFrames === undefined) return;
    this.ackPending = true;
    const mutation = this.mutate(
      (taskId) => this.options.api.acknowledgeLocalExecutionFrames({ taskId, playedFrames }),
      () => { this.nativeAcknowledgedFrames = playedFrames; },
    );
    void mutation.then(() => {
      this.ackPending = false;
      this.finishDrain();
      this.acknowledgePlayed();
      this.requestPump();
    }, (error: unknown) => {
      this.ackPending = false;
      this.failError(error);
    });
  }

  private finishDrain(): void {
    if (this.closed || !this.flow.drained || !this.nativePlaybackComplete) return;
    this.close();
    try {
      this.options.onDrained(this.flow.playedFrames);
    } catch {
      console.warn('[LocalAudioSender] Drain callback failed');
    }
  }

  private clearConnectTimer(): void {
    if (this.connectTimer === null) return;
    clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  private clearReadRetry(): void {
    if (this.readRetryTimer === null) return;
    clearTimeout(this.readRetryTimer);
    this.readRetryTimer = null;
  }

  private cleanup(operation: () => void): void {
    try {
      operation();
    } catch {
      console.warn('[LocalAudioSender] Resource cleanup failed');
    }
  }

  private dispose(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.clearConnectTimer();
    this.clearReadRetry();
    this.rejectConnect?.(error);
    this.resolveConnect = null;
    this.rejectConnect = null;
    this.frames = [];
    this.playedQueue = [];
    this.earlyCandidates = [];
    this.pumpRequested = false;
    for (const removeListener of this.listeners.splice(0)) this.cleanup(removeListener);
    const channel = this.channel;
    const peer = this.peer;
    this.channel = null;
    this.peer = null;
    if (channel) this.cleanup(() => channel.close());
    if (peer) this.cleanup(() => peer.close());
  }

  private failError(error: unknown): void {
    const failure = toLocalExecutionError(error);
    this.fail(failure.reason, failure.sourceFailure);
  }

  private fail(reason: LocalExecutionFailure, sourceFailure?: LocalRuntimeSourceFailure): void {
    if (this.closed) return;
    const error = new LocalExecutionError(reason, sourceFailure);
    this.dispose(error);
    try {
      this.options.onFailure(error.reason, error.sourceFailure);
    } catch {
      console.warn('[LocalAudioSender] Failure callback failed');
    }
  }
}
