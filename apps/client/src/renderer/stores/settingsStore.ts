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
  botSettingsValuesSchema,
  type BotFormValues,
} from '@monky/shared';
import { appEvents } from '../core/EventBus';

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
const MAX_BOT_PREFERENCE_SCOPES = 256;

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
  public noiseSuppressionEnabled: boolean = true;
  public soundboardFolderPath: string = '';
  public botDownloadConfirmationExceptions: string[] = [];
  public botUserPreferences: Record<string, BotFormValues> = {};
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
    this.load();
  }

  public load(): void {
    this.botDownloadConfirmationExceptions = [];
    this.botUserPreferences = {};
    if (typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem('monky_settings');
      if (raw) {
        const parsed = JSON.parse(raw);
        Object.assign(this, parsed);
        if (!this.userVolumes || typeof this.userVolumes !== 'object') {
          this.userVolumes = {};
        }
        if (typeof this.noiseSuppressionEnabled !== 'boolean') {
          this.noiseSuppressionEnabled = true;
        }
        if (typeof this.soundboardFolderPath !== 'string') {
          this.soundboardFolderPath = '';
        }
        if (!Array.isArray(this.botDownloadConfirmationExceptions) ||
            this.botDownloadConfirmationExceptions.length > MAX_BOT_PREFERENCE_SCOPES ||
            this.botDownloadConfirmationExceptions.some((key: unknown) => typeof key !== 'string' || !key || key.length > 2048)) {
          console.warn('[Settings] Invalid bot download confirmations; confirmation is required again.');
          this.botDownloadConfirmationExceptions = [];
        }
        if (!this.botUserPreferences || typeof this.botUserPreferences !== 'object' || Array.isArray(this.botUserPreferences) ||
            Object.keys(this.botUserPreferences).length > MAX_BOT_PREFERENCE_SCOPES ||
            Object.entries(this.botUserPreferences).some(([key, values]) => !key || key.length > 2048 ||
              !botSettingsValuesSchema.safeParse(values).success)) {
          console.warn('[Settings] Invalid individual bot preferences; saved overrides were discarded.');
          this.botUserPreferences = {};
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
        this.chatSoundServerOverrides = this.sanitizeModeMap(this.chatSoundServerOverrides);
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
      }
    } catch (error) {
      this.botDownloadConfirmationExceptions = [];
      this.botUserPreferences = {};
      console.warn('[Settings] Could not load settings; bot downloads require confirmation:', error);
    }
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
    if (mode === 'inherit') delete this.chatSoundServerOverrides[serverId];
    else this.chatSoundServerOverrides[serverId] = mode;
    this.save();
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

  public suppressBotDownloadConfirmation(key: string): void {
    this.saveBotPreferences(key, this.getBotUserSettings(key), false);
  }

  public getBotUserSettings(key: string): BotFormValues {
    return Object.hasOwn(this.botUserPreferences, key) ? structuredClone(this.botUserPreferences[key]) : {};
  }

  public saveBotPreferences(key: string, values: BotFormValues, confirmFileName?: boolean): void {
    if (!key || key.length > 2048 || (confirmFileName !== undefined && typeof confirmFileName !== 'boolean')) {
      throw new Error('Invalid individual bot preference scope.');
    }
    const parsed = botSettingsValuesSchema.safeParse(values);
    if (!parsed.success) throw new Error('Invalid individual bot preferences.');
    const previousPreferences = this.botUserPreferences;
    const previousConfirmations = this.botDownloadConfirmationExceptions;
    const customChanged = JSON.stringify(this.getBotUserSettings(key)) !== JSON.stringify(parsed.data);
    const entries = Object.entries(previousPreferences).filter(([scope]) => scope !== key);
    if (Object.keys(parsed.data).length) entries.push([key, structuredClone(parsed.data)]);
    this.botUserPreferences = Object.fromEntries(entries.slice(-MAX_BOT_PREFERENCE_SCOPES));
    if (confirmFileName !== undefined) {
      const confirmations = previousConfirmations.filter((scope) => scope !== key);
      if (!confirmFileName) confirmations.push(key);
      this.botDownloadConfirmationExceptions = confirmations.slice(-MAX_BOT_PREFERENCE_SCOPES);
    }
    if (!this.save()) {
      this.botUserPreferences = previousPreferences;
      this.botDownloadConfirmationExceptions = previousConfirmations;
      throw new Error('Could not save individual bot preferences.');
    }
    appEvents.emit('bot.preferences_updated', { scope: key, customChanged });
  }

  public resetBotDownloadConfirmations(): void {
    const previous = this.botDownloadConfirmationExceptions;
    this.botDownloadConfirmationExceptions = [];
    if (!this.save()) {
      this.botDownloadConfirmationExceptions = previous;
      throw new Error('Could not restore bot download confirmations.');
    }
  }

  public save(): boolean {
    try {
      localStorage.setItem('monky_settings', JSON.stringify({
        qualityPreset: this.qualityPreset,
        preferredVideoCodec: this.preferredVideoCodec,
        vadSensitivity: this.vadSensitivity,
        selectedMicrophoneId: this.selectedMicrophoneId,
        selectedSpeakerId: this.selectedSpeakerId,
        selectedCameraId: this.selectedCameraId,
        maxUploadKbps: this.maxUploadKbps,
        maxDownloadKbps: this.maxDownloadKbps,
        userVolumes: this.userVolumes,
        noiseSuppressionEnabled: this.noiseSuppressionEnabled,
        inputMode: this.inputMode,
        pttKey: this.pttKey,
        pttReleaseDelay: this.pttReleaseDelay,
        pttSoundCue: this.pttSoundCue,
        isMuted: this.isMuted,
        isDeafened: this.isDeafened,
        soundboardFolderPath: this.soundboardFolderPath,
        botDownloadConfirmationExceptions: this.botDownloadConfirmationExceptions,
        botUserPreferences: this.botUserPreferences,
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
      return true;
    } catch (error) {
      console.warn('[Settings] Could not save settings:', error);
      return false;
    }
  }
}

export const settingsStore = new SettingsStore();
