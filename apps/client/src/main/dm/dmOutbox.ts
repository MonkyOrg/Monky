import type { DmDispatch, DmRelayItem } from '@monky/shared';
import { newDmId, type DmKeyCertificate, type DmKeyring } from './dmCrypto';
import type { DmLedger } from './dmLedger';
import {
  DmError,
  type FriendStatementPayload,
  type OutboxEntry,
  type PeerRecord,
  type SignedStatement,
  type StatementType,
  type StoredMessage,
} from './dmModel';
import { isRecord } from './dmWire';

/** Queued items not confirmed this long after they went out go again with the next round. */
const RESEND_AFTER_MS = 20_000;
/** Ids one ack envelope carries; the receiving side reads at most this many. */
const MAX_ACK_IDS = 200;

/** What the renderer sends after an operation: `items` to one friend (null entries dropped), `broadcast` to every session. */
export function dispatchFor(peer: string, items: Array<DmRelayItem | null>, broadcast: DmRelayItem[] = []): DmDispatch {
  const list = items.filter((item): item is DmRelayItem => !!item);
  const dispatch: DmDispatch = {};
  if (list.length > 0) dispatch.peers = { [peer]: list };
  if (broadcast.length > 0) dispatch.broadcast = broadcast;
  return dispatch;
}

/**
 * What leaves this device (#743). Every item is sealed here. The operations a
 * friend must get wait in their outbox until the friend acks them, and the
 * acks this device owes leave only once what they confirm is on disk.
 */
export class DmOutbox {
  /** Received items confirmed only once what they changed is on disk: the sender drops them from its outbox on the ack. */
  private pendingAcks: Array<{ peer: string; id: string; needs: Set<string> }> = [];

  constructor(
    private readonly ledger: DmLedger,
    private readonly keyring: DmKeyring,
  ) {}

  signStatement(type: StatementType, to: string, requestId: string): SignedStatement {
    const payload: FriendStatementPayload = {
      v: 1,
      type,
      id: newDmId(),
      requestId,
      from: this.ledger.me,
      to,
      ts: this.ledger.stamp(),
      cert: this.keyring.certificate(),
      nickname: this.ledger.myNickname(),
      maxFileBytes: this.ledger.state.settings.maxFileBytes,
    };
    return { p: payload, s: this.keyring.signStatement(payload) };
  }

  statementItem(statement: SignedStatement): DmRelayItem {
    return { to: statement.p.to, kind: 'friend', data: JSON.stringify(statement) };
  }

  private seal(peer: string, cert: DmKeyCertificate, type: string, body: unknown, id = newDmId(), ts = this.ledger.stamp()): string {
    return this.keyring.seal(peer, cert, { id, type, ts }, body);
  }

  envelopeItem(record: PeerRecord, type: string, body: unknown, kind: DmRelayItem['kind'] = 'signal'): DmRelayItem {
    if (!record.cert) throw new DmError('not-friend', 'Certificado do amigo ausente.');
    return { to: record.publicKey, kind, data: this.seal(record.publicKey, record.cert, type, body) };
  }

  selfItem(type: string, body: unknown, kind: DmRelayItem['kind'] = 'envelope'): DmRelayItem {
    return { to: this.ledger.me, kind, data: this.seal(this.ledger.me, this.keyring.certificate(), type, body) };
  }

  selfCopy(peer: string, type: string, id: string, ts: number, body: unknown): DmRelayItem {
    return this.selfItem('self', { peer, op: { id, type, ts, body } });
  }

  entries(peer: string): OutboxEntry[] {
    let entries = this.ledger.state.outbox[peer];
    if (!entries) {
      entries = [];
      this.ledger.state.outbox[peer] = entries;
    }
    return entries;
  }

  item(record: PeerRecord, entry: OutboxEntry): DmRelayItem | null {
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

  queueStatement(record: PeerRecord, statement: SignedStatement): DmRelayItem {
    const now = this.ledger.now();
    this.entries(record.publicKey).push({
      id: statement.p.id,
      kind: 'friend',
      type: statement.p.type,
      ts: statement.p.ts,
      statement,
      lastSentAt: now,
    });
    return this.statementItem(statement);
  }

  queueEnvelope(record: PeerRecord, type: string, body: unknown, id = newDmId(), ts = this.ledger.stamp()): DmRelayItem | null {
    const entry: OutboxEntry = { id, kind: 'envelope', type, ts, body, lastSentAt: this.ledger.now() };
    this.entries(record.publicKey).push(entry);
    return this.item(record, entry);
  }

  /** Drops queued operations of `types` that target `messageId`; a queued `msg` is matched by its own id. */
  dropQueued(peer: string, messageId: string, types: readonly string[]): void {
    this.ledger.state.outbox[peer] = this.entries(peer).filter((entry) => {
      if (!types.includes(entry.type)) return true;
      const target = entry.type === 'msg' ? entry.id : isRecord(entry.body) ? entry.body.messageId : undefined;
      return target !== messageId;
    });
  }

  /** Drops the friend request queued for `peer`, now answered, withdrawn or moot. */
  dropOutgoingRequest(peer: string): void {
    this.ledger.state.outbox[peer] = this.entries(peer).filter((entry) => !(entry.kind === 'friend' && entry.type === 'request'));
  }

  /** Drops the read receipts queued for `peer`: only the newest one matters. */
  dropReadReceipts(peer: string): void {
    this.ledger.state.outbox[peer] = this.entries(peer).filter((entry) => entry.type !== 'read');
  }

  dropPendingEnvelopes(peer: string): void {
    const entries = this.ledger.state.outbox[peer] ?? [];
    const failedIds = new Set(entries.filter((entry) => entry.kind === 'envelope' && entry.type === 'msg').map((entry) => entry.id));
    this.ledger.state.outbox[peer] = entries.filter((entry) => entry.kind === 'friend');
    if (failedIds.size === 0) return;
    const changed: StoredMessage[] = [];
    for (const message of this.ledger.conversation(peer).messages) {
      if (failedIds.has(message.id) && message.delivery === 'pending') {
        message.delivery = 'failed';
        changed.push(message);
      }
    }
    this.ledger.emitMessages(peer, changed);
  }

  private ack(record: PeerRecord, ids: string[]): DmRelayItem | null {
    if (!record.cert || ids.length === 0) return null;
    return this.envelopeItem(record, 'ack', { ids });
  }

  /**
   * The ack for items whose effects are in memory now. It leaves at once when
   * nothing waits for the disk; otherwise it waits for the write pass that
   * saves them, so a crash right after acking can no longer lose a message the
   * sender already dropped from its outbox. Acks released together travel in
   * one envelope per peer.
   */
  ackWhenStored(record: PeerRecord, ids: string[]): DmRelayItem | null {
    const needs = this.ledger.store.pendingNames();
    if (needs.size === 0) return this.ack(record, ids);
    for (const id of ids) this.pendingAcks.push({ peer: record.publicKey, id, needs: new Set(needs) });
    return null;
  }

  releaseStoredAcks(written: ReadonlySet<string>): void {
    if (this.pendingAcks.length === 0) return;
    const ready = new Map<string, string[]>();
    this.pendingAcks = this.pendingAcks.filter((pending) => {
      for (const name of written) pending.needs.delete(name);
      if (pending.needs.size > 0) return true;
      const ids = ready.get(pending.peer) ?? [];
      ids.push(pending.id);
      ready.set(pending.peer, ids);
      return false;
    });
    const peers: Record<string, DmRelayItem[]> = {};
    for (const [peer, ids] of ready) {
      const record = this.ledger.state.peers[peer];
      if (!record || record.blocked) continue;
      for (let start = 0; start < ids.length; start += MAX_ACK_IDS) {
        const item = this.ack(record, ids.slice(start, start + MAX_ACK_IDS));
        if (item) (peers[peer] ??= []).push(item);
      }
    }
    if (Object.keys(peers).length > 0) this.ledger.emit({ type: 'dispatch', dispatch: { peers } });
  }

  /**
   * The items of `record`'s outbox to send now: every one when forced,
   * otherwise those that went out more than {@link RESEND_AFTER_MS} ago.
   */
  due(record: PeerRecord, now: number, force: boolean): DmRelayItem[] {
    const items: DmRelayItem[] = [];
    for (const entry of this.ledger.state.outbox[record.publicKey] ?? []) {
      if (!force && now - entry.lastSentAt < RESEND_AFTER_MS) continue;
      const item = this.item(record, entry);
      if (!item) continue;
      entry.lastSentAt = now;
      items.push(item);
    }
    return items;
  }

  /** The friend got these items: they leave the outbox, and the messages among them show as delivered. */
  acknowledged(record: PeerRecord, data: Record<string, unknown>): void {
    const peer = record.publicKey;
    const ids = Array.isArray(data.ids) ? data.ids.filter((id): id is string => typeof id === 'string').slice(0, MAX_ACK_IDS) : [];
    if (ids.length === 0) return;
    const acked = new Set(ids);
    const entries = this.ledger.state.outbox[peer] ?? [];
    const ackedMessages = entries.filter((entry) => acked.has(entry.id) && entry.type === 'msg').map((entry) => entry.id);
    this.ledger.state.outbox[peer] = entries.filter((entry) => !acked.has(entry.id));
    const changedMessages: StoredMessage[] = [];
    for (const id of ackedMessages) {
      const message = this.ledger.findMessage(peer, id);
      if (message && message.delivery !== 'delivered') {
        message.delivery = 'delivered';
        changedMessages.push(message);
      }
    }
    this.ledger.saveState();
    if (changedMessages.length > 0) {
      this.ledger.saveConversation(peer);
      this.ledger.emitMessages(peer, changedMessages);
    }
  }

  /** Whether received items wait for a write before their ack can leave (see {@link ackWhenStored}). */
  hasPendingAcks(): boolean {
    return this.pendingAcks.length > 0;
  }

  /** Forgets the acks still waiting; used right before the store is deleted. */
  discard(): void {
    this.pendingAcks = [];
  }
}
