import { COMPACT_VIEWPORT_QUERY, viewportBounds } from './viewport';

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
let pageTransition: {
  root: HTMLElement;
  transition: ViewTransition;
  name: string;
  commit: () => void;
  observer: MutationObserver;
  animations: Animation[];
} | null = null;

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
        pageTransition?.transition.skipTransition();
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

export function cancelCompactPageTransition(root: HTMLElement): void {
  if (pageTransition?.root !== root) return;
  const current = pageTransition;
  pageTransition = null;
  current.transition.skipTransition();
  current.observer.disconnect();
  current.animations.forEach(animation => animation.cancel());
  root.style.viewTransitionName = current.name;
  delete document.documentElement.dataset.compactTransition;
}

/** Slide browser snapshots, never live view ancestors that contain fixed-position menus. */
export function transitionCompactPage(root: HTMLElement, update: () => void, direction: 1 | -1): void {
  if (pageTransition) {
    if (pageTransition.root !== root) pageTransition.commit();
    cancelCompactPageTransition(pageTransition.root);
  }
  if (!matchMedia(COMPACT_VIEWPORT_QUERY).matches || reducedMotion()
    || !document.startViewTransition || document.visibilityState === 'hidden') {
    update();
    return;
  }
  const name = root.style.viewTransitionName;
  root.style.viewTransitionName = 'compact-page';
  document.documentElement.dataset.compactTransition = '';
  let committed = false;
  const hiddenBranches = (parent: Element): Element[] => {
    const hidden: Element[] = [];
    for (const child of parent.children) {
      if (getComputedStyle(child).display === 'none') hidden.push(child);
      else hidden.push(...hiddenBranches(child));
    }
    return hidden;
  };
  let uncaptured = hiddenBranches(root);
  const observation: MutationObserverInit = {
    childList: true, subtree: true, attributes: true, attributeOldValue: true,
    attributeFilter: ['hidden', 'inert', 'aria-hidden'],
  };
  const observer = new MutationObserver(records => {
    if (records.some(record => {
      if (!(record.target instanceof Element)) return false;
      if (uncaptured.some(branch => branch.contains(record.target) && getComputedStyle(branch).display === 'none')) return false;
      return record.type === 'childList' || !!record.attributeName
        && record.oldValue !== record.target.getAttribute(record.attributeName);
    })) transition.skipTransition();
  });
  const commit = (): void => {
    if (committed || pageTransition !== current || !root.isConnected) return;
    committed = true;
    observer.disconnect();
    update();
    const previousHidden = uncaptured;
    // Ignore only branches absent from both snapshots; an outgoing private page still needs revocation.
    uncaptured = hiddenBranches(root).flatMap(branch => previousHidden.flatMap(previous =>
      previous.contains(branch) ? [branch] : branch.contains(previous) ? [previous] : []));
    // Permission revocation or newer content must replace a captured page immediately.
    observer.observe(root, observation);
  };
  observer.observe(root, observation);
  const transition = document.startViewTransition(commit);
  const animations: Animation[] = [];
  const current = { root, transition, name, commit, observer, animations };
  pageTransition = current;
  void transition.ready.then(() => {
    if (pageTransition !== current || reducedMotion()) return;
    const options: KeyframeAnimationOptions = {
      duration: motionDuration('step'), easing: 'cubic-bezier(0.2, 0, 0, 1)', fill: 'both',
    };
    current.animations.push(document.documentElement.animate([
      { transform: 'translateX(0)', opacity: 1 },
      { transform: `translateX(${-direction * 25}%)`, opacity: 0 },
    ], { ...options, pseudoElement: '::view-transition-old(compact-page)' }));
    current.animations.push(document.documentElement.animate([
      { transform: `translateX(${direction * 100}%)` }, { transform: 'translateX(0)' },
    ], { ...options, pseudoElement: '::view-transition-new(compact-page)' }));
  }, (error: unknown) => {
    if (!(error instanceof DOMException && error.name === 'AbortError')) {
      console.warn('[Motion] Compact page transition unavailable', error);
    }
  });
  void transition.updateCallbackDone.catch((error: unknown) => { queueMicrotask(() => { throw error; }); });
  const finish = () => {
    observer.disconnect();
    current.animations.forEach(animation => animation.cancel());
    if (pageTransition !== current) return;
    root.style.viewTransitionName = name;
    delete document.documentElement.dataset.compactTransition;
    pageTransition = null;
  };
  void transition.finished.then(finish, finish);
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
  const compact = matchMedia(COMPACT_VIEWPORT_QUERY).matches;
  const sheet = compact && card?.matches('.emoji-picker--compact');
  const duration = motionDuration(sheet ? 'modal' : kind);
  const easing = getComputedStyle(document.documentElement).getPropertyValue('--motion-easing').trim()
    || 'cubic-bezier(0.2, 0, 0, 1)';
  element.dataset.uiMotion = '';
  motion.animations.push(element.animate([{ opacity }, { opacity: leaving ? 0 : 1 }], {
    duration, easing, fill: 'both',
  }));
  if (card) {
    const offset = sheet ? '0 100%' : kind === 'modal' && compact
      ? card.matches('.settings-modal-card') ? '100% 0' : '0 100%'
      : kind === 'panel' ? '10px 0' : kind === 'modal' ? '0 8px' : compact ? '0 16px' : '0 4px';
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
  { gap = 6, margin = 8, maxHeight = 360, matchWidth = true, minimumHeight = 240, alignEnd = false } = {},
): void {
  const rect = anchor.getBoundingClientRect();
  const viewport = viewportBounds();
  const below = Math.max(0, viewport.bottom - rect.bottom - margin - gap);
  const above = Math.max(0, rect.top - viewport.top - margin - gap);
  const opensAbove = below < Math.min(surface.scrollHeight, minimumHeight) && above > below;
  surface.style.maxHeight = `${Math.min(maxHeight, opensAbove ? above : below)}px`;
  if (matchWidth) surface.style.minWidth = `${Math.max(0, Math.min(rect.width, viewport.width - margin * 2))}px`;
  surface.style.maxWidth = `${Math.max(0, viewport.width - margin * 2)}px`;
  const box = surface.getBoundingClientRect();
  const left = alignEnd || getComputedStyle(anchor).direction === 'rtl' ? rect.right - box.width : rect.left;
  surface.style.left = `${Math.max(viewport.left + margin, Math.min(left, viewport.right - box.width - margin))}px`;
  surface.style.top = `${Math.max(viewport.top + margin, opensAbove ? rect.top - gap - box.height : rect.bottom + gap)}px`;
  surface.style.transformOrigin = opensAbove ? 'center bottom' : 'center top';
}
