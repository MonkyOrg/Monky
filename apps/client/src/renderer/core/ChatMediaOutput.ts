import { settingsStore } from '../stores/settingsStore';
import { t } from '../i18n';
import { normalizeAudioOutputId } from '../utils/audioPreferences';
import { setAudioOutputSink } from './AudioOutputSink';

let pendingDeviceId: string | null = null;

function showOutputError(media: HTMLMediaElement, error: unknown | null): void {
  const player = media.closest<HTMLElement>('.chat-video-player');
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

export async function routeChatMedia(media: HTMLMediaElement, deviceId?: string): Promise<void> {
  media.dataset.audioOutput = 'media';
  const sinkId = normalizeAudioOutputId(deviceId ?? pendingDeviceId ?? settingsStore.getAudioOutputDeviceId('media'));
  try {
    await setAudioOutputSink(media, sinkId);
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

export async function setChatMediaOutputDeviceId(deviceId: string): Promise<void> {
  pendingDeviceId = normalizeAudioOutputId(deviceId);
  const media = document.querySelectorAll<HTMLMediaElement>('[data-audio-output="media"]');
  await Promise.all(Array.from(media, (element) => routeChatMedia(element, deviceId)));
}

export function finishChatMediaOutputSelection(): void {
  pendingDeviceId = null;
}
