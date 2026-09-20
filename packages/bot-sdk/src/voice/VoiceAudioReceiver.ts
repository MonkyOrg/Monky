export interface BotVoicePacket {
  channelId: string;
  userId: string;
  sessionId: string;
  codec: 'opus';
  clockRate: 48000;
  channels: 2;
  /** Raw Opus, not PCM or an Ogg container. Owned by this packet's caller. */
  opus: Uint8Array;
  sequenceNumber: number;
  timestamp: number;
  ssrc: number;
  /** Monotonic milliseconds in this process, not wall time or RTP time. */
  receivedAt: number;
}

export interface BotVoiceAudioReceiver extends AsyncIterableIterator<BotVoicePacket, undefined, undefined> {
  /** Oldest packets dropped to keep the live queue bounded. */
  readonly droppedPackets: number;
  return(): Promise<IteratorResult<BotVoicePacket, undefined>>;
  throw(error: unknown): Promise<IteratorResult<BotVoicePacket, undefined>>;
}

export const MAX_BUFFERED_VOICE_PACKETS = 100;

export class VoiceAudioReceiver implements BotVoiceAudioReceiver {
  private queue: BotVoicePacket[] = [];
  private waiting?: {
    resolve: (result: IteratorResult<BotVoicePacket, undefined>) => void;
    reject: (error: Error) => void;
  };
  private finished = false;
  private failure?: Error;
  private ending?: Promise<IteratorResult<BotVoicePacket, undefined>>;
  private dropped = 0;
  private readonly onAbort = () => {
    void this.return().catch(this.reportError);
  };

  constructor(
    private readonly stop: () => Promise<void>,
    private readonly reportError: (error: Error) => void,
    private readonly signal?: AbortSignal,
  ) {
    signal?.addEventListener('abort', this.onAbort, { once: true });
    if (signal?.aborted) this.onAbort();
  }

  get droppedPackets(): number { return this.dropped; }
  [Symbol.asyncIterator](): BotVoiceAudioReceiver { return this; }

  next(): Promise<IteratorResult<BotVoicePacket, undefined>> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.ending) return this.ending;
    if (this.finished) return Promise.resolve({ done: true, value: undefined });
    if (this.waiting) return Promise.reject(new Error('Await the previous audio packet before requesting another.'));
    const packet = this.queue.shift();
    if (packet) return Promise.resolve({ done: false, value: packet });
    return new Promise((resolve, reject) => { this.waiting = { resolve, reject }; });
  }

  push(packet: BotVoicePacket): void {
    if (this.finished || this.ending) return;
    if (this.waiting) {
      const waiting = this.waiting;
      this.waiting = undefined;
      waiting.resolve({ done: false, value: packet });
      return;
    }
    if (this.queue.length === MAX_BUFFERED_VOICE_PACKETS) {
      this.queue.shift();
      this.dropped++;
    }
    this.queue.push(packet);
  }

  clear(sessionId?: string): void {
    this.queue = sessionId === undefined ? [] : this.queue.filter((packet) => packet.sessionId !== sessionId);
  }

  finish(error?: Error): void {
    if (this.finished) return;
    this.finished = true;
    this.failure = error;
    this.clear();
    this.signal?.removeEventListener('abort', this.onAbort);
    const waiting = this.waiting;
    this.waiting = undefined;
    if (error) waiting?.reject(error);
    else waiting?.resolve({ done: true, value: undefined });
  }

  return(): Promise<IteratorResult<BotVoicePacket, undefined>> {
    if (this.ending) return this.ending;
    this.clear();
    return this.ending = Promise.resolve().then(this.stop).then(() => {
      this.finish();
      return { done: true, value: undefined };
    }, (error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.finish(failure);
      throw failure;
    });
  }

  async throw(error: unknown): Promise<IteratorResult<BotVoicePacket, undefined>> {
    const failure = error instanceof Error ? error : new Error(String(error));
    this.finish(failure);
    await this.return();
    throw failure;
  }
}
