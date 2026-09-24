import { app, BrowserWindow, dialog, ipcMain, IpcMainEvent, Menu, screen, session, shell } from 'electron';
import path from 'path';
import { setupIpcHandlers } from './ipcHandlers';
import { setupUpdater } from './updater';
import {
  handleLaunchDuringUpdate,
  isInstallSplashActive,
  dismissInstallSplash,
  hasInstallSentinel,
  primeSimulatedInstallFinish,
  beginSimulatedFullInstall,
  beginRealNsisInstallTest,
} from './updateInstall';
import { updateLog } from './updateLog';
import { ServerManager } from './serverManager';
import { TrayManager } from './trayManager';
import { ClientLogger } from './clientLogger';
import { bindRendererDiagnostics } from './rendererDiagnostics';
import { OverlayManager } from './overlayManager';
import { HOME_MIN_HEIGHT, HOME_MIN_WIDTH } from './windowSizing';
import { bindBotScreenIsolation, installBotScreenRequestGuard, isBotScreenFrame, isBotScreenUrl } from './botScreenIsolation';
import { resolveDevelopmentProfile } from './developmentProfile';
import { bindDevelopmentQa, loadDevelopmentQa } from './developmentQa';
import { CrashRecovery } from './crashRecovery';
import { initializeMainLanguage, mt } from './i18n';
import { APP_SHUTDOWN_EVENT, APP_SHUTDOWN_IPC, type AppShutdownRequest, SERVER_INVITE_AVAILABLE, SERVER_INVITE_IPC, type ServerInviteResult } from '@monky/shared';
import { ServerInviteInbox } from './serverInvites';

import fs from 'fs';

const developmentQa = loadDevelopmentQa({
  packaged: app.isPackaged,
  appPath: app.getAppPath(),
  profile: app.commandLine.getSwitchValue('user-data-dir'),
  configFile: process.env.MONKY_QA_CONFIG,
  parentPid: process.ppid,
  supervised: typeof process.send === 'function',
});
if (developmentQa) {
  // Prepared QA never opens physical capture devices, including after unmute.
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  if (developmentQa.smoke) app.commandLine.appendSwitch('mute-audio');
}

const developmentProfile = resolveDevelopmentProfile({
  isPackaged: app.isPackaged,
  appPath: app.getAppPath(),
  appDataPath: app.getPath('appData'),
  explicitUserData: app.commandLine.getSwitchValue('user-data-dir'),
});
if (developmentProfile) {
  // Select the profile before creating services, Chromium sessions or the lock.
  fs.mkdirSync(developmentProfile.userData, { recursive: true });
  fs.mkdirSync(developmentProfile.sessionData, { recursive: true });
  app.setPath('userData', developmentProfile.userData);
  app.setPath('sessionData', developmentProfile.sessionData);
  process.env.MONKY_HOME = developmentProfile.cliHome;
}

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

/**
 * Makes full-screen sharing use Windows Graphics Capture instead of the legacy
 * DXGI/GDI capturer (#526).
 *
 * Chromium ships `AllowWgcWindowCapturer` enabled but `AllowWgcScreenCapturer`
 * disabled, so sharing a single window was already cheap while sharing a whole
 * monitor fell back to Desktop Duplication — which fights a full-screen game for
 * the GPU and cost roughly half the frame rate while playing. WGC composites on
 * the GPU and, with the zero-Hz mode, stops producing frames entirely when the
 * screen is not changing.
 *
 * WGC needs Windows 10 1809+; Chromium checks that itself and silently falls
 * back to the old capturer when unavailable. Set `MONKY_DISABLE_WGC=1` to force
 * the legacy path if a machine misbehaves (e.g. capturing inside an RDP
 * session, which WGC does not support).
 */
if (process.platform === 'win32' && process.env.MONKY_DISABLE_WGC !== '1') {
  app.commandLine.appendSwitch(
    'enable-features',
    'AllowWgcScreenCapturer,AllowWgcScreenZeroHz,AllowWgcWindowCapturer,AllowWgcWindowZeroHz'
  );
}

let mainWindow: BrowserWindow | null = null;
const serverInviteInbox = new ServerInviteInbox();
let overlayManager: OverlayManager | null = null;
let trayManager: TrayManager | null = null;
const serverManager = new ServerManager();
let clientLogger: ClientLogger | null = null;
let crashRecovery: CrashRecovery | null = null;
let isShuttingDown = false;
let isQuitting = false;
/** Whether the renderer has already been asked to leave the call (#458). */
let leaveAnnounced = false;
let localExecution: ReturnType<typeof setupIpcHandlers> | null = null;
let localExecutionStopping = false;
let localExecutionStopped = false;

function notifyServerInvite(): void {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(SERVER_INVITE_AVAILABLE);
  }
}

const onOpenInviteUrl = (event: Electron.Event, url: string): void => {
  if (!serverInviteInbox.receive(url)) return;
  event.preventDefault();
  notifyServerInvite();
  if (mainWindow && !mainWindow.isDestroyed() && !isInstallSplashActive()) {
    if (!mainWindow.isVisible()) mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
};
app.on('open-url', onOpenInviteUrl);
serverInviteInbox.receiveArguments(process.argv);
ipcMain.handle(SERVER_INVITE_IPC.take, (event: Electron.IpcMainInvokeEvent, ...args: unknown[]): ServerInviteResult | null => {
  const window = mainWindow;
  if (!window || window.isDestroyed() || event.sender !== window.webContents
    || event.senderFrame !== window.webContents.mainFrame || args.length !== 0) {
    console.warn('[Invites] Rejected an invitation read outside the main application frame.');
    throw new Error(mt('error.serverInviteUnavailable'));
  }
  return serverInviteInbox.take();
});
app.once('will-quit', () => {
  ipcMain.removeHandler(SERVER_INVITE_IPC.take);
  app.removeListener('open-url', onOpenInviteUrl);
});

/**
 * How long each renderer shutdown phase may retain the window.
 *
 * Native preparation retains signaling; farewell follows verified native
 * retirement. A missing acknowledgement must never authorize window closure.
 */
const LEAVE_ANNOUNCE_TIMEOUT_MS = 15000;

/**
 * Correlates each renderer phase independently, including retries (#458).
 *
 * Native controls quiesce before Main drains owners. Only the later farewell
 * disconnects sockets; an old native-phase acknowledgement cannot authorize it.
 */
function requestRendererShutdown(phase: AppShutdownRequest['phase']): Promise<void> {
  const window = mainWindow;
  if (!window || window.isDestroyed()) {
    return Promise.resolve();
  }
  const request: AppShutdownRequest = { requestId: ++shutdownRequestId, phase };
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      onLeaveComplete = null;
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error(`Renderer ${phase} did not acknowledge shutdown.`)), LEAVE_ANNOUNCE_TIMEOUT_MS);
    onLeaveComplete = acknowledgement => {
      if (typeof acknowledgement !== 'object' || acknowledgement === null
        || !('requestId' in acknowledgement) || acknowledgement.requestId !== request.requestId
        || !('phase' in acknowledgement) || acknowledgement.phase !== request.phase) {
        console.warn('[LocalExecution] Rejected an expired or mismatched shutdown acknowledgement.');
        return;
      }
      finish();
    };
    try { window.webContents.send(APP_SHUTDOWN_EVENT, request); }
    catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });
}

async function announceLeave(): Promise<void> {
  if (leaveAnnounced) return;
  await requestRendererShutdown('farewell');
  leaveAnnounced = true;
}

/** Set only while a quit is waiting for its exact renderer phase. */
let onLeaveComplete: ((request: unknown) => void) | null = null;
let shutdownRequestId = 0;
let rendererNativeRetired = false;

ipcMain.handle(APP_SHUTDOWN_IPC.acknowledge, (event, request: unknown) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents
    || event.senderFrame !== mainWindow.webContents.mainFrame)
    throw new Error('Shutdown acknowledgement belongs to a different renderer.');
  onLeaveComplete?.(request);
});

/**
 * Hands a URL to the OS only when it is a plain web link. Both guards below used
 * to forward whatever they were given, so a link with another scheme — file://,
 * or one of the Windows handlers that take arguments — would have been opened
 * by the system (#372). The `app:open-external` IPC channel already checked
 * this; the guards did not.
 */
function openExternalIfWebUrl(url: string): void {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
    void shell.openExternal(parsed.toString());
  } catch {
    // Not a URL we can make sense of: leaving it to the OS is the risk itself.
  }
}

function bindMainWindowNavigationGuards(): void {
  if (!mainWindow) return;
  bindBotScreenIsolation(mainWindow.webContents);

  mainWindow.webContents.setWindowOpenHandler(({ url, referrer }) => {
    if (!isBotScreenUrl(referrer.url)) openExternalIfWebUrl(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!mainWindow) return;
    if (isBotScreenFrame(event.initiator)) { event.preventDefault(); return; }
    if (url === mainWindow.webContents.getURL()) return;
    event.preventDefault();
    openExternalIfWebUrl(url);
  });
}

function shutdownServer(): void {
  if (isShuttingDown) return;
  isShuttingDown = true;
  serverManager.stopServer();
}

function quitApplication(): void {
  isQuitting = true;
  app.quit();
}

function getCrashRecovery(): CrashRecovery {
  if (!crashRecovery) {
    crashRecovery = new CrashRecovery({
      logger: () => clientLogger,
      isQuitting: () => isQuitting,
      quit: quitApplication,
      onRecovery: () => {
        leaveAnnounced = true;
        for (const cleanup of [
          () => overlayManager?.close(),
          () => { trayManager?.destroy(); trayManager = null; },
          () => dismissInstallSplash(),
        ]) {
          try { cleanup(); } catch (error: unknown) {
            console.error('[CrashRecovery] Auxiliary-window cleanup failed', error);
          }
        }
      },
    });
  }
  return crashRecovery;
}

function stopLocalExecutionThenQuit(): void {
  if (!localExecution || localExecutionStopping) return;
  localExecutionStopping = true;
  const owner = localExecution;
  owner.freezeAdmissions();
  void (async () => {
    if (!rendererNativeRetired) {
      await requestRendererShutdown('native');
      rendererNativeRetired = true;
    }
    await owner.prepareShutdown();
    await announceLeave();
    await owner.dispose();
  })().then(() => {
    localExecutionStopping = false;
    localExecutionStopped = true;
    app.quit();
  }, (error: unknown) => {
    console.error('[LocalExecution] Could not finish local task shutdown:', error);
    isQuitting = false;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
    void Promise.resolve().then(() => dialog.showMessageBox({
      type: 'error',
      title: mt('localExecution.shutdownFailedTitle'),
      message: mt('localExecution.shutdownFailedMessage'),
      buttons: [mt('localExecution.retryShutdown'), mt('localExecution.keepOpen')],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    })).then(({ response }) => {
      localExecutionStopping = false;
      if (response === 0) quitApplication();
      else { isQuitting = false; }
    }).catch((dialogError: unknown) => {
      localExecutionStopping = false;
      isQuitting = false;
      console.error('[LocalExecution] Could not display the shutdown error:', dialogError);
    });
  });
}

function createWindow(deferShow = false): void {
  const iconCandidates = [
    path.join(__dirname, '../../build/icon.ico'),
    path.join(__dirname, '../../build/icon.png'),
    path.join(__dirname, '../../images/Logo.png'),
    path.join(__dirname, '../../src/renderer/assets/Logo.png'),
    path.join(app.getAppPath(), 'build/icon.ico'),
    path.join(app.getAppPath(), 'build/icon.png'),
    path.join(app.getAppPath(), 'images/Logo.png'),
  ];
  const iconPath = iconCandidates.find((p) => fs.existsSync(p));

  const isMac = process.platform === 'darwin';

  const { width: screenW } = screen.getPrimaryDisplay().workAreaSize;
  const winWidth = Math.min(700, Math.round(screenW * 0.85));

  mainWindow = new BrowserWindow({
    width: winWidth,
    height: 950,
    minWidth: HOME_MIN_WIDTH,
    minHeight: HOME_MIN_HEIGHT,
    backgroundColor: '#0e1117',
    // Right after an update install the window is held back (show: false) and
    // only revealed once it has painted, so the "finishing" splash hands off to
    // a fully-drawn UI with no dark gap in between (#498).
    show: !deferShow && !developmentQa?.smoke,
    // Windows/Linux: fully frameless (custom title bar in the renderer).
    // macOS: keep the native traffic-light buttons but hide the title bar.
    frame: isMac,
    titleBarStyle: isMac ? 'hidden' : 'default',
    trafficLightPosition: isMac ? { x: 14, y: 12 } : undefined,
    title: developmentProfile ? 'Monky Dev' : 'Monky',
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      sandbox: false, // needed for custom desktopCapturer / preload access
      webSecurity: true,
      backgroundThrottling: false, // Keep audio and WebRTC processing smoothly when minimized/hidden
      offscreen: developmentQa?.smoke === true,
      additionalArguments: developmentQa ? ['--monky-prepared-qa'] : [],
    },
  });

  getCrashRecovery().watch(mainWindow);
  const disposeQa = bindDevelopmentQa(mainWindow, developmentQa, quitApplication);
  mainWindow.once('closed', disposeQa);

  if (developmentProfile) {
    const window = mainWindow;
    window.on('page-title-updated', (event) => {
      event.preventDefault();
      window.setTitle('Monky Dev');
    });
  }

  if (!trayManager) {
    trayManager = new TrayManager(mainWindow, quitApplication);
  }

  if (!overlayManager) {
    overlayManager = new OverlayManager(mainWindow);
  } else {
    overlayManager.setMainWindow(mainWindow);
  }

  let minimizeToTray = !developmentQa;

  clientLogger = new ClientLogger();
  clientLogger.write({
    timestamp: new Date().toISOString(),
    level: 'INFO',
    category: 'APP',
    message: `Application started — version ${app.getVersion()}, platform ${process.platform} ${process.arch}`,
  });
  bindRendererDiagnostics(mainWindow.webContents, clientLogger);

  localExecution = setupIpcHandlers(mainWindow, serverManager, trayManager, {
    setMinimizeToTray: (enabled: boolean) => {
      minimizeToTray = enabled;
    },
    clientLogger,
    overlayManager,
  });
  localExecutionStopped = false;
  rendererNativeRetired = false;
  setupUpdater(mainWindow);

  // A launch straight after an update install keeps the "finishing" splash up
  // while this fresh process cold-starts. Hold the main window back until the
  // renderer says its real UI has painted, then reveal it and drop the splash
  // together, so the splash only disappears as Monky actually opens (#498). A
  // fallback timer guarantees a slow or missing signal never strands the window
  // behind it.
  if (deferShow) {
    const window = mainWindow;
    let revealed = false;
    let onRendererReady: ((event: IpcMainEvent) => void) | null = null;
    let revealTimer: ReturnType<typeof setTimeout> | null = null;
    let dismissTimer: ReturnType<typeof setTimeout> | null = null;
    const cleanupReveal = (): void => {
      if (revealTimer) clearTimeout(revealTimer);
      if (dismissTimer) clearTimeout(dismissTimer);
      if (onRendererReady) ipcMain.removeListener('app:renderer-ready', onRendererReady);
      revealTimer = null;
      dismissTimer = null;
      onRendererReady = null;
    };
    window.once('closed', cleanupReveal);
    const reveal = (reason: string): void => {
      if (revealed) return;
      revealed = true;
      cleanupReveal();
      updateLog('reveal main window after update', { reason });
      if (!window.isDestroyed() && !window.isVisible()) {
        window.show();
        window.focus();
      }
      dismissTimer = setTimeout(() => dismissInstallSplash(), 80);
    };
    // Primary trigger: the renderer signals once its real UI has painted. The
    // old `ready-to-show` trigger fired at the blank first paint (a dark
    // rectangle still loading the bundle), which is exactly why the splash
    // vanished seconds before Monky appeared (#498).
    onRendererReady = (event: IpcMainEvent): void => {
      if (!window.isDestroyed() && event.sender === window.webContents) {
        reveal('renderer-ready');
      }
    };
    ipcMain.on('app:renderer-ready', onRendererReady);
    // Fallback: never leave the window stranded behind the splash if the signal
    // never arrives (renderer crash, load failure, …).
    revealTimer = setTimeout(() => reveal('timeout'), 20000);
  }

  // In dev, load Vite dev server if running, otherwise load dist/index.html
  const onPageLoadFailed = (error: unknown): void => {
    if (error && typeof error === 'object'
      && (('code' in error && error.code === 'ERR_ABORTED') || ('errno' in error && error.errno === -3))) return;
    getCrashRecovery().show({ kind: 'document-load' });
  };
  if (process.env.VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL).catch(onPageLoadFailed);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../../dist/index.html')).catch(onPageLoadFailed);
  }

  // Atalho de desenvolvimento: F12 ou Ctrl+Shift+I para alternar DevTools
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) {
      mainWindow?.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  // Minimize to tray on close instead of quitting the application (#149, #256)
  mainWindow.on('close', (event) => {
    if (developmentQa && !isQuitting) {
      event.preventDefault();
      quitApplication();
      return;
    }
    if (!isQuitting) {
      if (minimizeToTray) {
        event.preventDefault();
        mainWindow?.hide();
        return;
      }
      // The renderer has to stay alive long enough to leave the call (#458), so
      // the window is kept open and the quit drives the teardown instead.
      event.preventDefault();
      quitApplication();
      return;
    }

    // Tray/menu close must also preserve the renderer through every retirement phase.
    if (!leaveAnnounced || (localExecution && !localExecutionStopped)) {
      event.preventDefault();
      quitApplication();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Windows groups taskbar buttons by AppUserModelID. The NSIS installer stamps the
// shortcuts with `appId`, so the running process must declare the very same id --
// otherwise Windows sees the live window as a different app and the pinned icon
// stops matching it after every update (#323).
if (process.platform === 'win32') {
  app.setAppUserModelId(developmentProfile?.appUserModelId ?? 'com.monky.app');
}

// Keep one instance per profile; development never shares the installed profile.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    if (serverInviteInbox.receiveArguments(commandLine)) notifyServerInvite();
    if (crashRecovery?.focus()) return;
    if (mainWindow) {
      if (!mainWindow.isVisible()) mainWindow.show();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    initializeMainLanguage(app.getPath('userData'), app.getPreferredSystemLanguages());
    getCrashRecovery();
    // TEST-ONLY (Bancada A): simulate the update install UX without a real
    // download or NSIS run. Gated entirely on MONKY_SIM_UPDATE, so a normal
    // launch never reaches it. `full` shows the installing splash then
    // relaunches into the finishing splash; `finish` jumps straight to the
    // finishing splash. See docs at the bottom of updateInstall.ts.
    const sim = process.env.MONKY_SIM_UPDATE;
    if (sim === 'full' && !hasInstallSentinel()) {
      beginSimulatedFullInstall();
      return;
    }
    // `nsis` runs a REAL (isolated) installer to reproduce the actual NSIS gap
    // the `full` simulation skips — used by scripts/test-update-local.ps1 to
    // watch the update UX end to end without publishing a beta.
    if (sim === 'nsis' && !hasInstallSentinel()) {
      const installerPath = process.env.MONKY_SIM_INSTALLER;
      if (installerPath && fs.existsSync(installerPath)) {
        beginRealNsisInstallTest(installerPath, process.env.MONKY_SIM_TARGET || app.getVersion());
        return;
      }
      updateLog('SIM(nsis): installer missing, skipping', { installerPath });
    }
    if (sim === 'finish' && !hasInstallSentinel()) {
      primeSimulatedInstallFinish();
    }

    // A launch that lands in the middle of an install must not build a second
    // UI on top of a half-replaced installation: show what is going on and bow
    // out instead (#498).
    if (handleLaunchDuringUpdate()) {
      return;
    }

    // Remove the default application menu (File / Edit / View ...).
    Menu.setApplicationMenu(null);

    // Fix YouTube/Spotify embed iframes: set a valid Referer header so
    // external embed providers don't reject requests from file:// origins (#237).
    session.defaultSession.webRequest.onBeforeSendHeaders(
      { urls: ['https://*.youtube.com/*', 'https://*.youtube-nocookie.com/*', 'https://*.googlevideo.com/*', 'https://*.spotify.com/*'] },
      (details, callback) => {
        const headers = { ...details.requestHeaders };
        headers['Referer'] = 'https://www.youtube.com/';
        headers['Origin'] = 'https://www.youtube.com';
        callback({ requestHeaders: headers });
      }
    );

    // Allow media/DRM permissions required by embedded players.
    installBotScreenRequestGuard(session.defaultSession);
    session.defaultSession.setPermissionCheckHandler((_contents, permission, origin, details) => {
      const allowed = ['media', 'mediaKeySystem', 'fullscreen', 'clipboard-read', 'clipboard-sanitized-write'];
      return allowed.includes(permission) &&
        !(isBotScreenUrl(details.requestingUrl ?? '') || (!details.isMainFrame && (!origin || origin === 'null')));
    });
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
      const allowed = ['media', 'mediaKeySystem', 'fullscreen', 'clipboard-read', 'clipboard-sanitized-write'];
      callback(!isBotScreenUrl(details.requestingUrl) && allowed.includes(permission));
    });

    createWindow(isInstallSplashActive());
    bindMainWindowNavigationGuards();

    app.on('activate', () => {
      if (crashRecovery?.focus()) return;
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
        bindMainWindowNavigationGuards();
      } else if (mainWindow) {
        if (!mainWindow.isVisible()) mainWindow.show();
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
    });
  }).catch((error: unknown) => {
    getCrashRecovery().show({
      kind: 'main-bootstrap',
      ...(error instanceof Error ? { error: { name: error.name, stack: error.stack } } : {}),
    });
  });
}

app.on('window-all-closed', () => {
  if (crashRecovery?.isActive() && !isQuitting) return;
  shutdownServer();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', (event) => {
  isQuitting = true;

  if (localExecution && !localExecutionStopped) {
    event.preventDefault();
    stopLocalExecutionThenQuit();
    return;
  }

  if (!leaveAnnounced && mainWindow && !mainWindow.isDestroyed()) {
    event.preventDefault();
    void announceLeave().then(() => app.quit(), error => {
      isQuitting = false;
      console.error('[LocalExecution] Could not announce application shutdown:', error);
    });
    return;
  }

  crashRecovery?.dispose();
  clientLogger?.shutdown();
  shutdownServer();
  trayManager?.destroy();
  overlayManager?.close();
});
