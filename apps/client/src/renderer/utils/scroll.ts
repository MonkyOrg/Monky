export function scrollWithin(container: HTMLElement, target: HTMLElement, inset = 0): number {
  if (!container.contains(target)) throw new Error('Scroll target must belong to its container');
  const top = container.scrollTop + target.getBoundingClientRect().top
    - container.getBoundingClientRect().top - container.clientTop - inset;
  const destination = Math.max(0, Math.min(top, container.scrollHeight - container.clientHeight));
  container.scrollTo({
    top: destination,
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
  });
  return destination;
}
