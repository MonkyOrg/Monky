import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import type { IpcInvokeChannel } from '@monky/shared';
import type { ContractIpcMain, InvokeListener } from './ipcContract';

/** Whether the request comes from `window`'s top frame: never an iframe, a popup, the overlay or another window. */
export function isMainFrameSender(window: BrowserWindow, event: IpcMainInvokeEvent): boolean {
  return !window.isDestroyed() && event.sender === window.webContents
    && event.senderFrame === window.webContents.mainFrame;
}

/**
 * `ipcMain.handle` for channels only the main window's top frame may use
 * (E-MAIN-1): identity, backups, hosted servers, local files and system
 * settings. Any other sender — the overlay, a popup, an embedded frame or a
 * page that navigated in — is rejected before the handler runs.
 */
export function mainFrameHandle(ipc: Pick<ContractIpcMain, 'handle'>, window: BrowserWindow): ContractIpcMain['handle'] {
  return <C extends IpcInvokeChannel>(channel: C, listener: InvokeListener<C>) => ipc.handle(channel, (event, ...args) => {
    if (!isMainFrameSender(window, event)) throw new Error(`'${channel}' only answers the main window.`);
    return listener(event, ...args);
  });
}
