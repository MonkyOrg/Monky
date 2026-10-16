import { app, dialog, ipcMain, type BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import {
  FILE_BATCH_DOWNLOAD_IPC, fileBatchDownloadRequestSchema,
  type FileBatchDownloadFile, type FileBatchDownloadRequest, type FileBatchDownloadResult,
} from '@monky/shared';
import { mt } from './i18n';

/** Writes one requested file to `destination`: an HTTP download, or a DM attachment copied out. */
type Download = (file: FileBatchDownloadFile, destination: string) => Promise<void>;

const ZIP_LIMIT = 0xffffffff;

/** `foto.png`, `foto (2).png`, ...: never overwrites a file nor repeats a name inside the batch. */
export function uniqueFileName(name: string, isTaken: (candidate: string) => boolean): string {
  const extension = path.extname(name);
  const base = extension ? name.slice(0, -extension.length) : name;
  let candidate = name;
  for (let copy = 2; isTaken(candidate); copy++) candidate = `${base} (${copy})${extension}`;
  return candidate;
}

function dosDateTime(date: Date): { time: number; date: number } {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((Math.max(date.getFullYear(), 1980) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * Writes the files uncompressed (STORE): photos and videos are already compressed,
 * and streaming each file keeps a large batch out of memory. Without ZIP64 the
 * archive must stay under 4 GB.
 */
export async function writeStoredZip(entries: { name: string; filePath: string }[], destination: string): Promise<void> {
  const { time, date } = dosDateTime(new Date());
  const UTF8_NAMES = 0x0800, STORE = 0, VERSION = 20;
  const temporary = `${destination}.downloading`;
  const output = await fs.promises.open(temporary, 'w');
  const directory: Buffer[] = [];
  let offset = 0;
  try {
    for (const entry of entries) {
      const name = Buffer.from(entry.name, 'utf8');
      const { size } = await fs.promises.stat(entry.filePath);
      if (offset + 30 + name.length + size > ZIP_LIMIT) throw new Error(mt('fileBatch.zipTooLarge'));
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(VERSION, 4);
      local.writeUInt16LE(UTF8_NAMES, 6);
      local.writeUInt16LE(STORE, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(size, 18);
      local.writeUInt32LE(size, 22);
      local.writeUInt16LE(name.length, 26);
      await output.write(local, 0, local.length, offset);
      await output.write(name, 0, name.length, offset + 30);
      let checksum = 0;
      let position = offset + 30 + name.length;
      for await (const chunk of fs.createReadStream(entry.filePath)) {
        const data = chunk as Buffer;
        checksum = crc32(data, checksum);
        await output.write(data, 0, data.length, position);
        position += data.length;
      }
      if (position - offset - 30 - name.length !== size) throw new Error('File changed while archiving');
      const checksumBytes = Buffer.alloc(4);
      checksumBytes.writeUInt32LE(checksum >>> 0, 0);
      await output.write(checksumBytes, 0, 4, offset + 14);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(VERSION, 4);
      central.writeUInt16LE(VERSION, 6);
      central.writeUInt16LE(UTF8_NAMES, 8);
      central.writeUInt16LE(STORE, 10);
      central.writeUInt16LE(time, 12);
      central.writeUInt16LE(date, 14);
      central.writeUInt32LE(checksum >>> 0, 16);
      central.writeUInt32LE(size, 20);
      central.writeUInt32LE(size, 24);
      central.writeUInt16LE(name.length, 28);
      central.writeUInt32LE(offset, 42);
      directory.push(central, name);
      offset = position;
    }
    const centralDirectory = Buffer.concat(directory);
    if (offset + centralDirectory.length + 22 > ZIP_LIMIT) throw new Error(mt('fileBatch.zipTooLarge'));
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralDirectory.length, 12);
    end.writeUInt32LE(offset, 16);
    await output.write(centralDirectory, 0, centralDirectory.length, offset);
    await output.write(end, 0, end.length, offset + centralDirectory.length);
    await output.close();
    await fs.promises.rm(destination, { force: true });
    await fs.promises.rename(temporary, destination);
  } catch (error) {
    await output.close().catch(() => undefined);
    await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
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
    return { status: 'failed', saved: 0, error: errorMessage(error) };
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
