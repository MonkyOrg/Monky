/**
 * Client-side contracts for friends and direct messages (#743).
 *
 * The relay server only moves opaque items between identities. Everything in
 * this file is between the client's main process (crypto + encrypted store) and
 * the renderer (transport over the server sessions + UI).
 */

import type { DmRelayItem, DmRelayKind } from './protocol.js';
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
  pendingPeers: 'dm:pending-peers',
} as const;

export const DM_EVENT = 'dm:event';

export interface DmIncomingRelayItem {
  /** Sender identity, stamped by the server. */
  from: string;
  kind: DmRelayKind;
  data: string;
}

/**
 * What the renderer must send after a DM operation.
 * - `peers`: per recipient, send on every session where that identity is reachable.
 * - `broadcast`: send on every connected session (own-device copies, hellos).
 * - `reply`: send on the session the ingested item arrived on.
 */
export interface DmDispatch {
  peers?: Record<string, DmRelayItem[]>;
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
}

export interface DmObservedPeer {
  publicKey: string;
  nickname?: string;
  avatar?: string | null;
}

export type DmEvent =
  | { type: 'snapshot'; snapshot: DmSnapshot }
  | { type: 'messages'; peer: string; messages: DmMessageView[]; peerReadAt: number }
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

/** Renderer-facing bridge exposed as `window.api.dm`. */
export interface DmApi {
  snapshot(): Promise<DmResult<DmSnapshot>>;
  conversation(peer: string, before?: string | null, limit?: number): Promise<DmResult<DmConversationPage>>;
  openConversation(peer: string): Promise<DmResult<void>>;
  closeConversation(peer: string): Promise<DmResult<void>>;
  sendFriendRequest(peer: string, nickname?: string): Promise<DmResult<DmDispatch>>;
  acceptFriend(peer: string): Promise<DmResult<DmDispatch>>;
  declineFriend(peer: string): Promise<DmResult<DmDispatch>>;
  cancelFriendRequest(peer: string): Promise<DmResult<DmDispatch>>;
  removeFriend(peer: string): Promise<DmResult<DmDispatch>>;
  block(peer: string, nickname?: string): Promise<DmResult<DmDispatch>>;
  unblock(peer: string): Promise<DmResult<DmDispatch>>;
  sendMessage(input: DmSendMessageInput): Promise<DmResult<DmDispatch>>;
  editMessage(peer: string, messageId: string, content: string): Promise<DmResult<DmDispatch>>;
  deleteMessage(peer: string, messageId: string): Promise<DmResult<DmDispatch>>;
  react(peer: string, messageId: string, emoji: string, add: boolean): Promise<DmResult<DmDispatch>>;
  markRead(peer: string): Promise<DmResult<DmDispatch>>;
  typing(peer: string): Promise<DmResult<DmDispatch>>;
  ingest(item: DmIncomingRelayItem): Promise<DmResult<DmDispatch>>;
  outgoing(peers: string[], force?: boolean): Promise<DmResult<DmDispatch>>;
  hello(toFriends: boolean): Promise<DmResult<DmDispatch>>;
  helloTo(peer: string): Promise<DmResult<DmDispatch>>;
  pendingPeers(): Promise<DmResult<string[]>>;
  observePeer(peer: DmObservedPeer): Promise<DmResult<void>>;
  setSelfNickname(nickname: string): Promise<DmResult<void>>;
  updateSettings(settings: Partial<DmSettings>): Promise<DmResult<DmDispatch>>;
  readAttachment(peer: string, messageId: string, fileId: string): Promise<DmResult<DmAttachmentData>>;
  saveAttachment(peer: string, messageId: string, fileId: string): Promise<DmResult<boolean>>;
  retryAttachment(peer: string, messageId: string, fileId: string): Promise<DmResult<DmDispatch>>;
  onEvent(callback: (event: DmEvent) => void): () => void;
}
