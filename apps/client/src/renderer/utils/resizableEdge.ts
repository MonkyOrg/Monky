/** A panel whose width the person sets by dragging, or with the keyboard on, one of its vertical edges. */
export interface ResizableEdgeOptions {
  /** The element whose width changes. */
  readonly panel: HTMLElement;
  /** The vertical separator on the panel's edge. */
  readonly handle: HTMLElement;
  /** The edge the handle is on: moving it away from the panel makes the panel wider. */
  readonly edge: 'left' | 'right';
  /** The narrowest width; Home goes there. */
  readonly min: number;
  /** Keeps a width inside the bounds the layout allows right now. */
  readonly clamp: (width: number) => number;
  /** Where the chosen width is kept between sessions. */
  readonly storageKey: string;
  /** Pixels moved by each arrow key press. */
  readonly step?: number;
}

/**
 * Makes the edge a keyboard-operable window splitter: drag with the primary
 * button, arrows to step, Home/End to the narrowest and widest width. The width
 * the person chose is saved, restored here and kept apart from the one shown:
 * a window that shrinks only narrows the panel within its bounds, and growing
 * again gives the chosen width back. Returns the cleanup, which also ends a
 * drag in progress without saving it.
 */
export function bindResizableEdge(options: ResizableEdgeOptions): () => void {
  const { panel, handle, edge, min, clamp, storageKey, step = 24 } = options;
  const grows = edge === 'right' ? 1 : -1;
  /** Restored from storage, then set by each drag or key; null until one of them. */
  let chosen: number | null = null;
  const show = (width: number): void => {
    const next = clamp(width);
    panel.style.width = `${next}px`;
    handle.setAttribute('aria-valuenow', String(Math.round(next)));
  };
  /** Takes a new choice, unless the bounds swallow it: then nothing changes, the choice included. */
  const choose = (width: number): boolean => {
    const next = clamp(width);
    if (chosen !== null && next === clamp(chosen)) return false;
    chosen = next;
    show(next);
    return true;
  };
  const persist = (): void => {
    if (chosen === null) return;
    try {
      localStorage.setItem(storageKey, String(Math.round(chosen)));
    } catch {}
  };

  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.tabIndex = 0;
  handle.setAttribute('aria-valuemin', String(min));
  handle.setAttribute('aria-valuemax', String(clamp(Number.MAX_SAFE_INTEGER)));
  handle.setAttribute('aria-valuenow', String(Math.round(clamp(Number.parseFloat(getComputedStyle(panel).width) || min))));
  try {
    const saved = Number.parseInt(localStorage.getItem(storageKey) ?? '', 10);
    if (Number.isFinite(saved)) {
      chosen = saved;
      show(saved);
    }
  } catch {}

  let startX = 0;
  let startWidth = 0;
  let drag: AbortController | null = null;
  const stopDragging = (save: boolean): void => {
    if (!drag) return;
    drag.abort();
    drag = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    handle.classList.remove('is-resizing');
    if (save) persist();
  };
  const bound = new AbortController();
  handle.addEventListener('mousedown', (event: MouseEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    stopDragging(false);
    drag = new AbortController();
    startX = event.clientX;
    startWidth = panel.getBoundingClientRect().width;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    handle.classList.add('is-resizing');
    document.addEventListener('mousemove', (move: MouseEvent) => {
      choose(startWidth + grows * (move.clientX - startX));
    }, { signal: drag.signal });
    document.addEventListener('mouseup', () => stopDragging(true), { signal: drag.signal });
  }, { signal: bound.signal });
  handle.addEventListener('keydown', (event: KeyboardEvent) => {
    // Steps from the width shown, which the bounds may hold below the one chosen.
    const current = chosen !== null ? clamp(chosen) : panel.getBoundingClientRect().width;
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = current + grows * step;
    else if (event.key === 'ArrowLeft') next = current - grows * step;
    else if (event.key === 'Home') next = min;
    else if (event.key === 'End') next = Number.MAX_SAFE_INTEGER;
    if (next === null) return;
    event.preventDefault();
    if (choose(next)) persist();
  }, { signal: bound.signal });
  window.addEventListener('resize', () => {
    handle.setAttribute('aria-valuemax', String(clamp(Number.MAX_SAFE_INTEGER)));
    // The bounds changed, the choice did not: never measure it back from the screen.
    if (chosen !== null) show(chosen);
  }, { signal: bound.signal });

  return () => {
    stopDragging(false);
    bound.abort();
  };
}
