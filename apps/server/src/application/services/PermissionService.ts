import { ADMIN_PERMISSIONS, DEFAULT_PERMISSIONS, Permission, hasPermission } from '@monky/shared';
import { IRoleRepository, IServerRepository } from '../../domain/repositories';

export class PermissionService {
  private roleAccessVersion = 0;
  private pendingRoleMutations = 0;

  constructor(
    private serverRepo: IServerRepository,
    private roleRepo: IRoleRepository
  ) {}

  public getRoleAccessVersion(): number | null {
    return this.pendingRoleMutations === 0 ? this.roleAccessVersion : null;
  }

  /**
   * A role write can commit before its WebSocket broadcast resumes. Sensitive
   * readers must invalidate stale authorization at that write boundary, not
   * only after the asynchronously published role list changes.
   */
  public async withRoleMutation<T>(mutation: () => Promise<T>): Promise<T> {
    this.roleAccessVersion++;
    this.pendingRoleMutations++;
    try {
      return await mutation();
    } finally {
      this.pendingRoleMutations--;
      this.roleAccessVersion++;
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
}
