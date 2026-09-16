import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import type { IpcMainInvokeEvent, RenderProcessGoneDetails } from 'electron';
import path from 'path';
import { BUG_REPORT_URL, CRASH_RECOVERY_IPC } from '@monky/shared';
import type { CrashRecoveryActionResult } from '@monky/shared';
import type { ClientLogger } from './clientLogger';
import {
  createCrashDiagnostic, formatCrashDiagnostic, parseBootstrapFailure,
  type CrashDiagnostic, type FatalFailure,
} from './crashDiagnostics';
import { buildCrashRecoveryPage, CRASH_RECOVERY_COLORS } from './crashRecoveryPage';
import { mt } from './i18n';

export const BOOTSTRAP_TIMEOUT_MS = 45000;
const RECOVERY_TIMEOUT_MS = 10000;

interface CrashRecoveryOptions {
  logger: () => Pick<ClientLogger, 'write'> | null;
  isQuitting: () => boolean;
  onRecovery: () => void;
  quit: () => void;
}

/**
 * One recovery surface per process. It never reloads the broken bundle, creates
 * a renderer-recovery loop, or restarts without the user's explicit action.
 */
export class CrashRecovery {
  private mainWindow: BrowserWindow | null = null;
  private recoveryWindow: BrowserWindow | null = null;
  private recoveryUrl = '';
  private diagnostic: CrashDiagnostic | null = null;
  private bootstrapTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private unbindMain: (() => void) | null = null;
  private unbindRecovery: (() => void) | null = null;
  private disposed = false;
  private nativeFallback = false;
  private restarting = false;
  private reporting = false;

  constructor(private readonly options: CrashRecoveryOptions) {
    ipcMain.handle(CRASH_RECOVERY_IPC.bootstrapFailed, (event, input: unknown, ...extra: unknown[]): boolean => {
      if (extra.length || !this.ownsMain(event)) return false;
      const failure = parseBootstrapFailure(input);
      if (!failure) return false;
      return this.show({
        kind: 'renderer-bootstrap', reason: failure.phase,
        error: { name: failure.errorName, stack: failure.stack },
      });
    });
    ipcMain.handle(CRASH_RECOVERY_IPC.ready, (event, ...args: unknown[]): boolean => {
      if (args.length || this.disposed) return false;
      if (!this.diagnostic && this.ownsMain(event)) {
        this.clearBootstrapTimer();
        return true;
      }
      if (!this.ownsRecovery(event) || !this.recoveryWindow) return false;
      this.clearRecoveryTimer();
      this.recoveryWindow.show();
      this.recoveryWindow.focus();
      return true;
    });
    ipcMain.handle(CRASH_RECOVERY_IPC.report, (event, ...args: unknown[]): Promise<CrashRecoveryActionResult> =>
      !args.length && this.ownsRecovery(event) ? this.report() : Promise.resolve({ ok: false, reason: 'unavailable' }));
    ipcMain.handle(CRASH_RECOVERY_IPC.copy, (event, ...args: unknown[]): CrashRecoveryActionResult =>
      !args.length && this.ownsRecovery(event) ? this.copy() : { ok: false, reason: 'unavailable' });
    ipcMain.handle(CRASH_RECOVERY_IPC.reopen, (event, ...args: unknown[]): CrashRecoveryActionResult =>
      !args.length && this.ownsRecovery(event) ? this.reopen() : { ok: false, reason: 'unavailable' });
    ipcMain.handle(CRASH_RECOVERY_IPC.close, (event, ...args: unknown[]): boolean => {
      if (args.length || !this.ownsRecovery(event)) return false;
      this.options.quit();
      return true;
    });
  }

  private ownsMain(event: IpcMainInvokeEvent): boolean {
    return !this.disposed && !!this.mainWindow && !this.mainWindow.isDestroyed()
      && event.sender === this.mainWindow.webContents
      && event.senderFrame === this.mainWindow.webContents.mainFrame;
  }

  private ownsRecovery(event: IpcMainInvokeEvent): boolean {
    return !this.disposed && !this.nativeFallback && !!this.recoveryWindow && !this.recoveryWindow.isDestroyed()
      && event.sender === this.recoveryWindow.webContents
      && event.senderFrame === this.recoveryWindow.webContents.mainFrame
      && event.senderFrame?.url === this.recoveryUrl;
  }

  public watch(window: BrowserWindow): void {
    if (this.disposed || this.diagnostic) return;
    this.unbindMain?.();
    this.clearBootstrapTimer();
    this.mainWindow = window;
    const contents = window.webContents;
    const gone = (_event: Electron.Event, details: RenderProcessGoneDetails): void => {
      if (details.reason !== 'clean-exit') {
        this.show({ kind: 'renderer-gone', reason: details.reason, code: details.exitCode });
      }
    };
    const failedLoad = (_event: Electron.Event, code: number, _description: string, _url: string, mainFrame: boolean): void => {
      if (mainFrame && code !== -3) this.show({ kind: 'document-load', code });
    };
    const preloadError = (_event: Electron.Event, _preload: string, error: Error): void => {
      this.show({ kind: 'preload', error });
    };
    const navigation = (_event: Electron.Event, _url: string, inPage: boolean, mainFrame: boolean): void => {
      if (mainFrame && !inPage && !this.diagnostic) this.armBootstrapTimer();
    };
    const destroyed = (): void => {
      this.clearBootstrapTimer();
      this.unbindMain?.();
      this.mainWindow = null;
    };
    contents.on('render-process-gone', gone);
    contents.on('did-fail-load', failedLoad);
    contents.on('preload-error', preloadError);
    contents.on('did-start-navigation', navigation);
    contents.once('destroyed', destroyed);
    this.unbindMain = () => {
      contents.removeListener('render-process-gone', gone);
      contents.removeListener('did-fail-load', failedLoad);
      contents.removeListener('preload-error', preloadError);
      contents.removeListener('did-start-navigation', navigation);
      contents.removeListener('destroyed', destroyed);
      this.unbindMain = null;
    };
    // Covers missing/syntactically broken JS modules as well as stalled startup.
    // Onboarding signals readiness before waiting for any user input.
    this.armBootstrapTimer();
  }

  public isActive(): boolean {
    return this.diagnostic !== null && !this.disposed;
  }

  public focus(): boolean {
    if (!this.isActive()) return false;
    if (this.recoveryWindow && !this.recoveryWindow.isDestroyed()) {
      if (this.recoveryWindow.isMinimized()) this.recoveryWindow.restore();
      this.recoveryWindow.show();
      this.recoveryWindow.focus();
    }
    return true;
  }

  public show(failure: FatalFailure): boolean {
    if (this.disposed || this.diagnostic || this.options.isQuitting()) return false;
    this.clearBootstrapTimer();
    this.diagnostic = createCrashDiagnostic(failure, app.getVersion());
    try {
      this.options.logger()?.write({
        timestamp: this.diagnostic.occurredAt,
        level: 'ERROR',
        category: 'APP',
        message: 'Fatal application failure — recovery screen',
        data: { ...this.diagnostic },
      });
    } catch (error: unknown) {
      console.error('[CrashRecovery] Could not write the diagnostic log', error);
    }
    try {
      this.options.onRecovery();
    } catch (error: unknown) {
      console.error('[CrashRecovery] Could not finish auxiliary-window cleanup', error);
    }
    const brokenWindow = this.mainWindow;
    try {
      const isMac = process.platform === 'darwin';
      const window = new BrowserWindow({
        width: 640, height: 600, minWidth: 440, minHeight: 500,
        title: `Monky — ${mt('crash.nativeTitle')}`,
        backgroundColor: CRASH_RECOVERY_COLORS.background, show: false, autoHideMenuBar: true,
        // Native caption controls remain usable even if the recovery preload stalls.
        titleBarStyle: 'hidden',
        trafficLightPosition: isMac ? { x: 14, y: 12 } : undefined,
        titleBarOverlay: isMac ? undefined : {
          color: CRASH_RECOVERY_COLORS.titlebar,
          symbolColor: CRASH_RECOVERY_COLORS.controls,
          height: 32,
        },
        webPreferences: {
          preload: path.join(__dirname, '../preload/crashRecoveryPreload.js'),
          contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false,
          sandbox: false, // The isolated preload imports only Electron and shared contracts.
          webSecurity: true,
          partition: 'monky-crash-recovery',
        },
      });
      this.recoveryWindow = window;
      const contents = window.webContents;
      this.recoveryUrl = `data:text/html;charset=utf-8;base64,${Buffer.from(buildCrashRecoveryPage(this.diagnostic)).toString('base64')}`;
      const fallback = (): void => { void this.showNativeFallback(); };
      const failLoad = (_event: Electron.Event, code: number, _description: string, _url: string, mainFrame: boolean): void => {
        if (mainFrame && code !== -3) fallback();
      };
      const preventNavigation = (event: Electron.Event): void => event.preventDefault();
      const closed = (): void => {
        this.clearRecoveryTimer();
        this.unbindRecovery?.();
        this.recoveryWindow = null;
        if (!this.disposed && !this.nativeFallback && !this.restarting) this.options.quit();
      };
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      contents.on('will-navigate', preventNavigation);
      contents.on('will-attach-webview', preventNavigation);
      contents.on('render-process-gone', fallback);
      contents.on('preload-error', fallback);
      contents.on('did-fail-load', failLoad);
      window.once('closed', closed);
      this.unbindRecovery = () => {
        contents.removeListener('will-navigate', preventNavigation);
        contents.removeListener('will-attach-webview', preventNavigation);
        contents.removeListener('render-process-gone', fallback);
        contents.removeListener('preload-error', fallback);
        contents.removeListener('did-fail-load', failLoad);
        window.removeListener('closed', closed);
        this.unbindRecovery = null;
      };
      this.recoveryTimer = setTimeout(fallback, RECOVERY_TIMEOUT_MS);
      this.recoveryTimer.unref();
      void window.loadURL(this.recoveryUrl).catch(fallback);
      // A new WebContents already exists before retiring the old one, so the
      // application is not accidentally quit by window-all-closed.
      if (brokenWindow && !brokenWindow.isDestroyed()) brokenWindow.destroy();
    } catch (error: unknown) {
      console.error('[CrashRecovery] Could not create the recovery window', error);
      if (brokenWindow && !brokenWindow.isDestroyed()) brokenWindow.destroy();
      void this.showNativeFallback();
    }
    return true;
  }

  private copy(): CrashRecoveryActionResult {
    if (!this.diagnostic || this.disposed) return { ok: false, reason: 'unavailable' };
    try {
      clipboard.writeText(formatCrashDiagnostic(this.diagnostic));
      return { ok: true, copied: true };
    } catch {
      return { ok: false, reason: 'copy-failed' };
    }
  }

  private async report(): Promise<CrashRecoveryActionResult> {
    if (!this.diagnostic || this.disposed || this.reporting) return { ok: false, reason: 'unavailable' };
    this.reporting = true;
    const copied = this.copy().ok;
    try {
      // Keep diagnostics local until the user pastes and publishes the report.
      await shell.openExternal(BUG_REPORT_URL);
      return { ok: true, copied };
    } catch {
      return { ok: false, reason: 'open-failed', copied };
    } finally {
      this.reporting = false;
    }
  }

  private reopen(): CrashRecoveryActionResult {
    if (!this.diagnostic || this.disposed || this.restarting) return { ok: false, reason: 'unavailable' };
    this.restarting = true;
    try {
      app.relaunch();
      this.options.quit();
      return { ok: true };
    } catch {
      this.restarting = false;
      return { ok: false, reason: 'restart-failed' };
    }
  }

  private async showNativeFallback(): Promise<void> {
    if (this.disposed || this.nativeFallback || this.options.isQuitting() || !this.diagnostic) return;
    this.nativeFallback = true;
    this.clearRecoveryTimer();
    if (this.recoveryWindow && !this.recoveryWindow.isDestroyed()) this.recoveryWindow.destroy();
    const detail = `${mt('crash.nativePrivacy')}\n\n${formatCrashDiagnostic(this.diagnostic)}`;
    try {
      const choice = await dialog.showMessageBox({
        type: 'error', title: mt('crash.nativeTitle'), message: mt('crash.nativeDescription'), detail,
        buttons: [mt('crash.report'), mt('crash.reopen'), mt('crash.close')],
        defaultId: 0, cancelId: 2, noLink: true,
      });
      if (this.disposed || this.options.isQuitting()) return;
      if (choice.response === 1) {
        this.finishNativeRestart();
      } else if (choice.response === 0) {
        const reported = await this.report();
        if (this.disposed || this.options.isQuitting()) return;
        // One final explicit choice, not an automatic retry of a dead renderer.
        const next = await dialog.showMessageBox({
          type: 'info', title: mt('crash.nativeTitle'),
          message: reported.ok
            ? mt(reported.copied ? 'crash.reportOpened' : 'crash.reportOpenedNoCopy')
            : mt(reported.copied ? 'crash.reportFailed' : 'crash.actionFailed'),
          detail, buttons: [mt('crash.reopen'), mt('crash.close')], defaultId: 1, cancelId: 1, noLink: true,
        });
        if (this.disposed || this.options.isQuitting()) return;
        if (next.response === 0) this.finishNativeRestart();
        else this.options.quit();
      } else {
        this.options.quit();
      }
    } catch (error: unknown) {
      console.error('[CrashRecovery] Could not complete native recovery', error);
      try {
        dialog.showErrorBox(mt('crash.nativeTitle'), `${mt('crash.restartFailed')}\n\n${detail}`);
      } catch (dialogError: unknown) {
        console.error('[CrashRecovery] Native error dialog is unavailable', dialogError);
      }
      this.options.quit();
    }
  }

  private finishNativeRestart(): void {
    if (this.reopen().ok) return;
    dialog.showErrorBox(mt('crash.nativeTitle'), mt('crash.restartFailed'));
    this.options.quit();
  }

  private clearBootstrapTimer(): void {
    if (this.bootstrapTimer) clearTimeout(this.bootstrapTimer);
    this.bootstrapTimer = null;
  }

  private armBootstrapTimer(): void {
    this.clearBootstrapTimer();
    this.bootstrapTimer = setTimeout(() => this.show({ kind: 'bootstrap-timeout' }), BOOTSTRAP_TIMEOUT_MS);
    this.bootstrapTimer.unref();
  }

  private clearRecoveryTimer(): void {
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearBootstrapTimer();
    this.clearRecoveryTimer();
    this.unbindMain?.();
    this.unbindRecovery?.();
    for (const channel of Object.values(CRASH_RECOVERY_IPC)) ipcMain.removeHandler(channel);
    if (this.recoveryWindow && !this.recoveryWindow.isDestroyed()) this.recoveryWindow.destroy();
    this.recoveryWindow = null;
    this.mainWindow = null;
  }
}
