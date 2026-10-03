import {
  DM_DEFAULT_MAX_FILE_BYTES,
  DM_TYPING_TTL_MS,
  normalizePublicKeyHex,
  type DmApi,
  type DmConversationPage,
  type DmConversationSummary,
  type DmDispatch,
  type DmEvent,
  type DmFailure,
  type DmMessageView,
  type DmOutgoingFile,
  type DmPeerView,
  type DmResult,
  type DmSnapshot,
} from '@monky/shared';
import { EventBus } from '../core/EventBus';
import { DmTransport } from '../core/DmTransport';
import { clientLog } from '../core/ClientLogService';

const EMPTY: DmSnapshot = {
  me: null,
  peers: [],
  conversations: [],
  settings: { maxFileBytes: DM_DEFAULT_MAX_FILE_BYTES },
};

export interface DmConversationState {
  peer: string;
  messages: DmMessageView[];
  hasMore: boolean;
  peerReadAt: number;
  loading: boolean;
}

/**
 * Friends and direct messages in the renderer (#743).
 *
 * The main process owns keys, history and the outbox; this store mirrors what
 * the UI needs and hands every resulting dispatch to the transport.
 */
export class DmStore {
  readonly bus = new EventBus();
  private api: DmApi | null = null;
  private transport: DmTransport | null = null;
  private snapshotValue: DmSnapshot = EMPTY;
  private readonly conversations = new Map<string, DmConversationState>();
  private readonly typingUntil = new Map<string, number>();
  private readonly typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private lastTypingSent = new Map<string, number>();
  private offEvent: (() => void) | null = null;
  private presenceTimer: ReturnType<typeof setInterval> | null = null;
  private presenceSignature = '';
  /** Conversation currently on screen (marks read, silences notifications). */
  activePeer: string | null = null;

  get available(): boolean {
    return this.api !== null;
  }

  get snapshot(): DmSnapshot {
    return this.snapshotValue;
  }

  async init(): Promise<void> {
    const api = (window as unknown as { api?: { dm?: DmApi } }).api?.dm;
    if (!api || this.api) return;
    this.api = api;
    this.transport = new DmTransport(api);
    this.offEvent = api.onEvent((event) => this.onEvent(event));
    await this.reload();
    this.transport.start();
    // Presence comes from the servers, not from the main process.
    this.presenceTimer = setInterval(() => this.checkPresence(), 2_000);
  }

  /** After an identity import the main process opens another store. */
  async reload(): Promise<void> {
    if (!this.api) return;
    const result = await this.api.snapshot();
    if (result.ok) this.applySnapshot(result.value);
    for (const peer of [...this.conversations.keys()]) void this.loadConversation(peer);
  }

  dispose(): void {
    this.offEvent?.();
    this.offEvent = null;
    this.transport?.stop();
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.presenceTimer = null;
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  peer(key: string): DmPeerView | undefined {
    const normalized = normalizeKey(key);
    return this.snapshotValue.peers.find((peer) => peer.publicKey === normalized);
  }

  friends(): DmPeerView[] {
    return this.snapshotValue.peers
      .filter((peer) => peer.relation === 'friend' && !peer.blocked)
      .sort((a, b) => a.nickname.localeCompare(b.nickname));
  }

  pending(): DmPeerView[] {
    return this.snapshotValue.peers
      .filter((peer) => (peer.relation === 'incoming' || peer.relation === 'outgoing') && !peer.blocked)
      .sort((a, b) => (b.requestedAt ?? 0) - (a.requestedAt ?? 0));
  }

  blocked(): DmPeerView[] {
    return this.snapshotValue.peers.filter((peer) => peer.blocked).sort((a, b) => a.nickname.localeCompare(b.nickname));
  }

  incomingRequests(): number {
    return this.snapshotValue.peers.filter((peer) => peer.relation === 'incoming' && !peer.blocked).length;
  }

  conversationList(): DmConversationSummary[] {
    return this.snapshotValue.conversations
      .filter((conversation) => !conversation.hidden)
      .sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  }

  unreadTotal(): number {
    return this.snapshotValue.conversations.reduce((sum, conversation) => sum + conversation.unread, 0);
  }

  isOnline(peer: string): boolean {
    return this.transport?.isReachable(normalizeKey(peer)) ?? false;
  }

  isTyping(peer: string): boolean {
    return (this.typingUntil.get(peer) ?? 0) > Date.now();
  }

  conversation(peer: string): DmConversationState | undefined {
    return this.conversations.get(normalizeKey(peer));
  }

  // ---------------------------------------------------------------------------
  // Friends
  // ---------------------------------------------------------------------------

  sendFriendRequest(peer: string, nickname?: string): Promise<DmFailure | null> {
    return this.run((api) => api.sendFriendRequest(normalizeKey(peer), nickname));
  }

  acceptFriend(peer: string): Promise<DmFailure | null> {
    return this.run((api) => api.acceptFriend(peer));
  }

  declineFriend(peer: string): Promise<DmFailure | null> {
    return this.run((api) => api.declineFriend(peer));
  }

  cancelFriendRequest(peer: string): Promise<DmFailure | null> {
    return this.run((api) => api.cancelFriendRequest(peer));
  }

  removeFriend(peer: string): Promise<DmFailure | null> {
    return this.run((api) => api.removeFriend(peer));
  }

  block(peer: string, nickname?: string): Promise<DmFailure | null> {
    return this.run((api) => api.block(normalizeKey(peer), nickname));
  }

  unblock(peer: string): Promise<DmFailure | null> {
    return this.run((api) => api.unblock(peer));
  }

  observe(peer: string, nickname: string, avatar: string | null): void {
    void this.api?.observePeer({ publicKey: normalizeKey(peer), nickname, avatar });
  }

  updateMaxFileBytes(maxFileBytes: number): Promise<DmFailure | null> {
    return this.run((api) => api.updateSettings({ maxFileBytes }));
  }

  // ---------------------------------------------------------------------------
  // Conversations
  // ---------------------------------------------------------------------------

  async open(peer: string): Promise<void> {
    const key = normalizeKey(peer);
    this.activePeer = key;
    await this.api?.openConversation(key);
    await this.loadConversation(key);
    await this.markRead(key);
  }

  /** Leaves the conversation screen; the DM stays in the list. */
  leave(peer: string): void {
    if (this.activePeer === normalizeKey(peer)) this.activePeer = null;
  }

  /** Removes the DM from the sidebar list until a new message arrives. */
  hide(peer: string): void {
    const key = normalizeKey(peer);
    if (this.activePeer === key) this.activePeer = null;
    void this.api?.closeConversation(key);
  }

  async loadConversation(peer: string): Promise<void> {
    if (!this.api) return;
    const result = await this.api.conversation(peer, null, 60);
    if (!result.ok) return;
    this.storePage(result.value, true);
  }

  async loadOlder(peer: string): Promise<void> {
    const state = this.conversations.get(peer);
    if (!this.api || !state || !state.hasMore || state.loading) return;
    state.loading = true;
    try {
      const result = await this.api.conversation(peer, state.messages[0]?.id ?? null, 60);
      if (result.ok) this.storePage(result.value, false);
    } finally {
      state.loading = false;
    }
  }

  sendMessage(peer: string, content: string, files: DmOutgoingFile[] = [], replyTo: string | null = null): Promise<DmFailure | null> {
    return this.run((api) => api.sendMessage({ peer, content, files, replyTo }));
  }

  editMessage(peer: string, messageId: string, content: string): Promise<DmFailure | null> {
    return this.run((api) => api.editMessage(peer, messageId, content));
  }

  deleteMessage(peer: string, messageId: string): Promise<DmFailure | null> {
    return this.run((api) => api.deleteMessage(peer, messageId));
  }

  react(peer: string, messageId: string, emoji: string, add: boolean): Promise<DmFailure | null> {
    return this.run((api) => api.react(peer, messageId, emoji, add));
  }

  async markRead(peer: string): Promise<void> {
    if (!this.snapshotValue.conversations.some((conversation) => conversation.peer === peer)) return;
    await this.run((api) => api.markRead(peer));
  }

  typing(peer: string): void {
    const now = Date.now();
    if (now - (this.lastTypingSent.get(peer) ?? 0) < DM_TYPING_TTL_MS / 2) return;
    this.lastTypingSent.set(peer, now);
    void this.run((api) => api.typing(peer));
  }

  retryAttachment(peer: string, messageId: string, fileId: string): Promise<DmFailure | null> {
    return this.run((api) => api.retryAttachment(peer, messageId, fileId));
  }

  async readAttachment(peer: string, messageId: string, fileId: string): Promise<Blob | null> {
    if (!this.api) return null;
    const result = await this.api.readAttachment(peer, messageId, fileId);
    if (!result.ok) return null;
    return new Blob([result.value.data as BlobPart], { type: result.value.mime });
  }

  async saveAttachment(peer: string, messageId: string, fileId: string): Promise<DmFailure | null> {
    if (!this.api) return unavailable();
    const result = await this.api.saveAttachment(peer, messageId, fileId);
    return result.ok ? null : result.error;
  }

  /** Online human members of connected servers, for "add friend" suggestions. */
  onlineIdentities(): Set<string> {
    return new Set(this.transport?.onlineIdentities().keys() ?? []);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async run(operation: (api: DmApi) => Promise<DmResult<DmDispatch>>): Promise<DmFailure | null> {
    if (!this.api) return unavailable();
    try {
      const result = await operation(this.api);
      if (!result.ok) return result.error;
      this.transport?.execute(result.value);
      return null;
    } catch (error) {
      clientLog.warn('DM', 'Operation failed', { error: error instanceof Error ? error.message : String(error) });
      return unavailable();
    }
  }

  private applySnapshot(snapshot: DmSnapshot): void {
    this.snapshotValue = snapshot;
    const friends = snapshot.peers.filter((peer) => peer.relation === 'friend' && !peer.blocked).map((peer) => peer.publicKey);
    this.transport?.setIdentity(snapshot.me?.publicKey ?? null, friends);
    this.presenceSignature = '';
    this.bus.emit('changed');
  }

  private storePage(page: DmConversationPage, replace: boolean): void {
    const existing = this.conversations.get(page.peer);
    const messages = replace || !existing ? page.messages : mergeMessages(page.messages, existing.messages);
    this.conversations.set(page.peer, {
      peer: page.peer,
      messages,
      hasMore: page.hasMore,
      peerReadAt: page.peerReadAt,
      loading: false,
    });
    this.bus.emit('messages', { peer: page.peer });
  }

  private onEvent(event: DmEvent): void {
    switch (event.type) {
      case 'snapshot':
        this.applySnapshot(event.snapshot);
        break;
      case 'messages': {
        const state = this.conversations.get(event.peer);
        if (state) {
          state.messages = mergeMessages(state.messages, event.messages);
          state.peerReadAt = Math.max(state.peerReadAt, event.peerReadAt);
        }
        for (const message of event.messages) {
          if (message.author === event.peer) this.clearTyping(event.peer);
        }
        this.bus.emit('messages', { peer: event.peer });
        if (this.activePeer === event.peer && document.hasFocus()) void this.markRead(event.peer);
        break;
      }
      case 'typing':
        this.setTyping(event.peer);
        break;
      case 'incoming-message':
        this.clearTyping(event.peer);
        this.bus.emit('incoming', { peer: event.peer, message: event.message });
        break;
      case 'friend-request':
        this.bus.emit('friend-request', { peer: event.peer, nickname: event.nickname });
        break;
      case 'friend-accepted':
        this.bus.emit('friend-accepted', { peer: event.peer, nickname: event.nickname });
        break;
      case 'dispatch':
        this.transport?.execute(event.dispatch);
        break;
    }
  }

  private setTyping(peer: string): void {
    this.typingUntil.set(peer, Date.now() + DM_TYPING_TTL_MS);
    const previous = this.typingTimers.get(peer);
    if (previous) clearTimeout(previous);
    this.typingTimers.set(peer, setTimeout(() => this.clearTyping(peer), DM_TYPING_TTL_MS));
    this.bus.emit('typing', { peer });
  }

  private clearTyping(peer: string): void {
    const timer = this.typingTimers.get(peer);
    if (timer) clearTimeout(timer);
    this.typingTimers.delete(peer);
    if (this.typingUntil.delete(peer)) this.bus.emit('typing', { peer });
  }

  private checkPresence(): void {
    const online = this.friends().filter((friend) => this.isOnline(friend.publicKey)).map((friend) => friend.publicKey);
    const signature = online.sort().join(',');
    if (signature === this.presenceSignature) return;
    this.presenceSignature = signature;
    this.bus.emit('presence');
  }
}

function normalizeKey(value: string): string {
  try {
    return normalizePublicKeyHex(value);
  } catch {
    return value;
  }
}

function unavailable(): DmFailure {
  return { code: 'unavailable', message: 'unavailable', details: {} };
}

function mergeMessages(current: DmMessageView[], incoming: DmMessageView[]): DmMessageView[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

export const dmStore = new DmStore();
