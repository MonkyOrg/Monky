import { appEvents } from '../core/EventBus';
import { soundboardService, ActiveSoundPlayback } from '../core/SoundboardService';
import { t } from '../i18n';
import { escapeHtml } from '../utils/html';

interface PlaybackProgressPayload {
  userId?: string;
  percent?: number;
  currentTime?: number;
  duration?: number;
}

/** Matches the `.sb-notice-bar.is-leaving` animation in theme.css. */
const EXIT_ANIMATION_MS = 160;

/**
 * Shared sidebar/modal transport view. Mounting never starts or stops audio.
 */
export class SoundboardPlayersBar {
  private slot: HTMLElement | null = null;
  private unbindEvents: Array<() => void> = [];
  private readonly removalTimers = new Map<string, number>();

  public mount(slot: HTMLElement): void {
    this.unmount();
    this.slot = slot;
    slot.addEventListener('click', this.handleClick);
    this.sync();

    const onStarted = () => this.sync();
    const onProgress = (payload: PlaybackProgressPayload) => this.updateProgress(payload);
    const onEnded = () => this.sync();

    appEvents.on('soundboard.playback_started', onStarted);
    appEvents.on('soundboard.playback_progress', onProgress);
    appEvents.on('soundboard.playback_ended', onEnded);
    appEvents.on('soundboard.playback_changed', onStarted);

    this.unbindEvents.push(() => {
      appEvents.off('soundboard.playback_started', onStarted);
      appEvents.off('soundboard.playback_progress', onProgress);
      appEvents.off('soundboard.playback_ended', onEnded);
      appEvents.off('soundboard.playback_changed', onStarted);
    });
  }

  public unmount(): void {
    this.slot?.removeEventListener('click', this.handleClick);
    this.unbindEvents.forEach((unbind) => unbind());
    this.unbindEvents = [];
    for (const timer of this.removalTimers.values()) window.clearTimeout(timer);
    this.removalTimers.clear();
    this.slot = null;
  }

  private handleClick = (event: Event): void => {
    const button = (event.target as HTMLElement | null)?.closest('.sb-notice-stop-btn');
    const userId = button?.closest('.sb-notice-bar')?.getAttribute('data-userid');
    if (userId) soundboardService.stopSoundFromUi(userId);
  };

  /**
   * Reconciles the bars with what is actually playing instead of repainting the
   * slot: a full repaint would restart the entrance animation of every bar
   * whenever anyone else started a sound.
   */
  private sync(): void {
    if (!this.slot) return;

    const playbacks = soundboardService.getActivePlaybacks(true);
    const activeIds = new Set(playbacks.map((p) => p.userId));

    for (const bar of Array.from(this.slot.children) as HTMLElement[]) {
      const userId = bar.getAttribute('data-userid') || '';
      if (!activeIds.has(userId)) this.removeBar(bar, userId);
    }

    for (const playback of playbacks) {
      const existing = this.slot.querySelector(
        `[data-userid="${CSS.escape(playback.userId)}"]`
      ) as HTMLElement | null;

      if (existing) {
        existing.classList.toggle('is-paused', playback.audio.paused);
        // The same user swapped sounds (#156): the previous bar is mid-exit
        // because its `playback_ended` fired a tick before the new sound's
        // `playback_started`. Cancel the pending removal, bring the bar back and
        // repaint it so the label, progress and duration follow the new sound —
        // otherwise the stale exit timer wiped the bar and the second sound's
        // progress never showed up (#517).
        this.cancelRemoval(playback.userId);
        existing.classList.remove('is-leaving');
        if (existing.getAttribute('data-sound') !== playback.soundName) {
          existing.setAttribute('data-sound', playback.soundName);
          existing.innerHTML = this.renderBarInnerHtml(playback);
        }
        this.updateProgress({
          userId: playback.userId, currentTime: playback.audio.currentTime, duration: playback.audio.duration,
          percent: playback.audio.duration > 0 ? playback.audio.currentTime / playback.audio.duration * 100 : 0,
        });
        continue;
      }

      const bar = document.createElement('div');
      bar.className = 'sb-notice-bar';
      bar.classList.toggle('is-paused', playback.audio.paused);
      bar.setAttribute('data-userid', playback.userId);
      bar.setAttribute('data-sound', playback.soundName);
      bar.innerHTML = this.renderBarInnerHtml(playback);
      this.slot.appendChild(bar);
    }
  }

  private removeBar(bar: HTMLElement, userId: string): void {
    if (this.removalTimers.has(userId)) return;
    bar.classList.add('is-leaving');
    const timer = window.setTimeout(() => {
      this.removalTimers.delete(userId);
      bar.remove();
    }, EXIT_ANIMATION_MS);
    this.removalTimers.set(userId, timer);
  }

  private cancelRemoval(userId: string): void {
    const timer = this.removalTimers.get(userId);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      this.removalTimers.delete(userId);
    }
  }

  private updateProgress(payload: PlaybackProgressPayload): void {
    if (!this.slot || !payload?.userId) return;
    const bar = this.slot.querySelector(`[data-userid="${CSS.escape(payload.userId)}"]`);
    if (!bar) return;
    const fill = bar.querySelector('.sb-notice-progress-fill') as HTMLElement | null;
    if (fill) fill.style.width = `${Math.min(100, Math.max(0, payload.percent || 0))}%`;
    const track = bar.querySelector('.sb-notice-progress-track');
    track?.setAttribute('aria-valuenow', String(Math.min(100, Math.max(0, payload.percent || 0))));
    const time = bar.querySelector('.sb-notice-time') as HTMLElement | null;
    if (time && typeof payload.currentTime === 'number' && typeof payload.duration === 'number') {
      time.textContent = this.formatTimePair(payload.currentTime, payload.duration);
    }
  }

  /** `m:ss`, or `--:--` while the metadata (and therefore duration) is unknown. */
  private formatTime(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
    const total = Math.floor(seconds);
    const minutes = Math.floor(total / 60);
    const secs = total % 60;
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  }

  private formatTimePair(currentTime: number, duration: number): string {
    return `${this.formatTime(currentTime)} / ${this.formatTime(duration)}`;
  }

  private renderBarInnerHtml(playback: ActiveSoundPlayback): string {
    const label = playback.userName
      ? `${playback.soundName} · ${playback.userName}`
      : playback.soundName;
    const currentTime = playback.audio.currentTime || 0;
    const duration = playback.audio.duration || 0;
    const percent = duration > 0 ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0;
    return `
      <span class="material-symbols-outlined md-16 sb-notice-icon">volume_up</span>
      <div class="sb-notice-body">
        <span class="sb-notice-text" title="${escapeHtml(label)}">${escapeHtml(label)}</span>
        <div class="sb-notice-progress-row">
          <div class="sb-notice-progress-track" role="progressbar" aria-label="${escapeHtml(t('soundboard.playbackProgress'))}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}">
            <div class="sb-notice-progress-fill" style="width: ${percent}%"></div>
          </div>
          <span class="sb-notice-time">${escapeHtml(this.formatTimePair(currentTime, duration))}</span>
        </div>
      </div>
      <button type="button" class="sb-notice-stop-btn" title="${t('soundboard.stopPlayback')}" aria-label="${t('soundboard.stopPlayback')}">
        <span class="material-symbols-outlined md-16">stop</span>
      </button>
    `;
  }
}

export const soundboardPlayersBar = new SoundboardPlayersBar();
