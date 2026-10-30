import {
  ADMIN_PERMISSIONS,
  DEFAULT_PERMISSIONS,
  Permission,
  hasPermission,
  resolveMemberPermissions,
  stripAdministrator,
  type ResourceAudience,
} from '@monky/shared';
import { IRoleRepository, IServerRepository } from '../../domain/repositories';
import type { RoleRecord, ServerRecord } from '../../domain/entities';

interface ScreenRoleRevocation { roleId?: string; userId?: string }

/** A member's server-wide permissions and roles, read together (S-APP-5). */
export interface MemberAccess {
  userId: string;
  permissions: number;
  roleIds: string[];
}

/** The owner holds every permission; everybody else what Everyone and their roles grant. */
function memberPermissions(server: ServerRecord | null, userId: string, roles: readonly RoleRecord[]): number {
  return server && server.ownerUserId === userId
    ? ADMIN_PERMISSIONS : resolveMemberPermissions(server?.everyonePermissions ?? DEFAULT_PERMISSIONS, roles);
}

/** Whether a member may see a resource limited to an audience. Reads nothing. */
export function audienceAllows(member: MemberAccess, creatorUserId: string, audience: ResourceAudience): boolean {
  return revealsAudience(member, creatorUserId) || audience.visibility === 'public' ||
    audience.userIds.includes(member.userId) || audience.roleIds.some(roleId => member.roleIds.includes(roleId));
}

/** Whether a member may see who a resource's audience is. Reads nothing. */
export function revealsAudience(member: MemberAccess, creatorUserId: string): boolean {
  return member.userId === creatorUserId || hasPermission(member.permissions, Permission.MANAGE_SERVER);
}

export class PermissionService {
  private roleAccessVersion = 0;
  private pendingRoleMutations = 0;
  private screenRoleVersion = 0;
  private roleMutationListener?: (revocation: ScreenRoleRevocation | null) => void;

  public setRoleMutationListener(listener: ((revocation: ScreenRoleRevocation | null) => void) | undefined): void {
    this.roleMutationListener = listener;
  }

  constructor(
    private serverRepo: IServerRepository,
    private roleRepo: IRoleRepository
  ) {}

  public getRoleAccessVersion(): number | null {
    return this.pendingRoleMutations === 0 ? this.roleAccessVersion : null;
  }

  public getScreenRoleAccessVersion(): number {
    return this.screenRoleVersion;
  }

  /**
   * A role write can commit before its WebSocket broadcast resumes. Sensitive
   * readers must invalidate stale authorization at that write boundary, not
   * only after the asynchronously published role list changes.
   */
  public async withRoleMutation<T>(mutation: () => Promise<T>, revocation: ScreenRoleRevocation | false = {}): Promise<T> {
    this.roleAccessVersion++;
    this.pendingRoleMutations++;
    if (revocation !== false) {
      this.screenRoleVersion++;
    }
    try {
      this.roleMutationListener?.(revocation === false ? null : revocation);
      return await mutation();
    } finally {
      this.pendingRoleMutations--;
      this.roleAccessVersion++;
      if (revocation !== false) {
        this.screenRoleVersion++;
      }
      this.roleMutationListener?.(revocation === false ? null : revocation);
    }
  }

  public async isOwner(userId: string): Promise<boolean> {
    const server = await this.serverRepo.getServer();
    return !!server && server.ownerUserId === userId;
  }

  /** Every permission check of a member comes down to this one, which reads the server and their roles once. */
  public async getUserPermissions(userId: string): Promise<number> {
    const [server, roles] = await Promise.all([this.serverRepo.getServer(), this.roleRepo.listRolesForUser(userId)]);
    return memberPermissions(server, userId, roles);
  }

  /** A member's permissions together with their roles, as channel rules need both (S-APP-5). */
  public async getMemberAccess(userId: string): Promise<MemberAccess> {
    const [permissions, roleIds] = await Promise.all([this.getUserPermissions(userId), this.getUserRoleIds(userId)]);
    return { userId, permissions, roleIds };
  }

  /** getMemberAccess for many members at once, in three reads whatever their number (S-APP-5). */
  public async getMembersAccess(userIds: readonly string[]): Promise<Map<string, MemberAccess>> {
    if (userIds.length === 0) return new Map();
    const [server, roles, assignments] = await Promise.all([
      this.serverRepo.getServer(), this.roleRepo.listAll(), this.roleRepo.listUserRoles(),
    ]);
    const wanted = new Set(userIds);
    const assigned = new Map<string, Set<string>>();
    for (const { userId, roleId } of assignments) {
      if (!wanted.has(userId)) continue;
      const roleIds = assigned.get(userId) ?? new Set<string>();
      roleIds.add(roleId);
      assigned.set(userId, roleIds);
    }
    return new Map(userIds.map((userId): [string, MemberAccess] => {
      const roleIds = assigned.get(userId);
      // listAll keeps the order listRolesForUser reads them in.
      const memberRoles = roleIds ? roles.filter(role => roleIds.has(role.id)) : [];
      return [userId, { userId, permissions: memberPermissions(server, userId, memberRoles), roleIds: memberRoles.map(role => role.id) }];
    }));
  }

  public async getEveryonePermissions(): Promise<number> {
    return (await this.serverRepo.getServer())?.everyonePermissions ?? DEFAULT_PERMISSIONS;
  }

  public async updateEveryonePermissions(permissions: number): Promise<void> {
    await this.withRoleMutation(() => this.serverRepo.updateServer({
      everyonePermissions: stripAdministrator(permissions),
    }));
  }

  public async checkPermission(userId: string, permission: Permission): Promise<boolean> {
    const permissions = await this.getUserPermissions(userId);
    return hasPermission(permissions, permission);
  }

  public async getUserRoleIds(userId: string): Promise<string[]> {
    return (await this.roleRepo.listRolesForUser(userId)).map(role => role.id);
  }

  public async isSelectedAudienceMember(userId: string, audience: ResourceAudience): Promise<boolean> {
    if (audience.visibility === 'public' || audience.userIds.includes(userId)) return true;
    const roles = new Set(await this.getUserRoleIds(userId));
    return audience.roleIds.some(roleId => roles.has(roleId));
  }

  public async canAccessAudience(
    userId: string,
    creatorUserId: string,
    audience: ResourceAudience,
  ): Promise<boolean> {
    return userId === creatorUserId ||
      await this.checkPermission(userId, Permission.MANAGE_SERVER) ||
      await this.isSelectedAudienceMember(userId, audience);
  }

  public async canRevealAudience(userId: string, creatorUserId: string): Promise<boolean> {
    return userId === creatorUserId || await this.checkPermission(userId, Permission.MANAGE_SERVER);
  }
}
