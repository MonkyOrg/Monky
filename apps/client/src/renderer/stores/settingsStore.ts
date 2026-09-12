import {
  QualityPresetType,
  QualityProfile,
  DEFAULT_CUSTOM_PROFILE,
  PttKeyBinding,
  OverlayMode,
  OverlayLayout,
  OverlayPosition,
  OverlayBounds,
  OverlayConfig,
} from '@monky/shared';
import { appEvents } from '../core/EventBus';
import {
  isNoiseSuppressionMode, resolveAudioOutput, restoreAudioOutputDevices, restoreNoiseSuppressionMode,
  type AudioOutputCategory, type AudioOutputDevices, type NoiseSuppressionMode,
} from '../utils/audioPreferences';

/**
 * Chat-notification-sound mode for the 3-level configuration (#153).
 * - `inherit`: fall back to the next level up (channel → server → global).
 * - `all`: play the cue for every message.
 * - `mentions`: play the cue only when the current user is @-mentioned.
 * - `none`: never play the cue.
 */
export type ChatSoundMode = 'inherit' | 'all' | 'mentions' | 'none';

/** The resolved (effective) mode, after `inherit` has been resolved away. */
export type ResolvedChatSoundMode = 'all' | 'mentions' | 'none';

const CHAT_SOUND_MODES: ChatSoundMode[] = ['inherit', 'all', 'mentions', 'none'];

export class SettingsStore {
  public qualityPreset: QualityPresetType = 'NORMAL';
  public preferredVideoCodec: 'auto' | 'av1' | 'vp9' | 'vp8' | 'h264' = 'auto';
  public customProfile: QualityProfile = { ...DEFAULT_CUSTOM_PROFILE };
  public inputMode: 'voice_activity' | 'push_to_talk' = 'voice_activity'; // #186
  public pttKey: PttKeyBinding = { code: 'KeyV', display: 'V', keyType: 'keyboard', keyCode: 47 };
  public pttReleaseDelay: number = 200; // 0 - 2000 ms
  public pttSoundCue: boolean = true;
  public isMuted: boolean = false; // persistent user mic mute (#358)
  public isDeafened: boolean = false; // persistent user audio deafen (#358)
  public vadSensitivity: number = 25; // 0 - 100
  public selectedMicrophoneId: string = '';
  public selectedSpeakerId: string = '';
  public advancedAudioOutputs: boolean = false;
  public audioOutputDevices: AudioOutputDevices = { voice: null, screen: null, media: null };
  public selectedCameraId: string = '';
  public maxUploadKbps: number = 1000;
  public maxDownloadKbps: number = 2000;
  /**
   * Per-connection playback volume, keyed by `sessionId` (`userId:deviceId`).
   *
   * Until #363 this was keyed by `clientId`, i.e. per *person*. That meant
   * someone signed in from two machines had a single slider: turning down their
   * desktop also turned down their notebook. Volume addresses a connection, so
   * it follows the same rule as voice participants and WebRTC peers (#309).
   *
   * `deviceId` lives in this machine's localStorage, so the key is stable
   * across reconnects and restarts.
   */
  public userVolumes: Record<string, number> = {};
  public noiseSuppressionMode: NoiseSuppressionMode = 'rnnoise';
  public lastNoiseSuppressionMode: Exclude<NoiseSuppressionMode, 'off'> = 'rnnoise';
  public get noiseSuppressionEnabled(): boolean {
    return this.noiseSuppressionMode !== 'browser' && this.noiseSuppressionMode !== 'off';
  }
  public set noiseSuppressionEnabled(enabled: boolean) {
    this.noiseSuppressionMode = enabled ? 'rnnoise' : 'browser';
  }
  public soundboardFolderPath: string = '';
  public soundboardVolume: number = 80; // 0 - 100
  public soundboardMuted: boolean = false;
  /** Folder the user picked for custom chat stickers (#356). */
  public stickersFolderPath: string = '';
  public screenAudioVolumes: Record<string, number> = {}; // per-connection screen audio volume (#75), keyed by sessionId (#363)
  public screenShareTelemetryEnabled: boolean = false;
  public screenShareTelemetryPosition: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' = 'top-right';
  public screenShareTelemetryMode: 'simple' | 'complete' = 'simple';
  public customSounds: Partial<Record<string, string>> = {}; // key → file path
  public soundboardShortcuts: Record<string, { accelerator: string; display: string }> = {};
  public soundboardViewMode: 'grid' | 'list' = 'grid'; // view mode in soundboard modal (#326)
  public keybindShortcuts: Record<string, { accelerator: string; display: string }> = {};
  public chatMessageSoundEnabled: boolean = true; // play a cue when a chat message arrives (#152)
  public chatMessageSoundMentionsOnly: boolean = false; // only play the cue when you are mentioned (#153)
  public updateBetaChannel: boolean = false; // opt into receiving beta (pre-release) updates
  public minimizeToTrayOnClose: boolean = true; // minimize to tray when closing window (#256)
  // Ask whether to shut the local server down when its owner is the last one
  // leaving (#334). Turned off from the prompt itself or in Settings.
  public askShutdownOnLastLeave: boolean = true;
  // Appear offline to other users on all servers (#561).
  public appearOffline: boolean = false;
  // Per-server / per-channel overrides of the global chat-sound mode (#153).
  // A missing entry (or 'inherit') means "use the level above".
  public chatSoundServerOverrides: Record<string, ChatSoundMode> = {};
  public chatSoundChannelOverrides: Record<string, ChatSoundMode> = {};
  public onboardingCompleted: boolean = false;

  // Sobreposição de Tela Flutuante (Overlay) (#169)
  public overlayMode: OverlayMode = 'cameras-only';
  public overlayLayout: OverlayLayout = 'grid';
  public overlayPosition: OverlayPosition = 'bottom-right';
  public overlayCardOpacity: number = 85; // 20 - 100%
  public overlayFocusActiveSpeaker: boolean = false;
  public overlayAutoOpenOnLeaveStage: boolean = false;
  public overlayMinimalistMode: boolean = false;
  public overlayHideSelf: boolean = false;
  public overlaySavedBounds: OverlayBounds | null = null;

  constructor() {
    this.load(false);
  }

  public load(notify = true): void {
    try {
      const raw = localStorage.getItem('monky_settings');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new TypeError('Saved settings must be an object');
        }
        Object.assign(this, parsed);
        if (!this.userVolumes || typeof this.userVolumes !== 'object') {
          this.userVolumes = {};
        }
        this.noiseSuppressionMode = restoreNoiseSuppressionMode(parsed.noiseSuppressionMode, parsed.noiseSuppressionEnabled);
        this.lastNoiseSuppressionMode = isNoiseSuppressionMode(parsed.lastNoiseSuppressionMode) && parsed.lastNoiseSuppressionMode !== 'off'
          ? parsed.lastNoiseSuppressionMode : this.noiseSuppressionMode === 'off' ? 'rnnoise' : this.noiseSuppressionMode;
        this.advancedAudioOutputs = parsed.advancedAudioOutputs === true;
        this.audioOutputDevices = restoreAudioOutputDevices(parsed.audioOutputDevices);
        if (typeof this.soundboardFolderPath !== 'string') {
          this.soundboardFolderPath = '';
        }
        if (typeof this.stickersFolderPath !== 'string') {
          this.stickersFolderPath = '';
        }
        if (typeof this.soundboardVolume !== 'number' || isNaN(this.soundboardVolume)) {
          this.soundboardVolume = 80;
        }
        if (typeof this.soundboardMuted !== 'boolean') {
          this.soundboardMuted = false;
        }
        if (!this.screenAudioVolumes || typeof this.screenAudioVolumes !== 'object') {
          this.screenAudioVolumes = {};
        }
        if (typeof this.screenShareTelemetryEnabled !== 'boolean') {
          this.screenShareTelemetryEnabled = false;
        }
        if (!['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(this.screenShareTelemetryPosition)) {
          this.screenShareTelemetryPosition = 'top-right';
        }
        if (!['simple', 'complete'].includes(this.screenShareTelemetryMode)) {
          this.screenShareTelemetryMode = 'simple';
        }
        if (!['auto', 'av1', 'vp9', 'vp8', 'h264'].includes(this.preferredVideoCodec)) {
          this.preferredVideoCodec = 'auto';
        }
        if (!this.customProfile || typeof this.customProfile !== 'object' || !this.customProfile.audioBitrateKbps) {
          this.customProfile = { ...DEFAULT_CUSTOM_PROFILE };
        }
        if (!this.customSounds || typeof this.customSounds !== 'object') {
          this.customSounds = {};
        }
        if (!this.soundboardShortcuts || typeof this.soundboardShortcuts !== 'object') {
          this.soundboardShortcuts = {};
        }
        if (!['grid', 'list'].includes(this.soundboardViewMode)) {
          this.soundboardViewMode = 'grid';
        }
        if (!['voice_activity', 'push_to_talk'].includes(this.inputMode)) {
          this.inputMode = 'voice_activity';
        }
        if (!this.pttKey || typeof this.pttKey !== 'object' || !this.pttKey.code || !this.pttKey.display) {
          this.pttKey = { code: 'KeyV', display: 'V', keyType: 'keyboard', keyCode: 47 };
        }
        if (typeof this.pttReleaseDelay !== 'number' || isNaN(this.pttReleaseDelay)) {
          this.pttReleaseDelay = 200;
        } else {
          this.pttReleaseDelay = Math.max(0, Math.min(2000, this.pttReleaseDelay));
        }
        if (typeof this.pttSoundCue !== 'boolean') {
          this.pttSoundCue = true;
        }
        if (typeof this.isMuted !== 'boolean') {
          this.isMuted = false;
        }
        if (typeof this.isDeafened !== 'boolean') {
          this.isDeafened = false;
        }
        if (!this.keybindShortcuts || typeof this.keybindShortcuts !== 'object') {
          this.keybindShortcuts = {};
        }
        if (typeof this.chatMessageSoundEnabled !== 'boolean') {
          this.chatMessageSoundEnabled = true;
        }
        if (typeof this.chatMessageSoundMentionsOnly !== 'boolean') {
          this.chatMessageSoundMentionsOnly = false;
        }
        if (typeof this.updateBetaChannel !== 'boolean') {
          this.updateBetaChannel = false;
        }
        if (typeof this.minimizeToTrayOnClose !== 'boolean') {
          this.minimizeToTrayOnClose = true;
        }
        if (typeof this.askShutdownOnLastLeave !== 'boolean') {
          this.askShutdownOnLastLeave = true;
        }
        if (typeof this.appearOffline !== 'boolean') {
          this.appearOffline = false;
        }
        this.chatSoundServerOverrides = this.sanitizeModeMap(parsed.chatSoundServerOverrides);
        this.chatSoundChannelOverrides = this.sanitizeModeMap(this.chatSoundChannelOverrides);
        if (typeof this.onboardingCompleted !== 'boolean') {
          this.onboardingCompleted = false;
        }

        if (!['cameras-only', 'cameras-and-screens'].includes(this.overlayMode)) {
          this.overlayMode = 'cameras-only';
        }
        if (!['grid', 'vertical', 'horizontal'].includes(this.overlayLayout)) {
          this.overlayLayout = 'grid';
        }
        if (!['top-left', 'top-right', 'bottom-left', 'bottom-right', 'custom'].includes(this.overlayPosition)) {
          this.overlayPosition = 'bottom-right';
        }
        if (typeof this.overlayCardOpacity !== 'number' || isNaN(this.overlayCardOpacity)) {
          this.overlayCardOpacity = 85;
        } else {
          this.overlayCardOpacity = Math.max(20, Math.min(100, Math.round(this.overlayCardOpacity)));
        }
        if (typeof this.overlayFocusActiveSpeaker !== 'boolean') {
          this.overlayFocusActiveSpeaker = false;
        }
        if (typeof this.overlayAutoOpenOnLeaveStage !== 'boolean') {
          this.overlayAutoOpenOnLeaveStage = false;
        }
        if (typeof this.overlayMinimalistMode !== 'boolean') {
          this.overlayMinimalistMode = false;
        }
        if (typeof this.overlayHideSelf !== 'boolean') {
          this.overlayHideSelf = false;
        }
        if (
          this.overlaySavedBounds &&
          (typeof this.overlaySavedBounds.width !== 'number' || typeof this.overlaySavedBounds.height !== 'number')
        ) {
          this.overlaySavedBounds = null;
        }
      } else {
        this.chatSoundServerOverrides = {};
      }
    } catch (error) {
      console.warn('[SettingsStore] Could not load settings:', error);
      return;
    }
    if (notify) appEvents.emit('settings.updated');
  }

  public getOverlayConfig(): OverlayConfig {
    return {
      mode: this.overlayMode,
      layout: this.overlayLayout,
      position: this.overlayPosition,
      cardOpacity: this.overlayCardOpacity / 100,
      focusActiveSpeaker: this.overlayFocusActiveSpeaker,
      autoOpenOnLeaveStage: this.overlayAutoOpenOnLeaveStage,
      minimalistMode: this.overlayMinimalistMode,
      hideSelf: this.overlayHideSelf,
      bounds: this.overlaySavedBounds || undefined,
    };
  }

  public getAudioOutputDeviceId(category: AudioOutputCategory): string {
    return resolveAudioOutput(this, category);
  }

  public setOverlayConfig(config: Partial<OverlayConfig>): void {
    if (config.mode) this.overlayMode = config.mode;
    if (config.layout) this.overlayLayout = config.layout;
    if (config.position) this.overlayPosition = config.position;
    if (typeof config.cardOpacity === 'number') {
      this.overlayCardOpacity = Math.max(20, Math.min(100, Math.round(config.cardOpacity * 100)));
    }
    if (typeof config.focusActiveSpeaker === 'boolean') {
      this.overlayFocusActiveSpeaker = config.focusActiveSpeaker;
    }
    if (typeof config.autoOpenOnLeaveStage === 'boolean') {
      this.overlayAutoOpenOnLeaveStage = config.autoOpenOnLeaveStage;
    }
    if (typeof config.minimalistMode === 'boolean') {
      this.overlayMinimalistMode = config.minimalistMode;
    }
    if (typeof config.hideSelf === 'boolean') {
      this.overlayHideSelf = config.hideSelf;
    }
    // Presence of the key (not truthiness) is what matters: resetting the size
    // sends `{ bounds: undefined }` on purpose, and that has to actually clear
    // the saved bounds so the "reset size" control knows it is back to default
    // (#543).
    if ('bounds' in config) {
      this.overlaySavedBounds = config.bounds ?? null;
    }
    this.save();
    appEvents.emit('overlay_settings.updated', this.getOverlayConfig());
  }

  /**
   * Reads a volume for one connection, falling back to the value saved by
   * builds before #363 (which keyed these maps by `clientId`) so upgrading
   * doesn't silently reset everyone's sliders to 100%. The legacy entry stops
   * being consulted for a device as soon as its slider is touched.
   */
  private readVolume(map: Record<string, number>, sessionId: string, legacyClientId?: string): number {
    const raw = map[sessionId] ?? (legacyClientId ? map[legacyClientId] : undefined);
    return typeof raw === 'number' && !isNaN(raw) ? Math.max(0, Math.min(200, raw)) : 100;
  }

  public getUserVolume(sessionId: string, legacyClientId?: string): number {
    if (!sessionId) return 100;
    return this.readVolume(this.userVolumes, sessionId, legacyClientId);
  }

  public setUserVolume(sessionId: string, volume: number): void {
    if (!sessionId) return;
    const clamped = Math.max(0, Math.min(200, Math.round(volume)));
    this.userVolumes[sessionId] = clamped;
    this.save();
    appEvents.emit('user_volume.changed', { sessionId, volume: clamped });
  }

  public getScreenAudioVolume(sessionId: string, legacyClientId?: string): number {
    if (!sessionId) return 100;
    return this.readVolume(this.screenAudioVolumes, sessionId, legacyClientId);
  }

  public setScreenAudioVolume(sessionId: string, volume: number): void {
    if (!sessionId) return;
    const clamped = Math.max(0, Math.min(200, Math.round(volume)));
    this.screenAudioVolumes[sessionId] = clamped;
    this.save();
    appEvents.emit('screen_audio_volume.changed', { sessionId, volume: clamped });
  }

  /** Keep only valid { id: ChatSoundMode } entries, dropping 'inherit'/garbage (#153). */
  private sanitizeModeMap(map: unknown): Record<string, ChatSoundMode> {
    const result: Record<string, ChatSoundMode> = {};
    if (map && typeof map === 'object') {
      for (const [key, value] of Object.entries(map as Record<string, unknown>)) {
        if (typeof value === 'string' && CHAT_SOUND_MODES.includes(value as ChatSoundMode) && value !== 'inherit') {
          result[key] = value as ChatSoundMode;
        }
      }
    }
    return result;
  }

  /** The global (GERAL) chat-sound mode, derived from the app-wide toggles (#153). */
  public getGlobalChatSoundMode(): ResolvedChatSoundMode {
    if (!this.chatMessageSoundEnabled) return 'none';
    return this.chatMessageSoundMentionsOnly ? 'mentions' : 'all';
  }

  public getServerChatSoundOverride(serverId: string | undefined): ChatSoundMode {
    if (!serverId) return 'inherit';
    return this.chatSoundServerOverrides[serverId] ?? 'inherit';
  }

  public setServerChatSoundOverride(serverId: string, mode: ChatSoundMode): void {
    if (!serverId) return;
    const previous = this.chatSoundServerOverrides;
    const next = { ...previous };
    if (mode === 'inherit') delete next[serverId];
    else next[serverId] = mode;
    this.chatSoundServerOverrides = next;
    try {
      this.save();
    } catch (error) {
      this.chatSoundServerOverrides = previous;
      throw error;
    }
  }

  public getChannelChatSoundOverride(channelId: string | undefined): ChatSoundMode {
    if (!channelId) return 'inherit';
    return this.chatSoundChannelOverrides[channelId] ?? 'inherit';
  }

  public setChannelChatSoundOverride(channelId: string, mode: ChatSoundMode): void {
    if (!channelId) return;
    if (mode === 'inherit') delete this.chatSoundChannelOverrides[channelId];
    else this.chatSoundChannelOverrides[channelId] = mode;
    this.save();
  }

  /**
   * Resolve the effective chat-sound mode for a message, applying the 3-level
   * precedence channel → server → global (#153).
   */
  public getEffectiveChatSoundMode(
    serverId: string | undefined,
    channelId: string | undefined
  ): ResolvedChatSoundMode {
    const channelMode = this.getChannelChatSoundOverride(channelId);
    if (channelMode !== 'inherit') return channelMode;
    const serverMode = this.getServerChatSoundOverride(serverId);
    if (serverMode !== 'inherit') return serverMode;
    return this.getGlobalChatSoundMode();
  }

  public save(): void {
    try {
      localStorage.setItem('monky_settings', JSON.stringify({
        qualityPreset: this.qualityPreset,
        preferredVideoCodec: this.preferredVideoCodec,
        vadSensitivity: this.vadSensitivity,
        selectedMicrophoneId: this.selectedMicrophoneId,
        selectedSpeakerId: this.selectedSpeakerId,
        advancedAudioOutputs: this.advancedAudioOutputs,
        audioOutputDevices: this.audioOutputDevices,
        selectedCameraId: this.selectedCameraId,
        maxUploadKbps: this.maxUploadKbps,
        maxDownloadKbps: this.maxDownloadKbps,
        userVolumes: this.userVolumes,
        noiseSuppressionEnabled: this.noiseSuppressionEnabled,
        noiseSuppressionMode: this.noiseSuppressionMode,
        lastNoiseSuppressionMode: this.lastNoiseSuppressionMode,
        inputMode: this.inputMode,
        pttKey: this.pttKey,
        pttReleaseDelay: this.pttReleaseDelay,
        pttSoundCue: this.pttSoundCue,
        isMuted: this.isMuted,
        isDeafened: this.isDeafened,
        soundboardFolderPath: this.soundboardFolderPath,
        soundboardVolume: this.soundboardVolume,
        soundboardMuted: this.soundboardMuted,
        stickersFolderPath: this.stickersFolderPath,
        screenAudioVolumes: this.screenAudioVolumes,
        screenShareTelemetryEnabled: this.screenShareTelemetryEnabled,
        screenShareTelemetryPosition: this.screenShareTelemetryPosition,
        screenShareTelemetryMode: this.screenShareTelemetryMode,
        customProfile: this.customProfile,
        customSounds: this.customSounds,
        soundboardShortcuts: this.soundboardShortcuts,
        soundboardViewMode: this.soundboardViewMode,
        keybindShortcuts: this.keybindShortcuts,
        chatMessageSoundEnabled: this.chatMessageSoundEnabled,
        chatMessageSoundMentionsOnly: this.chatMessageSoundMentionsOnly,
        updateBetaChannel: this.updateBetaChannel,
        minimizeToTrayOnClose: this.minimizeToTrayOnClose,
        askShutdownOnLastLeave: this.askShutdownOnLastLeave,
        appearOffline: this.appearOffline,
        chatSoundServerOverrides: this.chatSoundServerOverrides,
        chatSoundChannelOverrides: this.chatSoundChannelOverrides,
        onboardingCompleted: this.onboardingCompleted,
        overlayMode: this.overlayMode,
        overlayLayout: this.overlayLayout,
        overlayPosition: this.overlayPosition,
        overlayCardOpacity: this.overlayCardOpacity,
        overlayFocusActiveSpeaker: this.overlayFocusActiveSpeaker,
        overlayAutoOpenOnLeaveStage: this.overlayAutoOpenOnLeaveStage,
        overlayMinimalistMode: this.overlayMinimalistMode,
        overlayHideSelf: this.overlayHideSelf,
        overlaySavedBounds: this.overlaySavedBounds,
      }));
      appEvents.emit('settings.updated');
    } catch (error) {
      console.error('[SettingsStore] Could not save settings:', error);
      throw error;
    }
  }
}

export const settingsStore = new SettingsStore();

// Register only after singleton construction; initial hydration must not notify
// consumers that can still be initializing their imports.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== 'monky_settings' && event.key !== null) return;
    if (event.storageArea !== localStorage) return;
    settingsStore.load();
  });
}
