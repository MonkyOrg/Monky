export const COMPACT_VIEWPORT_QUERY = '(max-width: 960px), (max-width: 1440px) and (hover: none) and (pointer: coarse)';

export function viewportBounds(): { top: number; left: number; width: number; height: number; right: number; bottom: number } {
  const viewport = window.visualViewport;
  const top = viewport?.offsetTop ?? 0;
  const left = viewport?.offsetLeft ?? 0;
  const width = viewport?.width ?? document.documentElement.clientWidth;
  const height = viewport?.height ?? document.documentElement.clientHeight;
  return { top, left, width, height, right: left + width, bottom: top + height };
}

/** Follow the visible viewport when a mobile keyboard opens, without disabling pinch zoom. */
export function bindViewportSize(): () => void {
  const viewport = window.visualViewport;
  if (!viewport) return () => {};
  const lifetime = new AbortController();
  const { signal } = lifetime;
  const root = document.documentElement;
  let frame = 0;
  const apply = (): void => {
    frame = 0;
    if (viewport.scale !== 1) return;
    root.style.setProperty('--viewport-height', `${viewport.height}px`);
    root.style.setProperty('--viewport-top', `${viewport.offsetTop}px`);
  };
  const schedule = (): void => { frame ||= requestAnimationFrame(apply); };
  viewport.addEventListener('resize', schedule, { signal });
  viewport.addEventListener('scroll', schedule, { signal });
  apply();
  return () => {
    lifetime.abort();
    cancelAnimationFrame(frame);
    root.style.removeProperty('--viewport-height');
    root.style.removeProperty('--viewport-top');
  };
}
