import { serverAuditEntrySchema, type ServerAuditEntry } from '@monky/shared';
import type { IServerAuditRepository, ServerAuditQuery } from '../../domain/repositories';
import { Logger } from '../logger/Logger';
import type { IDatabaseDriver } from './SqliteWrapper';

interface AuditRow {
  id: number;
  entryJson: string;
}

export class SqliteServerAuditRepository implements IServerAuditRepository {
  constructor(private readonly db: IDatabaseDriver) {}

  append(entry: Omit<ServerAuditEntry, 'id'>, category: string, searchText: string): void {
    this.db.prepare(`
      INSERT INTO server_audit_log (created_at, action, category, entry_json, search_text)
      VALUES (?, ?, ?, ?, ?)
    `).run(entry.createdAt, entry.action, category, JSON.stringify(entry), searchText);
  }

  list(query: ServerAuditQuery): ServerAuditEntry[] {
    const before = query.before ?? null;
    const after = query.after ?? null;
    const category = query.category ?? null;
    const search = query.search ? `%${query.search.replace(/[\\%_]/g, (match) => `\\${match}`)}%` : null;
    const rows: AuditRow[] = this.db.prepare(`
      SELECT id, entry_json AS entryJson FROM server_audit_log
      WHERE created_at >= ?
        AND (? IS NULL OR id < ?)
        AND (? IS NULL OR id > ?)
        AND (? IS NULL OR category = ?)
        AND (? IS NULL OR search_text LIKE ? ESCAPE '\\')
      ORDER BY id DESC
      LIMIT ?
    `).all(query.createdSince, before, before, after, after, category, category, search, search, query.limit);
    return rows.flatMap((row) => {
      try {
        const parsed = serverAuditEntrySchema.safeParse({ ...JSON.parse(row.entryJson), id: row.id });
        if (parsed.success) return [parsed.data];
      } catch {
        // Reported below like any other unreadable row.
      }
      Logger.warn('DATABASE', `Skipping unreadable audit entry ${row.id}.`);
      return [];
    });
  }

  prune(createdBefore: number, activityActions: readonly string[], keepActivity: number, keepOther: number): void {
    const actions = activityActions.map(() => '?').join(', ') || 'NULL';
    const keepNewest = (filter: string, keep: number) => this.db.prepare(`
      DELETE FROM server_audit_log
      WHERE action ${filter} (${actions})
        AND id <= (SELECT id FROM server_audit_log WHERE action ${filter} (${actions}) ORDER BY id DESC LIMIT 1 OFFSET ?)
    `).run(...activityActions, ...activityActions, keep);
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM server_audit_log WHERE created_at < ?').run(createdBefore);
      keepNewest('IN', keepActivity);
      keepNewest('NOT IN', keepOther);
    })();
  }
}
