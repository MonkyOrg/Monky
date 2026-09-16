import path from 'node:path';
import {
  LIMITS, LOCAL_EXECUTION_RUNTIME_LIMITS, localExecutionFailureSchema,
  localRuntimeSourceFailureSchema, localTaskResultSchema, localTaskSpecSchema, localToolIdSchema,
  type LocalExecutionFailure, type LocalRuntimeSourceFailure, type LocalTaskResult, type LocalTaskSpec, type LocalToolId,
} from '@monky/shared';
import { errorDiagnostic, MediaError, safeDiagnostic, SourceRecoveryError } from '@monky/bot-sdk/dist/localRuntime';
import type { LocalToolPaths } from './LocalTools';
import { LocalExecutionError } from './errors';

export const WORKER_LIMITS = {
  messageBytes: Math.ceil(LIMITS.MAX_BOT_AUDIO_PREVIEW_BYTES / 3) * 4 + 16384,
  diagnosticBytes: 65536,
  pendingCommands: 16,
  startupMs: 5000,
  controlMs: 5000,
  stopMs: 5000,
  cachePollMs: 500,
  cacheScanMs: 5000,
  cacheEntries: 10000,
  cacheDepth: 16,
} as const;

interface WorkerStartBase {
  type: 'start';
  id: string;
  paths: LocalToolPaths;
  directory: string;
}
export type WorkerStart = WorkerStartBase & (
  | { mode: 'task'; spec: LocalTaskSpec }
  | { mode: 'probe'; tool: LocalToolId }
);
export type WorkerCommand =
  | WorkerStart
  | { type: 'read'; id: string; requestId: number; count: number }
  | { type: 'ack'; id: string; requestId: number; playedFrames: number }
  | { type: 'pause'; id: string; requestId: number; paused: boolean }
  | { type: 'stop'; id: string; reason: LocalExecutionFailure };
export type WorkerReply =
  | { type: 'ready'; id: string }
  | { type: 'result'; id: string; result: LocalTaskResult }
  | { type: 'version'; id: string; version: string }
  | { type: 'frames'; id: string; requestId: number; frames: string[]; done: boolean }
  | { type: 'accepted'; id: string; requestId: number; operation: 'ack' | 'pause' }
  | { type: 'failure'; id: string; reason: LocalExecutionFailure; detail: string; sourceFailure?: LocalRuntimeSourceFailure }
  | { type: 'closed'; id: string };

export type WorkerOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

export function workerDeferred<T>(): {
  promise: Promise<T>; outcome: Promise<WorkerOutcome<T>>;
  resolve(value: T): void; reject(error: unknown): void;
} {
  let resolve: (value: T) => void = () => { throw new Error('Uninitialized worker promise'); };
  let reject: (error: unknown) => void = () => { throw new Error('Uninitialized worker promise'); };
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // Keep an explicit failure outcome even before the caller receives the public promise.
  const outcome = promise.then<WorkerOutcome<T>, WorkerOutcome<T>>(
    value => ({ ok: true, value }), error => ({ ok: false, error }),
  );
  return { promise, outcome, resolve, reject };
}

function invalid(): never { throw new LocalExecutionError('invalid_request'); }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== allowed.length || actual.some(key => !allowed.includes(key))) invalid();
}

function jsonBytes(value: unknown, budget = WORKER_LIMITS.messageBytes, depth = 0): number {
  if (budget < 0 || depth > 8) invalid();
  if (typeof value === 'string') {
    if (value.length > budget) invalid();
    const size = Buffer.byteLength(value) + 2;
    if (size > budget) invalid();
    return size;
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return 24;
  if (Array.isArray(value)) {
    if (value.length > Math.max(LOCAL_EXECUTION_RUNTIME_LIMITS.frameBatch, LIMITS.MAX_BOT_AUTOCOMPLETE_CHOICES)) invalid();
    let size = 2;
    for (const entry of value) size += jsonBytes(entry, budget - size, depth + 1) + 1;
    if (size > budget) invalid();
    return size;
  }
  if (!record(value)) invalid();
  const names = Object.keys(value);
  if (names.length > 10) invalid();
  let size = 2;
  for (const name of names) {
    size += jsonBytes(name, budget - size, depth + 1) + 1;
    size += jsonBytes(value[name], budget - size, depth + 1) + 1;
  }
  if (size > budget) invalid();
  return size;
}

export function workerId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) invalid();
  return value;
}

export function workerPath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value) ||
      !path.isAbsolute(value) || path.resolve(value) === path.parse(value).root) invalid();
  if (process.platform === 'win32' && (/^[\\/]{2}/.test(value) || !/^[A-Za-z]:[\\/]/.test(value))) invalid();
  return path.resolve(value);
}

export function workerPaths(value: unknown): LocalToolPaths {
  if (!record(value)) invalid();
  keys(value, ['node', 'ytDlp', 'ffmpeg']);
  return { node: workerPath(value.node), ytDlp: workerPath(value.ytDlp), ffmpeg: workerPath(value.ffmpeg) };
}

export function workerInteger(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid();
  return value;
}

export function workerVersion(value: unknown): string {
  if (typeof value !== 'string' || value !== value.trim() || !value.length || value.length > 128 ||
      /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(value)) invalid();
  return value;
}

export function workerBase64(value: unknown, limit: number): Buffer {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(limit / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) invalid();
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > limit || bytes.toString('base64') !== value) invalid();
  return bytes;
}

export function workerResult(value: unknown): LocalTaskResult {
  jsonBytes(value);
  const result = localTaskResultSchema.safeParse(value);
  if (!result.success) invalid();
  if (result.data.operation === 'youtube.preview') workerBase64(result.data.audioBase64, LIMITS.MAX_BOT_AUDIO_PREVIEW_BYTES);
  return result.data;
}

export function parseWorkerCommand(value: unknown): WorkerCommand {
  jsonBytes(value);
  if (!record(value)) invalid();
  const id = workerId(value.id);
  if (value.type === 'start') {
    const base = {
      type: 'start' as const, id, paths: workerPaths(value.paths), directory: workerPath(value.directory),
    };
    if (value.mode === 'task') {
      keys(value, ['type', 'id', 'paths', 'directory', 'mode', 'spec']);
      const spec = localTaskSpecSchema.safeParse(value.spec);
      if (!spec.success) invalid();
      return { ...base, mode: 'task', spec: spec.data };
    }
    keys(value, ['type', 'id', 'paths', 'directory', 'mode', 'tool']);
    const tool = localToolIdSchema.safeParse(value.tool);
    if (value.mode !== 'probe' || !tool.success) invalid();
    return { ...base, mode: 'probe', tool: tool.data };
  }
  if (value.type === 'stop') {
    keys(value, ['type', 'id', 'reason']);
    const reason = localExecutionFailureSchema.safeParse(value.reason);
    if (!reason.success) invalid();
    return { type: 'stop', id, reason: reason.data };
  }
  const requestId = workerInteger(value.requestId, 1, 0xffffffff);
  if (value.type === 'read') {
    keys(value, ['type', 'id', 'requestId', 'count']);
    return { type: 'read', id, requestId, count: workerInteger(value.count, 1, LOCAL_EXECUTION_RUNTIME_LIMITS.frameBatch) };
  }
  if (value.type === 'ack') {
    keys(value, ['type', 'id', 'requestId', 'playedFrames']);
    return { type: 'ack', id, requestId, playedFrames: workerInteger(value.playedFrames, 0, 0xffffffff) };
  }
  if (value.type === 'pause' && typeof value.paused === 'boolean') {
    keys(value, ['type', 'id', 'requestId', 'paused']);
    return { type: 'pause', id, requestId, paused: value.paused };
  }
  return invalid();
}

export function parseWorkerReply(value: unknown): WorkerReply {
  jsonBytes(value);
  if (!record(value)) invalid();
  const id = workerId(value.id);
  if (value.type === 'ready' || value.type === 'closed') {
    keys(value, ['type', 'id']);
    return { type: value.type, id };
  }
  if (value.type === 'result') {
    keys(value, ['type', 'id', 'result']);
    return { type: 'result', id, result: workerResult(value.result) };
  }
  if (value.type === 'version') {
    keys(value, ['type', 'id', 'version']);
    return { type: 'version', id, version: workerVersion(value.version) };
  }
  if (value.type === 'failure') {
    keys(value, ['type', 'id', 'reason', 'detail', ...('sourceFailure' in value ? ['sourceFailure'] : [])]);
    const reason = localExecutionFailureSchema.safeParse(value.reason);
    if (!reason.success || typeof value.detail !== 'string' || value.detail.length > 1024) invalid();
    const source = 'sourceFailure' in value ? localRuntimeSourceFailureSchema.safeParse(value.sourceFailure) : undefined;
    if (source && !source.success) invalid();
    return { type: 'failure', id, reason: reason.data, detail: safeDiagnostic(value.detail),
      ...(source?.success ? { sourceFailure: source.data } : {}) };
  }
  const requestId = workerInteger(value.requestId, 1, 0xffffffff);
  if (value.type === 'frames') {
    keys(value, ['type', 'id', 'requestId', 'frames', 'done']);
    if (!Array.isArray(value.frames) || value.frames.length > LOCAL_EXECUTION_RUNTIME_LIMITS.frameBatch ||
        typeof value.done !== 'boolean' || !value.done && value.frames.length === 0) invalid();
    const frames: string[] = [];
    for (const frame of value.frames) {
      workerBase64(frame, LOCAL_EXECUTION_RUNTIME_LIMITS.frameBytes);
      if (typeof frame !== 'string') invalid();
      frames.push(frame);
    }
    return { type: 'frames', id, requestId, frames, done: value.done };
  }
  if (value.type === 'accepted' && (value.operation === 'ack' || value.operation === 'pause')) {
    keys(value, ['type', 'id', 'requestId', 'operation']);
    return { type: 'accepted', id, requestId, operation: value.operation };
  }
  return invalid();
}

export function workerError(error: unknown, fallback: LocalExecutionFailure = 'worker_failed'): LocalExecutionError {
  if (error instanceof LocalExecutionError) return error;
  let sourceFailure: LocalRuntimeSourceFailure | undefined;
  if (error instanceof MediaError) {
    switch (error.code) {
      case 'input': case 'unsupported': fallback = 'invalid_request'; break;
      case 'tools': case 'runtime': fallback = 'tools_missing'; break;
      case 'unavailable': case 'recovery_failed': fallback = 'provider_unavailable'; break;
      case 'busy': fallback = 'busy'; break;
      case 'timeout': fallback = 'timeout'; break;
      case 'cancelled': fallback = 'cancelled'; break;
    }
    // Only SourceRecoveryError supplies an authoritative recovery count; never invent one for a generic error.
    const source = localRuntimeSourceFailureSchema.safeParse(error instanceof SourceRecoveryError
      ? { code: 'recovery_failed', attempts: error.attempts } : { code: error.code });
    if (source.success) sourceFailure = source.data;
  }
  return new LocalExecutionError(fallback, { cause: new Error(errorDiagnostic(error)),
    ...(sourceFailure ? { sourceFailure } : {}) });
}

export function workerDirectories(directory: string): Record<'temp' | 'home' | 'config' | 'cache' | 'data' | 'state' | 'runtime', string> {
  return {
    temp: path.join(directory, 'temp'), home: path.join(directory, 'home'), config: path.join(directory, 'config'),
    cache: path.join(directory, 'cache'), data: path.join(directory, 'data'), state: path.join(directory, 'state'),
    runtime: path.join(directory, 'runtime'),
  };
}
