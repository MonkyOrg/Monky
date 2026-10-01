import { ChannelCategory } from '@monky/shared';
import { ICategoryRepository } from '../../domain/repositories';
import { IDatabaseDriver } from './SqliteWrapper';

type CategoryRow = Omit<ChannelCategory, 'isPrivate' | 'allowedRoleIds'> & { isPrivate: number };
const COLUMNS = 'id, server_id AS serverId, name, position, created_at AS createdAt, is_private AS isPrivate';

export class SqliteCategoryRepository implements ICategoryRepository {
  constructor(private db: IDatabaseDriver) {}

  /** Synchronous hydration keeps each channel and its inherited ACL in one snapshot. */
  readByServerId(serverId: string): ChannelCategory[] {
    const rows = this.db.prepare(`SELECT ${COLUMNS} FROM channel_categories WHERE server_id = ? ORDER BY position, created_at, id`)
      .all(serverId) as CategoryRow[];
    const roles = this.db.prepare(`SELECT r.category_id AS categoryId, r.role_id AS roleId
      FROM category_allowed_roles r JOIN channel_categories c ON c.id = r.category_id WHERE c.server_id = ?`)
      .all(serverId) as { categoryId: string; roleId: string }[];
    const byCategory = new Map<string, string[]>();
    for (const role of roles) byCategory.set(role.categoryId, [...(byCategory.get(role.categoryId) ?? []), role.roleId]);
    return rows.map((row) => ({ ...row, isPrivate: row.isPrivate === 1, allowedRoleIds: byCategory.get(row.id) ?? [] }));
  }

  async listByServerId(serverId: string): Promise<ChannelCategory[]> { return this.readByServerId(serverId); }

  async findById(id: string): Promise<ChannelCategory | null> {
    const row = this.db.prepare('SELECT server_id AS serverId FROM channel_categories WHERE id = ?')
      .get(id) as { serverId: string } | undefined;
    return row ? this.readByServerId(row.serverId).find((category) => category.id === id) ?? null : null;
  }

  async create(category: ChannelCategory): Promise<void> {
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO channel_categories (id, server_id, name, position, created_at, is_private) VALUES (?, ?, ?, ?, ?, ?)')
        .run(category.id, category.serverId, category.name, category.position, category.createdAt, category.isPrivate ? 1 : 0);
      this.replaceRoles(category.id, category.isPrivate ? category.allowedRoleIds : []);
    })();
  }

  async update(id: string, updates: Partial<Pick<ChannelCategory, 'name' | 'isPrivate' | 'allowedRoleIds'>>): Promise<void> {
    this.db.transaction(() => {
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
