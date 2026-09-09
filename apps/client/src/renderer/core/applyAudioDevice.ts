import { audioProcessor } from './AudioProcessor';
import { webRtcManager } from './WebRtcManager';
import { soundEffects } from './SoundEffects';
import { soundboardService } from './SoundboardService';
import { settingsStore } from '../stores/settingsStore';
import { voiceStore } from '../stores/voiceStore';

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

  const previous = settingsStore.selectedSpeakerId;
  const applySinks = [
    (id: string) => webRtcManager.setSpeakerDeviceId(id),
    (id: string) => soundEffects.setSinkId(id),
    (id: string) => soundboardService.setSinkId(id),
  ];
  try {
    for (const apply of applySinks) {
      await apply(deviceId);
      if (signal?.aborted) throw new DOMException('Audio selection was cancelled', 'AbortError');
    }
  } catch (error) {
    // Some sinks may already have switched when a later element rejects.
    const restored = await Promise.allSettled(applySinks.map((apply) => apply(previous)));
    if (restored.some((result) => result.status === 'rejected')) {
      console.warn('[AudioDevices] Some playback devices could not be restored');
    }
    throw error;
  }
}
