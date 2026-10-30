import type { DmDispatch, DmRelayItem } from '@monky/shared';
import { isIdentityPublicKey, newDmId, normalizeIdentityKey, verifyDmCertificate, verifyDmStatement } from './dmCrypto';
import type { DmLedger } from './dmLedger';
import { DmError, MAX_CLOCK_SKEW_MS, type PeerRecord, type SignedStatement, type SyncEntry } from './dmModel';
import { dispatchFor, type DmOutbox } from './dmOutbox';
import { clampMaxFileBytes, isDmId, isRecord, isSignedStatement } from './dmWire';

/** Friend statements remembered per peer, so a copy that arrives again is only acked. */
const MAX_SEEN_STATEMENTS = 500;
const MAX_SYNC_ITEM_CHARS = 40_000;

/**
 * Friendships (#743). Requests, answers and removals travel as statements
 * signed by the identity, so a friend can check who sent them; the other
 * devices of this identity follow the relation through sync items, newest
 * change wins. Every way a relation starts or ends goes through
 * {@link becomeFriend} and {@link endRelation}.
 */
export class DmFriends {
  constructor(
    private readonly ledger: DmLedger,
    private readonly outbox: DmOutbox,
  ) {}

  sendRequest(peerKey: string, nickname?: string): DmDispatch {
    const peer = this.ledger.requirePeerKey(peerKey);
    const record = this.ledger.ensurePeer(peer, nickname);
    if (record.blocked) throw new DmError('blocked', 'Desbloqueie o usuário antes de enviar o pedido.');
    if (record.relation === 'friend' || record.relation === 'outgoing') return {};
    if (record.relation === 'incoming') return this.accept(peer);
    const requestId = newDmId();
    const statement = this.outbox.signStatement('request', peer, requestId);
    record.relation = 'outgoing';
    record.requestId = requestId;
    record.outgoingStatement = statement;
    record.requestedAt = statement.p.ts;
    record.relationUpdatedAt = statement.p.ts;
    const item = this.outbox.queueStatement(record, statement);
    this.ledger.changed();
    return dispatchFor(peer, [item], this.syncItems([record]));
  }

  accept(peerKey: string): DmDispatch {
    const peer = this.ledger.requirePeerKey(peerKey);
    const record = this.ledger.state.peers[peer];
    if (!record || record.relation !== 'incoming' || !record.cert || !record.requestId) {
      throw new DmError('not-found', 'Pedido de amizade não encontrado.');
    }
    const statement = this.outbox.signStatement('accept', peer, record.requestId);
    this.becomeFriend(record, statement.p.ts);
    const item = this.outbox.queueStatement(record, statement);
    this.ledger.changed();
    return dispatchFor(peer, [item], this.syncItems([record]));
  }

  /** Declining is silent: the friend's request keeps waiting on their side. */
  decline(peerKey: string): DmDispatch {
    const peer = this.ledger.requirePeerKey(peerKey);
    const record = this.ledger.state.peers[peer];
    if (!record || record.relation !== 'incoming') return {};
    this.endRelation(record, this.ledger.stamp());
    this.ledger.changed();
    return { broadcast: this.syncItems([record]) };
  }

  cancel(peerKey: string): DmDispatch {
    const peer = this.ledger.requirePeerKey(peerKey);
    const record = this.ledger.state.peers[peer];
    if (!record || record.relation !== 'outgoing' || !record.requestId) return {};
    const statement = this.outbox.signStatement('cancel', peer, record.requestId);
    this.endRelation(record, statement.p.ts);
    const item = this.outbox.queueStatement(record, statement);
    this.ledger.changed();
    return dispatchFor(peer, [item], this.syncItems([record]));
  }

  remove(peerKey: string): DmDispatch {
    const peer = this.ledger.requirePeerKey(peerKey);
    const record = this.ledger.state.peers[peer];
    if (!record || record.relation !== 'friend') return {};
    const statement = this.outbox.signStatement('remove', peer, record.requestId ?? newDmId());
    this.endRelation(record, statement.p.ts);
    const item = this.outbox.queueStatement(record, statement);
    this.ledger.changed(peer);
    return dispatchFor(peer, [item], this.syncItems([record]));
  }

  /** Blocking is silent: the friend only sees the friendship or the request end. */
  block(peerKey: string, nickname?: string): DmDispatch {
    const peer = this.ledger.requirePeerKey(peerKey);
    const record = this.ledger.ensurePeer(peer, nickname);
    if (record.blocked) return {};
    const now = this.ledger.stamp();
    let statement: SignedStatement | null = null;
    if (record.relation === 'friend') {
      statement = this.outbox.signStatement('remove', peer, record.requestId ?? newDmId());
    } else if (record.relation === 'outgoing' && record.requestId) {
      statement = this.outbox.signStatement('cancel', peer, record.requestId);
    }
    if (record.relation !== 'none') this.endRelation(record, now);
    const items = statement ? [this.outbox.queueStatement(record, statement)] : [];
    record.blocked = true;
    record.blockedUpdatedAt = now;
    this.ledger.changed(peer);
    return dispatchFor(peer, items, this.syncItems([record]));
  }

  unblock(peerKey: string): DmDispatch {
    const peer = this.ledger.requirePeerKey(peerKey);
    const record = this.ledger.state.peers[peer];
    if (!record || !record.blocked) return {};
    record.blocked = false;
    record.blockedUpdatedAt = this.ledger.stamp();
    this.ledger.changed();
    return { broadcast: this.syncItems([record]) };
  }

  /** A statement signed by `from`. Each is applied once; copies that arrive again are only acked. */
  ingestStatement(from: string, data: string): DmDispatch {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return {};
    }
    if (!isSignedStatement(parsed)) return {};
    const payload = parsed.p;
    if (
      normalizeIdentityKey(payload.from) !== from ||
      normalizeIdentityKey(payload.to) !== this.ledger.me ||
      !verifyDmCertificate(from, payload.cert) ||
      !verifyDmStatement(from, payload, parsed.s)
    ) {
      return {};
    }
    const existing = this.ledger.state.peers[from];
    if (existing?.blocked) return {};
    const record = this.ledger.ensurePeer(from, payload.nickname);
    record.cert = payload.cert;
    record.maxFileBytes = clampMaxFileBytes(payload.maxFileBytes, record.maxFileBytes);
    const reply: Array<DmRelayItem | null> = [];
    if (record.seenStatements.includes(payload.id)) {
      this.ledger.saveState();
      return { reply: [this.outbox.ackWhenStored(record, [payload.id])].filter((item): item is DmRelayItem => !!item) };
    }
    record.seenStatements.push(payload.id);
    if (record.seenStatements.length > MAX_SEEN_STATEMENTS) {
      record.seenStatements.splice(0, record.seenStatements.length - MAX_SEEN_STATEMENTS);
    }
    const now = this.ledger.now();
    const ts = Math.min(payload.ts, now);
    let broadcast: DmRelayItem[] = [];
    switch (payload.type) {
      case 'request': {
        if (record.relation === 'friend') {
          // They lost their state (new device, reinstall): confirm again.
          reply.push(this.outbox.queueStatement(record, this.outbox.signStatement('accept', from, payload.requestId)));
          record.requestId = payload.requestId;
        } else if (record.relation === 'outgoing') {
          // Both sides asked: treat as mutual acceptance.
          this.becomeFriend(record, now);
          reply.push(this.outbox.queueStatement(record, this.outbox.signStatement('accept', from, payload.requestId)));
          this.ledger.emit({ type: 'friend-accepted', peer: from, nickname: record.nickname });
          broadcast = this.syncItems([record]);
        } else if (record.relation === 'none' && ts > record.relationUpdatedAt - MAX_CLOCK_SKEW_MS) {
          record.relation = 'incoming';
          record.requestId = payload.requestId;
          record.requestedAt = ts;
          record.relationUpdatedAt = now;
          this.ledger.emit({ type: 'friend-request', peer: from, nickname: record.nickname });
          broadcast = this.syncItems([record]);
        }
        break;
      }
      case 'accept': {
        if (record.relation === 'outgoing' && record.requestId === payload.requestId) {
          this.becomeFriend(record, now);
          this.ledger.emit({ type: 'friend-accepted', peer: from, nickname: record.nickname });
          broadcast = this.syncItems([record]);
        }
        break;
      }
      case 'cancel': {
        if (record.relation === 'incoming' && record.requestId === payload.requestId) {
          this.endRelation(record, now);
          broadcast = this.syncItems([record]);
        }
        break;
      }
      case 'remove': {
        if (record.relation === 'friend' && ts >= (record.friendSince ?? 0) - MAX_CLOCK_SKEW_MS) {
          this.endRelation(record, now);
          broadcast = this.syncItems([record]);
        }
        break;
      }
    }
    this.ledger.changed();
    reply.unshift(this.outbox.ackWhenStored(record, [payload.id]));
    const dispatch: DmDispatch = { reply: reply.filter((item): item is DmRelayItem => !!item) };
    if (broadcast.length > 0) dispatch.broadcast = broadcast;
    return dispatch;
  }

  /**
   * The friendship starts. A request this side still had queued is moot, and
   * the conversation is there for the first message.
   */
  private becomeFriend(record: PeerRecord, at: number): void {
    this.outbox.dropOutgoingRequest(record.publicKey);
    record.relation = 'friend';
    record.friendSince = at;
    record.relationUpdatedAt = at;
    record.outgoingStatement = null;
    this.ledger.meta(record.publicKey);
  }

  /**
   * The request or the friendship ends, and nothing of it is left: a request
   * still queued is dropped, and so is what was queued for the friend, whose
   * pending messages show as failed.
   */
  private endRelation(record: PeerRecord, at: number): void {
    if (record.relation === 'friend') this.outbox.dropPendingEnvelopes(record.publicKey);
    else if (record.relation === 'outgoing') this.outbox.dropOutgoingRequest(record.publicKey);
    record.relation = 'none';
    record.requestId = null;
    record.requestedAt = null;
    record.friendSince = null;
    record.outgoingStatement = null;
    record.relationUpdatedAt = at;
  }

  // ---------------------------------------------------------------------------
  // Own devices
  // ---------------------------------------------------------------------------

  syncEntry(record: PeerRecord): SyncEntry {
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

  /** Relations for the other devices of this identity: of `records`, or all of them (an empty list too, as a greeting). */
  syncItems(records?: PeerRecord[]): DmRelayItem[] {
    const entries = (records ?? Object.values(this.ledger.state.peers))
      .filter((record) => record.relationUpdatedAt > 0 || record.blockedUpdatedAt > 0)
      .map((record) => this.syncEntry(record));
    const items: DmRelayItem[] = [];
    let batch: SyncEntry[] = [];
    let batchSize = 0;
    const pushBatch = () => {
      if (batch.length === 0) return;
      items.push(this.outbox.selfItem('sync', { entries: batch }, 'signal'));
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
      items.push(this.outbox.selfItem('sync', { entries: [] }, 'signal'));
    }
    return items;
  }

  /**
   * Relations another own device (or a backup) has: each one newer than what
   * this device knows replaces it. Answers with everything when the other
   * device is the one behind.
   */
  mergeSync(entries: unknown[]): DmDispatch {
    let dirty = false;
    let theyAreBehind = false;
    for (const value of entries.slice(0, 2000)) {
      if (!isRecord(value) || !isIdentityPublicKey(value.publicKey)) continue;
      const peer = normalizeIdentityKey(value.publicKey);
      if (peer === this.ledger.me) continue;
      const relation = value.relation;
      if (relation !== 'none' && relation !== 'friend' && relation !== 'outgoing' && relation !== 'incoming') continue;
      const relationUpdatedAt = typeof value.relationUpdatedAt === 'number' ? value.relationUpdatedAt : 0;
      const blockedUpdatedAt = typeof value.blockedUpdatedAt === 'number' ? value.blockedUpdatedAt : 0;
      const cert = verifyDmCertificate(peer, value.cert) ? value.cert : null;
      const local = this.ledger.state.peers[peer];
      if (relationUpdatedAt > (local?.relationUpdatedAt ?? 0)) {
        if ((relation === 'friend' || relation === 'incoming') && !cert && !local?.cert) continue;
        const record = this.ledger.ensurePeer(peer, typeof value.nickname === 'string' ? value.nickname : undefined);
        const previous = record.relation;
        record.relation = relation;
        record.relationUpdatedAt = relationUpdatedAt;
        record.requestId = isDmId(value.requestId) ? value.requestId : null;
        record.friendSince = typeof value.friendSince === 'number' ? value.friendSince : null;
        record.requestedAt = typeof value.requestedAt === 'number' ? value.requestedAt : null;
        if (cert) record.cert = cert;
        const statement = this.validOwnStatement(value.outgoingStatement, peer);
        record.outgoingStatement = relation === 'outgoing' ? statement : null;
        if (relation === 'outgoing' && statement && !this.outbox.entries(peer).some((entry) => entry.id === statement.p.id)) {
          this.outbox.entries(peer).push({ id: statement.p.id, kind: 'friend', type: 'request', ts: statement.p.ts, statement, lastSentAt: 0 });
        }
        if (relation !== 'outgoing') this.outbox.dropOutgoingRequest(peer);
        if (previous === 'friend' && relation !== 'friend') this.outbox.dropPendingEnvelopes(peer);
        if (relation === 'friend') this.ledger.meta(peer);
        dirty = true;
      } else if (local && local.relationUpdatedAt > relationUpdatedAt) {
        theyAreBehind = true;
      }
      if (blockedUpdatedAt > (this.ledger.state.peers[peer]?.blockedUpdatedAt ?? 0)) {
        const record = this.ledger.ensurePeer(peer, typeof value.nickname === 'string' ? value.nickname : undefined);
        record.blocked = value.blocked === true;
        record.blockedUpdatedAt = blockedUpdatedAt;
        dirty = true;
      } else if (local && local.blockedUpdatedAt > blockedUpdatedAt) {
        theyAreBehind = true;
      }
    }
    if (entries.length === 0) {
      // An empty sync is a "full state" hello from a fresh device.
      theyAreBehind = Object.values(this.ledger.state.peers).some((record) => record.relationUpdatedAt > 0 || record.blockedUpdatedAt > 0);
    }
    if (dirty) this.ledger.changed();
    return theyAreBehind ? { reply: this.syncItems() } : {};
  }

  /** A friend request this identity signed, as another own device hands it over; null when it is not one. */
  private validOwnStatement(value: unknown, peer: string): SignedStatement | null {
    if (!isSignedStatement(value)) return null;
    const payload = value.p;
    if (
      payload.type !== 'request' ||
      normalizeIdentityKey(payload.from) !== this.ledger.me ||
      normalizeIdentityKey(payload.to) !== peer ||
      !verifyDmStatement(this.ledger.me, payload, value.s)
    ) {
      return null;
    }
    return value;
  }
}
