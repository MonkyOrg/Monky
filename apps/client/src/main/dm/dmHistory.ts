import { createHash } from 'crypto';
import {
  DAY_MS,
  messageFingerprint,
  type ConversationHead,
  type ConversationSegment,
  type DayIndex,
  type StoredConversation,
  type StoredMessage,
} from './dmModel';
import { DmPersistence } from './dmPersistence';
import { isRecord } from './dmWire';

/** Deletes of messages this device never had, remembered per conversation. */
const MAX_TOMBSTONES = 500;
/** Dates past the year 9999 have no month; times are clamped long before that anyway. */
const LATEST_DATE_MS = 253_402_300_799_999;

/** The UTC month (`yyyymm`) a message time belongs to; times before 1970 go with its first month. */
export function monthOf(ts: number): number {
  const date = new Date(Math.min(Math.max(ts, 0), LATEST_DATE_MS));
  return date.getUTCFullYear() * 100 + date.getUTCMonth() + 1;
}

function dayOf(ts: number): number {
  return Math.floor(ts / DAY_MS);
}

/** A UTC day never crosses months, so every message of a day lives in the segment of this month. */
function monthOfDay(day: number): number {
  return monthOf(day * DAY_MS);
}

/** Conversation order: by time, and by id between messages of the same millisecond, the same on every device. */
function sortsBefore(a: StoredMessage, b: StoredMessage): boolean {
  return a.createdAt < b.createdAt || (a.createdAt === b.createdAt && a.id < b.id);
}

/** First position of `messages` whose time is at least `ts`. */
function firstAtOrAfter(messages: StoredMessage[], ts: number): number {
  let low = 0;
  let high = messages.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (messages[middle].createdAt < ts) low = middle + 1;
    else high = middle;
  }
  return low;
}

function descending(months: Iterable<number>): number[] {
  return [...months].sort((a, b) => b - a);
}

interface Segment {
  month: number;
  messages: StoredMessage[];
  byId: Map<string, StoredMessage>;
}

interface Conversation {
  peer: string;
  head: ConversationHead;
  /** Every month with messages, on disk or only in memory so far. */
  months: Set<number>;
  /** The months in memory; the rest is read when needed. */
  segments: Map<number, Segment>;
  /** Days whose messages changed since their {@link DayIndex} was computed. */
  staleDays: Set<number>;
  /** Months whose days were checked against the head since the conversation was opened. */
  verified: Set<number>;
  /** Being moved from the file of an earlier version: it writes everything itself, at the end. */
  moving: boolean;
}

function segmentOf(month: number, messages: StoredMessage[]): Segment {
  return { month, messages, byId: new Map(messages.map((message) => [message.id, message])) };
}

/**
 * The messages of every conversation, stored by month (#823).
 *
 * A conversation is a folder with one sealed file per UTC month and an
 * `index.mkdm` head: the tombstones and one {@link DayIndex} per day. A change
 * rewrites its month and the head, never the whole history; the digest, the
 * message count and the unread count come from the head without reading a
 * single message; pages are read from the newest month back. Months stay in
 * memory while used, up to {@link maxCachedMessages} messages in all.
 *
 * A conversation saved in one file by an earlier version is moved here the
 * first time it is opened. The head is written last: until it exists the old
 * file stays and the move starts over, merging what an interrupted move had
 * already written.
 */
export class DmHistory {
  /** Messages kept in memory across conversations; months that are still being saved stay over it. Tests use less. */
  static maxCachedMessages = 20_000;
  private readonly conversations = new Map<string, Conversation>();
  /** Months in memory, least recently used first. */
  private readonly recent = new Map<string, { conversation: Conversation; month: number }>();
  private trimTimer: NodeJS.Immediate | null = null;

  constructor(
    private readonly store: DmPersistence,
    private readonly me: string,
  ) {}

  // ---------------------------------------------------------------------------
  // Reading
  // ---------------------------------------------------------------------------

  /**
   * A message by id. The months in memory are looked at first, then, given
   * the time of the message, only its month; without it, the others from the
   * newest back.
   */
  find(peer: string, id: string, createdAt?: number): StoredMessage | null {
    const conversation = this.open(peer);
    for (const segment of conversation.segments.values()) {
      const message = segment.byId.get(id);
      if (message) return message;
    }
    if (createdAt !== undefined) {
      const month = monthOf(createdAt);
      if (!conversation.months.has(month) || conversation.segments.has(month)) return null;
      return this.segment(conversation, month).byId.get(id) ?? null;
    }
    for (const month of descending(conversation.months)) {
      if (conversation.segments.has(month)) continue;
      // Kept only when the message is there: a search that finds nothing does not fill the memory.
      const segment = this.read(conversation, month);
      const message = segment.byId.get(id);
      if (message) {
        this.adopt(conversation, segment);
        return message;
      }
    }
    return null;
  }

  /** The messages of a conversation from the newest back, each month read only when reached. */
  *newestFirst(peer: string): Generator<StoredMessage> {
    const conversation = this.open(peer);
    for (const month of descending(conversation.months)) {
      const messages = this.segment(conversation, month).messages;
      for (let index = messages.length - 1; index >= 0; index -= 1) yield messages[index];
    }
  }

  /** Up to `limit` messages right before `before` (or the newest), crossing months as needed. */
  page(peer: string, before: string | null, limit: number): { messages: StoredMessage[]; hasMore: boolean } {
    const conversation = this.open(peer);
    const anchor = before ? this.find(peer, before) : null;
    const anchorMonth = anchor ? monthOf(anchor.createdAt) : Number.POSITIVE_INFINITY;
    const months = descending(conversation.months).filter((month) => month <= anchorMonth);
    const parts: StoredMessage[][] = [];
    let needed = limit;
    let hasMore = false;
    for (let index = 0; index < months.length; index += 1) {
      const segment = this.segment(conversation, months[index]);
      let end = segment.messages.length;
      if (anchor && months[index] === anchorMonth) {
        const position = segment.messages.indexOf(anchor);
        if (position >= 0) end = position;
      }
      const start = Math.max(0, end - needed);
      parts.unshift(segment.messages.slice(start, end));
      needed -= end - start;
      if (needed === 0) {
        hasMore = start > 0 || index < months.length - 1;
        break;
      }
    }
    return { messages: parts.flat(), hasMore };
  }

  /** Every message, oldest first, for a backup; months not in memory are read without being kept. */
  all(peer: string): StoredMessage[] {
    const conversation = this.open(peer);
    return descending(conversation.months).reverse()
      .flatMap((month) => (conversation.segments.get(month) ?? this.read(conversation, month)).messages);
  }

  /** The messages of one UTC day (days since 1970). */
  messagesOfDay(peer: string, day: number): StoredMessage[] {
    return this.dayMessages(this.open(peer), day);
  }

  /** The fingerprint of each day with messages; read from the head, without the messages. */
  dayHashes(peer: string): Map<number, string> {
    const conversation = this.open(peer);
    this.reindex(conversation);
    return new Map(Object.entries(conversation.head.days).map(([day, index]) => [Number(day), index.h]));
  }

  /**
   * What the conversation list shows: messages not deleted, the newest of
   * them, and how many from the friend came after `lastReadAt`. Only the
   * month of the newest message and the one of `lastReadAt` are read.
   */
  summary(peer: string, lastReadAt: number): { count: number; last: StoredMessage | null; unread: number } {
    const conversation = this.open(peer);
    this.reindex(conversation);
    const days = Object.keys(conversation.head.days).map(Number).sort((a, b) => b - a);
    let count = 0;
    let last: StoredMessage | null = null;
    let unread = 0;
    const readDay = dayOf(lastReadAt);
    let counting = true;
    for (const day of days) {
      const index = conversation.head.days[day];
      count += index.n;
      if (!last && index.n > 0) {
        const messages = this.dayMessages(conversation, day);
        for (let position = messages.length - 1; position >= 0 && !last; position -= 1) {
          if (!messages[position].deleted) last = messages[position];
        }
      }
      if (!counting) continue;
      if (day > readDay) {
        unread += index.i;
      } else {
        counting = false;
        if (day === readDay && index.i > 0) {
          unread += this.dayMessages(conversation, day)
            .filter((message) => !message.deleted && message.author !== this.me && message.createdAt > lastReadAt).length;
        }
      }
    }
    return { count, last, unread };
  }

  isTombstoned(peer: string, id: string, author: string): boolean {
    return this.open(peer).head.tombstones.some((entry) => entry.id === id && entry.author === author);
  }

  // ---------------------------------------------------------------------------
  // Writing
  // ---------------------------------------------------------------------------

  /** Puts a message in its place, unless a message with its id is already there. */
  insert(peer: string, message: StoredMessage): boolean {
    return this.insertInto(this.open(peer), message);
  }

  /** Messages changed in place: their month and the head are saved, and their days indexed again. */
  touch(peer: string, messages: Iterable<StoredMessage>): void {
    const conversation = this.open(peer);
    for (const message of messages) {
      const segment = this.segment(conversation, monthOf(message.createdAt));
      const held = segment.byId.get(message.id);
      if (!held) continue;
      if (held !== message) {
        // A copy read again after its month left the memory: the caller's version is the one changed.
        segment.messages[segment.messages.indexOf(held)] = message;
        segment.byId.set(message.id, message);
      }
      this.changedIn(conversation, segment, message);
    }
  }

  addTombstone(peer: string, id: string, author: string): void {
    const conversation = this.open(peer);
    if (this.isTombstoned(peer, id, author)) return;
    const tombstones = conversation.head.tombstones;
    tombstones.push({ id, author });
    if (tombstones.length > MAX_TOMBSTONES) tombstones.splice(0, tombstones.length - MAX_TOMBSTONES);
    this.scheduleHead(conversation);
  }

  /** Forgets everything in memory; used right before the store is deleted. */
  discard(): void {
    if (this.trimTimer) clearImmediate(this.trimTimer);
    this.trimTimer = null;
    this.conversations.clear();
    this.recent.clear();
  }

  // ---------------------------------------------------------------------------
  // Conversations and months
  // ---------------------------------------------------------------------------

  private open(peer: string): Conversation {
    const cached = this.conversations.get(peer);
    if (cached) return cached;
    // A head or month that cannot be read right now throws, leaving everything on disk for the next try.
    const head = this.store.readJson(
      DmPersistence.headName(peer),
      (value): value is ConversationHead =>
        isRecord(value) && value.peer === peer && isRecord(value.days) && Array.isArray(value.tombstones),
    );
    const conversation: Conversation = {
      peer,
      head: head ?? { version: 2, peer, tombstones: [], days: {} },
      months: new Set(this.store.listSegments(peer)),
      segments: new Map(),
      staleDays: new Set(),
      verified: new Set(),
      moving: false,
    };
    this.conversations.set(peer, conversation);
    try {
      const legacy = DmPersistence.peerFileName(peer);
      if (this.store.exists(legacy)) {
        if (head) this.removeLegacy(legacy);
        else this.migrate(conversation, legacy);
      }
      this.reconcile(conversation);
    } catch (error) {
      this.forget(conversation);
      throw error;
    }
    return conversation;
  }

  /**
   * Moves a conversation from the single file of earlier versions. Messages
   * are merged into what an interrupted move left, every month is written,
   * and only then the head, which marks the move as done, and the old file goes.
   */
  private migrate(conversation: Conversation, legacyName: string): void {
    const legacy = this.store.readJson(
      legacyName,
      (value): value is StoredConversation => isRecord(value) && value.peer === conversation.peer && Array.isArray(value.messages),
    );
    // Missing, or unreadable and set aside: there is nothing to move.
    if (!legacy) return;
    // Nothing is scheduled while moving: a head saved before every month is would mark the move as done.
    conversation.moving = true;
    const months = new Set<number>();
    for (const message of legacy.messages) {
      if (this.insertInto(conversation, message)) months.add(monthOf(message.createdAt));
    }
    for (const entry of legacy.tombstones ?? []) {
      if (!conversation.head.tombstones.some((known) => known.id === entry.id && known.author === entry.author)) {
        conversation.head.tombstones.push(entry);
      }
    }
    this.reindex(conversation);
    for (const month of months) {
      this.store.writeJsonNow(DmPersistence.segmentName(conversation.peer, month), this.segmentDocument(conversation, month));
    }
    this.store.writeJsonNow(DmPersistence.headName(conversation.peer), conversation.head);
    conversation.moving = false;
    this.removeLegacy(legacyName);
  }

  private removeLegacy(name: string): void {
    try {
      this.store.remove(name);
    } catch (error) {
      // The move is done; the old file goes the next time the conversation is opened.
      console.error(`[DM] ${name} was moved but could not be deleted yet.`, error);
    }
  }

  /** Days of months that are gone are dropped, and months the head does not know (a crash between writes) are indexed. */
  private reconcile(conversation: Conversation): void {
    const indexed = new Set<number>();
    let changed = false;
    for (const key of Object.keys(conversation.head.days)) {
      const month = monthOfDay(Number(key));
      if (conversation.months.has(month)) {
        indexed.add(month);
      } else {
        delete conversation.head.days[key];
        changed = true;
      }
    }
    if (changed) this.scheduleHead(conversation);
    for (const month of conversation.months) {
      if (!indexed.has(month)) this.segment(conversation, month);
    }
  }

  /** A month in memory, read from disk if needed; a month without messages yet starts empty. */
  private segment(conversation: Conversation, month: number): Segment {
    const loaded = conversation.segments.get(month);
    if (loaded) {
      this.bump(conversation, month);
      return loaded;
    }
    const segment = this.read(conversation, month);
    this.adopt(conversation, segment);
    return segment;
  }

  /**
   * Reads a month without keeping it. The first read of each month corrects
   * the head when its days disagree with what the month holds (a crash
   * between the two writes); from then on, the head follows every change.
   */
  private read(conversation: Conversation, month: number): Segment {
    if (!conversation.months.has(month)) return segmentOf(month, []);
    const document = this.store.readJson(
      DmPersistence.segmentName(conversation.peer, month),
      (value): value is ConversationSegment =>
        isRecord(value) && value.peer === conversation.peer && value.month === month && Array.isArray(value.messages),
    );
    // Unreadable and set aside: only this month starts over.
    if (!document) conversation.months.delete(month);
    const segment = segmentOf(month, document?.messages ?? []);
    if (!conversation.verified.has(month)) {
      conversation.verified.add(month);
      this.verify(conversation, segment);
    }
    return segment;
  }

  private verify(conversation: Conversation, segment: Segment): void {
    const actual = new Map<number, DayIndex>();
    let start = 0;
    while (start < segment.messages.length) {
      const day = dayOf(segment.messages[start].createdAt);
      const end = firstAtOrAfter(segment.messages, (day + 1) * DAY_MS);
      actual.set(day, this.dayIndex(segment.messages.slice(start, Math.max(end, start + 1))));
      start = Math.max(end, start + 1);
    }
    const days = conversation.head.days;
    let changed = false;
    for (const key of Object.keys(days)) {
      if (monthOfDay(Number(key)) === segment.month && !actual.has(Number(key))) {
        delete days[key];
        changed = true;
      }
    }
    for (const [day, index] of actual) {
      const known = days[day];
      if (!known || known.h !== index.h || known.n !== index.n || known.i !== index.i) {
        days[day] = index;
        changed = true;
      }
    }
    if (changed) this.scheduleHead(conversation);
  }

  private insertInto(conversation: Conversation, message: StoredMessage): boolean {
    const segment = this.segment(conversation, monthOf(message.createdAt));
    if (segment.byId.has(message.id)) return false;
    for (const other of conversation.segments.values()) {
      if (other.byId.has(message.id)) return false;
    }
    let low = 0;
    let high = segment.messages.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (sortsBefore(message, segment.messages[middle])) high = middle;
      else low = middle + 1;
    }
    segment.messages.splice(low, 0, message);
    segment.byId.set(message.id, message);
    conversation.months.add(segment.month);
    this.changedIn(conversation, segment, message);
    return true;
  }

  private changedIn(conversation: Conversation, segment: Segment, message: StoredMessage): void {
    conversation.staleDays.add(dayOf(message.createdAt));
    if (conversation.moving) return;
    this.store.writeJsonSoon(
      DmPersistence.segmentName(conversation.peer, segment.month),
      () => this.segmentDocument(conversation, segment.month, segment),
    );
    this.scheduleHead(conversation);
  }

  private segmentDocument(conversation: Conversation, month: number, segment = conversation.segments.get(month)): ConversationSegment {
    return { version: 2, peer: conversation.peer, month, messages: segment?.messages ?? [] };
  }

  private scheduleHead(conversation: Conversation): void {
    if (conversation.moving) return;
    this.store.writeJsonSoon(DmPersistence.headName(conversation.peer), () => {
      this.reindex(conversation);
      return conversation.head;
    });
  }

  private dayMessages(conversation: Conversation, day: number): StoredMessage[] {
    const messages = this.segment(conversation, monthOfDay(day)).messages;
    return messages.slice(firstAtOrAfter(messages, day * DAY_MS), firstAtOrAfter(messages, (day + 1) * DAY_MS));
  }

  /** Indexes again the days that changed, from their month in memory. */
  private reindex(conversation: Conversation): void {
    if (conversation.staleDays.size === 0) return;
    const days = [...conversation.staleDays];
    conversation.staleDays.clear();
    for (const day of days) {
      const messages = this.dayMessages(conversation, day);
      if (messages.length > 0) conversation.head.days[day] = this.dayIndex(messages);
      else delete conversation.head.days[day];
    }
  }

  /** What earlier versions computed for the digest, so devices on either version agree on a day. */
  private dayIndex(messages: StoredMessage[]): DayIndex {
    const hash = createHash('sha256');
    let visible = 0;
    let incoming = 0;
    for (const message of messages) {
      hash.update(messageFingerprint(message));
      if (message.deleted) continue;
      visible += 1;
      if (message.author !== this.me) incoming += 1;
    }
    return { h: hash.digest('hex').slice(0, 12), n: visible, i: incoming };
  }

  // ---------------------------------------------------------------------------
  // Memory
  // ---------------------------------------------------------------------------

  private adopt(conversation: Conversation, segment: Segment): void {
    conversation.segments.set(segment.month, segment);
    this.bump(conversation, segment.month);
    // Later, so a month is never dropped in the middle of an operation that holds its messages.
    if (!this.trimTimer) {
      this.trimTimer = setImmediate(() => {
        this.trimTimer = null;
        this.trim();
      });
      this.trimTimer.unref?.();
    }
  }

  private bump(conversation: Conversation, month: number): void {
    const key = `${conversation.peer}:${month}`;
    this.recent.delete(key);
    this.recent.set(key, { conversation, month });
  }

  /** Drops the least recently used months over the limit; a month still to be saved or indexed stays. */
  private trim(): void {
    let total = 0;
    for (const { conversation, month } of this.recent.values()) total += conversation.segments.get(month)?.messages.length ?? 0;
    for (const [key, { conversation, month }] of this.recent) {
      if (total <= DmHistory.maxCachedMessages) break;
      const segment = conversation.segments.get(month);
      if (segment) {
        const stale = [...conversation.staleDays].some((day) => monthOfDay(day) === month);
        if (stale || this.store.hasPending(DmPersistence.segmentName(conversation.peer, month))) continue;
        conversation.segments.delete(month);
        total -= segment.messages.length;
      }
      this.recent.delete(key);
    }
  }

  private forget(conversation: Conversation): void {
    this.conversations.delete(conversation.peer);
    for (const month of conversation.segments.keys()) this.recent.delete(`${conversation.peer}:${month}`);
  }
}
