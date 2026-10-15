import { LIMITS, getNicknameIssue } from '@monky/shared';
import { t } from '../i18n';

/**
 * Why an up-to-date server would refuse this nickname, in the app language, or
 * `null` when it is accepted. Checked before saving or connecting so the person
 * learns what to change instead of meeting a failed connection (#567).
 */
export function nicknameError(nickname: string): string | null {
  switch (getNicknameIssue(nickname)) {
    case 'too_short': return t('identity.nicknameTooShort', { min: LIMITS.MIN_NICKNAME_LENGTH });
    case 'too_long': return t('identity.nicknameTooLong', { max: LIMITS.MAX_NICKNAME_LENGTH });
    case 'invalid_characters': return t('identity.nicknameInvalidCharacters');
    case null: return null;
  }
}
