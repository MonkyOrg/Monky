import { app, ipcMain as electronIpcMain, type BrowserWindow } from 'electron';
import * as screenAudio from '@monky/screen-audio';
import { downloadToFile, sanitizeDownloadFileName } from './attachmentDownload';
import type { ClientLogger } from './clientLogger';
import { registerDmIpc, writeDmAttachment } from './dm/dmIpc';
import { registerEditorCommands } from './editorCommands';
import { registerFileBatchDownloadIpc } from './fileBatchDownloadIpc';
import { registerHostingSkillIpc } from './hostingSkills';
import type { ContractIpcMain } from './ipcContract';
import { createLocalExecutionService } from './localExecution/createService';
import { setupLocalExecutionIpc, type LocalExecutionIpc } from './localExecution/ipc';
import type { LocalTools } from './localExecution/LocalTools';
import { registerNativeScreenSharingIpc } from './nativeScreenSharing';
import { OverlayManager } from './overlayManager';
import { ScreenPictureInPictureWindows } from './screenPictureInPictureWindow';
import { registerEventCalendarIpc } from './serverEventCalendarIpc';
import type { ServerManager } from './serverManager';
import { SteamPresence } from './steamPresence';
import type { TaskbarCallControls } from './taskbarCallControls';
import type { TrayManager } from './trayManager';
import { registerUpdaterIpc } from './updater';
import { registerAppIpc } from './ipc/appIpc';
import { registerClientLogIpc } from './ipc/clientLogIpc';
import { DesktopSourceCatalog, registerDesktopSourcesIpc, windowsDesktopSources } from './ipc/desktopSourcesIpc';
import { registerFilesIpc } from './ipc/filesIpc';
import { registerHostedServerIpc } from './ipc/hostedServerIpc';
import { registerIdentityIpc } from './ipc/identityIpc';
import { registerMediaFoldersIpc } from './ipc/mediaFoldersIpc';
import { registerOverlayIpc } from './ipc/overlayIpc';
import { IpcRegistry, windowContents } from './ipc/registry';
import { registerShortcutsIpc } from './ipc/shortcutsIpc';
import { registerSoundboardIpc } from './ipc/soundboardIpc';
import { registerStickersIpc } from './ipc/stickersIpc';
import { registerWindowIpc } from './ipc/windowIpc';

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

export interface SetupIpcOptions {
  setMinimizeToTray?: (enabled: boolean) => void;
  clientLogger?: ClientLogger;
  overlayManager?: OverlayManager;
  /** Call buttons on the Windows taskbar thumbnail; absent on other systems. */
  taskbarCallControls?: TaskbarCallControls | null;
  /** Graceful quit (leaves servers, stops the hosted server) used by logout. */
  quitApplication?: () => void;
}

/**
 * Everything the main window may ask Main, one module per domain (E-MAIN-4).
 * Each channel declares who may call it, and every channel and cleanup goes
 * away with the window, so a new window can register them again.
 */
export function setupIpcHandlers(
  mainWindow: BrowserWindow,
  serverManager: ServerManager,
  trayManager?: TrayManager,
  options?: SetupIpcOptions
): LocalExecutionIpc & { prepareShutdown(): Promise<void> } {
  logScreenAudioLoadFailure(options?.clientLogger);
  const overlayManager = options?.overlayManager || new OverlayManager(mainWindow);
  const registry = new IpcRegistry(ipcMain, {
    main: () => windowContents(mainWindow),
    overlay: () => overlayManager.contents(),
  });
  mainWindow.once('closed', () => registry.dispose());

  registerWindowIpc(registry, { window: mainWindow, pipWindows: new ScreenPictureInPictureWindows(mainWindow) });
  registerOverlayIpc(registry, overlayManager);
  registerShortcutsIpc(registry, mainWindow);
  registerIdentityIpc(registry, {
    window: mainWindow, sanitizeFileName: sanitizeDownloadFileName, quitApplication: options?.quitApplication,
  });
  registerHostedServerIpc(registry, serverManager);
  registerUpdaterIpc(registry, { window: mainWindow, getInventory: signal => serverManager.getUpdateInventory(signal) });

  let localTools: LocalTools | undefined;
  const localExecution = setupLocalExecutionIpc(mainWindow, (notifications) =>
    createLocalExecutionService(mainWindow, app.getPath('userData'), notifications, tools => { localTools = tools; }));

  // Presença de jogo (#675): só roda quando a pessoa liga nas configurações.
  const steamPresence = new SteamPresence(activity => registry.send('main', 'game-presence:changed', activity));
  registry.onDispose(() => steamPresence.stop());
  registerAppIpc(registry, {
    trayManager, taskbarCallControls: options?.taskbarCallControls, setMinimizeToTray: options?.setMinimizeToTray, steamPresence,
  });
  if (options?.clientLogger) registerClientLogIpc(registry, options.clientLogger);

  const isExcluded = (sourceId: string): boolean => overlayManager.isScreenShareSource(sourceId);
  const desktopSources = new DesktopSourceCatalog({
    nativeSources: windowsDesktopSources(isExcluded), isExcluded, logger: options?.clientLogger,
  });
  registerDesktopSourcesIpc(registry, {
    window: mainWindow, catalog: desktopSources, gameFolders: () => steamPresence.currentGameFolders(),
  });
  const nativeScreenSharing = registerNativeScreenSharingIpc(registry, {
    window: mainWindow, resolveSource: (sourceId, kind) => desktopSources.resolveTarget(sourceId, kind), logger: options?.clientLogger,
  });

  const mediaFolders = registerMediaFoldersIpc(registry, mainWindow);
  registerSoundboardIpc(registry, {
    window: mainWindow, folders: mediaFolders, localTools: () => localTools, sanitizeFileName: sanitizeDownloadFileName,
  });
  registerStickersIpc(registry, mainWindow, mediaFolders);
  registerFilesIpc(registry, mainWindow);
  registerEditorCommands(registry, mainWindow);
  registerEventCalendarIpc(registry, mainWindow, sanitizeDownloadFileName);
  registerHostingSkillIpc(registry, mainWindow);
  registerFileBatchDownloadIpc(registry, mainWindow, sanitizeDownloadFileName, async (file, destination) => {
    if ('url' in file) await downloadToFile(file.url, destination);
    else await writeDmAttachment(file.dm.peer, file.dm.messageId, file.dm.fileId, destination);
  });
  registerDmIpc(registry, mainWindow, sanitizeDownloadFileName);

  return {
    service: localExecution.service,
    freezeAdmissions: () => {
      desktopSources.freeze();
      localExecution.freezeAdmissions();
      nativeScreenSharing.freezeAdmissions();
    },
    prepareShutdown: async () => {
      localExecution.freezeAdmissions();
      await Promise.all([desktopSources.close(), nativeScreenSharing.prepareShutdown()]);
    },
    async dispose() {
      const results = await Promise.allSettled([desktopSources.close(), nativeScreenSharing.dispose(), localExecution.dispose()]);
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Application resource shutdown failed.');
    },
  };
}
