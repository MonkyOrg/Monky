import type { VoiceRestrictions } from '../../domain/entities';
import type { IVoiceRestrictionRepository } from '../../domain/repositories';
import type { IDatabaseDriver } from './SqliteWrapper';

export class SqliteVoiceRestrictionRepository implements IVoiceRestrictionRepository {
  constructor(private readonly db: IDatabaseDriver) {}

  public getForUser(userId: string): VoiceRestrictions {
    const row = this.db.prepare(
      'SELECT server_muted, server_deafened FROM user_voice_restrictions WHERE user_id = ?'
    ).get(userId) as { server_muted: number; server_deafened: number } | undefined;
    return {
      serverMuted: row?.server_muted === 1,
      serverDeafened: row?.server_deafened === 1,
    };
  }

  public save(userId: string, restrictions: VoiceRestrictions): void {
    this.db.prepare(`
      INSERT INTO user_voice_restrictions (user_id, server_muted, server_deafened)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        server_muted = excluded.server_muted,
        server_deafened = excluded.server_deafened
    `).run(userId, Number(restrictions.serverMuted), Number(restrictions.serverDeafened));
  }
}
