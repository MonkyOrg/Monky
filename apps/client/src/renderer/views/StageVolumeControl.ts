import { t, type TranslationKey } from '../i18n';
import type { SaveTiming } from '../stores/settingsStore';

/** What a tile's volume says: a screen share and a miniapp name their audio differently. */
export interface StageVolumeTexts {
  /** The slider's name, and the button's hint while the audio plays. */
  readonly volume: TranslationKey;
  /** The button's hint while the audio is muted. */
  readonly muted: TranslationKey;
  /** The mute button's name; aria-pressed says whether the audio is muted. */
  readonly mute: TranslationKey;
}

/**
 * The volume of a stage tile, a screen share or a miniapp: a mute button in the tile's
 * bottom-right controls and a vertical 0–200% slider shown above it on hover
 * (theme.css `.stage-volume-*`). The keyboard reaches it too: Tab goes from the button
 * into the slider, Escape closes it, and a muted control stays closed.
 */
export class StageVolumeControl {
  readonly element = document.createElement('div');
  readonly button = document.createElement('button');
  private readonly popup = document.createElement('div');
  private readonly slider = document.createElement('input');
  private readonly glyph = document.createElement('span');
  private percent: number | null = null;
  private muted = false;

  constructor(
    private readonly texts: StageVolumeTexts,
    onVolume: (percent: number, timing: SaveTiming) => void,
    onToggleMute: () => void,
  ) {
    this.element.className = 'stage-volume-wrapper';
    this.popup.className = 'stage-volume-popup';
    this.slider.type = 'range';
    this.slider.className = 'stage-screen-volume-slider';
    this.slider.min = '0';
    this.slider.max = '200';
    this.button.type = 'button';
    this.button.className = 'stage-volume-btn';
    this.glyph.className = 'material-symbols-outlined md-18';
    this.glyph.setAttribute('aria-hidden', 'true');
    this.button.append(this.glyph);
    this.popup.append(this.slider);
    // The popup is positioned above the button; listing the button first lets Tab reach the slider next.
    this.element.append(this.button, this.popup);

    this.button.addEventListener('click', () => onToggleMute());
    // Every step is heard at once; the volume is saved where the slider stops.
    this.slider.addEventListener('input', () => onVolume(this.slider.valueAsNumber, 'soon'));
    this.slider.addEventListener('change', () => onVolume(this.slider.valueAsNumber, 'now'));
    // Keep the slider open and tracking the pointer while dragging, even outside the small popup (#75).
    this.slider.addEventListener('pointerdown', (event) => {
      this.element.classList.add('dragging');
      try { this.slider.setPointerCapture(event.pointerId); } catch { /* The pointer may already be released. */ }
    });
    const endDrag = (): void => this.element.classList.remove('dragging');
    this.slider.addEventListener('pointerup', endDrag);
    this.slider.addEventListener('lostpointercapture', endDrag);
    this.element.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || this.element.classList.contains('dismissed')) return;
      event.stopPropagation();
      this.element.classList.add('dismissed');
      if (document.activeElement === this.slider) this.button.focus();
    });
    this.element.addEventListener('pointerenter', () => this.element.classList.remove('dismissed'));
    // A class, not :focus-within, so the slider stays focusable while focus moves into it.
    this.element.addEventListener('focusin', (event) => {
      if (event.target instanceof Element && event.target.matches(':focus-visible')) this.element.classList.add('keyboard');
    });
    this.element.addEventListener('focusout', (event) => {
      if (event.relatedTarget instanceof Node && this.element.contains(event.relatedTarget)) return;
      this.element.classList.remove('keyboard', 'dismissed');
    });
  }

  update(percent: number, muted: boolean): void {
    // Any saved setting triggers a refresh; untouched controls keep their DOM as is.
    if (percent === this.percent && muted === this.muted) return;
    this.percent = percent;
    this.muted = muted;
    // The thumb being dragged already shows the value it is setting.
    if (!this.element.classList.contains('dragging')) this.slider.value = String(percent);
    this.slider.setAttribute('aria-valuetext', `${percent}%`);
    this.button.setAttribute('aria-pressed', String(muted));
    // Muted audio also keeps the slider closed.
    this.element.classList.toggle('screen-audio-muted', muted);
    this.localize();
  }

  localize(): void {
    this.glyph.textContent = this.muted ? 'volume_off' : 'volume_up';
    this.button.title = t(this.muted ? this.texts.muted : this.texts.volume);
    this.button.setAttribute('aria-label', t(this.texts.mute));
    this.slider.setAttribute('aria-label', t(this.texts.volume));
  }

  /** A tile that stopped playing must not leave the slider held open. */
  close(): void {
    this.element.classList.remove('dragging', 'dismissed', 'keyboard');
  }
}