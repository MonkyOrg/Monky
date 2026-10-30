import { app, dialog, type BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { AUDIO_PREVIEW_IPC, LIMITS, SOUND_DOWNLOAD_IPC, SOUND_DOWNLOAD_PROGRESS } from '@monky/shared';
import { AudioPreviews } from '../audioPreviews';
import { mt } from '../i18n';
import type { LocalTools } from '../localExecution/LocalTools';
import { registerRecentSoundSaveIpc } from '../recentSoundSaveIpc';
import { SoundboardDownloads } from '../soundboardDownload';
import { createSoundboardEncoder } from '../soundboardEncoder';
import { SoundboardFiles } from '../soundboardFiles';
import { registerSoundboardFilesIpc } from '../soundboardFilesIpc';
import type { MediaFolderConsent } from './mediaFoldersIpc';
import { sendEvent, type IpcRegistry } from './registry';

/** Extensões que a soundboard aceita, na listagem e na leitura de um som. */
const SOUNDBOARD_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.webm']);
const INVALID_REQUEST = { status: 'failed', reason: 'invalid_request' } as const;

export interface SoundboardIpcDeps {
  window: BrowserWindow;
  folders: MediaFolderConsent;
  /** The local tools once local execution starts: their FFmpeg edits sound files. */
  localTools: () => LocalTools | undefined;
  sanitizeFileName: (name: string) => string;
}

/**
 * The soundboard library: its folder, the sounds listed and played from it,
 * downloads and previews of sounds others play, and editing its files.
 */
export function registerSoundboardIpc(registry: IpcRegistry, { window, folders, localTools, sanitizeFileName }: SoundboardIpcDeps): void {
  const soundDownloads = new SoundboardDownloads(path.join(app.getPath('userData'), 'soundboard-folder.json'));
  const audioPreviews = new AudioPreviews();
  const encoder = createSoundboardEncoder(async () => {
    try { return await localTools()?.readyExecutable('ffmpeg') ?? null; }
    catch (error: unknown) {
      console.error('[soundboard] Could not verify the local FFmpeg installation.', error);
      return null;
    }
  });
  registerSoundboardFilesIpc(registry, new SoundboardFiles(soundDownloads, encoder));
  registerRecentSoundSaveIpc(registry, window, sanitizeFileName);

  registry.handle(SOUND_DOWNLOAD_IPC.defaultFolder, 'main', async () => {
    let folder: string | null;
    try {
      folder = await soundDownloads.getDefaultFolder();
    } catch (error: unknown) {
      console.warn('[Soundboard] Could not initialize the default sound folder:', error);
      throw new Error(mt('error.defaultSoundboardFolder'));
    }
    // Main created or confirmed this folder itself.
    if (folder) await folders.allow('soundboard', folder);
    return folder;
  });
  registry.handle(SOUND_DOWNLOAD_IPC.availability, { from: 'main', refused: 'unavailable' },
    async (_event, folder) => soundDownloads.availability(folder));
  registry.handle(SOUND_DOWNLOAD_IPC.confirmFolder, { from: 'main', refused: false }, async (event, folder) => {
    let confirmed: boolean;
    try {
      confirmed = await soundDownloads.confirmConfiguredFolder(folder, async (canonical) => {
        if (window.isDestroyed() || !registry.isFrom(event, 'main')) return false;
        const result = await dialog.showMessageBox(window, {
          type: 'question',
          title: mt('dialog.confirmSoundboardFolderTitle'),
          message: mt('dialog.confirmSoundboardFolderMessage'),
          detail: mt('dialog.confirmSoundboardFolderDetail', { folder: canonical }),
          buttons: [mt('dialog.allowSoundboardDownloads'), mt('dialog.cancelSoundboardFolder')],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        });
        return result.response === 0 && !window.isDestroyed() && registry.isFrom(event, 'main');
      });
    } catch (error: unknown) {
      console.warn('[Soundboard] Could not authorize downloads in the configured folder:', error);
      throw new Error(mt('error.confirmSoundboardFolder'));
    }
    if (confirmed) await folders.allow('soundboard', folder);
    return confirmed;
  });
  registry.handle(SOUND_DOWNLOAD_IPC.authorize, { from: 'main', refused: INVALID_REQUEST },
    async (event, input) => soundDownloads.authorize(event.sender.id, input));
  registry.handle(SOUND_DOWNLOAD_IPC.download, { from: 'main', refused: INVALID_REQUEST }, async (event, input) => {
    try {
      return await soundDownloads.download(event.sender.id, input, (progress) => {
        sendEvent(event.sender, SOUND_DOWNLOAD_PROGRESS, progress);
      });
    } catch (error) {
      console.warn('[Soundboard] Could not clean up the local download:', error);
      return { status: 'failed', reason: 'write_failed' };
    }
  });
  registry.handle(SOUND_DOWNLOAD_IPC.cancel, { from: 'main', refused: false },
    (event, key) => soundDownloads.cancel(event.sender.id, key));
  registry.handle(AUDIO_PREVIEW_IPC.load, { from: 'main', refused: INVALID_REQUEST },
    async (event, input) => audioPreviews.load(event.sender.id, input));
  registry.handle(AUDIO_PREVIEW_IPC.cancel, { from: 'main', refused: false },
    (event, input) => audioPreviews.cancel(event.sender.id, input));
  const owner = window.webContents.id;
  const stopSoundDownloads = (): void => {
    soundDownloads.cancelOwner(owner);
    audioPreviews.cancelOwner(owner);
  };
  window.webContents.on('did-start-loading', stopSoundDownloads);
  window.webContents.on('render-process-gone', stopSoundDownloads);
  window.webContents.once('destroyed', stopSoundDownloads);
  registry.onDispose(stopSoundDownloads);

  // Soundboard Folder Selection
  registry.handle('dialog:select-soundboard-folder', 'main', async () => {
    const result = await dialog.showOpenDialog(window, {
      title: mt('dialog.selectSoundboardFolder'),
      properties: ['openDirectory'],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    let confirmed: string | null;
    try {
      confirmed = await soundDownloads.confirmFolder(result.filePaths[0]);
    } catch (error) {
      console.warn('[Soundboard] Could not persist the confirmed folder:', error);
      throw new Error(mt('error.confirmSoundboardFolder'));
    }
    if (confirmed) await folders.allow('soundboard', confirmed);
    return confirmed;
  });

  // Custom sound file selection (#7)
  registry.handle('dialog:select-sound-file', 'main', async () => {
    const result = await dialog.showOpenDialog(window, {
      title: mt('dialog.selectSoundFile'),
      filters: [
        { name: mt('dialog.audioFilter'), extensions: ['wav', 'mp3', 'ogg', 'webm'] },
      ],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const filePath = result.filePaths[0];
    const buffer = await fs.promises.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase().replace('.', '');
    const mime = ext === 'mp3' ? 'audio/mpeg' : ext === 'ogg' ? 'audio/ogg' : ext === 'webm' ? 'audio/webm' : 'audio/wav';
    const base64 = buffer.toString('base64');
    return `data:${mime};base64,${base64}`;
  });

  // Soundboard List Sounds
  registry.handle('soundboard:list-sounds', 'main', async (_event, folderPath, userAction) => {
    if (!folderPath || typeof folderPath !== 'string') {
      return [];
    }
    // The renderer shows remote content: only a folder confirmed natively is listed (D4).
    const access = await folders.request('soundboard', folderPath, userAction);
    if (access.status === 'missing') return [];
    if (access.status !== 'allowed') throw new Error('This sound folder was not confirmed on this computer.');
    try {
      const folderStat = await fs.promises.stat(folderPath).catch(() => null);
      if (!folderStat || !folderStat.isDirectory()) {
        return [];
      }
      const entries = await fs.promises.readdir(folderPath, { withFileTypes: true });
      const validExts = SOUNDBOARD_EXTENSIONS;
      
      const soundPromises = entries
        .filter((entry) => entry.isFile() && validExts.has(path.extname(entry.name).toLowerCase()))
        .map(async (entry) => {
          const ext = path.extname(entry.name).toLowerCase();
          const fullPath = path.join(folderPath, entry.name);
          const stat = await fs.promises.stat(fullPath);
          const displayName = path.basename(entry.name, ext);
          return {
            name: displayName,
            fileName: entry.name,
            filePath: fullPath,
            sizeBytes: stat.size,
            ext,
          };
        });

      const sounds = await Promise.all(soundPromises);
      sounds.sort((a, b) => a.name.localeCompare(b.name));
      return sounds;
    } catch (e) {
      console.warn('Error reading soundboard folder:', e);
      return [];
    }
  });

  // Soundboard Read Sound
  registry.handle('soundboard:read-sound', 'main', async (_event, filePath) => {
    if (!filePath || typeof filePath !== 'string') {
      return null;
    }
    // O caminho vem do renderer, então a extensão é conferida antes da leitura:
    // sem isso o canal devolvia o conteúdo de qualquer arquivo até 3 MB (#372).
    if (!SOUNDBOARD_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
      return null;
    }
    // ...e o arquivo precisa estar numa pasta confirmada pelo diálogo do sistema (D4).
    const soundFile = await folders.resolveFile('soundboard', filePath);
    if (!soundFile) return null;
    try {
      const stat = await fs.promises.stat(soundFile).catch(() => null);
      if (!stat || !stat.isFile()) {
        return null;
      }
      if (stat.size > LIMITS.MAX_SOUNDBOARD_FILE_SIZE) {
        throw new Error(mt('error.audioFileTooLarge'));
      }
      const buffer = await fs.promises.readFile(soundFile);
      const ext = path.extname(filePath).toLowerCase();
      let mime = 'audio/mpeg';
      if (ext === '.wav') mime = 'audio/wav';
      else if (ext === '.ogg') mime = 'audio/ogg';
      else if (ext === '.m4a') mime = 'audio/mp4';
      else if (ext === '.aac') mime = 'audio/aac';
      else if (ext === '.webm') mime = 'audio/webm';

      return {
        fileName: path.basename(filePath),
        soundName: path.basename(filePath, ext),
        mimeType: mime,
        base64: buffer.toString('base64'),
        dataUrl: `data:${mime};base64,${buffer.toString('base64')}`,
        sizeBytes: stat.size,
      };
    } catch (e: unknown) {
      console.warn('Error reading sound file:', e);
      return null;
    }
  });
}
