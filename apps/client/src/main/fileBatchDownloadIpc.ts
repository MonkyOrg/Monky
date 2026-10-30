import { app, dialog, ipcMain, type BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {
  FILE_BATCH_DOWNLOAD_IPC, fileBatchDownloadRequestSchema,
  type FileBatchDownloadFile, type FileBatchDownloadRequest, type FileBatchDownloadResult,
} from '@monky/shared';
import { mt } from './i18n';
import { writeStoredZip, ZipTooLargeError } from './zipWriter';

/** Writes one requested file to `destination`: an HTTP download, or a DM attachment copied out. */
type Download = (file: FileBatchDownloadFile, destination: string) => Promise<void>;

/** `foto.png`, `foto (2).png`, ...: never overwrites a file nor repeats a name inside the batch. */
export function uniqueFileName(name: string, isTaken: (candidate: string) => boolean): string {
  const extension = path.extname(name);
  const base = extension ? name.slice(0, -extension.length) : name;
  let candidate = name;
  for (let copy = 2; isTaken(candidate); copy++) candidate = `${base} (${copy})${extension}`;
  return candidate;
}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : 'Unknown error';

async function saveIntoFolder(
  mainWindow: BrowserWindow, request: FileBatchDownloadRequest,
  sanitizeFileName: (name: string) => string, download: Download,
): Promise<FileBatchDownloadResult> {
  const choice = await dialog.showOpenDialog(mainWindow, {
    title: mt('fileBatch.chooseFolder'),
    buttonLabel: mt('fileBatch.saveFolder'),
    defaultPath: app.getPath('downloads'),
    properties: ['openDirectory', 'createDirectory'],
  });
  const folder = choice.filePaths[0];
  if (choice.canceled || !folder) return { status: 'cancelled' };
  const used = new Set<string>();
  let saved = 0;
  let firstError: string | null = null;
  // One failed file must not cost the ones that still download.
  for (const file of request.files) {
    const name = uniqueFileName(sanitizeFileName(file.fileName),
      (candidate) => used.has(candidate.toLowerCase()) || fs.existsSync(path.join(folder, candidate)));
    used.add(name.toLowerCase());
    try {
      await download(file, path.join(folder, name));
      saved++;
    } catch (error) {
      firstError ??= errorMessage(error);
    }
  }
  return firstError === null ? { status: 'saved', saved } : { status: 'failed', saved, error: firstError };
}

async function saveAsZip(
  mainWindow: BrowserWindow, request: FileBatchDownloadRequest,
  sanitizeFileName: (name: string) => string, download: Download,
): Promise<FileBatchDownloadResult> {
  const archiveName = sanitizeFileName(request.archiveName).replace(/\.zip$/i, '');
  const choice = await dialog.showSaveDialog(mainWindow, {
    title: mt('fileBatch.saveZip'),
    defaultPath: path.join(app.getPath('downloads'), `${archiveName}.zip`),
    filters: [{ name: mt('fileBatch.zipFilter'), extensions: ['zip'] }],
  });
  if (choice.canceled || !choice.filePath) return { status: 'cancelled' };
  const destination = /\.zip$/i.test(choice.filePath) ? choice.filePath : `${choice.filePath}.zip`;
  const staging = await fs.promises.mkdtemp(path.join(app.getPath('temp'), 'monky-files-'));
  try {
    const used = new Set<string>();
    const entries: { name: string; filePath: string }[] = [];
    for (const [index, file] of request.files.entries()) {
      const name = uniqueFileName(sanitizeFileName(file.fileName), (candidate) => used.has(candidate.toLowerCase()));
      used.add(name.toLowerCase());
      const filePath = path.join(staging, String(index));
      await download(file, filePath);
      entries.push({ name, filePath });
    }
    await writeStoredZip(entries, destination);
    return { status: 'saved', saved: entries.length };
  } catch (error) {
    // A ZIP missing some of the files would look complete; nothing is kept.
    return { status: 'failed', saved: 0, error: error instanceof ZipTooLargeError ? mt('fileBatch.zipTooLarge') : errorMessage(error) };
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function setupFileBatchDownloadIpc(
  mainWindow: BrowserWindow,
  sanitizeFileName: (name: string) => string,
  download: Download,
): () => void {
  ipcMain.handle(FILE_BATCH_DOWNLOAD_IPC, async (event, input: unknown): Promise<FileBatchDownloadResult> => {
    if (mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
      return { status: 'failed', saved: 0, error: 'Unavailable sender' };
    }
    const parsed = fileBatchDownloadRequestSchema.safeParse(input);
    if (!parsed.success) return { status: 'failed', saved: 0, error: 'Invalid download request' };
    try {
      return parsed.data.mode === 'zip'
        ? await saveAsZip(mainWindow, parsed.data, sanitizeFileName, download)
        : await saveIntoFolder(mainWindow, parsed.data, sanitizeFileName, download);
    } catch (error) {
      return { status: 'failed', saved: 0, error: errorMessage(error) };
    }
  });
  return () => ipcMain.removeHandler(FILE_BATCH_DOWNLOAD_IPC);
}
