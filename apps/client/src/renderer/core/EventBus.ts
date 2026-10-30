import { clientLog } from './ClientLogService';
import type { AppEvents } from './appEventMap';

/** What `emit` takes after the event name: nothing for `void` events, optional when `undefined` is allowed. */
export type EventArgs<T> = undefined extends T ? [data?: T] : [data: T];
export type EventCallback<T> = (...args: EventArgs<T>) => void;
export type EventName<M> = keyof M & string;

interface HandlerFailures {
  since: number;
  logged: number;
  /** Failures left out of the client log since the last one written. */
  skipped: number;
}

/**
 * Publish/subscribe bus typed by an event map (`AppEvents` for the app bus).
 * An event name or payload that disagrees with the map does not compile.
 */
export class EventBus<M extends object> {
  /**
   * How many failures of one event's handlers reach the client log per window.
   * The console still gets every one; the log only needs the first few, and a
   * handler that throws on a frequent event would otherwise flood the file.
   */
  static HANDLER_ERROR_LOG_LIMIT = 3;
  static HANDLER_ERROR_LOG_WINDOW_MS = 60_000;
  private static readonly handlerFailures = new Map<string, HandlerFailures>();

  private listeners = new Map<string, Set<EventCallback<never>>>();

  public on<K extends EventName<M>>(event: K, callback: EventCallback<M[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(callback);

    // Return unbind function
    return () => {
      this.off(event, callback);
    };
  }

  public off<K extends EventName<M>>(event: K, callback: EventCallback<M[K]>): void {
    const set = this.listeners.get(event);
    if (set) {
      set.delete(callback);
      if (set.size === 0) {
        this.listeners.delete(event);
      }
    }
  }

  public emit<K extends EventName<M>>(event: K, ...args: EventArgs<M[K]>): void {
    // `on` files each listener under its own event, so this set only holds listeners of `K`.
    const set = this.listeners.get(event) as Set<EventCallback<M[K]>> | undefined;
    if (set) {
      // Rebinding a view during dispatch must not replay the same event forever.
      for (const cb of [...set]) {
        if (!set.has(cb)) continue;
        try {
          cb(...args);
        } catch (err) {
          console.error(`Error in event handler for "${event}":`, err);
          EventBus.logHandlerFailure(event, err);
        }
      }
    }
  }

  public clear(): void {
    this.listeners.clear();
  }

  private static logHandlerFailure(event: string, error: unknown): void {
    const now = Date.now();
    let failures = EventBus.handlerFailures.get(event);
    if (!failures || now - failures.since >= EventBus.HANDLER_ERROR_LOG_WINDOW_MS) {
      failures = { since: now, logged: 0, skipped: failures?.skipped ?? 0 };
      EventBus.handlerFailures.set(event, failures);
    }
    if (failures.logged >= EventBus.HANDLER_ERROR_LOG_LIMIT) {
      failures.skipped++;
      return;
    }
    failures.logged++;
    const skipped = failures.skipped;
    failures.skipped = 0;
    clientLog.error('APP', 'Event handler failed', {
      event,
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
      ...(skipped ? { skipped } : {}),
    });
  }
}

export type AppEventBus = EventBus<AppEvents>;

export const appEvents: AppEventBus = new EventBus<AppEvents>();
