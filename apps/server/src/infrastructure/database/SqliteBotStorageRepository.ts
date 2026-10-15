import type { BotStorageObjectRecord, IBotStorageRepository } from '../../domain/repositories';
import type { IDatabaseDriver } from './SqliteWrapper';

interface ObjectRow {
  bot_id: string;
  object_key: string;
  filename: string;
  size_bytes: number;
  content_type: string | null;
  updated_at: number;
}

function toRecord(row: ObjectRow): BotStorageObjectRecord {
  return {
    botId: row.bot_id, key: row.object_key, filename: row.filename, sizeBytes: Number(row.size_bytes),
    contentType: row.content_type, updatedAt: Number(row.updated_at),
  };
}

export class SqliteBotStorageRepository implements IBotStorageRepository {
  constructor(private readonly db: IDatabaseDriver) {}

  find(botId: string, key: string): BotStorageObjectRecord | undefined {
    const row: ObjectRow | undefined = this.db.prepare(
      'SELECT * FROM bot_storage_objects WHERE bot_id = ? AND object_key = ?',
    ).get(botId, key);
    return row ? toRecord(row) : undefined;
  }

  list(botId: string, prefix: string, after: string | undefined, limit: number): BotStorageObjectRecord[] {
    const rows: ObjectRow[] = this.db.prepare(`
      SELECT * FROM bot_storage_objects
      WHERE bot_id = ? AND substr(object_key, 1, ?) = ? AND object_key > ?
      ORDER BY object_key LIMIT ?
    `).all(botId, prefix.length, prefix, after ?? '', limit);
    return rows.map(toRecord);
  }

  usage(botId: string): { usedBytes: number; objectCount: number } {
    const row: { used: number | null; total: number } = this.db.prepare(
      'SELECT SUM(size_bytes) AS used, COUNT(*) AS total FROM bot_storage_objects WHERE bot_id = ?',
    ).get(botId);
    return { usedBytes: Number(row.used ?? 0), objectCount: Number(row.total) };
  }

  save(record: BotStorageObjectRecord): void {
    this.db.prepare(`
      INSERT INTO bot_storage_objects (bot_id, object_key, filename, size_bytes, content_type, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(bot_id, object_key) DO UPDATE SET filename = excluded.filename, size_bytes = excluded.size_bytes,
        content_type = excluded.content_type, updated_at = excluded.updated_at
    `).run(record.botId, record.key, record.filename, record.sizeBytes, record.contentType, record.updatedAt);
  }

  delete(botId: string, key: string): void {
    this.db.prepare('DELETE FROM bot_storage_objects WHERE bot_id = ? AND object_key = ?').run(botId, key);
  }

  deleteAll(botId: string): BotStorageObjectRecord[] {
    const rows: ObjectRow[] = this.db.prepare('SELECT * FROM bot_storage_objects WHERE bot_id = ?').all(botId);
    this.db.prepare('DELETE FROM bot_storage_objects WHERE bot_id = ?').run(botId);
    return rows.map(toRecord);
  }

  quota(botId: string): number | undefined {
    const row: { max_bytes: number } | undefined = this.db.prepare(
      'SELECT max_bytes FROM bot_storage_quotas WHERE bot_id = ?',
    ).get(botId);
    return row ? Number(row.max_bytes) : undefined;
  }

  setQuota(botId: string, maxBytes: number): void {
    this.db.prepare(`
      INSERT INTO bot_storage_quotas (bot_id, max_bytes) VALUES (?, ?)
      ON CONFLICT(bot_id) DO UPDATE SET max_bytes = excluded.max_bytes
    `).run(botId, maxBytes);
  }

  botExists(botId: string): boolean {
    return this.db.prepare('SELECT 1 AS found FROM bots WHERE id = ?').get(botId) !== undefined;
  }

  references(): Map<string, Set<string>> {
    const references = new Map<string, Set<string>>();
    for (const { id } of this.db.prepare('SELECT id FROM bots').all() as Array<{ id: string }>) references.set(id, new Set());
    const rows: Array<{ bot_id: string; filename: string }> = this.db.prepare(
      'SELECT bot_id, filename FROM bot_storage_objects',
    ).all();
    for (const row of rows) references.get(row.bot_id)?.add(row.filename);
    return references;
  }

  transaction<T>(operation: () => T): T { return this.db.transaction(operation)(); }
}
