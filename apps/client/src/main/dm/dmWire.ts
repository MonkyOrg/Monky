import {
  DM_DEFAULT_MAX_FILE_BYTES,
  DM_MAX_ATTACHMENTS,
  DM_MAX_FILE_BYTES_LIMIT,
  DM_MAX_MESSAGE_LENGTH,
  DM_PROFILE_AVATAR_MAX_LENGTH,
  sanitizeDmForward,
  type DmSelfProfile,
  type MessageForward,
} from '@monky/shared';
import { isIdentityPublicKey, normalizeIdentityKey } from './dmCrypto';
import type {
  AttachmentMeta,
  SignedStatement,
  StatementType,
  StoredAttachment,
  StoredMessage,
  StoredReactions,
  WireMessage,
} from './dmModel';

/**
 * Validation of what reaches the DM engine from outside: friends, the other
 * devices of this identity, backups and the renderer. Every value is checked
 * here before the engine keeps it.
 */

const MAX_NICKNAME_LENGTH = 64;
const MAX_AVATAR_URL_LENGTH = 2048;
const MAX_INLINE_AVATAR_LENGTH = 512 * 1024;
export const MAX_EMOJI_LENGTH = 64;
const MAX_FILE_NAME_LENGTH = 200;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function isDmId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
}

export function utf8Length(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

export function sanitizeNickname(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NICKNAME_LENGTH);
  return trimmed || fallback;
}

export function sanitizeAvatar(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  if (value.startsWith('data:image/')) {
    return value.length <= MAX_INLINE_AVATAR_LENGTH ? value : null;
  }
  if (/^https?:\/\//i.test(value) && value.length <= MAX_AVATAR_URL_LENGTH) return value;
  return null;
}

/** Avatars that travel inside DMs must be small inline images, never remote URLs. */
export function sanitizeProfileAvatar(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > DM_PROFILE_AVATAR_MAX_LENGTH) return null;
  return /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : null;
}

export function emptyProfile(): DmSelfProfile {
  return { nickname: '', nicknameAt: 0, avatar: null, avatarAt: 0 };
}

export function sanitizeSelfProfile(value: unknown): DmSelfProfile {
  if (!isRecord(value)) return emptyProfile();
  const stamp = (at: unknown) => (typeof at === 'number' && Number.isFinite(at) && at > 0 ? at : 0);
  const nickname = sanitizeNickname(value.nickname, '');
  const avatar = sanitizeProfileAvatar(value.avatar);
  return {
    nickname,
    nicknameAt: nickname ? stamp(value.nicknameAt) : 0,
    avatar,
    avatarAt: stamp(value.avatarAt),
  };
}

export function clampMaxFileBytes(value: unknown, fallback = DM_DEFAULT_MAX_FILE_BYTES): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), DM_MAX_FILE_BYTES_LIMIT);
}

export function sanitizeAttachmentMeta(value: unknown): AttachmentMeta | null {
  if (!isRecord(value)) return null;
  const { fileId, name, size, mime, sha256 } = value;
  if (!isDmId(fileId)) return null;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 || size > DM_MAX_FILE_BYTES_LIMIT) return null;
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  const safeName = typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f/\\]/g, '_').trim().slice(0, MAX_FILE_NAME_LENGTH) : '';
  const safeMime = typeof mime === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(mime) && mime.length <= 128 ? mime : 'application/octet-stream';
  return { fileId, name: safeName || 'arquivo', size, mime: safeMime, sha256 };
}

const STATEMENT_TYPES: readonly StatementType[] = ['request', 'accept', 'cancel', 'remove'];

/**
 * A friend statement in the shape every version signs. The object is kept
 * as it came, because its signature covers it whole: whether it is genuine
 * is for the caller to check with `verifyDmStatement`.
 */
export function isSignedStatement(value: unknown): value is SignedStatement {
  if (!isRecord(value) || typeof value.s !== 'string' || !isRecord(value.p)) return false;
  const { p } = value;
  const { cert } = p;
  return p.v === 1
    && STATEMENT_TYPES.some((type) => type === p.type)
    && isDmId(p.id)
    && isDmId(p.requestId)
    && typeof p.from === 'string'
    && typeof p.to === 'string'
    && typeof p.ts === 'number'
    && isRecord(cert) && cert.v === 1 && typeof cert.key === 'string' && typeof cert.sig === 'string'
    && typeof p.nickname === 'string'
    && typeof p.maxFileBytes === 'number';
}

/** The message as it leaves this device, for another own device or a backup. */
export function toWireMessage(message: StoredMessage): WireMessage {
  return {
    id: message.id,
    author: message.author,
    content: message.content,
    createdAt: message.createdAt,
    editedAt: message.editedAt,
    ...(message.contentAt !== undefined && message.contentAt !== message.editedAt ? { contentAt: message.contentAt } : {}),
    deleted: message.deleted,
    replyTo: message.replyTo,
    reactions: message.reactions,
    attachments: message.attachments.map(({ fileId, name, size, mime, sha256 }) => ({ fileId, name, size, mime, sha256 })),
    ...(message.forwarded ? { forwarded: message.forwarded } : {}),
  };
}

/** The two people a conversation is between, and the latest time accepted from it: later ones come back to it. */
export interface MessageScope {
  me: string;
  peer: string;
  limit: number;
}

/** A message from a friend, another own device or a backup, once validated (see {@link parseWireMessage}). */
export interface ParsedMessage {
  id: string;
  author: string;
  content: string;
  createdAt: number;
  editedAt: number | null;
  /** The clock of the text: devices before #490 send none, and for them it is the edit time. */
  contentAt: number | null;
  deleted: boolean;
  replyTo: string | null;
  reactions: StoredReactions;
  attachments: AttachmentMeta[];
  forwarded: MessageForward | null;
}

/**
 * The one reading of a message that comes from outside, whoever sends it: a
 * friend (built from the envelope of their `msg`), another own device (its
 * history) or a backup. It only accepts messages and reactions of the two
 * people in the conversation and keeps every time within `scope.limit`; it
 * says nothing on deletes and files, which each caller decides with what this
 * device already holds.
 */
export function parseWireMessage(raw: unknown, scope: MessageScope): ParsedMessage | null {
  if (!isRecord(raw) || !isDmId(raw.id) || !isIdentityPublicKey(raw.author)) return null;
  const author = normalizeIdentityKey(raw.author);
  if (author !== scope.me && author !== scope.peer) return null;
  const time = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(value, scope.limit) : null;
  const editedAt = time(raw.editedAt);
  return {
    id: raw.id,
    author,
    content: typeof raw.content === 'string' ? raw.content.slice(0, DM_MAX_MESSAGE_LENGTH) : '',
    createdAt: time(raw.createdAt) ?? 0,
    editedAt,
    contentAt: time(raw.contentAt) ?? editedAt,
    deleted: raw.deleted === true,
    replyTo: isDmId(raw.replyTo) ? raw.replyTo : null,
    reactions: parseReactions(raw.reactions, scope),
    attachments: (Array.isArray(raw.attachments) ? raw.attachments.slice(0, DM_MAX_ATTACHMENTS) : [])
      .map((entry) => sanitizeAttachmentMeta(entry))
      .filter((entry): entry is AttachmentMeta => !!entry),
    forwarded: sanitizeDmForward(raw.forwarded),
  };
}

function parseReactions(value: unknown, scope: MessageScope): StoredReactions {
  const reactions: StoredReactions = {};
  if (!isRecord(value)) return reactions;
  for (const [emojiRaw, users] of Object.entries(value).slice(0, 200)) {
    const emoji = emojiRaw.trim().slice(0, MAX_EMOJI_LENGTH);
    if (!emoji || !isRecord(users)) continue;
    for (const [userRaw, reaction] of Object.entries(users)) {
      if (!isIdentityPublicKey(userRaw) || !isRecord(reaction) || typeof reaction.ts !== 'number') continue;
      const user = normalizeIdentityKey(userRaw);
      if (user !== scope.me && user !== scope.peer) continue;
      (reactions[emoji] ??= {})[user] = { on: reaction.on === true, ts: Math.min(reaction.ts, scope.limit) };
    }
  }
  return reactions;
}

/**
 * The stored record of a message this device learns of from elsewhere, with
 * its files as this device holds them. A deleted message keeps nothing of
 * what it said, only its "edited" mark: devices compare it (see
 * `messageFingerprint`), and the one that saw the delete happen keeps it.
 */
export function storedMessage(parsed: ParsedMessage, deleted: boolean, attachments: StoredAttachment[], me: string): StoredMessage {
  return {
    id: parsed.id,
    author: parsed.author,
    content: deleted ? '' : parsed.content,
    createdAt: parsed.createdAt,
    editedAt: parsed.editedAt,
    contentAt: deleted || parsed.contentAt === null ? undefined : parsed.contentAt,
    deleted,
    replyTo: parsed.replyTo,
    reactions: deleted ? {} : parsed.reactions,
    attachments: deleted ? [] : attachments,
    delivery: parsed.author === me ? 'delivered' : null,
    forwarded: deleted ? null : parsed.forwarded,
  };
}
