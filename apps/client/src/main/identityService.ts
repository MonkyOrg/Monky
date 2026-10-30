import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'crypto';
import { app, safeStorage } from 'electron';
import fs from 'fs';
import path from 'path';
import {
  SecretEnvelopeError, deriveClientIdFromPublicKey, normalizePublicKeyHex, openIdentityExport, sealIdentityExport,
  type AppIdentityStatus, type IdentityUnreadableReason,
} from '@monky/shared';
import { fileErrorCode, renameFileSync, writeFileAtomicSync } from './atomicFile';
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

/**
 * What an import did. `confirm-replace`: the code belongs to another identity
 * than the one in use, and nothing was written; importing again with
 * `replace` set to that public key switches to it.
 */
export type IdentityImportOutcome =
  | (AppIdentityImport & { status: 'imported' })
  | (AppIdentity & { status: 'confirm-replace' });

interface LoadedIdentity extends AppIdentity {
  privateKeyDerBase64: string;
}

/**
 * The identity exists but cannot be used now (or there is none yet). It is
 * never answered by generating another identity: that would cost the user
 * their account on every server, their friends and their DM history.
 */
export class IdentityUnavailableError extends Error {
  constructor(readonly reason: IdentityUnreadableReason | 'missing') {
    super(reason === 'missing'
      ? 'Nenhuma identidade neste computador.'
      : `Não foi possível abrir a identidade salva (${reason}).`);
    this.name = 'IdentityUnavailableError';
  }
}

/**
 * `detail` is what goes to the log: an error code or name, never the message
 * of a JSON error, which quotes the file (and with it the private key).
 */
type StoredIdentity =
  | { kind: 'missing' }
  | { kind: 'ready'; identity: LoadedIdentity }
  | { kind: 'unreadable'; reason: IdentityUnreadableReason; detail: string };

/**
 * Read once and kept in memory: signing on every (re)connection must not
 * depend on reading the disk and the system keychain again, where a passing
 * failure used to look like "no identity".
 */
let loaded: LoadedIdentity | null = null;

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

/** The stored form of `identity`: the private key goes through the system keychain whenever there is one. */
function encodeIdentity(identity: LoadedIdentity): string {
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

  return JSON.stringify(record, null, 2);
}

function persistIdentity(identity: LoadedIdentity): void {
  writeFileAtomicSync(getIdentityFilePath(), encodeIdentity(identity));
}

function isStoredIdentityRecord(value: unknown): value is StoredIdentityRecord {
  return typeof value === 'object' && value !== null
    && 'publicKey' in value && typeof value.publicKey === 'string' && value.publicKey.length > 0
    && 'privateKey' in value && typeof value.privateKey === 'string' && value.privateKey.length > 0
    && 'storage' in value && (value.storage === 'safeStorage' || value.storage === 'plain');
}

/** Reads the file as it is now. Only a file that does not exist counts as "no identity". */
function readStoredIdentity(): StoredIdentity {
  let raw: string;
  try {
    raw = fs.readFileSync(getIdentityFilePath(), 'utf8');
  } catch (error) {
    const code = fileErrorCode(error);
    return code === 'ENOENT' ? { kind: 'missing' } : { kind: 'unreadable', reason: 'io', detail: code ?? 'read failed' };
  }

  let record: unknown;
  try {
    record = JSON.parse(raw);
  } catch {
    return { kind: 'unreadable', reason: 'corrupt', detail: 'invalid JSON' };
  }
  if (!isStoredIdentityRecord(record)) return { kind: 'unreadable', reason: 'corrupt', detail: 'missing fields' };

  let privateKeyDerBase64 = record.privateKey;
  if (record.storage === 'safeStorage') {
    try {
      privateKeyDerBase64 = safeStorage.decryptString(Buffer.from(record.privateKey, 'base64'));
    } catch (error) {
      return { kind: 'unreadable', reason: 'locked', detail: error instanceof Error ? error.message : String(error) };
    }
  }

  try {
    const identity = createIdentityFromPrivateKey(privateKeyDerBase64);
    if (identity.publicKey === normalizePublicKeyHex(record.publicKey)) return { kind: 'ready', identity };
  } catch {
    // Falls through: a key that does not parse is as unusable as one that does not match.
  }
  return { kind: 'unreadable', reason: 'corrupt', detail: 'key mismatch' };
}

function loadIdentity(): StoredIdentity {
  if (loaded) return { kind: 'ready', identity: loaded };
  const stored = readStoredIdentity();
  if (stored.kind === 'ready') loaded = stored.identity;
  else if (stored.kind === 'unreadable') console.error(`[Identity] The stored identity is unreadable (${stored.reason}: ${stored.detail}).`);
  return stored;
}

function readyIdentity(stored: StoredIdentity): LoadedIdentity {
  if (stored.kind === 'ready') return stored.identity;
  throw new IdentityUnavailableError(stored.kind === 'missing' ? 'missing' : stored.reason);
}

function requireIdentity(): LoadedIdentity {
  return readyIdentity(loadIdentity());
}

/** A free `identity.<kind>-<time>.json` next to identity.json, for a copy that must not be lost. */
function asidePath(kind: 'unreadable' | 'replaced'): string {
  const directory = path.dirname(getIdentityFilePath());
  const stamp = `identity.${kind}-${Date.now()}`;
  let aside = path.join(directory, `${stamp}.json`);
  for (let copy = 1; fs.existsSync(aside); copy += 1) aside = path.join(directory, `${stamp}-${copy}.json`);
  return aside;
}

/**
 * Writes `identity` as the identity of this computer, never losing the one it
 * replaces: a file that could not be read is renamed to
 * `identity.unreadable-<time>.json`, so it can still be recovered if, say, the
 * keychain opens it again later; another identity in use is first saved as
 * `identity.replaced-<time>.json`.
 */
function storeIdentity(identity: LoadedIdentity, current: StoredIdentity = loadIdentity()): void {
  if (current.kind === 'unreadable') {
    renameFileSync(getIdentityFilePath(), asidePath('unreadable'));
  } else if (current.kind === 'ready' && current.identity.publicKey !== identity.publicKey) {
    // Written from memory and synced before identity.json changes, so a crash in between loses neither.
    writeFileAtomicSync(asidePath('replaced'), encodeIdentity(current.identity));
  }
  persistIdentity(identity);
  loaded = identity;
}

function generateIdentity(): LoadedIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyHex = normalizePublicKeyHex(publicKey.export({ format: 'der', type: 'spki' }).toString('hex'));
  const privateKeyDerBase64 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  return {
    publicKey: publicKeyHex,
    clientId: deriveClientIdFromPublicKey(publicKeyHex),
    privateKeyDerBase64,
  };
}

function createFrom(current: StoredIdentity): LoadedIdentity {
  if (current.kind === 'ready') return current.identity;
  const identity = generateIdentity();
  storeIdentity(identity, current);
  return identity;
}

function publicIdentity(identity: LoadedIdentity): AppIdentity {
  return { publicKey: identity.publicKey, clientId: identity.clientId };
}

export function getIdentityStatus(): AppIdentityStatus {
  const stored = loadIdentity();
  if (stored.kind === 'unreadable') return { state: 'unreadable', reason: stored.reason };
  return { state: stored.kind };
}

export function hasIdentity(): boolean {
  return getIdentityStatus().state === 'ready';
}

/**
 * Every file that may hold this computer's private key: identity.json, the
 * copies kept aside when it was replaced or could not be read, and the
 * temporary files an interrupted write leaves next to any of them.
 */
function isIdentityFileName(name: string): boolean {
  const target = /^\.(.+)\.[0-9a-f]+\.tmp$/.exec(name)?.[1] ?? name;
  return /^identity(?:\.(?:unreadable|replaced)-\d+(?:-\d+)?)?\.json$/.test(target);
}

/**
 * Logout: removes the stored identity and every copy of its key; the next
 * launch asks for a new or imported one. The copies go first, so a file that
 * cannot be removed leaves the account as it was for another try.
 */
export function deleteIdentity(): void {
  const filePath = getIdentityFilePath();
  const directory = path.dirname(filePath);
  let names: string[] = [];
  try {
    names = fs.readdirSync(directory);
  } catch (error) {
    if (fileErrorCode(error) !== 'ENOENT') throw error;
  }
  for (const name of names) {
    if (name !== IDENTITY_FILE_NAME && isIdentityFileName(name)) fs.rmSync(path.join(directory, name), { force: true });
  }
  fs.rmSync(filePath, { force: true });
  loaded = null;
}

/**
 * The user asked for a new identity: generates one unless a readable identity
 * exists (then that one is kept and returned). An unreadable file is set aside.
 */
export function createIdentity(): AppIdentity {
  return publicIdentity(createFrom(loadIdentity()));
}

/**
 * The current identity. With `createIfMissing`, a computer that has none gets
 * one; an identity that exists but cannot be read throws instead.
 */
export function getIdentity(createIfMissing?: true): AppIdentity;
export function getIdentity(createIfMissing: boolean): AppIdentity | null;
export function getIdentity(createIfMissing = true): AppIdentity | null {
  const stored = loadIdentity();
  if (stored.kind === 'missing') return createIfMissing ? publicIdentity(createFrom(stored)) : null;
  return publicIdentity(readyIdentity(stored));
}

export function getClientId(): string {
  return requireIdentity().clientId;
}

export function signChallenge(nonceHex: string): string {
  if (!/^[a-fA-F0-9]{64}$/.test(nonceHex)) {
    throw new Error('Nonce inválido.');
  }

  const identity = requireIdentity();
  const privateKey = createPrivateKey({
    key: Buffer.from(identity.privateKeyDerBase64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });

  return sign(null, Buffer.from(nonceHex, 'hex'), privateKey).toString('hex');
}

/**
 * Keyring for friends/DMs (#743), derived from the identity seed. Main-process
 * only: the private key never reaches the renderer. Null without an identity.
 */
export function createDmKeyring(): DmKeyring | null {
  const stored = loadIdentity();
  if (stored.kind === 'missing') return null;
  const identity = readyIdentity(stored);
  return new DmKeyring(identity.publicKey, identity.privateKeyDerBase64);
}

/** Seals the identity in the format that `monky create` also reads (#490). */
export async function exportIdentity(password: string, extras?: string, dm?: unknown): Promise<string> {
  const identity = requireIdentity();
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

/**
 * Imports an exported identity. When this computer already uses another
 * identity, nothing is written until the user confirms: the call answers
 * `confirm-replace`, and importing again with `replace` set to the public key
 * it named switches identities, keeping the previous one aside.
 */
export async function importIdentity(
  exportedIdentity: string, password: string, replace?: string,
): Promise<IdentityImportOutcome> {
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
  const current = loadIdentity();
  if (current.kind === 'ready' && current.identity.publicKey !== identity.publicKey && replace !== identity.publicKey) {
    return { status: 'confirm-replace', ...publicIdentity(identity) };
  }
  storeIdentity(identity, current);
  return {
    status: 'imported',
    publicKey: identity.publicKey,
    clientId: identity.clientId,
    extras,
    dm,
  };
}
