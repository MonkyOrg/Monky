import { botSettingsDefinitionSchema, botServerSettingsSnapshotSchema } from '@monky/shared';
import type { BotSettingsRecord } from '../../domain/entities';
import type { IBotSettingsRepository } from '../../domain/repositories';
import type { IDatabaseDriver } from './SqliteWrapper';

interface SettingsRow {
  botId: string;
  definition: string;
  overrides: string;
  schemaRevision: number;
  revision: number;
  downloadsSound: number;
}

export class SqliteBotSettingsRepository implements IBotSettingsRepository {
  constructor(private db: IDatabaseDriver) {}

  findById(botId: string): BotSettingsRecord | undefined {
    const row: SettingsRow | undefined = this.db.prepare(`
      SELECT b.id AS botId, COALESCE(s.definition_json, '{}') AS definition,
        COALESCE(s.server_overrides_json, '{}') AS overrides,
        COALESCE(s.schema_revision, 0) AS schemaRevision, COALESCE(s.revision, 0) AS revision,
        COALESCE(s.downloads_sound, 0) AS downloadsSound
      FROM bots b LEFT JOIN bot_settings s ON s.bot_id = b.id WHERE b.id = ?
    `).get(botId);
    if (!row) return undefined;
    const stored = botServerSettingsSnapshotSchema.parse({
      schemaRevision: row.schemaRevision, revision: row.revision, values: JSON.parse(row.overrides),
    });
    if (row.downloadsSound !== 0 && row.downloadsSound !== 1) throw new Error('Invalid stored bot capability.');
    return {
      botId: row.botId, definition: botSettingsDefinitionSchema.parse(JSON.parse(row.definition)),
      serverOverrides: stored.values, schemaRevision: stored.schemaRevision, revision: stored.revision,
      downloadsSound: row.downloadsSound === 1,
    };
  }

  save(record: BotSettingsRecord): void {
    this.db.prepare(`
      INSERT INTO bot_settings (bot_id, definition_json, server_overrides_json, schema_revision, revision, downloads_sound)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(bot_id) DO UPDATE SET definition_json = excluded.definition_json,
        server_overrides_json = excluded.server_overrides_json, schema_revision = excluded.schema_revision,
        revision = excluded.revision, downloads_sound = excluded.downloads_sound
    `).run(record.botId, JSON.stringify(record.definition), JSON.stringify(record.serverOverrides),
      record.schemaRevision, record.revision, record.downloadsSound ? 1 : 0);
  }

  transaction<T>(operation: () => T): T {
    return this.db.transaction(operation)();
  }
}
