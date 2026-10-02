import {
  ADMIN_PERMISSIONS,
  DEFAULT_PERMISSIONS,
  Permission,
  hasPermission,
  type ResourceAudience,
} from '@monky/shared';
import { IRoleRepository, IServerRepository } from '../../domain/repositories';

interface ScreenRoleRevocation { roleId?: string; userId?: string }

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

  public async getUserPermissions(userId: string): Promise<number> {
    if (await this.isOwner(userId)) {
      return ADMIN_PERMISSIONS;
    }

    const roles = await this.roleRepo.listRolesForUser(userId);
    if (roles.length === 0) {
      return DEFAULT_PERMISSIONS;
    }
    return roles.reduce((bits, role) => bits | role.permissions, 0);
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
