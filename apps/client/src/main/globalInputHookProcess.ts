import { utilityProcess, type BrowserWindow, type UtilityProcess } from 'electron';
import path from 'path';
import { globalInputHook as localInputHook } from './globalInputHook';
import type { ShortcutCommand, ShortcutConfiguration, ShortcutOperation, ShortcutWorkerMessage, ShortcutWorkerRequest } from './shortcutWorkerProtocol';

const RESPONSE_TIMEOUT_MS = 10_000;

/**
 * Chromium's WebRTC keyboard monitor hides focused-window input from a hook in
 * the browser process (SnosMe/uiohook-napi#54). Keep the single passive observer outside
 * that process; renderer focus never selects a second matching/event path.
 */
export class GlobalInputHookProcess {
  private mainWindow: BrowserWindow | null = null;
  private child: UtilityProcess | null = null;
  private ready: Promise<boolean> | null = null;
  private resolveReady: ((ok: boolean) => void) | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private nextId = 0;
  private readonly pending = new Map<number, {
    resolve: (ok: boolean) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private retained: ShortcutConfiguration | null = null;

  public init(mainWindow: BrowserWindow): void {
    this.mainWindow = mainWindow;
    void this.ensureWorker();
  }

  private send(child: UtilityProcess, message: ShortcutWorkerRequest): void {
    child.postMessage(message);
  }

  private ensureWorker(): Promise<boolean> {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return Promise.resolve(false);
    if (this.ready) return this.ready;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.ready = new Promise((resolve) => { this.resolveReady = resolve; });
    const ready = this.ready;
    try {
      const child = utilityProcess.fork(path.join(__dirname, 'shortcutWorker.js'), [], {
        serviceName: 'Monky passive shortcuts',
        stdio: 'inherit',
      });
      this.child = child;
      this.startupTimer = setTimeout(() => {
        console.warn('[GlobalInputHook] Shortcut worker startup timed out.');
        this.workerStopped(child);
        child.kill();
      }, RESPONSE_TIMEOUT_MS);
      this.startupTimer.unref();
      child.on('spawn', () => {
        if (this.child === child) this.send(child, { type: 'init', configuration: this.retained });
      });
      child.on('message', (message: ShortcutWorkerMessage) => {
        if (this.child !== child) return;
        if (message.type === 'ready') {
          if (this.startupTimer) clearTimeout(this.startupTimer);
          this.startupTimer = null;
          this.resolveReady?.(true);
          this.resolveReady = null;
        } else if (message.type === 'event') {
          if (message.channel === 'ptt:captured' && this.retained) this.retained.pttCapture = false;
          if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send(message.channel, ...message.args);
          }
        } else {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          this.retained = message.configuration;
          pending.resolve(message.ok);
        }
      });
      child.on('error', (type, location, report) => {
        console.warn('[GlobalInputHook] Shortcut worker failed:', type, location, report);
      });
      child.on('exit', () => this.workerStopped(child));
    } catch (error) {
      console.warn('[GlobalInputHook] Could not start shortcut worker:', error);
      this.resolveReady?.(false);
      this.resolveReady = null;
      this.ready = null;
    }
    return ready;
  }

  private workerStopped(child: UtilityProcess): void {
    if (this.child !== child) return;
    this.child = null;
    this.ready = null;
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = null;
    this.resolveReady?.(false);
    this.resolveReady = null;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.resolve(false);
    }
    this.pending.clear();
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('ptt:state-changed', false);
      if (this.retained) {
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          void this.ensureWorker();
        }, 1000);
        this.restartTimer.unref();
      }
    }
  }

  private async request(command: ShortcutCommand, payload?: unknown): Promise<boolean> {
    if (!await this.ensureWorker()) return false;
    const child = this.child;
    if (!child) return false;
    const operation: ShortcutOperation = { command, payload };
    const id = ++this.nextId;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        console.warn('[GlobalInputHook] Shortcut worker request timed out:', command);
        this.workerStopped(child);
        child.kill();
      }, RESPONSE_TIMEOUT_MS);
      timer.unref();
      this.pending.set(id, { resolve, timer });
      try {
        this.send(child, { type: 'request', id, operation });
      } catch (error) {
        console.warn('[GlobalInputHook] Could not reach shortcut worker:', error);
        this.workerStopped(child);
        child.kill();
      }
    });
  }

  public setActionHotkeys(payload: unknown): Promise<boolean> { return this.request('setActionHotkeys', payload); }
  public setSoundboardHotkeys(payload: unknown): Promise<boolean> { return this.request('setSoundboardHotkeys', payload); }
  public setPttConfig(payload: unknown): Promise<boolean> { return this.request('setPttConfig', payload); }
  public setShortcutCapture(payload: unknown): Promise<boolean> { return this.request('setShortcutCapture', payload); }
  public startCapture(): Promise<boolean> { return this.request('startCapture'); }
  public stopCapture(): Promise<boolean> { return this.request('stopCapture'); }

  public destroy(): void {
    const child = this.child;
    this.mainWindow = null;
    this.retained = null;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (!child) return;
    this.workerStopped(child);
    try {
      this.send(child, { type: 'shutdown' });
      const timer = setTimeout(() => child.kill(), 1000);
      timer.unref();
      child.once('exit', () => clearTimeout(timer));
    } catch (error) {
      console.warn('[GlobalInputHook] Could not request graceful worker shutdown:', error);
      child.kill();
    }
  }
}

export const globalInputHook = process.platform === 'win32' ? new GlobalInputHookProcess() : localInputHook;
