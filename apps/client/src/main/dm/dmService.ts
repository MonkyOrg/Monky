import { createHash } from 'crypto';
import {
  DM_DEFAULT_MAX_FILE_BYTES,
  DM_MAX_ATTACHMENTS,
  DM_MAX_FILE_BYTES_LIMIT,
  DM_MAX_MESSAGE_LENGTH,
  DM_PROFILE_AVATAR_MAX_LENGTH,
  type DmAttachmentState,
  type DmAttachmentView,
  type DmConversationPage,
  type DmConversationSummary,
  type DmDeliveryState,
  type DmDispatch,
  type DmErrorCode,
  type DmEvent,
  type DmIncomingRelayItem,
  type DmMessageView,
  type DmObservedPeer,
  type DmPeerView,
  type DmRelation,
  type DmRelayItem,
  type DmSelfProfile,
  type DmSelfProfileInput,
  type DmSelfProfileResult,
  type DmSendMessageInput,
  type DmSettings,
  type DmSnapshot,
} from '@monky/shared';
import {
  DmKeyring,
  isIdentityPublicKey,
  newDmId,
  normalizeIdentityKey,
  verifyDmCertificate,
  verifyDmStatement,
  type DmEnvelopeHeader,
  type DmKeyCertificate,
} from './dmCrypto';
import { DmPersistence } from './dmPersistence';

/**
 * Friends and direct messages engine (#743), running in the main process.
 *
 * It owns the encrypted local store and all crypto. It never talks to a server
 * directly: every operation returns a {@link DmDispatch} with the sealed relay
 * items the renderer must push through the server sessions where the peer is
 * reachable. Servers only relay, so delivery is store-and-forward on the
 * devices: unacknowledged items stay in a per-peer outbox and are resent when
 * the peer shows up again.
 */

const STATE_FILE = 'state.mkdm';
export const DM_FILE_CHUNK_BYTES = 96 * 1024;
const FILE_WINDOW_CHUNKS = 6;
const RESEND_AFTER_MS = 20_000;
const DOWNLOAD_STALL_MS = 8_000;
const MAX_SEEN_STATEMENTS = 500;
const MAX_NICKNAME_LENGTH = 64;
const MAX_AVATAR_URL_LENGTH = 2048;
const MAX_INLINE_AVATAR_LENGTH = 512 * 1024;
const MAX_EMOJI_LENGTH = 64;
const MAX_SYNC_ITEM_CHARS = 40_000;
const MAX_FILE_NAME_LENGTH = 200;
const PAGE_SIZE = 80;
const FILE_CACHE_TTL_MS = 60_000;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const DAY_MS = 86_400_000;
/** Own-device exchanges arrive once per shared server; identical copies within this window are answered once. */
const SELF_REPEAT_WINDOW_MS = 30_000;
const MAX_DIGEST_DAYS = 1000;
/** Plaintext bytes per sealed item, so the relay's 64 KiB item limit holds after encryption. */
const MAX_SEALED_ITEM_BYTES = 44_000;
const MAX_HISTORY_RESPONSE_BYTES = 600_000;
const MAX_HISTORY_ROUNDS = 50;
const MAX_DIGEST_PARTS = 200;
const PENDING_DIGEST_TTL_MS = 60_000;

type StatementType = 'request' | 'accept' | 'cancel' | 'remove';

interface FriendStatementPayload {
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

interface SignedStatement {
  p: FriendStatementPayload;
  s: string;
}

interface PeerRecord {
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

interface OutboxEntry {
  id: string;
  kind: 'friend' | 'envelope';
  type: string;
  ts: number;
  body?: unknown;
  statement?: SignedStatement;
  lastSentAt: number;
}

interface ConversationMeta {
  lastMessageAt: number;
  lastMessagePreview: string;
  lastMessageAuthor: string | null;
  unread: number;
  lastReadAt: number;
  peerReadAt: number;
  hidden: boolean;
  messageCount: number;
}

interface DownloadState {
  peer: string;
  messageId: string;
  fileId: string;
  size: number;
  sha256: string;
  requestedUntil: number;
  lastActivityAt: number;
}

interface DmState {
  version: 1;
  identity: string;
  settings: DmSettings;
  peers: Record<string, PeerRecord>;
  outbox: Record<string, OutboxEntry[]>;
  conversations: Record<string, ConversationMeta>;
  downloads: Record<string, DownloadState>;
  profile: DmSelfProfile;
}

interface StoredAttachment {
  fileId: string;
  name: string;
  size: number;
  mime: string;
  sha256: string;
  state: DmAttachmentState;
  receivedBytes: number;
}

type StoredReactions = Record<string, Record<string, { on: boolean; ts: number }>>;

interface StoredMessage {
  id: string;
  author: string;
  content: string;
  createdAt: number;
  editedAt: number | null;
  deleted: boolean;
  replyTo: string | null;
  reactions: StoredReactions;
  attachments: StoredAttachment[];
  delivery: DmDeliveryState | null;
}

interface StoredConversation {
  version: 1;
  peer: string;
  messages: StoredMessage[];
}

interface AttachmentMeta {
  fileId: string;
  name: string;
  size: number;
  mime: string;
  sha256: string;
}

interface SyncEntry {
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
  conversations?: StoredConversation[];
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeNickname(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NICKNAME_LENGTH);
  return trimmed || fallback;
}

function sanitizeAvatar(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  if (value.startsWith('data:image/')) {
    return value.length <= MAX_INLINE_AVATAR_LENGTH ? value : null;
  }
  if (/^https?:\/\//i.test(value) && value.length <= MAX_AVATAR_URL_LENGTH) return value;
  return null;
}

/** Avatars that travel inside DMs must be small inline images, never remote URLs. */
function sanitizeProfileAvatar(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > DM_PROFILE_AVATAR_MAX_LENGTH) return null;
  return /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : null;
}

function profileHash(nickname: string, avatar: string | null): string {
  return createHash('sha256').update(`${nickname}\n${avatar ?? ''}`).digest('hex').slice(0, 16);
}

/** Last-writer-wins with a deterministic tie-break, so every device converges. */
function profileFieldWins(at: number, value: string, currentAt: number, current: string): boolean {
  if (at !== currentAt) return at > currentAt;
  return at > 0 && value !== current && value > current;
}

function emptyProfile(): DmSelfProfile {
  return { nickname: '', nicknameAt: 0, avatar: null, avatarAt: 0 };
}

function sanitizeSelfProfile(value: unknown): DmSelfProfile {
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

function utf8Length(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/** What decides whether two devices hold the same version of a message. */
function messageFingerprint(message: StoredMessage): string {
  const reactions = Object.entries(message.reactions)
    .flatMap(([emoji, users]) => Object.entries(users).map(([user, value]) => `${emoji}:${user}:${value.on ? 1 : 0}:${value.ts}`))
    .sort()
    .join(',');
  return `${message.id}|${message.deleted ? 1 : 0}|${message.editedAt ?? 0}|${reactions};`;
}

interface DigestConversation {
  p: string;
  lr: number;
  pr: number;
  /** Oldest day listed when the digest was truncated; 0 when complete. */
  from: number;
  /** `day:hash` pairs separated by commas. */
  b: string;
}

interface PendingDigest {
  parts: Array<Record<string, unknown> | undefined>;
  received: number;
  at: number;
}

function clampMaxFileBytes(value: unknown, fallback = DM_DEFAULT_MAX_FILE_BYTES): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), DM_MAX_FILE_BYTES_LIMIT);
}

function isDmId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
}

function previewOf(message: StoredMessage): string {
  if (message.deleted) return '';
  const text = message.content.replace(/\s+/g, ' ').trim();
  if (text) return text.slice(0, 120);
  if (message.attachments.length > 0) return message.attachments.map((file) => file.name).join(', ').slice(0, 120);
  return '';
}

function sanitizeAttachmentMeta(value: unknown): AttachmentMeta | null {
  if (!isRecord(value)) return null;
  const { fileId, name, size, mime, sha256 } = value;
  if (!isDmId(fileId)) return null;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 || size > DM_MAX_FILE_BYTES_LIMIT) return null;
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  const safeName = typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f/\\]/g, '_').trim().slice(0, MAX_FILE_NAME_LENGTH) : '';
  const safeMime = typeof mime === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(mime) && mime.length <= 128 ? mime : 'application/octet-stream';
  return { fileId, name: safeName || 'arquivo', size, mime: safeMime, sha256 };
}

export interface DmServiceOptions {
  keyring: DmKeyring;
  dir: string;
  now?: () => number;
  onEvent?: (event: DmEvent) => void;
}

export class DmService {
  readonly me: string;
  private readonly keyring: DmKeyring;
  private readonly store: DmPersistence;
  private readonly now: () => number;
  private readonly onEvent: (event: DmEvent) => void;
  private state: DmState;
  private readonly conversations = new Map<string, StoredConversation>();
  private readonly fileCache = new Map<string, { data: Buffer; expiresAt: number }>();
  private snapshotTimer: NodeJS.Timeout | null = null;
  private lastStamp = 0;
  /** Identifies this running device in own-device exchanges. */
  readonly device = newDmId();
  private readonly lastDigest = new Map<string, { hash: string; at: number }>();
  private readonly profileSentTo = new Map<string, { key: string; at: number }>();
  private readonly digestRounds = new Map<string, number>();
  /** `peer:day:hash` already sent to each own device, so copies of a digest do not resend history. */
  private readonly pushedDays = new Map<string, Set<string>>();
  private readonly pendingDigests = new Map<string, PendingDigest>();
  private readonly dayBucketCache = new Map<string, Map<number, string>>();

  constructor(options: DmServiceOptions) {
    this.keyring = options.keyring;
    this.me = keyringIdentity(options.keyring);
    this.store = new DmPersistence(options.dir, options.keyring.storageKey());
    this.now = options.now ?? Date.now;
    this.onEvent = options.onEvent ?? (() => undefined);
    this.state = this.loadState();
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  private loadState(): DmState {
    let loaded: DmState | null = null;
    try {
      loaded = this.store.readJson<DmState>(STATE_FILE);
    } catch (error) {
      console.error('[DM] Estado local ilegível; iniciando vazio.', error);
    }
    const empty: DmState = {
      version: 1,
      identity: this.me,
      settings: { maxFileBytes: DM_DEFAULT_MAX_FILE_BYTES },
      peers: {},
      outbox: {},
      conversations: {},
      downloads: {},
      profile: emptyProfile(),
    };
    if (!loaded || loaded.identity !== this.me) return empty;
    return {
      ...empty,
      ...loaded,
      settings: { maxFileBytes: clampMaxFileBytes(loaded.settings?.maxFileBytes) },
      peers: loaded.peers ?? {},
      outbox: loaded.outbox ?? {},
      conversations: loaded.conversations ?? {},
      downloads: loaded.downloads ?? {},
      profile: sanitizeSelfProfile(loaded.profile),
    };
  }

  private saveState(): void {
    this.store.writeJsonSoon(STATE_FILE, () => this.state);
  }

  /**
   * Lamport-style clock for locally created operations. It is strictly
   * increasing, so operations created in the same millisecond keep their order
   * and survive last-writer-wins checks, and it never falls behind messages
   * already seen, so a reply always sorts after the message it answers even
   * when the peer's clock runs ahead (bounded by MAX_CLOCK_SKEW_MS).
   */
  private stamp(): number {
    this.lastStamp = Math.max(this.now(), this.lastStamp + 1);
    return this.lastStamp;
  }

  private observeStamp(ts: number): void {
    if (ts > this.lastStamp) this.lastStamp = ts;
  }

  private conversation(peer: string): StoredConversation {
    const cached = this.conversations.get(peer);
    if (cached) return cached;
    let loaded: StoredConversation | null = null;
    try {
      loaded = this.store.readJson<StoredConversation>(DmPersistence.peerFileName(peer));
    } catch (error) {
      console.error('[DM] Conversa ilegível; mantendo vazia.', error);
    }
    const conversation: StoredConversation =
      loaded && loaded.peer === peer && Array.isArray(loaded.messages)
        ? loaded
        : { version: 1, peer, messages: [] };
    this.conversations.set(peer, conversation);
    return conversation;
  }

  private saveConversation(peer: string): void {
    this.dayBucketCache.delete(peer);
    this.store.writeJsonSoon(DmPersistence.peerFileName(peer), () => this.conversation(peer));
  }

  flush(): void {
    this.store.flush();
  }

  /** Stops timers and forgets pending writes; used right before the store is deleted. */
  discard(): void {
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.snapshotTimer = null;
    this.store.discardPending();
    this.conversations.clear();
    this.fileCache.clear();
  }

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------

  private meta(peer: string): ConversationMeta {
    let meta = this.state.conversations[peer];
    if (!meta) {
      meta = {
        lastMessageAt: 0,
        lastMessagePreview: '',
        lastMessageAuthor: null,
        unread: 0,
        lastReadAt: 0,
        peerReadAt: 0,
        hidden: true,
        messageCount: 0,
      };
      this.state.conversations[peer] = meta;
    }
    return meta;
  }

  private peerView(record: PeerRecord): DmPeerView {
    return {
      publicKey: record.publicKey,
      nickname: record.nickname,
      avatar: record.avatar,
      relation: record.relation,
      blocked: record.blocked,
      friendSince: record.relation === 'friend' ? record.friendSince : null,
      requestedAt: record.relation === 'incoming' || record.relation === 'outgoing' ? record.requestedAt : null,
      maxFileBytes: record.maxFileBytes,
    };
  }

  snapshot(): DmSnapshot {
    const peers = Object.values(this.state.peers)
      .filter((peer) => peer.relation !== 'none' || peer.blocked || (this.state.conversations[peer.publicKey]?.messageCount ?? 0) > 0)
      .map((peer) => this.peerView(peer));
    const conversations: DmConversationSummary[] = Object.entries(this.state.conversations)
      .filter(([peer, meta]) => !!this.state.peers[peer] && (!meta.hidden || meta.messageCount > 0))
      .map(([peer, meta]) => ({
        peer,
        lastMessageAt: meta.lastMessageAt,
        lastMessagePreview: meta.lastMessagePreview,
        lastMessageAuthor: meta.lastMessageAuthor,
        unread: meta.unread,
        hidden: meta.hidden,
        readOnly: this.state.peers[peer]?.relation !== 'friend' || !!this.state.peers[peer]?.blocked,
      }))
      .sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    return {
      me: { publicKey: this.me },
      peers,
      conversations,
      settings: { ...this.state.settings },
    };
  }

  private messageView(peer: string, message: StoredMessage): DmMessageView {
    const meta = this.state.conversations[peer];
    let delivery = message.delivery;
    if (message.author === this.me && delivery === 'delivered' && meta && message.createdAt <= meta.peerReadAt) {
      delivery = 'read';
    }
    return {
      id: message.id,
      peer,
      author: message.author,
      content: message.deleted ? '' : message.content,
      createdAt: message.createdAt,
      editedAt: message.editedAt,
      deleted: message.deleted,
      replyTo: message.replyTo,
      reactions: Object.entries(message.reactions)
        .map(([emoji, users]) => ({
          emoji,
          users: Object.entries(users)
            .filter(([, value]) => value.on)
            .map(([user]) => user),
        }))
        .filter((reaction) => reaction.users.length > 0),
      attachments: message.deleted
        ? []
        : message.attachments.map<DmAttachmentView>((file) => ({
            fileId: file.fileId,
            name: file.name,
            size: file.size,
            mime: file.mime,
            state: file.state,
            receivedBytes: file.receivedBytes,
          })),
      delivery: message.author === this.me ? delivery ?? 'delivered' : null,
    };
  }

  getConversation(peerKey: string, before?: string | null, limit = PAGE_SIZE): DmConversationPage {
    const peer = this.requirePeerKey(peerKey);
    const messages = this.conversation(peer).messages;
    let end = messages.length;
    if (before) {
      const index = messages.findIndex((message) => message.id === before);
      if (index >= 0) end = index;
    }
    const start = Math.max(0, end - Math.max(1, Math.min(limit, 500)));
    return {
      peer,
      messages: messages.slice(start, end).map((message) => this.messageView(peer, message)),
      hasMore: start > 0,
      peerReadAt: this.state.conversations[peer]?.peerReadAt ?? 0,
    };
  }

  private scheduleSnapshot(): void {
    if (this.snapshotTimer) return;
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      this.onEvent({ type: 'snapshot', snapshot: this.snapshot() });
    }, 30);
    this.snapshotTimer.unref?.();
  }

  private emitMessages(peer: string, messages: StoredMessage[]): void {
    if (messages.length === 0) return;
    this.onEvent({
      type: 'messages',
      peer,
      messages: messages.map((message) => this.messageView(peer, message)),
      peerReadAt: this.state.conversations[peer]?.peerReadAt ?? 0,
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private requirePeerKey(value: unknown): string {
    if (!isIdentityPublicKey(value)) throw new DmError('invalid-peer', 'Identidade inválida.');
    const peer = normalizeIdentityKey(value);
    if (peer === this.me) throw new DmError('invalid-peer', 'Não é possível usar a própria identidade.');
    return peer;
  }

  private ensurePeer(publicKey: string, nickname?: string): PeerRecord {
    let record = this.state.peers[publicKey];
    if (!record) {
      record = {
        publicKey,
        nickname: sanitizeNickname(nickname, publicKey.slice(-8)),
        avatar: null,
        cert: null,
        relation: 'none',
        requestId: null,
        outgoingStatement: null,
        relationUpdatedAt: 0,
        blocked: false,
        blockedUpdatedAt: 0,
        friendSince: null,
        requestedAt: null,
        maxFileBytes: DM_DEFAULT_MAX_FILE_BYTES,
        seenStatements: [],
      };
      this.state.peers[publicKey] = record;
    } else if (nickname) {
      record.nickname = sanitizeNickname(nickname, record.nickname);
    }
    return record;
  }

  private requireFriend(peerKey: string): PeerRecord {
    const peer = this.requirePeerKey(peerKey);
    const record = this.state.peers[peer];
    if (!record || record.relation !== 'friend' || !record.cert) {
      throw new DmError('not-friend', 'Vocês não são amigos.');
    }
    if (record.blocked) throw new DmError('blocked', 'Usuário bloqueado.');
    return record;
  }

  private myNickname(): string {
    return sanitizeNickname(this.state.profile.nickname || this.selfNickname, 'Monky');
  }

  private selfNickname = '';

  setSelfNickname(nickname: string): void {
    this.selfNickname = sanitizeNickname(nickname, '');
  }

  private signStatement(type: StatementType, to: string, requestId: string): SignedStatement {
    const payload: FriendStatementPayload = {
      v: 1,
      type,
      id: newDmId(),
      requestId,
      from: this.me,
      to,
      ts: this.stamp(),
      cert: this.keyring.certificate(),
      nickname: this.myNickname(),
      maxFileBytes: this.state.settings.maxFileBytes,
    };
    return { p: payload, s: this.keyring.signStatement(payload) };
  }

  private statementItem(statement: SignedStatement): DmRelayItem {
    return { to: statement.p.to, kind: 'friend', data: JSON.stringify(statement) };
  }

  private seal(peer: string, cert: DmKeyCertificate, type: string, body: unknown, id = newDmId(), ts = this.stamp()): string {
    return this.keyring.seal(peer, cert, { id, type, ts }, body);
  }

  private envelopeItem(record: PeerRecord, type: string, body: unknown, kind: DmRelayItem['kind'] = 'signal'): DmRelayItem {
    if (!record.cert) throw new DmError('not-friend', 'Certificado do amigo ausente.');
    return { to: record.publicKey, kind, data: this.seal(record.publicKey, record.cert, type, body) };
  }

  private selfItem(type: string, body: unknown, kind: DmRelayItem['kind'] = 'envelope'): DmRelayItem {
    return { to: this.me, kind, data: this.seal(this.me, this.keyring.certificate(), type, body) };
  }

  private outbox(peer: string): OutboxEntry[] {
    let entries = this.state.outbox[peer];
    if (!entries) {
      entries = [];
      this.state.outbox[peer] = entries;
    }
    return entries;
  }

  private outboxItem(record: PeerRecord, entry: OutboxEntry): DmRelayItem | null {
    if (entry.kind === 'friend' && entry.statement) {
      return this.statementItem(entry.statement);
    }
    if (!record.cert) return null;
    return {
      to: record.publicKey,
      kind: 'envelope',
      data: this.seal(record.publicKey, record.cert, entry.type, entry.body, entry.id, entry.ts),
    };
  }

  private queueStatement(record: PeerRecord, statement: SignedStatement): DmRelayItem {
    const now = this.now();
    this.outbox(record.publicKey).push({
      id: statement.p.id,
      kind: 'friend',
      type: statement.p.type,
      ts: statement.p.ts,
      statement,
      lastSentAt: now,
    });
    return this.statementItem(statement);
  }

  private queueEnvelope(record: PeerRecord, type: string, body: unknown, id = newDmId(), ts = this.stamp()): DmRelayItem | null {
    const entry: OutboxEntry = { id, kind: 'envelope', type, ts, body, lastSentAt: this.now() };
    this.outbox(record.publicKey).push(entry);
    return this.outboxItem(record, entry);
  }

  private selfCopy(peer: string, type: string, id: string, ts: number, body: unknown): DmRelayItem {
    return this.selfItem('self', { peer, op: { id, type, ts, body } });
  }

  private syncEntry(record: PeerRecord): SyncEntry {
    return {
      publicKey: record.publicKey,
      nickname: record.nickname,
      cert: record.cert,
      relation: record.relation,
      requestId: record.requestId,
      outgoingStatement: record.outgoingStatement,
      relationUpdatedAt: record.relationUpdatedAt,
      blocked: record.blocked,
      blockedUpdatedAt: record.blockedUpdatedAt,
      friendSince: record.friendSince,
      requestedAt: record.requestedAt,
    };
  }

  private syncItems(records?: PeerRecord[]): DmRelayItem[] {
    const entries = (records ?? Object.values(this.state.peers))
      .filter((record) => record.relationUpdatedAt > 0 || record.blockedUpdatedAt > 0)
      .map((record) => this.syncEntry(record));
    const items: DmRelayItem[] = [];
    let batch: SyncEntry[] = [];
    let batchSize = 0;
    const pushBatch = () => {
      if (batch.length === 0) return;
      items.push(this.selfItem('sync', { entries: batch }, 'signal'));
      batch = [];
      batchSize = 0;
    };
    for (const entry of entries) {
      const size = JSON.stringify(entry).length;
      if (batchSize + size > MAX_SYNC_ITEM_CHARS) pushBatch();
      batch.push(entry);
      batchSize += size;
    }
    pushBatch();
    if (items.length === 0 && !records) {
      items.push(this.selfItem('sync', { entries: [] }, 'signal'));
    }
    return items;
  }

  private dispatchFor(peer: string, items: Array<DmRelayItem | null>, broadcast: DmRelayItem[] = []): DmDispatch {
    const list = items.filter((item): item is DmRelayItem => !!item);
    const dispatch: DmDispatch = {};
    if (list.length > 0) dispatch.peers = { [peer]: list };
    if (broadcast.length > 0) dispatch.broadcast = broadcast;
    return dispatch;
  }

  private changed(peer?: string): void {
    this.saveState();
    if (peer) this.saveConversation(peer);
    this.scheduleSnapshot();
  }

  // ---------------------------------------------------------------------------
  // Friends
  // ---------------------------------------------------------------------------

  sendFriendRequest(peerKey: string, nickname?: string): DmDispatch {
    const peer = this.requirePeerKey(peerKey);
    const record = this.ensurePeer(peer, nickname);
    if (record.blocked) throw new DmError('blocked', 'Desbloqueie o usuário antes de enviar o pedido.');
    if (record.relation === 'friend' || record.relation === 'outgoing') return {};
    if (record.relation === 'incoming') return this.acceptFriend(peer);
    const requestId = newDmId();
    const statement = this.signStatement('request', peer, requestId);
    record.relation = 'outgoing';
    record.requestId = requestId;
    record.outgoingStatement = statement;
    record.requestedAt = statement.p.ts;
    record.relationUpdatedAt = statement.p.ts;
    const item = this.queueStatement(record, statement);
    this.changed();
    return this.dispatchFor(peer, [item], this.syncItems([record]));
  }

  acceptFriend(peerKey: string): DmDispatch {
    const peer = this.requirePeerKey(peerKey);
    const record = this.state.peers[peer];
    if (!record || record.relation !== 'incoming' || !record.cert || !record.requestId) {
      throw new DmError('not-found', 'Pedido de amizade não encontrado.');
    }
    const statement = this.signStatement('accept', peer, record.requestId);
    record.relation = 'friend';
    record.friendSince = statement.p.ts;
    record.relationUpdatedAt = statement.p.ts;
    record.outgoingStatement = null;
    const item = this.queueStatement(record, statement);
    this.meta(peer);
    this.changed();
    return this.dispatchFor(peer, [item], this.syncItems([record]));
  }

  declineFriend(peerKey: string): DmDispatch {
    const peer = this.requirePeerKey(peerKey);
    const record = this.state.peers[peer];
    if (!record || record.relation !== 'incoming') return {};
    record.relation = 'none';
    record.requestId = null;
    record.requestedAt = null;
    record.relationUpdatedAt = this.stamp();
    this.changed();
    return { broadcast: this.syncItems([record]) };
  }

  cancelFriendRequest(peerKey: string): DmDispatch {
    const peer = this.requirePeerKey(peerKey);
    const record = this.state.peers[peer];
    if (!record || record.relation !== 'outgoing' || !record.requestId) return {};
    const statement = this.signStatement('cancel', peer, record.requestId);
    this.state.outbox[peer] = this.outbox(peer).filter((entry) => !(entry.kind === 'friend' && entry.type === 'request'));
    record.relation = 'none';
    record.requestId = null;
    record.requestedAt = null;
    record.outgoingStatement = null;
    record.relationUpdatedAt = statement.p.ts;
    const item = this.queueStatement(record, statement);
    this.changed();
    return this.dispatchFor(peer, [item], this.syncItems([record]));
  }

  private dropPendingEnvelopes(peer: string): void {
    const entries = this.state.outbox[peer] ?? [];
    const failedIds = new Set(entries.filter((entry) => entry.kind === 'envelope' && entry.type === 'msg').map((entry) => entry.id));
    this.state.outbox[peer] = entries.filter((entry) => entry.kind === 'friend');
    if (failedIds.size === 0) return;
    const changed: StoredMessage[] = [];
    for (const message of this.conversation(peer).messages) {
      if (failedIds.has(message.id) && message.delivery === 'pending') {
        message.delivery = 'failed';
        changed.push(message);
      }
    }
    this.emitMessages(peer, changed);
  }

  removeFriend(peerKey: string): DmDispatch {
    const peer = this.requirePeerKey(peerKey);
    const record = this.state.peers[peer];
    if (!record || record.relation !== 'friend') return {};
    const statement = this.signStatement('remove', peer, record.requestId ?? newDmId());
    this.dropPendingEnvelopes(peer);
    record.relation = 'none';
    record.friendSince = null;
    record.relationUpdatedAt = statement.p.ts;
    const item = this.queueStatement(record, statement);
    this.changed(peer);
    return this.dispatchFor(peer, [item], this.syncItems([record]));
  }

  block(peerKey: string, nickname?: string): DmDispatch {
    const peer = this.requirePeerKey(peerKey);
    const record = this.ensurePeer(peer, nickname);
    if (record.blocked) return {};
    const items: DmRelayItem[] = [];
    const now = this.stamp();
    if (record.relation === 'friend') {
      const statement = this.signStatement('remove', peer, record.requestId ?? newDmId());
      this.dropPendingEnvelopes(peer);
      items.push(this.queueStatement(record, statement));
    } else if (record.relation === 'outgoing' && record.requestId) {
      this.state.outbox[peer] = this.outbox(peer).filter((entry) => entry.type !== 'request');
      items.push(this.queueStatement(record, this.signStatement('cancel', peer, record.requestId)));
    }
    if (record.relation !== 'none') {
      record.relation = 'none';
      record.requestId = null;
      record.requestedAt = null;
      record.friendSince = null;
      record.outgoingStatement = null;
      record.relationUpdatedAt = now;
    }
    record.blocked = true;
    record.blockedUpdatedAt = now;
    this.changed(peer);
    return this.dispatchFor(peer, items, this.syncItems([record]));
  }

  unblock(peerKey: string): DmDispatch {
    const peer = this.requirePeerKey(peerKey);
    const record = this.state.peers[peer];
    if (!record || !record.blocked) return {};
    record.blocked = false;
    record.blockedUpdatedAt = this.stamp();
    this.changed();
    return { broadcast: this.syncItems([record]) };
  }

  observePeer(observed: DmObservedPeer): void {
    if (!isIdentityPublicKey(observed?.publicKey)) return;
    const peer = normalizeIdentityKey(observed.publicKey);
    const record = this.state.peers[peer];
    if (!record) return;
    let dirty = false;
    // What the friend sent us beats what servers show.
    if (observed.nickname !== undefined && !(record.profileAt && record.profileAt > 0)) {
      const nickname = sanitizeNickname(observed.nickname, record.nickname);
      if (nickname !== record.nickname) {
        record.nickname = nickname;
        dirty = true;
      }
    }
    if (observed.avatar !== undefined && !record.profileAvatar) {
      const avatar = sanitizeAvatar(observed.avatar);
      if (avatar !== record.avatar) {
        record.avatar = avatar;
        dirty = true;
      }
    }
    if (dirty) this.changed();
  }

  updateSettings(settings: Partial<DmSettings>): DmDispatch {
    if (settings.maxFileBytes !== undefined) {
      this.state.settings.maxFileBytes = clampMaxFileBytes(settings.maxFileBytes, this.state.settings.maxFileBytes);
    }
    this.changed();
    return { broadcast: this.friendHellos() };
  }

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------

  openConversation(peerKey: string): void {
    const peer = this.requirePeerKey(peerKey);
    if (!this.state.peers[peer]) throw new DmError('not-found', 'Conversa não encontrada.');
    this.meta(peer).hidden = false;
    this.changed();
  }

  closeConversation(peerKey: string): void {
    const peer = this.requirePeerKey(peerKey);
    const meta = this.state.conversations[peer];
    if (!meta) return;
    meta.hidden = true;
    this.changed();
  }

  private insertMessage(peer: string, message: StoredMessage): boolean {
    const conversation = this.conversation(peer);
    if (conversation.messages.some((existing) => existing.id === message.id)) return false;
    let index = conversation.messages.length;
    // Equal timestamps only happen across authors; the id keeps every device in the same order.
    while (
      index > 0 &&
      (conversation.messages[index - 1].createdAt > message.createdAt ||
        (conversation.messages[index - 1].createdAt === message.createdAt && conversation.messages[index - 1].id > message.id))
    ) {
      index -= 1;
    }
    conversation.messages.splice(index, 0, message);
    this.refreshMeta(peer);
    return true;
  }

  private refreshMeta(peer: string): void {
    const meta = this.meta(peer);
    const messages = this.conversation(peer).messages;
    const visible = messages.filter((message) => !message.deleted);
    const last = visible[visible.length - 1];
    meta.messageCount = visible.length;
    meta.lastMessageAt = Math.max(meta.lastMessageAt, last?.createdAt ?? 0);
    meta.lastMessagePreview = last ? previewOf(last) : '';
    meta.lastMessageAuthor = last?.author ?? null;
    meta.unread = visible.filter((message) => message.author !== this.me && message.createdAt > meta.lastReadAt).length;
  }

  private findMessage(peer: string, id: unknown): StoredMessage | null {
    if (typeof id !== 'string') return null;
    return this.conversation(peer).messages.find((message) => message.id === id) ?? null;
  }

  sendMessage(input: DmSendMessageInput): DmDispatch {
    const record = this.requireFriend(input.peer);
    const peer = record.publicKey;
    const content = typeof input.content === 'string' ? input.content.replace(/\r\n/g, '\n').trim() : '';
    const files = Array.isArray(input.files) ? input.files : [];
    if (!content && files.length === 0) throw new DmError('empty-message', 'Mensagem vazia.');
    if (content.length > DM_MAX_MESSAGE_LENGTH) {
      throw new DmError('message-too-long', 'Mensagem muito longa.', { limit: DM_MAX_MESSAGE_LENGTH });
    }
    if (files.length > DM_MAX_ATTACHMENTS) {
      throw new DmError('too-many-files', 'Arquivos demais.', { limit: DM_MAX_ATTACHMENTS });
    }
    for (const file of files) {
      const size = file?.data?.byteLength ?? 0;
      if (size > record.maxFileBytes) {
        throw new DmError('file-too-large', 'Arquivo acima do limite do amigo.', {
          limit: record.maxFileBytes,
          nickname: record.nickname,
          name: file?.name ?? '',
        });
      }
    }
    const replyTo = input.replyTo && this.findMessage(peer, input.replyTo) ? input.replyTo : null;
    const attachments: StoredAttachment[] = files.map((file) => {
      const data = Buffer.from(file.data);
      const meta = sanitizeAttachmentMeta({
        fileId: newDmId(),
        name: file.name,
        size: data.length,
        mime: file.mime,
        sha256: createHash('sha256').update(data).digest('hex'),
      })!;
      this.store.writeAttachment(meta.fileId, data);
      return { ...meta, state: 'local', receivedBytes: meta.size };
    });
    const id = newDmId();
    const ts = this.stamp();
    const message: StoredMessage = {
      id,
      author: this.me,
      content,
      createdAt: ts,
      editedAt: null,
      deleted: false,
      replyTo,
      reactions: {},
      attachments,
      delivery: 'pending',
    };
    const meta = this.meta(peer);
    meta.hidden = false;
    this.insertMessage(peer, message);
    meta.lastReadAt = Math.max(meta.lastReadAt, ts);
    this.refreshMeta(peer);
    const body = {
      content,
      replyTo,
      attachments: attachments.map(({ fileId, name, size, mime, sha256 }) => ({ fileId, name, size, mime, sha256 })),
    };
    const item = this.queueEnvelope(record, 'msg', body, id, ts);
    this.changed(peer);
    this.emitMessages(peer, [message]);
    return this.dispatchFor(peer, [item], [this.selfCopy(peer, 'msg', id, ts, body)]);
  }

  editMessage(peerKey: string, messageId: string, contentInput: string): DmDispatch {
    const record = this.requireFriend(peerKey);
    const peer = record.publicKey;
    const message = this.findMessage(peer, messageId);
    if (!message || message.author !== this.me || message.deleted) throw new DmError('not-found', 'Mensagem não encontrada.');
    const content = typeof contentInput === 'string' ? contentInput.replace(/\r\n/g, '\n').trim() : '';
    if (!content && message.attachments.length === 0) throw new DmError('empty-message', 'Mensagem vazia.');
    if (content.length > DM_MAX_MESSAGE_LENGTH) {
      throw new DmError('message-too-long', 'Mensagem muito longa.', { limit: DM_MAX_MESSAGE_LENGTH });
    }
    if (content === message.content) return {};
    const editedAt = this.stamp();
    message.content = content;
    message.editedAt = editedAt;
    this.refreshMeta(peer);
    const body = { messageId, content, editedAt };
    const pendingMessage = this.outbox(peer).find((entry) => entry.id === messageId && entry.type === 'msg');
    let item: DmRelayItem | null;
    if (pendingMessage && isRecord(pendingMessage.body)) {
      pendingMessage.body = { ...pendingMessage.body, content };
      item = this.outboxItem(record, pendingMessage);
    } else {
      item = this.queueEnvelope(record, 'edit', body);
    }
    this.changed(peer);
    this.emitMessages(peer, [message]);
    return this.dispatchFor(peer, [item], [this.selfCopy(peer, 'edit', newDmId(), editedAt, body)]);
  }

  private markDeleted(message: StoredMessage): void {
    message.deleted = true;
    message.content = '';
    for (const file of message.attachments) {
      this.store.deleteAttachment(file.fileId);
      this.fileCache.delete(file.fileId);
      delete this.state.downloads[file.fileId];
    }
    message.attachments = [];
    message.reactions = {};
  }

  deleteMessage(peerKey: string, messageId: string): DmDispatch {
    const peer = this.requirePeerKey(peerKey);
    const record = this.state.peers[peer];
    const message = this.findMessage(peer, messageId);
    if (!record || !message || message.deleted) throw new DmError('not-found', 'Mensagem não encontrada.');
    if (message.author !== this.me) throw new DmError('forbidden', 'Só é possível apagar as próprias mensagens.');
    this.markDeleted(message);
    this.refreshMeta(peer);
    const body = { messageId };
    const items: Array<DmRelayItem | null> = [];
    const outbox = this.outbox(peer);
    const pendingIndex = outbox.findIndex((entry) => entry.id === messageId && entry.type === 'msg');
    if (pendingIndex >= 0) {
      outbox.splice(pendingIndex, 1);
    } else if (record.relation === 'friend' && !record.blocked && record.cert) {
      items.push(this.queueEnvelope(record, 'delete', body));
    }
    this.changed(peer);
    this.emitMessages(peer, [message]);
    return this.dispatchFor(peer, items, [this.selfCopy(peer, 'delete', newDmId(), this.stamp(), body)]);
  }

  private applyReaction(message: StoredMessage, user: string, emoji: string, on: boolean, ts: number): boolean {
    const users = (message.reactions[emoji] ??= {});
    const current = users[user];
    if (current && current.ts >= ts) return false;
    users[user] = { on, ts };
    return true;
  }

  react(peerKey: string, messageId: string, emojiInput: string, add: boolean): DmDispatch {
    const record = this.requireFriend(peerKey);
    const peer = record.publicKey;
    const message = this.findMessage(peer, messageId);
    if (!message || message.deleted) throw new DmError('not-found', 'Mensagem não encontrada.');
    const emoji = typeof emojiInput === 'string' ? emojiInput.trim().slice(0, MAX_EMOJI_LENGTH) : '';
    if (!emoji) throw new DmError('empty-message', 'Reação inválida.');
    const ts = this.stamp();
    this.applyReaction(message, this.me, emoji, add !== false, ts);
    const body = { messageId, emoji, add: add !== false, at: ts };
    const item = this.queueEnvelope(record, 'react', body);
    this.changed(peer);
    this.emitMessages(peer, [message]);
    return this.dispatchFor(peer, [item], [this.selfCopy(peer, 'react', newDmId(), ts, body)]);
  }

  markRead(peerKey: string): DmDispatch {
    const peer = this.requirePeerKey(peerKey);
    const meta = this.state.conversations[peer];
    if (!meta) return {};
    const lastIncoming = [...this.conversation(peer).messages]
      .reverse()
      .find((message) => message.author !== this.me && !message.deleted);
    const readAt = Math.max(meta.lastReadAt, lastIncoming?.createdAt ?? 0);
    if (meta.unread === 0 && readAt === meta.lastReadAt) return {};
    const advanced = readAt > meta.lastReadAt;
    meta.lastReadAt = readAt;
    meta.unread = 0;
    this.changed();
    if (!advanced) return {};
    const body = { readAt };
    const broadcast = [this.selfCopy(peer, 'read', newDmId(), this.stamp(), body)];
    const record = this.state.peers[peer];
    if (!record || record.relation !== 'friend' || record.blocked || !record.cert) {
      return { broadcast };
    }
    this.state.outbox[peer] = this.outbox(peer).filter((entry) => entry.type !== 'read');
    const item = this.queueEnvelope(record, 'read', body);
    return this.dispatchFor(peer, [item], broadcast);
  }

  typing(peerKey: string): DmDispatch {
    const record = this.requireFriend(peerKey);
    return this.dispatchFor(record.publicKey, [this.envelopeItem(record, 'typing', {})]);
  }

  // ---------------------------------------------------------------------------
  // Delivery
  // ---------------------------------------------------------------------------

  /**
   * Items to announce this device on a freshly connected session: own-device
   * friend sync, plus hellos to every friend so co-present (possibly invisible)
   * friends flush their outbox to us. `toFriends` is false for visible clients
   * that only need the sync.
   */
  hello(toFriends: boolean, announce = true): DmDispatch {
    const broadcast = this.syncItems();
    if (announce) {
      // Other devices of this identity answer with what they have that this one lacks.
      broadcast.push(this.selfItem('hello-self', { device: this.device, reply: false, prof: this.profileSummary() }, 'signal'));
      broadcast.push(...this.digestItems(false, null));
    }
    if (toFriends) broadcast.push(...this.friendHellos());
    return { broadcast };
  }

  private friendHellos(): DmRelayItem[] {
    const items: DmRelayItem[] = [];
    for (const record of Object.values(this.state.peers)) {
      if (record.relation !== 'friend' || record.blocked || !record.cert) continue;
      items.push(this.envelopeItem(record, 'hello', this.friendHelloBody(false)));
    }
    return items;
  }

  private friendHelloBody(reply: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = { reply, maxFileBytes: this.state.settings.maxFileBytes };
    const profile = this.friendProfileBody();
    if (profile.at > 0) body.prof = { at: profile.at, h: profileHash(profile.nickname, profile.avatar) };
    return body;
  }

  /** Hello for one friend that just became reachable. */
  helloTo(peerKey: string): DmDispatch {
    const peer = this.requirePeerKey(peerKey);
    const record = this.state.peers[peer];
    if (!record || record.relation !== 'friend' || record.blocked || !record.cert) return {};
    return this.dispatchFor(peer, [this.envelopeItem(record, 'hello', this.friendHelloBody(false))]);
  }

  // ---------------------------------------------------------------------------
  // Profile (nickname + avatar that travel with the identity)
  // ---------------------------------------------------------------------------

  /**
   * Merges what the renderer has locally. Fields win by their timestamp, so a
   * value chosen on another device later is kept and handed back for the
   * renderer to apply. Values without a timestamp (profiles saved before the
   * sync existed) only fill an empty profile.
   */
  setSelfProfile(input: DmSelfProfileInput): DmSelfProfileResult {
    const changed = this.mergeOwnProfile(input, 1);
    if (changed) this.saveState();
    return { profile: { ...this.state.profile }, dispatch: changed ? this.profileDispatch() : {} };
  }

  private mergeOwnProfile(input: DmSelfProfileInput, minimumAt: number): boolean {
    const profile = this.state.profile;
    const limit = this.now() + MAX_CLOCK_SKEW_MS;
    const stamp = (at: unknown): number =>
      typeof at === 'number' && Number.isFinite(at) && at > 0 ? Math.min(at, limit) : 0;
    let changed = false;
    if (input.nickname !== undefined) {
      const nickname = sanitizeNickname(input.nickname, '');
      const at = nickname ? Math.max(stamp(input.nicknameAt), minimumAt) : 0;
      if (nickname && profileFieldWins(at, nickname, profile.nicknameAt, profile.nickname)) {
        profile.nickname = nickname;
        profile.nicknameAt = at;
        changed = true;
      }
    }
    if (input.avatar !== undefined) {
      const avatar = input.avatar === null ? null : sanitizeProfileAvatar(input.avatar);
      // A picture that does not fit is ignored rather than read as "no picture".
      if (input.avatar === null || avatar !== null) {
        const at = avatar ? Math.max(stamp(input.avatarAt), minimumAt) : stamp(input.avatarAt);
        if (profileFieldWins(at, avatar ?? '', profile.avatarAt, profile.avatar ?? '')) {
          profile.avatar = avatar;
          profile.avatarAt = at;
          changed = true;
        }
      }
    }
    if (changed) this.observeStamp(Math.max(profile.nicknameAt, profile.avatarAt));
    return changed;
  }

  private profileSummary(): Record<string, unknown> {
    const profile = this.state.profile;
    return {
      n: profile.nickname,
      na: profile.nicknameAt,
      aa: profile.avatarAt,
      ah: profileHash('', profile.avatar),
    };
  }

  private selfProfileItem(): DmRelayItem {
    return this.selfItem('profile', { ...this.state.profile }, 'file');
  }

  private friendProfileBody(): { nickname: string; avatar: string | null; at: number } {
    const profile = this.state.profile;
    return {
      nickname: this.myNickname(),
      avatar: profile.avatar,
      at: Math.max(profile.nicknameAt, profile.avatarAt),
    };
  }

  /** New profile: own devices get it now; friends now if reachable, otherwise on their next hello. */
  private profileDispatch(): DmDispatch {
    const peers: Record<string, DmRelayItem[]> = {};
    const body = this.friendProfileBody();
    if (body.at > 0) {
      for (const record of Object.values(this.state.peers)) {
        if (record.relation !== 'friend' || record.blocked || !record.cert) continue;
        peers[record.publicKey] = [this.envelopeItem(record, 'profile', body, 'file')];
      }
    }
    const dispatch: DmDispatch = { broadcast: [this.selfProfileItem()] };
    if (Object.keys(peers).length > 0) dispatch.peers = peers;
    return dispatch;
  }

  private applyFriendProfile(record: PeerRecord, data: Record<string, unknown>): void {
    const at = typeof data.at === 'number' && Number.isFinite(data.at) ? Math.min(data.at, this.now() + MAX_CLOCK_SKEW_MS) : 0;
    if (at <= 0 || at <= (record.profileAt ?? 0)) return;
    const rawNickname = typeof data.nickname === 'string' ? data.nickname : '';
    const rawAvatar = typeof data.avatar === 'string' ? data.avatar : null;
    record.nickname = sanitizeNickname(rawNickname, record.nickname);
    const avatar = sanitizeProfileAvatar(rawAvatar);
    if (avatar) {
      record.avatar = avatar;
      record.profileAvatar = true;
    } else if (record.profileAvatar) {
      // They removed the picture: let what servers show fill it again.
      record.avatar = null;
      record.profileAvatar = false;
    }
    record.profileAt = at;
    record.profileHash = profileHash(rawNickname, rawAvatar);
    this.changed();
  }

  // ---------------------------------------------------------------------------
  // Own-device sync (friends, history, read markers)
  // ---------------------------------------------------------------------------

  /** Per-day fingerprints of a conversation, cached until it changes. */
  private dayBuckets(peer: string): Map<number, string> {
    const cached = this.dayBucketCache.get(peer);
    if (cached) return cached;
    const hashes = new Map<number, ReturnType<typeof createHash>>();
    for (const message of this.conversation(peer).messages) {
      const day = Math.floor(message.createdAt / DAY_MS);
      let hash = hashes.get(day);
      if (!hash) {
        hash = createHash('sha256');
        hashes.set(day, hash);
      }
      hash.update(messageFingerprint(message));
    }
    const buckets = new Map<number, string>();
    for (const [day, hash] of hashes) buckets.set(day, hash.digest('hex').slice(0, 12));
    this.dayBucketCache.set(peer, buckets);
    return buckets;
  }

  /**
   * Summary of friends and history, split in sealed parts. Another own device
   * answers with the friends and days of history this one is missing.
   */
  private digestItems(cont: boolean, forDevice: string | null): DmRelayItem[] {
    const seq = newDmId();
    const peers = Object.values(this.state.peers)
      .filter((record) => record.relationUpdatedAt > 0 || record.blockedUpdatedAt > 0)
      .map((record) => [record.publicKey, record.relationUpdatedAt, record.blockedUpdatedAt]);
    const convs: DigestConversation[] = [];
    for (const [peer, meta] of Object.entries(this.state.conversations)) {
      if (!this.state.peers[peer]) continue;
      const days = [...this.dayBuckets(peer)].sort((a, b) => b[0] - a[0]);
      if (days.length === 0 && meta.lastReadAt === 0 && meta.peerReadAt === 0) continue;
      const kept = days.slice(0, MAX_DIGEST_DAYS);
      convs.push({
        p: peer,
        lr: meta.lastReadAt,
        pr: meta.peerReadAt,
        from: kept.length < days.length ? kept[kept.length - 1][0] : 0,
        b: kept.map(([day, hash]) => `${day}:${hash}`).join(','),
      });
    }
    const parts: Array<{ peers: unknown[]; convs: DigestConversation[] }> = [];
    let current = { peers: [] as unknown[], convs: [] as DigestConversation[] };
    let size = 0;
    const add = (kind: 'peers' | 'convs', entry: unknown) => {
      const length = utf8Length(JSON.stringify(entry)) + 1;
      if (size + length > MAX_SEALED_ITEM_BYTES - 400 && size > 0) {
        parts.push(current);
        current = { peers: [], convs: [] };
        size = 0;
      }
      (current[kind] as unknown[]).push(entry);
      size += length;
    };
    for (const entry of peers) add('peers', entry);
    for (const entry of convs) add('convs', entry);
    parts.push(current);
    const total = Math.min(parts.length, MAX_DIGEST_PARTS);
    return parts.slice(0, total).map((part, index) =>
      this.selfItem('digest', {
        device: this.device,
        seq,
        part: index,
        parts: total,
        cont,
        for: forDevice,
        peers: part.peers,
        convs: part.convs,
      }, 'signal'));
  }

  private receiveSelfHello(data: Record<string, unknown>): DmDispatch {
    const device = typeof data.device === 'string' && isDmId(data.device) ? data.device : null;
    if (!device || device === this.device) return {};
    const reply: DmRelayItem[] = [];
    if (data.reply !== true) {
      reply.push(this.selfItem('hello-self', { device: this.device, reply: true, prof: this.profileSummary() }, 'signal'));
      reply.push(...this.digestItems(false, null));
    }
    const prof = isRecord(data.prof) ? data.prof : {};
    const theirNicknameAt = typeof prof.na === 'number' ? prof.na : 0;
    const theirAvatarAt = typeof prof.aa === 'number' ? prof.aa : 0;
    if (typeof prof.n === 'string' && this.mergeOwnProfile({ nickname: prof.n, nicknameAt: theirNicknameAt }, 0)) {
      this.saveState();
      this.onEvent({ type: 'self-profile', profile: { ...this.state.profile } });
    }
    const mine = this.state.profile;
    const theirAvatarHash = typeof prof.ah === 'string' ? prof.ah : '';
    const avatarBehind = mine.avatarAt > theirAvatarAt
      || (mine.avatarAt === theirAvatarAt && mine.avatarAt > 0 && theirAvatarHash !== profileHash('', mine.avatar));
    if (avatarBehind || mine.nicknameAt > theirNicknameAt) {
      const key = `${mine.nicknameAt}:${mine.avatarAt}`;
      const now = this.now();
      const last = this.profileSentTo.get(device);
      if (!last || last.key !== key || now - last.at >= SELF_REPEAT_WINDOW_MS) {
        this.profileSentTo.set(device, { key, at: now });
        reply.push(this.selfProfileItem());
      }
    }
    return reply.length > 0 ? { reply } : {};
  }

  private receiveSelfProfile(data: Record<string, unknown>): DmDispatch {
    const changed = this.mergeOwnProfile({
      nickname: typeof data.nickname === 'string' ? data.nickname : undefined,
      nicknameAt: typeof data.nicknameAt === 'number' ? data.nicknameAt : 0,
      avatar: typeof data.avatar === 'string' || data.avatar === null ? data.avatar : undefined,
      avatarAt: typeof data.avatarAt === 'number' ? data.avatarAt : 0,
    }, 0);
    if (changed) {
      this.saveState();
      this.scheduleSnapshot();
      this.onEvent({ type: 'self-profile', profile: { ...this.state.profile } });
    }
    return {};
  }

  private receiveDigest(data: Record<string, unknown>): DmDispatch {
    const device = typeof data.device === 'string' && isDmId(data.device) ? data.device : null;
    if (!device || device === this.device || !isDmId(data.seq)) return {};
    if (typeof data.for === 'string' && data.for !== this.device) return {};
    const parts = typeof data.parts === 'number' && Number.isSafeInteger(data.parts) ? data.parts : 0;
    const part = typeof data.part === 'number' && Number.isSafeInteger(data.part) ? data.part : -1;
    if (parts < 1 || parts > MAX_DIGEST_PARTS || part < 0 || part >= parts) return {};
    const now = this.now();
    for (const [key, pending] of this.pendingDigests) {
      if (now - pending.at > PENDING_DIGEST_TTL_MS) this.pendingDigests.delete(key);
    }
    const key = `${device}:${data.seq}`;
    let pending = this.pendingDigests.get(key);
    if (!pending) {
      pending = { parts: new Array(parts).fill(undefined), received: 0, at: now };
      this.pendingDigests.set(key, pending);
    }
    // A digest arrives once per shared server; the copies after the first are ignored.
    if (pending.received < 0 || pending.parts.length !== parts || pending.parts[part]) return {};
    pending.parts[part] = data;
    pending.received += 1;
    if (pending.received < parts) return {};
    const complete = pending.parts;
    pending.parts = [];
    pending.received = -1;

    const cont = data.cont === true;
    let repeat = false;
    if (cont) {
      const rounds = (this.digestRounds.get(device) ?? 0) + 1;
      if (rounds > MAX_HISTORY_ROUNDS) return {};
      this.digestRounds.set(device, rounds);
    } else {
      // The same state seen again shortly after (another shared server) only gets what changed since.
      const hash = createHash('sha256')
        .update(JSON.stringify(complete.map((body) => [body?.peers, body?.convs])))
        .digest('hex');
      const last = this.lastDigest.get(device);
      repeat = !!last && last.hash === hash && now - last.at < SELF_REPEAT_WINDOW_MS;
      if (!repeat) {
        this.lastDigest.set(device, { hash, at: now });
        this.digestRounds.set(device, 0);
        this.pushedDays.set(device, new Set());
      }
    }

    const theirPeers = new Map<string, { relationAt: number; blockedAt: number }>();
    const convs: DigestConversation[] = [];
    for (const body of complete) {
      for (const entry of Array.isArray(body?.peers) ? body.peers : []) {
        if (!Array.isArray(entry) || !isIdentityPublicKey(entry[0])) continue;
        theirPeers.set(normalizeIdentityKey(entry[0]), {
          relationAt: typeof entry[1] === 'number' ? entry[1] : 0,
          blockedAt: typeof entry[2] === 'number' ? entry[2] : 0,
        });
      }
      for (const entry of Array.isArray(body?.convs) ? body.convs : []) {
        if (!isRecord(entry) || !isIdentityPublicKey(entry.p)) continue;
        const peer = normalizeIdentityKey(entry.p);
        if (peer === this.me) continue;
        convs.push({
          p: peer,
          lr: typeof entry.lr === 'number' ? entry.lr : 0,
          pr: typeof entry.pr === 'number' ? entry.pr : 0,
          from: typeof entry.from === 'number' ? entry.from : 0,
          b: typeof entry.b === 'string' ? entry.b : '',
        });
      }
    }

    const reply: DmRelayItem[] = [];
    if (!cont && !repeat) {
      // The friend sync in their hello only says what they have; here we learn what they lack.
      const behind = Object.values(this.state.peers).some((record) => {
        if (record.relationUpdatedAt <= 0 && record.blockedUpdatedAt <= 0) return false;
        const theirs = theirPeers.get(record.publicKey);
        return !theirs || theirs.relationAt < record.relationUpdatedAt || theirs.blockedAt < record.blockedUpdatedAt;
      });
      if (behind) reply.push(...this.syncItems());
    }
    if (!cont) this.applyReadMarkers(convs);
    reply.push(...this.historyFor(device, convs));
    return reply.length > 0 ? { reply } : {};
  }

  private applyReadMarkers(convs: DigestConversation[]): void {
    const limit = this.now() + MAX_CLOCK_SKEW_MS;
    let dirty = false;
    for (const conv of convs) {
      if (!this.state.peers[conv.p]) continue;
      const meta = this.meta(conv.p);
      const lastReadAt = Math.min(conv.lr, limit);
      const peerReadAt = Math.min(conv.pr, limit);
      if (lastReadAt > meta.lastReadAt) {
        meta.lastReadAt = lastReadAt;
        this.refreshMeta(conv.p);
        dirty = true;
      }
      if (peerReadAt > meta.peerReadAt) {
        meta.peerReadAt = peerReadAt;
        dirty = true;
      }
    }
    if (dirty) this.changed();
  }

  /** Days of history the other device lacks or holds differently, newest first, within one response budget. */
  private historyFor(device: string, convs: DigestConversation[]): DmRelayItem[] {
    const pushed = this.pushedDays.get(device) ?? new Set<string>();
    this.pushedDays.set(device, pushed);
    const remote = new Map(convs.map((conv) => [conv.p, conv]));
    const peers = Object.keys(this.state.conversations)
      .filter((peer) => !!this.state.peers[peer])
      .sort((a, b) => (this.state.conversations[b]?.lastMessageAt ?? 0) - (this.state.conversations[a]?.lastMessageAt ?? 0));
    const bodies: Array<Record<string, unknown>> = [];
    let total = 0;
    let more = false;
    outer: for (const peer of peers) {
      const local = this.dayBuckets(peer);
      if (local.size === 0) continue;
      const theirs = remote.get(peer);
      const theirBuckets = new Map<number, string>();
      for (const pair of (theirs?.b ?? '').split(',')) {
        const [day, hash] = pair.split(':');
        if (day && hash) theirBuckets.set(Number(day), hash);
      }
      const from = theirs?.from ?? 0;
      const days = [...local.keys()]
        .filter((day) => day >= from && theirBuckets.get(day) !== local.get(day) && !pushed.has(`${peer}:${day}:${local.get(day)}`))
        .sort((a, b) => b - a);
      if (days.length === 0) continue;
      const byDay = new Map<number, StoredMessage[]>();
      for (const message of this.conversation(peer).messages) {
        const day = Math.floor(message.createdAt / DAY_MS);
        const list = byDay.get(day);
        if (list) list.push(message);
        else byDay.set(day, [message]);
      }
      const nickname = this.state.peers[peer]?.nickname ?? '';
      let batch: unknown[] = [];
      let batchSize = 0;
      const flush = () => {
        if (batch.length === 0) return;
        bodies.push({ peer, nickname, from: this.device, for: device, msgs: batch });
        total += batchSize;
        batch = [];
        batchSize = 0;
      };
      for (const day of days) {
        if (total + batchSize >= MAX_HISTORY_RESPONSE_BYTES) {
          more = true;
          flush();
          break outer;
        }
        pushed.add(`${peer}:${day}:${local.get(day)}`);
        for (const message of byDay.get(day) ?? []) {
          const wire = {
            id: message.id,
            author: message.author,
            content: message.content,
            createdAt: message.createdAt,
            editedAt: message.editedAt,
            deleted: message.deleted,
            replyTo: message.replyTo,
            reactions: message.reactions,
            attachments: message.attachments.map(({ fileId, name, size, mime, sha256 }) => ({ fileId, name, size, mime, sha256 })),
          };
          const length = utf8Length(JSON.stringify(wire)) + 1;
          if (length > MAX_SEALED_ITEM_BYTES - 2_000) continue;
          if (batchSize + length > MAX_SEALED_ITEM_BYTES - 2_000) flush();
          batch.push(wire);
          batchSize += length;
        }
      }
      flush();
    }
    // The last part asks for another digest so the rest follows in the next round.
    if (more && bodies.length > 0) bodies[bodies.length - 1].more = true;
    return bodies.map((body) => this.selfItem('hist', body, 'signal'));
  }

  /** Merges history another own device sent: union of messages, deletes win, edits and reactions by timestamp. */
  private receiveHistory(data: Record<string, unknown>): DmDispatch {
    if (!isIdentityPublicKey(data.peer) || !Array.isArray(data.msgs)) return {};
    const peer = normalizeIdentityKey(data.peer);
    if (peer === this.me) return {};
    if (!this.state.peers[peer]) this.ensurePeer(peer, typeof data.nickname === 'string' ? data.nickname : undefined);
    const limit = this.now() + MAX_CLOCK_SKEW_MS;
    const meta = this.meta(peer);
    const changedMessages: StoredMessage[] = [];
    let inserted = false;
    for (const raw of data.msgs.slice(0, 2000)) {
      if (!isRecord(raw) || !isDmId(raw.id) || !isIdentityPublicKey(raw.author)) continue;
      const author = normalizeIdentityKey(raw.author);
      if (author !== this.me && author !== peer) continue;
      const createdAt = typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? Math.min(raw.createdAt, limit) : 0;
      const editedAt = typeof raw.editedAt === 'number' && Number.isFinite(raw.editedAt) ? Math.min(raw.editedAt, limit) : null;
      const deleted = raw.deleted === true;
      const content = typeof raw.content === 'string' ? raw.content.slice(0, DM_MAX_MESSAGE_LENGTH) : '';
      const reactions: StoredReactions = {};
      if (isRecord(raw.reactions)) {
        for (const [emojiRaw, users] of Object.entries(raw.reactions).slice(0, 200)) {
          const emoji = emojiRaw.trim().slice(0, MAX_EMOJI_LENGTH);
          if (!emoji || !isRecord(users)) continue;
          for (const [userRaw, value] of Object.entries(users)) {
            if (!isIdentityPublicKey(userRaw) || !isRecord(value) || typeof value.ts !== 'number') continue;
            const user = normalizeIdentityKey(userRaw);
            if (user !== this.me && user !== peer) continue;
            (reactions[emoji] ??= {})[user] = { on: value.on === true, ts: Math.min(value.ts, limit) };
          }
        }
      }
      const existing = this.findMessage(peer, raw.id);
      if (!existing) {
        const attachments = deleted
          ? []
          : (Array.isArray(raw.attachments) ? raw.attachments.slice(0, DM_MAX_ATTACHMENTS) : [])
              .map((entry) => sanitizeAttachmentMeta(entry))
              .filter((entry): entry is AttachmentMeta => !!entry)
              .map<StoredAttachment>((file) => {
                const local = this.store.hasAttachment(file.fileId);
                const state: DmAttachmentState = local ? (author === this.me ? 'local' : 'ready') : 'unavailable';
                return { ...file, state, receivedBytes: local ? file.size : 0 };
              });
        if (!deleted && !content && attachments.length === 0) continue;
        const message: StoredMessage = {
          id: raw.id,
          author,
          content: deleted ? '' : content,
          createdAt,
          editedAt: deleted ? null : editedAt,
          deleted,
          replyTo: isDmId(raw.replyTo) ? raw.replyTo : null,
          reactions: deleted ? {} : reactions,
          attachments,
          delivery: author === this.me ? 'delivered' : null,
        };
        if (!this.insertMessage(peer, message)) continue;
        this.observeStamp(createdAt);
        if (author === this.me) meta.lastReadAt = Math.max(meta.lastReadAt, createdAt);
        changedMessages.push(message);
        inserted = true;
        continue;
      }
      if (existing.author !== author) continue;
      let dirty = false;
      if (deleted && !existing.deleted) {
        this.markDeleted(existing);
        dirty = true;
      } else if (!existing.deleted && !deleted && editedAt !== null && (existing.editedAt === null || editedAt > existing.editedAt)) {
        existing.content = content;
        existing.editedAt = editedAt;
        dirty = true;
      }
      if (!existing.deleted) {
        for (const [emoji, users] of Object.entries(reactions)) {
          for (const [user, value] of Object.entries(users)) {
            if (this.applyReaction(existing, user, emoji, value.on, value.ts)) dirty = true;
          }
        }
      }
      if (dirty) changedMessages.push(existing);
    }
    if (changedMessages.length > 0) {
      if (inserted) meta.hidden = false;
      this.refreshMeta(peer);
      this.changed(peer);
      this.emitMessages(peer, changedMessages);
    }
    if (data.more === true && typeof data.from === 'string' && isDmId(data.from) && data.for === this.device) {
      return { reply: this.digestItems(true, data.from) };
    }
    return {};
  }

  /**
   * Outbox items (and stalled download requests) for peers that are reachable
   * right now. Without `force`, items sent less than {@link RESEND_AFTER_MS}
   * ago are skipped.
   */
  outgoing(peerKeys: string[], force = false): DmDispatch {
    const now = this.now();
    const peers: Record<string, DmRelayItem[]> = {};
    let dirty = false;
    for (const value of peerKeys) {
      if (!isIdentityPublicKey(value)) continue;
      const peer = normalizeIdentityKey(value);
      const record = this.state.peers[peer];
      if (!record || record.blocked) continue;
      const items: DmRelayItem[] = [];
      for (const entry of this.state.outbox[peer] ?? []) {
        if (!force && now - entry.lastSentAt < RESEND_AFTER_MS) continue;
        const item = this.outboxItem(record, entry);
        if (!item) continue;
        entry.lastSentAt = now;
        items.push(item);
        dirty = true;
      }
      if (record.relation === 'friend' && record.cert) {
        for (const download of Object.values(this.state.downloads)) {
          if (download.peer !== peer) continue;
          if (!force && now - download.lastActivityAt < DOWNLOAD_STALL_MS) continue;
          const request = this.nextFileRequest(download, true);
          if (request) items.push(request);
        }
      }
      if (items.length > 0) peers[peer] = items;
    }
    if (dirty) this.saveState();
    return Object.keys(peers).length > 0 ? { peers } : {};
  }

  /** Peers that currently have something to deliver (outbox or downloads). */
  pendingPeers(): string[] {
    const peers = new Set<string>();
    for (const [peer, entries] of Object.entries(this.state.outbox)) {
      if (entries.length > 0) peers.add(peer);
    }
    for (const download of Object.values(this.state.downloads)) peers.add(download.peer);
    return [...peers];
  }

  ingest(item: DmIncomingRelayItem): DmDispatch {
    if (!item || !isIdentityPublicKey(item.from) || typeof item.data !== 'string') return {};
    const from = normalizeIdentityKey(item.from);
    try {
      if (item.kind === 'friend') return this.ingestStatement(from, item.data);
      try {
        DmKeyring.peekRoute(item.data);
      } catch {
        return {};
      }
      if (from === this.me) {
        const opened = this.keyring.open<unknown>(item.data, from, this.keyring.certificate());
        return this.ingestSelf(opened.header, opened.body);
      }
      const record = this.state.peers[from];
      if (!record || record.blocked || !record.cert) return {};
      const opened = this.keyring.open<unknown>(item.data, from, record.cert);
      if (opened.header.type !== 'ack' && record.relation !== 'friend') return {};
      return this.ingestPeer(record, opened.header, opened.body);
    } catch (error) {
      console.warn('[DM] Item descartado:', error instanceof Error ? error.message : error);
      return {};
    }
  }

  private ack(record: PeerRecord, ids: string[]): DmRelayItem | null {
    if (!record.cert || ids.length === 0) return null;
    return this.envelopeItem(record, 'ack', { ids });
  }

  private ingestStatement(from: string, data: string): DmDispatch {
    let parsed: SignedStatement;
    try {
      parsed = JSON.parse(data) as SignedStatement;
    } catch {
      return {};
    }
    const payload = parsed?.p;
    if (
      !payload ||
      payload.v !== 1 ||
      !['request', 'accept', 'cancel', 'remove'].includes(payload.type) ||
      !isDmId(payload.id) ||
      !isDmId(payload.requestId) ||
      normalizeIdentityKey(String(payload.from)) !== from ||
      normalizeIdentityKey(String(payload.to)) !== this.me ||
      typeof payload.ts !== 'number' ||
      !verifyDmCertificate(from, payload.cert) ||
      !verifyDmStatement(from, payload, parsed.s)
    ) {
      return {};
    }
    const existing = this.state.peers[from];
    if (existing?.blocked) return {};
    const record = this.ensurePeer(from, payload.nickname);
    record.cert = payload.cert;
    record.maxFileBytes = clampMaxFileBytes(payload.maxFileBytes, record.maxFileBytes);
    const reply: Array<DmRelayItem | null> = [this.ack(record, [payload.id])];
    if (record.seenStatements.includes(payload.id)) {
      this.saveState();
      return { reply: reply.filter((item): item is DmRelayItem => !!item) };
    }
    record.seenStatements.push(payload.id);
    if (record.seenStatements.length > MAX_SEEN_STATEMENTS) {
      record.seenStatements.splice(0, record.seenStatements.length - MAX_SEEN_STATEMENTS);
    }
    const now = this.now();
    const ts = Math.min(payload.ts, now);
    let broadcast: DmRelayItem[] = [];
    switch (payload.type) {
      case 'request': {
        if (record.relation === 'friend') {
          // They lost their state (new device, reinstall): confirm again.
          reply.push(this.queueStatement(record, this.signStatement('accept', from, payload.requestId)));
          record.requestId = payload.requestId;
        } else if (record.relation === 'outgoing') {
          // Both sides asked: treat as mutual acceptance.
          this.state.outbox[from] = this.outbox(from).filter((entry) => entry.type !== 'request');
          record.relation = 'friend';
          record.friendSince = now;
          record.outgoingStatement = null;
          record.relationUpdatedAt = now;
          reply.push(this.queueStatement(record, this.signStatement('accept', from, payload.requestId)));
          this.meta(from);
          this.onEvent({ type: 'friend-accepted', peer: from, nickname: record.nickname });
          broadcast = this.syncItems([record]);
        } else if (record.relation === 'none' && ts > record.relationUpdatedAt - MAX_CLOCK_SKEW_MS) {
          record.relation = 'incoming';
          record.requestId = payload.requestId;
          record.requestedAt = ts;
          record.relationUpdatedAt = now;
          this.onEvent({ type: 'friend-request', peer: from, nickname: record.nickname });
          broadcast = this.syncItems([record]);
        }
        break;
      }
      case 'accept': {
        if (record.relation === 'outgoing' && record.requestId === payload.requestId) {
          this.state.outbox[from] = this.outbox(from).filter((entry) => entry.type !== 'request');
          record.relation = 'friend';
          record.friendSince = now;
          record.outgoingStatement = null;
          record.relationUpdatedAt = now;
          this.meta(from);
          this.onEvent({ type: 'friend-accepted', peer: from, nickname: record.nickname });
          broadcast = this.syncItems([record]);
        }
        break;
      }
      case 'cancel': {
        if (record.relation === 'incoming' && record.requestId === payload.requestId) {
          record.relation = 'none';
          record.requestId = null;
          record.requestedAt = null;
          record.relationUpdatedAt = now;
          broadcast = this.syncItems([record]);
        }
        break;
      }
      case 'remove': {
        if (record.relation === 'friend' && ts >= (record.friendSince ?? 0) - MAX_CLOCK_SKEW_MS) {
          this.dropPendingEnvelopes(from);
          record.relation = 'none';
          record.friendSince = null;
          record.relationUpdatedAt = now;
          broadcast = this.syncItems([record]);
        }
        break;
      }
    }
    this.changed();
    const dispatch: DmDispatch = { reply: reply.filter((item): item is DmRelayItem => !!item) };
    if (broadcast.length > 0) dispatch.broadcast = broadcast;
    return dispatch;
  }

  private ingestPeer(record: PeerRecord, header: DmEnvelopeHeader, body: unknown): DmDispatch {
    const peer = record.publicKey;
    const data = isRecord(body) ? body : {};
    switch (header.type) {
      case 'ack': {
        const ids = Array.isArray(data.ids) ? data.ids.filter((id): id is string => typeof id === 'string').slice(0, 200) : [];
        if (ids.length === 0) return {};
        const acked = new Set(ids);
        const entries = this.state.outbox[peer] ?? [];
        const ackedMessages = entries.filter((entry) => acked.has(entry.id) && entry.type === 'msg').map((entry) => entry.id);
        this.state.outbox[peer] = entries.filter((entry) => !acked.has(entry.id));
        const changedMessages: StoredMessage[] = [];
        for (const id of ackedMessages) {
          const message = this.findMessage(peer, id);
          if (message && message.delivery !== 'delivered') {
            message.delivery = 'delivered';
            changedMessages.push(message);
          }
        }
        this.saveState();
        if (changedMessages.length > 0) {
          this.saveConversation(peer);
          this.emitMessages(peer, changedMessages);
        }
        return {};
      }
      case 'typing':
        this.onEvent({ type: 'typing', peer });
        return {};
      case 'hello': {
        record.maxFileBytes = clampMaxFileBytes(data.maxFileBytes, record.maxFileBytes);
        this.saveState();
        const flush = this.outgoing([peer], true).peers?.[peer] ?? [];
        const reply = [...flush];
        if (data.reply !== true) {
          reply.push(this.envelopeItem(record, 'hello', this.friendHelloBody(true)));
        }
        // Their nickname/avatar changed since we last saw it: ask for the new one.
        const prof = isRecord(data.prof) ? data.prof : null;
        if (
          prof && typeof prof.h === 'string' && typeof prof.at === 'number'
          && prof.h !== record.profileHash && prof.at > (record.profileAt ?? 0)
        ) {
          reply.push(this.envelopeItem(record, 'profile-req', {}));
        }
        this.scheduleSnapshot();
        return { reply };
      }
      case 'profile-req': {
        const body = this.friendProfileBody();
        return body.at > 0 ? { reply: [this.envelopeItem(record, 'profile', body, 'file')] } : {};
      }
      case 'profile':
        this.applyFriendProfile(record, data);
        return {};
      case 'file-req':
        return { reply: this.serveFile(record, data) };
      case 'file-chunk':
        return { reply: this.receiveChunk(record, data) };
      case 'file-missing': {
        const fileId = data.fileId;
        if (isDmId(fileId) && this.state.downloads[fileId]?.peer === peer) {
          this.finishDownload(fileId, 'unavailable');
        }
        return {};
      }
      case 'msg':
      case 'edit':
      case 'delete':
      case 'react':
      case 'read': {
        const reply: Array<DmRelayItem | null> = [this.ack(record, [header.id])];
        reply.push(...this.applyOp(peer, peer, header, data, true));
        return { reply: reply.filter((item): item is DmRelayItem => !!item) };
      }
      default:
        return {};
    }
  }

  /**
   * Applies a conversation operation. `author` is who performed it: the peer,
   * or this identity for copies coming from another own device.
   */
  private applyOp(
    peer: string,
    author: string,
    header: Pick<DmEnvelopeHeader, 'id' | 'type' | 'ts'>,
    data: Record<string, unknown>,
    fromPeer: boolean
  ): DmRelayItem[] {
    const now = this.now();
    const ts = Math.min(header.ts, now + MAX_CLOCK_SKEW_MS);
    const meta = this.meta(peer);
    switch (header.type) {
      case 'msg': {
        if (!isDmId(header.id)) return [];
        const content = typeof data.content === 'string' ? data.content.slice(0, DM_MAX_MESSAGE_LENGTH) : '';
        const attachmentsInput = Array.isArray(data.attachments) ? data.attachments.slice(0, DM_MAX_ATTACHMENTS) : [];
        const metas = attachmentsInput
          .map((entry) => sanitizeAttachmentMeta(entry))
          .filter((entry): entry is AttachmentMeta => !!entry);
        if (!content && metas.length === 0) return [];
        const replyTo = typeof data.replyTo === 'string' && isDmId(data.replyTo) ? data.replyTo : null;
        const attachments: StoredAttachment[] = metas.map((file) => {
          let state: DmAttachmentState = 'unavailable';
          if (this.store.hasAttachment(file.fileId)) state = author === this.me ? 'local' : 'ready';
          else if (fromPeer) state = file.size > this.state.settings.maxFileBytes ? 'too-large' : 'pending';
          return { ...file, state, receivedBytes: state === 'ready' || state === 'local' ? file.size : 0 };
        });
        const message: StoredMessage = {
          id: header.id,
          author,
          content,
          // The author's timestamp is kept as-is so every device shares one time base for order and read receipts.
          createdAt: ts,
          editedAt: null,
          deleted: false,
          replyTo,
          reactions: {},
          attachments,
          delivery: author === this.me ? 'delivered' : null,
        };
        if (!this.insertMessage(peer, message)) return [];
        this.observeStamp(message.createdAt);
        meta.hidden = false;
        if (author === this.me) {
          meta.lastReadAt = Math.max(meta.lastReadAt, message.createdAt);
        }
        this.refreshMeta(peer);
        const replies: DmRelayItem[] = [];
        for (const file of attachments) {
          if (file.state !== 'pending') continue;
          const download: DownloadState = {
            peer,
            messageId: message.id,
            fileId: file.fileId,
            size: file.size,
            sha256: file.sha256,
            requestedUntil: 0,
            lastActivityAt: now,
          };
          this.store.resetPart(file.fileId);
          this.state.downloads[file.fileId] = download;
          const request = this.nextFileRequest(download, false);
          if (request) replies.push(request);
        }
        this.changed(peer);
        this.emitMessages(peer, [message]);
        if (author !== this.me) {
          this.onEvent({ type: 'incoming-message', peer, message: this.messageView(peer, message) });
        }
        return replies;
      }
      case 'edit': {
        const message = this.findMessage(peer, data.messageId);
        if (!message || message.author !== author || message.deleted) return [];
        const content = typeof data.content === 'string' ? data.content.slice(0, DM_MAX_MESSAGE_LENGTH) : '';
        const editedAt = typeof data.editedAt === 'number' ? Math.min(data.editedAt, now + MAX_CLOCK_SKEW_MS) : ts;
        if (message.editedAt !== null && message.editedAt >= editedAt) return [];
        message.content = content;
        message.editedAt = editedAt;
        this.refreshMeta(peer);
        this.changed(peer);
        this.emitMessages(peer, [message]);
        return [];
      }
      case 'delete': {
        const message = this.findMessage(peer, data.messageId);
        if (!message || message.author !== author || message.deleted) return [];
        this.markDeleted(message);
        this.refreshMeta(peer);
        this.changed(peer);
        this.emitMessages(peer, [message]);
        return [];
      }
      case 'react': {
        const message = this.findMessage(peer, data.messageId);
        const emoji = typeof data.emoji === 'string' ? data.emoji.trim().slice(0, MAX_EMOJI_LENGTH) : '';
        if (!message || message.deleted || !emoji) return [];
        const at = typeof data.at === 'number' ? Math.min(data.at, now + MAX_CLOCK_SKEW_MS) : ts;
        if (this.applyReaction(message, author, emoji, data.add !== false, at)) {
          this.changed(peer);
          this.emitMessages(peer, [message]);
        }
        return [];
      }
      case 'read': {
        const readAt = typeof data.readAt === 'number' ? Math.min(data.readAt, now + MAX_CLOCK_SKEW_MS) : 0;
        if (author === this.me) {
          if (readAt > meta.lastReadAt) {
            meta.lastReadAt = readAt;
            this.refreshMeta(peer);
            this.changed();
          }
          return [];
        }
        if (readAt > meta.peerReadAt) {
          meta.peerReadAt = readAt;
          this.changed();
          const own = this.conversation(peer).messages.filter(
            (message) => message.author === this.me && message.createdAt <= readAt && message.createdAt > readAt - 60 * 60_000
          );
          this.emitMessages(peer, own);
        }
        return [];
      }
      default:
        return [];
    }
  }

  private ingestSelf(header: DmEnvelopeHeader, body: unknown): DmDispatch {
    const data = isRecord(body) ? body : {};
    if (header.type === 'sync') {
      return this.mergeSync(Array.isArray(data.entries) ? data.entries : []);
    }
    if (header.type === 'hello-self') return this.receiveSelfHello(data);
    if (header.type === 'digest') return this.receiveDigest(data);
    if (header.type === 'hist') return this.receiveHistory(data);
    if (header.type === 'profile') return this.receiveSelfProfile(data);
    if (header.type === 'self') {
      const op = isRecord(data.op) ? data.op : null;
      if (!op || !isIdentityPublicKey(data.peer)) return {};
      const peer = normalizeIdentityKey(data.peer);
      if (peer === this.me || !this.state.peers[peer]) return {};
      if (typeof op.id !== 'string' || typeof op.type !== 'string' || typeof op.ts !== 'number') return {};
      this.applyOp(peer, this.me, { id: op.id, type: op.type, ts: op.ts }, isRecord(op.body) ? op.body : {}, false);
      return {};
    }
    return {};
  }

  private mergeSync(entries: unknown[]): DmDispatch {
    let dirty = false;
    let theyAreBehind = false;
    const seen = new Set<string>();
    for (const value of entries.slice(0, 2000)) {
      if (!isRecord(value) || !isIdentityPublicKey(value.publicKey)) continue;
      const peer = normalizeIdentityKey(value.publicKey);
      if (peer === this.me) continue;
      seen.add(peer);
      const relation = value.relation;
      if (relation !== 'none' && relation !== 'friend' && relation !== 'outgoing' && relation !== 'incoming') continue;
      const relationUpdatedAt = typeof value.relationUpdatedAt === 'number' ? value.relationUpdatedAt : 0;
      const blockedUpdatedAt = typeof value.blockedUpdatedAt === 'number' ? value.blockedUpdatedAt : 0;
      const cert = verifyDmCertificate(peer, value.cert) ? (value.cert as DmKeyCertificate) : null;
      const local = this.state.peers[peer];
      if (relationUpdatedAt > (local?.relationUpdatedAt ?? 0)) {
        if ((relation === 'friend' || relation === 'incoming') && !cert && !local?.cert) continue;
        const record = this.ensurePeer(peer, typeof value.nickname === 'string' ? value.nickname : undefined);
        const previous = record.relation;
        record.relation = relation;
        record.relationUpdatedAt = relationUpdatedAt;
        record.requestId = isDmId(value.requestId) ? value.requestId : null;
        record.friendSince = typeof value.friendSince === 'number' ? value.friendSince : null;
        record.requestedAt = typeof value.requestedAt === 'number' ? value.requestedAt : null;
        if (cert) record.cert = cert;
        const statement = this.validOwnStatement(value.outgoingStatement, peer);
        record.outgoingStatement = relation === 'outgoing' ? statement : null;
        if (relation === 'outgoing' && statement && !this.outbox(peer).some((entry) => entry.id === statement.p.id)) {
          this.outbox(peer).push({ id: statement.p.id, kind: 'friend', type: 'request', ts: statement.p.ts, statement, lastSentAt: 0 });
        }
        if (relation !== 'outgoing') {
          this.state.outbox[peer] = this.outbox(peer).filter((entry) => entry.type !== 'request');
        }
        if (previous === 'friend' && relation !== 'friend') this.dropPendingEnvelopes(peer);
        if (relation === 'friend') this.meta(peer);
        dirty = true;
      } else if (local && local.relationUpdatedAt > relationUpdatedAt) {
        theyAreBehind = true;
      }
      if (blockedUpdatedAt > (this.state.peers[peer]?.blockedUpdatedAt ?? 0)) {
        const record = this.ensurePeer(peer, typeof value.nickname === 'string' ? value.nickname : undefined);
        record.blocked = value.blocked === true;
        record.blockedUpdatedAt = blockedUpdatedAt;
        dirty = true;
      } else if (local && local.blockedUpdatedAt > blockedUpdatedAt) {
        theyAreBehind = true;
      }
    }
    if (entries.length === 0) {
      // An empty sync is a "full state" hello from a fresh device.
      theyAreBehind = Object.values(this.state.peers).some((record) => record.relationUpdatedAt > 0 || record.blockedUpdatedAt > 0);
    }
    if (dirty) this.changed();
    return theyAreBehind ? { reply: this.syncItems() } : {};
  }

  private validOwnStatement(value: unknown, peer: string): SignedStatement | null {
    if (!isRecord(value) || !isRecord(value.p)) return null;
    const statement = value as unknown as SignedStatement;
    if (
      statement.p.type !== 'request' ||
      normalizeIdentityKey(String(statement.p.from)) !== this.me ||
      normalizeIdentityKey(String(statement.p.to)) !== peer ||
      !isDmId(statement.p.id) ||
      !verifyDmStatement(this.me, statement.p, statement.s)
    ) {
      return null;
    }
    return statement;
  }

  // ---------------------------------------------------------------------------
  // Files
  // ---------------------------------------------------------------------------

  private cachedFile(fileId: string): Buffer | null {
    const now = this.now();
    for (const [key, entry] of this.fileCache) {
      if (entry.expiresAt < now) this.fileCache.delete(key);
    }
    const cached = this.fileCache.get(fileId);
    if (cached) {
      cached.expiresAt = now + FILE_CACHE_TTL_MS;
      return cached.data;
    }
    const data = this.store.readAttachment(fileId);
    if (!data) return null;
    if (this.fileCache.size >= 3) {
      const oldest = this.fileCache.keys().next().value;
      if (oldest) this.fileCache.delete(oldest);
    }
    this.fileCache.set(fileId, { data, expiresAt: now + FILE_CACHE_TTL_MS });
    return data;
  }

  private serveFile(record: PeerRecord, data: Record<string, unknown>): DmRelayItem[] {
    const fileId = data.fileId;
    const offset = data.offset;
    if (!isDmId(fileId) || typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) return [];
    const owned = this.conversation(record.publicKey).messages.some(
      (message) => message.author === this.me && !message.deleted && message.attachments.some((file) => file.fileId === fileId)
    );
    const content = owned ? this.cachedFile(fileId) : null;
    if (!content) {
      return [this.envelopeItem(record, 'file-missing', { fileId })];
    }
    const count = Math.max(1, Math.min(FILE_WINDOW_CHUNKS, typeof data.count === 'number' ? Math.floor(data.count) : 1));
    const items: DmRelayItem[] = [];
    for (let index = 0; index < count; index += 1) {
      const start = offset + index * DM_FILE_CHUNK_BYTES;
      if (start >= content.length && !(content.length === 0 && start === 0)) break;
      const chunk = content.subarray(start, Math.min(content.length, start + DM_FILE_CHUNK_BYTES));
      items.push(
        this.envelopeItem(record, 'file-chunk', { fileId, offset: start, data: chunk.toString('base64') }, 'file')
      );
      if (content.length === 0) break;
    }
    return items;
  }

  private nextFileRequest(download: DownloadState, resume: boolean): DmRelayItem | null {
    const record = this.state.peers[download.peer];
    if (!record || record.relation !== 'friend' || !record.cert) return null;
    const received = this.receivedBytes(download);
    if (resume) download.requestedUntil = received;
    if (download.requestedUntil > received) return null;
    const count = FILE_WINDOW_CHUNKS;
    download.requestedUntil = Math.min(download.size, received + count * DM_FILE_CHUNK_BYTES);
    download.lastActivityAt = this.now();
    this.saveState();
    return this.envelopeItem(record, 'file-req', { fileId: download.fileId, offset: received, count });
  }

  private receivedBytes(download: DownloadState): number {
    return Math.min(download.size, this.store.partChunkCount(download.fileId) * DM_FILE_CHUNK_BYTES);
  }

  private attachmentRef(peer: string, messageId: string, fileId: string): { message: StoredMessage; file: StoredAttachment } | null {
    const message = this.findMessage(peer, messageId);
    const file = message?.attachments.find((entry) => entry.fileId === fileId);
    return message && file ? { message, file } : null;
  }

  private receiveChunk(record: PeerRecord, data: Record<string, unknown>): DmRelayItem[] {
    const fileId = data.fileId;
    if (!isDmId(fileId)) return [];
    const download = this.state.downloads[fileId];
    if (!download || download.peer !== record.publicKey) return [];
    const offset = data.offset;
    const received = this.receivedBytes(download);
    if (offset !== received || typeof data.data !== 'string') return [];
    const chunk = Buffer.from(data.data, 'base64');
    const expected = Math.min(DM_FILE_CHUNK_BYTES, download.size - received);
    if (chunk.length !== expected) return [];
    this.store.appendPart(fileId, Math.floor(received / DM_FILE_CHUNK_BYTES), chunk);
    download.lastActivityAt = this.now();
    const total = received + chunk.length;
    const ref = this.attachmentRef(download.peer, download.messageId, fileId);
    if (total >= download.size) {
      const content = this.store.readPart(fileId);
      const hash = createHash('sha256').update(content).digest('hex');
      if (content.length !== download.size || hash !== download.sha256) {
        this.finishDownload(fileId, 'failed');
        return [];
      }
      this.store.writeAttachment(fileId, content);
      this.finishDownload(fileId, 'ready');
      return [];
    }
    if (ref) {
      ref.file.state = 'downloading';
      ref.file.receivedBytes = total;
      this.emitMessages(download.peer, [ref.message]);
      this.saveConversation(download.peer);
    }
    const next = this.nextFileRequest(download, false);
    return next ? [next] : [];
  }

  private finishDownload(fileId: string, state: DmAttachmentState): void {
    const download = this.state.downloads[fileId];
    if (!download) return;
    delete this.state.downloads[fileId];
    this.store.resetPart(fileId);
    const ref = this.attachmentRef(download.peer, download.messageId, fileId);
    if (ref) {
      ref.file.state = state;
      ref.file.receivedBytes = state === 'ready' ? ref.file.size : 0;
      this.saveConversation(download.peer);
      this.emitMessages(download.peer, [ref.message]);
    }
    this.saveState();
  }

  retryAttachment(peerKey: string, messageId: string, fileId: string): DmDispatch {
    const peer = this.requirePeerKey(peerKey);
    const ref = this.attachmentRef(peer, messageId, fileId);
    if (!ref || ref.message.author === this.me) throw new DmError('not-found', 'Arquivo não encontrado.');
    if (ref.file.state !== 'failed' && ref.file.state !== 'unavailable' && ref.file.state !== 'too-large') return {};
    if (ref.file.size > this.state.settings.maxFileBytes) {
      ref.file.state = 'too-large';
      this.emitMessages(peer, [ref.message]);
      return {};
    }
    const download: DownloadState = {
      peer,
      messageId,
      fileId,
      size: ref.file.size,
      sha256: ref.file.sha256,
      requestedUntil: 0,
      lastActivityAt: 0,
    };
    this.store.resetPart(fileId);
    this.state.downloads[fileId] = download;
    ref.file.state = 'pending';
    ref.file.receivedBytes = 0;
    this.changed(peer);
    this.emitMessages(peer, [ref.message]);
    return this.outgoing([peer], true);
  }

  readAttachment(peerKey: string, messageId: string, fileId: string): { name: string; mime: string; data: Buffer } {
    const peer = this.requirePeerKey(peerKey);
    const ref = this.attachmentRef(peer, messageId, fileId);
    if (!ref || (ref.file.state !== 'ready' && ref.file.state !== 'local')) {
      throw new DmError('not-found', 'Arquivo não disponível.');
    }
    const data = this.store.readAttachment(fileId);
    if (!data) throw new DmError('not-found', 'Arquivo não disponível.');
    return { name: ref.file.name, mime: ref.file.mime, data };
  }

  // ---------------------------------------------------------------------------
  // Export / import
  // ---------------------------------------------------------------------------

  exportData(includeHistory: boolean): DmExportData {
    this.flush();
    const data: DmExportData = {
      version: 1,
      peers: Object.values(this.state.peers)
        .filter((record) => record.relationUpdatedAt > 0 || record.blockedUpdatedAt > 0)
        .map((record) => this.syncEntry(record)),
      settings: { ...this.state.settings },
    };
    if (includeHistory) {
      data.conversations = Object.keys(this.state.conversations)
        .map((peer) => this.conversation(peer))
        .filter((conversation) => conversation.messages.length > 0)
        .map((conversation) => ({
          version: 1 as const,
          peer: conversation.peer,
          messages: conversation.messages.map((message) => ({
            ...message,
            attachments: message.attachments.map((file) => ({ ...file, state: 'unavailable' as const, receivedBytes: 0 })),
          })),
        }));
    }
    return data;
  }

  importData(data: unknown): void {
    if (!isRecord(data) || data.version !== 1) return;
    if (isRecord(data.settings)) {
      this.state.settings.maxFileBytes = clampMaxFileBytes(data.settings.maxFileBytes, this.state.settings.maxFileBytes);
    }
    if (Array.isArray(data.peers)) this.mergeSync(data.peers);
    if (Array.isArray(data.conversations)) {
      for (const value of data.conversations) {
        if (!isRecord(value) || !isIdentityPublicKey(value.peer) || !Array.isArray(value.messages)) continue;
        const peer = normalizeIdentityKey(value.peer);
        if (peer === this.me) continue;
        this.ensurePeer(peer);
        const meta = this.meta(peer);
        for (const raw of value.messages) {
          if (!isRecord(raw) || !isDmId(raw.id) || !isIdentityPublicKey(raw.author)) continue;
          const author = normalizeIdentityKey(raw.author);
          if (author !== this.me && author !== peer) continue;
          const attachments = (Array.isArray(raw.attachments) ? raw.attachments : [])
            .map((entry) => sanitizeAttachmentMeta(entry))
            .filter((entry): entry is AttachmentMeta => !!entry)
            .map<StoredAttachment>((file) => ({ ...file, state: 'unavailable', receivedBytes: 0 }));
          this.insertMessage(peer, {
            id: raw.id,
            author,
            content: typeof raw.content === 'string' ? raw.content.slice(0, DM_MAX_MESSAGE_LENGTH) : '',
            createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0,
            editedAt: typeof raw.editedAt === 'number' ? raw.editedAt : null,
            deleted: raw.deleted === true,
            replyTo: isDmId(raw.replyTo) ? raw.replyTo : null,
            reactions: isRecord(raw.reactions) ? (raw.reactions as StoredReactions) : {},
            attachments,
            delivery: author === this.me ? 'delivered' : null,
          });
        }
        meta.hidden = false;
        meta.lastReadAt = Math.max(meta.lastReadAt, meta.lastMessageAt);
        this.refreshMeta(peer);
        this.saveConversation(peer);
      }
    }
    this.changed();
    this.flush();
  }
}

function keyringIdentity(keyring: DmKeyring): string {
  return keyring.identityPublicKey;
}
