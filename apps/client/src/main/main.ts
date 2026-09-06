import { app, BrowserWindow, ipcMain, IpcMainEvent, Menu, screen, session, shell } from 'electron';
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
import { OverlayManager } from './overlayManager';
import { HOME_MIN_HEIGHT, HOME_MIN_WIDTH } from './windowSizing';

import fs from 'fs';

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
let overlayManager: OverlayManager | null = null;
let trayManager: TrayManager | null = null;
const serverManager = new ServerManager();
let clientLogger: ClientLogger | null = null;
let isShuttingDown = false;
let isQuitting = false;
/** Whether the renderer has already been asked to leave the call (#458). */
let leaveAnnounced = false;

/**
 * How long the quit waits for the renderer to say goodbye to the servers.
 *
 * It only has to cover sending a frame on an already open socket, so the ack
 * normally arrives in a few milliseconds; this bound just guarantees that a
 * renderer which is wedged cannot hold the app open.
 */
const LEAVE_ANNOUNCE_TIMEOUT_MS = 1000;

/**
 * Asks the renderer to leave every call and disconnect before the process dies,
 * then quits (#458).
 *
 * Without this, closing the app just dropped the WebSocket: the server could not
 * tell that apart from a network blip, so the person stayed listed in the voice
 * channel and nobody heard them leave. Telling the server explicitly makes the
 * departure immediate and deliberate. A crash obviously cannot run this — that
 * case is covered on the server, which now takes a session out of voice as soon
 * as its socket dies.
 */
function announceLeaveThenQuit(): void {
  if (leaveAnnounced) {
    app.quit();
    return;
  }
  leaveAnnounced = true;

  if (!mainWindow || mainWindow.isDestroyed()) {
    app.quit();
    return;
  }

  let settled = false;
  const finish = (): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    onLeaveComplete = null;
    app.quit();
  };

  const timer = setTimeout(finish, LEAVE_ANNOUNCE_TIMEOUT_MS);
  onLeaveComplete = finish;
  mainWindow.webContents.send('app:before-quit');
}

/** Set only while a quit is waiting for the renderer's goodbye. */
let onLeaveComplete: (() => void) | null = null;

ipcMain.handle('app:leave-complete', () => {
  onLeaveComplete?.();
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

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfWebUrl(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!mainWindow) return;
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
    show: !deferShow,
    // Windows/Linux: fully frameless (custom title bar in the renderer).
    // macOS: keep the native traffic-light buttons but hide the title bar.
    frame: isMac,
    titleBarStyle: isMac ? 'hidden' : 'default',
    trafficLightPosition: isMac ? { x: 14, y: 12 } : undefined,
    title: 'Monky',
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // needed for custom desktopCapturer / preload access
      webSecurity: true,
      backgroundThrottling: false, // Keep audio and WebRTC processing smoothly when minimized/hidden
    },
  });

  if (!trayManager) {
    trayManager = new TrayManager(mainWindow, quitApplication);
  }

  if (!overlayManager) {
    overlayManager = new OverlayManager(mainWindow);
  } else {
    overlayManager.setMainWindow(mainWindow);
  }

  let minimizeToTray = true;

  clientLogger = new ClientLogger();
  clientLogger.write({
    timestamp: new Date().toISOString(),
    level: 'INFO',
    category: 'APP',
    message: `Application started — version ${app.getVersion()}, platform ${process.platform} ${process.arch}`,
  });

  setupIpcHandlers(mainWindow, serverManager, trayManager, {
    setMinimizeToTray: (enabled: boolean) => {
      minimizeToTray = enabled;
    },
    clientLogger,
    overlayManager,
  });
  setupUpdater(mainWindow);

  // A launch straight after an update install keeps the "finishing" splash up
  // while this fresh process cold-starts. Hold the main window back until the
  // renderer says its real UI has painted, then reveal it and drop the splash
  // together, so the splash only disappears as Monky actually opens (#498). A
  // fallback timer guarantees a slow or missing signal never strands the window
  // behind it.
  if (deferShow) {
    let revealed = false;
    let onRendererReady: ((event: IpcMainEvent) => void) | null = null;
    const reveal = (reason: string): void => {
      if (revealed) return;
      revealed = true;
      updateLog('reveal main window after update', { reason });
      if (onRendererReady) {
        ipcMain.removeListener('app:renderer-ready', onRendererReady);
        onRendererReady = null;
      }
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
        mainWindow.show();
        mainWindow.focus();
      }
      setTimeout(() => dismissInstallSplash(), 80);
    };
    // Primary trigger: the renderer signals once its real UI has painted. The
    // old `ready-to-show` trigger fired at the blank first paint (a dark
    // rectangle still loading the bundle), which is exactly why the splash
    // vanished seconds before Monky appeared (#498).
    onRendererReady = (event: IpcMainEvent): void => {
      if (mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents) {
        reveal('renderer-ready');
      }
    };
    ipcMain.on('app:renderer-ready', onRendererReady);
    // Fallback: never leave the window stranded behind the splash if the signal
    // never arrives (renderer crash, load failure, …).
    setTimeout(() => reveal('timeout'), 20000);
  }

  // In dev, load Vite dev server if running, otherwise load dist/index.html
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'));
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

    // Quitting from the tray or the menu: same rule, the goodbye needs a live
    // renderer. Once it has been sent, the window is free to go.
    if (!leaveAnnounced) {
      event.preventDefault();
      announceLeaveThenQuit();
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
  app.setAppUserModelId('com.monky.app');
}

// Only allow a single running instance. If a second instance is launched,
// focus the window of the instance that is already running instead of
// opening a new one (option 1 from #154).
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (!mainWindow.isVisible()) mainWindow.show();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
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
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
      const allowed = ['media', 'mediaKeySystem', 'fullscreen', 'clipboard-read', 'clipboard-sanitized-write'];
      callback(allowed.includes(permission));
    });

    createWindow(isInstallSplashActive());
    bindMainWindowNavigationGuards();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
        bindMainWindowNavigationGuards();
      } else if (mainWindow) {
        if (!mainWindow.isVisible()) mainWindow.show();
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
    });
  });
}

app.on('window-all-closed', () => {
  shutdownServer();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', (event) => {
  isQuitting = true;

  // Say goodbye to the servers while the renderer is still alive, then quit for
  // real on the second pass (#458).
  if (!leaveAnnounced && mainWindow && !mainWindow.isDestroyed()) {
    event.preventDefault();
    announceLeaveThenQuit();
    return;
  }

  clientLogger?.shutdown();
  shutdownServer();
  trayManager?.destroy();
  overlayManager?.close();
});
