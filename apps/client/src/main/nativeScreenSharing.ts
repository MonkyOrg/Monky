import { app, sharedTexture, MessageChannelMain, BrowserWindow, screen, type WebFrameMain } from 'electron';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  MessageType, NATIVE_SCREEN_IPC, SCREEN_SHARE_LIMITS, nativeScreenCommandSchema,
  getScreenShareProfile, nativeScreenFailureReason, nativeScreenProducerSchema, nativeScreenSignalSchema,
  type NativeScreenCall, type NativeScreenCapabilities, type NativeScreenCommand, type NativeScreenCommandResult,
  type NativeScreenParticipant, type NativeScreenSignalPayload,
  type NativeScreenSource, type NativeScreenAudioPreferences, type NativeScreenCaptureKind, type NativeScreenVideoProfile,
  type NativeScreenCaptureMode, type ScreenEncodingAvailability,
} from '@monky/shared';
import type {
  NativeScreenPublisher, NativeScreenSubscription, NativePcmCaptureHub, NativeScreenPreviewBridge,
  NativeScreenRuntime, NativeScreenAudioOptions, NativeScreenCaptureTarget, NativeScreenCaptureCapability,
} from '@monky/screen-share';
import { validateCaptureTarget } from '@monky/screen-share/target';
import * as screenAudio from '@monky/screen-audio';
import type { ClientLogger } from './clientLogger';
import { mt } from './i18n';
import { isRecord } from './ipc/guards';
import type { IpcRegistry } from './ipc/registry';
import { audioScopes, sharesApplicationAudio, type AudioScope } from './nativeScreen/audioScopes';
import { capturedBrowserEngine, CapturedSourceMonitor } from './nativeScreen/capturedSourceMonitor';
import { callContext, NativeScreenDiagnostics } from './nativeScreen/diagnosticLog';
import { captureRoot, EncoderDiscovery, SelectedCaptureProbe } from './nativeScreen/encoderDiscovery';
import { diagnosticId, diagnosticProfile, errorDetails, NativeScreenNotice, rendererFailure } from './nativeScreen/errorDiagnostics';
import { documentIdentity, RendererBridge } from './nativeScreen/rendererBridge';
import { screenShareModule } from './nativeScreen/screenShareModule';
import { isScreenEncoderFailure } from './screenEncodingCache';

type SourceRecord = {
  desktopSourceId: string;
  source: NativeScreenSource; publisher: NativeScreenPublisher; captureHub: NativePcmCaptureHub | null;
  audioScope: AudioScope | null;
  monitor: CapturedSourceMonitor;
  preview: NativeScreenPreviewBridge | null;
  previewMode: NativeScreenCaptureMode | null;
};
type SubscriptionRecord = { source: NativeScreenSource; publisherSessionId: string; subscription: NativeScreenSubscription };
type WatchIntent = { presentationId: string; audio: NativeScreenAudioPreferences };
type SourceSelection = {
  audioScope: AudioScope | null; abort: AbortController; probe: SelectedCaptureProbe | null;
  done: Promise<void>; finish: () => void;
};
type CallRecord = {
  config: NativeScreenCall; frame: WebFrameMain; documentUrl: string; stopping: boolean; retirement: Promise<void> | null;
  documentRetired: boolean; remoteUnavailable: boolean;
  pausePreviewWhenUnfocused: boolean;
  sources: Map<string, SourceRecord>; subscriptions: Map<string, SubscriptionRecord>;
  participants: Map<string, NativeScreenParticipant>;
  watchVersions: Map<string, WatchIntent>;
  sourceSelections: Map<string, SourceSelection>;
};
type ResolveSource = (sourceId: string, kind: NativeScreenCaptureKind) => NativeScreenCaptureTarget | Promise<NativeScreenCaptureTarget>;
export interface NativeScreenSharingIpc { freezeAdmissions(): void; prepareShutdown(): Promise<void>; dispose(): Promise<void> }

const key = (publisher: string, share: string): string => `${publisher}\0${share}`;
const cancelled = (): DOMException => new DOMException('Native screen call is no longer current.', 'AbortError');

/**
 * The native media of the main window's calls: admission and retirement of shared sources, watching other
 * people's shares, and the proof that every native owner retired before a call, a document or Main goes away.
 */
class NativeScreenSharingService {
  private readonly calls = new Map<string, CallRecord>();
  private runtime: NativeScreenRuntime | null = null;
  private availability: Promise<NativeScreenCapabilities> | null = null;
  private disposal: Promise<void> | null = null;
  private shutdownRequested = false;
  private admissionsFrozen = false;
  private shutdownPreparation: Promise<void> | null = null;
  private readonly shutdownCalls = new Set<string>();
  private readonly discovery: EncoderDiscovery;
  // Counts Windows display changes. A monitor identity read can wait behind another program's registry
  // writes while holding the system display lock, freezing every screen, so it never runs on a timer.
  private displayGeneration = 0;
  private readonly onDisplayChanged = (): void => { this.displayGeneration++; };

  constructor(
    private readonly window: BrowserWindow,
    private readonly resolveSource: ResolveSource,
    private readonly diagnostics: NativeScreenDiagnostics,
    private readonly bridge: RendererBridge,
  ) {
    this.discovery = new EncoderDiscovery({
      capabilities: () => this.capabilities(),
      runtime: () => this.nativeRuntime(),
      displayGeneration: () => this.displayGeneration,
    }, diagnostics);
    screen.on('display-added', this.onDisplayChanged);
    screen.on('display-removed', this.onDisplayChanged);
    screen.on('display-metrics-changed', this.onDisplayChanged);
  }

  private error(call: CallRecord, error: unknown, publisherSessionId: string, shareId?: string,
    presentationId?: string, sourceInstanceId?: string): void {
    if (call.stopping && error instanceof Error && error.name === 'AbortError') return;
    console.error('[NativeScreen]', error);
    this.diagnostics.logFailure('media', error, undefined, { ...callContext(call, shareId),
      publisher: diagnosticId(publisherSessionId),
      ...(presentationId ? { presentation: diagnosticId(presentationId) } : {}) });
    const details = errorDetails(error);
    this.bridge.emit(call, { type: 'error', callId: call.config.callId, publisherSessionId,
      ...(shareId ? { shareId } : {}), ...(presentationId ? { presentationId } : {}),
      ...(sourceInstanceId ? { sourceInstanceId } : {}),
      reason: details.code ? 'capture-failed' : nativeScreenFailureReason(error), ...details });
  }

  private capabilities(): Promise<NativeScreenCapabilities> {
    if (!this.availability) this.availability = (async (): Promise<NativeScreenCapabilities> => {
      if (!(process.platform === 'win32' && process.arch === 'x64')
        && !(process.platform === 'darwin' && ['arm64', 'x64'].includes(process.arch))) {
        this.diagnostics.log('runtime-unavailable', { reason: 'platform' }, 'WARN');
        return { capture: false, captureAudio: false, receive: false, backend: null, reason: 'platform' };
      }
      try {
        // Asynchronous, so the first picker or watch does not stall every IPC while the runtime is hashed.
        this.runtime = await screenShareModule().loadRuntimeAsync();
        this.diagnostics.log('runtime-ready', { requiresSelectionProbe: true, captureAudio: screenAudio.isPacketCaptureSupported() });
        return { capture: false, captureAudio: screenAudio.isPacketCaptureSupported(), receive: true,
          requiresSelectionProbe: true, captureKinds: [...this.runtime.capture.captureKinds], backend: null, reason: null };
      } catch (error) {
        console.error('[NativeScreen] Production media runtime is unavailable:', error);
        this.diagnostics.logFailure('runtime-load', error);
        return { capture: false, captureAudio: false, receive: false, backend: null, reason: 'runtime' };
      }
    })();
    return this.availability;
  }

  private nativeRuntime(): NativeScreenRuntime {
    if (!this.runtime) throw new Error('Native screen runtime has not passed availability validation.');
    return this.runtime;
  }

  private audioOptions(call: CallRecord, preferences: NativeScreenAudioPreferences): NativeScreenAudioOptions {
    return {
      ...preferences,
      output: { webContents: this.window.webContents, frame: call.frame, expectedUrl: call.documentUrl,
        createMessageChannel: () => new MessageChannelMain() },
    };
  }

  private callFor(id: string): CallRecord {
    const call = this.calls.get(id);
    if (!call || !this.bridge.hasFrame(call)) throw cancelled();
    return call;
  }

  private current(call: CallRecord): void {
    if (this.shutdownRequested || this.disposal || call.stopping || this.calls.get(call.config.callId) !== call || !this.bridge.hasFrame(call)) throw cancelled();
  }

  async invoke(value: unknown): Promise<NativeScreenCommandResult> {
    const command = nativeScreenCommandSchema.parse(value);
    if (this.admissionsFrozen && ['source-add', 'watch', 'preview-start', 'probe-encoding'].includes(command.action)) throw cancelled();
    if (command.action === 'capabilities') return { kind: 'capabilities', capabilities: await this.capabilities() };
    if (command.action === 'cancel-encoding-probe') {
      this.discovery.cancelVerification(command.probeId, cancelled());
      return { kind: 'ok' };
    }
    if (command.action === 'probe-encoding') {
      if (this.shutdownRequested || this.disposal) throw cancelled();
      return { kind: 'encoding', availability: await this.discovery.verify(command.probeId, { video: command.video,
        mode: command.encodingMode, codec: command.codec, strategy: command.encodingStrategy ?? 'automatic', inspectHardware: true }) };
    }
    if (command.action === 'join') {
      if (this.admissionsFrozen || this.shutdownRequested || this.disposal) throw cancelled();
      const { action: _action, ...config } = command;
      const previous = this.calls.get(config.callId);
      if (previous) {
        this.current(previous);
        if (!isDeepStrictEqual(previous.config, config)) throw new Error('Native call identity cannot change in place.');
        return { kind: 'ok' };
      }
      if (this.calls.size >= 2) throw new Error('A previous native call still owns media resources.');
      const frame = this.window.webContents.mainFrame;
      this.calls.set(config.callId, {
        config, frame, documentUrl: documentIdentity(frame.url), stopping: false, retirement: null,
        documentRetired: false, remoteUnavailable: false,
        pausePreviewWhenUnfocused: true,
        sources: new Map(), subscriptions: new Map(), participants: new Map(), watchVersions: new Map(), sourceSelections: new Map(),
      });
      this.diagnostics.log('call-joined', { call: diagnosticId(config.callId), mode: config.mode });
      return { kind: 'ok' };
    }
    // Closing is idempotent even if the renderer lost the join acknowledgement.
    if ((command.action === 'leave' || command.action === 'leave-local') && !this.calls.has(command.callId)) {
      if (this.shutdownRequested && !this.shutdownCalls.has(command.callId)) throw cancelled();
      return { kind: 'ok' };
    }
    const call = this.callFor(command.callId);
    if (command.action === 'leave' || command.action === 'leave-local') {
      if (command.action === 'leave-local') {
        call.remoteUnavailable = true;
        this.bridge.rejectUnavailable();
      }
      try { await this.closeCall(call); }
      catch (error) {
        if (this.calls.has(call.config.callId)) throw error;
        return this.retiredWithErrors(call, error);
      }
      return { kind: 'ok' };
    }
    this.current(call);
    switch (command.action) {
      case 'participants':
        await this.updateParticipants(call, command.participants);
        break;
      case 'source-add':
        return this.addSource(call, command);
      case 'source-remove':
        try { await this.removeSource(call, command.shareId); }
        catch (error) {
          if (call.sources.has(command.shareId) || call.sourceSelections.has(command.shareId)) throw error;
          return this.retiredWithErrors(call, error, command.shareId);
        }
        break;
      case 'preview-preferences':
        call.pausePreviewWhenUnfocused = command.pauseWhenUnfocused;
        this.diagnostics.log('preview-preferences', { ...callContext(call), pauseWhenUnfocused: command.pauseWhenUnfocused });
        await this.refreshCallPreviews(call);
        this.current(call);
        break;
      case 'preview-start': {
        const entry = call.sources.get(command.shareId);
        if (!entry || entry.publisher.snapshot().stopping || entry.source.instanceId !== command.sourceInstanceId) throw cancelled();
        if (entry.preview) throw new Error('This source already owns a local preview.');
        const info = { callId: call.config.callId, shareId: command.shareId,
          sourceInstanceId: command.sourceInstanceId, presentationId: command.presentationId };
        entry.previewMode = null;
        let previousState: string | undefined;
        entry.preview = new (screenShareModule().NativeScreenPreviewBridge)({
          frame: call.frame, info, createMessageChannel: () => new MessageChannelMain(),
          onState: state => {
            if (state !== previousState) {
              previousState = state;
              this.diagnostics.log('preview-state', { ...callContext(call, entry.source.shareId), state });
            }
            this.bridge.emit(call, { type: 'preview-state', callId: call.config.callId,
              publisherSessionId: call.config.sessionId, shareId: entry.source.shareId,
              sourceInstanceId: entry.source.instanceId, state });
          },
          onError: error => {
            console.warn('[NativeScreen] Local preview failed without changing the broadcast:', error);
            this.diagnostics.logFailure('preview', error, undefined, callContext(call, entry.source.shareId));
            if (!entry.publisher.snapshot().stopping)
              void entry.publisher.setPreviewEnabled(false).catch(cleanupError => {
                console.error('[NativeScreen] Failed local preview retained capture ownership:', cleanupError);
                this.diagnostics.logFailure('preview-retirement', cleanupError, undefined, callContext(call, entry.source.shareId));
              });
          },
        });
        this.diagnostics.log('preview-start', { ...callContext(call, entry.source.shareId), state: 'waiting' });
        await this.refreshSourcePreview(call, entry);
        break;
      }
      case 'watch':
        try { return await this.watch(call, command); }
        catch (error) {
          const subscriptionKey = key(command.publisherSessionId, command.shareId);
          if (call.watchVersions.get(subscriptionKey)?.presentationId === command.presentationId
            && call.subscriptions.get(subscriptionKey)?.subscription.presentationId !== command.presentationId)
            call.watchVersions.delete(subscriptionKey);
          throw error;
        }
      case 'watch-audio': {
        const subscriptionKey = key(command.publisherSessionId, command.shareId);
        const intent = call.watchVersions.get(subscriptionKey);
        if (!intent || intent.presentationId !== command.presentationId) throw cancelled();
        this.diagnostics.log('watch-audio', { ...callContext(call, command.shareId), muted: command.muted, volume: command.volume });
        const preferences = { muted: command.muted, volume: command.volume,
          ...(command.sinkId !== undefined ? { sinkId: command.sinkId } : {}) };
        const entry = call.subscriptions.get(subscriptionKey);
        if (entry?.subscription.presentationId === command.presentationId)
          await entry.subscription.setAudioPreferences(preferences);
        if (call.watchVersions.get(subscriptionKey) !== intent) throw cancelled();
        intent.audio = { ...intent.audio, ...preferences };
        break;
      }
      case 'stop': {
        this.diagnostics.log('unwatch-requested', { ...callContext(call, command.shareId),
          presentation: diagnosticId(command.presentationId) });
        const subscriptionKey = key(command.publisherSessionId, command.shareId);
        if (call.watchVersions.get(subscriptionKey)?.presentationId === command.presentationId) call.watchVersions.delete(subscriptionKey);
        const entry = call.subscriptions.get(subscriptionKey);
        if (entry?.subscription.presentationId === command.presentationId) {
          try { await this.closeSubscription(call, entry); }
          catch (error) {
            if (!entry.subscription.snapshot().closed || call.subscriptions.get(subscriptionKey) === entry) throw error;
            return this.retiredWithErrors(call, error, command.shareId);
          }
        }
        break;
      }
      case 'signal':
        await this.receiveSignal(call, command.signal);
        break;
      case 'producer':
        if (command.producer.channelId !== call.config.channelId) throw new Error('Native SFU producer belongs to another call.');
        await Promise.all([...call.subscriptions.values()].map(entry => entry.subscription.addRemoteProducer(command.producer)));
        break;
      case 'producer-remove':
        await Promise.all([...call.subscriptions.values()].map(entry => entry.subscription.removeRemoteProducer(command.producerId)));
        break;
      case 'stats':
        return { kind: 'stats', publishers: [...call.sources.values()].map(entry => entry.publisher.snapshot()),
          subscriptions: [...call.subscriptions.values()].map(entry => entry.subscription.snapshot()) };
      case 'diagnostics': {
        const publisher = command.publisherSessionId === call.config.sessionId ? call.sources.get(command.shareId) : undefined;
        const receiver = command.publisherSessionId !== call.config.sessionId
          ? call.subscriptions.get(key(command.publisherSessionId, command.shareId)) : undefined;
        const owner = publisher?.publisher ?? receiver?.subscription;
        if (!owner || (publisher?.source.instanceId ?? receiver?.source.instanceId) !== command.sourceInstanceId
          || command.presentationId !== receiver?.subscription.presentationId) throw cancelled();
        const assertCurrentOwner = (): void => {
          this.current(call);
          if (owner.snapshot().stopping
            || (publisher ? call.sources.get(command.shareId) !== publisher
              : call.subscriptions.get(key(command.publisherSessionId, command.shareId)) !== receiver)) throw cancelled();
        };
        assertCurrentOwner();
        const endpoints = await owner.diagnostics();
        assertCurrentOwner();
        return { kind: 'diagnostics', sourceInstanceId: command.sourceInstanceId,
          presentationId: receiver?.subscription.presentationId ?? null, viewers: publisher?.publisher.snapshot().viewers ?? null, endpoints };
      }
    }
    return { kind: 'ok' };
  }

  private previewAllowed(call: CallRecord, entry: SourceRecord): boolean {
    if (call.stopping || !entry.preview || entry.preview.closed) return false;
    const focused = BrowserWindow.getFocusedWindow();
    return !call.pausePreviewWhenUnfocused || (!!focused && !focused.isDestroyed());
  }

  private async refreshSourcePreview(call: CallRecord, entry: SourceRecord): Promise<void> {
    if (entry.publisher.snapshot().stopping) return;
    const enabled = this.previewAllowed(call, entry);
    if (!enabled) entry.preview?.reset('paused');
    await entry.publisher.setPreviewEnabled(enabled);
  }

  private async refreshCallPreviews(call: CallRecord): Promise<void> {
    const results = await Promise.allSettled([...call.sources.values()]
      .map(entry => this.refreshSourcePreview(call, entry)));
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Local screen preview demand could not be updated.');
  }

  async refreshPreviewVisibility(): Promise<void> {
    const results = await Promise.allSettled([...this.calls.values()]
      .filter(call => !call.stopping && this.bridge.hasFrame(call)).map(call => this.refreshCallPreviews(call)));
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Local screen preview focus transition failed.');
  }

  private async addSource(call: CallRecord, command: Extract<NativeScreenCommand, { action: 'source-add' }>): Promise<NativeScreenCommandResult> {
    const diagnostic = { ...callContext(call, command.shareId), captureKind: command.captureKind ?? 'window',
      video: diagnosticProfile(command.video), audio: command.audio, preserveAspectRatio: command.preserveAspectRatio ?? true };
    this.diagnostics.log('source-admission', diagnostic);
    const previous = call.sources.get(command.shareId);
    const replacement = command.replacesSourceInstanceId === undefined ? undefined : previous;
    if (command.replacesSourceInstanceId !== undefined && (!replacement
      || replacement.source.instanceId !== command.replacesSourceInstanceId
      || replacement.desktopSourceId !== command.desktopSourceId
      // A replacement may give up its audio (#253), never acquire it.
      || (command.audio && !replacement.source.audio)
      || command.replacesAudioShareIds !== undefined))
      throw new Error('Quality replacement must name the exact existing source instance and selected capture.');
    if ((previous && !replacement) || call.sourceSelections.has(command.shareId)
      || call.sources.size + call.sourceSelections.size > SCREEN_SHARE_LIMITS.maximum)
      throw new Error('Native screen source already exists or exceeds the screen-share plus pending-replacement limit.');
    const audioOwners = (command.replacesAudioShareIds ?? []).map(shareId => call.sources.get(shareId));
    if (command.replacesAudioShareIds !== undefined && (!command.audio || audioOwners.some(owner => !owner?.source.audio)))
      throw new Error('Audio replacement must name existing audible sources in this call.');
    const superseded = new Set([replacement, ...audioOwners].filter((entry): entry is SourceRecord => entry !== undefined));
    const supersededAudio = audioOwners.flatMap(owner => owner ? [[owner.source.shareId, owner.source.instanceId] as const] : []);
    const audioScope: AudioScope | null = command.audio
      ? { system: process.platform === 'darwin' || (command.captureKind ?? 'window') === 'monitor', processId: null } : null;
    // Applications may each share their own audio; the whole system mix already contains all of them.
    if (audioScope && audioScopes(this.calls.values(), superseded).some(scope => scope.system || audioScope.system))
      throw new Error('Whole-system screen audio cannot be combined with another shared audio.');
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const selection: SourceSelection = { audioScope, abort: new AbortController(), probe: null, done, finish };
    call.sourceSelections.set(command.shareId, selection);
    const assertCurrent = (): void => {
      this.current(call);
      selection.abort.signal.throwIfAborted();
      if (call.sourceSelections.get(command.shareId) !== selection) throw cancelled();
    };
    let stage = 'capabilities';
    try {
      const capabilities = await this.capabilities();
      assertCurrent();
      if (!capabilities.capture && !capabilities.requiresSelectionProbe)
        throw new Error(`Native screen capture is unavailable: ${capabilities.reason}.`);
      if (command.audio && !capabilities.captureAudio) throw new Error('Timestamped screen-sharing audio capture is unavailable.');
      const kind = command.captureKind ?? 'window';
      stage = 'source-validation';
      if (kind === 'monitor' ? !command.desktopSourceId.startsWith('native-monitor:')
        : !command.desktopSourceId.startsWith('window:'))
        throw new Error('Native source identity does not match its requested capture kind.');
      if (!(capabilities.captureKinds ?? (capabilities.capture ? ['window'] : [])).includes(kind))
        throw new Error('The selected native capture kind is not implemented by this verified runtime.');
      const target = await this.resolveSource(command.desktopSourceId, kind);
      assertCurrent();
      validateCaptureTarget(target);
      if (target.kind !== kind) throw new Error('Native source resolution changed the requested capture kind.');
      if (command.audio && target.kind !== 'monitor' && target.expectedProcessId === process.pid)
        throw new NativeScreenNotice(mt('screenShare.ownWindowAudioUnavailable'), 'ERR_AUDIO_TARGET');
      if (audioScope && !audioScope.system && target.kind !== 'monitor') {
        const shared = audioScopes(this.calls.values(), superseded)
          .flatMap(scope => !scope.system && scope.processId !== null ? [scope.processId] : []);
        if (sharesApplicationAudio(target.expectedProcessId, shared))
          throw new NativeScreenNotice(mt('screenShare.appAudioAlreadyShared'), 'ERR_AUDIO_TARGET');
        audioScope.processId = target.expectedProcessId;
      }
      const occlusionEngine = process.platform === 'win32' && target.platform !== 'darwin' && target.kind !== 'monitor'
        ? capturedBrowserEngine(target) : null;
      const monitor = new CapturedSourceMonitor(target, () => this.displayGeneration,
        paused => this.diagnostics.log('source-visibility', { ...diagnostic, paused }));
      monitor.assertCurrent();
      const captureDirectory = await captureRoot();
      assertCurrent();
      monitor.assertCurrent();
      stage = 'preflight';
      this.diagnostics.log('preflight-start', diagnostic);
      const discover = (): Promise<ScreenEncodingAvailability> => this.discovery.encoding({ video: command.video,
        mode: command.encodingMode ?? 'hardware', codec: command.codec ?? 'auto',
        strategy: command.encodingStrategy ?? 'automatic', inspectHardware: false }, selection.abort.signal);
      type Preflight = { video: NativeScreenVideoProfile; proof: NativeScreenCaptureCapability };
      // The selected source proves the chosen encoder with the real target, even when discovery was remembered.
      const prepare = async (encoding: ScreenEncodingAvailability): Promise<Preflight> => {
        assertCurrent();
        if (!encoding.selection) throw new Error(encoding.reason ?? 'No compatible screen encoder is available for this codec and profile.');
        const video = getScreenShareProfile(command.video, 'source', encoding.selection.codec);
        diagnostic.video = diagnosticProfile(video);
        selection.probe = new SelectedCaptureProbe(this.nativeRuntime(), captureDirectory,
          error => this.diagnostics.logFailure('preflight', error, undefined, { ...diagnostic, stage: 'preflight' }));
        try {
          return { video, proof: await selection.probe.prepare(target, video, selection.abort.signal, encoding.selection,
            command.preserveAspectRatio) };
        } catch (error) {
          // An encoder that fails with the real source makes every remembered discovery suspect.
          if (isScreenEncoderFailure(error)) this.discovery.cache.clear();
          throw error;
        }
      };
      let encoding = await discover();
      let preflight: Preflight;
      try { preflight = await prepare(encoding); }
      catch (error) {
        // A remembered choice that stopped working (a driver update, another adapter) is discovered again, once.
        if (!isScreenEncoderFailure(error) || !this.discovery.cache.isRemembered(encoding) || selection.probe?.retired !== true)
          throw error;
        this.diagnostics.logFailure('preflight', error, undefined, { ...diagnostic, stage: 'remembered-encoder' }, 'WARN');
        encoding = await discover();
        preflight = await prepare(encoding);
      }
      const { video, proof } = preflight;
      assertCurrent();
      monitor.assertCurrent();
      const backend = target.platform === 'darwin'
        ? proof.codec === 'av1' ? 'libaom-software'
          : proof.mode === 'hardware' ? 'videotoolbox-hardware' : 'videotoolbox-software'
        : proof.mode === 'software' ? 'libobs-software' : proof.encoderId.includes('nvenc') ? 'libobs-nvenc' : 'libobs-amf';
      this.availability = Promise.resolve({ ...capabilities, capture: true, backend });
      this.diagnostics.log('preflight-ready', { ...diagnostic, encoder: proof.encoderId, backend });
      if (replacement) {
        stage = 'source-retirement';
        await this.retireSource(call, command.shareId, replacement);
        assertCurrent();
      }
      stage = 'publisher-creation';
      const source: NativeScreenSource = {
        shareId: command.shareId, instanceId: randomUUID(), video, audio: command.audio, codec: proof.codec,
      };
      const onError = (error: Error, context?: unknown): void => {
        // An encoder that fails while capturing makes every remembered discovery suspect.
        if (isScreenEncoderFailure(error)) this.discovery.cache.clear();
        if (isRecord(context) && typeof context.remoteSessionId === 'string') {
          console.warn('[NativeScreen] Screen viewer failed:', { shareId: source.shareId, remoteSessionId: context.remoteSessionId }, error);
          this.diagnostics.logFailure('viewer', error, undefined, { ...callContext(call, source.shareId),
            viewer: diagnosticId(context.remoteSessionId),
            ...(typeof context.pipelineId === 'string' ? { pipeline: diagnosticId(context.pipelineId) } : {}) });
          return;
        }
        this.diagnostics.logFailure('publisher', error, undefined, { ...callContext(call, source.shareId),
          ...(isRecord(context) && typeof context.pipelineId === 'string' ? { pipeline: diagnosticId(context.pipelineId) } : {}) });
        this.error(call, error, call.config.sessionId, source.shareId, undefined, source.instanceId);
        if (!call.stopping && call.sources.get(source.shareId)?.source === source
          && nativeScreenFailureReason(error) === 'source-unavailable')
          void this.removeSource(call, source.shareId).catch(cleanupError => {
            this.error(call, cleanupError, call.config.sessionId, source.shareId, undefined, source.instanceId);
          });
      };
      const audioSelection = target.kind === 'monitor' ? { excludePid: process.pid }
        : { includeWindowId: target.platform === 'darwin' ? target.windowId : target.hwnd,
          expectedProcessId: target.expectedProcessId,
          ...(target.platform === 'darwin' ? { expectedProcessStartTimeUs: target.expectedProcessStartTimeUs } : {}) };
      const { NativePcmCaptureHub, NativeScreenPublisher, NativeScreenEndpoint } = screenShareModule();
      const captureHub = command.audio ? new NativePcmCaptureHub(screenAudio, audioSelection, onError) : null;
      let captureTarget = target;
      const publisher = new NativeScreenPublisher({
        ...call.config, source, send: signal => this.bridge.send(call, signal), onError,
        onState: ({ state }) => {
          if (state.type !== 'capture-fallback' || captureTarget.kind !== 'game') return;
          this.current(call);
          monitor.assertCurrent();
          captureTarget = { ...captureTarget, kind: 'window' };
          this.diagnostics.log('capture-fallback', { ...callContext(call, source.shareId), from: 'game', to: 'window' }, 'WARN');
          this.bridge.emit(call, { type: 'capture-fallback', callId: call.config.callId,
            publisherSessionId: call.config.sessionId, shareId: source.shareId, sourceInstanceId: source.instanceId });
        },
        onPreview: packet => {
          const enabled = !monitor.paused && this.previewAllowed(call, entry);
          if (packet && enabled && entry.preview) {
            if (packet.captureMode && packet.captureMode !== entry.previewMode) {
              entry.previewMode = packet.captureMode;
              this.bridge.emit(call, { type: 'capture-mode', callId: call.config.callId,
                publisherSessionId: call.config.sessionId, shareId: source.shareId, sourceInstanceId: source.instanceId,
                presentationId: entry.preview.info.presentationId, mode: packet.captureMode });
            }
            entry.preview.offer(packet.frame, packet.pipelineId, packet.video);
          }
          else if (!packet) entry.preview?.reset(enabled ? 'waiting' : 'paused');
        },
        createEndpoint: options => {
          this.current(call);
          if (supersededAudio.some(([shareId, instanceId]) => call.sources.get(shareId)?.source.instanceId === instanceId))
            throw new Error('Previous screen audio owners must give up their audio before replacement capture starts.');
          monitor.assertCurrent();
          const diagnostic = { ...callContext(call, source.shareId, options.pipelineId), role: 'publish',
            quality: options.quality, video: diagnosticProfile(getScreenShareProfile(source.video, options.quality, source.codec)),
            captureKind: captureTarget.kind, encoder: proof.encoderId };
          this.diagnostics.log('pipeline-create', diagnostic);
          const observe = this.diagnostics.endpointObserver(call, source.shareId, options.pipelineId, 'publish', options.quality);
          return new NativeScreenEndpoint({
            ...options, runtime: this.nativeRuntime(), textures: sharedTexture, role: 'publish', ...call.config,
            source: { ...options.source, codec: source.codec ?? 'h264' },
            onState: state => { observe(state); options.onState(state); },
            publisherSessionId: call.config.sessionId, target: captureTarget, captureDirectory, captureEncoder: proof.encoderId,
            preserveAspectRatio: command.preserveAspectRatio ?? true,
            isSourcePaused: () => monitor.paused,
            assertSourceCurrent: () => {
              this.current(call);
              if (call.sources.get(source.shareId)?.source !== source) throw cancelled();
              monitor.assertCurrent();
            },
            ...(captureHub ? { audio: {
              ...this.audioOptions(call, { sinkId: '', muted: true, volume: 0 }),
              captureModule: screenAudio, captureHub, maxBitrateBps: command.audioBitrateKbps * 1000,
            } } : {}),
            rpc: (type, payload) => this.bridge.rpc(call, type, payload),
            onDiagnostic: error => {
              console.warn('[NativeScreen] Capture diagnostic:', error);
              this.diagnostics.logFailure('capture-diagnostic', error, undefined, diagnostic);
            },
          });
        },
      });
      const entry: SourceRecord = { desktopSourceId: command.desktopSourceId, source, publisher, captureHub, audioScope,
        monitor, preview: null, previewMode: null };
      call.sources.set(source.shareId, entry);
      // An announcement owns its exact target even without a capture pipeline.
      monitor.start({
        isCurrent: () => !call.stopping && call.sources.get(source.shareId) === entry,
        resolve: () => this.resolveSource(command.desktopSourceId, kind),
        pausedChanged: paused => entry.preview?.reset(paused || !this.previewAllowed(call, entry) ? 'paused' : 'waiting'),
        hiddenChanged: hidden => this.bridge.emit(call, { type: 'source-visibility', callId: call.config.callId,
          publisherSessionId: call.config.sessionId, shareId: source.shareId, sourceInstanceId: source.instanceId, hidden }),
        checked: () => publisher.refreshSourceState(),
        lost: error => {
          this.diagnostics.logFailure('source-monitor', error, undefined, callContext(call, source.shareId));
          if (target.kind === 'monitor' || nativeScreenFailureReason(error) !== 'source-unavailable')
            this.error(call, error, call.config.sessionId, source.shareId, undefined, source.instanceId);
          void this.removeSource(call, source.shareId).catch(cleanupError =>
            this.error(call, cleanupError, call.config.sessionId, source.shareId, undefined, source.instanceId));
        },
        failed: error => this.error(call, error, call.config.sessionId, source.shareId),
      }, occlusionEngine ? {
        engine: occlusionEngine, diagnostics: this.diagnostics, context: callContext(call, source.shareId),
        changed: occluded => this.bridge.emit(call, { type: 'source-occlusion', callId: call.config.callId,
          publisherSessionId: call.config.sessionId, shareId: source.shareId, sourceInstanceId: source.instanceId,
          occluded, engine: occlusionEngine }),
      } : null);
      this.diagnostics.log('source-admitted', { ...diagnostic, instance: diagnosticId(source.instanceId),
        ...(occlusionEngine ? { occlusionEngine } : {}) });
      return { kind: 'source', source, encoding };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') this.diagnostics.log('source-admission-cancelled', { ...diagnostic, stage });
      else this.diagnostics.logFailure('source-admission', error, undefined, { ...diagnostic, stage });
      throw error;
    } finally {
      selection.finish();
      if ((!selection.probe || selection.probe.retired) && call.sourceSelections.get(command.shareId) === selection)
        call.sourceSelections.delete(command.shareId);
    }
  }

  private async removeSource(call: CallRecord, shareId: string): Promise<void> {
    const entry = call.sources.get(shareId);
    const selection = call.sourceSelections.get(shareId);
    if (selection) {
      this.diagnostics.log('preflight-retirement', callContext(call, shareId));
      selection.abort.abort(cancelled());
      await selection.done;
      await selection.probe?.close();
      if (call.sourceSelections.get(shareId) === selection) call.sourceSelections.delete(shareId);
    }
    if (!entry) return;
    await this.retireSource(call, shareId, entry);
  }

  private async retireSource(call: CallRecord, shareId: string, entry: SourceRecord): Promise<void> {
    this.diagnostics.log('source-retirement', callContext(call, shareId));
    entry.monitor.stop();
    const errors: unknown[] = [];
    const preview = entry.preview;
    if (preview) this.diagnostics.log('preview-retirement', callContext(call, shareId));
    preview?.close();
    const retired = await Promise.allSettled([
      entry.publisher.close(),
      preview && this.bridge.hasFrame(call)
        ? this.bridge.request(call, { type: 'presentation-stop', presentationId: preview.info.presentationId }) : Promise.resolve(),
    ]);
    for (const result of retired) if (result.status === 'rejected') errors.push(result.reason);
    if (retired[1].status === 'fulfilled') entry.preview = null;
    if (entry.publisher.snapshot().closed) {
      try { await entry.captureHub?.close(); }
      catch (error) { errors.push(error); }
      if (!entry.preview && (!entry.captureHub || entry.captureHub.getStats().closed) && call.sources.get(shareId) === entry) {
        call.sources.delete(shareId);
        this.bridge.emit(call, { type: 'state', callId: call.config.callId, publisherSessionId: call.config.sessionId,
          shareId, sourceInstanceId: entry.source.instanceId, state: 'closed' });
      }
    }
    this.diagnostics.log('source-retirement-result', { ...callContext(call, shareId),
      retained: call.sources.get(shareId) === entry, failures: errors.length });
    if (errors.length) throw new AggregateError(errors, 'Native screen source retirement reported failures.');
  }

  private async watch(call: CallRecord, command: Extract<NativeScreenCommand, { action: 'watch' }>): Promise<NativeScreenCommandResult> {
    this.diagnostics.log('watch-requested', { ...callContext(call, command.shareId), quality: command.quality,
      presentation: diagnosticId(command.presentationId) });
    const subscriptionKey = key(command.publisherSessionId, command.shareId);
    if (call.watchVersions.get(subscriptionKey)?.presentationId === command.presentationId)
      throw new Error('A new native Watch requires a new presentation identity.');
    if (!call.watchVersions.has(subscriptionKey) && call.watchVersions.size >= 32)
      throw new Error('Native screen pending receiver capacity was reached.');
    const intent: WatchIntent = { presentationId: command.presentationId, audio: command.audio };
    call.watchVersions.set(subscriptionKey, intent);
    const assertCurrent = (): void => {
      this.current(call);
      if (call.watchVersions.get(subscriptionKey) !== intent) throw cancelled();
    };
    const capabilities = await this.capabilities();
    assertCurrent();
    if (!capabilities.receive) throw new Error(`Native screen receiving is unavailable: ${capabilities.reason}.`);
    const source = call.participants.get(command.publisherSessionId)?.nativeScreenShares.find(value => value.shareId === command.shareId);
    if (!source || command.publisherSessionId === call.config.sessionId) throw new Error('Native screen source is not in this call roster.');
    const previous = call.subscriptions.get(subscriptionKey);
    if (previous) await this.closeSubscription(call, previous);
    assertCurrent();
    if (!isDeepStrictEqual(source, call.participants.get(command.publisherSessionId)?.nativeScreenShares
      .find(value => value.shareId === source.shareId))) throw cancelled();
    if (call.subscriptions.size >= 32) throw new Error('Native screen receiver capacity was reached.');
    let previousState: string | undefined;
    const { NativeScreenSubscription, NativeScreenEndpoint } = screenShareModule();
    const subscription = new NativeScreenSubscription({
      ...call.config, source, publisherSessionId: command.publisherSessionId, quality: command.quality,
      presentationId: command.presentationId, send: signal => this.bridge.send(call, signal),
      onError: error => this.error(call, error, command.publisherSessionId, source.shareId, command.presentationId, source.instanceId),
      onState: state => {
        const diagnostic = { ...callContext(call, source.shareId), state: state.type,
          quality: state.quality, presentation: diagnosticId(state.presentationId),
          ...(state.type === 'capture-mode' ? { captureMode: state.mode } : { reason: state.reason }) };
        const signature = JSON.stringify(diagnostic);
        if (previousState !== signature) {
          previousState = signature;
          this.diagnostics.log('subscription-state', diagnostic);
        }
        if (state.type === 'capture-mode') {
          this.bridge.emit(call, { type: 'capture-mode', callId: call.config.callId,
            publisherSessionId: command.publisherSessionId, shareId: source.shareId, sourceInstanceId: source.instanceId,
            presentationId: state.presentationId, mode: state.mode });
          return;
        }
        if (state.type === 'closed' && call.subscriptions.get(subscriptionKey)?.subscription === subscription)
          call.subscriptions.delete(subscriptionKey);
        if (state.type === 'closed' && call.watchVersions.get(subscriptionKey) === intent) call.watchVersions.delete(subscriptionKey);
        this.bridge.emit(call, {
          type: 'state', callId: call.config.callId, publisherSessionId: command.publisherSessionId, shareId: source.shareId,
          sourceInstanceId: source.instanceId,
          presentationId: state.presentationId, state: state.type, ...(state.reason ? { reason: state.reason } : {}),
        });
      },
      retirePresentation: presentationId => this.bridge.hasFrame(call)
        ? this.bridge.request(call, { type: 'presentation-stop', presentationId }) : Promise.resolve(null),
      createEndpoint: options => {
        this.current(call);
        const diagnostic = { ...callContext(call, source.shareId, options.pipelineId), role: 'receive',
          quality: options.quality, video: diagnosticProfile(getScreenShareProfile(source.video, options.quality, source.codec)) };
        this.diagnostics.log('pipeline-create', diagnostic);
        const observe = this.diagnostics.endpointObserver(call, source.shareId, options.pipelineId, 'receive', options.quality);
        const healthRecorded = new Set<'diagnostic' | 'terminal'>();
        const recordHealth = (trigger: 'diagnostic' | 'terminal'): void => {
          if (healthRecorded.has(trigger)) return;
          healthRecorded.add(trigger);
          try { this.diagnostics.log('receive-health', { ...diagnostic, trigger, observations: endpoint.failureDiagnostics() }, 'WARN'); }
          catch (error) { this.diagnostics.logFailure('receive-health-read', error, undefined, diagnostic); }
        };
        const endpoint = new NativeScreenEndpoint({
          ...options, runtime: this.nativeRuntime(), textures: sharedTexture, role: 'receive', ...call.config,
          source: { ...options.source, codec: source.codec ?? 'h264' },
          onState: state => { observe(state); options.onState(state); },
          publisherSessionId: command.publisherSessionId,
          destination: { frame: call.frame, presentationId: options.presentationId },
          ...(source.audio ? { audio: this.audioOptions(call, intent.audio) } : {}),
          rpc: (type, payload) => this.bridge.rpc(call, type, payload),
          onError: error => { recordHealth('terminal'); options.onError(error); },
          onDiagnostic: error => {
            recordHealth('diagnostic');
            console.warn('[NativeScreen] Receive diagnostic:', error);
            this.diagnostics.logFailure('receive-diagnostic', error, undefined, diagnostic);
          },
        });
        return endpoint;
      },
    });
    const entry = { source, publisherSessionId: command.publisherSessionId, subscription };
    call.subscriptions.set(subscriptionKey, entry);
    try {
      await subscription.start();
      assertCurrent();
      if (call.subscriptions.get(subscriptionKey) !== entry || subscription.snapshot().stopping) throw cancelled();
      return { kind: 'subscription', subscriptionId: subscription.subscriptionId, presentationId: subscription.presentationId };
    } catch (error) {
      try { await this.closeSubscription(call, entry); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Native screen Watch and retirement failed.'); }
      throw error;
    }
  }

  private async closeSubscription(call: CallRecord, entry: SubscriptionRecord): Promise<void> {
    const subscriptionKey = key(entry.publisherSessionId, entry.source.shareId);
    const diagnostic = { ...callContext(call, entry.source.shareId),
      presentation: diagnosticId(entry.subscription.presentationId) };
    this.diagnostics.log('subscription-retirement', diagnostic);
    try { await entry.subscription.close(); }
    finally {
      if (entry.subscription.snapshot().closed && call.subscriptions.get(subscriptionKey) === entry)
        call.subscriptions.delete(subscriptionKey);
      this.diagnostics.log('subscription-retirement-result', { ...diagnostic, closed: entry.subscription.snapshot().closed });
    }
  }

  private async updateParticipants(call: CallRecord, participants: NativeScreenParticipant[]): Promise<void> {
    call.participants = new Map(participants.map(participant => [participant.sessionId, participant]));
    const operations: Promise<unknown>[] = [...call.sources.values()]
      .map(entry => entry.publisher.setParticipants(participants.map(participant => participant.sessionId)));
    for (const entry of call.subscriptions.values()) {
      const current = call.participants.get(entry.publisherSessionId)?.nativeScreenShares
        .find(source => source.shareId === entry.source.shareId);
      if (!current || !isDeepStrictEqual(current, entry.source)) operations.push(this.closeSubscription(call, entry));
    }
    const results = await Promise.allSettled(operations);
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Native screen roster retirement failed.');
  }

  private async receiveSignal(call: CallRecord, signal: NativeScreenSignalPayload): Promise<void> {
    if (signal.targetSessionId !== call.config.sessionId || signal.channelId !== call.config.channelId)
      throw new Error('Native screen signal belongs to another call.');
    if (signal.publisherSessionId === call.config.sessionId) {
      const entry = call.sources.get(signal.shareId);
      if (entry?.source.instanceId === signal.sourceInstanceId) {
        if (!call.participants.has(signal.fromSessionId)) throw new Error('Native screen viewer is absent from the call roster.');
        if (signal.action === 'watch' || signal.action === 'stop')
          this.diagnostics.log('viewer-demand', { ...callContext(call, signal.shareId), action: signal.action,
            viewer: diagnosticId(signal.fromSessionId), subscription: diagnosticId(signal.subscriptionId),
            ...(signal.action === 'watch' ? { quality: signal.quality } : {}) });
        await entry.publisher.receive(signal);
      } else if (signal.action === 'watch') {
        await this.bridge.send(call, nativeScreenSignalSchema.parse({
          action: 'closed', reason: 'source-unavailable', fromSessionId: call.config.sessionId,
          targetSessionId: signal.fromSessionId, publisherSessionId: call.config.sessionId, channelId: call.config.channelId,
          shareId: signal.shareId, sourceInstanceId: signal.sourceInstanceId, subscriptionId: signal.subscriptionId,
        }));
      }
      return;
    }
    const entry = call.subscriptions.get(key(signal.publisherSessionId, signal.shareId));
    if (!entry || entry.source.instanceId !== signal.sourceInstanceId || entry.subscription.subscriptionId !== signal.subscriptionId) return;
    const receiving = entry.subscription.receive(signal);
    void receiving.catch(error => this.error(call, error, entry.publisherSessionId, entry.source.shareId, entry.subscription.presentationId));
    if (signal.action === 'accepted' && call.config.mode === 'sfu') {
      const value = await this.bridge.rpc(call, MessageType.SFU_GET_PRODUCERS, { channelId: call.config.channelId });
      if (!isRecord(value) || value.channelId !== call.config.channelId || !Array.isArray(value.producers) || value.producers.length > 2048)
        throw new Error('Invalid native screen producer list.');
      for (const producer of value.producers) {
        if (isRecord(producer) && isRecord(producer.appData) && producer.appData.nativeScreen !== undefined)
          await entry.subscription.addRemoteProducer(nativeScreenProducerSchema.parse({ ...producer, channelId: call.config.channelId }));
      }
    }
    await receiving;
  }

  private retiredWithErrors(call: CallRecord, error: unknown, shareId?: string): NativeScreenCommandResult {
    console.warn('[NativeScreen] Media retired with cleanup errors:', error);
    this.diagnostics.logFailure('remote-retirement', error, undefined, callContext(call, shareId));
    return { kind: 'retired-with-errors', remoteAcknowledged: !call.remoteUnavailable, error: errorDetails(error).message };
  }

  private closeCall(call: CallRecord): Promise<void> {
    if (call.retirement) return call.retirement;
    this.diagnostics.log('call-retirement', { ...callContext(call), remoteUnavailable: call.remoteUnavailable,
      sources: call.sources.size, selections: call.sourceSelections.size, subscriptions: call.subscriptions.size });
    call.stopping = true;
    for (const selection of call.sourceSelections.values()) selection.abort.abort(cancelled());
    call.watchVersions.clear();
    const retirement = (async () => {
      const results = await Promise.allSettled([
        ...[...new Set([...call.sources.keys(), ...call.sourceSelections.keys()])].map(shareId => this.removeSource(call, shareId)),
        ...[...call.subscriptions.values()].map(entry => this.closeSubscription(call, entry)),
      ]);
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (call.remoteUnavailable) {
        // Remote acknowledgement cannot survive a lost connection/document.
        // Release the call slot only after the original local owners prove retirement,
        // and retain the failed remote acknowledgement as an explicit error.
        for (const [shareId, source] of call.sources) {
          try {
            source.publisher.assertLocallyClosed();
            await source.captureHub?.close();
            call.sources.delete(shareId);
          } catch (error) { errors.push(error); }
        }
        for (const [subscriptionKey, entry] of call.subscriptions) {
          try { entry.subscription.assertLocallyClosed(); call.subscriptions.delete(subscriptionKey); }
          catch (error) { errors.push(error); }
        }
      }
      if (call.sources.size === 0 && call.sourceSelections.size === 0 && call.subscriptions.size === 0) this.calls.delete(call.config.callId);
      this.diagnostics.log('call-retirement-result', { ...callContext(call), retained: this.calls.has(call.config.callId),
        remoteAcknowledged: !call.remoteUnavailable, failures: errors.length,
        sources: call.sources.size, selections: call.sourceSelections.size, subscriptions: call.subscriptions.size });
      for (const [shareId, source] of call.sources) {
        const publisher = source.publisher.snapshot(), pcm = source.captureHub?.getStats();
        this.diagnostics.log('retained-source-owner', { ...callContext(call, shareId),
          phase: publisher.closed ? 'source-retirement' : 'publisher-retirement',
          publisherClosed: publisher.closed, previewRetained: source.preview !== null,
          pcmSubscriptions: pcm?.subscriptions, pcmCaptureClosed: pcm?.captureClosed }, 'WARN');
      }
      for (const entry of call.subscriptions.values())
        this.diagnostics.log('retained-subscription-owner', { ...callContext(call, entry.source.shareId),
          presentation: diagnosticId(entry.subscription.presentationId), phase: 'subscription-retirement',
          closed: entry.subscription.snapshot().closed }, 'WARN');
      if (errors.length) throw new AggregateError(errors, 'Native screen call shutdown reported failures.');
      if (call.sources.size || call.sourceSelections.size || call.subscriptions.size)
        throw new Error('A native screen call retained media resources.');
    })();
    call.retirement = retirement;
    void retirement.catch(error => {
      this.diagnostics.logFailure('call-retirement', error, undefined, callContext(call));
      if (this.calls.get(call.config.callId) === call) call.retirement = null;
    });
    return retirement;
  }

  async closeCalls(): Promise<void> {
    this.bridge.rejectUnavailable();
    const results = await Promise.allSettled([...this.calls.values()].map(call => this.closeCall(call)));
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Native screen cleanup did not finish without errors.');
  }

  async retireDocument(): Promise<void> {
    if (this.calls.size) this.diagnostics.log('document-retirement', { calls: this.calls.size });
    for (const call of this.calls.values()) { call.documentRetired = true; call.remoteUnavailable = true; }
    this.discovery.cache.clear();
    const retirement = this.discovery.retire(cancelled());
    this.discovery.restart();
    await Promise.all([retirement, this.closeCalls()]);
  }

  freezeAdmissions(): void {
    this.admissionsFrozen = true;
    this.discovery.abort(cancelled());
    for (const call of this.calls.values()) this.shutdownCalls.add(call.config.callId);
  }

  prepareShutdown(): Promise<void> {
    this.freezeAdmissions();
    this.shutdownRequested = true;
    if (this.shutdownPreparation) return this.shutdownPreparation;
    const calls = [...this.calls.values()];
    for (const call of calls) this.shutdownCalls.add(call.config.callId);
    const work = Promise.allSettled([this.discovery.retire(cancelled()), ...calls.map(async call => {
      try { await this.closeCall(call); }
      catch (error) {
        // A historical cleanup error is not retained ownership. Only the
        // original owners' retirement proofs can release the call slot.
        if (this.calls.has(call.config.callId)) throw error;
        this.diagnostics.logFailure('shutdown-remote-retirement', error, undefined, callContext(call));
        this.diagnostics.log('shutdown-locally-retired', { ...callContext(call), remoteAcknowledged: !call.remoteUnavailable }, 'WARN');
      }
    })]).then(results => {
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Native screen shutdown preparation failed.');
      if (this.calls.size || this.bridge.pending) throw new Error('Native shutdown preparation retained owners or requests.');
    });
    this.shutdownPreparation = work;
    void work.catch(() => { if (this.shutdownPreparation === work) this.shutdownPreparation = null; });
    return work;
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    const work = Promise.resolve().then(async () => {
      await Promise.all([this.discovery.retire(cancelled()), this.closeCalls()]);
      if (this.bridge.pending) throw new Error('Native screen IPC still owns pending requests.');
      screen.removeListener('display-added', this.onDisplayChanged);
      screen.removeListener('display-removed', this.onDisplayChanged);
      screen.removeListener('display-metrics-changed', this.onDisplayChanged);
      this.diagnostics.clear();
    });
    this.disposal = work;
    void work.catch(() => { if (this.disposal === work) this.disposal = null; });
    return work;
  }
}

/**
 * Native screen sharing of the main window. Commands and renderer replies come in through the window's IPC
 * registry, from its top frame only; the media of a call is retired when the document that joined it goes away.
 */
export function registerNativeScreenSharingIpc(registry: IpcRegistry, { window, resolveSource, logger }: {
  window: BrowserWindow; resolveSource: ResolveSource; logger?: Pick<ClientLogger, 'write'>;
}): NativeScreenSharingIpc {
  const ipc = registry.scope();
  const diagnostics = new NativeScreenDiagnostics(logger);
  const bridge = new RendererBridge(window, ipc);
  const service = new NativeScreenSharingService(window, resolveSource, diagnostics, bridge);
  const reportFailures = async <T>(action: () => Promise<T> | T, input?: unknown): Promise<T> => {
    try { return await action(); }
    catch (error) {
      console.error('[NativeScreen] IPC operation failed:', errorDetails(error).message, error);
      diagnostics.logFailure('IPC', error, input);
      throw rendererFailure(error);
    }
  };
  ipc.handle(NATIVE_SCREEN_IPC.invoke, 'main', (_event, input: unknown) => reportFailures(async (): Promise<NativeScreenCommandResult> => {
    try { return await service.invoke(input); }
    catch (error) {
      if (isRecord(input) && input.action === 'diagnostics' && error instanceof DOMException && error.name === 'AbortError') {
        console.debug('[NativeScreen] Diagnostics superseded by media retirement.');
        return { kind: 'diagnostics-retired' };
      }
      throw error;
    }
  }, input));
  ipc.handle(NATIVE_SCREEN_IPC.reply, 'main', (_event, input: unknown) => reportFailures(() => bridge.reply(input)));
  const cleanup = (): void => {
    void service.retireDocument().catch(error => {
      console.error('[NativeScreen] Renderer teardown reported failures:', error);
      diagnostics.logFailure('document-retirement', error);
    });
  };
  const navigation = (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>): void => {
    if (details.isMainFrame && !details.isSameDocument) cleanup();
  };
  const contents = window.webContents;
  let focusUpdate: NodeJS.Immediate | null = null;
  const focusChanged = (): void => {
    if (focusUpdate) return;
    focusUpdate = setImmediate(() => {
      focusUpdate = null;
      void service.refreshPreviewVisibility().catch(error => {
        console.error('[NativeScreen] Preview focus update failed:', error);
        diagnostics.logFailure('preview-focus', error);
      });
    });
  };
  app.on('browser-window-focus', focusChanged);
  app.on('browser-window-blur', focusChanged);
  contents.on('did-start-navigation', navigation);
  contents.on('render-process-gone', cleanup);
  contents.on('destroyed', cleanup);
  return {
    freezeAdmissions: () => service.freezeAdmissions(),
    prepareShutdown: () => service.prepareShutdown(),
    async dispose() {
      await service.dispose();
      if (focusUpdate) clearImmediate(focusUpdate);
      app.removeListener('browser-window-focus', focusChanged);
      app.removeListener('browser-window-blur', focusChanged);
      ipc.dispose();
      contents.removeListener('did-start-navigation', navigation);
      contents.removeListener('render-process-gone', cleanup);
      contents.removeListener('destroyed', cleanup);
    },
  };
}
