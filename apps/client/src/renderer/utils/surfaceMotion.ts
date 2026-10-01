export type SurfaceKind = 'modal' | 'popover' | 'panel' | 'notice' | 'view';

interface Motion {
  animations: Animation[];
  finish?: () => void;
  inert: boolean;
  ariaHidden: string | null;
}

const motions = new Map<HTMLElement, Motion>();
const owners = new Map<HTMLElement, HTMLElement>();
// Revocation must also remove portals whose logical owner was released for an exit.
const lastOwners = new WeakMap<HTMLElement, HTMLElement>();
let preference: MediaQueryList | undefined;

export const ACTIVE_MODAL_SELECTOR = '.modal-backdrop:not([data-ui-closing]):not([hidden])';

export function topModal(): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>(ACTIVE_MODAL_SELECTOR)].at(-1) ?? null;
}

export function reducedMotion(): boolean {
  if (!preference) {
    preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    preference.addEventListener('change', () => {
      if (preference?.matches) {
        for (const [element, motion] of [...motions]) settle(element, motion);
      }
    });
  }
  return preference.matches;
}

export function motionDuration(kind: SurfaceKind | 'step'): number {
  const defaults = { modal: 200, popover: 140, panel: 200, notice: 140, view: 200, step: 240 };
  const token = getComputedStyle(document.documentElement).getPropertyValue(`--motion-${kind}-duration`).trim();
  // Production CSS minification can convert milliseconds to seconds.
  const value = Number.parseFloat(token) * (token.endsWith('s') && !token.endsWith('ms') ? 1000 : 1);
  return Number.isFinite(value) ? Math.max(0, value) : defaults[kind];
}

function restore(element: HTMLElement, motion: Motion): void {
  element.inert = motion.inert;
  if (motion.ariaHidden === null) element.removeAttribute('aria-hidden');
  else element.setAttribute('aria-hidden', motion.ariaHidden);
  element.removeAttribute('data-ui-closing');
}

function settle(element: HTMLElement, motion: Motion): void {
  if (motions.get(element) !== motion) return;
  motions.delete(element);
  for (const animation of motion.animations) animation.cancel();
  restore(element, motion);
  motion.finish?.();
}

export function cancelSurfaceMotion(element: HTMLElement): void {
  const previous = motions.get(element);
  if (!previous) return;
  motions.delete(element);
  for (const animation of previous.animations) animation.cancel();
  restore(element, previous);
}

function move(element: HTMLElement, kind: SurfaceKind, leaving: boolean, finish?: () => void): void {
  const previous = motions.get(element);
  const opacity = previous ? getComputedStyle(element).opacity : leaving ? '1' : '0';
  const card = kind === 'view' ? null : kind === 'modal' ? element.querySelector<HTMLElement>(':scope > .modal-card') : element;
  const translation = previous && card ? getComputedStyle(card).translate : null;
  cancelSurfaceMotion(element);
  const motion: Motion = {
    animations: [], finish, inert: element.inert, ariaHidden: element.getAttribute('aria-hidden'),
  };
  if (leaving) {
    element.dataset.uiClosing = '';
    element.inert = true;
    element.setAttribute('aria-hidden', 'true');
  }
  motions.set(element, motion);
  if (reducedMotion() || !element.isConnected || !element.checkVisibility({ checkVisibilityCSS: true })) {
    settle(element, motion);
    return;
  }
  const duration = motionDuration(kind);
  const easing = getComputedStyle(document.documentElement).getPropertyValue('--motion-easing').trim()
    || 'cubic-bezier(0.2, 0, 0, 1)';
  element.dataset.uiMotion = '';
  motion.animations.push(element.animate([{ opacity }, { opacity: leaving ? 0 : 1 }], {
    duration, easing, fill: 'both',
  }));
  if (card) {
    const offset = kind === 'panel' ? '10px 0' : kind === 'modal' ? '0 8px' : '0 4px';
    motion.animations.push(card.animate(
      leaving ? [{ translate: translation ?? '0 0' }, { translate: offset }]
        : [{ translate: translation ?? offset }, { translate: '0 0' }],
      { duration, easing, fill: 'both' },
    ));
  }
  void Promise.all(motion.animations.map(animation => animation.finished)).then(
    () => settle(element, motion),
    () => { if (motions.get(element) === motion) settle(element, motion); },
  );
}

export function animateEnter(element: HTMLElement, kind: SurfaceKind = 'popover'): void {
  const ids = new Set([element.id, ...[...element.querySelectorAll<HTMLElement>('[id]')].map(node => node.id)].filter(Boolean));
  if (ids.size) {
    for (const [closing, motion] of [...motions]) {
      if (closing === element || !closing.hasAttribute('data-ui-closing')) continue;
      if (ids.has(closing.id) || [...closing.querySelectorAll<HTMLElement>('[id]')].some(node => ids.has(node.id))) {
        // A reopened fixed-ID form supersedes its old visual exit, including label/ARIA targets.
        settle(closing, motion);
      }
    }
  }
  move(element, kind, false);
}

export function removeWithMotion(element: HTMLElement, kind: SurfaceKind = 'popover'): void {
  owners.delete(element);
  move(element, kind, true, () => element.remove());
}

export function hideWithMotion(element: HTMLElement, kind: SurfaceKind = 'panel', onHidden?: () => void): void {
  owners.delete(element);
  move(element, kind, true, () => { element.hidden = true; onHidden?.(); });
}

export function showWithMotion(element: HTMLElement, kind: SurfaceKind = 'panel'): void {
  element.hidden = false;
  animateEnter(element, kind);
}

/** A top-layer popup still belongs to its trigger's modal. */
export function ownSurface(surface: HTMLElement, anchor: HTMLElement): () => void {
  owners.set(surface, anchor);
  lastOwners.set(surface, anchor);
  return () => owners.delete(surface);
}

export function ownsSurface(root: HTMLElement, target: Node): boolean {
  return belongsToSurface(root, target, owners);
}

function belongsToSurface(root: HTMLElement, target: Node, ownership: ReadonlyMap<HTMLElement, HTMLElement>): boolean {
  if (root.contains(target)) return true;
  const visited = new Set<HTMLElement>();
  let current: Node = target;
  for (;;) {
    const entry = [...ownership].find(([surface]) => !visited.has(surface) && surface.contains(current));
    if (!entry) return false;
    const [surface, anchor] = entry;
    visited.add(surface);
    if (root.contains(anchor)) return true;
    current = anchor;
  }
}

export function hasOwnedSurface(root: HTMLElement): boolean {
  return [...owners].some(([surface, anchor]) => surface.isConnected
    && !surface.hasAttribute('data-ui-closing') && ownsSurface(root, anchor));
}

export function removeOwnedSurfaces(root: HTMLElement): void {
  const retainedOwners = new Map(owners);
  for (const surface of motions.keys()) {
    const anchor = lastOwners.get(surface);
    if (anchor) retainedOwners.set(surface, anchor);
  }
  const surfaces = [...retainedOwners].filter(([, anchor]) => belongsToSurface(root, anchor, retainedOwners)).map(([surface]) => surface);
  for (const surface of surfaces) {
    owners.delete(surface);
    cancelSurfaceMotion(surface);
    surface.remove();
  }
}

export function positionAnchoredSurface(
  surface: HTMLElement,
  anchor: HTMLElement,
  { gap = 6, margin = 8, maxHeight = 360, matchWidth = true, minimumHeight = 240 } = {},
): void {
  const rect = anchor.getBoundingClientRect();
  const width = document.documentElement.clientWidth;
  const height = document.documentElement.clientHeight;
  const below = Math.max(0, height - rect.bottom - margin - gap);
  const above = Math.max(0, rect.top - margin - gap);
  const opensAbove = below < Math.min(surface.scrollHeight, minimumHeight) && above > below;
  surface.style.maxHeight = `${Math.min(maxHeight, opensAbove ? above : below)}px`;
  if (matchWidth) surface.style.minWidth = `${Math.min(rect.width, width - margin * 2)}px`;
  surface.style.maxWidth = `${Math.max(0, width - margin * 2)}px`;
  const box = surface.getBoundingClientRect();
  const left = getComputedStyle(anchor).direction === 'rtl' ? rect.right - box.width : rect.left;
  surface.style.left = `${Math.max(margin, Math.min(left, width - box.width - margin))}px`;
  surface.style.top = `${Math.max(margin, opensAbove ? rect.top - gap - box.height : rect.bottom + gap)}px`;
  surface.style.transformOrigin = opensAbove ? 'center bottom' : 'center top';
}
