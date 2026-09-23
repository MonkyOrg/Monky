import { botPermissionsSchema, unreviewedBotPermissions, type BotPermissions } from '@monky/shared';
import type { IBotPermissionRepository } from '../../domain/repositories';
import type { IDatabaseDriver } from './SqliteWrapper';

export class SqliteBotPermissionRepository implements IBotPermissionRepository {
  constructor(private readonly db: IDatabaseDriver) {}

  findById(botId: string): BotPermissions | undefined {
    const row: { permissions: string | null } | undefined = this.db.prepare(`
      SELECT p.permissions_json AS permissions FROM bots b
      LEFT JOIN bot_permissions p ON p.bot_id = b.id WHERE b.id = ?
    `).get(botId);
    if (!row) return undefined;
    return row.permissions === null ? unreviewedBotPermissions() : botPermissionsSchema.parse(JSON.parse(row.permissions));
  }

  save(botId: string, permissions: BotPermissions): void {
    const state = botPermissionsSchema.parse(permissions);
    this.db.prepare(`
      INSERT INTO bot_permissions (bot_id, permissions_json) VALUES (?, ?)
      ON CONFLICT(bot_id) DO UPDATE SET permissions_json = excluded.permissions_json
    `).run(botId, JSON.stringify(state));
  }

  transaction<T>(operation: () => T): T { return this.db.transaction(operation)(); }
}
