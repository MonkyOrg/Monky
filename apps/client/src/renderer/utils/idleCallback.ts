/** Work slice granted per fallback callback; short enough to keep a 60 Hz frame. */
const FALLBACK_BUDGET_MS = 8;

/**
 * Runs `callback` when the renderer is idle and returns its cancellation.
 * Safari ships without requestIdleCallback (#883), so there the work runs in short timer slices.
 */
export function requestIdle(callback: IdleRequestCallback): () => void {
  if (typeof globalThis.requestIdleCallback === 'function') {
    const handle = globalThis.requestIdleCallback(callback);
    return () => globalThis.cancelIdleCallback(handle);
  }
  const timer = setTimeout(() => {
    const started = performance.now();
    callback({ didTimeout: false, timeRemaining: () => Math.max(0, FALLBACK_BUDGET_MS - (performance.now() - started)) });
  }, 1);
  return () => clearTimeout(timer);
}
