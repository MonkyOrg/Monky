import { t } from '../i18n';
import { setAudioOutputSink } from './AudioOutputSink';
import { effectiveAudioOutput, registerAudioOutputConsumer } from './audioOutputRouting';

function showOutputError(media: HTMLMediaElement, error: unknown | null): void {
  const player = media.closest<HTMLElement>('.chat-video-player, .chat-audio-player');
  if (!player) return;
  let status = player.querySelector<HTMLElement>('.chat-media-output-error');
  if (error && !status) {
    status = document.createElement('div');
    status.className = 'chat-media-output-error audio-device-status';
    status.setAttribute('role', 'alert');
    status.style.cssText = 'position:absolute;left:10px;right:10px;bottom:52px;padding:8px;background:var(--bg-secondary);border-radius:var(--radius-md);z-index:2;';
    player.append(status);
  }
  if (status) {
    status.textContent = error ? t('audioOutputs.mediaUnavailable') : '';
    status.hidden = !error;
  }
}

export async function routeChatMedia(media: HTMLMediaElement): Promise<void> {
  media.dataset.audioOutput = 'media';
  try {
    await setAudioOutputSink(media, effectiveAudioOutput('media'));
    showOutputError(media, null);
  } catch (error) {
    media.pause();
    showOutputError(media, error);
    throw error;
  }
}

export async function playChatMedia(media: HTMLMediaElement): Promise<void> {
  await routeChatMedia(media);
  if (!media.isConnected) throw new DOMException('Media player was closed', 'AbortError');
  await media.play();
}

// Every chat player in the page, inline or in the lightbox, follows the media output.
registerAudioOutputConsumer(async () => {
  const media = document.querySelectorAll<HTMLMediaElement>('[data-audio-output="media"]');
  await Promise.all(Array.from(media, routeChatMedia));
});
