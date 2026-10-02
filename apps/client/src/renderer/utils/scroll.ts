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

export function scrollWithin(container: HTMLElement, target: HTMLElement, inset = 0): number {
  if (!container.contains(target)) throw new Error('Scroll target must belong to its container');
  const top = container.scrollTop + target.getBoundingClientRect().top
    - container.getBoundingClientRect().top - container.clientTop - inset;
  const destination = Math.max(0, Math.min(top, container.scrollHeight - container.clientHeight));
  smoothScrollTo(container, { top: destination });
  return destination;
}
