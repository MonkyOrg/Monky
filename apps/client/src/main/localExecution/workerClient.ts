import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  errorDiagnostic, safeDiagnostic, terminate,
} from '@monky/bot-sdk/dist/localRuntime';
import {
  LOCAL_EXECUTION_RUNTIME_LIMITS, localTaskSpecSchema, localToolIdSchema,
  type LocalTaskResult, type LocalToolId,
} from '@monky/shared';
import type { LocalRuntimeFactory, LocalRuntimeTask } from './service';
import type { LocalTools, LocalToolPaths } from './LocalTools';
import { localToolDirectory } from './localToolsStorage';
import { LocalExecutionError, localFailure } from './errors';
import { assertTaskCacheDirectory, leaseTaskCache, type TaskCacheLease } from './taskCacheLease';
import { localWorkerEnvironment, workerDirectories } from './workerEnvironment';
import {
  parseWorkerCommand, parseWorkerReply, workerBase64, workerDeferred,
  workerError, workerId, workerInteger, workerPaths, WORKER_LIMITS,
  type WorkerCommand, type WorkerReply, type WorkerStart,
} from './workerProtocol';

type CacheTools = Pick<LocalTools, 'allocateTaskCache' | 'removeTaskCache' | 'registerTaskCacheOwner'>;
type LogError = (message: string, error: unknown) => void;
type Frames = Awaited<ReturnType<LocalRuntimeTask['readFrames']>>;
type Output = LocalTaskResult | string;
type RequestCommand = Extract<WorkerCommand, { requestId: number }>;
type StartInput =
  | Omit<Extract<WorkerStart, { mode: 'task' }>, 'directory'>
  | Omit<Extract<WorkerStart, { mode: 'probe' }>, 'directory'>;

interface Pending {
  command: RequestCommand;
  response: ReturnType<typeof workerDeferred<WorkerReply>>;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Main's side of one worker process: its IPC protocol, its stop and forced termination, and the release of
 * its private cache, which waits until the worker confirms that its native descendants are gone.
 */
class WorkerHost {
  private readonly ready = workerDeferred<void>();
  private readonly output = workerDeferred<Output>();
  private readonly completion = workerDeferred<void>();
  private readonly startupFinished = workerDeferred<void>();
  private readonly nativeCleanup = workerDeferred<void>();
  private readonly firstCleanup = workerDeferred<void>();
  private readonly requests = new Map<number, Pending>();
  private readonly cacheOwner: ReturnType<CacheTools['registerTaskCacheOwner']>;
  private child: ChildProcess | undefined;
  private cleanupAttempt: Promise<void> | undefined;
  private sequence = 0;
  private readyReceived = false;
  private resultReceived = false;
  private closedReceived = false;
  private childClosed = false;
  private abandoned = false;
  private stopping = false;
  private eof = false;
  private reading = false;
  private delivered = 0;
  private played = 0;
  private pendingOutput: Output | undefined;
  private failure: LocalExecutionError | undefined;
  private stopReason = new LocalExecutionError('cancelled');
  private diagnostic = '';
  private diagnosticBytes = 0;
  private startupTimer: ReturnType<typeof setTimeout> | undefined;
  private stopTimer: ReturnType<typeof setTimeout> | undefined;
  private termination: Promise<void> | undefined;

  constructor(
    private readonly start: WorkerStart,
    private readonly signal: AbortSignal,
    private readonly tools: CacheTools,
    private readonly lease: TaskCacheLease,
    private readonly logError: LogError,
  ) {
    this.cacheOwner = tools.registerTaskCacheOwner(start.directory, () => this.close());
    this.signal.addEventListener('abort', this.abort, { once: true });
    this.lease.onFailure = error => this.fail(error);
    if (signal.aborted) this.abort();
    void this.launch();
  }

  private async launch(): Promise<void> {
    try {
      this.signal.throwIfAborted();
      if (this.stopping) throw this.failure ?? this.stopReason;
      await localToolDirectory(this.start.directory);
      try {
        for (const directory of Object.values(workerDirectories(this.start.directory))) await fs.mkdir(directory, { mode: 0o700 });
      } catch (error) { throw workerError(error, 'storage_failed'); }
      await this.lease.check();
      if (this.lease.failure) throw this.lease.failure;
      this.signal.throwIfAborted();
      if (this.stopping) throw this.failure ?? this.stopReason;
      const child = spawn(this.start.paths.node, [path.join(__dirname, 'worker.js')], {
        shell: false, windowsHide: true, detached: process.platform !== 'win32',
        cwd: this.start.directory, env: localWorkerEnvironment(this.start.paths, this.start.directory, this.start.id),
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'json',
      });
      this.child = child;
      child.once('close', this.exited);
      child.on('error', this.spawnError);
      child.on('message', this.receive);
      child.once('disconnect', this.disconnected);
      child.stdout?.on('data', this.stdout);
      child.stderr?.on('data', this.stderr);
      child.stdout?.on('error', this.spawnError);
      child.stderr?.on('error', this.spawnError);
      if (!child.stdout || !child.stderr) this.fail(new LocalExecutionError('worker_failed'));
      if (this.stopping) {
        this.send({ type: 'stop', id: this.start.id, reason: (this.failure ?? this.stopReason).reason });
        this.armStop();
      } else if (this.signal.aborted) this.abort();
      else {
        this.startupTimer = setTimeout(() => this.fail(new LocalExecutionError('timeout')), WORKER_LIMITS.startupMs);
        this.send(this.start);
      }
    } catch (error) {
      if (this.signal.aborted && error === this.signal.reason) this.abort();
      else if (error === this.stopReason) this.stop();
      else this.fail(error);
      if (!this.child) this.exited(null, null);
    } finally { this.startupFinished.resolve(undefined); }
  }

  get result(): Promise<Output> { return this.output.promise; }
  get closed(): Promise<void> { return this.completion.promise; }

  async started(): Promise<void> {
    await this.ready.promise;
    if (this.signal.aborted || this.stopping) {
      throw this.failure ?? this.stopReason;
    }
  }

  private send(message: WorkerCommand): void {
    try {
      if (!this.child?.connected || !this.child.send) throw new LocalExecutionError('worker_failed');
      this.child.send(message, error => { if (error && !this.childClosed && !this.closedReceived) this.fail(error); });
    } catch (error) {
      if (!this.childClosed && !this.closedReceived) this.fail(error);
    }
  }

  private readonly abort = (): void => {
    this.stopReason = new LocalExecutionError(localFailure(this.signal.reason, 'cancelled', this.signal));
    this.stop();
  };

  private stop(): void {
    if (this.childClosed || this.stopping) return;
    this.stopping = true;
    clearTimeout(this.startupTimer);
    this.startupTimer = undefined;
    this.ready.reject(this.failure ?? this.stopReason);
    this.output.reject(this.failure ?? this.stopReason);
    for (const request of this.requests.values()) {
      clearTimeout(request.timer);
      request.response.reject(this.failure ?? this.stopReason);
    }
    this.requests.clear();
    if (this.child) {
      this.send({ type: 'stop', id: this.start.id, reason: (this.failure ?? this.stopReason).reason });
      this.armStop();
    }
  }

  private armStop(): void {
    const child = this.child;
    if (this.stopTimer || this.childClosed || !child) return;
    this.stopTimer = setTimeout(() => {
      this.stopTimer = undefined;
      if (this.childClosed) return;
      this.termination = terminate(child);
      void this.termination.then(undefined, error => this.fail(error));
    }, WORKER_LIMITS.stopMs);
  }

  private fail(error: unknown): void {
    const failure = workerError(error);
    if (!this.failure || failure.reason === 'storage_failed') this.failure = failure;
    this.stop();
  }

  private readonly spawnError = (error: Error): void => { this.fail(error); };
  private readonly disconnected = (): void => {
    if (!this.closedReceived) this.fail(new LocalExecutionError('worker_failed'));
  };
  private readonly stdout = (chunk: unknown): void => {
    if (!Buffer.isBuffer(chunk)) { this.fail(new LocalExecutionError('worker_failed')); return; }
    if (chunk.length) this.fail(new LocalExecutionError('worker_failed', { cause: new Error('Unexpected worker standard output.') }));
  };
  private readonly stderr = (chunk: unknown): void => {
    if (!Buffer.isBuffer(chunk)) { this.fail(new LocalExecutionError('worker_failed')); return; }
    this.diagnosticBytes = Math.min(WORKER_LIMITS.diagnosticBytes + 1, this.diagnosticBytes + chunk.length);
    this.diagnostic = (this.diagnostic + chunk.toString('utf8')).slice(0, 4096);
    if (this.diagnosticBytes > WORKER_LIMITS.diagnosticBytes) this.fail(new LocalExecutionError('worker_failed'));
  };

  private readonly receive = (raw: unknown): void => {
    try {
      const message = parseWorkerReply(raw);
      if (message.id !== this.start.id) throw new LocalExecutionError('worker_failed');
      if (message.type === 'failure') {
        this.fail(new LocalExecutionError(message.reason, { cause: new Error(message.detail),
          ...(message.sourceFailure ? { sourceFailure: message.sourceFailure } : {}) }));
        return;
      }
      if (message.type === 'closed') {
        if (this.closedReceived || !this.resultReceived && !this.stopping) throw new LocalExecutionError('worker_failed');
        this.closedReceived = true;
        this.armStop();
        return;
      }
      if (this.closedReceived) throw new LocalExecutionError('worker_failed');
      if (message.type === 'ready') {
        if (this.readyReceived) throw new LocalExecutionError('worker_failed');
        this.readyReceived = true;
        clearTimeout(this.startupTimer);
        if (!this.stopping) this.ready.resolve(undefined);
        return;
      }
      if (this.stopping) return;
      if (!this.readyReceived) throw new LocalExecutionError('worker_failed');
      if (message.type === 'result' || message.type === 'version') {
        if (this.resultReceived) throw new LocalExecutionError('worker_failed');
        if (message.type === 'version') {
          if (this.start.mode !== 'probe') throw new LocalExecutionError('worker_failed');
          this.pendingOutput = message.version;
        } else {
          if (this.start.mode !== 'task' || message.result.operation !== this.start.spec.operation) {
            throw new LocalExecutionError('worker_failed');
          }
          this.pendingOutput = message.result;
          if (message.result.operation === 'youtube.preview') {
            this.lease.bufferedBytes = Buffer.byteLength(message.result.audioBase64, 'base64');
          }
          if (message.result.operation === 'youtube.stream') this.output.resolve(message.result);
        }
        this.resultReceived = true;
        return;
      }
      const pending = this.requests.get(message.requestId);
      if (!pending) throw new LocalExecutionError('worker_failed');
      if (message.type === 'frames') {
        if (pending.command.type !== 'read' || message.frames.length > pending.command.count) {
          throw new LocalExecutionError('worker_failed');
        }
        this.lease.bufferedBytes = message.frames.reduce((bytes, frame) => bytes + Buffer.byteLength(frame, 'base64'), 0);
        this.delivered = workerInteger(this.delivered + message.frames.length, 0, 0xffffffff);
        this.eof = message.done;
      } else if (message.operation !== pending.command.type) throw new LocalExecutionError('worker_failed');
      clearTimeout(pending.timer);
      this.requests.delete(message.requestId);
      pending.response.resolve(message);
    } catch (error) {
      this.fail(new LocalExecutionError('worker_failed', { cause: new Error(errorDiagnostic(error)) }));
    }
  };

  private readonly exited = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (this.childClosed) return;
    this.childClosed = true;
    const child = this.child;
    clearTimeout(this.startupTimer);
    clearTimeout(this.stopTimer);
    this.signal.removeEventListener('abort', this.abort);
    child?.off('message', this.receive);
    child?.off('error', this.spawnError);
    child?.off('disconnect', this.disconnected);
    child?.stdout?.off('data', this.stdout);
    child?.stderr?.off('data', this.stderr);
    child?.stdout?.off('error', this.spawnError);
    child?.stderr?.off('error', this.spawnError);
    if (child?.pid !== undefined && (!this.closedReceived || code !== 0 || signal)) {
      this.failure ??= new LocalExecutionError('worker_failed', {
        cause: new Error(safeDiagnostic(`Worker exited without successful closure (code=${code}, signal=${signal}). ${this.diagnostic}`)),
      });
    }
    this.ready.reject(this.failure ?? this.stopReason);
    for (const pending of this.requests.values()) {
      clearTimeout(pending.timer);
      if (this.eof && !this.failure && pending.command.type !== 'read') {
        pending.response.resolve({ type: 'accepted', id: this.start.id, requestId: pending.command.requestId, operation: pending.command.type });
      } else pending.response.reject(this.failure ?? this.stopReason);
    }
    this.requests.clear();
    void this.finalize();
  };

  private async finalize(): Promise<void> {
    let cleanupError: LocalExecutionError | undefined;
    try {
      await this.startupFinished.promise;
      await this.termination;
      try { await this.lease.check(); }
      catch (error) { this.fail(workerError(error, 'storage_failed')); }
      if (this.lease.failure) this.failure = this.lease.failure;
      try { await this.lease.release(); }
      catch (error) { this.fail(workerError(error, 'storage_failed')); }
      if (this.child?.pid !== undefined && !this.closedReceived) {
        // Killed, crashed or unresponsive: nothing can confirm this worker's descendants anymore. Its
        // files stay until the next start, but its task, cache slot and shutdown are released.
        cleanupError = new LocalExecutionError('worker_failed', {
          cause: new Error('Worker did not confirm native cleanup; its private cache is retained until the next start.'),
        });
        this.cacheOwner.abandon();
        this.abandoned = true;
      } else {
        this.cacheOwner.confirmNativeClosed();
      }
      this.nativeCleanup.resolve(undefined);
    } catch (error) {
      cleanupError = workerError(error, 'storage_failed');
      this.nativeCleanup.reject(cleanupError);
    }
    try { await this.cleanupFiles(); }
    catch (error) { cleanupError = workerError(error, 'storage_failed'); }
    if (cleanupError) this.failure = cleanupError;
    try {
      if (this.failure) this.logError('Local media worker failed', new Error(errorDiagnostic(this.failure)));
      else if (this.diagnostic.trim()) this.logError('Local media worker diagnostic', new Error(safeDiagnostic(this.diagnostic)));
    } catch (error) {
      this.failure = workerError(new AggregateError([this.failure, error], 'Worker diagnostic delivery failed.'));
    }
    if (this.failure) {
      this.output.reject(this.failure);
      this.completion.reject(this.failure);
    } else {
      if (!this.stopping && this.pendingOutput !== undefined) this.output.resolve(this.pendingOutput);
      else this.output.reject(this.stopReason);
      this.completion.resolve(undefined);
    }
    this.pendingOutput = undefined;
    if (!this.reading) this.lease.bufferedBytes = 0;
    if (cleanupError) this.firstCleanup.reject(cleanupError);
    else this.firstCleanup.resolve(undefined);
  }

  private cleanupFiles(): Promise<void> {
    if (this.cleanupAttempt) return this.cleanupAttempt;
    const attempt = (async () => {
      await this.nativeCleanup.promise;
      if (this.abandoned) return;
      try { await this.tools.removeTaskCache(this.start.directory); }
      catch (error) { throw workerError(error, 'storage_failed'); }
    })();
    this.cleanupAttempt = attempt;
    void attempt.then(undefined, () => {
      if (this.cleanupAttempt === attempt) this.cleanupAttempt = undefined;
    });
    return attempt;
  }

  private request(command: RequestCommand): Promise<WorkerReply> {
    if (this.failure) throw this.failure;
    if (this.stopping || this.childClosed) throw this.stopReason;
    if (this.requests.size >= WORKER_LIMITS.pendingCommands) throw new LocalExecutionError('busy');
    const response = workerDeferred<WorkerReply>();
    const pending: Pending = { command, response };
    if (command.type !== 'read') {
      pending.timer = setTimeout(() => this.fail(new LocalExecutionError('timeout')), WORKER_LIMITS.controlMs);
    }
    this.requests.set(command.requestId, pending);
    this.send(command);
    return response.promise;
  }

  private nextId(): number {
    return workerInteger(++this.sequence, 1, 0xffffffff);
  }

  async readFrames(count: number): Promise<Frames> {
    workerInteger(count, 1, LOCAL_EXECUTION_RUNTIME_LIMITS.frameBatch);
    if (this.signal.aborted || this.stopping) throw this.failure ?? this.stopReason;
    if (this.reading) throw new LocalExecutionError('busy');
    if (this.start.mode !== 'task' || this.start.spec.operation !== 'youtube.stream') throw new LocalExecutionError('invalid_request');
    if (this.eof) {
      await this.closed;
      if (this.signal.aborted || this.stopping) throw this.failure ?? this.stopReason;
      return { frames: [], done: true };
    }
    this.reading = true;
    try {
      const reply = await this.request({ type: 'read', id: this.start.id, requestId: this.nextId(), count });
      if (reply.type !== 'frames') throw new LocalExecutionError('worker_failed');
      const frames = reply.frames.map(frame => workerBase64(frame, LOCAL_EXECUTION_RUNTIME_LIMITS.frameBytes));
      if (reply.done) await this.closed;
      if (this.signal.aborted || this.stopping) throw this.failure ?? this.stopReason;
      return { frames, done: reply.done };
    } finally {
      // Handed-off frames belong to the caller's bounded transport buffer, not to this task's cache.
      this.lease.bufferedBytes = 0;
      this.reading = false;
    }
  }

  async acknowledgeFrames(playedFrames: number): Promise<void> {
    if (this.signal.aborted || this.stopping) throw this.failure ?? this.stopReason;
    if (this.start.mode !== 'task' || this.start.spec.operation !== 'youtube.stream') throw new LocalExecutionError('invalid_request');
    workerInteger(playedFrames, this.played, this.delivered);
    if (this.failure) throw this.failure;
    if (playedFrames === this.played) return;
    // Keep terminal ACK state in Main without calling a decoder that has reached EOF.
    if (this.eof) { this.played = playedFrames; return; }
    const accepted = this.request({ type: 'ack', id: this.start.id, requestId: this.nextId(), playedFrames });
    this.played = playedFrames;
    await accepted;
  }

  async setPaused(paused: boolean): Promise<void> {
    if (this.signal.aborted || this.stopping) throw this.failure ?? this.stopReason;
    if (this.start.mode !== 'task' || this.start.spec.operation !== 'youtube.stream') throw new LocalExecutionError('invalid_request');
    if (typeof paused !== 'boolean') throw new LocalExecutionError('invalid_request');
    if (this.failure) throw this.failure;
    if (this.eof) return;
    await this.request({ type: 'pause', id: this.start.id, requestId: this.nextId(), paused });
  }

  close(): Promise<void> {
    if (!this.eof && !this.closedReceived) this.stop();
    return this.cleanupFiles();
  }

  finish(): Promise<void> {
    if (!this.eof && !this.closedReceived) this.stop();
    // Internal startup/probe joins report the first failure; only a new owner close retries filesystem work.
    return this.firstCleanup.promise;
  }
}

async function startWorker(
  input: StartInput,
  signal: AbortSignal, tools: CacheTools, logError: LogError,
): Promise<WorkerHost> {
  signal.throwIfAborted();
  const directory = await tools.allocateTaskCache();
  let lease: TaskCacheLease | undefined;
  let host: WorkerHost | undefined;
  let owned = false;
  try {
    assertTaskCacheDirectory(directory);
    owned = true;
    const start = parseWorkerCommand({ ...input, directory });
    if (start.type !== 'start') throw new LocalExecutionError('invalid_request');
    lease = leaseTaskCache(directory);
    host = new WorkerHost(start, signal, tools, lease, logError);
    await host.started();
    return host;
  } catch (error) {
    if (!owned) throw workerError(error, 'storage_failed');
    if (host) {
      await host.finish();
    } else {
      const cleanup = await Promise.allSettled([
        lease?.release(),
      ]);
      try {
        await tools.removeTaskCache(directory);
      } catch (cleanupError) {
        logError('Could not remove a private worker directory', new Error(errorDiagnostic(cleanupError)));
        throw workerError(cleanupError, 'storage_failed');
      }
      for (const result of cleanup) if (result.status === 'rejected') throw workerError(result.reason, 'storage_failed');
    }
    throw workerError(error, signal.aborted ? localFailure(error, 'cancelled', signal) : 'worker_failed');
  }
}

export async function createLocalRuntimeTask(
  input: Parameters<LocalRuntimeFactory>[0], tools: CacheTools, logError: LogError,
): Promise<LocalRuntimeTask> {
  const id = workerId(input.id);
  const paths = workerPaths(input.paths);
  const spec = localTaskSpecSchema.safeParse(input.spec);
  if (!spec.success) throw new LocalExecutionError('invalid_request');
  const host = await startWorker({ type: 'start', id, paths, mode: 'task', spec: spec.data }, input.signal, tools, logError);
  return {
    result: host.result.then(result => {
      if (typeof result === 'string') throw new LocalExecutionError('worker_failed');
      return result;
    }),
    closed: host.closed,
    readFrames: count => host.readFrames(count),
    acknowledgeFrames: count => host.acknowledgeFrames(count),
    setPaused: paused => host.setPaused(paused),
    close: () => host.close(),
  };
}

export async function probeLocalTool(
  tool: LocalToolId, paths: LocalToolPaths, signal: AbortSignal, tools: CacheTools, logError: LogError,
): Promise<string> {
  const parsed = localToolIdSchema.safeParse(tool);
  if (!parsed.success) throw new LocalExecutionError('invalid_request');
  const host = await startWorker({
    type: 'start', id: randomUUID(), paths: workerPaths(paths), mode: 'probe', tool: parsed.data,
  }, signal, tools, logError);
  try {
    const result = await host.result;
    await host.closed;
    if (typeof result !== 'string') throw new LocalExecutionError('worker_failed');
    return result;
  } finally { await host.finish(); }
}
