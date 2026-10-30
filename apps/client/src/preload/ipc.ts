import { ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  IpcEventChannel, IpcEvents, IpcInvokeChannel, IpcInvokeChannels, IpcSendChannel, IpcSendChannels,
} from '@monky/shared';

/** `ipcRenderer.invoke` held to the contract (`IpcInvokeChannels` in @monky/shared). */
export function invoke<C extends IpcInvokeChannel>(
  channel: C, ...args: IpcInvokeChannels[C]['args']
): Promise<IpcInvokeChannels[C]['returnType']> {
  return ipcRenderer.invoke(channel, ...args);
}

/** Listens to one event of `IpcEvents`, without handing the Electron event to the page. */
export function subscribe<E extends IpcEventChannel>(channel: E, callback: (...args: IpcEvents[E]) => void): () => void {
  const listener = (_event: IpcRendererEvent, ...args: IpcEvents[E]): void => callback(...args);
  ipcRenderer.on(channel, listener);
  return () => { ipcRenderer.removeListener(channel, listener); };
}

/** `ipcRenderer.send` held to `IpcSendChannels`. */
export function send<C extends IpcSendChannel>(channel: C, ...args: IpcSendChannels[C]): void {
  ipcRenderer.send(channel, ...args);
}
