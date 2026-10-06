import { ipcMain, type BrowserWindow } from 'electron';
import { SOUNDBOARD_FILES_IPC, type IpcInvokeChannels } from '@monky/shared';
import type { SoundboardFiles } from './soundboardFiles';

export function setupSoundboardFilesIpc(window: BrowserWindow, files: SoundboardFiles): () => void {
  const contents = window.webContents;
  const owns = (event: Electron.IpcMainInvokeEvent): boolean =>
    !contents.isDestroyed() && event.sender === contents && event.senderFrame === contents.mainFrame;
  ipcMain.handle(SOUNDBOARD_FILES_IPC.read, (event, input: unknown): Promise<IpcInvokeChannels['soundboard:edit-read']['returnType']> =>
    owns(event) ? files.read(input) : Promise.resolve({ status: 'failed', reason: 'invalid_request' }));
  ipcMain.handle(SOUNDBOARD_FILES_IPC.open, (event, input: unknown): Promise<IpcInvokeChannels['soundboard:open-editor']['returnType']> =>
    owns(event) ? files.openEditor(input) : Promise.resolve({ status: 'failed', reason: 'invalid_request' }));
  ipcMain.handle(SOUNDBOARD_FILES_IPC.overwrite, (event, input: unknown): Promise<IpcInvokeChannels['soundboard:overwrite-audio']['returnType']> =>
    owns(event) ? files.overwrite(input) : Promise.resolve({ status: 'failed', reason: 'invalid_request' }));
  ipcMain.handle(SOUNDBOARD_FILES_IPC.rename, (event, input: unknown): Promise<IpcInvokeChannels['soundboard:rename-file']['returnType']> =>
    owns(event) ? files.rename(input) : Promise.resolve({ status: 'failed', reason: 'invalid_request' }));
  ipcMain.handle(SOUNDBOARD_FILES_IPC.delete, (event, input: unknown): Promise<IpcInvokeChannels['soundboard:delete-file']['returnType']> =>
    owns(event) ? files.delete(input) : Promise.resolve({ status: 'failed', reason: 'invalid_request' }));
  ipcMain.handle(SOUNDBOARD_FILES_IPC.edit, (event, input: unknown): Promise<IpcInvokeChannels['soundboard:save-edited-copy']['returnType']> =>
    owns(event) ? files.edit(input) : Promise.resolve({ status: 'failed', reason: 'invalid_request' }));
  return () => { for (const channel of Object.values(SOUNDBOARD_FILES_IPC)) ipcMain.removeHandler(channel); };
}
