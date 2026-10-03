import type { DmFailure } from '@monky/shared';
import { t } from '../../i18n';
import { formatBytes } from '../../utils/attachment';

/** Turns a DM engine failure into a sentence in the app language. */
export function dmFailureMessage(failure: DmFailure, nickname: string): string {
  const details = failure.details ?? {};
  switch (failure.code) {
    case 'file-too-large': {
      const limit = typeof details.limit === 'number' ? details.limit : 0;
      const name = typeof details.name === 'string' ? details.name : '';
      const who = typeof details.nickname === 'string' && details.nickname ? details.nickname : nickname;
      return t('dm.errorFileTooLarge', { nickname: who, size: formatBytes(limit), name });
    }
    case 'too-many-files':
      return t('dm.errorTooManyFiles', { count: typeof details.limit === 'number' ? details.limit : 10 });
    case 'message-too-long':
      return t('dm.errorMessageTooLong', { count: typeof details.limit === 'number' ? details.limit : 4000 });
    case 'not-friend':
      return t('dm.errorNotFriend');
    case 'blocked':
      return t('dm.errorBlocked');
    case 'empty-message':
      return t('dm.errorEmpty');
    case 'not-found':
      return t('dm.errorNotFound');
    default:
      return t('dm.errorGeneric');
  }
}
