export const COMPACT_VIEWPORT_QUERY = '(max-width: 960px), (max-width: 1440px) and (hover: none) and (pointer: coarse)';
/** A phone on its side: too short for one page at a time, wide enough for two columns (responsiveDialogs.css). */
export const PHONE_LANDSCAPE_QUERY = '(max-height: 540px) and (min-aspect-ratio: 3/2)';
/** A finger is the main pointer: there is no hover and no right click. */
export const TOUCH_POINTER_QUERY = '(hover: none) and (pointer: coarse)';

export function viewportBounds(): { top: number; left: number; width: number; height: number; right: number; bottom: number } {
  const viewport = window.visualViewport;
  const top = viewport?.offsetTop ?? 0;
  const left = viewport?.offsetLeft ?? 0;
  const width = viewport?.width ?? document.documentElement.clientWidth;
  const height = viewport?.height ?? document.documentElement.clientHeight;
  return { top, left, width, height, right: left + width, bottom: top + height };
}

const EDITABLE = 'input, textarea, [contenteditable="true"], [contenteditable=""]';
/** Shorter gaps are browser toolbars appearing, not a keyboard. */
const KEYBOARD_MIN_HEIGHT = 120;
/** The keyboard animation plus the late visualViewport report, measured on iOS. */
const VIEWPORT_SETTLE_MS = 1000;

/**
 * Follow the visible viewport when a mobile keyboard opens, without disabling pinch zoom.
 * `changeKeyboard` runs the keyboard flag's change, so a layout can animate around it.
 */
export function bindViewportSize(changeKeyboard: (update: () => void) => void = update => update()): () => void {
  const viewport = window.visualViewport;
  if (!viewport) return () => {};
  const lifetime = new AbortController();
  const { signal } = lifetime;
  const root = document.documentElement;
  let frame = 0;
  let settleUntil = 0;
  let fullWidth = 0;
  let fullHeight = 0;
  let height = '';
  let top = '';
  const apply = (): void => {
    if (viewport.scale !== 1) return;
    const nextHeight = `${viewport.height}px`;
    // iOS scrolls the page to the field and may report it in visualViewport ~350 ms later, without any
    // event in between: the scrolled page is the only sign meanwhile, and following it late makes the app jump.
    const nextTop = `${Math.max(viewport.offsetTop, window.scrollY)}px`;
    if (nextHeight !== height) root.style.setProperty('--viewport-height', height = nextHeight);
    if (nextTop !== top) root.style.setProperty('--viewport-top', top = nextTop);
    // The tallest viewport seen at this width is the keyboard-free height; rotating starts over.
    if (viewport.width !== fullWidth) {
      fullWidth = viewport.width;
      fullHeight = viewport.height;
    } else fullHeight = Math.max(fullHeight, viewport.height);
    const editing = document.activeElement instanceof HTMLElement && document.activeElement.matches(EDITABLE);
    const keyboard = editing && fullHeight - viewport.height > KEYBOARD_MIN_HEIGHT;
    if (keyboard !== root.hasAttribute('data-keyboard-open')) {
      changeKeyboard(() => root.toggleAttribute('data-keyboard-open', keyboard));
    }
  };
  const tick = (): void => {
    apply();
    frame = performance.now() < settleUntil ? requestAnimationFrame(tick) : 0;
  };
  // While a keyboard opens or closes, check every frame: the page moves before the browser says so.
  const follow = (): void => {
    settleUntil = performance.now() + VIEWPORT_SETTLE_MS;
    frame ||= requestAnimationFrame(tick);
  };
  // The viewport already moved: follow it before the frame paints, or the app shows one frame raised or lowered.
  const applyNow = (): void => { apply(); follow(); };
  viewport.addEventListener('resize', applyNow, { signal });
  viewport.addEventListener('scroll', applyNow, { signal });
  document.addEventListener('focusin', follow, { signal });
  document.addEventListener('focusout', follow, { signal });
  apply();
  return () => {
    lifetime.abort();
    cancelAnimationFrame(frame);
    root.style.removeProperty('--viewport-height');
    root.style.removeProperty('--viewport-top');
    root.removeAttribute('data-keyboard-open');
  };
}
