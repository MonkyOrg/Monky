import type { BrowserWindow } from 'electron';

/**
 * Chromium's frame metrics (cc::FrameSorter) can stall for good: once one frame's
 * presentation feedback arrives more than 300 frames late (1.25 s at 240 Hz), the
 * sorter never flushes again. From then on every animation, transition or
 * requestAnimationFrame that starts and stops leaks a FrameSequenceTracker that the
 * compositor thread walks on every frame, so after an hour or two even hovering lags.
 *
 * Chromium clears that state when the renderer becomes hidden, which happens all the
 * time for browser tabs but never in Monky: `backgroundThrottling: false` keeps the
 * renderer visible so audio and WebRTC are not throttled.
 *
 * While the window is out of sight (minimized or covered by another app), throttling is
 * allowed for the duration of one page capture. The capture makes Chromium re-apply
 * the real visibility, which now reaches the compositor and resets the stalled state;
 * restoring `backgroundThrottling: false` resumes painting right away, keeping timers,
 * animation frames and media callbacks at full rate. On a window the user can see the
 * same sequence changes nothing.
 */

/** Bounds how long a stalled compositor accumulates trackers while Monky is out of sight. */
export const COMPOSITOR_REFRESH_INTERVAL_MS = 60_000;
/** Chromium computes minimized/occluded visibility asynchronously after the window event. */
export const COMPOSITOR_REFRESH_SETTLE_MS = 1_500;
/** Throttling never stays enabled longer than this, even if a capture never completes (it takes ~30 ms). */
export const COMPOSITOR_REFRESH_CAPTURE_TIMEOUT_MS = 1_000;

export interface CompositorRefreshOptions {
  platform?: NodeJS.Platform;
  intervalMs?: number;
  settleMs?: number;
  captureTimeoutMs?: number;
  onError?: (error: unknown) => void;
}

type WindowEvent = 'blur' | 'minimize' | 'hide' | 'show';
type RefreshWindow = Pick<BrowserWindow, 'isDestroyed' | 'isVisible' | 'isMinimized' | 'isFocused'> & {
  on(event: WindowEvent, listener: () => void): unknown;
  removeListener(event: WindowEvent, listener: () => void): unknown;
  webContents: Pick<BrowserWindow['webContents'],
    'isDestroyed' | 'isCrashed' | 'getBackgroundThrottling' | 'setBackgroundThrottling' | 'capturePage'>;
};

export function bindCompositorRefresh(window: RefreshWindow, options: CompositorRefreshOptions = {}): () => void {
  // Validated on Windows only: other platforms keep their current behavior.
  if ((options.platform ?? process.platform) !== 'win32') return () => {};
  const intervalMs = options.intervalMs ?? COMPOSITOR_REFRESH_INTERVAL_MS;
  const settleMs = options.settleMs ?? COMPOSITOR_REFRESH_SETTLE_MS;
  const captureTimeoutMs = options.captureTimeoutMs ?? COMPOSITOR_REFRESH_CAPTURE_TIMEOUT_MS;
  const onError = options.onError ?? ((error: unknown) => console.warn('Compositor refresh failed:', error));
  let disposed = false;
  let inFlight = false;
  // Electron reports a minimized window as not visible, and a minimized window hidden to
  // the tray looks the same, so the tray is tracked through its own events.
  let hiddenToTray = false;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;

  const eligible = (): boolean => {
    if (disposed || window.isDestroyed()) return false;
    const contents = window.webContents;
    return !contents.isDestroyed() && !contents.isCrashed()
      // A window hidden in the tray paints nothing, so its capture would only finish once shown.
      && !hiddenToTray && (window.isVisible() || window.isMinimized())
      // The focused window is in front of the user: the refresh could not reset anything.
      && !window.isFocused()
      // With throttling already allowed Chromium hides the renderer by itself.
      && !contents.getBackgroundThrottling();
  };

  const refresh = (): void => {
    if (inFlight || !eligible()) return;
    inFlight = true;
    const contents = window.webContents;
    let restored = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const restore = (): void => {
      if (restored) return;
      restored = true;
      if (timeout) clearTimeout(timeout);
      if (!contents.isDestroyed()) contents.setBackgroundThrottling(false);
    };
    timeout = setTimeout(restore, captureTimeoutMs);
    let capture: Promise<unknown>;
    try {
      contents.setBackgroundThrottling(true);
      capture = contents.capturePage();
    } catch (error) {
      capture = Promise.reject(error);
    }
    // A capture that never settles keeps further refreshes off instead of stacking them.
    void capture.then(() => undefined, onError).finally(() => {
      restore();
      inFlight = false;
    });
  };

  const schedule = (): void => {
    if (disposed) return;
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      refresh();
    }, settleMs);
  };

  const onHide = (): void => { hiddenToTray = true; };
  const onShow = (): void => { hiddenToTray = false; };
  const interval = setInterval(refresh, intervalMs);
  window.on('blur', schedule);
  window.on('minimize', schedule);
  window.on('hide', onHide);
  window.on('show', onShow);

  return () => {
    if (disposed) return;
    disposed = true;
    clearInterval(interval);
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = null;
    window.removeListener('blur', schedule);
    window.removeListener('minimize', schedule);
    window.removeListener('hide', onHide);
    window.removeListener('show', onShow);
  };
}
