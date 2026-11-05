import { dmCrypto, type DmGcmSealer } from './backend';
import { concatBytes, equalBytes, fromBase64, fromHex, fromUtf8, toBase64, toHex, utf8 } from './bytes';

/**
 * End-to-end crypto for friends and direct messages (#743).
 *
 * The identity is an Ed25519 key. DMs need key agreement, so every identity
 * deterministically derives an X25519 "DM key" from its Ed25519 seed (HKDF) and
 * publishes it inside a certificate signed by the identity key. All devices that
 * share the identity derive the same DM key, so any of them can read what is
 * addressed to the identity, including copies sent to itself.
 *
 * Envelopes use static-static ECDH -> HKDF -> AES-256-GCM with a random nonce;
 * the header (sender, recipient, id, type, time) is authenticated as AAD. The
 * relay server only ever sees the sealed string.
 *
 * The primitives come from the platform (`installDmCrypto`): the bytes are the
 * same on the desktop and in the browser.
 */

const ED25519_PKCS8_PREFIX = fromHex('302e020100300506032b657004220420');
const ED25519_SPKI_PREFIX_HEX = '302a300506032b6570032100';

const DM_KEY_SALT = utf8('monky-dm-key-v1');
const DM_KEY_INFO = utf8('x25519');
const STORE_KEY_SALT = utf8('monky-dm-store-v1');
const AEAD_INFO = utf8('monky-dm-aead-v1');
const CERT_DOMAIN = 'monky-dm-cert-v1\n';
const STATEMENT_DOMAIN = 'monky-dm-statement-v1\n';

export const DM_ENVELOPE_VERSION = 1;

export interface DmKeyCertificate {
  v: 1;
  /** Raw X25519 public key, lowercase hex (64 chars). */
  key: string;
  /** Ed25519 signature by the identity over the domain, identity and key. */
  sig: string;
}

export interface DmEnvelopeHeader {
  /** Sender identity public key (SPKI DER hex). */
  from: string;
  /** Recipient identity public key (SPKI DER hex). Equals `from` for self copies. */
  to: string;
  /** Unique id of this envelope (dedupe key). */
  id: string;
  /** Application message type. */
  type: string;
  /** Sender clock in ms. */
  ts: number;
}

/** The only part of an envelope the relay can read. */
export interface DmEnvelopeRoute {
  from: string;
  to: string;
}

interface SealedEnvelope {
  v: number;
  h: DmEnvelopeRoute;
  n: string;
  c: string;
}

export interface OpenedEnvelope<T = unknown> {
  header: DmEnvelopeHeader;
  body: T;
}

export class DmCryptoError extends Error {}

const HEX = /^[0-9a-f]+$/;

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => (entry === undefined ? 'null' : canonicalJson(entry))).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export function normalizeIdentityKey(value: string): string {
  return value.trim().toLowerCase();
}

export function isIdentityPublicKey(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const normalized = normalizeIdentityKey(value);
  return (
    normalized.length === ED25519_SPKI_PREFIX_HEX.length + 64 &&
    HEX.test(normalized) &&
    normalized.startsWith(ED25519_SPKI_PREFIX_HEX)
  );
}

/** Raw Ed25519 key inside an identity public key (SPKI DER hex). */
function identityRawKey(identityPublicKeyHex: string): Uint8Array {
  if (!isIdentityPublicKey(identityPublicKeyHex)) {
    throw new DmCryptoError('Chave de identidade inválida.');
  }
  return fromHex(normalizeIdentityKey(identityPublicKeyHex).slice(ED25519_SPKI_PREFIX_HEX.length));
}

function dmRawKey(rawHex: string): Uint8Array {
  if (typeof rawHex !== 'string' || rawHex.length !== 64 || !HEX.test(rawHex)) {
    throw new DmCryptoError('Chave de DM inválida.');
  }
  return fromHex(rawHex);
}

function certificateMessage(identityPublicKeyHex: string, dmKeyHex: string): Uint8Array {
  return utf8(`${CERT_DOMAIN}${normalizeIdentityKey(identityPublicKeyHex)}\n${dmKeyHex}`);
}

function statementMessage(identityPublicKeyHex: string, payload: unknown): Uint8Array {
  return utf8(`${STATEMENT_DOMAIN}${normalizeIdentityKey(identityPublicKeyHex)}\n${canonicalJson(payload)}`);
}

export function verifyDmCertificate(identityPublicKeyHex: string, certificate: unknown): certificate is DmKeyCertificate {
  try {
    const cert = certificate as DmKeyCertificate;
    if (!cert || cert.v !== 1 || typeof cert.key !== 'string' || typeof cert.sig !== 'string') {
      return false;
    }
    if (cert.key.length !== 64 || !HEX.test(cert.key) || cert.sig.length !== 128 || !HEX.test(cert.sig)) {
      return false;
    }
    return dmCrypto().ed25519Verify(
      identityRawKey(identityPublicKeyHex),
      certificateMessage(identityPublicKeyHex, cert.key),
      fromHex(cert.sig)
    );
  } catch {
    return false;
  }
}

/** Verifies a payload signed with {@link DmKeyring.signStatement}. */
export function verifyDmStatement(identityPublicKeyHex: string, payload: unknown, signatureHex: unknown): boolean {
  try {
    if (typeof signatureHex !== 'string' || signatureHex.length !== 128 || !HEX.test(signatureHex)) return false;
    return dmCrypto().ed25519Verify(
      identityRawKey(identityPublicKeyHex),
      statementMessage(identityPublicKeyHex, payload),
      fromHex(signatureHex)
    );
  } catch {
    return false;
  }
}

/** The 32-byte seed of an Ed25519 PKCS#8 key, the 48-byte form Node and WebCrypto both export. */
function extractEd25519Seed(privateKeyDer: Uint8Array): Uint8Array {
  if (
    privateKeyDer.length === ED25519_PKCS8_PREFIX.length + 32 &&
    equalBytes(privateKeyDer.subarray(0, ED25519_PKCS8_PREFIX.length), ED25519_PKCS8_PREFIX)
  ) {
    return privateKeyDer.slice(ED25519_PKCS8_PREFIX.length);
  }
  throw new DmCryptoError('A identidade não é uma chave Ed25519.');
}

function hkdf(input: Uint8Array, salt: Uint8Array, info: Uint8Array): Uint8Array {
  return dmCrypto().hkdf32(input, salt, info);
}

export function sha256Hex(data: Uint8Array | string): string {
  return toHex(dmCrypto().sha256().update(typeof data === 'string' ? utf8(data) : data).digest());
}

/** SHA-256 fed piece by piece; text is hashed as UTF-8, as Node's `createHash` does. */
export function createSha256(): { update(data: Uint8Array | string): ReturnType<typeof createSha256>; hex(): string } {
  const hash = dmCrypto().sha256();
  const hasher = {
    update(data: Uint8Array | string) {
      hash.update(typeof data === 'string' ? utf8(data) : data);
      return hasher;
    },
    hex: () => toHex(hash.digest()),
  };
  return hasher;
}

export class DmKeyring {
  readonly identityPublicKey: string;
  readonly dmPublicKey: string;
  private readonly identitySeed: Uint8Array;
  private readonly dmPrivateKey: Uint8Array;
  private readonly storeKey: Uint8Array;
  private readonly cert: DmKeyCertificate;
  private readonly sharedKeys = new Map<string, Uint8Array>();

  constructor(identityPublicKeyHex: string, identityPrivateKeyDerBase64: string) {
    const crypto = dmCrypto();
    this.identityPublicKey = normalizeIdentityKey(identityPublicKeyHex);
    const seed = extractEd25519Seed(fromBase64(identityPrivateKeyDerBase64));
    const derivedPublic = `${ED25519_SPKI_PREFIX_HEX}${toHex(crypto.ed25519PublicKey(seed))}`;
    if (derivedPublic !== this.identityPublicKey) {
      throw new DmCryptoError('A chave privada não corresponde à identidade.');
    }
    this.identitySeed = seed;
    this.dmPrivateKey = hkdf(seed, DM_KEY_SALT, DM_KEY_INFO);
    this.dmPublicKey = toHex(crypto.x25519PublicKey(this.dmPrivateKey));
    this.storeKey = hkdf(seed, STORE_KEY_SALT, utf8(this.identityPublicKey));
    this.cert = {
      v: 1,
      key: this.dmPublicKey,
      sig: toHex(crypto.ed25519Sign(seed, certificateMessage(this.identityPublicKey, this.dmPublicKey))),
    };
  }

  certificate(): DmKeyCertificate {
    return { ...this.cert };
  }

  /** Key that encrypts the local DM store at rest. Same on every device of the identity. */
  storageKey(): Uint8Array {
    return this.storeKey.slice();
  }

  signStatement(payload: unknown): string {
    return toHex(dmCrypto().ed25519Sign(this.identitySeed, statementMessage(this.identityPublicKey, payload)));
  }

  private sharedKey(peerIdentity: string, peerCert: DmKeyCertificate): Uint8Array {
    const peer = normalizeIdentityKey(peerIdentity);
    const cacheKey = `${peer}:${peerCert?.key}`;
    const cached = this.sharedKeys.get(cacheKey);
    if (cached) return cached;
    if (!verifyDmCertificate(peer, peerCert)) {
      throw new DmCryptoError('Certificado de DM inválido.');
    }
    const crypto = dmCrypto();
    const secret = crypto.x25519SharedSecret(this.dmPrivateKey, dmRawKey(peerCert.key));
    const identities = [this.identityPublicKey, peer].sort();
    const dmKeys = [this.dmPublicKey, peerCert.key].sort();
    const salt = crypto.sha256().update(utf8(`monky-dm-v1\n${identities.join('\n')}\n${dmKeys.join('\n')}`)).digest();
    const key = hkdf(secret, salt, AEAD_INFO);
    this.sharedKeys.set(cacheKey, key);
    return key;
  }

  /**
   * Encrypts `body` for `peerIdentity`. Only sender and recipient stay visible
   * to the relay; id, type and time travel inside the ciphertext. Use the own
   * identity/cert to address the other own devices.
   */
  seal(
    peerIdentity: string,
    peerCert: DmKeyCertificate,
    header: Pick<DmEnvelopeHeader, 'id' | 'type' | 'ts'>,
    body: unknown
  ): string {
    const route: DmEnvelopeRoute = { from: this.identityPublicKey, to: normalizeIdentityKey(peerIdentity) };
    const inner: InnerEnvelope = { i: header.id, t: header.type, s: header.ts, b: body ?? null };
    const crypto = dmCrypto();
    const nonce = crypto.randomBytes(12);
    const ciphertext = crypto.aesGcmSeal(this.sharedKey(route.to, peerCert), nonce, utf8(JSON.stringify(inner)), envelopeAad(route));
    const sealed: SealedEnvelope = {
      v: DM_ENVELOPE_VERSION,
      h: route,
      n: toBase64(nonce),
      c: toBase64(ciphertext),
    };
    return JSON.stringify(sealed);
  }

  /** Reads the visible route without decrypting, so the caller can look up the sender's certificate. */
  static peekRoute(sealed: string): DmEnvelopeRoute {
    return parseSealed(sealed).h;
  }

  /**
   * Decrypts an envelope. `relayFrom` is the sender the server stamped; it must
   * match the authenticated route, and `peerCert` must be that sender's
   * certificate (the own one for copies from other own devices).
   */
  open<T = unknown>(sealed: string, relayFrom: string, peerCert: DmKeyCertificate): OpenedEnvelope<T> {
    const parsed = parseSealed(sealed);
    const from = parsed.h.from;
    if (from !== normalizeIdentityKey(relayFrom)) {
      throw new DmCryptoError('Remetente do envelope não confere.');
    }
    if (parsed.h.to !== this.identityPublicKey) {
      throw new DmCryptoError('Envelope não endereçado a esta identidade.');
    }
    let payload: Uint8Array;
    let nonce: Uint8Array;
    try {
      payload = fromBase64(parsed.c);
      nonce = fromBase64(parsed.n);
    } catch {
      throw new DmCryptoError('Envelope de DM inválido.');
    }
    if (nonce.length !== 12 || payload.length < 16) {
      throw new DmCryptoError('Envelope de DM inválido.');
    }
    const key = this.sharedKey(from, peerCert);
    let plaintext: Uint8Array;
    try {
      plaintext = dmCrypto().aesGcmOpen(key, nonce, payload, envelopeAad(parsed.h));
    } catch {
      throw new DmCryptoError('Não foi possível abrir o envelope de DM.');
    }
    let inner: InnerEnvelope;
    try {
      inner = JSON.parse(fromUtf8(plaintext)) as InnerEnvelope;
    } catch {
      throw new DmCryptoError('Conteúdo de DM inválido.');
    }
    if (
      !inner ||
      typeof inner.i !== 'string' ||
      inner.i.length === 0 ||
      inner.i.length > 128 ||
      typeof inner.t !== 'string' ||
      inner.t.length === 0 ||
      inner.t.length > 64 ||
      typeof inner.s !== 'number' ||
      !Number.isFinite(inner.s)
    ) {
      throw new DmCryptoError('Conteúdo de DM inválido.');
    }
    return {
      header: { from, to: parsed.h.to, id: inner.i, type: inner.t, ts: inner.s },
      body: inner.b as T,
    };
  }
}

interface InnerEnvelope {
  i: string;
  t: string;
  s: number;
  b: unknown;
}

function envelopeAad(route: DmEnvelopeRoute): Uint8Array {
  return utf8(canonicalJson({ v: DM_ENVELOPE_VERSION, from: route.from, to: route.to }));
}

function parseSealed(sealed: string): SealedEnvelope {
  let parsed: SealedEnvelope;
  try {
    parsed = JSON.parse(sealed) as SealedEnvelope;
  } catch {
    throw new DmCryptoError('Envelope de DM inválido.');
  }
  const route = parsed?.h;
  if (
    !parsed ||
    parsed.v !== DM_ENVELOPE_VERSION ||
    !route ||
    !isIdentityPublicKey(route.from) ||
    !isIdentityPublicKey(route.to) ||
    typeof parsed.n !== 'string' ||
    typeof parsed.c !== 'string'
  ) {
    throw new DmCryptoError('Envelope de DM inválido.');
  }
  return { v: parsed.v, h: { from: normalizeIdentityKey(route.from), to: normalizeIdentityKey(route.to) }, n: parsed.n, c: parsed.c };
}
/** AES-256-GCM helpers for the local store (`MKDM1` + nonce + ciphertext + tag). */
const STORE_MAGIC = utf8('MKDM1');

export function sealAtRest(key: Uint8Array, plaintext: Uint8Array, label: string): Uint8Array {
  const crypto = dmCrypto();
  const nonce = crypto.randomBytes(12);
  return concatBytes(STORE_MAGIC, nonce, crypto.aesGcmSeal(key, nonce, plaintext, utf8(label)));
}

/**
 * The same bytes as {@link sealAtRest}, produced piece by piece: a large file
 * never needs a second copy of itself in memory. The tag goes last, after
 * every piece; a piece source that throws stops the output before it.
 */
export function* sealAtRestStream(key: Uint8Array, pieces: Iterable<Uint8Array>, label: string): Generator<Uint8Array> {
  const crypto = dmCrypto();
  const nonce = crypto.randomBytes(12);
  const sealer: DmGcmSealer = crypto.aesGcmSealer(key, nonce, utf8(label));
  yield concatBytes(STORE_MAGIC, nonce);
  for (const piece of pieces) yield sealer.update(piece);
  yield sealer.final();
}

export function openAtRest(key: Uint8Array, data: Uint8Array, label: string): Uint8Array {
  if (data.length < STORE_MAGIC.length + 12 + 16 || !equalBytes(data.subarray(0, STORE_MAGIC.length), STORE_MAGIC)) {
    throw new DmCryptoError('Arquivo de DM inválido.');
  }
  const nonce = data.subarray(STORE_MAGIC.length, STORE_MAGIC.length + 12);
  try {
    return dmCrypto().aesGcmOpen(key, nonce, data.subarray(STORE_MAGIC.length + 12), utf8(label));
  } catch {
    throw new DmCryptoError('Arquivo de DM corrompido.');
  }
}

export function newDmId(): string {
  return toHex(dmCrypto().randomBytes(16));
}
