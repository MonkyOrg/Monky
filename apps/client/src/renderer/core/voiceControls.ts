import { MessageType } from '@monky/shared';
import { voiceStore } from '../stores/voiceStore';
import { settingsStore } from '../stores/settingsStore';
import { applyLocalAudioState } from './localAudioState';
import { leaveCurrentCall } from './serverConnection';
import { callClient, callServer } from './callScope';
import { soundEffects } from './SoundEffects';
import { sessionManager } from './SessionManager';
import { serverStore } from '../stores/serverStore';
import { t } from '../i18n';
import { afkChannelIdOf } from '../utils/voiceRooms';

export function isViewingCallServer(): boolean {
  return !voiceStore.voiceSessionKey || voiceStore.voiceSessionKey === sessionManager.getActiveKey();
}

export function updateLocalSpeaking(speaking: boolean): void {
  voiceStore.setSpeaking(speaking);
  const call = callServer();
  const user = call?.serverStore.currentUser;
  if (call && user) {
    const sessionId = user.sessionId || user.id;
    const inCall = voiceStore.currentVoiceChannelId !== null
      && call.participants.get(sessionId)?.voiceState?.channelId === voiceStore.currentVoiceChannelId;
    // Physical capture can already be unmuted while its older server echo is still muted.
    call.participants.setSpeaking(sessionId, voiceStore.isSpeaking && inCall, voiceStore);
  }
}

export function getVoiceControlModeration(): {
  serverMuted: boolean;
  serverDeafened: boolean;
  permissionMuted: boolean;
  muteReason: string | null;
  deafenReason: string | null;
} {
  const { serverMuted, serverDeafened } = serverStore.voiceRestrictions;
  const permissionMuted = voiceStore.permissionMuted;
  const deafenReason = serverDeafened ? t('permissions.serverDeafened') : null;
  const permissionReason = permissionMuted ? t(isCallInAfkChannel() ? 'afk.muted' : 'permissions.permissionMuted') : null;
  return {
    serverMuted,
    serverDeafened,
    permissionMuted,
    muteReason: permissionReason ?? deafenReason ?? (serverMuted ? t('permissions.serverMuted') : null),
    deafenReason,
  };
}

/** Whether the call sits in its server's AFK room, where the server mutes every microphone. */
export function isCallInAfkChannel(): boolean {
  return !!voiceStore.currentVoiceChannelId
    && voiceStore.currentVoiceChannelId === afkChannelIdOf(callServer()?.serverStore.serverDetails);
}

export function toggleMicrophoneMute(): void {
  if (voiceStore.permissionMuted) return;
  const muted = !voiceStore.isMuted;
  voiceStore.setMuted(muted);
  const undeafened = !muted && voiceStore.isDeafened;
  if (undeafened) voiceStore.setDeafened(false);

  applyLocalAudioState();
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
  applyLocalAudioState();
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

/**
 * Hangs up from the stage, the sidebar row, the tray or the taskbar thumbnail.
 * It never goes through a view: a stage that is not on screen would paint
 * itself over the chat.
 */
export function leaveCall(): void {
  if (voiceStore.currentVoiceChannelId) leaveCurrentCall();
}
