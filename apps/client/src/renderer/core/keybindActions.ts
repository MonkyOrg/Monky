import { appEvents } from './EventBus';
import { soundboardService } from './SoundboardService';
import { toggleAudioDeafen, toggleMicrophoneMute, toggleSoundboardMute } from './voiceControls';
import { voiceStore } from '../stores/voiceStore';

export interface KeybindActionsHost {
  /** The camera of the call, redrawing the stage when it is on screen. */
  toggleCamera(): Promise<void>;
}

/** What the global shortcuts do (#252). Call shortcuts outside a call do nothing. */
export function bindKeybindActions(host: KeybindActionsHost): () => void {
  const unbind = [
    appEvents.on('keybind.toggle_mute', toggleMicrophoneMute),
    appEvents.on('keybind.toggle_deafen', toggleAudioDeafen),
    appEvents.on('keybind.toggle_camera', () => {
      if (voiceStore.currentVoiceChannelId) void host.toggleCamera();
    }),
    appEvents.on('keybind.toggle_screen_share', () => {
      if (voiceStore.currentVoiceChannelId) appEvents.emit('modal.open_screenshare_picker');
    }),
    appEvents.on('keybind.toggle_soundboard_mute', toggleSoundboardMute),
    appEvents.on('keybind.stop_soundboard', () => {
      if (voiceStore.currentVoiceChannelId) soundboardService.stopAllFromUi();
    }),
  ];
  return () => unbind.forEach(off => off());
}
