import { Permission, Role } from '@monky/shared';
import { serverStore } from '../../../stores/serverStore';
import { getAvatarUrl } from '../../../utils/avatar';
import { escapeHtml } from '../../../utils/html';
import { t } from '../../../i18n';

function renderRoleOption(role: Role, isAssigned: boolean): string {
  return `
    <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%;">
      <div style="display: flex; align-items: center; gap: 8px; min-width: 0;">
        <span style="width: 8px; height: 8px; border-radius: 50%; background: ${role.color || 'var(--text-muted)'}; flex-shrink: 0;"></span>
        <span style="font-size: 12px; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(role.name)}</span>
      </div>
      <span class="material-symbols-outlined md-16" style="color: ${isAssigned ? 'var(--accent-primary)' : 'transparent'};">${isAssigned ? 'check' : 'check'}</span>
    </div>
  `;
}

export class ServerMembersTab {
  public renderHtml(): string {
    const roles = [...serverStore.roles].sort((a, b) => b.position - a.position);
    // Admin is toggled through its own action, never listed as a role (#265).
    const manageableRoles = roles.filter((role) => !role.isDefault && !serverStore.isAdminRole(role));
    const adminRole = serverStore.getAdminRole();
    const members = [...(serverStore.serverDetails?.members ?? [])].sort((a, b) => a.nickname.localeCompare(b.nickname));
    const canKickMembers = serverStore.hasPermission(Permission.KICK_MEMBERS);

    return `
      <div style="display: flex; flex-direction: column; gap: 16px; width: 100%;">
        <div data-settings-section="members" data-settings-label="${escapeHtml(t('roles.membersList'))}" style="background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 14px; overflow: visible;">
          <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 12px; flex-wrap: wrap;">
            <div>
              <div style="font-size: 13px; font-weight: 700; margin-bottom: 4px;">${t('roles.membersList')}</div>
              <div style="font-size: 11px; color: var(--text-muted);">${t('roles.membersTableHint')}</div>
            </div>
          </div>
          <div class="settings-table-wrap">
            <table class="settings-data-table">
              <thead>
                <tr>
                  <th>${t('roles.memberColumn')}</th>
                  <th>${t('roles.rolesColumn')}</th>
                  <th style="width: 96px; text-align: right;">${t('roles.actionsColumn')}</th>
                </tr>
              </thead>
              <tbody>
            ${members.map((member) => {
              const userRoles = serverStore
                .getUserRoles(member.id)
                .filter((role) => !role.isDefault && !serverStore.isAdminRole(role));
              const visibleRoles = userRoles.slice(0, 2);
              const extraRoles = userRoles.length - visibleRoles.length;
              const avatar = getAvatarUrl(member.avatarUrl);
              const isAdmin = Boolean(adminRole && serverStore.getUserRoleIds(member.id).includes(adminRole.id));
              const isOwner = member.id === serverStore.ownerId;

              return `
                <tr>
                  <td>
                    <div style="display: flex; align-items: center; gap: 10px; min-width: 0;">
                      <img src="${avatar}" alt="${escapeHtml(member.nickname)}" data-fallback="avatar" style="width: 40px; height: 40px; border-radius: 50%; object-fit: cover; border: 1px solid var(--border-color); flex-shrink: 0;">
                      <div style="min-width: 0; display: flex; flex-direction: column; gap: 4px;">
                        <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0;">
                          <span style="font-size: 13px; font-weight: 600; color: var(--text-primary); min-width: 0; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(member.nickname)}</span>
                          ${member.id === serverStore.currentUser?.id ? `<span class="member-badge-you">${t('common.you')}</span>` : ''}
                          ${isOwner ? `<span class="member-badge-you">${t('roles.ownerBadge')}</span>` : ''}
                          ${isAdmin ? `<span class="member-badge-you" style="background: rgba(88, 101, 242, 0.18); color: var(--accent-primary);">${t('roles.adminBadge')}</span>` : ''}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td>
                    ${visibleRoles.length
                      ? `
                        <div class="member-role-tags">
                          ${visibleRoles.map((role) => `<span class="member-role-tag" style="${role.color ? `--role-color: ${role.color}` : ''}">${escapeHtml(role.name)}</span>`).join('')}
                          ${extraRoles > 0 ? `<span class="member-badge-you" style="background: rgba(255, 255, 255, 0.08); color: var(--text-secondary);">${t('roles.moreRoles', { count: extraRoles })}</span>` : ''}
                        </div>
                      `
                      : `<span style="font-size: 11px; color: var(--text-muted);">${t('roles.noExtraRoles')}</span>`}
                  </td>
                  <td style="text-align: right;">
                    <div class="settings-action-menu-wrap">
                      <button type="button" class="btn btn-secondary btn-icon member-actions-trigger" data-user-id="${member.id}" title="${t('common.moreOptions')}" style="width: 32px; height: 32px; padding: 0; justify-content: center;">
                        <span class="material-symbols-outlined md-18">more_horiz</span>
                      </button>
                      <div class="settings-action-menu">
                        ${canKickMembers ? `
                          <button type="button" class="settings-action-menu-item danger" data-member-action="kick" data-user-id="${member.id}" ${isOwner ? 'disabled' : ''}>
                            ${t('userMenu.kickMember')}
                          </button>
                        ` : ''}
                        ${adminRole ? `
                          <button type="button" class="settings-action-menu-item" data-member-action="toggle-admin" data-user-id="${member.id}" data-role-id="${adminRole.id}" ${isOwner ? 'disabled' : ''}>
                            <span class="material-symbols-outlined md-16">${isAdmin ? 'remove_moderator' : 'shield_person'}</span>
                            <span>${isAdmin ? t('userMenu.removeAdmin') : t('userMenu.promoteToAdmin')}</span>
                          </button>
                        ` : ''}
                        <div class="settings-action-submenu-wrap">
                          <button type="button" class="settings-action-menu-item" ${manageableRoles.length ? '' : 'disabled'}>
                            <span>${t('userMenu.rolesSubmenu')}</span>
                            <span class="material-symbols-outlined md-16">chevron_left</span>
                          </button>
                          ${manageableRoles.length ? `
                            <div class="settings-action-submenu">
                              ${manageableRoles.map((role) => {
                                const assigned = serverStore.getUserRoleIds(member.id).includes(role.id);
                                return `
                                  <button type="button" class="settings-action-menu-item" data-member-action="toggle-role" data-user-id="${member.id}" data-role-id="${role.id}" ${isOwner ? 'disabled' : ''}>
                                    ${renderRoleOption(role, assigned)}
                                  </button>
                                `;
                              }).join('')}
                            </div>
                          ` : ''}
                        </div>
                      </div>
                    </div>
                  </td>
                </tr>
              `;
            }).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;
  }
}
