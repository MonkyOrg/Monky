import { SECRET_PASSWORD_MIN_LENGTH, secretPasswordProblem } from '@monky/shared';
import { t } from '../i18n';
import { showErrorToast } from './CopyToast';

/** Explains, under the field, the policy that protects an exported identity or backup (#490). */
export function exportPasswordHint(): string {
  return t('backup.passwordHint', { min: SECRET_PASSWORD_MIN_LENGTH });
}

/**
 * Applies the policy the main process enforces before the password reaches it:
 * marks the field and explains in a toast when the password does not pass.
 */
export function acceptExportPassword(input: HTMLInputElement): boolean {
  const problem = secretPasswordProblem(input.value);
  if (!problem) {
    input.removeAttribute('aria-invalid');
    return true;
  }
  input.setAttribute('aria-invalid', 'true');
  input.focus();
  showErrorToast(problem === 'too_short'
    ? t('backup.passwordTooShort', { min: SECRET_PASSWORD_MIN_LENGTH })
    : t('backup.passwordTooCommon'));
  return false;
}
