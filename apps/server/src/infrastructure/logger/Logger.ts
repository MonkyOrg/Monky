import { AsyncLocalStorage } from 'node:async_hooks';
import { LIMITS, LogCategory, LogEntry, LogLevel } from '@monky/shared';
import { ServerLogScope } from './ServerLogScope';

export type { LogCategory } from '@monky/shared';

export type LogListener = (entry: LogEntry) => void;

/**
 * Server logger.
 *
 * Besides writing to the console, every entry is kept in a bounded in-memory
 * buffer and pushed to subscribers. That is what lets the desktop app show the
 * logs of the server it is hosting, and the CLI read them back, without anyone
 * reaching into the server's internals — the Server GUI used to monkey patch
 * these very methods to capture the same information, which broke silently
 * whenever a signature changed.
 *
 * The buffer is bounded: a long-running server would otherwise grow it without
 * limit, and only the most recent entries are worth showing.
 */
export class Logger {
  private static buffer: LogEntry[] = [];
  private static listeners = new Set<LogListener>();
  private static scope = new AsyncLocalStorage<ServerLogScope>();

  public static withScope<T>(scope: ServerLogScope, operation: () => T): T {
    return this.scope.run(scope, operation);
  }

  /**
   * Registers a listener for new entries and returns the function that removes
   * it, so a caller cannot leak a subscription by losing the original reference.
   */
  public static subscribe(listener: LogListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Most recent entries, oldest first. */
  public static getRecent(): LogEntry[] {
    return [...this.buffer];
  }

  public static clearBuffer(): void {
    this.buffer = [];
  }

  private static record(level: LogLevel, category: LogCategory, message: string, remoteMessage: string): void {
    const entry: LogEntry = { timestamp: new Date().toISOString(), level, category, message };
    this.scope.getStore()?.record(entry, remoteMessage);

    this.buffer.push(entry);
    if (this.buffer.length > LIMITS.LOG_BUFFER_SIZE) {
      this.buffer.splice(0, this.buffer.length - LIMITS.LOG_BUFFER_SIZE);
    }

    for (const listener of this.listeners) {
      // A broken listener must not take the server down, nor stop the remaining
      // listeners from being notified.
      try {
        listener(entry);
      } catch {
        /* ignore */
      }
    }
  }

  public static log(category: LogCategory, message: string, meta?: unknown): void {
    const timestamp = new Date().toISOString();
    const metaStr = meta ? ` | ${JSON.stringify(meta)}` : '';
    console.log(`[${timestamp}] [${category}] ${message}${metaStr}`);
    this.record('INFO', category, `${message}${metaStr}`, message);
  }

  public static info(category: LogCategory, message: string, meta?: unknown): void {
    this.log(category, message, meta);
  }

  public static warn(category: LogCategory, message: string, meta?: unknown): void {
    const timestamp = new Date().toISOString();
    const metaStr = meta ? ` | ${JSON.stringify(meta)}` : '';
    console.warn(`[${timestamp}] [WARN:${category}] ${message}${metaStr}`);
    this.record('WARN', category, `${message}${metaStr}`, message);
  }

  public static error(category: LogCategory, message: string, error?: unknown): void {
    const timestamp = new Date().toISOString();
    const errStr = error ? ` | ${error instanceof Error ? error.stack : JSON.stringify(error)}` : '';
    console.error(`[${timestamp}] [ERROR:${category}] ${message}${errStr}`);
    this.record('ERROR', category, `${message}${errStr}`, message);
  }

  public static security(message: string, meta?: unknown): void {
    this.log('SECURITY', message, meta);
  }
}
