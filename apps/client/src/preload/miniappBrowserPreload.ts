import { contextBridge } from 'electron';
import { MINIAPP_BROWSER_FOCUS_ADDRESS, MINIAPP_BROWSER_IPC, MINIAPP_BROWSER_STATE, type IpcInvoker, type IpcSubscriber } from '@monky/shared';
import { invoke, subscribe } from './ipc';

const api: {
  control: IpcInvoker<'miniapp-browser:control'>;
  onState: IpcSubscriber<'miniapp-browser:state'>;
  onFocusAddress: IpcSubscriber<'miniapp-browser:focus-address'>;
} = {
  control: command => invoke(MINIAPP_BROWSER_IPC.control, command),
  onState: callback => subscribe(MINIAPP_BROWSER_STATE, callback),
  onFocusAddress: callback => subscribe(MINIAPP_BROWSER_FOCUS_ADDRESS, callback),
};
contextBridge.exposeInMainWorld('miniappBrowser', api);
