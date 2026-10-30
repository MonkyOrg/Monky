import { MessageType, Permission } from '@monky/shared';
import { t } from '../i18n';
import type { ServerStore } from '../stores/serverStore';

type MemberActionStore = Pick<ServerStore,
  'currentUser' | 'ownerId' | 'hasPermission' | 'getAdminRole' | 'getRole' | 'isAdminRole' | 'getAllMembersInDisplayOrder'>;

/** Sends one request to the server that owns the member being changed. */
export type MemberRequest = (type: MessageType, payload: object) => Promise<unknown>;

export type MemberRoleChange = { name: string; role: string };

/**
 * Whether the person using the app may grant or remove the built-in Admin role.
 * The server only lets the owner do it (#397), so offering it to anyone else
 * would only end in a refusal.
 */
export function canManageAdmins(store: MemberActionStore): boolean {
  return !!store.ownerId && store.currentUser?.id === store.ownerId && !!store.getAdminRole()
    && store.hasPermission(Permission.MANAGE_ROLES);
}

/**
 * Adds or removes one role from a member. The member menu and the Members tab
 * both go through here, so they follow the same rules and report the same way.
 */
export async function changeMemberRole(
  send: MemberRequest,
  store: MemberActionStore,
  userId: string,
  roleId: string,
  assign: boolean,
): Promise<MemberRoleChange> {
  const role = store.getRole(roleId);
  if (!role) throw new Error(t('serverSettings.roleUnavailable'));
  const member = store.getAllMembersInDisplayOrder().find(entry => entry.id === userId);
  if (!member) throw new Error(t('roles.memberUnavailable'));
  if (store.isAdminRole(role) && !canManageAdmins(store)) throw new Error(t('protocolError.permissionDenied'));
  await send(assign ? MessageType.ROLE_ASSIGN : MessageType.ROLE_UNASSIGN, { userId, roleId });
  return { name: member.nickname, role: role.name };
}

export function memberRoleChangedMessage(assign: boolean, change: MemberRoleChange): string {
  return t(assign ? 'roles.memberAdded' : 'roles.memberRemoved', change);
}
