import { ChannelCategory, channelOverwrites, channelPrivacy, withChannelPrivacy } from '@monky/shared';
import { ICategoryRepository } from '../../domain/repositories';
import { IDatabaseDriver } from './SqliteWrapper';
import { SqliteChannelPermissions } from './SqliteChannelPermissions';

type CategoryRow = Omit<ChannelCategory, 'isPrivate' | 'allowedRoleIds'> & { isPrivate: number };
const COLUMNS = 'id, server_id AS serverId, name, position, created_at AS createdAt, is_private AS isPrivate';

export class SqliteCategoryRepository implements ICategoryRepository {
  private readonly permissions: SqliteChannelPermissions;
  constructor(private db: IDatabaseDriver) {
    this.permissions = new SqliteChannelPermissions(db, 'category');
  }

  /** Synchronous hydration keeps each channel and its inherited ACL in one snapshot. */
  readByServerId(serverId: string): ChannelCategory[] {
    const rows = this.db.prepare(`SELECT ${COLUMNS} FROM channel_categories WHERE server_id = ? ORDER BY position, created_at, id`)
      .all(serverId) as CategoryRow[];
    const roles = this.db.prepare(`SELECT r.category_id AS categoryId, r.role_id AS roleId
      FROM category_allowed_roles r JOIN channel_categories c ON c.id = r.category_id WHERE c.server_id = ?`)
      .all(serverId) as { categoryId: string; roleId: string }[];
    const byCategory = new Map<string, string[]>();
    for (const role of roles) byCategory.set(role.categoryId, [...(byCategory.get(role.categoryId) ?? []), role.roleId]);
    const permissions = this.permissions.read(rows.map(row => row.id));
    return rows.map((row) => ({ ...row, isPrivate: row.isPrivate === 1, allowedRoleIds: byCategory.get(row.id) ?? [],
      permissionOverwrites: permissions.get(row.id) ?? [] }));
  }

  async listByServerId(serverId: string): Promise<ChannelCategory[]> { return this.readByServerId(serverId); }

  async findById(id: string): Promise<ChannelCategory | null> {
    const row = this.db.prepare('SELECT server_id AS serverId FROM channel_categories WHERE id = ?')
      .get(id) as { serverId: string } | undefined;
    return row ? this.readByServerId(row.serverId).find((category) => category.id === id) ?? null : null;
  }

  async create(category: ChannelCategory): Promise<void> {
    this.db.transaction(() => {
      if (category.permissionOverwrites) category = { ...category, ...channelPrivacy(category.permissionOverwrites) };
      this.db.prepare('INSERT INTO channel_categories (id, server_id, name, position, created_at, is_private) VALUES (?, ?, ?, ?, ?, ?)')
        .run(category.id, category.serverId, category.name, category.position, category.createdAt, category.isPrivate ? 1 : 0);
      this.replaceRoles(category.id, category.isPrivate ? category.allowedRoleIds : []);
      this.permissions.replace(category.id, channelOverwrites(category));
    })();
  }

  async update(id: string, updates: Partial<Pick<ChannelCategory, 'name' | 'isPrivate' | 'allowedRoleIds' | 'permissionOverwrites'>>): Promise<void> {
    this.db.transaction(() => {
      if (updates.permissionOverwrites !== undefined) {
        const stored = this.db.prepare('SELECT is_private AS isPrivate FROM channel_categories WHERE id = ?').get(id) as { isPrivate: number } | undefined;
        const privacy = channelPrivacy(updates.permissionOverwrites, {
          isPrivate: stored?.isPrivate === 1, allowedRoleIds: [],
          permissionOverwrites: this.permissions.read([id]).get(id) ?? [],
        });
        this.permissions.replace(id, updates.permissionOverwrites);
        updates = { ...updates, ...privacy, isPrivate: updates.isPrivate ?? privacy.isPrivate };
      } else if (updates.isPrivate !== undefined || updates.allowedRoleIds !== undefined) {
        const stored = this.db.prepare('SELECT is_private AS isPrivate FROM channel_categories WHERE id = ?').get(id) as { isPrivate: number } | undefined;
        if (!stored) return;
        const roles = this.db.prepare('SELECT role_id AS roleId FROM category_allowed_roles WHERE category_id = ?').all(id) as { roleId: string }[];
        this.permissions.replace(id, withChannelPrivacy(this.permissions.read([id]).get(id) ?? [],
          updates.isPrivate ?? stored.isPrivate === 1, updates.allowedRoleIds ?? roles.map(role => role.roleId)));
      }
      if (updates.name !== undefined) this.db.prepare('UPDATE channel_categories SET name = ? WHERE id = ?').run(updates.name, id);
      if (updates.isPrivate !== undefined) this.db.prepare('UPDATE channel_categories SET is_private = ? WHERE id = ?').run(updates.isPrivate ? 1 : 0, id);
      if (updates.allowedRoleIds !== undefined) this.replaceRoles(id, updates.allowedRoleIds);
    })();
  }

  private replaceRoles(id: string, roleIds: string[]): void {
    this.db.prepare('DELETE FROM category_allowed_roles WHERE category_id = ?').run(id);
    for (const roleId of roleIds) {
      this.db.prepare('INSERT OR IGNORE INTO category_allowed_roles (category_id, role_id) VALUES (?, ?)').run(id, roleId);
    }
  }

  async deletePreservingAccess(id: string): Promise<void> {
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM channel_permission_overwrites WHERE channel_id IN
        (SELECT id FROM channels WHERE category_id = ? AND inherit_category_permissions = 1)`).run(id);
      this.db.prepare(`INSERT INTO channel_permission_overwrites (channel_id, target_id, role_id, user_id, allow_bits, deny_bits)
        SELECT c.id, p.target_id, p.role_id, p.user_id, p.allow_bits, p.deny_bits FROM channels c
        JOIN category_permission_overwrites p ON p.category_id = c.category_id
        WHERE c.category_id = ? AND c.inherit_category_permissions = 1`).run(id);
      this.db.prepare(`DELETE FROM channel_allowed_roles WHERE channel_id IN
        (SELECT id FROM channels WHERE category_id = ? AND inherit_category_permissions = 1)`).run(id);
      this.db.prepare(`INSERT INTO channel_allowed_roles (channel_id, role_id)
        SELECT c.id, r.role_id FROM channels c JOIN category_allowed_roles r ON r.category_id = c.category_id
        JOIN channel_categories category ON category.id = c.category_id
        WHERE c.category_id = ? AND c.inherit_category_permissions = 1 AND category.is_private = 1`).run(id);
      this.db.prepare(`UPDATE channels SET is_private = (SELECT is_private FROM channel_categories WHERE id = ?)
        WHERE category_id = ? AND inherit_category_permissions = 1`).run(id, id);
      this.db.prepare('UPDATE channels SET category_id = NULL, inherit_category_permissions = 0 WHERE category_id = ?').run(id);
      this.db.prepare('DELETE FROM channel_categories WHERE id = ?').run(id);
    })();
  }

  async reorder(orderedIds: string[]): Promise<void> {
    this.db.transaction(() => {
      orderedIds.forEach((id, position) => this.db.prepare('UPDATE channel_categories SET position = ? WHERE id = ?').run(position, id));
    })();
  }
}
