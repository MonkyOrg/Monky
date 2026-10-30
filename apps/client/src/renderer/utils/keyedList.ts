import type { SafeHtml } from './html';

export interface KeyedItem {
  /** Names the item across renders; unique within the list. */
  key: string;
  /** Markup of exactly one element. */
  html: string | SafeHtml;
  /**
   * A list inside the item, reconciled the same way once the item is in place:
   * `html` leaves it empty, so a change in there rebuilds only the inner items
   * that changed. `selector` finds the list inside the item; without it, the
   * item itself holds the inner items.
   */
  list?: { selector?: string; items: readonly KeyedItem[] };
}

/** The markup each element was built from, so an unchanged one is recognized. */
const built = new WeakMap<Element, { key: string; html: string }>();

/**
 * Writes keyed items into `container`, rebuilding only the items whose markup changed.
 * Every other item keeps its element, and with it focus, a menu opened from one of its
 * buttons and its loaded images, while items around it come, go or move.
 */
export function renderKeyedList(container: HTMLElement, items: readonly KeyedItem[]): void {
  const current = new Map<string, Element>();
  for (const child of container.children) {
    const item = built.get(child);
    if (item) current.set(item.key, child);
  }
  const next = items.map(({ key, html }) => {
    const markup = String(html);
    const existing = current.get(key);
    if (existing && built.get(existing)?.html === markup) return existing;
    const template = document.createElement('template');
    template.innerHTML = markup;
    const element = template.content.firstElementChild;
    if (!element || template.content.childElementCount !== 1) throw new Error(`List item "${key}" must render one element.`);
    built.set(element, { key, html: markup });
    return element;
  });
  const kept = new Set<Node>(next);
  for (const node of [...container.childNodes]) if (!kept.has(node)) node.remove();
  next.forEach((element, index) => {
    const at = container.children[index] ?? null;
    if (at !== element) container.insertBefore(element, at);
  });
  items.forEach(({ key, list }, index) => {
    if (!list) return;
    const holder = list.selector ? next[index].querySelector(list.selector) : next[index];
    if (!(holder instanceof HTMLElement)) throw new Error(`List item "${key}" has no inner list.`);
    renderKeyedList(holder, list.items);
  });
}
