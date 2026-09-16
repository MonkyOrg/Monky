import { LIMITS, localTaskResultSchema, type LocalTaskResult } from '@monky/shared';
import { v4 as uuidv4 } from 'uuid';
import { LocalExecutionError } from './localExecutionSupport';

export interface LocalPreviewContext {
  connectionId: string;
  botId: string;
  botPublicKey: string;
  requestId: string;
}

interface PreviewEntry {
  context: LocalPreviewContext;
  taskId: string;
  result: Extract<LocalTaskResult, { operation: 'youtube.preview' }>;
  expiresAt: number;
}

const MAX_PREVIEWS = LIMITS.MAX_BOT_AUDIO_PREVIEW_HANDLERS;
const PREVIEW_TTL_MS = LIMITS.BOT_AUDIO_PREVIEW_TIMEOUT_MS;

function sameContext(left: LocalPreviewContext, right: LocalPreviewContext): boolean {
  return left.connectionId === right.connectionId && left.botId === right.botId &&
    left.botPublicKey === right.botPublicKey && left.requestId === right.requestId;
}

/** Handles never contain bytes and cannot be resolved outside their original client request. */
export class LocalPreviewStore {
  private entries = new Map<string, PreviewEntry>();
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;

  public put(context: LocalPreviewContext, taskId: string, value: unknown): string {
    this.expire();
    const parsed = localTaskResultSchema.safeParse(value);
    if (!parsed.success || parsed.data.operation !== 'youtube.preview' || !taskId ||
      !context.connectionId || !context.botId || !context.botPublicKey || !context.requestId) {
      throw new LocalExecutionError('invalid_request');
    }
    if (this.entries.size >= MAX_PREVIEWS) throw new LocalExecutionError('busy');
    const handle = uuidv4();
    this.entries.set(handle, {
      context: { ...context }, taskId, result: parsed.data, expiresAt: Date.now() + PREVIEW_TTL_MS,
    });
    this.scheduleExpiry();
    return handle;
  }

  public take(handle: string, context: LocalPreviewContext, taskId: string): Extract<LocalTaskResult, { operation: 'youtube.preview' }> {
    this.expire();
    const entry = this.entries.get(handle);
    if (!entry || entry.taskId !== taskId || !sameContext(entry.context, context)) {
      throw new LocalExecutionError('permission_denied');
    }
    this.entries.delete(handle);
    this.scheduleExpiry();
    return entry.result;
  }

  public releaseRequest(context: LocalPreviewContext): void {
    for (const [id, entry] of this.entries) if (sameContext(entry.context, context)) this.entries.delete(id);
    this.scheduleExpiry();
  }

  public releaseTask(taskId: string): void {
    for (const [id, entry] of this.entries) if (entry.taskId === taskId) this.entries.delete(id);
    this.scheduleExpiry();
  }

  public clear(): void {
    this.entries.clear();
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
  }

  private expire(): void {
    const now = Date.now();
    for (const [id, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(id);
  }

  private scheduleExpiry(): void {
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    if (!this.entries.size) return;
    const next = Math.min(...[...this.entries.values()].map((entry) => entry.expiresAt));
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      this.expire();
      this.scheduleExpiry();
    }, Math.max(1, next - Date.now()));
  }
}
