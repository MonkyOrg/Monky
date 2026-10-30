import { app, dialog, type BrowserWindow } from 'electron';
import path from 'node:path';
import { MEDIA_FOLDERS_IPC } from '@monky/shared';
import { mt } from '../i18n';
import { MediaFolderAccess, type MediaFolderCheck, type MediaFolderPurpose } from '../mediaFolders';
import type { IpcRegistry } from './registry';

/** Sound and sticker folders are read only once confirmed natively (D4). */
export interface MediaFolderConsent {
  /** Remembers a folder Main itself created or confirmed: the default one, or one chosen in the system dialog. */
  allow(purpose: MediaFolderPurpose, folder: unknown): Promise<void>;
  /**
   * Whether `folder` may be read. A folder in the settings that this profile never confirmed (restored
   * from a backup, or chosen in another version) is offered natively instead of staying blocked, and only
   * when the person opens it themselves (`userAction`).
   */
  request(purpose: MediaFolderPurpose, folder: string, userAction: unknown): Promise<MediaFolderCheck>;
  /** The real file behind `file`, when it lies directly inside a confirmed folder. */
  resolveFile(purpose: MediaFolderPurpose, file: unknown): Promise<string | null>;
}

/** Registers the one-time adoption of the folders already configured, and returns the consent the readers use. */
export function registerMediaFoldersIpc(registry: IpcRegistry, window: BrowserWindow): MediaFolderConsent {
  const access = new MediaFolderAccess(path.join(app.getPath('userData'), 'media-folders.json'));
  const ask = (purpose: MediaFolderPurpose) => async (folder: string): Promise<boolean> => {
    if (window.isDestroyed()) return false;
    const stickers = purpose === 'stickers';
    const { response } = await dialog.showMessageBox(window, {
      type: 'question',
      title: mt(stickers ? 'dialog.confirmStickersReadTitle' : 'dialog.confirmSoundsReadTitle'),
      message: mt(stickers ? 'dialog.confirmStickersReadMessage' : 'dialog.confirmSoundsReadMessage'),
      detail: mt('dialog.confirmMediaFolderDetail', { folder }),
      buttons: [mt('dialog.allowMediaFolder'), mt('dialog.notNowMediaFolder')],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    return response === 0 && !window.isDestroyed();
  };

  registry.handle(MEDIA_FOLDERS_IPC.adopt, 'main', async (_event, folders) => {
    try {
      await access.adoptConfigured(folders);
    } catch (error: unknown) {
      console.warn('[MediaFolders] Could not keep the folders configured before confirmation was required:', error);
    }
  });

  return {
    async allow(purpose, folder) {
      try {
        await access.allow(purpose, folder);
      } catch (error: unknown) {
        console.warn(`[MediaFolders] Could not remember the confirmed ${purpose} folder:`, error);
      }
    },
    request: (purpose, folder, userAction) =>
      access.requestFolder(purpose, folder, userAction === true ? ask(purpose) : undefined),
    resolveFile: (purpose, file) => access.resolveFile(purpose, file),
  };
}
