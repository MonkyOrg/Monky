import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  KeyObject,
  randomBytes,
  sign,
  verify,
} from 'crypto';

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
 */

const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

const DM_KEY_SALT = Buffer.from('monky-dm-key-v1', 'utf8');
const DM_KEY_INFO = Buffer.from('x25519', 'utf8');
const STORE_KEY_SALT = Buffer.from('monky-dm-store-v1', 'utf8');
const AEAD_INFO = Buffer.from('monky-dm-aead-v1', 'utf8');
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
    normalized.length === ED25519_SPKI_PREFIX.length * 2 + 64 &&
    HEX.test(normalized) &&
    normalized.startsWith(ED25519_SPKI_PREFIX.toString('hex'))
  );
}

function identityPublicKeyObject(identityPublicKeyHex: string): KeyObject {
  if (!isIdentityPublicKey(identityPublicKeyHex)) {
    throw new DmCryptoError('Chave de identidade inválida.');
  }
  return createPublicKey({
    key: Buffer.from(normalizeIdentityKey(identityPublicKeyHex), 'hex'),
    format: 'der',
    type: 'spki',
  });
}

function dmPublicKeyObject(rawHex: string): KeyObject {
  if (typeof rawHex !== 'string' || rawHex.length !== 64 || !HEX.test(rawHex)) {
    throw new DmCryptoError('Chave de DM inválida.');
  }
  return createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, Buffer.from(rawHex, 'hex')]),
    format: 'der',
    type: 'spki',
  });
}

function certificateMessage(identityPublicKeyHex: string, dmKeyHex: string): Buffer {
  return Buffer.from(`${CERT_DOMAIN}${normalizeIdentityKey(identityPublicKeyHex)}\n${dmKeyHex}`, 'utf8');
}

function statementMessage(identityPublicKeyHex: string, payload: unknown): Buffer {
  return Buffer.from(
    `${STATEMENT_DOMAIN}${normalizeIdentityKey(identityPublicKeyHex)}\n${canonicalJson(payload)}`,
    'utf8'
  );
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
    return verify(
      null,
      certificateMessage(identityPublicKeyHex, cert.key),
      identityPublicKeyObject(identityPublicKeyHex),
      Buffer.from(cert.sig, 'hex')
    );
  } catch {
    return false;
  }
}

/** Verifies a payload signed with {@link DmKeyring.signStatement}. */
export function verifyDmStatement(identityPublicKeyHex: string, payload: unknown, signatureHex: unknown): boolean {
  try {
    if (typeof signatureHex !== 'string' || signatureHex.length !== 128 || !HEX.test(signatureHex)) return false;
    return verify(
      null,
      statementMessage(identityPublicKeyHex, payload),
      identityPublicKeyObject(identityPublicKeyHex),
      Buffer.from(signatureHex, 'hex')
    );
  } catch {
    return false;
  }
}

function extractEd25519Seed(privateKey: KeyObject, privateKeyDer: Buffer): Buffer {
  if (
    privateKeyDer.length === ED25519_PKCS8_PREFIX.length + 32 &&
    privateKeyDer.subarray(0, ED25519_PKCS8_PREFIX.length).equals(ED25519_PKCS8_PREFIX)
  ) {
    return Buffer.from(privateKeyDer.subarray(ED25519_PKCS8_PREFIX.length));
  }
  const jwk = privateKey.export({ format: 'jwk' });
  if (jwk.crv !== 'Ed25519' || typeof jwk.d !== 'string') {
    throw new DmCryptoError('A identidade não é uma chave Ed25519.');
  }
  return Buffer.from(jwk.d, 'base64url');
}

function hkdf(input: Buffer, salt: Buffer, info: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', input, salt, info, 32));
}

export class DmKeyring {
  readonly identityPublicKey: string;
  readonly dmPublicKey: string;
  private readonly identityPrivateKey: KeyObject;
  private readonly dmPrivateKey: KeyObject;
  private readonly storeKey: Buffer;
  private readonly cert: DmKeyCertificate;
  private readonly sharedKeys = new Map<string, Buffer>();

  constructor(identityPublicKeyHex: string, identityPrivateKeyDerBase64: string) {
    this.identityPublicKey = normalizeIdentityKey(identityPublicKeyHex);
    const privateKeyDer = Buffer.from(identityPrivateKeyDerBase64, 'base64');
    this.identityPrivateKey = createPrivateKey({ key: privateKeyDer, format: 'der', type: 'pkcs8' });
    const derivedPublic = createPublicKey(this.identityPrivateKey)
      .export({ format: 'der', type: 'spki' })
      .toString('hex');
    if (derivedPublic !== this.identityPublicKey) {
      throw new DmCryptoError('A chave privada não corresponde à identidade.');
    }

    const seed = extractEd25519Seed(this.identityPrivateKey, privateKeyDer);
    const dmSeed = hkdf(seed, DM_KEY_SALT, DM_KEY_INFO);
    this.dmPrivateKey = createPrivateKey({
      key: Buffer.concat([X25519_PKCS8_PREFIX, dmSeed]),
      format: 'der',
      type: 'pkcs8',
    });
    const dmSpki = createPublicKey(this.dmPrivateKey).export({ format: 'der', type: 'spki' });
    this.dmPublicKey = dmSpki.subarray(X25519_SPKI_PREFIX.length).toString('hex');
    this.storeKey = hkdf(seed, STORE_KEY_SALT, Buffer.from(this.identityPublicKey, 'utf8'));
    this.cert = {
      v: 1,
      key: this.dmPublicKey,
      sig: sign(null, certificateMessage(this.identityPublicKey, this.dmPublicKey), this.identityPrivateKey).toString('hex'),
    };
  }

  certificate(): DmKeyCertificate {
    return { ...this.cert };
  }

  /** Key that encrypts the local DM store at rest. Same on every device of the identity. */
  storageKey(): Buffer {
    return Buffer.from(this.storeKey);
  }

  signStatement(payload: unknown): string {
    return sign(null, statementMessage(this.identityPublicKey, payload), this.identityPrivateKey).toString('hex');
  }

  private sharedKey(peerIdentity: string, peerCert: DmKeyCertificate): Buffer {
    const peer = normalizeIdentityKey(peerIdentity);
    const cacheKey = `${peer}:${peerCert?.key}`;
    const cached = this.sharedKeys.get(cacheKey);
    if (cached) return cached;
    if (!verifyDmCertificate(peer, peerCert)) {
      throw new DmCryptoError('Certificado de DM inválido.');
    }
    const secret = diffieHellman({ privateKey: this.dmPrivateKey, publicKey: dmPublicKeyObject(peerCert.key) });
    const identities = [this.identityPublicKey, peer].sort();
    const dmKeys = [this.dmPublicKey, peerCert.key].sort();
    const salt = createHash('sha256')
      .update(`monky-dm-v1\n${identities.join('\n')}\n${dmKeys.join('\n')}`, 'utf8')
      .digest();
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
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.sharedKey(route.to, peerCert), nonce);
    cipher.setAAD(envelopeAad(route));
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify(inner), 'utf8')),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    const sealed: SealedEnvelope = {
      v: DM_ENVELOPE_VERSION,
      h: route,
      n: nonce.toString('base64'),
      c: ciphertext.toString('base64'),
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
    const payload = Buffer.from(parsed.c, 'base64');
    const nonce = Buffer.from(parsed.n, 'base64');
    if (nonce.length !== 12 || payload.length < 16) {
      throw new DmCryptoError('Envelope de DM inválido.');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.sharedKey(from, peerCert), nonce);
    decipher.setAAD(envelopeAad(parsed.h));
    decipher.setAuthTag(payload.subarray(payload.length - 16));
    let plaintext: Buffer;
    try {
      plaintext = Buffer.concat([decipher.update(payload.subarray(0, payload.length - 16)), decipher.final()]);
    } catch {
      throw new DmCryptoError('Não foi possível abrir o envelope de DM.');
    }
    let inner: InnerEnvelope;
    try {
      inner = JSON.parse(plaintext.toString('utf8')) as InnerEnvelope;
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

function envelopeAad(route: DmEnvelopeRoute): Buffer {
  return Buffer.from(canonicalJson({ v: DM_ENVELOPE_VERSION, from: route.from, to: route.to }), 'utf8');
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
const STORE_MAGIC = Buffer.from('MKDM1', 'utf8');

export function sealAtRest(key: Buffer, plaintext: Buffer, label: string): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(label, 'utf8'));
  return Buffer.concat([STORE_MAGIC, nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

export function openAtRest(key: Buffer, data: Buffer, label: string): Buffer {
  if (data.length < STORE_MAGIC.length + 12 + 16 || !data.subarray(0, STORE_MAGIC.length).equals(STORE_MAGIC)) {
    throw new DmCryptoError('Arquivo de DM inválido.');
  }
  const nonce = data.subarray(STORE_MAGIC.length, STORE_MAGIC.length + 12);
  const body = data.subarray(STORE_MAGIC.length + 12, data.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(label, 'utf8'));
  decipher.setAuthTag(data.subarray(data.length - 16));
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new DmCryptoError('Arquivo de DM corrompido.');
  }
}

export function newDmId(): string {
  return randomBytes(16).toString('hex');
}
