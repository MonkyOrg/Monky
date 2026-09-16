import { BrowserWindow } from 'electron';
import type { LocalBotIdentity, LocalCapabilityId, LocalConsentDecision, LocalToolId } from '@monky/shared';
import { LocalExecutionError } from './errors';
import type { LocalTools } from './LocalTools';
import {
  LocalPreparationWindow, type LocalToolDialogOptions, type LocalToolDialogResult, type PrepareLocalTools,
} from './preparationWindow';
import type { LocalMaintenanceRequest, PreparationDialogMode } from './preparationView';

export class LocalExecutionDialogs {
  private pending: Promise<void> = Promise.resolve();
  private active: LocalPreparationWindow | null = null;

  constructor(private readonly window: BrowserWindow, private readonly tools: Pick<LocalTools, 'preparationInfo'>) {}

  consent(
    bot: LocalBotIdentity, capability: LocalCapabilityId, signal: AbortSignal, prepare: PrepareLocalTools,
  ): Promise<LocalConsentDecision> {
    return this.preparation('consent', bot, capability, signal, prepare);
  }

  async enable(
    bot: LocalBotIdentity, capability: LocalCapabilityId, signal: AbortSignal, prepare: PrepareLocalTools,
  ): Promise<boolean> {
    return await this.preparation('enable', bot, capability, signal, prepare) === 'always';
  }

  toolsChanged(): void {
    this.active?.update();
  }

  private async preparation(
    mode: PreparationDialogMode, bot: LocalBotIdentity, capability: LocalCapabilityId, signal: AbortSignal, prepare: PrepareLocalTools,
  ): Promise<LocalConsentDecision> {
    const result = await this.show({ parent: this.window, bot, capability, mode, signal, prepare, tools: this.tools });
    if (result === 'completed') throw new LocalExecutionError('invalid_request');
    return result;
  }

  private show(options: LocalToolDialogOptions): Promise<LocalToolDialogResult> {
    const operation = this.pending.then(async () => {
      this.assertOwner(options.signal);
      const view = new LocalPreparationWindow(options);
      this.active = view;
      try { return await view.show(); }
      finally { if (this.active === view) this.active = null; }
    });
    this.pending = operation.then(() => undefined, () => undefined);
    return operation;
  }

  removeTool(
    tool: LocalToolId, affectedTasks: number, signal: AbortSignal, perform: (signal: AbortSignal) => Promise<void>,
  ): Promise<boolean> {
    return this.maintenance({ mode: 'remove', tool, affectedTasks }, signal, perform);
  }

  clearCache(affectedTasks: number, signal: AbortSignal, perform: (signal: AbortSignal) => Promise<void>): Promise<boolean> {
    return this.maintenance({ mode: 'cache', affectedTasks }, signal, perform);
  }

  private async maintenance(request: LocalMaintenanceRequest, signal: AbortSignal, perform: (signal: AbortSignal) => Promise<void>): Promise<boolean> {
    const result = await this.show({ ...request, parent: this.window, signal, perform });
    if (result !== 'completed') throw new LocalExecutionError('invalid_request');
    return true;
  }

  private assertOwner(signal: AbortSignal): void {
    signal.throwIfAborted();
    if (this.window.isDestroyed() || this.window.webContents.isDestroyed()) {
      throw new LocalExecutionError('executor_unavailable');
    }
  }
}
