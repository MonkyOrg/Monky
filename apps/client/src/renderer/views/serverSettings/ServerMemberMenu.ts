import { MessageType, Permission } from '@monky/shared';
import { t } from '../../i18n';
import { ContextMenu, type ContextMenuEntry } from '../ContextMenu';
import { showConfirm } from '../Dialog';
import { canManageAdmins } from '../memberActions';
import { canBanIdentity } from '../../utils/identityBan';
import { openIdentityBanDialog } from '../IdentityBanDialog';
import type { ServerSettingsContext } from './ServerSettingsContext';

type AssignRole = (userId: string, roleId: string, assign: boolean) => void;

export class ServerMemberMenu {
  private readonly menu = new ContextMenu();
  private confirmation: { userId: string; controller: AbortController } | null = null;

  public open(anchor: HTMLButtonElement, userId: string, context: ServerSettingsContext, assignRole: AssignRole): void {
    if (!context.isCurrent()) return;
    if (this.menu.isOpenFor(anchor)) {
      this.menu.close();
      return;
    }
    const { store, operations } = context;
    const member = store.getAllMembersInDisplayOrder().find(entry => entry.id === userId);
    if (!member) return;
    const protectedMember = userId === store.ownerId;
    const roleIds = new Set(store.getUserRoleIds(userId));
    const items: ContextMenuEntry[] = [];
    if (store.hasPermission(Permission.KICK_MEMBERS)) {
      items.push({
        label: t('userMenu.kickMember'), icon: 'person_remove', danger: true,
        disabled: protectedMember || userId === store.currentUser?.id || operations.isPending(`kick:${userId}`),
        onClick: () => this.removeMember(userId, context),
      });
    }
    if (canBanIdentity(store, userId)) {
      items.push({
        label: t('identity.banAction'), icon: 'block', danger: true,
        onClick: () => { if (context.isCurrent()) openIdentityBanDialog(userId); },
      });
    }
    const adminRole = store.getAdminRole();
    if (adminRole && canManageAdmins(store)) {
      const assigned = roleIds.has(adminRole.id);
      items.push({
        label: t(assigned ? 'userMenu.removeAdmin' : 'userMenu.promoteToAdmin'),
        icon: assigned ? 'remove_moderator' : 'shield_person',
        disabled: protectedMember,
        onClick: () => assignRole(userId, adminRole.id, !assigned),
      });
    }
    if (store.hasPermission(Permission.MANAGE_ROLES)) {
      const roles = [...store.roles].filter(role => !role.isDefault && !store.isAdminRole(role))
        .sort((a, b) => b.position - a.position);
      if (roles.length) {
        items.push({
          label: t('userMenu.rolesSubmenu'), icon: 'label',
          submenu: roles.map(role => ({
            label: role.name, icon: roleIds.has(role.id) ? 'check' : 'label', iconColor: role.color ?? undefined,
            disabled: protectedMember || operations.isPending(`assignment:${userId}:${role.id}`),
            onClick: () => assignRole(userId, role.id, !roleIds.has(role.id)),
          })),
        });
      }
    }
    const rect = anchor.getBoundingClientRect();
    this.menu.open(rect.right, rect.bottom + 6, items, anchor);
  }

  private removeMember(userId: string, context: ServerSettingsContext): void {
    if (this.confirmation || context.operations.isPending(`kick:${userId}`)) return;
    const confirmation = { userId, controller: new AbortController() };
    this.confirmation = confirmation;
    void context.operations.run(`kick:${userId}`, t('userMenu.kickMember'), Permission.KICK_MEMBERS, async () => {
      const member = context.store.getAllMembersInDisplayOrder().find(entry => entry.id === userId);
      if (!member) throw new Error(t('roles.memberUnavailable'));
      if (userId === context.store.ownerId || userId === context.store.currentUser?.id) {
        throw new Error(t('protocolError.permissionDenied'));
      }
      const confirmed = await showConfirm({
        title: t('userMenu.kickMember'),
        message: t('roles.confirmKickMember', { name: member.nickname }),
        confirmLabel: t('userMenu.kickMember'), variant: 'danger', focusCancel: true,
        signal: confirmation.controller.signal,
      });
      if (!confirmed) return;
      context.assertAllowed(Permission.KICK_MEMBERS);
      if (!context.store.getAllMembersInDisplayOrder().some(entry => entry.id === userId)) {
        throw new Error(t('roles.memberUnavailable'));
      }
      if (userId === context.store.ownerId || userId === context.store.currentUser?.id) {
        throw new Error(t('protocolError.permissionDenied'));
      }
      await context.request<unknown>([MessageType.MEMBER_KICK, { targetUserId: userId }], Permission.KICK_MEMBERS);
    }).finally(() => {
      if (this.confirmation === confirmation) this.confirmation = null;
    });
  }

  public refresh(context: ServerSettingsContext): void {
    const confirmation = this.confirmation;
    if (confirmation && (!context.isCurrent() || !context.store.hasPermission(Permission.KICK_MEMBERS)
      || context.store.ownerId === confirmation.userId || context.store.currentUser?.id === confirmation.userId
      || !context.store.getAllMembersInDisplayOrder().some(entry => entry.id === confirmation.userId))) {
      confirmation.controller.abort();
    }
  }

  public close(): void {
    this.menu.close();
  }

  public dispose(): void {
    this.confirmation?.controller.abort();
    this.menu.close();
  }
}
