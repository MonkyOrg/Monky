import {
  DM_DEFAULT_MAX_FILE_BYTES,
  type DmAttachmentView,
  type DmConversationPage,
  type DmConversationSummary,
  type DmEvent,
  type DmMessageView,
  type DmPeerView,
  type DmSnapshot,
} from '@monky/shared';
import { isIdentityPublicKey, normalizeIdentityKey } from './dmCrypto';
import { DmError, type ConversationMeta, type DmState, type PeerRecord, type StoredConversation, type StoredMessage } from './dmModel';
import { DmPersistence } from './dmPersistence';
import { clampMaxFileBytes, emptyProfile, isRecord, sanitizeNickname, sanitizeSelfProfile } from './dmWire';

const STATE_FILE = 'state.mkdm';
const PAGE_SIZE = 80;

function previewOf(message: StoredMessage): string {
  if (message.deleted) return '';
  const text = message.content.replace(/\s+/g, ' ').trim();
  if (text) return text.slice(0, 120);
  if (message.attachments.length > 0) return message.attachments.map((file) => file.name).join(', ').slice(0, 120);
  return '';
}

/**
 * What every part of the DM engine works on (#743): the state file (friends,
 * outbox, downloads, settings, profile), the conversations, each loaded on
 * first use, the clock of the operations this device creates, and what the
 * renderer is shown of all of it. Changes reach the disk with a short
 * debounce (see {@link DmPersistence}).
 */
export class DmLedger {
  readonly state: DmState;
  private readonly conversations = new Map<string, StoredConversation>();
  private lastStamp = 0;
  private snapshotTimer: NodeJS.Timeout | null = null;
  private selfNickname = '';
  /** Told when a conversation is saved after a change, for what is derived from its messages. */
  onConversationChanged: ((peer: string) => void) | null = null;

  constructor(
    readonly me: string,
    readonly store: DmPersistence,
    readonly now: () => number,
    readonly emit: (event: DmEvent) => void,
  ) {
    this.state = this.loadState();
  }

  private loadState(): DmState {
    // A state that cannot be read right now throws instead of starting empty:
    // the next save would otherwise replace friends and outbox with nothing.
    const loaded = this.store.readJson(STATE_FILE, (value): value is DmState => isRecord(value) && value.identity === this.me);
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
    if (!loaded) return empty;
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

  saveState(): void {
    this.store.writeJsonSoon(STATE_FILE, () => this.state);
  }

  /**
   * Lamport-style clock for locally created operations. It is strictly
   * increasing, so operations created in the same millisecond keep their order
   * and survive last-writer-wins checks, and it never falls behind messages
   * already seen, so a reply always sorts after the message it answers even
   * when the peer's clock runs ahead (bounded by MAX_CLOCK_SKEW_MS).
   */
  stamp(): number {
    this.lastStamp = Math.max(this.now(), this.lastStamp + 1);
    return this.lastStamp;
  }

  observeStamp(ts: number): void {
    if (ts > this.lastStamp) this.lastStamp = ts;
  }

  conversation(peer: string): StoredConversation {
    const cached = this.conversations.get(peer);
    if (cached) return cached;
    // Throws while the file cannot be read (it stays on disk for the next try); a damaged one is set aside.
    const loaded = this.store.readJson(
      DmPersistence.peerFileName(peer),
      (value): value is StoredConversation => isRecord(value) && value.peer === peer && Array.isArray(value.messages),
    );
    const conversation: StoredConversation = loaded ?? { version: 1, peer, messages: [] };
    this.conversations.set(peer, conversation);
    return conversation;
  }

  saveConversation(peer: string): void {
    this.onConversationChanged?.(peer);
    this.store.writeJsonSoon(DmPersistence.peerFileName(peer), () => this.conversation(peer));
  }

  changed(peer?: string): void {
    this.saveState();
    if (peer) this.saveConversation(peer);
    this.scheduleSnapshot();
  }

  requirePeerKey(value: unknown): string {
    if (!isIdentityPublicKey(value)) throw new DmError('invalid-peer', 'Identidade inválida.');
    const peer = normalizeIdentityKey(value);
    if (peer === this.me) throw new DmError('invalid-peer', 'Não é possível usar a própria identidade.');
    return peer;
  }

  ensurePeer(publicKey: string, nickname?: string): PeerRecord {
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

  requireFriend(peerKey: string): PeerRecord {
    const peer = this.requirePeerKey(peerKey);
    const record = this.state.peers[peer];
    if (!record || record.relation !== 'friend' || !record.cert) {
      throw new DmError('not-friend', 'Vocês não são amigos.');
    }
    if (record.blocked) throw new DmError('blocked', 'Usuário bloqueado.');
    return record;
  }

  myNickname(): string {
    return sanitizeNickname(this.state.profile.nickname || this.selfNickname, 'Monky');
  }

  setSelfNickname(nickname: string): void {
    this.selfNickname = sanitizeNickname(nickname, '');
  }

  meta(peer: string): ConversationMeta {
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

  refreshMeta(peer: string): void {
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

  findMessage(peer: string, id: unknown): StoredMessage | null {
    if (typeof id !== 'string') return null;
    return this.conversation(peer).messages.find((message) => message.id === id) ?? null;
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

  messageView(peer: string, message: StoredMessage): DmMessageView {
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
      forwarded: message.deleted ? null : message.forwarded ?? null,
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

  scheduleSnapshot(): void {
    if (this.snapshotTimer) return;
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      this.emit({ type: 'snapshot', snapshot: this.snapshot() });
    }, 30);
    this.snapshotTimer.unref?.();
  }

  emitMessages(peer: string, messages: StoredMessage[]): void {
    if (messages.length === 0) return;
    this.emit({
      type: 'messages',
      peer,
      messages: messages.map((message) => this.messageView(peer, message)),
      peerReadAt: this.state.conversations[peer]?.peerReadAt ?? 0,
    });
  }

  /** Stops the timer and forgets what was not saved; used right before the store is deleted. */
  discard(): void {
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.snapshotTimer = null;
    this.store.discardPending();
    this.conversations.clear();
  }
}
