import {
  getScreenShareProfile, nativeScreenFailureReason, nativeScreenSignalSchema, screenShareProfileKey,
  type NativeScreenCall, type NativeScreenFailure, type NativeScreenSignalPayload, type NativeScreenSource,
  type NativeScreenVideoProfile, type ScreenShareQuality, type ScreenFormat,
} from '@monky/shared';
import { BrowserScreenPeer } from './browserScreenPeer';
import type { DisplayCapture } from './displayCaptures';
import { ScreenP2pPublisherPeer } from './screenP2pPublisherPeer';
import { WebScreenSfuRendition, type WebScreenRpc } from './webScreenSfuRendition';

type Watch = Extract<NativeScreenSignalPayload, { action: 'watch' }>;
type PublisherSignal = { action: 'accepted'; quality: ScreenShareQuality; backend: Watch['backend']; generation: number }
  | { action: 'capture-mode'; generation: number; capture: { mode: 'normal'; ready: true } }
  | { action: 'closed'; reason: NativeScreenFailure }
  | { action: 'control'; control: Parameters<ScreenP2pPublisherPeer['receive']>[0] };

interface Pipeline {
  readonly key: string;
  readonly id: string;
  readonly profile: Readonly<NativeScreenVideoProfile>;
  readonly viewers: Map<string, Viewer>;
  readonly video: MediaStreamTrack;
  readonly audio: MediaStreamTrack | null;
  ready: Promise<void>;
  sfu: WebScreenSfuRendition | null;
  closing: Promise<void> | null;
}

interface Viewer {
  readonly sessionId: string;
  readonly subscriptionId: string;
  readonly quality: ScreenShareQuality;
  readonly backend: Watch['backend'];
  readonly generation: number;
  pipeline: Pipeline | null;
  peer: ScreenP2pPublisherPeer | null;
  retiring: boolean;
  setup: Promise<void> | null;
  retirement: Promise<void> | null;
}

/** As on the desktop: each viewer of a profile costs an encoder session and upload. */
export const WEB_SCREEN_LIMITS = Object.freeze({ viewersPerProfile: 16, profiles: 4 });

const cancelled = (): DOMException => new DOMException('The screen subscription was retired.', 'AbortError');
const capacity = (): Error => Object.assign(new Error('The screen profile has reached its viewer limit.'), { code: 'ERR_SCREEN_CAPACITY' });

export interface WebScreenPublisherOptions {
  readonly call: NativeScreenCall;
  readonly source: NativeScreenSource;
  /** How this screen is encoded; its codec is the source's. */
  readonly format: ScreenFormat;
  readonly capture: DisplayCapture;
  readonly audioBitrateKbps: number;
  readonly signal: (signal: NativeScreenSignalPayload) => Promise<void>;
  readonly rpc: WebScreenRpc;
  readonly onError: (error: unknown) => void;
}

/**
 * Publishes one browser capture to the viewers of a call (#858), as the native publisher does: a Watch
 * reserves a rendition of the quality it asks for (a constrained copy of the capture, and on the SFU its own
 * producers), is accepted once that rendition is ready and, in P2P, gets its own connection. The tracks it
 * copies are its own and stop with it; the capture itself belongs to the share.
 */
export class WebScreenPublisher {
  private readonly viewers = new Map<string, Viewer>();
  private readonly pipelines = new Map<string, Pipeline>();
  private readonly pending = new Set<Promise<void>>();
  private generation = 0;
  private closed = false;
  private closing: Promise<void> | null = null;

  constructor(private readonly options: WebScreenPublisherOptions) {}

  public get source(): NativeScreenSource { return this.options.source; }
  public get viewerCount(): number { return this.viewers.size; }

  private current(viewer: Viewer): boolean {
    return !this.closed && !viewer.retiring && this.viewers.get(viewer.sessionId) === viewer;
  }

  private track(work: Promise<void>): Promise<void> {
    this.pending.add(work);
    void work.then(() => this.pending.delete(work), (error: unknown) => {
      this.pending.delete(work);
      if (!(error instanceof DOMException && error.name === 'AbortError')) this.options.onError(error);
    });
    return work;
  }

  private async signal(viewer: Viewer, body: PublisherSignal): Promise<void> {
    if (!this.current(viewer)) throw cancelled();
    const { call, source } = this.options;
    await this.options.signal(nativeScreenSignalSchema.parse({
      fromSessionId: call.sessionId, targetSessionId: viewer.sessionId, publisherSessionId: call.sessionId,
      channelId: call.channelId, shareId: source.shareId, sourceInstanceId: source.instanceId,
      subscriptionId: viewer.subscriptionId, ...body,
    }));
  }

  /** A viewer's signal for this screen: a Watch, its end, or P2P negotiation. */
  public async receive(value: NativeScreenSignalPayload): Promise<void> {
    const signal = nativeScreenSignalSchema.parse(value);
    const { call, source } = this.options;
    if (signal.targetSessionId !== call.sessionId || signal.publisherSessionId !== call.sessionId
      || signal.channelId !== call.channelId || signal.shareId !== source.shareId || signal.sourceInstanceId !== source.instanceId)
      throw new Error('The screen signal belongs to another screen.');
    if (signal.action === 'watch') return this.watch(signal);
    if (signal.action !== 'stop' && signal.action !== 'control') throw new Error('A screen publisher received a publisher signal.');
    const viewer = this.viewers.get(signal.fromSessionId);
    if (!viewer || viewer.subscriptionId !== signal.subscriptionId || !this.current(viewer)) return;
    if (signal.action === 'stop') return this.retireViewer(viewer);
    if (call.mode !== 'p2p' || !viewer.peer || signal.control.generation !== viewer.generation)
      throw new Error('Screen negotiation arrived without an accepted P2P viewer.');
    await viewer.peer.receive(signal.control);
  }

  private watch(request: Watch): Promise<void> {
    if (this.closed) return Promise.reject(cancelled());
    const previous = this.viewers.get(request.fromSessionId);
    if (previous?.subscriptionId === request.subscriptionId) {
      if (previous.quality !== request.quality || previous.backend !== request.backend)
        throw new Error('A screen Watch changed in place.');
      return previous.setup ?? Promise.resolve();
    }
    const viewer: Viewer = {
      sessionId: request.fromSessionId, subscriptionId: request.subscriptionId, quality: request.quality,
      backend: request.backend, generation: ++this.generation, pipeline: null, peer: null, retiring: false,
      setup: null, retirement: null,
    };
    this.viewers.set(viewer.sessionId, viewer);
    viewer.setup = this.track(this.prepare(viewer, previous));
    return viewer.setup;
  }

  private async prepare(viewer: Viewer, previous: Viewer | undefined): Promise<void> {
    try {
      if (previous) await this.retireViewer(previous);
      if (!this.current(viewer)) throw cancelled();
      const pipeline = await this.pipelineFor(viewer);
      await pipeline.ready;
      if (!this.current(viewer)) throw cancelled();
      await this.signal(viewer, { action: 'accepted', quality: viewer.quality, backend: viewer.backend, generation: viewer.generation });
      await this.signal(viewer, { action: 'capture-mode', generation: viewer.generation, capture: { mode: 'normal', ready: true } });
      if (this.options.call.mode === 'p2p') this.connect(viewer, pipeline);
    } catch (error) {
      const errors: unknown[] = [error];
      if (this.current(viewer) && !(error instanceof DOMException && error.name === 'AbortError')) {
        try { await this.signal(viewer, { action: 'closed', reason: nativeScreenFailureReason(error) }); }
        catch (signalError) { if (!(signalError instanceof DOMException)) errors.push(signalError); }
      }
      try { await this.retireViewer(viewer); }
      catch (cleanupError) { errors.push(cleanupError); }
      if (errors.length === 1 && error instanceof Error && Reflect.get(error, 'code') === 'ERR_SCREEN_CAPACITY') return;
      if (errors.length > 1) throw new AggregateError(errors, 'Screen subscription setup and retirement failed.');
      throw error;
    }
  }

  private connect(viewer: Viewer, pipeline: Pipeline): void {
    const { call, source, audioBitrateKbps } = this.options;
    let peer: ScreenP2pPublisherPeer | null = null;
    const port = new BrowserScreenPeer({
      iceServers: call.iceServers, format: this.options.format, streamId: source.instanceId, video: pipeline.video, audio: pipeline.audio,
      maxBitrateBps: pipeline.profile.maxBitrateKbps * 1000, maxFramerate: pipeline.profile.fps,
      audioBitrateBps: audioBitrateKbps * 1000,
      onCandidate: candidate => peer?.localCandidate(candidate),
      onState: state => peer?.connectionState(state),
    });
    peer = new ScreenP2pPublisherPeer({
      sessionId: call.sessionId, viewerSessionId: viewer.sessionId, channelId: call.channelId,
      shareId: source.shareId, sourceInstanceId: source.instanceId, audio: source.audio,
      connectionId: viewer.subscriptionId, generation: viewer.generation, port,
      send: control => this.signal(viewer, { action: 'control', control }),
      onError: error => { void this.track(this.failViewer(viewer, error)); },
    });
    viewer.peer = peer;
    peer.start();
  }

  private async failViewer(viewer: Viewer, error: unknown): Promise<void> {
    this.options.onError(error);
    try {
      if (this.current(viewer)) await this.signal(viewer, { action: 'closed', reason: nativeScreenFailureReason(error) });
    } finally { await this.retireViewer(viewer); }
  }

  private async pipelineFor(viewer: Viewer): Promise<Pipeline> {
    const { source, capture, call } = this.options;
    const profile = getScreenShareProfile(source.video, viewer.quality, source.codec);
    const key = screenShareProfileKey(profile);
    const existing = this.pipelines.get(key);
    if (existing?.closing) {
      await existing.closing;
      if (!this.current(viewer)) throw cancelled();
      return this.pipelineFor(viewer);
    }
    const pipeline = existing ?? this.createPipeline(key, profile);
    if (pipeline.viewers.size >= WEB_SCREEN_LIMITS.viewersPerProfile) throw capacity();
    viewer.pipeline = pipeline;
    pipeline.viewers.set(viewer.sessionId, viewer);
    if (!existing && call.mode === 'sfu') {
      const sfu = new WebScreenSfuRendition({
        channelId: call.channelId, shareId: source.shareId, format: this.options.format,
        rendition: { sourceInstanceId: source.instanceId, pipelineId: pipeline.id, video: profile },
        video: pipeline.video, audio: pipeline.audio, audioBitrateBps: this.options.audioBitrateKbps * 1000,
        rpc: this.options.rpc, onError: error => { void this.track(this.failPipeline(pipeline, error)); },
      });
      pipeline.sfu = sfu;
      pipeline.ready = pipeline.ready.then(() => sfu.ready);
    }
    if (capture.ended) throw new Error('The browser capture ended.');
    return pipeline;
  }

  private createPipeline(key: string, profile: Readonly<NativeScreenVideoProfile>): Pipeline {
    if (this.pipelines.size >= WEB_SCREEN_LIMITS.profiles) throw capacity();
    const { capture } = this.options;
    const video = capture.video.clone();
    video.contentHint = 'detail';
    const pipeline: Pipeline = {
      key, id: crypto.randomUUID(), profile, viewers: new Map(), video,
      audio: this.options.source.audio && capture.audioTrack ? capture.audioTrack.clone() : null,
      // The browser scales the copy to the rendition; refusing only costs bandwidth, never the share.
      ready: video.applyConstraints({
        width: { max: profile.width }, height: { max: profile.height }, frameRate: { max: profile.fps },
      }).catch((error: unknown) => console.warn('[WebScreen] The capture kept its own size for this rendition:', error)),
      sfu: null, closing: null,
    };
    this.pipelines.set(key, pipeline);
    return pipeline;
  }

  private async failPipeline(pipeline: Pipeline, error: unknown): Promise<void> {
    this.options.onError(error);
    const results = await Promise.allSettled([...pipeline.viewers.values()].map(async viewer => {
      try {
        if (this.current(viewer)) await this.signal(viewer, { action: 'closed', reason: nativeScreenFailureReason(error) });
      } finally { await this.retireViewer(viewer); }
    }));
    await this.retirePipeline(pipeline);
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, 'A failed screen rendition did not retire cleanly.');
  }

  private retireViewer(viewer: Viewer): Promise<void> {
    if (viewer.retirement) return viewer.retirement;
    viewer.retiring = true;
    if (this.viewers.get(viewer.sessionId) === viewer) this.viewers.delete(viewer.sessionId);
    const pipeline = viewer.pipeline;
    if (pipeline?.viewers.get(viewer.sessionId) === viewer) pipeline.viewers.delete(viewer.sessionId);
    viewer.retirement = (async () => {
      await viewer.peer?.close();
      if (pipeline && pipeline.viewers.size === 0) await this.retirePipeline(pipeline);
    })();
    return viewer.retirement;
  }

  private retirePipeline(pipeline: Pipeline): Promise<void> {
    if (pipeline.closing) return pipeline.closing;
    pipeline.closing = (async () => {
      try { await pipeline.sfu?.close(); }
      finally {
        pipeline.video.stop();
        pipeline.audio?.stop();
        if (this.pipelines.get(pipeline.key) === pipeline) this.pipelines.delete(pipeline.key);
      }
    })();
    return pipeline.closing;
  }

  /** Viewers who left the call stop receiving. */
  public async setParticipants(sessionIds: readonly string[]): Promise<void> {
    const present = new Set(sessionIds);
    const results = await Promise.allSettled([...this.viewers.values()]
      .filter(viewer => !present.has(viewer.sessionId)).map(viewer => this.retireViewer(viewer)));
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, 'Screen viewers who left did not retire.');
  }

  /** The renditions this screen currently sends, for diagnostics. */
  public renditions(): { pipelineId: string; profile: Readonly<NativeScreenVideoProfile> }[] {
    return [...this.pipelines.values()].filter(pipeline => !pipeline.closing)
      .map(pipeline => ({ pipelineId: pipeline.id, profile: pipeline.profile }));
  }

  /** Tells the viewers why the screen ends, then retires every connection and rendition. */
  public close(reason: NativeScreenFailure = 'source-unavailable'): Promise<void> {
    if (this.closing) return this.closing;
    const viewers = [...this.viewers.values()];
    const notices = viewers.map(viewer => this.signal(viewer, { action: 'closed', reason }));
    this.closed = true;
    this.closing = (async () => {
      const results = await Promise.allSettled([...notices, ...viewers.map(viewer => this.retireViewer(viewer))]);
      await Promise.allSettled([...this.pending]);
      const retired = await Promise.allSettled([...this.pipelines.values()].map(pipeline => this.retirePipeline(pipeline)));
      const errors = [...results, ...retired].flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, 'The screen publisher did not retire cleanly.');
    })();
    return this.closing;
  }
}
