import { t } from '../../i18n';
import { html, type SafeHtml } from '../../utils/html';

/** Clockwise turn applied only on this viewer; the published capture stays as the phone sent it. */
export type ScreenRotation = 0 | 90 | 180 | 270;

const ROTATE_SELECTOR = '[data-screen-rotate]';
const rotations = new Map<string, ScreenRotation>();
const resizeObservers = new WeakMap<HTMLVideoElement, ResizeObserver>();

export function screenRotationFor(tileKey: string): ScreenRotation {
  return rotations.get(tileKey) ?? 0;
}

export function nextScreenRotation(current: ScreenRotation): ScreenRotation {
  return ((current + 90) % 360) as ScreenRotation;
}

/** Advances the tile's turn and remembers it across stage re-renders. */
export function cycleScreenRotation(tileKey: string): ScreenRotation {
  const next = nextScreenRotation(screenRotationFor(tileKey));
  if (next === 0) rotations.delete(tileKey);
  else rotations.set(tileKey, next);
  return next;
}

/** Tile that clips the video; focused pane first, then the grid/mini card. */
export function screenRotationHost(video: HTMLVideoElement): HTMLElement | null {
  return video.closest<HTMLElement>('.stage-focused-main, .stage-card, .stage-mini-card');
}

/** CSS rotate only — the 90°/270° box size is applied separately so the frame stays filled. */
export function screenRotationTransform(degrees: ScreenRotation): string {
  return degrees ? `rotate(${degrees}deg)` : '';
}

/**
 * For a quarter-turn, the video box must be the host with axes swapped: after `rotate(90|270)`
 * that box lands exactly on the tile. Scaling a full-size box left a thin strip and black sides.
 */
export function quarterTurnBox(hostWidth: number, hostHeight: number): {
  width: number; height: number; left: number; top: number;
} | null {
  if (!(hostWidth > 0) || !(hostHeight > 0)) return null;
  return {
    width: hostHeight,
    height: hostWidth,
    left: (hostWidth - hostHeight) / 2,
    top: (hostHeight - hostWidth) / 2,
  };
}

function clearQuarterTurnLayout(video: HTMLVideoElement): void {
  video.style.width = '';
  video.style.height = '';
  video.style.left = '';
  video.style.top = '';
  video.style.right = '';
  video.style.bottom = '';
  video.style.objectFit = '';
}

function applyQuarterTurnLayout(video: HTMLVideoElement, host: HTMLElement): boolean {
  const box = quarterTurnBox(host.clientWidth, host.clientHeight);
  if (!box) return false;
  video.style.width = `${box.width}px`;
  video.style.height = `${box.height}px`;
  video.style.left = `${box.left}px`;
  video.style.top = `${box.top}px`;
  video.style.right = 'auto';
  video.style.bottom = 'auto';
  // Keep letterboxing inside the swapped box; the box itself already matches the tile after rotate.
  video.style.objectFit = 'contain';
  return true;
}

function stopWatchingHost(video: HTMLVideoElement): void {
  const observer = resizeObservers.get(video);
  if (!observer) return;
  observer.disconnect();
  resizeObservers.delete(video);
}

function watchHost(video: HTMLVideoElement, host: HTMLElement): void {
  if (resizeObservers.has(video) || typeof ResizeObserver === 'undefined') return;
  const observer = new ResizeObserver(() => {
    const degrees = Number(video.dataset.screenRotation || 0) as ScreenRotation;
    if (degrees !== 90 && degrees !== 270) {
      stopWatchingHost(video);
      return;
    }
    applyScreenRotation(video, degrees);
    video.dispatchEvent(new CustomEvent('monky:screen-rotation', { bubbles: true }));
  });
  observer.observe(host);
  resizeObservers.set(video, observer);
}

/**
 * Paints the viewer's chosen turn onto `video`. Zoom/pan composes on top via `FocusedScreenZoom`,
 * which reads `data-screen-rotation` and keeps the same box layout.
 */
export function applyScreenRotation(video: HTMLVideoElement, degrees: ScreenRotation): void {
  const host = screenRotationHost(video);
  video.dataset.screenRotation = String(degrees);
  delete video.dataset.screenRotationFit;

  const quarter = degrees === 90 || degrees === 270;
  if (!quarter) clearQuarterTurnLayout(video);

  if (degrees === 0) {
    stopWatchingHost(video);
    if (!video.closest('.is-zoomed')) video.style.transform = '';
    return;
  }

  if (quarter && host) {
    applyQuarterTurnLayout(video, host);
    watchHost(video, host);
  } else {
    stopWatchingHost(video);
  }

  if (video.closest('.is-zoomed')) return;
  video.style.transform = screenRotationTransform(degrees);
}

/** Re-applies remembered turns after the stage re-renders its tiles. */
export function syncScreenRotations(root: HTMLElement): void {
  const live = new Set<string>();
  for (const video of root.querySelectorAll<HTMLVideoElement>('video.screen-share[data-video-tile-key]')) {
    const key = video.dataset.videoTileKey;
    if (!key) continue;
    live.add(key);
    applyScreenRotation(video, screenRotationFor(key));
  }
  for (const key of [...rotations.keys()]) {
    if (!live.has(key)) rotations.delete(key);
  }
}

/** One control per screen tile: each tap turns the picture 90° for this viewer only. */
export function renderScreenRotateButton(tileKey: string): SafeHtml {
  const degrees = screenRotationFor(tileKey);
  return html`<button type="button" class="stage-screen-rotate-btn" data-screen-rotate="${tileKey}"
    data-haptic="impact" title="${t('stage.rotateScreen')}" aria-label="${t('stage.rotateScreen')}"
    aria-pressed="${degrees !== 0}">
    <span class="material-symbols-outlined md-18" aria-hidden="true">rotate_right</span>
  </button>`;
}

/** Drives every rotate button `root` holds, including those its tiles render later. */
export function bindScreenRotate(root: HTMLElement): () => void {
  const controller = new AbortController();
  root.addEventListener('click', event => {
    const button = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>(ROTATE_SELECTOR) : null;
    if (!button) return;
    const tileKey = button.dataset.screenRotate;
    if (!tileKey) return;
    event.stopPropagation();
    const degrees = cycleScreenRotation(tileKey);
    button.setAttribute('aria-pressed', String(degrees !== 0));
    for (const video of root.querySelectorAll<HTMLVideoElement>(`video.screen-share[data-video-tile-key="${CSS.escape(tileKey)}"]`)) {
      applyScreenRotation(video, degrees);
      video.dispatchEvent(new CustomEvent('monky:screen-rotation', { bubbles: true }));
    }
  }, { signal: controller.signal });
  return () => {
    controller.abort();
    for (const video of root.querySelectorAll<HTMLVideoElement>('video.screen-share[data-video-tile-key]')) {
      stopWatchingHost(video);
    }
  };
}
