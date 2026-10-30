import type {
  DmConversationPage,
  DmDispatch,
  DmEvent,
  DmIncomingRelayItem,
  DmObservedPeer,
  DmRelayItem,
  DmSelfProfileInput,
  DmSelfProfileResult,
  DmSendMessageInput,
  DmSettings,
  DmSnapshot,
} from '@monky/shared';
import { DmKeyring, isIdentityPublicKey, normalizeIdentityKey, type DmEnvelopeHeader } from './dmCrypto';
import { DmConversations } from './dmConversations';
import { DmDeviceSync } from './dmDeviceSync';
import { DmFiles } from './dmFiles';
import { DmFriends } from './dmFriends';
import { DmLedger } from './dmLedger';
import { MAX_CLOCK_SKEW_MS, type DmExportData, type PeerRecord } from './dmModel';
import { DmOutbox, dispatchFor } from './dmOutbox';
import { DmPersistence } from './dmPersistence';
import { DmProfile } from './dmProfile';
import { clampMaxFileBytes, isRecord, toWireMessage } from './dmWire';

export { DmError } from './dmModel';
export type { DmExportData } from './dmModel';
export { DM_DOWNLOAD_STALL_MS, DM_FILE_CHUNK_BYTES, DM_FILE_TRANSFER_IDLE_MS } from './dmFiles';

/** One sighting of a friend brings several hellos (each side greets and answers); the outbox goes out once for all of them. */
const HELLO_FLUSH_GAP_MS = 5_000;

export interface DmServiceOptions {
  keyring: DmKeyring;
  dir: string;
  now?: () => number;
  onEvent?: (event: DmEvent) => void;
  /** Memory for the decrypted files being sent to friends; the default suits the largest file allowed. Tests use less. */
  fileCacheMaxBytes?: number;
}

/**
 * Friends and direct messages engine (#743), running in the main process.
 *
 * It owns the encrypted local store and all crypto. It never talks to a server
 * directly: every operation returns a {@link DmDispatch} with the sealed relay
 * items the renderer must push through the server sessions where the peer is
 * reachable. Servers only relay, so delivery is store-and-forward on the
 * devices: unacknowledged items stay in a per-peer outbox and are resent when
 * the peer shows up again.
 *
 * This class is what the IPC layer talks to. It routes what arrives and greets
 * friends and own devices; the rest of the work lives in modules that share one
 * {@link DmLedger} (state, conversations, clock and views):
 * - {@link DmOutbox}: sealing, the outbox and acks;
 * - {@link DmFriends}: requests and friendships, and their sync between own devices;
 * - {@link DmConversations}: messages, edits, deletes, reactions and read receipts;
 * - {@link DmFiles}: attachments, sent and downloaded in chunks;
 * - {@link DmProfile}: the nickname and picture that travel with the identity;
 * - {@link DmDeviceSync}: history and read markers between own devices.
 */
export class DmService {
  readonly me: string;
  private readonly keyring: DmKeyring;
  private readonly ledger: DmLedger;
  private readonly outbox: DmOutbox;
  private readonly files: DmFiles;
  private readonly friends: DmFriends;
  private readonly conversations: DmConversations;
  private readonly profile: DmProfile;
  private readonly sync: DmDeviceSync;
  private readonly helloFlushedAt = new Map<string, number>();

  constructor(options: DmServiceOptions) {
    this.keyring = options.keyring;
    this.me = options.keyring.identityPublicKey;
    const store = new DmPersistence(options.dir, options.keyring.storageKey());
    this.ledger = new DmLedger(this.me, store, options.now ?? Date.now, options.onEvent ?? (() => undefined));
    this.outbox = new DmOutbox(this.ledger, this.keyring);
    this.files = new DmFiles(this.ledger, this.outbox, options.fileCacheMaxBytes);
    this.friends = new DmFriends(this.ledger, this.outbox);
    this.conversations = new DmConversations(this.ledger, this.outbox, this.files);
    this.profile = new DmProfile(this.ledger, this.outbox);
    this.sync = new DmDeviceSync(this.ledger, this.outbox, this.friends, this.profile, this.conversations);
    this.ledger.onConversationChanged = (peer) => this.sync.conversationChanged(peer);
    store.onWritten = (written) => this.outbox.releaseStoredAcks(written);
  }

  /** Identifies this running device in own-device exchanges. */
  get device(): string {
    return this.sync.device;
  }

  flush(): void {
    this.ledger.store.flush();
  }

  /** Whether received items wait for a write before their ack can leave. */
  hasPendingAcks(): boolean {
    return this.outbox.hasPendingAcks();
  }

  /** Stops timers and forgets pending writes; used right before the store is deleted. */
  discard(): void {
    this.ledger.discard();
    this.outbox.discard();
    this.files.discard();
  }

  snapshot(): DmSnapshot {
    return this.ledger.snapshot();
  }

  getConversation(peerKey: string, before?: string | null, limit?: number): DmConversationPage {
    return this.ledger.getConversation(peerKey, before, limit);
  }

  // ---------------------------------------------------------------------------
  // Friends
  // ---------------------------------------------------------------------------

  sendFriendRequest(peerKey: string, nickname?: string): DmDispatch {
    return this.friends.sendRequest(peerKey, nickname);
  }

  acceptFriend(peerKey: string): DmDispatch {
    return this.friends.accept(peerKey);
  }

  declineFriend(peerKey: string): DmDispatch {
    return this.friends.decline(peerKey);
  }

  cancelFriendRequest(peerKey: string): DmDispatch {
    return this.friends.cancel(peerKey);
  }

  removeFriend(peerKey: string): DmDispatch {
    return this.friends.remove(peerKey);
  }

  block(peerKey: string, nickname?: string): DmDispatch {
    return this.friends.block(peerKey, nickname);
  }

  unblock(peerKey: string): DmDispatch {
    return this.friends.unblock(peerKey);
  }

  /** Settings of this device; friends learn the largest file it accepts from the hello that goes out now. */
  updateSettings(settings: Partial<DmSettings>): DmDispatch {
    if (settings.maxFileBytes !== undefined) {
      this.ledger.state.settings.maxFileBytes = clampMaxFileBytes(settings.maxFileBytes, this.ledger.state.settings.maxFileBytes);
    }
    this.ledger.changed();
    return { broadcast: this.friendHellos() };
  }

  // ---------------------------------------------------------------------------
  // Profile
  // ---------------------------------------------------------------------------

  setSelfNickname(nickname: string): void {
    this.ledger.setSelfNickname(nickname);
  }

  /**
   * Merges what the renderer has locally. Fields win by their timestamp, so a
   * value chosen on another device later is kept and handed back for the
   * renderer to apply. Values without a timestamp (profiles saved before the
   * sync existed) only fill an empty profile.
   */
  setSelfProfile(input: DmSelfProfileInput): DmSelfProfileResult {
    return this.profile.setSelfProfile(input);
  }

  /** What a server shows of a peer: kept only where the friend did not send their own. */
  observePeer(observed: DmObservedPeer): void {
    this.profile.observePeer(observed);
  }

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------

  openConversation(peerKey: string): void {
    this.conversations.openConversation(peerKey);
  }

  closeConversation(peerKey: string): void {
    this.conversations.closeConversation(peerKey);
  }

  sendMessage(input: DmSendMessageInput): DmDispatch {
    return this.conversations.sendMessage(input);
  }

  editMessage(peerKey: string, messageId: string, content: string): DmDispatch {
    return this.conversations.editMessage(peerKey, messageId, content);
  }

  deleteMessage(peerKey: string, messageId: string): DmDispatch {
    return this.conversations.deleteMessage(peerKey, messageId);
  }

  react(peerKey: string, messageId: string, emoji: string, add: boolean): DmDispatch {
    return this.conversations.react(peerKey, messageId, emoji, add);
  }

  markRead(peerKey: string): DmDispatch {
    return this.conversations.markRead(peerKey);
  }

  typing(peerKey: string): DmDispatch {
    return this.conversations.typing(peerKey);
  }

  // ---------------------------------------------------------------------------
  // Files
  // ---------------------------------------------------------------------------

  retryAttachment(peerKey: string, messageId: string, fileId: string): DmDispatch {
    const peer = this.ledger.requirePeerKey(peerKey);
    return this.files.retry(peer, messageId, fileId) ? this.outgoing([peer], true) : {};
  }

  readAttachment(peerKey: string, messageId: string, fileId: string): { name: string; mime: string; data: Buffer } {
    return this.files.readAttachment(peerKey, messageId, fileId);
  }

  /** Decrypts a ready/local attachment into `destination` (absolute path), creating or overwriting it. */
  writeAttachmentTo(peerKey: string, messageId: string, fileId: string, destination: string): Promise<void> {
    return this.files.writeAttachmentTo(peerKey, messageId, fileId, destination);
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
    const broadcast = this.friends.syncItems();
    // Other devices of this identity answer with what they have that this one lacks.
    if (announce) broadcast.push(...this.sync.helloItems());
    if (toFriends) broadcast.push(...this.friendHellos());
    return { broadcast };
  }

  /** Hello for one friend that just became reachable. */
  helloTo(peerKey: string): DmDispatch {
    const peer = this.ledger.requirePeerKey(peerKey);
    const record = this.ledger.state.peers[peer];
    if (!record || record.relation !== 'friend' || record.blocked || !record.cert) return {};
    return dispatchFor(peer, [this.outbox.envelopeItem(record, 'hello', this.friendHelloBody(false))]);
  }

  private friendHellos(): DmRelayItem[] {
    const items: DmRelayItem[] = [];
    for (const record of Object.values(this.ledger.state.peers)) {
      if (record.relation !== 'friend' || record.blocked || !record.cert) continue;
      items.push(this.outbox.envelopeItem(record, 'hello', this.friendHelloBody(false)));
    }
    return items;
  }

  private friendHelloBody(reply: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = { reply, maxFileBytes: this.ledger.state.settings.maxFileBytes };
    const prof = this.profile.helloSummary();
    if (prof) body.prof = prof;
    return body;
  }

  /**
   * Outbox items (and stalled download requests) for peers that are reachable
   * right now. Without `force`, items sent in the last 20 s are skipped (see
   * {@link DmOutbox.due}). The outbox goes through one server; download requests
   * go through every server where the peer is, because only the device that
   * sent a file has it and a server only reaches the devices connected to it.
   */
  outgoing(peerKeys: string[], force = false): DmDispatch {
    const now = this.ledger.now();
    const peers: Record<string, DmRelayItem[]> = {};
    const everywhere: Record<string, DmRelayItem[]> = {};
    let dirty = false;
    for (const value of peerKeys) {
      if (!isIdentityPublicKey(value)) continue;
      const peer = normalizeIdentityKey(value);
      const record = this.ledger.state.peers[peer];
      if (!record || record.blocked) continue;
      const items = this.outbox.due(record, now, force);
      if (items.length > 0) {
        peers[peer] = items;
        dirty = true;
      }
      const requests = record.relation === 'friend' && record.cert ? this.files.requests(peer, now, force) : [];
      if (requests.length > 0) everywhere[peer] = requests;
    }
    if (dirty) this.ledger.saveState();
    const dispatch: DmDispatch = {};
    if (Object.keys(peers).length > 0) dispatch.peers = peers;
    if (Object.keys(everywhere).length > 0) dispatch.everywhere = everywhere;
    return dispatch;
  }

  /** Peers that currently have something to deliver (outbox or downloads). */
  pendingPeers(): string[] {
    const peers = new Set<string>();
    for (const [peer, entries] of Object.entries(this.ledger.state.outbox)) {
      if (entries.length > 0) peers.add(peer);
    }
    for (const download of Object.values(this.ledger.state.downloads)) peers.add(download.peer);
    return [...peers];
  }

  // ---------------------------------------------------------------------------
  // What arrives
  // ---------------------------------------------------------------------------

  ingest(item: DmIncomingRelayItem): DmDispatch {
    if (!item || !isIdentityPublicKey(item.from) || typeof item.data !== 'string') return {};
    const from = normalizeIdentityKey(item.from);
    try {
      if (item.kind === 'friend') return this.friends.ingestStatement(from, item.data);
      try {
        DmKeyring.peekRoute(item.data);
      } catch {
        return {};
      }
      if (from === this.me) {
        const opened = this.keyring.open<unknown>(item.data, from, this.keyring.certificate());
        return this.ingestSelf(opened.header, opened.body);
      }
      const record = this.ledger.state.peers[from];
      if (!record || record.blocked || !record.cert) return {};
      const opened = this.keyring.open<unknown>(item.data, from, record.cert);
      if (opened.header.type !== 'ack' && record.relation !== 'friend') return {};
      return this.ingestPeer(record, opened.header, opened.body);
    } catch (error) {
      console.warn('[DM] Item descartado:', error instanceof Error ? error.message : error);
      return {};
    }
  }

  /** Routes an envelope from a friend to the part of the engine that handles its type. */
  private ingestPeer(record: PeerRecord, header: DmEnvelopeHeader, body: unknown): DmDispatch {
    const peer = record.publicKey;
    const data = isRecord(body) ? body : {};
    switch (header.type) {
      case 'ack':
        this.outbox.acknowledged(record, data);
        return {};
      case 'typing':
        this.ledger.emit({ type: 'typing', peer });
        return {};
      case 'hello':
        return this.receiveFriendHello(record, data);
      case 'profile-req':
        return this.profile.answerRequest(record);
      case 'profile':
        this.profile.applyFriendProfile(record, data);
        return {};
      case 'file-req':
        return this.files.answerRequest(record, header.id, data);
      case 'file-chunk':
        return { reply: this.files.receiveChunk(record, data) };
      case 'file-missing':
      case 'file-absent':
        // Versions before #490 say "missing" whether the file is gone or only not on that device: only the flag
        // makes it final.
        this.files.receiveAbsent(record, data, header.type === 'file-missing' && data.final === true);
        return {};
      case 'file-wait':
        this.files.receiveWait(record, data);
        return {};
      case 'msg':
      case 'edit':
      case 'delete':
      case 'react':
      case 'read': {
        const replies = this.conversations.applyOp(peer, peer, header, data, true);
        return { reply: [this.outbox.ackWhenStored(record, [header.id]), ...replies].filter((item): item is DmRelayItem => !!item) };
      }
      default:
        return {};
    }
  }

  /** A device of the friend is listening now: what waited for them goes, and their hello is answered. */
  private receiveFriendHello(record: PeerRecord, data: Record<string, unknown>): DmDispatch {
    const peer = record.publicKey;
    record.maxFileBytes = clampMaxFileBytes(data.maxFileBytes, record.maxFileBytes);
    this.ledger.saveState();
    this.files.peerAppeared(peer);
    // Their greeting and their answer to ours arrive moments apart: the outbox goes out once for both instead of
    // once per hello.
    const now = this.ledger.now();
    const reply: DmRelayItem[] = [];
    let requests: DmRelayItem[] = [];
    if (now - (this.helloFlushedAt.get(peer) ?? Number.NEGATIVE_INFINITY) >= HELLO_FLUSH_GAP_MS) {
      this.helloFlushedAt.set(peer, now);
      const flush = this.outgoing([peer], true);
      reply.push(...(flush.peers?.[peer] ?? []));
      requests = flush.everywhere?.[peer] ?? [];
    }
    if (data.reply !== true) {
      reply.push(this.outbox.envelopeItem(record, 'hello', this.friendHelloBody(true)));
    }
    // Their nickname/avatar changed since we last saw it: ask for the new one.
    if (this.profile.outdated(record, data.prof)) reply.push(this.outbox.envelopeItem(record, 'profile-req', {}));
    this.ledger.scheduleSnapshot();
    return requests.length > 0 ? { reply, everywhere: { [peer]: requests } } : { reply };
  }

  /** Routes an envelope from another device of this identity. */
  private ingestSelf(header: DmEnvelopeHeader, body: unknown): DmDispatch {
    const data = isRecord(body) ? body : {};
    switch (header.type) {
      case 'sync':
        return this.friends.mergeSync(Array.isArray(data.entries) ? data.entries : []);
      case 'hello-self':
        return this.sync.receiveSelfHello(data);
      case 'digest':
        return this.sync.receiveDigest(data);
      case 'hist':
        return this.sync.receiveHistory(data);
      case 'profile':
        return this.profile.receiveSelfProfile(data);
      case 'self': {
        // The copy of an operation this identity did on another device.
        const op = isRecord(data.op) ? data.op : null;
        if (!op || !isIdentityPublicKey(data.peer)) return {};
        const peer = normalizeIdentityKey(data.peer);
        if (peer === this.me || !this.ledger.state.peers[peer]) return {};
        if (typeof op.id !== 'string' || typeof op.type !== 'string' || typeof op.ts !== 'number') return {};
        this.conversations.applyOp(peer, this.me, { id: op.id, type: op.type, ts: op.ts }, isRecord(op.body) ? op.body : {}, false);
        return {};
      }
      default:
        return {};
    }
  }

  // ---------------------------------------------------------------------------
  // Export / import
  // ---------------------------------------------------------------------------

  exportData(includeHistory: boolean): DmExportData {
    this.flush();
    const data: DmExportData = {
      version: 1,
      peers: Object.values(this.ledger.state.peers)
        .filter((record) => record.relationUpdatedAt > 0 || record.blockedUpdatedAt > 0)
        .map((record) => this.friends.syncEntry(record)),
      settings: { ...this.ledger.state.settings },
    };
    if (includeHistory) {
      data.conversations = Object.keys(this.ledger.state.conversations)
        .map((peer) => this.ledger.conversation(peer))
        .filter((conversation) => conversation.messages.length > 0)
        .map((conversation) => ({
          version: 1 as const,
          peer: conversation.peer,
          messages: conversation.messages.map((message) => toWireMessage(message)),
        }));
    }
    return data;
  }

  /**
   * Merges friends and history from a backup. Its messages are read like the
   * history of another own device: the same validation, and files that are
   * not on this device stay unavailable.
   */
  importData(data: unknown): void {
    if (!isRecord(data) || data.version !== 1) return;
    if (isRecord(data.settings)) {
      this.ledger.state.settings.maxFileBytes = clampMaxFileBytes(data.settings.maxFileBytes, this.ledger.state.settings.maxFileBytes);
    }
    if (Array.isArray(data.peers)) this.friends.mergeSync(data.peers);
    if (Array.isArray(data.conversations)) {
      const limit = this.ledger.now() + MAX_CLOCK_SKEW_MS;
      for (const value of data.conversations) {
        if (!isRecord(value) || !isIdentityPublicKey(value.peer) || !Array.isArray(value.messages)) continue;
        const peer = normalizeIdentityKey(value.peer);
        if (peer === this.me) continue;
        this.ledger.ensurePeer(peer);
        this.conversations.importHistory(peer, value.messages, limit);
      }
    }
    this.ledger.changed();
    this.flush();
  }
}
