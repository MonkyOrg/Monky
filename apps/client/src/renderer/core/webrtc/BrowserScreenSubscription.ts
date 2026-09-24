import {
  getScreenShareProfile, nativeScreenSignalSchema, screenShareProfileKey, type NativeScreenCall, type NativeScreenFailure,
  type NativeScreenProducer, type NativeScreenSignalPayload, type NativeScreenSource, type ScreenShareQuality,
  type NativeScreenCaptureMode, NATIVE_SCREEN_GAME_STARTUP_TIMEOUT_MS,
} from '@monky/shared';
import { BrowserScreenP2p } from './BrowserScreenP2p';
import { BrowserScreenSfu, type BrowserScreenRpc } from './BrowserScreenSfu';
import { supportsBrowserScreenCodec } from './browserScreenCodecs';

export interface BrowserScreenSubscriptionOptions {
  call: NativeScreenCall;
  publisherSessionId: string;
  source: NativeScreenSource;
  quality: ScreenShareQuality;
  muted: boolean;
  send: (signal: NativeScreenSignalPayload) => Promise<void>;
  rpc: BrowserScreenRpc;
  onTrack: (track: MediaStreamTrack, receiver?: RTCRtpReceiver) => void;
  onCaptureMode: (mode: NativeScreenCaptureMode) => void;
  onUnavailable: (reason: NativeScreenFailure) => void;
  onError: (error: unknown) => void;
}

export class BrowserScreenSubscription {
  public readonly subscriptionId = crypto.randomUUID();
  private readonly producers = new Map<string, NativeScreenProducer>();
  private p2p: BrowserScreenP2p | null = null;
  private sfu: BrowserScreenSfu | null = null;
  private generation: number | null = null;
  private muted: boolean;
  private started = false;
  private stopping = false;
  private remoteClosed = false;
  private stopAcknowledged = false;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private starting: Promise<void> | null = null;
  private opening: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private cancelDiscovery: (() => void) | null = null;
  private gameStartupWait = false;
  private isPlaying = false;

  constructor(private readonly options: BrowserScreenSubscriptionOptions) { this.muted = options.muted; }

  private envelope(body: Record<string, unknown>): NativeScreenSignalPayload {
    const { call, publisherSessionId, source } = this.options;
    return nativeScreenSignalSchema.parse({
      channelId: call.channelId, fromSessionId: call.sessionId, targetSessionId: publisherSessionId, publisherSessionId,
      shareId: source.shareId, sourceInstanceId: source.instanceId, subscriptionId: this.subscriptionId, ...body,
    });
  }

  private fail(error: unknown): void {
    if (this.stopping) return;
    this.options.onUnavailable('connection-failed');
    this.options.onError(error);
  }

  public start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.stopping) return Promise.reject(new DOMException('Screen Watch was retired.', 'AbortError'));
    this.starting = (async () => {
      const cancelled = new Promise<never>((_resolve, reject) => {
        this.cancelDiscovery = () => reject(new DOMException('Screen codec discovery was cancelled.', 'AbortError'));
      });
      let supported: boolean;
      try {
        supported = await Promise.race([
          supportsBrowserScreenCodec(getScreenShareProfile(this.options.source.video, this.options.quality)), cancelled,
        ]);
      } finally { this.cancelDiscovery = null; }
      if (!supported) {
        this.options.onUnavailable('unsupported');
        throw new Error('This browser cannot decode the requested screen rendition in H.264 Main at its required level.');
      }
      if (this.stopping) throw new DOMException('Screen Watch was retired during codec discovery.', 'AbortError');
      this.started = true;
      this.startupTimer = setTimeout(() => this.fail(new Error('The browser screen did not present its first frame.')), 30000);
      await this.options.send(this.envelope({ action: 'watch', backend: 'browser', quality: this.options.quality }));
    })();
    return this.starting;
  }

  public playing(): void {
    this.isPlaying = true;
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = null;
  }

  public async receive(value: NativeScreenSignalPayload): Promise<void> {
    const signal = nativeScreenSignalSchema.parse(value);
    const { call, source, publisherSessionId } = this.options;
    if (signal.targetSessionId !== call.sessionId || signal.fromSessionId !== publisherSessionId
      || signal.publisherSessionId !== publisherSessionId || signal.channelId !== call.channelId
      || signal.shareId !== source.shareId || signal.sourceInstanceId !== source.instanceId)
      throw new Error('Browser screen signaling escaped its subscription.');
    if (this.stopping || signal.subscriptionId !== this.subscriptionId) return;
    if (!this.started) throw new Error('Browser screen signaling arrived before Watch.');
    if (signal.action === 'closed') {
      this.remoteClosed = true;
      this.options.onUnavailable(signal.reason);
      return;
    }
    if (signal.action === 'accepted') {
      if (signal.backend !== 'browser' || signal.quality !== this.options.quality
        || (this.generation !== null && this.generation !== signal.generation))
        throw new Error('The publisher changed the requested browser screen subscription.');
      if (this.generation !== null) return this.opening ?? undefined;
      this.generation = signal.generation;
      if (call.mode === 'p2p') {
        this.p2p = new BrowserScreenP2p({
          call, publisherSessionId, source, profile: getScreenShareProfile(source.video, this.options.quality),
          subscriptionId: this.subscriptionId,
          generation: signal.generation, muted: this.muted,
          send: control => this.options.send(this.envelope({ action: 'control', control })),
          onTrack: this.options.onTrack, onError: error => this.fail(error),
        });
      } else {
        this.sfu = new BrowserScreenSfu({
          call, publisherSessionId, source, profile: getScreenShareProfile(source.video, this.options.quality),
          muted: this.muted, rpc: this.options.rpc, onTrack: this.options.onTrack, onError: error => this.fail(error),
        });
        const sfu = this.sfu;
        this.opening = (async () => {
          for (const producer of this.producers.values()) await sfu.addProducer(producer);
          this.producers.clear();
          if (this.stopping) throw new DOMException('Screen setup was retired.', 'AbortError');
          await sfu.start();
        })();
        return this.opening;
      }
      return;
    }
    if (signal.action === 'capture-mode') {
      if (signal.generation !== this.generation) throw new Error('Capture mode belongs to another browser screen subscription.');
      if (signal.capture.ready) this.options.onCaptureMode(signal.capture.mode);
      else if (signal.capture.mode === 'game' && !this.isPlaying && !this.gameStartupWait) {
        this.gameStartupWait = true;
        if (this.startupTimer) clearTimeout(this.startupTimer);
        this.startupTimer = setTimeout(() => this.fail(new Error('Game Capture and its Normal fallback did not produce a frame.')),
          NATIVE_SCREEN_GAME_STARTUP_TIMEOUT_MS);
      }
      return;
    }
    if (signal.action !== 'control' || !this.p2p || signal.control.generation !== this.generation)
      throw new Error('The browser screen received control without an accepted P2P connection.');
    await this.p2p.receive(signal.control);
  }

  public addProducer(producer: NativeScreenProducer): Promise<void> {
    if (this.stopping || this.options.call.mode !== 'sfu') return Promise.resolve();
    if (this.sfu) return this.sfu.addProducer(producer);
    const { source, publisherSessionId, quality } = this.options;
    const profile = getScreenShareProfile(source.video, quality);
    if (producer.producerSessionId !== publisherSessionId || producer.appData.shareId !== source.shareId
      || producer.appData.nativeScreen.sourceInstanceId !== source.instanceId
      || screenShareProfileKey(producer.appData.nativeScreen.video) !== screenShareProfileKey(profile)) return Promise.resolve();
    if (this.producers.size >= 8 && !this.producers.has(producer.producerId))
      return Promise.reject(new Error('The screen exceeded its pending rendition limit.'));
    this.producers.set(producer.producerId, producer);
    return Promise.resolve();
  }

  public removeProducer(producerId: string): Promise<void> {
    this.producers.delete(producerId);
    return this.sfu?.removeProducer(producerId) ?? Promise.resolve();
  }

  public async setMuted(muted: boolean): Promise<void> {
    if (this.stopping || this.muted === muted) return;
    this.muted = muted;
    await this.p2p?.setMuted(muted);
    await this.sfu?.setMuted(muted);
  }

  public async stats(): Promise<RTCStatsReport | null> {
    if (this.stopping) return null;
    return this.p2p?.stats() ?? this.sfu?.stats() ?? null;
  }

  public close(notify: boolean): Promise<void> {
    if (this.closing) return this.closing;
    this.stopping = true;
    this.cancelDiscovery?.();
    this.playing();
    const local = Promise.all([this.p2p?.close(), this.sfu?.close(notify)]);
    this.closing = (async () => {
      const results = await Promise.allSettled([
        local,
        (async () => {
          await Promise.allSettled([this.starting]);
          if (notify && this.started && !this.remoteClosed && !this.stopAcknowledged) {
            await this.options.send(this.envelope({ action: 'stop' }));
            this.stopAcknowledged = true;
          }
        })(),
      ]);
      await Promise.allSettled([this.opening]);
      this.producers.clear();
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Browser screen retirement failed.');
    })();
    void this.closing.catch(() => { this.closing = null; });
    return this.closing;
  }
}
