import type { BrowserWindow } from 'electron';
import { EDITOR_COMMAND_IPC, EDITOR_COMMANDS } from '@monky/shared';
import type { IpcRegistry } from './ipc/registry';

/** Cut, copy, paste and select all from the app's own menus, run on the main window's page. */
export function registerEditorCommands(registry: IpcRegistry, window: BrowserWindow): void {
  const contents = window.webContents;
  registry.handle(EDITOR_COMMAND_IPC, { from: 'main', refused: { success: false } }, (_event, input) => {
    const command = EDITOR_COMMANDS.find(value => value === input);
    if (!command || contents.isDestroyed()) {
      console.warn('[Editor] Rejected an invalid editing command.');
      return { success: false };
    }
    contents[command]();
    return { success: true };
  });
}
