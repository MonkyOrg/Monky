import { v4 as uuidv4 } from 'uuid';
import type { SoundDownloadFailureReason } from '@monky/shared';
import { appEvents } from './EventBus';
import { settingsStore } from '../stores/settingsStore';
import { t, type TranslationKey } from '../i18n';
import { formatMediaTime } from '../utils/videoPlayer';
import { setAudioOutputSink } from './AudioOutputSink';

const DEFAULT_PREVIEW_VOLUME = 60;
const MAX_PREVIEW_VOLUMES = 256;
const scopeVolumes = new Map<string, number>();

interface ActivePreview {
  key: string;
  volumeScope: string;
  requestId: string;
  controls: HTMLElement;
  audio?: HTMLAudioElement;
  objectUrl?: string;
  loading: boolean;
  wantsPlayback: boolean;
  sinkTarget?: string;
  sinkQueue: Promise<void>;
  unbindAudio: () => void;
  unbindSettings: () => void;
}

const FAILURE_KEYS: Record<SoundDownloadFailureReason, TranslationKey> = {
  no_folder: 'botChat.downloadNoFolder',
  invalid_request: 'botChat.downloadInvalidRequest',
  invalid_url: 'botChat.downloadInvalidUrl',
  blocked_url: 'botChat.downloadBlockedUrl',
  invalid_file_name: 'botChat.downloadInvalidName',
  unsupported_audio: 'botChat.downloadUnsupported',
  too_large: 'botChat.downloadTooLarge',
  http_error: 'botChat.downloadHttpError',
  network_error: 'botChat.downloadNetworkError',
  write_failed: 'botChat.downloadWriteFailed',
  timeout: 'botChat.downloadTimeout',
};

export function getAudioPreviewVolume(scope: string): number {
  return scopeVolumes.get(scope) ?? DEFAULT_PREVIEW_VOLUME;
}

function clampVolume(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_PREVIEW_VOLUME;
  return Math.max(0, Math.min(100, Math.round(parsed)));
}

function stopEvent(event: Event): void {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
}

export class AudioPreviewService {
  private active: ActivePreview | null = null;

  public bind(root: HTMLElement): () => void {
    const click = (event: MouseEvent) => this.onClick(event);
    const input = (event: Event) => this.onVolumeInput(event);
    const keydown = (event: KeyboardEvent) => this.onKeyDown(event);
    root.addEventListener('click', click, true);
    root.addEventListener('input', input, true);
    root.addEventListener('change', input, true);
    root.addEventListener('keydown', keydown, true);
    return () => {
      root.removeEventListener('click', click, true);
      root.removeEventListener('input', input, true);
      root.removeEventListener('change', input, true);
      root.removeEventListener('keydown', keydown, true);
      this.release(root);
    };
  }

  public ownsEventTarget(target: EventTarget | null): boolean {
    return target instanceof Element && !!target.closest('[data-audio-choice-controls], [data-audio-preview-volume-control]');
  }

  public release(scope?: HTMLElement): void {
    if (!this.active) return;
    if (!scope || scope.contains(this.active.controls) || !this.active.controls.isConnected) this.stopActive(true);
  }

  public prune(scope: HTMLElement): void {
    if (!this.active) return;
    if (!this.active.controls.isConnected) {
      this.stopActive(true);
      return;
    }
    const stillVisible = [...scope.querySelectorAll<HTMLElement>('[data-audio-choice-controls]')]
      .some((controls) => controls.dataset.audioKey === this.active?.key);
    if (!stillVisible) this.release(scope);
  }

  private onClick(event: MouseEvent): void {
    if (!(event.target instanceof Element)) return;
    const toggle = event.target.closest<HTMLButtonElement>('[data-audio-preview-action="toggle"]');
    const range = event.target.closest<HTMLInputElement>('[data-audio-preview-volume]');
    if (toggle) {
      stopEvent(event);
      const controls = toggle.closest<HTMLElement>('[data-audio-choice-controls]');
      if (controls) void this.toggle(controls);
    } else if (range) {
      event.stopPropagation();
      event.stopImmediatePropagation();
    }
  }

  private onVolumeInput(event: Event): void {
    if (!(event.target instanceof HTMLInputElement) || !event.target.hasAttribute('data-audio-preview-volume')) return;
    event.stopPropagation();
    event.stopImmediatePropagation();
    const controls = event.target.closest<HTMLElement>('[data-audio-preview-volume-control]');
    const scope = controls?.dataset.audioVolumeScope;
    if (!scope) return;
    const volume = clampVolume(event.target.value);
    scopeVolumes.delete(scope);
    scopeVolumes.set(scope, volume);
    if (scopeVolumes.size > MAX_PREVIEW_VOLUMES) {
      const oldest = scopeVolumes.keys().next().value;
      if (oldest !== undefined) scopeVolumes.delete(oldest);
    }
    for (const control of document.querySelectorAll<HTMLElement>('[data-audio-preview-volume-control]')) {
      if (control.dataset.audioVolumeScope !== scope) continue;
      const input = control.querySelector<HTMLInputElement>('[data-audio-preview-volume]');
      const percentage = control.querySelector<HTMLElement>('[data-audio-preview-percentage]');
      if (input) {
        input.value = String(volume);
        input.style.setProperty('--slider-fill', `${volume}%`);
        input.setAttribute('aria-valuetext', `${volume}%`);
      }
      if (percentage) percentage.textContent = `${volume}%`;
    }
    if (this.active?.volumeScope === scope && this.active.audio) this.active.audio.volume = volume / 100;
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (this.ownsEventTarget(event.target)) {
      event.stopPropagation();
      event.stopImmediatePropagation();
    }
  }

  private async toggle(controls: HTMLElement): Promise<void> {
    const key = controls.dataset.audioKey;
    const url = controls.dataset.audioUrl;
    const volumeScope = controls.dataset.audioVolumeScope;
    if (!key || !url || !volumeScope || !controls.isConnected) return;
    if (this.active?.key === key) {
      const active = this.active;
      if (!active.audio) {
        this.stopActive(true);
      } else {
        active.wantsPlayback = !active.wantsPlayback;
        if (active.wantsPlayback) await this.playActive(active);
        else active.audio.pause();
        this.updateControls();
      }
      return;
    }
    this.stopActive(true);
    const requestId = uuidv4();
    const active: ActivePreview = {
      key, volumeScope, requestId, controls, loading: true, wantsPlayback: true, sinkQueue: Promise.resolve(),
      unbindAudio: () => {}, unbindSettings: () => {},
    };
    this.active = active;
    active.unbindSettings = appEvents.on('settings.updated', () => {
      if (!this.isCurrent(active) || !active.audio || active.sinkTarget === settingsStore.getAudioOutputDeviceId('media')) return;
      active.audio.pause();
      void this.playActive(active);
    });
    this.setControlsState(controls, 'loading', t('botChat.audioPreviewLoading'));
    try {
      const result = await window.api?.loadAudioPreview?.({
        requestId, url, fileName: controls.dataset.audioFileName,
      });
      if (!this.isCurrent(active)) return;
      active.loading = false;
      if (!result || result.status === 'failed') {
        const reason = result?.status === 'failed' ? result.reason : 'invalid_request';
        this.stopActive(false, false);
        this.setControlsState(controls, 'failed', t(FAILURE_KEYS[reason]));
        return;
      }
      if (result.status === 'cancelled') {
        this.stopActive(false);
        return;
      }
      const bytes = new Uint8Array(result.data.byteLength);
      bytes.set(result.data);
      const audio = new Audio();
      const objectUrl = URL.createObjectURL(new Blob([bytes.buffer], { type: result.mimeType }));
      audio.src = objectUrl;
      audio.preload = 'auto';
      audio.volume = getAudioPreviewVolume(volumeScope) / 100;
      const update = () => { if (this.isCurrent(active)) this.updateControls(); };
      const ended = () => { if (this.isCurrent(active)) { active.wantsPlayback = false; this.updateControls(); } };
      const failed = () => this.failActive(active, 'botChat.audioPreviewPlaybackFailed', audio.error);
      audio.addEventListener('ended', ended);
      audio.addEventListener('pause', update);
      audio.addEventListener('play', update);
      audio.addEventListener('error', failed);
      const progressEvents = ['timeupdate', 'loadedmetadata', 'durationchange', 'seeked'] as const;
      const progress = () => { if (this.isCurrent(active)) this.updateProgress(controls, audio); };
      for (const event of progressEvents) audio.addEventListener(event, progress);
      active.unbindAudio = () => {
        audio.removeEventListener('ended', ended);
        audio.removeEventListener('pause', update);
        audio.removeEventListener('play', update);
        audio.removeEventListener('error', failed);
        for (const event of progressEvents) audio.removeEventListener(event, progress);
      };
      active.audio = audio;
      active.objectUrl = objectUrl;
      await this.playActive(active);
    } catch (error) {
      this.failActive(active, 'botChat.audioPreviewPlaybackFailed', error);
    }
  }

  private isCurrent(active: ActivePreview): boolean {
    if (this.active !== active) return false;
    if (active.controls.isConnected) return true;
    this.stopActive(true);
    return false;
  }

  private failActive(active: ActivePreview, key: TranslationKey, error: unknown): void {
    if (!this.isCurrent(active)) return;
    console.warn('Could not play audio preview.', error);
    this.stopActive(true, false);
    this.setControlsState(active.controls, 'failed', t(key));
  }

  private async playActive(active: ActivePreview): Promise<void> {
    if (!active.audio || !this.isCurrent(active)) return;
    const audio = active.audio;
    const routing = this.routeActiveAudio(active, audio);
    try {
      await routing;
    } catch (error) {
      if (active.sinkQueue === routing) this.failActive(active, 'botChat.audioPreviewOutputFailed', error);
      return;
    }
    if (!this.isCurrent(active) || active.sinkQueue !== routing || !active.wantsPlayback) return;
    try {
      await audio.play();
    } catch (error) {
      if (this.isCurrent(active) && active.wantsPlayback && active.sinkQueue === routing) {
        active.wantsPlayback = false;
        console.warn('Could not start audio preview playback.', error);
        this.setControlsState(active.controls, 'failed', t('botChat.audioPreviewPlaybackFailed'));
      }
    }
  }

  private routeActiveAudio(active: ActivePreview, audio: HTMLAudioElement): Promise<void> {
    active.sinkTarget = settingsStore.getAudioOutputDeviceId('media');
    const route = async () => {
      if (!this.isCurrent(active)) return;
      await setAudioOutputSink(audio, settingsStore.getAudioOutputDeviceId('media'));
    };
    // Older sink changes must finish before a newer one can select the output.
    const routing = active.sinkQueue.then(route, route);
    active.sinkQueue = routing;
    return routing;
  }

  private stopActive(cancelRequest: boolean, resetControls = true): void {
    const active = this.active;
    if (!active) return;
    this.active = null;
    active.unbindSettings();
    active.unbindAudio();
    if (active.loading && cancelRequest) {
      const cancellation = window.api?.cancelAudioPreview?.({ requestId: active.requestId });
      if (cancellation) {
        void cancellation.catch((error: unknown) => {
          console.warn('Could not cancel audio preview.', error);
        });
      }
    }
    if (active.audio) {
      active.audio.pause();
      active.audio.removeAttribute('src');
      active.audio.load();
    }
    if (active.objectUrl) URL.revokeObjectURL(active.objectUrl);
    if (resetControls && active.controls.isConnected) this.setControlsState(active.controls, 'idle');
  }

  private updateControls(): void {
    const active = this.active;
    if (!active?.controls.isConnected) {
      this.stopActive(true);
      return;
    }
    if (!active.audio) {
      this.setControlsState(active.controls, active.loading ? 'loading' : 'idle');
      return;
    }
    this.setControlsState(active.controls, active.audio.paused ? 'ready' : 'playing');
  }

  private setControlsState(controls: HTMLElement, state: 'idle' | 'loading' | 'ready' | 'playing' | 'failed', message = ''): void {
    controls.dataset.audioPreviewState = state;
    const icon = controls.querySelector<HTMLElement>('[data-audio-preview-icon]');
    const button = controls.querySelector<HTMLButtonElement>('[data-audio-preview-action="toggle"]');
    const status = controls.querySelector<HTMLElement>('[data-audio-preview-status]');
    if (icon) {
      icon.textContent = state === 'loading' ? 'hourglass_empty' :
        state === 'playing' ? 'pause' :
          state === 'failed' ? 'error' : 'play_arrow';
    }
    if (button) {
      const label = state === 'playing' ? t('botChat.audioPreviewPause') : t('botChat.audioPreviewPlay');
      button.setAttribute('aria-label', `${label}: ${controls.dataset.audioLabel ?? ''}`);
      button.title = label;
      button.disabled = false;
    }
    if (status) {
      const text = message || (state === 'playing' ? t('botChat.audioPreviewPlaying') :
        state === 'ready' ? t('botChat.audioPreviewReady') :
          state === 'loading' ? t('botChat.audioPreviewLoading') : '');
      if (status.textContent !== text) status.textContent = text;
      status.title = status.textContent ?? '';
    }
    this.updateProgress(controls, this.active?.controls === controls ? this.active.audio : undefined);
  }

  private updateProgress(controls: HTMLElement, audio?: HTMLAudioElement): void {
    const hintedDuration = Number(controls.dataset.audioDurationMs) / 1000;
    const duration = audio && Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration :
      Number.isFinite(hintedDuration) && hintedDuration > 0 ? hintedDuration : undefined;
    const elapsed = audio && Number.isFinite(audio.currentTime) ? Math.max(0, audio.currentTime) : 0;
    const current = duration === undefined ? elapsed : audio?.ended ? duration : Math.min(elapsed, duration);
    const progress = controls.querySelector<HTMLProgressElement>('[data-audio-preview-progress]');
    const time = controls.querySelector<HTMLElement>('[data-audio-preview-time]');
    const label = `${formatMediaTime(current)} / ${duration === undefined ? '--:--' : formatMediaTime(duration)}`;
    if (progress) {
      progress.max = duration ?? 1;
      progress.value = duration === undefined ? 0 : current;
      progress.setAttribute('aria-valuetext', label);
    }
    if (time && time.textContent !== label) time.textContent = label;
  }
}

export const audioPreviewService = new AudioPreviewService();
