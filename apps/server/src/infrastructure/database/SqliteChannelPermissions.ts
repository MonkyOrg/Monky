import { channelPermissionTargetKey, type ChannelPermissionOverwrite } from '@monky/shared';
import type { IDatabaseDriver } from './SqliteWrapper';

export class SqliteChannelPermissions {
  constructor(private readonly db: IDatabaseDriver, private readonly kind: 'channel' | 'category') {}

  read(ids: string[]): Map<string, ChannelPermissionOverwrite[]> {
    const result = new Map<string, ChannelPermissionOverwrite[]>();
    if (!ids.length) return result;
    const rows = this.db.prepare(`SELECT ${this.kind}_id AS id, role_id AS roleId, user_id AS userId,
      allow_bits AS allow, deny_bits AS deny FROM ${this.kind}_permission_overwrites
      WHERE ${this.kind}_id IN (SELECT value FROM json_each(?)) ORDER BY target_id`)
      .all(JSON.stringify(ids)) as Array<{ id: string; roleId: string | null; userId: string | null; allow: number; deny: number }>;
    for (const { id, roleId, userId, allow, deny } of rows) {
      const entries = result.get(id) ?? [];
      entries.push(userId !== null ? { userId, allow, deny } : { roleId, allow, deny });
      result.set(id, entries);
    }
    return result;
  }

  replace(id: string, overwrites: readonly ChannelPermissionOverwrite[]): void {
    this.db.prepare(`DELETE FROM ${this.kind}_permission_overwrites WHERE ${this.kind}_id = ?`).run(id);
    const insert = this.db.prepare(`INSERT INTO ${this.kind}_permission_overwrites
      (${this.kind}_id, target_id, role_id, user_id, allow_bits, deny_bits) VALUES (?, ?, ?, ?, ?, ?)`);
    for (const overwrite of overwrites) {
      insert.run(id, channelPermissionTargetKey(overwrite), overwrite.roleId ?? null, overwrite.userId ?? null, overwrite.allow, overwrite.deny);
    }
  }
}
