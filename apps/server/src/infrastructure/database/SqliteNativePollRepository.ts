import { nativePollSchema, resourceAudienceSchema } from '@monky/shared';
import type { MessageRecord, NativePollRecord, NativePollVoterRecord } from '../../domain/entities';
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
  anonymousVotes: number;
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
  allow_multiple AS allowMultiple, anonymous_votes AS anonymousVotes, images_json AS imagesJson,
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
    anonymousVotes: Boolean(row.anonymousVotes),
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
        (id, message_id, channel_id, creator_user_id, question, allow_multiple, anonymous_votes, images_json,
         options_json, allow_change, closes_at, max_voters, closed_at, live_action, created_at, revision,
         audience_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(poll.id, poll.messageId, poll.channelId, poll.creatorUserId, poll.question,
          poll.allowMultiple ? 1 : 0, poll.anonymousVotes ? 1 : 0,
          JSON.stringify(poll.imagePaths.map(path => `/avatars/${path}`)),
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
      const removed = previous.filter(optionId => !optionIds.includes(optionId));
      const added = optionIds.filter(optionId => !previous.includes(optionId));
      if (removed.length === 0 && added.length === 0) return poll;
      // Kept answers keep their original time, so voter order stays stable while a member toggles others.
      const remove = this.db.prepare('DELETE FROM native_poll_votes WHERE poll_id = ? AND user_id = ? AND option_id = ?');
      for (const optionId of removed) remove.run(id, userId, optionId);
      const insert = this.db.prepare(`INSERT INTO native_poll_votes
        (poll_id, user_id, option_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`);
      for (const optionId of added) insert.run(id, userId, optionId, now, now);
      const total = this.voterCount(id);
      const closes = poll.maxVoters !== null && total >= poll.maxVoters ? now : null;
      this.db.prepare(`UPDATE native_polls SET revision = revision + 1,
        closed_at = CASE WHEN ? IS NULL THEN closed_at ELSE ? END WHERE id = ?`)
        .run(closes, closes, id);
      poll = this.findById(id);
      return poll;
    })();
  }

  edit(poll: NativePollRecord, singleAnswer: boolean, now: number): NativePollRecord | undefined {
    return this.db.transaction(() => {
      const current = this.findById(poll.id);
      if (!current || current.closedAt !== null || (current.closesAt !== null && current.closesAt <= now)) return undefined;
      // Changed, removed and reset answers carry ids that are no longer in the poll.
      const optionIds = poll.options.map(option => option.id);
      this.db.prepare(`DELETE FROM native_poll_votes WHERE poll_id = ?
        AND option_id NOT IN (${optionIds.map(() => '?').join(',')})`).run(poll.id, ...optionIds);
      if (singleAnswer) {
        this.db.prepare(`DELETE FROM native_poll_votes WHERE poll_id = ? AND user_id IN (
          SELECT user_id FROM native_poll_votes WHERE poll_id = ? GROUP BY user_id HAVING COUNT(*) > 1)`).run(poll.id, poll.id);
      }
      this.db.prepare(`UPDATE native_polls SET question = ?, allow_multiple = ?, anonymous_votes = ?, images_json = ?,
        options_json = ?, closes_at = ?, max_voters = ?, live_action = ?, audience_json = ?, revision = revision + 1
        WHERE id = ?`).run(
        poll.question, poll.allowMultiple ? 1 : 0, poll.anonymousVotes ? 1 : 0,
        JSON.stringify(poll.imagePaths.map(path => `/avatars/${path}`)), JSON.stringify(poll.options),
        poll.closesAt, poll.maxVoters, poll.liveAction ? 1 : 0,
        JSON.stringify(resourceAudienceSchema.parse(poll.audience)), poll.id,
      );
      this.audiences.replace('poll', poll.id, poll.audience);
      // The message text is the question: replies and search follow the edit.
      this.db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(poll.question, poll.messageId);
      if (poll.maxVoters !== null && this.voterCount(poll.id) >= poll.maxVoters) {
        this.db.prepare('UPDATE native_polls SET closed_at = ? WHERE id = ?').run(now, poll.id);
      }
      return this.findById(poll.id);
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

  votersByOption(id: string, limitPerOption?: number): Map<string, NativePollVoterRecord[]> {
    const rows = this.db.prepare(`SELECT optionId, userId, nickname, avatarPath FROM (
        SELECT v.option_id AS optionId, v.user_id AS userId, u.nickname AS nickname, u.avatar_path AS avatarPath,
          ROW_NUMBER() OVER (PARTITION BY v.option_id ORDER BY v.created_at, v.user_id) AS position
        FROM native_poll_votes v JOIN users u ON u.id = v.user_id
        WHERE v.poll_id = ?)
      WHERE ? IS NULL OR position <= ?
      ORDER BY optionId, position`).all(id, limitPerOption ?? null, limitPerOption ?? null) as Array<{
        optionId: string; userId: string; nickname: string; avatarPath: string | null;
      }>;
    const voters = new Map<string, NativePollVoterRecord[]>();
    for (const row of rows) {
      const list = voters.get(row.optionId) ?? [];
      list.push({ userId: row.userId, nickname: row.nickname, avatarPath: row.avatarPath });
      voters.set(row.optionId, list);
    }
    return voters;
  }
}
