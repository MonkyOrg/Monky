import { LIMITS, ProtocolErrorCode, type DmRelayItem } from '@monky/shared';

/**
 * Share of the server's bursts this side allows itself. The server refills by
 * the time each batch reaches it; batches that leave apart but arrive close
 * together (a congested link) find it emptier than the estimate here. A quarter
 * of each burst covers about a second of that, at the full rate.
 */
const BURST_SHARE = 0.75;
const ITEMS_BURST = LIMITS.DM_RELAY_RATE_ITEMS_BURST * BURST_SHARE;
const CHARS_BURST = LIMITS.DM_RELAY_RATE_BYTES_BURST * BURST_SHARE;
/** A batch the server never answered (the connection went away) stops being tracked. */
const IN_FLIGHT_TTL_MS = 30_000;
const MAX_IN_FLIGHT = 256;

interface Queued {
  item: DmRelayItem;
  /** Order of arrival, kept when a refused batch goes back in line. */
  seq: number;
}

export interface RelayPacerOptions {
  /** Puts one DM_RELAY_SEND on the wire; false when the connection is gone. */
  send: (relayId: string, items: DmRelayItem[]) => boolean;
  /** A batch refused for another reason than the rate; the outbox sends its items again later. */
  onDropped?: (code: string, items: number) => void;
}

/**
 * Sends DM relay items over one server connection within its rate limit
 * (DM-3). The server keeps two token buckets per connection, one for items and
 * one for characters of data, and refuses a whole DM_RELAY_SEND when either
 * runs dry. Without pacing, a large file used the burst up in about a second
 * and the windows refused after that only came back with the next outbox
 * round, 8 to 28 s later.
 *
 * This mirrors both buckets with the server's constants, holds back what does
 * not fit yet and sends it as soon as they refill. Conversation traffic
 * (messages, acks, hellos, file requests) goes ahead of file chunks, so a big
 * transfer never delays a chat message. A batch the server still refuses for
 * the rate goes back in line in its original order.
 */
export class RelayPacer {
  private urgent: Queued[] = [];
  private bulk: Queued[] = [];
  private itemTokens = ITEMS_BURST;
  private charTokens = CHARS_BURST;
  private updatedAt = Date.now();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly inFlight = new Map<string, { entries: Queued[]; sentAt: number }>();
  private seq = 0;

  constructor(private readonly options: RelayPacerOptions) {}

  /** Items waiting for the buckets to refill. */
  get queued(): number {
    return this.urgent.length + this.bulk.length;
  }

  enqueue(items: readonly DmRelayItem[]): void {
    for (const item of items) (item.kind === 'file' ? this.bulk : this.urgent).push({ item, seq: this.seq++ });
    this.drain();
  }

  /** The server relayed the batch. */
  accepted(relayId: string): void {
    this.inFlight.delete(relayId);
  }

  /**
   * The server refused a batch. One refused for the rate waits for the buckets
   * again; any other refusal is final for this connection. Returns whether the
   * batch was one of these.
   */
  refused(relayId: string, code: string): boolean {
    const batch = this.inFlight.get(relayId);
    if (!batch) return false;
    this.inFlight.delete(relayId);
    if (code !== ProtocolErrorCode.RATE_LIMITED) {
      this.options.onDropped?.(code, batch.entries.length);
      return true;
    }
    // The server ran dry before this estimate did: count from empty from now on.
    this.refill();
    this.itemTokens = 0;
    this.charTokens = 0;
    for (const entry of batch.entries) {
      const queue = entry.item.kind === 'file' ? this.bulk : this.urgent;
      const index = queue.findIndex((queued) => queued.seq > entry.seq);
      queue.splice(index < 0 ? queue.length : index, 0, entry);
    }
    this.drain();
    return true;
  }

  /**
   * A new connection starts with full buckets on the server; what waited for
   * the old one is dropped, and the outbox sends it again.
   */
  reset(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.urgent = [];
    this.bulk = [];
    this.inFlight.clear();
    this.itemTokens = ITEMS_BURST;
    this.charTokens = CHARS_BURST;
    this.updatedAt = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = Math.max(0, now - this.updatedAt) / 1000;
    this.updatedAt = now;
    this.itemTokens = Math.min(ITEMS_BURST, this.itemTokens + elapsed * LIMITS.DM_RELAY_RATE_ITEMS_PER_SECOND);
    this.charTokens = Math.min(CHARS_BURST, this.charTokens + elapsed * LIMITS.DM_RELAY_RATE_BYTES_PER_SECOND);
  }

  private drain(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    for (;;) {
      const head = this.urgent[0] ?? this.bulk[0];
      if (!head) return;
      this.refill();
      const batch: Queued[] = [];
      let chars = 0;
      for (const queue of [this.urgent, this.bulk]) {
        while (queue.length > 0 && batch.length < LIMITS.DM_RELAY_MAX_ITEMS) {
          const cost = queue[0].item.data.length;
          if (chars + cost > LIMITS.DM_RELAY_TOTAL_DATA_MAX_LENGTH) break;
          if (batch.length + 1 > this.itemTokens || chars + cost > this.charTokens) break;
          batch.push(queue[0]);
          queue.shift();
          chars += cost;
        }
        // File chunks only follow once every conversation item went out.
        if (queue.length > 0) break;
      }
      if (batch.length === 0) {
        this.wait(head.item.data.length);
        return;
      }
      this.itemTokens -= batch.length;
      this.charTokens -= chars;
      const relayId = crypto.randomUUID();
      if (!this.options.send(relayId, batch.map((entry) => entry.item))) {
        this.reset();
        return;
      }
      this.track(relayId, batch);
    }
  }

  /** Comes back when the buckets hold enough for the item at the head of the line. */
  private wait(cost: number): void {
    const itemsLack = Math.max(0, 1 - this.itemTokens) / LIMITS.DM_RELAY_RATE_ITEMS_PER_SECOND;
    const charsLack = Math.max(0, cost - this.charTokens) / LIMITS.DM_RELAY_RATE_BYTES_PER_SECOND;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.drain();
    }, Math.ceil(Math.max(itemsLack, charsLack) * 1000) + 1);
  }

  private track(relayId: string, entries: Queued[]): void {
    const now = Date.now();
    for (const [id, batch] of this.inFlight) {
      if (now - batch.sentAt < IN_FLIGHT_TTL_MS && this.inFlight.size < MAX_IN_FLIGHT) break;
      this.inFlight.delete(id);
    }
    this.inFlight.set(relayId, { entries, sentAt: now });
  }
}
