import { ACTIVE_MODAL_SELECTOR, animateEnter, cancelSurfaceMotion, hasOwnedSurface, hideWithMotion, ownsSurface, removeOwnedSurfaces, removeWithMotion, topModal } from './surfaceMotion';
import { cancelModalStep } from './modalSteps';
import { cancelVisibilityMotion } from './surfaceVisibility';

interface ModalState {
  parent: HTMLElement | null;
  focus: Element | null;
  background: string;
  filter: string;
}

const active = new Map<HTMLElement, ModalState>();
const suspended = new Map<HTMLElement, { inert: boolean; card: HTMLElement | null; hidden: boolean }>();

/** Keep one scrim while a child dialog replaces its parent's card. */
export function enterModal(element: HTMLElement): void {
  const ownCard = element.querySelector<HTMLElement>(':scope > .modal-card');
  if (ownCard) ownCard.dataset.uiMotion = '';
  const parent = [...document.querySelectorAll<HTMLElement>(ACTIVE_MODAL_SELECTOR)]
    .filter(candidate => candidate !== element).at(-1) ?? null;
  active.set(element, {
    parent, focus: document.activeElement, background: element.style.background,
    filter: element.style.backdropFilter,
  });
  if (parent) {
    cancelModalStep(parent);
    cancelSurfaceMotion(parent);
    const card = parent.querySelector<HTMLElement>(':scope > .modal-card');
    if (card) cancelSurfaceMotion(card);
    suspended.set(parent, { inert: parent.inert, card, hidden: card?.hidden ?? false });
    parent.inert = true;
    if (card && !card.hidden) hideWithMotion(card, 'panel');
    element.style.background = 'transparent';
    element.style.backdropFilter = 'none';
  }
  animateEnter(element, 'modal');
}

export function exitModal(element: HTMLElement, immediate = false): void {
  if (element.hasAttribute('data-ui-closing') && !immediate) return;
  cancelModalStep(element);
  element.querySelectorAll<HTMLElement>('[data-ui-motion]').forEach(cancelVisibilityMotion);
  const state = active.get(element);
  active.delete(element);
  // A parent can be closed by an abort/session change before its child.
  for (const [child, childState] of active) {
    if (childState.parent !== element) continue;
    childState.parent = state?.parent ?? null;
    child.style.background = childState.parent ? 'transparent' : childState.background;
    child.style.backdropFilter = childState.parent ? 'none' : childState.filter;
    element.style.background = 'transparent';
    element.style.backdropFilter = 'none';
  }
  suspended.delete(element);
  if (immediate) {
    removeOwnedSurfaces(element);
    cancelSurfaceMotion(element);
    element.remove();
  } else removeWithMotion(element, 'modal');
  const parent = state?.parent;
  const previous = parent ? suspended.get(parent) : undefined;
  if (parent?.isConnected && !parent.hasAttribute('data-ui-closing') && previous
    && ![...active.values()].some(value => value.parent === parent)) {
    suspended.delete(parent);
    parent.inert = previous.inert;
    if (previous.card) {
      previous.card.hidden = previous.hidden;
      if (!previous.hidden) animateEnter(previous.card, 'panel');
    }
  }
  const focus = state?.focus;
  if (focus instanceof HTMLElement && focus.isConnected && !focus.closest('[inert], [hidden], [data-ui-closing]')
    && (!topModal() || ownsSurface(topModal()!, focus))) focus.focus({ preventScroll: true });
}

export function handlesModalKey(element: HTMLElement | null, event: KeyboardEvent): boolean {
  return !!element && !event.defaultPrevented && topModal() === element && !hasOwnedSurface(element);
}
