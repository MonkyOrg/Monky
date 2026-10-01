import type { ForumPost, ForumUpdatePost, ChannelSummary } from '@monky/shared';
import type { IDatabaseDriver } from './SqliteWrapper';

interface PostRow extends Omit<ForumPost, 'locked' | 'closed' | 'pinned'> {
  locked: number;
  closed: number;
  pinned: number;
  thumbnailFilename: string | null;
}
const columns = `p.channel_id AS channelId, p.forum_id AS forumId, c.name AS title, p.author_id AS authorId,
  p.created_at AS createdAt, p.pinned, p.locked, p.closed,
  COALESCE((SELECT MAX(created_at) FROM messages WHERE channel_id = p.channel_id AND deleted_at IS NULL), p.created_at) AS updatedAt,
  (SELECT COUNT(*) FROM messages WHERE channel_id = p.channel_id AND deleted_at IS NULL AND is_system = 0
    AND id <> (SELECT id FROM messages WHERE channel_id = p.channel_id ORDER BY created_at, rowid LIMIT 1)) AS replyCount,
  COALESCE((SELECT substr(content, 1, 300) FROM messages WHERE channel_id = p.channel_id AND deleted_at IS NULL ORDER BY created_at, rowid LIMIT 1), '') AS preview,
  (SELECT a.filename FROM message_attachments a JOIN messages m ON m.id = a.message_id
    WHERE m.id = (SELECT id FROM messages WHERE channel_id = p.channel_id ORDER BY created_at, rowid LIMIT 1)
      AND m.deleted_at IS NULL AND a.kind = 'image' AND a.evicted = 0 LIMIT 1) AS thumbnailFilename,
  (SELECT COUNT(*) FROM message_reactions r JOIN messages m ON m.id = r.message_id
    WHERE m.id = (SELECT id FROM messages WHERE channel_id = p.channel_id ORDER BY created_at, rowid LIMIT 1)
      AND m.deleted_at IS NULL) AS reactionCount,
  (SELECT id FROM messages WHERE channel_id = p.channel_id ORDER BY created_at, rowid LIMIT 1) AS firstMessageId`;
const map = ({ thumbnailFilename, ...row }: PostRow): ForumPost => ({
  ...row, locked: row.locked === 1, closed: row.closed === 1, pinned: row.pinned === 1,
  thumbnailUrl: thumbnailFilename ? `/attachments/${encodeURIComponent(thumbnailFilename)}` : null,
});

export class SqliteForumRepository {
  constructor(private readonly db: IDatabaseDriver) {}

  get(channelId: string): ForumPost | undefined {
    const row: PostRow | undefined = this.db.prepare(
      `SELECT ${columns} FROM forum_posts p JOIN channels c ON c.id = p.channel_id WHERE p.channel_id = ?`
    ).get(channelId);
    return row ? map(row) : undefined;
  }

  list(forumId: string, query: string, sort: 'latest' | 'newest' | 'oldest', offset: number): ForumPost[] {
    const order = sort === 'latest' ? 'updatedAt DESC' : sort === 'oldest' ? 'p.created_at ASC' : 'p.created_at DESC';
    const rows: PostRow[] = this.db.prepare(
      `SELECT ${columns} FROM forum_posts p JOIN channels c ON c.id = p.channel_id
       WHERE p.forum_id = ? AND c.name LIKE ? ESCAPE '\\'
       ORDER BY p.pinned DESC, ${order}, p.channel_id LIMIT 26 OFFSET ?`
    ).all(forumId, `%${query.replace(/[\\%_]/g, '\\$&')}%`, offset);
    return rows.map(map);
  }

  create(channelId: string, forum: ChannelSummary, authorId: string, title: string, now: number): void {
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO channels (id, server_id, name, type, position, created_at,
        is_private, bot_commands_enabled, inherit_category_permissions, forum_parent_id)
        VALUES (?, ?, ?, 'TEXT', 0, ?, 1, ?, 0, ?)`)
        .run(channelId, forum.serverId, title, now, forum.botCommandsEnabled ? 1 : 0, forum.id);
      this.db.prepare('INSERT INTO forum_posts (channel_id, forum_id, author_id, created_at) VALUES (?, ?, ?, ?)')
        .run(channelId, forum.id, authorId, now);
    })();
  }

  update(input: ForumUpdatePost): void {
    this.db.transaction(() => {
      if (input.title !== undefined) this.db.prepare('UPDATE channels SET name = ? WHERE id = ?').run(input.title, input.channelId);
      if (input.pinned !== undefined) this.db.prepare('UPDATE forum_posts SET pinned = ? WHERE channel_id = ?').run(input.pinned ? 1 : 0, input.channelId);
      if (input.locked !== undefined) this.db.prepare('UPDATE forum_posts SET locked = ? WHERE channel_id = ?').run(input.locked ? 1 : 0, input.channelId);
      if (input.closed !== undefined) this.db.prepare('UPDATE forum_posts SET closed = ? WHERE channel_id = ?').run(input.closed ? 1 : 0, input.channelId);
    })();
  }

  delete(channelId: string): void { this.db.prepare('DELETE FROM channels WHERE id = ?').run(channelId); }

  moveAttachments(ids: string[], userId: string, from: string, to: string): boolean {
    return this.db.transaction(() => {
      for (const id of ids) {
        if (!this.db.prepare(`SELECT id FROM message_attachments
          WHERE id = ? AND user_id = ? AND channel_id = ? AND message_id IS NULL AND evicted = 0`).get(id, userId, from)) {
          return false;
        }
      }
      for (const id of ids) this.db.prepare('UPDATE message_attachments SET channel_id = ? WHERE id = ?').run(to, id);
      return true;
    })();
  }

  restoreAttachments(userId: string, postId: string, forumId: string): void {
    this.db.prepare(`UPDATE message_attachments SET channel_id = ?
      WHERE user_id = ? AND channel_id = ? AND message_id IS NULL`).run(forumId, userId, postId);
  }
}
