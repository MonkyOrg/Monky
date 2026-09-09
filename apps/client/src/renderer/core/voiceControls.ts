import { MessageType } from '@monky/shared';
import { voiceStore } from '../stores/voiceStore';
import { settingsStore } from '../stores/settingsStore';
import { audioProcessor } from './AudioProcessor';
import { webRtcManager } from './WebRtcManager';
import { callClient } from './serverConnection';
import { soundEffects } from './SoundEffects';
import { sessionManager } from './SessionManager';
import { serverStore } from '../stores/serverStore';
import { participantManager } from './ParticipantManager';
import { t } from '../i18n';

export function isViewingCallServer(): boolean {
  return !voiceStore.voiceSessionKey || voiceStore.voiceSessionKey === sessionManager.getActiveKey();
}

export function updateLocalSpeaking(speaking: boolean): void {
  voiceStore.setSpeaking(speaking);
  const key = voiceStore.voiceSessionKey;
  const call = key ? sessionManager.get(key) : undefined;
  const user = key ? call?.serverStore.currentUser : serverStore.currentUser;
  const participants = key ? call?.participants : participantManager;
  if (user && participants) {
    const sessionId = user.sessionId || user.id;
    const inCall = voiceStore.currentVoiceChannelId !== null
      && participants.get(sessionId)?.voiceState?.channelId === voiceStore.currentVoiceChannelId;
    participants.setSpeaking(sessionId, voiceStore.isSpeaking && inCall);
  }
}

export function getVoiceControlModeration(): {
  serverMuted: boolean;
  serverDeafened: boolean;
  muteReason: string | null;
  deafenReason: string | null;
} {
  const { serverMuted, serverDeafened } = serverStore.voiceRestrictions;
  const deafenReason = serverDeafened ? t('permissions.serverDeafened') : null;
  return {
    serverMuted,
    serverDeafened,
    muteReason: deafenReason ?? (serverMuted ? t('permissions.serverMuted') : null),
    deafenReason,
  };
}

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
