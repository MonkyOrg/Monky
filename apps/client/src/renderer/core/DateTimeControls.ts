import { getLanguage, t } from '../i18n';
import {
  calendarDate, calendarValue, dateFieldValue, quarterHourOptions, setDateFieldValue, shiftCalendarMonth,
} from '../utils/calendarDate';
import { animateEnter, ownSurface, positionAnchoredSurface, removeWithMotion } from '../utils/surfaceMotion';
import { smoothScrollIntoView } from '../utils/scroll';
import '../styles/dateTimeControls.css';

let sequence = 0;

/** Canonical date/time fields use one themed picker and may opt out of direct editing. */
export class DateTimeControls {
  private lifetime: AbortController | null = null;
  private input: HTMLInputElement | null = null;
  private popup: HTMLElement | null = null;
  private releaseOwner: (() => void) | null = null;
  private observer: MutationObserver | null = null;
  private resize: ResizeObserver | null = null;
  private attributes = new Map<string, string | null>();
  private day = new Date();
  private range: { start: HTMLInputElement; end: HTMLInputElement; first: string | null } | null = null;

  public init(): void {
    if (this.lifetime) return;
    this.lifetime = new AbortController();
    const options = { capture: true, signal: this.lifetime.signal };
    document.addEventListener('pointerdown', this.pointer, options);
    document.addEventListener('mousedown', this.mouse, options);
    document.addEventListener('click', this.click, options);
    document.addEventListener('keydown', this.key, options);
    document.addEventListener('focusin', this.focus, options);
    document.addEventListener('input', this.change, options);
    document.addEventListener('scroll', this.position, options);
    window.addEventListener('resize', this.position, options);
    window.addEventListener('blur', this.blur, options);
  }

  public dispose(): void {
    this.close();
    this.lifetime?.abort();
    this.lifetime = null;
  }

  private eligible(target: EventTarget | null): target is HTMLInputElement {
    return target instanceof HTMLInputElement && this.kind(target) !== null
      && !target.matches(':disabled') && (!target.readOnly || target.dataset.pickerOnly !== undefined) && !target.closest('[inert]')
      && target.checkVisibility({ checkVisibilityCSS: true });
  }

  private kind(input: HTMLInputElement): 'date' | 'time' | null {
    if (input.dataset.datePicker !== undefined || input.type === 'date') return 'date';
    return input.type === 'time' ? 'time' : null;
  }

  private value(input: HTMLInputElement): string {
    return this.kind(input) === 'date' ? dateFieldValue(input) : input.value;
  }

  private setValue(input: HTMLInputElement, value: string): void {
    if (this.kind(input) === 'date') setDateFieldValue(input, value, getLanguage());
    else input.value = value;
  }

  private pickerOnly(input: HTMLInputElement): boolean {
    return input.dataset.pickerOnly !== undefined;
  }

  private onIndicator(input: HTMLInputElement, event: MouseEvent): boolean {
    const box = input.getBoundingClientRect();
    return getComputedStyle(input).direction === 'rtl' ? event.clientX <= box.left + 40 : event.clientX >= box.right - 40;
  }

  private pointer = (event: PointerEvent): void => {
    if (event.button !== 0) { this.close(); return; }
    if (this.eligible(event.target)) {
      if (!this.pickerOnly(event.target) && !this.onIndicator(event.target, event)) {
        if (this.input !== event.target) this.close();
        return;
      }
      event.preventDefault();
      event.target.focus({ preventScroll: true });
      if (this.input === event.target) this.close();
      else this.open(event.target);
    } else if (event.target instanceof Node && this.popup?.contains(event.target)) {
      event.stopImmediatePropagation();
    } else this.close();
  };

  private mouse = (event: MouseEvent): void => {
    if (this.eligible(event.target) && (this.pickerOnly(event.target) || this.onIndicator(event.target, event))) event.preventDefault();
  };

  private click = (event: MouseEvent): void => {
    if (this.eligible(event.target)) {
      if (this.pickerOnly(event.target)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      if (event.detail === 0) { event.preventDefault(); this.open(event.target); }
      return;
    }
    if (!(event.target instanceof Element) || !this.popup?.contains(event.target)) return;
    const button = event.target.closest<HTMLButtonElement>('button');
    if (!button || button.disabled) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (button.dataset.value !== undefined) this.commit(button.dataset.value);
    else if (button.dataset.month) {
      this.day = shiftCalendarMonth(this.day, Number(button.dataset.month));
      this.render();
      this.popup?.querySelector<HTMLButtonElement>(`[data-month="${button.dataset.month}"]`)?.focus();
    }
  };

  private focus = (event: FocusEvent): void => {
    if (event.target !== this.input && event.target instanceof Node && !this.popup?.contains(event.target)) this.close();
  };
  private blur = (event: FocusEvent): void => { if (event.target === window) this.close(); };
  private change = (event: Event): void => {
    if (event.target === this.input && this.popup) {
      const date = calendarDate(this.input ? this.value(this.input) : '');
      if (date) this.day = date;
      this.render();
    }
  };

  private key = (event: KeyboardEvent): void => {
    if (event.isComposing) return;
    const inside = event.target instanceof Node && !!this.popup?.contains(event.target);
    if (!inside && !this.eligible(event.target)) return;
    if (this.popup && (inside || event.target === this.input)) {
      if (event.key === 'Escape' || event.key === 'Tab') {
        if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); }
        this.close(true);
        return;
      }
      if (this.input && this.kind(this.input) === 'date' && inside && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) {
        const focused = event.target instanceof HTMLElement ? calendarDate(event.target.dataset.value ?? '') : null;
        if (!focused) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const next = event.key.startsWith('Page') ? shiftCalendarMonth(focused, event.key === 'PageUp' ? -1 : 1) : new Date(focused);
        const delta: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -focused.getUTCDay(), End: 6 - focused.getUTCDay() };
        if (event.key in delta) next.setUTCDate(next.getUTCDate() + delta[event.key]);
        if (!this.allowed(calendarValue(next))) return;
        this.day = next;
        this.render();
        this.popup?.querySelector<HTMLButtonElement>(`[data-value="${calendarValue(next)}"]`)?.focus();
        return;
      }
      if (this.input && this.kind(this.input) === 'time' && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const choices = [...this.popup.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const index = choices.indexOf(document.activeElement as HTMLButtonElement);
        const nearest = choices.findIndex(button => (button.dataset.value ?? '') >= (this.input ? this.value(this.input) : ''));
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1
          : index < 0 ? Math.max(0, nearest < 0 ? choices.length - 1 : nearest)
            : Math.max(0, Math.min(choices.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)));
        choices[next]?.focus({ preventScroll: true });
        if (choices[next]) smoothScrollIntoView(choices[next], { block: 'nearest' });
        return;
      }
      if (inside && (event.key === 'Enter' || event.key === ' ')) {
        if (event.target instanceof HTMLButtonElement) {
          event.preventDefault();
          event.stopImmediatePropagation();
          event.target.click();
        }
        return;
      }
    }
    if (this.eligible(event.target) && this.pickerOnly(event.target)) {
      const opens = event.key === 'Enter' || event.key === ' ' || event.key === 'F4'
        || event.key === 'ArrowDown' || (event.altKey && event.key === 'ArrowDown');
      if (event.key !== 'Tab') {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      if (opens) this.open(event.target);
      return;
    }
    if (this.eligible(event.target) && (event.key === 'Enter' || event.key === 'F4' || (event.altKey && event.key === 'ArrowDown'))) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.open(event.target);
    }
  };

  private allowed(value: string): boolean {
    if (!this.input || (this.kind(this.input) === 'date' && !calendarDate(value))) return false;
    const { min, max } = this.input;
    if (this.kind(this.input) === 'time' && min && max && min > max) return value >= min || value <= max;
    return (!min || value >= min) && (!max || value <= max);
  }

  private open(input: HTMLInputElement): void {
    this.close();
    this.input = input;
    const start = document.getElementById(input.dataset.dateRangeStart ?? '');
    const end = document.getElementById(input.dataset.dateRangeEnd ?? '');
    const kind = this.kind(input);
    if (kind === 'date' && start instanceof HTMLInputElement && end instanceof HTMLInputElement
      && this.kind(start) === 'date' && this.kind(end) === 'date'
      && !start.disabled && !end.disabled && !start.closest('[inert]') && !end.closest('[inert]')) {
      this.range = { start, end, first: null };
    }
    const popup = document.createElement('div');
    popup.className = `date-time-popup ${kind === 'date' ? 'calendar-popup' : 'time-popup'}`;
    popup.id = `date-time-popup-${++sequence}`;
    popup.setAttribute('popover', 'manual');
    popup.setAttribute('role', kind === 'date' ? 'dialog' : 'listbox');
    popup.setAttribute('aria-label', input.getAttribute('aria-label') || input.labels?.[0]?.textContent?.trim() || t('datePicker.chooseDate'));
    for (const name of ['aria-expanded', 'aria-controls', 'aria-haspopup']) this.attributes.set(name, input.getAttribute(name));
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-controls', popup.id);
    input.setAttribute('aria-haspopup', kind === 'date' ? 'dialog' : 'listbox');
    const today = new Date();
    this.day = calendarDate(this.value(input)) ?? calendarDate(`${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`)!;
    this.popup = popup;
    this.releaseOwner = ownSurface(popup, input);
    document.body.append(popup);
    popup.showPopover();
    popup.addEventListener('pointerover', event => {
      if (!this.range?.first || !(event.target instanceof Element)) return;
      const value = event.target.closest<HTMLElement>('[data-value]')?.dataset.value;
      if (!value) return;
      const bounds = [this.range.first, value].sort();
      popup.querySelectorAll<HTMLElement>('[role=gridcell]').forEach(cell =>
        cell.classList.toggle('is-in-range', !!cell.dataset.value && cell.dataset.value >= bounds[0] && cell.dataset.value <= bounds[1]));
    });
    this.render();
    animateEnter(popup);
    this.observer = new MutationObserver(() => {
      if (!this.eligible(input) || !input.isConnected) this.close();
    });
    this.observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'inert', 'disabled', 'readonly', 'class', 'style'] });
    this.resize = new ResizeObserver(this.position);
    this.resize.observe(input);
    if (kind === 'date') popup.querySelector<HTMLButtonElement>('[tabindex="0"]')?.focus();
  }

  private render(): void {
    const popup = this.popup, input = this.input;
    if (!popup || !input) return;
    popup.replaceChildren();
    const button = (label: string, value: string): HTMLButtonElement => {
      const result = document.createElement('button');
      result.type = 'button';
      result.textContent = label;
      result.dataset.value = value;
      result.disabled = value !== '' && !this.allowed(value);
      return result;
    };
    if (this.kind(input) === 'time') {
      for (const value of quarterHourOptions()) {
        const option = button(value, value);
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', String(this.value(input) === value));
        popup.append(option);
      }
    } else {
      const header = document.createElement('div');
      header.className = 'calendar-heading';
      const heading = document.createElement('strong');
      heading.setAttribute('aria-live', 'polite');
      heading.textContent = new Intl.DateTimeFormat(getLanguage(), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(this.day);
      const previous = document.createElement('button'), next = document.createElement('button');
      for (const [control, delta, icon, label] of [[previous, -1, 'chevron_left', t('datePicker.previousMonth')], [next, 1, 'chevron_right', t('datePicker.nextMonth')]] as const) {
        control.type = 'button';
        control.dataset.month = String(delta);
        control.setAttribute('aria-label', label);
        control.innerHTML = `<span class="material-symbols-outlined" aria-hidden="true">${icon}</span>`;
        const year = shiftCalendarMonth(this.day, delta).getUTCFullYear();
        control.disabled = year < 1 || year > 9999;
      }
      header.append(previous, heading, next);
      popup.append(header);
      if (this.range) {
        const status = document.createElement('p');
        status.className = 'calendar-range-status';
        status.setAttribute('role', 'status');
        status.textContent = t(this.range.first ? 'datePicker.rangeEnd' : 'datePicker.rangeStart');
        popup.append(status);
      }
      const grid = document.createElement('div');
      grid.className = 'calendar-grid';
      grid.setAttribute('role', 'grid');
      grid.setAttribute('aria-label', heading.textContent);
      if (this.range) grid.setAttribute('aria-multiselectable', 'true');
      const weekdays = document.createElement('div');
      weekdays.setAttribute('role', 'row');
      for (let day = 0; day < 7; day++) {
        const label = document.createElement('span');
        label.setAttribute('role', 'columnheader');
        label.textContent = new Intl.DateTimeFormat(getLanguage(), { weekday: 'narrow', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 7 + day)));
        weekdays.append(label);
      }
      grid.append(weekdays);
      const date = new Date(this.day);
      date.setUTCDate(1);
      date.setUTCDate(1 - date.getUTCDay());
      for (let week = 0; week < 6; week++) {
        const row = document.createElement('div');
        row.setAttribute('role', 'row');
        for (let column = 0; column < 7; column++) {
          const value = calendarValue(date);
          const control = button(String(date.getUTCDate()), value);
          control.setAttribute('role', 'gridcell');
          const rangeStart = this.range?.first ?? (this.range ? this.value(this.range.start) : '');
          const rangeEnd = this.range?.first ? '' : (this.range ? this.value(this.range.end) : '');
          control.setAttribute('aria-selected', String(this.range ? value === rangeStart || value === rangeEnd : value === this.value(input)));
          control.classList.toggle('is-in-range', !!rangeStart && !!rangeEnd && value >= rangeStart && value <= rangeEnd);
          control.setAttribute('aria-label', new Intl.DateTimeFormat(getLanguage(), { dateStyle: 'full', timeZone: 'UTC' }).format(date));
          control.classList.toggle('is-other-month', date.getUTCMonth() !== this.day.getUTCMonth());
          control.tabIndex = value === calendarValue(this.day) ? 0 : -1;
          control.disabled ||= date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999;
          row.append(control);
          date.setUTCDate(date.getUTCDate() + 1);
        }
        grid.append(row);
      }
      popup.append(grid);
      const footer = document.createElement('div');
      footer.className = 'calendar-actions';
      const now = new Date();
      const today = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
      footer.append(button(t('datePicker.today'), calendarValue(today)));
      if (!input.required) footer.append(button(t('datePicker.clear'), ''));
      popup.append(footer);
    }
    this.position();
    const selected = popup.querySelector('[aria-selected="true"]');
    const nearestTime = this.kind(input) === 'time'
      ? [...popup.querySelectorAll<HTMLButtonElement>('button')].find(button => (button.dataset.value ?? '') >= this.value(input))
      : null;
    const target = selected ?? nearestTime;
    if (target) smoothScrollIntoView(target, { block: 'nearest' });
  }

  private commit(value: string): void {
    const input = this.input;
    if (!input || (value && !this.allowed(value))) return;
    if (this.range) {
      const range = this.range;
      if (value && !range.first) {
        range.first = value;
        this.day = calendarDate(value)!;
        this.render();
        this.popup?.querySelector<HTMLButtonElement>(`[data-value="${value}"]`)?.focus();
        return;
      }
      const [start, end] = value ? [range.first!, value].sort() : ['', ''];
      const changed = [this.value(range.start) !== start, this.value(range.end) !== end];
      this.setValue(range.start, start);
      this.setValue(range.end, end);
      this.close(true);
      [range.start, range.end].forEach((field, index) => {
        if (!changed[index]) return;
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
      });
      return;
    }
    const changed = this.value(input) !== value;
    this.setValue(input, value);
    this.close(true);
    if (changed) {
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  private position = (): void => {
    if (this.popup && this.input) {
      const date = this.kind(this.input) === 'date';
      positionAnchoredSurface(this.popup, this.input, {
        matchWidth: !date,
        maxHeight: 370,
        minimumHeight: date ? 370 : 240,
      });
    }
  };

  private close(restoreFocus = false): void {
    const input = this.input;
    const popup = this.popup;
    const attributes = new Map(this.attributes);
    this.popup = null;
    this.input = null;
    this.range = null;
    this.attributes.clear();
    this.observer?.disconnect();
    this.resize?.disconnect();
    this.observer = null;
    this.resize = null;
    this.releaseOwner?.();
    this.releaseOwner = null;
    if (popup) removeWithMotion(popup);
    if (input) for (const [name, value] of attributes) {
      if (value === null) input.removeAttribute(name);
      else input.setAttribute(name, value);
    }
    if (restoreFocus && input?.isConnected && !input.closest('[inert]')) input.focus({ preventScroll: true });
  }
}

export const dateTimeControls = new DateTimeControls();
