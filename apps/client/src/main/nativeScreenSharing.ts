import { app, ipcMain, sharedTexture, MessageChannelMain, BrowserWindow, type IpcMainInvokeEvent, type WebFrameMain } from 'electron';
import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  MessageType, NATIVE_SCREEN_EVENT, NATIVE_SCREEN_IPC, nativeScreenCommandSchema, nativeScreenEventSchema,
  nativeScreenProducerSchema, nativeScreenReplySchema, nativeScreenRpcMethodSchema, nativeScreenSignalSchema,
  type NativeScreenCall, type NativeScreenCapabilities, type NativeScreenCommand, type NativeScreenCommandResult,
  type NativeScreenEvent, type NativeScreenFailure, type NativeScreenParticipant, type NativeScreenSignalPayload,
  type NativeScreenSource, type NativeScreenAudioPreferences, type NativeScreenCaptureKind, type NativeScreenVideoProfile,
  type NativeScreenCaptureMode,
} from '@monky/shared';
import {
  loadRuntime, NativeScreenEndpoint, NativeScreenPublisher, NativeScreenSubscription, NativePcmCaptureHub,
  NativeScreenPreviewBridge, CaptureBridge,
  validateCaptureTarget, type NativeScreenRuntime, type NativeScreenAudioOptions, type NativeScreenCaptureTarget,
  type NativeScreenCaptureCapability,
} from '@monky/screen-share';
import * as screenAudio from '@monky/screen-audio';

type RendererRequest = Extract<NativeScreenEvent, { requestId: string }>;
type RequestInput = Omit<Extract<RendererRequest, { type: 'signal' }>, 'requestId' | 'callId'>
  | Omit<Extract<RendererRequest, { type: 'rpc' }>, 'requestId' | 'callId'>
  | Omit<Extract<RendererRequest, { type: 'presentation-stop' }>, 'requestId' | 'callId'>;
type SourceRecord = {
  source: NativeScreenSource; publisher: NativeScreenPublisher; captureHub: NativePcmCaptureHub | null;
  monitor: NodeJS.Timeout | null;
  preview: NativeScreenPreviewBridge | null;
  previewMode: NativeScreenCaptureMode | null;
};
type SubscriptionRecord = { source: NativeScreenSource; publisherSessionId: string; subscription: NativeScreenSubscription };
type WatchIntent = { presentationId: string; audio: NativeScreenAudioPreferences };
type SourceSelection = {
  audio: boolean; abort: AbortController; probe: SelectedCaptureProbe | null;
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
type PendingRequest = {
  call: CallRecord; type: RendererRequest['type'];
  resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout;
};
export interface NativeScreenSharingIpc { dispose(): Promise<void> }

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const key = (publisher: string, share: string): string => `${publisher}\0${share}`;
const cancelled = (): DOMException => new DOMException('Native screen call is no longer current.', 'AbortError');
function errorDetails(error: unknown): { message: string; code?: 'ERR_SCREEN_CAPTURE_GAME_UNAVAILABLE' } {
  const pending: unknown[] = [error], seen = new Set<unknown>(), messages = new Set<string>();
  let code: 'ERR_SCREEN_CAPTURE_GAME_UNAVAILABLE' | undefined;
  while (pending.length && seen.size < 12) {
    const current = pending.shift();
    if (seen.has(current)) continue;
    seen.add(current);
    if (record(current) && current.code === 'ERR_SCREEN_CAPTURE_GAME_UNAVAILABLE') code = current.code;
    messages.add(current instanceof Error ? current.message : String(current));
    if (current instanceof AggregateError) {
      const nested: readonly unknown[] = current.errors;
      pending.push(...nested.slice(0, 8));
    }
    if (current instanceof Error && current.cause !== undefined) pending.push(current.cause);
  }
  return { message: [...messages].join(' / ').slice(0, 4096) || 'Native screen operation failed.',
    ...(code ? { code } : {}) };
}
function failureReason(error: unknown): NativeScreenFailure {
  const code = record(error) && typeof error.code === 'string' ? error.code : '';
  if (code === 'ERR_SCREEN_CAPTURE_SOURCE_LOST') return 'source-unavailable';
  if (code.includes('CAPTURE')) return 'capture-failed';
  return 'connection-failed';
}
function documentIdentity(value: string): string {
  const url = new URL(value);
  url.hash = '';
  return url.href;
}

class SelectedCaptureProbe {
  private readonly runId = randomBytes(16).toString('hex');
  private readonly directory: string;
  private bridge: CaptureBridge | null = null;
  private child: CaptureBridge['child'] = undefined;
  private exited = false;
  private childClosed = false;
  private directoryCreated = false;
  private closeWork: Promise<void> | null = null;
  retired = false;

  constructor(private readonly runtime: NativeScreenRuntime, private readonly root: string) {
    this.directory = path.join(root, `monky-screen-capture-${this.runId}`);
  }

  async prepare(target: NativeScreenCaptureTarget, video: NativeScreenVideoProfile,
    signal: AbortSignal, preserveAspectRatio = false): Promise<NativeScreenCaptureCapability> {
    let capability: NativeScreenCaptureCapability;
    try {
      signal.throwIfAborted();
      await mkdir(this.directory);
      this.directoryCreated = true;
      signal.throwIfAborted();
      const { width, height, fps, maxBitrateKbps } = video;
      this.bridge = new CaptureBridge({
        host: this.runtime.host, runtime: this.runtime.obs, runId: this.runId, runDirectory: this.directory,
        encoder: 'auto', video: { width, height, fps, bitrateKbps: maxBitrateKbps,
          scaleMode: preserveAspectRatio ? 'fit' : 'stretch' },
        onError: error => console.warn('[NativeScreen] Selected-source probe failed:', error),
        onPacket: () => { throw new Error('A source-selection probe must not capture pixels.'); }, onNotice() {},
      });
      const preparing = this.bridge.prepare(target, signal);
      this.child = this.bridge.child;
      // Observe this exact child's lifecycle independently of mutable bridge snapshots.
      this.child?.once('exit', () => { this.exited = true; });
      this.child?.once('close', () => { this.childClosed = true; });
      await preparing;
      signal.throwIfAborted();
      const proof = this.bridge.getCapabilities();
      if (!proof || !proof.probeVerified || !proof.textureInput || !proof.dynamicBitrate
        || proof.hardwareSessionConfirmed || proof.hardwareQualified || proof.codec !== 'h264'
        || !this.runtime.capture.encoders.includes(proof.encoderId))
        throw new Error('The selected source did not produce a verified, capture-free hardware probe.');
      capability = proof;
    } catch (error) {
      try { await this.close(); }
      catch (cleanupError) {
        if (!this.retired || cleanupError !== error)
          throw new AggregateError([error, cleanupError], 'Selected source probing and retirement failed.');
      }
      throw error;
    }
    await this.close();
    return capability;
  }

  close(): Promise<void> {
    if (this.closeWork) return this.closeWork;
    const work = this.retire();
    this.closeWork = work;
    void work.catch(() => { if (!this.retired && this.closeWork === work) this.closeWork = null; });
    return work;
  }

  private async retire(): Promise<void> {
    let failure: unknown;
    if (this.bridge) {
      try { await this.bridge.stop(); }
      catch (error) { failure = error; }
      const snapshot = this.bridge.snapshot();
      if (this.child && (!this.exited || !this.childClosed || !snapshot.nativeClosed || snapshot.forcedTermination)) {
        const error = new Error('The original selected-source probe has not proved native process retirement.');
        throw failure ? new AggregateError([failure, error], error.message) : error;
      }
    }
    if (this.directoryCreated) {
      const directory = await lstat(this.directory);
      if (!directory.isDirectory() || directory.isSymbolicLink()
        || (await realpath(this.directory)).toLowerCase() !== this.directory.toLowerCase()
        || path.dirname(this.directory) !== this.root)
        throw new Error('The owned probe directory changed identity before retirement.');
      if ((await readdir(this.directory)).length) {
        const marker: unknown = JSON.parse(await readFile(path.join(this.directory, '.monky-screen-capture-owner'), 'utf8'));
        if (!record(marker) || marker.runId !== this.runId || marker.parentProcessId !== process.pid
          || marker.helperProcessId !== this.child?.pid)
          throw new Error('The selected-source probe directory has a different process owner.');
      }
      await rm(this.directory, { recursive: true });
      this.directoryCreated = false;
    }
    this.retired = true;
    if (failure) throw failure;
  }
}

class NativeScreenSharingService {
  private readonly calls = new Map<string, CallRecord>();
  private readonly requests = new Map<string, PendingRequest>();
  private runtime: NativeScreenRuntime | null = null;
  private availability: Promise<NativeScreenCapabilities> | null = null;
  private disposed = false;

  constructor(
    private readonly window: BrowserWindow,
    private readonly resolveSource: (sourceId: string, kind: NativeScreenCaptureKind) => NativeScreenCaptureTarget,
  ) {}

  owns(event: IpcMainInvokeEvent): boolean {
    return !this.disposed && !this.window.isDestroyed() && !this.window.webContents.isDestroyed()
      && event.sender === this.window.webContents && event.senderFrame === this.window.webContents.mainFrame;
  }

  private hasFrame(call: CallRecord): boolean {
    return !call.documentRetired && !this.window.isDestroyed() && !this.window.webContents.isDestroyed()
      && !call.frame.isDestroyed() && !call.frame.detached && call.frame.url.length > 0
      && this.window.webContents.mainFrame === call.frame && documentIdentity(call.frame.url) === call.documentUrl;
  }

  private emit(call: CallRecord, event: NativeScreenEvent): void {
    if (this.hasFrame(call)) this.window.webContents.send(NATIVE_SCREEN_EVENT, nativeScreenEventSchema.parse(event));
  }

  private error(call: CallRecord, error: unknown, publisherSessionId: string, shareId?: string,
    presentationId?: string, sourceInstanceId?: string): void {
    if (call.stopping && error instanceof Error && error.name === 'AbortError') return;
    console.error('[NativeScreen]', error);
    const details = errorDetails(error);
    this.emit(call, { type: 'error', callId: call.config.callId, publisherSessionId,
      ...(shareId ? { shareId } : {}), ...(presentationId ? { presentationId } : {}),
      ...(sourceInstanceId ? { sourceInstanceId } : {}),
      reason: details.code ? 'capture-failed' : failureReason(error), ...details });
  }

  private request(call: CallRecord, input: RequestInput): Promise<unknown> {
    if (!this.hasFrame(call)) return Promise.reject(new Error('The native screen Renderer document is unavailable.'));
    if (call.remoteUnavailable && input.type !== 'presentation-stop')
      return Promise.reject(new Error('The disconnected native screen call cannot acknowledge remote media cleanup.'));
    if (this.requests.size >= 256) return Promise.reject(new Error('Native screen IPC exceeded its pending-request limit.'));
    const requestId = randomUUID();
    const event = nativeScreenEventSchema.parse({ ...input, requestId, callId: call.config.callId });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(requestId);
        reject(new Error(`Native screen Renderer ${input.type} did not acknowledge its request.`));
      }, 15000);
      this.requests.set(requestId, { call, type: input.type, resolve, reject, timer });
      try { this.window.webContents.send(NATIVE_SCREEN_EVENT, event); }
      catch (error) {
        clearTimeout(timer);
        this.requests.delete(requestId);
        reject(error);
      }
    });
  }

  reply(value: unknown): void {
    const reply = nativeScreenReplySchema.parse(value);
    const pending = this.requests.get(reply.requestId);
    if (!pending) {
      console.warn('[NativeScreen] Ignored an expired Renderer response.');
      return;
    }
    if (pending.call.config.callId !== reply.callId || !this.hasFrame(pending.call))
      throw new Error('Native screen response belongs to a different call or Renderer document.');
    clearTimeout(pending.timer);
    this.requests.delete(reply.requestId);
    if (reply.ok) pending.resolve(reply.value);
    else pending.reject(new Error(reply.error));
  }

  private send(call: CallRecord, signal: NativeScreenSignalPayload): Promise<void> {
    return this.request(call, { type: 'signal', signal }).then(() => {});
  }

  private rpc(call: CallRecord, type: MessageType, payload: Readonly<Record<string, unknown>>): Promise<unknown> {
    const method = nativeScreenRpcMethodSchema.parse(type);
    if (payload.channelId !== call.config.channelId) return Promise.reject(new Error('Native SFU RPC escaped its voice channel.'));
    return this.request(call, { type: 'rpc', method, payload });
  }

  private capabilities(): Promise<NativeScreenCapabilities> {
    if (!this.availability) this.availability = (async (): Promise<NativeScreenCapabilities> => {
      if (process.platform !== 'win32' || process.arch !== 'x64')
        return { capture: false, captureAudio: false, receive: false, backend: null, reason: 'platform' };
      try {
        this.runtime = loadRuntime();
        return { capture: false, captureAudio: screenAudio.isPacketCaptureSupported(), receive: true,
          requiresSelectionProbe: true, captureKinds: [...this.runtime.capture.captureKinds], backend: null, reason: null };
      } catch (error) {
        console.error('[NativeScreen] Production media runtime is unavailable:', error);
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
    if (!call || !this.hasFrame(call)) throw cancelled();
    return call;
  }

  private current(call: CallRecord): void {
    if (call.stopping || this.calls.get(call.config.callId) !== call || !this.hasFrame(call)) throw cancelled();
  }

  async invoke(value: unknown): Promise<NativeScreenCommandResult> {
    const command = nativeScreenCommandSchema.parse(value);
    if (command.action === 'capabilities') return { kind: 'capabilities', capabilities: await this.capabilities() };
    if (command.action === 'join') {
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
      return { kind: 'ok' };
    }
    // Closing is idempotent even if the renderer lost the join acknowledgement.
    if ((command.action === 'leave' || command.action === 'leave-local') && !this.calls.has(command.callId))
      return { kind: 'ok' };
    const call = this.callFor(command.callId);
    if (command.action === 'leave' || command.action === 'leave-local') {
      if (command.action === 'leave-local') {
        call.remoteUnavailable = true;
        this.rejectUnavailableRequests();
      }
      try { await this.closeCall(call); }
      catch (error) {
        if (this.calls.has(call.config.callId)) throw error;
        console.warn('[NativeScreen] Media retired with cleanup errors:', error);
        return { kind: 'retired-with-errors', remoteAcknowledged: !call.remoteUnavailable, error: errorDetails(error).message };
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
        await this.removeSource(call, command.shareId);
        break;
      case 'preview-preferences':
        call.pausePreviewWhenUnfocused = command.pauseWhenUnfocused;
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
        entry.preview = new NativeScreenPreviewBridge({
          frame: call.frame, info, createMessageChannel: () => new MessageChannelMain(),
          onState: state => this.emit(call, { type: 'preview-state', callId: call.config.callId,
            publisherSessionId: call.config.sessionId, shareId: entry.source.shareId,
            sourceInstanceId: entry.source.instanceId, state }),
          onError: error => {
            console.warn('[NativeScreen] Local preview failed without changing the broadcast:', error);
            if (!entry.publisher.snapshot().stopping)
              void entry.publisher.setPreviewEnabled(false).catch(cleanupError =>
                console.error('[NativeScreen] Failed local preview retained capture ownership:', cleanupError));
          },
        });
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
        intent.audio = { ...intent.audio, muted: command.muted, volume: command.volume };
        const entry = call.subscriptions.get(subscriptionKey);
        if (entry?.subscription.presentationId === command.presentationId)
          await entry.subscription.setAudioPreferences({ muted: command.muted, volume: command.volume });
        break;
      }
      case 'stop': {
        const subscriptionKey = key(command.publisherSessionId, command.shareId);
        if (call.watchVersions.get(subscriptionKey)?.presentationId === command.presentationId) call.watchVersions.delete(subscriptionKey);
        const entry = call.subscriptions.get(subscriptionKey);
        if (entry?.subscription.presentationId === command.presentationId) await this.closeSubscription(call, entry);
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
        const endpoints = await owner.diagnostics();
        this.current(call);
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
      .filter(call => !call.stopping && this.hasFrame(call)).map(call => this.refreshCallPreviews(call)));
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Local screen preview focus transition failed.');
  }

  private async addSource(call: CallRecord, command: Extract<NativeScreenCommand, { action: 'source-add' }>): Promise<NativeScreenCommandResult> {
    if (call.sources.has(command.shareId) || call.sourceSelections.has(command.shareId)
      || call.sources.size + call.sourceSelections.size >= 3)
      throw new Error('Native screen source already exists or exceeds the two-share plus pending-replacement limit.');
    if (command.audio && [...this.calls.values()].some(owner =>
      [...owner.sources.values()].some(entry => entry.source.audio)
      || [...owner.sourceSelections.values()].some(entry => entry.audio)))
      throw new Error('Only one shared source can reserve capture audio at a time.');
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const selection: SourceSelection = { audio: command.audio, abort: new AbortController(), probe: null, done, finish };
    call.sourceSelections.set(command.shareId, selection);
    const assertCurrent = (): void => {
      this.current(call);
      selection.abort.signal.throwIfAborted();
      if (call.sourceSelections.get(command.shareId) !== selection) throw cancelled();
    };
    try {
      const capabilities = await this.capabilities();
      assertCurrent();
      if (!capabilities.capture && !capabilities.requiresSelectionProbe)
        throw new Error(`Native screen capture is unavailable: ${capabilities.reason}.`);
      if (command.audio && !capabilities.captureAudio) throw new Error('Timestamped screen-sharing audio capture is unavailable.');
      const kind = command.captureKind ?? 'window';
      if (kind === 'monitor' ? !command.desktopSourceId.startsWith('native-monitor:')
        : !command.desktopSourceId.startsWith('window:'))
        throw new Error('Native source identity does not match its requested capture kind.');
      if (!(capabilities.captureKinds ?? (capabilities.capture ? ['window'] : [])).includes(kind))
        throw new Error('The selected native capture kind is not implemented by this verified runtime.');
      const target = this.resolveSource(command.desktopSourceId, kind);
      validateCaptureTarget(target);
      if (target.kind !== kind) throw new Error('Native source resolution changed the requested capture kind.');
      let paused = false;
      const sourceState = (): void => {
        if (target.kind === 'monitor') {
          const current = screenAudio.getMonitorState(target.deviceId);
          if (!current || current.deviceId !== target.deviceId || current.deviceName !== target.deviceName
            || !isDeepStrictEqual(current.bounds, target.bounds))
            throw Object.assign(new Error('The selected monitor disconnected or changed its bounds. Select it again explicitly.'),
              { code: 'ERR_SCREEN_CAPTURE_SOURCE_LOST' });
          return;
        }
        const state = screenAudio.getWindowState(target.hwnd);
        if (!state?.isTopLevel || state.processId !== target.expectedProcessId
          || state.processCreationTime100ns !== target.expectedProcessCreationTime100ns)
          throw Object.assign(new Error('The selected screen-sharing window was closed or replaced.'),
            { code: 'ERR_SCREEN_CAPTURE_SOURCE_LOST' });
        paused = state.isIconic || !state.isVisible;
      };
      sourceState();
      const captureDirectory = path.join(app.getPath('userData'), 'native-screen-capture');
      await mkdir(captureDirectory, { recursive: true });
      assertCurrent();
      sourceState();
      selection.probe = new SelectedCaptureProbe(this.nativeRuntime(), captureDirectory);
      const proof = await selection.probe.prepare(target, command.video, selection.abort.signal, command.preserveAspectRatio);
      assertCurrent();
      sourceState();
      this.availability = Promise.resolve({ ...capabilities, capture: true,
        backend: proof.encoderId === 'obs_nvenc_h264_tex' ? 'libobs-nvenc' : 'libobs-amf' });
      const source: NativeScreenSource = {
        shareId: command.shareId, instanceId: randomUUID(), video: command.video, audio: command.audio,
      };
      const onError = (error: Error, context?: unknown): void => {
        if (record(context) && typeof context.remoteSessionId === 'string') {
          console.warn('[NativeScreen] Screen viewer failed:', { shareId: source.shareId, remoteSessionId: context.remoteSessionId }, error);
          return;
        }
        this.error(call, error, call.config.sessionId, source.shareId, undefined, source.instanceId);
        if (!call.stopping && call.sources.get(source.shareId)?.source === source && failureReason(error) === 'source-unavailable')
          void this.removeSource(call, source.shareId).catch(cleanupError => {
            this.error(call, cleanupError, call.config.sessionId, source.shareId, undefined, source.instanceId);
          });
      };
      const audioSelection = target.kind === 'monitor' ? { excludePid: process.pid }
        : { includeWindowId: target.hwnd, expectedProcessId: target.expectedProcessId };
      const captureHub = command.audio ? new NativePcmCaptureHub(screenAudio, audioSelection, onError) : null;
      let captureTarget = target;
      const publisher = new NativeScreenPublisher({
        ...call.config, source, send: signal => this.send(call, signal), onError,
        onState: ({ state }) => {
          if (state.type !== 'capture-fallback' || captureTarget.kind !== 'game') return;
          this.current(call);
          sourceState();
          captureTarget = { ...captureTarget, kind: 'window' };
          this.emit(call, { type: 'capture-fallback', callId: call.config.callId,
            publisherSessionId: call.config.sessionId, shareId: source.shareId, sourceInstanceId: source.instanceId });
        },
        onPreview: packet => {
          const enabled = this.previewAllowed(call, entry);
          if (packet && enabled && entry.preview) {
            if (packet.captureMode && packet.captureMode !== entry.previewMode) {
              entry.previewMode = packet.captureMode;
              this.emit(call, { type: 'capture-mode', callId: call.config.callId,
                publisherSessionId: call.config.sessionId, shareId: source.shareId, sourceInstanceId: source.instanceId,
                presentationId: entry.preview.info.presentationId, mode: packet.captureMode });
            }
            entry.preview.offer(packet.frame, packet.pipelineId, packet.video);
          }
          else if (!packet) entry.preview?.reset(enabled ? 'waiting' : 'paused');
        },
        createEndpoint: options => {
          this.current(call);
          sourceState();
          return new NativeScreenEndpoint({
            ...options, runtime: this.nativeRuntime(), textures: sharedTexture, role: 'publish', ...call.config,
            publisherSessionId: call.config.sessionId, target: captureTarget, captureDirectory, captureEncoder: proof.encoderId,
            preserveAspectRatio: command.preserveAspectRatio ?? false,
            isSourcePaused: () => paused,
            assertSourceCurrent: () => {
              this.current(call);
              if (call.sources.get(source.shareId)?.source !== source) throw cancelled();
              sourceState();
            },
            ...(captureHub ? { audio: {
              ...this.audioOptions(call, { sinkId: '', muted: true, volume: 0 }),
              captureModule: screenAudio, captureHub, maxBitrateBps: command.audioBitrateKbps * 1000,
            } } : {}),
            rpc: (type, payload) => this.rpc(call, type, payload),
            onDiagnostic: error => console.warn('[NativeScreen] Capture diagnostic:', error),
          });
        },
      });
      const entry: SourceRecord = { source, publisher, captureHub, monitor: null, preview: null, previewMode: null };
      call.sources.set(source.shareId, entry);
      // An announcement owns its exact target even without a capture pipeline.
      entry.monitor = setInterval(() => {
        try { sourceState(); }
        catch (error) {
          if (entry.monitor) clearInterval(entry.monitor);
          entry.monitor = null;
          if (target.kind === 'monitor' || failureReason(error) !== 'source-unavailable')
            this.error(call, error, call.config.sessionId, source.shareId, undefined, source.instanceId);
          void this.removeSource(call, source.shareId).catch(cleanupError =>
            this.error(call, cleanupError, call.config.sessionId, source.shareId, undefined, source.instanceId));
        }
      }, 250);
      entry.monitor.unref();
      return { kind: 'source', source };
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
      selection.abort.abort(cancelled());
      await selection.done;
      await selection.probe?.close();
      if (call.sourceSelections.get(shareId) === selection) call.sourceSelections.delete(shareId);
    }
    if (!entry) return;
    if (entry.monitor) clearInterval(entry.monitor);
    entry.monitor = null;
    const errors: unknown[] = [];
    const preview = entry.preview;
    preview?.close();
    const retired = await Promise.allSettled([
      entry.publisher.close(),
      preview && this.hasFrame(call)
        ? this.request(call, { type: 'presentation-stop', presentationId: preview.info.presentationId }) : Promise.resolve(),
    ]);
    for (const result of retired) if (result.status === 'rejected') errors.push(result.reason);
    if (retired[1].status === 'fulfilled') entry.preview = null;
    if (entry.publisher.snapshot().closed) {
      try { await entry.captureHub?.close(); }
      catch (error) { errors.push(error); }
      if (!entry.preview && (!entry.captureHub || entry.captureHub.getStats().closed) && call.sources.get(shareId) === entry) {
        call.sources.delete(shareId);
        this.emit(call, { type: 'state', callId: call.config.callId, publisherSessionId: call.config.sessionId,
          shareId, sourceInstanceId: entry.source.instanceId, state: 'closed' });
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Native screen source retirement reported failures.');
  }

  private async watch(call: CallRecord, command: Extract<NativeScreenCommand, { action: 'watch' }>): Promise<NativeScreenCommandResult> {
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
    const subscription = new NativeScreenSubscription({
      ...call.config, source, publisherSessionId: command.publisherSessionId, quality: command.quality,
      presentationId: command.presentationId, send: signal => this.send(call, signal),
      onError: error => this.error(call, error, command.publisherSessionId, source.shareId, command.presentationId, source.instanceId),
      onState: state => {
        if (state.type === 'capture-mode') {
          this.emit(call, { type: 'capture-mode', callId: call.config.callId,
            publisherSessionId: command.publisherSessionId, shareId: source.shareId, sourceInstanceId: source.instanceId,
            presentationId: state.presentationId, mode: state.mode });
          return;
        }
        if (state.type === 'closed' && call.subscriptions.get(subscriptionKey)?.subscription === subscription)
          call.subscriptions.delete(subscriptionKey);
        if (state.type === 'closed' && call.watchVersions.get(subscriptionKey) === intent) call.watchVersions.delete(subscriptionKey);
        this.emit(call, {
          type: 'state', callId: call.config.callId, publisherSessionId: command.publisherSessionId, shareId: source.shareId,
          sourceInstanceId: source.instanceId,
          presentationId: state.presentationId, state: state.type, ...(state.reason ? { reason: state.reason } : {}),
        });
      },
      retirePresentation: presentationId => this.hasFrame(call)
        ? this.request(call, { type: 'presentation-stop', presentationId }) : Promise.resolve(null),
      createEndpoint: options => {
        this.current(call);
        return new NativeScreenEndpoint({
          ...options, runtime: this.nativeRuntime(), textures: sharedTexture, role: 'receive', ...call.config,
          publisherSessionId: command.publisherSessionId,
          destination: { frame: call.frame, presentationId: options.presentationId },
          ...(source.audio ? { audio: this.audioOptions(call, intent.audio) } : {}),
          rpc: (type, payload) => this.rpc(call, type, payload),
          onDiagnostic: error => console.warn('[NativeScreen] Receive diagnostic:', error),
        });
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
    try { await entry.subscription.close(); }
    finally {
      if (entry.subscription.snapshot().closed && call.subscriptions.get(subscriptionKey) === entry)
        call.subscriptions.delete(subscriptionKey);
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
        await entry.publisher.receive(signal);
      } else if (signal.action === 'watch') {
        await this.send(call, nativeScreenSignalSchema.parse({
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
      const value = await this.rpc(call, MessageType.SFU_GET_PRODUCERS, { channelId: call.config.channelId });
      if (!record(value) || value.channelId !== call.config.channelId || !Array.isArray(value.producers) || value.producers.length > 2048)
        throw new Error('Invalid native screen producer list.');
      for (const producer of value.producers) {
        if (record(producer) && record(producer.appData) && producer.appData.nativeScreen !== undefined)
          await entry.subscription.addRemoteProducer(nativeScreenProducerSchema.parse({ ...producer, channelId: call.config.channelId }));
      }
    }
    await receiving;
  }

  private closeCall(call: CallRecord): Promise<void> {
    if (call.retirement) return call.retirement;
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
      if (errors.length) throw new AggregateError(errors, 'Native screen call shutdown reported failures.');
      if (call.sources.size || call.sourceSelections.size || call.subscriptions.size)
        throw new Error('A native screen call retained media resources.');
    })();
    call.retirement = retirement;
    void retirement.catch(() => { if (this.calls.get(call.config.callId) === call) call.retirement = null; });
    return retirement;
  }

  async closeCalls(): Promise<void> {
    this.rejectUnavailableRequests();
    const results = await Promise.allSettled([...this.calls.values()].map(call => this.closeCall(call)));
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Native screen cleanup did not finish without errors.');
  }

  private rejectUnavailableRequests(): void {
    for (const [id, pending] of this.requests) {
      if (!this.hasFrame(pending.call) || (pending.call.remoteUnavailable && pending.type !== 'presentation-stop')) {
        clearTimeout(pending.timer); this.requests.delete(id);
        pending.reject(new Error('The native screen document or remote connection was retired before acknowledgement.'));
      }
    }
  }

  retireDocument(): Promise<void> {
    for (const call of this.calls.values()) { call.documentRetired = true; call.remoteUnavailable = true; }
    return this.closeCalls();
  }

  async dispose(): Promise<void> {
    await this.closeCalls();
    if (this.requests.size) throw new Error('Native screen IPC still owns pending requests.');
    this.disposed = true;
  }
}

export function setupNativeScreenSharingIpc(
  window: BrowserWindow,
  resolveSource: (sourceId: string, kind: NativeScreenCaptureKind) => NativeScreenCaptureTarget,
): NativeScreenSharingIpc {
  const service = new NativeScreenSharingService(window, resolveSource);
  const invoke = async <T>(event: IpcMainInvokeEvent, action: () => Promise<T> | T): Promise<T> => {
    if (!service.owns(event)) {
      console.warn('[NativeScreen] Rejected IPC from a non-owner frame.');
      throw new Error('Native screen IPC requires the owned main frame.');
    }
    try { return await action(); }
    catch (error) {
      const message = errorDetails(error).message;
      console.error('[NativeScreen] IPC operation failed:', message, error);
      if (error instanceof AggregateError) throw new Error(message, { cause: error });
      throw error;
    }
  };
  ipcMain.handle(NATIVE_SCREEN_IPC.invoke, (event, input: unknown) => invoke(event, async (): Promise<NativeScreenCommandResult> => {
    try { return await service.invoke(input); }
    catch (error) {
      if (record(input) && input.action === 'diagnostics' && error instanceof DOMException && error.name === 'AbortError') {
        console.debug('[NativeScreen] Diagnostics superseded by media retirement.');
        return { kind: 'diagnostics-retired' };
      }
      throw error;
    }
  }));
  ipcMain.handle(NATIVE_SCREEN_IPC.reply, (event, input: unknown) => invoke(event, () => service.reply(input)));
  const cleanup = (): void => {
    void service.retireDocument().catch(error => console.error('[NativeScreen] Renderer teardown reported failures:', error));
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
      void service.refreshPreviewVisibility().catch(error =>
        console.error('[NativeScreen] Preview focus update failed:', error));
    });
  };
  app.on('browser-window-focus', focusChanged);
  app.on('browser-window-blur', focusChanged);
  contents.on('did-start-navigation', navigation);
  contents.on('render-process-gone', cleanup);
  contents.on('destroyed', cleanup);
  return {
    async dispose() {
      await service.dispose();
      if (focusUpdate) clearImmediate(focusUpdate);
      app.removeListener('browser-window-focus', focusChanged);
      app.removeListener('browser-window-blur', focusChanged);
      for (const channel of Object.values(NATIVE_SCREEN_IPC)) ipcMain.removeHandler(channel);
      contents.removeListener('did-start-navigation', navigation);
      contents.removeListener('render-process-gone', cleanup);
      contents.removeListener('destroyed', cleanup);
    },
  };
}
