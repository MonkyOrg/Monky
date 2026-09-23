import type { VoiceRestrictions } from '../../domain/entities';
import type { IVoiceRestrictionRepository } from '../../domain/repositories';
import type { IDatabaseDriver } from './SqliteWrapper';

export class SqliteVoiceRestrictionRepository implements IVoiceRestrictionRepository {
  constructor(private readonly db: IDatabaseDriver) {}

  public getForUser(userId: string): VoiceRestrictions {
    const row = this.db.prepare(
      `SELECT server_muted, server_deafened FROM user_voice_restrictions WHERE user_id = ?
       UNION ALL
       SELECT server_muted, server_deafened FROM bot_voice_restrictions WHERE bot_id = ?
       LIMIT 1`
    ).get(userId, userId) as { server_muted: number; server_deafened: number } | undefined;
    return {
      serverMuted: row?.server_muted === 1,
      serverDeafened: row?.server_deafened === 1,
    };
  }

  public save(userId: string, restrictions: VoiceRestrictions): void {
    const isBot = !!this.db.prepare('SELECT id FROM bots WHERE id = ?').get(userId);
    const table = isBot ? 'bot_voice_restrictions' : 'user_voice_restrictions';
    const column = isBot ? 'bot_id' : 'user_id';
    this.db.prepare(`
      INSERT INTO ${table} (${column}, server_muted, server_deafened)
      VALUES (?, ?, ?)
      ON CONFLICT(${column}) DO UPDATE SET
        server_muted = excluded.server_muted,
        server_deafened = excluded.server_deafened
    `).run(userId, Number(restrictions.serverMuted), Number(restrictions.serverDeafened));
  }
}
