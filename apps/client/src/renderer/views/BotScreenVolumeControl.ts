import { t } from '../i18n';
import type { SaveTiming } from '../stores/settingsStore';

/**
 * A miniapp tile's volume, built exactly like a screen share's: a mute button in
 * the tile's bottom-right controls and a vertical 0–200% slider shown above it on
 * hover (theme.css `.stage-volume-*`). It also opens from the keyboard and closes on Escape.
 */
export class BotScreenVolumeControl {
  readonly element = document.createElement('div');
  private wrapper = document.createElement('div');
  private popup = document.createElement('div');
  private slider = document.createElement('input');
  private button = document.createElement('button');
  private glyph = document.createElement('span');
  private percent: number | null = null;
  private muted = false;

  constructor(onVolume: (percent: number, timing: SaveTiming) => void, onToggleMute: () => void) {
    this.element.className = 'stage-card-controls';
    this.wrapper.className = 'stage-volume-wrapper';
    this.wrapper.dataset.botScreenVolume = '';
    this.popup.className = 'stage-volume-popup';
    this.slider.type = 'range';
    this.slider.className = 'stage-screen-volume-slider';
    this.slider.min = '0';
    this.slider.max = '200';
    this.button.type = 'button';
    this.button.className = 'stage-volume-btn';
    this.button.dataset.botScreenAction = 'mute';
    this.glyph.className = 'material-symbols-outlined md-18';
    this.glyph.setAttribute('aria-hidden', 'true');
    this.button.append(this.glyph);
    this.popup.append(this.slider);
    // The popup is positioned above the button; listing the button first lets Tab reach the slider next.
    this.wrapper.append(this.button, this.popup);
    this.element.append(this.wrapper);

    // Controls must not reach the tile, whose click toggles focus.
    this.element.addEventListener('click', (event) => event.stopPropagation());
    this.button.addEventListener('click', () => onToggleMute());
    // Every step is heard at once; the volume is saved where the slider stops.
    this.slider.addEventListener('input', () => onVolume(this.slider.valueAsNumber, 'soon'));
    this.slider.addEventListener('change', () => onVolume(this.slider.valueAsNumber, 'now'));
    // Keep the slider open and tracking the pointer while dragging, as on screen shares (#75).
    this.slider.addEventListener('pointerdown', (event) => {
      this.wrapper.classList.add('dragging');
      try { this.slider.setPointerCapture(event.pointerId); } catch { /* The pointer may already be released. */ }
    });
    const endDrag = (): void => this.wrapper.classList.remove('dragging');
    this.slider.addEventListener('pointerup', endDrag);
    this.slider.addEventListener('lostpointercapture', endDrag);
    this.wrapper.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || this.wrapper.classList.contains('dismissed')) return;
      event.stopPropagation();
      this.wrapper.classList.add('dismissed');
      if (document.activeElement === this.slider) this.button.focus();
    });
    this.wrapper.addEventListener('pointerenter', () => this.wrapper.classList.remove('dismissed'));
    // A class, not :focus-within, so the slider stays focusable while focus moves into it.
    this.wrapper.addEventListener('focusin', (event) => {
      if (event.target instanceof Element && event.target.matches(':focus-visible')) this.wrapper.classList.add('keyboard');
    });
    this.wrapper.addEventListener('focusout', (event) => {
      if (event.relatedTarget instanceof Node && this.wrapper.contains(event.relatedTarget)) return;
      this.wrapper.classList.remove('keyboard', 'dismissed');
    });
  }

  update(percent: number, muted: boolean): void {
    // Any saved setting triggers a refresh; untouched controls keep their DOM as is.
    if (percent === this.percent && muted === this.muted) return;
    this.percent = percent;
    this.muted = muted;
    this.slider.value = String(percent);
    this.slider.setAttribute('aria-valuetext', `${percent}%`);
    this.button.setAttribute('aria-pressed', String(muted));
    // The screen share class also keeps the slider closed while muted.
    this.wrapper.classList.toggle('screen-audio-muted', muted);
    this.localize();
  }

  localize(): void {
    this.glyph.textContent = this.muted ? 'volume_off' : 'volume_up';
    this.button.title = t(this.muted ? 'botScreen.audioMuted' : 'botScreen.volume');
    this.button.setAttribute('aria-label', t('botScreen.mute'));
    this.slider.setAttribute('aria-label', t('botScreen.volume'));
  }

  /** A view that stopped playing must not leave the slider held open. */
  close(): void {
    this.wrapper.classList.remove('dragging', 'dismissed', 'keyboard');
  }
}
