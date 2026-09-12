interface MotionRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface MotionItem {
  key: string | null;
  element: HTMLElement;
  rect: DOMRect;
  clip: MotionRect;
  opacity: number;
  display: string;
  font: string;
}

export type FavoriteMotionKind = 'reorder' | 'filter';

export function favoriteMotionOffset(
  before: Pick<MotionRect, 'left' | 'top'>,
  after: Pick<MotionRect, 'left' | 'top'>,
  focus?: { rect: MotionRect; clip: MotionRect }
): { x: number; y: number } {
  let x = before.left - after.left;
  let y = before.top - after.top;
  if (focus) {
    x = Math.max(focus.clip.left - focus.rect.left, Math.min(x, focus.clip.right - focus.rect.right));
    y = Math.max(focus.clip.top - focus.rect.top, Math.min(y, focus.clip.bottom - focus.rect.bottom));
  }
  return { x, y };
}

function intersect(a: MotionRect, b: MotionRect): MotionRect {
  return {
    left: Math.max(a.left, b.left), top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom),
  };
}

function visible(rect: MotionRect, clip: MotionRect): boolean {
  const overlap = intersect(rect, clip);
  return overlap.right > overlap.left && overlap.bottom > overlap.top;
}

export class FavoriteListMotion {
  private readonly animations = new Set<Animation>();
  private ghosts: MotionItem[] = [];
  private layer: HTMLElement | null = null;
  private root: HTMLElement | null = null;
  private unwatch: (() => void) | null = null;
  private generation = 0;

  public update(root: HTMLElement, selector: string, change: () => void, kind: FavoriteMotionKind | false = 'reorder'): void {
    const reduced = kind ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    const continuing = this.root === root && this.animations.size > 0;
    const before = reduced && !reduced.matches ? this.measure(root, selector) : [];
    if (before.length && this.root === root) {
      for (const ghost of this.ghosts) {
        before.push({
          ...ghost, rect: ghost.element.getBoundingClientRect(),
          opacity: Number(getComputedStyle(ghost.element).opacity),
        });
      }
    }
    // Read the current visual positions before cancelling an interrupted FLIP.
    this.cancel();
    change();
    if (!reduced || reduced.matches || !root.isConnected || !before.length) return;

    const after = this.measure(root, selector);
    const previous = new Map<string | null, MotionItem[]>();
    for (const item of before) {
      const entries = previous.get(item.key) ?? [];
      entries.push(item);
      previous.set(item.key, entries);
    }
    this.root = root;
    const targets = new Set<HTMLElement>();
    for (const item of after) {
      const old = previous.get(item.key)?.shift();
      if (!visible(item.rect, item.clip) && (!old || !visible(old.rect, item.clip))) continue;
      const focused = document.activeElement;
      const focus = focused instanceof HTMLElement && item.element.contains(focused)
        ? { rect: focused.getBoundingClientRect(), clip: item.clip } : undefined;
      const origin = old?.rect ?? { left: item.rect.left, top: item.rect.top + 8 };
      const filterEntrance = kind === 'filter' && !continuing && old;
      const delta = favoriteMotionOffset(filterEntrance
        ? { left: origin.left, top: origin.top + 4 } : origin, item.rect, focus);
      const opacity = old ? old.opacity * (filterEntrance ? 0.7 : 1) : 0;
      if (Math.abs(delta.x) < 0.5 && Math.abs(delta.y) < 0.5 && Math.abs(opacity - item.opacity) < 0.01) continue;
      targets.add(item.element);
      this.play(item.element, [
        { translate: `${delta.x}px ${delta.y}px`, opacity },
        { translate: '0px 0px', opacity: item.opacity },
      ], old ? 'move' : 'enter', 240);
    }
    const bounds = root.getBoundingClientRect();
    for (const entries of previous.values()) {
      for (const item of entries) this.leave(item, intersect(item.clip, bounds), root);
    }
    if (this.animations.size) this.watch(root, targets, reduced);
    else this.cancel();
  }

  public cancel(): void {
    this.generation++;
    this.unwatch?.();
    this.unwatch = null;
    for (const animation of this.animations) {
      animation.onfinish = null;
      animation.oncancel = null;
      animation.cancel();
    }
    this.animations.clear();
    this.ghosts = [];
    this.layer?.remove();
    this.layer = null;
    this.root = null;
  }

  private measure(root: HTMLElement, selector: string): MotionItem[] {
    const viewport = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
    const bounds = root.getBoundingClientRect();
    const clips = new Map<HTMLElement, MotionRect>();
    const clipFor = (element: HTMLElement | null): MotionRect => {
      if (!element) return viewport;
      const cached = clips.get(element);
      if (cached) return cached;
      const clip = { ...clipFor(element.parentElement) };
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (style.overflowX !== 'visible') {
        clip.left = Math.max(clip.left, rect.left + element.clientLeft);
        clip.right = Math.min(clip.right, rect.left + element.clientLeft + element.clientWidth);
      }
      if (style.overflowY !== 'visible') {
        clip.top = Math.max(clip.top, rect.top + element.clientTop);
        clip.bottom = Math.min(clip.bottom, rect.top + element.clientTop + element.clientHeight);
      }
      clips.set(element, clip);
      return clip;
    };
    const items: MotionItem[] = [];
    const add = (element: HTMLElement, key: string | null) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (!rect.width || !rect.height || style.visibility === 'hidden') return;
      items.push({
        key, element, rect, clip: intersect(clipFor(element.parentElement), bounds),
        opacity: Number(style.opacity), display: style.display, font: style.font,
      });
    };
    for (const element of root.querySelectorAll<HTMLElement>(selector)) {
      const key = element.querySelector<HTMLButtonElement>('.favorite-toggle')?.dataset.favoriteKey;
      if (!key) throw new Error('Favorite list item is missing its stable identity');
      add(element, key);
    }
    if (!items.length) {
      const empty = root.querySelector<HTMLElement>('.favorites-empty, .favorite-motion-empty');
      if (empty) add(empty, null);
    }
    return items;
  }

  private play(element: HTMLElement, frames: Keyframe[], kind: string, duration: number, done?: () => void): void {
    const animation = element.animate(frames, {
      duration, easing: 'cubic-bezier(0.2, 0, 0, 1)', fill: 'both',
    });
    animation.id = `favorite-list-${kind}`;
    this.animations.add(animation);
    const finish = () => {
      if (!this.animations.delete(animation)) return;
      animation.onfinish = null;
      animation.oncancel = null;
      animation.cancel();
      done?.();
      if (!this.animations.size) this.cancel();
    };
    animation.onfinish = finish;
    animation.oncancel = finish;
  }

  private leave(item: MotionItem, clip: MotionRect, root: HTMLElement): void {
    if (!visible(item.rect, clip) || item.opacity < 0.01) return;
    if (!this.layer) {
      this.layer = document.createElement('div');
      this.layer.dataset.favoriteMotionLayer = '';
      this.layer.setAttribute('aria-hidden', 'true');
      this.layer.inert = true;
      Object.assign(this.layer.style, {
        position: 'fixed', inset: '0', pointerEvents: 'none', contain: 'strict', zIndex: '1',
      });
      // Stay in the modal's stacking context, outside the live list and its selectors.
      (root.closest('.modal-backdrop') ?? document.body).append(this.layer);
    }
    const frame = document.createElement('div');
    Object.assign(frame.style, {
      position: 'absolute', overflow: 'hidden',
      left: `${clip.left}px`, top: `${clip.top}px`,
      width: `${clip.right - clip.left}px`, height: `${clip.bottom - clip.top}px`,
    });
    const ghost = item.element.cloneNode(true);
    if (!(ghost instanceof HTMLElement)) throw new Error('Favorite motion requires HTML items');
    ghost.removeAttribute('id');
    ghost.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'));
    ghost.querySelectorAll('.favorite-toggle').forEach(element => {
      element.classList.replace('favorite-toggle', 'favorite-motion-toggle');
    });
    Object.assign(ghost.style, {
      position: 'absolute', margin: '0', boxSizing: 'border-box',
      left: `${item.rect.left - clip.left}px`, top: `${item.rect.top - clip.top}px`,
      width: `${item.rect.width}px`, height: `${item.rect.height}px`,
      display: item.display, font: item.font, translate: 'none', transform: 'none', transition: 'none',
    });
    frame.append(ghost);
    this.layer.append(frame);
    const snapshot = { ...item, element: ghost, clip };
    this.ghosts.push(snapshot);
    this.play(ghost, [{ opacity: item.opacity, translate: '0px 0px' }, { opacity: 0, translate: '0px -6px' }], 'exit', 160, () => {
      frame.remove();
      this.ghosts = this.ghosts.filter(entry => entry !== snapshot);
    });
  }

  private watch(root: HTMLElement, targets: Set<HTMLElement>, reduced: MediaQueryList): void {
    const generation = this.generation;
    const bounds = root.getBoundingClientRect();
    const geometry = new Map(Array.from(targets, element => [element, {
      left: element.offsetLeft, top: element.offsetTop, width: element.offsetWidth, height: element.offsetHeight,
    }]));
    const scroll = new Map<HTMLElement, { left: number; top: number }>();
    for (const target of [root, ...targets]) {
      for (let element: HTMLElement | null = target; element; element = element.parentElement) {
        if (scroll.has(element)) break;
        scroll.set(element, { left: element.scrollLeft, top: element.scrollTop });
      }
    }
    const stopIfChanged = () => {
      if (generation !== this.generation) return;
      const rect = root.getBoundingClientRect();
      if (!root.isConnected || !root.checkVisibility({ checkVisibilityCSS: true }) || reduced.matches
        || Math.abs(rect.left - bounds.left) > 0.5 || Math.abs(rect.top - bounds.top) > 0.5
        || Math.abs(rect.width - bounds.width) > 0.5 || Math.abs(rect.height - bounds.height) > 0.5
        || Array.from(geometry).some(([element, old]) => !root.contains(element)
          || element.offsetLeft !== old.left || element.offsetTop !== old.top
          || element.offsetWidth !== old.width || element.offsetHeight !== old.height)
        || Array.from(scroll).some(([element, old]) => element.scrollLeft !== old.left || element.scrollTop !== old.top)) {
        this.cancel();
      }
    };
    const mutations = new MutationObserver(stopIfChanged);
    mutations.observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'],
    });
    const resize = new ResizeObserver(stopIfChanged);
    resize.observe(root);
    targets.forEach(element => resize.observe(element));
    document.addEventListener('scroll', stopIfChanged, true);
    window.addEventListener('resize', stopIfChanged);
    reduced.addEventListener('change', stopIfChanged);
    this.unwatch = () => {
      mutations.disconnect();
      resize.disconnect();
      document.removeEventListener('scroll', stopIfChanged, true);
      window.removeEventListener('resize', stopIfChanged);
      reduced.removeEventListener('change', stopIfChanged);
    };
  }
}
