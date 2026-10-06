import { nativePollSchema, resourceAudienceSchema } from '@monky/shared';
import type { MessageRecord, NativePollRecord } from '../../domain/entities';
import type { INativePollRepository } from '../../domain/repositories';
import type { IDatabaseDriver } from './SqliteWrapper';
import { SqliteResourceAudienceRepository } from './SqliteResourceAudienceRepository';

interface PollRow {
  id: string;
  messageId: string;
  channelId: string;
  creatorUserId: string;
  question: string;
  allowMultiple: number;
  imagesJson: string;
  optionsJson: string;
  allowChange: number;
  closesAt: number | null;
  maxVoters: number | null;
  closedAt: number | null;
  liveAction: number;
  createdAt: number;
  revision: number;
  audienceJson: string;
}

const COLUMNS = `id, message_id AS messageId, channel_id AS channelId,
  creator_user_id AS creatorUserId, question, options_json AS optionsJson,
  allow_multiple AS allowMultiple, images_json AS imagesJson,
  allow_change AS allowChange, closes_at AS closesAt, max_voters AS maxVoters,
  closed_at AS closedAt, live_action AS liveAction, created_at AS createdAt, revision,
  audience_json AS audienceJson`;

function record(row: PollRow, audiences: SqliteResourceAudienceRepository): NativePollRecord {
  const options = JSON.parse(row.optionsJson) as unknown;
  const parsed = nativePollSchema.shape.options.parse(
    Array.isArray(options) ? options.map(option => ({ emoji: null, ...(option as object), votes: 0 })) : options
  );
  return {
    id: row.id,
    messageId: row.messageId,
    channelId: row.channelId,
    creatorUserId: row.creatorUserId,
    question: row.question,
    allowMultiple: Boolean(row.allowMultiple),
    imagePaths: nativePollSchema.shape.imageUrls.parse(JSON.parse(row.imagesJson))
      .map(url => url.slice('/avatars/'.length)),
    options: parsed.map(({ id, label, emoji }) => ({ id, label, emoji })),
    allowChange: Boolean(row.allowChange),
    closesAt: row.closesAt,
    maxVoters: row.maxVoters,
    closedAt: row.closedAt,
    liveAction: Boolean(row.liveAction),
    createdAt: row.createdAt,
    revision: row.revision,
    audience: audiences.load('poll', row.id),
  };
}

export class SqliteNativePollRepository implements INativePollRepository {
  private readonly audiences: SqliteResourceAudienceRepository;
  constructor(private readonly db: IDatabaseDriver) {
    this.audiences = new SqliteResourceAudienceRepository(db);
  }

  messageExists(messageId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM messages WHERE id = ?').get(messageId);
  }

  findById(id: string): NativePollRecord | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM native_polls WHERE id = ?`).get(id) as PollRow | undefined;
    return row ? record(row, this.audiences) : undefined;
  }

  findByMessageId(messageId: string): NativePollRecord | undefined {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM native_polls WHERE message_id = ?`).get(messageId) as PollRow | undefined;
    return row ? record(row, this.audiences) : undefined;
  }

  findByMessageIds(messageIds: string[]): NativePollRecord[] {
    if (messageIds.length === 0) return [];
    const rows = this.db.prepare(`SELECT ${COLUMNS} FROM native_polls
      WHERE message_id IN (${messageIds.map(() => '?').join(',')})`).all(...messageIds) as PollRow[];
    return rows.map(row => record(row, this.audiences));
  }

  listByChannel(channelId: string): NativePollRecord[] {
    const rows = this.db.prepare(`SELECT ${COLUMNS} FROM native_polls
      WHERE channel_id = ? ORDER BY created_at`).all(channelId) as PollRow[];
    return rows.map(row => record(row, this.audiences));
  }

  listActiveLiveActions(now: number): NativePollRecord[] {
    const rows = this.db.prepare(`SELECT ${COLUMNS} FROM native_polls
      WHERE live_action = 1 AND closed_at IS NULL AND (closes_at IS NULL OR closes_at > ?)
      ORDER BY created_at`).all(now) as PollRow[];
    return rows.map(row => record(row, this.audiences));
  }

  createWithMessage(poll: NativePollRecord, message: MessageRecord): { poll: NativePollRecord; created: boolean } {
    return this.db.transaction(() => {
      const existing = this.findByMessageId(message.id);
      if (existing) return { poll: existing, created: false };
      if (this.messageExists(message.id)) throw new Error('Message identifier already used.');
      this.db.prepare(`INSERT INTO messages
        (id, channel_id, user_id, content, created_at, is_system)
        VALUES (?, ?, ?, ?, ?, 0)`)
        .run(message.id, message.channelId, message.userId, message.content, message.createdAt);
      this.db.prepare(`INSERT INTO native_polls
        (id, message_id, channel_id, creator_user_id, question, allow_multiple, images_json,
         options_json, allow_change, closes_at, max_voters, closed_at, live_action, created_at, revision,
         audience_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(poll.id, poll.messageId, poll.channelId, poll.creatorUserId, poll.question,
          poll.allowMultiple ? 1 : 0, JSON.stringify(poll.imagePaths.map(path => `/avatars/${path}`)),
          JSON.stringify(poll.options), poll.allowChange ? 1 : 0, poll.closesAt, poll.maxVoters,
          poll.closedAt, poll.liveAction ? 1 : 0, poll.createdAt, poll.revision,
          JSON.stringify(resourceAudienceSchema.parse(poll.audience)));
      this.audiences.replace('poll', poll.id, poll.audience);
      return { poll, created: true };
    })();
  }

  vote(id: string, userId: string, optionIds: string[], now: number): NativePollRecord | undefined {
    return this.db.transaction(() => {
      let poll = this.findById(id);
      if (!poll) return undefined;
      if (poll.closedAt === null && poll.closesAt !== null && poll.closesAt <= now) {
        this.db.prepare('UPDATE native_polls SET closed_at = ?, revision = revision + 1 WHERE id = ? AND closed_at IS NULL')
          .run(poll.closesAt, id);
        return this.findById(id);
      }
      const validOptions = new Set(poll.options.map(option => option.id));
      if (poll.closedAt !== null || optionIds.some(optionId => !validOptions.has(optionId))) return poll;
      const previous = this.votesForUser(id, userId);
      if (previous.length > 0 && !poll.allowChange) return poll;
      if (previous.length === optionIds.length && previous.every(optionId => optionIds.includes(optionId))) return poll;
      this.db.prepare('DELETE FROM native_poll_votes WHERE poll_id = ? AND user_id = ?').run(id, userId);
      const insert = this.db.prepare(`INSERT INTO native_poll_votes
        (poll_id, user_id, option_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`);
      for (const optionId of optionIds) insert.run(id, userId, optionId, now, now);
      const total = this.voterCount(id);
      const closes = poll.maxVoters !== null && total >= poll.maxVoters ? now : null;
      this.db.prepare(`UPDATE native_polls SET revision = revision + 1,
        closed_at = CASE WHEN ? IS NULL THEN closed_at ELSE ? END WHERE id = ?`)
        .run(closes, closes, id);
      poll = this.findById(id);
      return poll;
    })();
  }

  closeExpired(now: number): NativePollRecord[] {
    return this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT ${COLUMNS} FROM native_polls
        WHERE closed_at IS NULL AND closes_at IS NOT NULL AND closes_at <= ?`).all(now) as PollRow[];
      if (rows.length === 0) return [];
      const statement = this.db.prepare('UPDATE native_polls SET closed_at = closes_at, revision = revision + 1 WHERE id = ? AND closed_at IS NULL');
      for (const row of rows) statement.run(row.id);
      return rows.map(row => this.findById(row.id)!).filter(Boolean);
    })();
  }

  closeByMessageId(messageId: string, now: number): NativePollRecord | undefined {
    this.db.prepare(`UPDATE native_polls SET closed_at = ?, live_action = 0, revision = revision + 1
      WHERE message_id = ? AND closed_at IS NULL`).run(now, messageId);
    return this.findByMessageId(messageId);
  }

  closeById(id: string, now: number): NativePollRecord | undefined {
    this.db.prepare(`UPDATE native_polls SET closed_at = ?, live_action = 0, revision = revision + 1
      WHERE id = ? AND closed_at IS NULL`).run(now, id);
    return this.findById(id);
  }

  deleteByMessageIds(messageIds: string[]): void {
    if (messageIds.length === 0) return;
    this.db.prepare(`DELETE FROM native_polls
      WHERE message_id IN (${messageIds.map(() => '?').join(',')})`).run(...messageIds);
  }

  voteCounts(id: string): Map<string, number> {
    const rows = this.db.prepare(`SELECT option_id AS optionId, COUNT(*) AS count
      FROM native_poll_votes WHERE poll_id = ? GROUP BY option_id`).all(id) as Array<{ optionId: string; count: number }>;
    return new Map(rows.map(row => [row.optionId, Number(row.count)]));
  }

  voterCount(id: string): number {
    return Number((this.db.prepare('SELECT COUNT(DISTINCT user_id) AS count FROM native_poll_votes WHERE poll_id = ?')
      .get(id) as { count: number }).count);
  }

  votesForUser(id: string, userId: string): string[] {
    return (this.db.prepare(`SELECT option_id AS optionId FROM native_poll_votes
      WHERE poll_id = ? AND user_id = ? ORDER BY created_at, option_id`).all(id, userId) as Array<{ optionId: string }>)
      .map(row => row.optionId);
  }
}
