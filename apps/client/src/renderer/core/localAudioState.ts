import { voiceStore } from '../stores/voiceStore';
import { audioProcessor } from './AudioProcessor';
import { webRtcManager } from './WebRtcManager';

/**
 * Applies the effective mute and deafen (the person's choice plus the call's moderation) to the
 * microphone and to what is heard. Every path that changes either flag calls this after both settle,
 * so a new reason to mute only has to be taught to the store. Reapplying the same state is harmless.
 */
export function applyLocalAudioState(): void {
  const deafened = voiceStore.getEffectiveDeafened();
  audioProcessor.setMuted(voiceStore.getEffectiveMuted());
  audioProcessor.setDeafened(deafened);
  webRtcManager.setDeafened(deafened);
}
