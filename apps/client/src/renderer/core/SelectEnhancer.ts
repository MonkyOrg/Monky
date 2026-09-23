const OPEN_ATTRIBUTES = ['aria-expanded', 'aria-controls', 'aria-activedescendant'] as const;

interface OptionRow {
  option: HTMLOptionElement;
  element: HTMLDivElement;
}

/** Keep the native control as the source of truth; only its popup is custom. */
export class SelectEnhancer {
  private listeners: AbortController | null = null;
  private select: HTMLSelectElement | null = null;
  private popup: HTMLDivElement | null = null;
  private rows: OptionRow[] = [];
  private active: HTMLOptionElement | null = null;
  private savedAttributes = new Map<string, string | null>();
  private optionObserver: MutationObserver | null = null;
  private documentObserver: MutationObserver | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private search = '';
  private searchTime = 0;
  private sequence = 0;

  public init(): void {
    if (this.listeners) return;
    this.listeners = new AbortController();
    const options = { capture: true, signal: this.listeners.signal };
    document.addEventListener('pointerdown', this.onPointerDown, options);
    document.addEventListener('mousedown', this.onMouseDown, options);
    document.addEventListener('click', this.onClick, options);
    document.addEventListener('keydown', this.onKeyDown, options);
    document.addEventListener('focusin', this.onFocusIn, options);
    document.addEventListener('input', this.onNativeChange, options);
    document.addEventListener('change', this.onNativeChange, options);
    document.addEventListener('reset', this.onReset, options);
    document.addEventListener('scroll', this.onScroll, options);
    window.addEventListener('resize', this.position, options);
    window.addEventListener('blur', this.onWindowBlur, options);
  }

  public dispose(): void {
    this.close();
    this.listeners?.abort();
    this.listeners = null;
  }

  private eligible(target: EventTarget | null): target is HTMLSelectElement {
    // Multi-select and visible list controls keep their native selection semantics.
    return target instanceof HTMLSelectElement && !target.multiple && target.size <= 1
      && !target.matches(':disabled') && !target.closest('[inert]')
      && target.checkVisibility({ checkVisibilityCSS: true });
  }

  private available(option: HTMLOptionElement): boolean {
    return !option.disabled && !(option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled);
  }

  private visible(option: HTMLOptionElement): boolean {
    return !option.hidden && !option.parentElement?.hidden
      && getComputedStyle(option).display !== 'none'
      && (!option.parentElement || getComputedStyle(option.parentElement).display !== 'none');
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) {
      if (!this.popup?.contains(event.target as Node)) this.close();
      return;
    }
    if (this.eligible(event.target)) {
      event.preventDefault();
      event.target.focus({ preventScroll: true });
      if (this.select === event.target) this.close();
      else this.open(event.target);
    } else if (event.target instanceof Node && this.popup?.contains(event.target)) {
      event.preventDefault(); // Keep focus (and active descendant) on the select.
      event.stopImmediatePropagation();
    } else {
      this.close();
    }
  };

  private onMouseDown = (event: MouseEvent): void => {
    // Chromium's OS picker is a mousedown default action, not a click action.
    if (event.button === 0 && this.eligible(event.target)) event.preventDefault();
  };

  private onClick = (event: MouseEvent): void => {
    if (this.eligible(event.target)) {
      event.preventDefault();
      // Assistive technology and associated labels can activate without pointerdown.
      if (event.detail === 0 && !this.select) this.open(event.target);
      return;
    }
    if (!(event.target instanceof Element) || !this.popup?.contains(event.target)) return;
    const row = this.rows.find(({ element }) => element.contains(event.target as Node));
    if (row) {
      event.preventDefault();
      event.stopPropagation();
      this.commit(row.option);
    }
  };

  private onFocusIn = (event: FocusEvent): void => {
    if (this.select && event.target !== this.select && !(event.target instanceof Node && this.popup?.contains(event.target))) {
      this.close();
    }
  };

  private onWindowBlur = (): void => { this.close(); };

  private onNativeChange = (event: Event): void => {
    if (event.target === this.select) {
      this.active = null;
      this.render();
    }
  };

  private onReset = (event: Event): void => {
    if (this.select?.form === event.target) queueMicrotask(() => {
      this.active = null;
      this.render();
    });
  };

  private onScroll = (event: Event): void => {
    if (event.target instanceof Node && this.popup?.contains(event.target)) return;
    this.position();
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (!this.eligible(event.target) || event.isComposing) return;
    const select = event.target;
    const key = event.key;
    if (Date.now() - this.searchTime > 700) this.search = '';
    if (key === 'Tab') {
      this.close();
      return;
    }
    if (key === 'Escape') {
      if (!this.select) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.close();
      return;
    }
    if (event.ctrlKey || event.metaKey || (event.altKey && key !== 'ArrowDown' && key !== 'ArrowUp')) return;
    const printable = key.length === 1 && key !== ' ';
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' ', 'F4', 'PageDown', 'PageUp'].includes(key) && !printable) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const wasOpen = this.select === select;
    if (!wasOpen) this.open(select);
    if (!this.popup) return;
    if (wasOpen && (key === 'Enter' || (key === ' ' && !this.search) || (event.altKey && key === 'ArrowUp') || key === 'F4')) {
      if (this.active) this.commit(this.active);
      else this.close();
      return;
    }
    const enabled = this.rows.filter(({ option }) => this.available(option));
    if (!enabled.length) return;
    const current = enabled.findIndex(({ option }) => option === this.active);
    let next = current;
    if (key === 'Home') next = 0;
    else if (key === 'End') next = enabled.length - 1;
    else if (event.altKey && key === 'ArrowDown') return;
    else if (key === 'ArrowDown' || key === 'ArrowRight') next = Math.min(current + 1, enabled.length - 1);
    else if (key === 'ArrowUp' || key === 'ArrowLeft') next = Math.max(current - 1, 0);
    else if (key === 'PageDown') next = Math.min(current + 8, enabled.length - 1);
    else if (key === 'PageUp') next = Math.max(current - 8, 0);
    else if (printable || key === ' ') {
      const now = Date.now();
      this.search = now - this.searchTime > 700 ? key : this.search + key;
      this.searchTime = now;
      const repeated = [...this.search].every(char => char.toLocaleLowerCase() === key.toLocaleLowerCase());
      const term = (repeated ? key : this.search).toLocaleLowerCase();
      const start = repeated ? current + 1 : Math.max(current, 0);
      for (let offset = 0; offset < enabled.length; offset++) {
        const index = (start + offset) % enabled.length;
        if (enabled[index].option.label.trim().toLocaleLowerCase().startsWith(term)) {
          next = index;
          break;
        }
      }
    }
    if (next >= 0) this.setActive(enabled[next].option);
  };

  private open(select: HTMLSelectElement): void {
    this.close();
    this.select = select;
    select.focus({ preventScroll: true });
    if (!this.valid()) { this.close(); return; }
    this.savedAttributes = new Map(OPEN_ATTRIBUTES.map(name => [name, select.getAttribute(name)]));
    const popup = document.createElement('div');
    popup.className = 'monky-select-popup';
    popup.id = `monky-select-listbox-${++this.sequence}`;
    popup.setAttribute('role', 'listbox');
    popup.setAttribute('popover', 'manual');
    const labelledBy = select.getAttribute('aria-labelledby');
    const label = select.getAttribute('aria-label')
      || Array.from(select.labels ?? []).map(item => item.textContent?.trim()).filter(Boolean).join(' ')
      || select.closest('.form-group')?.querySelector('label')?.textContent?.trim()
      || select.title;
    if (labelledBy) popup.setAttribute('aria-labelledby', labelledBy);
    else if (label) popup.setAttribute('aria-label', label);
    this.popup = popup;
    document.body.append(popup);
    // The top layer escapes modal stacking contexts without moving the select.
    popup.showPopover();
    select.setAttribute('aria-expanded', 'true');
    select.setAttribute('aria-controls', popup.id);
    this.render();
    if (this.popup !== popup) return;
    popup.addEventListener('pointermove', event => {
      const row = this.rows.find(({ element }) => element.contains(event.target as Node));
      if (row && this.available(row.option)) this.setActive(row.option, false);
    });
    this.optionObserver = new MutationObserver(() => this.render());
    this.optionObserver.observe(select, {
      childList: true, subtree: true, characterData: true, attributes: true,
      attributeFilter: ['disabled', 'hidden', 'label', 'value', 'selected', 'multiple', 'size', 'class', 'style'],
    });
    this.documentObserver = new MutationObserver(() => {
      if (!this.valid()) this.close();
    });
    this.documentObserver.observe(document.body, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['hidden', 'disabled', 'inert', 'class', 'style'],
    });
    this.resizeObserver = new ResizeObserver(this.position);
    this.resizeObserver.observe(select);
  }

  private valid(): boolean {
    return !!this.select?.isConnected && this.eligible(this.select)
      && this.select.getBoundingClientRect().width > 0;
  }

  private render(): void {
    const select = this.select;
    const popup = this.popup;
    if (!select || !popup) return;
    if (!this.valid()) { this.close(); return; }
    const previousActive = this.active;
    const scrollTop = popup.scrollTop;
    this.rows = [];
    const fragment = document.createDocumentFragment();
    let lastGroup: HTMLOptGroupElement | null = null;
    let groupContainer: HTMLElement = fragment.appendChild(document.createElement('div'));
    groupContainer.setAttribute('role', 'presentation');
    for (const option of Array.from(select.options)) {
      if (!this.visible(option)) continue;
      const group = option.parentElement instanceof HTMLOptGroupElement ? option.parentElement : null;
      if (group !== lastGroup) {
        groupContainer = document.createElement('div');
        fragment.append(groupContainer);
        groupContainer.setAttribute('role', group ? 'group' : 'presentation');
        if (group) {
          groupContainer.setAttribute('aria-label', group.label);
          const heading = document.createElement('div');
          heading.className = 'monky-select-group';
          heading.setAttribute('aria-hidden', 'true');
          heading.textContent = group.label;
          groupContainer.append(heading);
        }
        lastGroup = group;
      }
      const element = document.createElement('div');
      element.className = 'monky-select-option';
      element.id = `${popup.id}-option-${option.index}`;
      element.setAttribute('role', 'option');
      element.setAttribute('aria-selected', String(option.selected));
      element.setAttribute('aria-disabled', String(!this.available(option)));
      element.textContent = option.label;
      groupContainer.append(element);
      this.rows.push({ option, element });
    }
    popup.replaceChildren(fragment);
    const active = this.rows.find(({ option }) => option === previousActive && this.available(option))?.option
      ?? this.rows.find(({ option }) => option.selected && this.available(option))?.option
      ?? this.rows.find(({ option }) => this.available(option))?.option;
    this.active = null;
    popup.scrollTop = scrollTop;
    this.position();
    if (active) this.setActive(active);
    else select.removeAttribute('aria-activedescendant');
  }

  private setActive(option: HTMLOptionElement, scroll = true): void {
    this.active = option;
    for (const row of this.rows) {
      row.element.classList.toggle('is-active', row.option === option);
      // Property assignments do not emit mutations; read selectedness on interaction.
      row.element.setAttribute('aria-selected', String(row.option.selected));
      if (row.option === option) {
        this.select?.setAttribute('aria-activedescendant', row.element.id);
        if (scroll) row.element.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  private commit(option: HTMLOptionElement): void {
    const select = this.select;
    if (!select || !this.valid() || !this.available(option) || !this.visible(option) || !Array.from(select.options).includes(option)) return;
    const changed = !option.selected;
    // Close before application listeners run: they may replace the entire settings view.
    select.selectedIndex = option.index;
    this.close();
    if (changed) {
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  private position = (): void => {
    if (!this.popup || !this.select) return;
    if (!this.valid()) { this.close(); return; }
    const rect = this.select.getBoundingClientRect();
    const margin = 8;
    const gap = 6;
    const width = document.documentElement.clientWidth;
    const height = document.documentElement.clientHeight;
    if (rect.bottom < 0 || rect.top > height || rect.right < 0 || rect.left > width) { this.close(); return; }
    const popup = this.popup;
    const availableBelow = Math.max(0, height - rect.bottom - margin - gap);
    const availableAbove = Math.max(0, rect.top - margin - gap);
    const above = availableBelow < Math.min(popup.scrollHeight, 240) && availableAbove > availableBelow;
    const maxHeight = Math.min(360, above ? availableAbove : availableBelow);
    popup.style.maxHeight = `${maxHeight}px`;
    popup.style.minWidth = `${Math.min(rect.width, width - margin * 2)}px`;
    popup.style.maxWidth = `${Math.max(0, width - margin * 2)}px`;
    const popupRect = popup.getBoundingClientRect();
    const alignedLeft = getComputedStyle(this.select).direction === 'rtl' ? rect.right - popupRect.width : rect.left;
    popup.style.left = `${Math.max(margin, Math.min(alignedLeft, width - popupRect.width - margin))}px`;
    popup.style.top = `${Math.max(margin, Math.min(above ? rect.top - gap - popupRect.height : rect.bottom + gap, height - popupRect.height - margin))}px`;
  };

  private close(): void {
    this.optionObserver?.disconnect();
    this.documentObserver?.disconnect();
    this.resizeObserver?.disconnect();
    this.optionObserver = this.documentObserver = null;
    this.resizeObserver = null;
    this.popup?.remove();
    if (this.select) {
      for (const [name, value] of this.savedAttributes) {
        if (value === null) this.select.removeAttribute(name);
        else this.select.setAttribute(name, value);
      }
    }
    this.select = null;
    this.popup = null;
    this.rows = [];
    this.active = null;
    this.savedAttributes.clear();
    this.search = '';
    this.searchTime = 0;
  }
}

export const selectEnhancer = new SelectEnhancer();
