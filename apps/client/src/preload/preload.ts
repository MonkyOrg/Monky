import { contextBridge, ipcRenderer, sharedTexture } from 'electron';
import nativePcmPlayoutWorklet from '@monky/screen-share/runtime/nativePcmPlayout.worklet.js?raw';
import type { NativeScreenPresentationController } from '@monky/screen-share/renderer';
import * as nativeAudioProtocol from '@monky/shared';
import {
  APP_RENDERER_READY, APP_SHUTDOWN_EVENT, APP_SHUTDOWN_IPC, AUDIO_PREVIEW_IPC, BOT_SCREEN_DOCUMENT_IPC, BOT_STORAGE_CHANGED,
  BOT_STORAGE_IPC, CRASH_RECOVERY_IPC, DESKTOP_SOURCES_IPC, DEVELOPMENT_QA_IPC, DM_EVENT, DM_IPC, EDITOR_COMMAND_IPC,
  EVENT_CALENDAR_IPC, FILE_BATCH_DOWNLOAD_IPC, HOSTING_SKILL_IPC, LOCAL_EXECUTION_CHANGED, LOCAL_EXECUTION_IPC,
  LOCAL_EXECUTION_TASK_FAILED, MEDIA_FOLDERS_IPC, NATIVE_SCREEN_EVENT, NATIVE_SCREEN_IPC, SERVER_INVITE_AVAILABLE,
  SERVER_INVITE_IPC, SHORTCUT_IPC, SOUND_DOWNLOAD_IPC, SOUND_DOWNLOAD_PROGRESS, SOUNDBOARD_FILES_IPC, UPDATER_IPC,
  nativeScreenEventSchema,
  type ConfiguredMediaFolders,
} from '@monky/shared';
import type { ElectronApi } from './api';
import { invoke, send, subscribe } from './ipc';

export type { BotStorageApi, ElectronApi } from './api';

const preparedQa = process.argv.includes('--monky-prepared-qa');

/**
 * Sound and sticker folders configured before reading them required the system
 * dialog keep working (D4). This runs before any page script, so the folders
 * come from what the user saved, not from remote content; Main adopts only the
 * first report of each profile and ignores the rest.
 */
function reportConfiguredMediaFolders(): void {
  let saved: string | null;
  try { saved = window.localStorage.getItem('monky_settings'); }
  catch { return; } // Documents without storage (data: URLs) are not the application.
  let settings: unknown = null;
  try { settings = saved ? JSON.parse(saved) : null; }
  catch { /* Unreadable settings hold no folder; the report still closes the adoption. */ }
  const folder = (key: 'soundboardFolderPath' | 'stickersFolderPath'): string | undefined => {
    if (typeof settings !== 'object' || settings === null || !(key in settings)) return undefined;
    const value: unknown = Reflect.get(settings, key);
    return typeof value === 'string' && value ? value : undefined;
  };
  const folders: ConfiguredMediaFolders = { soundboard: folder('soundboardFolderPath'), stickers: folder('stickersFolderPath') };
  void invoke(MEDIA_FOLDERS_IPC.adopt, folders).catch((error: unknown) => {
    console.warn('[MediaFolders] Could not report the configured sound and sticker folders:', error);
  });
}
reportConfiguredMediaFolders();

type NativeScreenRenderer = typeof import('@monky/screen-share/renderer');
let nativeScreenRenderer: NativeScreenRenderer | null = null;
/**
 * Only the presentation and audio half of the native runtime, loaded with the
 * first native screen this window watches instead of with every window (E-MAIN-8).
 */
function screenRenderer(): NativeScreenRenderer {
  const loaded: NativeScreenRenderer = nativeScreenRenderer ?? require('@monky/screen-share/renderer');
  nativeScreenRenderer = loaded;
  return loaded;
}
let nativePresentation: NativeScreenPresentationController | null = null;
let nativeAudio: ReturnType<NativeScreenRenderer['registerNativeAudioPortReceiver']> | null = null;
let nativeAudioWorkletUrl: string | null = null;
function prepareNativeAudio(): void {
  if (nativeAudio) return;
  const url = URL.createObjectURL(new Blob([nativePcmPlayoutWorklet], { type: 'application/javascript' }));
  try {
    nativeAudio = screenRenderer().registerNativeAudioPortReceiver(ipcRenderer, nativeAudioProtocol, {
      workletUrl: url, onError: error => console.error('[NativeScreen] Audio output failed:', error),
    });
    nativeAudioWorkletUrl = url;
  } catch (error) { URL.revokeObjectURL(url); throw error; }
}
const nativePresentationErrors = new Set<(value: { presentationId: string | null; message: string }) => void>();
function presentationController(): NativeScreenPresentationController {
  if (!nativePresentation) nativePresentation = screenRenderer().createNativeScreenPresentation(sharedTexture, document, (presentationId, error) => {
    console.error('[NativeScreen] Presentation failed:', error);
    for (const callback of nativePresentationErrors) {
      try { callback({ presentationId, message: error.message }); }
      catch (observerError) { console.error('[NativeScreen] Presentation error observer failed:', observerError); }
    }
  }, ipcRenderer);
  return nativePresentation;
}
window.addEventListener('beforeunload', () => {
  void nativePresentation?.close().catch(error => console.error('[NativeScreen] Document presentation cleanup failed:', error));
  void nativeAudio?.dispose().catch(error => console.error('[NativeScreen] Document audio cleanup failed:', error)).finally(() => {
    if (nativeAudioWorkletUrl) URL.revokeObjectURL(nativeAudioWorkletUrl);
  });
  nativePresentationErrors.clear();
});
const api: ElectronApi = {
  nativeScreenCommand: command => {
    if (command?.action === 'watch') prepareNativeAudio();
    return invoke(NATIVE_SCREEN_IPC.invoke, command);
  },
  nativeScreenReply: reply => invoke(NATIVE_SCREEN_IPC.reply, reply),
  onNativeScreenEvent: callback => subscribe(NATIVE_SCREEN_EVENT, event => callback(nativeScreenEventSchema.parse(event))),
  attachNativeScreenPresentation: input => presentationController().attach(input),
  attachNativeScreenPreview: input => presentationController().attachPreview(input),
  stopNativeScreenPresentation: presentationId => presentationController().stop(presentationId),
  sampleNativeScreenPresentation: presentationId => presentationController().sample(presentationId),
  onNativeScreenPresentationError: callback => {
    nativePresentationErrors.add(callback);
    return () => { nativePresentationErrors.delete(callback); };
  },
  getDevelopmentQaConfig: () => preparedQa ? invoke(DEVELOPMENT_QA_IPC.config) : Promise.resolve(null),
  reportDevelopmentQaState: report => invoke(DEVELOPMENT_QA_IPC.report, report),
  startLanDiscovery: () => preparedQa ? Promise.resolve() : invoke('lan:start'),
  stopLanDiscovery: () => invoke('lan:stop'),
  onLanDiscoveryFound: callback => subscribe('lan:found', callback),
  onLanDiscoveryLost: callback => subscribe('lan:lost', callback),
  setLanguage: language => invoke('app:set-language', language),
  getIdentityStatus: () => invoke('identity:status'),
  createIdentity: () => invoke('identity:create'),
  getIdentity: () => invoke('identity:get'),
  getClientId: () => invoke('identity:get-client-id'),
  signChallenge: nonceHex => invoke('identity:sign-challenge', nonceHex),
  exportIdentity: (password, extras, dmMode) => invoke('identity:export', password, extras, dmMode),
  importIdentity: (exportedIdentity, password, replace) => invoke('identity:import', exportedIdentity, password, replace),
  logOut: () => invoke('identity:logout'),
  dm: {
    snapshot: () => invoke(DM_IPC.snapshot),
    conversation: (peer, before, limit) => invoke(DM_IPC.conversation, peer, before ?? null, limit),
    openConversation: peer => invoke(DM_IPC.openConversation, peer),
    closeConversation: peer => invoke(DM_IPC.closeConversation, peer),
    sendFriendRequest: (peer, nickname) => invoke(DM_IPC.sendFriendRequest, peer, nickname),
    acceptFriend: peer => invoke(DM_IPC.acceptFriend, peer),
    declineFriend: peer => invoke(DM_IPC.declineFriend, peer),
    cancelFriendRequest: peer => invoke(DM_IPC.cancelFriendRequest, peer),
    removeFriend: peer => invoke(DM_IPC.removeFriend, peer),
    block: (peer, nickname) => invoke(DM_IPC.block, peer, nickname),
    unblock: peer => invoke(DM_IPC.unblock, peer),
    sendMessage: input => invoke(DM_IPC.sendMessage, input),
    editMessage: (peer, messageId, content) => invoke(DM_IPC.editMessage, peer, messageId, content),
    deleteMessage: (peer, messageId) => invoke(DM_IPC.deleteMessage, peer, messageId),
    react: (peer, messageId, emoji, add) => invoke(DM_IPC.react, peer, messageId, emoji, add),
    markRead: peer => invoke(DM_IPC.markRead, peer),
    typing: peer => invoke(DM_IPC.typing, peer),
    ingest: item => invoke(DM_IPC.ingest, item),
    outgoing: (peers, force) => invoke(DM_IPC.outgoing, peers, force === true),
    hello: (toFriends, announce) => invoke(DM_IPC.hello, toFriends, announce !== false),
    helloTo: peer => invoke(DM_IPC.helloTo, peer),
    pendingPeers: () => invoke(DM_IPC.pendingPeers),
    observePeer: peer => invoke(DM_IPC.observePeer, peer),
    setSelfNickname: nickname => invoke(DM_IPC.setSelfNickname, nickname),
    setSelfProfile: input => invoke(DM_IPC.setSelfProfile, input),
    updateSettings: settings => invoke(DM_IPC.updateSettings, settings),
    readAttachment: (peer, messageId, fileId) => invoke(DM_IPC.readAttachment, peer, messageId, fileId),
    saveAttachment: (peer, messageId, fileId) => invoke(DM_IPC.saveAttachment, peer, messageId, fileId),
    retryAttachment: (peer, messageId, fileId) => invoke(DM_IPC.retryAttachment, peer, messageId, fileId),
    onEvent: callback => subscribe(DM_EVENT, callback),
  },
  saveBackupFile: (contents, suggestedName) => invoke('backup:save-file', contents, suggestedName),
  openBackupFile: () => invoke('backup:open-file'),
  takeServerInvite: () => invoke(SERVER_INVITE_IPC.take),
  createBotScreenDocument: (html, consent) => invoke(BOT_SCREEN_DOCUMENT_IPC.create, html, consent),
  removeBotScreenDocument: url => invoke(BOT_SCREEN_DOCUMENT_IPC.remove, url),
  botStorage: {
    documentState: url => invoke(BOT_STORAGE_IPC.documentState, url),
    documentRequest: (url, request) => invoke(BOT_STORAGE_IPC.documentRequest, url, request),
    list: () => invoke(BOT_STORAGE_IPC.list),
    get: scope => invoke(BOT_STORAGE_IPC.get, scope),
    setDecision: (scope, decision) => invoke(BOT_STORAGE_IPC.setDecision, { scope, decision }),
    setQuota: (scope, maxBytes) => invoke(BOT_STORAGE_IPC.setQuota, { scope, maxBytes }),
    clear: scopeId => invoke(BOT_STORAGE_IPC.clear, scopeId),
    forget: scopeId => invoke(BOT_STORAGE_IPC.forget, scopeId),
    onChanged: callback => subscribe(BOT_STORAGE_CHANGED, callback),
  },
  onServerInviteAvailable: callback => subscribe(SERVER_INVITE_AVAILABLE, callback),
  encryptBackup: (contents, password) => invoke('backup:encrypt', contents, password),
  decryptBackup: (payload, password) => invoke('backup:decrypt', payload, password),
  hostServerStart: options => invoke('server-host:start', options),
  hostServerStop: port => invoke('server-host:stop', port),
  hostServerStatus: () => invoke('server-host:status'),
  hostServerLogs: port => invoke('server-host:logs', port),
  hostServerClearLogs: port => invoke('server-host:clear-logs', port),
  hostServerStats: port => invoke('server-host:stats', port),
  hostServerDeleteData: serverId => invoke('server-host:delete-data', serverId),
  onHostServerLog: callback => subscribe('server-host:log', callback),
  onHostServerStatusChanged: callback => subscribe('server-host:status-changed', callback),
  getDesktopSources: options => invoke(DESKTOP_SOURCES_IPC.list, options),
  getDesktopSourcePreviews: request => invoke(DESKTOP_SOURCES_IPC.previews, request),
  cancelDesktopSourcePreviews: () => invoke(DESKTOP_SOURCES_IPC.cancelPreviews),
  prepareScreenShareWindow: sourceId => invoke('screen-share:prepare-window', sourceId),
  ensureScreenPermission: () => invoke('screen-share:ensure-permission'),
  selectImageDialog: () => invoke('dialog:select-image'),
  selectImagesDialog: maxFiles => invoke('dialog:select-images', maxFiles),
  selectSoundFile: () => invoke('dialog:select-sound-file'),
  selectSoundboardFolder: () => invoke('dialog:select-soundboard-folder'),
  getDefaultSoundboardFolder: () => invoke(SOUND_DOWNLOAD_IPC.defaultFolder),
  // Only a direct user action (opening the soundboard or the stickers, Retry) may
  // raise Main's native confirmation of a folder not chosen on this computer (D4).
  listSoundboardSounds: folderPath => invoke('soundboard:list-sounds', folderPath, navigator.userActivation.isActive),
  readSoundboardSound: filePath => invoke('soundboard:read-sound', filePath),
  readSoundboardEdit: input => invoke(SOUNDBOARD_FILES_IPC.read, input),
  openSoundboardEditor: input => invoke(SOUNDBOARD_FILES_IPC.open, input),
  overwriteSoundboardAudio: input => invoke(SOUNDBOARD_FILES_IPC.overwrite, input),
  renameSoundboardFile: input => invoke(SOUNDBOARD_FILES_IPC.rename, input),
  deleteSoundboardFile: input => invoke(SOUNDBOARD_FILES_IPC.delete, input),
  saveSoundboardEdit: input => invoke(SOUNDBOARD_FILES_IPC.edit, input),
  soundDownloadAvailability: folder => invoke(SOUND_DOWNLOAD_IPC.availability, folder),
  confirmSoundboardFolder: folder => invoke(SOUND_DOWNLOAD_IPC.confirmFolder, folder),
  authorizeSoundDownload: input => invoke(SOUND_DOWNLOAD_IPC.authorize, input),
  downloadSound: input => invoke(SOUND_DOWNLOAD_IPC.download, input),
  cancelSoundDownload: key => invoke(SOUND_DOWNLOAD_IPC.cancel, key),
  loadAudioPreview: input => invoke(AUDIO_PREVIEW_IPC.load, input),
  cancelAudioPreview: input => invoke(AUDIO_PREVIEW_IPC.cancel, input),
  getLocalExecutionState: () => invoke(LOCAL_EXECUTION_IPC.getState),
  setLocalExecutionPermission: input => invoke(LOCAL_EXECUTION_IPC.setPermission, input),
  removeLocalTool: tool => invoke(LOCAL_EXECUTION_IPC.removeTool, tool),
  clearLocalExecutionCache: () => invoke(LOCAL_EXECUTION_IPC.clearCache),
  cancelLocalExecutionTask: taskId => invoke(LOCAL_EXECUTION_IPC.cancelTask, taskId),
  onLocalExecutionChanged: callback => subscribe(LOCAL_EXECUTION_CHANGED, callback),
  prepareLocalExecution: input => invoke(LOCAL_EXECUTION_IPC.prepare, input),
  startLocalExecutionTask: input => invoke(LOCAL_EXECUTION_IPC.startTask, input),
  readLocalExecutionFrames: input => invoke(LOCAL_EXECUTION_IPC.readFrames, input),
  acknowledgeLocalExecutionFrames: input => invoke(LOCAL_EXECUTION_IPC.acknowledgeFrames, input),
  cancelLocalExecutionRequest: input => invoke(LOCAL_EXECUTION_IPC.cancelRequest, input),
  setLocalExecutionPaused: input => invoke(LOCAL_EXECUTION_IPC.setPaused, input),
  setLocalExecutionConnection: input => invoke(LOCAL_EXECUTION_IPC.setConnection, input),
  onLocalExecutionTaskFailed: callback => subscribe(LOCAL_EXECUTION_TASK_FAILED, callback),
  onSoundDownloadProgress: callback => subscribe(SOUND_DOWNLOAD_PROGRESS, callback),
  selectStickersFolder: () => invoke('dialog:select-stickers-folder'),
  listStickers: folderPath => invoke('stickers:list', folderPath, navigator.userActivation.isActive),
  readSticker: filePath => invoke('stickers:read', filePath),
  saveSticker: (folderPath, fileName, bytes) => invoke('stickers:save', folderPath, fileName, bytes),
  registerSoundboardShortcuts: shortcuts => invoke(SHORTCUT_IPC.registerSoundboard, shortcuts),
  onSoundboardShortcutTriggered: callback => subscribe('soundboard:shortcut-triggered', callback),
  registerActionShortcuts: shortcuts => invoke(SHORTCUT_IPC.registerActions, shortcuts),
  setShortcutCapture: active => invoke(SHORTCUT_IPC.setCapture, active),
  onActionShortcutTriggered: callback => subscribe('shortcut:action-triggered', callback),
  setPttConfig: config => invoke(SHORTCUT_IPC.setPttConfig, config),
  startPttCapture: () => invoke(SHORTCUT_IPC.startPttCapture),
  stopPttCapture: () => invoke(SHORTCUT_IPC.stopPttCapture),
  onPttStateChanged: callback => subscribe('ptt:state-changed', callback),
  onPttCaptured: callback => subscribe('ptt:captured', callback),
  minimize: () => invoke('window:minimize'),
  openScreenPictureInPicture: (requestId, requireInactive, aspectRatio) =>
    invoke('screen-pip:open', requestId, requireInactive, aspectRatio),
  returnFromScreenPictureInPicture: () => invoke('screen-pip:return'),
  onWindowInactive: callback => subscribe('window:inactive', callback),
  onWindowActive: callback => subscribe('window:active', callback),
  maximize: () => invoke('window:maximize'),
  toggleMaximize: () => invoke('window:toggle-maximize'),
  setWindowInServer: inServer => invoke('window:set-in-server', inServer),
  fitHomeWindowToContent: contentHeight => invoke('window:fit-home-content', contentHeight),
  close: () => invoke('window:close'),
  getAppVersion: () => invoke('app:get-version'),
  signalRendererReady: () => {
    send(APP_RENDERER_READY);
    void invoke(CRASH_RECOVERY_IPC.ready).catch((error: unknown) => {
      console.error('[Bootstrap] Could not acknowledge renderer readiness', error);
    });
  },
  reportFatalBootstrap: failure => invoke(CRASH_RECOVERY_IPC.bootstrapFailed, failure),
  checkForUpdates: requestId => invoke(UPDATER_IPC.check, requestId),
  downloadUpdate: (expectedVersion, requestId) => invoke(UPDATER_IPC.download, expectedVersion, requestId),
  cancelUpdate: requestId => invoke(UPDATER_IPC.cancel, requestId),
  checkUpdateCompatibility: (version, requestId) => invoke(UPDATER_IPC.preflight, version, requestId),
  installUpdate: () => invoke(UPDATER_IPC.install),
  setUpdateChannel: allowBeta => invoke(UPDATER_IPC.setChannel, allowBeta),
  getUpdateOutcome: () => invoke(UPDATER_IPC.outcome),
  getReleaseNotes: tag => invoke(UPDATER_IPC.releaseNotes, tag),
  getReleaseHistory: (page, before) => invoke(UPDATER_IPC.releaseHistory, page, before),
  onUpdateProgress: callback => subscribe('updater:progress', callback),
  onUpdateDownloaded: callback => subscribe('updater:downloaded', callback),
  onUpdateError: callback => subscribe('updater:error', callback),
  openExternal: url => invoke('app:open-external', url),
  editorCommand: command => invoke(EDITOR_COMMAND_IPC, command),
  fetchLinkPreview: url => invoke('link-preview:fetch', url),
  downloadFile: (url, fileName) => invoke('app:download-file', url, fileName),
  downloadFiles: request => invoke(FILE_BATCH_DOWNLOAD_IPC, request),
  saveRecentSound: input => invoke('app:save-recent-sound', input),
  saveCsvFile: (content, fileName) => invoke('app:save-csv-file', content, fileName),
  saveEventCalendar: input => invoke(EVENT_CALENDAR_IPC, input),
  saveHostingSkill: id => invoke(HOSTING_SKILL_IPC, id),
  probeServer: (host, port) => invoke('net:probe-server', host, port),
  updateTrayVoiceStatus: status => invoke('tray:update-voice-status', status),
  onAppBeforeQuit: callback => subscribe(APP_SHUTDOWN_EVENT, callback),
  notifyLeaveComplete: request => invoke(APP_SHUTDOWN_IPC.acknowledge, request),
  onTrayToggleMute: callback => subscribe('tray:toggle-mute', callback),
  onTrayToggleDeafen: callback => subscribe('tray:toggle-deafen', callback),
  onTrayLeaveCall: callback => subscribe('tray:leave-call', callback),
  getAutoStart: () => invoke('app:get-auto-start'),
  setAutoStart: enabled => invoke('app:set-auto-start', enabled),
  setMinimizeToTray: enabled => invoke('app:set-minimize-to-tray', enabled),
  setGamePresenceEnabled: enabled => invoke('game-presence:set-enabled', enabled),
  getCurrentGameActivity: () => invoke('game-presence:get-current'),
  findGameWindows: () => invoke('game-share:find-windows'),
  getSystemIdleSeconds: () => invoke('system:get-idle-seconds'),
  onGamePresenceChanged: callback => subscribe('game-presence:changed', callback),
  openOverlay: config => invoke('overlay:open', config),
  closeOverlay: () => invoke('overlay:close'),
  isOverlayOpen: () => invoke('overlay:is-open'),
  getOverlayConfig: () => invoke('overlay:get-config'),
  setOverlayConfig: config => invoke('overlay:set-config', config),
  saveOverlayBounds: bounds => invoke('overlay:save-bounds', bounds),
  resetOverlayBounds: () => invoke('overlay:reset-bounds'),
  layoutOverlayCards: layout => invoke('overlay:layout-cards', layout),
  sendOverlaySignal: payload => invoke('overlay:send-signal', payload),
  sendOverlaySyncState: state => invoke('overlay:send-sync-state', state),
  onOverlayStateChanged: callback => subscribe('overlay:state-changed', callback),
  onOverlayConfigUpdated: callback => subscribe('overlay:config-updated', callback),
  onOverlaySignalReceived: callback => subscribe('overlay:signal-received', callback),
  onOverlaySyncStateReceived: callback => subscribe('overlay:sync-state-received', callback),
  onOverlayCloseRequested: callback => subscribe('overlay:close-requested', callback),
  onOverlayHoverChanged: callback => subscribe('overlay:hover-changed', callback),
  onOverlayResizeStateChanged: callback => subscribe('overlay:resize-state-changed', callback),

  // Client Logging (#444)
  writeClientLog: entry => invoke('client-log:write', entry),
  getClientLogConfig: () => invoke('client-log:get-config'),
  setClientLogConfig: config => invoke('client-log:set-config', config),
  exportClientLogs: () => invoke('client-log:export'),
  getClientLogSize: () => invoke('client-log:get-size'),
  clearClientLogs: () => invoke('client-log:clear'),
  platform: process.platform,
};

contextBridge.exposeInMainWorld('api', api);

// The renderer reports when the preload finished, on the page's timeline (#490).
performance.mark('monky:preload');

declare global {
  interface Window {
    api: ElectronApi;
  }
}
