import type {
  DmAttachmentState,
  DmDeliveryState,
  DmErrorCode,
  DmRelation,
  DmSelfProfile,
  DmSettings,
  MessageForward,
} from '@monky/shared';
import type { DmKeyCertificate } from './dmCrypto';

/**
 * What the DM engine keeps (#743): the records it stores encrypted on disk,
 * the rules that decide between two versions of a message, and the error the
 * renderer is told about. Shared by every part of the engine.
 */

/** How far ahead of this device's clock a time from another device may be. */
export const MAX_CLOCK_SKEW_MS = 5 * 60_000;
/**
 * Items sent on every shared server (own-device exchanges, file requests) arrive once per server; identical
 * copies within this window are answered once.
 */
export const SELF_REPEAT_WINDOW_MS = 30_000;

export type StatementType = 'request' | 'accept' | 'cancel' | 'remove';

export interface FriendStatementPayload {
  v: 1;
  type: StatementType;
  id: string;
  requestId: string;
  from: string;
  to: string;
  ts: number;
  cert: DmKeyCertificate;
  nickname: string;
  maxFileBytes: number;
}

export interface SignedStatement {
  p: FriendStatementPayload;
  s: string;
}

export interface PeerRecord {
  publicKey: string;
  nickname: string;
  avatar: string | null;
  cert: DmKeyCertificate | null;
  relation: DmRelation;
  requestId: string | null;
  outgoingStatement: SignedStatement | null;
  relationUpdatedAt: number;
  blocked: boolean;
  blockedUpdatedAt: number;
  friendSince: number | null;
  requestedAt: number | null;
  maxFileBytes: number;
  seenStatements: string[];
  /** Newest profile (nickname/avatar) the friend sent us; 0/undefined when only servers told us. */
  profileAt?: number;
  profileHash?: string;
  /** The avatar came from the friend's profile, so server observations must not replace it. */
  profileAvatar?: boolean;
}

export interface OutboxEntry {
  id: string;
  kind: 'friend' | 'envelope';
  type: string;
  ts: number;
  body?: unknown;
  statement?: SignedStatement;
  lastSentAt: number;
}

export interface ConversationMeta {
  lastMessageAt: number;
  lastMessagePreview: string;
  lastMessageAuthor: string | null;
  unread: number;
  lastReadAt: number;
  peerReadAt: number;
  hidden: boolean;
  messageCount: number;
}

export interface DownloadState {
  peer: string;
  messageId: string;
  fileId: string;
  size: number;
  sha256: string;
  requestedUntil: number;
  lastActivityAt: number;
}

export interface DmState {
  version: 1;
  identity: string;
  settings: DmSettings;
  peers: Record<string, PeerRecord>;
  outbox: Record<string, OutboxEntry[]>;
  conversations: Record<string, ConversationMeta>;
  downloads: Record<string, DownloadState>;
  profile: DmSelfProfile;
}

export interface StoredAttachment {
  fileId: string;
  name: string;
  size: number;
  mime: string;
  sha256: string;
  state: DmAttachmentState;
  receivedBytes: number;
}

export type StoredReactions = Record<string, Record<string, { on: boolean; ts: number }>>;

export interface StoredMessage {
  id: string;
  author: string;
  content: string;
  createdAt: number;
  /** When this device last saw the text change: what marks the message as edited. */
  editedAt: number | null;
  /**
   * Last-writer-wins clock of the text (#490). Unlike `editedAt`, it also
   * moves for an edit that keeps the text, so an older edit arriving later
   * cannot bring back a text the author already replaced. Absent until the
   * first edit, and in stores written before it existed: `editedAt` then.
   */
  contentAt?: number;
  deleted: boolean;
  replyTo: string | null;
  reactions: StoredReactions;
  attachments: StoredAttachment[];
  delivery: DmDeliveryState | null;
  /** Absent in stores written before forwarding existed. */
  forwarded?: MessageForward | null;
}

export interface StoredConversation {
  version: 1;
  peer: string;
  messages: StoredMessage[];
  /**
   * Messages deleted before this device had them: a copy that arrives late stays
   * out instead of showing up for good. Absent in stores written before #490.
   */
  tombstones?: Array<{ id: string; author: string }>;
}

export interface AttachmentMeta {
  fileId: string;
  name: string;
  size: number;
  mime: string;
  sha256: string;
}

/**
 * A message as it goes to the other devices of this identity (history) and
 * into backups: what it says, never how this device holds it. `contentAt`
 * only goes when it differs from `editedAt`, which is what the receiver
 * assumes otherwise, and `forwarded` only when set.
 */
export interface WireMessage {
  id: string;
  author: string;
  content: string;
  createdAt: number;
  editedAt: number | null;
  contentAt?: number;
  deleted: boolean;
  replyTo: string | null;
  reactions: StoredReactions;
  attachments: AttachmentMeta[];
  forwarded?: MessageForward;
}

export interface SyncEntry {
  publicKey: string;
  nickname: string;
  cert: DmKeyCertificate | null;
  relation: DmRelation;
  requestId: string | null;
  outgoingStatement: SignedStatement | null;
  relationUpdatedAt: number;
  blocked: boolean;
  blockedUpdatedAt: number;
  friendSince: number | null;
  requestedAt: number | null;
}

export interface DmExportData {
  version: 1;
  peers: SyncEntry[];
  settings: DmSettings;
  conversations?: Array<{ version: 1; peer: string; messages: WireMessage[] }>;
}

export class DmError extends Error {
  constructor(
    readonly code: DmErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

/** What decides whether two devices hold the same version of a message. */
export function messageFingerprint(message: StoredMessage): string {
  const reactions = Object.entries(message.reactions)
    .flatMap(([emoji, users]) => Object.entries(users).map(([user, value]) => `${emoji}:${user}:${value.on ? 1 : 0}:${value.ts}`))
    .sort()
    .join(',');
  // Only when it tells something `editedAt` does not, so the usual message keeps the fingerprint older versions compute.
  const clock = !message.deleted && message.contentAt !== undefined && message.contentAt !== message.editedAt
    ? `~${message.contentAt}` : '';
  return `${message.id}|${message.deleted ? 1 : 0}|${message.editedAt ?? 0}${clock}|${reactions};`;
}

/** The clock the text of a message is compared by (see `StoredMessage.contentAt`). */
export function contentClock(message: StoredMessage): number {
  return message.contentAt ?? message.editedAt ?? 0;
}

/** Whether a text stamped `at` replaces the current one. Equal stamps keep the same text on every device. */
export function contentWins(at: number, content: string, message: StoredMessage): boolean {
  const current = contentClock(message);
  return at > current || (at === current && content > message.content);
}

/**
 * Whether an "edited" mark stamped `at` replaces the current one: the newest
 * any device has, also on a deleted message. Devices compare it (see
 * {@link messageFingerprint}), and a delete keeps the mark each device had, so
 * every copy has to end with the same one or the history goes back and forth.
 */
export function editedAtWins(at: number | null, message: StoredMessage): boolean {
  return at !== null && (message.editedAt === null || at > message.editedAt);
}
