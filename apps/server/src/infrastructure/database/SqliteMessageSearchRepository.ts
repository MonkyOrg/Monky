import { messageSearchTerms, type MessageSearchFilters } from '@monky/shared';
import type { IDatabaseDriver } from './SqliteWrapper';

export interface SearchPosition { createdAt: number; id: string }
export interface MessageSearchRow extends SearchPosition { channelId: string }

export class SqliteMessageSearchRepository {
  constructor(private readonly db: IDatabaseDriver) {}

  public getRevision(): number {
    return (this.db.prepare('SELECT revision FROM message_search_state WHERE id = 1').get() as { revision: number }).revision;
  }

  public search(
    filters: MessageSearchFilters,
    channels: string[],
    userId: string,
    canManageServer: boolean,
    limit: number,
    position?: SearchPosition,
  ): MessageSearchRow[] {
    const conditions = this.conditions(filters, channels, userId, canManageServer);
    if (!conditions) return [];
    const { where, parameters } = conditions;
    const direction = filters.sort === 'oldest' ? 'ASC' : 'DESC';
    if (position) {
      where.push(`(m.created_at, m.id) ${filters.sort === 'oldest' ? '>' : '<'} (?, ?)`);
      parameters.push(position.createdAt, position.id);
    }
    parameters.push(limit);
    return this.db.prepare(`SELECT m.id, m.channel_id AS channelId, m.created_at AS createdAt
      FROM messages m JOIN channels c ON c.id = m.channel_id
      WHERE ${where.join(' AND ')} ORDER BY m.created_at ${direction}, m.id ${direction} LIMIT ?`)
      .all(...parameters) as MessageSearchRow[];
  }

  public count(filters: MessageSearchFilters, channels: string[], userId: string, canManageServer: boolean): number {
    const conditions = this.conditions(filters, channels, userId, canManageServer);
    if (!conditions) return 0;
    return (this.db.prepare(`SELECT COUNT(*) AS total FROM messages m JOIN channels c ON c.id = m.channel_id
      WHERE ${conditions.where.join(' AND ')}`).get(...conditions.parameters) as { total: number }).total;
  }

  private conditions(
    filters: MessageSearchFilters,
    channels: string[],
    userId: string,
    canManageServer: boolean,
  ): { where: string[]; parameters: (string | number)[] } | null {
    if (!channels.length) return null;
    const where = ["m.deleted_at IS NULL", "m.is_system = 0", "c.type IN ('TEXT', 'VOICE')",
      'm.channel_id IN (SELECT value FROM json_each(?))'];
    const parameters: (string | number)[] = [JSON.stringify(channels)];
    where.push(`NOT EXISTS (
      SELECT 1 FROM native_polls np
      JOIN community_resource_audiences audience
        ON audience.resource_type = 'poll' AND audience.resource_id = np.id
      WHERE np.message_id = m.id
        AND np.creator_user_id <> ?
        AND ? = 0
        AND NOT EXISTS (
          SELECT 1 FROM community_resource_audience_users selected_user
          WHERE selected_user.resource_type = 'poll'
            AND selected_user.resource_id = np.id
            AND selected_user.user_id = ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM community_resource_audience_roles selected_role
          JOIN user_roles membership ON membership.role_id = selected_role.role_id
          WHERE selected_role.resource_type = 'poll'
            AND selected_role.resource_id = np.id
            AND membership.user_id = ?
        )
    )`);
    parameters.push(userId, canManageServer ? 1 : 0, userId, userId);
    const tokens = messageSearchTerms(filters.query);
    if (filters.query && !tokens.length) return null;
    if (tokens.length) {
      where.push('m.rowid IN (SELECT docid FROM message_search_fts WHERE message_search_fts MATCH ?)');
      parameters.push(tokens.map(token => `"${token}*"`).join(' AND '));
    }
    if (filters.authorIds.length) {
      where.push(`((m.author_bot_id IS NULL AND m.user_id IN (SELECT value FROM json_each(?)))
        OR m.author_bot_id IN (SELECT value FROM json_each(?)))`);
      parameters.push(JSON.stringify(filters.authorIds), JSON.stringify(filters.authorIds));
    }
    if (filters.authorType) where.push(`m.author_bot_id IS ${filters.authorType === 'bot' ? 'NOT ' : ''}NULL`);
    if (filters.mentionsUserIds.length) {
      where.push(`EXISTS (SELECT 1 FROM message_search_mentions mm WHERE mm.message_id = m.id
        AND mm.user_id IN (SELECT value FROM json_each(?)))`);
      parameters.push(JSON.stringify(filters.mentionsUserIds));
    }
    if (filters.contains.length) {
      const clauses: string[] = [];
      for (const kind of filters.contains) {
        if (kind === 'link') {
          clauses.push("(instr(lower(m.content), 'https://') > 0 OR instr(lower(m.content), 'http://') > 0)");
        } else {
          clauses.push(`EXISTS (SELECT 1 FROM message_attachments a WHERE a.message_id = m.id
            AND ${kind === 'audio' ? "a.mime_type LIKE 'audio/%'" : 'a.kind = ?'})`);
          if (kind !== 'audio') parameters.push(kind);
        }
      }
      where.push(`(${clauses.join(' OR ')})`);
    }
    if (filters.before !== undefined) { where.push('m.created_at < ?'); parameters.push(filters.before); }
    if (filters.after !== undefined) { where.push('m.created_at > ?'); parameters.push(filters.after); }
    if (filters.on) {
      const start = Date.parse(`${filters.on}T00:00:00.000Z`);
      where.push('m.created_at >= ? AND m.created_at < ?');
      parameters.push(start, start + 86400000);
    }
    return { where, parameters };
  }
}
