import { LOCAL_EXECUTION_PROTOCOL_LIMITS as limits, type LocalRequestContext } from '@monky/shared';
import {
  LocalAdmissionError,
  MAX_SOURCES,
  MAX_TASKS,
  botChange,
  invokerChange,
  localAdmissionError,
  pinBot,
  type BotLocalContext,
  type BotLocalExecutionTransport,
  type BotLocalSession,
  type PinnedBot,
  type PinnedInvoker,
  type Source,
  type Task,
} from './botLocalExecutionRecords';

/**
 * One request in flight: a source to retain or check, a task to start, a message of a live task, a preview
 * proof to consume or one pass over a bot's sources. Until it finishes, it counts against the quotas of the
 * sources and tasks it may create, stays pinned to its bot and requester, and is aborted as soon as either
 * changes, its context or access ends, or its deadline passes.
 */
export interface Admission<Session extends BotLocalSession> extends PinnedBot, PinnedInvoker {
  kind: 'task' | 'source' | 'operation';
  botId: string;
  bot?: Session;
  botSocket: object | undefined;
  botSessionId: string | undefined;
  botPublicKey: string | undefined;
  context?: LocalRequestContext;
  scope?: BotLocalContext<Session>;
  source?: Source<Session>;
  task?: Task<Session>;
  origin?: Session;
  originSocket: object | undefined;
  invokerId: string | undefined;
  invokerSessionId: string | undefined;
  voiceChannelId?: string;
  accessVersion: string | null;
  deadline: number;
  controller: AbortController;
  timer?: NodeJS.Timeout;
  taskAbort?: () => void;
  failure?: LocalAdmissionError;
  pending: number;
  finished: boolean;
}

/**
 * The admissions in flight and their quotas. A dependency awaited through `during` keeps its admission's
 * quota until it settles, even after an abort released the caller: an aborted promise has not necessarily
 * stopped working, and churn must not outrun the limits.
 */
export class BotLocalAdmissions<Session extends BotLocalSession> implements Iterable<Admission<Session>> {
  private readonly entries = new Set<Admission<Session>>();
  private closed = false;

  constructor(
    private readonly transport: BotLocalExecutionTransport<Session>,
    /** Live tasks and sources share the quotas of the admissions that may still become one. */
    private readonly tasks: ReadonlyMap<string, Task<Session>>,
    private readonly sources: ReadonlyMap<string, Source<Session>>,
    /** Releases what expired records still hold, before a reservation counts them. */
    private readonly expire: () => void,
  ) {}

  [Symbol.iterator](): Iterator<Admission<Session>> {
    return this.entries.values();
  }

  reserve(
    botId: string, kind: Admission<Session>['kind'], context?: LocalRequestContext, bot?: Session, voiceChannelId?: string,
  ): Admission<Session> {
    if (this.closed) throw localAdmissionError('server_shutdown');
    const pinned = bot && pinBot(bot);
    if (bot && (!pinned || pinned.botId !== botId || !this.transport.isCurrent(bot))) {
      throw localAdmissionError('permission_denied');
    }
    this.expire();
    const pending = [...this.entries];
    if (pending.length >= MAX_TASKS || pending.filter((entry) => entry.botId === botId).length >= limits.tasksPerBot) {
      throw localAdmissionError('busy');
    }
    if (kind === 'task') {
      const reserved = pending.filter((entry) => entry.kind === 'task' && (!entry.task || this.tasks.get(entry.task.id) !== entry.task));
      if (this.tasks.size + reserved.length >= MAX_TASKS ||
          [...this.tasks.values()].filter((task) => task.botId === botId).length +
          reserved.filter((entry) => entry.botId === botId).length >= limits.tasksPerBot) throw localAdmissionError('busy');
    } else if (kind === 'source') {
      const reserved = pending.filter((entry) => entry.kind === 'source' &&
        (!entry.source || this.sources.get(entry.source.value.sourceContextId) !== entry.source));
      if (this.sources.size + reserved.length >= MAX_SOURCES ||
          [...this.sources.values()].filter((source) => source.value.botId === botId).length +
          reserved.filter((entry) => entry.botId === botId).length >= limits.sourceContextsPerBot) throw localAdmissionError('busy');
    }
    const admission: Admission<Session> = {
      kind, botId, context, bot, botSocket: bot?.ws, botSessionId: bot?.sessionId, botPublicKey: bot?.botPublicKey,
      originSocket: undefined, invokerId: undefined, invokerSessionId: undefined,
      voiceChannelId, accessVersion: this.transport.accessVersion(), deadline: Date.now() + limits.taskStartTimeoutMs,
      controller: new AbortController(), pending: 0, finished: false,
    };
    this.entries.add(admission);
    this.arm(admission);
    return admission;
  }

  /** The deadline is the start deadline, or the expiry of its scope or source when that comes first. */
  arm(admission: Admission<Session>): void {
    if (admission.timer) clearTimeout(admission.timer);
    const expiresAt = admission.scope?.expiresAt ?? admission.source?.value.expiresAt ?? Infinity;
    admission.timer = setTimeout(() => this.abort(admission,
      localAdmissionError(expiresAt <= admission.deadline ? 'expired' : 'timeout')),
    Math.max(0, Math.min(admission.deadline, expiresAt) - Date.now()));
    admission.timer.unref();
  }

  /** Pins the requester behind `scope` and charges the admission to that executor's quota. */
  bind(admission: Admission<Session>, scope: BotLocalContext<Session>, source?: Source<Session>): void {
    if (scope.bot !== admission.bot || (admission.scope && admission.scope !== scope)) throw localAdmissionError('permission_denied');
    if (!admission.origin) {
      admission.origin = scope.origin;
      admission.originSocket = source?.originSocket ?? scope.origin.ws;
      admission.invokerId = scope.invokerId;
      admission.invokerSessionId = source?.value.invokerSessionId ?? scope.origin.sessionId;
    }
    admission.scope = scope;
    admission.source = source;
    this.assert(admission);
    const others = [...this.entries].filter((entry) => entry !== admission &&
      entry.origin === admission.origin && entry.originSocket === admission.originSocket);
    if (others.length >= limits.tasksPerExecutor) throw localAdmissionError('busy');
    if (admission.kind === 'task' && !admission.task) {
      const reserved = others.filter((entry) => entry.kind === 'task' && (!entry.task || this.tasks.get(entry.task.id) !== entry.task));
      if ([...this.tasks.values()].filter((task) => task.origin === admission.origin && task.originSocket === admission.originSocket).length +
          reserved.length >= limits.tasksPerExecutor) throw localAdmissionError('busy');
    }
    this.arm(admission);
  }

  /** Binds the admission of a message to its live task, so that dropping the task aborts it. */
  bindTask(admission: Admission<Session>, task: Task<Session>): void {
    if (admission.task === task) return;
    admission.origin = task.origin;
    admission.originSocket = task.originSocket;
    admission.invokerId = task.invokerId;
    admission.invokerSessionId = task.invokerSessionId;
    admission.task = task;
    this.bind(admission, task.scope, task.source);
    admission.taskAbort = () => this.abort(admission,
      task.controller.signal.reason instanceof LocalAdmissionError ? task.controller.signal.reason : localAdmissionError('expired'));
    if (task.controller.signal.aborted) admission.taskAbort();
    else task.controller.signal.addEventListener('abort', admission.taskAbort, { once: true });
  }

  /** Why the admission no longer holds, if it does not. */
  failure(admission: Admission<Session>): LocalAdmissionError | undefined {
    if (admission.failure) return admission.failure;
    if (this.closed) return localAdmissionError('server_shutdown');
    const { bot, origin } = admission;
    const botChanged = bot && botChange(bot, admission);
    if (bot && (!this.transport.isCurrent(bot) || botChanged === 'connection' || botChanged === 'session')) {
      return localAdmissionError('bot_disconnected');
    }
    if (botChanged) return localAdmissionError('permission_denied');
    if (origin && (!this.transport.isCurrent(origin) || !admission.invokerSessionId || invokerChange(origin, admission))) {
      return localAdmissionError('requester_disconnected');
    }
    if (admission.source && this.sources.get(admission.source.value.sourceContextId) !== admission.source) {
      return localAdmissionError('source_released');
    }
    if ((admission.scope && (!admission.scope.isCurrent() || Date.now() >= admission.scope.expiresAt)) ||
        (admission.source && Date.now() >= admission.source.value.expiresAt)) return localAdmissionError('expired');
    if (Date.now() >= admission.deadline) return localAdmissionError('timeout');
    if (admission.voiceChannelId) {
      if (origin && this.transport.voiceChannelId(origin) !== admission.voiceChannelId) return localAdmissionError('requester_left_voice');
      if (bot && this.transport.voiceChannelId(bot) !== admission.voiceChannelId) return localAdmissionError('bot_left_voice');
    }
    if (admission.scope && !this.transport.commandHasCapability(admission.botId, admission.scope.commandName, admission.scope.capability)) {
      return localAdmissionError('permission_denied');
    }
    if (admission.accessVersion === null || admission.accessVersion !== this.transport.accessVersion()) return localAdmissionError('busy');
    return undefined;
  }

  assert(admission: Admission<Session>): void {
    const failure = this.failure(admission);
    if (failure) { this.abort(admission, failure); throw failure; }
  }

  abort(admission: Admission<Session>, failure: LocalAdmissionError): void {
    if (admission.failure) return;
    admission.failure = failure;
    if (admission.timer) clearTimeout(admission.timer);
    admission.controller.abort();
  }

  /** Aborts every unfinished admission (of those `matches` selects) that no longer holds. */
  recheck(matches: (admission: Admission<Session>) => boolean = () => true): void {
    for (const admission of this.entries) {
      if (admission.finished || admission.failure || !matches(admission)) continue;
      const failure = this.failure(admission);
      if (failure) this.abort(admission, failure);
    }
  }

  /** Runs one request under its admission, then finishes the admission. */
  async run<T>(admission: Admission<Session>, operation: (admission: Admission<Session>) => Promise<T>): Promise<T> {
    try {
      this.assert(admission);
      return await operation(admission);
    } finally {
      admission.finished = true;
      this.abort(admission, localAdmissionError('expired'));
      if (admission.taskAbort) admission.task?.controller.signal.removeEventListener('abort', admission.taskAbort);
      if (admission.pending === 0) this.entries.delete(admission);
    }
  }

  /** Awaits one dependency of the admission; an abort releases the caller at once. */
  async during<T>(admission: Admission<Session>, operation: () => Promise<T>): Promise<T> {
    this.assert(admission);
    const pending = operation();
    admission.pending++;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const signal = admission.controller.signal;
      const cancel = () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', cancel);
        reject(admission.failure ?? localAdmissionError('expired'));
      };
      if (signal.aborted) cancel();
      else signal.addEventListener('abort', cancel, { once: true });
      const finish = () => {
        admission.pending--;
        if (admission.finished && admission.pending === 0) this.entries.delete(admission);
        signal.removeEventListener('abort', cancel);
      };
      // Cancellation settles the caller, not an arbitrary dependency. Keep its quota until BOTH
      // success and failure paths actually settle, including siblings of a rejected Promise.all.
      void pending.then((value) => {
        finish();
        if (settled) return;
        settled = true;
        try { this.assert(admission); resolve(value); } catch (error) { reject(error); }
      }, (error: unknown) => {
        finish();
        if (settled) return;
        settled = true;
        reject(error);
      });
    });
  }

  /** Refuses new admissions and aborts those in flight. */
  close(): void {
    this.closed = true;
    for (const admission of this.entries) this.abort(admission, localAdmissionError('server_shutdown'));
  }
}
