import { IDENTITY_BAN_HISTORY_PAGE_SIZE, type IdentityBanHistoryEntry, type IdentityBanHistoryPage, type IdentityBanHistoryRequest, type IdentityBanModerator, type IdentityBanSummary } from '@monky/shared';
import type { IdentityAccessRepository, StoredIdentityBan } from '../../domain/identityAccess';
import type { IDatabaseDriver } from './SqliteWrapper';

interface BanRow extends Omit<IdentityBanSummary, 'showReason'> { showReason: number }
const BAN_COLUMNS = 'public_key AS publicKey, nickname, reason, show_reason AS showReason, created_at AS createdAt, expires_at AS expiresAt';
const fromRow = (row: BanRow): IdentityBanSummary => ({ ...row, showReason: row.showReason === 1 });
interface HistoryRow extends BanRow {
  id: number;
  createdById: string | null;
  createdByNickname: string | null;
  endedAt: number | null;
  endedById: string | null;
  endedByNickname: string | null;
  resolution: 'revoked' | 'replaced' | null;
}

export class SqliteIdentityAccessRepository implements IdentityAccessRepository {
  constructor(private readonly db: IDatabaseDriver) {}

  ban(publicKey: string): StoredIdentityBan | undefined {
    const row = this.db.prepare(`SELECT ${BAN_COLUMNS}, history_id AS historyId FROM identity_bans WHERE public_key = ?`)
      .get(publicKey) as (BanRow & { historyId: number }) | undefined;
    return row && { ...fromRow(row), historyId: row.historyId };
  }

  bans(): IdentityBanSummary[] {
    return (this.db.prepare(`SELECT ${BAN_COLUMNS} FROM identity_bans ORDER BY created_at DESC`).all() as BanRow[]).map(fromRow);
  }

  history(request: IdentityBanHistoryRequest, now = Date.now()): IdentityBanHistoryPage {
    const active = request.scope === 'active'
      ? 'AND resolution IS NULL AND (expires_at IS NULL OR expires_at > ?)' : '';
    const params = [request.beforeId ?? Number.MAX_SAFE_INTEGER, ...(request.scope === 'active' ? [now] : []),
      IDENTITY_BAN_HISTORY_PAGE_SIZE + 1];
    const rows = this.db.prepare(`SELECT ${BAN_COLUMNS}, id, created_by_id AS createdById,
      created_by_nickname AS createdByNickname, ended_at AS endedAt, ended_by_id AS endedById,
      ended_by_nickname AS endedByNickname, resolution FROM identity_ban_history
      WHERE id < ? ${active} ORDER BY id DESC LIMIT ?`).all(...params) as HistoryRow[];
    const entries = rows.slice(0, IDENTITY_BAN_HISTORY_PAGE_SIZE).map((row): IdentityBanHistoryEntry => ({
      id: row.id, publicKey: row.publicKey, nickname: row.nickname, reason: row.reason, showReason: row.showReason === 1,
      createdAt: row.createdAt, expiresAt: row.expiresAt,
      createdBy: row.createdById !== null && row.createdByNickname !== null
        ? { id: row.createdById, nickname: row.createdByNickname } : null,
      endedAt: row.endedAt,
      endedBy: row.endedById !== null && row.endedByNickname !== null
        ? { id: row.endedById, nickname: row.endedByNickname } : null,
      status: row.resolution ?? (row.expiresAt !== null && row.expiresAt <= now ? 'expired' : 'active'),
    }));
    return { entries, nextCursor: rows.length > IDENTITY_BAN_HISTORY_PAGE_SIZE ? entries.at(-1)!.id : null };
  }

  saveBan(ban: IdentityBanSummary, moderator?: IdentityBanModerator): void {
    this.db.transaction(() => {
      this.db.prepare(`UPDATE identity_ban_history SET resolution = 'replaced', ended_at = ?,
        ended_by_id = ?, ended_by_nickname = ? WHERE id = (SELECT history_id FROM identity_bans WHERE public_key = ?)
        AND resolution IS NULL AND (expires_at IS NULL OR expires_at > ?)`)
        .run(ban.createdAt, moderator?.id ?? null, moderator?.nickname ?? null, ban.publicKey, ban.createdAt);
      this.db.prepare(`INSERT INTO identity_ban_history
        (public_key, nickname, reason, show_reason, created_at, expires_at, created_by_id, created_by_nickname)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(ban.publicKey, ban.nickname, ban.reason, Number(ban.showReason), ban.createdAt, ban.expiresAt,
          moderator?.id ?? null, moderator?.nickname ?? null);
      const { id } = this.db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number };
      this.db.prepare(`INSERT OR REPLACE INTO identity_bans
        (public_key, nickname, reason, show_reason, created_at, expires_at, history_id) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(ban.publicKey, ban.nickname, ban.reason, Number(ban.showReason), ban.createdAt, ban.expiresAt, id);
    })();
  }

  unban(publicKey: string, moderator?: IdentityBanModerator, expectedId?: number, now = Date.now()): boolean {
    return this.db.transaction(() => {
      const ban = this.ban(publicKey);
      if (!ban || (expectedId !== undefined && (expectedId !== ban.historyId
        || (ban.expiresAt !== null && ban.expiresAt <= now)))) return false;
      this.db.prepare(`UPDATE identity_ban_history SET resolution = 'revoked', ended_at = ?,
        ended_by_id = ?, ended_by_nickname = ? WHERE id = ? AND resolution IS NULL
        AND (expires_at IS NULL OR expires_at > ?)`)
        .run(now, moderator?.id ?? null, moderator?.nickname ?? null, ban.historyId, now);
      this.db.prepare('DELETE FROM identity_bans WHERE public_key = ?').run(publicKey);
      return true;
    })();
  }

  registerGuest(userId: string): void {
    this.db.prepare('INSERT INTO guest_memberships (user_id, active) VALUES (?, 1) ON CONFLICT(user_id) DO UPDATE SET active = 1').run(userId);
  }

  retireGuest(userId: string): boolean {
    const row = this.db.prepare('SELECT active FROM guest_memberships WHERE user_id = ?').get(userId) as { active: number } | undefined;
    if (row?.active !== 1) return false;
    this.retireActiveGuests(userId);
    return true;
  }

  private retireActiveGuests(userId?: string): void {
    const guests = `SELECT user_id FROM guest_memberships WHERE active = 1${userId ? ' AND user_id = ?' : ''}`;
    const parameters = userId ? [userId] : [];
    this.db.transaction(() => {
      for (const table of ['user_roles', 'mentions', 'channel_permission_overwrites', 'category_permission_overwrites', 'user_voice_restrictions']) {
        this.db.prepare(`DELETE FROM ${table} WHERE user_id IN (${guests})`).run(...parameters);
      }
      this.db.prepare(`UPDATE guest_memberships SET active = 0 WHERE user_id IN (${guests})`).run(...parameters);
    })();
  }

  retireAllGuests(): void {
    this.retireActiveGuests();
  }
}
