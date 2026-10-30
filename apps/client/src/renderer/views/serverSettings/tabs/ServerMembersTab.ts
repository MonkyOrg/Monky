import { Permission } from '@monky/shared';
import { serverStore } from '../../../stores/serverStore';
import { getAvatarUrl } from '../../../utils/avatar';
import { escapeHtml, html, trustedHtml } from '../../../utils/html';
import { renderRoleOption } from '../../../utils/roleOption';
import { renderRoleTags } from '../../../utils/roleTags';
import { t } from '../../../i18n';

const VISIBLE_ROLE_TAGS = 2;

/** Case- and accent-insensitive form used to match member names. */
function normalizeMemberQuery(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase().trim();
}

/**
 * Shows only the member rows whose name matches the search. Run again after
 * the rows are redrawn, since a refresh rebuilds them unfiltered.
 */
export function filterServerMembers(root: ParentNode): void {
  const input = root.querySelector<HTMLInputElement>('#server-members-search');
  const query = normalizeMemberQuery(input?.value ?? '');
  const rows = [...root.querySelectorAll<HTMLElement>('#server-members-table tbody tr[data-member-name]')];
  let shown = 0;
  for (const row of rows) {
    const matches = !query || normalizeMemberQuery(row.dataset.memberName ?? '').includes(query);
    row.hidden = !matches;
    if (matches) shown += 1;
  }
  const clear = root.querySelector<HTMLElement>('#server-members-search-clear');
  if (clear) clear.hidden = !input?.value;
  const empty = root.querySelector<HTMLElement>('[data-server-members-empty]');
  if (empty) empty.hidden = !query || shown > 0;
  const count = root.querySelector<HTMLElement>('[data-server-members-count]');
  if (count) {
    count.hidden = !query;
    count.textContent = query ? t('roles.membersShown', { shown, total: rows.length }) : '';
  }
}

export class ServerMembersTab {
  public renderHtml(): string {
    return `
      <div style="display: flex; flex-direction: column; gap: 16px; width: 100%;">
        <div data-settings-section="members" data-settings-label="${escapeHtml(t('roles.membersList'))}" style="background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 14px; overflow: visible;">
          <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 12px; flex-wrap: wrap;">
            <div>
              <div style="font-size: 13px; font-weight: 700; margin-bottom: 4px;">${t('roles.membersList')}</div>
              <div style="font-size: 11px; color: var(--text-muted);">${t('roles.membersTableHint')}</div>
            </div>
            <div class="members-search">
              <span class="material-symbols-outlined md-18 members-search-icon" aria-hidden="true">search</span>
              <input type="text" id="server-members-search" class="members-search-input" autocomplete="off" spellcheck="false"
                data-clear-on-escape placeholder="${escapeHtml(t('roles.searchMembersPlaceholder'))}"
                aria-label="${escapeHtml(t('roles.searchMembersPlaceholder'))}" aria-controls="server-members-table">
              <button type="button" id="server-members-search-clear" class="btn btn-icon members-search-clear"
                title="${escapeHtml(t('common.clear'))}" aria-label="${escapeHtml(t('common.clear'))}" hidden>
                <span class="material-symbols-outlined md-16" aria-hidden="true">close</span>
              </button>
            </div>
          </div>
          <div class="members-search-count" data-server-members-count role="status" aria-live="polite" hidden></div>
          <div class="settings-table-wrap">
            <table id="server-members-table" class="settings-data-table">
              <thead>
                <tr>
                  <th>${t('roles.memberColumn')}</th>
                  <th>${t('roles.rolesColumn')}</th>
                  <th style="width: 96px; text-align: right;">${t('roles.actionsColumn')}</th>
                </tr>
              </thead>
              <tbody>${this.renderRows()}</tbody>
            </table>
          </div>
          <div class="members-search-empty" data-server-members-empty hidden>${escapeHtml(t('roles.noMatchingMembers'))}</div>
        </div>
      </div>
    `;
  }

  /** The member rows alone: refreshing them keeps the search field and its focus. */
  public renderRows(): string {
    const roles = [...serverStore.roles].sort((a, b) => b.position - a.position);
    // Admin is toggled through its own action, never listed as a role (#265).
    const manageableRoles = roles.filter((role) => !role.isDefault && !serverStore.isAdminRole(role));
    const adminRole = serverStore.getAdminRole();
    const members = serverStore.getHumanMembersInDisplayOrder().sort((a, b) => a.nickname.localeCompare(b.nickname));
    const canKickMembers = serverStore.hasPermission(Permission.KICK_MEMBERS);

    return members.map((member) => {
      const userRoles = serverStore
        .getUserRoles(member.id)
        .filter((role) => !role.isDefault && !serverStore.isAdminRole(role));
      const avatar = getAvatarUrl(member.avatarUrl);
      const isAdmin = Boolean(adminRole && serverStore.getUserRoleIds(member.id).includes(adminRole.id));
      const isOwner = member.id === serverStore.ownerId;

      return html`
        <tr data-member-name="${member.nickname}">
          <td>
            <div style="display: flex; align-items: center; gap: 10px; min-width: 0;">
              <img src="${avatar}" alt="${member.nickname}" data-fallback="avatar" style="width: 40px; height: 40px; border-radius: 50%; object-fit: cover; border: 1px solid var(--border-color); flex-shrink: 0;">
              <div style="min-width: 0; display: flex; flex-direction: column; gap: 4px;">
                <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0;">
                  <span style="font-size: 13px; font-weight: 600; color: var(--text-primary); min-width: 0; overflow: hidden; text-overflow: ellipsis;">${member.nickname}</span>
                  ${member.id === serverStore.currentUser?.id ? html`<span class="member-badge-you">${t('common.you')}</span>` : ''}
                  ${isOwner ? html`<span class="member-badge-you">${t('roles.ownerBadge')}</span>` : ''}
                  ${member.status === 'DISCONNECTED' ? html`<span class="member-badge-offline">${t('roles.offlineBadge')}</span>` : ''}
                  ${isAdmin ? html`<span class="member-badge-you" style="background: rgba(88, 101, 242, 0.18); color: var(--accent-primary);">${t('roles.adminBadge')}</span>` : ''}
                </div>
              </div>
            </div>
          </td>
          <td>
            ${userRoles.length
              ? trustedHtml(renderRoleTags(userRoles, VISIBLE_ROLE_TAGS))
              : html`<span style="font-size: 11px; color: var(--text-muted);">${t('roles.noExtraRoles')}</span>`}
          </td>
          <td style="text-align: right;">
            <div class="settings-action-menu-wrap">
              <button type="button" class="btn btn-secondary btn-icon member-actions-trigger" data-user-id="${member.id}" title="${t('common.moreOptions')}" style="width: 32px; height: 32px; padding: 0; justify-content: center;">
                <span class="material-symbols-outlined md-18">more_horiz</span>
              </button>
              <div class="settings-action-menu">
                ${canKickMembers ? html`
                  <button type="button" class="settings-action-menu-item danger" data-member-action="kick" data-user-id="${member.id}" ${isOwner ? 'disabled' : ''}>
                    ${t('userMenu.kickMember')}
                  </button>
                ` : ''}
                ${adminRole ? html`
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
                  ${manageableRoles.length ? html`
                    <div class="settings-action-submenu">
                      ${manageableRoles.map((role) => html`
                        <button type="button" class="settings-action-menu-item" data-member-action="toggle-role" data-user-id="${member.id}" data-role-id="${role.id}" ${isOwner ? 'disabled' : ''}>
                          ${trustedHtml(renderRoleOption(role, serverStore.getUserRoleIds(member.id).includes(role.id)))}
                        </button>
                      `)}
                    </div>
                  ` : ''}
                </div>
              </div>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }
}
