import {
  botFormValuesSchema,
  liveActionRecordSchema,
  nativeLiveFormRecordSchema,
  nativeLiveFormResponseSchema,
  serverEventSchema,
  type BotFormValues,
  type LiveActionRecord,
  type NativeLiveFormRecord,
  type NativeLiveFormResponse,
  type ServerEvent,
} from '@monky/shared';
import type { IDatabaseDriver } from './SqliteWrapper';
import { SqliteResourceAudienceRepository } from './SqliteResourceAudienceRepository';

interface SnapshotRow { snapshot: string }
export class SqliteCommunityRepository {
  private readonly audiences: SqliteResourceAudienceRepository;
  constructor(private readonly db: IDatabaseDriver) {
    this.audiences = new SqliteResourceAudienceRepository(db);
  }

  settings(): { eventsEnabled: boolean; bannerPath: string | null; disabledAt: number | null } {
    const row: { events_enabled: number; banner_path: string | null; disabled_at: number | null } =
      this.db.prepare('SELECT events_enabled, banner_path, disabled_at FROM server_community_settings WHERE id = 1').get();
    return {
      eventsEnabled: row.events_enabled === 1,
      bannerPath: row.banner_path,
      disabledAt: row.disabled_at,
    };
  }

  setSettings(eventsEnabled: boolean, bannerPath: string | null, disabledAt: number | null): void {
    this.db.prepare(`UPDATE server_community_settings
      SET events_enabled = ?, banner_path = ?, disabled_at = ? WHERE id = 1`)
      .run(eventsEnabled ? 1 : 0, bannerPath, disabledAt);
  }

  event(id: string): ServerEvent | undefined {
    const row: SnapshotRow | undefined = this.db.prepare('SELECT snapshot FROM server_events WHERE id = ?').get(id);
    if (!row) return undefined;
    const event = serverEventSchema.parse(JSON.parse(row.snapshot));
    return { ...event, audience: this.audiences.load('event', event.id) };
  }

  events(includeEnded = false): ServerEvent[] {
    const rows: SnapshotRow[] = this.db.prepare(
      `SELECT snapshot FROM server_events ${includeEnded ? '' : "WHERE status IN ('scheduled', 'active')"}
       ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'scheduled' THEN 1 ELSE 2 END,
         CASE WHEN status IN ('active', 'scheduled') THEN starts_at ELSE -starts_at END LIMIT 200`
    ).all();
    return rows.map((row) => {
      const event = serverEventSchema.parse(JSON.parse(row.snapshot));
      return { ...event, audience: this.audiences.load('event', event.id) };
    });
  }

  saveEvent(event: ServerEvent): void {
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO server_events (id, snapshot, status, starts_at, ends_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET snapshot = excluded.snapshot, status = excluded.status,
        starts_at = excluded.starts_at, ends_at = excluded.ends_at`)
        .run(event.id, JSON.stringify(event), event.status, event.startsAt, event.endsAt);
      this.audiences.replace('event', event.id, event.audience);
    })();
  }

  deleteEvent(id: string): void {
    this.db.transaction(() => {
      this.audiences.remove('event', id);
      this.db.prepare('DELETE FROM server_events WHERE id = ?').run(id);
    })();
  }

  interest(id: string, userId: string): { interested: boolean; interestedCount: number } {
    const row: { count: number; mine: number } = this.db.prepare(
      'SELECT COUNT(*) AS count, COALESCE(MAX(user_id = ?), 0) AS mine FROM server_event_interest WHERE event_id = ?'
    ).get(userId, id);
    return { interested: row.mine === 1, interestedCount: row.count };
  }

  setInterest(id: string, userId: string, interested: boolean): void {
    if (interested) this.db.prepare('INSERT OR IGNORE INTO server_event_interest (event_id, user_id) VALUES (?, ?)').run(id, userId);
    else this.db.prepare('DELETE FROM server_event_interest WHERE event_id = ? AND user_id = ?').run(id, userId);
  }

  interestedMembers(id: string, cursor: string | undefined, limit: number): Array<{ id: string; nickname: string; avatarPath: string | null }> {
    return this.db.prepare(`SELECT u.id, u.nickname, u.avatar_path AS avatarPath
      FROM server_event_interest i JOIN users u ON u.id = i.user_id
      WHERE i.event_id = ? AND u.id > ? ORDER BY u.id LIMIT ?`).all(id, cursor ?? '', limit);
  }

  liveActions(): LiveActionRecord[] {
    const rows: SnapshotRow[] = this.db.prepare('SELECT snapshot FROM bot_live_actions ORDER BY rowid').all();
    return rows.map((row) => {
      const action = liveActionRecordSchema.parse(JSON.parse(row.snapshot));
      return { ...action, audience: this.audiences.load('live_action', action.id) };
    });
  }

  liveAction(id: string): LiveActionRecord | undefined {
    const row: SnapshotRow | undefined = this.db.prepare('SELECT snapshot FROM bot_live_actions WHERE id = ?').get(id);
    if (!row) return undefined;
    const action = liveActionRecordSchema.parse(JSON.parse(row.snapshot));
    return { ...action, audience: this.audiences.load('live_action', action.id) };
  }

  saveLiveAction(action: LiveActionRecord): void {
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO bot_live_actions (id, bot_id, channel_id, expires_at, snapshot) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET expires_at = excluded.expires_at, snapshot = excluded.snapshot`)
        .run(action.id, action.botId, action.channelId, action.expiresAt, JSON.stringify(action));
      this.audiences.replace('live_action', action.id, action.audience);
    })();
  }

  deleteLiveAction(id: string): void {
    this.db.transaction(() => {
      this.audiences.remove('live_action', id);
      this.db.prepare('DELETE FROM bot_live_actions WHERE id = ?').run(id);
    })();
  }

  activeNativeForms(now: number): NativeLiveFormRecord[] {
    const rows: SnapshotRow[] = this.db.prepare(`SELECT snapshot FROM native_live_forms
      WHERE closed_at IS NULL AND expires_at > ? ORDER BY rowid`).all(now);
    return rows.map(row => {
      const form = nativeLiveFormRecordSchema.parse(JSON.parse(row.snapshot));
      return { ...form, audience: this.audiences.load('native_form', form.id) };
    });
  }

  nativeForm(id: string): NativeLiveFormRecord | undefined {
    const row: SnapshotRow | undefined = this.db.prepare(
      'SELECT snapshot FROM native_live_forms WHERE id = ?'
    ).get(id);
    if (!row) return undefined;
    const form = nativeLiveFormRecordSchema.parse(JSON.parse(row.snapshot));
    return { ...form, audience: this.audiences.load('native_form', form.id) };
  }

  saveNativeForm(form: NativeLiveFormRecord): void {
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO native_live_forms
        (id, channel_id, creator_user_id, expires_at, closed_at, snapshot)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET expires_at = excluded.expires_at,
          closed_at = excluded.closed_at, snapshot = excluded.snapshot`)
        .run(form.id, form.channelId, form.creatorUserId, form.expiresAt, form.closedAt, JSON.stringify(form));
      this.audiences.replace('native_form', form.id, form.audience);
    })();
  }

  closeNativeForm(id: string, closedAt: number): NativeLiveFormRecord | undefined {
    return this.db.transaction(() => {
      const form = this.nativeForm(id);
      if (!form || form.closedAt !== null) return form;
      const updated = { ...form, closedAt, revision: form.revision + 1 };
      this.saveNativeForm(updated);
      return updated;
    })();
  }

  closeExpiredNativeForms(now: number): NativeLiveFormRecord[] {
    return this.db.transaction(() => {
      const rows: Array<{ id: string }> = this.db.prepare(`SELECT id FROM native_live_forms
        WHERE closed_at IS NULL AND expires_at <= ?`).all(now);
      return rows.map(row => this.closeNativeForm(row.id, this.nativeForm(row.id)?.expiresAt ?? now))
        .filter((form): form is NativeLiveFormRecord => !!form);
    })();
  }

  deleteClosedNativeForms(closedBefore: number): number {
    return this.db.prepare(`DELETE FROM native_live_forms
      WHERE closed_at IS NOT NULL AND closed_at <= ?`).run(closedBefore).changes;
  }

  saveNativeFormResponse(
    id: string,
    userId: string,
    values: BotFormValues,
    now: number,
  ): NativeLiveFormResponse {
    const parsed = botFormValuesSchema.parse(values);
    this.db.prepare(`INSERT INTO native_live_form_responses
      (form_id, user_id, values_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(form_id, user_id) DO UPDATE SET
        values_json = excluded.values_json, updated_at = excluded.updated_at`)
      .run(id, userId, JSON.stringify(parsed), now, now);
    return this.nativeFormResponse(id, userId)!;
  }

  nativeFormResponse(id: string, userId: string): NativeLiveFormResponse | undefined {
    const row: { valuesJson: string; createdAt: number; updatedAt: number } | undefined =
      this.db.prepare(`SELECT values_json AS valuesJson, created_at AS createdAt, updated_at AS updatedAt
        FROM native_live_form_responses WHERE form_id = ? AND user_id = ?`).get(id, userId);
    return row ? nativeLiveFormResponseSchema.parse({
      values: JSON.parse(row.valuesJson),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }) : undefined;
  }

  nativeFormResponseCount(id: string): number {
    const row: { count: number } = this.db.prepare(
      'SELECT COUNT(*) AS count FROM native_live_form_responses WHERE form_id = ?'
    ).get(id);
    return Number(row.count);
  }

  nativeFormResponses(
    id: string,
    cursor: string | undefined,
    limit: number,
  ): Array<{
    userId: string;
    nickname: string;
    avatarPath: string | null;
    response: NativeLiveFormResponse;
  }> {
    const rows: Array<{
      userId: string;
      nickname: string;
      avatarPath: string | null;
      valuesJson: string;
      createdAt: number;
      updatedAt: number;
    }> = this.db.prepare(`SELECT r.user_id AS userId, u.nickname, u.avatar_path AS avatarPath,
      r.values_json AS valuesJson, r.created_at AS createdAt, r.updated_at AS updatedAt
      FROM native_live_form_responses r
      JOIN users u ON u.id = r.user_id
      WHERE r.form_id = ? AND r.user_id > ?
      ORDER BY r.user_id LIMIT ?`).all(id, cursor ?? '', limit);
    return rows.map(row => ({
      userId: row.userId,
      nickname: row.nickname,
      avatarPath: row.avatarPath,
      response: nativeLiveFormResponseSchema.parse({
        values: JSON.parse(row.valuesJson),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }),
    }));
  }

  transaction<T>(action: () => T): T { return this.db.transaction(action)(); }
}
