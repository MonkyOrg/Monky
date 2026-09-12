import { t, type TranslationKey } from '../i18n';
import { escapeHtml } from '../utils/html';
import { COLOR_PRESETS, hexToHsv, hsvToHex, normalizeHexColor, type HsvColor } from '../utils/colors';
import { isScreenColorPickerAvailable, pickScreenColor, ScreenColorPickerError } from '../core/ScreenColorPicker';
import '../styles/colorPicker.css';

interface ColorPickerOptions {
  id: string;
  label: TranslationKey;
  name?: string;
  describedBy?: string;
  presets?: readonly string[];
}

let openPicker: ColorPicker | null = null;

export class ColorPicker {
  private root: HTMLElement | null = null;
  private trigger: HTMLButtonElement | null = null;
  private panel: HTMLElement | null = null;
  private value = '#000000';
  private hsv: HsvColor = { h: 0, s: 0, v: 0 };
  private draftChanged = false;
  private hexChanged = false;
  private pointer: number | null = null;
  private onChange: ((color: string) => void) | null = null;
  private binding: AbortController | null = null;
  private opened: AbortController | null = null;
  private sampling: AbortController | null = null;
  private unwatch: (() => void) | null = null;

  public constructor(
    private readonly options: ColorPickerOptions,
    private readonly screenPicker = { isAvailable: isScreenColorPickerAvailable, pick: pickScreenColor },
  ) {}

  public get isOpen(): boolean {
    return this.panel !== null;
  }

  public renderHtml(value: string): string {
    this.cleanup();
    const color = normalizeHexColor(value);
    if (!color) throw new RangeError('Invalid color picker value');
    this.value = color;
    this.hsv = hexToHsv(color);
    const { id, label, name, describedBy } = this.options;
    return `<div class="color-picker">
      <button type="button" id="${escapeHtml(id)}" class="color-picker-trigger" data-color-picker
        name="${escapeHtml(name ?? id)}" value="${color}" aria-haspopup="dialog" aria-expanded="false"
        aria-label="${escapeHtml(t('colorPicker.choose', { name: t(label) }))}"
        ${describedBy ? `aria-describedby="${escapeHtml(describedBy)}"` : ''}>
        <span class="color-picker-swatch" style="--picked-color: ${color}" aria-hidden="true"></span>
        <span class="color-picker-code">${color.toUpperCase()}</span>
        <span class="material-symbols-outlined md-16" aria-hidden="true">expand_more</span>
      </button>
    </div>`;
  }

  public attachEvents(container: HTMLElement, onChange: (color: string) => void): void {
    this.cleanup();
    const trigger = container.querySelector<HTMLButtonElement>(`#${CSS.escape(this.options.id)}`);
    if (!trigger?.matches('.color-picker-trigger') || !trigger.parentElement) throw new Error('Missing color picker control');
    this.trigger = trigger;
    this.root = trigger.parentElement;
    this.onChange = onChange;
    this.binding = new AbortController();
    trigger.addEventListener('click', () => {
      if (this.isOpen) this.close(true);
      else this.open();
    }, { signal: this.binding.signal });
    this.setValue(trigger.value);
  }

  public setValue(value: string, pending = false): void {
    const color = normalizeHexColor(value);
    if (!color) throw new RangeError('Invalid color picker value');
    // An owner's busy refresh may still contain its previous persisted value.
    if (pending) return;
    const changed = this.value !== color;
    this.value = color;
    if (!this.isOpen || !this.draftChanged) {
      if (changed || !this.isOpen) this.hsv = hexToHsv(color, this.hsv.h);
      this.renderDraft();
    }
  }

  public setDisabled(disabled: boolean): void {
    if (this.trigger) this.trigger.disabled = disabled;
    if (disabled) this.close(false, false);
  }

  public close(restoreFocus = false, commit = true): boolean {
    const panel = this.panel;
    if (!panel) return true;
    if (commit && !this.commitDraft()) return false;
    if (this.panel !== panel) return true;
    this.sampling?.abort();
    this.sampling = null;
    this.opened?.abort();
    this.opened = null;
    this.unwatch?.();
    this.unwatch = null;
    if (this.panel.isConnected && this.panel.matches(':popover-open')) this.panel.hidePopover();
    this.panel.remove();
    this.panel = null;
    this.pointer = null;
    this.draftChanged = false;
    this.hexChanged = false;
    this.hsv = hexToHsv(this.value, this.hsv.h);
    this.trigger?.setAttribute('aria-expanded', 'false');
    this.trigger?.removeAttribute('aria-controls');
    if (openPicker === this) openPicker = null;
    this.renderDraft();
    if (restoreFocus && this.trigger?.isConnected && !this.trigger.matches(':disabled')) this.trigger.focus({ preventScroll: true });
    return true;
  }

  public cleanup(): void {
    this.close(false, false);
    this.binding?.abort();
    this.binding = null;
    this.onChange = null;
    this.trigger = null;
    this.root = null;
  }

  private open(): void {
    const trigger = this.trigger;
    const root = this.root;
    if (!trigger?.isConnected || !root || trigger.matches(':disabled') || this.panel) return;
    if (openPicker && !openPicker.close(false)) return;
    const panel = document.createElement('section');
    panel.id = `${this.options.id}-picker`;
    panel.className = 'color-picker-popover';
    panel.popover = 'manual';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', t('colorPicker.choose', { name: t(this.options.label) }));
    panel.innerHTML = this.panelHtml();
    root.append(panel);
    this.panel = panel;
    this.opened = new AbortController();
    this.hsv = hexToHsv(this.value, this.hsv.h);
    this.draftChanged = this.hexChanged = false;
    openPicker = this;
    trigger.setAttribute('aria-expanded', 'true');
    trigger.setAttribute('aria-controls', panel.id);
    this.bindPanel(this.opened.signal);
    this.renderDraft();
    panel.showPopover();
    this.position();
    this.watchOwner();
    this.field('hex')?.focus({ preventScroll: true });
    this.field('hex')?.select();
  }

  private panelHtml(): string {
    const id = escapeHtml(this.options.id);
    const axis = (name: 'saturation' | 'brightness', value: number) => `<input type="range" class="color-picker-axis"
      data-color-${name} min="0" max="100" step="1" value="${value}" aria-label="${escapeHtml(t(`colorPicker.${name}`))}">`;
    const available = this.screenPicker.isAvailable();
    return `
      <div class="color-picker-heading">
        <strong>${t(this.options.label)}</strong>
        <button type="button" class="color-picker-close" data-color-close aria-label="${escapeHtml(t('common.close'))}">
          <span class="material-symbols-outlined md-18" aria-hidden="true">close</span>
        </button>
      </div>
      <div class="color-picker-area" data-color-area role="group" aria-label="${escapeHtml(t('colorPicker.area'))}">
        ${axis('saturation', this.hsv.s)}${axis('brightness', this.hsv.v)}
        <span class="color-picker-cursor" data-color-cursor aria-hidden="true"></span>
      </div>
      <label class="color-picker-hue-label" for="${id}-hue">${t('colorPicker.hue')}</label>
      <input id="${id}-hue" type="range" class="color-picker-hue" data-color-hue min="0" max="360" step="1" value="${this.hsv.h}">
      <div class="color-picker-entry">
        <label for="${id}-hex">${t('colorPicker.hexLabel')}</label>
        <input id="${id}-hex" data-color-hex type="text" maxlength="7" autocomplete="off" spellcheck="false"
          aria-label="${escapeHtml(t('colorPicker.hex'))}" aria-describedby="${id}-color-error">
        <button type="button" class="color-picker-eyedropper" data-color-eyedropper ${available ? '' : 'disabled'}
          aria-label="${escapeHtml(t('colorPicker.eyedropper'))}">
          <span class="material-symbols-outlined md-20" aria-hidden="true">colorize</span>
          <span>${t('colorPicker.eyedropper')}</span>
        </button>
      </div>
      <div class="color-picker-presets" role="group" aria-label="${escapeHtml(t('colorPicker.presets'))}">
        ${(this.options.presets ?? COLOR_PRESETS).map(value => {
          const color = normalizeHexColor(value);
          if (!color) throw new RangeError('Invalid color preset');
          return `<button type="button" class="color-picker-preset" data-color-preset="${color}"
            style="--picked-color: ${color}" aria-label="${color.toUpperCase()}" aria-pressed="false"></button>`;
        }).join('')}
      </div>
      <p class="color-picker-hint" data-color-status role="status">${t(available ? 'colorPicker.hint' : 'colorPicker.unsupported')}</p>
      <p id="${id}-color-error" class="color-picker-error" data-color-error role="alert" hidden></p>`;
  }

  private field(name: string): HTMLInputElement | null {
    return this.panel?.querySelector<HTMLInputElement>(`[data-color-${name}]`) ?? null;
  }

  private bindPanel(signal: AbortSignal): void {
    const panel = this.panel;
    if (!panel) return;
    const options = { signal };
    const area = panel.querySelector<HTMLElement>('[data-color-area]')!;
    const move = (event: PointerEvent) => {
      const rect = area.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      this.hsv.s = Math.max(0, Math.min(100, (event.clientX - rect.left) / rect.width * 100));
      this.hsv.v = Math.max(0, Math.min(100, (1 - (event.clientY - rect.top) / rect.height) * 100));
      this.draftChanged = true;
      this.hexChanged = false;
      this.showError('');
      this.renderDraft();
    };
    area.addEventListener('pointerdown', event => {
      if (event.button !== 0 || this.sampling || this.pointer !== null) return;
      event.preventDefault();
      this.pointer = event.pointerId;
      area.setPointerCapture(event.pointerId);
      this.field('saturation')?.focus({ preventScroll: true });
      move(event);
    }, options);
    area.addEventListener('pointermove', event => { if (this.pointer === event.pointerId) move(event); }, options);
    area.addEventListener('pointerup', event => {
      if (this.pointer !== event.pointerId) return;
      move(event);
      this.pointer = null;
      if (area.hasPointerCapture(event.pointerId)) area.releasePointerCapture(event.pointerId);
      this.commitDraft();
    }, options);
    area.addEventListener('pointercancel', () => {
      this.pointer = null;
      this.draftChanged = false;
      this.hsv = hexToHsv(this.value, this.hsv.h);
      this.renderDraft();
    }, options);
    for (const [name, key] of [['hue', 'h'], ['saturation', 's'], ['brightness', 'v']] as const) {
      const input = this.field(name)!;
      input.addEventListener('input', () => {
        this.hsv[key] = Number(input.value);
        this.draftChanged = true;
        this.hexChanged = false;
        this.showError('');
        this.renderDraft();
      }, options);
      input.addEventListener('change', () => { this.commitDraft(); }, options);
    }
    const hex = this.field('hex')!;
    hex.addEventListener('input', () => {
      this.hexChanged = true;
      const color = normalizeHexColor(hex.value);
      if (color) {
        this.hsv = hexToHsv(color, this.hsv.h);
        this.draftChanged = true;
        this.showError('');
        this.renderDraft();
      }
    }, options);
    hex.addEventListener('change', () => { this.commitDraft(); }, options);
    panel.addEventListener('click', event => {
      const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null;
      if (!button || button.disabled) return;
      if (button.hasAttribute('data-color-close')) this.close(true);
      else if (button.hasAttribute('data-color-eyedropper')) void this.sample();
      else if (button.dataset.colorPreset) {
        const color = normalizeHexColor(button.dataset.colorPreset);
        if (!color) { this.showError(t('colorPicker.invalidHex')); return; }
        this.hexChanged = false;
        this.draftChanged = true;
        this.hsv = hexToHsv(color, this.hsv.h);
        this.renderDraft();
        this.commitDraft();
      }
    }, options);
    const outside = (event: Event) => {
      if (this.sampling || (event.target instanceof Node && this.root?.contains(event.target))) return;
      if (!this.close(false)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.field('hex')?.focus({ preventScroll: true });
      }
    };
    window.addEventListener('pointerdown', outside, { signal, capture: true });
    window.addEventListener('focusin', outside, { signal, capture: true });
    window.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (this.sampling) this.sampling.abort();
        else this.close(true, false);
      } else if (event.key === 'Enter' && event.target === this.field('hex')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.close(true);
      } else if (event.key === 'Tab') {
        const fields = [...panel.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')];
        const first = fields[0];
        const last = fields.at(-1);
        if ((event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
          event.preventDefault();
          event.stopImmediatePropagation();
          (event.shiftKey ? last : first)?.focus();
        }
      }
    }, { signal, capture: true });
    window.addEventListener('blur', () => { if (!this.sampling) this.close(false); }, options);
    window.addEventListener('resize', () => this.position(), options);
    window.addEventListener('scroll', () => this.position(), { signal, capture: true });
  }

  private commitDraft(): boolean {
    if (!this.panel) return true;
    if (this.hexChanged) {
      const color = normalizeHexColor(this.field('hex')?.value ?? '');
      if (!color) { this.showError(t('colorPicker.invalidHex')); return false; }
      this.hsv = hexToHsv(color, this.hsv.h);
      this.draftChanged = true;
    }
    this.hexChanged = false;
    this.showError('');
    const color = hsvToHex(this.hsv);
    const changed = this.draftChanged && color !== this.value;
    this.draftChanged = false;
    this.value = color;
    this.renderDraft();
    // Pass the immutable selection, not a DOM value an owner refresh can reset.
    if (changed) this.onChange?.(color);
    return true;
  }

  private renderDraft(): void {
    const color = this.isOpen ? hsvToHex(this.hsv) : this.value;
    if (this.trigger) {
      this.trigger.value = color;
      this.trigger.querySelector<HTMLElement>('.color-picker-swatch')?.style.setProperty('--picked-color', color);
      const code = this.trigger.querySelector('.color-picker-code');
      if (code) code.textContent = color.toUpperCase();
    }
    if (!this.panel) return;
    const area = this.panel.querySelector<HTMLElement>('[data-color-area]');
    area?.style.setProperty('--picker-hue', String(this.hsv.h));
    const cursor = this.panel.querySelector<HTMLElement>('[data-color-cursor]');
    if (cursor) { cursor.style.left = `${this.hsv.s}%`; cursor.style.top = `${100 - this.hsv.v}%`; }
    for (const [name, key] of [['hue', 'h'], ['saturation', 's'], ['brightness', 'v']] as const) {
      const field = this.field(name);
      if (field) {
        field.value = String(this.hsv[key]);
        field.setAttribute('aria-valuetext', t(name === 'hue' ? 'colorPicker.degrees' : 'colorPicker.percentage', { value: Math.round(this.hsv[key]) }));
      }
    }
    const hex = this.field('hex');
    if (hex && !this.hexChanged) hex.value = color.toUpperCase();
    for (const preset of this.panel.querySelectorAll<HTMLButtonElement>('[data-color-preset]')) {
      preset.setAttribute('aria-pressed', String(preset.dataset.colorPreset === color));
    }
  }

  private showError(message: string): void {
    const error = this.panel?.querySelector<HTMLElement>('[data-color-error]');
    if (error) { error.textContent = message; error.hidden = !message; }
    this.field('hex')?.setAttribute('aria-invalid', String(Boolean(message) && this.hexChanged));
  }

  private async sample(): Promise<void> {
    const panel = this.panel;
    if (this.sampling || !panel || !this.commitDraft() || this.panel !== panel) return;
    const controller = new AbortController();
    this.sampling = controller;
    panel.classList.add('color-picker-sampling');
    const button = panel.querySelector<HTMLButtonElement>('[data-color-eyedropper]')!;
    const status = panel.querySelector<HTMLElement>('[data-color-status]')!;
    button.disabled = true;
    status.textContent = t('colorPicker.sampling');
    this.showError('');
    try {
      const picked = await this.screenPicker.pick(controller.signal);
      if (controller.signal.aborted || this.panel !== panel || picked === null) return;
      const color = normalizeHexColor(picked);
      if (!color) throw new ScreenColorPickerError('capture');
      this.hexChanged = false;
      this.draftChanged = true;
      this.hsv = hexToHsv(color, this.hsv.h);
      this.renderDraft();
      this.commitDraft();
    } catch (error: unknown) {
      if (!controller.signal.aborted && this.panel === panel) {
        const messages: Record<ScreenColorPickerError['code'], TranslationKey> = {
          unsupported: 'colorPicker.unsupported', permission: 'colorPicker.permission',
          capture: 'colorPicker.captureFailed', busy: 'colorPicker.busy',
        };
        console.warn('[ColorPicker] Screen color selection failed:', error);
        this.showError(t(error instanceof ScreenColorPickerError ? messages[error.code] : 'colorPicker.captureFailed'));
      }
    } finally {
      if (this.sampling === controller) {
        this.sampling = null;
        if (this.panel === panel) {
          panel.classList.remove('color-picker-sampling');
          button.disabled = !this.screenPicker.isAvailable();
          status.textContent = t('colorPicker.hint');
          if (!button.disabled) button.focus({ preventScroll: true });
        }
      }
    }
  }

  private position(): void {
    const panel = this.panel;
    const trigger = this.trigger;
    if (!panel || !trigger) return;
    const padding = 8;
    panel.style.maxHeight = `${Math.max(80, innerHeight - padding * 2)}px`;
    const anchor = trigger.getBoundingClientRect();
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    const top = anchor.bottom + padding + height <= innerHeight - padding
      ? anchor.bottom + padding : anchor.top - height - padding;
    panel.style.left = `${Math.max(padding, Math.min(anchor.right - width, innerWidth - width - padding))}px`;
    panel.style.top = `${Math.max(padding, Math.min(top, innerHeight - height - padding))}px`;
  }

  private watchOwner(): void {
    const check = () => {
      if (!this.trigger?.isConnected || !this.trigger.checkVisibility({ checkVisibilityCSS: true }) || this.trigger.matches(':disabled')) {
        this.close(false, false);
      }
    };
    const mutations = new MutationObserver(check);
    mutations.observe(document.body, { childList: true, subtree: true });
    const visibility = new MutationObserver(check);
    for (let element: HTMLElement | null = this.trigger; element; element = element.parentElement) {
      visibility.observe(element, { attributes: true, attributeFilter: ['class', 'style', 'hidden', 'disabled'] });
    }
    const resize = new ResizeObserver(() => this.position());
    if (this.trigger) resize.observe(this.trigger);
    if (this.panel) resize.observe(this.panel);
    this.unwatch = () => { mutations.disconnect(); visibility.disconnect(); resize.disconnect(); };
  }
}
