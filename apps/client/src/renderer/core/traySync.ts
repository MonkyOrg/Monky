import { appEvents } from './EventBus';
import { soundboardService } from './SoundboardService';
import { isCallInAfkChannel, leaveCall, toggleAudioDeafen, toggleMicrophoneMute } from './voiceControls';
import { voiceStore } from '../stores/voiceStore';

export interface TraySyncHost {
  /** Whether a miniapp of the call is open, on stage or parked off it. */
  isWatchingBotScreen(): boolean;
}

/**
 * Mirrors the call on the tray icon and the taskbar thumbnail, and answers
 * their mute, deafen and hang-up buttons.
 */
export function bindTraySync(host: TraySyncHost): () => void {
  const sync = (): void => {
    window.api?.updateTrayVoiceStatus({
      inCall: !!voiceStore.currentVoiceChannelId,
      isMuted: voiceStore.getEffectiveMuted(),
      isDeafened: voiceStore.getEffectiveDeafened(),
      isSpeaking: voiceStore.isSpeaking,
      selfMuted: voiceStore.isMuted,
      selfDeafened: voiceStore.isDeafened,
      micLock: voiceStore.permissionMuted ? (isCallInAfkChannel() ? 'afk' : 'permission') : null,
      isWatching: voiceStore.isWatchingAnyScreenShare() || host.isWatchingBotScreen(),
      isPlayingSound: soundboardService.isPlayingOwnSound(),
      isRecording: voiceStore.isCameraOn || voiceStore.isScreenSharing,
    });
  };

  const unbind = [
    appEvents.on('voice.state_updated', sync),
    appEvents.on('voice.speaking_changed', sync),
    appEvents.on('voice.channel_changed', sync),
    // Watching someone's screen or a miniapp puts 3D glasses on the tray monkey.
    appEvents.on('voice.screen_watch_changed', sync),
    appEvents.on('stage.bot_screens_changed', sync),
    // Our own soundboard sound puts a megaphone in its hand (a pause counts as stopping).
    appEvents.on('soundboard.playback_started', sync),
    appEvents.on('soundboard.playback_changed', sync),
    appEvents.on('soundboard.playback_ended', sync),
    // Tray context menu and Windows taskbar thumbnail actions. Leaving takes the
    // same path as the hang-up button in the sidebar's voice connection row.
    window.api?.onTrayToggleMute(toggleMicrophoneMute),
    window.api?.onTrayToggleDeafen(toggleAudioDeafen),
    window.api?.onTrayLeaveCall(leaveCall),
  ];
  sync();
  return () => unbind.forEach(off => off?.());
}
