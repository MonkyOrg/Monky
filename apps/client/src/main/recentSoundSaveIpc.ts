import { app, dialog, ipcMain, type BrowserWindow } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { LIMITS, type IpcInvokeChannels } from '@monky/shared';

const CHANNEL = 'app:save-recent-sound' satisfies keyof IpcInvokeChannels;

export function setupRecentSoundSaveIpc(
  mainWindow: BrowserWindow,
  sanitizeFileName: (name: string) => string,
): () => void {
  ipcMain.handle(CHANNEL, async (_, input: IpcInvokeChannels[typeof CHANNEL]['args'][0]) => {
    try {
      const extensions: Record<string, string> = {
        'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg',
        'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/webm': 'webm',
      };
      if (!input || typeof input !== 'object' || typeof input.fileName !== 'string'
        || typeof input.mimeType !== 'string' || typeof input.base64 !== 'string'
        || !extensions[input.mimeType] || !/^[A-Za-z0-9+/]+={0,2}$/u.test(input.base64)) {
        return { success: false, error: 'Invalid audio data' };
      }
      const bytes = Buffer.from(input.base64, 'base64');
      if (bytes.length < 1 || bytes.length > LIMITS.MAX_SOUNDBOARD_FILE_SIZE) {
        return { success: false, error: 'Invalid audio size' };
      }
      const extension = extensions[input.mimeType];
      const rawName = sanitizeFileName(input.fileName);
      const suggestedName = rawName.toLowerCase().endsWith(`.${extension}`) ? rawName : `${rawName}.${extension}`;
      const result = await dialog.showSaveDialog(mainWindow, {
        defaultPath: path.join(app.getPath('downloads'), suggestedName),
        filters: [{ name: 'Audio', extensions: [extension] }],
      });
      if (result.canceled || !result.filePath) return { success: false, canceled: true };
      await fs.writeFile(result.filePath, bytes);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });
  return () => ipcMain.removeHandler(CHANNEL);
}
