import {
  PUBLIC_AUDIENCE,
  resourceAudienceSchema,
  type ResourceAudience,
} from '@monky/shared';
import type { IDatabaseDriver } from './SqliteWrapper';

export type CommunityResourceType = 'event' | 'live_action' | 'poll' | 'native_form';

export class SqliteResourceAudienceRepository {
  constructor(private readonly db: IDatabaseDriver) {}

  replace(resourceType: CommunityResourceType, resourceId: string, input: ResourceAudience): void {
    const audience = resourceAudienceSchema.parse(input);
    this.remove(resourceType, resourceId);
    if (audience.visibility === 'public') return;
    this.db.prepare(`INSERT INTO community_resource_audiences (resource_type, resource_id)
      VALUES (?, ?)`).run(resourceType, resourceId);
    const addUser = this.db.prepare(`INSERT OR IGNORE INTO community_resource_audience_users
      (resource_type, resource_id, user_id) VALUES (?, ?, ?)`);
    const addRole = this.db.prepare(`INSERT OR IGNORE INTO community_resource_audience_roles
      (resource_type, resource_id, role_id) VALUES (?, ?, ?)`);
    for (const userId of audience.userIds) addUser.run(resourceType, resourceId, userId);
    for (const roleId of audience.roleIds) addRole.run(resourceType, resourceId, roleId);
  }

  remove(resourceType: CommunityResourceType, resourceId: string): void {
    this.db.prepare(`DELETE FROM community_resource_audiences
      WHERE resource_type = ? AND resource_id = ?`).run(resourceType, resourceId);
  }

  load(resourceType: CommunityResourceType, resourceId: string): ResourceAudience {
    const privateRow = this.db.prepare(`SELECT 1 FROM community_resource_audiences
      WHERE resource_type = ? AND resource_id = ?`).get(resourceType, resourceId);
    if (!privateRow) return PUBLIC_AUDIENCE;
    const userIds = (this.db.prepare(`SELECT user_id AS id FROM community_resource_audience_users
      WHERE resource_type = ? AND resource_id = ? ORDER BY user_id`).all(resourceType, resourceId) as Array<{ id: string }>)
      .map(row => row.id);
    const roleIds = (this.db.prepare(`SELECT role_id AS id FROM community_resource_audience_roles
      WHERE resource_type = ? AND resource_id = ? ORDER BY role_id`).all(resourceType, resourceId) as Array<{ id: string }>)
      .map(row => row.id);
    return { visibility: 'private', userIds, roleIds };
  }
}
