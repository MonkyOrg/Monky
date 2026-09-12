import type { SoundDownloadFailureReason, SoundDownloadResult } from '@monky/shared';
import { t, type TranslationKey } from '../i18n';

const FAILURE_KEYS: Record<SoundDownloadFailureReason, TranslationKey> = {
  no_folder: 'botChat.downloadNoFolder',
  invalid_request: 'botChat.downloadInvalidRequest',
  invalid_url: 'botChat.downloadInvalidUrl',
  blocked_url: 'botChat.downloadBlockedUrl',
  invalid_file_name: 'botChat.downloadInvalidName',
  unsupported_audio: 'botChat.downloadUnsupported',
  too_large: 'botChat.downloadTooLarge',
  http_error: 'botChat.downloadHttpError',
  network_error: 'botChat.downloadNetworkError',
  write_failed: 'botChat.downloadWriteFailed',
  timeout: 'botChat.downloadTimeout',
};

export function soundDownloadText(result: SoundDownloadResult): string {
  if (result.status === 'downloaded') return t('botChat.downloadSaved');
  if (result.status === 'exists') return t('botChat.downloadExists');
  if (result.status === 'cancelled') return t('botChat.downloadCancelled');
  return t(FAILURE_KEYS[result.reason]);
}
