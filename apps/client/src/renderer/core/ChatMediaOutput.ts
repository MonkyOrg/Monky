import { t } from '../i18n';
import { reportError } from '../utils/feedback';
import { setAudioOutputSink } from './AudioOutputSink';
import { effectiveAudioOutput, registerAudioOutputConsumer } from './audioOutputRouting';

/**
 * Puts a chat player on the media output. Players are routed when they mount
 * and when the output changes, which the person did not ask for one by one:
 * a failure pauses the player and is left to the caller, never shown on it.
 */
export async function routeChatMedia(media: HTMLMediaElement): Promise<void> {
  media.dataset.audioOutput = 'media';
  try {
    await setAudioOutputSink(media, effectiveAudioOutput('media'));
  } catch (error) {
    media.pause();
    throw error;
  }
}

/** Plays a chat player the person started; an output that cannot be used is explained once, in the alert toast (#490). */
export async function playChatMedia(media: HTMLMediaElement): Promise<void> {
  try {
    await routeChatMedia(media);
  } catch (error) {
    reportError(t('audioOutputs.mediaUnavailable'), { log: 'MEDIA', error });
    throw error;
  }
  if (!media.isConnected) throw new DOMException('Media player was closed', 'AbortError');
  await media.play();
}

// Every chat player in the page, inline or in the lightbox, follows the media output.
registerAudioOutputConsumer(async () => {
  const media = document.querySelectorAll<HTMLMediaElement>('[data-audio-output="media"]');
  await Promise.all(Array.from(media, routeChatMedia));
});
