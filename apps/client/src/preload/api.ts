import type {
  BotDeviceStorageDecision, BotDeviceStorageDocumentState, BotDeviceStorageEntry, BotDeviceStorageRequest,
  BotDeviceStorageResponse, BotDeviceStorageScope, DmApi, IpcInvoker as Invoke, IpcSubscriber as Subscribe,
  NativeScreenPresentation, NativeScreenPresentationSample, SoundboardSoundEntry, StickerEntry,
} from '@monky/shared';
export type { LinkPreviewData, OverlayBounds, OverlayConfig, OverlayMode, OverlayLayout, OverlayPosition, OverlayParticipantState, OverlaySyncState } from '@monky/shared';

export interface BotStorageApi {
  documentState: (url: string) => Promise<BotDeviceStorageDocumentState>;
  documentRequest: (url: string, request: BotDeviceStorageRequest) => Promise<BotDeviceStorageResponse>;
  list: () => Promise<BotDeviceStorageEntry[]>;
  get: (scope: BotDeviceStorageScope) => Promise<BotDeviceStorageEntry>;
  setDecision: (scope: BotDeviceStorageScope, decision: BotDeviceStorageDecision) => Promise<BotDeviceStorageEntry>;
  setQuota: (scope: BotDeviceStorageScope, maxBytes: number) => Promise<BotDeviceStorageEntry>;
  /** Deletes what the bot stored and keeps the preference. */
  clear: (scopeId: string) => Promise<void>;
  /** Deletes what the bot stored and the preferences of that server, account and bot. */
  forget: (scopeId: string) => Promise<void>;
  onChanged: Subscribe<'bot-storage:changed'>;
}

/**
 * What the main window's page may ask of Main. A member typed `Invoke<channel>`
 * or `Subscribe<event>` is exactly that channel of the contract in @monky/shared
 * (`IpcInvokeChannels`/`IpcEvents`); the others add something of the preload's.
 */
export interface ElectronApi {
  createBotScreenDocument: Invoke<'bot-screen-document:create'>;
  removeBotScreenDocument: Invoke<'bot-screen-document:remove'>;
  botStorage: BotStorageApi;
  nativeScreenCommand: Invoke<'native-screen:invoke'>;
  nativeScreenReply: Invoke<'native-screen:reply'>;
  onNativeScreenEvent: Subscribe<'native-screen:event'>;
  attachNativeScreenPresentation: (input: NativeScreenPresentation) => Promise<void>;
  attachNativeScreenPreview: (input: NativeScreenPresentation) => Promise<void>;
  stopNativeScreenPresentation: (presentationId: string) => Promise<void>;
  sampleNativeScreenPresentation: (presentationId: string) => Promise<NativeScreenPresentationSample | null>;
  onNativeScreenPresentationError: (callback: (value: { presentationId: string | null; message: string }) => void) => () => void;
  takeServerInvite: Invoke<'server-invite:take'>;
  onServerInviteAvailable: Subscribe<'server-invite:available'>;
  getDevelopmentQaConfig: Invoke<'development-qa:config'>;
  reportDevelopmentQaState: Invoke<'development-qa:report'>;
  startLanDiscovery: Invoke<'lan:start'>;
  stopLanDiscovery: Invoke<'lan:stop'>;
  onLanDiscoveryFound: Subscribe<'lan:found'>;
  onLanDiscoveryLost: Subscribe<'lan:lost'>;
  setLanguage: Invoke<'app:set-language'>;
  /** Whether this computer has a usable identity, none yet, or one that could not be opened. */
  getIdentityStatus: Invoke<'identity:status'>;
  /** Creates an identity when there is no readable one; an unreadable file is set aside, never deleted. */
  createIdentity: Invoke<'identity:create'>;
  getIdentity: Invoke<'identity:get'>;
  getClientId: Invoke<'identity:get-client-id'>;
  signChallenge: Invoke<'identity:sign-challenge'>;
  exportIdentity: Invoke<'identity:export'>;
  /**
   * Imports an identity code. A code of another identity than the one in use answers `confirm-replace`
   * without writing anything; calling again with `replace` set to that public key switches to it.
   */
  importIdentity: Invoke<'identity:import'>;
  /** Deletes the identity, friends and DMs from this computer, then relaunches Monky. */
  logOut: Invoke<'identity:logout'>;
  dm: DmApi;
  saveBackupFile: Invoke<'backup:save-file'>;
  openBackupFile: Invoke<'backup:open-file'>;
  encryptBackup: Invoke<'backup:encrypt'>;
  decryptBackup: Invoke<'backup:decrypt'>;
  hostServerStart: Invoke<'server-host:start'>;
  hostServerStop: Invoke<'server-host:stop'>;
  hostServerStatus: Invoke<'server-host:status'>;
  hostServerLogs: Invoke<'server-host:logs'>;
  hostServerClearLogs: Invoke<'server-host:clear-logs'>;
  hostServerStats: Invoke<'server-host:stats'>;
  hostServerDeleteData: Invoke<'server-host:delete-data'>;
  onHostServerLog: Subscribe<'server-host:log'>;
  onHostServerStatusChanged: Subscribe<'server-host:status-changed'>;
  getDesktopSources: Invoke<'screen-share:get-sources'>;
  getDesktopSourcePreviews: Invoke<'screen-share:get-previews'>;
  cancelDesktopSourcePreviews: Invoke<'screen-share:cancel-previews'>;
  prepareScreenShareWindow: Invoke<'screen-share:prepare-window'>;
  ensureScreenPermission: Invoke<'screen-share:ensure-permission'>;
  selectImageDialog: Invoke<'dialog:select-image'>;
  selectImagesDialog: Invoke<'dialog:select-images'>;
  selectSoundFile: Invoke<'dialog:select-sound-file'>;
  selectSoundboardFolder: Invoke<'dialog:select-soundboard-folder'>;
  getDefaultSoundboardFolder: Invoke<'soundboard:default-folder'>;
  /** The preload adds whether a direct user action asked for it (D4). */
  listSoundboardSounds: (folderPath: string) => Promise<SoundboardSoundEntry[]>;
  readSoundboardSound: Invoke<'soundboard:read-sound'>;
  readSoundboardEdit: Invoke<'soundboard:edit-read'>;
  openSoundboardEditor: Invoke<'soundboard:open-editor'>;
  overwriteSoundboardAudio: Invoke<'soundboard:overwrite-audio'>;
  renameSoundboardFile: Invoke<'soundboard:rename-file'>;
  deleteSoundboardFile: Invoke<'soundboard:delete-file'>;
  saveSoundboardEdit: Invoke<'soundboard:save-edited-copy'>;
  soundDownloadAvailability: Invoke<'soundboard:download-availability'>;
  confirmSoundboardFolder: Invoke<'soundboard:confirm-download-folder'>;
  authorizeSoundDownload: Invoke<'soundboard:authorize-download'>;
  downloadSound: Invoke<'soundboard:download-sound'>;
  cancelSoundDownload: Invoke<'soundboard:cancel-download'>;
  onSoundDownloadProgress: Subscribe<'soundboard:download-progress'>;
  loadAudioPreview: Invoke<'audio-preview:load'>;
  cancelAudioPreview: Invoke<'audio-preview:cancel'>;
  getLocalExecutionState: Invoke<'local-execution:get-state'>;
  setLocalExecutionPermission: Invoke<'local-execution:set-permission'>;
  removeLocalTool: Invoke<'local-execution:remove-tool'>;
  clearLocalExecutionCache: Invoke<'local-execution:clear-cache'>;
  cancelLocalExecutionTask: Invoke<'local-execution:cancel-task'>;
  onLocalExecutionChanged: Subscribe<'local-execution:changed'>;
  prepareLocalExecution: Invoke<'local-execution:prepare'>;
  startLocalExecutionTask: Invoke<'local-execution:start-task'>;
  readLocalExecutionFrames: Invoke<'local-execution:read-frames'>;
  acknowledgeLocalExecutionFrames: Invoke<'local-execution:acknowledge-frames'>;
  cancelLocalExecutionRequest: Invoke<'local-execution:cancel-request'>;
  setLocalExecutionPaused: Invoke<'local-execution:set-paused'>;
  setLocalExecutionConnection: Invoke<'local-execution:set-connection'>;
  onLocalExecutionTaskFailed: Subscribe<'local-execution:task-failed'>;
  selectStickersFolder: Invoke<'dialog:select-stickers-folder'>;
  /** The preload adds whether a direct user action asked for it (D4). */
  listStickers: (folderPath: string) => Promise<StickerEntry[]>;
  readSticker: Invoke<'stickers:read'>;
  saveSticker: Invoke<'stickers:save'>;
  registerSoundboardShortcuts: Invoke<'soundboard:register-shortcuts'>;
  onSoundboardShortcutTriggered: Subscribe<'soundboard:shortcut-triggered'>;
  registerActionShortcuts: Invoke<'shortcuts:register-actions'>;
  setShortcutCapture: Invoke<'shortcuts:set-capture'>;
  onActionShortcutTriggered: Subscribe<'shortcut:action-triggered'>;
  setPttConfig: Invoke<'ptt:set-config'>;
  startPttCapture: Invoke<'ptt:start-capture'>;
  stopPttCapture: Invoke<'ptt:stop-capture'>;
  onPttStateChanged: Subscribe<'ptt:state-changed'>;
  onPttCaptured: Subscribe<'ptt:captured'>;
  minimize: Invoke<'window:minimize'>;
  openScreenPictureInPicture: Invoke<'screen-pip:open'>;
  returnFromScreenPictureInPicture: Invoke<'screen-pip:return'>;
  onWindowInactive: Subscribe<'window:inactive'>;
  onWindowActive: Subscribe<'window:active'>;
  maximize: Invoke<'window:maximize'>;
  toggleMaximize: Invoke<'window:toggle-maximize'>;
  setWindowInServer: Invoke<'window:set-in-server'>;
  fitHomeWindowToContent: Invoke<'window:fit-home-content'>;
  close: Invoke<'window:close'>;
  getAppVersion: Invoke<'app:get-version'>;
  /** Reveals the window and tells the crash recovery that the renderer started. */
  signalRendererReady: () => void;
  reportFatalBootstrap: Invoke<'crash-recovery:bootstrap-failed'>;
  checkForUpdates: Invoke<'updater:check'>;
  downloadUpdate: Invoke<'updater:download'>;
  cancelUpdate: Invoke<'updater:cancel'>;
  checkUpdateCompatibility: Invoke<'updater:preflight'>;
  installUpdate: Invoke<'updater:install'>;
  setUpdateChannel: Invoke<'updater:set-channel'>;
  getUpdateOutcome: Invoke<'updater:outcome'>;
  getReleaseNotes: Invoke<'updater:release-notes'>;
  getReleaseHistory: Invoke<'updater:release-history'>;
  onUpdateProgress: Subscribe<'updater:progress'>;
  onUpdateDownloaded: Subscribe<'updater:downloaded'>;
  onUpdateError: Subscribe<'updater:error'>;
  openExternal: Invoke<'app:open-external'>;
  editorCommand: Invoke<'editor:command'>;
  fetchLinkPreview: Invoke<'link-preview:fetch'>;
  downloadFile: Invoke<'app:download-file'>;
  downloadFiles: Invoke<'app:download-files'>;
  saveRecentSound: Invoke<'app:save-recent-sound'>;
  saveCsvFile: Invoke<'app:save-csv-file'>;
  saveEventCalendar: Invoke<'community:save-event-calendar'>;
  saveHostingSkill: Invoke<'onboarding:save-hosting-skill'>;
  probeServer: Invoke<'net:probe-server'>;
  updateTrayVoiceStatus: Invoke<'tray:update-voice-status'>;
  // Encerramento gracioso: sair das chamadas antes do processo morrer (#458)
  onAppBeforeQuit: Subscribe<'app:before-quit'>;
  notifyLeaveComplete: Invoke<'app:leave-complete'>;
  onTrayToggleMute: Subscribe<'tray:toggle-mute'>;
  onTrayToggleDeafen: Subscribe<'tray:toggle-deafen'>;
  onTrayLeaveCall: Subscribe<'tray:leave-call'>;
  getAutoStart: Invoke<'app:get-auto-start'>;
  setAutoStart: Invoke<'app:set-auto-start'>;
  setMinimizeToTray: Invoke<'app:set-minimize-to-tray'>;
  // Presença de jogo (#675)
  setGamePresenceEnabled: Invoke<'game-presence:set-enabled'>;
  getCurrentGameActivity: Invoke<'game-presence:get-current'>;
  findGameWindows: Invoke<'game-share:find-windows'>;
  /** Seconds since the last keyboard or mouse input in the whole system, for the AFK channel. */
  getSystemIdleSeconds: Invoke<'system:get-idle-seconds'>;
  onGamePresenceChanged: Subscribe<'game-presence:changed'>;
  // Sobreposição de Tela (Overlay) (#169)
  openOverlay: Invoke<'overlay:open'>;
  closeOverlay: Invoke<'overlay:close'>;
  isOverlayOpen: Invoke<'overlay:is-open'>;
  getOverlayConfig: Invoke<'overlay:get-config'>;
  setOverlayConfig: Invoke<'overlay:set-config'>;
  saveOverlayBounds: Invoke<'overlay:save-bounds'>;
  resetOverlayBounds: Invoke<'overlay:reset-bounds'>;
  layoutOverlayCards: Invoke<'overlay:layout-cards'>;
  sendOverlaySignal: Invoke<'overlay:send-signal'>;
  sendOverlaySyncState: Invoke<'overlay:send-sync-state'>;
  onOverlayStateChanged: Subscribe<'overlay:state-changed'>;
  onOverlayConfigUpdated: Subscribe<'overlay:config-updated'>;
  onOverlaySignalReceived: Subscribe<'overlay:signal-received'>;
  onOverlaySyncStateReceived: Subscribe<'overlay:sync-state-received'>;
  onOverlayCloseRequested: Subscribe<'overlay:close-requested'>;
  onOverlayHoverChanged: Subscribe<'overlay:hover-changed'>;
  onOverlayResizeStateChanged: Subscribe<'overlay:resize-state-changed'>;

  // Client Logging (#444)
  writeClientLog: Invoke<'client-log:write'>;
  getClientLogConfig: Invoke<'client-log:get-config'>;
  setClientLogConfig: Invoke<'client-log:set-config'>;
  exportClientLogs: Invoke<'client-log:export'>;
  getClientLogSize: Invoke<'client-log:get-size'>;
  clearClientLogs: Invoke<'client-log:clear'>;
  platform: string;
}
