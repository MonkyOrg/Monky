/**
 * Reordering by dragging with the pointer, shared by the sidebar's channels and
 * categories and by the server rail (R-SHELL-12): each view only works out where
 * the pointer would drop. Native drag-and-drop is left to what it suits, people
 * moved between voice rooms and files: dragging a row with it would carry a
 * picture of the row, or of the server icon.
 */

/** Distance, in px, a press travels before it becomes a drag; shorter is a click. */
export const REORDER_THRESHOLD_PX = 6;

/** What of a press the drag reads. */
export type ReorderPress = Pick<PointerEvent, 'button' | 'isPrimary' | 'pointerId' | 'clientX' | 'clientY'>;

/**
 * Whether a pointer event presses the primary button. Pointer events send
 * pointerdown only for the first button that goes down: while another mouse
 * button is held (one bound to push-to-talk, say), pressing the left one
 * arrives as a move that adds it.
 */
export function isPrimaryPress(event: Pick<PointerEvent, 'isPrimary' | 'button' | 'buttons'>): boolean {
  return event.isPrimary && event.button === 0 && (event.buttons & 1) === 1;
}

/** Calls `press` whenever the primary button goes down on `target`; see isPrimaryPress. */
export function onPrimaryPress(target: HTMLElement, press: (event: PointerEvent) => void, options?: AddEventListenerOptions): void {
  const listener = (event: PointerEvent) => { if (isPrimaryPress(event)) press(event); };
  target.addEventListener('pointerdown', listener, options);
  target.addEventListener('pointermove', listener, options);
}

export interface PointerReorder {
  /**
   * Holds the pointer while it drags. Pass the list, never the pressed row:
   * lists redraw their rows during a drag, and a removed element loses the
   * capture.
   */
  capture: Pick<Element, 'setPointerCapture' | 'releasePointerCapture' | 'hasPointerCapture'>;
  /** Aborting it ends the press, or cancels the drag, e.g. when the list is torn down. */
  signal?: AbortSignal;
  /** The press became a drag. */
  onStart: () => void;
  /** Where the dragging pointer is, in viewport coordinates. */
  onMove: (clientX: number, clientY: number) => void;
  /** Released there. */
  onDrop: (clientX: number, clientY: number) => void;
  /** Escape, a cancelled pointer, losing the window or the signal ended the drag. */
  onCancel: () => void;
}

/**
 * Follows a primary press that may become a reorder drag. Past
 * REORDER_THRESHOLD_PX the pointer is captured and its moves reported, and
 * releasing drops. Escape cancels the drag and goes no further. The click a
 * release produces belongs to the drag: it never opens what the drag started
 * on, even after Escape.
 */
export function followPointerReorder(press: ReorderPress, reorder: PointerReorder): void {
  if (press.button !== 0 || !press.isPrimary || reorder.signal?.aborted) return;
  const { pointerId } = press;
  const following = new AbortController();
  const signal = following.signal;
  let dragging = false;
  let cancelled = false;

  const releaseCapture = () => {
    try {
      if (reorder.capture.hasPointerCapture(pointerId)) reorder.capture.releasePointerCapture(pointerId);
    } catch { /* The pointer is already gone. */ }
  };
  const finish = (release: PointerEvent | null) => {
    if (signal.aborted) return;
    following.abort();
    if (!dragging) return;
    if (release) swallowReleaseClick();
    if (cancelled) return;
    releaseCapture();
    if (release) reorder.onDrop(release.clientX, release.clientY);
    else reorder.onCancel();
  };

  window.addEventListener('pointermove', event => {
    if (event.pointerId !== pointerId) return;
    // With another button still held, the left one comes up as a move: no pointerup arrives until the last one does.
    if ((event.buttons & 1) === 0) {
      finish(event);
      return;
    }
    if (cancelled) return;
    if (!dragging) {
      if (Math.hypot(event.clientX - press.clientX, event.clientY - press.clientY) < REORDER_THRESHOLD_PX) return;
      dragging = true;
      try { reorder.capture.setPointerCapture(pointerId); } catch { /* Released meanwhile; the window still hears it. */ }
      reorder.onStart();
    }
    reorder.onMove(event.clientX, event.clientY);
  }, { signal });
  window.addEventListener('pointerup', event => { if (event.pointerId === pointerId) finish(event); }, { signal });
  window.addEventListener('pointercancel', event => { if (event.pointerId === pointerId) finish(null); }, { signal });
  window.addEventListener('blur', () => finish(null), { signal });
  // Stopped on its way down, before the document and its elements: Escape ends the drag and closes nothing else.
  window.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !dragging || cancelled) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    cancelled = true;
    releaseCapture();
    reorder.onCancel();
  }, { capture: true, signal });
  reorder.signal?.addEventListener('abort', () => finish(null), { signal });
}

/**
 * The click the browser dispatches for a release, right after it in the same
 * task. Only a real one: a click made by code never belongs to the drag.
 */
function swallowReleaseClick(): void {
  const swallow = new AbortController();
  window.addEventListener('click', event => {
    if (!event.isTrusted) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    swallow.abort();
  }, { capture: true, signal: swallow.signal });
  setTimeout(() => swallow.abort(), 0);
}
