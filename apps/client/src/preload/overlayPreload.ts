import { contextBridge } from 'electron';
import type { ElectronApi } from './api';
import { invoke, subscribe } from './ipc';

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
  closeOverlay: () => invoke('overlay:close'),
  layoutOverlayCards: layout => invoke('overlay:layout-cards', layout),
  sendOverlaySignal: payload => invoke('overlay:send-signal', payload),
  onOverlayConfigUpdated: callback => subscribe('overlay:config-updated', callback),
  onOverlaySignalReceived: callback => subscribe('overlay:signal-received', callback),
  onOverlaySyncStateReceived: callback => subscribe('overlay:sync-state-received', callback),
  onOverlayHoverChanged: callback => subscribe('overlay:hover-changed', callback),
  onOverlayResizeStateChanged: callback => subscribe('overlay:resize-state-changed', callback),
};

contextBridge.exposeInMainWorld('api', api);
