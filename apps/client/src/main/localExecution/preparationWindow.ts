import { BrowserWindow, ipcMain, screen, type IpcMainInvokeEvent, type WebContents } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { errorDiagnostic } from '@monky/bot-sdk/dist/localRuntime';
import {
  LOCAL_PREPARATION_DIALOG_CHANGED, LOCAL_PREPARATION_DIALOG_IPC,
  type LocalBotIdentity, type LocalCapabilityId, type LocalConsentDecision, type LocalPreparationDialogState,
} from '@monky/shared';
import { mt } from '../i18n';
import { LocalExecutionError, localFailure } from './errors';
import type { LocalTools } from './LocalTools';
import {
  maintenanceDialogHtml, maintenanceDialogState, preparationDialogHtml, preparationDialogState,
  type LocalMaintenanceRequest, type PreparationDialogMode,
} from './preparationView';

export type PrepareLocalTools = (signal: AbortSignal, retryCleanup?: boolean) => Promise<void>;
export type LocalToolDialogResult = LocalConsentDecision | 'completed';
type PreparationRequest = {
  bot: LocalBotIdentity; capability: LocalCapabilityId; mode: PreparationDialogMode;
  tools: Pick<LocalTools, 'preparationInfo'>; prepare: PrepareLocalTools;
};
export type LocalToolDialogOptions = { parent: BrowserWindow; signal: AbortSignal } & (
  PreparationRequest | (LocalMaintenanceRequest & { perform: (signal: AbortSignal) => Promise<void> })
);

function isPreparation(options: LocalToolDialogOptions): options is LocalToolDialogOptions & PreparationRequest {
  return options.mode === 'consent' || options.mode === 'enable';
}

const owners = new Map<number, LocalPreparationWindow>();

function owner(event: IpcMainInvokeEvent): LocalPreparationWindow {
  const window = owners.get(event.sender.id);
  if (!window || !window.owns(event)) {
    console.warn('[LocalExecution] Rejected an unowned preparation dialog request');
    throw new LocalExecutionError('invalid_request');
  }
  return window;
}

function register(window: LocalPreparationWindow, contents: WebContents): void {
  if (!owners.size) {
    ipcMain.handle(LOCAL_PREPARATION_DIALOG_IPC.state, (event) => owner(event).readyState());
    try {
      ipcMain.handle(LOCAL_PREPARATION_DIALOG_IPC.action, (event, input: unknown) => owner(event).act(input));
    } catch (error) {
      ipcMain.removeHandler(LOCAL_PREPARATION_DIALOG_IPC.state);
      throw error;
    }
  }
  owners.set(contents.id, window);
}

function unregister(window: LocalPreparationWindow, id: number): void {
  if (owners.get(id) !== window) return;
  owners.delete(id);
  if (!owners.size) {
    ipcMain.removeHandler(LOCAL_PREPARATION_DIALOG_IPC.state);
    ipcMain.removeHandler(LOCAL_PREPARATION_DIALOG_IPC.action);
  }
}

export class LocalPreparationWindow {
  private window: BrowserWindow | null = null;
  private contents: WebContents | null = null;
  private readonly cancellation = new AbortController();
  private readonly signal: AbortSignal;
  private phase: LocalPreparationDialogState['phase'] = 'consent';
  private decision: Exclude<LocalToolDialogResult, 'deny'> | null = null;
  private attempts = 0;
  private failure: unknown;
  private settled = false;
  private ready = false;
  private loadingTimeout: ReturnType<typeof setTimeout> | null = null;
  private resolve!: (decision: LocalToolDialogResult) => void;
  private reject!: (error: unknown) => void;
  private readonly result = new Promise<LocalToolDialogResult>((resolve, reject) => {
    this.resolve = resolve;
    this.reject = reject;
  });

  constructor(private readonly options: LocalToolDialogOptions) {
    this.signal = AbortSignal.any([options.signal, this.cancellation.signal]);
  }

  async show(): Promise<LocalToolDialogResult> {
    this.signal.throwIfAborted();
    const { parent } = this.options;
    const preparing = isPreparation(this.options);
    if (parent.isDestroyed() || parent.webContents.isDestroyed()) throw new LocalExecutionError('executor_unavailable');
    const workArea = screen.getDisplayMatching(parent.getBounds()).workArea;
    const window = new BrowserWindow({
      parent, modal: true, frame: false, show: false, useContentSize: true,
      width: Math.min(720, workArea.width - 40), height: Math.min(preparing ? 820 : 470, workArea.height - 40),
      resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
      backgroundColor: '#161b22', title: this.state().title,
      webPreferences: {
        contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, sandbox: true,
        webSecurity: true, backgroundThrottling: false,
        preload: path.join(__dirname, '../../preload/localPreparationDialog.cjs'),
      },
    });
    this.window = window;
    this.contents = window.webContents;
    const contents = this.contents;
    const contentsId = contents.id;
    window.setMenuBarVisibility(false);
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event) => event.preventDefault());
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.once('render-process-gone', () => this.cancel(new LocalExecutionError('executor_unavailable')));
    contents.once('preload-error', (_event, _preloadPath, error) => this.finish(undefined, error));
    window.once('ready-to-show', () => { if (!window.isDestroyed()) window.show(); });
    window.on('close', (event) => {
      if (!preparing && (this.phase === 'installing' || this.phase === 'cancelling')) event.preventDefault();
    });
    window.once('closed', () => {
      unregister(this, contentsId);
      this.cancel(new LocalExecutionError('cancelled'));
    });
    this.signal.addEventListener('abort', this.onAbort, { once: true });
    try {
      register(this, contents);
      this.loadingTimeout = setTimeout(() => this.finish(undefined, new LocalExecutionError('executor_unavailable')), 15_000);
      const icon = `data:image/png;base64,${fs.readFileSync(path.join(__dirname, '../../../build/icons/128x128.png')).toString('base64')}`;
      const font = `data:font/woff2;base64,${fs.readFileSync(require.resolve('@fontsource/inter/files/inter-latin-400-normal.woff2')).toString('base64')}`;
      const html = isPreparation(this.options)
        ? preparationDialogHtml({ ...this.options, inventory: this.options.tools.preparationInfo(this.options.capability), icon, font })
        : maintenanceDialogHtml(this.options, { icon, font });
      const loaded = contents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      const [, decision] = await Promise.all([loaded, this.result]);
      return decision;
    } finally {
      if (this.loadingTimeout) clearTimeout(this.loadingTimeout);
      this.signal.removeEventListener('abort', this.onAbort);
      unregister(this, contentsId);
      if (!window.isDestroyed()) window.destroy();
      this.window = null;
      this.contents = null;
    }
  }

  owns(event: IpcMainInvokeEvent): boolean {
    return !this.settled && !!this.window && !this.window.isDestroyed() && !!this.contents && !this.contents.isDestroyed() &&
      event.sender === this.contents && event.senderFrame === this.contents.mainFrame;
  }

  state(): LocalPreparationDialogState {
    const failure = this.failure === undefined ? undefined : localFailure(this.failure,
      isPreparation(this.options) ? 'tool_install_failed' : 'storage_failed');
    const state = isPreparation(this.options)
      ? preparationDialogState(this.phase, this.options.tools.preparationInfo(this.options.capability), failure)
      : maintenanceDialogState(this.options, this.phase, failure);
    if (this.phase === 'failed') state.status = mt('localExecution.attemptFailed', { count: String(this.attempts) });
    return state;
  }

  readyState(): LocalPreparationDialogState {
    this.ready = true;
    if (this.loadingTimeout) clearTimeout(this.loadingTimeout);
    this.loadingTimeout = null;
    return this.state();
  }

  update(): void {
    if (this.settled || !this.contents || this.contents.isDestroyed()) return;
    this.contents.send(LOCAL_PREPARATION_DIALOG_CHANGED, this.state());
  }

  act(input: unknown): void {
    if (!isPreparation(this.options) && (this.phase === 'installing' || this.phase === 'cancelling') &&
      (input === 'cancel' || input === 'close')) {
      console.warn('[LocalExecution] Maintenance must finish cleanup before closing');
      throw new LocalExecutionError('busy');
    }
    if (input === 'cancel') { this.cancel(new LocalExecutionError('cancelled')); return; }
    if (input === 'close' && this.phase === 'failed') { this.finish(undefined, this.failure); return; }
    if (this.ready && !this.signal.aborted && input === 'retry' && this.phase === 'failed' && this.decision) {
      this.startInstallation(this.decision, true);
      return;
    }
    if (!isPreparation(this.options) && this.ready && !this.signal.aborted && this.phase === 'consent' && input === 'confirm') {
      this.startInstallation('completed');
      return;
    }
    if (!this.ready || this.signal.aborted || this.phase !== 'consent' || (input !== 'deny' && input !== 'connection' && input !== 'always') ||
      !isPreparation(this.options) || this.options.mode === 'enable' && input === 'connection') {
      console.warn('[LocalExecution] Rejected an invalid preparation dialog action');
      throw new LocalExecutionError('invalid_request');
    }
    if (input === 'deny') { this.finish('deny'); return; }
    this.startInstallation(input);
  }

  private startInstallation(decision: Exclude<LocalToolDialogResult, 'deny'>, retryCleanup = false): void {
    this.decision = decision;
    this.attempts++;
    this.failure = undefined;
    this.phase = 'installing';
    this.update();
    void this.install(decision, retryCleanup).catch((error: unknown) => this.finish(undefined, error));
  }

  private async install(decision: Exclude<LocalToolDialogResult, 'deny'>, retryCleanup: boolean): Promise<void> {
    try {
      if (isPreparation(this.options)) await this.options.prepare(this.signal, retryCleanup);
      else await this.options.perform(this.signal);
      this.signal.throwIfAborted();
      this.phase = 'complete';
      this.update();
      this.finish(decision);
    } catch (error) {
      if (this.signal.aborted) this.finish(undefined, this.signal.reason);
      else {
        this.failure = error;
        this.phase = 'failed';
        console.warn(`[LocalExecution] Local tool ${this.options.mode} attempt ${this.attempts} failed: ${errorDiagnostic(error)}`);
        this.update();
      }
    }
  }

  private cancel(reason: LocalExecutionError): void {
    if (!this.settled) this.cancellation.abort(reason);
  }

  private onAbort = (): void => {
    if (this.settled) return;
    if (this.phase === 'installing' || this.phase === 'cancelling') {
      this.phase = 'cancelling';
      this.update();
    } else this.finish(undefined, this.signal.reason);
  };

  private finish(decision?: LocalToolDialogResult, error?: unknown): void {
    if (this.settled) return;
    this.settled = true;
    if (decision !== undefined) this.resolve(decision);
    else this.reject(error ?? new LocalExecutionError('cancelled'));
  }
}
