import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from 'electron';
import type { IpcEventChannel, IpcEvents, IpcInvokeChannel, IpcInvokeChannels } from '@monky/shared';
import type { ContractIpcMain, InvokeListener } from '../ipcContract';

/** The windows whose pages may call Main: the application window and the call overlay. */
export type IpcSender = 'main' | 'overlay';

type Senders = IpcSender | readonly IpcSender[];

/**
 * Who may call a channel: the top frame of these windows — never an embedded
 * frame, a popup or a page of another window. Channels whose answer is a result
 * union name in `refused` what any other sender gets; the others reject the call.
 */
export type IpcPolicy<C extends IpcInvokeChannel> =
  | Senders
  | { readonly from: Senders; readonly refused: IpcInvokeChannels[C]['returnType'] };

const SENDER_NAMES: Record<IpcSender, string> = { main: 'the main window', overlay: 'the overlay' };

/** The page of a window while both are alive; reading `webContents` of a destroyed window throws. */
export function windowContents(window: BrowserWindow | null | undefined): WebContents | null {
  return window && !window.isDestroyed() && !window.webContents.isDestroyed() ? window.webContents : null;
}

/** `webContents.send` held to `IpcEvents`: a page that is gone is skipped instead of throwing. */
export function sendEvent<E extends IpcEventChannel>(contents: WebContents | null | undefined, channel: E,
  ...args: IpcEvents[E]): boolean {
  if (!contents || contents.isDestroyed()) return false;
  contents.send(channel, ...args);
  return true;
}

/**
 * Every invoke channel of a window goes through one registry (E-MAIN-4): it
 * checks the sender against the channel's policy before the handler runs, sends
 * typed events only to pages that still exist, and removes on `dispose()`
 * exactly what it registered, together with the cleanups the modules gave it,
 * so a new window can register the same channels again.
 */
export class IpcRegistry {
  private readonly channels = new Set<IpcInvokeChannel>();
  private readonly cleanups = new Set<() => void>();
  private disposed = false;

  constructor(
    private readonly ipc: Pick<ContractIpcMain, 'handle' | 'removeHandler'>,
    private readonly owners: Readonly<Record<IpcSender, () => WebContents | null>>,
  ) {}

  /** Whether the request comes from the top frame of `sender`'s window, as it is now. */
  isFrom(event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>, sender: IpcSender): boolean {
    const contents = this.owners[sender]();
    return !!contents && !contents.isDestroyed() && event.sender === contents && event.senderFrame === contents.mainFrame;
  }

  handle<C extends IpcInvokeChannel>(channel: C, policy: IpcPolicy<C>, listener: InvokeListener<C>): void {
    if (this.disposed) throw new Error(`Cannot register '${channel}' after its IPC registry was disposed.`);
    if (this.channels.has(channel)) throw new Error(`'${channel}' is already registered.`);
    const rule = typeof policy === 'object' && 'from' in policy ? policy : { from: policy };
    const from: readonly IpcSender[] = typeof rule.from === 'string' ? [rule.from] : rule.from;
    this.ipc.handle(channel, (event, ...args) => {
      if (from.some(sender => this.isFrom(event, sender))) return listener(event, ...args);
      console.warn(`[IPC] Refused '${channel}' from a sender outside its policy.`);
      if ('refused' in rule) return rule.refused;
      throw new Error(`'${channel}' only answers ${from.map(sender => SENDER_NAMES[sender]).join(' or ')}.`);
    });
    this.channels.add(channel);
  }

  /** Sends an event to `to`'s page; nothing happens once that window or this registry is gone. */
  send<E extends IpcEventChannel>(to: IpcSender, channel: E, ...args: IpcEvents[E]): boolean {
    return !this.disposed && sendEvent(this.owners[to](), channel, ...args);
  }

  /** Runs `cleanup` when the registry is disposed, after its channels are removed. */
  onDispose(cleanup: () => void): void {
    if (this.disposed) throw new Error('Cannot add a cleanup to a disposed IPC registry.');
    this.cleanups.add(cleanup);
  }

  /** A registry for one module, disposed on its own or, at the latest, together with this one. */
  scope(): IpcRegistry {
    const child = new IpcRegistry(this.ipc, this.owners);
    const release = (): void => child.dispose();
    this.onDispose(release);
    child.onDispose(() => this.cleanups.delete(release));
    return child;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const channel of this.channels) this.ipc.removeHandler(channel);
    this.channels.clear();
    // What was registered later may depend on what came before, so it is released first.
    const cleanups = [...this.cleanups].reverse();
    this.cleanups.clear();
    for (const cleanup of cleanups) {
      try { cleanup(); }
      catch (error: unknown) { console.error('[IPC] A cleanup failed while disposing the registry:', error); }
    }
  }
}
