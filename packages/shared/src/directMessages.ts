/**
 * Client-side contracts for friends and direct messages (#743).
 *
 * The relay server only moves opaque items between identities. Everything in
 * this file is between the client's main process (crypto + encrypted store) and
 * the renderer (transport over the server sessions + UI).
 */

import { MESSAGE_FORWARD_SOURCE_MAX_LENGTH, type MessageForward } from './models.js';
import type { DmRelayItem, DmRelayKind } from './protocol.js';
import type { IpcEvents, IpcInvoker } from './ipc.js';
export type { DmRelayItem, DmRelayKind } from './protocol.js';

export const DM_DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const DM_MAX_FILE_BYTES_LIMIT = 200 * 1024 * 1024;
export const DM_MAX_FILE_BYTES_OPTIONS = [10, 25, 50, 100, 200].map((mb) => mb * 1024 * 1024);
export const DM_MAX_MESSAGE_LENGTH = 4000;
export const DM_MAX_ATTACHMENTS = 10;
export const DM_TYPING_TTL_MS = 6000;

export const DM_IPC = {
  snapshot: 'dm:snapshot',
  conversation: 'dm:conversation',
  openConversation: 'dm:open-conversation',
  closeConversation: 'dm:close-conversation',
  sendFriendRequest: 'dm:friend-request',
  acceptFriend: 'dm:friend-accept',
  declineFriend: 'dm:friend-decline',
  cancelFriendRequest: 'dm:friend-cancel',
  removeFriend: 'dm:friend-remove',
  block: 'dm:block',
  unblock: 'dm:unblock',
  sendMessage: 'dm:send',
  editMessage: 'dm:edit',
  deleteMessage: 'dm:delete',
  react: 'dm:react',
  markRead: 'dm:mark-read',
  typing: 'dm:typing',
  ingest: 'dm:ingest',
  outgoing: 'dm:outgoing',
  hello: 'dm:hello',
  helloTo: 'dm:hello-to',
  observePeer: 'dm:observe-peer',
  updateSettings: 'dm:update-settings',
  readAttachment: 'dm:read-attachment',
  saveAttachment: 'dm:save-attachment',
  retryAttachment: 'dm:retry-attachment',
  setSelfNickname: 'dm:set-self-nickname',
  setSelfProfile: 'dm:set-self-profile',
  pendingPeers: 'dm:pending-peers',
} as const satisfies Record<string, keyof DmInvokeChannels>;

/** Largest avatar (data URL) that travels with the identity and to friends. */
export const DM_PROFILE_AVATAR_MAX_LENGTH = 120_000;

export const DM_EVENT = 'dm:event' satisfies keyof IpcEvents;

export interface DmIncomingRelayItem {
  /** Sender identity, stamped by the server. */
  from: string;
  kind: DmRelayKind;
  data: string;
}

/**
 * What the renderer must send after a DM operation.
 * - `peers`: per recipient, send on one session where that identity is reachable; the outbox tries again later.
 * - `everywhere`: per recipient, send on every session where that identity is reachable. For requests whose
 *   answer depends on which of its devices get them: only the device that sent a file has it, and each server
 *   only reaches the devices connected to it. Copies of the same item are answered once.
 * - `broadcast`: send on every connected session (own-device copies, hellos).
 * - `reply`: send on the session the ingested item arrived on.
 */
export interface DmDispatch {
  peers?: Record<string, DmRelayItem[]>;
  everywhere?: Record<string, DmRelayItem[]>;
  broadcast?: DmRelayItem[];
  reply?: DmRelayItem[];
}

export type DmRelation = 'none' | 'friend' | 'outgoing' | 'incoming';

export interface DmPeerView {
  publicKey: string;
  nickname: string;
  avatar: string | null;
  relation: DmRelation;
  blocked: boolean;
  friendSince: number | null;
  requestedAt: number | null;
  /** Largest file this peer accepts, as last advertised by them. */
  maxFileBytes: number;
}

export type DmAttachmentState =
  | 'local'
  | 'pending'
  | 'downloading'
  | 'ready'
  | 'unavailable'
  | 'too-large'
  | 'failed';

export interface DmAttachmentView {
  fileId: string;
  name: string;
  size: number;
  mime: string;
  state: DmAttachmentState;
  receivedBytes: number;
}

export interface DmReactionView {
  emoji: string;
  users: string[];
}

export type DmDeliveryState = 'pending' | 'delivered' | 'read' | 'failed';

export interface DmMessageView {
  id: string;
  peer: string;
  author: string;
  content: string;
  createdAt: number;
  editedAt: number | null;
  deleted: boolean;
  replyTo: string | null;
  reactions: DmReactionView[];
  attachments: DmAttachmentView[];
  /** "Forwarded" badge; null when the message was not forwarded or was deleted. */
  forwarded: MessageForward | null;
  /** Only for own messages. */
  delivery: DmDeliveryState | null;
}

export interface DmConversationSummary {
  peer: string;
  lastMessageAt: number;
  lastMessagePreview: string;
  lastMessageAuthor: string | null;
  unread: number;
  hidden: boolean;
  readOnly: boolean;
}

export interface DmSettings {
  maxFileBytes: number;
}

export interface DmSnapshot {
  me: { publicKey: string } | null;
  peers: DmPeerView[];
  conversations: DmConversationSummary[];
  settings: DmSettings;
}

export interface DmConversationPage {
  peer: string;
  messages: DmMessageView[];
  hasMore: boolean;
  peerReadAt: number;
}

export interface DmOutgoingFile {
  name: string;
  mime: string;
  data: Uint8Array;
}

export interface DmSendMessageInput {
  peer: string;
  content: string;
  replyTo?: string | null;
  files?: DmOutgoingFile[];
  /** Marks the message as forwarded; travels inside the encrypted body. */
  forwarded?: MessageForward | null;
}

/**
 * Validates a forward marker that came from the renderer, a peer or a backup.
 * `source` is a string (control characters stripped, trimmed, capped; empty
 * becomes null) or null; `createdAt` is a non-negative safe integer or null.
 * A missing field counts as null; any other shape means "not forwarded".
 */
export function sanitizeDmForward(value: unknown): MessageForward | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = 'source' in value ? value.source : undefined;
  const createdAt = 'createdAt' in value ? value.createdAt : undefined;
  if (source !== undefined && source !== null && typeof source !== 'string') return null;
  if (
    createdAt !== undefined
    && createdAt !== null
    && !(typeof createdAt === 'number' && Number.isSafeInteger(createdAt) && createdAt >= 0)
  ) {
    return null;
  }
  const cleanSource = typeof source === 'string'
    ? source.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MESSAGE_FORWARD_SOURCE_MAX_LENGTH).trim()
    : '';
  return {
    source: cleanSource || null,
    createdAt: typeof createdAt === 'number' ? createdAt : null,
  };
}

export interface DmObservedPeer {
  publicKey: string;
  nickname?: string;
  avatar?: string | null;
}

/**
 * Nickname and avatar that travel with the identity (own devices and friends).
 * Each field is last-writer-wins on its own timestamp; 0 means never set.
 */
export interface DmSelfProfile {
  nickname: string;
  nicknameAt: number;
  /** Small data URL (WebP) or null. */
  avatar: string | null;
  avatarAt: number;
}

/** Local values the renderer knows, with the time each one was chosen. */
export interface DmSelfProfileInput {
  nickname?: string;
  nicknameAt?: number;
  avatar?: string | null;
  avatarAt?: number;
}

export interface DmSelfProfileResult {
  profile: DmSelfProfile;
  dispatch: DmDispatch;
}

export type DmEvent =
  | { type: 'snapshot'; snapshot: DmSnapshot }
  | { type: 'self-profile'; profile: DmSelfProfile }
  | { type: 'messages'; peer: string; messages: DmMessageView[]; peerReadAt: number }
  /** A download under way moved on; the rest of the message did not change. */
  | { type: 'attachment-progress'; peer: string; messageId: string; fileId: string; receivedBytes: number }
  | { type: 'typing'; peer: string }
  | { type: 'incoming-message'; peer: string; message: DmMessageView }
  | { type: 'friend-request'; peer: string; nickname: string }
  | { type: 'friend-accepted'; peer: string; nickname: string }
  | { type: 'dispatch'; dispatch: DmDispatch };

export type DmErrorCode =
  | 'unavailable'
  | 'invalid-peer'
  | 'not-friend'
  | 'blocked'
  | 'empty-message'
  | 'message-too-long'
  | 'too-many-files'
  | 'file-too-large'
  | 'not-found'
  | 'forbidden';

export interface DmOperationResult {
  dispatch: DmDispatch;
}

export interface DmFailure {
  code: DmErrorCode;
  message: string;
  details: Record<string, unknown>;
}

/** IPC results: errors travel as data because Electron drops custom error fields. */
export type DmResult<T> = { ok: true; value: T } | { ok: false; error: DmFailure };

export interface DmAttachmentData {
  name: string;
  mime: string;
  data: Uint8Array;
}

/** What the identity export carries about friends/DMs. */
export type DmExportMode = 'none' | 'friends' | 'history';

/** Renderer -> Main channels of friends and DMs; `IpcInvokeChannels` (ipc.ts) includes them. */
export interface DmInvokeChannels {
  'dm:snapshot': { args: []; returnType: DmResult<DmSnapshot> };
  'dm:conversation': { args: [peer: string, before: string | null, limit?: number]; returnType: DmResult<DmConversationPage> };
  'dm:open-conversation': { args: [peer: string]; returnType: DmResult<void> };
  'dm:close-conversation': { args: [peer: string]; returnType: DmResult<void> };
  'dm:friend-request': { args: [peer: string, nickname?: string]; returnType: DmResult<DmDispatch> };
  'dm:friend-accept': { args: [peer: string]; returnType: DmResult<DmDispatch> };
  'dm:friend-decline': { args: [peer: string]; returnType: DmResult<DmDispatch> };
  'dm:friend-cancel': { args: [peer: string]; returnType: DmResult<DmDispatch> };
  'dm:friend-remove': { args: [peer: string]; returnType: DmResult<DmDispatch> };
  'dm:block': { args: [peer: string, nickname?: string]; returnType: DmResult<DmDispatch> };
  'dm:unblock': { args: [peer: string]; returnType: DmResult<DmDispatch> };
  'dm:send': { args: [input: DmSendMessageInput]; returnType: DmResult<DmDispatch> };
  'dm:edit': { args: [peer: string, messageId: string, content: string]; returnType: DmResult<DmDispatch> };
  'dm:delete': { args: [peer: string, messageId: string]; returnType: DmResult<DmDispatch> };
  'dm:react': { args: [peer: string, messageId: string, emoji: string, add: boolean]; returnType: DmResult<DmDispatch> };
  'dm:mark-read': { args: [peer: string]; returnType: DmResult<DmDispatch> };
  'dm:typing': { args: [peer: string]; returnType: DmResult<DmDispatch> };
  'dm:ingest': { args: [item: DmIncomingRelayItem]; returnType: DmResult<DmDispatch> };
  'dm:outgoing': { args: [peers: string[], force: boolean]; returnType: DmResult<DmDispatch> };
  /** `announce` also starts the own-device history/profile exchange. */
  'dm:hello': { args: [toFriends: boolean, announce: boolean]; returnType: DmResult<DmDispatch> };
  'dm:hello-to': { args: [peer: string]; returnType: DmResult<DmDispatch> };
  'dm:pending-peers': { args: []; returnType: DmResult<string[]> };
  'dm:observe-peer': { args: [peer: DmObservedPeer]; returnType: DmResult<void> };
  'dm:set-self-nickname': { args: [nickname: string]; returnType: DmResult<void> };
  'dm:set-self-profile': { args: [input: DmSelfProfileInput]; returnType: DmResult<DmSelfProfileResult> };
  'dm:update-settings': { args: [settings: Partial<DmSettings>]; returnType: DmResult<DmDispatch> };
  'dm:read-attachment': { args: [peer: string, messageId: string, fileId: string]; returnType: DmResult<DmAttachmentData> };
  'dm:save-attachment': { args: [peer: string, messageId: string, fileId: string]; returnType: DmResult<boolean> };
  'dm:retry-attachment': { args: [peer: string, messageId: string, fileId: string]; returnType: DmResult<DmDispatch> };
}

/** Renderer-facing bridge exposed as `window.api.dm`: one channel per call. */
export interface DmApi {
  snapshot: IpcInvoker<'dm:snapshot'>;
  /** `before` may be left out; the channel always carries it, as null. */
  conversation(peer: string, before?: string | null, limit?: number): Promise<DmResult<DmConversationPage>>;
  openConversation: IpcInvoker<'dm:open-conversation'>;
  closeConversation: IpcInvoker<'dm:close-conversation'>;
  sendFriendRequest: IpcInvoker<'dm:friend-request'>;
  acceptFriend: IpcInvoker<'dm:friend-accept'>;
  declineFriend: IpcInvoker<'dm:friend-decline'>;
  cancelFriendRequest: IpcInvoker<'dm:friend-cancel'>;
  removeFriend: IpcInvoker<'dm:friend-remove'>;
  block: IpcInvoker<'dm:block'>;
  unblock: IpcInvoker<'dm:unblock'>;
  sendMessage: IpcInvoker<'dm:send'>;
  editMessage: IpcInvoker<'dm:edit'>;
  deleteMessage: IpcInvoker<'dm:delete'>;
  react: IpcInvoker<'dm:react'>;
  markRead: IpcInvoker<'dm:mark-read'>;
  typing: IpcInvoker<'dm:typing'>;
  ingest: IpcInvoker<'dm:ingest'>;
  outgoing(peers: string[], force?: boolean): Promise<DmResult<DmDispatch>>;
  /** `announce` (default true) also starts the own-device history/profile exchange. */
  hello(toFriends: boolean, announce?: boolean): Promise<DmResult<DmDispatch>>;
  helloTo: IpcInvoker<'dm:hello-to'>;
  pendingPeers: IpcInvoker<'dm:pending-peers'>;
  observePeer: IpcInvoker<'dm:observe-peer'>;
  setSelfNickname: IpcInvoker<'dm:set-self-nickname'>;
  setSelfProfile: IpcInvoker<'dm:set-self-profile'>;
  updateSettings: IpcInvoker<'dm:update-settings'>;
  readAttachment: IpcInvoker<'dm:read-attachment'>;
  saveAttachment: IpcInvoker<'dm:save-attachment'>;
  retryAttachment: IpcInvoker<'dm:retry-attachment'>;
  onEvent(callback: (event: DmEvent) => void): () => void;
}
