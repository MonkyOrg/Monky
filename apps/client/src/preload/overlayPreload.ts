import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { OverlayConfig, OverlaySignal, OverlaySyncState } from '@monky/shared';
import type { ElectronApi } from './preload';

/**
 * Everything the overlay window may do (E-MAIN-1): draw the call it receives,
 * size its cards, talk to the main window and close itself. The window is
 * transparent and stays on top of games, so whatever loads in it — even a page
 * it was steered to — never reaches identity, files, servers or settings.
 */
export type OverlayWindowApi = Pick<ElectronApi,
  | 'closeOverlay' | 'layoutOverlayCards' | 'sendOverlaySignal' | 'onOverlayConfigUpdated'
  | 'onOverlaySignalReceived' | 'onOverlaySyncStateReceived' | 'onOverlayHoverChanged' | 'onOverlayResizeStateChanged'>;

const api: OverlayWindowApi = {
  closeOverlay: () => ipcRenderer.invoke('overlay:close'),
  layoutOverlayCards: (layout) => ipcRenderer.invoke('overlay:layout-cards', layout),
  sendOverlaySignal: (payload) => ipcRenderer.invoke('overlay:send-signal', payload),
  onOverlayConfigUpdated: (cb) => {
    const listener = (_e: IpcRendererEvent, config: OverlayConfig) => cb(config);
    ipcRenderer.on('overlay:config-updated', listener);
    return () => { ipcRenderer.removeListener('overlay:config-updated', listener); };
  },
  onOverlaySignalReceived: (cb) => {
    const listener = (_e: IpcRendererEvent, signal: OverlaySignal) => cb(signal);
    ipcRenderer.on('overlay:signal-received', listener);
    return () => { ipcRenderer.removeListener('overlay:signal-received', listener); };
  },
  onOverlaySyncStateReceived: (cb) => {
    const listener = (_e: IpcRendererEvent, state: OverlaySyncState) => cb(state);
    ipcRenderer.on('overlay:sync-state-received', listener);
    return () => { ipcRenderer.removeListener('overlay:sync-state-received', listener); };
  },
  onOverlayHoverChanged: (cb) => {
    const listener = (_e: IpcRendererEvent, hovered: boolean, point?: { x: number; y: number }) => cb(hovered, point);
    ipcRenderer.on('overlay:hover-changed', listener);
    return () => { ipcRenderer.removeListener('overlay:hover-changed', listener); };
  },
  onOverlayResizeStateChanged: (cb) => {
    const listener = (_e: IpcRendererEvent, resizing: boolean) => cb(resizing);
    ipcRenderer.on('overlay:resize-state-changed', listener);
    return () => { ipcRenderer.removeListener('overlay:resize-state-changed', listener); };
  },
};

contextBridge.exposeInMainWorld('api', api);
