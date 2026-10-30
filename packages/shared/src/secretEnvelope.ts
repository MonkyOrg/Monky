import { z } from 'zod';

/**
 * Password-sealed envelope for exported secrets (#472): the identity code
 * carries the private key, and the servers/settings backup carries the
 * passwords of saved servers. The app seals and opens both, and `monky create`
 * opens identity codes. Both run this single WebCrypto implementation, so they
 * can never drift into reading different formats or weaker parameters (#490).
 *
 * Version 2 names its KDF and cost inside the envelope. Version 1 (implicit
 * PBKDF2-SHA256 with 210 000 iterations) still opens, so codes and backup files
 * exported by earlier versions keep working.
 */

export type SecretEnvelopeKind = 'identity' | 'backup';

/**
 * Readers released before #490 (the app and `monky create`) only know the
 * legacy prefixes and always derive with 210 000 iterations: under those
 * prefixes a version 2 envelope would fail as "wrong password". The current
 * prefixes make them answer "invalid code" instead; this version reads both.
 */
const PREFIXES: Record<SecretEnvelopeKind, { current: string; legacy: string }> = {
  identity: { current: 'MONKY-ID2:', legacy: 'MONKY-ID:' },
  backup: { current: 'MONKY-BACKUP2:', legacy: 'MONKY-BACKUP:' },
};

export const IDENTITY_EXPORT_PREFIX = PREFIXES.identity.current;
export const BACKUP_EXPORT_PREFIX = PREFIXES.backup.current;

/** OWASP's recommendation for PBKDF2-HMAC-SHA256. */
export const SECRET_ENVELOPE_PBKDF2_ITERATIONS = 600_000;
const LEGACY_PBKDF2_ITERATIONS = 210_000;
/** A crafted code must not keep the CPU busy for minutes. */
const MAX_PBKDF2_ITERATIONS = 2_000_000;
const PBKDF2_SHA256 = 'pbkdf2-sha256';
const TAG_BYTES = 16;

export const SECRET_PASSWORD_MIN_LENGTH = 8;

export type SecretPasswordProblem = 'too_short' | 'too_common';
export type SecretEnvelopeErrorCode =
  | SecretPasswordProblem
  | 'invalid'
  | 'invalid_content'
  | 'unsupported'
  | 'missing_password'
  | 'wrong_password';

/** Each side turns the code into a message in its own language. */
export class SecretEnvelopeError extends Error {
  constructor(readonly code: SecretEnvelopeErrorCode) {
    super(`Secret envelope error: ${code}`);
    this.name = 'SecretEnvelopeError';
  }
}

// Passwords people reach for first. Shorter ones already fail the length rule.
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password12', 'password123', 'passw0rd', 'p@ssw0rd', 'p@ssword', 'iloveyou', 'iloveyou1',
  'sunshine', 'princess', 'football', 'baseball', 'whatever', 'superman', 'starwars', 'trustno1', 'welcome1',
  'welcome123', 'letmein1', 'computer', 'internet', 'changeme', 'test1234', 'admin123', 'administrator',
  'master123', 'monkey123', 'dragon123', 'secret123', 'qwertyui', 'qwertyuiop', 'qwerty12', 'qwerty123',
  'qwerty1234', 'qwer1234', '1234qwer', 'asdfghjk', 'asdfghjkl', 'asdf1234', 'zxcvbnm1', 'zxcvbnm123', '1q2w3e4r',
  '1q2w3e4r5t', '1qaz2wsx', 'zaq12wsx', 'q1w2e3r4', 'q1w2e3r4t5', 'a1b2c3d4', 'abc12345', 'abcd1234', 'aa123456',
  '123qweasd', '11223344', '12341234', '123123123', '147258369', '123456789a', 'a123456789', '12345678910',
  'senha123', 'senha1234', 'senha12345', 'senhasenha', 'minhasenha', 'senhaforte', 'mudar123', 'trocar123',
  'brasil123', 'flamengo', 'flamengo1', 'flamengo123', 'corinthians', 'palmeiras', 'saopaulo', 'vasco123',
  'gremio123', 'cruzeiro', 'botafogo', 'fluminense', 'santos123', 'internacional', 'teamo123', 'euteamo1',
  'jesus123', 'jesuscristo', 'deusefiel', 'familia1', 'familia123', 'amor1234', 'meuamor1',
  'monkymonky', 'monky123', 'monky1234', 'monkyapp',
]);

function isStraightSequence(characters: string[]): boolean {
  const codes = characters.map((character) => character.codePointAt(0) ?? 0);
  const step = codes[1] - codes[0];
  return Math.abs(step) === 1 && codes.every((code, index) => index === 0 || code - codes[index - 1] === step);
}

/**
 * Minimum bar for a password that protects an exported secret: whoever gets
 * the code can guess offline, without any rate limit.
 */
export function secretPasswordProblem(password: string): SecretPasswordProblem | null {
  const normalized = password.trim().toLowerCase();
  const characters = Array.from(normalized);
  if (characters.length < SECRET_PASSWORD_MIN_LENGTH) return 'too_short';
  if (COMMON_PASSWORDS.has(normalized) || new Set(characters).size <= 2 || isStraightSequence(characters)) {
    return 'too_common';
  }
  return null;
}

const hexBytes = (min: number, max = min) => z.string()
  .regex(/^[0-9a-f]*$/i)
  .refine((value) => value.length % 2 === 0 && value.length >= min * 2 && value.length <= max * 2);
const sealedFields = {
  salt: hexBytes(16, 64),
  iv: hexBytes(12),
  tag: hexBytes(TAG_BYTES),
  ciphertext: hexBytes(1, Number.MAX_SAFE_INTEGER),
};
const legacyEnvelopeSchema = z.object({ version: z.literal(1).optional(), ...sealedFields });
const envelopeSchema = z.object({
  version: z.literal(2),
  kdf: z.literal(PBKDF2_SHA256),
  iterations: z.number().int().positive().max(MAX_PBKDF2_ITERATIONS),
  ...sealedFields,
});
type SealedEnvelope = Pick<z.infer<typeof envelopeSchema>, 'iterations' | 'salt' | 'iv' | 'tag' | 'ciphertext'>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function envelopePrefix(payload: string, kind: SecretEnvelopeKind): string | undefined {
  const { current, legacy } = PREFIXES[kind];
  return [current, legacy].find((prefix) => payload.startsWith(prefix));
}

/** True when `value` is an envelope of this kind in a format this version reads, e.g. a scanned QR code. */
export function isSecretEnvelope(value: string, kind: SecretEnvelopeKind): boolean {
  return envelopePrefix(value.trim(), kind) !== undefined;
}

function parseEnvelope(payload: string, kind: SecretEnvelopeKind): SealedEnvelope {
  const normalized = payload.trim();
  const prefix = envelopePrefix(normalized, kind);
  if (prefix === undefined) throw new SecretEnvelopeError('invalid');
  let decoded: unknown;
  try {
    decoded = JSON.parse(atob(normalized.slice(prefix.length).replace(/\s+/g, '')));
  } catch {
    throw new SecretEnvelopeError('invalid');
  }
  if (!isRecord(decoded)) throw new SecretEnvelopeError('invalid');
  if (decoded.version === undefined || decoded.version === 1) {
    const legacy = legacyEnvelopeSchema.safeParse(decoded);
    if (!legacy.success) throw new SecretEnvelopeError('invalid');
    return { ...legacy.data, iterations: LEGACY_PBKDF2_ITERATIONS };
  }
  if (decoded.version === 2) {
    const current = envelopeSchema.safeParse(decoded);
    if (current.success) return current.data;
    // A KDF or a cost this version does not know comes from a newer Monky.
    const newer = (typeof decoded.kdf === 'string' && decoded.kdf !== PBKDF2_SHA256) ||
      (typeof decoded.iterations === 'number' && decoded.iterations > MAX_PBKDF2_ITERATIONS);
    throw new SecretEnvelopeError(newer ? 'unsupported' : 'invalid');
  }
  throw new SecretEnvelopeError(typeof decoded.version === 'number' && decoded.version > 2 ? 'unsupported' : 'invalid');
}

const HEX = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, '0'));

function toHex(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += HEX[byte];
  return text;
}

/** Callers validate the digits first; 0-9 map from 48 and a-f/A-F (folded to lowercase) from 87. */
function hexDigit(code: number): number {
  return code <= 57 ? code - 48 : (code | 32) - 87;
}

function fromHex(text: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(text.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = (hexDigit(text.charCodeAt(index * 2)) << 4) | hexDigit(text.charCodeAt(index * 2 + 1));
  }
  return bytes;
}

/** PBKDF2 runs inside WebCrypto, off the main thread in Electron's main process and in Node. */
async function deriveKey(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number, usage: KeyUsage): Promise<CryptoKey> {
  const { subtle } = globalThis.crypto;
  const material = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, material, { name: 'AES-GCM', length: 256 }, false, [usage],
  );
}

/** Encrypts `plaintext` and returns `<prefix><base64 envelope>`; refuses passwords below the policy. */
export async function sealSecretEnvelope(plaintext: string, password: string, kind: SecretEnvelopeKind): Promise<string> {
  const problem = secretPasswordProblem(password);
  if (problem) throw new SecretEnvelopeError(problem);
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, SECRET_ENVELOPE_PBKDF2_ITERATIONS, 'encrypt');
  const sealed = new Uint8Array(await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext),
  ));
  const envelope = {
    version: 2,
    kdf: PBKDF2_SHA256,
    iterations: SECRET_ENVELOPE_PBKDF2_ITERATIONS,
    salt: toHex(salt),
    iv: toHex(iv),
    tag: toHex(sealed.subarray(sealed.length - TAG_BYTES)),
    ciphertext: toHex(sealed.subarray(0, sealed.length - TAG_BYTES)),
  };
  // Every field is ASCII, so btoa() encodes the JSON as is.
  return `${PREFIXES[kind].current}${btoa(JSON.stringify(envelope))}`;
}

/**
 * Reverses {@link sealSecretEnvelope} for both versions and both prefixes.
 * `invalid` means the payload is not an envelope of this kind at all and
 * `wrong_password` that it is one but does not open, so callers can tell
 * "wrong file" from "wrong password".
 */
export async function openSecretEnvelope(payload: string, password: string, kind: SecretEnvelopeKind): Promise<string> {
  const envelope = parseEnvelope(payload, kind);
  if (!password.trim()) throw new SecretEnvelopeError('missing_password');
  const key = await deriveKey(password, fromHex(envelope.salt), envelope.iterations, 'decrypt');
  const ciphertext = fromHex(envelope.ciphertext + envelope.tag);
  try {
    const plaintext = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromHex(envelope.iv) }, key, ciphertext);
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new SecretEnvelopeError('wrong_password');
  }
}

/** What an identity code carries; checking the key pair stays with each side's own crypto. */
export interface IdentityExportPayload {
  publicKey?: string;
  privateKeyDerBase64: string;
  /** Saved servers and settings exported with the identity (#472), opaque to the main process. */
  extras?: string;
  /** Friends and, optionally, DM history (#743). */
  dm?: unknown;
}

const identityExportPayloadSchema = z.object({
  publicKey: z.string().optional().catch(undefined),
  privateKeyDerBase64: z.string().min(1),
  extras: z.string().optional().catch(undefined),
  dm: z.unknown().optional(),
});

export function sealIdentityExport(payload: IdentityExportPayload, password: string): Promise<string> {
  return sealSecretEnvelope(JSON.stringify({ version: 1, ...payload }), password, 'identity');
}

export async function openIdentityExport(code: string, password: string): Promise<IdentityExportPayload> {
  const plaintext = await openSecretEnvelope(code, password, 'identity');
  let raw: unknown;
  try {
    raw = JSON.parse(plaintext);
  } catch {
    throw new SecretEnvelopeError('invalid_content');
  }
  const parsed = identityExportPayloadSchema.safeParse(raw);
  if (!parsed.success) throw new SecretEnvelopeError('invalid_content');
  return parsed.data;
}
