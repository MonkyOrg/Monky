import { audioProcessor } from './AudioProcessor';
import { webRtcManager } from './WebRtcManager';
import { soundEffects } from './SoundEffects';
import { soundboardService } from './SoundboardService';
import { settingsStore } from '../stores/settingsStore';
import { voiceStore } from '../stores/voiceStore';
import { setChatMediaOutputDeviceId } from './ChatMediaOutput';
import { copyAudioOutputPreferences, resolveAudioOutput, type AudioOutputPreferences } from '../utils/audioPreferences';

export async function applyAudioDevice(
  kind: 'input' | 'output',
  deviceId: string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new DOMException('Audio selection was cancelled', 'AbortError');
  if (kind === 'input') {
    if (!voiceStore.currentVoiceChannelId) return;
    await audioProcessor.switchMicrophone(
      deviceId,
      (track, pending) => webRtcManager.replaceMicrophoneTrack(track, pending),
      signal,
    );
    return;
  }

  const next = copyAudioOutputPreferences(settingsStore);
  next.selectedSpeakerId = deviceId;
  await applyAudioOutputPreferences(next, signal);
}

export async function applyAudioOutputPreferences(
  next: AudioOutputPreferences,
  signal?: AbortSignal,
): Promise<void> {
  const previous = copyAudioOutputPreferences(settingsStore);
  const applySinks = [
    (preferences: AudioOutputPreferences) => webRtcManager.setOutputDeviceIds(
      resolveAudioOutput(preferences, 'voice'), resolveAudioOutput(preferences, 'screen'),
    ),
    (preferences: AudioOutputPreferences) => soundEffects.setSinkId(preferences.selectedSpeakerId),
    (preferences: AudioOutputPreferences) => soundboardService.setSinkId(preferences.selectedSpeakerId),
    (preferences: AudioOutputPreferences) => setChatMediaOutputDeviceId(resolveAudioOutput(preferences, 'media')),
  ];
  try {
    for (const apply of applySinks) {
      if (signal?.aborted) throw new DOMException('Audio selection was cancelled', 'AbortError');
      await apply(next);
      if (signal?.aborted) throw new DOMException('Audio selection was cancelled', 'AbortError');
    }
  } catch (error) {
    // Some sinks may already have switched when a later element rejects.
    const restored = await Promise.allSettled(applySinks.map((apply) => apply(previous)));
    if (restored.some((result) => result.status === 'rejected')) {
      console.error('[AudioDevices] Some playback devices could not be restored', restored);
    }
    throw error;
  }
}
