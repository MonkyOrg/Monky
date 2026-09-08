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
}

export const DEFAULT_PERMISSIONS =
  Permission.SPEAK |
  Permission.SEND_MESSAGES |
  Permission.READ_MESSAGES |
  Permission.ATTACH_FILES |
  Permission.USE_SOUNDBOARD |
  Permission.USE_BOT_COMMANDS;

export const ADMIN_PERMISSIONS = 0xFFFFFFFF;

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
 * Whether a member may see and use a channel (#384).
 *
 * MANAGE_CHANNELS grants full access on purpose: whoever can edit a channel
 * could simply add their own role to it, so withholding the content would be
 * an illusion of privacy rather than actual protection. `hasPermission` already
 * treats ADMINISTRATOR as a wildcard, and the owner is handed
 * ADMIN_PERMISSIONS, so both are covered by the same check.
 *
 * A private channel with no allowed roles resolves to managers only, which is
 * the safe direction to fail towards when its last allowed role is deleted.
 */
export function canAccessChannel(
  channel: { isPrivate: boolean; allowedRoleIds: readonly string[] },
  userPermissions: number,
  userRoleIds: readonly string[]
): boolean {
  if (!channel.isPrivate) return true;
  if (hasPermission(userPermissions, Permission.MANAGE_CHANNELS)) return true;
  return channel.allowedRoleIds.some((roleId) => userRoleIds.includes(roleId));
}
