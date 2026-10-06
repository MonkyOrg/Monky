import { cancelSurfaceMotion, motionDuration, reducedMotion } from './surfaceMotion';

const steps = new Map<HTMLElement, () => void>();
let preference: MediaQueryList | undefined;

export function cancelModalStep(root: HTMLElement): void {
  steps.get(root)?.();
}

/** Retain the real card and outgoing content; no screenshot or cloned focus targets. */
export function replaceModalStep(root: HTMLElement, next: HTMLElement, direction: number): HTMLElement {
  cancelModalStep(root);
  const card = root.querySelector<HTMLElement>(':scope > .modal-card');
  if (!card) { root.replaceChildren(next); return next; }
  cancelSurfaceMotion(root);
  cancelSurfaceMotion(card);
  if (reducedMotion()) {
    card.className = next.className;
    card.style.cssText = next.style.cssText;
    card.replaceChildren(...next.childNodes);
    return card;
  }
  if (!preference) {
    preference = matchMedia('(prefers-reduced-motion: reduce)');
    preference.addEventListener('change', () => {
      if (preference?.matches) for (const finish of [...steps.values()]) finish();
    });
  }
  const height = card.getBoundingClientRect().height;
  const outgoing = document.createElement('div');
  const incoming = document.createElement('div');
  const gap = getComputedStyle(card).gap;
  for (const panel of [outgoing, incoming]) {
    panel.style.cssText = `display:flex;flex-direction:column;gap:${gap};min-height:0;`;
  }
  outgoing.append(...card.childNodes);
  outgoing.inert = true;
  outgoing.dataset.uiClosing = '';
  outgoing.setAttribute('aria-hidden', 'true');
  incoming.append(...next.childNodes);
  card.className = next.className;
  card.style.cssText = next.style.cssText;
  card.dataset.uiMotion = '';
  const style = card.style.cssText;
  card.style.position = 'relative';
  const padding = getComputedStyle(card);
  outgoing.style.position = 'absolute';
  outgoing.style.left = padding.paddingLeft;
  outgoing.style.right = padding.paddingRight;
  outgoing.style.top = padding.paddingTop;
  card.replaceChildren(outgoing, incoming);
  const targetHeight = card.getBoundingClientRect().height;
  card.style.overflow = 'hidden';
  const options = { duration: motionDuration('step'), easing: 'cubic-bezier(0.2, 0, 0, 1)', fill: 'both' as const };
  const offset = direction < 0 ? -20 : 20;
  const animations = [
    outgoing.animate([{ opacity: 1, translate: '0 0' }, { opacity: 0, translate: `${-offset}px 0` }], options),
    incoming.animate([{ opacity: 0, translate: `${offset}px 0` }, { opacity: 1, translate: '0 0' }], options),
    card.animate([{ height: `${height}px` }, { height: `${targetHeight}px` }], options),
  ];
  const finish = () => {
    if (steps.get(root) !== finish) return;
    steps.delete(root);
    for (const animation of animations) animation.cancel();
    outgoing.remove();
    card.style.cssText = style;
    const focused = incoming.contains(document.activeElement) ? document.activeElement : null;
    card.replaceChildren(...incoming.childNodes);
    if (focused instanceof HTMLElement && focused.isConnected) focused.focus({ preventScroll: true });
  };
  steps.set(root, finish);
  void Promise.all(animations.map(animation => animation.finished)).then(finish, finish);
  return incoming;
}
