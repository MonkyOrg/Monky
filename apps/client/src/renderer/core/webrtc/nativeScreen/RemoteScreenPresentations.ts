import {
  type NativeScreenAudioPreferences, type NativeScreenCaptureMode, type NativeScreenFailure, type NativeScreenRpcMethod,
  type NativeScreenSource, type ScreenShareQuality,
} from '@monky/shared';
import { clientLog } from '../../ClientLogService';
import { t } from '../../../i18n';
import { settingsStore, type ScreenShareReceiver } from '../../../stores/settingsStore';
import { voiceStore } from '../../../stores/voiceStore';
import { resolveAudioOutput } from '../../../utils/audioPreferences';
import { showInfoToast } from '../../../views/CopyToast';
import { BrowserScreenSubscription } from '../BrowserScreenSubscription';
import type { RemoteMediaRouter } from '../RemoteMediaRouter';
import {
  announceScreenChange, cancelled, keyOf, messageOf, reportScreenError,
  type Call, type NativeScreenCallContext, type NativeScreenCalls, type NativeScreenNotice,
} from './NativeScreenCall';
import { RewatchPolicy, type RewatchEntry } from './RewatchPolicy';

export interface NativeScreenWatchState {
  readonly state: 'connecting' | 'playing' | 'unavailable';
  readonly reason?: NativeScreenFailure;
  readonly receiver?: ScreenShareReceiver;
}

/** A remote screen this client watches: presented by Main, or received by Chromium when chosen in the settings. */
export interface Presentation extends RewatchEntry {
  readonly receiver: ScreenShareReceiver;
  readonly publisherSessionId: string;
  readonly source: NativeScreenSource;
  readonly quality: ScreenShareQuality;
  sinkId: string;
  audioWork?: Promise<void>;
  // A preference refresh waiting behind the audio change in flight: later refreshes join it.
  queuedAudio?: Promise<void>;
  // What the native receiver last accepted; applying the same preferences again sends nothing.
  appliedAudio?: NativeScreenAudioPreferences;
  readonly presentationId: string;
  readonly video: HTMLVideoElement;
  stream: MediaStream | null;
  state: NativeScreenWatchState;
  stopping: boolean;
  requested: boolean;
  restart: boolean;
  attachment?: Promise<void>;
  retirement?: Promise<void>;
  stoppingTask?: Promise<void>;
  browser?: BrowserScreenSubscription;
  audioTrack?: MediaStreamTrack;
  captureMode?: NativeScreenCaptureMode;
}

/** What Main reports about a remote screen this client watches. */
type PresentationNotice = Extract<NativeScreenNotice, { type: 'state' | 'capture-mode' | 'error' }>;

/**
 * The remote screens this client watches: one presentation per Watch, replaced when the source,
 * the quality or the receiver changes, and the screen audio routed to the chosen output.
 */
export class RemoteScreenPresentations {
  // The output chosen for screen audio. A device that is not connected plays on the system default
  // instead: Chromium rejects a missing device, which would fail the whole Watch, video included.
  private sinkId = resolveAudioOutput(settingsStore, 'screen');
  // Connected outputs, or null when they cannot be listed (then the chosen device is used as is).
  private outputs: ReadonlySet<string> | null = null;
  private outputFallbackNotified: string | null = null;
  private outputWork: Promise<void> = Promise.resolve();
  private readonly rewatches = new WeakMap<Call, RewatchPolicy<Presentation>>();

  constructor(
    private readonly calls: NativeScreenCalls,
    private readonly retireStream: (stream: MediaStream) => Promise<void>,
    private readonly mediaRouter: RemoteMediaRouter,
    /** Brings the call's sources and Watches in line with what is wanted. */
    private readonly resync: () => Promise<void>,
  ) {}

  private rewatch(call: Call): RewatchPolicy<Presentation> {
    let policy = this.rewatches.get(call);
    if (!policy) {
      policy = new RewatchPolicy<Presentation>({
        ended: () => call.stopping || this.calls.active !== call,
        presentation: key => call.presentations.get(key),
        wanted: entry => voiceStore.isWatchingScreen(entry.publisherSessionId, entry.source.shareId),
        restart: entry => {
          entry.restart = true;
          return this.resync().catch(reportScreenError);
        },
        changed: announceScreenChange,
      });
      this.rewatches.set(call, policy);
    }
    return policy;
  }

  /** The native screens the viewer watches in this call, by presentation key. */
  public wantedWatches(context: NativeScreenCallContext): string[] {
    return voiceStore.getScreenWatchers().flatMap(([sessionId, shares]) => shares
      .filter(shareId => context.participants.get(sessionId)?.voiceState?.nativeScreenShares?.some(source => source.shareId === shareId))
      .map(shareId => keyOf(sessionId, shareId)));
  }

  /** Stops, for a restart, the presentations of what the viewer no longer watches or now wants differently. */
  public retireUnwanted(call: Call): void {
    for (const entry of call.presentations.values()) {
      if (!entry.stopping && !this.wanted(call, entry)) {
        entry.restart = true;
        void this.stop(call, entry).catch(reportScreenError);
      }
    }
  }

  /** The next presentation of `key`, after the ones already queued for it. */
  public queue(call: Call, key: string): Promise<void> {
    const preceding = call.watchTasks.get(key) ?? Promise.resolve();
    const execute = () => this.watch(call, key);
    const task = preceding.then(execute, execute).catch(error => {
      const entry = call.presentations.get(key);
      if (entry && !(error instanceof Error && error.name === 'AbortError')) {
        if (entry.state.state !== 'unavailable') entry.state = { state: 'unavailable', reason: 'connection-failed' };
        announceScreenChange();
      }
      throw error;
    });
    call.watchTasks.set(key, task);
    const remove = () => { if (call.watchTasks.get(key) === task) call.watchTasks.delete(key); };
    void task.then(remove, remove);
    return task;
  }

  private wanted(call: Call, entry: Presentation): boolean {
    const participant = call.context.participants.get(entry.publisherSessionId);
    return !entry.restart && participant?.voiceState?.channelId === call.config.channelId
      && participant.voiceState.nativeScreenShares?.some(source => source.shareId === entry.source.shareId
        && source.instanceId === entry.source.instanceId) === true
      && voiceStore.isWatchingScreen(entry.publisherSessionId, entry.source.shareId)
      && voiceStore.getScreenQuality(entry.publisherSessionId, entry.source.shareId) === entry.quality;
  }

  private async watch(call: Call, key: string): Promise<void> {
    this.calls.current(call);
    const [publisherSessionId, shareId] = key.split('\0');
    const participant = call.context.participants.get(publisherSessionId);
    const source = participant?.voiceState?.channelId === call.config.channelId
      && voiceStore.isWatchingScreen(publisherSessionId, shareId)
      ? participant.voiceState.nativeScreenShares?.find(value => value.shareId === shareId) : undefined;
    const quality = voiceStore.getScreenQuality(publisherSessionId, shareId);
    const assertWanted = (entry?: Presentation): void => {
      this.calls.current(call);
      if (entry?.stopping
        || !voiceStore.isWatchingScreen(publisherSessionId, shareId)
        || voiceStore.getScreenQuality(publisherSessionId, shareId) !== quality
        || call.context.participants.get(publisherSessionId)?.voiceState?.nativeScreenShares
          ?.find(value => value.shareId === shareId)?.instanceId !== source?.instanceId) throw cancelled();
    };
    const previous = call.presentations.get(key);
    if (previous && this.wanted(call, previous)) {
      if (!previous.stopping) { await this.applyAudio(call, previous); return; }
      if (previous.state.state === 'unavailable') return;
    }
    if (previous) {
      this.rewatch(call).endReplacement(previous);
      await this.stop(call, previous);
      if (call.presentations.get(key) === previous) call.presentations.delete(key);
    }
    if (!source) return;
    assertWanted();
    const video = document.createElement('video');
    video.id = crypto.randomUUID();
    video.className = 'native-screen-presentation-owner';
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('aria-hidden', 'true');
    document.body.append(video);
    const entry: Presentation = {
      receiver: settingsStore.getScreenShareReceiver(),
      publisherSessionId, source, quality, sinkId: this.sinkId, presentationId: crypto.randomUUID(),
      video, stream: null, state: { state: 'connecting' }, stopping: false, requested: false, restart: false,
    };
    call.presentations.set(key, entry);
    announceScreenChange();
    try {
      assertWanted(entry);
      if (entry.receiver === 'chromium') {
        entry.browser = this.createBrowserSubscription(call, entry);
        entry.requested = true;
        await entry.browser.start();
        assertWanted(entry);
        return;
      }
      const capabilities = await this.calls.capabilities();
      assertWanted(entry);
      if (!capabilities.receive) {
        clientLog.error('SCREEN_SHARE', 'Selected native screen receiver is unavailable; no browser fallback', {
          reason: capabilities.reason,
        });
        throw new Error(t('screenShare.nativeReceiverUnavailable'));
      }
      entry.attachment = call.api.attachNativeScreenPresentation({ presentationId: entry.presentationId, elementId: video.id });
      await entry.attachment;
      assertWanted(entry);
      if (!(video.srcObject instanceof MediaStream)) throw new Error('Native presentation did not expose its owned DOM stream.');
      entry.stream = video.srcObject;
      call.context.participants.setRemoteScreenStream(publisherSessionId, shareId, entry.stream, { notify: false });
      announceScreenChange();
      await this.refreshOutputs();
      assertWanted(entry);
      entry.requested = true;
      entry.sinkId = this.screenOutput();
      // Main applies the Watch's own preferences: an identical later change has nothing to send.
      const audio = this.audioPreferences(call, entry);
      entry.appliedAudio = audio;
      const result = await call.api.nativeScreenCommand({
        action: 'watch', callId: call.config.callId, publisherSessionId, shareId, quality,
        presentationId: entry.presentationId, audio,
      });
      assertWanted(entry);
      if (result.kind !== 'subscription' || result.presentationId !== entry.presentationId)
        throw new Error('Native Watch acknowledged another presentation.');
    } catch (error) {
      if (entry.state.state !== 'unavailable') entry.state = { state: 'unavailable', reason: 'connection-failed' };
      try { await this.stop(call, entry); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Native Watch and presentation cleanup failed.'); }
      throw error;
    } finally { announceScreenChange(); }
  }

  /** Main reported a new state or capture mode of a Watch. */
  public notice(call: Call, event: PresentationNotice, shareId: string): void {
    const entry = call.presentations.get(keyOf(event.publisherSessionId, shareId));
    if (!entry || entry.stopping || entry.presentationId !== event.presentationId
      || entry.source.instanceId !== event.sourceInstanceId) return;
    if (event.type === 'capture-mode') entry.captureMode = event.mode;
    else if (!(event.type === 'state' && event.state === 'closed' && entry.state.state === 'unavailable'))
      entry.state = event.type === 'state' && (event.state === 'playing' || event.state === 'connecting')
        ? { state: event.state } : { state: 'unavailable', reason: event.reason ?? 'connection-failed' };
    const rewatch = this.rewatch(call);
    rewatch.awaitReplacement(entry);
    rewatch.outcome(keyOf(entry.publisherSessionId, entry.source.shareId), entry);
    announceScreenChange();
  }

  /** Main stopped presenting: one presentation, or every native one when it names none. */
  public presentationFailed(call: Call, event: { presentationId: string | null; message: string }): void {
    for (const entry of call.presentations.values()) {
      if (!entry.browser && !entry.stopping && (!event.presentationId || entry.presentationId === event.presentationId)) {
        entry.state = { state: 'unavailable', reason: 'connection-failed' };
        reportScreenError(new Error(event.message));
        void this.stop(call, entry).catch(reportScreenError);
      }
    }
  }

  public browserFailed(call: Call, entry: Presentation, error: unknown): void {
    if (entry.stopping) return;
    reportScreenError(error);
    entry.state = { state: 'unavailable', reason: 'connection-failed' };
    this.rewatch(call).outcome(keyOf(entry.publisherSessionId, entry.source.shareId), entry);
    announceScreenChange();
    void this.stop(call, entry).catch(reportScreenError);
  }

  private createBrowserSubscription(call: Call, entry: Presentation): BrowserScreenSubscription {
    const key = keyOf(entry.publisherSessionId, entry.source.shareId);
    entry.video.onplaying = () => {
      if (entry.stopping) return;
      entry.browser?.playing();
      entry.state = { state: 'playing' };
      this.rewatch(call).outcome(key, entry);
      announceScreenChange();
    };
    return new BrowserScreenSubscription({
      call: call.config, publisherSessionId: entry.publisherSessionId, source: entry.source, quality: entry.quality,
      muted: this.audioPreferences(call, entry).muted,
      send: signal => this.calls.sendSignal(call, signal),
      rpc: async <T>(method: NativeScreenRpcMethod, payload: Record<string, unknown>): Promise<T> => {
        if (!this.calls.networkCurrent(call)) throw new Error('The original screen SFU connection is unavailable.');
        const response = await call.context.client.relayRequest<T>(method, payload);
        if (response === undefined) throw new Error('The screen SFU returned no acknowledgement.');
        return response;
      },
      onTrack: track => {
        if (entry.stopping || call.stopping) { track.stop(); return; }
        if (track.kind === 'audio') {
          entry.audioTrack = track;
          this.mediaRouter.routeScreenAudioTrack(entry.publisherSessionId, track,
            error => this.browserFailed(call, entry, error), entry.source.shareId);
          void this.applyAudio(call, entry).catch(error => this.browserFailed(call, entry, error));
        } else {
          if (entry.stream) for (const previous of entry.stream.getTracks()) previous.stop();
          const stream = entry.stream = new MediaStream([track]);
          entry.video.srcObject = stream;
          call.context.participants.setRemoteScreenStream(entry.publisherSessionId, entry.source.shareId, stream, { notify: false });
          announceScreenChange();
          void entry.video.play().catch(error => this.browserFailed(call, entry, error));
        }
      },
      onUnavailable: reason => {
        if (entry.stopping) return;
        entry.state = { state: 'unavailable', reason };
        const rewatch = this.rewatch(call);
        rewatch.awaitReplacement(entry);
        rewatch.outcome(key, entry);
        announceScreenChange();
        void this.stop(call, entry).catch(reportScreenError);
      },
      onCaptureMode: mode => {
        if (entry.stopping || call.stopping || !call.context.isCurrent() || call.presentations.get(key) !== entry) return;
        entry.captureMode = mode;
        announceScreenChange();
      },
      onError: reportScreenError,
    });
  }

  private audioPreferences(call: Call, entry: Presentation) {
    return {
      sinkId: entry.sinkId, muted: voiceStore.getEffectiveDeafened() || voiceStore.isScreenAudioMuted(entry.publisherSessionId),
      volume: settingsStore.getScreenAudioVolume(entry.publisherSessionId,
        call.context.participants.get(entry.publisherSessionId)?.user.clientId) / 100,
    };
  }

  private async refreshOutputs(): Promise<void> {
    try {
      const devices = await navigator.mediaDevices?.enumerateDevices?.() ?? [];
      const outputs = devices.filter(device => device.kind === 'audiooutput' && device.deviceId).map(device => device.deviceId);
      // Without media permission Chromium hides device IDs, and no chosen device can be judged absent.
      this.outputs = outputs.length ? new Set(outputs) : null;
    } catch (error) {
      this.outputs = null;
      clientLog.warn('SCREEN_SHARE', 'Screen audio outputs could not be listed', { error: messageOf(error) });
    }
  }

  /** The chosen screen output while it is connected, otherwise the system default (announced once per absence). */
  private screenOutput(): string {
    const chosen = this.sinkId;
    if (!chosen || !this.outputs || this.outputs.has(chosen)) {
      if (this.outputs?.has(chosen)) this.outputFallbackNotified = null;
      return chosen;
    }
    if (this.outputFallbackNotified !== chosen) {
      this.outputFallbackNotified = chosen;
      showInfoToast(t('screenShare.audioOutputFallback'), 8000);
    }
    return '';
  }

  // A device came or went: move native screen audio between the chosen output and the system default,
  // through the same serialized path as choosing an output.
  public followOutputs(call: Call): Promise<void> {
    const execute = async (): Promise<void> => {
      if (call.stopping || this.calls.active !== call || !call.context.isCurrent()) return;
      await this.refreshOutputs();
      const entries = [...call.presentations.values()].filter(entry => !entry.stopping && !entry.browser && entry.requested);
      if (!entries.length) return;
      const output = this.screenOutput();
      const results = await Promise.allSettled(entries.filter(entry => entry.sinkId !== output)
        .map(entry => this.applyAudio(call, entry, output)));
      const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, 'Screen audio could not follow the connected outputs.');
    };
    const work = this.outputWork.then(execute, execute);
    this.outputWork = work;
    return work;
  }

  // A volume slider fires dozens of changes per second and every mute or voice update reaches all
  // screens: at most one preference refresh waits per presentation, it reads the latest preferences
  // when it runs, and the native receiver only hears about a real change. An output change runs as
  // its own request, so a refresh never inherits a rejected device.
  private applyAudio(call: Call, entry: Presentation, sinkId?: string): Promise<void> {
    if (sinkId === undefined && entry.queuedAudio) return entry.queuedAudio;
    const execute = async (): Promise<void> => {
      if (entry.queuedAudio === work) entry.queuedAudio = undefined;
      if (!entry.requested || entry.stopping || entry.state.state === 'unavailable') return;
      this.calls.current(call);
      const { muted, volume } = this.audioPreferences(call, entry);
      if (entry.browser) {
        if (entry.audioTrack) {
          this.mediaRouter.setScreenAudioMuted(entry.publisherSessionId, muted);
          this.mediaRouter.setScreenAudioVolume(entry.publisherSessionId, volume * 100);
        }
        await entry.browser.setMuted(muted);
      } else {
        const applied = entry.appliedAudio;
        if (applied?.muted !== muted || applied.volume !== volume || (sinkId !== undefined && applied.sinkId !== sinkId)) {
          await this.calls.ok(call, { action: 'watch-audio', callId: call.config.callId, publisherSessionId: entry.publisherSessionId,
            shareId: entry.source.shareId, presentationId: entry.presentationId, muted, volume,
            ...(sinkId !== undefined ? { sinkId } : {}) });
          entry.appliedAudio = { muted, volume, sinkId: sinkId ?? applied?.sinkId ?? entry.sinkId };
        }
      }
      if (sinkId !== undefined && !entry.stopping) entry.sinkId = sinkId;
    };
    const work: Promise<void> = (entry.audioWork ?? Promise.resolve()).then(execute, execute);
    if (sinkId === undefined) entry.queuedAudio = work;
    entry.audioWork = work;
    const clear = (): void => { if (entry.audioWork === work) entry.audioWork = undefined; };
    void work.then(clear, clear);
    return work;
  }

  public async updateAudio(): Promise<void> {
    const call = this.calls.active;
    if (!call || call.stopping || !call.context.isCurrent()) return;
    await Promise.all([...call.presentations.values()].filter(entry => !entry.stopping).map(entry => this.applyAudio(call, entry)));
  }

  public setOutputDeviceId(sinkId: string): Promise<void> {
    const execute = async (): Promise<void> => {
      if (this.sinkId === sinkId) return;
      const previous = this.sinkId;
      this.sinkId = sinkId;
      const call = this.calls.active;
      if (!call || call.stopping || !call.context.isCurrent()) return;
      const current = () => [...call.presentations.values()].filter(entry => !entry.stopping);
      if (current().some(entry => !entry.browser)) await this.refreshOutputs();
      const apply = () => {
        const entries = current();
        const output = entries.some(entry => !entry.browser) ? this.screenOutput() : this.sinkId;
        return Promise.allSettled(entries.map(entry => this.applyAudio(call, entry, output)));
      };
      const changed = await apply();
      const failures = changed.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (!failures.length) return;
      this.sinkId = previous;
      const restored = await apply();
      failures.push(...restored.flatMap(result => result.status === 'rejected' ? [result.reason] : []));
      throw new AggregateError(failures, 'Screen audio output selection failed; the video subscription was retained.');
    };
    const work = this.outputWork.then(execute, execute);
    this.outputWork = work;
    return work;
  }

  public watchState(sessionId: string, shareId: string): NativeScreenWatchState | null {
    const call = this.calls.active;
    const key = keyOf(sessionId, shareId);
    const entry = call?.presentations.get(key);
    if (!call || !entry) return null;
    return { ...this.rewatch(call).presented(key, entry), receiver: entry.receiver };
  }

  public captureMode(call: Call, sessionId: string, shareId: string): NativeScreenCaptureMode | null {
    const entry = call.presentations.get(keyOf(sessionId, shareId));
    return entry && !entry.stopping && entry.state.state !== 'unavailable' ? entry.captureMode ?? null : null;
  }

  public withPresentationId(call: Call, presentationId: string): Presentation | undefined {
    return [...call.presentations.values()].find(item => item.presentationId === presentationId);
  }

  public release(call: Call, entry: Presentation): Promise<void> {
    if (entry.retirement) return entry.retirement;
    entry.retirement = (async () => {
      if (entry.attachment) await Promise.allSettled([entry.attachment]);
      if (entry.stream) {
        if (call.context.participants.get(entry.publisherSessionId)?.remoteScreenStreams.get(entry.source.shareId) === entry.stream)
          call.context.participants.removeRemoteScreenStream(entry.publisherSessionId, entry.source.shareId, { notify: false });
        announceScreenChange();
        await this.retireStream(entry.stream);
      }
      if (entry.browser) {
        if (entry.audioTrack) await this.mediaRouter.cleanupScreenAudio(entry.publisherSessionId, entry.audioTrack);
        await this.retireBrowser(call, entry.browser);
        entry.video.onplaying = null;
        entry.video.pause();
        entry.video.srcObject = null;
      } else if (entry.attachment) await call.api.stopNativeScreenPresentation(entry.presentationId);
      entry.video.remove();
      entry.stream = null;
    })();
    void entry.retirement.catch(() => { entry.retirement = undefined; });
    return entry.retirement;
  }

  private async retireBrowser(call: Call, browser: BrowserScreenSubscription): Promise<void> {
    const notify = this.calls.networkCurrent(call);
    if (!notify) clientLog.warn('SCREEN_SHARE', 'Browser screen is retiring without remote confirmation', { remoteAcknowledged: false });
    try { await browser.close(notify); }
    catch (error) {
      if (!call.stopping) throw error;
      reportScreenError(error);
      await browser.close(false);
    }
  }

  private stop(call: Call, entry: Presentation): Promise<void> {
    if (entry.stoppingTask) return entry.stoppingTask;
    entry.stopping = true;
    entry.stoppingTask = (async () => {
      const results = await Promise.allSettled([
        this.release(call, entry),
        entry.browser ? this.retireBrowser(call, entry.browser) : call.stopping || !entry.requested ? Promise.resolve() : this.calls.ok(call, { action: 'stop', callId: call.config.callId,
          publisherSessionId: entry.publisherSessionId, shareId: entry.source.shareId, presentationId: entry.presentationId }),
      ]);
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Native presentation retirement failed.');
    })();
    void entry.stoppingTask.catch(() => { entry.stoppingTask = undefined; });
    return entry.stoppingTask;
  }

  /** The call retired: no reconnection outlives it and every presentation is released. */
  public async releaseAll(call: Call): Promise<void> {
    this.rewatch(call).end(call.presentations.values());
    await Promise.all([...call.presentations.values()].map(entry => this.release(call, entry)));
  }
}
