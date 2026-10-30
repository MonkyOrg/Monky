import { randomUUID } from 'node:crypto';
import {
  LOCAL_EXECUTION_PROTOCOL_LIMITS as limits,
  LOCAL_MEDIA_PROTOCOL,
  LOCAL_OPERATION_CAPABILITY,
  MessageType,
  ProtocolErrorCode,
  commandRequestIdSchema,
  localMediaSignalSchema,
  localSourceRequestSchema,
  localTaskAcceptMatchesOffer,
  localTaskAcceptSchema,
  localTaskControlSchema,
  localTaskEventSchema,
  localTaskMatchesSource,
  localTaskOfferSchema,
  localTaskRequestSchema,
  raceSignal,
  type LocalMediaSignal,
  type LocalPreviewReference,
  type LocalRequestContext,
  type LocalSourceContext,
  type LocalTaskCancellationCause,
  type LocalTaskEvent,
  type LocalTaskFailureReason,
  type LocalTaskOffer,
  type LocalTaskRequest,
  type ServerMessage,
} from '@monky/shared';
import {
  LocalAdmissionError,
  MAX_PREVIEW_PROOFS,
  MAX_SOURCES,
  MAX_TASKS,
  botChange,
  invokerChange,
  localAdmissionError,
  pinBot,
  type BotLocalContext,
  type BotLocalExecutionTransport,
  type BotLocalSession,
  type LocalAdmissionFailure,
  type PinnedBot,
  type PinnedInvoker,
  type PreviewProof,
  type ReleasedSource,
  type RetiredTask,
  type Source,
  type Task,
} from './botLocalExecutionRecords';
import { BotLocalAdmissions, type Admission } from './BotLocalAdmissions';

export type { BotLocalContext, BotLocalExecutionTransport, BotLocalSession } from './botLocalExecutionRecords';

/** How duringTask tells a dropped task apart from a failure of the operation it was awaiting. */
const TASK_DROPPED = Symbol('task dropped');

/**
 * Local execution between a bot and the person whose app runs it: retained sources, task offers, private
 * media signalling and task events, each revoked as soon as either side loses its connection or access.
 * Every request in flight is bounded by BotLocalAdmissions.
 */
export class BotLocalExecutionService<Session extends BotLocalSession> {
  private readonly sources = new Map<string, Source<Session>>();
  private readonly released = new Map<string, ReleasedSource>();
  private readonly tasks = new Map<string, Task<Session>>();
  private readonly previews = new Map<string, PreviewProof<Session>>();
  private readonly retired = new Map<string, RetiredTask<Session>>();
  private readonly admissions: BotLocalAdmissions<Session>;
  private readonly sweepTimer: NodeJS.Timeout;
  private closed = false;
  private generation = 0;
  private reconciliation?: Promise<void>;
  private reconcileRequested = false;

  constructor(private readonly transport: BotLocalExecutionTransport<Session>) {
    this.admissions = new BotLocalAdmissions(transport, this.tasks, this.sources, () => this.expire());
    this.sweepTimer = setInterval(() => this.expire(), 1000);
    this.sweepTimer.unref();
  }

  get counts(): Readonly<{ sources: number; released: number; tasks: number; previews: number; retired: number }> {
    return {
      sources: this.sources.size, released: this.released.size, tasks: this.tasks.size,
      previews: this.previews.size, retired: this.retired.size,
    };
  }

  async handle(session: Session, type: MessageType, payload: unknown, requestId?: string): Promise<void> {
    if (this.closed || !this.transport.isCurrent(session)) return;
    const socket = session.ws;
    const sessionId = session.sessionId;
    try {
      switch (type) {
        case MessageType.BOT_LOCAL_SOURCE_REQUEST:
          await this.sourceRequest(session, payload, this.correlation(requestId));
          break;
        case MessageType.BOT_LOCAL_TASK_REQUEST:
          await this.taskRequest(session, payload, this.correlation(requestId));
          break;
        case MessageType.BOT_LOCAL_TASK_ACCEPT:
          await this.accept(session, payload);
          break;
        case MessageType.BOT_LOCAL_TASK_CONTROL:
          await this.control(session, payload);
          break;
        case MessageType.BOT_LOCAL_TASK_EVENT:
          await this.event(session, payload);
          break;
        case MessageType.BOT_LOCAL_MEDIA_SIGNAL:
          await this.signal(session, payload);
          break;
        default:
          throw new LocalAdmissionError('invalid_request', ProtocolErrorCode.BAD_REQUEST);
      }
    } catch (error) {
      if (!(error instanceof LocalAdmissionError)) this.reportError(error);
      if (session.ws === socket && session.sessionId === sessionId && this.transport.isCurrent(session)) {
        this.sendError(session,
          error instanceof LocalAdmissionError ? error.code : ProtocolErrorCode.INTERNAL_ERROR,
          error instanceof LocalAdmissionError ? error.reason : 'transport_failed', requestId);
      }
    }
  }

  private reportError(error: unknown): void {
    try { this.transport.reportError(error); } catch (reportingError) {
      // A broken diagnostic adapter must not strand shutdown or hide the original failure.
      console.error('[BOT] Local execution diagnostic delivery failed.', error, reportingError);
    }
  }

  private sendError(session: Session, code: ProtocolErrorCode, reason: string, requestId?: string): void {
    try { this.transport.error(session, code, reason, requestId); } catch (error) { this.reportError(error); }
  }

  private send(session: Session, message: ServerMessage): boolean {
    try { return this.transport.send(session, message); } catch (error) { this.reportError(error); return false; }
  }

  private correlation(requestId: string | undefined): string {
    const parsed = commandRequestIdSchema.safeParse(requestId);
    if (!parsed.success) throw new LocalAdmissionError('invalid_request', ProtocolErrorCode.BAD_REQUEST);
    return parsed.data;
  }

  private async authenticateBot(session: Session, admission: Admission<Session>): Promise<LocalTaskOffer['bot']> {
    const pinned = pinBot(session);
    if (!pinned || !this.transport.isCurrent(session)) throw new LocalAdmissionError('permission_denied');
    const identity = await this.admissions.during(admission, () => this.transport.botIdentity(session));
    this.admissions.assert(admission);
    const binding = identity ? await this.admissions.during(admission, () => this.transport.botBinding(identity.botId)) : undefined;
    this.admissions.assert(admission);
    // The session checks below (closed, isCurrent, changed) are a second line that never decides today: the
    // assert above, like the ledger after every await, already refused a changed socket, login or identity
    // with these same pins. So an identity change mid-request is refused there, without the invalidateBot
    // below, which only the identity or binding read from storage reaches.
    const changed = botChange(session, pinned);
    if (this.closed || !this.transport.isCurrent(session) || changed === 'connection' || changed === 'session') {
      throw new LocalAdmissionError('bot_disconnected', ProtocolErrorCode.BOT_OFFLINE);
    }
    if (changed || !identity || identity.botId !== pinned.botId || identity.botPublicKey !== pinned.botPublicKey ||
        binding !== pinned.botPublicKey) {
      this.invalidateBot(pinned.botId);
      throw new LocalAdmissionError('permission_denied');
    }
    return identity;
  }

  private async sourceRequest(session: Session, payload: unknown, requestId: string): Promise<void> {
    const parsed = localSourceRequestSchema.safeParse(payload);
    if (!parsed.success) throw new LocalAdmissionError('invalid_request', ProtocolErrorCode.BAD_REQUEST);
    const request = parsed.data;
    const context: LocalRequestContext | undefined = request.action === 'retain'
      ? { kind: 'invocation', invocationId: request.invocationId }
      : request.action === 'check' ? { kind: 'source', sourceContextId: request.sourceContextId } : undefined;
    return this.admissions.run(this.admissions.reserve(session.botId ?? '',
      request.action === 'retain' ? 'source' : 'operation', context, session,
      request.action === 'check' ? request.voiceChannelId : undefined), async (admission) => {
      if (request.action === 'check') {
        const { scope } = this.bindSourceAdmission(session, request.sourceContextId, admission);
        const bot = await this.authenticateBot(session, admission);
        await this.authorizeAdmission(admission, session, bot.botPublicKey, scope, request.voiceChannelId);
        this.admissions.assert(admission);
        this.send(session, {
          type: MessageType.BOT_LOCAL_SOURCE_RESULT, requestId,
          payload: { status: 'available', sourceContextId: request.sourceContextId, voiceChannelId: request.voiceChannelId },
        });
        return;
      }
      const bot = await this.authenticateBot(session, admission);
      this.admissions.assert(admission);
      if (request.action === 'release') {
        const source = this.sources.get(request.sourceContextId);
        const owner = source?.value ?? this.released.get(request.sourceContextId);
        if (!owner || owner.botId !== bot.botId || owner.botPublicKey !== bot.botPublicKey) {
          throw new LocalAdmissionError('permission_denied');
        }
        if (source) {
          this.removeSource(source, 'source_released');
          this.rememberRelease(source.value);
        }
        this.send(session, {
          type: MessageType.BOT_LOCAL_SOURCE_RESULT, requestId,
          payload: { status: 'released', sourceContextId: request.sourceContextId },
        });
        return;
      }
      const scope = await this.admissions.during(admission, () => this.transport.authorizeContext(session,
        { kind: 'invocation', invocationId: request.invocationId }, 'youtube-audio'));
      this.admissions.assert(admission);
      if (!scope) throw new LocalAdmissionError('permission_denied');
      this.admissions.bind(admission, scope);
      await this.authorizeAdmission(admission, session, bot.botPublicKey, scope);
      this.admissions.assert(admission);
      if (this.sources.size >= MAX_SOURCES ||
          [...this.sources.values()].filter((source) => source.value.botId === bot.botId).length >= limits.sourceContextsPerBot) {
        throw new LocalAdmissionError('busy', ProtocolErrorCode.BOT_COMMAND_BUSY);
      }
      const invokerSessionId = scope.origin.sessionId;
      if (!invokerSessionId) throw new LocalAdmissionError('requester_disconnected');
      const value: LocalSourceContext = {
        sourceContextId: randomUUID(), botId: bot.botId, botPublicKey: bot.botPublicKey,
        invokerId: scope.invokerId, invokerSessionId, originChannelId: scope.originChannelId,
        capability: scope.capability, provider: 'youtube-local', url: request.url,
        expiresAt: Date.now() + limits.sourceContextTtlMs,
      };
      const source: Source<Session> = { value, origin: scope.origin, originSocket: scope.origin.ws, commandName: scope.commandName };
      this.sources.set(value.sourceContextId, source);
      admission.source = source;
      if (!this.send(session, { type: MessageType.BOT_LOCAL_SOURCE_RESULT, requestId, payload: { status: 'retained', source: value } })) {
        this.removeSource(source, 'bot_disconnected');
      }
    });
  }

  private async taskRequest(session: Session, payload: unknown, requestId: string): Promise<void> {
    const parsed = localTaskRequestSchema.safeParse(payload);
    if (!parsed.success) throw new LocalAdmissionError('invalid_request', ProtocolErrorCode.BAD_REQUEST);
    const input = parsed.data;
    return this.admissions.run(this.admissions.reserve(session.botId ?? '', 'task', input.context, session, input.voiceChannelId),
      (admission) => this.admitTask(session, input, requestId, admission));
  }

  private bindSourceAdmission(
    session: Session, sourceContextId: string, admission: Admission<Session>, spec?: LocalTaskRequest['spec'],
  ): { source: Source<Session>; scope: BotLocalContext<Session> } {
    const source = this.sources.get(sourceContextId);
    if (!source || source.value.botId !== admission.botId || source.value.botPublicKey !== admission.botPublicKey) {
      throw new LocalAdmissionError('permission_denied');
    }
    if (spec && !localTaskMatchesSource(source.value, spec)) {
      throw new LocalAdmissionError('invalid_request', ProtocolErrorCode.BAD_REQUEST);
    }
    const invoker: PinnedInvoker = {
      originSocket: source.originSocket, invokerSessionId: source.value.invokerSessionId, invokerId: source.value.invokerId,
    };
    if (!this.transport.isCurrent(source.origin) || invokerChange(source.origin, invoker)) {
      throw new LocalAdmissionError('requester_disconnected', ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
    }
    const scope: BotLocalContext<Session> = {
      origin: source.origin, bot: session, requestId: randomUUID(), invokerId: source.value.invokerId,
      originChannelId: source.value.originChannelId, commandName: source.commandName,
      capability: source.value.capability, expiresAt: source.value.expiresAt,
      isCurrent: () => this.sources.get(source.value.sourceContextId) === source && Date.now() < source.value.expiresAt,
    };
    this.admissions.bind(admission, scope, source);
    return { source, scope };
  }

  private async admitTask(session: Session, input: LocalTaskRequest, requestId: string, admission: Admission<Session>): Promise<void> {
    const startDeadline = admission.deadline;
    const capability = LOCAL_OPERATION_CAPABILITY[input.spec.operation];
    if (!this.transport.negotiated(session, input.spec.operation)) {
      throw new LocalAdmissionError('invalid_request', ProtocolErrorCode.FEATURE_REQUIRES_UPDATE);
    }
    let source: Source<Session> | undefined;
    let scope: BotLocalContext<Session> | undefined;
    if (input.context.kind === 'source') {
      ({ source, scope } = this.bindSourceAdmission(session, input.context.sourceContextId, admission, input.spec));
    }
    const bot = await this.authenticateBot(session, admission);
    this.admissions.assert(admission);
    if (input.context.kind !== 'source') {
      const context = input.context;
      scope = await this.admissions.during(admission, () => this.transport.authorizeContext(session, context, capability));
      this.admissions.assert(admission);
      if (scope) this.admissions.bind(admission, scope);
    }
    if (!scope) throw new LocalAdmissionError('permission_denied');
    // Refuse before any offer: an outdated executor would ignore it and leave the bot waiting for the timeout.
    if (!this.transport.negotiated(scope.origin, input.spec.operation)) {
      throw new LocalAdmissionError('executor_unavailable', ProtocolErrorCode.FEATURE_REQUIRES_UPDATE);
    }
    await this.authorizeAdmission(admission, session, bot.botPublicKey, scope, input.voiceChannelId);
    this.admissions.assert(admission);
    if (Date.now() >= startDeadline) throw new LocalAdmissionError('timeout', ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
    if (this.tasks.size >= MAX_TASKS ||
        [...this.tasks.values()].filter((task) => task.botId === bot.botId).length >= limits.tasksPerBot ||
        [...this.tasks.values()].filter((task) => task.origin === scope.origin && task.originSocket === scope.origin.ws).length >= limits.tasksPerExecutor) {
      throw new LocalAdmissionError('busy', ProtocolErrorCode.BOT_COMMAND_BUSY);
    }
    const invokerSessionId = scope.origin.sessionId;
    const botSessionId = session.sessionId;
    if (!invokerSessionId || !botSessionId) throw new LocalAdmissionError('executor_unavailable');
    const id = randomUUID();
    const setupDeadline = Math.min(scope.expiresAt, startDeadline);
    const setupTimer = setTimeout(() => this.failById(id, 'timeout'), Math.max(0, setupDeadline - Date.now()));
    const lifetimeTimer = setTimeout(() => this.cancelById(id, 'expired'), Math.max(0, scope.expiresAt - Date.now()));
    setupTimer.unref();
    lifetimeTimer.unref();
    const task: Task<Session> = {
      id, context: input.context, scope, source, origin: scope.origin, originSocket: scope.origin.ws,
      bot: session, botSocket: session.ws, botId: bot.botId, botPublicKey: bot.botPublicKey,
      botSessionId, invokerId: scope.invokerId, invokerSessionId, requestId, spec: input.spec, voiceChannelId: input.voiceChannelId,
      expiresAt: scope.expiresAt, setupDeadline,
      generation: this.generation = this.generation === 0xffffffff ? 1 : this.generation + 1, offered: false, botAssigned: false,
      ready: false, botReady: false, executorReady: false, offerRelayed: false, answerRelayed: false,
      candidates: 0, queuedSignals: [], revision: -1, setupTimer, lifetimeTimer, controller: new AbortController(),
    };
    this.tasks.set(id, task);
    try {
      this.admissions.bindTask(admission, task);
      const accessVersion = this.transport.accessVersion();
      const negotiation = input.spec.operation === 'youtube.stream'
        ? await this.duringTask(task, Promise.all([
          this.admissions.during(admission, () => this.transport.iceServers(session)),
          this.admissions.during(admission, () => this.transport.iceServers(task.origin)),
        ])) : undefined;
      if (negotiation && !negotiation.active) return;
      this.admissions.assert(admission);
      const ice = negotiation?.active ? negotiation.value : undefined;
      if (!(await this.authorizeTask(task, admission))) return;
      this.admissions.assert(admission);
      if (accessVersion === null || accessVersion !== this.transport.accessVersion()) {
        this.failTask(task, 'busy');
        return;
      }
      const common = {
        taskId: id, requestId: scope.requestId, context: input.context, bot, botSessionId,
        invokerId: scope.invokerId, invokerSessionId, capability, spec: input.spec, expiresAt: scope.expiresAt,
        ...(input.voiceChannelId ? { voiceChannelId: input.voiceChannelId } : {}),
      };
      task.botOffer = localTaskOfferSchema.parse({
        ...common, ...(ice ? { media: { protocol: LOCAL_MEDIA_PROTOCOL, generation: task.generation, iceServers: ice[0] } } : {}),
      });
      task.executorOffer = localTaskOfferSchema.parse({
        ...common, ...(ice ? { media: { protocol: LOCAL_MEDIA_PROTOCOL, generation: task.generation, iceServers: ice[1] } } : {}),
      });
      // This no-await boundary assigns BOTH receivers before any private SDP can be relayed.
      if (!this.send(session, { type: MessageType.BOT_LOCAL_TASK_OFFER, requestId, payload: task.botOffer })) {
        this.cancelTask(task, 'bot_disconnected');
        return;
      }
      task.botAssigned = true;
      if (this.tasks.get(task.id) !== task) return;
      if (!this.send(scope.origin, { type: MessageType.BOT_LOCAL_TASK_OFFER, payload: task.executorOffer })) {
        this.cancelTask(task, 'requester_disconnected');
        return;
      }
      task.offered = true;
    } catch (error) {
      this.failTask(task, error instanceof LocalAdmissionError ? this.failureReason(error.reason) : 'transport_failed');
      if (!(error instanceof LocalAdmissionError)) this.reportError(error);
    }
  }

  private async authorizeAdmission(
    admission: Admission<Session>, bot: Session, botPublicKey: string, scope: BotLocalContext<Session>, voiceChannelId?: string,
  ): Promise<void> {
    // Both connections as they were before the awaits below; the bot must still present the key it was admitted with.
    const pinnedBot: PinnedBot = { botSocket: bot.ws, botSessionId: bot.sessionId, botId: bot.botId, botPublicKey };
    const invoker: PinnedInvoker = { originSocket: scope.origin.ws, invokerSessionId: scope.origin.sessionId, invokerId: scope.invokerId };
    const { botId } = pinnedBot;
    if (scope.bot !== bot) throw new LocalAdmissionError('permission_denied');
    const version = this.transport.accessVersion();
    if (version === null) throw new LocalAdmissionError('busy', ProtocolErrorCode.BOT_COMMAND_BUSY);
    const [allowed, voiceAllowed] = await Promise.all([
      this.admissions.during(admission, () => this.transport.authorizeCaller(scope.invokerId, scope.originChannelId)),
      voiceChannelId ? this.admissions.during(admission, () => this.transport.authorizeVoice(scope.origin, bot, voiceChannelId)) : true,
    ]);
    this.admissions.assert(admission);
    const binding = botId ? await this.admissions.during(admission, () => this.transport.botBinding(botId)) : undefined;
    this.admissions.assert(admission);
    // The connection checks below (closed, isCurrent, botChanged, invokerChange) are a second line that never
    // decides today: the assert above, like the ledger after every await, already refused a changed socket,
    // login or identity of either side with these same pins. So an identity change mid-request is refused
    // there, without the invalidateBot below, which only the binding read from storage reaches.
    const botChanged = botChange(bot, pinnedBot);
    if (this.closed || !this.transport.isCurrent(bot) || botChanged === 'connection' || botChanged === 'session') {
      throw new LocalAdmissionError('bot_disconnected', ProtocolErrorCode.BOT_OFFLINE);
    }
    if (!invoker.invokerSessionId || !this.transport.isCurrent(scope.origin) || invokerChange(scope.origin, invoker)) {
      throw new LocalAdmissionError('requester_disconnected', ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
    }
    if (botChanged || binding !== botPublicKey) {
      if (bot.botId) this.invalidateBot(bot.botId);
      throw new LocalAdmissionError('permission_denied');
    }
    if (version !== this.transport.accessVersion()) throw new LocalAdmissionError('busy', ProtocolErrorCode.BOT_COMMAND_BUSY);
    if (!scope.isCurrent() || Date.now() >= scope.expiresAt) {
      throw new LocalAdmissionError('expired', ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
    }
    if (voiceChannelId) {
      if (this.transport.voiceChannelId(scope.origin) !== voiceChannelId) throw new LocalAdmissionError('requester_left_voice');
      if (this.transport.voiceChannelId(bot) !== voiceChannelId) throw new LocalAdmissionError('bot_left_voice');
    }
    if (!allowed || !voiceAllowed || !bot.botId ||
        !this.transport.commandHasCapability(bot.botId, scope.commandName, scope.capability)) {
      throw new LocalAdmissionError('permission_denied');
    }
  }

  private endpoint(session: Session, task: Task<Session> | RetiredTask<Session>): 'bot' | 'executor' {
    if (session === task.bot && !botChange(session, task)) return 'bot';
    if (session === task.origin && !invokerChange(session, task)) return 'executor';
    throw new LocalAdmissionError('permission_denied');
  }

  private findTask(session: Session, id: string): Task<Session> {
    const task = this.tasks.get(id);
    if (!task) throw new LocalAdmissionError('expired', ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
    this.endpoint(session, task);
    return task;
  }

  private liveFailure(task: Task<Session>): LocalTaskCancellationCause | undefined {
    if (this.closed) return 'server_shutdown';
    const botChanged = botChange(task.bot, task);
    const invokerChanged = invokerChange(task.origin, task);
    if (!this.transport.isCurrent(task.bot) || botChanged === 'connection') return 'bot_disconnected';
    if (!this.transport.isCurrent(task.origin) || invokerChanged === 'connection') return 'requester_disconnected';
    // Another login or identity on the same socket is not a departure: the access this task was granted is gone.
    if (botChanged || invokerChanged) return 'permission_revoked';
    if (Date.now() >= task.expiresAt || (!task.ready && Date.now() >= task.setupDeadline)) return 'expired';
    if (task.voiceChannelId) {
      if (this.transport.voiceChannelId(task.origin) !== task.voiceChannelId) return 'requester_left_voice';
      if (this.transport.voiceChannelId(task.bot) !== task.voiceChannelId) return 'bot_left_voice';
    }
    if (!task.scope.isCurrent()) return 'expired';
    if (!this.transport.commandHasCapability(task.botId, task.scope.commandName, task.scope.capability)) return 'permission_revoked';
    return undefined;
  }

  private taskActive(task: Task<Session>): boolean {
    if (this.tasks.get(task.id) !== task) return false;
    const failure = this.liveFailure(task);
    if (failure) { this.cancelTask(task, failure); return false; }
    return true;
  }

  private async authorizeTask(task: Task<Session>, admission?: Admission<Session>): Promise<boolean> {
    if (!this.taskActive(task)) return false;
    try {
      const authorize = (lease: Admission<Session>) => {
        this.admissions.bindTask(lease, task);
        return this.duringTask(task, this.authorizeAdmission(lease, task.bot, task.botPublicKey, task.scope, task.voiceChannelId));
      };
      const authorization = admission ? await authorize(admission)
        : await this.admissions.run(this.admissions.reserve(task.botId, 'operation', task.context, task.bot, task.voiceChannelId), authorize);
      if (!authorization.active) return false;
    } catch (error) {
      if (this.tasks.get(task.id) !== task) return false;
      if (error instanceof LocalAdmissionError) {
        switch (error.reason) {
          case 'bot_disconnected':
          case 'requester_disconnected':
          case 'bot_left_voice':
          case 'requester_left_voice':
          case 'expired':
          case 'requested':
          case 'source_released':
          case 'voice_mode_changed':
          case 'permission_revoked':
          case 'server_shutdown':
            this.cancelTask(task, error.reason);
            break;
          case 'permission_denied':
            this.cancelTask(task, 'permission_revoked');
            break;
          default:
            this.failTask(task, this.failureReason(error.reason));
        }
      } else {
        this.reportError(error);
        this.failTask(task, 'transport_failed');
      }
      return false;
    }
    return this.taskActive(task);
  }

  private async accept(session: Session, payload: unknown): Promise<void> {
    const parsed = localTaskAcceptSchema.safeParse(payload);
    if (!parsed.success) throw new LocalAdmissionError('invalid_request', ProtocolErrorCode.BAD_REQUEST);
    const task = this.findTask(session, parsed.data.taskId);
    if (this.endpoint(session, task) !== 'executor') throw new LocalAdmissionError('permission_denied');
    if (!(await this.authorizeTask(task)) || !this.taskActive(task)) return;
    if (!task.offered || !task.executorOffer || task.accepted || !localTaskAcceptMatchesOffer(task.executorOffer, parsed.data) ||
        (task.spec.operation === 'youtube.stream' && !task.answerRelayed)) {
      this.failTask(task, 'invalid_request');
      throw new LocalAdmissionError('invalid_request', ProtocolErrorCode.BAD_REQUEST);
    }
    const result = parsed.data.result;
    if (result.operation !== 'youtube.stream') {
      if (result.operation === 'youtube.preview' && task.context.kind === 'audio-preview') {
        this.expire();
        if (this.previews.size >= MAX_PREVIEW_PROOFS) {
          this.failTask(task, 'busy');
          return;
        }
        this.previews.set(task.id, {
          result, contextId: task.context.requestId, bot: task.bot, botSocket: task.botSocket,
          botId: task.botId, botPublicKey: task.botPublicKey, origin: task.origin, originSocket: task.originSocket,
          expiresAt: task.expiresAt,
        });
      }
      // Metadata completion is atomic with acceptance, before COMMAND_FINISH can cancel it.
      this.dropTask(task);
      this.sendEvent(task, { state: 'accepted', taskId: task.id, result });
      this.sendEvent(task, { state: 'completed', taskId: task.id });
      return;
    }
    const botMedia = task.botOffer?.media;
    const executorMedia = task.executorOffer.media;
    if (!botMedia || !executorMedia) {
      this.failTask(task, 'invalid_request');
      return;
    }
    task.accepted = result;
    if (!this.send(task.bot, {
      type: MessageType.BOT_LOCAL_TASK_EVENT,
      payload: { state: 'accepted', taskId: task.id, result, media: botMedia },
    })) { this.cancelTask(task, 'bot_disconnected'); return; }
    if (!this.send(task.origin, {
      type: MessageType.BOT_LOCAL_TASK_EVENT,
      payload: { state: 'accepted', taskId: task.id, result, media: executorMedia },
    })) { this.cancelTask(task, 'requester_disconnected'); return; }
    this.publishReady(task);
  }

  private async signal(session: Session, payload: unknown): Promise<void> {
    const parsed = localMediaSignalSchema.safeParse(payload);
    if (!parsed.success) throw new LocalAdmissionError('invalid_request', ProtocolErrorCode.BAD_REQUEST);
    const signal = parsed.data;
    const task = this.findTask(session, signal.taskId);
    const endpoint = this.endpoint(session, task);
    if (!(await this.authorizeTask(task)) || !this.taskActive(task)) return;
    if (!task.offered || task.spec.operation !== 'youtube.stream' || signal.mediaGeneration !== task.generation) {
      throw new LocalAdmissionError('invalid_request', ProtocolErrorCode.BAD_REQUEST);
    }
    switch (signal.signal.signalType) {
      case 'offer':
        if (endpoint !== 'executor' || task.offerRelayed || task.ready) throw new LocalAdmissionError('invalid_request', ProtocolErrorCode.BAD_REQUEST);
        task.offerRelayed = true;
        task.mediaTimer = setTimeout(() => this.failTask(task, 'transport_failed'), limits.mediaConnectTimeoutMs);
        task.mediaTimer.unref();
        this.relay(task, endpoint, signal);
        this.flushSignals(task, endpoint);
        break;
      case 'answer':
        if (endpoint !== 'bot' || !task.offerRelayed || task.answerRelayed || task.ready) {
          throw new LocalAdmissionError('invalid_request', ProtocolErrorCode.BAD_REQUEST);
        }
        task.answerRelayed = true;
        this.relay(task, endpoint, signal);
        this.flushSignals(task, endpoint);
        break;
      case 'candidate':
        if (++task.candidates > limits.iceCandidates) { this.failTask(task, 'transport_failed'); return; }
        if (endpoint === 'bot' ? task.answerRelayed : task.offerRelayed) this.relay(task, endpoint, signal);
        else {
          if (task.queuedSignals.length >= limits.queuedSignals) { this.failTask(task, 'transport_failed'); return; }
          task.queuedSignals.push({ endpoint, payload: signal });
        }
        break;
    }
  }

  private relay(task: Task<Session>, endpoint: 'bot' | 'executor', payload: LocalMediaSignal): void {
    if (this.tasks.get(task.id) !== task) return;
    if (!this.send(endpoint === 'bot' ? task.origin : task.bot, { type: MessageType.BOT_LOCAL_MEDIA_SIGNAL, payload })) {
      this.cancelTask(task, endpoint === 'bot' ? 'requester_disconnected' : 'bot_disconnected');
    }
  }

  private flushSignals(task: Task<Session>, endpoint: 'bot' | 'executor'): void {
    const queued = task.queuedSignals.filter((signal) => signal.endpoint === endpoint);
    task.queuedSignals = task.queuedSignals.filter((signal) => signal.endpoint !== endpoint);
    for (const signal of queued) this.relay(task, endpoint, signal.payload);
  }

  private async control(session: Session, payload: unknown): Promise<void> {
    const parsed = localTaskControlSchema.safeParse(payload);
    if (!parsed.success) throw new LocalAdmissionError('invalid_request', ProtocolErrorCode.BAD_REQUEST);
    const control = parsed.data;
    const retired = this.retired.get(control.taskId);
    if (!this.tasks.has(control.taskId) && retired && Date.now() < retired.expiresAt &&
        this.endpoint(session, retired) === 'bot') return;
    const task = this.findTask(session, control.taskId);
    if (this.endpoint(session, task) !== 'bot') throw new LocalAdmissionError('permission_denied');
    if (!(await this.authorizeTask(task)) || !this.taskActive(task)) return;
    if (control.action === 'cancel') { this.cancelTask(task, 'requested'); return; }
    if (!task.ready || task.spec.operation !== 'youtube.stream') {
      throw new LocalAdmissionError('executor_unavailable', ProtocolErrorCode.BAD_REQUEST);
    }
    if (control.revision <= task.revision) {
      const previous = task.control ?? task.confirmedControl;
      if (control.revision === task.revision && previous?.action === control.action) return;
      throw new LocalAdmissionError('invalid_request', ProtocolErrorCode.BAD_REQUEST);
    }
    task.revision = control.revision;
    task.control = control;
    if (task.controlTimer) clearTimeout(task.controlTimer);
    task.controlTimer = setTimeout(() => this.failTask(task, 'transport_failed'), limits.mediaConnectTimeoutMs);
    task.controlTimer.unref();
    if (!this.send(task.origin, { type: MessageType.BOT_LOCAL_TASK_CONTROL, payload: control })) {
      this.cancelTask(task, 'requester_disconnected');
    }
  }

  private async event(session: Session, payload: unknown): Promise<void> {
    const parsed = localTaskEventSchema.safeParse(payload);
    if (!parsed.success) throw new LocalAdmissionError('invalid_request', ProtocolErrorCode.BAD_REQUEST);
    const event = parsed.data;
    if (!this.tasks.has(event.taskId) && this.ignoreRetiredEvent(session, event)) return;
    const task = this.findTask(session, event.taskId);
    const endpoint = this.endpoint(session, task);
    if (!(await this.authorizeTask(task)) || !this.taskActive(task)) return;
    switch (event.state) {
      case 'ready':
        if (!task.offered || task.spec.operation !== 'youtube.stream' || event.mediaGeneration !== task.generation || !task.answerRelayed) break;
        if (endpoint === 'bot') task.botReady = true;
        else task.executorReady = true;
        this.publishReady(task);
        return;
      case 'paused':
      case 'resumed': {
        if (endpoint !== 'executor' || !task.ready) break;
        if (event.revision < task.revision || (!task.control && event.revision === task.confirmedControl?.revision)) return;
        if (!task.control || event.revision !== task.control.revision ||
            (event.state === 'paused' ? 'pause' : 'resume') !== task.control.action) break;
        task.confirmedControl = task.control;
        task.control = undefined;
        if (task.controlTimer) clearTimeout(task.controlTimer);
        task.controlTimer = undefined;
        this.sendEvent(task, event);
        return;
      }
      case 'completed':
        if (endpoint !== 'executor' || !task.ready || !task.accepted || task.spec.operation !== 'youtube.stream' ||
            event.mediaGeneration !== task.generation || event.playedFrames === undefined) break;
        // The executor observed the private drain ACK; the SDK independently checks its local drain/count.
        this.dropTask(task);
        this.sendEvent(task, event);
        return;
      case 'failed':
        if (endpoint === 'bot' && (event.reason !== 'transport_failed' || event.sourceFailure !== undefined)) break;
        this.dropTask(task);
        this.sendEvent(task, event);
        return;
      case 'cancelled':
        if (endpoint !== 'executor' || (event.cause !== 'requested' && event.cause !== 'permission_revoked')) break;
        this.cancelTask(task, event.cause);
        return;
      case 'accepted':
        break;
    }
    throw new LocalAdmissionError('invalid_request', ProtocolErrorCode.BAD_REQUEST);
  }

  private publishReady(task: Task<Session>): void {
    if (this.tasks.get(task.id) !== task || task.ready || !task.accepted || !task.botReady || !task.executorReady) return;
    task.ready = true;
    clearTimeout(task.setupTimer);
    if (task.mediaTimer) clearTimeout(task.mediaTimer);
    task.mediaTimer = undefined;
    this.sendEvent(task, { state: 'ready', taskId: task.id, mediaGeneration: task.generation });
  }

  async consumePreview(
    bot: Session, origin: Session, contextId: string, requestId: string, result: LocalPreviewReference,
  ): Promise<boolean> {
    this.expire();
    const proof = this.previews.get(result.taskId);
    if (!proof || !bot.botId || proof.bot !== bot || proof.origin !== origin) return false;
    try {
      return await this.admissions.run(this.admissions.reserve(bot.botId, 'operation',
        { kind: 'audio-preview', requestId: contextId }, bot), async (admission) => {
        admission.origin = proof.origin;
        admission.originSocket = proof.originSocket;
        admission.invokerSessionId = proof.result.executorSessionId;
        admission.invokerId = proof.origin.user?.id;
        admission.deadline = Math.min(admission.deadline, proof.expiresAt);
        this.admissions.arm(admission);
        const scope = await this.admissions.during(admission, () =>
          this.transport.authorizeContext(bot, { kind: 'audio-preview', requestId: contextId }, 'youtube-audio'));
        this.admissions.assert(admission);
        if (!scope) return false;
        this.admissions.bind(admission, scope);
        const binding = await this.admissions.during(admission, () => this.transport.botBinding(proof.botId));
        this.admissions.assert(admission);
        if (binding !== proof.botPublicKey) {
          this.invalidateBot(proof.botId);
          return false;
        }
        if (this.previews.get(result.taskId) !== proof ||
            !scope.isCurrent() || scope.origin !== origin || scope.bot !== bot ||
            scope.requestId !== requestId || Date.now() >= proof.expiresAt ||
            proof.botSocket !== bot.ws || proof.originSocket !== origin.ws ||
            proof.botId !== bot.botId || proof.botPublicKey !== bot.botPublicKey || !bot.isBot || origin.isBot ||
            !this.transport.isCurrent(bot) || !this.transport.isCurrent(origin) || proof.contextId !== contextId ||
            proof.result.operation !== 'youtube.preview' || proof.result.requestId !== requestId ||
            result.requestId !== requestId || proof.result.localPreviewId !== result.localPreviewId ||
            proof.result.executorSessionId !== result.executorSessionId || origin.sessionId !== result.executorSessionId) return false;
        this.previews.delete(result.taskId);
        return true;
      });
    } catch (error) {
      if (!(error instanceof LocalAdmissionError)) this.reportError(error);
      return false;
    }
  }

  contextEnded(context: Exclude<LocalRequestContext, { kind: 'source' }>, cause: LocalTaskCancellationCause = 'requested'): void {
    const matches = (candidate: LocalRequestContext): boolean => candidate.kind === context.kind &&
      (candidate.kind === 'invocation' && context.kind === 'invocation'
        ? candidate.invocationId === context.invocationId
        : candidate.kind !== 'invocation' && context.kind !== 'invocation' &&
          candidate.requestId === context.requestId);
    for (const admission of this.admissions) {
      if (admission.context && matches(admission.context)) this.admissions.abort(admission, localAdmissionError(cause));
    }
    for (const task of this.tasks.values()) if (matches(task.context)) this.cancelTask(task, cause);
    if (context.kind === 'audio-preview') {
      for (const [id, proof] of this.previews) if (proof.contextId === context.requestId) this.previews.delete(id);
    }
  }

  disconnect(session: Session): void {
    for (const admission of this.admissions) {
      if (admission.bot === session && admission.botSocket === session.ws) this.admissions.abort(admission, localAdmissionError('bot_disconnected'));
      else if (admission.origin === session && admission.originSocket === session.ws) {
        this.admissions.abort(admission, localAdmissionError('requester_disconnected'));
      }
    }
    for (const task of this.tasks.values()) {
      if (task.bot === session && task.botSocket === session.ws) this.cancelTask(task, 'bot_disconnected');
      else if (task.origin === session && task.originSocket === session.ws) this.cancelTask(task, 'requester_disconnected');
    }
    for (const [id, proof] of this.previews) if (proof.bot === session || proof.origin === session) this.previews.delete(id);
    for (const [id, task] of this.retired) if (task.bot === session || task.origin === session) this.retired.delete(id);
    // Retained metadata stays pinned to the old object/socket. A new device cannot inherit it.
  }

  voiceChanged(): void {
    this.admissions.recheck((admission) => !!admission.voiceChannelId);
    for (const task of this.tasks.values()) {
      if (!task.voiceChannelId) continue;
      const failure = this.liveFailure(task);
      if (failure) this.cancelTask(task, failure);
    }
  }

  voiceModeChanged(): void {
    for (const admission of this.admissions) {
      if (admission.voiceChannelId) this.admissions.abort(admission, localAdmissionError('voice_mode_changed'));
    }
    for (const task of this.tasks.values()) if (task.voiceChannelId) this.cancelTask(task, 'voice_mode_changed');
  }

  commandsChanged(botId: string): void {
    for (const admission of this.admissions) {
      if (admission.botId === botId && (!admission.scope ||
          !this.transport.commandHasCapability(botId, admission.scope.commandName, admission.scope.capability))) {
        this.admissions.abort(admission, localAdmissionError('permission_revoked'));
      }
    }
    for (const source of this.sources.values()) {
      if (source.value.botId === botId &&
          !this.transport.commandHasCapability(botId, source.commandName, source.value.capability)) {
        this.removeSource(source, 'permission_revoked');
      }
    }
    for (const task of this.tasks.values()) {
      if (task.botId === botId && !this.transport.commandHasCapability(botId, task.scope.commandName, task.scope.capability)) {
        this.cancelTask(task, 'permission_revoked');
      }
    }
  }

  settingsChanged(botId: string): void {
    for (const admission of this.admissions) {
      if (admission.botId === botId) this.admissions.abort(admission, localAdmissionError('permission_revoked'));
    }
    for (const task of this.tasks.values()) if (task.botId === botId) this.cancelTask(task, 'permission_revoked');
    for (const [id, proof] of this.previews) if (proof.botId === botId) this.previews.delete(id);
  }

  deleteChannel(channelId: string): void {
    for (const admission of this.admissions) {
      if (admission.scope?.originChannelId === channelId || admission.source?.value.originChannelId === channelId ||
          admission.voiceChannelId === channelId) this.admissions.abort(admission, localAdmissionError('permission_revoked'));
    }
    for (const source of this.sources.values()) if (source.value.originChannelId === channelId) this.removeSource(source, 'permission_revoked');
    for (const task of this.tasks.values()) {
      if (task.scope.originChannelId === channelId || task.voiceChannelId === channelId) this.cancelTask(task, 'permission_revoked');
    }
  }

  invalidateBot(botId: string): void {
    for (const admission of this.admissions) {
      if (admission.botId === botId) this.admissions.abort(admission, localAdmissionError('permission_revoked'));
    }
    for (const source of this.sources.values()) if (source.value.botId === botId) this.removeSource(source, 'permission_revoked');
    for (const [id, released] of this.released) if (released.botId === botId) this.released.delete(id);
    for (const task of this.tasks.values()) if (task.botId === botId) this.cancelTask(task, 'permission_revoked');
    for (const [id, proof] of this.previews) if (proof.botId === botId) this.previews.delete(id);
    for (const [id, task] of this.retired) if (task.botId === botId) this.retired.delete(id);
  }

  reconcileAccess(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.reconcileRequested = true;
    if (!this.reconciliation) {
      const reconcile = async () => {
        while (this.reconcileRequested && !this.closed) {
          this.reconcileRequested = false;
          await this.reconcileAccessPass();
        }
      };
      this.reconciliation = reconcile().finally(() => { this.reconciliation = undefined; });
    }
    return this.reconciliation;
  }

  private async reconcileAccessPass(): Promise<void> {
    await Promise.all([...this.tasks.values()].map((task) => this.authorizeTask(task)));
    if (this.closed) return;
    const owners = new Map<string, Source<Session>[]>();
    for (const source of this.sources.values()) {
      const owned = owners.get(source.value.botId) ?? [];
      owned.push(source);
      owners.set(source.value.botId, owned);
    }
    // One bounded, sequential pass per bot, rather than thousands of uncancellable source checks.
    await Promise.all([...owners].map(async ([botId, sources]) => {
      try {
        await this.admissions.run(this.admissions.reserve(botId, 'operation'), async (admission) => {
          for (const source of sources) {
            if (this.sources.get(source.value.sourceContextId) !== source) continue;
            admission.source = source;
            this.admissions.arm(admission);
            try {
              const allowed = await this.admissions.during(admission, () =>
                this.transport.authorizeCaller(source.value.invokerId, source.value.originChannelId));
              this.admissions.assert(admission);
              const binding = await this.admissions.during(admission, () => this.transport.botBinding(source.value.botId));
              this.admissions.assert(admission);
              // Removing this source must not cancel the remaining sources in this pass.
              admission.source = undefined;
              if (binding !== source.value.botPublicKey) { this.invalidateBot(botId); return; }
              if (!allowed) this.removeSource(source, 'permission_revoked');
            } catch (error) {
              if (error instanceof LocalAdmissionError) throw error;
              this.reportError(error);
              admission.source = undefined;
              this.removeSource(source, 'permission_revoked');
            }
          }
        });
      } catch (error) {
        if (!(error instanceof LocalAdmissionError)) this.reportError(error);
      }
    }));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.reconcileRequested = false;
    clearInterval(this.sweepTimer);
    this.admissions.close();
    for (const task of this.tasks.values()) this.cancelTask(task, 'server_shutdown');
    this.sources.clear();
    this.released.clear();
    this.previews.clear();
    this.retired.clear();
  }

  private expire(): void {
    const now = Date.now();
    for (const source of this.sources.values()) if (now >= source.value.expiresAt) this.removeSource(source, 'expired');
    for (const [id, source] of this.released) if (now >= source.expiresAt) this.released.delete(id);
    for (const [id, proof] of this.previews) if (now >= proof.expiresAt) this.previews.delete(id);
    for (const [id, task] of this.retired) if (now >= task.expiresAt) this.retired.delete(id);
    this.admissions.recheck();
  }

  private rememberRelease(source: LocalSourceContext): void {
    const owned = [...this.released].filter(([, value]) => value.botId === source.botId);
    if (owned.length >= limits.sourceContextsPerBot) this.released.delete(owned[0][0]);
    if (this.released.size >= MAX_SOURCES) {
      const first = this.released.keys().next();
      if (!first.done) this.released.delete(first.value);
    }
    this.released.set(source.sourceContextId, {
      botId: source.botId, botPublicKey: source.botPublicKey, expiresAt: source.expiresAt,
    });
  }

  private removeSource(source: Source<Session>, cause: LocalTaskCancellationCause): void {
    if (this.sources.get(source.value.sourceContextId) !== source) return;
    this.sources.delete(source.value.sourceContextId);
    for (const admission of this.admissions) {
      if (admission.source === source) this.admissions.abort(admission, localAdmissionError(cause));
    }
    for (const task of this.tasks.values()) if (task.source === source) this.cancelTask(task, cause);
  }

  private dropTask(task: Task<Session>, failure = localAdmissionError('expired')): boolean {
    if (this.tasks.get(task.id) !== task) return false;
    this.tasks.delete(task.id);
    if (task.botAssigned) this.rememberTask(task);
    clearTimeout(task.setupTimer);
    clearTimeout(task.lifetimeTimer);
    if (task.mediaTimer) clearTimeout(task.mediaTimer);
    if (task.controlTimer) clearTimeout(task.controlTimer);
    task.controller.abort(failure);
    task.queuedSignals = [];
    task.control = undefined;
    return true;
  }

  /** Once the task is dropped this settles inactive, and a late outcome of `operation` is ignored. */
  private async duringTask<T>(task: Task<Session>, operation: Promise<T>): Promise<{ active: true; value: T } | { active: false }> {
    try {
      return { active: true, value: await raceSignal(operation, task.controller.signal, { abortReason: () => TASK_DROPPED }) };
    } catch (error) {
      if (error === TASK_DROPPED) return { active: false };
      throw error;
    }
  }

  private rememberTask(task: Task<Session>): void {
    const owned = [...this.retired].filter(([, previous]) => previous.botId === task.botId);
    if (owned.length >= limits.tasksPerBot) this.retired.delete(owned[0][0]);
    if (this.retired.size >= MAX_TASKS) {
      const oldest = this.retired.keys().next();
      if (!oldest.done) this.retired.delete(oldest.value);
    }
    this.retired.set(task.id, {
      origin: task.origin, originSocket: task.originSocket, invokerId: task.invokerId, invokerSessionId: task.invokerSessionId,
      bot: task.bot, botSocket: task.botSocket, botId: task.botId, botPublicKey: task.botPublicKey, botSessionId: task.botSessionId,
      generation: task.spec.operation === 'youtube.stream' ? task.generation : undefined,
      revision: task.revision, expiresAt: Date.now() + limits.taskStartTimeoutMs,
    });
  }

  private ignoreRetiredEvent(session: Session, event: LocalTaskEvent): boolean {
    const task = this.retired.get(event.taskId);
    if (!task || Date.now() >= task.expiresAt) return false;
    const endpoint = this.endpoint(session, task);
    // Renderer metadata completion and native stop acknowledgements may already be queued when a task ends.
    // These bounded receipts suppress only owned, harmless late reports; they never publish success or revive work.
    switch (event.state) {
      case 'completed':
        return endpoint === 'executor' && (task.generation === undefined
          ? event.mediaGeneration === undefined && event.playedFrames === undefined
          : event.mediaGeneration === task.generation && event.playedFrames !== undefined);
      case 'cancelled':
        return endpoint === 'executor' && (event.cause === 'requested' || event.cause === 'permission_revoked');
      case 'failed':
        return endpoint === 'executor' || (event.reason === 'transport_failed' && event.sourceFailure === undefined);
      case 'paused':
      case 'resumed':
        return endpoint === 'executor' && event.revision <= task.revision;
      default:
        return false;
    }
  }

  private sendEvent(task: Task<Session>, event: LocalTaskEvent): void {
    let failed: LocalTaskCancellationCause | undefined;
    for (const endpoint of [task.bot, task.origin]) {
      if (endpoint === task.bot && !task.botAssigned) {
        if (event.state === 'failed' || event.state === 'cancelled') {
          this.sendError(endpoint,
            event.state === 'failed' && event.reason === 'busy' ? ProtocolErrorCode.BOT_COMMAND_BUSY : ProtocolErrorCode.BOT_INTERACTION_EXPIRED,
            event.state === 'failed' ? event.reason : event.cause, task.requestId);
        }
        continue;
      }
      if (endpoint === task.origin && !task.offered) continue;
      if (!this.send(endpoint, {
        type: MessageType.BOT_LOCAL_TASK_EVENT, payload: event,
      })) failed = endpoint === task.bot ? 'bot_disconnected' : 'requester_disconnected';
    }
    if (failed) {
      this.previews.delete(task.id);
      this.cancelTask(task, failed);
    }
  }

  private cancelTask(task: Task<Session>, cause: LocalTaskCancellationCause): void {
    if (this.dropTask(task, localAdmissionError(cause))) this.sendEvent(task, { state: 'cancelled', taskId: task.id, cause });
  }

  private failTask(task: Task<Session>, reason: LocalTaskFailureReason): void {
    if (this.dropTask(task, localAdmissionError(reason))) this.sendEvent(task, { state: 'failed', taskId: task.id, reason });
  }

  private cancelById(id: string, cause: LocalTaskCancellationCause): void {
    const task = this.tasks.get(id);
    if (task) this.cancelTask(task, cause);
  }

  private failById(id: string, reason: LocalTaskFailureReason): void {
    const task = this.tasks.get(id);
    if (task) this.failTask(task, reason);
  }

  private failureReason(reason: LocalAdmissionFailure): LocalTaskFailureReason {
    switch (reason) {
      case 'requested':
      case 'permission_revoked':
      case 'requester_left_voice':
      case 'requester_disconnected':
      case 'bot_left_voice':
      case 'bot_disconnected':
      case 'source_released':
      case 'voice_mode_changed':
      case 'expired':
      case 'server_shutdown':
        return 'executor_unavailable';
      default:
        return reason;
    }
  }
}
