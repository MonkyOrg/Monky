import { createHash } from 'crypto';
import type { DmDispatch, DmRelayItem } from '@monky/shared';
import { isIdentityPublicKey, newDmId, normalizeIdentityKey } from './dmCrypto';
import type { DmConversations } from './dmConversations';
import type { DmFriends } from './dmFriends';
import type { DmLedger } from './dmLedger';
import { MAX_CLOCK_SKEW_MS, SELF_REPEAT_WINDOW_MS, messageFingerprint, type StoredMessage } from './dmModel';
import type { DmOutbox } from './dmOutbox';
import type { DmProfile } from './dmProfile';
import { isDmId, isRecord, toWireMessage, utf8Length } from './dmWire';

const DAY_MS = 86_400_000;
const MAX_DIGEST_DAYS = 1000;
/** Plaintext bytes per sealed item, so the relay's 64 KiB item limit holds after encryption. */
const MAX_SEALED_ITEM_BYTES = 44_000;
const MAX_HISTORY_RESPONSE_BYTES = 600_000;
const MAX_HISTORY_ROUNDS = 50;
const MAX_DIGEST_PARTS = 200;
const PENDING_DIGEST_TTL_MS = 60_000;

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

/**
 * Keeps the devices of this identity in step (#743). Each hello carries a
 * digest of friends and history, one hash per day of each conversation, and
 * the other device answers with the relations and the days this one lacks,
 * in rounds when the history is long. Read markers travel in the digest.
 */
export class DmDeviceSync {
  /** Identifies this running device in own-device exchanges. */
  readonly device = newDmId();
  private readonly lastDigest = new Map<string, { hash: string; at: number }>();
  private readonly digestRounds = new Map<string, number>();
  /** `peer:day:hash` already sent to each own device, so copies of a digest do not resend history. */
  private readonly pushedDays = new Map<string, Set<string>>();
  private readonly pendingDigests = new Map<string, PendingDigest>();
  private readonly dayBucketCache = new Map<string, Map<number, string>>();

  constructor(
    private readonly ledger: DmLedger,
    private readonly outbox: DmOutbox,
    private readonly friends: DmFriends,
    private readonly profile: DmProfile,
    private readonly conversations: DmConversations,
  ) {}

  /** What a session that just connected tells the other own devices: which device this is, and its digest. */
  helloItems(): DmRelayItem[] {
    return [
      this.outbox.selfItem('hello-self', { device: this.device, reply: false, prof: this.profile.summary() }, 'signal'),
      ...this.digestItems(false, null),
    ];
  }

  /** A conversation changed: its fingerprints per day are computed again when next needed. */
  conversationChanged(peer: string): void {
    this.dayBucketCache.delete(peer);
  }

  /** Another own device greeted: it is greeted back with a digest, and their profile and this one's compared. */
  receiveSelfHello(data: Record<string, unknown>): DmDispatch {
    const device = typeof data.device === 'string' && isDmId(data.device) ? data.device : null;
    if (!device || device === this.device) return {};
    const reply: DmRelayItem[] = [];
    if (data.reply !== true) {
      reply.push(this.outbox.selfItem('hello-self', { device: this.device, reply: true, prof: this.profile.summary() }, 'signal'));
      reply.push(...this.digestItems(false, null));
    }
    reply.push(...this.profile.ownDeviceHello(device, data.prof));
    return reply.length > 0 ? { reply } : {};
  }

  /** A digest part of another own device; once all parts are in, it gets what it lacks. */
  receiveDigest(data: Record<string, unknown>): DmDispatch {
    const device = typeof data.device === 'string' && isDmId(data.device) ? data.device : null;
    if (!device || device === this.device || !isDmId(data.seq)) return {};
    if (typeof data.for === 'string' && data.for !== this.device) return {};
    const parts = typeof data.parts === 'number' && Number.isSafeInteger(data.parts) ? data.parts : 0;
    const part = typeof data.part === 'number' && Number.isSafeInteger(data.part) ? data.part : -1;
    if (parts < 1 || parts > MAX_DIGEST_PARTS || part < 0 || part >= parts) return {};
    const now = this.ledger.now();
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
        if (peer === this.ledger.me) continue;
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
      const behind = Object.values(this.ledger.state.peers).some((record) => {
        if (record.relationUpdatedAt <= 0 && record.blockedUpdatedAt <= 0) return false;
        const theirs = theirPeers.get(record.publicKey);
        return !theirs || theirs.relationAt < record.relationUpdatedAt || theirs.blockedAt < record.blockedUpdatedAt;
      });
      if (behind) reply.push(...this.friends.syncItems());
    }
    if (!cont) this.applyReadMarkers(convs);
    reply.push(...this.historyFor(device, convs));
    return reply.length > 0 ? { reply } : {};
  }

  /** Merges history another own device sent: union of messages, deletes win, edits and reactions by timestamp. */
  receiveHistory(data: Record<string, unknown>): DmDispatch {
    if (!isIdentityPublicKey(data.peer) || !Array.isArray(data.msgs)) return {};
    const peer = normalizeIdentityKey(data.peer);
    if (peer === this.ledger.me) return {};
    if (!this.ledger.state.peers[peer]) this.ledger.ensurePeer(peer, typeof data.nickname === 'string' ? data.nickname : undefined);
    this.conversations.mergeHistory(peer, data.msgs);
    if (data.more === true && typeof data.from === 'string' && isDmId(data.from) && data.for === this.device) {
      return { reply: this.digestItems(true, data.from) };
    }
    return {};
  }

  /**
   * Summary of friends and history, split in sealed parts. Another own device
   * answers with the friends and days of history this one is missing.
   */
  private digestItems(cont: boolean, forDevice: string | null): DmRelayItem[] {
    const seq = newDmId();
    const peers = Object.values(this.ledger.state.peers)
      .filter((record) => record.relationUpdatedAt > 0 || record.blockedUpdatedAt > 0)
      .map((record) => [record.publicKey, record.relationUpdatedAt, record.blockedUpdatedAt]);
    const convs: DigestConversation[] = [];
    for (const [peer, meta] of Object.entries(this.ledger.state.conversations)) {
      if (!this.ledger.state.peers[peer]) continue;
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
      this.outbox.selfItem('digest', {
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

  /** Per-day fingerprints of a conversation, cached until it changes. */
  private dayBuckets(peer: string): Map<number, string> {
    const cached = this.dayBucketCache.get(peer);
    if (cached) return cached;
    const hashes = new Map<number, ReturnType<typeof createHash>>();
    for (const message of this.ledger.conversation(peer).messages) {
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

  private applyReadMarkers(convs: DigestConversation[]): void {
    const limit = this.ledger.now() + MAX_CLOCK_SKEW_MS;
    let dirty = false;
    for (const conv of convs) {
      if (!this.ledger.state.peers[conv.p]) continue;
      const meta = this.ledger.meta(conv.p);
      const lastReadAt = Math.min(conv.lr, limit);
      const peerReadAt = Math.min(conv.pr, limit);
      if (lastReadAt > meta.lastReadAt) {
        meta.lastReadAt = lastReadAt;
        this.ledger.refreshMeta(conv.p);
        dirty = true;
      }
      if (peerReadAt > meta.peerReadAt) {
        meta.peerReadAt = peerReadAt;
        dirty = true;
      }
    }
    if (dirty) this.ledger.changed();
  }

  /** Days of history the other device lacks or holds differently, newest first, within one response budget. */
  private historyFor(device: string, convs: DigestConversation[]): DmRelayItem[] {
    const pushed = this.pushedDays.get(device) ?? new Set<string>();
    this.pushedDays.set(device, pushed);
    const remote = new Map(convs.map((conv) => [conv.p, conv]));
    const peers = Object.keys(this.ledger.state.conversations)
      .filter((peer) => !!this.ledger.state.peers[peer])
      .sort((a, b) => (this.ledger.state.conversations[b]?.lastMessageAt ?? 0) - (this.ledger.state.conversations[a]?.lastMessageAt ?? 0));
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
      for (const message of this.ledger.conversation(peer).messages) {
        const day = Math.floor(message.createdAt / DAY_MS);
        const list = byDay.get(day);
        if (list) list.push(message);
        else byDay.set(day, [message]);
      }
      const nickname = this.ledger.state.peers[peer]?.nickname ?? '';
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
          const wire = toWireMessage(message);
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
    return bodies.map((body) => this.outbox.selfItem('hist', body, 'signal'));
  }
}
