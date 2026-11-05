import { t } from '../i18n';
import { platformSupports } from './capabilities';

export type MediaKind = 'soundboard' | 'stickers';

/** How a soundboard or sticker folder is shown: a desktop path as is, a web folder by its name. */
export function mediaFolderLabel(folder: string): string {
  return folder ? window.api?.describeMediaFolder?.(folder) ?? folder : '';
}

/** Whether media comes from a folder the user picks; otherwise "choose folder" adds files to the browser. */
export function picksMediaFolder(): boolean {
  return platformSupports('mediaFolderPicker');
}

/** Icon and label of the button that sets where the media comes from. */
export function mediaSourceButton(kind: MediaKind, folderLabel: string): { icon: string; label: string } {
  return picksMediaFolder()
    ? { icon: 'folder_open', label: folderLabel }
    : { icon: 'upload_file', label: t(kind === 'soundboard' ? 'media.addSounds' : 'media.addStickers') };
}
