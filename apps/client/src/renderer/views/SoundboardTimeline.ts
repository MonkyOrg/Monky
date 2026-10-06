import type { SoundboardEditTimes } from '@monky/shared';
import { getLanguage, t } from '../i18n';

type Handle = keyof SoundboardEditTimes;
const HANDLES: Handle[] = ['start', 'end', 'fadeIn', 'fadeOut'];

export function soundboardPeaks(buffer: AudioBuffer, bins = 2048): Float32Array[] {
  const count = Math.min(bins, buffer.length);
  return Array.from({ length: buffer.numberOfChannels }, (_, channel) => {
    const samples = buffer.getChannelData(channel);
    const peaks = new Float32Array(count * 2);
    for (let bin = 0; bin < count; bin++) {
      let low = 0, high = 0;
      const end = Math.floor((bin + 1) * samples.length / count);
      for (let index = Math.floor(bin * samples.length / count); index < end; index++) {
        const sample = Number.isFinite(samples[index]) ? samples[index] : 0;
        low = Math.min(low, sample); high = Math.max(high, sample);
      }
      peaks[bin * 2] = low; peaks[bin * 2 + 1] = high;
    }
    return peaks;
  });
}

/** All editing coordinates are integer source frames; the renderer/encoder share the resulting times. */
export class SoundboardTimeline {
  private readonly frames: SoundboardEditTimes;
  private readonly peaks: Float32Array[];
  private readonly canvas: HTMLCanvasElement;
  private readonly controller = new AbortController();
  private readonly resize: ResizeObserver;
  private active: { id: number; handle: Handle; button: HTMLButtonElement; before: SoundboardEditTimes } | null = null;
  private disabled = false;
  private playbackTime = 0;
  private readonly format = new Intl.NumberFormat(getLanguage(), { minimumFractionDigits: 3, maximumFractionDigits: 3 });

  constructor(
    private readonly root: HTMLElement,
    private readonly buffer: AudioBuffer,
    private readonly changed: (times: SoundboardEditTimes) => void,
  ) {
    this.frames = { start: 0, end: buffer.length, fadeIn: 0, fadeOut: 0 };
    this.peaks = soundboardPeaks(buffer);
    root.className = 'sb-timeline';
    root.innerHTML = `<div class="sb-waveform-track">
      <canvas aria-hidden="true"></canvas>
      <div class="sb-waveform-playhead" aria-hidden="true"></div>
      ${HANDLES.map(handle => `<button type="button" class="sb-waveform-handle" data-handle="${handle}"
        role="slider" aria-label="${t(`soundboard.waveform.${handle}`)}" aria-orientation="horizontal"
        aria-describedby="sb-waveform-help" title="${t(`soundboard.waveform.${handle}`)}">
        <span aria-hidden="true">${handle === 'start' ? '⏵' : handle === 'end' ? '⏴' : handle === 'fadeIn' ? '↗' : '↘'}</span></button>`).join('')}
      </div><div class="sb-waveform-ruler"><span>0:00</span><span>${this.format.format(buffer.duration)} s</span></div>
      <div class="sb-waveform-readouts">${HANDLES.map(handle =>
        `<div><span>${t(`soundboard.edit.${handle}`)}</span><output data-time="${handle}"></output></div>`).join('')}</div>
      <p id="sb-waveform-help" class="sb-editor-help">${t('soundboard.waveformHelp')}</p>
      <p class="sb-editor-help" data-fade-adjustment role="status" aria-live="polite"></p>`;
    this.canvas = root.querySelector('canvas')!;
    const { signal } = this.controller;
    root.querySelectorAll<HTMLButtonElement>('[data-handle]').forEach(button => {
      const handle = button.dataset.handle as Handle;
      button.addEventListener('pointerdown', event => {
        if (this.disabled || this.active || event.button !== 0) return;
        event.preventDefault(); button.focus({ preventScroll: true });
        this.active = { id: event.pointerId, handle, button, before: { ...this.frames } };
        button.setPointerCapture(event.pointerId);
      }, { signal });
      button.addEventListener('pointermove', event => {
        if (this.active?.id !== event.pointerId || this.active.button !== button) return;
        const box = this.canvas.getBoundingClientRect();
        const position = (event.clientX - box.left - 18) / Math.max(1, box.width - 36);
        this.set(handle, Math.round(position * buffer.length));
      }, { signal });
      button.addEventListener('pointerup', event => {
        if (this.active?.id === event.pointerId) this.release(false);
      }, { signal });
      const cancel = (event: PointerEvent) => {
        if (this.active?.id === event.pointerId && this.active.button === button) this.release(true);
      };
      button.addEventListener('pointercancel', cancel, { signal });
      button.addEventListener('lostpointercapture', cancel, { signal });
      button.addEventListener('keydown', event => {
        if (this.disabled) return;
        const [minimum, maximum] = this.bounds(handle);
        const step = event.altKey ? 1 : Math.round(buffer.sampleRate * (event.shiftKey ? 0.1 : 0.01));
        const direction = handle === 'fadeOut' ? -1 : 1;
        let value = this.position(handle);
        if (event.key === 'Home') value = handle === 'fadeOut' ? maximum : minimum;
        else if (event.key === 'End') value = handle === 'fadeOut' ? minimum : maximum;
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') value -= step * direction;
        else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') value += step * direction;
        else if (event.key === 'Escape' && this.active) { event.preventDefault(); this.release(true); return; }
        else return;
        event.preventDefault(); event.stopPropagation(); this.set(handle, value);
      }, { signal });
    });
    this.resize = new ResizeObserver(() => this.render());
    this.resize.observe(root);
    window.addEventListener('resize', () => this.render(), { signal });
    this.render();
  }

  public values(): SoundboardEditTimes {
    const rate = this.buffer.sampleRate;
    return { start: this.frames.start / rate, end: this.frames.end / rate,
      fadeIn: this.frames.fadeIn / rate, fadeOut: this.frames.fadeOut / rate };
  }

  public setPlaybackTime(seconds: number): void {
    this.playbackTime = seconds;
    const frame = Math.min(this.frames.end, this.frames.start + seconds * this.buffer.sampleRate);
    this.root.querySelector<HTMLElement>('.sb-waveform-playhead')!.style.left =
      `${18 + frame / this.buffer.length * Math.max(1, this.root.clientWidth - 36)}px`;
  }

  public cancelDrag(): boolean {
    if (!this.active) return false;
    this.release(true);
    return true;
  }

  private position(handle: Handle): number {
    return handle === 'fadeIn' ? this.frames.start + this.frames.fadeIn
      : handle === 'fadeOut' ? this.frames.end - this.frames.fadeOut : this.frames[handle];
  }

  private bounds(handle: Handle): [number, number] {
    const { start, end, fadeIn, fadeOut } = this.frames;
    return handle === 'start' ? [0, end - 1] : handle === 'end' ? [start + 1, this.buffer.length]
      : handle === 'fadeIn' ? [start, end - fadeOut] : [start + fadeIn, end];
  }

  private set(handle: Handle, value: number): void {
    const [min, max] = this.bounds(handle);
    const position = Math.max(min, Math.min(max, Math.round(value)));
    if (this.position(handle) === position) return;
    if (handle === 'fadeIn') this.frames.fadeIn = position - this.frames.start;
    else if (handle === 'fadeOut') this.frames.fadeOut = this.frames.end - position;
    else this.frames[handle] = position;
    const span = this.frames.end - this.frames.start;
    const sum = this.frames.fadeIn + this.frames.fadeOut;
    const adjusted = sum > span;
    if (adjusted) {
      this.frames.fadeIn = Math.round(this.frames.fadeIn * span / sum);
      this.frames.fadeOut = span - this.frames.fadeIn;
    }
    this.root.querySelector<HTMLElement>('[data-fade-adjustment]')!.textContent = adjusted ? t('soundboard.fadesAdjusted') : '';
    this.render(); this.changed(this.values());
  }

  private release(cancel: boolean): void {
    const active = this.active;
    if (!active) return;
    this.active = null;
    if (cancel) {
      Object.assign(this.frames, active.before);
      this.root.querySelector<HTMLElement>('[data-fade-adjustment]')!.textContent = '';
      this.render(); this.changed(this.values());
    }
    if (active.button.hasPointerCapture(active.id)) active.button.releasePointerCapture(active.id);
  }

  public setDisabled(disabled: boolean): void {
    if (disabled) this.release(true);
    this.disabled = disabled;
    this.root.querySelectorAll<HTMLButtonElement>('[data-handle]').forEach(button => { button.disabled = disabled; });
  }

  private render(): void {
    if (this.controller.signal.aborted) return;
    const width = Math.max(1, this.root.clientWidth), height = 208;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(width * dpr); this.canvas.height = Math.round(height * dpr);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    const style = getComputedStyle(this.root);
    const color = (name: string) => style.getPropertyValue(name).trim();
    const x = (frame: number) => 18 + frame / this.buffer.length * Math.max(1, width - 36);
    const { start, end, fadeIn, fadeOut } = this.frames;
    const handleWidth = this.root.querySelector<HTMLButtonElement>('[data-handle]')!.offsetWidth;
    this.root.classList.toggle('has-crop-overlap', x(end) - x(start) < handleWidth);
    this.root.classList.toggle('has-fade-overlap', x(end - fadeOut) - x(start + fadeIn) < handleWidth);
    const top = 55, bottom = 150, waveHeight = (bottom - top) / this.peaks.length;
    ctx.fillStyle = color('--bg-input'); ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = color('--bg-tertiary'); ctx.fillRect(x(start), top, x(end) - x(start), bottom - top);
    ctx.strokeStyle = color('--text-secondary'); ctx.lineWidth = 1;
    for (const [channel, peaks] of this.peaks.entries()) {
      const middle = top + waveHeight * (channel + 0.5), amplitude = waveHeight * 0.45;
      ctx.beginPath(); ctx.moveTo(18, middle); ctx.lineTo(width - 18, middle);
      const count = peaks.length / 2;
      for (let bin = 0; bin < count; bin++) {
        const px = 18 + bin / count * (width - 36);
        ctx.moveTo(px, middle - Math.min(1, peaks[bin * 2 + 1]) * amplitude);
        ctx.lineTo(px, middle - Math.max(-1, peaks[bin * 2]) * amplitude);
      }
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(18, top, x(start) - 18, bottom - top);
    ctx.fillRect(x(end), top, width - 18 - x(end), bottom - top);
    ctx.strokeStyle = color('--accent-primary'); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x(start), bottom);
    ctx.lineTo(x(start + fadeIn), top); ctx.lineTo(x(end - fadeOut), top); ctx.lineTo(x(end), bottom); ctx.stroke();
    for (const handle of HANDLES) {
      const position = this.position(handle), [minimum, maximum] = this.bounds(handle);
      const button = this.root.querySelector<HTMLButtonElement>(`[data-handle="${handle}"]`)!;
      button.style.left = `${x(position)}px`;
      const fade = handle === 'fadeIn' || handle === 'fadeOut';
      button.setAttribute('aria-valuemin', String(fade ? 0 : minimum / this.buffer.sampleRate));
      button.setAttribute('aria-valuemax', String((fade ? maximum - minimum : maximum) / this.buffer.sampleRate));
      button.setAttribute('aria-valuenow', String(this.frames[handle] / this.buffer.sampleRate));
      button.setAttribute('aria-valuetext', `${t(`soundboard.edit.${handle}`)}: ${this.format.format(this.frames[handle] / this.buffer.sampleRate)}`);
      this.root.querySelector<HTMLOutputElement>(`[data-time="${handle}"]`)!.textContent =
        `${this.format.format(this.frames[handle] / this.buffer.sampleRate)} s`;
      ctx.strokeStyle = color('--text-muted'); ctx.lineWidth = 1;
      ctx.setLineDash(handle === 'start' || handle === 'end' ? [] : [3, 3]);
      ctx.beginPath(); ctx.moveTo(x(position), 45); ctx.lineTo(x(position), 158); ctx.stroke();
    }
    ctx.setLineDash([]);
    this.setPlaybackTime(this.playbackTime);
  }

  public dispose(): void {
    this.release(true);
    this.controller.abort(); this.resize.disconnect();
  }
}
