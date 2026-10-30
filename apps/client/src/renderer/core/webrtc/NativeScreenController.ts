import {
  getScreenShareProfile,
  type NativeScreenCapabilities, type NativeScreenCaptureMode, type NativeScreenEndpointDiagnostics, type NativeScreenEvent,
  type NativeScreenPreviewState, type NativeScreenSource, type NativeScreenVideoProfile, type QualityProfile,
  type ScreenCodecPreference,
} from '@monky/shared';
import { videoService } from '../VideoService';
import type { RemoteMediaRouter } from './RemoteMediaRouter';
import { LocalScreenSources, type NativeScreenSourceWarning, type SourceInput } from './nativeScreen/LocalScreenSources';
import { answerMainRequest } from './nativeScreen/MainRequestResponder';
import {
  NativeScreenCalls, announceScreenChange, keyOf, reportScreenError, type Call, type NativeScreenCallContext,
} from './nativeScreen/NativeScreenCall';
import { RemoteScreenPresentations, type NativeScreenWatchState } from './nativeScreen/RemoteScreenPresentations';

export { nativeScreenProfile } from './nativeScreen/LocalScreenSources';
export type { NativeScreenCallContext, NativeScreenSourceWarning, NativeScreenWatchState };

export type ScreenVideoDiagnostics =
  | { backend: 'native'; source: NativeScreenSource; viewers: number | null; endpoints: readonly NativeScreenEndpointDiagnostics[] }
  | { backend: 'browser'; source: NativeScreenSource; target: object; profile: Readonly<NativeScreenVideoProfile>;
    reports: RTCStatsReport | null };

/**
 * The renderer's side of native screen sharing (#689): the call in Main (`nativeScreen/NativeScreenCall`),
 * the screens this client publishes (`LocalScreenSources`), the ones it watches (`RemoteScreenPresentations`)
 * and the requests Main sends back (`MainRequestResponder`).
 */
export class NativeScreenController {
  private readonly calls: NativeScreenCalls;
  private readonly sources: LocalScreenSources;
  private readonly presentations: RemoteScreenPresentations;

  constructor(
    private readonly context: () => NativeScreenCallContext | null,
    retireStream: (stream: MediaStream) => Promise<void>,
    mediaRouter: RemoteMediaRouter,
  ) {
    this.calls = new NativeScreenCalls(context, {
      main: (call, event) => this.handleMainEvent(call, event),
      presentationError: (call, event) => {
        this.sources.previewFailed(call, event);
        this.presentations.presentationFailed(call, event);
        announceScreenChange();
      },
      browserFailed: (call, entry, error) => this.presentations.browserFailed(call, entry, error),
      outputsChanged: call => this.presentations.followOutputs(call),
      retired: async call => {
        await this.presentations.releaseAll(call);
        await this.sources.releaseAll(call);
      },
    });
    this.sources = new LocalScreenSources(this.calls, retireStream);
    this.presentations = new RemoteScreenPresentations(this.calls, retireStream, mediaRouter, () => this.sync());
  }

  public capabilities(): Promise<NativeScreenCapabilities> {
    return this.calls.capabilities();
  }

  public report(error: unknown): void {
    reportScreenError(error);
  }

  private async handleMainEvent(call: Call, event: NativeScreenEvent): Promise<void> {
    if ('requestId' in event) {
      await answerMainRequest(this.calls, call, event, presentationId => this.stopPresentation(call, presentationId));
      return;
    }
    if (call.stopping || !call.context.isCurrent()) return;
    if (event.type === 'error') reportScreenError(new Error(event.message));
    if (!event.shareId) return;
    if (event.publisherSessionId === call.config.sessionId) await this.sources.notice(call, event, event.shareId);
    else if (event.type === 'state' || event.type === 'capture-mode' || event.type === 'error')
      this.presentations.notice(call, event, event.shareId);
  }

  /** Main asks to stop presenting a remote screen or a local preview; one already gone is stopped in Main directly. */
  private stopPresentation(call: Call, presentationId: string): Promise<void> {
    const entry = this.presentations.withPresentationId(call, presentationId);
    if (entry) return this.presentations.release(call, entry);
    const source = this.sources.withPreviewId(call, presentationId);
    if (source) return this.sources.releasePreview(call, source);
    return call.api.stopNativeScreenPresentation(presentationId);
  }

  public addSource(input: SourceInput): Promise<NativeScreenSource> {
    return this.sources.add(input);
  }

  public getLocalPreviewState(shareId: string): NativeScreenPreviewState {
    return this.sources.previewState(shareId);
  }

  /** Why viewers currently see a frozen picture of this local source, or null while it is captured normally. */
  public getLocalSourceWarning(shareId: string): NativeScreenSourceWarning | null {
    return this.sources.warning(shareId);
  }

  public attachLocalPreview(shareId: string): Promise<MediaStream> {
    return this.sources.attachPreview(shareId);
  }

  public removeSource(shareId: string): Promise<void> {
    return this.sources.remove(shareId);
  }

  public applyQuality(profile: QualityProfile): Promise<number> {
    return this.sources.applyQuality(profile);
  }

  /** Keeps the share on air but stops capturing its audio, which a whole screen is taking over (#253). */
  public withdrawAudio(shareId: string): Promise<void> {
    return this.sources.withdrawAudio(shareId);
  }

  public settingsIssue(profile: QualityProfile, codec: ScreenCodecPreference): 'profile' | 'codec' | null {
    return this.sources.settingsIssue(profile, codec);
  }

  /** Brings Main in line with the call: its roster, every captured source and every Watch the viewer wants. */
  public async sync(): Promise<void> {
    const context = this.context();
    if (!context?.isCurrent()) return;
    const active = this.calls.active;
    if (active && !active.stopping && active.context.isCurrent()) this.presentations.retireUnwanted(active);
    const nativeWatches = this.presentations.wantedWatches(context);
    if (!this.calls.active && !nativeWatches.length && !videoService.getNativeScreenCaptures().length) return;
    const call = await this.calls.ensure();
    await this.calls.updateRoster(call);
    await Promise.all(videoService.getNativeScreenCaptures().map(capture => this.sources.refresh(call, capture.source.shareId)));
    const keys = new Set([...call.presentations.keys(), ...nativeWatches]);
    await Promise.all([...keys].map(key => this.presentations.queue(call, key)));
  }

  public updateAudio(): Promise<void> {
    return this.presentations.updateAudio();
  }

  public setOutputDeviceId(sinkId: string): Promise<void> {
    return this.presentations.setOutputDeviceId(sinkId);
  }

  public getWatchState(sessionId: string, shareId: string): NativeScreenWatchState | null {
    return this.presentations.watchState(sessionId, shareId);
  }

  public getCaptureMode(sessionId: string, shareId: string): NativeScreenCaptureMode | null {
    const call = this.calls.active;
    if (!call || call.stopping || !call.context.isCurrent()) return null;
    return sessionId === call.config.sessionId
      ? this.sources.captureMode(call, shareId)
      : this.presentations.captureMode(call, sessionId, shareId);
  }

  public async diagnostics(sessionId: string, shareId: string): Promise<ScreenVideoDiagnostics | null> {
    const call = this.calls.active;
    if (!call || call.stopping || !call.context.isCurrent()) return null;
    const local = sessionId === call.config.sessionId ? call.sources.get(shareId) : undefined;
    const remote = sessionId !== call.config.sessionId ? call.presentations.get(keyOf(sessionId, shareId)) : undefined;
    const source = local?.descriptor ?? remote?.source;
    if (!source || local?.removing || remote?.stopping) return null;
    const current = () => this.calls.active === call && !call.stopping && call.context.isCurrent()
      && (local ? call.sources.get(shareId) === local && !local.removing
        : call.presentations.get(keyOf(sessionId, shareId)) === remote && !remote?.stopping);
    if (remote?.browser) {
      const reports = await remote.browser.stats();
      return current() ? { backend: 'browser', source, target: remote.browser, reports,
        profile: getScreenShareProfile(source.video, remote.quality, source.codec) } : null;
    }
    if (remote && !remote.requested) return { backend: 'native', source, viewers: null, endpoints: [] };
    const result = await call.api.nativeScreenCommand({
      action: 'diagnostics', callId: call.config.callId, publisherSessionId: sessionId, shareId,
      sourceInstanceId: source.instanceId, ...(remote ? { presentationId: remote.presentationId } : {}),
    });
    if (!current() || result.kind === 'diagnostics-retired') return null;
    if (result.kind !== 'diagnostics' || result.sourceInstanceId !== source.instanceId
      || result.presentationId !== (remote?.presentationId ?? null))
      throw new Error('Native diagnostics do not belong to the current screen owner.');
    return { backend: 'native', source, viewers: result.viewers, endpoints: result.endpoints };
  }

  /** A Watch the viewer retries starts over with a new presentation. */
  public async retry(sessionId: string, shareId: string): Promise<void> {
    const entry = this.calls.active?.presentations.get(keyOf(sessionId, shareId));
    if (entry) entry.restart = true;
    await this.sync();
  }

  public prepareShutdown(): Promise<void> {
    return this.calls.prepareShutdown();
  }

  public close(): Promise<void> {
    return this.calls.close();
  }
}
