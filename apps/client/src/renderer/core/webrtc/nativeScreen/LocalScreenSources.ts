import {
  nativeScreenAudioBitrateSchema, nativeScreenVideoProfileSchema, screenShareProfileKey,
  type NativeScreenCaptureMode, type NativeScreenPreviewState, type NativeScreenSource, type NativeScreenVideoProfile,
  type QualityProfile, type ScreenCodecPreference,
} from '@monky/shared';
import { appEvents } from '../../EventBus';
import { emitOutsideRouting } from '../../sessionRouting';
import { t } from '../../../i18n';
import { videoService, type NativeScreenCapture } from '../../VideoService';
import { settingsStore } from '../../../stores/settingsStore';
import { customVideoFpsLimit } from '../../../utils/qualityProfileLimits';
import { acceptScreenEncoding } from '../../screenEncoding';
import {
  announceScreenChange, cancelled, reportScreenError, type Call, type NativeScreenCalls, type NativeScreenNotice,
} from './NativeScreenCall';

/** Why viewers see a frozen picture of a local source: its window is minimized or hidden, or a browser stopped drawing it. */
export type NativeScreenSourceWarning = 'hidden' | 'covered';

export type SourceInput = Omit<NativeScreenCapture, 'source'> & {
  shareId: string; video: NativeScreenVideoProfile; audio: boolean;
  replacesAudioShareIds?: readonly string[];
  audience?: NativeScreenSource['audience'];
};

/** A screen this client publishes, from its admission in Main until Main retires it. */
export interface LocalSource {
  readonly ready: Promise<NativeScreenSource>;
  descriptor: NativeScreenSource | null;
  removing: boolean;
  reconfiguration?: { retired: boolean };
  retirement?: Promise<void>;
  previewState?: NativeScreenPreviewState;
  captureMode?: NativeScreenCaptureMode;
  fallbackNotified?: boolean;
  sourceCovered?: boolean;
  sourceHidden?: boolean;
  failureNotified?: boolean;
  sourceUnavailableNotified?: boolean;
  preview?: {
    presentationId: string; video: HTMLVideoElement; stream: MediaStream | null;
    attachment: Promise<void>; retirement?: Promise<void>;
  };
}

export function nativeScreenProfile(profile: QualityProfile): NativeScreenVideoProfile | null {
  if (profile.screenFps > customVideoFpsLimit(profile.screenWidth, profile.screenHeight)) return null;
  const parsed = nativeScreenVideoProfileSchema.safeParse({
    width: Math.floor(profile.screenWidth / 4) * 4, height: Math.floor(profile.screenHeight / 2) * 2,
    fps: profile.screenFps, maxBitrateKbps: profile.screenBitrateKbps,
  });
  return parsed.success ? parsed.data : null;
}

/**
 * The screens this client publishes in the call: their admission and retirement in Main, the quality
 * and audio changes that replace them, and the local preview that shows what viewers receive.
 */
export class LocalScreenSources {
  constructor(
    private readonly calls: NativeScreenCalls,
    private readonly retireStream: (stream: MediaStream) => Promise<void>,
  ) {}

  public async add(input: SourceInput): Promise<NativeScreenSource> {
    return this.addToCall(await this.calls.ensure(), input);
  }

  public previewState(shareId: string): NativeScreenPreviewState {
    return this.calls.active?.sources.get(shareId)?.previewState ?? 'waiting';
  }

  /** Why viewers currently see a frozen picture of this local source, or null while it is captured normally. */
  public warning(shareId: string): NativeScreenSourceWarning | null {
    const source = this.calls.active?.sources.get(shareId);
    if (source?.sourceHidden) return 'hidden';
    return source?.sourceCovered ? 'covered' : null;
  }

  public captureMode(call: Call, shareId: string): NativeScreenCaptureMode | null {
    const source = call.sources.get(shareId);
    return source && !source.removing && source.previewState === 'playing' ? source.captureMode ?? null : null;
  }

  public async attachPreview(shareId: string): Promise<MediaStream> {
    const call = await this.calls.ensure();
    const entry = call.sources.get(shareId);
    if (!entry?.descriptor || entry.removing || entry.preview) throw cancelled();
    const video = document.createElement('video');
    video.id = crypto.randomUUID();
    video.className = 'native-screen-presentation-owner';
    video.setAttribute('aria-hidden', 'true');
    document.body.append(video);
    const presentationId = crypto.randomUUID();
    const preview: NonNullable<LocalSource['preview']> = { presentationId, video, stream: null,
      attachment: Promise.resolve().then(() => call.api.attachNativeScreenPreview({ presentationId, elementId: video.id })) };
    entry.preview = preview;
    entry.previewState = 'waiting';
    try {
      await preview.attachment;
      this.calls.current(call);
      if (entry.removing || call.sources.get(shareId) !== entry) throw cancelled();
      if (!(video.srcObject instanceof MediaStream)) throw new Error('The local preview did not expose its owned stream.');
      preview.stream = video.srcObject;
      await this.calls.ok(call, { action: 'preview-start', callId: call.config.callId, shareId,
        sourceInstanceId: entry.descriptor.instanceId, presentationId });
      this.calls.current(call);
      if (entry.removing || call.sources.get(shareId) !== entry) throw cancelled();
      const captureStream = videoService.getScreenStream(shareId);
      if (!captureStream) throw cancelled();
      for (const track of captureStream.getVideoTracks()) {
        if (track.readyState === 'ended') captureStream.removeTrack(track);
      }
      for (const track of preview.stream.getVideoTracks()) captureStream.addTrack(track);
      return preview.stream;
    } catch (error) {
      entry.previewState = 'unavailable';
      await this.releasePreview(call, entry);
      throw error;
    } finally { announceScreenChange(); }
  }

  public releasePreview(call: Call, entry: LocalSource): Promise<void> {
    const preview = entry.preview;
    if (!preview) return Promise.resolve();
    if (preview.retirement) return preview.retirement;
    const work = (async () => {
      await Promise.allSettled([preview.attachment]);
      if (preview.stream) await this.retireStream(preview.stream);
      await call.api.stopNativeScreenPresentation(preview.presentationId);
      preview.video.remove();
      preview.stream = null;
    })();
    preview.retirement = work;
    void work.catch(() => { if (preview.retirement === work) preview.retirement = undefined; });
    return work;
  }

  public withPreviewId(call: Call, presentationId: string): LocalSource | undefined {
    return [...call.sources.values()].find(item => item.preview?.presentationId === presentationId);
  }

  private addToCall(call: Call, input: SourceInput): Promise<NativeScreenSource> {
    this.calls.current(call);
    const existing = call.sources.get(input.shareId);
    if (existing) return existing.removing ? Promise.reject(new Error('The native source is still retiring.')) : existing.ready;
    const entry: LocalSource = {
      descriptor: null, removing: false,
      ready: call.api.nativeScreenCommand({
        action: 'source-add', callId: call.config.callId, shareId: input.shareId,
        desktopSourceId: input.desktopSourceId, video: input.video, audio: input.audio, audioBitrateKbps: input.audioBitrateKbps,
        preserveAspectRatio: input.preserveAspectRatio ?? true,
        encodingMode: settingsStore.screenEncodingMode, codec: settingsStore.preferredScreenCodec,
        encodingStrategy: settingsStore.screenEncodingStrategy,
        ...(input.replacesAudioShareIds?.length ? { replacesAudioShareIds: [...input.replacesAudioShareIds] } : {}),
        ...(input.captureKind ? { captureKind: input.captureKind } : {}),
      }).then(result => {
        this.calls.current(call);
        if (call.sources.get(input.shareId) !== entry || entry.removing) throw cancelled();
        if (result.kind !== 'source') throw new Error('Native source preparation returned no descriptor.');
        acceptScreenEncoding(result.encoding);
        entry.descriptor = { ...result.source, ...(input.audience ? { audience: input.audience } : {}) };
        return entry.descriptor;
      }),
    };
    call.sources.set(input.shareId, entry);
    void entry.ready.catch(() => {
      if (!entry.removing && call.sources.get(input.shareId) === entry) call.sources.delete(input.shareId);
    });
    return entry.ready;
  }

  public async remove(shareId: string): Promise<void> {
    const call = this.calls.active;
    if (call) await this.removeFromCall(call, shareId);
  }

  private removeFromCall(call: Call, shareId: string): Promise<void> {
    const entry = call.sources.get(shareId);
    if (!entry) return Promise.resolve();
    if (entry.retirement) return entry.retirement;
    entry.removing = true;
    const work = this.calls.ok(call, { action: 'source-remove', callId: call.config.callId, shareId }).then(async () => {
      await this.releasePreview(call, entry);
      if (call.sources.get(shareId) === entry) call.sources.delete(shareId);
    });
    entry.retirement = work;
    void work.catch(() => { if (entry.retirement === work) entry.retirement = undefined; });
    return work;
  }

  /**
   * Brings a captured source in Main in line with its capture, or with `selected` quality and audio. Mutations
   * of one source run in order; the replies they await do not.
   */
  public refresh(call: Call, shareId: string, selected?: {
    video: NativeScreenVideoProfile; audioBitrateKbps: number; audio?: boolean;
  }): Promise<void> {
    this.calls.current(call);
    const execute = async (): Promise<void> => {
      this.calls.current(call);
      const capture = videoService.getNativeScreenCapture(shareId);
      if (!capture) return;
      const video = selected?.video ?? capture.source.video;
      const audioBitrateKbps = selected?.audioBitrateKbps ?? capture.audioBitrateKbps;
      // A source may give up its audio in place (#253), never acquire it.
      const audio = capture.source.audio && selected?.audio !== false;
      const previous = call.sources.get(shareId);
      if (previous && !previous.removing && screenShareProfileKey(capture.source.video) === screenShareProfileKey(video)
        && capture.audioBitrateKbps === audioBitrateKbps && capture.source.audio === audio) return;
      const isCurrentCapture = () => this.calls.active === call && !call.stopping && call.context.isCurrent()
        && videoService.getNativeScreenCapture(shareId) === capture;
      if (selected && previous?.descriptor && !previous.removing) {
        const transition = { retired: false };
        previous.reconfiguration = transition;
        try {
          const result = await call.api.nativeScreenCommand({
            action: 'source-add', callId: call.config.callId, shareId,
            replacesSourceInstanceId: previous.descriptor.instanceId,
            desktopSourceId: capture.desktopSourceId, captureKind: capture.captureKind,
            preserveAspectRatio: capture.preserveAspectRatio ?? true,
            video, audio, audioBitrateKbps,
            encodingMode: settingsStore.screenEncodingMode, codec: settingsStore.preferredScreenCodec,
            encodingStrategy: settingsStore.screenEncodingStrategy,
          });
          this.calls.current(call);
          if (!isCurrentCapture() || previous.removing || call.sources.get(shareId) !== previous) {
            await this.removeFromCall(call, shareId);
            return;
          }
          if (result.kind !== 'source') throw new Error('Native quality preparation returned no source descriptor.');
          acceptScreenEncoding(result.encoding);
          transition.retired = true;
          await this.releasePreview(call, previous);
          this.calls.current(call);
          if (!isCurrentCapture() || previous.removing || call.sources.get(shareId) !== previous) {
            await this.removeFromCall(call, shareId);
            return;
          }
          const source = { ...result.source, ...(capture.source.audience ? { audience: capture.source.audience } : {}) };
          call.sources.set(shareId, { descriptor: source, ready: Promise.resolve(source), removing: false });
          videoService.updateNativeScreenCapture({ ...capture, source, audioBitrateKbps });
          try { await this.attachPreview(shareId); }
          catch (error) { reportScreenError(error); }
          call.context.announceSources();
        } catch (error) {
          if (transition.retired && isCurrentCapture())
            emitOutsideRouting(() => appEvents.emit('local.screen_ended_externally', shareId));
          throw error;
        } finally {
          if (previous.reconfiguration === transition) previous.reconfiguration = undefined;
        }
        return;
      }
      const replace = async (nextVideo: NativeScreenVideoProfile, nextAudioBitrate: number, nextAudio: boolean): Promise<void> => {
        const source = await this.addToCall(call, {
          ...capture, shareId, video: nextVideo, audioBitrateKbps: nextAudioBitrate, audio: nextAudio,
          audience: capture.source.audience,
        });
        this.calls.current(call);
        if (videoService.getNativeScreenCapture(shareId) !== capture) { await this.removeFromCall(call, shareId); return; }
        videoService.updateNativeScreenCapture({ ...capture, source, audioBitrateKbps: nextAudioBitrate });
        try { await this.attachPreview(shareId); }
        catch (error) { reportScreenError(error); }
        call.context.announceSources();
      };
      let removed = false;
      try {
        await this.removeFromCall(call, shareId);
        removed = true;
        this.calls.current(call);
        if (videoService.getNativeScreenCapture(shareId) !== capture) return;
        await replace(video, audioBitrateKbps, audio);
      } catch (error) {
        if (isCurrentCapture()) {
          if (removed && previous && selected) {
            try { await replace(capture.source.video, capture.audioBitrateKbps, capture.source.audio); }
            catch (rollbackError) {
              if (isCurrentCapture()) emitOutsideRouting(() => appEvents.emit('local.screen_ended_externally', shareId));
              throw new AggregateError([error, rollbackError], 'Native screen quality change and restoration failed.');
            }
          } else emitOutsideRouting(() => appEvents.emit('local.screen_ended_externally', shareId));
        }
        throw error;
      }
    };
    // Serialize only mutations of this source, never the replies they await.
    const task = (call.sourceTasks.get(shareId) ?? Promise.resolve()).then(execute, execute);
    call.sourceTasks.set(shareId, task);
    const remove = () => { if (call.sourceTasks.get(shareId) === task) call.sourceTasks.delete(shareId); };
    void task.then(remove, remove);
    return task;
  }

  public async applyQuality(profile: QualityProfile): Promise<number> {
    const captures = videoService.getNativeScreenCaptures();
    if (!captures.length) return 0;
    const video = nativeScreenProfile(profile);
    if (!video) throw new Error(t('screenShare.nativeProfileChangeBlocked'));
    const call = await this.calls.ensure();
    await Promise.all(captures.map(capture => this.refresh(call, capture.source.shareId,
      { video, audioBitrateKbps: profile.audioBitrateKbps })));
    announceScreenChange();
    return captures.length;
  }

  /** Keeps the share on air but stops capturing its audio, which a whole screen is taking over (#253). */
  public async withdrawAudio(shareId: string): Promise<void> {
    const capture = videoService.getNativeScreenCapture(shareId);
    if (!capture?.source.audio) return;
    const call = await this.calls.ensure();
    await this.refresh(call, shareId,
      { video: capture.source.video, audioBitrateKbps: capture.audioBitrateKbps, audio: false });
    announceScreenChange();
  }

  public settingsIssue(profile: QualityProfile, codec: ScreenCodecPreference): 'profile' | 'codec' | null {
    if (!videoService.getNativeScreenCaptures().length) return null;
    if (!nativeScreenProfile(profile) || !nativeScreenAudioBitrateSchema.safeParse(profile.audioBitrateKbps).success)
      return 'profile';
    return codec === 'auto' || codec === 'h264' || codec === 'av1' ? null : 'codec';
  }

  /** What Main reports about a screen this client publishes. */
  public async notice(call: Call, event: NativeScreenNotice, shareId: string): Promise<void> {
    const entry = call.sources.get(shareId), source = entry?.descriptor;
    if (!source || entry.removing || source.instanceId !== event.sourceInstanceId) return;
    if (event.type === 'state' && event.state === 'closed') {
      if (entry.reconfiguration) { entry.reconfiguration.retired = true; return; }
      await this.releasePreview(call, entry);
      call.sources.delete(shareId);
      emitOutsideRouting(() => appEvents.emit('local.screen_ended_externally', shareId));
    } else if (event.type === 'preview-state') {
      entry.previewState = event.state;
      if (event.state === 'playing') entry.failureNotified = false;
      announceScreenChange();
    } else if (event.type === 'capture-mode') {
      if (entry.preview?.presentationId !== event.presentationId) return;
      entry.captureMode = event.mode;
      announceScreenChange();
    } else if (event.type === 'capture-fallback') {
      const capture = videoService.getNativeScreenCapture(shareId);
      if (!capture || capture.source.instanceId !== source.instanceId || entry.fallbackNotified) return;
      entry.fallbackNotified = true;
      videoService.updateNativeScreenCapture({ ...capture, captureKind: 'window' });
      emitOutsideRouting(() => appEvents.emit('native_screen.capture_fallback', { shareId }));
    } else if (event.type === 'source-occlusion') {
      if ((entry.sourceCovered ?? false) === event.occluded) return;
      entry.sourceCovered = event.occluded;
      announceScreenChange();
    } else if (event.type === 'source-visibility') {
      if ((entry.sourceHidden ?? false) === event.hidden) return;
      entry.sourceHidden = event.hidden;
      announceScreenChange();
    } else if (event.type === 'error') {
      if (event.reason === 'source-unavailable') {
        if (entry.sourceUnavailableNotified) return;
        entry.sourceUnavailableNotified = true;
      } else {
        if (entry.failureNotified) return;
        entry.failureNotified = true;
      }
      emitOutsideRouting(() => appEvents.emit('native_screen.source_failed', {
        reason: event.reason, shareId, ...(event.code ? { code: event.code } : {}),
      }));
    }
  }

  /** Main stopped presenting a local preview: viewers keep receiving, only the preview goes. */
  public previewFailed(call: Call, event: { presentationId: string | null; message: string }): void {
    for (const entry of call.sources.values()) {
      if (entry.preview && event.presentationId === entry.preview.presentationId) {
        entry.previewState = 'unavailable';
        reportScreenError(new Error(event.message));
        void this.releasePreview(call, entry).catch(reportScreenError);
      }
    }
  }

  /** The call retired: the previews it showed are released. */
  public async releaseAll(call: Call): Promise<void> {
    await Promise.all([...call.sources.values()].map(entry => this.releasePreview(call, entry)));
  }
}
