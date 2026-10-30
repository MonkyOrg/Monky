import { randomUUID } from 'crypto';

interface PendingReply<T> {
  resolve(value: T): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Requests waiting for the server's correlated reply. Each one settles exactly
 * once: by its reply, by its timeout, when it cannot be sent, or by `rejectAll`
 * when the connection drops.
 */
export class PendingReplies<T> {
  private readonly pending = new Map<string, PendingReply<T>>();

  get size(): number {
    return this.pending.size;
  }

  has(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  /** Sends with a fresh `requestId` and waits for the reply that carries it. */
  request(timeoutMs: number, timeoutMessage: string, send: (requestId: string) => void): Promise<T> {
    const requestId = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(timeoutMessage));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        send(requestId);
      } catch (error) {
        this.fail(requestId, error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  settle(requestId: string, value: T): boolean {
    const pending = this.take(requestId);
    pending?.resolve(value);
    return pending !== undefined;
  }

  fail(requestId: string, error: Error): boolean {
    const pending = this.take(requestId);
    pending?.reject(error);
    return pending !== undefined;
  }

  /** Each request gets its own Error, as if each had failed alone. */
  rejectAll(message: string): void {
    for (const requestId of [...this.pending.keys()]) this.fail(requestId, new Error(message));
  }

  private take(requestId: string): PendingReply<T> | undefined {
    const pending = this.pending.get(requestId);
    if (!pending) return undefined;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    return pending;
  }
}
