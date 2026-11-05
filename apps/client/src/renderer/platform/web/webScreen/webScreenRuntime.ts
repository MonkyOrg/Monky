import {
  SCREEN_SHARE_LIMITS, browserScreenCommandSchema, nativeScreenCallSchema, nativeScreenPresentationSchema,
  nativeScreenSignalSchema, nativeScreenSourceSchema,
  type NativeScreenCall, type NativeScreenCapabilities, type NativeScreenCommandResult, type NativeScreenEvent,
  type NativeScreenParticipant, type NativeScreenPresentation, type NativeScreenSignalPayload, type NativeScreenSource,
} from '@monky/shared';
import type { PlatformApi } from '../../api';
import { browserScreenFormats, browserScreenProfile } from './browserScreenProfile';
import { DisplayCaptures, type DisplayCapture } from './displayCaptures';
import { WebScreenBridge } from './webScreenBridge';
import { WebScreenPublisher } from './webScreenPublisher';

type Command = ReturnType<typeof browserScreenCommandSchema.parse>;
type CommandOf<A extends Command['action']> = Extract<Command, { action: A }>;

interface WebSource {
  readonly source: NativeScreenSource;
  readonly capture: DisplayCapture;
  readonly publisher: WebScreenPublisher;
  retirement: Promise<void> | null;
}

interface WebCall {
  readonly config: NativeScreenCall;
  participants: Map<string, NativeScreenParticipant>;
  readonly sources: Map<string, WebSource>;
  /** Shares whose admission is still running. */
  readonly admitting: Set<string>;
  stopping: boolean;
  retirement: Promise<void> | null;
}

interface Preview {
  readonly element: HTMLVideoElement;
  readonly stream: MediaStream;
  track: MediaStreamTrack | null;
}

const cancelled = (): DOMException => new DOMException('The screen call was retired.', 'AbortError');
const sourceLost = (): Error => Object.assign(new Error('The browser capture is no longer available.'),
  { code: 'ERR_SCREEN_CAPTURE_SOURCE_LOST' });
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 4096)
  || 'Screen retirement failed.';

/** What a browser tab can do with screens: capture through its own dialog and send; receiving is the browser receiver's. */
export function webScreenCapabilities(): NativeScreenCapabilities {
  const display = typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function';
  const formats = typeof RTCRtpSender === 'undefined' ? [] : browserScreenFormats(RTCRtpSender.getCapabilities('video')?.codecs ?? []);
  const capture = display && formats.length > 0;
  // Only Chromium shares a tab's or the system's sound, and only Chromium lists this constraint.
  const captureAudio = capture && 'suppressLocalAudioPlayback' in navigator.mediaDevices.getSupportedConstraints();
  return {
    capture, captureAudio, receive: false, captureKinds: capture ? ['window', 'monitor'] : [], backend: null,
    reason: !display ? 'platform' : !formats.length ? 'encoder' : null, browserFormats: capture ? formats : [],
  };
}

/**
 * The web version's screen runtime (#858): it answers the same commands and raises the same events as
 * the desktop's native runtime, so the renderer's screen calls, sources and viewers work unchanged above
 * it. It publishes browser captures (P2P or through the SFU); watching uses the browser receiver.
 */
export class WebScreenRuntime {
  private readonly bridge = new WebScreenBridge();
  private readonly captures = new DisplayCaptures();
  private readonly calls = new Map<string, WebCall>();
  private readonly previews = new Map<string, Preview>();
  /** Which screen instance each local preview shows. */
  private readonly previewSource = new Map<string, string>();
  private availability: NativeScreenCapabilities | null = null;

  constructor() {
    this.captures.onEnded(capture => { void this.captureEnded(capture); });
  }

  private capabilities(): NativeScreenCapabilities {
    this.availability ??= webScreenCapabilities();
    return this.availability;
  }

  public api(): Pick<PlatformApi, 'nativeScreenCommand' | 'nativeScreenReply' | 'onNativeScreenEvent'
    | 'attachNativeScreenPreview' | 'stopNativeScreenPresentation' | 'sampleNativeScreenPresentation'
    | 'onNativeScreenPresentationError' | 'captureDisplay' | 'releaseScreenCapture'> {
    return {
      nativeScreenCommand: command => this.command(command),
      nativeScreenReply: reply => {
        this.bridge.reply(reply);
        return Promise.resolve();
      },
      onNativeScreenEvent: callback => this.bridge.subscribe(callback),
      attachNativeScreenPreview: input => this.attachPreview(input),
      stopNativeScreenPresentation: presentationId => {
        this.stopPreview(presentationId);
        return Promise.resolve();
      },
      sampleNativeScreenPresentation: () => Promise.resolve(null),
      // A preview here is a plain copy of the capture: none fails on its own.
      onNativeScreenPresentationError: () => () => {},
      captureDisplay: request => this.captures.capture(request),
      releaseScreenCapture: sourceId => this.captures.release(sourceId),
    };
  }

  private emit(event: NativeScreenEvent): void {
    this.bridge.emit(event);
  }

  private async command(value: unknown): Promise<NativeScreenCommandResult> {
    const command = browserScreenCommandSchema.parse(value);
    switch (command.action) {
      case 'capabilities': return { kind: 'capabilities', capabilities: this.capabilities() };
      case 'probe-encoding': throw new Error('A browser chooses its own screen encoder.');
      case 'cancel-encoding-probe': return { kind: 'ok' };
      case 'join': return this.join(command);
      case 'leave':
      case 'leave-local': return this.leave(command);
      default: break;
    }
    const call = this.callFor(command.callId);
    switch (command.action) {
      case 'participants':
        await this.updateParticipants(call, command.participants);
        return { kind: 'ok' };
      case 'source-add': return this.addSource(call, command);
      case 'source-remove': {
        const entry = call.sources.get(command.shareId);
        if (entry) {
          try { await this.retireSource(call, entry); }
          catch (error) { return { kind: 'retired-with-errors', remoteAcknowledged: true, error: errorText(error) }; }
        }
        return { kind: 'ok' };
      }
      case 'preview-preferences': return { kind: 'ok' };
      case 'preview-start': return this.startPreview(call, command);
      case 'watch': throw new Error('This browser watches screens with its own receiver.');
      case 'watch-audio': throw cancelled();
      case 'stop': return { kind: 'ok' };
      case 'signal':
        await this.receiveSignal(call, command.signal);
        return { kind: 'ok' };
      case 'producer':
        if (command.producer.channelId !== call.config.channelId) throw new Error('The screen producer belongs to another call.');
        return { kind: 'ok' };
      case 'producer-remove': return { kind: 'ok' };
      case 'stats':
        return { kind: 'stats', subscriptions: [], publishers: [...call.sources.values()].map(entry => ({
          source: entry.source, viewers: entry.publisher.viewerCount, renditions: entry.publisher.renditions(),
        })) };
      case 'diagnostics': {
        const entry = command.publisherSessionId === call.config.sessionId ? call.sources.get(command.shareId) : undefined;
        if (!entry || entry.retirement || entry.source.instanceId !== command.sourceInstanceId || command.presentationId)
          return { kind: 'diagnostics-retired' };
        return { kind: 'diagnostics', sourceInstanceId: entry.source.instanceId, presentationId: null,
          viewers: entry.publisher.viewerCount, endpoints: entry.publisher.renditions().map(rendition => ({
            pipelineId: rendition.pipelineId, profile: { ...rendition.profile }, readErrors: 0, rtp: [], decoders: [],
          })) };
      }
    }
  }

  private callFor(callId: string): WebCall {
    const call = this.calls.get(callId);
    if (!call || call.stopping) throw cancelled();
    return call;
  }

  private join(command: CommandOf<'join'>): NativeScreenCommandResult {
    const { action: _action, ...value } = command;
    const config = nativeScreenCallSchema.parse(value);
    const previous = this.calls.get(config.callId);
    if (previous) {
      if (previous.stopping) throw cancelled();
      if (JSON.stringify(previous.config) !== JSON.stringify(config)) throw new Error('A screen call cannot change in place.');
      return { kind: 'ok' };
    }
    if (this.calls.size >= 2) throw new Error('A previous screen call still owns media.');
    this.calls.set(config.callId, {
      config, participants: new Map(), sources: new Map(), admitting: new Set(), stopping: false, retirement: null,
    });
    return { kind: 'ok' };
  }

  private async leave(command: CommandOf<'leave' | 'leave-local'>): Promise<NativeScreenCommandResult> {
    const call = this.calls.get(command.callId);
    if (!call) return { kind: 'ok' };
    // Without the server nobody can acknowledge the viewers' goodbye.
    if (command.action === 'leave-local') this.bridge.rejectCall(call.config.callId);
    try { await this.closeCall(call); }
    catch (error) {
      return { kind: 'retired-with-errors', remoteAcknowledged: command.action === 'leave', error: errorText(error) };
    }
    return { kind: 'ok' };
  }

  private closeCall(call: WebCall): Promise<void> {
    if (call.retirement) return call.retirement;
    call.stopping = true;
    call.retirement = (async () => {
      try {
        const results = await Promise.allSettled([...call.sources.values()].map(entry => this.retireSource(call, entry)));
        const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
        if (errors.length) throw new AggregateError(errors, 'The screen call did not retire cleanly.');
      } finally {
        this.bridge.rejectCall(call.config.callId);
        if (this.calls.get(call.config.callId) === call) this.calls.delete(call.config.callId);
      }
    })();
    return call.retirement;
  }

  private async updateParticipants(call: WebCall, participants: readonly NativeScreenParticipant[]): Promise<void> {
    call.participants = new Map(participants.map(participant => [participant.sessionId, participant]));
    const sessionIds = participants.map(participant => participant.sessionId);
    const results = await Promise.allSettled([...call.sources.values()].map(entry => entry.publisher.setParticipants(sessionIds)));
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, 'Screen viewers who left did not retire.');
  }

  private async addSource(call: WebCall, command: CommandOf<'source-add'>): Promise<NativeScreenCommandResult> {
    const capabilities = this.capabilities();
    if (!capabilities.capture) throw new Error(`Screen capture is unavailable: ${capabilities.reason}.`);
    const previous = call.sources.get(command.shareId);
    const replacement = command.replacesSourceInstanceId === undefined ? undefined : previous;
    if (command.replacesSourceInstanceId !== undefined && (!replacement || replacement.retirement
      || replacement.source.instanceId !== command.replacesSourceInstanceId
      || replacement.capture.sourceId !== command.desktopSourceId
      // A replacement may give up its audio (#253), never acquire it.
      || (command.audio && !replacement.source.audio) || command.replacesAudioShareIds !== undefined))
      throw new Error('A quality replacement must name the exact existing source and its capture.');
    if ((previous && !replacement) || call.admitting.has(command.shareId)
      || call.sources.size + call.admitting.size - (replacement ? 1 : 0) >= SCREEN_SHARE_LIMITS.maximum)
      throw new Error('The screen source already exists or exceeds the screen limit.');
    if (command.replacesAudioShareIds && (!command.audio
      || command.replacesAudioShareIds.some(shareId => !call.sources.get(shareId)?.source.audio)))
      throw new Error('An audio handover must name audible screens of this call.');
    const capture = this.captures.get(command.desktopSourceId);
    if (!capture || capture.ended) throw sourceLost();
    if ([...call.sources.values()].some(entry => entry !== replacement && entry.capture === capture))
      throw new Error('Another screen already shares this capture.');
    if ((command.captureKind ?? 'window') !== capture.captureKind)
      throw new Error('The capture kind does not match what the browser captured.');
    if (command.audio && (!capture.audioTrack || !capabilities.captureAudio))
      throw new Error('The browser did not share sound with this capture.');
    // The compatible format unless the publisher chose a better one this browser encodes; both are H.264.
    const format = command.browserFormat ?? 'compatible';
    if (!capabilities.browserFormats?.includes(format)) throw new Error(`This browser cannot share in the ${format} format.`);
    call.admitting.add(command.shareId);
    try {
      if (replacement) await this.retireSource(call, replacement);
      if (call.stopping || this.calls.get(call.config.callId) !== call) throw cancelled();
      if (capture.ended) throw sourceLost();
      const source = nativeScreenSourceSchema.parse({
        shareId: command.shareId, instanceId: crypto.randomUUID(),
        video: browserScreenProfile(command.video, capture.video.getSettings()), audio: command.audio, codec: 'h264',
      });
      const publisher = new WebScreenPublisher({
        call: call.config, source, format, capture, audioBitrateKbps: command.audioBitrateKbps,
        signal: signal => this.bridge.signal(call.config.callId, signal),
        rpc: (method, payload) => this.bridge.rpc(call.config.callId, call.config.channelId, method, payload),
        onError: error => console.warn('[WebScreen] A screen viewer failed:', error),
      });
      call.sources.set(source.shareId, { source, capture, publisher, retirement: null });
      await publisher.setParticipants([...call.participants.keys()]);
      return { kind: 'source', source };
    } finally { call.admitting.delete(command.shareId); }
  }

  /** Ends a published screen: viewers learn why, its renditions stop, and the renderer is told it closed. */
  private retireSource(call: WebCall, entry: WebSource): Promise<void> {
    if (entry.retirement) return entry.retirement;
    entry.retirement = (async () => {
      try { await entry.publisher.close('source-unavailable'); }
      finally {
        for (const [presentationId, preview] of this.previews) {
          if (preview.track && this.previewSource.get(presentationId) === entry.source.instanceId) this.stopPreview(presentationId);
        }
        if (call.sources.get(entry.source.shareId) === entry) call.sources.delete(entry.source.shareId);
        this.emit({ type: 'state', callId: call.config.callId, publisherSessionId: call.config.sessionId,
          shareId: entry.source.shareId, sourceInstanceId: entry.source.instanceId, state: 'closed' });
      }
    })();
    return entry.retirement;
  }

  /** The browser ended a capture on its own: every screen showing it ends too. */
  private async captureEnded(capture: DisplayCapture): Promise<void> {
    for (const call of this.calls.values()) {
      for (const entry of call.sources.values()) {
        if (entry.capture !== capture) continue;
        try { await this.retireSource(call, entry); }
        catch (error) { console.warn('[WebScreen] An ended capture did not retire cleanly:', error); }
      }
    }
  }

  private async receiveSignal(call: WebCall, value: NativeScreenSignalPayload): Promise<void> {
    const signal = nativeScreenSignalSchema.parse(value);
    if (signal.targetSessionId !== call.config.sessionId || signal.channelId !== call.config.channelId)
      throw new Error('The screen signal belongs to another call.');
    // Signals of screens this tab watches go to its browser receivers before reaching here.
    if (signal.publisherSessionId !== call.config.sessionId) return;
    const entry = call.sources.get(signal.shareId);
    if (entry && !entry.retirement && entry.source.instanceId === signal.sourceInstanceId) {
      if (!call.participants.has(signal.fromSessionId)) throw new Error('The screen viewer is not in the call.');
      await entry.publisher.receive(signal);
    } else if (signal.action === 'watch') {
      await this.bridge.signal(call.config.callId, nativeScreenSignalSchema.parse({
        action: 'closed', reason: 'source-unavailable', fromSessionId: call.config.sessionId,
        targetSessionId: signal.fromSessionId, publisherSessionId: call.config.sessionId, channelId: call.config.channelId,
        shareId: signal.shareId, sourceInstanceId: signal.sourceInstanceId, subscriptionId: signal.subscriptionId,
      }));
    }
  }

  private attachPreview(input: NativeScreenPresentation): Promise<void> {
    const { presentationId, elementId } = nativeScreenPresentationSchema.parse(input);
    const element = document.getElementById(elementId);
    if (!(element instanceof HTMLVideoElement)) return Promise.reject(new Error('The screen preview has no video element.'));
    if (this.previews.has(presentationId)) return Promise.reject(new Error('The screen preview already exists.'));
    const stream = new MediaStream();
    element.muted = true;
    element.srcObject = stream;
    this.previews.set(presentationId, { element, stream, track: null });
    return Promise.resolve();
  }

  private startPreview(call: WebCall, command: CommandOf<'preview-start'>): NativeScreenCommandResult {
    const entry = call.sources.get(command.shareId);
    const preview = this.previews.get(command.presentationId);
    if (!entry || entry.retirement || entry.source.instanceId !== command.sourceInstanceId || !preview) throw cancelled();
    if (preview.track || [...this.previewSource.values()].includes(entry.source.instanceId))
      throw new Error('This screen already has a local preview.');
    if (entry.capture.ended) throw sourceLost();
    // A copy of the capture, so ending the preview never ends what viewers receive.
    preview.track = entry.capture.video.clone();
    preview.stream.addTrack(preview.track);
    this.previewSource.set(command.presentationId, entry.source.instanceId);
    this.emit({ type: 'preview-state', callId: call.config.callId, publisherSessionId: call.config.sessionId,
      shareId: entry.source.shareId, sourceInstanceId: entry.source.instanceId, state: 'playing' });
    return { kind: 'ok' };
  }

  private stopPreview(presentationId: string): void {
    const preview = this.previews.get(presentationId);
    if (!preview) return;
    this.previews.delete(presentationId);
    this.previewSource.delete(presentationId);
    preview.track?.stop();
    if (preview.element.srcObject === preview.stream) preview.element.srcObject = null;
  }
}
