import type { OverlayManager } from '../overlayManager';
import type { IpcRegistry } from './registry';

/**
 * The call overlay (#169). The main window drives it; the overlay page itself may
 * only close, size its cards and exchange the video link with the main window,
 * the same three calls its preload offers (E-MAIN-1).
 */
export function registerOverlayIpc(registry: IpcRegistry, overlay: OverlayManager): void {
  registry.handle('overlay:open', 'main', (_event, config) => ({ success: overlay.open(config) }));
  registry.handle('overlay:close', ['main', 'overlay'], () => ({ success: overlay.close() }));
  registry.handle('overlay:is-open', 'main', () => overlay.isOpen());
  registry.handle('overlay:get-config', 'main', () => overlay.getConfig());
  registry.handle('overlay:set-config', 'main', (_event, config) => {
    overlay.setConfig(config);
  });
  registry.handle('overlay:save-bounds', 'main', (_event, bounds) => {
    overlay.setConfig({ bounds, position: 'custom' });
  });
  registry.handle('overlay:reset-bounds', 'main', () => {
    overlay.resetBounds();
  });
  registry.handle('overlay:layout-cards', 'overlay', (event, layout) => overlay.layoutCards(event.sender.id, layout));
  registry.handle('overlay:send-signal', ['main', 'overlay'], (_event, payload) => {
    overlay.sendSignal(payload);
  });
  registry.handle('overlay:send-sync-state', 'main', (_event, state) => {
    overlay.sendSyncState(state);
  });
}
