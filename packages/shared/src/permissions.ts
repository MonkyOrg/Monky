export enum Permission {
  MANAGE_CHANNELS = 1 << 0,
  MANAGE_SERVER = 1 << 1,
  MANAGE_ROLES = 1 << 2,
  KICK_MEMBERS = 1 << 3,
  SPEAK = 1 << 4,
  MUTE_MEMBERS = 1 << 5,
  DEAFEN_MEMBERS = 1 << 6,
  MOVE_MEMBERS = 1 << 7,
  SEND_MESSAGES = 1 << 8,
  READ_MESSAGES = 1 << 9,
  ATTACH_FILES = 1 << 10,
  ADMINISTRATOR = 1 << 11,
  USE_SOUNDBOARD = 1 << 12,
  MANAGE_BOTS = 1 << 13,
  USE_BOT_COMMANDS = 1 << 14,
  CONFIGURE_BOTS = 1 << 15,
  VIEW_SERVER_MONITOR = 1 << 16,
  MANAGE_EVENTS = 1 << 17,
  EMIT_LIVE_ACTIONS = 1 << 18,
  VIEW_CHANNEL = 1 << 19,
}

export const DEFAULT_PERMISSIONS =
  Permission.SPEAK |
  Permission.SEND_MESSAGES |
  Permission.READ_MESSAGES |
  Permission.ATTACH_FILES |
  Permission.USE_SOUNDBOARD |
  Permission.USE_BOT_COMMANDS |
  Permission.VIEW_CHANNEL;

export const ADMIN_PERMISSIONS = 0xFFFFFFFF;
/** An editor target, never a persisted or assignable role. */
export const EVERYONE_ROLE_ID = '@everyone';

export type ChannelPermissionOverwrite = (
  /** null addresses the automatic Everyone base; a member is a separate target. */
  { roleId: string | null; userId?: never } | { userId: string; roleId?: never }
) & {
  allow: number;
  deny: number;
};

export function channelPermissionTargetKey(target: Pick<ChannelPermissionOverwrite, 'roleId' | 'userId'>): string {
  return target.userId !== undefined ? `user:${target.userId}`
    : target.roleId === null ? EVERYONE_ROLE_ID : `role:${target.roleId}`;
}

export interface ChannelAccessRules {
  isPrivate: boolean;
  allowedRoleIds: readonly string[];
  permissionOverwrites?: readonly ChannelPermissionOverwrite[];
}

export const CHANNEL_PERMISSIONS =
  Permission.VIEW_CHANNEL | Permission.SPEAK | Permission.SEND_MESSAGES | Permission.READ_MESSAGES |
  Permission.ATTACH_FILES | Permission.USE_SOUNDBOARD | Permission.USE_BOT_COMMANDS;

/**
 * Server management bits that earlier channel editors could store. They are
 * still accepted from older clients but dropped: only server roles grant them.
 */
export const LEGACY_CHANNEL_PERMISSIONS = Permission.MANAGE_EVENTS | Permission.EMIT_LIVE_ACTIONS;

/** A server role: `permissions` holds the allowed bits, `deny` the denied ones; every other bit inherits Everyone. */
export interface RolePermissionRule {
  permissions: number;
  deny?: number;
}

/**
 * Everyone is the base of every member. Roles allow or deny on top of it and
 * any denial wins; bits a role leaves unset inherit. Administrators bypass it.
 */
export function resolveMemberPermissions(everyone: number, roles: readonly RolePermissionRule[]): number {
  if (roles.some(role => hasPermission(role.permissions, Permission.ADMINISTRATOR))) return ADMIN_PERMISSIONS;
  let allow = 0;
  let deny = 0;
  for (const role of roles) {
    allow |= role.permissions;
    deny |= role.deny ?? 0;
  }
  return stripAdministrator((everyone | allow) & ~deny);
}

/**
 * Servers before allow/deny roles stored each role as a full switch mask that
 * replaced Everyone, and intersected the masks of several roles.
 */
export function resolveLegacyMemberPermissions(everyone: number, roles: readonly { permissions: number }[]): number {
  if (roles.some(role => hasPermission(role.permissions, Permission.ADMINISTRATOR))) return ADMIN_PERMISSIONS;
  if (roles.length === 0) return stripAdministrator(everyone);
  return stripAdministrator(roles.reduce((bits, role) => bits & role.permissions, ADMIN_PERMISSIONS));
}

/** Expresses a former full role mask as allow/deny against Everyone without changing what it grants. */
export function legacyRoleRule(permissions: number, everyone: number): Required<RolePermissionRule> {
  if (hasPermission(permissions, Permission.ADMINISTRATOR)) return { permissions: permissions >>> 0, deny: 0 };
  return { permissions: (permissions & ~everyone) >>> 0, deny: stripAdministrator(everyone & ~permissions) };
}

/** The full switch mask an older server expects for an allow/deny role. */
export function legacyRoleMask(rule: RolePermissionRule, everyone: number): number {
  if (hasPermission(rule.permissions, Permission.ADMINISTRATOR)) return rule.permissions >>> 0;
  return stripAdministrator((everyone | rule.permissions) & ~(rule.deny ?? 0));
}

/** Roles as clients without allow/deny support expect them: full masks and no `deny`. */
export function toLegacyRoles<T extends RolePermissionRule>(roles: readonly T[], everyone: number): Array<Omit<T, 'deny'>> {
  return roles.map(({ deny, ...role }) => ({ ...role, permissions: legacyRoleMask({ permissions: role.permissions, deny }, everyone) }));
}

/** Converts the old privacy form to the same rules used by the permission editor. */
export function withChannelPrivacy(
  overwrites: readonly ChannelPermissionOverwrite[], isPrivate: boolean, roleIds: readonly string[],
): ChannelPermissionOverwrite[] {
  const result = overwrites.map(overwrite => ({
    ...overwrite,
    allow: overwrite.allow & ~Permission.VIEW_CHANNEL,
    deny: overwrite.deny & ~Permission.VIEW_CHANNEL,
  }));
  const set = (roleId: string | null, allow: boolean) => {
    let entry = result.find(overwrite => overwrite.roleId === roleId);
    if (!entry) { entry = { roleId, allow: 0, deny: 0 }; result.push(entry); }
    if (allow) entry.allow |= Permission.VIEW_CHANNEL;
    else entry.deny |= Permission.VIEW_CHANNEL;
  };
  set(null, !isPrivate);
  if (isPrivate) for (const roleId of new Set(roleIds)) set(roleId, true);
  if (isPrivate) {
    for (const entry of result) {
      if (entry.userId !== undefined && overwrites.some(old =>
        old.userId === entry.userId && (old.allow & Permission.VIEW_CHANNEL) !== 0)) {
        entry.allow |= Permission.VIEW_CHANNEL;
      }
    }
  }
  return result.filter(overwrite => overwrite.allow !== 0 || overwrite.deny !== 0);
}

export function channelOverwrites(rules: ChannelAccessRules): ChannelPermissionOverwrite[] {
  return rules.permissionOverwrites
    ? rules.permissionOverwrites.map(overwrite => ({
      ...overwrite,
      allow: overwrite.allow & CHANNEL_PERMISSIONS,
      deny: overwrite.deny & CHANNEL_PERMISSIONS,
    })).filter(overwrite => overwrite.allow !== 0 || overwrite.deny !== 0)
    : rules.isPrivate ? withChannelPrivacy([], true, rules.allowedRoleIds) : [];
}

export function channelPrivacy(overwrites: readonly ChannelPermissionOverwrite[], previous?: ChannelAccessRules): { isPrivate: boolean; allowedRoleIds: string[] } {
  const viewRules = overwrites.filter(rule => ((rule.allow | rule.deny) & Permission.VIEW_CHANNEL) !== 0);
  const previousViewRules = previous ? channelOverwrites(previous).filter(rule => ((rule.allow | rule.deny) & Permission.VIEW_CHANNEL) !== 0) : [];
  // Migrated Member audiences may allow all humans while still excluding bots.
  const preservePrivate = previous?.isPrivate && viewRules.length === previousViewRules.length &&
    viewRules.every(rule => previousViewRules.some(old => channelPermissionTargetKey(old) === channelPermissionTargetKey(rule) &&
      ((old.allow ^ rule.allow) & Permission.VIEW_CHANNEL) === 0 &&
      ((old.deny ^ rule.deny) & Permission.VIEW_CHANNEL) === 0));
  const isPrivate = !!preservePrivate || overwrites.some(overwrite => overwrite.roleId === null && (overwrite.deny & Permission.VIEW_CHANNEL) !== 0);
  return {
    isPrivate,
    allowedRoleIds: isPrivate
      ? overwrites.filter(overwrite => overwrite.roleId != null && (overwrite.allow & Permission.VIEW_CHANNEL) !== 0)
        .map(overwrite => overwrite.roleId!)
      : [],
  };
}

/** Role and member rules replace Everyone; any matching explicit denial wins. */
export function getChannelPermissions(
  rules: ChannelAccessRules, permissions: number, roleIds: readonly string[], limitToBase = false, userId?: string,
): number {
  if (hasPermission(permissions, Permission.ADMINISTRATOR)) return ADMIN_PERMISSIONS;
  let result = rules.permissionOverwrites === undefined ? permissions | Permission.VIEW_CHANNEL : permissions;
  let allow = 0;
  let deny = 0;
  for (const overwrite of channelOverwrites(rules)) {
    if (overwrite.roleId === null) {
      result = (result | overwrite.allow) & ~overwrite.deny;
    } else if (overwrite.userId !== undefined ? overwrite.userId === userId
      : overwrite.roleId !== undefined && roleIds.includes(overwrite.roleId)) {
      allow |= overwrite.allow;
      deny |= overwrite.deny;
    }
  }
  result = ((result | allow) & ~deny) >>> 0;
  if (limitToBase) result = (result & permissions) >>> 0;
  return result;
}

export function hasChannelPermission(
  rules: ChannelAccessRules, permissions: number, roleIds: readonly string[], permission: Permission, limitToBase = false, userId?: string,
): boolean {
  const effective = getChannelPermissions(rules, permissions, roleIds, limitToBase, userId);
  return hasPermission(effective, Permission.VIEW_CHANNEL) && hasPermission(effective, permission);
}

export function hasPermission(userPermissions: number, permission: Permission): boolean {
  if (userPermissions & Permission.ADMINISTRATOR) return true;
  return (userPermissions & permission) !== 0;
}

/**
 * ADMINISTRATOR is no longer granted through a custom role: admin rights come
 * exclusively from the Admin role, given by promoting the member (#277).
 */
export function stripAdministrator(permissions: number): number {
  return (permissions & ~Permission.ADMINISTRATOR) >>> 0;
}

/**
 * Canonical visibility follows scoped rules; only administrators bypass them.
 * Bots never enter private channels through ordinary role permissions.
 */
export function canAccessChannel(
  channel: ChannelAccessRules,
  userPermissions: number,
  userRoleIds: readonly string[],
  isBot = false,
  userId?: string,
): boolean {
  if (isBot && channel.isPrivate) return false;
  if (hasPermission(userPermissions, Permission.ADMINISTRATOR)) return true;
  if (channel.permissionOverwrites !== undefined) {
    return hasChannelPermission(channel, userPermissions, userRoleIds, Permission.VIEW_CHANNEL, isBot, userId);
  }
  if (!channel.isPrivate) return true;
  return channel.allowedRoleIds.some((roleId) => userRoleIds.includes(roleId));
}

/** Resolve once at the repository boundary so every access path sees the same ACL. */
export function resolveChannelPermissions(
  channel: ChannelAccessRules & { categoryId?: string | null; inheritCategoryPermissions?: boolean },
  category: ChannelAccessRules | null,
): { isPrivate: boolean; allowedRoleIds: string[]; permissionOverwrites?: ChannelPermissionOverwrite[] } {
  if (!channel.categoryId || channel.inheritCategoryPermissions === false) {
    return { isPrivate: channel.isPrivate, allowedRoleIds: channel.isPrivate ? [...channel.allowedRoleIds] : [],
      ...(channel.permissionOverwrites !== undefined ? { permissionOverwrites: channelOverwrites(channel) } : {}) };
  }
  // A missing parent must fail closed, never silently publish inherited channels.
  return category
    ? { isPrivate: category.isPrivate, allowedRoleIds: category.isPrivate ? [...category.allowedRoleIds] : [],
      ...(category.permissionOverwrites !== undefined ? { permissionOverwrites: channelOverwrites(category) } : {}) }
    : { isPrivate: true, allowedRoleIds: [], permissionOverwrites: [{ roleId: null, allow: 0, deny: CHANNEL_PERMISSIONS }] };
}
