import { audioProcessor } from './AudioProcessor';
import { webRtcManager } from './WebRtcManager';
import { voiceStore } from '../stores/voiceStore';

/**
 * Moves the call to another microphone; outside a call there is nothing to move.
 * Outputs move through `routeAudioOutputs` (audioOutputRouting.ts).
 */
export async function applyAudioDevice(kind: 'input', deviceId: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new DOMException('Audio selection was cancelled', 'AbortError');
  if (!voiceStore.currentVoiceChannelId) return;
  await audioProcessor.switchMicrophone(
    deviceId,
    (track, pending) => webRtcManager.replaceMicrophoneTrack(track, pending),
    signal,
  );
}
