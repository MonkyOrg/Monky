const CONTROLS = 'button, input, select, textarea, a[href], [tabindex]';

export interface PreserveViewStateOptions {
  /** Element whose scroll offset survives the render; the container itself by default. */
  scroller?: string;
  /**
   * Attributes naming the item a control belongs to (a card, a question). Such a
   * control is only looked for inside that same item, so a list that gained, lost
   * or reordered entries never hands focus to the matching button of a neighbor.
   */
  itemKeys?: readonly string[];
  /** Takes focus when the focused control, or its item, is gone; made focusable if needed. */
  fallback?: () => HTMLElement | null;
  /**
   * While focus is in a surface opened from the container, such as the menu of a
   * card's ⋯ button, that opener stands for the focus. If the render replaces the
   * opener, focus lands on its replacement or on the fallback (the surface must be
   * closed by the render); if the opener stays, focus stays in the surface.
   */
  origin?: HTMLElement | null;
}

interface FocusedControl {
  element: HTMLElement;
  /** Captured from `origin`: focus is in the surface it opened, not on the element itself. */
  opener: boolean;
  /** Selector of the item holding the control; null when it belongs to the container itself. */
  item: string | null;
  selector: string;
  index: number;
  selection: [number, number, 'forward' | 'backward' | 'none'] | null;
}

function describe(element: HTMLElement): string {
  return element.id ? `#${CSS.escape(element.id)}` : element.tagName.toLowerCase() + [...element.attributes]
    .filter(attribute => attribute.name === 'name' || attribute.name.startsWith('data-'))
    .map(attribute => `[${attribute.name}="${CSS.escape(attribute.value)}"]`).join('');
}

/** Describes the focused control so the same one, in the same item, can be found in rebuilt markup. */
function captureFocus(container: HTMLElement, itemKeys: readonly string[], origin?: HTMLElement | null): FocusedControl | null {
  const opener = !!origin && container.contains(origin);
  const active = opener ? origin : document.activeElement;
  if (!(active instanceof HTMLElement) || active === container || !container.contains(active)) return null;
  const holder = itemKeys.length
    ? active.parentElement?.closest<HTMLElement>(itemKeys.map(key => `[${key}]`).join(', ')) : null;
  const itemElement = holder && holder !== container && container.contains(holder) ? holder : null;
  const key = itemElement ? itemKeys.find(name => itemElement.hasAttribute(name)) : undefined;
  const item = itemElement && key ? `[${key}="${CSS.escape(itemElement.getAttribute(key) ?? '')}"]` : null;
  const selector = describe(active);
  const index = [...(itemElement ?? container).querySelectorAll(selector)].indexOf(active);
  const text = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active : null;
  // Inputs without a caret (number, checkbox…) report null here instead of throwing.
  const selection: FocusedControl['selection'] = text && text.selectionStart !== null && text.selectionEnd !== null
    ? [text.selectionStart, text.selectionEnd, text.selectionDirection ?? 'none'] : null;
  return index < 0 ? null : { element: active, opener, item, selector, index, selection };
}

function restoreFocus(container: HTMLElement, focused: FocusedControl, fallback?: () => HTMLElement | null): void {
  // Markup the render left alone keeps its control, focus and caret; an opener left
  // in place keeps focus in the surface it opened.
  if (focused.element.isConnected && container.contains(focused.element)) {
    if (!focused.opener && document.activeElement !== focused.element) focused.element.focus({ preventScroll: true });
    return;
  }
  const scope = focused.item ? container.querySelector<HTMLElement>(focused.item) : container;
  const target = scope?.querySelectorAll<HTMLElement>(focused.selector)[focused.index];
  if (target?.matches(CONTROLS) && !target.matches(':disabled')) {
    target.focus({ preventScroll: true });
    if (focused.selection && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
      try { target.setSelectionRange(...focused.selection); } catch { /* the rebuilt input has no caret */ }
    }
    return;
  }
  // The control or its item is gone: a neutral place, never the same button of another
  // item, where Enter would act on something the reader did not choose.
  const neutral = fallback?.();
  if (!neutral) return;
  if (!neutral.matches(CONTROLS)) neutral.tabIndex = -1;
  neutral.focus({ preventScroll: true });
}

/**
 * Rebuilds `container` without losing the reader's place: the focused control
 * (with its caret) and the scroll offset of `scroller` survive the new markup.
 * Restoring the exact offset is instantaneous on purpose — nothing moved.
 */
export function preserveViewState(container: HTMLElement, render: () => void, options: PreserveViewStateOptions = {}): void {
  const scroller = () => options.scroller ? container.querySelector<HTMLElement>(options.scroller) : container;
  const scrollTop = scroller()?.scrollTop ?? 0;
  const focused = captureFocus(container, options.itemKeys ?? [], options.origin);
  render();
  const next = scroller();
  if (next && scrollTop) next.scrollTop = scrollTop;
  if (focused) restoreFocus(container, focused, options.fallback);
}
