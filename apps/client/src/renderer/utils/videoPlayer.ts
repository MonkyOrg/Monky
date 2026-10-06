import { t } from '../i18n';
import { playChatMedia, routeChatMedia } from '../core/ChatMediaOutput';

export function formatMediaTime(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) {
    return [hours, minutes, secs].map((part, index) => (index === 0 ? `${part}` : `${part}`.padStart(2, '0'))).join(':');
  }
  return `${minutes}`.padStart(2, '0') + `:${`${secs}`.padStart(2, '0')}`;
}

export function initializeCustomMediaPlayers(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('.chat-video-player, .chat-audio-player').forEach((player) => {
    if (player.dataset.enhanced === 'true') return;
    player.dataset.enhanced = 'true';

    const video = player.querySelector('video') as HTMLVideoElement | null;
    const audio = player.querySelector('audio') as HTMLAudioElement | null;
    const media = video ?? audio;
    if (!media) return;
    const isVideo = !!video;

    media.controls = false;
    media.removeAttribute('controls');
    if (video) video.playsInline = true;
    media.volume = media.volume || 0.8;
    void routeChatMedia(media).catch((error: unknown) => {
      console.warn('[MediaPlayer] Could not select the configured media output:', error);
    });

    const bigPlay = isVideo ? document.createElement('button') : null;
    if (bigPlay) {
      bigPlay.type = 'button';
      bigPlay.className = 'chat-video-big-play';
      bigPlay.title = t('common.play');
      bigPlay.innerHTML = '<span class="material-symbols-outlined md-36">play_arrow</span>';
    }

    const controls = document.createElement('div');
    controls.className = isVideo ? 'chat-video-controls' : 'chat-video-controls chat-audio-controls';
    const seekLabel = t(isVideo ? 'chat.videoSeek' : 'chat.audioSeek');
    const volumeLabel = t(isVideo ? 'chat.videoVolume' : 'chat.audioVolume');
    const volumePopup = `
      <div class="stage-volume-popup chat-video-volume-popup">
        <span class="chat-media-track" aria-hidden="true"></span>
        <input
          type="range"
          class="chat-media-slider chat-video-volume"
          min="0"
          max="1"
          step="0.05"
          value="${media.volume || 0.8}"
          aria-label="${volumeLabel}"
          title="${volumeLabel}"
        >
      </div>`;
    const volumeButton = `
      <button type="button" class="chat-video-control-btn stage-volume-btn" data-action="mute" title="${t('common.mute')}">
        <span class="material-symbols-outlined md-20">volume_up</span>
      </button>`;
    controls.innerHTML = `
      <div class="chat-video-progress-shell">
        <span class="chat-media-track" aria-hidden="true"></span>
        <input
          type="range"
          class="chat-media-slider chat-video-seek"
          min="0"
          max="100"
          step="0.1"
          value="0"
          style="--slider-progress: 0%;"
          aria-label="${seekLabel}"
          title="${seekLabel}"
        >
      </div>
      <div class="chat-video-controls-row">
        <button type="button" class="chat-video-control-btn" data-action="play" title="${t('common.play')}">
          <span class="material-symbols-outlined md-20">play_arrow</span>
        </button>
        <div class="stage-volume-wrapper chat-video-volume-wrapper">
          ${isVideo ? volumePopup + volumeButton : volumeButton + volumePopup}
        </div>
        <div class="chat-video-time">00:00 / --:--</div>
        ${isVideo ? `<button type="button" class="chat-video-control-btn" data-action="fullscreen" title="${t('common.fullscreen')}">
          <span class="material-symbols-outlined md-20">fullscreen</span>
        </button>` : ''}
      </div>
    `;

    if (bigPlay) player.append(bigPlay);
    player.append(controls);

    const playButton = controls.querySelector('[data-action="play"]') as HTMLButtonElement | null;
    const playIcon = playButton?.querySelector('.material-symbols-outlined') as HTMLElement | null;
    const muteButton = controls.querySelector('[data-action="mute"]') as HTMLButtonElement | null;
    const muteIcon = muteButton?.querySelector('.material-symbols-outlined') as HTMLElement | null;
    const fullscreenButton = controls.querySelector('[data-action="fullscreen"]') as HTMLButtonElement | null;
    const fullscreenIcon = fullscreenButton?.querySelector('.material-symbols-outlined') as HTMLElement | null;
    const progress = controls.querySelector('.chat-video-seek') as HTMLInputElement | null;
    const volume = controls.querySelector('.chat-video-volume') as HTMLInputElement | null;
    const volumeWrapper = controls.querySelector('.chat-video-volume-wrapper') as HTMLElement | null;
    const timeDisplay = controls.querySelector('.chat-video-time') as HTMLElement | null;
    let lastVolume = media.volume || 0.8;

    const syncRangeFill = (input: HTMLInputElement, ratio: number) => {
      const percent = `${Math.max(0, Math.min(ratio * 100, 100))}%`;
      input.style.setProperty('--slider-progress', percent);
      input.style.setProperty('--value', percent);
      input.parentElement?.style.setProperty('--slider-progress', percent);
    };

    const getVolumeIcon = (level: number) => {
      if (level <= 0.001) return 'volume_off';
      if (level < 0.5) return 'volume_down';
      return 'volume_up';
    };

    const updatePlayState = () => {
      const paused = media.paused || media.ended;
      player.classList.toggle('is-paused', paused);
      if (playIcon) playIcon.innerText = paused ? 'play_arrow' : 'pause';
      if (playButton) playButton.title = paused ? t('common.play') : t('common.pause');
      if (bigPlay) bigPlay.title = paused ? t('common.play') : t('common.pause');
    };

    const updateTimeline = () => {
      const duration = Number.isFinite(media.duration) ? media.duration : 0;
      const current = Number.isFinite(media.currentTime) ? media.currentTime : 0;
      if (timeDisplay) {
        timeDisplay.innerText = `${formatMediaTime(current)} / ${duration > 0 ? formatMediaTime(duration) : '--:--'}`;
      }
      if (progress) {
        const ratio = duration > 0 ? current / duration : 0;
        progress.value = `${ratio * 100}`;
        syncRangeFill(progress, ratio);
      }
    };

    const updateVolumeState = () => {
      const level = media.muted ? 0 : media.volume;
      if (muteIcon) muteIcon.innerText = getVolumeIcon(level);
      if (muteButton) muteButton.title = level <= 0.001 ? t('common.unmute') : t('common.mute');
      if (volume) {
        volume.value = `${level}`;
        syncRangeFill(volume, level);
      }
    };

    const updateFullscreenState = () => {
      const isFullscreen = document.fullscreenElement === player;
      if (fullscreenIcon) fullscreenIcon.innerText = isFullscreen ? 'fullscreen_exit' : 'fullscreen';
      if (fullscreenButton) {
        fullscreenButton.title = isFullscreen ? t('common.exitFullscreen') : t('common.fullscreen');
      }
    };

    const togglePlay = async () => {
      try {
        if (media.paused || media.ended) {
          if (media.ended) media.currentTime = 0;
          await playChatMedia(media);
        } else {
          media.pause();
        }
      } catch (err) {
        console.warn('[MediaPlayer] Unable to toggle playback:', err);
      }
    };

    player.querySelectorAll('.chat-attachment-action').forEach((button) => {
      button.addEventListener('click', (e) => e.stopPropagation());
    });
    controls.addEventListener('pointerdown', (e) => e.stopPropagation());
    controls.addEventListener('click', (e) => e.stopPropagation());
    controls.addEventListener('dblclick', (e) => e.stopPropagation());
    playButton?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      void togglePlay();
    });
    bigPlay?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      void togglePlay();
    });
    if (video) {
      video.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        void togglePlay();
      });
      video.addEventListener('dblclick', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
    }

    progress?.addEventListener('input', (e) => {
      const target = e.currentTarget as HTMLInputElement;
      const duration = Number.isFinite(media.duration) ? media.duration : 0;
      const ratio = Number(target.value) / 100;
      syncRangeFill(target, ratio);
      if (duration > 0) {
        media.currentTime = duration * ratio;
        updateTimeline();
      }
    });

    muteButton?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (media.muted || media.volume <= 0.001) {
        media.muted = false;
        media.volume = lastVolume > 0 ? lastVolume : 0.8;
      } else {
        lastVolume = media.volume;
        media.muted = true;
      }
      updateVolumeState();
    });

    volume?.addEventListener('input', (e) => {
      const target = e.currentTarget as HTMLInputElement;
      const nextVolume = Number(target.value);
      media.muted = nextVolume <= 0.001;
      media.volume = nextVolume;
      if (nextVolume > 0.001) lastVolume = nextVolume;
      syncRangeFill(target, nextVolume);
      updateVolumeState();
    });
    volume?.addEventListener('pointerdown', (e) => {
      volumeWrapper?.classList.add('dragging');
      try { volume.setPointerCapture((e as PointerEvent).pointerId); } catch { /* ignore */ }
    });
    const endVolumeDrag = () => volumeWrapper?.classList.remove('dragging');
    volume?.addEventListener('pointerup', endVolumeDrag);
    volume?.addEventListener('lostpointercapture', endVolumeDrag);

    fullscreenButton?.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        if (document.fullscreenElement === player) {
          await document.exitFullscreen();
        } else {
          await player.requestFullscreen();
        }
      } catch (err) {
        console.warn('[VideoPlayer] Unable to toggle video fullscreen:', err);
      }
      updateFullscreenState();
    });

    player.addEventListener('mouseenter', updateFullscreenState);
    media.addEventListener('play', updatePlayState);
    media.addEventListener('pause', updatePlayState);
    media.addEventListener('ended', updatePlayState);
    media.addEventListener('loadedmetadata', updateTimeline);
    media.addEventListener('durationchange', updateTimeline);
    media.addEventListener('timeupdate', updateTimeline);
    media.addEventListener('volumechange', updateVolumeState);

    updatePlayState();
    updateTimeline();
    updateVolumeState();
    updateFullscreenState();
  });
}

export const initializeCustomVideoPlayers = initializeCustomMediaPlayers;
