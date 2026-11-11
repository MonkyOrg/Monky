import {
  SecretEnvelopeError, deriveClientIdFromPublicKey, memberAuthChallenge, normalizePublicKeyHex, openIdentityExport,
  sealIdentityExport, serverAuthChallenge, serverChallengeBindingSchema,
  nicknameSchema,
  type AppIdentityImportOutcome, type AppIdentityResult, type AppIdentityStatus, type ServerChallengeBinding,
  type SignChallengeResult,
} from '@monky/shared';
import { base64ToBytes, bytesToBase64 } from './webFiles';
import { secretEnvelopeError } from './webSecretEnvelope';
import { deleteRecord, listRecordKeys, readRecord, writeRecord } from './webStorage';

/**
 * The identity of the web version (#858): the same Ed25519 key as the desktop
 * (`main/identityService.ts`), kept in IndexedDB.
 *
 * The private key (PKCS#8, the format the desktop export carries) is stored
 * encrypted with an AES-GCM key that the browser generated as non-extractable:
 * a copy of the site's files is not enough to read it, and no password is asked
 * to open the app. The password is only for exporting, as on the desktop.
 */
const IDENTITY_RECORD = 'identity';

interface StoredWebIdentity {
  version: 1;
  publicKey: string;
  /** Non-extractable AES-GCM key that seals `sealedPrivateKey`. */
  wrappingKey: CryptoKey;
  iv: Uint8Array;
  sealedPrivateKey: ArrayBuffer;
}

interface LoadedWebIdentity extends AppIdentityResult {
  signingKey: CryptoKey;
  privateKeyDer: Uint8Array;
}

type WebIdentityState =
  | { kind: 'missing' }
  | { kind: 'ready'; identity: LoadedWebIdentity }
  | { kind: 'unreadable'; reason: 'locked' | 'corrupt' | 'io' };

const ED25519 = { name: 'Ed25519' } as const;

let loaded: LoadedWebIdentity | null = null;
let guestIdentity: LoadedWebIdentity | null = null;
let guestBase: WebIdentityState | null = null;

function toHex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function isStoredWebIdentity(value: unknown): value is StoredWebIdentity {
  return typeof value === 'object' && value !== null
    && 'version' in value && value.version === 1
    && 'publicKey' in value && typeof value.publicKey === 'string'
    && 'wrappingKey' in value && value.wrappingKey instanceof CryptoKey
    && 'iv' in value && value.iv instanceof Uint8Array
    && 'sealedPrivateKey' in value && value.sealedPrivateKey instanceof ArrayBuffer;
}

/** Opens a PKCS#8 Ed25519 key and the public key it belongs to (SPKI DER, hex, as the desktop writes it). */
async function openPrivateKey(privateKeyDer: Uint8Array<ArrayBuffer>): Promise<LoadedWebIdentity> {
  const extractable = await crypto.subtle.importKey('pkcs8', privateKeyDer, ED25519, true, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', extractable);
  if (!jwk.x) throw new Error('Ed25519 key without public part');
  const publicJwk: JsonWebKey = { kty: jwk.kty, crv: jwk.crv, x: jwk.x };
  const publicKey = await crypto.subtle.importKey('jwk', publicJwk, ED25519, true, ['verify']);
  const publicKeyHex = normalizePublicKeyHex(toHex(await crypto.subtle.exportKey('spki', publicKey)));
  return {
    publicKey: publicKeyHex,
    clientId: deriveClientIdFromPublicKey(publicKeyHex),
    signingKey: await crypto.subtle.importKey('pkcs8', privateKeyDer, ED25519, false, ['sign']),
    privateKeyDer,
  };
}

async function readIdentity(): Promise<WebIdentityState> {
  if (guestIdentity) return { kind: 'ready', identity: guestIdentity };
  if (loaded) return { kind: 'ready', identity: loaded };
  let record: unknown;
  try {
    record = await readRecord(IDENTITY_RECORD);
  } catch {
    return { kind: 'unreadable', reason: 'io' };
  }
  if (record === undefined) return { kind: 'missing' };
  if (!isStoredWebIdentity(record)) return { kind: 'unreadable', reason: 'corrupt' };
  let privateKeyDer: Uint8Array<ArrayBuffer>;
  try {
    privateKeyDer = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(record.iv) }, record.wrappingKey, record.sealedPrivateKey,
    ));
  } catch {
    return { kind: 'unreadable', reason: 'locked' };
  }
  try {
    const identity = await openPrivateKey(privateKeyDer);
    if (identity.publicKey !== normalizePublicKeyHex(record.publicKey)) return { kind: 'unreadable', reason: 'corrupt' };
    loaded = identity;
    return { kind: 'ready', identity };
  } catch {
    return { kind: 'unreadable', reason: 'corrupt' };
  }
}

async function sealIdentity(identity: LoadedWebIdentity): Promise<StoredWebIdentity> {
  const wrappingKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealedPrivateKey = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrappingKey, new Uint8Array(identity.privateKeyDer));
  return { version: 1, publicKey: identity.publicKey, wrappingKey, iv, sealedPrivateKey };
}

/** A free `identity.<kind>-<time>` record, for a copy that must not be lost. */
async function asideKey(kind: 'unreadable' | 'replaced'): Promise<string> {
  const used = new Set(await listRecordKeys());
  const stamp = `${IDENTITY_RECORD}.${kind}-${Date.now()}`;
  let key = stamp;
  for (let copy = 1; used.has(key); copy += 1) key = `${stamp}-${copy}`;
  return key;
}

/**
 * Writes `identity` as the identity of this browser without losing the one it
 * replaces, as the desktop does: a record that could not be read, or another
 * identity in use, is first kept aside under `identity.<kind>-<time>`.
 */
async function storeIdentity(identity: LoadedWebIdentity, current: WebIdentityState): Promise<void> {
  current = guestBase ?? current;
  if (current.kind === 'unreadable') {
    const unreadable = await readRecord(IDENTITY_RECORD);
    if (unreadable !== undefined) await writeRecord(await asideKey('unreadable'), unreadable);
  } else if (current.kind === 'ready' && current.identity.publicKey !== identity.publicKey) {
    await writeRecord(await asideKey('replaced'), await sealIdentity(current.identity));
  }
  await writeRecord(IDENTITY_RECORD, await sealIdentity(identity));
  loaded = identity;
  guestIdentity = null;
  guestBase = null;
}

async function requireIdentity(): Promise<LoadedWebIdentity> {
  const state = await readIdentity();
  if (state.kind !== 'ready') throw new Error(state.kind === 'missing' ? 'No identity in this browser.' : `The saved identity could not be opened (${state.reason}).`);
  return state.identity;
}

function publicIdentity(identity: LoadedWebIdentity): AppIdentityResult {
  return { publicKey: identity.publicKey, clientId: identity.clientId,
    ...(identity.guest ? { guest: true, nickname: identity.nickname } : {}) };
}
export async function createWebGuestIdentity(nickname: string): Promise<AppIdentityResult> {
  const name = nicknameSchema.parse(nickname);
  const state = await readIdentity();
  if (state.kind === 'ready') throw new Error('Sign out before entering as a guest.');
  const pair = await crypto.subtle.generateKey(ED25519, true, ['sign', 'verify']);
  guestIdentity = { ...await openPrivateKey(new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))),
    guest: true, nickname: name };
  guestBase = state;
  return publicIdentity(guestIdentity);
}

/** Logout: removes the identity and every copy kept aside; the next load asks for a new or imported one. */
export async function deleteWebIdentity(): Promise<void> {
  if (guestIdentity) { guestIdentity = null; guestBase = null; return; }
  const copies = (await listRecordKeys()).filter(key => key.startsWith(`${IDENTITY_RECORD}.`));
  for (const key of copies) await deleteRecord(key);
  await deleteRecord(IDENTITY_RECORD);
  loaded = null;
}

export async function getWebIdentityStatus(): Promise<AppIdentityStatus> {
  const state = await readIdentity();
  return state.kind === 'unreadable' ? { state: 'unreadable', reason: state.reason } : { state: state.kind };
}

/** Creates an identity unless a readable one exists, which is kept and returned. */
export async function createWebIdentity(): Promise<AppIdentityResult> {
  const state = await readIdentity();
  if (state.kind === 'ready') return publicIdentity(state.identity);
  const pair = await crypto.subtle.generateKey(ED25519, true, ['sign', 'verify']);
  const identity = await openPrivateKey(new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey)));
  await storeIdentity(identity, state);
  return publicIdentity(identity);
}

/** Seals the identity in the format the desktop and `monky create` also read (#490). */
export async function exportWebIdentity(password: string, extras?: string, dm?: unknown): Promise<string> {
  if (guestIdentity) throw new Error('Temporary guest identities cannot be exported.');
  const identity = await requireIdentity();
  try {
    return await sealIdentityExport({
      publicKey: identity.publicKey,
      privateKeyDerBase64: bytesToBase64(identity.privateKeyDer),
      extras: extras && extras.length > 0 ? extras : undefined,
      dm: dm ?? undefined,
    }, password);
  } catch (error) {
    throw secretEnvelopeError(error, 'identity');
  }
}

/**
 * Imports an exported identity. When this browser already uses another one,
 * nothing is written until the person confirms: the call answers
 * `confirm-replace`, and importing again with `replace` set to that public key
 * switches identities, keeping the previous one aside. `dm` is the friends
 * and history the code carried, for the DM store of the imported identity.
 */
export async function importWebIdentity(
  code: string, password: string, replace?: string,
): Promise<{ outcome: AppIdentityImportOutcome; dm?: unknown }> {
  let identity: LoadedWebIdentity;
  let extras: string | undefined;
  let dm: unknown;
  try {
    const payload = await openIdentityExport(code, password);
    extras = payload.extras;
    dm = payload.dm;
    try {
      identity = await openPrivateKey(base64ToBytes(payload.privateKeyDerBase64));
    } catch {
      throw new SecretEnvelopeError('invalid_content');
    }
  } catch (error) {
    throw secretEnvelopeError(error, 'identity');
  }
  const current = await readIdentity();
  if (current.kind === 'ready' && current.identity.publicKey !== identity.publicKey && replace !== identity.publicKey) {
    return { outcome: { status: 'confirm-replace', ...publicIdentity(identity) } };
  }
  await storeIdentity(identity, current);
  return { outcome: { status: 'imported', ...publicIdentity(identity), extras }, dm };
}

export async function getWebIdentity(): Promise<AppIdentityResult> {
  return publicIdentity(await requireIdentity());
}

export async function getWebClientId(): Promise<string> {
  return (await requireIdentity()).clientId;
}

/** The key DMs derive theirs from; stays inside the web platform, as it stays in Main on the desktop. */
export async function webIdentitySecret(): Promise<{ publicKey: string; privateKeyDerBase64: string; guest?: boolean } | null> {
  const state = await readIdentity();
  return state.kind === 'ready'
    ? { publicKey: state.identity.publicKey, privateKeyDerBase64: bytesToBase64(state.identity.privateKeyDer), guest: state.identity.guest }
    : null;
}

async function verifyServerProof(nonceHex: string, serverKey: string, serverSignature: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('spki', fromHex(serverKey), ED25519, false, ['verify']);
    return await crypto.subtle.verify(ED25519, key, fromHex(serverSignature), new TextEncoder().encode(serverAuthChallenge(nonceHex, serverKey)));
  } catch {
    return false;
  }
}

/** Same contract as the desktop `signChallenge`, including the server-key binding (#821). */
export async function signWebChallenge(nonceHex: string, binding?: ServerChallengeBinding): Promise<SignChallengeResult> {
  if (typeof nonceHex !== 'string' || !/^[a-fA-F0-9]{64}$/.test(nonceHex)) throw new Error('Invalid nonce.');
  const identity = await requireIdentity();
  if (binding === undefined) {
    return { signature: toHex(await crypto.subtle.sign(ED25519, identity.signingKey, fromHex(nonceHex))) };
  }
  const { serverKey, serverSignature } = serverChallengeBindingSchema.parse(binding);
  if (!await verifyServerProof(nonceHex, serverKey, serverSignature)) return { refused: 'server-signature' };
  const challenge = new TextEncoder().encode(memberAuthChallenge(nonceHex, serverKey));
  return { signature: toHex(await crypto.subtle.sign(ED25519, identity.signingKey, challenge)) };
}
