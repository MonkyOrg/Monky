import { MessageType } from '@monky/shared';
import { voiceStore } from '../stores/voiceStore';
import { settingsStore } from '../stores/settingsStore';
import { audioProcessor } from './AudioProcessor';
import { webRtcManager } from './WebRtcManager';
import { callClient } from './serverConnection';
import { soundEffects } from './SoundEffects';

export function toggleMicrophoneMute(): void {
  const muted = !voiceStore.isMuted;
  voiceStore.setMuted(muted);
  const undeafened = !muted && voiceStore.isDeafened;
  if (undeafened) voiceStore.setDeafened(false);

  // Apply media state after both flags settle, including unmuting while deafened.
  audioProcessor.setMuted(voiceStore.getEffectiveMuted());
  audioProcessor.setDeafened(voiceStore.getEffectiveDeafened());
  if (undeafened) webRtcManager.setDeafened(voiceStore.getEffectiveDeafened());
  soundEffects.play(muted ? 'mic_mute' : 'mic_unmute');

  if (voiceStore.currentVoiceChannelId) {
    callClient().send(MessageType.VOICE_STATE_UPDATE, {
      isMuted: voiceStore.isMuted,
      ...(undeafened ? { isDeafened: false } : {}),
    });
  }
}

export function toggleAudioDeafen(): void {
  const deafened = !voiceStore.isDeafened;
  voiceStore.setDeafened(deafened);
  audioProcessor.setDeafened(voiceStore.getEffectiveDeafened());
  audioProcessor.setMuted(voiceStore.getEffectiveMuted());
  webRtcManager.setDeafened(voiceStore.getEffectiveDeafened());
  soundEffects.play(deafened ? 'deafen' : 'undeafen');

  if (voiceStore.currentVoiceChannelId) {
    callClient().send(MessageType.VOICE_STATE_UPDATE, {
      isDeafened: voiceStore.isDeafened,
      isMuted: voiceStore.isMuted,
    });
  }
}

export function toggleSoundboardMute(): void {
  settingsStore.soundboardMuted = !settingsStore.soundboardMuted;
  settingsStore.save();
}
