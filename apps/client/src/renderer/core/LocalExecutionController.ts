import {
  LIMITS,
  LOCAL_EXECUTION_PROTOCOL_LIMITS,
  LOCAL_PERMISSION_LIMITS,
  MessageType,
  commandFinishedSchema,
  commandLocalMetadataSchema,
  localCommandPreparationSchema,
  localExecutionSubjectSchema,
  localMediaSignalSchema,
  localPreviewReferenceSchema,
  localTaskAcceptMatchesOffer,
  localTaskAcceptSchema,
  localTaskControlSchema,
  localTaskEventSchema,
  localTaskOfferSchema,
  localTaskResultSchema,
  toLocalCommandPreparation,
  type LocalBotIdentity,
  type LocalCapabilityId,
  type LocalCommandPreparation,
  type LocalConnectionState,
  type LocalExecutionFailure,
  type LocalExecutionFailureDetails,
  type LocalExecutionMutationResult,
  type LocalExecutionSnapshot,
  type LocalExecutionSubject,
  type LocalPreparationResult,
  type LocalMediaSignal,
  type LocalPreviewReference,
  type LocalRequestContext,
  type LocalRuntimeSourceFailure,
  type LocalTaskEvent,
  type LocalTaskOffer,
  type LocalTaskResult,
  type LocalWireTaskResult,
} from '@monky/shared';
import { v4 as uuidv4 } from 'uuid';
import type { NetworkClient } from './NetworkClient';
import type { ServerStore } from '../stores/serverStore';
import { clientLog } from './ClientLogService';
import { LocalPreviewStore, type LocalPreviewContext } from './LocalPreviewStore';
import { LocalAudioSender, type LocalAudioSenderOptions, type LocalAudioSenderTransport } from './LocalAudioSender';
import { appEvents } from './EventBus';
import { emitOutsideRouting } from './sessionRouting';
import {
  getLocalExecutionApi, localFailure, LocalExecutionError, observeWithSignal, requireLocalMutation, toLocalExecutionError,
  type LocalExecutionApi,
} from './localExecutionSupport';

export interface PreparedLocalCapability {
  capability: LocalCapabilityId;
  permit: string;
  subject: LocalExecutionSubject;
}

type BotIdentity = Pick<LocalBotIdentity, 'botId' | 'botName' | 'botPublicKey'>;
type RequestKind = Exclude<LocalRequestContext['kind'], 'source'>;
type TerminalEvent = Extract<LocalTaskEvent, { state: 'completed' | 'failed' | 'cancelled' }>;

export interface LocalExecutionTaskNotice {
  sessionKey: string;
  taskId: string;
  botName: string;
  serverName: string;
  reason: LocalExecutionFailure;
}

export interface LocalExecutionControllerOptions {
  botIsInVoice?: (botId: string, botSessionId: string, channelId: string) => boolean;
  createSender?: (options: LocalAudioSenderOptions) => LocalAudioSenderTransport;
}

interface CommandRequest {
  requestId: string;
  kind: RequestKind;
  grant: PreparedLocalCapability;
  channelId: string;
  commandName: string;
  invokerId: string;
  invokerSessionId: string;
  invocationId: string | null;
  remoteRequestId: string | null;
  expiry: ReturnType<typeof setTimeout>;
  unbind: () => void;
}

interface ExecutionTask {
  offer: LocalTaskOffer;
  subject: LocalExecutionSubject;
  request: CommandRequest | null;
  controller: AbortController;
  nativeRequestId: string;
  mainTaskId: string | null;
  nativeStarting: boolean;
  sender: LocalAudioSenderTransport | null;
  grant: PreparedLocalCapability | null;
  expiry: ReturnType<typeof setTimeout>;
  accepted: boolean;
  mediaState: 'pending' | 'accepted' | 'ready';
  readyReported: boolean;
  paused: boolean;
  revision: number;
  controlAction: 'pause' | 'resume' | null;
  controls: Promise<void>;
  signals: LocalMediaSignal[];
}

interface Preparation {
  key: string;
  requestId: string;
  controller: AbortController;
  owners: Map<AbortSignal, () => void>;
  promise: Promise<PreparedLocalCapability>;
  state: { settled: boolean; failure?: LocalExecutionFailureDetails & { failedAt: number } };
}

const controllers = new WeakMap<NetworkClient, LocalExecutionController>();

export function localExecutionFor(client: NetworkClient): LocalExecutionController {
  const controller = controllers.get(client);
  if (!controller) throw new LocalExecutionError('executor_unavailable');
  return controller;
}

/** One physical server socket owns its native permits, requests and private media. */
export class LocalExecutionController {
  public readonly previews = new LocalPreviewStore();
  private disposed = false;
  private connectionId: string | null = null;
  private serverUrl: string | null = null;
  private preparations = new Map<string, Preparation>();
  private prepared = new Map<string, PreparedLocalCapability>();
  private unbind: Array<() => void> = [];
  private nativeState: LocalConnectionState | null = null;
  private nativeUpdate: Promise<LocalExecutionMutationResult | null> = Promise.resolve(null);
  private requests = new Map<string, CommandRequest>();
  private tasks = new Map<string, ExecutionTask>();
  private retiredTasks = new Set<string>();
  private earlyNativeFailures = new Map<string, LocalExecutionError>();
  private sourcePreparationFailures = new Map<string, LocalExecutionFailureDetails & { failedAt: number }>();
  private sourceNotices = new Map<string, LocalExecutionFailure>();

  constructor(
    public readonly client: NetworkClient,
    private readonly server: ServerStore,
    private readonly currentVoiceChannel: () => string | null,
    private readonly api: LocalExecutionApi | null = getLocalExecutionApi(),
    private readonly options: LocalExecutionControllerOptions = {},
  ) {
    if (controllers.has(client)) throw new Error('A local execution controller already owns this connection');
    controllers.set(client, this);
    this.unbind.push(client.onEvent((event, data, requestId) => {
      if (event === 'network.status' && client.getStatus() !== 'CONNECTED') this.invalidateConnection();
      else if (event === 'network.connected') this.connected();
      else if (event === 'network.disposed') this.dispose();
      else if (event === `message.${MessageType.BOT_LOCAL_TASK_OFFER}`) this.receiveOffer(data);
      else if (event === `message.${MessageType.BOT_LOCAL_MEDIA_SIGNAL}`) this.receiveSignal(data);
      else if (event === `message.${MessageType.BOT_LOCAL_TASK_CONTROL}`) this.receiveControl(data);
      else if (event === `message.${MessageType.BOT_LOCAL_TASK_EVENT}`) this.receiveTaskEvent(data);
      else if (event === `message.${MessageType.COMMAND_INVOKED}` && requestId) this.acknowledgeRequest(requestId, data);
      else if (event === `message.${MessageType.COMMAND_FINISHED}`) this.invocationFinished(data);
      else if (event === `message.${MessageType.COMMANDS_LIST_RESPONSE}`) this.catalogChanged();
    }));
    if (api) this.unbind.push(
      api.onLocalExecutionChanged((snapshot) => this.permissionsChanged(snapshot)),
      api.onLocalExecutionTaskFailed((failure) => this.nativeTaskFailed(failure.taskId, failure.reason, failure.sourceFailure)),
    );
    if (client.getStatus() === 'CONNECTED') this.connected();
  }

  private connected(): void {
    const connectionId = this.client.getConnectionId();
    if (this.disposed || this.client.getStatus() !== 'CONNECTED') return;
    if (this.connectionId !== connectionId) {
      this.invalidateConnection();
      this.connectionId = connectionId;
    }
    this.serverUrl = this.client.getCurrentServerUrl();
    this.syncVoiceContext();
  }

  public syncVoiceContext(): void {
    if (this.disposed || !this.connectionId || this.client.getStatus() !== 'CONNECTED' ||
      this.client.getConnectionId() !== this.connectionId) return;
    this.setNativeConnection({
      connectionId: this.connectionId, connected: true, voiceChannelId: this.currentVoiceChannel(),
    });
    for (const task of this.tasks.values()) {
      if (task.offer.spec.operation === 'youtube.stream' && !this.hasVoiceContext(task.offer)) {
        this.finishTask(task, { state: 'cancelled', taskId: task.offer.taskId, cause: 'requested' });
      }
    }
  }

  private setNativeConnection(state: LocalConnectionState): void {
    if (!this.api || (this.nativeState?.connectionId === state.connectionId &&
      this.nativeState.connected === state.connected && this.nativeState.voiceChannelId === state.voiceChannelId)) return;
    this.nativeState = state;
    const api = this.api;
    this.nativeUpdate = this.nativeUpdate.then(async () => {
      try {
        return await api.setLocalExecutionConnection(state);
      } catch (error) {
        const failure = toLocalExecutionError(error);
        return {
          status: 'failed', reason: failure.reason,
          ...(failure.sourceFailure ? { sourceFailure: failure.sourceFailure } : {}),
        };
      }
    });
    void this.nativeUpdate.then((result) => {
      if (result && result.status !== 'completed') {
        if (this.nativeState === state) this.nativeState = null;
        clientLog.warn('NETWORK', '[LocalExecution] Native connection synchronization failed', {
          reason: result.status === 'failed' ? result.reason : 'cancelled',
        });
      }
    });
  }

  private subject(bot: BotIdentity): LocalExecutionSubject {
    if (this.disposed || !this.connectionId || this.client.getStatus() !== 'CONNECTED' ||
      this.client.getConnectionId() !== this.connectionId) throw new LocalExecutionError('executor_unavailable');
    const details = this.server.serverDetails;
    const parsed = localExecutionSubjectSchema.safeParse({
      ...bot, connectionId: this.connectionId, serverOrigin: this.client.getCurrentServerUrl(),
      serverId: details?.id, serverName: details?.name,
    });
    if (!parsed.success) throw new LocalExecutionError('invalid_request');
    return parsed.data;
  }

  private isCurrent(subject: LocalExecutionSubject): boolean {
    return !this.disposed && this.connectionId === subject.connectionId &&
      this.client.getStatus() === 'CONNECTED' && this.client.getConnectionId() === subject.connectionId &&
      this.server.serverDetails?.id === subject.serverId &&
      this.client.getCurrentServerUrl() === this.serverUrl;
  }

  public registerRequest(
    kind: RequestKind, requestId: string, grant: PreparedLocalCapability,
    context: { channelId: string; commandName: string; signal?: AbortSignal },
  ): LocalCommandPreparation {
    const user = this.server.currentUser;
    const preparation = localCommandPreparationSchema.safeParse({ capability: grant.capability });
    if (!preparation.success || !/^[a-f0-9]{64}$/.test(grant.permit) || !requestId || requestId.length > 128 || this.requests.has(requestId) ||
      !context.channelId || !context.commandName || !user?.sessionId || !this.isCurrent(grant.subject) ||
      context.signal?.aborted || !this.catalogAllows(grant.subject, grant.capability)) {
      throw new LocalExecutionError('invalid_request');
    }
    if (this.requests.size >= LIMITS.MAX_BOT_AUDIO_PREVIEW_REQUESTS) throw new LocalExecutionError('busy');
    const timeout = kind === 'invocation' ? LIMITS.BOT_INTERACTION_TIMEOUT_MS
      : kind === 'autocomplete' ? LIMITS.BOT_AUTOCOMPLETE_CHOICE_TTL_MS
        : LIMITS.BOT_AUDIO_PREVIEW_TIMEOUT_MS + LIMITS.BOT_AUDIO_PREVIEW_MAX_DURATION_MS;
    const abort = () => this.releaseRequest(requestId);
    const request: CommandRequest = {
      requestId, kind, grant, channelId: context.channelId, commandName: context.commandName,
      invokerId: user.id, invokerSessionId: user.sessionId, invocationId: null, remoteRequestId: null,
      expiry: setTimeout(abort, timeout),
      unbind: () => context.signal?.removeEventListener('abort', abort),
    };
    this.requests.set(requestId, request);
    context.signal?.addEventListener('abort', abort, { once: true });
    if (context.signal?.aborted) abort();
    return toLocalCommandPreparation(preparation.data);
  }

  public acknowledgeRequest(requestId: string, payload: unknown): void {
    const request = this.requests.get(requestId);
    if (!request || request.kind !== 'invocation') return;
    if (!payload || typeof payload !== 'object' ||
      !('invocationId' in payload) || typeof payload.invocationId !== 'string' || !payload.invocationId || payload.invocationId.length > 128 ||
      !('botId' in payload) || payload.botId !== request.grant.subject.botId ||
      !('channelId' in payload) || payload.channelId !== request.channelId ||
      !('commandName' in payload) || payload.commandName !== request.commandName ||
      (request.invocationId !== null && request.invocationId !== payload.invocationId)) {
      this.releaseRequest(requestId);
      this.warn('Invalid local invocation acknowledgement');
      return;
    }
    request.invocationId = payload.invocationId;
  }

  public releaseRequest(requestId: string, cancelActive = true): void {
    const request = this.requests.get(requestId);
    if (!request) return;
    this.requests.delete(requestId);
    clearTimeout(request.expiry);
    request.unbind();
    this.previews.releaseRequest(this.previewContext(request));
    if (cancelActive) {
      for (const task of this.tasks.values()) {
        if (task.request === request) {
          this.finishTask(task, { state: 'cancelled', taskId: task.offer.taskId, cause: 'requested' });
        }
      }
    }
  }

  public resolvePreview(
    reference: LocalPreviewReference, requestId: string, signal: AbortSignal,
  ): Extract<LocalTaskResult, { operation: 'youtube.preview' }> {
    const parsed = localPreviewReferenceSchema.safeParse(reference);
    const request = this.requests.get(requestId);
    if (!parsed.success || signal.aborted || !request || request.kind !== 'audio-preview' ||
      parsed.data.requestId !== requestId || parsed.data.executorSessionId !== request.invokerSessionId ||
      !this.requestIsCurrent(request)) throw new LocalExecutionError('permission_denied');
    return this.previews.take(parsed.data.localPreviewId, this.previewContext(request), parsed.data.taskId);
  }

  private previewContext(request: CommandRequest): LocalPreviewContext {
    return {
      connectionId: request.grant.subject.connectionId, botId: request.grant.subject.botId,
      botPublicKey: request.grant.subject.botPublicKey, requestId: request.requestId,
    };
  }

  private catalogAllows(bot: BotIdentity, capability: LocalCapabilityId): boolean {
    return this.server.slashCommands.some((command) => {
      if (command.botId !== bot.botId || !command.localCapabilities?.includes(capability)) return false;
      const metadata = commandLocalMetadataSchema.safeParse({
        localCapabilities: command.localCapabilities, botPublicKey: command.botPublicKey,
      });
      return metadata.success && metadata.data.botPublicKey === bot.botPublicKey;
    });
  }

  private catalogChanged(): void {
    for (const task of this.tasks.values()) {
      if (!this.catalogAllows(task.subject, task.offer.capability)) this.failTask(task, 'permission_revoked');
    }
    for (const request of this.requests.values()) {
      if (!this.catalogAllows(request.grant.subject, request.grant.capability)) this.releaseRequest(request.requestId);
    }
  }

  private requestIsCurrent(request: CommandRequest): boolean {
    return this.requests.get(request.requestId) === request && this.isCurrent(request.grant.subject) &&
      this.server.currentUser?.id === request.invokerId && this.server.currentUser.sessionId === request.invokerSessionId &&
      this.catalogAllows(request.grant.subject, request.grant.capability);
  }

  private hasVoiceContext(offer: LocalTaskOffer): boolean {
    return !!offer.voiceChannelId && this.currentVoiceChannel() === offer.voiceChannelId &&
      this.options.botIsInVoice?.(offer.bot.botId, offer.botSessionId, offer.voiceChannelId) === true;
  }

  private requestForOffer(offer: LocalTaskOffer, subject: LocalExecutionSubject): CommandRequest | null {
    if (offer.context.kind === 'source') return null;
    const request = this.requests.get(offer.requestId);
    if (!request || request.kind !== offer.context.kind || !this.requestIsCurrent(request) ||
      request.grant.subject.connectionId !== subject.connectionId || request.grant.subject.botId !== subject.botId ||
      request.grant.subject.botPublicKey !== subject.botPublicKey || request.grant.capability !== offer.capability) {
      throw new LocalExecutionError('permission_denied');
    }
    if (offer.context.kind === 'invocation') {
      if (request.invocationId !== null && request.invocationId !== offer.context.invocationId) {
        throw new LocalExecutionError('permission_denied');
      }
      request.invocationId = offer.context.invocationId;
    } else {
      if (request.remoteRequestId !== null && request.remoteRequestId !== offer.context.requestId) {
        throw new LocalExecutionError('permission_denied');
      }
      request.remoteRequestId = offer.context.requestId;
    }
    return request;
  }

  private receiveOffer(payload: unknown): void {
    const parsed = localTaskOfferSchema.safeParse(payload);
    if (!parsed.success) { this.warn('Invalid local task offer'); return; }
    const offer = parsed.data;
    if (this.disposed || this.retiredTasks.has(offer.taskId)) return;
    if (!this.connectionId || this.client.getStatus() !== 'CONNECTED' || this.client.getConnectionId() !== this.connectionId) {
      this.warn('Local task offer arrived outside its live connection', 'executor_unavailable');
      return;
    }
    const existing = this.tasks.get(offer.taskId);
    if (existing) {
      if (JSON.stringify(existing.offer) !== JSON.stringify(offer)) this.failTask(existing, 'invalid_request');
      return;
    }
    try {
      if (!this.api) throw new LocalExecutionError('executor_unavailable');
      const subject = this.subject(offer.bot);
      if (offer.bot.serverId !== subject.serverId || offer.invokerId !== this.server.currentUser?.id ||
        offer.invokerSessionId !== this.server.currentUser?.sessionId || !this.catalogAllows(subject, offer.capability)) {
        throw new LocalExecutionError('permission_denied');
      }
      if (offer.expiresAt <= Date.now()) throw new LocalExecutionError('timeout');
      if (offer.spec.operation === 'youtube.stream' && !this.hasVoiceContext(offer)) {
        throw new LocalExecutionError('executor_unavailable');
      }
      if (this.tasks.size >= LOCAL_EXECUTION_PROTOCOL_LIMITS.tasksPerExecutor) throw new LocalExecutionError('busy');
      const request = this.requestForOffer(offer, subject);
      if (offer.spec.operation === 'youtube.preview' && request?.kind !== 'audio-preview') {
        throw new LocalExecutionError('invalid_request');
      }
      if (offer.context.kind === 'source' && offer.spec.operation === 'youtube.search') {
        throw new LocalExecutionError('invalid_request');
      }
      const task: ExecutionTask = {
        offer, subject, request, controller: new AbortController(), nativeRequestId: uuidv4(),
        mainTaskId: null, nativeStarting: false, sender: null, grant: request?.grant ?? null,
        accepted: false, mediaState: 'pending', readyReported: false,
        paused: false, revision: -1, controlAction: null, controls: Promise.resolve(), signals: [],
        expiry: setTimeout(() => this.failTask(task, 'timeout'),
          Math.min(offer.expiresAt - Date.now(), LOCAL_EXECUTION_PROTOCOL_LIMITS.taskStartTimeoutMs)),
      };
      this.tasks.set(offer.taskId, task);
      void this.startTask(task);
    } catch (error) {
      this.retireTask(offer.taskId);
      const failure = toLocalExecutionError(error);
      this.sendEvent(this.failureEvent(offer.taskId, failure.reason, failure.sourceFailure));
      this.notifyFailure(offer, failure.reason);
    }
  }

  private taskIsCurrent(task: ExecutionTask): boolean {
    return this.tasks.get(task.offer.taskId) === task && !task.controller.signal.aborted &&
      this.isCurrent(task.subject) && this.server.currentUser?.id === task.offer.invokerId &&
      this.server.currentUser.sessionId === task.offer.invokerSessionId &&
      this.catalogAllows(task.subject, task.offer.capability) &&
      (task.offer.spec.operation !== 'youtube.stream' || this.hasVoiceContext(task.offer));
  }

  private assertTaskCurrent(task: ExecutionTask): void {
    if (!this.taskIsCurrent(task)) throw new LocalExecutionError('cancelled');
    if (!task.accepted && task.offer.expiresAt <= Date.now()) throw new LocalExecutionError('timeout');
  }

  private async startTask(task: ExecutionTask): Promise<void> {
    const api = this.api;
    if (!api) { this.failTask(task, 'executor_unavailable'); return; }
    try {
      this.assertTaskCurrent(task);
      const preparationKey = this.preparationKey(task.subject, task.offer.capability);
      const previousFailure = task.offer.context.kind === 'source' ? this.sourcePreparationFailures.get(preparationKey) : undefined;
      if (previousFailure) throw new LocalExecutionError(previousFailure.reason, previousFailure.sourceFailure);
      if (task.offer.context.kind === 'source' && this.sourcePreparationFailures.size >= LOCAL_PERMISSION_LIMITS.entries) {
        throw new LocalExecutionError('busy');
      }
      task.grant ??= await this.prepare(task.offer.bot, task.offer.capability, task.controller.signal);
      this.assertTaskCurrent(task);
      if (task.offer.media) {
        const options: LocalAudioSenderOptions = {
          taskId: task.offer.taskId, media: task.offer.media, api,
          sendSignal: (signal) => {
            this.assertTaskCurrent(task);
            this.client.send(MessageType.BOT_LOCAL_MEDIA_SIGNAL, signal);
          },
          onFailure: (reason, sourceFailure) => this.failTask(
            task, reason === 'timeout' && !task.mainTaskId ? 'transport_failed' : reason, sourceFailure,
          ),
          onDrained: (playedFrames) => {
            if (!this.taskIsCurrent(task) || task.mediaState !== 'ready' || !task.offer.media) return;
            this.finishTask(task, {
              state: 'completed', taskId: task.offer.taskId,
              mediaGeneration: task.offer.media.generation, playedFrames,
            });
          },
        };
        task.sender = this.options.createSender?.(options) ?? new LocalAudioSender(options);
        const connected = observeWithSignal(task.sender.connect(), task.controller.signal);
        for (const signal of task.signals.splice(0)) {
          void task.sender.acceptSignal(signal).catch((error: unknown) => this.failTaskError(task, error));
        }
        await connected;
        this.assertTaskCurrent(task);
      }
      this.syncVoiceContext();
      const connection = await observeWithSignal(this.nativeUpdate, task.controller.signal);
      if (!connection) throw new LocalExecutionError('executor_unavailable');
      requireLocalMutation(connection);
      this.assertTaskCurrent(task);
      task.nativeStarting = true;
      const result = await api.startLocalExecutionTask({
        requestId: task.nativeRequestId, permit: task.grant.permit, spec: task.offer.spec,
        ...(task.offer.voiceChannelId ? { voiceChannelId: task.offer.voiceChannelId } : {}),
      });
      task.nativeStarting = false;
      if (result.status === 'failed') throw new LocalExecutionError(result.reason, result.sourceFailure);
      if (result.status === 'cancelled') throw new LocalExecutionError('cancelled');
      task.mainTaskId = result.taskId;
      if (!this.taskIsCurrent(task)) {
        if (this.tasks.get(task.offer.taskId) === task) {
          this.finishTask(task, { state: 'cancelled', taskId: task.offer.taskId, cause: 'requested' });
        } else if (task.offer.spec.operation === 'youtube.stream') this.cancelNativeTask(result.taskId);
        return;
      }
      const earlyFailure = this.earlyNativeFailures.get(result.taskId);
      this.earlyNativeFailures.delete(result.taskId);
      if (earlyFailure) throw earlyFailure;
      const nativeResult = localTaskResultSchema.safeParse(result.result);
      if (!nativeResult.success) throw new LocalExecutionError('invalid_request');
      let wireResult: LocalWireTaskResult;
      if (nativeResult.data.operation === 'youtube.preview') {
        if (!task.request || !this.requestIsCurrent(task.request)) throw new LocalExecutionError('cancelled');
        wireResult = {
          operation: 'youtube.preview',
          localPreviewId: this.previews.put(this.previewContext(task.request), task.offer.taskId, nativeResult.data),
          taskId: task.offer.taskId, requestId: task.offer.requestId, executorSessionId: task.offer.invokerSessionId,
        };
      } else wireResult = nativeResult.data;
      const accept = localTaskAcceptSchema.safeParse({ taskId: task.offer.taskId, result: wireResult });
      if (!accept.success || !localTaskAcceptMatchesOffer(task.offer, accept.data)) throw new LocalExecutionError('invalid_request');
      this.assertTaskCurrent(task);
      task.accepted = true;
      this.client.send(MessageType.BOT_LOCAL_TASK_ACCEPT, accept.data);
      if (task.sender && task.offer.media) {
        await task.sender.setPaused(task.paused);
        this.assertTaskCurrent(task);
        task.sender.start(result.taskId);
        task.readyReported = true;
        this.sendEvent({ state: 'ready', taskId: task.offer.taskId, mediaGeneration: task.offer.media.generation });
      } else this.finishTask(task, { state: 'completed', taskId: task.offer.taskId });
    } catch (error) {
      const failure = toLocalExecutionError(error);
      if (task.offer.context.kind === 'source' && !task.grant && this.taskIsCurrent(task) &&
        this.sourcePreparationFailures.size < LOCAL_PERMISSION_LIMITS.entries) {
        // Retried source work is not another user gesture to reopen a consent dialog.
        const key = this.preparationKey(task.subject, task.offer.capability);
        if (!this.sourcePreparationFailures.has(key)) {
          this.sourcePreparationFailures.set(key, {
            reason: failure.reason, failedAt: Date.now(),
            ...(failure.sourceFailure ? { sourceFailure: failure.sourceFailure } : {}),
          });
        }
      }
      this.failTask(task, failure.reason, failure.sourceFailure);
    } finally {
      task.nativeStarting = false;
      if (![...this.tasks.values()].some((candidate) => candidate.nativeStarting)) this.earlyNativeFailures.clear();
    }
  }

  private receiveSignal(payload: unknown): void {
    const parsed = localMediaSignalSchema.safeParse(payload);
    if (!parsed.success) {
      this.failMalformedTask(payload, 'Invalid local media signal');
      return;
    }
    const signal = parsed.data;
    const task = this.tasks.get(signal.taskId);
    if (!task || task.offer.media?.generation !== signal.mediaGeneration) return;
    if (signal.signal.signalType === 'offer') { this.failTask(task, 'transport_failed'); return; }
    if (!this.taskIsCurrent(task)) { this.failTask(task, 'transport_failed'); return; }
    if (!task.sender) {
      if (task.signals.length >= LOCAL_EXECUTION_PROTOCOL_LIMITS.queuedSignals) this.failTask(task, 'transport_failed');
      else task.signals.push(signal);
      return;
    }
    void task.sender.acceptSignal(signal).catch((error: unknown) => this.failTaskError(task, error));
  }

  private receiveControl(payload: unknown): void {
    const parsed = localTaskControlSchema.safeParse(payload);
    if (!parsed.success) { this.failMalformedTask(payload, 'Invalid local task control'); return; }
    const control = parsed.data;
    const task = this.tasks.get(control.taskId);
    if (!task) {
      if (control.action === 'cancel') this.previews.releaseTask(control.taskId);
      return;
    }
    // Cancellation retires the lease; a newer pause/resume cannot revive it.
    if (control.action === 'cancel') {
      this.finishTask(task, { state: 'cancelled', taskId: control.taskId, cause: 'requested' });
      return;
    }
    if (task.offer.spec.operation !== 'youtube.stream') { this.failTask(task, 'invalid_request'); return; }
    if (control.revision < task.revision) return;
    if (control.revision === task.revision) {
      if (control.action !== task.controlAction) this.failTask(task, 'invalid_request');
      return;
    }
    task.revision = control.revision;
    task.controlAction = control.action;
    task.paused = control.action === 'pause';
    const mutation = task.sender?.setPaused(task.paused) ?? Promise.resolve();
    task.controls = Promise.all([task.controls, mutation]).then(() => {
      if (!this.taskIsCurrent(task) || task.revision !== control.revision) return;
      this.sendEvent({
        state: control.action === 'pause' ? 'paused' : 'resumed', taskId: control.taskId, revision: control.revision,
      });
    }).catch((error: unknown) => this.failTaskError(task, error));
  }

  private receiveTaskEvent(payload: unknown): void {
    const parsed = localTaskEventSchema.safeParse(payload);
    if (!parsed.success) { this.failMalformedTask(payload, 'Invalid local task event'); return; }
    const event = parsed.data;
    const task = this.tasks.get(event.taskId);
    if (!task) {
      if (event.state === 'failed' || event.state === 'cancelled') this.previews.releaseTask(event.taskId);
      return;
    }
    if (event.state === 'failed' || event.state === 'cancelled') {
      this.finishTask(task, event, false);
      if (event.state === 'failed') this.notifyFailure(task.offer, event.reason);
    } else if (event.state === 'accepted' && task.offer.media) {
      if (event.media?.generation !== task.offer.media.generation) return;
      if (!task.accepted || !localTaskAcceptMatchesOffer(task.offer, { taskId: event.taskId, result: event.result })) {
        this.failTask(task, 'invalid_request');
        return;
      }
      if (task.mediaState === 'pending') task.mediaState = 'accepted';
    } else if (event.state === 'ready' && task.offer.media) {
      if (event.mediaGeneration !== task.offer.media.generation || task.mediaState === 'ready') return;
      if (task.mediaState !== 'accepted' || !task.readyReported || !task.sender || !task.mainTaskId) {
        this.warn('Local media readiness arrived before acceptance', 'invalid_request');
        return;
      }
      if (!this.taskIsCurrent(task)) { this.failTask(task, 'cancelled'); return; }
      if (task.offer.expiresAt <= Date.now()) { this.failTask(task, 'timeout'); return; }
      task.mediaState = 'ready';
      clearTimeout(task.expiry);
      task.sender.markReady();
    } else if (event.state === 'completed') {
      if (task.offer.media) {
        // WebSocket can overtake SCTP. Only the sender's ordered drain ACK closes a successful stream.
        if (event.mediaGeneration !== task.offer.media.generation) return;
      } else if (task.accepted) this.finishTask(task, event, false);
    }
  }

  private nativeTaskFailed(taskId: string, reason: LocalExecutionFailure, sourceFailure?: LocalRuntimeSourceFailure): void {
    if (this.disposed) return;
    const failure = new LocalExecutionError(reason, sourceFailure);
    const task = [...this.tasks.values()].find((candidate) => candidate.mainTaskId === taskId);
    if (task) {
      this.failTask(task, failure.reason, failure.sourceFailure);
    } else if ([...this.tasks.values()].some((candidate) => candidate.nativeStarting)) {
      const previous = this.earlyNativeFailures.get(taskId);
      if (previous?.reason === 'cancelled' || previous?.reason === 'permission_revoked') return;
      this.earlyNativeFailures.set(taskId, failure);
      if (this.earlyNativeFailures.size > LOCAL_EXECUTION_PROTOCOL_LIMITS.tasksPerExecutor) {
        const oldest = this.earlyNativeFailures.keys().next().value;
        if (oldest !== undefined) this.earlyNativeFailures.delete(oldest);
      }
    }
  }

  private invocationFinished(payload: unknown): void {
    const parsed = commandFinishedSchema.safeParse(payload);
    if (!parsed.success) { this.warn('Invalid invocation completion'); return; }
    for (const request of this.requests.values()) {
      if (request.invocationId === parsed.data.invocationId) {
        this.releaseRequest(request.requestId, parsed.data.reason !== 'completed');
      }
    }
  }

  private failureEvent(taskId: string, reason: LocalExecutionFailure, sourceFailure?: LocalRuntimeSourceFailure): TerminalEvent {
    if (reason === 'cancelled' || reason === 'permission_revoked') {
      return { state: 'cancelled', taskId, cause: reason === 'permission_revoked' ? reason : 'requested' };
    }
    return { state: 'failed', taskId, reason, ...(sourceFailure ? { sourceFailure } : {}) };
  }

  private failTaskError(task: ExecutionTask, error: unknown): void {
    const failure = toLocalExecutionError(error);
    this.failTask(task, failure.reason, failure.sourceFailure);
  }

  private failTask(task: ExecutionTask, reason: LocalExecutionFailure, sourceFailure?: LocalRuntimeSourceFailure): void {
    if (this.tasks.get(task.offer.taskId) !== task) return;
    const failure = new LocalExecutionError(reason, sourceFailure);
    this.finishTask(task, this.failureEvent(task.offer.taskId, failure.reason, failure.sourceFailure));
    this.notifyFailure(task.offer, failure.reason);
  }

  private finishTask(task: ExecutionTask, event: TerminalEvent, report = true): void {
    if (this.tasks.get(task.offer.taskId) !== task) return;
    this.tasks.delete(task.offer.taskId);
    this.retireTask(task.offer.taskId);
    clearTimeout(task.expiry);
    task.signals = [];
    task.controller.abort();
    task.sender?.close();
    if (event.state === 'completed' && task.offer.context.kind === 'source') {
      this.sourceNotices.delete(JSON.stringify([task.offer.context.sourceContextId, task.offer.spec.operation]));
    }
    if (event.state !== 'completed') {
      this.previews.releaseTask(task.offer.taskId);
      if (task.nativeStarting) this.cancelNativeRequest(task.nativeRequestId);
      if (task.mainTaskId && task.offer.spec.operation === 'youtube.stream' && !task.sender?.nativePlaybackComplete) {
        this.cancelNativeTask(task.mainTaskId);
      }
    }
    if (report && this.isCurrent(task.subject)) this.sendEvent(event);
  }

  private retireTask(taskId: string): void {
    this.retiredTasks.add(taskId);
    if (this.retiredTasks.size > 256) {
      const oldest = this.retiredTasks.values().next().value;
      if (oldest !== undefined) this.retiredTasks.delete(oldest);
    }
  }

  private cancelNativeTask(taskId: string): void {
    if (!this.api) return;
    void this.api.cancelLocalExecutionTask(taskId).then((result) => {
      if (result.status === 'failed') this.warn('Native task cancellation failed', result.reason);
    }, (error: unknown) => this.warn('Native task cancellation failed', localFailure(error)));
  }

  private sendEvent(event: LocalTaskEvent): void {
    if (this.disposed || this.client.getStatus() !== 'CONNECTED' || this.client.getConnectionId() !== this.connectionId) return;
    this.client.send(MessageType.BOT_LOCAL_TASK_EVENT, localTaskEventSchema.parse(event));
  }

  private failMalformedTask(payload: unknown, message: string): void {
    this.warn(message);
    if (!payload || typeof payload !== 'object' || !('taskId' in payload) || typeof payload.taskId !== 'string') return;
    const task = this.tasks.get(payload.taskId);
    if (task && (!('mediaGeneration' in payload) || payload.mediaGeneration === task.offer.media?.generation)) {
      this.failTask(task, 'transport_failed');
    }
  }

  private warn(message: string, reason: LocalExecutionFailure = 'invalid_request'): void {
    clientLog.warn('NETWORK', `[LocalExecution] ${message}`, { reason });
  }

  private notifyFailure(offer: LocalTaskOffer, reason: LocalExecutionFailure): void {
    if (reason === 'cancelled' || reason === 'permission_revoked') return;
    this.warn('Local task failed', reason);
    if (offer.context.kind === 'source') {
      const key = JSON.stringify([offer.context.sourceContextId, offer.spec.operation]);
      if (this.sourceNotices.get(key) === reason) return;
      this.sourceNotices.set(key, reason);
      if (this.sourceNotices.size > 256) {
        const oldest = this.sourceNotices.keys().next().value;
        if (oldest !== undefined) this.sourceNotices.delete(oldest);
      }
    }
    const notice: LocalExecutionTaskNotice = {
      sessionKey: this.client.sessionKey, taskId: offer.taskId,
      botName: offer.bot.botName, serverName: offer.bot.serverName, reason,
    };
    emitOutsideRouting(() => {
      if (!this.disposed) appEvents.emit('localExecution.task_failed', notice);
    });
  }

  public prepare(bot: BotIdentity, capability: LocalCapabilityId, owner: AbortSignal): Promise<PreparedLocalCapability> {
    if (owner.aborted) return Promise.reject(new DOMException('Preparation cancelled', 'AbortError'));
    if (!this.api) return Promise.reject(new LocalExecutionError('executor_unavailable'));
    let subject: LocalExecutionSubject;
    try { subject = this.subject(bot); }
    catch (error) { return Promise.reject(error); }
    const key = this.preparationKey(subject, capability);
    const prepared = this.prepared.get(key);
    if (prepared) return Promise.resolve(prepared);
    let preparation = this.preparations.get(key);
    if (!preparation) {
      if (this.prepared.size >= LOCAL_PERMISSION_LIMITS.entries) return Promise.reject(new LocalExecutionError('busy'));
      const requestId = uuidv4();
      const controller = new AbortController();
      const state = { settled: false };
      preparation = {
        key, requestId, controller, state, owners: new Map(),
        promise: this.performPreparation(subject, capability, requestId, controller.signal, state).then((grant) => {
          if (this.isCurrent(subject) && !controller.signal.aborted) {
            this.prepared.set(key, grant);
            this.sourcePreparationFailures.delete(key);
          }
          return grant;
        }),
      };
      this.preparations.set(key, preparation);
    }
    if (!preparation.owners.has(owner)) {
      const captured = preparation;
      const release = () => this.releasePreparation(captured, owner);
      owner.addEventListener('abort', release, { once: true });
      preparation.owners.set(owner, () => owner.removeEventListener('abort', release));
    }
    return observeWithSignal(preparation.promise, owner);
  }

  private preparationKey(subject: LocalExecutionSubject, capability: LocalCapabilityId): string {
    return JSON.stringify([subject.connectionId, subject.serverOrigin, subject.serverId, subject.botId, subject.botPublicKey, capability]);
  }

  private async performPreparation(
    subject: LocalExecutionSubject, capability: LocalCapabilityId, requestId: string,
    signal: AbortSignal, state: Preparation['state'],
  ): Promise<PreparedLocalCapability> {
    try {
      this.syncVoiceContext();
      const connection = await observeWithSignal(this.nativeUpdate, signal);
      if (!connection || !this.api) throw new LocalExecutionError('executor_unavailable');
      requireLocalMutation(connection);
      if (signal.aborted || !this.isCurrent(subject)) throw new DOMException('Preparation cancelled', 'AbortError');
      let result: LocalPreparationResult;
      try { result = await observeWithSignal(this.api.prepareLocalExecution({ requestId, subject, capability }), signal); }
      catch (error) { throw toLocalExecutionError(error); }
      if (signal.aborted || !this.isCurrent(subject)) throw new DOMException('Preparation cancelled', 'AbortError');
      if (result.status === 'cancelled') throw new LocalExecutionError('cancelled');
      if (result.status === 'failed') throw new LocalExecutionError(result.reason, result.sourceFailure);
      if (!/^[a-f0-9]{64}$/.test(result.permit)) throw new LocalExecutionError('invalid_request');
      return { capability, permit: result.permit, subject };
    } catch (error) {
      const failure = toLocalExecutionError(error);
      state.failure = {
        reason: failure.reason, failedAt: Date.now(),
        ...(failure.sourceFailure ? { sourceFailure: failure.sourceFailure } : {}),
      };
      throw error;
    } finally {
      state.settled = true;
    }
  }

  private releasePreparation(preparation: Preparation, owner: AbortSignal): void {
    preparation.owners.get(owner)?.();
    preparation.owners.delete(owner);
    if (preparation.owners.size) return;
    if (this.preparations.get(preparation.key) === preparation) this.preparations.delete(preparation.key);
    if (!preparation.state.settled) {
      preparation.controller.abort();
      this.cancelNativeRequest(preparation.requestId);
    }
  }

  private forgetSettledPreparation(key: string): void {
    const preparation = this.preparations.get(key);
    if (!preparation?.state.settled) return;
    for (const off of preparation.owners.values()) off();
    preparation.owners.clear();
    this.preparations.delete(key);
  }

  private cancelNativeRequest(requestId: string): void {
    if (!this.api) return;
    void this.api.cancelLocalExecutionRequest({ requestId }).then((result) => {
      if (result.status === 'failed') {
        clientLog.warn('NETWORK', '[LocalExecution] Native request cancellation failed', { reason: result.reason });
      }
    }, (error: unknown) => {
      clientLog.warn('NETWORK', '[LocalExecution] Native request cancellation failed', { reason: localFailure(error) });
    });
  }

  private permissionsChanged(snapshot: LocalExecutionSnapshot): void {
    if (this.disposed) return;
    if (this.connectionId && snapshot.supported) {
      for (const permission of snapshot.permissions) {
        if (permission.decision === 'deny') continue;
        const key = this.preparationKey({ ...permission.bot, connectionId: this.connectionId }, permission.capability);
        const blocked = this.sourcePreparationFailures.get(key);
        if (blocked && permission.updatedAt > blocked.failedAt) {
          this.sourcePreparationFailures.delete(key);
        }
        const failure = this.preparations.get(key)?.state.failure;
        if (failure && permission.updatedAt > failure.failedAt && !this.prepared.has(key)) this.forgetSettledPreparation(key);
      }
    }
    for (const [key, grant] of this.prepared) {
      const permission = snapshot.permissions.find((entry) => entry.capability === grant.capability &&
        entry.bot.serverOrigin === grant.subject.serverOrigin && entry.bot.serverId === grant.subject.serverId &&
        entry.bot.botId === grant.subject.botId && entry.bot.botPublicKey === grant.subject.botPublicKey);
      if (!snapshot.supported || !permission || permission.decision === 'deny') {
        this.prepared.delete(key);
        this.sourcePreparationFailures.set(key, { reason: 'permission_revoked', failedAt: Date.now() });
        this.forgetSettledPreparation(key);
        for (const task of this.tasks.values()) {
          if (this.preparationKey(task.subject, task.offer.capability) === key) this.failTask(task, 'permission_revoked');
        }
        for (const request of this.requests.values()) {
          if (this.preparationKey(request.grant.subject, request.grant.capability) === key) this.releaseRequest(request.requestId);
        }
        emitOutsideRouting(() => {
          if (!this.disposed) appEvents.emit('localExecution.permission_revoked', {
            sessionKey: this.client.sessionKey, botId: grant.subject.botId,
          });
        });
      }
    }
  }

  private invalidateConnection(): void {
    const previous = this.connectionId;
    this.connectionId = null;
    this.serverUrl = null;
    for (const task of this.tasks.values()) {
      this.finishTask(task, { state: 'cancelled', taskId: task.offer.taskId, cause: 'requested' }, false);
    }
    for (const requestId of this.requests.keys()) this.releaseRequest(requestId);
    this.earlyNativeFailures.clear();
    this.sourcePreparationFailures.clear();
    this.sourceNotices.clear();
    this.prepared.clear();
    this.previews.clear();
    for (const preparation of this.preparations.values()) {
      preparation.controller.abort();
      for (const off of preparation.owners.values()) off();
      if (!preparation.state.settled) this.cancelNativeRequest(preparation.requestId);
    }
    this.preparations.clear();
    if (previous) this.setNativeConnection({ connectionId: previous, connected: false, voiceChannelId: null });
  }

  public async dispose(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true;
      this.invalidateConnection();
      for (const off of this.unbind) off();
      this.unbind = [];
      controllers.delete(this.client);
    }
    await this.nativeUpdate;
  }
}
