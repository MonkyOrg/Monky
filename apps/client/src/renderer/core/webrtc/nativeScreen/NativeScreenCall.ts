import {
  MessageType, nativeScreenIceServersSchema, nativeScreenProducerSchema, nativeScreenSignalAckSchema, nativeScreenSignalSchema,
  type NativeScreenCall as NativeScreenCallConfig, type NativeScreenCapabilities, type NativeScreenCommand,
  type NativeScreenCommandResult, type NativeScreenEvent, type NativeScreenSignalPayload,
} from '@monky/shared';
import type { ElectronApi } from '../../../../preload/api';
import type { NetworkClient } from '../../NetworkClient';
import type { ParticipantManager } from '../../ParticipantManager';
import { appEvents } from '../../EventBus';
import { emitOutsideRouting } from '../../sessionRouting';
import { clientLog } from '../../ClientLogService';
import { settingsStore } from '../../../stores/settingsStore';
import type { LocalSource } from './LocalScreenSources';
import type { Presentation } from './RemoteScreenPresentations';

export interface NativeScreenCallContext {
  readonly client: NetworkClient;
  readonly participants: ParticipantManager;
  readonly sessionId: string;
  readonly channelId: string;
  readonly mode: 'p2p' | 'sfu';
  readonly isCurrent: () => boolean;
  readonly announceSources: () => void;
}

/** The voice call's screens in Main: what this client publishes, what it watches and the work still running for them. */
export interface Call {
  readonly config: NativeScreenCallConfig;
  readonly context: NativeScreenCallContext;
  readonly connectionId: string;
  readonly api: ElectronApi;
  readonly sources: Map<string, LocalSource>;
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

/** What Main reports about a screen of the call, as opposed to the requests it waits a reply for. */
export type NativeScreenNotice = Exclude<NativeScreenEvent, { requestId: string }>;
export type NativeScreenRequest = Extract<NativeScreenEvent, { requestId: string }>;

/** Where the call's subscriptions hand over what belongs to its sources and presentations. */
export interface NativeScreenCallEvents {
  /** An event or a request from Main for this call. */
  main(call: Call, event: NativeScreenEvent): Promise<void>;
  /** Main stopped presenting a local preview or a remote screen of this call. */
  presentationError(call: Call, event: { presentationId: string | null; message: string }): void;
  /** The browser receiver of a remote screen failed. */
  browserFailed(call: Call, entry: Presentation, error: unknown): void;
  /** An audio output came or went. */
  outputsChanged(call: Call): Promise<void>;
  /** Main retired the call: everything it presented is released. */
  retired(call: Call): Promise<void>;
}

export const keyOf = (sessionId: string, shareId: string): string => `${sessionId}\0${shareId}`;
export const cancelled = (): DOMException => new DOMException('The native screen call was superseded.', 'AbortError');
export const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function reportScreenError(error: unknown): void {
  if (error instanceof Error && error.name === 'AbortError') return;
  clientLog.error('SCREEN_SHARE', 'Native screen operation failed', { error: messageOf(error) });
}

/** The stage and the picker read the native screens again. */
export function announceScreenChange(): void {
  emitOutsideRouting(() => appEvents.emit('native_screen.updated'));
}

export function warnRetirement(result: Extract<NativeScreenCommandResult, { kind: 'retired-with-errors' }>): void {
  clientLog.warn('SCREEN_SHARE', 'Native media retired with cleanup errors',
    { error: result.error, remoteAcknowledged: result.remoteAcknowledged });
}

function nativeScreenApi(): ElectronApi {
  if (typeof window === 'undefined' || !window.api?.nativeScreenCommand)
    throw new Error('The native screen IPC boundary is unavailable.');
  return window.api;
}

/**
 * The call in Main that carries the voice call's screens: joined on first use, followed while the voice
 * call is current and retired once, whatever ends it. Its subscriptions hand what they receive to `events`.
 */
export class NativeScreenCalls {
  private call: Call | null = null;
  private readonly retiring = new Set<Call>();
  private availability: Promise<NativeScreenCapabilities> | null = null;
  private shutdownRequested = false;

  constructor(
    private readonly context: () => NativeScreenCallContext | null,
    private readonly events: NativeScreenCallEvents,
  ) {}

  /** The call joined for the current voice call, until it starts retiring. */
  public get active(): Call | null {
    return this.call;
  }

  public capabilities(): Promise<NativeScreenCapabilities> {
    if (!this.availability) this.availability = nativeScreenApi().nativeScreenCommand({ action: 'capabilities' }).then(result => {
      if (result.kind !== 'capabilities') throw new Error('Invalid native screen capability response.');
      return result.capabilities;
    });
    return this.availability;
  }

  /** Throws an AbortError once `call` stopped being the voice call's current one. */
  public current(call: Call): void {
    if (this.shutdownRequested || call.stopping || this.call !== call || !call.context.isCurrent()) throw cancelled();
  }

  public networkCurrent(call: Call): boolean {
    return call.context.client.getStatus() === 'CONNECTED'
      && call.context.client.getConnectionId() === call.connectionId;
  }

  /** Runs a command of the current call; the call retires only after the commands it admitted finish. */
  public async ok(call: Call, command: NativeScreenCommand): Promise<void> {
    this.current(call);
    const work = call.api.nativeScreenCommand(command);
    call.controls.add(work);
    let result: NativeScreenCommandResult;
    try { result = await work; }
    finally { call.controls.delete(work); }
    if (result.kind === 'retired-with-errors' && (command.action === 'source-remove' || command.action === 'stop')) {
      warnRetirement(result);
      return;
    }
    if (result.kind !== 'ok') throw new Error(`Unexpected native screen response to ${command.action}.`);
  }

  public async ensure(): Promise<Call> {
    if (this.shutdownRequested) throw cancelled();
    if (this.call && !this.call.context.isCurrent()) await this.close();
    let call = this.call;
    if (!call) {
      await Promise.all([...this.retiring].map(retiring => this.retire(retiring)));
      if (this.shutdownRequested) throw cancelled();
      // A concurrent source/Watch may have created the call while cleanup awaited.
      if (this.call) return this.ensure();
      const context = this.context();
      if (!context || !context.isCurrent()) throw cancelled();
      call = this.join(context);
    }
    try {
      await call.ready;
      this.current(call);
      return call;
    } catch (error) {
      try { await this.retire(call); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Native call admission and retirement failed.'); }
      throw error;
    }
  }

  private join(context: NativeScreenCallContext): Call {
    const api = nativeScreenApi();
    const config: NativeScreenCallConfig = {
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
      if (event.callId === config.callId) void this.events.main(call, event).catch(reportScreenError);
    }));
    call.unbind.push(api.onNativeScreenPresentationError(event => this.events.presentationError(call, event)));
    call.unbind.push(context.client.onEvent((event, value) => {
      if (event === 'network.status' && !this.networkCurrent(call)) {
        void this.retire(call).catch(reportScreenError);
      } else if (!call.stopping && context.isCurrent()) {
        void this.handleNetworkEvent(call, event, value).catch(reportScreenError);
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
      void call.ready.then(() => this.syncPreviewPreference(call)).catch(reportScreenError);
    }));
    const followOutputs = (): void => { void this.events.outputsChanged(call).catch(reportScreenError); };
    navigator.mediaDevices?.addEventListener('devicechange', followOutputs);
    call.unbind.push(() => navigator.mediaDevices?.removeEventListener('devicechange', followOutputs));
    return call;
  }

  public updateRoster(call: Call): Promise<void> {
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

  /** Screen signaling and SFU producers from the server reach Main, or the browser receiver of their screen. */
  private async handleNetworkEvent(call: Call, event: string, value: unknown): Promise<void> {
    if (event === `message.${MessageType.NATIVE_SCREEN_SIGNAL}`) {
      const signal = nativeScreenSignalSchema.parse(value);
      if (signal.channelId !== call.config.channelId || signal.targetSessionId !== call.config.sessionId) return;
      await call.ready;
      // Main applies a roster as soon as it receives it, and this IPC is FIFO: dispatching the latest
      // roster first is enough. Awaiting the viewers it retires would hold every signal for seconds,
      // reorder signals across rosters and drop them when a retirement fails.
      const previousRoster = call.rosterTask;
      const roster = this.updateRoster(call);
      if (roster !== previousRoster) void roster.catch(reportScreenError);
      const entry = call.presentations.get(keyOf(signal.publisherSessionId, signal.shareId));
      if (entry?.browser && entry.source.instanceId === signal.sourceInstanceId) {
        try { await entry.browser.receive(signal); }
        catch (error) { this.events.browserFailed(call, entry, error); }
      } else await this.ok(call, { action: 'signal', callId: call.config.callId, signal });
    } else if (event === `message.${MessageType.SFU_NEW_PRODUCER}`) {
      const parsed = nativeScreenProducerSchema.safeParse(value);
      if (!parsed.success || parsed.data.channelId !== call.config.channelId) return;
      await call.ready;
      this.current(call);
      await Promise.all([
        this.ok(call, { action: 'producer', callId: call.config.callId, producer: parsed.data }),
        ...[...call.presentations.values()].flatMap(entry => entry.browser && !entry.stopping
          ? [entry.browser.addProducer(parsed.data).catch(error => this.events.browserFailed(call, entry, error))] : []),
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
          ? [entry.browser.removeProducer(producerId).catch(error => this.events.browserFailed(call, entry, error))] : []),
      ]);
    }
  }

  public async sendSignal(call: Call, signal: NativeScreenSignalPayload): Promise<void> {
    if (!this.networkCurrent(call)) throw new Error('The original signaling connection is unavailable.');
    const ack = nativeScreenSignalAckSchema.parse(await call.context.client.sendRequest<unknown>(MessageType.NATIVE_SCREEN_SIGNAL, signal));
    if (ack.subscriptionId !== signal.subscriptionId) throw new Error('Screen signaling acknowledged another subscription.');
  }

  public prepareShutdown(): Promise<void> {
    this.shutdownRequested = true;
    return this.close();
  }

  public close(): Promise<void> {
    return this.call ? this.retire(this.call) : Promise.all([...this.retiring].map(call => this.retire(call))).then(() => {});
  }

  public retire(call: Call): Promise<void> {
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
          reportScreenError(error);
          result = await call.api.nativeScreenCommand({ action: 'leave-local', callId: call.config.callId });
        }
      } else result = await call.api.nativeScreenCommand({ action: 'leave-local', callId: call.config.callId });
      if (result.kind === 'retired-with-errors')
        warnRetirement(result);
      else if (result.kind !== 'ok') throw new Error('Native call retirement returned an invalid acknowledgement.');
      await Promise.allSettled([call.ready, ...call.watchTasks.values(), ...call.sourceTasks.values(),
        ...[...call.sources.values()].map(source => source.ready)]);
      await this.events.retired(call);
      for (const unbind of call.unbind.splice(0)) unbind();
      this.retiring.delete(call);
      announceScreenChange();
    })();
    void call.retirement.catch(() => { call.retirement = undefined; });
    return call.retirement;
  }
}
