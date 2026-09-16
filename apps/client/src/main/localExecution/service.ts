import { randomBytes, randomUUID } from 'node:crypto';
import {
  LOCAL_CAPABILITY_IDS, LOCAL_CAPABILITY_TOOLS, LOCAL_EXECUTION_RUNTIME_LIMITS,
  localConnectionStateSchema, localFrameProgressSchema, localFrameReadInputSchema, localPermissionChangeSchema,
  localPreparationInputSchema, localRequestCancellationSchema, localTaskPauseSchema,
  localTaskResultSchema, localTaskStartInputSchema, localToolIdSchema,
  type LocalCapabilityId, type LocalExecutionFailedResult, type LocalExecutionFailure, type LocalExecutionMutationResult,
  type LocalExecutionSnapshot, type LocalExecutionSubject, type LocalFrameReadResult,
  type LocalPreparationInput, type LocalPreparationResult, type LocalRuntimeSourceFailure, type LocalTaskFailureEvent,
  type LocalTaskInfo, type LocalTaskResult, type LocalTaskSpec, type LocalTaskStartInput,
  type LocalTaskStartResult, type LocalToolId,
} from '@monky/shared';
import type { LocalExecutionDialogs } from './dialogs';
import { LocalPermissions, localPermissionId } from './LocalPermissions';
import { LocalExecutionError, localFailureDetails } from './errors';

export interface LocalRuntimePaths { node: string; ytDlp: string; ffmpeg: string }

export interface LocalToolHost {
  initialize(): Promise<void>;
  snapshot(): Promise<Pick<LocalExecutionSnapshot, 'supported' | 'tools' | 'toolsBytes' | 'cacheBytes'>>;
  prepare(signal: AbortSignal, retryCleanup?: boolean): Promise<LocalRuntimePaths>;
  remove(tool: LocalToolId): Promise<void>;
  clearCache(): Promise<void>;
  dispose(): Promise<void>;
}

export interface LocalRuntimeTask {
  result: Promise<LocalTaskResult>;
  closed: Promise<void>;
  readFrames(count: number): Promise<{ frames: Uint8Array[]; done: boolean }>;
  acknowledgeFrames(playedFrames: number): Promise<void>;
  setPaused(paused: boolean): Promise<void>;
  close(): Promise<void>;
}

export type LocalRuntimeFactory = (input: {
  id: string; paths: LocalRuntimePaths; spec: LocalTaskSpec; signal: AbortSignal;
}) => Promise<LocalRuntimeTask>;

interface Permit {
  subject: LocalExecutionSubject;
  capability: LocalCapabilityId;
  permissionId: string;
}

interface Job {
  info: LocalTaskInfo;
  requestId: string;
  subject: LocalExecutionSubject;
  controller: AbortController;
  startup: Promise<void>;
  runtime: LocalRuntimeTask | null;
  voiceChannelId?: string;
  timer: ReturnType<typeof setTimeout> | null;
  streamActive: boolean;
  failureSent: boolean;
  reading: boolean;
  nextFrameAt: number;
  deliveredFrames: number;
  playedFrames: number;
  acknowledgedFrames: number;
  producerEnded: boolean;
  nativeClosing: Promise<void> | null;
  closing: Promise<void> | null;
}

export interface LocalExecutionServiceOptions {
  owner: number;
  tools: LocalToolHost;
  permissions: LocalPermissions;
  dialogs: Pick<LocalExecutionDialogs, 'consent' | 'enable' | 'removeTool' | 'clearCache'>;
  createRuntime: LocalRuntimeFactory;
  changed: () => void;
  failed: (failure: LocalTaskFailureEvent) => void;
  logError: (message: string, error: unknown) => void;
}

function awaitSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', abort); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', abort); reject(error); },
    );
    if (signal.aborted) abort();
  });
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

export class LocalExecutionService {
  private readonly jobs = new Map<string, Job>();
  private readonly requests = new Map<string, Job>();
  private readonly cancelledRequests = new Map<string, number>();
  private readonly permits = new Map<string, Permit>();
  private readonly connections = new Map<string, string | null>();
  private mutations = new AbortController();
  private initialization: Promise<void> | null = null;
  private maintenance: Promise<void> = Promise.resolve();
  private maintaining = false;
  private disposed = false;

  constructor(private readonly options: LocalExecutionServiceOptions) {
    if (!Number.isSafeInteger(options.owner) || options.owner <= 0) throw new LocalExecutionError('invalid_request');
  }

  initialize(): Promise<void> {
    if (!this.initialization) {
      const loading = Promise.all([
        this.options.tools.initialize(), this.options.permissions.initialize(),
      ]).then(() => undefined);
      this.initialization = loading;
      void loading.catch(() => { if (this.initialization === loading) this.initialization = null; });
    }
    return this.initialization;
  }

  async snapshot(): Promise<LocalExecutionSnapshot> {
    await this.initialize();
    const [inventory, permissions] = await Promise.all([this.options.tools.snapshot(), this.options.permissions.list()]);
    return {
      ...inventory,
      tools: inventory.tools.map((tool) => ({
        ...tool,
        requiredBy: permissions.filter((permission) => permission.decision !== 'deny' &&
          LOCAL_CAPABILITY_TOOLS[permission.capability].includes(tool.id)).map((permission) => permission.id),
      })),
      permissions,
      tasks: [...this.jobs.values()].map((job) => ({ ...job.info, bot: { ...job.info.bot } })),
    };
  }

  prepare(input: unknown): Promise<LocalPreparationResult> {
    const parsed = localPreparationInputSchema.safeParse(input);
    if (!parsed.success) return Promise.resolve({ status: 'failed', reason: 'invalid_request' });
    let job: Job;
    try {
      job = this.begin(parsed.data.requestId, parsed.data.subject, parsed.data.capability, 'tools.prepare');
    } catch (error) {
      return Promise.resolve(this.failedResult(error, 'worker_failed'));
    }
    const operation = this.prepareJob(job, parsed.data);
    job.startup = operation.then(() => undefined, () => undefined);
    this.options.changed();
    return operation;
  }

  startTask(input: unknown): Promise<LocalTaskStartResult> {
    const parsed = localTaskStartInputSchema.safeParse(input);
    if (!parsed.success) return Promise.resolve({ status: 'failed', reason: 'invalid_request' });
    const permit = this.permits.get(parsed.data.permit);
    if (!permit) return Promise.resolve({ status: 'failed', reason: 'permission_denied' });
    let job: Job;
    try {
      job = this.begin(parsed.data.requestId, permit.subject, permit.capability, parsed.data.spec.operation);
      job.voiceChannelId = parsed.data.voiceChannelId;
    } catch (error) {
      return Promise.resolve(this.failedResult(error, 'worker_failed'));
    }
    const operation = this.startJob(job, parsed.data);
    job.startup = operation.then(() => undefined, () => undefined);
    this.options.changed();
    return operation;
  }

  async readFrames(input: unknown): Promise<LocalFrameReadResult> {
    const parsed = localFrameReadInputSchema.safeParse(input);
    if (!parsed.success) return { status: 'failed', reason: 'invalid_request' };
    const job = this.jobs.get(parsed.data.taskId);
    if (!job || !job.streamActive || !job.runtime) return { status: 'failed', reason: 'executor_unavailable' };
    if (job.reading || job.info.phase === 'paused') return { status: 'failed', reason: 'busy' };
    job.reading = true;
    try {
      this.assertJob(job);
      await this.options.permissions.assertAllowed(this.options.owner, job.subject, job.info.capability);
      if (job.producerEnded) return { status: 'frames', frames: [], done: true };
      const delay = job.nextFrameAt - performance.now();
      if (delay > 0) await wait(delay, job.controller.signal);
      this.assertJob(job);
      const batch = await awaitSignal(job.runtime.readFrames(parsed.data.count), job.controller.signal);
      this.assertJob(job);
      if (batch.frames.length > parsed.data.count || typeof batch.done !== 'boolean' ||
          batch.frames.some((frame) => !(frame instanceof Uint8Array) || !frame.byteLength ||
            frame.byteLength > LOCAL_EXECUTION_RUNTIME_LIMITS.frameBytes) ||
          !batch.frames.length && !batch.done) {
        throw new LocalExecutionError('worker_failed');
      }
      // A bot cannot turn a playback lease into an unpaced bulk download.
      const now = performance.now();
      if (!job.nextFrameAt || now - job.nextFrameAt > 100) job.nextFrameAt = now;
      job.nextFrameAt += batch.frames.length * 20;
      job.deliveredFrames += batch.frames.length;
      if (batch.done) {
        job.producerEnded = true;
        await this.closeRuntime(job);
        this.assertJob(job);
        if (job.acknowledgedFrames === job.deliveredFrames) await this.finish(job);
      }
      return { status: 'frames', frames: batch.frames, done: batch.done };
    } catch (error) {
      const failure = localFailureDetails(error, 'worker_failed', job.controller.signal);
      this.abort(job, failure.reason, failure.sourceFailure);
      try { await this.finish(job); } catch (cleanupError) {
        this.options.logError('Could not stop the local audio worker', cleanupError);
        return { status: 'failed', reason: 'worker_failed' };
      }
      return failure.reason === 'cancelled' ? { status: 'cancelled' } : { status: 'failed', ...failure };
    } finally {
      job.reading = false;
    }
  }

  async setConnection(input: unknown): Promise<LocalExecutionMutationResult> {
    const parsed = localConnectionStateSchema.safeParse(input);
    if (!parsed.success) return { status: 'failed', reason: 'invalid_request' };
    if (this.disposed) return { status: 'failed', reason: 'executor_unavailable' };
    const state = parsed.data;
    if (state.connected) this.connections.set(state.connectionId, state.voiceChannelId);
    else {
      this.connections.delete(state.connectionId);
      this.options.permissions.cancelConnection(this.options.owner, state.connectionId);
      for (const [key, permit] of this.permits) {
        if (permit.subject.connectionId === state.connectionId) this.permits.delete(key);
      }
    }
    const affected = [...this.jobs.values()].filter((job) => job.subject.connectionId === state.connectionId &&
      (!state.connected || job.voiceChannelId !== undefined && job.voiceChannelId !== state.voiceChannelId));
    return this.mutate(async () => this.cancelJobs(affected, 'executor_unavailable'));
  }

  async setPaused(input: unknown): Promise<LocalExecutionMutationResult> {
    const parsed = localTaskPauseSchema.safeParse(input);
    if (!parsed.success) return { status: 'failed', reason: 'invalid_request' };
    const job = this.jobs.get(parsed.data.taskId);
    if (!job?.streamActive || job.controller.signal.aborted) return { status: 'failed', reason: 'executor_unavailable' };
    return this.mutate(async () => {
      this.assertJob(job);
      if (!job.runtime) throw new LocalExecutionError('executor_unavailable');
      await job.runtime.setPaused(parsed.data.paused);
      this.assertJob(job);
      job.info.phase = parsed.data.paused ? 'paused' : 'streaming';
      job.nextFrameAt = Math.max(job.nextFrameAt, performance.now());
    });
  }

  async acknowledgeFrames(input: unknown): Promise<LocalExecutionMutationResult> {
    const parsed = localFrameProgressSchema.safeParse(input);
    if (!parsed.success) return { status: 'failed', reason: 'invalid_request' };
    const job = this.jobs.get(parsed.data.taskId);
    if (!job?.streamActive || !job.runtime) return { status: 'failed', reason: 'executor_unavailable' };
    if (parsed.data.playedFrames < job.playedFrames || parsed.data.playedFrames > job.deliveredFrames) {
      return { status: 'failed', reason: 'invalid_request' };
    }
    try {
      this.assertJob(job);
      job.playedFrames = parsed.data.playedFrames;
      await job.runtime.acknowledgeFrames(parsed.data.playedFrames);
      this.assertJob(job);
      job.acknowledgedFrames = Math.max(job.acknowledgedFrames, parsed.data.playedFrames);
      if (job.producerEnded && job.acknowledgedFrames === job.deliveredFrames) await this.finish(job);
      return { status: 'completed' };
    } catch (error) {
      const failure = localFailureDetails(error, 'worker_failed', job.controller.signal);
      this.abort(job, failure.reason, failure.sourceFailure);
      await this.cancelJobs([job], 'worker_failed');
      return this.failedResult(error, 'worker_failed', job.controller.signal);
    }
  }

  cancelTask(taskId: unknown): Promise<LocalExecutionMutationResult> {
    if (typeof taskId !== 'string' || !taskId.length || taskId.length > 128) return Promise.resolve({ status: 'failed', reason: 'invalid_request' });
    const job = this.jobs.get(taskId);
    if (!job) return Promise.resolve({ status: 'failed', reason: 'executor_unavailable' });
    this.abort(job, 'cancelled');
    return this.mutate(async () => {
      await job.startup;
      await this.finish(job);
    });
  }

  cancelRequest(input: unknown): Promise<LocalExecutionMutationResult> {
    const parsed = localRequestCancellationSchema.safeParse(input);
    if (!parsed.success) return Promise.resolve({ status: 'failed', reason: 'invalid_request' });
    const now = Date.now();
    for (const [key, expires] of this.cancelledRequests) if (expires <= now) this.cancelledRequests.delete(key);
    if (this.cancelledRequests.size >= 1024) {
      const oldest = this.cancelledRequests.keys().next().value;
      if (oldest !== undefined) this.cancelledRequests.delete(oldest);
    }
    this.cancelledRequests.set(parsed.data.requestId, now + LOCAL_EXECUTION_RUNTIME_LIMITS.prepareTimeoutMs);
    const job = this.requests.get(parsed.data.requestId);
    return job ? this.cancelTask(job.info.id) : Promise.resolve({ status: 'completed' });
  }

  async setPermission(input: unknown): Promise<LocalExecutionMutationResult> {
    const parsed = localPermissionChangeSchema.safeParse(input);
    if (!parsed.success) return { status: 'failed', reason: 'invalid_request' };
    const { permissionId, enabled } = parsed.data;
    const signal = this.mutations.signal;
    if (enabled) {
      try {
        await this.initialize();
        await awaitSignal(this.maintenance, signal);
        const changed = await this.options.permissions.enable(permissionId, signal, async (bot, capability, signal) => {
          await this.assertSupported(signal);
          let prepared = false;
          const enabled = await this.options.dialogs.enable(bot, capability, signal, async (preparationSignal, retryCleanup) => {
            await this.options.tools.prepare(preparationSignal, retryCleanup);
            prepared = true;
          });
          if (enabled && !prepared) throw new LocalExecutionError('tool_install_failed');
          return enabled;
        });
        return { status: changed ? 'completed' : 'cancelled' };
      } catch (error) {
        return this.failedResult(error, 'storage_failed', signal);
      } finally {
        this.options.changed();
      }
    }
    const affected = [...this.jobs.values()].filter((job) =>
      localPermissionId(job.info.bot, job.info.capability) === permissionId);
    for (const [key, permit] of this.permits) if (permit.permissionId === permissionId) this.permits.delete(key);
    for (const job of affected) this.abort(job, 'permission_revoked');
    return this.mutate(async () => {
      await this.settle([
        this.options.permissions.revoke(permissionId),
        this.cancelJobs(affected, 'permission_revoked'),
      ]);
    });
  }

  async removeTool(input: unknown): Promise<LocalExecutionMutationResult> {
    const parsed = localToolIdSchema.safeParse(input);
    if (!parsed.success) return { status: 'failed', reason: 'invalid_request' };
    if (this.maintaining) return { status: 'failed', reason: 'busy' };
    const signal = this.mutations.signal;
    try {
      const count = [...this.jobs.values()].filter((job) => LOCAL_CAPABILITY_TOOLS[job.info.capability].includes(parsed.data)).length;
      let completed = false;
      const confirmed = await this.options.dialogs.removeTool(parsed.data, count, signal, async (operationSignal) => this.maintain(async () => {
        operationSignal.throwIfAborted();
        const capabilities = LOCAL_CAPABILITY_IDS.filter((capability) => LOCAL_CAPABILITY_TOOLS[capability].includes(parsed.data));
        const affected = [...this.jobs.values()].filter((job) => capabilities.includes(job.info.capability));
        for (const job of affected) this.abort(job, 'permission_revoked');
        for (const [key, permit] of this.permits) if (capabilities.includes(permit.capability)) this.permits.delete(key);
        await this.settle([
          ...capabilities.map((capability) => this.options.permissions.revokeCapability(capability)),
          this.cancelJobs(affected, 'permission_revoked'),
        ]);
        await this.options.tools.remove(parsed.data);
        completed = true;
      }));
      if (!confirmed) return { status: 'cancelled' };
      if (!completed) throw new LocalExecutionError('storage_failed');
      return { status: 'completed' };
    } catch (error) {
      return this.failedResult(error, 'storage_failed', signal);
    }
  }

  async clearCache(): Promise<LocalExecutionMutationResult> {
    if (this.maintaining) return { status: 'failed', reason: 'busy' };
    const signal = this.mutations.signal;
    try {
      let completed = false;
      const confirmed = await this.options.dialogs.clearCache(this.jobs.size, signal, async (operationSignal) => this.maintain(async () => {
        operationSignal.throwIfAborted();
        await this.cancelJobs([...this.jobs.values()], 'cancelled');
        await this.options.tools.clearCache();
        completed = true;
      }));
      if (!confirmed) return { status: 'cancelled' };
      if (!completed) throw new LocalExecutionError('storage_failed');
      return { status: 'completed' };
    } catch (error) {
      return this.failedResult(error, 'storage_failed', signal);
    }
  }

  async cancelOwner(): Promise<void> {
    this.mutations.abort(new LocalExecutionError('executor_unavailable'));
    if (!this.disposed) this.mutations = new AbortController();
    this.connections.clear();
    this.permits.clear();
    this.options.permissions.cancelOwner(this.options.owner);
    await this.cancelJobs([...this.jobs.values()], 'executor_unavailable');
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.mutations.abort(new LocalExecutionError('executor_unavailable'));
    await this.cancelOwner();
    await this.maintenance;
    await this.options.tools.dispose();
    await this.options.permissions.dispose();
  }

  private begin(requestId: string, subject: LocalExecutionSubject, capability: LocalCapabilityId, operation: LocalTaskInfo['operation']): Job {
    if (this.disposed || !this.connections.has(subject.connectionId)) throw new LocalExecutionError('executor_unavailable');
    if ((this.cancelledRequests.get(requestId) ?? 0) > Date.now()) throw new LocalExecutionError('cancelled');
    if (this.requests.has(requestId)) throw new LocalExecutionError('invalid_request');
    if (this.jobs.size >= LOCAL_EXECUTION_RUNTIME_LIMITS.tasks) throw new LocalExecutionError('busy');
    const { connectionId: _connectionId, ...bot } = subject;
    const job: Job = {
      info: { id: randomUUID(), bot, capability, operation, phase: 'consent', startedAt: Date.now() },
      requestId, subject, controller: new AbortController(), startup: Promise.resolve(),
      runtime: null, timer: null, streamActive: false, failureSent: false, reading: false,
      nextFrameAt: 0, deliveredFrames: 0, playedFrames: 0, acknowledgedFrames: 0,
      producerEnded: false, nativeClosing: null, closing: null,
    };
    this.jobs.set(job.info.id, job);
    this.requests.set(requestId, job);
    return job;
  }

  private async prepareJob(job: Job, input: LocalPreparationInput): Promise<LocalPreparationResult> {
    this.deadline(job, LOCAL_EXECUTION_RUNTIME_LIMITS.prepareTimeoutMs);
    let prepared = false;
    try {
      await this.initialize();
      await awaitSignal(this.maintenance, job.controller.signal);
      await this.assertSupported(job.controller.signal);
      this.assertJob(job);
      const permissionId = await this.options.permissions.authorize(
        this.options.owner, job.subject, input.capability, job.controller.signal,
        async (bot, capability, signal) => {
          const decision = await this.options.dialogs.consent(bot, capability, signal, async (preparationSignal, retryCleanup) => {
            for (const waiting of this.jobs.values()) {
              if (waiting.subject.connectionId === job.subject.connectionId &&
                  localPermissionId(waiting.info.bot, waiting.info.capability) === localPermissionId(bot, capability)) {
                waiting.info.phase = 'installing';
              }
            }
            this.options.changed();
            await this.options.tools.prepare(preparationSignal, retryCleanup);
            prepared = true;
          });
          if (decision !== 'deny' && !prepared) throw new LocalExecutionError('tool_install_failed');
          return decision;
        },
      );
      job.info.phase = 'installing';
      this.options.changed();
      if (!prepared) await this.options.tools.prepare(job.controller.signal);
      this.assertJob(job);
      await this.options.permissions.assertAllowed(this.options.owner, job.subject, input.capability);
      const existing = [...this.permits].find(([, entry]) => entry.permissionId === permissionId &&
        entry.subject.connectionId === job.subject.connectionId);
      if (existing) return { status: 'prepared', permit: existing[0] };
      const permit = randomBytes(32).toString('hex');
      this.permits.set(permit, { subject: job.subject, capability: input.capability, permissionId });
      return { status: 'prepared', permit };
    } catch (error) {
      return this.failedResult(error, 'tool_install_failed', job.controller.signal);
    } finally {
      this.removeJob(job);
    }
  }

  private async startJob(job: Job, input: LocalTaskStartInput): Promise<LocalTaskStartResult> {
    this.deadline(job, LOCAL_EXECUTION_RUNTIME_LIMITS.metadataTimeoutMs);
    let outcome: LocalTaskStartResult;
    try {
      await this.initialize();
      await awaitSignal(this.maintenance, job.controller.signal);
      this.assertJob(job);
      await this.options.permissions.assertAllowed(this.options.owner, job.subject, job.info.capability);
      const paths = await this.options.tools.prepare(job.controller.signal);
      this.assertJob(job);
      job.info.phase = 'running';
      this.options.changed();
      job.runtime = await this.options.createRuntime({ id: job.info.id, paths, spec: input.spec, signal: job.controller.signal });
      const runtime = job.runtime;
      runtime.closed.then(
        () => { void this.runtimeClosed(job); },
        (error: unknown) => { void this.runtimeClosed(job, error); },
      );
      const raw = await awaitSignal(runtime.result, job.controller.signal);
      const result = localTaskResultSchema.safeParse(raw);
      if (!result.success || result.data.operation !== input.spec.operation) throw new LocalExecutionError('worker_failed');
      this.assertJob(job);
      await this.options.permissions.assertAllowed(this.options.owner, job.subject, job.info.capability);
      if (result.data.operation === 'youtube.stream') {
        job.streamActive = true;
        job.info.phase = 'streaming';
        this.clearDeadline(job);
        this.options.changed();
      }
      outcome = { status: 'started', taskId: job.info.id, result: result.data };
    } catch (error) {
      outcome = this.failedResult(error, 'worker_failed', job.controller.signal);
    }
    if (!job.streamActive) {
      try { await this.finish(job); } catch (error) {
        this.abort(job, 'worker_failed');
        this.options.logError('Could not clean up a local task', error);
        return { status: 'failed', reason: 'worker_failed' };
      }
    }
    return outcome;
  }

  private async runtimeClosed(job: Job, error?: unknown): Promise<void> {
    await job.startup;
    if (!this.jobs.has(job.info.id)) return;
    // Native EOF may arrive before the final read response and remote PLAYED acknowledgments.
    if (error === undefined && job.streamActive && !job.controller.signal.aborted) return;
    if (error !== undefined) {
      if (!job.controller.signal.aborted) this.options.logError('Local runtime exited unexpectedly', error);
      const failure = localFailureDetails(error, 'worker_failed', job.controller.signal);
      this.abort(job, failure.reason, failure.sourceFailure);
    }
    try { await this.finish(job); } catch (cleanupError) {
      this.options.logError('Could not finalize the local runtime', cleanupError);
    }
  }

  private assertJob(job: Job): void {
    job.controller.signal.throwIfAborted();
    if (this.disposed || !this.connections.has(job.subject.connectionId) ||
        job.voiceChannelId !== undefined && this.connections.get(job.subject.connectionId) !== job.voiceChannelId) {
      throw new LocalExecutionError('executor_unavailable');
    }
  }

  private async assertSupported(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (!(await this.options.tools.snapshot()).supported) throw new LocalExecutionError('unsupported_platform');
    signal.throwIfAborted();
  }

  private deadline(job: Job, timeout: number): void {
    job.timer = setTimeout(() => this.abort(job, 'timeout'), timeout);
  }

  private clearDeadline(job: Job): void {
    if (job.timer) clearTimeout(job.timer);
    job.timer = null;
  }

  private abort(job: Job, reason: LocalExecutionFailure, sourceFailure?: LocalRuntimeSourceFailure): void {
    if (job.controller.signal.aborted) return;
    const details = sourceFailure ? { reason, sourceFailure } : { reason };
    job.controller.abort(new LocalExecutionError(reason, { sourceFailure }));
    job.info.phase = 'cancelling';
    if (job.streamActive && !job.failureSent) {
      job.failureSent = true;
      this.options.failed({ taskId: job.info.id, ...details });
    }
    this.options.changed();
  }

  private async cancelJobs(jobs: Job[], reason: LocalExecutionFailure): Promise<void> {
    for (const job of jobs) this.abort(job, reason);
    await this.settle(jobs.map(async (job) => {
      await job.startup;
      await this.finish(job);
    }));
  }

  private finish(job: Job): Promise<void> {
    if (job.closing) return job.closing;
    const closing = (async () => {
      this.clearDeadline(job);
      try {
        await this.closeRuntime(job);
        this.removeJob(job);
      } catch (error) {
        job.info.phase = 'cancelling';
        this.options.changed();
        throw error;
      }
    })();
    job.closing = closing;
    closing.catch(() => {
      if (job.closing === closing) job.closing = null;
    });
    return closing;
  }

  private closeRuntime(job: Job): Promise<void> {
    if (job.nativeClosing) return job.nativeClosing;
    const closing = (async () => { if (job.runtime) await job.runtime.close(); })();
    job.nativeClosing = closing;
    closing.catch(() => {
      if (job.nativeClosing === closing) job.nativeClosing = null;
    });
    return closing;
  }

  private removeJob(job: Job): void {
    this.clearDeadline(job);
    this.jobs.delete(job.info.id);
    if (this.requests.get(job.requestId) === job) this.requests.delete(job.requestId);
    this.options.changed();
  }

  private async settle(promises: Promise<unknown>[]): Promise<void> {
    const outcomes = await Promise.allSettled(promises);
    const failed = outcomes.find((outcome) => outcome.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }

  private async mutate(action: () => Promise<void>): Promise<LocalExecutionMutationResult> {
    try {
      if (this.disposed) throw new LocalExecutionError('executor_unavailable');
      await action();
      return { status: 'completed' };
    } catch (error) {
      this.options.logError('Local execution mutation failed', error);
      return this.failedResult(error, 'worker_failed', this.mutations.signal);
    } finally {
      this.options.changed();
    }
  }

  private maintain(action: () => Promise<void>): Promise<void> {
    if (this.maintaining) return Promise.reject(new LocalExecutionError('busy'));
    if (this.disposed) return Promise.reject(new LocalExecutionError('executor_unavailable'));
    this.maintaining = true;
    const operation = Promise.resolve().then(action);
    const finish = (): void => {
      this.maintaining = false;
      this.options.changed();
    };
    this.maintenance = operation.then(finish, finish);
    this.options.changed();
    return operation;
  }

  private failedResult(
    error: unknown, fallback: LocalExecutionFailure, signal?: AbortSignal,
  ): { status: 'cancelled' } | LocalExecutionFailedResult {
    const failure = localFailureDetails(error, fallback, signal);
    if (!signal?.aborted && (!(error instanceof LocalExecutionError) || failure.reason === 'storage_failed')) {
      this.options.logError('Local execution operation failed', error);
    }
    return failure.reason === 'cancelled' ? { status: 'cancelled' } : { status: 'failed', ...failure };
  }
}
