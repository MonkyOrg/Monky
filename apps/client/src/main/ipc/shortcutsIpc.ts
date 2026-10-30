import type { BrowserWindow } from 'electron';
import { SHORTCUT_IPC } from '@monky/shared';
import { globalInputHook } from '../globalInputHookProcess';
import type { IpcRegistry } from './registry';

/**
 * Global shortcuts for the soundboard and actions (mute/deafen/camera/etc.)
 * are matched through the passive uiohook listener (globalInputHook) instead
 * of Electron globalShortcut. globalShortcut.register() consumes the key on
 * Windows, so a single-key bind like "Q" was swallowed and never reached the
 * focused game (#571). uiohook only observes input, so the key passes through.
 * Only the main window's top frame configures them, push-to-talk included:
 * nothing else may replace its global input (R-MEDIA-3).
 */
export function registerShortcutsIpc(registry: IpcRegistry, window: BrowserWindow): void {
  globalInputHook.init(window);
  registry.handle(SHORTCUT_IPC.registerSoundboard, 'main', (_event, shortcuts) => globalInputHook.setSoundboardHotkeys(shortcuts));
  // Action Global Shortcuts Registration (#252)
  registry.handle(SHORTCUT_IPC.registerActions, 'main', (_event, shortcuts) => globalInputHook.setActionHotkeys(shortcuts));
  registry.handle(SHORTCUT_IPC.setCapture, 'main', (_event, active) => globalInputHook.setShortcutCapture(active));
  // Push to Talk (PTT) (#186)
  registry.handle(SHORTCUT_IPC.setPttConfig, 'main', (_event, config) => globalInputHook.setPttConfig(config));
  registry.handle(SHORTCUT_IPC.startPttCapture, 'main', () => globalInputHook.startCapture());
  registry.handle(SHORTCUT_IPC.stopPttCapture, 'main', () => globalInputHook.stopCapture());

  window.webContents.on('did-start-loading', () => {
    globalInputHook.stopCapture();
    globalInputHook.setShortcutCapture(false);
  });
  window.webContents.on('render-process-gone', () => {
    globalInputHook.stopCapture();
    globalInputHook.setShortcutCapture(false);
    globalInputHook.setPttConfig({ enabled: false, key: null });
    globalInputHook.setActionHotkeys([]);
    globalInputHook.setSoundboardHotkeys([]);
  });
  registry.onDispose(() => globalInputHook.destroy());
}
