import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'crypto';
import { app, safeStorage } from 'electron';
import fs from 'fs';
import path from 'path';
import {
  SecretEnvelopeError, deriveClientIdFromPublicKey, normalizePublicKeyHex, openIdentityExport, sealIdentityExport,
} from '@monky/shared';
import { secretEnvelopeError } from './secretEnvelope';
import { DmKeyring } from './dm/dmCrypto';

const IDENTITY_FILE_NAME = 'identity.json';

interface StoredIdentityRecord {
  version: 1;
  publicKey: string;
  privateKey: string;
  storage: 'safeStorage' | 'plain';
}

export interface AppIdentity {
  publicKey: string;
  clientId: string;
}

/** An import may carry the servers/settings backup exported alongside it (#472). */
export interface AppIdentityImport extends AppIdentity {
  extras?: string;
  /** Friends (and optionally DM history) exported with the identity (#743). Main-process only. */
  dm?: unknown;
}

interface LoadedIdentity extends AppIdentity {
  privateKeyDerBase64: string;
}

function getIdentityFilePath(): string {
  return path.join(app.getPath('userData'), IDENTITY_FILE_NAME);
}

function createIdentityFromPrivateKey(privateKeyDerBase64: string): LoadedIdentity {
  const privateKey = createPrivateKey({
    key: Buffer.from(privateKeyDerBase64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = normalizePublicKeyHex(
    createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('hex')
  );
  return {
    publicKey,
    clientId: deriveClientIdFromPublicKey(publicKey),
    privateKeyDerBase64,
  };
}

function persistIdentity(identity: LoadedIdentity): void {
  const filePath = getIdentityFilePath();
  const storage = safeStorage.isEncryptionAvailable() ? 'safeStorage' : 'plain';
  const privateKey =
    storage === 'safeStorage'
      ? safeStorage.encryptString(identity.privateKeyDerBase64).toString('base64')
      : identity.privateKeyDerBase64;

  const record: StoredIdentityRecord = {
    version: 1,
    publicKey: identity.publicKey,
    privateKey,
    storage,
  };

  fs.writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf8');
}

function loadStoredIdentity(): LoadedIdentity | null {
  const filePath = getIdentityFilePath();
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const record = JSON.parse(raw) as StoredIdentityRecord;
  if (!record?.publicKey || !record?.privateKey) {
    return null;
  }

  const privateKeyDerBase64 =
    record.storage === 'safeStorage'
      ? safeStorage.decryptString(Buffer.from(record.privateKey, 'base64'))
      : record.privateKey;

  const identity = createIdentityFromPrivateKey(privateKeyDerBase64);
  if (identity.publicKey !== normalizePublicKeyHex(record.publicKey)) {
    throw new Error('A identidade armazenada está corrompida.');
  }

  return identity;
}

function generateIdentity(): LoadedIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyHex = normalizePublicKeyHex(publicKey.export({ format: 'der', type: 'spki' }).toString('hex'));
  const privateKeyDerBase64 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  const identity = {
    publicKey: publicKeyHex,
    clientId: deriveClientIdFromPublicKey(publicKeyHex),
    privateKeyDerBase64,
  };
  persistIdentity(identity);
  return identity;
}

function ensureIdentity(): LoadedIdentity {
  try {
    return loadStoredIdentity() ?? generateIdentity();
  } catch {
    return generateIdentity();
  }
}

export function hasIdentity(): boolean {
  try {
    return loadStoredIdentity() !== null;
  } catch {
    return false;
  }
}

/** Logout: removes the stored identity; the next launch asks for a new or imported one. */
export function deleteIdentity(): void {
  fs.rmSync(getIdentityFilePath(), { force: true });
}

export function getIdentity(createIfMissing = true): AppIdentity | null {
  const identity = createIfMissing ? ensureIdentity() : loadStoredIdentity();
  if (!identity) return null;
  return {
    publicKey: identity.publicKey,
    clientId: identity.clientId,
  };
}

export function getClientId(): string {
  return ensureIdentity().clientId;
}

export function signChallenge(nonceHex: string): string {
  if (!/^[a-fA-F0-9]{64}$/.test(nonceHex)) {
    throw new Error('Nonce inválido.');
  }

  const identity = ensureIdentity();
  const privateKey = createPrivateKey({
    key: Buffer.from(identity.privateKeyDerBase64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });

  return sign(null, Buffer.from(nonceHex, 'hex'), privateKey).toString('hex');
}

/**
 * Keyring for friends/DMs (#743), derived from the identity seed. Main-process
 * only: the private key never reaches the renderer.
 */
export function createDmKeyring(): DmKeyring | null {
  const identity = loadStoredIdentity();
  if (!identity) return null;
  return new DmKeyring(identity.publicKey, identity.privateKeyDerBase64);
}

/** Seals the identity in the format that `monky create` also reads (#490). */
export async function exportIdentity(password: string, extras?: string, dm?: unknown): Promise<string> {
  const identity = ensureIdentity();
  try {
    return await sealIdentityExport({
      publicKey: identity.publicKey,
      privateKeyDerBase64: identity.privateKeyDerBase64,
      // Saved servers and app settings ride along inside the same encrypted
      // envelope (#472). The main process never inspects them: the renderer owns
      // the format and hands over an opaque string.
      extras: extras && extras.length > 0 ? extras : undefined,
      dm: dm ?? undefined,
    }, password);
  } catch (error) {
    throw secretEnvelopeError(error, 'identity');
  }
}

export async function importIdentity(exportedIdentity: string, password: string): Promise<AppIdentityImport> {
  let identity: LoadedIdentity;
  let extras: string | undefined;
  let dm: unknown;
  try {
    const payload = await openIdentityExport(exportedIdentity, password);
    extras = payload.extras;
    dm = payload.dm;
    try {
      identity = createIdentityFromPrivateKey(payload.privateKeyDerBase64);
    } catch {
      throw new SecretEnvelopeError('invalid_content');
    }
  } catch (error) {
    throw secretEnvelopeError(error, 'identity');
  }
  persistIdentity(identity);
  return {
    publicKey: identity.publicKey,
    clientId: identity.clientId,
    extras,
    dm,
  };
}
