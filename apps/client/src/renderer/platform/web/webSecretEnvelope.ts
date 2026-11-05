import {
  SECRET_PASSWORD_MIN_LENGTH, SecretEnvelopeError, openSecretEnvelope, sealSecretEnvelope,
  type SecretEnvelopeErrorCode, type SecretEnvelopeKind,
} from '@monky/shared';
import { t, type TranslationKey } from '../../i18n';

/**
 * The web side of the password-sealed envelope (#472): the format, KDF and
 * password policy are the shared ones, so a code sealed here opens on the
 * desktop and in `monky create`, and the other way round. Only the wording of
 * the failures lives here, as `main/secretEnvelope.ts` does for the desktop.
 */
const MESSAGES: Record<SecretEnvelopeKind, Record<SecretEnvelopeErrorCode, TranslationKey>> = {
  identity: {
    invalid: 'secret.identityInvalid',
    invalid_content: 'secret.identityInvalid',
    unsupported: 'secret.identityUnsupported',
    wrong_password: 'secret.identityWrongPassword',
    missing_password: 'secret.passwordMissing',
    too_short: 'secret.passwordTooShort',
    too_common: 'secret.passwordTooCommon',
  },
  backup: {
    invalid: 'secret.backupInvalid',
    invalid_content: 'secret.backupInvalid',
    unsupported: 'secret.backupUnsupported',
    wrong_password: 'secret.backupWrongPassword',
    missing_password: 'secret.passwordMissing',
    too_short: 'secret.passwordTooShort',
    too_common: 'secret.passwordTooCommon',
  },
};

export function secretEnvelopeError(error: unknown, kind: SecretEnvelopeKind): Error {
  if (!(error instanceof SecretEnvelopeError)) return error instanceof Error ? error : new Error(String(error));
  return new Error(t(MESSAGES[kind][error.code], { min: String(SECRET_PASSWORD_MIN_LENGTH) }));
}

export async function sealWebBackup(contents: string, password: string): Promise<string> {
  try {
    return await sealSecretEnvelope(contents, password, 'backup');
  } catch (error) {
    throw secretEnvelopeError(error, 'backup');
  }
}

export async function openWebBackup(payload: string, password: string): Promise<string> {
  try {
    return await openSecretEnvelope(payload, password, 'backup');
  } catch (error) {
    throw secretEnvelopeError(error, 'backup');
  }
}
