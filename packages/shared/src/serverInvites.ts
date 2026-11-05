import { z } from 'zod';
import { deflateSync, Inflate } from 'fflate';
import { ED25519_SPKI_PUBLIC_KEY_DER_PREFIX_HEX } from './constants.js';
import { serverPublicKeySchema } from './serverAuth.js';

// A dedicated page, not the docs home: link previews (WhatsApp, Discord…) never
// receive the fragment, so the page itself must carry the invitation card.
export const SERVER_INVITE_WEB_URL = 'https://monkyorg.github.io/Monky/convite/';
const SERVER_INVITE_WEB_URL_EN = 'https://monkyorg.github.io/Monky/en/convite/';
// Links shared before the dedicated page keep opening from the docs home.
const SERVER_INVITE_WEB_PATHS = new Set(['/Monky', '/Monky/en', '/Monky/convite', '/Monky/en/convite']
  .flatMap(base => [base, `${base}/`, `${base}/index.html`]));
export type ServerInviteLanguage = 'pt-BR' | 'en';
export const SERVER_INVITE_SCHEME = 'monky';
export const SERVER_INVITE_FRAGMENT_PREFIX = '~';
export const MAX_SERVER_INVITE_LENGTH = 16384;
const MAX_INVITE_BYTES = 4800;
// This is part of the invitation format, not a configurable server default.
const INVITE_DEFAULT_PORT = 3000;
const encoder = new TextEncoder();
// A leading U+FEFF belongs to the field, including when that field is a password.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

class InviteSizeError extends Error {}

/**
 * The extension: fields that older apps must not trip on. The header has no bit
 * left and older readers refuse leftover body bytes, but they stop inflating at
 * the end of the deflate stream, so the extension follows it, in an invitation
 * that is then always compressed:
 *
 *   deflate stream | fields | flags (1) | fields length (1) | "M" "K" | version (1)
 *
 * Each flag bit announces a field, and the fields go in bit order. A field with
 * no bytes (`tls`) is the bit alone. A reader that does not know a bit skips it:
 * the length tells where the stream ends, and the fields it knows come first.
 */
const EXTENSION_MARKER = [0x4d, 0x4b, 1] as const;
const EXTENSION_TAIL = 2 + EXTENSION_MARKER.length;
const EXTENSION_TLS = 1;
/** The 32 raw bytes of the server's Ed25519 key (server-key-auth, #821); the SPKI prefix is the same for every server. */
const EXTENSION_SERVER_KEY = 2;
const SERVER_KEY_BYTES = 32;

type InviteExtension = Pick<ServerInvite, 'tls' | 'serverKey'>;

function inviteExtension(invite: ServerInvite): number[] | null {
  let flags = 0;
  const fields: number[] = [];
  if (invite.tls) flags |= EXTENSION_TLS;
  if (invite.serverKey !== undefined) {
    flags |= EXTENSION_SERVER_KEY;
    fields.push(...hexBytes(invite.serverKey.slice(ED25519_SPKI_PUBLIC_KEY_DER_PREFIX_HEX.length)));
  }
  return flags ? [...fields, flags, fields.length, ...EXTENSION_MARKER] : null;
}

/** Where the deflate stream ends and how to read the fields after it, when the bytes close with an extension. */
function readInviteExtension(bytes: Uint8Array): { streamEnd: number; fields: () => InviteExtension } | null {
  const tail = bytes.length - EXTENSION_TAIL;
  if (tail < 2 || EXTENSION_MARKER.some((value, index) => bytes[tail + 2 + index] !== value)) return null;
  const flags = bytes[tail];
  const fields = bytes.subarray(tail - bytes[tail + 1], tail);
  const streamEnd = tail - fields.length;
  if (streamEnd < 2) return null;
  return {
    streamEnd,
    fields: () => {
      const extension: InviteExtension = {};
      if (flags & EXTENSION_TLS) extension.tls = true;
      if (flags & EXTENSION_SERVER_KEY) {
        if (fields.length < SERVER_KEY_BYTES) throw new Error('Truncated invitation extension');
        extension.serverKey = ED25519_SPKI_PUBLIC_KEY_DER_PREFIX_HEX
          + [...fields.subarray(0, SERVER_KEY_BYTES)].map(byte => byte.toString(16).padStart(2, '0')).join('');
      }
      return extension;
    },
  };
}

function validUnicode(value: string): boolean {
  return !/[\uD800-\uDFFF]/u.test(value);
}

function normalizeHost(value: string): string | null {
  const host = value.trim();
  if (!host || /[\s/?#@\\%]/u.test(host)) return null;
  try {
    const bracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    const url = new URL(`ws://${bracketed}:1`);
    if (!url.hostname || url.port !== '1' || url.pathname !== '/' || url.username || url.password) return null;
    return url.hostname.length <= 255 ? url.hostname : null;
  } catch {
    return null;
  }
}

export const serverInviteSchema = z.object({
  v: z.literal(1),
  host: z.string().min(1).max(255).transform((value, context) => {
    const host = normalizeHost(value);
    if (host) return host;
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid server invitation host' });
    return z.NEVER;
  }),
  port: z.number().int().min(1).max(65535),
  name: z.string().min(1).max(100).refine(validUnicode).optional(),
  password: z.string().min(1).max(1024).refine(validUnicode).refine(value => !/[\x00-\x1f\x7f]/.test(value)).optional(),
  eventId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/).optional(),
  /** Reached over TLS (`wss://`), as behind a reverse proxy. Apps that predate it ignore it and connect plain. */
  tls: z.literal(true).optional(),
  /** The server's identity (server-key-auth, #821): the only way the app accepts a key other than the one it pinned. */
  serverKey: serverPublicKeySchema.optional(),
}).strict();

export type ServerInvite = z.infer<typeof serverInviteSchema>;
export type ServerInviteResult =
  | { ok: true; invite: ServerInvite }
  | { ok: false; reason: 'invalid' | 'too_long' };

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function writeLength(output: number[], length: number): void {
  if (length >= 128) output.push((length & 127) | 128, length >>> 7);
  else output.push(length);
}

function writeText(output: number[], value: string): void {
  const bytes = encoder.encode(value);
  writeLength(output, bytes.length);
  output.push(...bytes);
}

function hostType(host: string): number {
  if (host === 'localhost') return 3;
  if (host === '127.0.0.1') return 4;
  if (host === '[::1]') return 5;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return 1;
  return host.startsWith('[') ? 2 : 0;
}

function hexBytes(value: string): number[] {
  return Array.from({ length: value.length / 2 }, (_, index) => parseInt(value.slice(index * 2, index * 2 + 2), 16));
}

function ipv6Bytes(host: string): number[] {
  const halves = host.slice(1, -1).split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 1 ? left : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  return groups.flatMap(group => {
    const word = parseInt(group, 16);
    return [word >>> 8, word & 255];
  });
}

function inviteToken(value: ServerInvite): string {
  const invite = serverInviteSchema.parse(value);
  const host = hostType(invite.host);
  const password = invite.password;
  const passwordMode = password === undefined ? 0
    : /^[0-9a-f]+$/.test(password) ? 2 : /^[0-9A-F]+$/.test(password) ? 3 : 1;
  const encode = (hostEncoding: number, passwordEncoding: number): Uint8Array => {
    // Version 1 ("~"): host(3 bits), custom port(1), name(1), password(2), deflate(1).
    const header = hostEncoding | (invite.port !== INVITE_DEFAULT_PORT ? 8 : 0)
      | (invite.name !== undefined ? 16 : 0) | (passwordEncoding << 5);
    const body: number[] = [];
    if (hostEncoding === 0) writeText(body, invite.host);
    else if (hostEncoding === 1) body.push(...invite.host.split('.').map(Number));
    else if (hostEncoding === 2) body.push(...ipv6Bytes(invite.host));
    if (invite.port !== INVITE_DEFAULT_PORT) body.push(invite.port >>> 8, invite.port & 255);
    if (invite.name !== undefined) writeText(body, invite.name);
    if (password !== undefined) {
      if (passwordEncoding === 1) writeText(body, password);
      else {
        writeLength(body, password.length);
        for (let index = 0; index < password.length; index += 2) {
          body.push(parseInt(password.slice(index, index + 2).padEnd(2, '0'), 16));
        }
      }
    }
    const raw = Uint8Array.from(body);
    const compressed = deflateSync(raw, { level: 9 });
    const extension = inviteExtension(invite);
    if (extension) return Uint8Array.from([header | 128, ...compressed, ...extension]);
    return compressed.length < raw.length
      ? Uint8Array.from([header | 128, ...compressed]) : Uint8Array.from([header, ...raw]);
  };
  const textPassword = password === undefined ? 0 : 1;
  let bytes = encode(host, textPassword);
  const keepShorter = (candidate: Uint8Array): void => {
    if (candidate.length < bytes.length) bytes = candidate;
  };
  // Repeated text across fields can compress better than their packed forms.
  if (host !== 0) keepShorter(encode(0, textPassword));
  if (passwordMode >= 2) {
    keepShorter(encode(host, passwordMode));
    if (host !== 0) keepShorter(encode(0, passwordMode));
  }
  const token = SERVER_INVITE_FRAGMENT_PREFIX + base64Url(bytes) + (invite.eventId ? `.event.${invite.eventId}` : '');
  if (token.length > MAX_SERVER_INVITE_LENGTH - SERVER_INVITE_WEB_URL_EN.length - 1) {
    throw new Error('Server invitation is too large');
  }
  return token;
}

/** The language picks the page, and therefore the text of the preview card other apps show. */
export function createServerInviteLink(invite: ServerInvite, language: ServerInviteLanguage = 'pt-BR'): string {
  return `${language === 'en' ? SERVER_INVITE_WEB_URL_EN : SERVER_INVITE_WEB_URL}#${inviteToken(invite)}`;
}

export function createServerInviteAppLink(invite: ServerInvite): string {
  return `${SERVER_INVITE_SCHEME}://#${inviteToken(invite)}`;
}

/**
 * The web version of Monky (#858). It only reaches servers over TLS, so the
 * invitation page offers it only for an invitation marked `tls`.
 */
// Both domains are the ones Vercel gave each project; the release deploy pins them from here, so this is the one place to change them.
export const MONKY_WEB_APP_URL = 'https://monkyweb.vercel.app/';

/**
 * Where the web version opens bot miniapps: a site of its own, so a miniapp
 * never runs with the app's origin or under its CSP. With `{id}` in the host,
 * each document gets its own subdomain, as each gets its own origin on the
 * desktop; without it, each runs in an opaque, sandboxed origin.
 */
export const MONKY_MINIAPPS_URL = 'https://monky-miniapps.vercel.app/';

/** The CSP source that admits every document of a miniapps site; `{id}` must be the first label of its host. */
export function miniappsFrameSource(url: string): string {
  if (!url.includes('{id}')) return new URL(url).origin;
  if (!/^https?:\/\/\{id\}\.[^/{}]+\//.test(url)) throw new Error(`Unsupported miniapps URL: ${url}`);
  const site = new URL(url.replace('{id}', 'x'));
  return `${site.protocol}//*.${site.host.slice(2)}`;
}
/** The page of the miniapps site that receives a document from the app and shows it. */
export const MINIAPP_LOADER_PAGE = 'frame.html';
export const MINIAPP_LOADER_MESSAGES = { ready: 'monky-miniapp-loader', document: 'monky-miniapp-document' } as const;

/** Opens the invitation in the web version, which reads it from the fragment as the app link does. */
export function createServerInviteWebAppLink(invite: ServerInvite): string {
  return `${MONKY_WEB_APP_URL}#${inviteToken(invite)}`;
}

function inflateBody(bytes: Uint8Array): Uint8Array {
  if (!bytes.length) throw new Error('Missing compressed invitation data');
  const chunks: Uint8Array[] = [];
  let length = 0;
  const stream = new Inflate(chunk => {
    length += chunk.length;
    if (length >= MAX_INVITE_BYTES) throw new InviteSizeError('Decoded invitation is too large');
    chunks.push(chunk.slice());
  });
  // Bound each expansion step, rather than inflating an untrusted stream at once.
  for (let offset = 0; offset < bytes.length; offset += 64) {
    stream.push(bytes.subarray(offset, offset + 64), offset + 64 >= bytes.length);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}

function readInvite(header: number, body: Uint8Array): ServerInvite {
  let offset = 0;
  const take = (length: number): Uint8Array => {
    if (offset + length > body.length) throw new Error('Truncated invitation');
    const bytes = body.subarray(offset, offset + length);
    offset += length;
    return bytes;
  };
  const readLength = (): number => {
    const first = take(1)[0];
    if (first < 128) return first;
    const next = take(1)[0];
    if (next === 0 || next >= 128) throw new Error('Invalid invitation field length');
    return (first & 127) | (next << 7);
  };
  const text = (): string => decoder.decode(take(readLength()));
  const kind = header & 7;
  let host: string;
  if (kind === 0) host = text();
  else if (kind === 1) host = [...take(4)].join('.');
  else if (kind === 2) {
    const bytes = take(16);
    const words: string[] = [];
    for (let index = 0; index < 16; index += 2) words.push(((bytes[index] << 8) | bytes[index + 1]).toString(16));
    host = `[${words.join(':')}]`;
  } else if (kind === 3) host = 'localhost';
  else if (kind === 4) host = '127.0.0.1';
  else if (kind === 5) host = '[::1]';
  else throw new Error('Unknown invitation host encoding');
  const portBytes = header & 8 ? take(2) : null;
  const port = portBytes ? (portBytes[0] << 8) | portBytes[1] : INVITE_DEFAULT_PORT;
  const name = header & 16 ? text() : undefined;
  const passwordMode = (header >>> 5) & 3;
  let password: string | undefined;
  if (passwordMode === 1) password = text();
  else if (passwordMode >= 2) {
    const digits = readLength();
    if (digits > 1024) throw new InviteSizeError('Invitation password is too large');
    const bytes = take(Math.ceil(digits / 2));
    if (digits % 2 && (bytes[bytes.length - 1] & 15)) throw new Error('Invalid hexadecimal padding');
    password = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, digits);
    if (passwordMode === 3) password = password.toUpperCase();
  }
  if (offset !== body.length) throw new Error('Unexpected invitation data');
  return serverInviteSchema.parse({
    v: 1, host, port,
    ...(name !== undefined ? { name } : {}),
    ...(password !== undefined ? { password } : {}),
  });
}

/** The body, inflated when compressed, and the extension after its deflate stream. */
function inviteBody(bytes: Uint8Array): { body: Uint8Array; extension: InviteExtension } {
  if (!(bytes[0] & 128)) return { body: bytes.subarray(1), extension: {} };
  const extension = readInviteExtension(bytes);
  if (extension) {
    let body: Uint8Array | null = null;
    try {
      // A stream cut short does not inflate: success means the extension really followed it.
      body = inflateBody(bytes.subarray(1, extension.streamEnd));
    } catch (error: unknown) {
      if (error instanceof InviteSizeError) throw error;
    }
    // A real extension that cannot be read refuses the invitation, rather than dropping a field.
    if (body) return { body, extension: extension.fields() };
  }
  return { body: inflateBody(bytes.subarray(1)), extension: {} };
}

export function decodeServerInviteToken(token: unknown): ServerInviteResult {
  if (typeof token !== 'string' || !token.startsWith(SERVER_INVITE_FRAGMENT_PREFIX)) return { ok: false, reason: 'invalid' };
  if (token.length > MAX_SERVER_INVITE_LENGTH) return { ok: false, reason: 'too_long' };
  const [base, marker, eventId, ...extra] = token.split('.');
  if (extra.length || (marker !== undefined && (marker !== 'event' || !eventId))) return { ok: false, reason: 'invalid' };
  const encoded = base.slice(SERVER_INVITE_FRAGMENT_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return { ok: false, reason: 'invalid' };
  try {
    const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    if (bytes.length > MAX_INVITE_BYTES) return { ok: false, reason: 'too_long' };
    if (base64Url(bytes) !== encoded) return { ok: false, reason: 'invalid' };
    const { body, extension } = inviteBody(bytes);
    const invite = readInvite(bytes[0], body);
    return { ok: true, invite: serverInviteSchema.parse({
      ...invite, ...extension, ...(eventId !== undefined ? { eventId } : {}),
    }) };
  } catch (error: unknown) {
    return { ok: false, reason: error instanceof InviteSizeError ? 'too_long' : 'invalid' };
  }
}

export function parseServerInviteLink(value: unknown): ServerInviteResult {
  if (typeof value !== 'string' || !value.trim()) return { ok: false, reason: 'invalid' };
  if (value.length > MAX_SERVER_INVITE_LENGTH) return { ok: false, reason: 'too_long' };
  try {
    const url = new URL(value.trim());
    if (url.username || url.password || url.search) return { ok: false, reason: 'invalid' };
    const native = url.protocol === `${SERVER_INVITE_SCHEME}:` && url.hostname === ''
      && !url.port && (url.pathname === '' || url.pathname === '/');
    const web = url.origin === new URL(SERVER_INVITE_WEB_URL).origin && SERVER_INVITE_WEB_PATHS.has(url.pathname);
    return native || web ? decodeServerInviteToken(url.hash.slice(1)) : { ok: false, reason: 'invalid' };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}
