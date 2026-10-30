import { cancelSurfaceMotion, motionDuration, reducedMotion } from './surfaceMotion';
import { cancelVisibilityMotion } from './surfaceVisibility';

/** Step changes still moving, by the element whose content they replace: a modal's root or a wizard's viewport. */
const steps = new Map<HTMLElement, () => void>();
let preference: MediaQueryList | undefined;

/** Turning on reduced motion lands every step change still moving. */
function settleOnReducedMotion(): void {
  if (preference) return;
  preference = matchMedia('(prefers-reduced-motion: reduce)');
  preference.addEventListener('change', () => {
    if (preference?.matches) for (const finish of [...steps.values()]) finish();
  });
}

/** Lands the step change of `root`, and of any wizard inside it, in its final state. */
export function cancelModalStep(root: HTMLElement): void {
  for (const [element, finish] of [...steps]) {
    if (element === root || root.contains(element)) finish();
  }
}

/**
 * Retain the real card and outgoing content; no screenshot or cloned focus targets.
 * `direction` 0 fills a card that is still entering, without a step of its own.
 */
export function replaceModalStep(root: HTMLElement, next: HTMLElement, direction: number): HTMLElement {
  cancelModalStep(root);
  const card = root.querySelector<HTMLElement>(':scope > .modal-card');
  if (!card) { root.replaceChildren(next); return next; }
  const fill = (): HTMLElement => {
    card.className = next.className;
    card.style.cssText = next.style.cssText;
    card.replaceChildren(...next.childNodes);
    return card;
  };
  // The modal's own entrance is the only motion while it opens.
  if (direction === 0) return fill();
  cancelSurfaceMotion(root);
  cancelSurfaceMotion(card);
  if (reducedMotion()) return fill();
  settleOnReducedMotion();
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

/**
 * Moves a wizard to another step inside its viewport, which stays in place with
 * the stepper and the footer around it (#490). The current step leaves toward
 * where the wizard came from while `next` comes in from the other side, from its
 * top. `direction` 0 draws the same step again, without motion. Returns when the
 * new step lands, or null when it was swapped in at once.
 */
export function slideStepContent(viewport: HTMLElement, next: HTMLElement, direction: number): Promise<void> | null {
  cancelModalStep(viewport);
  const leaving = [...viewport.children].filter((child): child is HTMLElement => child instanceof HTMLElement);
  for (const element of leaving) element.querySelectorAll<HTMLElement>('[data-ui-motion]').forEach(cancelVisibilityMotion);
  if (direction === 0 || !leaving.length || reducedMotion() || !viewport.checkVisibility()) {
    viewport.replaceChildren(next);
    if (direction !== 0) viewport.scrollTop = 0;
    return null;
  }
  settleOnReducedMotion();
  const scrolled = viewport.scrollTop;
  const box = getComputedStyle(viewport);
  const style = viewport.style.cssText;
  if (box.position === 'static') viewport.style.position = 'relative';
  viewport.replaceChildren(next, ...leaving);
  // The new step starts from its top, while the one leaving stays where it was on screen, out of the flow.
  viewport.scrollTop = 0;
  for (const element of leaving) {
    element.inert = true;
    element.dataset.uiClosing = '';
    element.setAttribute('aria-hidden', 'true');
    element.style.position = 'absolute';
    element.style.top = `${parseFloat(box.paddingTop) - scrolled}px`;
    element.style.left = box.paddingLeft;
    element.style.right = box.paddingRight;
  }
  const options: KeyframeAnimationOptions = { duration: motionDuration('step'), easing: 'cubic-bezier(0.2, 0, 0, 1)', fill: 'both' };
  const offset = direction > 0 ? 100 : -100;
  const animations = [
    next.animate([{ transform: `translateX(${offset}%)`, opacity: 0 }, { transform: 'translateX(0)', opacity: 1 }], options),
    ...leaving.map(element => element.animate(
      [{ transform: 'translateX(0)', opacity: 1 }, { transform: `translateX(${-offset}%)`, opacity: 0 }], options)),
  ];
  return new Promise(resolve => {
    const finish = () => {
      if (steps.get(viewport) !== finish) return;
      steps.delete(viewport);
      for (const animation of animations) animation.cancel();
      for (const element of leaving) element.remove();
      viewport.style.cssText = style;
      resolve();
    };
    steps.set(viewport, finish);
    void Promise.all(animations.map(animation => animation.finished)).then(finish, finish);
  });
}
