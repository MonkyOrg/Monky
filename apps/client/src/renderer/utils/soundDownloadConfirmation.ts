import { soundDownloadFileNameSchema, type SoundDownloadRequest } from '@monky/shared';
import { settingsStore } from '../stores/settingsStore';
import { showConfirmWithText } from '../views/Dialog';
import { t } from '../i18n';
import { botPreferenceScope, type BotPreferenceScope } from './botPreferenceScope';

export interface SoundDownloadConfirmationDetails extends BotPreferenceScope {
  serverName: string;
  botName: string;
  folder: string;
  request: SoundDownloadRequest;
}

export interface SoundDownloadApproval {
  fileName: string;
}

export const soundDownloadConfirmationScope = botPreferenceScope;

let queue = Promise.resolve();

export function confirmSoundDownload(details: SoundDownloadConfirmationDetails, signal: AbortSignal): Promise<SoundDownloadApproval | null> {
  const confirmation = queue.then(async () => {
    if (signal.aborted) return null;
    const scope = soundDownloadConfirmationScope(details);
    if (scope && settingsStore.botDownloadConfirmationExceptions.includes(scope)) return { fileName: details.request.fileName };
    const extensionIndex = details.request.fileName.lastIndexOf('.');
    const extension = details.request.fileName.slice(extensionIndex);
    const validateName = (value: string): string | undefined =>
      soundDownloadFileNameSchema.safeParse(`${value}${extension}`).success ? undefined : t('botChat.downloadInvalidName');
    const options = {
      title: t('botChat.downloadConfirmTitle'),
      message: [
        t('botChat.downloadConfirmMessage', { bot: details.botName }),
        details.serverName,
        details.request.title,
        t('botChat.downloadConfirmFile', { file: details.request.fileName }),
        t('botChat.downloadConfirmFolderPath', { folder: details.folder }),
        t('botChat.downloadConfirmSource', { host: new URL(details.request.url).host }),
      ].filter(Boolean).join('\n'),
      confirmLabel: t('botChat.downloadConfirmAccept'),
      signal,
      requireUserGesture: true,
      textInput: {
        label: t('botChat.downloadRenameLabel'),
        value: details.request.fileName.slice(0, extensionIndex),
        suffix: extension,
        hint: t('botChat.downloadRenameHint', { extension }),
        maxLength: 128 - extension.length,
        validate: validateName,
      },
      checkboxLabel: scope ? t('botChat.downloadDontAskAgain') : undefined,
      checkboxHint: t('botChat.downloadDontAskAgainHint'),
    };
    const result = await showConfirmWithText(options);
    if (signal.aborted || !result.confirmed) return null;
    if (validateName(result.value)) throw new Error('The confirmed sound file name is invalid.');
    if (scope && result.checked) settingsStore.suppressBotDownloadConfirmation(scope);
    return { fileName: `${result.value}${extension}` };
  });
  // A failure is reported to its caller but must not block later confirmation dialogs.
  queue = confirmation.then(() => undefined, () => undefined);
  return confirmation;
}
