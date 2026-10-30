import { app, BrowserWindow, desktopCapturer, dialog, ipcMain as electronIpcMain, powerMonitor, screen, shell, systemPreferences } from 'electron';
import { execFile } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { LanDiscovery } from './lanDiscovery';
import { globalInputHook } from './globalInputHookProcess';
import {
  AUDIO_PREVIEW_IPC, LIMITS, MEDIA_FOLDERS_IPC, SHORTCUT_IPC, SOUND_DOWNLOAD_IPC, SOUND_DOWNLOAD_PROGRESS,
  DESKTOP_SOURCES_IPC, desktopSourcesOptionsSchema, desktopSourcePreviewsRequestSchema, trayVoiceStatusSchema,
  type AudioPreviewResult, type SoundDownloadResult, type SoundboardDownloadPermit, type SoundboardDownloadAvailability,
} from '@monky/shared';
import { SoundboardDownloads } from './soundboardDownload';
import { SoundboardFiles } from './soundboardFiles';
import { setupSoundboardFilesIpc } from './soundboardFilesIpc';
import { setupEditorCommands } from './editorCommands';
import { createSoundboardEncoder } from './soundboardEncoder';
import { MediaFolderAccess, type MediaFolderPurpose } from './mediaFolders';
import { downloadToFile, sanitizeDownloadFileName, suggestedDownloadName } from './attachmentDownload';
import { isMainFrameSender, mainFrameHandle } from './ipcSender';
import type { ContractIpcMain } from './ipcContract';
import type { LocalTools } from './localExecution/LocalTools';
import { AudioPreviews } from './audioPreviews';
import { createLocalExecutionService } from './localExecution/createService';
import { setupLocalExecutionIpc, type LocalExecutionIpc } from './localExecution/ipc';
import { setupNativeScreenSharingIpc } from './nativeScreenSharing';
import { NativeDesktopSources, nativeWindowIdFromSourceId, nativeMonitorDesktopSources } from './nativeWindows';
import { browserOcclusionEngine } from './browserOcclusion';
import { ScreenPictureInPictureWindows } from './screenPictureInPictureWindow';
import { NativeThumbnailCapturer, loadThumbnailRuntime, createMacScreenProvider, type MacScreenProvider } from '@monky/screen-share';
import { DesktopSourcePreviews } from './desktopSourcePreviews';
import * as screenAudio from '@monky/screen-audio';
import type { NativeWindowInfo, WindowOwner } from '@monky/screen-audio';
import type { ClientLogger } from './clientLogger';
import { createIdentity, deleteIdentity, exportIdentity, getClientId, getIdentity, getIdentityStatus, importIdentity, signChallenge } from './identityService';
import { exportDirectMessages, importDirectMessages, resetDirectMessages, setupDmIpc, wipeDirectMessages, writeDmAttachment } from './dm/dmIpc';
import { openBackup, sealBackup } from './secretEnvelope';
import { HostServerOptions, ServerManager } from './serverManager';
import { mt, setMainLanguage } from './i18n';
import { setupEventCalendarIpc } from './serverEventCalendarIpc';
import { setupHostingSkillIpc } from './hostingSkills';
import { setupRecentSoundSaveIpc } from './recentSoundSaveIpc';
import { setupFileBatchDownloadIpc } from './fileBatchDownloadIpc';
import { fetchLinkPreview } from './linkPreview';
import { TrayManager } from './trayManager';
import type { TaskbarCallControls } from './taskbarCallControls';
import type { DesktopSource, IpcInvokeChannels, OverlayBounds, OverlayConfig, OverlaySyncState } from '@monky/shared';
import { OverlayManager } from './overlayManager';
import { SteamPresence } from './steamPresence';
import { gameWindowIds } from './gameWindows';
import {
  HOME_MIN_HEIGHT,
  HOME_MIN_WIDTH,
  IN_SERVER_MIN_HEIGHT,
  IN_SERVER_MIN_WIDTH,
} from './windowSizing';

/** Extensões que a soundboard aceita, na listagem e na leitura de um som. */
const SOUNDBOARD_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.webm']);

// Every channel registered here is checked against the contract in @monky/shared.
const ipcMain: ContractIpcMain = electronIpcMain;

// O addon nativo também enumera janelas e monitores, lê o layout do teclado e limita o redimensionamento
// do overlay. Se ele não carregar, a causa vai uma vez para o log; as funções que dependem dele falham
// com ela, em vez de devolver listas vazias.
let screenAudioLoadFailureLogged = false;
function logScreenAudioLoadFailure(logger: ClientLogger | undefined): void {
  const error = screenAudio.getLoadError();
  if (!error || screenAudioLoadFailureLogged) return;
  screenAudioLoadFailureLogged = true;
  console.error('[ScreenAudio:Main] Native module failed to load:', error);
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  logger?.write({
    timestamp: new Date().toISOString(), level: 'ERROR', category: 'SCREEN_SHARE',
    message: 'Native screen-audio module failed to load', data: { code, message: error.message },
  });
}

// Icones de app nao mudam enquanto o app roda, e ler o bundle do disco a cada
// abertura do seletor de tela seria desperdicio.
const appIconCache = new Map<string, string | null>();

/**
 * No macOS o Electron devolve `appIcon` vazio para janelas, mesmo com
 * `fetchWindowIcons: true` (#455). Descobrimos o app dono de cada janela pelo
 * modulo nativo e lemos o icone do proprio bundle.
 */
async function resolveMacAppIcons(sourceIds: string[]): Promise<Map<string, string>> {
  const iconsBySourceId = new Map<string, string>();
  if (process.platform !== 'darwin') return iconsBySourceId;

  let owners: WindowOwner[];
  try {
    owners = screenAudio.listWindowOwners();
  } catch (e) {
    console.warn('[ScreenShare:Main] Falha ao listar donos de janela:', (e as Error).message);
    return iconsBySourceId;
  }

  const bundlePathByWindowId = new Map<number, string>();
  for (const owner of owners) bundlePathByWindowId.set(owner.windowId, owner.bundlePath);

  for (const sourceId of sourceIds) {
    const nativeId = nativeWindowIdFromSourceId(sourceId);
    if (nativeId === null) continue;
    const bundlePath = bundlePathByWindowId.get(nativeId);
    if (!bundlePath) continue;

    let dataUrl = appIconCache.get(bundlePath);
    if (dataUrl === undefined) {
      try {
        const icon = await app.getFileIcon(bundlePath, { size: 'normal' });
        dataUrl = icon.isEmpty() ? null : icon.toDataURL();
      } catch (e) {
        console.warn(`[ScreenShare:Main] Sem icone para ${bundlePath}:`, (e as Error).message);
        dataUrl = null;
      }
      appIconCache.set(bundlePath, dataUrl);
    }
    if (dataUrl) iconsBySourceId.set(sourceId, dataUrl);
  }

  return iconsBySourceId;
}

function listNativeWindows(): NativeWindowInfo[] {
  if (process.platform !== 'win32') return [];
  try {
    return screenAudio.listWindows();
  } catch (e) {
    console.warn('[ScreenShare:Main] Falha ao enumerar janelas nativas:', (e as Error).message);
    throw e;
  }
}

/**
 * Le o icone do executavel do processo dono usando a API nativa do sistema.
 * Reaproveita o
 * `appIconCache` (chaveado por caminho absoluto, sem colisao com os bundles mac).
 */
async function resolveWindowsAppIcons(processPaths: string[]): Promise<Map<string, string>> {
  const icons = new Map<string, string>();
  if (process.platform !== 'win32') return icons;

  for (const processPath of processPaths) {
    if (!processPath || icons.has(processPath)) continue;

    let dataUrl = appIconCache.get(processPath);
    if (dataUrl === undefined) {
      try {
        const icon = await app.getFileIcon(processPath, { size: 'normal' });
        dataUrl = icon.isEmpty() ? null : icon.toDataURL();
      } catch (e) {
        console.warn(`[ScreenShare:Main] Sem icone para ${processPath}:`, (e as Error).message);
        dataUrl = null;
      }
      appIconCache.set(processPath, dataUrl);
    }
    if (dataUrl) icons.set(processPath, dataUrl);
  }

  return icons;
}

export interface SetupIpcOptions {
  setMinimizeToTray?: (enabled: boolean) => void;
  clientLogger?: import('./clientLogger').ClientLogger;
  overlayManager?: OverlayManager;
  /** Call buttons on the Windows taskbar thumbnail; absent on other systems. */
  taskbarCallControls?: TaskbarCallControls | null;
  /** Graceful quit (leaves servers, stops the hosted server) used by logout. */
  quitApplication?: () => void;
}

/**
 * Bundle identifier macOS uses to key TCC permissions. Read from the bundle
 * itself so a rename in electron-builder cannot silently break the reset below.
 */
function getMacBundleId(): string {
  try {
    // .../Monky.app/Contents/MacOS/Monky -> .../Monky.app/Contents/Info.plist
    const infoPlist = path.join(path.dirname(path.dirname(app.getPath('exe'))), 'Info.plist');
    const match = fs
      .readFileSync(infoPlist, 'utf8')
      .match(/<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/);
    if (match) return match[1];
  } catch {
    // Unpackaged runs have no Info.plist; the default below is only a hint.
  }
  return 'com.monky.app';
}

/**
 * macOS ties the Screen Recording permission to the app's code signature. An
 * ad-hoc build gets a new identity with every update, so the previous
 * authorization stops applying — while System Settings keeps showing the old
 * entry as enabled, so the system never asks again (#327). Releases signed with
 * the project certificate keep their identity, but the first of them still
 * differs from the ad-hoc version before it. Detect that state and offer to
 * clear the stale entry, which makes macOS prompt on the next attempt.
 */
async function ensureScreenRecordingPermission(mainWindow: BrowserWindow): Promise<boolean> {
  if (process.platform !== 'darwin') return true;

  const status = systemPreferences.getMediaAccessStatus('screen');
  // 'not-determined' means macOS still shows its own prompt on the first capture.
  if (status === 'granted' || status === 'not-determined') return true;

  const bundleId = getMacBundleId();
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: mt('screenPermission.title'),
    message: mt('screenPermission.message'),
    detail: mt('screenPermission.detail'),
    buttons: [mt('screenPermission.reset'), mt('screenPermission.openSettings'), mt('screenPermission.cancel')],
    defaultId: 0,
    cancelId: 2,
  });

  if (response === 1) {
    await shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
    );
    return false;
  }

  if (response !== 0) return false;

  try {
    await new Promise<void>((resolve, reject) => {
      execFile('tccutil', ['reset', 'ScreenCapture', bundleId], (error) =>
        error ? reject(error) : resolve()
      );
    });
  } catch (error) {
    await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: mt('screenPermission.resetFailedTitle'),
      message: (error as Error).message,
      detail: mt('screenPermission.resetFailedDetail', { bundleId }),
    });
    return false;
  }

  // TCC caches the verdict per process, so the new prompt only appears on a
  // fresh launch.
  app.relaunch();
  app.exit(0);
  return false;
}

export function setupIpcHandlers(
  mainWindow: BrowserWindow,
  serverManager: ServerManager,
  trayManager?: TrayManager,
  options?: SetupIpcOptions
): LocalExecutionIpc & { prepareShutdown(): Promise<void> } {
  logScreenAudioLoadFailure(options?.clientLogger);
  const lanDiscovery = new LanDiscovery(mainWindow);
  globalInputHook.init(mainWindow);
  const overlayManager = options?.overlayManager || new OverlayManager(mainWindow);
  const soundDownloads = new SoundboardDownloads(path.join(app.getPath('userData'), 'soundboard-folder.json'));
  const audioPreviews = new AudioPreviews();
  let soundboardTools: LocalTools | undefined;
  const localExecution = setupLocalExecutionIpc(mainWindow, (notifications) =>
    createLocalExecutionService(mainWindow, app.getPath('userData'), notifications, tools => { soundboardTools = tools; }));
  // Presença de jogo (#675): só roda quando a pessoa liga nas configurações.
  const steamPresence = new SteamPresence((activity) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('game-presence:changed', activity);
  });
  const nativeSources = new NativeDesktopSources({
    windows: listNativeWindows,
    isWindowExcluded: hwnd => overlayManager.isScreenShareSource(`window:${hwnd}:0`),
    windowState: hwnd => screenAudio.getWindowState(hwnd),
    monitors: () => screenAudio.listMonitors(),
    monitorState: deviceId => screenAudio.getMonitorState(deviceId),
    processAncestry: ids => screenAudio.getProcessAncestry(ids),
  });
  const assertCaptureSourceAllowed = (sourceId: string): void => {
    if (overlayManager.isScreenShareSource(sourceId)) {
      throw new Error(mt('screenShare.overlayWindowUnavailable'));
    }
  };
  let macSources: MacScreenProvider | undefined;
  const getMacSources = (): MacScreenProvider => macSources ??= createMacScreenProvider();
  const nativeScreenSharing = setupNativeScreenSharingIpc(
    mainWindow, (sourceId, kind) => {
      assertCaptureSourceAllowed(sourceId);
      if (process.platform === 'darwin') {
        if (kind === 'game') throw new Error('macOS does not support Windows game hooks.');
        return getMacSources().resolveTarget(sourceId, kind);
      }
      return nativeSources.resolve(sourceId, kind);
    }, options?.clientLogger,
  );
  const ownsSoundDownload = (event: Electron.IpcMainInvokeEvent): boolean => isMainFrameSender(mainWindow, event);
  // Privileged channels below answer only the main window's top frame (E-MAIN-1).
  const handleFromMainFrame = mainFrameHandle(ipcMain, mainWindow);
  // Sound and sticker folders may be read only once confirmed natively (D4).
  const mediaFolders = new MediaFolderAccess(path.join(app.getPath('userData'), 'media-folders.json'));
  const allowMediaFolder = async (purpose: MediaFolderPurpose, folder: unknown): Promise<void> => {
    try {
      await mediaFolders.allow(purpose, folder);
    } catch (error: unknown) {
      console.warn(`[MediaFolders] Could not remember the confirmed ${purpose} folder:`, error);
    }
  };
  // A folder in the settings that this profile never confirmed (restored from a
  // backup, or chosen in another version) is offered natively instead of
  // staying blocked, and only when the person opens it themselves.
  const askToReadMediaFolder = (purpose: MediaFolderPurpose) => async (folder: string): Promise<boolean> => {
    if (mainWindow.isDestroyed()) return false;
    const stickers = purpose === 'stickers';
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: mt(stickers ? 'dialog.confirmStickersReadTitle' : 'dialog.confirmSoundsReadTitle'),
      message: mt(stickers ? 'dialog.confirmStickersReadMessage' : 'dialog.confirmSoundsReadMessage'),
      detail: mt('dialog.confirmMediaFolderDetail', { folder }),
      buttons: [mt('dialog.allowMediaFolder'), mt('dialog.notNowMediaFolder')],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    return response === 0 && !mainWindow.isDestroyed();
  };
  const requestMediaFolder = (purpose: MediaFolderPurpose, folder: string, userAction: unknown) =>
    mediaFolders.requestFolder(purpose, folder, userAction === true ? askToReadMediaFolder(purpose) : undefined);
  handleFromMainFrame(MEDIA_FOLDERS_IPC.adopt, async (_event, folders: unknown): Promise<void> => {
    try {
      await mediaFolders.adoptConfigured(folders);
    } catch (error: unknown) {
      console.warn('[MediaFolders] Could not keep the folders configured before confirmation was required:', error);
    }
  });
  const soundboardEncoder = createSoundboardEncoder(async () => {
    try { return await soundboardTools?.readyExecutable('ffmpeg') ?? null; }
    catch (error: unknown) {
      console.error('[soundboard] Could not verify the local FFmpeg installation.', error);
      return null;
    }
  });
  const disposeSoundboardFiles = setupSoundboardFilesIpc(mainWindow, new SoundboardFiles(soundDownloads, soundboardEncoder));
  const disposeEditorCommands = setupEditorCommands(mainWindow);
  const disposeEventCalendar = setupEventCalendarIpc(mainWindow, sanitizeDownloadFileName);
  const disposeHostingSkill = setupHostingSkillIpc(mainWindow);
  const disposeRecentSoundSave = setupRecentSoundSaveIpc(mainWindow, sanitizeDownloadFileName);
  const disposeFileBatchDownload = setupFileBatchDownloadIpc(mainWindow, sanitizeDownloadFileName, async (file, destination) => {
    if ('url' in file) await downloadToFile(file.url, destination);
    else await writeDmAttachment(file.dm.peer, file.dm.messageId, file.dm.fileId, destination);
  });
  const disposeDirectMessages = setupDmIpc(mainWindow, sanitizeDownloadFileName);
  ipcMain.handle(SOUND_DOWNLOAD_IPC.defaultFolder, async (event): Promise<string | null> => {
    if (!ownsSoundDownload(event)) throw new Error(mt('error.defaultSoundboardFolder'));
    let folder: string | null;
    try {
      folder = await soundDownloads.getDefaultFolder();
    } catch (error: unknown) {
      console.warn('[Soundboard] Could not initialize the default sound folder:', error);
      throw new Error(mt('error.defaultSoundboardFolder'));
    }
    // Main created or confirmed this folder itself.
    if (folder) await allowMediaFolder('soundboard', folder);
    return folder;
  });
  ipcMain.handle(SOUND_DOWNLOAD_IPC.availability, async (event, folder: unknown): Promise<SoundboardDownloadAvailability> =>
    ownsSoundDownload(event) ? soundDownloads.availability(folder) : 'unavailable');
  ipcMain.handle(SOUND_DOWNLOAD_IPC.confirmFolder, async (event, folder: unknown): Promise<boolean> => {
    if (!ownsSoundDownload(event)) return false;
    let confirmed: boolean;
    try {
      confirmed = await soundDownloads.confirmConfiguredFolder(folder, async (canonical) => {
        if (mainWindow.isDestroyed() || !ownsSoundDownload(event)) return false;
        const result = await dialog.showMessageBox(mainWindow, {
          type: 'question',
          title: mt('dialog.confirmSoundboardFolderTitle'),
          message: mt('dialog.confirmSoundboardFolderMessage'),
          detail: mt('dialog.confirmSoundboardFolderDetail', { folder: canonical }),
          buttons: [mt('dialog.allowSoundboardDownloads'), mt('dialog.cancelSoundboardFolder')],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        });
        return result.response === 0 && !mainWindow.isDestroyed() && ownsSoundDownload(event);
      });
    } catch (error: unknown) {
      console.warn('[Soundboard] Could not authorize downloads in the configured folder:', error);
      throw new Error(mt('error.confirmSoundboardFolder'));
    }
    if (confirmed) await allowMediaFolder('soundboard', folder);
    return confirmed;
  });
  ipcMain.handle(SOUND_DOWNLOAD_IPC.authorize, async (event, input: unknown): Promise<SoundboardDownloadPermit> =>
    ownsSoundDownload(event) ? soundDownloads.authorize(event.sender.id, input) : { status: 'failed', reason: 'invalid_request' });
  ipcMain.handle(SOUND_DOWNLOAD_IPC.download, async (event, input: unknown): Promise<SoundDownloadResult> => {
    if (!ownsSoundDownload(event)) return { status: 'failed', reason: 'invalid_request' };
    try {
      return await soundDownloads.download(event.sender.id, input, (progress) => {
        if (!event.sender.isDestroyed()) event.sender.send(SOUND_DOWNLOAD_PROGRESS, progress);
      });
    } catch (error) {
      console.warn('[Soundboard] Could not clean up the local download:', error);
      return { status: 'failed', reason: 'write_failed' };
    }
  });
  ipcMain.handle(SOUND_DOWNLOAD_IPC.cancel, (event, key: unknown) =>
    ownsSoundDownload(event) && soundDownloads.cancel(event.sender.id, key));
  ipcMain.handle(AUDIO_PREVIEW_IPC.load, async (event, input: unknown): Promise<AudioPreviewResult> =>
    ownsSoundDownload(event) ? audioPreviews.load(event.sender.id, input) : { status: 'failed', reason: 'invalid_request' });
  ipcMain.handle(AUDIO_PREVIEW_IPC.cancel, (event, input: unknown) =>
    ownsSoundDownload(event) && audioPreviews.cancel(event.sender.id, input));
  const soundDownloadOwner = mainWindow.webContents.id;
  const stopSoundDownloads = () => {
    soundDownloads.cancelOwner(soundDownloadOwner);
    audioPreviews.cancelOwner(soundDownloadOwner);
  };
  mainWindow.webContents.on('did-start-loading', stopSoundDownloads);
  mainWindow.webContents.on('render-process-gone', stopSoundDownloads);
  mainWindow.webContents.once('destroyed', stopSoundDownloads);

  // Overlay (#169)
  ipcMain.handle('overlay:open', (_event, config: OverlayConfig) => {
    return { success: overlayManager.open(config) };
  });

  ipcMain.handle('overlay:close', () => {
    return { success: overlayManager.close() };
  });

  ipcMain.handle('overlay:is-open', () => {
    return overlayManager.isOpen();
  });

  ipcMain.handle('overlay:get-config', () => {
    return overlayManager.getConfig();
  });

  ipcMain.handle('overlay:set-config', (_event, config: Partial<OverlayConfig>) => {
    overlayManager.setConfig(config);
  });

  ipcMain.handle('overlay:save-bounds', (_event, bounds: OverlayBounds) => {
    overlayManager.setConfig({ bounds, position: 'custom' });
  });

  ipcMain.handle('overlay:reset-bounds', () => {
    overlayManager.resetBounds();
  });

  ipcMain.handle('overlay:layout-cards', (event, layout: IpcInvokeChannels['overlay:layout-cards']['args'][0]) => {
    if (event.senderFrame !== event.sender.mainFrame) throw new Error('Overlay layout requires its main frame.');
    return overlayManager.layoutCards(event.sender.id, layout);
  });

  ipcMain.handle('overlay:send-signal', (_event, payload: unknown) => {
    overlayManager.sendSignal(payload);
  });

  ipcMain.handle('overlay:send-sync-state', (_event, state: OverlaySyncState) => {
    overlayManager.sendSyncState(state);
  });

  ipcMain.handle('tray:update-voice-status', (event, input: unknown) => {
    // The taskbar buttons send their commands back to this window, so only its own frame reports the call.
    if (mainWindow.isDestroyed() || event.sender !== mainWindow.webContents
      || event.senderFrame !== mainWindow.webContents.mainFrame) {
      throw new Error('Invalid voice status sender.');
    }
    const status = trayVoiceStatusSchema.parse(input);
    trayManager?.updateVoiceStatus(status);
    options?.taskbarCallControls?.update(status);
  });

  // Active UI language (#16): keeps native dialogs in the same language the
  // renderer is showing.
  ipcMain.handle('app:set-language', (_event, language: string) => {
    setMainLanguage(language);
    // The tray builds its labels eagerly, so it needs a redraw to pick the
    // new language up (#16).
    trayManager?.refresh();
    options?.taskbarCallControls?.refresh();
  });

  ipcMain.handle('app:set-minimize-to-tray', (_event, enabled: boolean) => {
    if (typeof enabled === 'boolean') {
      options?.setMinimizeToTray?.(enabled);
    }
  });

  handleFromMainFrame('identity:status', async () => getIdentityStatus());
  handleFromMainFrame('identity:create', async () => createIdentity());
  handleFromMainFrame('identity:get', async () => getIdentity(true));
  handleFromMainFrame('identity:get-client-id', async () => getClientId());
  handleFromMainFrame('identity:sign-challenge', async (_event, nonceHex: string) => signChallenge(nonceHex));
  handleFromMainFrame('identity:export', async (_event, password: string, extras?: string, dmMode?: unknown) =>
    exportIdentity(
      password,
      typeof extras === 'string' ? extras : undefined,
      exportDirectMessages(dmMode === 'friends' || dmMode === 'history' ? dmMode : 'none'),
    )
  );
  handleFromMainFrame('identity:import', async (_event, exportedIdentity: string, password: string, replace?: unknown) => {
    const outcome = await importIdentity(exportedIdentity, password, typeof replace === 'string' ? replace : undefined);
    // Waiting for the user to confirm another identity: friends and DMs stay as they are.
    if (outcome.status !== 'imported') return outcome;
    const { dm, ...imported } = outcome;
    resetDirectMessages();
    importDirectMessages(dm);
    return imported;
  });

  // Logout: the identity only exists on this computer, so leaving it means
  // deleting it together with friends and DMs. The renderer already cleared
  // the identity-bound localStorage; relaunching gives a clean process that
  // lands on the create/import screen.
  let loggingOut = false;
  handleFromMainFrame('identity:logout', async () => {
    if (loggingOut) return { success: true };
    loggingOut = true;
    try {
      deleteIdentity();
      await wipeDirectMessages();
      await mainWindow.webContents.session.flushStorageData();
    } catch (error) {
      loggingOut = false;
      console.error('[Identity] Logout failed:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
    setImmediate(() => {
      app.relaunch();
      if (options?.quitApplication) options.quitApplication();
      else app.quit();
    });
    return { success: true };
  });

  // Backup of saved servers and app settings (#472). The renderer owns the
  // content (it all lives in localStorage); the main process only picks the
  // path, seals the file with the user's password and touches the disk.
  //
  // The backup carries the passwords of saved servers, so it gets the very same
  // protection as the identity export instead of landing on disk as plain JSON.
  handleFromMainFrame('backup:encrypt', async (_event, contents: string, password: string) => {
    if (typeof contents !== 'string' || !contents) {
      return { success: false, error: 'Conteúdo de backup inválido.' };
    }
    try {
      return { success: true, payload: await sealBackup(contents, password) };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  handleFromMainFrame('backup:decrypt', async (_event, payload: string, password: string) => {
    if (typeof payload !== 'string' || !payload) {
      return { success: false, error: 'Arquivo de backup inválido.' };
    }
    try {
      const contents = await openBackup(payload, password);
      return { success: true, contents };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  handleFromMainFrame('backup:save-file', async (_event, contents: string, suggestedName: string) => {
    if (typeof contents !== 'string' || !contents) {
      return { success: false, error: 'Conteúdo de backup inválido.' };
    }
    try {
      const safeName = sanitizeDownloadFileName(suggestedName || 'monky-backup.monkybackup');
      const result = await dialog.showSaveDialog(mainWindow, {
        title: mt('dialog.saveBackup'),
        defaultPath: path.join(app.getPath('documents'), safeName),
        filters: [{ name: 'Monky', extensions: ['monkybackup', 'json'] }],
      });
      if (result.canceled || !result.filePath) return { success: false };
      await fs.promises.writeFile(result.filePath, contents, 'utf8');
      return { success: true, filePath: result.filePath };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  handleFromMainFrame('backup:open-file', async () => {
    try {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: mt('dialog.openBackup'),
        filters: [{ name: 'Monky', extensions: ['monkybackup', 'json'] }],
        properties: ['openFile'],
      });
      if (result.canceled || result.filePaths.length === 0) return { success: false };
      const contents = await fs.promises.readFile(result.filePaths[0], 'utf8');
      return { success: true, contents };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  // Local Server Management
  handleFromMainFrame('server-host:start', async (_, options: HostServerOptions) => {
    return await serverManager.startServer(options);
  });

  const hostedPort = (port: unknown): port is number =>
    typeof port === 'number' && Number.isInteger(port) && port >= LIMITS.MIN_PORT && port <= LIMITS.MAX_PORT;

  handleFromMainFrame('server-host:stop', async (_, port: unknown) => {
    if (!hostedPort(port)) return { success: false };
    await serverManager.stopServer(port);
    return { success: true };
  });

  handleFromMainFrame('server-host:status', async () => {
    return serverManager.getStatus();
  });

  handleFromMainFrame('server-host:logs', async (_, port: unknown) => {
    return hostedPort(port) ? serverManager.getLogs(port) : [];
  });

  handleFromMainFrame('server-host:clear-logs', async (_, port: unknown) => {
    if (hostedPort(port)) serverManager.clearLogs(port);
  });

  handleFromMainFrame('server-host:stats', async (_, port: unknown) => {
    return hostedPort(port) ? serverManager.getStats(port) : null;
  });

  // Removing a server from "Meus Servidores" has to take its data with it (#364).
  handleFromMainFrame('server-host:delete-data', async (_, serverId: string) => {
    if (typeof serverId !== 'string') return { success: false };
    return serverManager.deleteServerData(serverId);
  });

  handleFromMainFrame('lan:start', async () => {
    await lanDiscovery.start();
  });

  handleFromMainFrame('lan:stop', async () => {
    await lanDiscovery.stop();
  });

  // Desktop Screen Sharing sources
  ipcMain.handle('screen-share:ensure-permission', async () => {
    return await ensureScreenRecordingPermission(mainWindow);
  });

  let nativeThumbnails: NativeThumbnailCapturer | undefined;
  let desktopSourcesFrozen = false;
  async function enumerateDesktopSources(metadataOnly: boolean, type?: DesktopSource['type'],
    sourceIds?: readonly string[], signal?: AbortSignal): Promise<DesktopSource[]> {
    if (desktopSourcesFrozen || signal?.aborted)
      throw new DOMException('Desktop source enumeration was cancelled.', 'AbortError');
    if (process.platform === 'darwin') {
      const provider = getMacSources();
      let sources = (await provider.listSources({ signal })).filter(source =>
        (!type || source.type === type) && !overlayManager.isScreenShareSource(source.id));
      if (metadataOnly) return sources;
      if (sourceIds) sources = sources.filter(source => sourceIds.includes(source.id));
      for (let offset = 0; offset < sources.length; offset += 4) {
        await Promise.all(sources.slice(offset, offset + 4).map(async source => {
          try {
            const bytes = await provider.thumbnail(source.id, { signal });
            source.thumbnailDataUrl = `data:image/png;base64,${bytes.toString('base64')}`;
            source.thumbnailState = 'ready';
          } catch (error) {
            if (signal?.aborted || error instanceof Error && error.name === 'AbortError') throw error;
            console.warn('[ScreenShare:Main] Native macOS preview unavailable:', error);
            source.thumbnailState = 'unavailable';
          }
        }));
      }
      return sources;
    }
    if (process.platform === 'win32') {
      let windows: ReturnType<NativeDesktopSources['listWindows']>;
      let result: DesktopSource[];
      try {
        windows = type === 'screen' ? [] : nativeSources.listWindows();
        result = windows.map(({ id, window, processAncestry }) => {
          const occlusionEngine = browserOcclusionEngine(window.processPath);
          return {
            id, name: window.title, type: 'window', isOwnWindow: window.processId === process.pid,
            processId: window.processId,
            ...(processAncestry ? { processAncestry } : {}),
            ...(occlusionEngine ? { occlusionEngine } : {}),
            thumbnailDataUrl: '', appIconDataUrl: null, thumbnailState: window.isIconic ? 'unavailable' : 'pending',
          } satisfies DesktopSource;
        });
        if (type !== 'window') result.push(...nativeMonitorDesktopSources(nativeSources.listMonitors()));
      } catch (error) {
        console.warn('[ScreenShare:Main] Native desktop source enumeration failed:', error);
        try {
          options?.clientLogger?.write({
            timestamp: new Date().toISOString(), level: 'ERROR', category: 'SCREEN_SHARE',
            message: 'Native desktop source enumeration failed',
            data: { phase: 'native-source-identities', metadataOnly, type: type ?? 'all' },
          });
        } catch (loggingError) {
          console.error('[ScreenShare:Main] Could not persist source enumeration failure:', loggingError);
        }
        throw error;
      }
      if (metadataOnly) return result;
      if (sourceIds) {
        const requested = new Set(sourceIds);
        result = result.filter(source => requested.has(source.id));
      }
      const paths = new Map(windows.map(({ id, window }) => [id, window.processPath]));
      const iconPaths = result.flatMap(source => {
        const filename = paths.get(source.id);
        return filename ? [filename] : [];
      });
      const icons = await new Promise<Map<string, string>>((resolve, reject) => {
        const abort = () => {
          signal?.removeEventListener('abort', abort);
          reject(new DOMException('Desktop preview icons were cancelled.', 'AbortError'));
        };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        void resolveWindowsAppIcons(iconPaths).then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort));
      });
      const previews = await Promise.allSettled(result.map(async source => {
        source.appIconDataUrl = icons.get(paths.get(source.id) ?? '') ?? null;
        if (source.thumbnailState === 'unavailable') return;
        try {
          if (signal?.aborted) throw new DOMException('Desktop preview was cancelled.', 'AbortError');
          nativeThumbnails ??= new NativeThumbnailCapturer(loadThumbnailRuntime());
          const kind = source.type === 'screen' ? 'monitor' : 'window';
          const target = nativeSources.resolve(source.id, kind);
          const image = await nativeThumbnails.capture(target, { signal });
          nativeSources.resolve(source.id, kind);
          source.thumbnailDataUrl = `data:image/png;base64,${image.toString('base64')}`;
          source.thumbnailState = 'ready';
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') throw error;
          const code = error instanceof Error && 'code' in error && typeof error.code === 'string'
            && /^ERR_DESKTOP_PREVIEW_[A-Z_]{1,32}$/u.test(error.code) ? error.code : 'ERR_DESKTOP_PREVIEW_UNAVAILABLE';
          const hresult = error instanceof Error && 'hresult' in error && typeof error.hresult === 'number'
            && Number.isInteger(error.hresult) && error.hresult >= 0 && error.hresult <= 0xffffffff ? error.hresult : undefined;
          console.warn('[ScreenShare:Main] Native desktop preview unavailable:', code);
          options?.clientLogger?.write({
            timestamp: new Date().toISOString(), level: 'WARN', category: 'SCREEN_SHARE',
            message: 'Native desktop preview unavailable', data: { type: source.type, code, hresult },
          });
          source.thumbnailState = 'unavailable';
        }
      }));
      const errors = previews.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Native desktop preview requests failed.');
      return result;
    }
    const sources = (await desktopCapturer.getSources({
      types: type ? [type] : ['screen', 'window'],
      thumbnailSize: metadataOnly ? { width: 0, height: 0 } : { width: 320, height: 180 },
      fetchWindowIcons: !metadataOnly,
    })).filter(source => !overlayManager.isScreenShareSource(source.id));
    const macIcons = metadataOnly ? new Map<string, string>() : await resolveMacAppIcons(sources.map((s) => s.id));
    return sources.map((s) => {
      const electronIcon = s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null;
      return {
        id: s.id,
        name: s.name,
        type: s.id.startsWith('screen:') ? 'screen' : 'window',
        thumbnailDataUrl: metadataOnly || s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
        appIconDataUrl: electronIcon ?? macIcons.get(s.id) ?? null,
        thumbnailState: metadataOnly ? 'pending' : s.thumbnail.isEmpty() ? 'unavailable' : 'ready',
      };
    });
  }

  const sourcePreviews = new DesktopSourcePreviews((type, ids, signal) => enumerateDesktopSources(false, type, ids, signal));
  const stopDesktopPreviews = async (): Promise<void> => {
    desktopSourcesFrozen = true;
    await Promise.all([sourcePreviews.dispose(), nativeThumbnails?.close(), macSources?.close()]);
  };
  ipcMain.handle(DESKTOP_SOURCES_IPC.list, async (_event, input: unknown) => {
    const options = desktopSourcesOptionsSchema.parse(input === undefined ? {} : input);
    if (options.refresh) sourcePreviews.clear();
    const sources = await enumerateDesktopSources(options.metadataOnly === true);
    return options.metadataOnly ? sources.map(source => {
      const cached = sourcePreviews.cached(source.id);
      if (!cached) return source;
      return source.thumbnailState === 'unavailable' ? { ...source, appIconDataUrl: cached.appIconDataUrl }
        : { ...source, ...cached, thumbnailState: cached.thumbnailDataUrl ? 'ready' as const : 'unavailable' as const };
    }) : sources;
  });
  ipcMain.handle(DESKTOP_SOURCES_IPC.previews, async (_event, input: unknown) => {
    const request = desktopSourcePreviewsRequestSchema.parse(input);
    return sourcePreviews.get({ ...request, sourceIds: request.sourceIds.filter(id => !overlayManager.isScreenShareSource(id)) });
  });
  ipcMain.handle(DESKTOP_SOURCES_IPC.cancelPreviews, async () => sourcePreviews.cancel());

  // Restaura uma janela minimizada antes da captura (#560). O capturador WGC nao
  // consegue iniciar numa janela minimizada, entao o jogo em tela cheia que
  // minimizou no alt-tab precisa voltar ao primeiro plano antes do getUserMedia.
  ipcMain.handle('screen-share:prepare-window', (_event, sourceId: string) => {
    assertCaptureSourceAllowed(sourceId);
    if (process.platform !== 'win32') return false;
    if (typeof sourceId !== 'string') return false;
    const hwnd = nativeWindowIdFromSourceId(sourceId);
    if (hwnd === null) return false;
    try {
      return screenAudio.restoreWindow(hwnd);
    } catch (e) {
      console.warn('[ScreenShare:Main] Falha ao restaurar janela:', (e as Error).message);
      return false;
    }
  });

  // Avatar Image Selection Dialog
  ipcMain.handle('dialog:select-image', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: mt('dialog.selectProfilePhoto'),
      filters: [
        { name: 'Imagens (PNG, JPG, WebP)', extensions: ['png', 'jpg', 'jpeg', 'webp'] },
      ],
      properties: ['openFile'],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const filePath = result.filePaths[0];
    const buffer = await fs.promises.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase().replace('.', '');
    const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    const base64 = buffer.toString('base64');

    return {
      fileName: path.basename(filePath),
      mimeType: mime,
      base64: `data:${mime};base64,${base64}`,
    };
  });

  ipcMain.handle('dialog:select-images', async (_event, maxFiles: number) => {
    const limit = Math.min(5, Math.max(1, Number.isInteger(maxFiles) ? maxFiles : 1));
    const result = await dialog.showOpenDialog(mainWindow, {
      title: mt('dialog.selectImages'),
      filters: [
        { name: 'Imagens (PNG, JPG, WebP)', extensions: ['png', 'jpg', 'jpeg', 'webp'] },
      ],
      properties: ['openFile', 'multiSelections'],
    });
    if (result.canceled || result.filePaths.length === 0) return [];
    return Promise.all(result.filePaths.slice(0, limit).map(async filePath => {
      const buffer = await fs.promises.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase().replace('.', '');
      const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
      return {
        fileName: path.basename(filePath),
        mimeType: mime,
        base64: `data:${mime};base64,${buffer.toString('base64')}`,
      };
    }));
  });

  // Custom sound file selection (#7)
  handleFromMainFrame('dialog:select-sound-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: mt('dialog.selectSoundFile'),
      filters: [
        { name: mt('dialog.audioFilter'), extensions: ['wav', 'mp3', 'ogg', 'webm'] },
      ],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const filePath = result.filePaths[0];
    const buffer = await fs.promises.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase().replace('.', '');
    const mime = ext === 'mp3' ? 'audio/mpeg' : ext === 'ogg' ? 'audio/ogg' : ext === 'webm' ? 'audio/webm' : 'audio/wav';
    const base64 = buffer.toString('base64');
    return `data:${mime};base64,${base64}`;
  });

  // Soundboard Folder Selection
  ipcMain.handle('dialog:select-soundboard-folder', async (event) => {
    if (!ownsSoundDownload(event)) throw new Error(mt('error.confirmSoundboardFolder'));
    const result = await dialog.showOpenDialog(mainWindow, {
      title: mt('dialog.selectSoundboardFolder'),
      properties: ['openDirectory'],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    let confirmed: string | null;
    try {
      confirmed = await soundDownloads.confirmFolder(result.filePaths[0]);
    } catch (error) {
      console.warn('[Soundboard] Could not persist the confirmed folder:', error);
      throw new Error(mt('error.confirmSoundboardFolder'));
    }
    if (confirmed) await allowMediaFolder('soundboard', confirmed);
    return confirmed;
  });

  // Soundboard List Sounds
  handleFromMainFrame('soundboard:list-sounds', async (_, folderPath: string, userAction: unknown) => {
    if (!folderPath || typeof folderPath !== 'string') {
      return [];
    }
    // The renderer shows remote content: only a folder confirmed natively is listed (D4).
    const access = await requestMediaFolder('soundboard', folderPath, userAction);
    if (access.status === 'missing') return [];
    if (access.status !== 'allowed') throw new Error('This sound folder was not confirmed on this computer.');
    try {
      const folderStat = await fs.promises.stat(folderPath).catch(() => null);
      if (!folderStat || !folderStat.isDirectory()) {
        return [];
      }
      const entries = await fs.promises.readdir(folderPath, { withFileTypes: true });
      const validExts = SOUNDBOARD_EXTENSIONS;
      
      const soundPromises = entries
        .filter((entry) => entry.isFile() && validExts.has(path.extname(entry.name).toLowerCase()))
        .map(async (entry) => {
          const ext = path.extname(entry.name).toLowerCase();
          const fullPath = path.join(folderPath, entry.name);
          const stat = await fs.promises.stat(fullPath);
          const displayName = path.basename(entry.name, ext);
          return {
            name: displayName,
            fileName: entry.name,
            filePath: fullPath,
            sizeBytes: stat.size,
            ext,
          };
        });

      const sounds = await Promise.all(soundPromises);
      sounds.sort((a, b) => a.name.localeCompare(b.name));
      return sounds;
    } catch (e) {
      console.warn('Error reading soundboard folder:', e);
      return [];
    }
  });

  // Soundboard Read Sound
  handleFromMainFrame('soundboard:read-sound', async (_, filePath: string) => {
    if (!filePath || typeof filePath !== 'string') {
      return null;
    }
    // O caminho vem do renderer, então a extensão é conferida antes da leitura:
    // sem isso o canal devolvia o conteúdo de qualquer arquivo até 3 MB (#372).
    if (!SOUNDBOARD_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
      return null;
    }
    // ...e o arquivo precisa estar numa pasta confirmada pelo diálogo do sistema (D4).
    const soundFile = await mediaFolders.resolveFile('soundboard', filePath);
    if (!soundFile) return null;
    try {
      const stat = await fs.promises.stat(soundFile).catch(() => null);
      if (!stat || !stat.isFile()) {
        return null;
      }
      if (stat.size > LIMITS.MAX_SOUNDBOARD_FILE_SIZE) {
        throw new Error(mt('error.audioFileTooLarge'));
      }
      const buffer = await fs.promises.readFile(soundFile);
      const ext = path.extname(filePath).toLowerCase();
      let mime = 'audio/mpeg';
      if (ext === '.wav') mime = 'audio/wav';
      else if (ext === '.ogg') mime = 'audio/ogg';
      else if (ext === '.m4a') mime = 'audio/mp4';
      else if (ext === '.aac') mime = 'audio/aac';
      else if (ext === '.webm') mime = 'audio/webm';

      return {
        fileName: path.basename(filePath),
        soundName: path.basename(filePath, ext),
        mimeType: mime,
        base64: buffer.toString('base64'),
        dataUrl: `data:${mime};base64,${buffer.toString('base64')}`,
        sizeBytes: stat.size,
      };
    } catch (e: unknown) {
      console.warn('Error reading sound file:', e);
      return null;
    }
  });

  // --- Figurinhas do chat (#356) ---
  // Same shape as the soundboard folder feature: the user points at a folder on
  // their machine and we only ever read image files out of it.
  const STICKER_MIME_TYPES: Record<string, string> = {
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.apng': 'image/apng',
    '.avif': 'image/avif',
  };
  // Animated GIFs and WebPs are routinely a few megabytes, so the ceiling has to
  // be generous enough not to quietly swallow a normal sticker. The server
  // accepts far more (LIMITS.MAX_ATTACHMENT_FILE_SIZE_DEFAULT is 50 MB); the
  // tighter bound here exists only because the renderer decodes these as base64
  // data URLs, which costs ~33% on top of the file size.
  const MAX_STICKER_BYTES = 8 * 1024 * 1024;
  const MAX_STICKERS_LISTED = 500;

  /**
   * Folders the user confirmed through the dialog below. `stickers:save` is the
   * only channel here that writes to disk, so it refuses any folder outside this
   * set: the renderer handles untrusted remote chat content and must not be able
   * to name an arbitrary write target. Listing and reading follow the same rule
   * through `mediaFolders` (D4), which also keeps folders configured before it.
   *
   * It is persisted so the confirmation survives a restart — otherwise the first
   * save of every session would pop a folder dialog for no reason the user can
   * see.
   */
  const confirmedFoldersFile = path.join(app.getPath('userData'), 'sticker-folders.json');

  const loadConfirmedStickerFolders = (): Set<string> => {
    try {
      const raw = fs.readFileSync(confirmedFoldersFile, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return new Set();
      return new Set(parsed.filter((p): p is string => typeof p === 'string'));
    } catch {
      return new Set();
    }
  };

  const confirmedStickerFolders = loadConfirmedStickerFolders();

  const confirmStickerFolder = (folder: string): void => {
    confirmedStickerFolders.add(path.resolve(folder));
    try {
      fs.writeFileSync(confirmedFoldersFile, JSON.stringify(Array.from(confirmedStickerFolders)), 'utf8');
    } catch (e) {
      // Losing the record only costs an extra dialog next session.
      console.warn('Could not persist the confirmed stickers folder:', e);
    }
  };

  handleFromMainFrame('dialog:select-stickers-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: mt('dialog.selectStickersFolder'),
      properties: ['openDirectory'],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    confirmStickerFolder(result.filePaths[0]);
    await allowMediaFolder('stickers', result.filePaths[0]);
    return result.filePaths[0];
  });

  handleFromMainFrame('stickers:list', async (_, folderPath: string, userAction: unknown) => {
    if (!folderPath || typeof folderPath !== 'string') {
      return [];
    }
    const access = await requestMediaFolder('stickers', folderPath, userAction);
    if (access.status === 'missing') return [];
    if (access.status !== 'allowed') throw new Error('This sticker folder was not confirmed on this computer.');
    try {
      const folderStat = await fs.promises.stat(folderPath).catch(() => null);
      if (!folderStat || !folderStat.isDirectory()) {
        return [];
      }
      const entries = await fs.promises.readdir(folderPath, { withFileTypes: true });
      const candidates = entries
        .filter((entry) => entry.isFile() && STICKER_MIME_TYPES[path.extname(entry.name).toLowerCase()])
        .slice(0, MAX_STICKERS_LISTED);

      const stickers = await Promise.all(
        candidates.map(async (entry) => {
          const ext = path.extname(entry.name).toLowerCase();
          const fullPath = path.join(folderPath, entry.name);
          const stat = await fs.promises.stat(fullPath).catch(() => null);
          if (!stat) return null;
          return {
            name: path.basename(entry.name, ext),
            fileName: entry.name,
            filePath: fullPath,
            sizeBytes: stat.size,
            ext,
            mimeType: STICKER_MIME_TYPES[ext],
            // Listed but flagged instead of dropped, so an oversized file is
            // visibly rejected rather than appearing to have been ignored.
            tooLarge: stat.size > MAX_STICKER_BYTES,
          };
        })
      );

      const valid = stickers.filter((s): s is NonNullable<typeof s> => s !== null);
      valid.sort((a, b) => a.name.localeCompare(b.name));
      return valid;
    } catch (e) {
      console.warn('Error reading stickers folder:', e);
      return [];
    }
  });

  handleFromMainFrame('stickers:read', async (_, filePath: string) => {
    if (!filePath || typeof filePath !== 'string') {
      return null;
    }
    // Only ever hand image bytes back to the renderer, and only from a confirmed folder.
    const ext = path.extname(filePath).toLowerCase();
    const mimeType = STICKER_MIME_TYPES[ext];
    if (!mimeType) return null;
    const stickerFile = await mediaFolders.resolveFile('stickers', filePath);
    if (!stickerFile) return null;
    try {
      const stat = await fs.promises.stat(stickerFile).catch(() => null);
      if (!stat || !stat.isFile() || stat.size > MAX_STICKER_BYTES) {
        return null;
      }
      const buffer = await fs.promises.readFile(stickerFile);
      return {
        fileName: path.basename(filePath),
        mimeType,
        dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}`,
        sizeBytes: stat.size,
      };
    } catch (e) {
      console.warn('Error reading sticker file:', e);
      return null;
    }
  });

  // Saves a sticker somebody else sent into the user's own folder (#356 QA).
  handleFromMainFrame('stickers:save', async (_, folderPath: string, fileName: string, bytes: Uint8Array) => {
    if (!folderPath || typeof folderPath !== 'string') {
      return { ok: false, reason: 'no-folder' as const };
    }
    // Only a folder the user confirmed through the dialog is writable, so the
    // renderer cannot pick the destination on its own.
    if (!confirmedStickerFolders.has(path.resolve(folderPath))) {
      return { ok: false, reason: 'no-folder' as const };
    }
    // The renderer supplies the name, so only the basename is trusted: it must
    // never be able to steer the write outside that folder.
    const safeName = path.basename(String(fileName ?? ''));
    const ext = path.extname(safeName).toLowerCase();
    if (!safeName || !STICKER_MIME_TYPES[ext]) {
      return { ok: false, reason: 'bad-extension' as const };
    }
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_STICKER_BYTES) {
      return { ok: false, reason: 'too-large' as const };
    }
    try {
      const folderStat = await fs.promises.stat(folderPath).catch(() => null);
      if (!folderStat || !folderStat.isDirectory()) {
        return { ok: false, reason: 'no-folder' as const };
      }

      // Never clobber an existing sticker: "cat.gif" becomes "cat (1).gif". The
      // 'wx' flag makes the filesystem itself reject an existing name, so there
      // is no window between checking and writing.
      const base = path.basename(safeName, ext);
      for (let i = 0; i < 100; i++) {
        const candidate = i === 0 ? safeName : `${base} (${i})${ext}`;
        try {
          await fs.promises.writeFile(path.join(folderPath, candidate), bytes, { flag: 'wx' });
          return { ok: true, fileName: candidate };
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        }
      }
      return { ok: false, reason: 'write-failed' as const };
    } catch (e) {
      console.warn('Error saving sticker file:', e);
      return { ok: false, reason: 'write-failed' as const };
    }
  });

  // Global shortcuts for the soundboard and actions (mute/deafen/camera/etc.)
  // are matched through the passive uiohook listener (globalInputHook) instead
  // of Electron globalShortcut. globalShortcut.register() consumes the key on
  // Windows, so a single-key bind like "Q" was swallowed and never reached the
  // focused game (#571). uiohook only observes input, so the key passes through.
  // Only the main window's top frame configures them, push-to-talk included:
  // nothing else may replace its global input (R-MEDIA-3).
  handleFromMainFrame(SHORTCUT_IPC.registerSoundboard, (_, shortcuts: unknown) => {
    return globalInputHook.setSoundboardHotkeys(shortcuts);
  });

  // Action Global Shortcuts Registration (#252)
  handleFromMainFrame(SHORTCUT_IPC.registerActions, (_, shortcuts: unknown) => {
    return globalInputHook.setActionHotkeys(shortcuts);
  });

  handleFromMainFrame(SHORTCUT_IPC.setCapture, (_, active: unknown) => {
    return globalInputHook.setShortcutCapture(active);
  });

  mainWindow.webContents.on('did-start-loading', () => {
    globalInputHook.stopCapture();
    globalInputHook.setShortcutCapture(false);
  });
  mainWindow.webContents.on('render-process-gone', () => {
    globalInputHook.stopCapture();
    globalInputHook.setShortcutCapture(false);
    globalInputHook.setPttConfig({ enabled: false, key: null });
    globalInputHook.setActionHotkeys([]);
    globalInputHook.setSoundboardHotkeys([]);
  });

  // Push to Talk (PTT) (#186)
  handleFromMainFrame(SHORTCUT_IPC.setPttConfig, (_, config: unknown) => {
    return globalInputHook.setPttConfig(config);
  });

  handleFromMainFrame(SHORTCUT_IPC.startPttCapture, () => {
    return globalInputHook.startCapture();
  });

  handleFromMainFrame(SHORTCUT_IPC.stopPttCapture, () => {
    return globalInputHook.stopCapture();
  });

  // Window Controls
  // Automatic Picture-in-Picture follows the window leaving the screen
  // (minimized or hidden to the tray), never a plain focus change.
  const isWindowAway = () => mainWindow.isMinimized() || !mainWindow.isVisible();
  let screenPipWindowInactive = isWindowAway();
  const notifyWindowActivity = () => {
    if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
    const inactive = isWindowAway();
    // Minimize, hide, restore and show can describe the same native transition.
    if (inactive === screenPipWindowInactive) return;
    screenPipWindowInactive = inactive;
    mainWindow.webContents.send(inactive ? 'window:inactive' : 'window:active');
  };
  mainWindow.on('minimize', notifyWindowActivity);
  mainWindow.on('hide', notifyWindowActivity);
  mainWindow.on('restore', notifyWindowActivity);
  mainWindow.on('show', notifyWindowActivity);
  mainWindow.on('focus', notifyWindowActivity);
  const screenPipWindows = new ScreenPictureInPictureWindows(mainWindow);
  // Authorizes one popup from the main frame; the renderer opens it right
  // after with window.open, which needs no user activation in Electron.
  ipcMain.handle('screen-pip:open', (event, requestId: unknown, requireInactive: unknown, aspectRatio: unknown) => {
    if (mainWindow.isDestroyed() || event.sender !== mainWindow.webContents
      || event.senderFrame !== mainWindow.webContents.mainFrame
      || typeof requestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(requestId)
      || typeof requireInactive !== 'boolean'
      || typeof aspectRatio !== 'number' || !Number.isFinite(aspectRatio) || aspectRatio <= 0) {
      throw new Error('Invalid screen Picture-in-Picture request.');
    }
    if (requireInactive && !isWindowAway()) return false;
    screenPipWindows.authorize(requestId, aspectRatio);
    return true;
  });
  // "Voltar ao Monky" must bring back a minimized or tray-hidden window.
  ipcMain.handle('screen-pip:return', (event) => {
    if (mainWindow.isDestroyed() || event.sender !== mainWindow.webContents
      || event.senderFrame !== mainWindow.webContents.mainFrame) {
      throw new Error('Invalid screen Picture-in-Picture request.');
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  });
  ipcMain.handle('window:minimize', () => {
    mainWindow.minimize();
  });
  ipcMain.handle('window:toggle-maximize', () => {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  });
  ipcMain.handle('window:maximize', () => {
    mainWindow.maximize();
  });

  // The connection screen is a narrow card, but the in-server layout (rail +
  // channels + stage + members) needs room to stay usable, so the floor is
  // raised to a 16:9 box while a server is open (#342).
  ipcMain.handle('window:set-in-server', (_event, inServer: boolean) => {
    const [minWidth, minHeight] = inServer
      ? [IN_SERVER_MIN_WIDTH, IN_SERVER_MIN_HEIGHT]
      : [HOME_MIN_WIDTH, HOME_MIN_HEIGHT];

    mainWindow.setMinimumSize(minWidth, minHeight);

    // setMinimumSize does not resize a window that is already smaller, which
    // would leave the layout clipped until the user dragged an edge.
    if (!mainWindow.isMaximized() && !mainWindow.isFullScreen()) {
      const [width, height] = mainWindow.getSize();
      if (width < minWidth || height < minHeight) {
        mainWindow.setSize(Math.max(width, minWidth), Math.max(height, minHeight));
      }
    }
  });

  ipcMain.handle('window:close', () => {
    mainWindow.close();
  });

  // The connection screen must never need scrolling: it grows to whatever the
  // card measures, error banner included, and only stops at the display's work
  // area so the window can't outgrow the monitor (#536).
  ipcMain.handle('window:fit-home-content', (_event, contentHeight: number) => {
    if (!Number.isFinite(contentHeight) || contentHeight <= 0) return;
    if (mainWindow.isDestroyed() || mainWindow.isMaximized() || mainWindow.isFullScreen()) return;

    const bounds = mainWindow.getBounds();
    const [, currentContentHeight] = mainWindow.getContentSize();
    // Title bar and borders are not part of the measured content.
    const chrome = bounds.height - currentContentHeight;
    const workArea = screen.getDisplayMatching(bounds).workArea;
    const desired = Math.ceil(contentHeight) + chrome;
    const target = Math.max(HOME_MIN_HEIGHT, Math.min(desired, workArea.height));

    mainWindow.setMinimumSize(HOME_MIN_WIDTH, target);

    // Only ever grow: shrinking would fight a user who deliberately enlarged
    // the window, and a taller window never causes the scrollbar this fixes.
    if (bounds.height >= target) return;

    // Growing downwards past the taskbar would push the card off-screen, so the
    // window slides up just enough to stay inside the work area.
    const y = Math.max(workArea.y, Math.min(bounds.y, workArea.y + workArea.height - target));
    mainWindow.setBounds({ ...bounds, y, height: target });
  });

  // App version (for update checks)
  ipcMain.handle('app:get-version', () => app.getVersion());

  // Open an external URL in the default browser
  ipcMain.handle('game-presence:set-enabled', (_event, enabled: boolean) => {
    steamPresence.setEnabled(enabled === true);
  });

  ipcMain.handle('game-presence:get-current', () => steamPresence.getCurrent());

  // Listing here also registers the ids, so the native capture can resolve them (#763).
  ipcMain.handle('game-share:find-windows', async () => {
    if (process.platform !== 'win32') return [];
    const folders = await steamPresence.currentGameFolders();
    if (folders.length === 0) return [];
    try {
      return gameWindowIds(nativeSources.listWindows(), folders);
    } catch (error) {
      console.warn('[GameShare] Could not list the game windows:', (error as Error).message);
      return [];
    }
  });

  // Input anywhere in the system counts, not only in Monky's window: someone
  // playing a game in the foreground is not idle in the call.
  ipcMain.handle('system:get-idle-seconds', () => powerMonitor.getSystemIdleTime());

  ipcMain.handle('app:open-external', async (_, url: string) => {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return { success: false };
      }

      await shell.openExternal(parsed.toString());
      return { success: true };
    } catch {
      return { success: false };
    }
  });

  ipcMain.handle('link-preview:fetch', async (_, url: string) => {
    if (typeof url !== 'string') return null;
    return await fetchLinkPreview(url);
  });

  // Auto-start with OS (#245)
  handleFromMainFrame('app:get-auto-start', () => {
    return app.getLoginItemSettings().openAtLogin;
  });

  handleFromMainFrame('app:set-auto-start', (_, enabled: unknown) => {
    if (typeof enabled === 'boolean') app.setLoginItemSettings({ openAtLogin: enabled });
  });

  handleFromMainFrame('app:download-file', async (_, url: string, fileName: unknown) => {
    try {
      const parsedUrl = new URL(url);
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        return { success: false, error: 'Invalid URL' };
      }

      const suggestedName = suggestedDownloadName(parsedUrl, fileName);
      const saveResult = await dialog.showSaveDialog(mainWindow, {
        defaultPath: path.join(app.getPath('downloads'), suggestedName),
      });

      if (saveResult.canceled || !saveResult.filePath) {
        return { success: false };
      }

      await downloadToFile(parsedUrl.toString(), saveResult.filePath);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  handleFromMainFrame('app:save-csv-file', async (_, content: string, fileName: string) => {
    try {
      if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > 128 * 1024 * 1024) {
        return { success: false, error: 'Invalid CSV content' };
      }
      const safeName = sanitizeDownloadFileName(fileName || 'responses.csv');
      const suggestedName = safeName.toLowerCase().endsWith('.csv') ? safeName : `${safeName}.csv`;
      const saveResult = await dialog.showSaveDialog(mainWindow, {
        defaultPath: path.join(app.getPath('downloads'), suggestedName),
        filters: [{ name: 'CSV', extensions: ['csv'] }],
      });
      if (saveResult.canceled || !saveResult.filePath) return { success: false };
      await fs.promises.writeFile(saveResult.filePath, content, 'utf8');
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  // TCP reachability probe (#37): distinguishes an unreachable host (offline)
  // from a reachable host whose port refuses the connection (server closed).
  ipcMain.handle('net:probe-server', async (_, host: string, port: number) => {
    return await new Promise<{ reachable: boolean; reason: 'online' | 'refused' | 'timeout' | 'unreachable' }>(
      (resolve) => {
        const socket = new net.Socket();
        let settled = false;
        const finish = (result: { reachable: boolean; reason: 'online' | 'refused' | 'timeout' | 'unreachable' }) => {
          if (settled) return;
          settled = true;
          socket.destroy();
          resolve(result);
        };

        socket.setTimeout(5000);
        socket.once('connect', () => finish({ reachable: true, reason: 'online' }));
        socket.once('timeout', () => finish({ reachable: false, reason: 'timeout' }));
        socket.once('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'ECONNREFUSED') {
            // Host answered but the port is closed → machine is online, server is not.
            finish({ reachable: false, reason: 'refused' });
          } else if (err.code === 'ETIMEDOUT') {
            finish({ reachable: false, reason: 'timeout' });
          } else {
            // ENOTFOUND / EHOSTUNREACH / ENETUNREACH / etc. → host is offline.
            finish({ reachable: false, reason: 'unreachable' });
          }
        });

        try {
          socket.connect(port, host);
        } catch {
          finish({ reachable: false, reason: 'unreachable' });
        }
      }
    );
  });

  // Client Logging (#444)
  const logger = options?.clientLogger;
  if (logger) {
    ipcMain.handle('client-log:write', (_, entry) => {
      logger.write(entry);
    });
    ipcMain.handle('client-log:get-config', () => logger.getConfig());
    ipcMain.handle('client-log:set-config', (_, config) => {
      logger.setConfig(config);
    });
    ipcMain.handle('client-log:export', () => logger.exportLogs());
    ipcMain.handle('client-log:get-size', () => logger.getTotalSize());
    ipcMain.handle('client-log:clear', () => {
      logger.clearLogs();
    });
  }

  mainWindow.on('closed', () => {
    void stopDesktopPreviews().catch(error => console.error('[ScreenShare:Main] Preview shutdown failed:', error));
    for (const channel of Object.values(DESKTOP_SOURCES_IPC)) ipcMain.removeHandler(channel);
    stopSoundDownloads();
    for (const channel of Object.values(SOUND_DOWNLOAD_IPC)) ipcMain.removeHandler(channel);
    disposeSoundboardFiles();
    disposeEditorCommands();
    disposeEventCalendar();
    disposeHostingSkill();
    disposeRecentSoundSave();
    disposeFileBatchDownload();
    disposeDirectMessages();
    for (const channel of Object.values(AUDIO_PREVIEW_IPC)) ipcMain.removeHandler(channel);
    ipcMain.removeHandler('app:save-csv-file');
    void lanDiscovery.stop();
    globalInputHook.destroy();
  });
  return {
    service: localExecution.service,
    freezeAdmissions: () => {
      desktopSourcesFrozen = true;
      sourcePreviews.clear();
      localExecution.freezeAdmissions();
      nativeScreenSharing.freezeAdmissions();
    },
    prepareShutdown: async () => {
      localExecution.freezeAdmissions();
      await Promise.all([stopDesktopPreviews(), nativeScreenSharing.prepareShutdown()]);
    },
    async dispose() {
      const results = await Promise.allSettled([stopDesktopPreviews(), nativeScreenSharing.dispose(), localExecution.dispose()]);
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Application resource shutdown failed.');
    },
  };
}
