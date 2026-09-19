import { z } from 'zod';
import { deflateSync, Inflate } from 'fflate';

export const SERVER_INVITE_WEB_URL = 'https://monkyorg.github.io/Monky/';
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
  const token = SERVER_INVITE_FRAGMENT_PREFIX + base64Url(bytes);
  if (token.length > MAX_SERVER_INVITE_LENGTH - SERVER_INVITE_WEB_URL.length - 1) {
    throw new Error('Server invitation is too large');
  }
  return token;
}

export function createServerInviteLink(invite: ServerInvite): string {
  return `${SERVER_INVITE_WEB_URL}#${inviteToken(invite)}`;
}

export function createServerInviteAppLink(invite: ServerInvite): string {
  return `${SERVER_INVITE_SCHEME}://#${inviteToken(invite)}`;
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

export function decodeServerInviteToken(token: unknown): ServerInviteResult {
  if (typeof token !== 'string' || !token.startsWith(SERVER_INVITE_FRAGMENT_PREFIX)) return { ok: false, reason: 'invalid' };
  if (token.length > MAX_SERVER_INVITE_LENGTH) return { ok: false, reason: 'too_long' };
  const encoded = token.slice(SERVER_INVITE_FRAGMENT_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return { ok: false, reason: 'invalid' };
  try {
    const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    if (bytes.length > MAX_INVITE_BYTES) return { ok: false, reason: 'too_long' };
    if (base64Url(bytes) !== encoded) return { ok: false, reason: 'invalid' };
    const body = bytes[0] & 128 ? inflateBody(bytes.subarray(1)) : bytes.subarray(1);
    return { ok: true, invite: readInvite(bytes[0], body) };
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
    const web = url.origin === new URL(SERVER_INVITE_WEB_URL).origin
      && ['/Monky', '/Monky/', '/Monky/index.html', '/Monky/en', '/Monky/en/', '/Monky/en/index.html'].includes(url.pathname);
    return native || web ? decodeServerInviteToken(url.hash.slice(1)) : { ok: false, reason: 'invalid' };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}
