import {
  MessageType, nativeScreenIceServersSchema, nativeScreenProducerSchema, nativeScreenSignalAckSchema,
  nativeScreenSignalSchema, nativeScreenVideoProfileSchema, nativeScreenAudioBitrateSchema, screenShareProfileKey, getScreenShareProfile,
  type NativeScreenCall, type NativeScreenCapabilities, type NativeScreenCommand, type NativeScreenCommandResult,
  type NativeScreenEvent, type NativeScreenFailure, type NativeScreenSource, type NativeScreenVideoProfile,
  type NativeScreenRpcMethod, type NativeScreenSignalPayload, type QualityProfile, type ScreenShareQuality,
  type NativeScreenEndpointDiagnostics, type NativeScreenPreviewState, type NativeScreenCaptureMode,
} from '@monky/shared';
import type { ElectronApi } from '../../../preload/preload';
import type { NetworkClient } from '../NetworkClient';
import type { ParticipantManager } from '../ParticipantManager';
import { appEvents } from '../EventBus';
import { emitOutsideRouting } from '../sessionRouting';
import { clientLog } from '../ClientLogService';
import { t } from '../../i18n';
import { videoService, type NativeScreenCapture } from '../VideoService';
import { settingsStore, type ScreenShareReceiver } from '../../stores/settingsStore';
import { voiceStore } from '../../stores/voiceStore';
import { resolveAudioOutput } from '../../utils/audioPreferences';
import { customVideoFpsLimit } from '../../utils/qualityProfileLimits';
import { BrowserScreenSubscription } from './BrowserScreenSubscription';
import type { RemoteMediaRouter } from './RemoteMediaRouter';
import type { ScreenCodecPreference } from '@monky/shared';
import { acceptScreenEncoding } from '../screenEncoding';

export interface NativeScreenCallContext {
  readonly client: NetworkClient;
  readonly participants: ParticipantManager;
  readonly sessionId: string;
  readonly channelId: string;
  readonly mode: 'p2p' | 'sfu';
  readonly isCurrent: () => boolean;
  readonly announceSources: () => void;
}

export interface NativeScreenWatchState {
  readonly state: 'connecting' | 'playing' | 'unavailable';
  readonly reason?: NativeScreenFailure;
  readonly receiver?: ScreenShareReceiver;
}

export type ScreenVideoDiagnostics =
  | { backend: 'native'; source: NativeScreenSource; viewers: number | null; endpoints: readonly NativeScreenEndpointDiagnostics[] }
  | { backend: 'browser'; source: NativeScreenSource; target: object; profile: Readonly<NativeScreenVideoProfile>;
    reports: RTCStatsReport | null };

interface Presentation {
  readonly receiver: ScreenShareReceiver;
  readonly publisherSessionId: string;
  readonly source: NativeScreenSource;
  readonly quality: ScreenShareQuality;
  readonly sinkId: string;
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

type SourceInput = Omit<NativeScreenCapture, 'source'> & {
  shareId: string; video: NativeScreenVideoProfile; audio: boolean;
  replacesAudioShareId?: string;
  audience?: NativeScreenSource['audience'];
};
interface Source {
  readonly ready: Promise<NativeScreenSource>;
  descriptor: NativeScreenSource | null;
  removing: boolean;
  reconfiguration?: { retired: boolean };
  retirement?: Promise<void>;
  previewState?: NativeScreenPreviewState;
  captureMode?: NativeScreenCaptureMode;
  fallbackNotified?: boolean;
  failureNotified?: boolean;
  sourceUnavailableNotified?: boolean;
  preview?: {
    presentationId: string; video: HTMLVideoElement; stream: MediaStream | null;
    attachment: Promise<void>; retirement?: Promise<void>;
  };
}

interface Call {
  readonly config: NativeScreenCall;
  readonly context: NativeScreenCallContext;
  readonly connectionId: string;
  readonly api: ElectronApi;
  readonly sources: Map<string, Source>;
  readonly sourceTasks: Map<string, Promise<void>>;
  readonly presentations: Map<string, Presentation>;
  readonly watchTasks: Map<string, Promise<void>>;
  readonly unbind: Array<() => void>;
  readonly controls: Set<Promise<NativeScreenCommandResult>>;
  joining: Promise<void>;
  ready: Promise<void>;
  roster: string;
  rosterTask: Promise<void>;
  previewPreference?: boolean;
  previewPreferenceTask?: Promise<void>;
  stopping: boolean;
  retirement?: Promise<void>;
}

const keyOf = (sessionId: string, shareId: string): string => `${sessionId}\0${shareId}`;
const cancelled = (): DOMException => new DOMException('The native screen call was superseded.', 'AbortError');
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function nativeScreenProfile(profile: QualityProfile): NativeScreenVideoProfile | null {
  if (profile.screenFps > customVideoFpsLimit(profile.screenWidth, profile.screenHeight)) return null;
  const parsed = nativeScreenVideoProfileSchema.safeParse({
    width: Math.floor(profile.screenWidth / 4) * 4, height: Math.floor(profile.screenHeight / 2) * 2,
    fps: profile.screenFps, maxBitrateKbps: profile.screenBitrateKbps,
  });
  return parsed.success ? parsed.data : null;
}

export class NativeScreenController {
  private call: Call | null = null;
  private retiring = new Set<Call>();
  private availability: Promise<NativeScreenCapabilities> | null = null;
  private sinkId = resolveAudioOutput(settingsStore, 'screen');
  private shutdownRequested = false;

  constructor(
    private readonly context: () => NativeScreenCallContext | null,
    private readonly retireStream: (stream: MediaStream) => Promise<void>,
    private readonly mediaRouter: RemoteMediaRouter,
  ) {}

  public capabilities(): Promise<NativeScreenCapabilities> {
    if (!this.availability) this.availability = this.api().nativeScreenCommand({ action: 'capabilities' }).then(result => {
      if (result.kind !== 'capabilities') throw new Error('Invalid native screen capability response.');
      return result.capabilities;
    });
    return this.availability;
  }

  private api(): ElectronApi {
    if (typeof window === 'undefined' || !window.api?.nativeScreenCommand)
      throw new Error('The native screen IPC boundary is unavailable.');
    return window.api;
  }

  private current(call: Call): void {
    if (this.shutdownRequested || call.stopping || this.call !== call || !call.context.isCurrent()) throw cancelled();
  }

  private networkCurrent(call: Call): boolean {
    return call.context.client.getStatus() === 'CONNECTED'
      && call.context.client.getConnectionId() === call.connectionId;
  }

  private changed(): void {
    emitOutsideRouting(() => appEvents.emit('native_screen.updated'));
  }

  public report(error: unknown): void {
    if (error instanceof Error && error.name === 'AbortError') return;
    clientLog.error('SCREEN_SHARE', 'Native screen operation failed', { error: messageOf(error) });
  }

  private warnRetirement(result: Extract<NativeScreenCommandResult, { kind: 'retired-with-errors' }>): void {
    clientLog.warn('SCREEN_SHARE', 'Native media retired with cleanup errors',
      { error: result.error, remoteAcknowledged: result.remoteAcknowledged });
  }

  private async ok(call: Call, command: NativeScreenCommand): Promise<void> {
    this.current(call);
    const work = call.api.nativeScreenCommand(command);
    call.controls.add(work);
    let result: NativeScreenCommandResult;
    try { result = await work; }
    finally { call.controls.delete(work); }
    if (result.kind === 'retired-with-errors' && (command.action === 'source-remove' || command.action === 'stop')) {
      this.warnRetirement(result);
      return;
    }
    if (result.kind !== 'ok') throw new Error(`Unexpected native screen response to ${command.action}.`);
  }

  private async ensureCall(): Promise<Call> {
    if (this.shutdownRequested) throw cancelled();
    if (this.call && !this.call.context.isCurrent()) await this.close();
    if (!this.call) {
      await Promise.all([...this.retiring].map(call => this.retireCall(call)));
      if (this.shutdownRequested) throw cancelled();
      // A concurrent source/Watch may have created the call while cleanup awaited.
      if (this.call) return this.ensureCall();
      const context = this.context();
      if (!context || !context.isCurrent()) throw cancelled();
      const api = this.api();
      const config: NativeScreenCall = {
        callId: crypto.randomUUID(), sessionId: context.sessionId, channelId: context.channelId, mode: context.mode,
        iceServers: nativeScreenIceServersSchema.parse(context.client.getIceServers().flatMap(server => {
          const urls = typeof server.urls === 'string' ? [server.urls] : server.urls;
          if (!urls.length) throw new Error('An ICE server must contain at least one URL.');
          return Array.from({ length: Math.ceil(urls.length / 4) }, (_, index) => ({
            urls: urls.slice(index * 4, index * 4 + 4),
            ...(server.username === undefined ? {} : { username: server.username }),
            ...(server.credential === undefined ? {} : { credential: server.credential }),
          }));
        })),
      };
      const call: Call = {
        config, context, api, connectionId: context.client.getConnectionId(), sources: new Map(), presentations: new Map(),
        sourceTasks: new Map(), watchTasks: new Map(), unbind: [], controls: new Set(), joining: Promise.resolve(),
        ready: Promise.resolve(), roster: '', rosterTask: Promise.resolve(), stopping: false,
      };
      this.call = call;
      call.unbind.push(api.onNativeScreenEvent(event => {
        if (event.callId === config.callId) void this.handleMainEvent(call, event).catch(error => this.report(error));
      }));
      call.unbind.push(api.onNativeScreenPresentationError(event => {
        for (const entry of call.sources.values()) {
          if (entry.preview && event.presentationId === entry.preview.presentationId) {
            entry.previewState = 'unavailable';
            this.report(new Error(event.message));
            void this.releaseLocalPreview(call, entry).catch(error => this.report(error));
          }
        }
        for (const entry of call.presentations.values()) {
          if (!entry.browser && !entry.stopping && (!event.presentationId || entry.presentationId === event.presentationId)) {
            entry.state = { state: 'unavailable', reason: 'connection-failed' };
            this.report(new Error(event.message));
            void this.stopPresentation(call, entry).catch(error => this.report(error));
          }
        }
        this.changed();
      }));
      call.unbind.push(context.client.onEvent((event, value) => {
        if (event === 'network.status' && !this.networkCurrent(call)) {
          void this.retireCall(call).catch(error => this.report(error));
        } else if (!call.stopping && context.isCurrent()) {
          void this.handleNetworkEvent(call, event, value).catch(error => this.report(error));
        }
      }));
      call.joining = this.ok(call, { ...config, action: 'join' });
      call.ready = call.joining.then(async () => {
        this.current(call);
        await this.syncPreviewPreference(call);
        return this.updateRoster(call);
      });
      call.unbind.push(appEvents.on('settings.updated', () => {
        if (call.stopping || !call.context.isCurrent()) return;
        void call.ready.then(() => this.syncPreviewPreference(call)).catch(error => this.report(error));
      }));
    }
    const call = this.call;
    try {
      await call.ready;
      this.current(call);
      return call;
    } catch (error) {
      try { await this.retireCall(call); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Native call admission and retirement failed.'); }
      throw error;
    }
  }

  private updateRoster(call: Call): Promise<void> {
    this.current(call);
    const participants = call.context.participants.getInVoiceChannel(call.config.channelId).map(participant => ({
      sessionId: participant.user.sessionId || participant.user.id,
      nativeScreenShares: (participant.voiceState?.nativeScreenShares ?? []).map(({ audience: _audience, ...source }) => source),
    }));
    const roster = JSON.stringify(participants);
    if (roster !== call.roster) {
      call.roster = roster;
      const task = this.ok(call, { action: 'participants', callId: call.config.callId, participants });
      call.rosterTask = task;
      void task.catch(() => { if (call.rosterTask === task) call.roster = ''; });
    }
    return call.rosterTask;
  }

  private async handleNetworkEvent(call: Call, event: string, value: unknown): Promise<void> {
    if (event === `message.${MessageType.NATIVE_SCREEN_SIGNAL}`) {
      const signal = nativeScreenSignalSchema.parse(value);
      if (signal.channelId !== call.config.channelId || signal.targetSessionId !== call.config.sessionId) return;
      await call.ready;
      await this.updateRoster(call);
      this.current(call);
      const entry = call.presentations.get(keyOf(signal.publisherSessionId, signal.shareId));
      if (entry?.browser && entry.source.instanceId === signal.sourceInstanceId) {
        try { await entry.browser.receive(signal); }
        catch (error) { this.browserFailed(call, entry, error); }
      } else await this.ok(call, { action: 'signal', callId: call.config.callId, signal });
    } else if (event === `message.${MessageType.SFU_NEW_PRODUCER}`) {
      const parsed = nativeScreenProducerSchema.safeParse(value);
      if (!parsed.success || parsed.data.channelId !== call.config.channelId) return;
      await call.ready;
      this.current(call);
      await Promise.all([
        this.ok(call, { action: 'producer', callId: call.config.callId, producer: parsed.data }),
        ...[...call.presentations.values()].flatMap(entry => entry.browser && !entry.stopping
          ? [entry.browser.addProducer(parsed.data).catch(error => this.browserFailed(call, entry, error))] : []),
      ]);
    } else if (event === `message.${MessageType.SFU_PRODUCER_CLOSED}` && value && typeof value === 'object'
      && 'channelId' in value && value.channelId === call.config.channelId
      && 'producerId' in value && typeof value.producerId === 'string') {
      await call.ready;
      this.current(call);
      const producerId = value.producerId;
      await Promise.all([
        this.ok(call, { action: 'producer-remove', callId: call.config.callId, producerId }),
        ...[...call.presentations.values()].flatMap(entry => entry.browser && !entry.stopping
          ? [entry.browser.removeProducer(producerId).catch(error => this.browserFailed(call, entry, error))] : []),
      ]);
    }
  }

  private async sendSignal(call: Call, signal: NativeScreenSignalPayload): Promise<void> {
    if (!this.networkCurrent(call)) throw new Error('The original signaling connection is unavailable.');
    const ack = nativeScreenSignalAckSchema.parse(await call.context.client.sendRequest<unknown>(MessageType.NATIVE_SCREEN_SIGNAL, signal));
    if (ack.subscriptionId !== signal.subscriptionId) throw new Error('Screen signaling acknowledged another subscription.');
  }

  private async handleMainEvent(call: Call, event: NativeScreenEvent): Promise<void> {
    if ('requestId' in event) {
      // Replies must run independently of the command awaiting this request.
      try {
        let value: unknown = null;
        if (event.type === 'presentation-stop') {
          const entry = [...call.presentations.values()].find(item => item.presentationId === event.presentationId);
          if (entry) await this.releasePresentation(call, entry);
          else {
            const source = [...call.sources.values()].find(item => item.preview?.presentationId === event.presentationId);
            if (source) await this.releaseLocalPreview(call, source);
            else await call.api.stopNativeScreenPresentation(event.presentationId);
          }
        } else {
          if (!this.networkCurrent(call)) throw new Error('The original signaling connection is unavailable.');
          if (event.type === 'signal') {
            await this.sendSignal(call, event.signal);
          } else {
            value = await call.context.client.sendRequest<unknown>(event.method, event.payload);
            if (value === undefined) throw new Error('Native SFU RPC returned no acknowledgement.');
          }
        }
        await call.api.nativeScreenReply({ callId: event.callId, requestId: event.requestId, ok: true, value });
      } catch (error) {
        await call.api.nativeScreenReply({
          callId: event.callId, requestId: event.requestId, ok: false, error: messageOf(error).slice(0, 4096) || 'Native screen request failed.',
        });
      }
      return;
    }
    if (call.stopping || !call.context.isCurrent()) return;
    if (event.type === 'error') this.report(new Error(event.message));
    if (event.publisherSessionId === call.config.sessionId && event.shareId) {
      const entry = call.sources.get(event.shareId), source = entry?.descriptor;
      if (!source || entry.removing || source.instanceId !== event.sourceInstanceId) return;
      if (event.type === 'state' && event.state === 'closed') {
        if (entry.reconfiguration) { entry.reconfiguration.retired = true; return; }
        await this.releaseLocalPreview(call, entry);
        call.sources.delete(event.shareId);
        emitOutsideRouting(() => appEvents.emit('local.screen_ended_externally', event.shareId));
      } else if (event.type === 'preview-state') {
        entry.previewState = event.state;
        if (event.state === 'playing') entry.failureNotified = false;
        this.changed();
      } else if (event.type === 'capture-mode') {
        if (entry.preview?.presentationId !== event.presentationId) return;
        entry.captureMode = event.mode;
        this.changed();
      } else if (event.type === 'capture-fallback') {
        const capture = videoService.getNativeScreenCapture(event.shareId);
        if (!capture || capture.source.instanceId !== source.instanceId || entry.fallbackNotified) return;
        entry.fallbackNotified = true;
        videoService.updateNativeScreenCapture({ ...capture, captureKind: 'window' });
        emitOutsideRouting(() => appEvents.emit('native_screen.capture_fallback', { shareId: event.shareId }));
      } else if (event.type === 'error') {
        if (event.reason === 'source-unavailable') {
          if (entry.sourceUnavailableNotified) return;
          entry.sourceUnavailableNotified = true;
        } else {
          if (entry.failureNotified) return;
          entry.failureNotified = true;
        }
        emitOutsideRouting(() => appEvents.emit('native_screen.source_failed', {
          reason: event.reason, shareId: event.shareId, ...(event.code ? { code: event.code } : {}),
        }));
      }
    } else if (event.shareId && event.type !== 'preview-state' && event.type !== 'capture-fallback') {
      const entry = call.presentations.get(keyOf(event.publisherSessionId, event.shareId));
      if (!entry || entry.stopping || entry.presentationId !== event.presentationId
        || entry.source.instanceId !== event.sourceInstanceId) return;
      if (event.type === 'capture-mode') entry.captureMode = event.mode;
      else if (!(event.type === 'state' && event.state === 'closed' && entry.state.state === 'unavailable'))
        entry.state = event.type === 'state' && (event.state === 'playing' || event.state === 'connecting')
          ? { state: event.state } : { state: 'unavailable', reason: event.reason ?? 'connection-failed' };
      this.changed();
    }
  }

  public async addSource(input: SourceInput): Promise<NativeScreenSource> {
    return this.addCallSource(await this.ensureCall(), input);
  }

  public getLocalPreviewState(shareId: string): NativeScreenPreviewState {
    return this.call?.sources.get(shareId)?.previewState ?? 'waiting';
  }

  private syncPreviewPreference(call: Call): Promise<void> {
    this.current(call);
    const pauseWhenUnfocused = settingsStore.screenSharePreviewPauseWhenUnfocused;
    if (call.previewPreference === pauseWhenUnfocused) return call.previewPreferenceTask ?? Promise.resolve();
    call.previewPreference = pauseWhenUnfocused;
    const work = this.ok(call, { action: 'preview-preferences', callId: call.config.callId, pauseWhenUnfocused });
    call.previewPreferenceTask = work;
    void work.then(() => {
      if (call.previewPreferenceTask === work) call.previewPreferenceTask = undefined;
    }, () => {
      if (call.previewPreferenceTask === work) {
        call.previewPreferenceTask = undefined;
        call.previewPreference = undefined;
      }
    });
    return work;
  }

  public async attachLocalPreview(shareId: string): Promise<MediaStream> {
    const call = await this.ensureCall();
    const entry = call.sources.get(shareId);
    if (!entry?.descriptor || entry.removing || entry.preview) throw cancelled();
    const video = document.createElement('video');
    video.id = crypto.randomUUID();
    video.className = 'native-screen-presentation-owner';
    video.setAttribute('aria-hidden', 'true');
    document.body.append(video);
    const presentationId = crypto.randomUUID();
    const preview: NonNullable<Source['preview']> = { presentationId, video, stream: null,
      attachment: Promise.resolve().then(() => call.api.attachNativeScreenPreview({ presentationId, elementId: video.id })) };
    entry.preview = preview;
    entry.previewState = 'waiting';
    try {
      await preview.attachment;
      this.current(call);
      if (entry.removing || call.sources.get(shareId) !== entry) throw cancelled();
      if (!(video.srcObject instanceof MediaStream)) throw new Error('The local preview did not expose its owned stream.');
      preview.stream = video.srcObject;
      await this.ok(call, { action: 'preview-start', callId: call.config.callId, shareId,
        sourceInstanceId: entry.descriptor.instanceId, presentationId });
      this.current(call);
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
      await this.releaseLocalPreview(call, entry);
      throw error;
    } finally { this.changed(); }
  }

  private releaseLocalPreview(call: Call, entry: Source): Promise<void> {
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

  private addCallSource(call: Call, input: SourceInput): Promise<NativeScreenSource> {
    this.current(call);
    const existing = call.sources.get(input.shareId);
    if (existing) return existing.removing ? Promise.reject(new Error('The native source is still retiring.')) : existing.ready;
    const entry: Source = {
      descriptor: null, removing: false,
      ready: call.api.nativeScreenCommand({
        action: 'source-add', callId: call.config.callId, shareId: input.shareId,
        desktopSourceId: input.desktopSourceId, video: input.video, audio: input.audio, audioBitrateKbps: input.audioBitrateKbps,
        preserveAspectRatio: input.preserveAspectRatio ?? true,
        encodingMode: settingsStore.screenEncodingMode, codec: settingsStore.preferredScreenCodec,
        encodingStrategy: settingsStore.screenEncodingStrategy,
        ...(input.replacesAudioShareId ? { replacesAudioShareId: input.replacesAudioShareId } : {}),
        ...(input.captureKind ? { captureKind: input.captureKind } : {}),
      }).then(result => {
        this.current(call);
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

  public async removeSource(shareId: string): Promise<void> {
    const call = this.call;
    if (call) await this.removeCallSource(call, shareId);
  }

  private removeCallSource(call: Call, shareId: string): Promise<void> {
    const entry = call.sources.get(shareId);
    if (!entry) return Promise.resolve();
    if (entry.retirement) return entry.retirement;
    entry.removing = true;
    const work = this.ok(call, { action: 'source-remove', callId: call.config.callId, shareId }).then(async () => {
      await this.releaseLocalPreview(call, entry);
      if (call.sources.get(shareId) === entry) call.sources.delete(shareId);
    });
    entry.retirement = work;
    void work.catch(() => { if (entry.retirement === work) entry.retirement = undefined; });
    return work;
  }

  private refreshSource(call: Call, shareId: string, selected?: {
    video: NativeScreenVideoProfile; audioBitrateKbps: number;
  }): Promise<void> {
    this.current(call);
    const execute = async (): Promise<void> => {
      this.current(call);
      const capture = videoService.getNativeScreenCapture(shareId);
      if (!capture) return;
      const video = selected?.video ?? capture.source.video;
      const audioBitrateKbps = selected?.audioBitrateKbps ?? capture.audioBitrateKbps;
      const previous = call.sources.get(shareId);
      if (previous && !previous.removing && screenShareProfileKey(capture.source.video) === screenShareProfileKey(video)
        && capture.audioBitrateKbps === audioBitrateKbps) return;
      const isCurrentCapture = () => this.call === call && !call.stopping && call.context.isCurrent()
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
            video, audio: capture.source.audio, audioBitrateKbps,
            encodingMode: settingsStore.screenEncodingMode, codec: settingsStore.preferredScreenCodec,
            encodingStrategy: settingsStore.screenEncodingStrategy,
          });
          this.current(call);
          if (!isCurrentCapture() || previous.removing || call.sources.get(shareId) !== previous) {
            await this.removeCallSource(call, shareId);
            return;
          }
          if (result.kind !== 'source') throw new Error('Native quality preparation returned no source descriptor.');
          acceptScreenEncoding(result.encoding);
          transition.retired = true;
          await this.releaseLocalPreview(call, previous);
          this.current(call);
          if (!isCurrentCapture() || previous.removing || call.sources.get(shareId) !== previous) {
            await this.removeCallSource(call, shareId);
            return;
          }
          const source = { ...result.source, ...(capture.source.audience ? { audience: capture.source.audience } : {}) };
          call.sources.set(shareId, { descriptor: source, ready: Promise.resolve(source), removing: false });
          videoService.updateNativeScreenCapture({ ...capture, source, audioBitrateKbps });
          try { await this.attachLocalPreview(shareId); }
          catch (error) { this.report(error); }
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
      const replace = async (nextVideo: NativeScreenVideoProfile, nextAudioBitrate: number): Promise<void> => {
        const source = await this.addCallSource(call, {
          ...capture, shareId, video: nextVideo, audioBitrateKbps: nextAudioBitrate, audio: capture.source.audio,
          audience: capture.source.audience,
        });
        this.current(call);
        if (videoService.getNativeScreenCapture(shareId) !== capture) { await this.removeCallSource(call, shareId); return; }
        videoService.updateNativeScreenCapture({ ...capture, source, audioBitrateKbps: nextAudioBitrate });
        try { await this.attachLocalPreview(shareId); }
        catch (error) { this.report(error); }
        call.context.announceSources();
      };
      let removed = false;
      try {
        await this.removeCallSource(call, shareId);
        removed = true;
        this.current(call);
        if (videoService.getNativeScreenCapture(shareId) !== capture) return;
        await replace(video, audioBitrateKbps);
      } catch (error) {
        if (isCurrentCapture()) {
          if (removed && previous && selected) {
            try { await replace(capture.source.video, capture.audioBitrateKbps); }
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

  public async applyQuality(profile: QualityProfile): Promise<void> {
    const captures = videoService.getNativeScreenCaptures();
    if (!captures.length) return;
    const video = nativeScreenProfile(profile);
    if (!video) throw new Error(t('screenShare.nativeProfileChangeBlocked'));
    const call = await this.ensureCall();
    await Promise.all(captures.map(capture => this.refreshSource(call, capture.source.shareId,
      { video, audioBitrateKbps: profile.audioBitrateKbps })));
    this.changed();
  }

  public settingsIssue(profile: QualityProfile, codec: ScreenCodecPreference): 'profile' | 'codec' | null {
    if (!videoService.getNativeScreenCaptures().length) return null;
    if (!nativeScreenProfile(profile) || !nativeScreenAudioBitrateSchema.safeParse(profile.audioBitrateKbps).success)
      return 'profile';
    return codec === 'auto' || codec === 'h264' || codec === 'av1' ? null : 'codec';
  }

  public async sync(): Promise<void> {
    const context = this.context();
    if (!context?.isCurrent()) return;
    const active = this.call;
    if (active && !active.stopping && active.context.isCurrent()) {
      for (const entry of active.presentations.values()) {
        if (!entry.stopping && !this.wantsPresentation(active, entry)) {
          entry.restart = true;
          void this.stopPresentation(active, entry).catch(error => this.report(error));
        }
      }
    }
    const nativeWatches = voiceStore.getScreenWatchers().flatMap(([sessionId, shares]) => shares
      .filter(shareId => context.participants.get(sessionId)?.voiceState?.nativeScreenShares?.some(source => source.shareId === shareId))
      .map(shareId => keyOf(sessionId, shareId)));
    if (!this.call && !nativeWatches.length && !videoService.getNativeScreenCaptures().length) return;
    const call = await this.ensureCall();
    await this.updateRoster(call);
    await Promise.all(videoService.getNativeScreenCaptures().map(capture => this.refreshSource(call, capture.source.shareId)));
    const keys = new Set([...call.presentations.keys(), ...nativeWatches]);
    await Promise.all([...keys].map(key => this.queueWatch(call, key)));
  }

  private queueWatch(call: Call, key: string): Promise<void> {
    const preceding = call.watchTasks.get(key) ?? Promise.resolve();
    const execute = () => this.syncWatch(call, key);
    const task = preceding.then(execute, execute).catch(error => {
      const entry = call.presentations.get(key);
      if (entry && !(error instanceof Error && error.name === 'AbortError')) {
        if (entry.state.state !== 'unavailable') entry.state = { state: 'unavailable', reason: 'connection-failed' };
        this.changed();
      }
      throw error;
    });
    call.watchTasks.set(key, task);
    const remove = () => { if (call.watchTasks.get(key) === task) call.watchTasks.delete(key); };
    void task.then(remove, remove);
    return task;
  }

  private wantsPresentation(call: Call, entry: Presentation): boolean {
    const participant = call.context.participants.get(entry.publisherSessionId);
    return !entry.restart && participant?.voiceState?.channelId === call.config.channelId
      && participant.voiceState.nativeScreenShares?.some(source => source.shareId === entry.source.shareId
        && source.instanceId === entry.source.instanceId) === true
      && voiceStore.isWatchingScreen(entry.publisherSessionId, entry.source.shareId)
      && voiceStore.getScreenQuality(entry.publisherSessionId, entry.source.shareId) === entry.quality
      && this.sinkId === entry.sinkId;
  }

  private async syncWatch(call: Call, key: string): Promise<void> {
    this.current(call);
    const [publisherSessionId, shareId] = key.split('\0');
    const participant = call.context.participants.get(publisherSessionId);
    const source = participant?.voiceState?.channelId === call.config.channelId
      && voiceStore.isWatchingScreen(publisherSessionId, shareId)
      ? participant.voiceState.nativeScreenShares?.find(value => value.shareId === shareId) : undefined;
    const quality = voiceStore.getScreenQuality(publisherSessionId, shareId);
    const assertWanted = (entry?: Presentation): void => {
      this.current(call);
      if (entry?.stopping || (entry && this.sinkId !== entry.sinkId)
        || !voiceStore.isWatchingScreen(publisherSessionId, shareId)
        || voiceStore.getScreenQuality(publisherSessionId, shareId) !== quality
        || call.context.participants.get(publisherSessionId)?.voiceState?.nativeScreenShares
          ?.find(value => value.shareId === shareId)?.instanceId !== source?.instanceId) throw cancelled();
    };
    const previous = call.presentations.get(key);
    if (previous && this.wantsPresentation(call, previous)) {
      if (!previous.stopping) { await this.applyAudio(call, previous); return; }
      if (previous.state.state === 'unavailable') return;
    }
    if (previous) {
      await this.stopPresentation(call, previous);
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
    this.changed();
    try {
      assertWanted(entry);
      if (entry.receiver === 'chromium') {
        entry.browser = this.createBrowserSubscription(call, entry);
        entry.requested = true;
        await entry.browser.start();
        assertWanted(entry);
        return;
      }
      const capabilities = await this.capabilities();
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
      this.changed();
      entry.requested = true;
      const result = await call.api.nativeScreenCommand({
        action: 'watch', callId: call.config.callId, publisherSessionId, shareId, quality,
        presentationId: entry.presentationId, audio: this.audioPreferences(call, entry),
      });
      assertWanted(entry);
      if (result.kind !== 'subscription' || result.presentationId !== entry.presentationId)
        throw new Error('Native Watch acknowledged another presentation.');
    } catch (error) {
      if (entry.state.state !== 'unavailable') entry.state = { state: 'unavailable', reason: 'connection-failed' };
      try { await this.stopPresentation(call, entry); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Native Watch and presentation cleanup failed.'); }
      throw error;
    } finally { this.changed(); }
  }

  private browserFailed(call: Call, entry: Presentation, error: unknown): void {
    if (entry.stopping) return;
    this.report(error);
    entry.state = { state: 'unavailable', reason: 'connection-failed' };
    this.changed();
    void this.stopPresentation(call, entry).catch(cleanupError => this.report(cleanupError));
  }

  private createBrowserSubscription(call: Call, entry: Presentation): BrowserScreenSubscription {
    entry.video.onplaying = () => {
      if (entry.stopping) return;
      entry.browser?.playing();
      entry.state = { state: 'playing' };
      this.changed();
    };
    return new BrowserScreenSubscription({
      call: call.config, publisherSessionId: entry.publisherSessionId, source: entry.source, quality: entry.quality,
      muted: this.audioPreferences(call, entry).muted,
      send: signal => this.sendSignal(call, signal),
      rpc: async <T>(method: NativeScreenRpcMethod, payload: Record<string, unknown>): Promise<T> => {
        if (!this.networkCurrent(call)) throw new Error('The original screen SFU connection is unavailable.');
        const response = await call.context.client.sendRequest<T>(method, payload);
        if (response === undefined) throw new Error('The screen SFU returned no acknowledgement.');
        return response;
      },
      onTrack: track => {
        if (entry.stopping || call.stopping) { track.stop(); return; }
        if (track.kind === 'audio') {
          entry.audioTrack = track;
          this.mediaRouter.routeScreenAudioTrack(entry.publisherSessionId, track,
            error => this.browserFailed(call, entry, error));
          void this.applyAudio(call, entry).catch(error => this.browserFailed(call, entry, error));
        } else {
          if (entry.stream) for (const previous of entry.stream.getTracks()) previous.stop();
          const stream = entry.stream = new MediaStream([track]);
          entry.video.srcObject = stream;
          call.context.participants.setRemoteScreenStream(entry.publisherSessionId, entry.source.shareId, stream, { notify: false });
          this.changed();
          void entry.video.play().catch(error => this.browserFailed(call, entry, error));
        }
      },
      onUnavailable: reason => {
        if (entry.stopping) return;
        entry.state = { state: 'unavailable', reason };
        this.changed();
        void this.stopPresentation(call, entry).catch(error => this.report(error));
      },
      onCaptureMode: mode => {
        if (entry.stopping || call.stopping || !call.context.isCurrent()
          || call.presentations.get(keyOf(entry.publisherSessionId, entry.source.shareId)) !== entry) return;
        entry.captureMode = mode;
        this.changed();
      },
      onError: error => this.report(error),
    });
  }

  private audioPreferences(call: Call, entry: Presentation) {
    return {
      sinkId: entry.sinkId, muted: voiceStore.getEffectiveDeafened() || voiceStore.isScreenAudioMuted(entry.publisherSessionId),
      volume: settingsStore.getScreenAudioVolume(entry.publisherSessionId,
        call.context.participants.get(entry.publisherSessionId)?.user.clientId) / 100,
    };
  }

  private async applyAudio(call: Call, entry: Presentation): Promise<void> {
    const { muted, volume } = this.audioPreferences(call, entry);
    if (!entry.requested || entry.state.state === 'unavailable') return;
    if (entry.browser) {
      if (entry.audioTrack) {
        this.mediaRouter.setScreenAudioMuted(entry.publisherSessionId, muted);
        this.mediaRouter.setScreenAudioVolume(entry.publisherSessionId, volume * 100);
      }
      await entry.browser.setMuted(muted);
      return;
    }
    await this.ok(call, { action: 'watch-audio', callId: call.config.callId, publisherSessionId: entry.publisherSessionId,
      shareId: entry.source.shareId, presentationId: entry.presentationId, muted, volume });
  }

  public async updateAudio(): Promise<void> {
    const call = this.call;
    if (!call || call.stopping || !call.context.isCurrent()) return;
    await Promise.all([...call.presentations.values()].filter(entry => !entry.stopping).map(entry => this.applyAudio(call, entry)));
  }

  public async setOutputDeviceId(sinkId: string): Promise<void> {
    if (this.sinkId === sinkId) return;
    this.sinkId = sinkId;
    await this.sync();
  }

  public getWatchState(sessionId: string, shareId: string): NativeScreenWatchState | null {
    const entry = this.call?.presentations.get(keyOf(sessionId, shareId));
    return entry ? { ...entry.state, receiver: entry.receiver } : null;
  }

  public getCaptureMode(sessionId: string, shareId: string): NativeScreenCaptureMode | null {
    const call = this.call;
    if (!call || call.stopping || !call.context.isCurrent()) return null;
    if (sessionId === call.config.sessionId) {
      const source = call.sources.get(shareId);
      return source && !source.removing && source.previewState === 'playing' ? source.captureMode ?? null : null;
    }
    const entry = call.presentations.get(keyOf(sessionId, shareId));
    return entry && !entry.stopping && entry.state.state !== 'unavailable' ? entry.captureMode ?? null : null;
  }

  public async diagnostics(sessionId: string, shareId: string): Promise<ScreenVideoDiagnostics | null> {
    const call = this.call;
    if (!call || call.stopping || !call.context.isCurrent()) return null;
    const local = sessionId === call.config.sessionId ? call.sources.get(shareId) : undefined;
    const remote = sessionId !== call.config.sessionId ? call.presentations.get(keyOf(sessionId, shareId)) : undefined;
    const source = local?.descriptor ?? remote?.source;
    if (!source || local?.removing || remote?.stopping) return null;
    const current = () => this.call === call && !call.stopping && call.context.isCurrent()
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

  public async retry(sessionId: string, shareId: string): Promise<void> {
    const entry = this.call?.presentations.get(keyOf(sessionId, shareId));
    if (entry) entry.restart = true;
    await this.sync();
  }

  private releasePresentation(call: Call, entry: Presentation): Promise<void> {
    if (entry.retirement) return entry.retirement;
    entry.retirement = (async () => {
      if (entry.attachment) await Promise.allSettled([entry.attachment]);
      if (entry.stream) {
        if (call.context.participants.get(entry.publisherSessionId)?.remoteScreenStreams.get(entry.source.shareId) === entry.stream)
          call.context.participants.removeRemoteScreenStream(entry.publisherSessionId, entry.source.shareId, { notify: false });
        this.changed();
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
    const notify = this.networkCurrent(call);
    if (!notify) clientLog.warn('SCREEN_SHARE', 'Browser screen is retiring without remote confirmation', { remoteAcknowledged: false });
    try { await browser.close(notify); }
    catch (error) {
      if (!call.stopping) throw error;
      this.report(error);
      await browser.close(false);
    }
  }

  private stopPresentation(call: Call, entry: Presentation): Promise<void> {
    if (entry.stoppingTask) return entry.stoppingTask;
    entry.stopping = true;
    entry.stoppingTask = (async () => {
      const results = await Promise.allSettled([
        this.releasePresentation(call, entry),
        entry.browser ? this.retireBrowser(call, entry.browser) : call.stopping || !entry.requested ? Promise.resolve() : this.ok(call, { action: 'stop', callId: call.config.callId,
          publisherSessionId: entry.publisherSessionId, shareId: entry.source.shareId, presentationId: entry.presentationId }),
      ]);
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Native presentation retirement failed.');
    })();
    void entry.stoppingTask.catch(() => { entry.stoppingTask = undefined; });
    return entry.stoppingTask;
  }

  public prepareShutdown(): Promise<void> {
    this.shutdownRequested = true;
    return this.close();
  }

  public close(): Promise<void> {
    return this.call ? this.retireCall(this.call) : Promise.all([...this.retiring].map(call => this.retireCall(call))).then(() => {});
  }

  private retireCall(call: Call): Promise<void> {
    if (call.retirement) return call.retirement;
    call.stopping = true;
    if (this.call === call) this.call = null;
    this.retiring.add(call);
    call.retirement = (async () => {
      await Promise.allSettled([call.joining]);
      // Stop producing controls first, but finish admitted commands before Main
      // retires their call. Cleanup RPC replies use the independent event path.
      while (call.controls.size) await Promise.allSettled([...call.controls]);
      let result: NativeScreenCommandResult;
      if (this.networkCurrent(call)) {
        try { result = await call.api.nativeScreenCommand({ action: 'leave', callId: call.config.callId }); }
        catch (error) {
          this.report(error);
          result = await call.api.nativeScreenCommand({ action: 'leave-local', callId: call.config.callId });
        }
      } else result = await call.api.nativeScreenCommand({ action: 'leave-local', callId: call.config.callId });
      if (result.kind === 'retired-with-errors')
        this.warnRetirement(result);
      else if (result.kind !== 'ok') throw new Error('Native call retirement returned an invalid acknowledgement.');
      await Promise.allSettled([call.ready, ...call.watchTasks.values(), ...call.sourceTasks.values(),
        ...[...call.sources.values()].map(source => source.ready)]);
      await Promise.all([...call.presentations.values()].map(entry => this.releasePresentation(call, entry)));
      await Promise.all([...call.sources.values()].map(entry => this.releaseLocalPreview(call, entry)));
      for (const unbind of call.unbind.splice(0)) unbind();
      this.retiring.delete(call);
      this.changed();
    })();
    void call.retirement.catch(() => { call.retirement = undefined; });
    return call.retirement;
  }
}
