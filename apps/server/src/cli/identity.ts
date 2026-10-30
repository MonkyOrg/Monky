import { createPrivateKey, createPublicKey } from 'crypto';
import {
  SecretEnvelopeError, deriveClientIdFromPublicKey, isSecretEnvelope, normalizePublicKeyHex, openIdentityExport,
  type IdentityExportPayload, type SecretEnvelopeErrorCode,
} from '@monky/shared';
import { t, type CliTranslationKey } from './i18n/index';

export interface DecryptedIdentity {
  publicKey: string;
  clientId: string;
  privateKeyDerBase64: string;
}

function messageKey(code: SecretEnvelopeErrorCode): CliTranslationKey {
  switch (code) {
    case 'missing_password': return 'identity.noPassword';
    case 'wrong_password': return 'identity.wrongPassword';
    case 'unsupported': return 'identity.unsupportedVersion';
    case 'invalid_content': return 'identity.invalidDecrypted';
    // Only sealing checks the password policy; opening never reports it.
    default: return 'identity.invalidContent';
  }
}

/**
 * Opens an identity code exported by the app, current (`MONKY-ID2:`) or from
 * before #490 (`MONKY-ID:`). The envelope format and its KDF come from
 * `@monky/shared`, the same code the app seals with (#490), so a stronger KDF
 * in the app can never break `monky create` silently.
 */
export async function decryptIdentityExport(exportedIdentity: string, password: string): Promise<DecryptedIdentity> {
  if (!isSecretEnvelope(exportedIdentity, 'identity')) {
    throw new Error(t('identity.invalidCode'));
  }
  let payload: IdentityExportPayload;
  try {
    payload = await openIdentityExport(exportedIdentity, password);
  } catch (error) {
    if (error instanceof SecretEnvelopeError) throw new Error(t(messageKey(error.code)));
    throw error;
  }

  let publicKey: string;
  try {
    const privateKey = createPrivateKey({
      key: Buffer.from(payload.privateKeyDerBase64, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
    publicKey = normalizePublicKeyHex(createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('hex'));
  } catch {
    throw new Error(t('identity.invalidDecrypted'));
  }

  if (payload.publicKey && normalizePublicKeyHex(payload.publicKey) !== publicKey) {
    throw new Error(t('identity.keyMismatch'));
  }

  return {
    publicKey,
    clientId: deriveClientIdFromPublicKey(publicKey),
    privateKeyDerBase64: payload.privateKeyDerBase64,
  };
}
