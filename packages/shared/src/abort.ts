/**
 * Cancellation primitives shared by the app (main, renderer and the local
 * execution worker), the server and the bot SDK. Only AbortSignal and timers
 * are used, so they run on every runtime the SDK supports (Node 18 included).
 * Each caller keeps its own error: these helpers only decide when to reject.
 */

/** A deadline whose rejection is built when it fires. */
export interface Deadline {
  ms: number;
  reason: () => unknown;
}

export interface RaceOptions {
  /** Rejection when the signal aborts; the signal's reason by default. */
  abortReason?: () => unknown;
  timeout?: Deadline;
}

/**
 * Settles like `promise` unless `signal` aborts, or the deadline passes, first.
 * The listener and the timer are released on every path, and `promise` stays
 * observed, so its rejection after a cancellation is never unhandled. A signal
 * that is already aborted wins over a promise that is already settled.
 */
export function raceSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined, options: RaceOptions = {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      finish();
    };
    const aborted = (): void => settle(() => reject(options.abortReason ? options.abortReason() : signal?.reason));
    signal?.addEventListener('abort', aborted, { once: true });
    const { timeout } = options;
    if (timeout) timer = setTimeout(() => settle(() => reject(timeout.reason())), timeout.ms);
    promise.then((value) => settle(() => resolve(value)), (error: unknown) => settle(() => reject(error)));
    if (signal?.aborted) aborted();
  });
}

export interface LinkedSignal {
  readonly signal: AbortSignal;
  /** Aborts this signal only; the parent is left alone. */
  abort(reason?: unknown): void;
  /** Detaches from the parent and stops the deadline; call it once the work ends. */
  dispose(): void;
}

/**
 * A signal for one operation: it aborts with the parent's reason, with
 * `timeout.reason()` once the deadline passes, or through `abort()`, so the
 * operation can fail or time out without touching the caller's signal.
 */
export function linkedSignal(parent: AbortSignal | undefined, timeout?: Deadline): LinkedSignal {
  const controller = new AbortController();
  const follow = (): void => controller.abort(parent?.reason);
  parent?.addEventListener('abort', follow, { once: true });
  if (parent?.aborted) follow();
  const timer = timeout ? setTimeout(() => controller.abort(timeout.reason()), timeout.ms) : undefined;
  return {
    signal: controller.signal,
    abort: (reason) => controller.abort(reason),
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', follow);
    },
  };
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

/** `Promise.withResolvers()`, for the runtimes and type libraries that predate ES2024. */
export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
