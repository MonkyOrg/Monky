import { botSelectorSchema, type BotSelector } from '@monky/shared';
import type { IBotSelectorRepository } from '../../domain/repositories';
import type { IDatabaseDriver } from './SqliteWrapper';

interface SelectorRow { snapshot: string }

export class SqliteBotSelectorRepository implements IBotSelectorRepository {
  constructor(private db: IDatabaseDriver) {}

  findById(id: string): BotSelector | undefined {
    const row: SelectorRow | undefined = this.db.prepare('SELECT snapshot FROM bot_selectors WHERE id = ?').get(id);
    return row ? this.decode(row) : undefined;
  }

  list(botId?: string, channelId?: string): BotSelector[] {
    const rows: SelectorRow[] = botId
      ? this.db.prepare('SELECT snapshot FROM bot_selectors WHERE bot_id = ? ORDER BY rowid').all(botId)
      : this.db.prepare('SELECT snapshot FROM bot_selectors WHERE channel_id = ? ORDER BY rowid').all(channelId);
    return rows.map((row) => this.decode(row));
  }

  listExpired(now: number): BotSelector[] {
    const rows: SelectorRow[] = this.db.prepare(
      'SELECT snapshot FROM bot_selectors WHERE closed_at IS NULL AND expires_at <= ?'
    ).all(now);
    return rows.map((row) => this.decode(row));
  }

  countOpen(botId: string): number {
    const result: { count: number } = this.db.prepare(
      'SELECT count(*) AS count FROM bot_selectors WHERE bot_id = ? AND closed_at IS NULL'
    ).get(botId);
    return result.count;
  }

  create(selector: BotSelector): void {
    this.db.prepare(
      'INSERT INTO bot_selectors (id, bot_id, channel_id, snapshot, closed_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(selector.id, selector.botId, selector.channelId, JSON.stringify(selector), selector.closedAt, selector.expiresAt ?? null);
  }

  save(selector: BotSelector): void {
    this.db.prepare('UPDATE bot_selectors SET snapshot = ?, closed_at = ?, expires_at = ? WHERE id = ?')
      .run(JSON.stringify(selector), selector.closedAt, selector.expiresAt ?? null, selector.id);
  }

  transaction<T>(operation: () => T): T {
    return this.db.transaction(operation)();
  }

  private decode(row: SelectorRow): BotSelector {
    return botSelectorSchema.parse(JSON.parse(row.snapshot));
  }
}
