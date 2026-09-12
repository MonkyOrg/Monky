import { contextBridge, ipcRenderer } from 'electron';
import { AUDIO_PREVIEW_IPC, SHORTCUT_IPC, SOUND_DOWNLOAD_IPC, SOUND_DOWNLOAD_PROGRESS } from '@monky/shared';
import type {
  ActionShortcutBinding,
  AudioPreviewCancellation,
  AudioPreviewInput,
  AudioPreviewResult,
  AppIdentityImportResult,
  AppIdentityResult,
  BackupCryptoResult,
  ClientLogConfig,
  ClientLogEntry,
  DesktopSource,
  DiscoveredLanServer,
  HostServerOptions,
  ImageSelectionResult,
  LinkPreviewData,
  LogEntry,
  OverlayBounds,
  OverlayConfig,
  OverlaySignalPayload,
  OverlaySyncState,
  PttConfig,
  PttKeyBinding,
  ScreenAudioDiagnostics,
  ServerProbeResult,
  ServerStats,
  SoundboardShortcutBinding,
  SoundboardSoundData,
  SoundboardSoundEntry,
  SoundboardDownloadAvailability,
  SoundboardDownloadAuthorization,
  SoundboardDownloadPermit,
  SoundboardDownloadInput,
  SoundboardDownloadCancellation,
  SoundboardDownloadProgress,
  SoundDownloadResult,
  StickerData,
  StickerEntry,
  StickerSaveResult,
  TrayVoiceStatus,
  UpdateCheckResult,
  UpdateOutcome,
  ReleaseNotesResult,
  UpdateSimpleResult,
} from '@monky/shared';

export type { LinkPreviewData, OverlayBounds, OverlayConfig, OverlayMode, OverlayLayout, OverlayPosition, OverlayParticipantState, OverlaySyncState } from '@monky/shared';

export interface ElectronApi {
  startLanDiscovery: () => Promise<void>;
  stopLanDiscovery: () => Promise<void>;
  onLanDiscoveryFound: (cb: (server: DiscoveredLanServer) => void) => () => void;
  onLanDiscoveryLost: (cb: (server: DiscoveredLanServer) => void) => () => void;
  setLanguage: (language: string) => Promise<void>;
  hasIdentity: () => Promise<boolean>;
  getIdentity: () => Promise<AppIdentityResult>;
  getClientId: () => Promise<string>;
  signChallenge: (nonceHex: string) => Promise<string>;
  exportIdentity: (password: string, extras?: string) => Promise<string>;
  importIdentity: (exportedIdentity: string, password: string) => Promise<AppIdentityImportResult>;
  saveBackupFile: (contents: string, suggestedName: string) => Promise<{ success: boolean; filePath?: string; error?: string }>;
  openBackupFile: () => Promise<{ success: boolean; contents?: string; error?: string }>;
  encryptBackup: (contents: string, password: string) => Promise<BackupCryptoResult>;
  decryptBackup: (payload: string, password: string) => Promise<BackupCryptoResult>;
  hostServerStart: (options: HostServerOptions) => Promise<{ success: boolean; error?: string }>;
  hostServerStop: () => Promise<{ success: boolean }>;
  hostServerStatus: () => Promise<{ isRunning: boolean; port: number | null; serverId: string | null }>;
  hostServerLogs: () => Promise<LogEntry[]>;
  hostServerClearLogs: () => Promise<void>;
  hostServerStats: () => Promise<ServerStats | null>;
  hostServerDeleteData: (serverId: string) => Promise<{ success: boolean; error?: string }>;
  onHostServerLog: (callback: (entry: LogEntry) => void) => () => void;
  onHostServerStatusChanged: (
    callback: (status: { isRunning: boolean; port: number | null; serverId: string | null }) => void
  ) => () => void;
  getDesktopSources: () => Promise<DesktopSource[]>;
  prepareScreenShareWindow: (sourceId: string) => Promise<boolean>;
  ensureScreenPermission: () => Promise<boolean>;
  selectImageDialog: () => Promise<ImageSelectionResult | null>;
  selectSoundFile: () => Promise<string | null>;
  selectSoundboardFolder: () => Promise<string | null>;
  listSoundboardSounds: (folderPath: string) => Promise<SoundboardSoundEntry[]>;
  readSoundboardSound: (filePath: string) => Promise<SoundboardSoundData | null>;
  soundDownloadAvailability: (configuredFolder: string) => Promise<SoundboardDownloadAvailability>;
  authorizeSoundDownload: (input: SoundboardDownloadAuthorization) => Promise<SoundboardDownloadPermit>;
  downloadSound: (input: SoundboardDownloadInput) => Promise<SoundDownloadResult>;
  cancelSoundDownload: (key: SoundboardDownloadCancellation) => Promise<boolean>;
  onSoundDownloadProgress: (cb: (progress: SoundboardDownloadProgress) => void) => () => void;
  loadAudioPreview: (input: AudioPreviewInput) => Promise<AudioPreviewResult>;
  cancelAudioPreview: (input: AudioPreviewCancellation) => Promise<boolean>;
  selectStickersFolder: () => Promise<string | null>;
  listStickers: (folderPath: string) => Promise<StickerEntry[]>;
  readSticker: (filePath: string) => Promise<StickerData | null>;
  saveSticker: (folderPath: string, fileName: string, bytes: Uint8Array) => Promise<StickerSaveResult>;
  registerSoundboardShortcuts: (shortcuts: SoundboardShortcutBinding[]) => Promise<boolean>;
  onSoundboardShortcutTriggered: (cb: (soundName: string) => void) => () => void;
  registerActionShortcuts: (shortcuts: ActionShortcutBinding[]) => Promise<boolean>;
  setShortcutCapture: (active: boolean) => Promise<boolean>;
  onActionShortcutTriggered: (cb: (action: string) => void) => () => void;
  setPttConfig: (config: PttConfig) => Promise<boolean>;
  startPttCapture: () => Promise<boolean>;
  stopPttCapture: () => Promise<boolean>;
  onPttStateChanged: (cb: (active: boolean) => void) => () => void;
  onPttCaptured: (cb: (binding: PttKeyBinding) => void) => () => void;
  minimize: () => Promise<void>;
  maximize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  setWindowInServer: (inServer: boolean) => Promise<void>;
  fitHomeWindowToContent: (contentHeight: number) => Promise<void>;
  close: () => Promise<void>;
  getAppVersion: () => Promise<string>;
  signalRendererReady: () => void;
  checkForUpdates: () => Promise<UpdateCheckResult>;
  downloadUpdate: () => Promise<UpdateSimpleResult>;
  installUpdate: () => Promise<UpdateSimpleResult>;
  setUpdateChannel: (allowBeta: boolean) => Promise<UpdateSimpleResult>;
  getUpdateOutcome: () => Promise<UpdateOutcome | null>;
  getReleaseNotes: (tag?: string) => Promise<ReleaseNotesResult>;
  onUpdateProgress: (cb: (percent: number) => void) => () => void;
  onUpdateDownloaded: (cb: (info: { manual: boolean }) => void) => () => void;
  onUpdateError: (cb: (message: string) => void) => () => void;
  openExternal: (url: string) => Promise<{ success: boolean }>;
  fetchLinkPreview: (url: string) => Promise<LinkPreviewData | null>;
  downloadFile: (url: string, fileName: string) => Promise<{ success: boolean; error?: string }>;
  probeServer: (host: string, port: number) => Promise<ServerProbeResult>;
  screenAudioSupported: () => Promise<boolean>;
  screenAudioDiagnose: () => Promise<ScreenAudioDiagnostics>;
  screenAudioStart: (sourceId?: string) => Promise<{ success: boolean; error?: string }>;
  screenAudioStop: () => Promise<{ success: boolean }>;
  onScreenAudioFrame: (cb: (buffer: ArrayBuffer | Uint8Array) => void) => () => void;
  removeScreenAudioFrameListener: () => void;
  onScreenAudioError: (cb: (errorMsg: string) => void) => () => void;
  updateTrayVoiceStatus: (status: TrayVoiceStatus) => Promise<void>;
  // Encerramento gracioso: sair das chamadas antes do processo morrer (#458)
  onAppBeforeQuit: (cb: () => void) => () => void;
  notifyLeaveComplete: () => Promise<void>;
  onTrayToggleMute: (cb: () => void) => () => void;
  onTrayToggleDeafen: (cb: () => void) => () => void;
  getAutoStart: () => Promise<boolean>;
  setAutoStart: (enabled: boolean) => Promise<void>;
  setMinimizeToTray: (enabled: boolean) => Promise<void>;
  // Sobreposição de Tela (Overlay) (#169)
  openOverlay: (config: OverlayConfig) => Promise<{ success: boolean }>;
  closeOverlay: () => Promise<{ success: boolean }>;
  isOverlayOpen: () => Promise<boolean>;
  getOverlayConfig: () => Promise<OverlayConfig | null>;
  setOverlayConfig: (config: Partial<OverlayConfig>) => Promise<void>;
  saveOverlayBounds: (bounds: OverlayBounds) => Promise<void>;
  resetOverlayBounds: () => Promise<void>;
  sendOverlaySignal: (payload: OverlaySignalPayload) => Promise<void>;
  sendOverlaySyncState: (state: OverlaySyncState) => Promise<void>;
  onOverlayStateChanged: (cb: (isOpen: boolean) => void) => () => void;
  onOverlayConfigUpdated: (cb: (config: OverlayConfig) => void) => () => void;
  onOverlaySignalReceived: (cb: (signal: string) => void) => () => void;
  onOverlaySyncStateReceived: (cb: (state: OverlaySyncState) => void) => () => void;
  onOverlayCloseRequested: (cb: () => void) => () => void;
  onOverlayHoverChanged: (cb: (hovered: boolean) => void) => () => void;

  // Client Logging (#444)
  writeClientLog: (entry: ClientLogEntry) => Promise<void>;
  getClientLogConfig: () => Promise<ClientLogConfig>;
  setClientLogConfig: (config: Partial<ClientLogConfig>) => Promise<void>;
  exportClientLogs: () => Promise<{ success: boolean; filePath?: string; error?: string }>;
  getClientLogSize: () => Promise<number>;
  clearClientLogs: () => Promise<void>;
  platform: string;
}

const api: ElectronApi = {
  startLanDiscovery: () => ipcRenderer.invoke('lan:start'),
  stopLanDiscovery: () => ipcRenderer.invoke('lan:stop'),
  onLanDiscoveryFound: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, server: DiscoveredLanServer) => cb(server);
    ipcRenderer.on('lan:found', listener);
    return () => {
      ipcRenderer.removeListener('lan:found', listener);
    };
  },
  onLanDiscoveryLost: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, server: DiscoveredLanServer) => cb(server);
    ipcRenderer.on('lan:lost', listener);
    return () => {
      ipcRenderer.removeListener('lan:lost', listener);
    };
  },
  setLanguage: (language) => ipcRenderer.invoke('app:set-language', language),
  hasIdentity: () => ipcRenderer.invoke('identity:has'),
  getIdentity: () => ipcRenderer.invoke('identity:get'),
  getClientId: () => ipcRenderer.invoke('identity:get-client-id'),
  signChallenge: (nonceHex) => ipcRenderer.invoke('identity:sign-challenge', nonceHex),
  exportIdentity: (password, extras) => ipcRenderer.invoke('identity:export', password, extras),
  importIdentity: (exportedIdentity, password) => ipcRenderer.invoke('identity:import', exportedIdentity, password),
  saveBackupFile: (contents, suggestedName) => ipcRenderer.invoke('backup:save-file', contents, suggestedName),
  openBackupFile: () => ipcRenderer.invoke('backup:open-file'),
  encryptBackup: (contents, password) => ipcRenderer.invoke('backup:encrypt', contents, password),
  decryptBackup: (payload, password) => ipcRenderer.invoke('backup:decrypt', payload, password),
  hostServerStart: (options) => ipcRenderer.invoke('server-host:start', options),
  hostServerStop: () => ipcRenderer.invoke('server-host:stop'),
  hostServerStatus: () => ipcRenderer.invoke('server-host:status'),
  hostServerLogs: () => ipcRenderer.invoke('server-host:logs'),
  hostServerClearLogs: () => ipcRenderer.invoke('server-host:clear-logs'),
  hostServerStats: () => ipcRenderer.invoke('server-host:stats'),
  hostServerDeleteData: (serverId) => ipcRenderer.invoke('server-host:delete-data', serverId),
  onHostServerLog: (callback) => {
    const listener = (_event: unknown, entry: LogEntry) => callback(entry);
    ipcRenderer.on('server-host:log', listener);
    return () => ipcRenderer.removeListener('server-host:log', listener);
  },
  onHostServerStatusChanged: (callback) => {
    const listener = (
      _event: unknown,
      status: { isRunning: boolean; port: number | null; serverId: string | null }
    ) => callback(status);
    ipcRenderer.on('server-host:status-changed', listener);
    return () => ipcRenderer.removeListener('server-host:status-changed', listener);
  },
  getDesktopSources: () => ipcRenderer.invoke('screen-share:get-sources'),
  prepareScreenShareWindow: (sourceId: string) => ipcRenderer.invoke('screen-share:prepare-window', sourceId),
  ensureScreenPermission: (): Promise<boolean> => ipcRenderer.invoke('screen-share:ensure-permission'),
  selectImageDialog: () => ipcRenderer.invoke('dialog:select-image'),
  selectSoundFile: () => ipcRenderer.invoke('dialog:select-sound-file'),
  selectSoundboardFolder: () => ipcRenderer.invoke('dialog:select-soundboard-folder'),
  listSoundboardSounds: (folderPath) => ipcRenderer.invoke('soundboard:list-sounds', folderPath),
  readSoundboardSound: (filePath) => ipcRenderer.invoke('soundboard:read-sound', filePath),
  soundDownloadAvailability: (folder) => ipcRenderer.invoke(SOUND_DOWNLOAD_IPC.availability, folder),
  authorizeSoundDownload: (input) => ipcRenderer.invoke(SOUND_DOWNLOAD_IPC.authorize, input),
  downloadSound: (input) => ipcRenderer.invoke(SOUND_DOWNLOAD_IPC.download, input),
  cancelSoundDownload: (key) => ipcRenderer.invoke(SOUND_DOWNLOAD_IPC.cancel, key),
  loadAudioPreview: (input) => ipcRenderer.invoke(AUDIO_PREVIEW_IPC.load, input),
  cancelAudioPreview: (input) => ipcRenderer.invoke(AUDIO_PREVIEW_IPC.cancel, input),
  onSoundDownloadProgress: (cb) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: SoundboardDownloadProgress) => cb(progress);
    ipcRenderer.on(SOUND_DOWNLOAD_PROGRESS, listener);
    return () => ipcRenderer.removeListener(SOUND_DOWNLOAD_PROGRESS, listener);
  },
  selectStickersFolder: () => ipcRenderer.invoke('dialog:select-stickers-folder'),
  listStickers: (folderPath) => ipcRenderer.invoke('stickers:list', folderPath),
  readSticker: (filePath) => ipcRenderer.invoke('stickers:read', filePath),
  saveSticker: (folderPath, fileName, bytes) => ipcRenderer.invoke('stickers:save', folderPath, fileName, bytes),
  registerSoundboardShortcuts: (shortcuts) => ipcRenderer.invoke(SHORTCUT_IPC.registerSoundboard, shortcuts),
  onSoundboardShortcutTriggered: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, soundName: string) => cb(soundName);
    ipcRenderer.on('soundboard:shortcut-triggered', listener);
    return () => {
      ipcRenderer.removeListener('soundboard:shortcut-triggered', listener);
    };
  },
  registerActionShortcuts: (shortcuts) => ipcRenderer.invoke(SHORTCUT_IPC.registerActions, shortcuts),
  setShortcutCapture: (active) => ipcRenderer.invoke(SHORTCUT_IPC.setCapture, active),
  onActionShortcutTriggered: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, action: string) => cb(action);
    ipcRenderer.on('shortcut:action-triggered', listener);
    return () => {
      ipcRenderer.removeListener('shortcut:action-triggered', listener);
    };
  },
  setPttConfig: (config) => ipcRenderer.invoke(SHORTCUT_IPC.setPttConfig, config),
  startPttCapture: () => ipcRenderer.invoke(SHORTCUT_IPC.startPttCapture),
  stopPttCapture: () => ipcRenderer.invoke(SHORTCUT_IPC.stopPttCapture),
  onPttStateChanged: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, active: boolean) => cb(active);
    ipcRenderer.on('ptt:state-changed', listener);
    return () => {
      ipcRenderer.removeListener('ptt:state-changed', listener);
    };
  },
  onPttCaptured: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, binding: PttKeyBinding) => cb(binding);
    ipcRenderer.on('ptt:captured', listener);
    return () => {
      ipcRenderer.removeListener('ptt:captured', listener);
    };
  },
  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
  setWindowInServer: (inServer) => ipcRenderer.invoke('window:set-in-server', inServer),
  fitHomeWindowToContent: (contentHeight) => ipcRenderer.invoke('window:fit-home-content', contentHeight),
  close: () => ipcRenderer.invoke('window:close'),
  getAppVersion: () => ipcRenderer.invoke('app:get-version'),
  signalRendererReady: () => ipcRenderer.send('app:renderer-ready'),
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  downloadUpdate: () => ipcRenderer.invoke('updater:download'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  setUpdateChannel: (allowBeta) => ipcRenderer.invoke('updater:set-channel', allowBeta),
  getUpdateOutcome: () => ipcRenderer.invoke('updater:outcome'),
  getReleaseNotes: (tag) => ipcRenderer.invoke('updater:release-notes', tag),
  onUpdateProgress: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, percent: number) => cb(percent);
    ipcRenderer.on('updater:progress', listener);
    return () => {
      ipcRenderer.removeListener('updater:progress', listener);
    };
  },
  onUpdateDownloaded: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, info: { manual: boolean }) => cb(info);
    ipcRenderer.on('updater:downloaded', listener);
    return () => {
      ipcRenderer.removeListener('updater:downloaded', listener);
    };
  },
  onUpdateError: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, message: string) => cb(message);
    ipcRenderer.on('updater:error', listener);
    return () => {
      ipcRenderer.removeListener('updater:error', listener);
    };
  },
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  fetchLinkPreview: (url) => ipcRenderer.invoke('link-preview:fetch', url),
  downloadFile: (url, fileName) => ipcRenderer.invoke('app:download-file', url, fileName),
  probeServer: (host, port) => ipcRenderer.invoke('net:probe-server', host, port),
  screenAudioSupported: () => ipcRenderer.invoke('screen-audio:is-supported'),
  screenAudioDiagnose: () => ipcRenderer.invoke('screen-audio:diagnose'),
  screenAudioStart: (sourceId) => ipcRenderer.invoke('screen-audio:start', sourceId),
  screenAudioStop: () => ipcRenderer.invoke('screen-audio:stop'),
  onScreenAudioFrame: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, buffer: ArrayBuffer | Uint8Array) => cb(buffer);
    ipcRenderer.on('screen-audio:frame', listener);
    return () => {
      ipcRenderer.removeListener('screen-audio:frame', listener);
    };
  },
  removeScreenAudioFrameListener: () => ipcRenderer.removeAllListeners('screen-audio:frame'),
  onScreenAudioError: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, errorMsg: string) => cb(errorMsg);
    ipcRenderer.on('screen-audio:error', listener);
    return () => {
      ipcRenderer.removeListener('screen-audio:error', listener);
    };
  },
  updateTrayVoiceStatus: (status) => ipcRenderer.invoke('tray:update-voice-status', status),
  onAppBeforeQuit: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('app:before-quit', listener);
    return () => {
      ipcRenderer.removeListener('app:before-quit', listener);
    };
  },
  notifyLeaveComplete: () => ipcRenderer.invoke('app:leave-complete'),
  onTrayToggleMute: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('tray:toggle-mute', listener);
    return () => {
      ipcRenderer.removeListener('tray:toggle-mute', listener);
    };
  },
  onTrayToggleDeafen: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('tray:toggle-deafen', listener);
    return () => {
      ipcRenderer.removeListener('tray:toggle-deafen', listener);
    };
  },
  getAutoStart: () => ipcRenderer.invoke('app:get-auto-start'),
  setAutoStart: (enabled: boolean) => ipcRenderer.invoke('app:set-auto-start', enabled),
  setMinimizeToTray: (enabled: boolean) => ipcRenderer.invoke('app:set-minimize-to-tray', enabled),
  // Sobreposição de Tela (Overlay) (#169)
  openOverlay: (config) => ipcRenderer.invoke('overlay:open', config),
  closeOverlay: () => ipcRenderer.invoke('overlay:close'),
  isOverlayOpen: () => ipcRenderer.invoke('overlay:is-open'),
  getOverlayConfig: () => ipcRenderer.invoke('overlay:get-config'),
  setOverlayConfig: (config) => ipcRenderer.invoke('overlay:set-config', config),
  saveOverlayBounds: (bounds) => ipcRenderer.invoke('overlay:save-bounds', bounds),
  resetOverlayBounds: () => ipcRenderer.invoke('overlay:reset-bounds'),
  sendOverlaySignal: (payload) => ipcRenderer.invoke('overlay:send-signal', payload),
  sendOverlaySyncState: (state) => ipcRenderer.invoke('overlay:send-sync-state', state),
  onOverlayStateChanged: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, isOpen: boolean) => cb(isOpen);
    ipcRenderer.on('overlay:state-changed', listener);
    return () => {
      ipcRenderer.removeListener('overlay:state-changed', listener);
    };
  },
  onOverlayConfigUpdated: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, config: OverlayConfig) => cb(config);
    ipcRenderer.on('overlay:config-updated', listener);
    return () => {
      ipcRenderer.removeListener('overlay:config-updated', listener);
    };
  },
  onOverlaySignalReceived: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, signal: string) => cb(signal);
    ipcRenderer.on('overlay:signal-received', listener);
    return () => {
      ipcRenderer.removeListener('overlay:signal-received', listener);
    };
  },
  onOverlaySyncStateReceived: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, state: OverlaySyncState) => cb(state);
    ipcRenderer.on('overlay:sync-state-received', listener);
    return () => {
      ipcRenderer.removeListener('overlay:sync-state-received', listener);
    };
  },
  onOverlayCloseRequested: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('overlay:close-requested', listener);
    return () => {
      ipcRenderer.removeListener('overlay:close-requested', listener);
    };
  },
  onOverlayHoverChanged: (cb) => {
    const listener = (_e: Electron.IpcRendererEvent, hovered: boolean) => cb(hovered);
    ipcRenderer.on('overlay:hover-changed', listener);
    return () => {
      ipcRenderer.removeListener('overlay:hover-changed', listener);
    };
  },

  // Client Logging (#444)
  writeClientLog: (entry) => ipcRenderer.invoke('client-log:write', entry),
  getClientLogConfig: () => ipcRenderer.invoke('client-log:get-config'),
  setClientLogConfig: (config) => ipcRenderer.invoke('client-log:set-config', config),
  exportClientLogs: () => ipcRenderer.invoke('client-log:export'),
  getClientLogSize: () => ipcRenderer.invoke('client-log:get-size'),
  clearClientLogs: () => ipcRenderer.invoke('client-log:clear'),
  platform: process.platform,
};

contextBridge.exposeInMainWorld('api', api);

declare global {
  interface Window {
    api: ElectronApi;
  }
}
