import { RTCPeerConnection, SessionDescription, type RTCDataChannel } from 'werift';
import {
  LOCAL_EXECUTION_PROTOCOL_LIMITS, LOCAL_MEDIA_FORMAT, LOCAL_MEDIA_MAX_RECORD_BYTES, LOCAL_MEDIA_PROTOCOL,
  advanceLocalMediaFlow, assertLocalMediaChannel, createLocalMediaFlowState, decodeLocalMediaRecord,
  encodeLocalMediaRecord, isLocalMediaSdp, localMediaGenerationSchema, localMediaSignalSchema,
  type BotVoiceAuth, type LocalMediaRecord, type LocalMediaSignal,
} from '@monky/shared';

export interface LocalOpusReceiverOptions {
  taskId: string;
  generation: number;
  iceServers: BotVoiceAuth['iceServers'];
  sendSignal(signal: LocalMediaSignal): void;
  onReady(): void;
  onError(error: Error): void;
}

type MediaCandidate = Extract<LocalMediaSignal['signal'], { signalType: 'candidate' }>['candidate'];
interface SignalJob {
  signal: LocalMediaSignal['signal'];
  resolve(): void;
  reject(error: Error): void;
}
interface FrameRead {
  resolve(result: IteratorResult<Uint8Array>): void;
  reject(error: Error): void;
}

const toError = (error: unknown): Error => error instanceof Error ? error : new Error(String(error));

/** A private, data-only answerer, independent of the bot's room audio publisher. */
export class LocalOpusReceiver {
  readonly frames: AsyncIterable<Uint8Array>;
  readonly drained: Promise<void>;
  private readonly options: LocalOpusReceiverOptions;
  private readonly pc: RTCPeerConnection;
  private readonly subscriptions: (() => void)[] = [];
  private readonly timer: ReturnType<typeof setTimeout>;
  private resolveDrained!: () => void;
  private rejectDrained!: (error: Error) => void;
  private channel?: RTCDataChannel;
  private flow = createLocalMediaFlowState();
  private packets: Uint8Array[] = [];
  private pendingRead?: FrameRead;
  private iteratorClaimed = false;
  private started = false;
  private readyReported = false;
  private closed = false;
  private failure?: Error;
  private closing?: Promise<void>;
  private offerReceived = false;
  private candidateCount = 0;
  private localCandidateCount = 0;
  private pendingCandidates: MediaCandidate[] = [];
  private remoteMedia?: { mid: string; usernameFragment: string };
  private signalQueue: SignalJob[] = [];
  private activeSignal?: SignalJob;
  private signaling = false;

  constructor(options: LocalOpusReceiverOptions) {
    if (typeof options.taskId !== 'string' || !options.taskId.length || options.taskId.length > 128) {
      throw new TypeError('Invalid local media task identity.');
    }
    const media = localMediaGenerationSchema.parse({
      protocol: LOCAL_MEDIA_PROTOCOL, generation: options.generation, iceServers: options.iceServers,
    });
    this.options = { ...options, iceServers: media.iceServers };
    this.pc = new RTCPeerConnection({
      iceServers: media.iceServers, bundlePolicy: 'max-bundle',
      codecs: { audio: [], video: [] }, maxMessageSize: LOCAL_MEDIA_MAX_RECORD_BYTES,
    });
    this.drained = new Promise<void>((resolve, reject) => {
      this.resolveDrained = resolve;
      this.rejectDrained = reject;
    });
    // A transport can fail before the parent has attached its playback consumer.
    void this.drained.catch(() => undefined);
    this.frames = { [Symbol.asyncIterator]: () => this.createIterator() };
    this.timer = setTimeout(() => {
      this.fail(new Error('Local media ICE/DTLS/data channel connection timed out.'));
    }, LOCAL_EXECUTION_PROTOCOL_LIMITS.mediaConnectTimeoutMs);
    this.subscriptions.push(
      this.pc.connectionStateChange.subscribe((state) => {
        if (this.closed) return;
        if (state === 'connected') this.checkReady();
        else if (state === 'failed' || state === 'disconnected' || state === 'closed') {
          this.transportEnded(new Error(`Local media transport ${state}.`));
        }
      }).unSubscribe,
      this.pc.iceConnectionStateChange.subscribe((state) => {
        if (!this.closed && (state === 'failed' || state === 'disconnected' || state === 'closed')) {
          this.transportEnded(new Error(`Local media ICE transport ${state}.`));
        }
      }).unSubscribe,
      this.pc.onDataChannel.subscribe((channel) => this.acceptChannel(channel)).unSubscribe,
      this.pc.onIceCandidate.subscribe((candidate) => {
        if (this.closed) return;
        try {
          if (++this.localCandidateCount > LOCAL_EXECUTION_PROTOCOL_LIMITS.iceCandidates) {
            throw new RangeError('Local media outgoing ICE candidate limit exceeded.');
          }
          this.sendSignal({ signalType: 'candidate', candidate: candidate?.toJSON() ?? null });
        } catch (error) { this.fail(toError(error)); }
      }).unSubscribe,
    );
  }

  get hasDrained(): boolean { return this.flow.drained; }
  get playedFrames(): number { return this.flow.playedFrames; }

  handleSignal(input: LocalMediaSignal): Promise<void> {
    let signal: LocalMediaSignal['signal'];
    try {
      this.assertOpen();
      const envelope = localMediaSignalSchema.parse(input);
      if (envelope.taskId !== this.options.taskId || envelope.mediaGeneration !== this.options.generation) {
        throw new Error('Local media signal belongs to another task or generation.');
      }
      signal = envelope.signal;
      if (signal.signalType === 'answer') throw new Error('The local media receiver accepts offers, not answers.');
      if (this.signalQueue.length + (this.activeSignal ? 1 : 0) >= LOCAL_EXECUTION_PROTOCOL_LIMITS.queuedSignals) {
        throw new RangeError('Local media signaling queue exceeded.');
      }
      if (signal.signalType === 'offer') {
        if (this.offerReceived) throw new Error('Local media renegotiation is not allowed.');
        this.offerReceived = true;
      } else if (++this.candidateCount > LOCAL_EXECUTION_PROTOCOL_LIMITS.iceCandidates) {
        throw new RangeError('Local media ICE candidate limit exceeded.');
      }
    } catch (error) {
      const failure = toError(error);
      this.fail(failure);
      return Promise.reject(failure);
    }
    return new Promise<void>((resolve, reject) => {
      this.signalQueue.push({ signal, resolve, reject });
      void this.processSignals().catch((error: unknown) => this.options.onError(toError(error)));
    });
  }

  start(): void {
    this.assertOpen();
    if (this.started) return;
    if (!this.readyReported || !this.isConnected()) throw new Error('Local media is not ready to start.');
    try {
      this.started = true;
      this.sendRecord({ kind: 'credit', consumedFrames: 0, windowEnd: LOCAL_MEDIA_FORMAT.creditWindowFrames });
    } catch (error) {
      const failure = toError(error);
      this.fail(failure);
      throw failure;
    }
  }

  /** Advances the publisher's playback clock, not proof of audible listener delivery. */
  markFrameAdvanced(): void {
    this.assertOpen();
    if (!this.started || this.flow.playedFrames >= this.flow.consumedFrames) {
      throw new Error('No consumed local Opus frame is awaiting playback.');
    }
    try {
      this.sendRecord({ kind: 'played', playedFrames: this.flow.playedFrames + 1 });
      this.checkDrain();
      this.deliverFrame();
    } catch (error) {
      const failure = toError(error);
      this.fail(failure);
      throw failure;
    }
  }

  finish(): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (!this.hasDrained) return Promise.reject(new Error('Local media completed before playback drained.'));
    return this.close();
  }

  abort(reason: Error): Promise<void> {
    return this.close(reason);
  }

  private assertOpen(): void {
    if (this.closed) throw this.failure ?? new Error('Local media receiver is closed.');
  }

  private isConnected(): boolean {
    return this.pc.connectionState === 'connected' && this.channel?.readyState === 'open';
  }

  private checkReady(): void {
    if (this.closed || this.readyReported || !this.isConnected()) return;
    this.readyReported = true;
    clearTimeout(this.timer);
    try { this.options.onReady(); } catch (error) { this.fail(toError(error)); }
  }

  private acceptChannel(channel: RTCDataChannel): void {
    if (this.closed) { channel.close(); return; }
    try {
      if (this.channel) throw new Error('Unexpected extra local media data channel.');
      assertLocalMediaChannel(channel);
      if (channel.negotiated) throw new Error('Local media requires an executor-created in-band data channel.');
      this.channel = channel;
      this.subscriptions.push(
        channel.stateChange.subscribe((state) => {
          if (this.closed) return;
          if (state === 'open') this.checkReady();
          else if (state === 'closing' || state === 'closed') {
            this.transportEnded(new Error('Local media data channel closed before playback drained.'));
          }
        }).unSubscribe,
        channel.onMessage.subscribe((data) => this.receive(data)).unSubscribe,
        channel.error.subscribe((error) => this.transportEnded(error)).unSubscribe,
      );
      this.checkReady();
    } catch (error) { this.fail(toError(error)); }
  }

  private receive(data: string | Uint8Array): void {
    if (this.closed) return;
    try {
      if (!this.started) throw new Error('Local media arrived before authoritative start.');
      if (typeof data === 'string') throw new TypeError('Local media records must be binary.');
      const record = decodeLocalMediaRecord(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      this.flow = advanceLocalMediaFlow(this.flow, record, 'executor');
      if (record.kind === 'frame') {
        if (this.packets.length >= LOCAL_MEDIA_FORMAT.creditWindowFrames) {
          throw new RangeError('Local media packet buffer exceeded.');
        }
        this.packets.push(record.opus);
      }
      this.checkDrain();
      this.deliverFrame();
    } catch (error) { this.fail(toError(error)); }
  }

  private sendRecord(record: LocalMediaRecord): void {
    if (!this.started || !this.isConnected() || !this.channel) throw new Error('Local media channel is not writable.');
    const next = advanceLocalMediaFlow(this.flow, record, 'bot');
    this.channel.send(Buffer.from(encodeLocalMediaRecord(record)));
    this.flow = next;
  }

  private createIterator(): AsyncIterator<Uint8Array> {
    if (this.iteratorClaimed) throw new Error('Local Opus frames have a single playback consumer.');
    this.iteratorClaimed = true;
    return {
      next: () => this.readFrame(),
      return: async () => {
        if (!this.hasDrained) await this.abort(new Error('Local Opus playback iterator was cancelled.'));
        return { done: true, value: undefined };
      },
      throw: async (reason: unknown) => {
        const error = toError(reason);
        await this.abort(error);
        throw error;
      },
    };
  }

  private readFrame(): Promise<IteratorResult<Uint8Array>> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.hasDrained) return Promise.resolve({ done: true, value: undefined });
    if (this.pendingRead) return Promise.reject(new Error('Concurrent local Opus reads are not allowed.'));
    return new Promise<IteratorResult<Uint8Array>>((resolve, reject) => {
      this.pendingRead = { resolve, reject };
      try { this.deliverFrame(); } catch (error) { this.fail(toError(error)); }
    });
  }

  private deliverFrame(): void {
    const read = this.pendingRead;
    if (!read || this.closed) return;
    if (this.hasDrained) {
      this.pendingRead = undefined;
      read.resolve({ done: true, value: undefined });
      return;
    }
    // Do not turn iterator read-ahead into an unbounded queue outside the credit window.
    if (this.flow.consumedFrames !== this.flow.playedFrames) return;
    const frame = this.packets.shift();
    if (!frame) return;
    const consumedFrames = this.flow.consumedFrames + 1;
    this.sendRecord({
      kind: 'credit', consumedFrames,
      windowEnd: Math.min(consumedFrames + LOCAL_MEDIA_FORMAT.creditWindowFrames, LOCAL_MEDIA_FORMAT.maxFrameCount),
    });
    this.pendingRead = undefined;
    read.resolve({ done: false, value: frame });
  }

  private checkDrain(): void {
    const { finalSequence, playedFrames, consumedFrames, drained } = this.flow;
    if (drained || finalSequence === null || playedFrames !== finalSequence ||
        consumedFrames !== finalSequence || this.packets.length) return;
    this.sendRecord({ kind: 'drainAck', finalSequence });
    this.resolveDrained();
  }

  private sendSignal(signal: LocalMediaSignal['signal']): void {
    this.assertOpen();
    this.options.sendSignal({ taskId: this.options.taskId, mediaGeneration: this.options.generation, signal });
  }

  private async processSignals(): Promise<void> {
    if (this.signaling || this.closed) return;
    this.signaling = true;
    try {
      while (!this.closed) {
        const job = this.signalQueue.shift();
        if (!job) break;
        this.activeSignal = job;
        try {
          await this.applySignal(job.signal);
          this.assertOpen();
          job.resolve();
        } catch (error) {
          const failure = toError(error);
          job.reject(failure);
          this.fail(failure);
        } finally { this.activeSignal = undefined; }
      }
    } finally {
      try {
        if (this.closed) {
          await this.closing;
          // werift SDP/gathering can finish after close(), whose own cleanup is one-shot.
          await Promise.all(this.pc.dtlsTransports.map(async (transport) => {
            await transport.stop();
            await transport.iceTransport.connection.close();
          }));
          await this.pc.sctpTransport?.stop();
        }
      } finally { this.signaling = false; }
    }
  }

  private async applySignal(signal: LocalMediaSignal['signal']): Promise<void> {
    this.assertOpen();
    if (signal.signalType === 'candidate') {
      if (!this.remoteMedia) this.pendingCandidates.push(signal.candidate);
      else await this.applyCandidate(signal.candidate);
      return;
    }
    if (signal.signalType !== 'offer' || !isLocalMediaSdp(signal.sdp.sdp)) {
      throw new TypeError('Expected a data-only local media offer.');
    }
    const description = SessionDescription.parse(signal.sdp.sdp);
    const media = description.media[0];
    if (!media?.rtp.muxId || !media.iceParams?.usernameFragment) throw new Error('Local media SDP is missing its ICE identity.');
    this.candidateCount += media.iceCandidates.length;
    if (this.candidateCount > LOCAL_EXECUTION_PROTOCOL_LIMITS.iceCandidates) {
      throw new RangeError('Local media ICE candidate limit exceeded.');
    }
    await this.pc.setRemoteDescription(signal.sdp);
    this.assertOpen();
    if (this.pc.getTransceivers().length) throw new Error('Local media must not negotiate audio or video tracks.');
    for (const transport of this.pc.iceTransports) {
      // werift adds public STUN even for []/TURN-only ICE; retain only the authenticated configuration.
      transport.connection.stunServer = transport.connection.options.stunServer;
    }
    this.remoteMedia = { mid: media.rtp.muxId, usernameFragment: media.iceParams.usernameFragment };
    while (this.pendingCandidates.length) {
      const candidate = this.pendingCandidates.shift();
      if (candidate !== undefined) await this.applyCandidate(candidate);
      this.assertOpen();
    }
    const answer = await this.pc.createAnswer();
    this.assertOpen();
    if (!isLocalMediaSdp(answer.sdp)) throw new Error('Local media answer is not data-only.');
    await this.pc.setLocalDescription(answer);
    this.assertOpen();
    const local = this.pc.localDescription;
    if (!local || !isLocalMediaSdp(local.sdp)) throw new Error('Local media answer is missing.');
    this.sendSignal({ signalType: 'answer', sdp: { type: 'answer', sdp: local.sdp } });
  }

  private async applyCandidate(candidate: MediaCandidate): Promise<void> {
    this.assertOpen();
    if (candidate === null) {
      await this.pc.addIceCandidate(null);
      return;
    }
    if (candidate.candidate && candidate.sdpMid == null && candidate.sdpMLineIndex == null) {
      throw new Error('Local media ICE candidate is missing its media identity.');
    }
    if ((candidate.sdpMid != null && candidate.sdpMid !== this.remoteMedia?.mid) ||
        (candidate.sdpMLineIndex != null && candidate.sdpMLineIndex !== 0)) {
      throw new Error('Local media ICE candidate belongs to another media section.');
    }
    let usernameFragment = candidate.usernameFragment ?? undefined;
    const fields = candidate.candidate.trim().split(/\s+/);
    for (let i = 8; i + 1 < fields.length; i += 2) {
      if (fields[i] === 'ufrag') {
        if (usernameFragment !== undefined && usernameFragment !== fields[i + 1]) {
          throw new Error('Local media ICE candidate has conflicting generations.');
        }
        usernameFragment = fields[i + 1];
      }
    }
    if (usernameFragment !== undefined && usernameFragment !== this.remoteMedia?.usernameFragment) {
      throw new Error('Local media ICE candidate belongs to a stale ICE generation.');
    }
    await this.pc.addIceCandidate({
      candidate: candidate.candidate, sdpMid: candidate.sdpMid ?? undefined,
      sdpMLineIndex: candidate.sdpMLineIndex ?? undefined, usernameFragment,
    });
  }

  private transportEnded(error: Error): void {
    // After verified EOF/PLAYED, the owner still requires its bounded server completion ACK.
    if (!this.hasDrained) this.fail(error);
  }

  private fail(error: Error): void {
    if (this.closed) return;
    void this.abort(error).catch((failure: unknown) => this.options.onError(toError(failure)));
    this.options.onError(error);
  }

  private close(reason?: Error): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.failure = reason;
    clearTimeout(this.timer);
    this.packets = [];
    this.pendingCandidates = [];
    const cancelled = reason ?? new Error('Local media receiver finished.');
    this.activeSignal?.reject(cancelled);
    for (const job of this.signalQueue) job.reject(cancelled);
    this.signalQueue = [];
    if (reason) {
      this.rejectDrained(reason);
      this.pendingRead?.reject(reason);
    } else {
      this.pendingRead?.resolve({ done: true, value: undefined });
    }
    this.pendingRead = undefined;
    for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe();
    this.closing = (async () => {
      try { this.channel?.close(); } finally { await this.pc.close(); }
    })();
    return this.closing;
  }
}
