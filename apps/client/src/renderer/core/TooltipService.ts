import '../styles/tooltips.css';

const HOVER_DELAY = 150;
const instances = new WeakMap<Document, () => void>();
let nextId = 0;

interface SuppressedTitle {
  value: string | null;
  descriptor: PropertyDescriptor | undefined;
  observer: MutationObserver;
}

/**
 * Delegated tooltips also cover views mounted after startup. Native title attributes
 * are suppressed only on the hovered/focused ancestry; .title remains a live API.
 * getAttribute('title') is temporarily empty there and is restored on departure.
 * data-tooltip supplies plain text; data-tooltip-source references an existing
 * hidden element by ID, retaining line breaks without copying its HTML.
 */
export function initTooltips(doc: Document = document): () => void {
  const existing = instances.get(doc);
  if (existing) return existing;
  const win = doc.defaultView;
  if (!win) return () => {};

  const tooltip = doc.createElement('div');
  tooltip.className = 'monky-tooltip';
  tooltip.id = `monky-tooltip-${++nextId}`;
  tooltip.setAttribute('role', 'tooltip');
  tooltip.hidden = true;
  const content = doc.createElement('span');
  content.className = 'monky-tooltip__content';
  tooltip.append(content);
  doc.body.append(tooltip);

  const suppressed = new Map<Element, SuppressedTitle>();
  let pointerTarget: Element | null = null;
  let focusTarget: Element | null = null;
  let anchor: Element | null = null;
  let keyboard = false;
  let dismissed = false;
  let timer: number | undefined;
  let disposed = false;

  const sourceTitle = (element: Element): string | null =>
    suppressed.get(element)?.value ?? (suppressed.has(element) ? null : element.getAttribute('title'));

  function textFor(element: Element): string {
    const explicitText = element.getAttribute('data-tooltip');
    if (explicitText !== null) return explicitText;
    const sourceId = element.getAttribute('data-tooltip-source');
    if (sourceId === null) return sourceTitle(element) ?? '';
    const source = doc.getElementById(sourceId);
    if (!source) return '';
    const walker = doc.createTreeWalker(source, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => node instanceof Element && node.matches('script, style')
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    const parts: string[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === Node.TEXT_NODE) parts.push(node.textContent ?? '');
      else if (node instanceof HTMLBRElement) parts.push('\n');
    }
    return parts.join('').replace(/[ \t]*\n[ \t]*/g, '\n').trim();
  }

  function hide(): void {
    win!.clearTimeout(timer);
    timer = undefined;
    tooltip.hidden = true;
    content.textContent = '';
    if (anchor) {
      const ids = (anchor.getAttribute('aria-describedby') ?? '').split(/\s+/)
        .filter((id) => id && id !== tooltip.id);
      if (ids.length) anchor.setAttribute('aria-describedby', ids.join(' '));
      else anchor.removeAttribute('aria-describedby');
    }
  }

  function readPending(element: Element, state: SuppressedTitle): boolean {
    if (!state.observer.takeRecords().length) return false;
    state.value = element.getAttribute('title');
    return true;
  }

  function blankNativeTitle(element: Element, state: SuppressedTitle): void {
    state.observer.disconnect();
    element.setAttribute('title', '');
    state.observer.observe(element, { attributes: true, attributeFilter: ['title'] });
  }

  function suppress(element: Element): void {
    if (suppressed.has(element) || !element.hasAttribute('title')) return;
    const state: SuppressedTitle = {
      value: element.getAttribute('title'),
      descriptor: Object.getOwnPropertyDescriptor(element, 'title'),
      observer: new MutationObserver(() => {
        state.value = element.getAttribute('title');
        blankNativeTitle(element, state);
        refresh();
      }),
    };
    suppressed.set(element, state);
    // Do not replace custom accessors owned by a component, or SVG's animated APIs.
    if (element instanceof HTMLElement && !state.descriptor) {
      Object.defineProperty(element, 'title', {
        configurable: true,
        enumerable: true,
        get: () => {
          if (readPending(element, state)) {
            blankNativeTitle(element, state);
            refresh();
          }
          return state.value ?? '';
        },
        set: (value: string) => {
          readPending(element, state);
          state.value = String(value);
          blankNativeTitle(element, state);
          refresh();
        },
      });
    }
    blankNativeTitle(element, state);
  }

  function restore(element: Element, state: SuppressedTitle): void {
    readPending(element, state);
    state.observer.disconnect();
    if (element instanceof HTMLElement && !state.descriptor) Reflect.deleteProperty(element, 'title');
    if (state.value === null) element.removeAttribute('title');
    else element.setAttribute('title', state.value);
    suppressed.delete(element);
  }

  function syncSuppression(): void {
    const ancestry = new Set<Element>();
    for (let element of [pointerTarget, keyboard ? focusTarget : null]) {
      while (element?.isConnected) {
        ancestry.add(element);
        element = element.parentElement;
      }
    }
    for (const [element, state] of suppressed) {
      if (!ancestry.has(element)) restore(element, state);
    }
    for (const element of ancestry) suppress(element);
  }

  function candidate(target: Element | null): Element | null {
    for (let element = target; element?.isConnected; element = element.parentElement) {
      if (element.hasAttribute('data-tooltip') || element.hasAttribute('data-tooltip-source')
        || sourceTitle(element) !== null) {
        // Empty titles deliberately stop native title inheritance.
        return textFor(element).trim() ? element : null;
      }
    }
    return null;
  }

  function visible(element: Element): boolean {
    if (!element.isConnected || element.closest('[hidden], [inert]')) return false;
    const rect = element.getBoundingClientRect();
    const style = win!.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden'
      && style.visibility !== 'collapse' && rect.bottom > 0 && rect.right > 0
      && rect.top < win!.innerHeight && rect.left < win!.innerWidth;
  }

  function position(): void {
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const margin = 8;
    const gap = 9;
    const width = tooltip.offsetWidth;
    const height = tooltip.offsetHeight;
    const center = rect.left + rect.width / 2;
    const below = rect.top < height + gap + margin;
    const left = Math.max(margin, Math.min(center - width / 2, win!.innerWidth - width - margin));
    const top = below ? rect.bottom + gap : rect.top - height - gap;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${Math.max(margin, Math.min(top, win!.innerHeight - height - margin))}px`;
    tooltip.style.setProperty('--tooltip-pointer-x', `${Math.max(12, Math.min(center - left, width - 12))}px`);
    tooltip.dataset.placement = below ? 'bottom' : 'top';
  }

  function show(): void {
    timer = undefined;
    if (dismissed || !anchor || !visible(anchor) || !textFor(anchor).trim()) return;
    content.textContent = textFor(anchor);
    tooltip.hidden = false;
    const ids = new Set((anchor.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean));
    ids.add(tooltip.id);
    anchor.setAttribute('aria-describedby', [...ids].join(' '));
    position();
  }

  function refresh(): void {
    if (disposed) return;
    if (!pointerTarget?.isConnected) pointerTarget = null;
    if (!focusTarget?.isConnected) focusTarget = null;
    syncSuppression();
    const next = candidate(keyboard ? focusTarget ?? pointerTarget : pointerTarget);
    if (next !== anchor) {
      hide();
      anchor = next;
      if (next && !dismissed) {
        if (keyboard && focusTarget) show();
        else timer = win!.setTimeout(show, HOVER_DELAY);
      }
    } else if (anchor && !tooltip.hidden) {
      if (!visible(anchor) || !textFor(anchor).trim()) hide();
      else {
        if (content.textContent !== textFor(anchor)) content.textContent = textFor(anchor);
        position();
      }
    }
    if (next && !dismissed && tooltip.hidden && keyboard && focusTarget) {
      win!.clearTimeout(timer);
      show();
    } else if (next && !dismissed && tooltip.hidden && timer === undefined) {
      timer = win!.setTimeout(show, HOVER_DELAY);
    }
  }

  function onPointerOver(event: PointerEvent): void {
    if (event.pointerType === 'touch' || !(event.target instanceof Element)) return;
    pointerTarget = event.target;
    keyboard = false;
    dismissed = false;
    refresh();
  }

  function onPointerOut(event: PointerEvent): void {
    if (event.pointerType === 'touch') return;
    pointerTarget = event.relatedTarget instanceof Element ? event.relatedTarget : null;
    if (!pointerTarget) dismiss();
    refresh();
  }

  function onFocusIn(event: FocusEvent): void {
    focusTarget = event.target instanceof Element ? event.target : null;
    dismissed = false;
    refresh();
  }

  function onFocusOut(event: FocusEvent): void {
    focusTarget = event.relatedTarget instanceof Element ? event.relatedTarget : null;
    refresh();
  }

  function dismiss(): void {
    dismissed = true;
    hide();
  }

  function onPointerDown(): void {
    keyboard = false;
    dismiss();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') dismiss();
    else {
      keyboard = true;
      if (event.key === 'Tab') dismissed = false;
    }
  }

  function onBlur(): void {
    dismiss();
    pointerTarget = null;
    focusTarget = null;
    refresh();
  }

  const observer = new MutationObserver((records) => {
    if (records.some((record) => record.target !== tooltip && !tooltip.contains(record.target))) refresh();
  });
  observer.observe(doc.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['title', 'data-tooltip', 'data-tooltip-source', 'hidden', 'class', 'style', 'id'],
  });
  doc.addEventListener('pointerover', onPointerOver, true);
  doc.addEventListener('pointerout', onPointerOut, true);
  doc.addEventListener('pointerdown', onPointerDown, true);
  doc.addEventListener('focusin', onFocusIn, true);
  doc.addEventListener('focusout', onFocusOut, true);
  doc.addEventListener('keydown', onKeyDown, true);
  doc.addEventListener('scroll', dismiss, true);
  doc.addEventListener('visibilitychange', onBlur);
  win.addEventListener('blur', onBlur);
  win.addEventListener('resize', dismiss);

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    hide();
    for (const [element, state] of suppressed) restore(element, state);
    tooltip.remove();
    doc.removeEventListener('pointerover', onPointerOver, true);
    doc.removeEventListener('pointerout', onPointerOut, true);
    doc.removeEventListener('pointerdown', onPointerDown, true);
    doc.removeEventListener('focusin', onFocusIn, true);
    doc.removeEventListener('focusout', onFocusOut, true);
    doc.removeEventListener('keydown', onKeyDown, true);
    doc.removeEventListener('scroll', dismiss, true);
    doc.removeEventListener('visibilitychange', onBlur);
    win.removeEventListener('blur', onBlur);
    win.removeEventListener('resize', dismiss);
    instances.delete(doc);
  };
  instances.set(doc, dispose);
  return dispose;
}

export function disposeTooltips(doc: Document = document): void {
  instances.get(doc)?.();
}
