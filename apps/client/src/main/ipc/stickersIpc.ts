import { app, dialog, type BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { mt } from '../i18n';
import type { MediaFolderConsent } from './mediaFoldersIpc';
import type { IpcRegistry } from './registry';

// Same shape as the soundboard folder feature: the user points at a folder on
// their machine and we only ever read image files out of it.
const STICKER_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.apng': 'image/apng',
  '.avif': 'image/avif',
};
// Animated GIFs and WebPs are routinely a few megabytes, so the ceiling has to
// be generous enough not to quietly swallow a normal sticker. The server
// accepts far more (LIMITS.MAX_ATTACHMENT_FILE_SIZE_DEFAULT is 50 MB); the
// tighter bound here exists only because the renderer decodes these as base64
// data URLs, which costs ~33% on top of the file size.
const MAX_STICKER_BYTES = 8 * 1024 * 1024;
const MAX_STICKERS_LISTED = 500;

/** Chat stickers (#356): the folder they come from, listing and reading them, and saving one somebody sent. */
export function registerStickersIpc(registry: IpcRegistry, window: BrowserWindow, folders: MediaFolderConsent): void {
  /**
   * Folders the user confirmed through the dialog below. `stickers:save` is the
   * only channel here that writes to disk, so it refuses any folder outside this
   * set: the renderer handles untrusted remote chat content and must not be able
   * to name an arbitrary write target. Listing and reading follow the same rule
   * through `folders` (D4), which also keeps folders configured before it.
   *
   * It is persisted so the confirmation survives a restart — otherwise the first
   * save of every session would pop a folder dialog for no reason the user can
   * see.
   */
  const confirmedFoldersFile = path.join(app.getPath('userData'), 'sticker-folders.json');

  const loadConfirmedStickerFolders = (): Set<string> => {
    try {
      const raw = fs.readFileSync(confirmedFoldersFile, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return new Set();
      return new Set(parsed.filter((p): p is string => typeof p === 'string'));
    } catch {
      return new Set();
    }
  };

  const confirmedStickerFolders = loadConfirmedStickerFolders();

  const confirmStickerFolder = (folder: string): void => {
    confirmedStickerFolders.add(path.resolve(folder));
    try {
      fs.writeFileSync(confirmedFoldersFile, JSON.stringify(Array.from(confirmedStickerFolders)), 'utf8');
    } catch (e) {
      // Losing the record only costs an extra dialog next session.
      console.warn('Could not persist the confirmed stickers folder:', e);
    }
  };

  registry.handle('dialog:select-stickers-folder', 'main', async () => {
    const result = await dialog.showOpenDialog(window, {
      title: mt('dialog.selectStickersFolder'),
      properties: ['openDirectory'],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    confirmStickerFolder(result.filePaths[0]);
    await folders.allow('stickers', result.filePaths[0]);
    return result.filePaths[0];
  });

  registry.handle('stickers:list', 'main', async (_event, folderPath, userAction) => {
    if (!folderPath || typeof folderPath !== 'string') {
      return [];
    }
    const access = await folders.request('stickers', folderPath, userAction);
    if (access.status === 'missing') return [];
    if (access.status !== 'allowed') throw new Error('This sticker folder was not confirmed on this computer.');
    try {
      const folderStat = await fs.promises.stat(folderPath).catch(() => null);
      if (!folderStat || !folderStat.isDirectory()) {
        return [];
      }
      const entries = await fs.promises.readdir(folderPath, { withFileTypes: true });
      const candidates = entries
        .filter((entry) => entry.isFile() && STICKER_MIME_TYPES[path.extname(entry.name).toLowerCase()])
        .slice(0, MAX_STICKERS_LISTED);

      const stickers = await Promise.all(
        candidates.map(async (entry) => {
          const ext = path.extname(entry.name).toLowerCase();
          const fullPath = path.join(folderPath, entry.name);
          const stat = await fs.promises.stat(fullPath).catch(() => null);
          if (!stat) return null;
          return {
            name: path.basename(entry.name, ext),
            fileName: entry.name,
            filePath: fullPath,
            sizeBytes: stat.size,
            ext,
            mimeType: STICKER_MIME_TYPES[ext],
            // Listed but flagged instead of dropped, so an oversized file is
            // visibly rejected rather than appearing to have been ignored.
            tooLarge: stat.size > MAX_STICKER_BYTES,
          };
        })
      );

      const valid = stickers.filter((s): s is NonNullable<typeof s> => s !== null);
      valid.sort((a, b) => a.name.localeCompare(b.name));
      return valid;
    } catch (e) {
      console.warn('Error reading stickers folder:', e);
      return [];
    }
  });

  registry.handle('stickers:read', 'main', async (_event, filePath) => {
    if (!filePath || typeof filePath !== 'string') {
      return null;
    }
    // Only ever hand image bytes back to the renderer, and only from a confirmed folder.
    const ext = path.extname(filePath).toLowerCase();
    const mimeType = STICKER_MIME_TYPES[ext];
    if (!mimeType) return null;
    const stickerFile = await folders.resolveFile('stickers', filePath);
    if (!stickerFile) return null;
    try {
      const stat = await fs.promises.stat(stickerFile).catch(() => null);
      if (!stat || !stat.isFile() || stat.size > MAX_STICKER_BYTES) {
        return null;
      }
      const buffer = await fs.promises.readFile(stickerFile);
      return {
        fileName: path.basename(filePath),
        mimeType,
        dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}`,
        sizeBytes: stat.size,
      };
    } catch (e) {
      console.warn('Error reading sticker file:', e);
      return null;
    }
  });

  // Saves a sticker somebody else sent into the user's own folder (#356 QA).
  registry.handle('stickers:save', 'main', async (_event, folderPath, fileName, bytes) => {
    if (!folderPath || typeof folderPath !== 'string') {
      return { ok: false, reason: 'no-folder' as const };
    }
    // Only a folder the user confirmed through the dialog is writable, so the
    // renderer cannot pick the destination on its own.
    if (!confirmedStickerFolders.has(path.resolve(folderPath))) {
      return { ok: false, reason: 'no-folder' as const };
    }
    // The renderer supplies the name, so only the basename is trusted: it must
    // never be able to steer the write outside that folder.
    const safeName = path.basename(String(fileName ?? ''));
    const ext = path.extname(safeName).toLowerCase();
    if (!safeName || !STICKER_MIME_TYPES[ext]) {
      return { ok: false, reason: 'bad-extension' as const };
    }
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_STICKER_BYTES) {
      return { ok: false, reason: 'too-large' as const };
    }
    try {
      const folderStat = await fs.promises.stat(folderPath).catch(() => null);
      if (!folderStat || !folderStat.isDirectory()) {
        return { ok: false, reason: 'no-folder' as const };
      }

      // Never clobber an existing sticker: "cat.gif" becomes "cat (1).gif". The
      // 'wx' flag makes the filesystem itself reject an existing name, so there
      // is no window between checking and writing.
      const base = path.basename(safeName, ext);
      for (let i = 0; i < 100; i++) {
        const candidate = i === 0 ? safeName : `${base} (${i})${ext}`;
        try {
          await fs.promises.writeFile(path.join(folderPath, candidate), bytes, { flag: 'wx' });
          return { ok: true, fileName: candidate };
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        }
      }
      return { ok: false, reason: 'write-failed' as const };
    } catch (e) {
      console.warn('Error saving sticker file:', e);
      return { ok: false, reason: 'write-failed' as const };
    }
  });
}
