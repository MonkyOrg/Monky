import { appEvents } from '../core/EventBus';
import { soundboardService } from '../core/SoundboardService';
import { getLanguage, t } from '../i18n';

export class SoundboardEditorPlayer {
  private readonly controller = new AbortController();
  private readonly unbind: Array<() => void> = [];
  private readonly play: HTMLButtonElement;
  private readonly seek: HTMLInputElement;
  private readonly time: HTMLOutputElement;
  private readonly format = new Intl.NumberFormat(getLanguage(), { minimumFractionDigits: 3, maximumFractionDigits: 3 });
  private position = 0;
  private duration = 0;
  private bytes: Uint8Array | null = null;
  private busy = false;
  private disabled = false;
  private generation = 0;
  private frame: number | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly soundName: string,
    private readonly encode: () => { bytes: Uint8Array; duration: number },
    private readonly onPosition: (seconds: number) => void,
    private readonly onError: (error: unknown | null) => void,
  ) {
    root.className = 'sb-editor-player';
    root.innerHTML = `<div class="sb-editor-player-heading">${t('soundboard.player.result')}</div>
      <div class="sb-editor-transport" role="group" aria-label="${t('soundboard.player.result')}">
        <button type="button" class="btn btn-secondary" data-player-restart
          title="${t('soundboard.player.restart')}" aria-label="${t('soundboard.player.restart')}">
          <span class="material-symbols-outlined" aria-hidden="true">skip_previous</span></button>
        <button type="button" class="btn btn-primary" data-player-play></button>
        <button type="button" class="btn btn-secondary" data-player-stop
          title="${t('soundboard.player.stop')}" aria-label="${t('soundboard.player.stop')}">
          <span class="material-symbols-outlined" aria-hidden="true">stop</span></button>
        <output data-player-time></output>
      </div>
      <input type="range" class="sb-slider" data-player-seek min="0" max="0" step="0.001" value="0"
        aria-label="${t('soundboard.player.seek')}">
      <p class="sb-editor-help">${t('soundboard.player.help')}</p>`;
    this.play = root.querySelector('[data-player-play]')!;
    this.seek = root.querySelector('[data-player-seek]')!;
    this.time = root.querySelector('[data-player-time]')!;
    const { signal } = this.controller;
    this.play.addEventListener('click', () => { void this.toggle(); }, { signal });
    root.querySelector('[data-player-restart]')!.addEventListener('click', () => this.seekTo(0), { signal });
    root.querySelector('[data-player-stop]')!.addEventListener('click', () => this.stop(), { signal });
    this.seek.addEventListener('input', () => this.seekTo(Number(this.seek.value)), { signal });
    for (const event of ['soundboard.playback_started', 'soundboard.playback_changed', 'soundboard.playback_progress']) {
      this.unbind.push(appEvents.on<{ userId?: string }>(event, data => {
        if (data?.userId === 'editor-preview') this.render();
      }));
    }
    this.unbind.push(appEvents.on<{ userId?: string; ended?: boolean; failed?: boolean }>('soundboard.playback_ended', data => {
      if (data?.userId !== 'editor-preview') return;
      this.position = data.ended ? this.duration : 0;
      if (data.failed) this.onError(new Error(t('soundboard.previewFailed')));
      this.render();
    }));
  }

  private get audio(): HTMLAudioElement | undefined {
    return soundboardService.getActivePlaybacks(true).find(entry => entry.userId === 'editor-preview')?.audio;
  }

  public reset(duration: number): void {
    this.stop();
    this.duration = duration;
    this.bytes = null;
    this.render();
  }

  public stop(): void {
    this.generation++;
    this.busy = false;
    soundboardService.stopEditorPreview();
    this.position = 0;
    this.render();
  }

  public setDisabled(disabled: boolean): void {
    this.disabled = disabled;
    this.render();
  }

  private seekTo(seconds: number): void {
    if (this.disabled || this.busy) return;
    this.position = Math.max(0, Math.min(this.duration, seconds));
    if (this.audio) this.audio.currentTime = this.position;
    this.render();
  }

  private async toggle(): Promise<void> {
    if (this.disabled || this.busy || this.controller.signal.aborted) return;
    const audio = this.audio;
    if (audio && !audio.paused) { audio.pause(); this.render(); return; }
    const generation = this.generation;
    this.onError(null);
    this.busy = true;
    this.render();
    try {
      if (audio) await audio.play();
      else {
        if (!this.bytes) this.bytes = this.encode().bytes;
        if (this.position >= this.duration) this.position = 0;
        if (!await soundboardService.previewEditedSound(this.bytes, this.soundName, this.position)) {
          throw new Error(t('soundboard.previewFailed'));
        }
      }
    } catch (error: unknown) {
      if (generation === this.generation && !this.controller.signal.aborted) {
        console.warn('[SoundboardEditorPlayer] Could not play edited audio:', error);
        this.stop();
        this.onError(error);
      }
    } finally {
      if (generation === this.generation && !this.controller.signal.aborted) {
        this.busy = false;
        this.render();
      }
    }
  }

  private render(): void {
    if (this.controller.signal.aborted) return;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    const audio = this.audio;
    if (audio) this.position = Math.min(this.duration, audio.currentTime);
    const playing = !!audio && !audio.paused;
    const label = t(this.busy ? 'common.loading' : playing ? 'soundboard.player.pause' : 'soundboard.player.play');
    this.play.setAttribute('aria-label', label);
    this.play.title = label;
    const icon = playing ? 'pause' : 'play_arrow';
    if (this.play.dataset.icon !== icon) {
      this.play.dataset.icon = icon;
      this.play.innerHTML = `<span class="material-symbols-outlined" aria-hidden="true">${icon}</span>`;
    }
    this.seek.max = String(this.duration);
    this.seek.value = String(this.position);
    this.seek.style.setProperty('--slider-progress', `${this.duration > 0 ? this.position / this.duration * 100 : 0}%`);
    this.seek.setAttribute('aria-valuetext', t('soundboard.player.time', {
      current: this.format.format(this.position), duration: this.format.format(this.duration),
    }));
    this.time.textContent = this.seek.getAttribute('aria-valuetext');
    this.root.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input').forEach(control => {
      control.disabled = this.disabled || (this.busy && !control.matches('[data-player-stop]'));
    });
    this.onPosition(this.position);
    if (playing) this.frame = requestAnimationFrame(() => this.render());
  }

  public dispose(): void {
    this.controller.abort();
    this.unbind.forEach(unbind => unbind());
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.stop();
    this.bytes = null;
  }
}
