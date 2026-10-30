import { app, dialog, type BrowserWindow } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { downloadToFile, sanitizeDownloadFileName, suggestedDownloadName } from '../attachmentDownload';
import { mt } from '../i18n';
import { webUrl } from './guards';
import type { IpcRegistry } from './registry';

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : 'Unknown error';

/** Images the person picks to send, and the files the app saves for them: a downloaded attachment or a CSV. */
export function registerFilesIpc(registry: IpcRegistry, window: BrowserWindow): void {
  // Avatar Image Selection Dialog
  registry.handle('dialog:select-image', 'main', async () => {
    const result = await dialog.showOpenDialog(window, {
      title: mt('dialog.selectProfilePhoto'),
      filters: [
        { name: 'Imagens (PNG, JPG, WebP)', extensions: ['png', 'jpg', 'jpeg', 'webp'] },
      ],
      properties: ['openFile'],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const filePath = result.filePaths[0];
    const buffer = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase().replace('.', '');
    const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    const base64 = buffer.toString('base64');

    return {
      fileName: path.basename(filePath),
      mimeType: mime,
      base64: `data:${mime};base64,${base64}`,
    };
  });

  registry.handle('dialog:select-images', 'main', async (_event, maxFiles) => {
    const limit = Math.min(5, Math.max(1, Number.isInteger(maxFiles) ? maxFiles : 1));
    const result = await dialog.showOpenDialog(window, {
      title: mt('dialog.selectImages'),
      filters: [
        { name: 'Imagens (PNG, JPG, WebP)', extensions: ['png', 'jpg', 'jpeg', 'webp'] },
      ],
      properties: ['openFile', 'multiSelections'],
    });
    if (result.canceled || result.filePaths.length === 0) return [];
    return Promise.all(result.filePaths.slice(0, limit).map(async filePath => {
      const buffer = await readFile(filePath);
      const ext = path.extname(filePath).toLowerCase().replace('.', '');
      const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
      return {
        fileName: path.basename(filePath),
        mimeType: mime,
        base64: `data:${mime};base64,${buffer.toString('base64')}`,
      };
    }));
  });

  registry.handle('app:download-file', 'main', async (_event, url, fileName) => {
    try {
      const parsedUrl = webUrl(url);
      if (!parsedUrl) {
        return { success: false, error: 'Invalid URL' };
      }

      const suggestedName = suggestedDownloadName(parsedUrl, fileName);
      const saveResult = await dialog.showSaveDialog(window, {
        defaultPath: path.join(app.getPath('downloads'), suggestedName),
      });

      if (saveResult.canceled || !saveResult.filePath) {
        return { success: false };
      }

      await downloadToFile(parsedUrl.toString(), saveResult.filePath);
      return { success: true };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  });

  registry.handle('app:save-csv-file', 'main', async (_event, content, fileName) => {
    try {
      if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > 128 * 1024 * 1024) {
        return { success: false, error: 'Invalid CSV content' };
      }
      const safeName = sanitizeDownloadFileName(fileName || 'responses.csv');
      const suggestedName = safeName.toLowerCase().endsWith('.csv') ? safeName : `${safeName}.csv`;
      const saveResult = await dialog.showSaveDialog(window, {
        defaultPath: path.join(app.getPath('downloads'), suggestedName),
        filters: [{ name: 'CSV', extensions: ['csv'] }],
      });
      if (saveResult.canceled || !saveResult.filePath) return { success: false };
      await writeFile(saveResult.filePath, content, 'utf8');
      return { success: true };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  });
}
