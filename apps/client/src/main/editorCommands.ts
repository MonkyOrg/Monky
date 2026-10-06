import { ipcMain, type BrowserWindow } from 'electron';
import { EDITOR_COMMAND_IPC, EDITOR_COMMANDS, type IpcInvokeChannels } from '@monky/shared';

export function setupEditorCommands(window: BrowserWindow): () => void {
  const contents = window.webContents;
  ipcMain.handle(EDITOR_COMMAND_IPC, (event, input: unknown): IpcInvokeChannels['editor:command']['returnType'] => {
    const command = EDITOR_COMMANDS.find(value => value === input);
    if (!command || contents.isDestroyed() || event.sender !== contents || event.senderFrame !== contents.mainFrame) {
      console.warn('[Editor] Rejected an invalid editing command or sender.');
      return { success: false };
    }
    contents[command]();
    return { success: true };
  });
  return () => ipcMain.removeHandler(EDITOR_COMMAND_IPC);
}
