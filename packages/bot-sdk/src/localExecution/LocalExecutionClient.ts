import { randomUUID } from 'crypto';
import { isDeepStrictEqual } from 'util';
import type WebSocket from 'ws';
import {
  LOCAL_EXECUTION_PROTOCOL_LIMITS, LOCAL_OPERATION_CAPABILITY, MessageType, ProtocolErrorCode,
  localMediaSignalSchema, localRequestContextSchema, localSourceRequestSchema, localSourceResultSchema,
  localTaskAcceptMatchesOffer, localTaskEventSchema, localTaskMatchesSource, localTaskOfferSchema,
  localTaskRequestSchema,
  type CommandCallerContext, type LocalMediaSignal, type LocalRequestContext, type LocalSourceContext,
  type LocalSourceRequest, type LocalSourceResult, type LocalTaskControl, type LocalTaskEvent,
  type LocalTaskOffer, type LocalTaskRequest, type LocalTaskSpec, type LocalWirePreviewResult,
  type LocalWireTaskResult,
} from '@monky/shared';
import {
  LocalExecutionError, LocalExecutionRpcError,
  type LocalExecutionClient, type LocalExecutionTaskOptions, type LocalExecutor,
  type LocalMetadataTaskResult, type LocalMetadataTaskSpec, type LocalOpusStream, type LocalStreamOptions,
} from './contracts';
import type { LocalOpusReceiver } from './LocalOpusReceiver';

export type LocalExecutionCaller = Pick<
  CommandCallerContext, 'botId' | 'channelId' | 'invokerId' | 'invokerSessionId'
>;
type InteractionContext = Exclude<LocalRequestContext, { kind: 'source' }>;

export interface LocalExecutionConnection {
  readonly ws: WebSocket;
  readonly botId: string;
  readonly botSessionId: string;
  readonly botPublicKey: string;
}

export interface LocalExecutionContextLifetime {
  readonly caller: LocalExecutionCaller;
  readonly signal: AbortSignal;
  isCurrent(): boolean;
}

type OutgoingMessage =
  | { type: MessageType.BOT_LOCAL_TASK_REQUEST; requestId: string; payload: LocalTaskRequest }
  | { type: MessageType.BOT_LOCAL_SOURCE_REQUEST; requestId: string; payload: LocalSourceRequest }
  | { type: MessageType.BOT_LOCAL_TASK_CONTROL; requestId?: string; payload: LocalTaskControl }
  | { type: MessageType.BOT_LOCAL_TASK_EVENT; payload: LocalTaskEvent }
  | { type: MessageType.BOT_LOCAL_MEDIA_SIGNAL; payload: LocalMediaSignal };

export interface LocalExecutionTransport {
  connection(): LocalExecutionConnection;
  isCurrent(connection: LocalExecutionConnection): boolean;
  captureContext(connection: LocalExecutionConnection, context: InteractionContext): LocalExecutionContextLifetime;
  send(connection: LocalExecutionConnection, message: OutgoingMessage): void;
  reportError(error: unknown): void;
}

interface IncomingMessage {
  type: string;
  requestId?: string;
  payload?: unknown;
}
interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}
interface ExecutorBinding {
  context: LocalRequestContext;
  connection?: LocalExecutionConnection;
  lifetime?: LocalExecutionContextLifetime;
}
interface PendingSource {
  requestId: string;
  connection: LocalExecutionConnection;
  request: LocalSourceRequest;
  lifetime?: LocalExecutionContextLifetime;
  result: Deferred<LocalSourceResult>;
  timer: ReturnType<typeof setTimeout>;
  unsubscribe(): void;
  cancelled?: Error;
}
interface PendingControl {
  requestId: string;
  revision: number;
  paused: boolean;
  result: Deferred<void>;
  timer: ReturnType<typeof setTimeout>;
}
type TaskResult =
  | { kind: 'metadata'; result: LocalMetadataTaskResult }
  | { kind: 'stream'; stream: LocalOpusStream };
interface PendingTask {
  requestId: string;
  connection: LocalExecutionConnection;
  request: LocalTaskRequest;
  lifetime?: LocalExecutionContextLifetime;
  source?: LocalSourceContext;
  result: Deferred<TaskResult>;
  closed: Deferred<void>;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  expiryTimer?: ReturnType<typeof setTimeout>;
  completionTimer?: ReturnType<typeof setTimeout>;
  unsubscribe(): void;
  offer?: LocalTaskOffer;
  accepted?: Extract<LocalTaskEvent, { state: 'accepted' }>;
  receiver?: LocalOpusReceiver;
  localReady: boolean;
  serverReady: boolean;
  started: boolean;
  terminal: boolean;
  cancelled?: Error;
  revision: number;
  control?: PendingControl;
  confirmedControl?: { revision: number; paused: boolean };
  cleanup?: Promise<void>;
}

const RPC_TIMEOUT_MS = 8_000;
const CONTROL_TIMEOUT_MS = 8_000;
const COMPLETION_TIMEOUT_MS = 8_000;
const MAX_SOURCE_REQUESTS = 100;
const LOCAL_MESSAGES = new Set<string>([
  MessageType.BOT_LOCAL_SOURCE_RESULT, MessageType.BOT_LOCAL_TASK_OFFER,
  MessageType.BOT_LOCAL_TASK_EVENT, MessageType.BOT_LOCAL_MEDIA_SIGNAL,
]);
const toError = (error: unknown): Error => error instanceof Error ? error : new Error(String(error));
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  // Observe early internal failures without replacing the rejected public promise.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function abortError(): Error {
  const error = new Error('The local execution context or request was aborted.');
  error.name = 'AbortError';
  return error;
}

function listenForAbort(signals: (AbortSignal | undefined)[], abort: () => void): () => void {
  const unique = [...new Set(signals.filter((signal): signal is AbortSignal => signal !== undefined))];
  for (const signal of unique) signal.addEventListener('abort', abort, { once: true });
  return () => { for (const signal of unique) signal.removeEventListener('abort', abort); };
}

function rpcError(payload: unknown): Error {
  if (!isRecord(payload) || typeof payload.message !== 'string') return new Error('Invalid local RPC rejection.');
  const code = Object.values(ProtocolErrorCode).find((value) => value === payload.code);
  return code === undefined
    ? new Error('Invalid local RPC error code.')
    : new LocalExecutionRpcError(code, payload.message);
}

/** The authenticated WebSocket carries bounded control/metadata only, never audio. */
export class BotLocalExecutionClient implements LocalExecutionClient {
  private readonly requestPrefix = `local-${randomUUID()}-`;
  private readonly requests = new Map<string, PendingTask>();
  private readonly tasks = new Map<string, PendingTask>();
  private readonly sourceRequests = new Map<string, PendingSource>();
  private readonly controlRequests = new Map<string, PendingTask>();
  private readonly sources = new Map<string, LocalSourceContext>();
  private readonly cleanups = new Set<Promise<void>>();
  private Receiver?: typeof LocalOpusReceiver;
  private disposed = false;

  constructor(private readonly transport: LocalExecutionTransport) {}

  executor(input: LocalRequestContext): LocalExecutor {
    this.assertOpen();
    const context = localRequestContextSchema.parse(input);
    if (context.kind === 'source') return new ContextLocalExecutor(this, { context });
    const connection = this.transport.connection();
    const lifetime = this.transport.captureContext(connection, context);
    this.assertLifetime(connection, lifetime);
    return new ContextLocalExecutor(this, { context, connection, lifetime });
  }

  async retainSource(
    invocationId: string, url: string, options: LocalExecutionTaskOptions = {},
  ): Promise<LocalSourceContext> {
    this.assertOpen();
    const request = localSourceRequestSchema.parse({ action: 'retain', invocationId, url });
    const connection = this.transport.connection();
    const lifetime = this.transport.captureContext(connection, { kind: 'invocation', invocationId });
    this.assertLifetime(connection, lifetime, options.signal);
    this.pruneSources();
    if (this.sources.size + this.sourceRequests.size >= LOCAL_EXECUTION_PROTOCOL_LIMITS.sourceContextsPerBot) {
      throw new Error('Too many retained local sources.');
    }
    const result = await this.requestSource(connection, request, lifetime, options.signal);
    this.assertLifetime(connection);
    if (result.status !== 'retained') throw new Error('Expected a retained local source.');
    return result.source;
  }

  async releaseSource(sourceContextId: string): Promise<void> {
    this.assertOpen();
    const request = localSourceRequestSchema.parse({ action: 'release', sourceContextId });
    const connection = this.transport.connection();
    const result = await this.requestSource(connection, request);
    this.assertLifetime(connection);
    if (result.status !== 'released') throw new Error('Expected a released local source.');
  }

  async checkSourceAvailability(
    sourceContextId: string, voiceChannelId: string, options: LocalExecutionTaskOptions = {},
  ): Promise<void> {
    this.assertOpen();
    const request = localSourceRequestSchema.parse({ action: 'check', sourceContextId, voiceChannelId });
    const connection = this.transport.connection();
    const result = await this.requestSource(connection, request, undefined, options.signal);
    this.assertLifetime(connection, undefined, options.signal);
    if (result.status !== 'available') throw new Error('Expected a local source availability confirmation.');
  }

  async execute(
    binding: ExecutorBinding, spec: LocalMetadataTaskSpec, options: LocalExecutionTaskOptions = {},
  ): Promise<LocalMetadataTaskResult> {
    if (spec.operation !== 'youtube.search' && spec.operation !== 'youtube.resolve' && spec.operation !== 'youtube.preview') {
      throw new TypeError('Streams require executor.stream().');
    }
    const result = await this.requestTask(binding, spec, options);
    if (result.kind !== 'metadata') throw new Error('Expected a local metadata result.');
    return result.result;
  }

  async stream(
    binding: ExecutorBinding, spec: Extract<LocalTaskSpec, { operation: 'youtube.stream' }>, options: LocalStreamOptions,
  ): Promise<LocalOpusStream> {
    if (spec.operation !== 'youtube.stream' || !options) throw new TypeError('A stream requires explicit voice scope.');
    const result = await this.requestTask(binding, spec, options, options.voiceChannelId);
    if (result.kind !== 'stream') throw new Error('Expected a local Opus stream.');
    return result.stream;
  }

  handle(ws: WebSocket, message: IncomingMessage): boolean {
    if (message.type === MessageType.SERVER_ERROR) {
      if (!message.requestId?.startsWith(this.requestPrefix)) return false;
      const error = rpcError(message.payload);
      const source = this.sourceRequests.get(message.requestId);
      if (source?.connection.ws === ws) this.finishSource(source, error);
      const task = this.requests.get(message.requestId);
      if (task?.connection.ws === ws) this.failTask(task, error);
      const controlled = this.controlRequests.get(message.requestId);
      if (controlled?.connection.ws === ws) this.rejectControl(controlled, error);
      return true;
    }
    if (!LOCAL_MESSAGES.has(message.type)) return false;
    if (this.disposed) return true;
    if (message.type === MessageType.BOT_LOCAL_SOURCE_RESULT) {
      const source = message.requestId ? this.sourceRequests.get(message.requestId) : undefined;
      if (source?.connection.ws === ws) this.handleSource(source, message.payload);
      const task = message.requestId ? this.requests.get(message.requestId) : undefined;
      if (task?.connection.ws === ws) this.invalidTask(task);
      return true;
    }
    if (message.type === MessageType.BOT_LOCAL_TASK_OFFER) {
      const task = message.requestId ? this.requests.get(message.requestId) : undefined;
      if (task?.connection.ws === ws) this.handleOffer(task, message.payload);
      const source = message.requestId ? this.sourceRequests.get(message.requestId) : undefined;
      if (source?.connection.ws === ws) this.finishSource(source, new Error('Expected a local source response, not a task offer.'));
      return true;
    }
    const source = message.requestId ? this.sourceRequests.get(message.requestId) : undefined;
    if (source?.connection.ws === ws) {
      this.finishSource(source, new Error('Expected a local source response, not a task event or signal.'));
      return true;
    }
    const correlated = message.requestId ? this.requests.get(message.requestId) : undefined;
    const taskId = isRecord(message.payload) && typeof message.payload.taskId === 'string'
      ? message.payload.taskId : undefined;
    const reserved = taskId ? this.tasks.get(taskId) : undefined;
    const task = correlated ?? reserved;
    if (!task || task.connection.ws !== ws || task.terminal) return true;
    if (!this.transport.isCurrent(task.connection)) {
      this.disconnectTask(task);
      return true;
    }
    if (message.requestId !== undefined && message.requestId !== task.requestId &&
        message.requestId !== task.control?.requestId) return true;
    if (correlated && reserved && correlated !== reserved) {
      this.invalidTask(correlated);
      return true;
    }
    if (message.type === MessageType.BOT_LOCAL_MEDIA_SIGNAL) {
      const parsed = localMediaSignalSchema.safeParse(message.payload);
      if (!parsed.success || !task.offer?.media || !task.receiver ||
          parsed.data.taskId !== task.offer.taskId ||
          parsed.data.mediaGeneration !== task.offer.media.generation) {
        this.invalidTask(task);
        return true;
      }
      void task.receiver.handleSignal(parsed.data).catch((error: unknown) => {
        if (!task.terminal) this.mediaFailed(task, toError(error));
      });
    } else {
      const parsed = localTaskEventSchema.safeParse(message.payload);
      if (!parsed.success || parsed.data.taskId !== task.offer?.taskId) this.invalidTask(task);
      else this.handleEvent(task, parsed.data);
    }
    return true;
  }

  disconnect(ws: WebSocket): void {
    for (const task of this.requests.values()) {
      if (task.connection.ws === ws) this.disconnectTask(task);
    }
    for (const source of this.sourceRequests.values()) {
      if (source.connection.ws === ws) this.finishSource(source, new Error('Local execution signaling disconnected.'));
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const task of this.requests.values()) this.disconnectTask(task);
    for (const source of this.sourceRequests.values()) {
      this.finishSource(source, new Error('The local execution client was closed.'));
    }
    this.sources.clear();
    const results = await Promise.allSettled([...this.cleanups]);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw toError(failure.reason);
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error('The local execution client was closed.');
  }

  private assertLifetime(
    connection: LocalExecutionConnection, lifetime?: LocalExecutionContextLifetime, signal?: AbortSignal,
  ): void {
    this.assertOpen();
    if (!this.transport.isCurrent(connection)) throw new Error('Local execution signaling disconnected.');
    if (signal?.aborted || lifetime?.signal.aborted || (lifetime && !lifetime.isCurrent())) throw abortError();
  }

  private nextRequestId(): string { return `${this.requestPrefix}${randomUUID()}`; }

  private pruneSources(): void {
    for (const [id, source] of this.sources) if (source.expiresAt <= Date.now()) this.sources.delete(id);
  }

  private requestSource(
    connection: LocalExecutionConnection, request: LocalSourceRequest,
    lifetime?: LocalExecutionContextLifetime, signal?: AbortSignal,
  ): Promise<LocalSourceResult> {
    this.assertLifetime(connection, lifetime, signal);
    if (this.sourceRequests.size >= MAX_SOURCE_REQUESTS) throw new Error('Too many pending local source requests.');
    const result = deferred<LocalSourceResult>();
    const requestId = this.nextRequestId();
    const source: PendingSource = {
      requestId, connection, request, lifetime, result,
      timer: setTimeout(() => this.finishSource(source, new Error('Local source request timed out.')), RPC_TIMEOUT_MS),
      unsubscribe: () => undefined,
    };
    this.sourceRequests.set(requestId, source);
    source.unsubscribe = listenForAbort([lifetime?.signal, signal], () => {
      source.cancelled = abortError();
      source.unsubscribe();
      source.result.reject(source.cancelled);
      // Keep a bounded correlation until its reply/timeout so an abandoned retain can be released.
    });
    try {
      this.assertLifetime(connection, lifetime, signal);
      this.transport.send(connection, { type: MessageType.BOT_LOCAL_SOURCE_REQUEST, requestId, payload: request });
    } catch (error) { this.finishSource(source, toError(error)); }
    return result.promise;
  }

  private finishSource(source: PendingSource, error?: Error, result?: LocalSourceResult): void {
    clearTimeout(source.timer);
    source.unsubscribe();
    this.sourceRequests.delete(source.requestId);
    if (error) source.result.reject(error);
    else if (result) source.result.resolve(result);
  }

  private handleSource(pending: PendingSource, payload: unknown): void {
    if (!this.transport.isCurrent(pending.connection)) {
      this.finishSource(pending, new Error('Local source response belongs to a disconnected socket.'));
      return;
    }
    const parsed = localSourceResultSchema.safeParse(payload);
    if (!parsed.success) {
      this.finishSource(pending, new Error('Invalid local source response.'));
      return;
    }
    const result = parsed.data;
    if (pending.request.action === 'release') {
      if (result.status !== 'released' || result.sourceContextId !== pending.request.sourceContextId) {
        this.finishSource(pending, new Error('Local source release response does not match its request.'));
        return;
      }
      this.sources.delete(result.sourceContextId);
    } else if (pending.request.action === 'check') {
      if (result.status !== 'available' || result.sourceContextId !== pending.request.sourceContextId ||
          result.voiceChannelId !== pending.request.voiceChannelId) {
        this.finishSource(pending, new Error('Local source availability does not match its request.'));
        return;
      }
    } else {
      const caller = pending.lifetime?.caller;
      if (result.status !== 'retained' || !caller ||
          result.source.botId !== pending.connection.botId ||
          result.source.botPublicKey !== pending.connection.botPublicKey ||
          result.source.invokerId !== caller.invokerId ||
          result.source.invokerSessionId !== caller.invokerSessionId ||
          result.source.originChannelId !== caller.channelId ||
          result.source.url !== pending.request.url ||
          result.source.capability !== LOCAL_OPERATION_CAPABILITY['youtube.resolve'] ||
          result.source.expiresAt <= Date.now()) {
        this.finishSource(pending, new Error('Retained local source does not match its invocation.'));
        return;
      }
      const known = this.sources.get(result.source.sourceContextId);
      if (known && !isDeepStrictEqual(known, result.source)) {
        this.finishSource(pending, new Error('The server changed an existing retained local source.'));
        return;
      }
      if (pending.cancelled || !pending.lifetime?.isCurrent() || pending.lifetime.signal.aborted) {
        this.finishSource(pending, pending.cancelled ?? abortError());
        if (!known) {
          try {
            void this.requestSource(pending.connection, {
              action: 'release', sourceContextId: result.source.sourceContextId,
            }).catch((error: unknown) => this.transport.reportError(error));
          } catch (error) { this.transport.reportError(error); }
        }
        return;
      }
      Object.freeze(result.source);
      this.sources.set(result.source.sourceContextId, result.source);
    }
    this.finishSource(pending, undefined, result);
  }

  private async requestTask(
    binding: ExecutorBinding, spec: LocalTaskSpec, options: LocalExecutionTaskOptions, voiceChannelId?: string,
  ): Promise<TaskResult> {
    this.assertOpen();
    const request = localTaskRequestSchema.parse({ context: binding.context, spec, voiceChannelId });
    const connection = binding.connection ?? this.transport.connection();
    this.assertLifetime(connection, binding.lifetime, options.signal);
    if (this.requests.size + this.cleanups.size >= LOCAL_EXECUTION_PROTOCOL_LIMITS.tasksPerBot) {
      throw new Error('Too many pending local execution tasks.');
    }
    this.pruneSources();
    const source = request.context.kind === 'source' ? this.sources.get(request.context.sourceContextId) : undefined;
    if (source && (source.botId !== connection.botId || source.botPublicKey !== connection.botPublicKey ||
        !localTaskMatchesSource(source, request.spec))) {
      throw new Error('The local task does not match its retained source.');
    }
    const result = deferred<TaskResult>();
    const task: PendingTask = {
      requestId: this.nextRequestId(), connection, request, lifetime: binding.lifetime, source, result,
      closed: deferred<void>(), controller: new AbortController(),
      timer: setTimeout(() => this.timeoutTask(task), LOCAL_EXECUTION_PROTOCOL_LIMITS.taskStartTimeoutMs),
      unsubscribe: () => undefined, localReady: false, serverReady: false, started: false, terminal: false, revision: 0,
    };
    this.requests.set(task.requestId, task);
    task.unsubscribe = listenForAbort([binding.lifetime?.signal, options.signal], () => this.cancelTask(task));
    try {
      if (request.spec.operation === 'youtube.stream' && !this.Receiver) {
        const { LocalOpusReceiver } = await import('./LocalOpusReceiver');
        this.assertLifetime(connection, binding.lifetime, options.signal);
        this.Receiver = LocalOpusReceiver;
      }
      this.assertLifetime(connection, binding.lifetime, options.signal);
      if (task.terminal) throw toError(task.controller.signal.reason);
      this.transport.send(connection, {
        type: MessageType.BOT_LOCAL_TASK_REQUEST, requestId: task.requestId, payload: request,
      });
    } catch (error) { this.failTask(task, toError(error)); }
    const outcome = await result.promise;
    if (task.controller.signal.aborted) throw toError(task.controller.signal.reason);
    this.assertLifetime(connection, binding.lifetime, options.signal);
    return outcome;
  }

  private offerMatches(task: PendingTask, offer: LocalTaskOffer): boolean {
    const { connection, request, source } = task;
    const caller = task.lifetime?.caller;
    return offer.bot.botId === connection.botId && offer.bot.botPublicKey === connection.botPublicKey &&
      offer.botSessionId === connection.botSessionId &&
      isDeepStrictEqual(offer.context, request.context) && isDeepStrictEqual(offer.spec, request.spec) &&
      offer.voiceChannelId === request.voiceChannelId && offer.expiresAt > Date.now() &&
      (!caller || (offer.invokerId === caller.invokerId && offer.invokerSessionId === caller.invokerSessionId)) &&
      (!source || (offer.invokerId === source.invokerId && offer.invokerSessionId === source.invokerSessionId &&
        localTaskMatchesSource(source, offer.spec)));
  }

  private handleOffer(task: PendingTask, payload: unknown): void {
    if (!this.transport.isCurrent(task.connection)) { this.disconnectTask(task); return; }
    const parsed = localTaskOfferSchema.safeParse(payload);
    if (!parsed.success || !this.offerMatches(task, parsed.data)) {
      this.invalidTask(task);
      return;
    }
    const offer = parsed.data;
    if (task.offer) {
      if (!isDeepStrictEqual(task.offer, offer)) this.invalidTask(task);
      return;
    }
    if (this.tasks.has(offer.taskId)) { this.invalidTask(task); return; }
    task.offer = offer;
    this.tasks.set(offer.taskId, task);
    if (task.cancelled || task.lifetime?.signal.aborted || (task.lifetime && !task.lifetime.isCurrent())) {
      this.cancelTask(task);
      return;
    }
    this.scheduleExpiry(task);
    const media = offer.media;
    if (!media) return;
    const Receiver = this.Receiver;
    if (!Receiver) { this.invalidTask(task); return; }
    try {
      task.receiver = new Receiver({
        taskId: offer.taskId, generation: media.generation, iceServers: media.iceServers,
        sendSignal: (signal) => {
          this.assertTaskCurrent(task);
          this.transport.send(task.connection, { type: MessageType.BOT_LOCAL_MEDIA_SIGNAL, payload: signal });
        },
        onReady: () => {
          if (task.terminal) return;
          this.assertTaskCurrent(task);
          task.localReady = true;
          this.transport.send(task.connection, {
            type: MessageType.BOT_LOCAL_TASK_EVENT,
            payload: { state: 'ready', taskId: offer.taskId, mediaGeneration: media.generation },
          });
          this.maybeStart(task);
        },
        onError: (error) => {
          if (task.terminal) this.transport.reportError(error);
          else this.mediaFailed(task, error);
        },
      });
      void task.receiver.drained.then(() => {
        if (task.terminal) return;
        task.completionTimer = setTimeout(() => this.timeoutTask(task), COMPLETION_TIMEOUT_MS);
      }, (error: unknown) => {
        if (!task.terminal) this.mediaFailed(task, toError(error));
      });
    } catch (error) { this.mediaFailed(task, toError(error)); }
  }

  private assertTaskCurrent(task: PendingTask): void {
    if (task.terminal) throw task.controller.signal.reason ?? new Error('The local task has completed.');
    this.assertLifetime(task.connection, task.lifetime);
    if (!task.offer || task.offer.expiresAt <= Date.now()) throw new Error('The local task reservation expired.');
  }

  private scheduleExpiry(task: PendingTask): void {
    const offer = task.offer;
    if (!offer || task.terminal) return;
    const remaining = offer.expiresAt - Date.now();
    if (remaining <= 0) {
      this.terminate(task, new LocalExecutionError({ state: 'cancelled', taskId: offer.taskId, cause: 'expired' }), true);
      return;
    }
    task.expiryTimer = setTimeout(() => this.scheduleExpiry(task),
      Math.min(remaining, LOCAL_EXECUTION_PROTOCOL_LIMITS.sourceContextTtlMs));
  }

  private handleEvent(task: PendingTask, event: LocalTaskEvent): void {
    if (!task.offer || task.terminal) return;
    if (event.state === 'failed' || event.state === 'cancelled') {
      this.terminate(task, new LocalExecutionError(event), false);
      return;
    }
    try { this.assertTaskCurrent(task); }
    catch (error) { this.failTask(task, toError(error)); return; }
    switch (event.state) {
      case 'accepted': {
        if (!localTaskAcceptMatchesOffer(task.offer, event) || !isDeepStrictEqual(event.media, task.offer.media) ||
            (task.accepted && !isDeepStrictEqual(task.accepted, event))) {
          this.invalidTask(task);
          return;
        }
        if (task.accepted) return;
        task.accepted = event;
        if (event.result.operation === 'youtube.stream') this.maybeStart(task);
        else {
          this.removeTask(task);
          task.terminal = true;
          task.closed.resolve();
          task.result.resolve({ kind: 'metadata', result: event.result });
        }
        return;
      }
      case 'ready':
        if (!task.accepted || !task.offer.media || event.mediaGeneration !== task.offer.media.generation) {
          this.invalidTask(task);
          return;
        }
        task.serverReady = true;
        this.maybeStart(task);
        return;
      case 'paused':
      case 'resumed':
        this.confirmControl(task, event);
        return;
      case 'completed':
        if (!task.started || !task.receiver?.hasDrained || !task.offer.media ||
            event.mediaGeneration !== task.offer.media.generation || event.playedFrames !== task.receiver.playedFrames) {
          this.invalidTask(task);
          return;
        }
        this.removeTask(task);
        task.terminal = true;
        task.cleanup = this.trackCleanup(task.receiver.finish());
        void task.cleanup.then(() => task.closed.resolve(), () => {
          const error = new LocalExecutionError({ state: 'failed', taskId: event.taskId, reason: 'transport_failed' });
          task.controller.abort(error);
          task.closed.reject(error);
        });
        return;
    }
  }

  private maybeStart(task: PendingTask): void {
    if (task.terminal || task.started || !task.accepted || task.accepted.result.operation !== 'youtube.stream' ||
        !task.receiver || !task.localReady || !task.serverReady || !task.offer) return;
    try {
      this.assertTaskCurrent(task);
      task.receiver.start();
      task.started = true;
      clearTimeout(task.timer);
      task.result.resolve({ kind: 'stream', stream: this.createStream(task, task.accepted.result) });
    } catch (error) { this.mediaFailed(task, toError(error)); }
  }

  private createStream(
    task: PendingTask, result: Extract<LocalWireTaskResult, { operation: 'youtube.stream' }>,
  ): LocalOpusStream {
    const receiver = task.receiver;
    const offer = task.offer;
    if (!receiver || !offer) throw new Error('Local stream reservation is missing.');
    const close = (): Promise<void> => {
      if (receiver.hasDrained) return task.closed.promise;
      if (!task.terminal) this.cancelTask(task);
      return task.cleanup ?? Promise.resolve();
    };
    return Object.freeze({
      taskId: offer.taskId, track: Object.freeze(result.track), signal: task.controller.signal, closed: task.closed.promise,
      frames: {
        [Symbol.asyncIterator]: (): AsyncIterator<Uint8Array> => {
          const iterator = receiver.frames[Symbol.asyncIterator]();
          return {
            next: async () => {
              try {
                const frame = await iterator.next();
                if (task.controller.signal.aborted) throw task.controller.signal.reason;
                if (frame.done) await task.closed.promise;
                return frame;
              } catch (error) {
                throw task.controller.signal.aborted ? toError(task.controller.signal.reason) : toError(error);
              }
            },
            return: async () => { await close(); return { done: true, value: undefined }; },
            throw: async (reason: unknown) => { await close(); throw toError(reason); },
          };
        },
      },
      markFrameAdvanced: () => {
        this.assertTaskCurrent(task);
        receiver.markFrameAdvanced();
      },
      setPaused: (paused: boolean) => this.setPaused(task, paused),
      close,
    });
  }

  private setPaused(task: PendingTask, paused: boolean): Promise<void> {
    try {
      this.assertTaskCurrent(task);
      if (typeof paused !== 'boolean' || !task.started || !task.offer) throw new TypeError('Invalid local pause control.');
      if (task.receiver?.hasDrained) throw new Error('Local playback has already drained.');
      if (task.control?.paused === paused) return task.control.result.promise;
      this.rejectControl(task, new Error('Local execution control was superseded by a newer revision.'));
      const revision = this.nextRevision(task);
      const requestId = this.nextRequestId();
      const result = deferred<void>();
      const control: PendingControl = {
        requestId, revision, paused, result,
        timer: setTimeout(() => this.timeoutTask(task), CONTROL_TIMEOUT_MS),
      };
      task.control = control;
      this.controlRequests.set(requestId, task);
      try {
        this.transport.send(task.connection, {
          type: MessageType.BOT_LOCAL_TASK_CONTROL, requestId,
          payload: { taskId: task.offer.taskId, revision, action: paused ? 'pause' : 'resume' },
        });
      } catch (error) { this.failTask(task, toError(error)); }
      return result.promise;
    } catch (error) { return Promise.reject(toError(error)); }
  }

  private nextRevision(task: PendingTask): number {
    if (task.revision >= 0xffffffff) throw new Error('Local execution control revisions are exhausted.');
    return ++task.revision;
  }

  private confirmControl(task: PendingTask, event: Extract<LocalTaskEvent, { state: 'paused' | 'resumed' }>): void {
    const paused = event.state === 'paused';
    const control = task.control;
    if (event.revision < task.revision) return;
    if (event.revision !== task.revision || !task.started ||
        (control ? control.paused !== paused :
          task.confirmedControl?.revision !== event.revision || task.confirmedControl.paused !== paused)) {
      this.invalidTask(task);
      return;
    }
    if (!control) return;
    clearTimeout(control.timer);
    this.controlRequests.delete(control.requestId);
    task.control = undefined;
    task.confirmedControl = { revision: event.revision, paused };
    control.result.resolve();
  }

  private rejectControl(task: PendingTask, error: Error): void {
    const control = task.control;
    if (!control) return;
    clearTimeout(control.timer);
    this.controlRequests.delete(control.requestId);
    task.control = undefined;
    control.result.reject(error);
  }

  private cancelTask(task: PendingTask): void {
    if (task.terminal) return;
    if (task.offer) {
      this.terminate(task, new LocalExecutionError({ state: 'cancelled', taskId: task.offer.taskId, cause: 'requested' }), true);
    } else {
      task.cancelled = abortError();
      task.unsubscribe();
      task.result.reject(task.cancelled);
      task.closed.reject(task.cancelled);
      // An offer can race cancellation. Retain its bounded correlation only to cancel, never to create a peer.
    }
  }

  private timeoutTask(task: PendingTask): void {
    if (task.terminal) return;
    if (task.offer) {
      this.terminate(task, new LocalExecutionError({ state: 'failed', taskId: task.offer.taskId, reason: 'timeout' }), true);
    } else this.failTask(task, new Error('Local execution admission timed out.'));
  }

  private disconnectTask(task: PendingTask): void {
    const error = task.offer
      ? new LocalExecutionError({ state: 'cancelled', taskId: task.offer.taskId, cause: 'bot_disconnected' })
      : new Error('Local execution signaling disconnected.');
    this.terminate(task, error, false);
  }

  private invalidTask(task: PendingTask): void {
    const error = task.offer
      ? new LocalExecutionError({ state: 'failed', taskId: task.offer.taskId, reason: 'invalid_request' })
      : new Error('The local task response does not match its request or reservation.');
    this.terminate(task, error, true);
  }

  private failTask(task: PendingTask, error: Error): void {
    if (task.offer) {
      if (!this.transport.isCurrent(task.connection)) this.disconnectTask(task);
      else this.terminate(task,
        new LocalExecutionError({ state: 'failed', taskId: task.offer.taskId, reason: 'invalid_request' }), true);
    } else this.terminate(task, error, false);
  }

  private mediaFailed(task: PendingTask, error: Error): void {
    if (task.terminal) return;
    if (!this.transport.isCurrent(task.connection)) { this.disconnectTask(task); return; }
    if (!task.offer) { this.failTask(task, error); return; }
    const failure = new LocalExecutionError({ state: 'failed', taskId: task.offer.taskId, reason: 'transport_failed' });
    this.terminate(task, failure, false);
    if (this.transport.isCurrent(task.connection)) {
      try {
        this.transport.send(task.connection, { type: MessageType.BOT_LOCAL_TASK_EVENT, payload: failure.event });
      } catch (sendError) { this.transport.reportError(sendError); }
    }
  }

  private removeTask(task: PendingTask): void {
    this.requests.delete(task.requestId);
    if (task.offer) this.tasks.delete(task.offer.taskId);
    clearTimeout(task.timer);
    if (task.expiryTimer) clearTimeout(task.expiryTimer);
    if (task.completionTimer) clearTimeout(task.completionTimer);
    task.unsubscribe();
    this.rejectControl(task, new Error('Local execution completed before the control acknowledgement.'));
  }

  private terminate(task: PendingTask, error: Error, notify: boolean): void {
    if (task.terminal) return;
    task.terminal = true;
    this.rejectControl(task, error);
    this.removeTask(task);
    if (task.receiver) task.cleanup = this.trackCleanup(task.receiver.abort(error));
    task.controller.abort(error);
    task.result.reject(error);
    task.closed.reject(error);
    if (notify && task.offer && this.transport.isCurrent(task.connection)) {
      try {
        this.transport.send(task.connection, {
          type: MessageType.BOT_LOCAL_TASK_CONTROL,
          payload: { taskId: task.offer.taskId, revision: this.nextRevision(task), action: 'cancel' },
        });
      } catch (sendError) { this.transport.reportError(sendError); }
    }
  }

  private trackCleanup(cleanup: Promise<void>): Promise<void> {
    this.cleanups.add(cleanup);
    void cleanup.then(() => this.cleanups.delete(cleanup), (error: unknown) => {
      this.cleanups.delete(cleanup);
      this.transport.reportError(error);
    });
    return cleanup;
  }
}

class ContextLocalExecutor implements LocalExecutor {
  constructor(private readonly client: BotLocalExecutionClient, private readonly binding: ExecutorBinding) {}

  execute(
    spec: Extract<LocalTaskSpec, { operation: 'youtube.search' }>, options?: LocalExecutionTaskOptions,
  ): Promise<Extract<LocalWireTaskResult, { operation: 'youtube.search' }>>;
  execute(
    spec: Extract<LocalTaskSpec, { operation: 'youtube.resolve' }>, options?: LocalExecutionTaskOptions,
  ): Promise<Extract<LocalWireTaskResult, { operation: 'youtube.resolve' }>>;
  execute(
    spec: Extract<LocalTaskSpec, { operation: 'youtube.preview' }>, options?: LocalExecutionTaskOptions,
  ): Promise<LocalWirePreviewResult>;
  execute(spec: LocalMetadataTaskSpec, options?: LocalExecutionTaskOptions): Promise<LocalMetadataTaskResult>;
  execute(spec: LocalMetadataTaskSpec, options?: LocalExecutionTaskOptions): Promise<LocalMetadataTaskResult> {
    return this.client.execute(this.binding, spec, options);
  }

  stream(
    spec: Extract<LocalTaskSpec, { operation: 'youtube.stream' }>, options: LocalStreamOptions,
  ): Promise<LocalOpusStream> {
    return this.client.stream(this.binding, spec, options);
  }
}
