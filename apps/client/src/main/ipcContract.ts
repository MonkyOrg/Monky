import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import type { IpcInvokeChannel, IpcInvokeChannels, IpcSendChannel, IpcSendChannels } from '@monky/shared';

/** A handler of one invoke channel: the arguments the contract declares, and its answer. */
export type InvokeListener<C extends IpcInvokeChannel> = (
  event: IpcMainInvokeEvent, ...args: IpcInvokeChannels[C]['args']
) => IpcInvokeChannels[C]['returnType'] | Promise<IpcInvokeChannels[C]['returnType']>;

export type SendListener<C extends IpcSendChannel> = (event: IpcMainEvent, ...args: IpcSendChannels[C]) => void;

/**
 * `ipcMain` held to the contract in @monky/shared (`IpcInvokeChannels` and
 * `IpcSendChannels`): a channel the contract lacks, an answer of another type or
 * a handler expecting other arguments does not compile. The arguments still come
 * from a renderer, so handlers keep checking them.
 */
export interface ContractIpcMain {
  handle<C extends IpcInvokeChannel>(channel: C, listener: InvokeListener<C>): void;
  removeHandler(channel: IpcInvokeChannel): void;
  on<C extends IpcSendChannel>(channel: C, listener: SendListener<C>): this;
  removeListener<C extends IpcSendChannel>(channel: C, listener: SendListener<C>): this;
}
