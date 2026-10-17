import type { FileBatchDownloadFile, FileBatchDownloadMode } from '@monky/shared';
import { t, tCount } from '../i18n';
import { showErrorToast, showSuccessToast } from '../views/CopyToast';
import { showConfirmWithChoice, type DialogChoice } from '../views/Dialog';

/** A server attachment by URL, or a DM attachment kept by the main process. */
export type DownloadableFile = FileBatchDownloadFile;

/**
 * Saves one file through the system dialog. A failure uses the shared toast,
 * which stays above the media viewer; a dialog would hide behind it (#406).
 */
export async function downloadSingleFile(url: string, fileName: string): Promise<void> {
  if (!window.api?.downloadFile) return;
  const result = await window.api.downloadFile(url, fileName);
  if (!result.success && result.error) {
    showErrorToast(t('chat.downloadFailedMessage', { error: result.error }), 7000);
  }
}

async function downloadOne(file: DownloadableFile): Promise<void> {
  if ('url' in file) {
    await downloadSingleFile(file.url, file.fileName);
    return;
  }
  const result = await window.api?.dm?.saveAttachment(file.dm.peer, file.dm.messageId, file.dm.fileId);
  if (result && !result.ok) showErrorToast(t('chat.downloadFailedMessage', { error: result.error.message }), 7000);
}

export async function downloadFileBatch(
  files: readonly DownloadableFile[],
  mode: FileBatchDownloadMode,
  archiveName: string,
): Promise<void> {
  if (!window.api?.downloadFiles) return;
  const result = await window.api.downloadFiles({
    mode, archiveName, files: files.map((file) => 'url' in file
      ? { url: file.url, fileName: file.fileName }
      : { dm: { ...file.dm }, fileName: file.fileName }),
  });
  if (result.status === 'saved') {
    showSuccessToast(tCount(mode === 'zip' ? 'chat.filesSavedZip' : 'chat.filesSaved', result.saved));
  } else if (result.status === 'failed') {
    showErrorToast(result.saved > 0
      ? t('chat.filesPartiallySaved', { saved: result.saved, total: files.length, error: result.error })
      : t('chat.downloadFailedMessage', { error: result.error }), 7000);
  }
}

type DownloadChoice = 'current' | FileBatchDownloadMode;

/**
 * Downloads `files`, asking first how when there are several: just `current`
 * (when given), all of them into a folder, or all of them in one ZIP.
 */
export async function downloadFilesWithChoice(
  files: readonly DownloadableFile[],
  archiveName: string,
  current?: DownloadableFile,
): Promise<void> {
  if (files.length === 0) return;
  if (files.length === 1) {
    await downloadOne(files[0]);
    return;
  }
  const count = files.length;
  const options: DialogChoice<DownloadChoice>[] = [
    ...(current ? [{
      value: 'current' as const, icon: 'download', label: t('chat.downloadOnlyCurrent'), description: current.fileName,
    }] : []),
    {
      value: 'folder', icon: 'folder_open', label: t('chat.downloadAllSeparate', { count }),
      description: t('chat.downloadAllSeparateHint'),
    },
    {
      value: 'zip', icon: 'folder_zip', label: t('chat.downloadAllZip', { count }),
      description: t('chat.downloadAllZipHint'),
    },
  ];
  const { confirmed, choice } = await showConfirmWithChoice<DownloadChoice>({
    title: t('chat.downloadChoiceTitle'),
    message: '',
    variant: 'info',
    confirmLabel: t('common.download'),
    choices: { legend: t('chat.downloadChoiceLegend', { count }), options, selected: options[0].value },
  });
  if (!confirmed) return;
  if (choice === 'current' && current) await downloadOne(current);
  else if (choice === 'folder' || choice === 'zip') await downloadFileBatch(files, choice, archiveName);
}
