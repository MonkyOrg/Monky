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

export function motionDuration(kind: SurfaceKind | 'step' | 'sheet'): number {
  const defaults = { modal: 200, popover: 140, panel: 200, notice: 140, view: 200, step: 240, sheet: 320 };
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
  const layoutRows = previous && card?.matches('.voice-channel-chat-panel') && card.parentElement
    ? getComputedStyle(card.parentElement).gridTemplateRows : null;
  // Where the stage cards are seen now, mid-flight included, before the chat moves them.
  const stageCards = card?.matches('.voice-channel-chat-panel') && card.parentElement
    ? [...card.parentElement.querySelectorAll<HTMLElement>('.voice-stage-container .stage-card')]
      .map(tile => ({ tile, from: tile.getBoundingClientRect() })) : [];
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
  // On a phone held upright the call chat opens under the stage: the stage band
  // shrinks from the whole screen as the chat rises with it, and grows back on close.
  const stageLayout = compact && card?.matches('.voice-channel-chat-panel') ? card.parentElement : null;
  const underStage = stageLayout && (leaving ? stageLayout.matches('[data-compact-chat-below]')
    : stageLayout.matches('[data-compact-panel="content"]:not([data-compact-split])')
      && !!stageLayout.querySelector('.voice-stage-container')) ? stageLayout : null;
  const duration = motionDuration(underStage ? 'sheet' : sheet ? 'modal' : kind);
  const easing = getComputedStyle(document.documentElement).getPropertyValue('--motion-easing').trim()
    || 'cubic-bezier(0.2, 0, 0, 1)';
  element.dataset.uiMotion = '';
  motion.animations.push(element.animate([{ opacity }, { opacity: leaving ? 0 : 1 }], {
    duration, easing, fill: 'both',
  }));
  if (underStage) {
    // The open end is the layout's live rows, set once the shell sees the chat.
    const wholeScreen = { gridTemplateRows: '100% minmax(0, 1fr) auto' };
    const from = layoutRows ? { gridTemplateRows: layoutRows } : null;
    const rows = underStage.animate(leaving ? from ? [from, wholeScreen] : [wholeScreen]
      : [{ ...from ?? wholeScreen, offset: 0 }], { duration, easing, fill: 'both' });
    motion.animations.push(rows);
    // The shell settles the chat's layout before this frame paints.
    requestAnimationFrame(() => {
      if (motions.get(element) === motion) followStage(underStage, stageCards, rows, motion.animations, duration);
    });
  } else if (card) {
    const popoverOffset = kind === 'popover' ? Math.max(0, Math.min(compact ? 16 : 4,
      viewportBounds().bottom - card.getBoundingClientRect().bottom - 8)) : compact ? 16 : 4;
    const offset = sheet ? '0 100%' : kind === 'modal' && compact
      ? card.matches('.settings-modal-card') ? '100% 0' : '0 100%'
      : kind === 'panel' ? '10px 0' : kind === 'modal' ? '0 8px' : `0 ${popoverOffset}px`;
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

/**
 * The stage cards trade a grid for a row above the call chat. Each card travels from
 * where it was seen to its new place at the pace of the stage band, sampled from the
 * band's own animation, so cards and band never part ways.
 */
function followStage(
  layout: HTMLElement, cards: { tile: HTMLElement; from: DOMRect }[], rows: Animation, animations: Animation[], duration: number,
): void {
  const stage = layout.querySelector<HTMLElement>('.voice-stage-container');
  const tiles = cards.filter(({ tile, from }) => tile.isConnected && from.width > 0 && from.height > 0);
  const now = rows.currentTime;
  if (!stage || !tiles.length || typeof now !== 'number') return;
  const steps = 12;
  const samples = Array.from({ length: steps + 1 }, (_, index) => {
    rows.currentTime = duration * index / steps;
    return { band: stage.getBoundingClientRect().height, rects: tiles.map(({ tile }) => tile.getBoundingClientRect()) };
  });
  rows.currentTime = now;
  const start = samples[0].band;
  const end = samples[steps].band;
  tiles.forEach(({ tile, from }, card) => {
    const to = samples[steps].rects[card];
    if (to.width <= 0 || to.height <= 0) return;
    const keyframes = samples.map((sample, index) => {
      const progress = end === start ? index / steps : (sample.band - start) / (end - start);
      const at = sample.rects[card];
      const left = from.left + (to.left - from.left) * progress;
      const top = from.top + (to.top - from.top) * progress;
      const width = from.width + (to.width - from.width) * progress;
      const height = from.height + (to.height - from.height) * progress;
      return {
        offset: index / steps,
        transformOrigin: '0 0',
        transform: `translate(${left - at.left}px, ${top - at.top}px) scale(${width / Math.max(1, at.width)}, ${height / Math.max(1, at.height)})`,
      };
    });
    const animation = tile.animate(keyframes, { duration, fill: 'both' });
    animation.currentTime = now;
    animations.push(animation);
  });
}

let stageBand: { layout: HTMLElement; animations: Animation[] } | null = null;

function stopStageBand(): void {
  if (!stageBand) return;
  const { layout, animations } = stageBand;
  stageBand = null;
  animations.forEach(animation => animation.cancel());
  layout.style.removeProperty('grid-template-rows');
}

/**
 * The tallest the band may start while the call chat below still holds its header
 * and composer. Squeezed past them the composer drops off the screen, and Safari
 * scrolls the whole page after the caret until the band settles.
 */
function stageBandStart(layout: HTMLElement, top: number): number {
  const end = parseFloat(getComputedStyle(layout).gridTemplateRows);
  const feed = layout.querySelector<HTMLElement>(':scope > .voice-channel-chat-panel .chat-messages-feed');
  if (!feed || !Number.isFinite(end)) return top;
  const style = getComputedStyle(feed);
  const room = feed.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  return Math.min(top, end + Math.max(0, room));
}

/**
 * Typing shrinks the stage band above the call chat. The band eases to its new
 * height with the keyboard instead of jumping ahead of it, which would throw the
 * chat up before the keyboard arrives; closing the keyboard grows it back the same way.
 */
export function animateStageBand(update: () => void): void {
  const layout = document.querySelector<HTMLElement>('.main-layout[data-compact-chat-below]');
  const animate = !!layout && !reducedMotion() && layout.checkVisibility({ checkVisibilityCSS: true });
  const top = animate ? parseFloat(getComputedStyle(layout).gridTemplateRows) : NaN;
  const stageCards = animate
    ? [...layout.querySelectorAll<HTMLElement>('.voice-stage-container .stage-card')]
      .map(tile => ({ tile, from: tile.getBoundingClientRect() })) : [];
  stopStageBand();
  update();
  if (!layout || !Number.isFinite(top) || !layout.matches('[data-compact-chat-below]')) return;
  const from = `${stageBandStart(layout, top)}px minmax(0, 1fr) auto`;
  const duration = motionDuration('sheet');
  const easing = getComputedStyle(document.documentElement).getPropertyValue('--motion-easing').trim()
    || 'cubic-bezier(0.2, 0, 0, 1)';
  const animations: Animation[] = [];
  const rows = layout.animate([{ gridTemplateRows: from, offset: 0 }], { duration, easing });
  animations.push(rows);
  followStage(layout, stageCards, rows, animations, duration);
  const band = { layout, animations };
  stageBand = band;
  // WebKit applies a new animation only from the frame after it is ready: hold
  // the start meanwhile, or the chat flashes at its final place first.
  layout.style.gridTemplateRows = from;
  void rows.ready.then(() => requestAnimationFrame(() => requestAnimationFrame(() => {
    if (stageBand === band) layout.style.removeProperty('grid-template-rows');
  })), () => {});
  void rows.finished.then(() => {
    if (stageBand === band) stopStageBand();
  }, () => {});
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
