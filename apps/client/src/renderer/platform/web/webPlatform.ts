import {
  SERVER_INVITE_FRAGMENT_PREFIX, ZipTooLargeError, decodeServerInviteToken, eventCalendarExportSchema, fetchReleaseHistory,
  fetchVersionReleaseNotes, sanitizeDownloadFileName, storedZipParts, uniqueFileName,
  type AudioPreviewCancellation, type AudioPreviewInput, type AudioPreviewResult,
  type EditorCommand, type FileBatchDownloadFile, type FileBatchDownloadRequest, type FileBatchDownloadResult,
  type HostServerStatus, type LinkPreviewData, type ServerInviteResult,
} from '@monky/shared';
import type { PlatformApi, PlatformCapabilities } from '../api';
import { t } from '../../i18n';
import { IMAGE_ACCEPT, base64ToBytes, bytesToBase64, pickFiles, readImageSelection, saveBlob, saveText } from './webFiles';
import {
  createWebIdentity, deleteWebIdentity, exportWebIdentity, getWebClientId, getWebIdentity, getWebIdentityStatus, importWebIdentity,
  signWebChallenge,
} from './webIdentity';
import { openWebBackup, sealWebBackup } from './webSecretEnvelope';
import {
  exportWebDirectMessages, importWebDirectMessages, resetWebDirectMessages, webDirectMessages, wipeWebDirectMessages,
} from './webDirectMessages';
import { embeddedReleaseRequest } from './webReleases';
import { createWebMediaLibrary, supportsDirectoryPicker } from './webMediaLibrary';
import { createWebBotScreenDocument, removeWebBotScreenDocument, webBotScreenDocumentHost } from './webBotScreens';
import { webBotStorage, wipeWebBotStorage } from './webBotStorage';
import { createEventCalendar } from '../../utils/eventCalendar';
import { clearWebLogs, exportWebLogs, getWebLogConfig, getWebLogSize, setWebLogConfig, writeWebLog } from './webClientLog';
import { WebScreenRuntime, webScreenCapabilities } from './webScreen/webScreenRuntime';

/**
 * The platform bridge of the web version (#858). It answers the same contract
 * as the desktop preload; what a browser tab cannot do is false in
 * `capabilities`, so the interface shows it locked, and its methods reject.
 * Methods the app calls on its own (start-up, settings sync) answer the
 * neutral value instead: nothing to report, nothing registered.
 */
export function webCapabilities(): PlatformCapabilities {
  // Chrome and Edge offer an always-on-top window to a click; other browsers do not.
  const documentPictureInPicture = 'documentPictureInPicture' in window;
  return {
    windowControls: false,
    screenPictureInPicture: documentPictureInPicture,
    documentPictureInPicture,
    // A browser opens that window only for a click, never on its own.
    automaticPictureInPicture: false,
    hostServer: false,
    lanDiscovery: false,
    overlay: false,
    globalShortcuts: false,
    tray: false,
    autoStart: false,
    autoUpdate: false,
    gamePresence: false,
    nativeScreenAudio: false,
    screenShare: webScreenCapabilities().capture,
    browserScreenPicker: true,
    screenEncoderChoice: false,
    localExecution: false,
    botScreens: true,
    directMessages: true,
    mediaFolders: true,
    mediaFolderPicker: supportsDirectoryPicker(),
    botSoundDownloads: false,
    folderDownloads: false,
    durableIdentity: false,
    plainRemoteServers: false,
  };
}

export class PlatformUnsupportedError extends Error {
  constructor(feature: string) {
    super(`${feature} is not available in the web version.`);
    this.name = 'PlatformUnsupportedError';
  }
}

function unsupported(feature: string): () => Promise<never> {
  return () => Promise.reject(new PlatformUnsupportedError(feature));
}

const done = (): Promise<void> => Promise.resolve();
const never = (): (() => void) => () => {};

const NO_HOSTED_SERVERS: HostServerStatus = { servers: [] };

/** Only web pages leave the app, in a new tab that cannot reach back into it. */
function openExternal(url: string): Promise<{ success: boolean }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return Promise.resolve({ success: false });
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return Promise.resolve({ success: false });
  // With noopener the browser never hands the new tab back, so there is nothing more to check.
  window.open(parsed.toString(), '_blank', 'noopener,noreferrer');
  return Promise.resolve({ success: true });
}

async function downloadFromUrl(url: string, fileName: string): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch(url);
    if (!response.ok) return { success: false, error: `HTTP ${response.status}` };
    saveBlob(await response.blob(), fileName);
    return { success: true };
  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** The bytes of one file of a batch: a server attachment, or a DM attachment kept in this browser. */
async function batchFileBytes(file: FileBatchDownloadFile): Promise<Uint8Array> {
  if ('url' in file) {
    const response = await fetch(file.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }
  const result = await webDirectMessages.readAttachment(file.dm.peer, file.dm.messageId, file.dm.fileId);
  if (!result.ok) throw new Error(result.error.message);
  return new Uint8Array(result.value.data);
}

/** A browser saves one download per file, so a batch always arrives as one ZIP, named as on the desktop. */
async function downloadBatchAsZip(request: FileBatchDownloadRequest): Promise<FileBatchDownloadResult> {
  try {
    const used = new Set<string>();
    const entries: Array<{ name: string; data: Uint8Array }> = [];
    for (const file of request.files) {
      const name = uniqueFileName(sanitizeDownloadFileName(file.fileName), (candidate) => used.has(candidate.toLowerCase()));
      used.add(name.toLowerCase());
      entries.push({ name, data: await batchFileBytes(file) });
    }
    const parts = storedZipParts(entries).map((part) => new Uint8Array(part));
    saveBlob(new Blob(parts, { type: 'application/zip' }), `${sanitizeDownloadFileName(request.archiveName).replace(/\.zip$/i, '')}.zip`);
    return { status: 'saved', saved: entries.length };
  } catch (error: unknown) {
    // A ZIP missing some of the files would look complete; nothing is saved.
    return { status: 'failed', saved: 0, error: error instanceof ZipTooLargeError ? t('chat.zipTooLargeWeb')
      : error instanceof Error ? error.message : String(error) };
  }
}

const audioPreviews = new Map<string, AbortController>();

/** Plays a sound before downloading it: the server sends it with CORS, so the page reads it directly. */
async function loadAudioPreview(input: AudioPreviewInput): Promise<AudioPreviewResult> {
  if (input.audioBase64 !== undefined) {
    return { status: 'ready', data: base64ToBytes(input.audioBase64), mimeType: input.mimeType };
  }
  const controller = new AbortController();
  audioPreviews.get(input.requestId)?.abort();
  audioPreviews.set(input.requestId, controller);
  try {
    const response = await fetch(input.url, { signal: controller.signal });
    if (!response.ok) return { status: 'failed', reason: 'http_error' };
    const data = new Uint8Array(await response.arrayBuffer());
    return { status: 'ready', data, mimeType: response.headers.get('content-type') ?? 'audio/mpeg' };
  } catch {
    return controller.signal.aborted ? { status: 'cancelled' } : { status: 'failed', reason: 'network_error' };
  } finally {
    if (audioPreviews.get(input.requestId) === controller) audioPreviews.delete(input.requestId);
  }
}

function cancelAudioPreview({ requestId }: AudioPreviewCancellation): Promise<boolean> {
  const controller = audioPreviews.get(requestId);
  controller?.abort();
  return Promise.resolve(controller !== undefined);
}

/**
 * Cut, copy, paste and select all for the app's own text menu. Electron runs
 * them on the focused field; a page does the same with the editing commands,
 * and pastes through the Clipboard API, which may ask for permission.
 */
async function editorCommand(command: EditorCommand): Promise<{ success: boolean }> {
  if (command === 'paste' || command === 'pasteAndMatchStyle') {
    try {
      const text = await navigator.clipboard.readText();
      return { success: document.execCommand('insertText', false, text) };
    } catch {
      return { success: false };
    }
  }
  return { success: document.execCommand(command) };
}

/**
 * An invitation opened in the web version arrives in the fragment, as the
 * desktop's `monky://#~…` link does. It is taken off the address at once: the
 * fragment may carry the server password.
 */
function takeFragmentInvite(): ServerInviteResult | null {
  const token = window.location.hash.slice(1);
  if (!token.startsWith(SERVER_INVITE_FRAGMENT_PREFIX)) return null;
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  return decodeServerInviteToken(token);
}

function onFragmentInvite(callback: () => void): () => void {
  const listener = (): void => {
    if (window.location.hash.startsWith(`#${SERVER_INVITE_FRAGMENT_PREFIX}`)) callback();
  };
  window.addEventListener('hashchange', listener);
  return () => window.removeEventListener('hashchange', listener);
}

async function logOut(): Promise<{ success: boolean; error?: string }> {
  try {
    await deleteWebIdentity();
    await wipeWebDirectMessages();
    await wipeWebBotStorage();
    // The desktop relaunches; a tab starts over by loading the page again.
    setTimeout(() => window.location.reload(), 0);
    return { success: true };
  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The desktop's Main process shows its crash recovery when start-up fails; a
 * tab has no Main, so the page itself says so and offers to load again.
 */
function showFatalScreen(): void {
  const root = document.getElementById('app') ?? document.body;
  const card = document.createElement('div');
  card.setAttribute('role', 'alert');
  card.style.cssText = 'margin:auto;max-width:420px;padding:32px;text-align:center;display:grid;gap:12px;';
  const title = document.createElement('h1');
  title.style.cssText = 'font-size:20px;margin:0;';
  title.textContent = t('webFatal.title');
  const message = document.createElement('p');
  message.style.cssText = 'margin:0;color:var(--text-secondary);';
  message.textContent = t('webFatal.message');
  const reload = document.createElement('button');
  reload.type = 'button';
  reload.className = 'btn btn-primary';
  reload.textContent = t('webFatal.reload');
  reload.addEventListener('click', () => window.location.reload(), { once: true });
  card.append(title, message, reload);
  root.replaceChildren(card);
  reload.focus();
}

/** What the site's link-preview function answers, checked before the chat draws it. */
function isLinkPreview(value: unknown): value is LinkPreviewData {
  if (typeof value !== 'object' || value === null) return false;
  const optionalText = (key: string): boolean => {
    const field: unknown = Reflect.get(value, key);
    return field === undefined || typeof field === 'string';
  };
  const embedType: unknown = Reflect.get(value, 'embedType');
  return typeof Reflect.get(value, 'url') === 'string' && typeof Reflect.get(value, 'title') === 'string'
    && ['description', 'image', 'siteName', 'favicon', 'embedUrl'].every(optionalText)
    && (embedType === undefined || embedType === 'youtube' || embedType === 'spotify');
}

export function createWebPlatformApi(): PlatformApi {
  return {
    capabilities: webCapabilities(),
    platform: 'web',

    // Identity.
    getIdentityStatus: getWebIdentityStatus,
    createIdentity: createWebIdentity,
    getIdentity: getWebIdentity,
    getClientId: getWebClientId,
    signChallenge: signWebChallenge,
    exportIdentity: async (password, extras, dmMode) =>
      exportWebIdentity(password, extras, await exportWebDirectMessages(dmMode ?? 'none')),
    importIdentity: async (code, password, replace) => {
      const { outcome, dm } = await importWebIdentity(code, password, replace);
      // Another identity opens another DM store; the friends that came with it join that one.
      if (outcome.status === 'imported') {
        await resetWebDirectMessages();
        await importWebDirectMessages(dm);
      }
      return outcome;
    },
    logOut,
    dm: webDirectMessages,
    saveBackupFile: (contents, suggestedName) => {
      saveText(contents, suggestedName || 'monky-backup.monkybackup', 'application/json');
      return Promise.resolve({ success: true });
    },
    openBackupFile: async () => {
      const [file] = await pickFiles({ accept: '.monkybackup,.json,application/json' });
      return file ? { success: true, contents: await file.text() } : { success: false };
    },
    encryptBackup: async (contents, password) => {
      if (!contents) return { success: false, error: t('secret.backupInvalid') };
      try { return { success: true, payload: await sealWebBackup(contents, password) }; }
      catch (error: unknown) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
    },
    decryptBackup: async (payload, password) => {
      if (!payload) return { success: false, error: t('secret.backupInvalid') };
      try { return { success: true, contents: await openWebBackup(payload, password) }; }
      catch (error: unknown) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
    },

    // App and window: a browser tab has no frame, tray, auto start or updater.
    signalRendererReady: () => {},
    reportFatalBootstrap: () => {
      showFatalScreen();
      return Promise.resolve(true);
    },
    getDevelopmentQaConfig: () => Promise.resolve(null),
    reportDevelopmentQaState: () => Promise.resolve(false),
    takeServerInvite: () => Promise.resolve(takeFragmentInvite()),
    onServerInviteAvailable: onFragmentInvite,
    setLanguage: done,
    getAppVersion: () => Promise.resolve(__MONKY_VERSION__),
    minimize: done,
    maximize: done,
    toggleMaximize: done,
    close: done,
    setWindowInServer: done,
    fitHomeWindowToContent: done,
    onWindowInactive: never,
    onWindowActive: never,
    openScreenPictureInPicture: () => Promise.resolve(false),
    returnFromScreenPictureInPicture: done,
    onAppBeforeQuit: never,
    notifyLeaveComplete: done,
    updateTrayVoiceStatus: done,
    onTrayToggleMute: never,
    onTrayToggleDeafen: never,
    onTrayLeaveCall: never,
    getAutoStart: () => Promise.resolve(false),
    setAutoStart: unsupported('Automatic start'),
    setMinimizeToTray: done,
    checkForUpdates: unsupported('App updates'),
    downloadUpdate: unsupported('App updates'),
    cancelUpdate: unsupported('App updates'),
    checkUpdateCompatibility: unsupported('App updates'),
    installUpdate: unsupported('App updates'),
    setUpdateChannel: unsupported('App updates'),
    getUpdateOutcome: () => Promise.resolve(null),
    getReleaseNotes: (tag) => fetchVersionReleaseNotes(__MONKY_VERSION__, tag, embeddedReleaseRequest),
    getReleaseHistory: (page, before) => fetchReleaseHistory(__MONKY_VERSION__, page, before, embeddedReleaseRequest),
    onUpdateProgress: never,
    onUpdateDownloaded: never,
    onUpdateError: never,
    openExternal,
    editorCommand,
    fetchLinkPreview: async (url) => {
      // The site's own function reads the page (api/link-preview.ts); a local build without it shows no preview.
      try {
        const response = await fetch(`/api/link-preview?url=${encodeURIComponent(url)}`);
        if (!response.ok) return null;
        const preview: unknown = await response.json();
        return isLinkPreview(preview) ? preview : null;
      } catch {
        return null;
      }
    },
    probeServer: unsupported('Server probe'),

    // Files: downloads and the browser's file picker.
    selectImageDialog: async () => {
      const [file] = await pickFiles({ accept: IMAGE_ACCEPT });
      return file ? readImageSelection(file) : null;
    },
    selectImagesDialog: async (maxFiles) => {
      const limit = Math.min(5, Math.max(1, Number.isInteger(maxFiles) ? maxFiles : 1));
      const files = await pickFiles({ accept: IMAGE_ACCEPT, multiple: true });
      return Promise.all(files.slice(0, limit).map(readImageSelection));
    },
    downloadFile: downloadFromUrl,
    downloadFiles: downloadBatchAsZip,
    saveRecentSound: (input) => {
      saveBlob(new Blob([base64ToBytes(input.base64)], { type: input.mimeType }), input.fileName);
      return Promise.resolve({ success: true });
    },
    saveCsvFile: (content, fileName) => {
      saveText(content, fileName, 'text/csv');
      return Promise.resolve({ success: true });
    },
    saveEventCalendar: (input) => {
      try {
        const payload = eventCalendarExportSchema.parse(input);
        saveText(createEventCalendar(payload), `${payload.event.title.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120) || 'evento'}.ics`, 'text/calendar');
        return Promise.resolve({ status: 'saved' });
      } catch (error: unknown) {
        console.warn('[Community] Calendar export failed.', error);
        return Promise.resolve({ status: 'failed', error: t('calendar.exportFailed') });
      }
    },
    saveHostingSkill: unsupported('Hosting guides'),

    // Hosting a server and finding them on the local network need the desktop.
    startLanDiscovery: done,
    stopLanDiscovery: done,
    onLanDiscoveryFound: never,
    onLanDiscoveryLost: never,
    hostServerStart: unsupported('Hosting a server'),
    hostServerStop: unsupported('Hosting a server'),
    hostServerStatus: () => Promise.resolve(NO_HOSTED_SERVERS),
    hostServerLogs: () => Promise.resolve([]),
    hostServerClearLogs: done,
    hostServerStats: () => Promise.resolve(null),
    hostServerDeleteData: unsupported('Hosting a server'),
    onHostServerLog: never,
    onHostServerStatusChanged: never,
    // Automatic TLS belongs to a server this browser cannot host.
    hostServerAutoTlsStatus: unsupported('Hosting a server'),
    hostServerAutoTlsEnable: unsupported('Hosting a server'),
    hostServerAutoTlsDisable: unsupported('Hosting a server'),
    onHostServerAutoTlsProblem: never,

    // Screens: captured through the browser's own dialog and sent by the web screen runtime;
    // remote screens play in the browser receiver, never in a native presentation.
    ...new WebScreenRuntime().api(),
    attachNativeScreenPresentation: unsupported('Native screen presentation'),
    getDesktopSources: () => Promise.resolve([]),
    getDesktopSourcePreviews: () => Promise.resolve([]),
    cancelDesktopSourcePreviews: done,
    prepareScreenShareWindow: () => Promise.resolve(false),
    ensureScreenPermission: () => Promise.resolve(true),
    findGameWindows: () => Promise.resolve([]),

    // Soundboard and stickers: a folder (File System Access) or the browser's storage.
    ...createWebMediaLibrary(),
    selectSoundFile: async () => {
      const [file] = await pickFiles({ accept: '.wav,.mp3,.ogg,.webm,audio/wav,audio/mpeg,audio/ogg,audio/webm' });
      if (!file) return null;
      return `data:${file.type || 'audio/wav'};base64,${bytesToBase64(new Uint8Array(await file.arrayBuffer()))}`;
    },
    // Bot sound downloads fetch arbitrary https addresses, which the browser blocks (CORS and the site CSP).
    soundDownloadAvailability: () => Promise.resolve('unavailable'),
    confirmSoundboardFolder: () => Promise.resolve(false),
    authorizeSoundDownload: unsupported('Bot sound downloads'),
    downloadSound: unsupported('Bot sound downloads'),
    cancelSoundDownload: () => Promise.resolve(false),
    onSoundDownloadProgress: never,
    loadAudioPreview,
    cancelAudioPreview,

    // Shortcuts that work in the background, push-to-talk and game presence.
    registerSoundboardShortcuts: () => Promise.resolve(false),
    onSoundboardShortcutTriggered: never,
    registerActionShortcuts: () => Promise.resolve(false),
    setShortcutCapture: () => Promise.resolve(false),
    onActionShortcutTriggered: never,
    setPttConfig: () => Promise.resolve(false),
    startPttCapture: () => Promise.resolve(false),
    stopPttCapture: () => Promise.resolve(false),
    onPttStateChanged: never,
    onPttCaptured: never,
    setGamePresenceEnabled: done,
    getCurrentGameActivity: () => Promise.resolve(null),
    getSystemIdleSeconds: () => Promise.resolve(0),
    onGamePresenceChanged: never,

    // Overlay.
    openOverlay: unsupported('Overlay'),
    closeOverlay: () => Promise.resolve({ success: true }),
    isOverlayOpen: () => Promise.resolve(false),
    getOverlayConfig: () => Promise.resolve(null),
    setOverlayConfig: done,
    saveOverlayBounds: done,
    resetOverlayBounds: done,
    layoutOverlayCards: unsupported('Overlay'),
    sendOverlaySignal: done,
    sendOverlaySyncState: done,
    onOverlayStateChanged: never,
    onOverlayConfigUpdated: never,
    onOverlaySignalReceived: never,
    onOverlaySyncStateReceived: never,
    onOverlayCloseRequested: never,
    onOverlayHoverChanged: never,
    onOverlayResizeStateChanged: never,

    // Bots that run on this computer, and their screens and storage.
    createBotScreenDocument: createWebBotScreenDocument,
    removeBotScreenDocument: removeWebBotScreenDocument,
    botScreenDocuments: webBotScreenDocumentHost(),
    botStorage: webBotStorage,
    getLocalExecutionState: unsupported('Local tools'),
    setLocalExecutionPermission: unsupported('Local tools'),
    removeLocalTool: unsupported('Local tools'),
    clearLocalExecutionCache: unsupported('Local tools'),
    cancelLocalExecutionTask: unsupported('Local tools'),
    onLocalExecutionChanged: never,
    prepareLocalExecution: unsupported('Local tools'),
    startLocalExecutionTask: unsupported('Local tools'),
    readLocalExecutionFrames: unsupported('Local tools'),
    acknowledgeLocalExecutionFrames: unsupported('Local tools'),
    cancelLocalExecutionRequest: unsupported('Local tools'),
    setLocalExecutionPaused: unsupported('Local tools'),
    setLocalExecutionConnection: unsupported('Local tools'),
    onLocalExecutionTaskFailed: never,

    // The client log, kept in IndexedDB.
    writeClientLog: writeWebLog,
    getClientLogConfig: getWebLogConfig,
    setClientLogConfig: setWebLogConfig,
    exportClientLogs: exportWebLogs,
    getClientLogSize: getWebLogSize,
    clearClientLogs: clearWebLogs,
  };
}
