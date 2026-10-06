export function automaticScrollBehavior(): ScrollBehavior {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
}

export function smoothScrollIntoView(
  target: Element,
  options: Omit<ScrollIntoViewOptions, 'behavior'> = {},
): void {
  target.scrollIntoView({ ...options, behavior: automaticScrollBehavior() });
}

export function smoothScrollTo(
  container: Element,
  options: Omit<ScrollToOptions, 'behavior'>,
): void {
  container.scrollTo({ ...options, behavior: automaticScrollBehavior() });
}

/** Reveal restored content with a short movement, regardless of history length. */
export function restoreScrollWithMotion(container: HTMLElement, top: number): void {
  const destination = Math.max(0, Math.min(top, container.scrollHeight - container.clientHeight));
  const behavior = automaticScrollBehavior();
  const distance = Math.min(160, container.clientHeight / 3);
  const delta = destination - container.scrollTop;
  if (behavior === 'smooth' && Math.abs(delta) > distance) {
    container.scrollTo({ top: destination - Math.sign(delta) * distance, behavior: 'instant' });
  }
  container.scrollTo({ top: destination, behavior });
}

export function scrollWithin(container: HTMLElement, target: HTMLElement, inset = 0): number {
  if (!container.contains(target)) throw new Error('Scroll target must belong to its container');
  const top = container.scrollTop + target.getBoundingClientRect().top
    - container.getBoundingClientRect().top - container.clientTop - inset;
  const destination = Math.max(0, Math.min(top, container.scrollHeight - container.clientHeight));
  smoothScrollTo(container, { top: destination });
  return destination;
}
