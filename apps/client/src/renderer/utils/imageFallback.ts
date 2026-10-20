/**
 * Friendly placeholders for images that fail to load (#456).
 *
 * The renderer paints almost everything through `innerHTML`, so wiring an
 * `onerror` handler per `<img>` would mean touching dozens of template strings
 * and remembering to do it again on every new one. Instead a single listener is
 * installed on `document` in the capture phase — `error` events do not bubble,
 * but they do propagate downwards — which catches every image in the app,
 * including ones created after this module ran.
 *
 * The failing element is kept in place and only its `src` is swapped, so the
 * caller's sizing, `object-fit` and `border-radius` keep applying and nothing
 * shifts on screen.
 */

import { DEFAULT_AVATAR_URL } from './avatar';
import { t } from '../i18n';

/** Muted "picture that did not load" glyph, matching the app's palette. */
const BROKEN_IMAGE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="64" height="64"><rect width="24" height="24" rx="4" fill="#1c232d"/><path d="M5 17.5 9 12l2.5 3.2L14 12.6l5 6.4H5z" fill="#484f58"/><circle cx="8.6" cy="8.4" r="1.7" fill="#484f58"/><path d="M4.2 4.2l15.6 15.6" stroke="#656d76" stroke-width="1.4" stroke-linecap="round"/></svg>`;

export const BROKEN_IMAGE_URL = `data:image/svg+xml;base64,${btoa(BROKEN_IMAGE_SVG)}`;

/**
 * What to show in place of a broken image. Declared per `<img>` through the
 * `data-fallback` attribute; images without it get the generic placeholder.
 *
 * - `avatar`  — a person silhouette, for user pictures
 * - `initial` — the element gives way to `data-fallback-initial` (or to a sibling
 *               `[data-fallback-initial-slot]` already painted underneath),
 *               matching how a server with no icon is drawn in the rail
 * - `broken`  — the generic "could not load" placeholder (default)
 */
export type ImageFallbackKind = 'avatar' | 'initial' | 'broken';

const APPLIED_FLAG = 'fallbackApplied';
const FAILED_RETRY_MS = 60_000;
// Outcome per `initial` image URL. Views that redraw often (the server rail)
// read it so a re-render neither hides a loaded icon behind its initial for a
// frame nor keeps re-requesting one that cannot load.
const initialImageLoaded = new Set<string>();
const initialImageFailedAt = new Map<string, number>();

export function initialImageState(url: string): 'loaded' | 'failed' | 'unknown' {
  if (initialImageLoaded.has(url)) return 'loaded';
  const failedAt = initialImageFailedAt.get(url);
  if (failedAt !== undefined && Date.now() - failedAt < FAILED_RETRY_MS) return 'failed';
  return 'unknown';
}

function replaceWithInitial(img: HTMLImageElement): void {
  const url = img.getAttribute('src');
  if (url) {
    initialImageLoaded.delete(url);
    initialImageFailedAt.set(url, Date.now());
  }
  // Layered markup already paints the initial under the picture.
  const slot = img.parentElement?.querySelector<HTMLElement>(':scope > [data-fallback-initial-slot]');
  if (slot) {
    slot.title = t('common.imageLoadFailed');
    img.remove();
    return;
  }
  const initial = img.dataset.fallbackInitial ?? '?';
  const span = document.createElement('span');
  span.textContent = initial;
  span.title = t('common.imageLoadFailed');
  img.replaceWith(span);
}

function handleImageLoad(event: Event): void {
  const img = event.target as HTMLImageElement | null;
  if (!img || img.tagName !== 'IMG' || img.dataset.fallback !== 'initial') return;
  const url = img.getAttribute('src');
  if (url) {
    initialImageLoaded.add(url);
    initialImageFailedAt.delete(url);
  }
  img.dataset.loaded = '1';
}

function handleImageError(event: Event): void {
  const img = event.target as HTMLImageElement | null;
  if (!img || img.tagName !== 'IMG') return;

  // A placeholder that somehow fails too must not retrigger this handler.
  if (img.dataset[APPLIED_FLAG] === '1') return;
  img.dataset[APPLIED_FLAG] = '1';

  const kind = (img.dataset.fallback as ImageFallbackKind | undefined) ?? 'broken';

  if (kind === 'initial') {
    replaceWithInitial(img);
    return;
  }

  img.src = kind === 'avatar' ? DEFAULT_AVATAR_URL : BROKEN_IMAGE_URL;
  if (!img.title) img.title = t('common.imageLoadFailed');
}

let installed = false;

/** Installs the app-wide broken-image handler. Safe to call more than once. */
export function installImageFallback(): void {
  if (installed) return;
  installed = true;
  document.addEventListener('error', handleImageError, true);
  document.addEventListener('load', handleImageLoad, true);
}
