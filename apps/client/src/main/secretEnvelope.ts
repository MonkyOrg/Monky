import {
  SECRET_PASSWORD_MIN_LENGTH,
  SecretEnvelopeError,
  openSecretEnvelope,
  sealSecretEnvelope,
  type SecretEnvelopeErrorCode,
  type SecretEnvelopeKind,
} from '@monky/shared';
import { mt, type MainTranslationKey } from './i18n';

/**
 * Main-process side of the password-sealed envelope (#472) that protects the
 * identity export and the servers/settings backup. Its format, KDF and
 * password policy live in `@monky/shared`, shared with `monky create` (#490);
 * this file only words the failures in the app language.
 */
const MESSAGES: Record<SecretEnvelopeKind, Record<SecretEnvelopeErrorCode, MainTranslationKey>> = {
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
  return new Error(mt(MESSAGES[kind][error.code], { min: String(SECRET_PASSWORD_MIN_LENGTH) }));
}

export async function sealBackup(contents: string, password: string): Promise<string> {
  try {
    return await sealSecretEnvelope(contents, password, 'backup');
  } catch (error) {
    throw secretEnvelopeError(error, 'backup');
  }
}

export async function openBackup(payload: string, password: string): Promise<string> {
  try {
    return await openSecretEnvelope(payload, password, 'backup');
  } catch (error) {
    throw secretEnvelopeError(error, 'backup');
  }
}
