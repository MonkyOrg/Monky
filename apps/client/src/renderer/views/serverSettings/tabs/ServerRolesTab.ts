import { Permission, MessageType, type Role, type RoleUpdatePayload, type RolesListPayload } from '@monky/shared';
import { serverStore } from '../../../stores/serverStore';
import { getAvatarUrl } from '../../../utils/avatar';
import { escapeHtml } from '../../../utils/html';
import { showAlert, showConfirm } from '../../Dialog';
import { t } from '../../../i18n';
import type { ServerSettingsContext } from '../ServerSettingsContext';
import { ServerMembersTab } from './ServerMembersTab';
import { ColorPicker } from '../../ColorPicker';
import { COLOR_PRESETS } from '../../../utils/colors';

export class ServerRolesTab {
  private draggedRoleId: string | null = null;
  private root: HTMLElement | null = null;
  private context: ServerSettingsContext | null = null;
  private cleanup: Array<() => void> = [];
  private stateSignature = '';
  private membersSignature = '';
  private dirtyName = false;
  private submittedName = '';
  private readonly colorPicker = new ColorPicker({ id: 'role-editor-color', label: 'roles.roleColor' });

  public renderHtml(): string {
    return `
      <div style="display: flex; flex-direction: column; gap: 16px; width: 100%;">
        <fieldset class="server-settings-fieldset" data-server-permission="${Permission.MANAGE_SERVER}">
        <div data-settings-section="role-badges" data-settings-label="${escapeHtml(t('roles.badgeVisibility'))}" style="display: flex; align-items: center; justify-content: space-between; background: var(--bg-card); padding: 12px 14px; border-radius: var(--radius-md); border: 1px solid var(--border-color);">
          <div>
            <label for="checkbox-show-role-badges" style="font-size: 13px; font-weight: 600; color: var(--text-primary); display: flex; align-items: center; gap: 6px; cursor: pointer; margin-bottom: 2px;">
              <span class="material-symbols-outlined md-18" style="color: var(--accent-primary);">visibility</span>
              <span>${t('roles.badgeVisibility')}</span>
            </label>
            <div style="font-size: 11px; color: var(--text-muted);">
              ${t('roles.badgeVisibilityDesc')}
            </div>
          </div>
          <label class="toggle-switch" aria-label="${t('roles.badgeVisibility')}">
            <input id="checkbox-show-role-badges" type="checkbox" ${serverStore.serverDetails?.showRoleBadgesToEveryone !== false ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
        </div>
        </fieldset>
        <fieldset class="server-settings-fieldset" data-server-permission="${Permission.MANAGE_ROLES}" style="display: flex; flex-direction: column; gap: 16px;">
        <div data-settings-section="roles" data-settings-label="${escapeHtml(t('roles.rolesList'))}" style="background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 14px; display: flex; flex-direction: column; gap: 12px; overflow: visible;">
          <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap;">
            <div>
              <div style="font-size: 13px; font-weight: 700; margin-bottom: 4px;">${t('roles.rolesList')}</div>
              <div style="font-size: 11px; color: var(--text-muted);">${t('roles.dragReorderHint')}</div>
            </div>
            <button type="button" id="btn-role-create-new" class="btn btn-primary">${t('roles.createRole')}</button>
          </div>
          <div class="settings-table-wrap">
            <table id="roles-list" class="settings-data-table">
              <thead>
                <tr>
                  <th>${t('roles.roleColumn')}</th>
                  <th>${t('roles.permissionsColumn')}</th>
                  <th style="width: 120px;">${t('roles.membersColumn')}</th>
                  <th style="width: 110px; text-align: right;">${t('roles.actionsColumn')}</th>
                </tr>
              </thead>
              <tbody>
                ${this.renderRoleRows()}
              </tbody>
            </table>
          </div>
        </div>

        <div id="role-editor-section" style="display: none; background: var(--bg-card); border: 1px solid color-mix(in srgb, var(--accent-primary) 35%, var(--border-color)); border-radius: var(--radius-md); padding: 16px; flex-direction: column; gap: 14px; box-shadow: 0 12px 32px rgba(0, 0, 0, 0.25);">
          <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap;">
            <div>
              <div id="role-editor-title" style="font-size: 15px; font-weight: 700; color: var(--text-primary);">${t('roles.editorNewTitle')}</div>
              <div style="font-size: 11px; color: var(--text-muted); margin-top: 4px;">${t('serverSettings.roleImmediateHint')}</div>
            </div>
          </div>
          <input type="hidden" id="role-editor-id">
          <div style="display: flex; gap: 8px; flex-wrap: wrap; border-bottom: 1px solid var(--border-color); padding-bottom: 6px;">
            <button type="button" class="role-editor-tab-btn active" data-role-editor-tab="display">${t('roles.displayTab')}</button>
            <button type="button" class="role-editor-tab-btn" data-role-editor-tab="permissions">${t('roles.permissionsTab')}</button>
            <button type="button" class="role-editor-tab-btn" data-role-editor-tab="members">${t('roles.membersTab')}</button>
          </div>
          <div id="role-editor-tab-display" data-settings-section="role-display" data-settings-label="${escapeHtml(t('roles.displayTab'))}" class="role-editor-tab-panel" style="display: flex; flex-direction: column; gap: 12px;">
            <div class="form-group" style="margin-bottom: 0;">
              <label>${t('roles.roleName')}</label>
              <input id="role-editor-name" type="text" maxlength="32" placeholder="${t('roles.roleNamePlaceholder')}">
            </div>
            <div style="display: flex; flex-direction: column; gap: 8px;">
              <label for="role-editor-color" style="font-size: 12px; font-weight: 600; color: var(--text-primary);">${t('roles.roleColor')}</label>
              <div style="font-size: 11px; color: var(--text-muted);">${t('roles.colorPaletteHint')}</div>
              ${this.colorPicker.renderHtml(COLOR_PRESETS[0])}
            </div>
            <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; border: 1px solid var(--border-color); border-radius: var(--radius-md); background: var(--bg-secondary);">
              <div style="min-width: 0;">
                <div style="font-size: 12px; font-weight: 600; color: var(--text-primary);">${t('roles.autoAssign')}</div>
                <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">${t('roles.autoAssignEditorHint')}</div>
              </div>
              <label class="permission-switch" aria-label="${t('roles.autoAssign')}">
                <input type="checkbox" id="role-editor-is-default">
                <span class="slider"></span>
              </label>
            </div>
          </div>
          <div id="role-editor-tab-permissions" data-settings-section="role-permissions" data-settings-label="${escapeHtml(t('roles.permissionsTab'))}" class="role-editor-tab-panel" style="display: none; flex-direction: column; gap: 10px;">
            ${this.renderPermissionSwitches()}
          </div>
          <div id="role-editor-tab-members" data-settings-section="role-members" data-settings-label="${escapeHtml(t('roles.membersTab'))}" class="role-editor-tab-panel" style="display: none; flex-direction: column; gap: 10px;">
            <div id="role-editor-members-panel">${this.renderRoleMembersEditorPanel()}</div>
          </div>
          <div style="display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end;">
            <button type="button" id="btn-role-done" class="btn btn-secondary">${t('common.done')}</button>
            <button type="button" id="btn-role-delete" class="btn btn-danger">${t('common.delete')}</button>
            <button type="button" id="btn-role-save" class="btn btn-primary">${t('roles.createRole')}</button>
          </div>
        </div>
        </fieldset>
      </div>
    `;
  }

  private renderRoleRows(): string {
    const roles = serverStore.getVisibleRoles().sort((a, b) => b.position - a.position);
    const members = serverStore.getAllMembersInDisplayOrder();
    return roles.map((role) => `
      <tr class="role-table-row" data-role-id="${role.id}" draggable="true">
        <td><div style="display: flex; align-items: center; gap: 10px; min-width: 0;">
          <span class="material-symbols-outlined md-16" title="${t('roles.dragReorderHint')}" style="color: var(--text-muted); cursor: grab;">drag_indicator</span>
          <span style="width: 12px; height: 12px; border-radius: 50%; background: ${role.color || 'var(--text-muted)'}; flex-shrink: 0;"></span>
          <span style="font-size: 13px; font-weight: 600;">${escapeHtml(role.name)}</span>
          ${role.isDefault ? `<span class="member-badge-you">${t('roles.autoBadge')}</span>` : ''}
        </div></td>
        <td style="font-size: 12px;">${escapeHtml(this.describeRolePermissions(role))}</td>
        <td class="role-member-count" data-role-count="${role.id}">${members.filter((member) => serverStore.getUserRoleIds(member.id).includes(role.id)).length}</td>
        <td style="text-align: right;"><button type="button" class="btn btn-secondary role-open-btn" data-role-open="${role.id}">${t('common.edit')}</button></td>
      </tr>`).join('');
  }

  private describeRolePermissions(role: Role): string {
    if (role.permissions & Permission.ADMINISTRATOR) {
      return t('permissions.administrator');
    }
    const labels: string[] = [];
    if (role.permissions & Permission.MANAGE_SERVER) labels.push(t('permissions.manageServer'));
    if (role.permissions & Permission.MANAGE_CHANNELS) labels.push(t('permissions.manageChannels'));
    if (role.permissions & Permission.MANAGE_ROLES) labels.push(t('permissions.manageRoles'));
    if (role.permissions & Permission.MANAGE_BOTS) labels.push(t('permissions.manageBots'));
    if (role.permissions & Permission.CONFIGURE_BOTS) labels.push(t('permissions.configureBots'));
    if (role.permissions & Permission.USE_BOT_COMMANDS) labels.push(t('permissions.useBotCommands'));
    if (role.permissions & Permission.SPEAK) labels.push(t('permissions.speak'));
    return labels.slice(0, 3).join(', ') || t('roles.noPermissions');
  }

  private renderPermissionSwitches(): string {
    const items: Array<{ key: Permission; label: string; description: string }> = [
      { key: Permission.MANAGE_CHANNELS, label: t('permissions.manageChannels'), description: t('permissions.manageChannelsDesc') },
      { key: Permission.MANAGE_SERVER, label: t('permissions.manageServer'), description: t('permissions.manageServerDesc') },
      { key: Permission.MANAGE_ROLES, label: t('permissions.manageRoles'), description: t('permissions.manageRolesDesc') },
      { key: Permission.KICK_MEMBERS, label: t('permissions.kickMembers'), description: t('permissions.kickMembersDesc') },
      { key: Permission.SPEAK, label: t('permissions.speak'), description: t('permissions.speakDesc') },
      { key: Permission.MUTE_MEMBERS, label: t('permissions.muteMembers'), description: t('permissions.muteMembersDesc') },
      { key: Permission.DEAFEN_MEMBERS, label: t('permissions.deafenMembers'), description: t('permissions.deafenMembersDesc') },
      { key: Permission.MOVE_MEMBERS, label: t('permissions.moveMembers'), description: t('permissions.moveMembersDesc') },
      { key: Permission.SEND_MESSAGES, label: t('permissions.sendMessages'), description: t('permissions.sendMessagesDesc') },
      { key: Permission.READ_MESSAGES, label: t('permissions.readMessages'), description: t('permissions.readMessagesDesc') },
      { key: Permission.ATTACH_FILES, label: t('permissions.attachFiles'), description: t('permissions.attachFilesDesc') },
      { key: Permission.USE_SOUNDBOARD, label: t('permissions.useSoundboard'), description: t('permissions.useSoundboardDesc') },
      { key: Permission.MANAGE_BOTS, label: t('permissions.manageBots'), description: t('permissions.manageBotsDesc') },
      { key: Permission.CONFIGURE_BOTS, label: t('permissions.configureBots'), description: t('permissions.configureBotsDesc') },
      { key: Permission.USE_BOT_COMMANDS, label: t('permissions.useBotCommands'), description: t('permissions.useBotCommandsDesc') },
    ];

    return items.map((item) => `
      <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; border: 1px solid var(--border-color); border-radius: var(--radius-md); background: var(--bg-secondary);">
        <div style="min-width: 0;">
          <div style="font-size: 12px; font-weight: 600; color: var(--text-primary);">${item.label}</div>
          <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">${item.description}</div>
        </div>
        <label class="permission-switch" aria-label="${item.label}">
          <input type="checkbox" class="role-permission-switch" data-permission="${item.key}">
          <span class="slider"></span>
        </label>
      </div>
    `).join('');
  }

  public renderRoleMembersEditorPanel(roleId?: string): string {
    if (!roleId) {
      return `
        <div style="padding: 16px; border: 1px dashed var(--border-color); border-radius: var(--radius-md); background: var(--bg-secondary); font-size: 12px; color: var(--text-muted); text-align: center;">
          ${t('roles.membersTabHint')}
        </div>
      `;
    }

    // A role belongs to the person, not to the connection, so offline members
    // have to be listed too. This helper forces the right presence state on
    // people who dropped mid-session (#477).
    const members = serverStore.getAllMembersInDisplayOrder();

    return `
      <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 10px;">${t('roles.membersEditorHint')}</div>
      <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px;">
        <input type="text" id="role-members-search" class="role-members-search" placeholder="${t('roles.searchMembersPlaceholder')}" autocomplete="off">
        <span id="role-members-count" style="font-size: 11px; color: var(--text-muted); white-space: nowrap;">${t('roles.membersShown', { shown: members.length, total: members.length })}</span>
        <div style="display: flex; gap: 6px; margin-left: auto;">
          <button type="button" class="btn btn-secondary role-members-bulk" data-bulk-assign="true" data-role-id="${roleId}">${t('roles.bulkAssign')}</button>
          <button type="button" class="btn btn-secondary role-members-bulk" data-bulk-assign="false" data-role-id="${roleId}">${t('roles.bulkUnassign')}</button>
        </div>
      </div>
      <div class="settings-table-wrap">
        <table class="settings-data-table">
          <thead>
            <tr>
              <th>${t('roles.memberColumn')}</th>
              <th style="width: 100px; text-align: center;">${t('roles.assignedColumn')}</th>
            </tr>
          </thead>
          <tbody id="role-members-tbody">
            ${members.map((member) => {
              const assigned = serverStore.getUserRoleIds(member.id).includes(roleId);
              const offline = member.status === 'DISCONNECTED';
              return `
                <tr class="role-member-row" data-member-name="${escapeHtml(member.nickname.toLowerCase())}">
                  <td>
                    <div style="display: flex; align-items: center; gap: 10px; min-width: 0;">
                      <img src="${getAvatarUrl(member.avatarUrl)}" alt="${escapeHtml(member.nickname)}" data-fallback="avatar" style="width: 34px; height: 34px; border-radius: 50%; object-fit: cover; border: 1px solid var(--border-color); flex-shrink: 0; ${offline ? 'opacity: 0.5;' : ''}">
                      <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0;">
                        <span style="font-size: 13px; font-weight: 600; color: var(--text-primary); min-width: 0; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(member.nickname)}</span>
                        ${member.id === serverStore.currentUser?.id ? `<span class="member-badge-you">${t('common.you')}</span>` : ''}
                        ${member.id === serverStore.ownerId ? `<span class="member-badge-you">${t('roles.ownerBadge')}</span>` : ''}
                        ${offline ? `<span class="member-badge-offline">${t('roles.offlineBadge')}</span>` : ''}
                      </div>
                    </div>
                  </td>
                  <td style="text-align: center;">
                    <label class="permission-switch" aria-label="${t('roles.assignedColumn')}">
                      <input type="checkbox" class="role-editor-member-switch" data-user-id="${member.id}" data-role-id="${roleId}" ${assigned ? 'checked' : ''}>
                      <span class="slider"></span>
                    </label>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  private animateRoleRowsWhile(tbody: HTMLElement, mutate: () => void): void {
    const rows = Array.from(tbody.querySelectorAll('.role-table-row')) as HTMLElement[];
    const previousTops = new Map(rows.map((row) => [row, row.getBoundingClientRect().top]));

    mutate();

    rows.forEach((row) => {
      const previousTop = previousTops.get(row);
      if (previousTop === undefined) return;
      const delta = previousTop - row.getBoundingClientRect().top;
      if (Math.abs(delta) < 1) return;

      row.style.transition = 'none';
      row.style.transform = `translateY(${delta}px)`;
      requestAnimationFrame(() => {
        row.style.transition = 'transform 0.18s ease';
        row.style.transform = '';
      });
    });
  }

  public attachEvents(container: HTMLElement, context: ServerSettingsContext): void {
    this.detachEvents();
    this.root = container;
    this.context = context;
    this.colorPicker.attachEvents(container, color => {
      const roleId = this.editorRoleId();
      if (roleId) this.updateRole(roleId, () => ({ roleId, color }));
      this.syncColor(color);
    });
    const controller = new AbortController();
    this.cleanup.push(() => controller.abort());
    const options = { signal: controller.signal };
    const name = container.querySelector<HTMLInputElement>('#role-editor-name');
    const commitName = () => {
      const roleId = this.editorRoleId();
      if (!name || !roleId) return;
      this.dirtyName = false;
      if (name.value === this.submittedName) return;
      this.submittedName = name.value;
      const nextName = name.value.trim();
      this.updateRole(roleId, () => ({ roleId, name: nextName }));
    };
    name?.addEventListener('blur', commitName, options);
    name?.addEventListener('change', commitName, options);
    name?.addEventListener('input', () => { this.dirtyName = true; }, options);
    name?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); commitName(); name.blur(); }
    }, options);
    const closeMenus = () => {
      for (const className of ['show', 'open', 'menu-open', 'row-menu-open']) {
        container.querySelectorAll(`.settings-action-menu.${className}, .settings-action-submenu-wrap.${className}, .settings-action-menu-wrap.${className}, tr.${className}`)
          .forEach((element) => element.classList.remove(className));
      }
    };
    container.addEventListener('click', (event) => {
      if (!(event.target instanceof HTMLElement) || !context.isCurrent()) return;
      const target = event.target.closest<HTMLButtonElement>('button');
      if (!target || target.matches(':disabled')) return;
      if (target.id === 'btn-role-create-new') this.openEditor();
      else if (target.id === 'btn-role-done') {
        name?.blur();
        if (!context.operations.isPending(`role:${this.editorRoleId()}`) && !context.operations.isPending('role-create')) this.hideEditor();
      } else if (target.id === 'btn-role-save') this.createRole();
      else if (target.id === 'btn-role-delete') {
        const roleId = this.editorRoleId();
        if (roleId) void context.operations.run(`role:${roleId}`, t('roles.rolesList'), Permission.MANAGE_ROLES,
          () => context.request<RolesListPayload>(MessageType.ROLE_DELETE, { roleId }, Permission.MANAGE_ROLES));
      } else if (target.dataset.roleOpen) this.openEditor(context.store.getRole(target.dataset.roleOpen));
      else if (target.dataset.roleEditorTab) {
        const tab = target.dataset.roleEditorTab;
        container.querySelectorAll<HTMLButtonElement>('.role-editor-tab-btn').forEach((button) => button.classList.toggle('active', button === target));
        container.querySelectorAll<HTMLElement>('.role-editor-tab-panel').forEach((panel) => {
          panel.style.display = panel.id === `role-editor-tab-${tab}` ? 'flex' : 'none';
        });
      } else if (target.classList.contains('role-members-bulk') && target.dataset.roleId) {
        this.applyBulkRoleChange(container, target.dataset.roleId, target.dataset.bulkAssign === 'true');
      } else if (target.classList.contains('member-actions-trigger')) {
        const wrap = target.closest('.settings-action-menu-wrap');
        const menu = wrap?.querySelector('.settings-action-menu');
        const willShow = !menu?.classList.contains('show');
        closeMenus();
        if (willShow) {
          menu?.classList.add('show');
          wrap?.classList.add('menu-open');
          target.closest('tr')?.classList.add('row-menu-open');
        }
      } else if (target.dataset.memberAction && target.dataset.userId) {
        const userId = target.dataset.userId;
        const roleId = target.dataset.roleId;
        if (target.dataset.memberAction === 'kick') {
          void context.operations.run(`kick:${userId}`, t('userMenu.kickMember'), Permission.KICK_MEMBERS,
            () => context.request<unknown>(MessageType.MEMBER_KICK, { targetUserId: userId }, Permission.KICK_MEMBERS));
        } else if (roleId) {
          this.assignRole(userId, roleId, !context.store.getUserRoleIds(userId).includes(roleId));
        }
        closeMenus();
      } else if (target.closest('.settings-action-submenu-wrap')) {
        target.closest('.settings-action-submenu-wrap')?.classList.toggle('open');
      } else if (!target.closest('.settings-action-menu-wrap')) closeMenus();
    }, options);
    container.addEventListener('input', (event) => {
      if (event.target instanceof HTMLInputElement && event.target.id === 'role-members-search') {
        this.filterMemberRows(container, event.target.value);
      }
    }, options);
    container.addEventListener('change', (event) => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement) || input.matches(':disabled')) return;
      const roleId = this.editorRoleId();
      if (input.classList.contains('role-editor-member-switch') && input.dataset.roleId && input.dataset.userId) {
        this.assignRole(input.dataset.userId, input.dataset.roleId, input.checked);
      } else if (roleId && input.id === 'role-editor-is-default') {
        const isDefault = input.checked;
        this.updateRole(roleId, () => ({ roleId, isDefault }));
      } else if (roleId && input.classList.contains('role-permission-switch')) {
        const bit = Number(input.dataset.permission);
        const enabled = input.checked;
        this.updateRole(roleId, (role) => ({
          roleId, permissions: enabled ? role.permissions | bit : role.permissions & ~bit,
        }));
      }
    }, options);
    const body = container.querySelector<HTMLElement>('#roles-list tbody');
    let previousOrder: string[] = [];
    const order = () => [...container.querySelectorAll<HTMLElement>('.role-table-row')].map((row) => row.dataset.roleId ?? '');
    container.addEventListener('dragstart', (event) => {
      const row = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('.role-table-row') : null;
      if (!row) return;
      if (!context.isCurrent() || !context.store.hasPermission(Permission.MANAGE_ROLES) || context.operations.isPending('role-order')) {
        event.preventDefault();
        return;
      }
      this.draggedRoleId = row.dataset.roleId ?? null;
      previousOrder = order();
      row.classList.add('role-row-dragging');
      event.dataTransfer?.setData('text/plain', this.draggedRoleId ?? '');
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    }, options);
    container.addEventListener('dragover', (event) => {
      const row = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('.role-table-row') : null;
      if (!body || !row || !this.draggedRoleId) return;
      const dragged = [...body.querySelectorAll<HTMLElement>('.role-table-row')].find((item) => item.dataset.roleId === this.draggedRoleId);
      if (!dragged || dragged === row) return;
      event.preventDefault();
      const rect = row.getBoundingClientRect();
      const reference = event.clientY > rect.top + rect.height / 2 ? row.nextElementSibling : row;
      if (reference !== dragged) this.animateRoleRowsWhile(body, () => body.insertBefore(dragged, reference));
    }, options);
    container.addEventListener('drop', (event) => { if (this.draggedRoleId) event.preventDefault(); }, options);
    container.addEventListener('dragend', () => {
      if (!this.draggedRoleId) return;
      this.draggedRoleId = null;
      container.querySelector('.role-row-dragging')?.classList.remove('role-row-dragging');
      const ordered = order();
      this.stateSignature = '';
      this.membersSignature = '';
      if (ordered.join() === previousOrder.join()) { this.refreshState(); return; }
      void context.operations.run('role-order', t('roles.dragReorderHint'), Permission.MANAGE_ROLES, async () => {
        for (const [index, roleId] of ordered.entries()) {
          await context.request<RolesListPayload>(
            MessageType.ROLE_UPDATE, { roleId, position: ordered.length - index }, Permission.MANAGE_ROLES,
          );
        }
      });
    }, options);
    this.hideEditor();
    this.refreshState();
  }

  public detachEvents(): void {
    for (const dispose of this.cleanup) dispose();
    this.cleanup = [];
    this.colorPicker.cleanup();
    this.root = null;
    this.context = null;
    this.stateSignature = '';
    this.draggedRoleId = null;
    this.dirtyName = false;
    this.submittedName = '';
  }

  private editorRoleId(): string {
    return this.root?.querySelector<HTMLInputElement>('#role-editor-id')?.value ?? '';
  }

  private hideEditor(): void {
    this.colorPicker.close(false, false);
    const editor = this.root?.querySelector<HTMLElement>('#role-editor-section');
    if (editor) editor.style.display = 'none';
    const id = this.root?.querySelector<HTMLInputElement>('#role-editor-id');
    if (id) id.value = '';
    this.dirtyName = false;
  }

  private openEditor(role?: Role): void {
    const root = this.root;
    if (!root || this.context?.operations.isPending('role-create')) return;
    const editor = root.querySelector<HTMLElement>('#role-editor-section');
    const id = root.querySelector<HTMLInputElement>('#role-editor-id');
    const name = root.querySelector<HTMLInputElement>('#role-editor-name');
    if (!editor || !id || !name) return;
    this.colorPicker.close(false, false);
    editor.style.display = 'flex';
    id.value = role?.id ?? '';
    name.value = role?.name ?? '';
    this.submittedName = name.value;
    this.dirtyName = false;
    const auto = root.querySelector<HTMLInputElement>('#role-editor-is-default');
    if (auto) auto.checked = role?.isDefault ?? false;
    this.syncColor(role?.color ?? COLOR_PRESETS[0]);
    root.querySelectorAll<HTMLInputElement>('.role-permission-switch').forEach((input) => {
      input.checked = Boolean((role?.permissions ?? 0) & Number(input.dataset.permission));
    });
    const panel = root.querySelector('#role-editor-members-panel');
    if (panel) panel.innerHTML = this.renderRoleMembersEditorPanel(role?.id);
    this.membersSignature = '';
    const title = root.querySelector('#role-editor-title');
    if (title) title.textContent = role ? t('roles.editorEditTitle', { name: role.name }) : t('roles.editorNewTitle');
    root.querySelector<HTMLButtonElement>('[data-role-editor-tab="display"]')?.click();
    this.refreshState();
    editor.scrollIntoView({ block: 'nearest' });
    name.focus();
  }

  private syncColor(color: string): void {
    this.colorPicker.setValue(color);
  }

  private updateRole(roleId: string, patch: (role: Role) => RoleUpdatePayload): void {
    const context = this.context;
    if (!context) return;
    void context.operations.run(`role:${roleId}`, t('roles.rolesList'), Permission.MANAGE_ROLES, async () => {
      const role = context.store.getRole(roleId);
      if (!role) throw new Error(t('serverSettings.roleUnavailable'));
      const payload = patch(role);
      if (payload.name !== undefined && (!payload.name.trim() || payload.name.length > 32)) {
        throw new Error(t('serverSettings.roleNameInvalid'));
      }
      await context.request<RolesListPayload>(MessageType.ROLE_UPDATE, payload, Permission.MANAGE_ROLES);
    });
  }

  private createRole(): void {
    const context = this.context;
    const root = this.root;
    if (!context || !root || this.editorRoleId() || context.operations.isPending('role-create')) return;
    const name = root.querySelector<HTMLInputElement>('#role-editor-name')?.value.trim() ?? '';
    const color = root.querySelector<HTMLButtonElement>('#role-editor-color')?.value ?? COLOR_PRESETS[0];
    const isDefault = Boolean(root.querySelector<HTMLInputElement>('#role-editor-is-default')?.checked);
    let permissions = 0;
    root.querySelectorAll<HTMLInputElement>('.role-permission-switch:checked').forEach((input) => { permissions |= Number(input.dataset.permission); });
    void context.operations.run('role-create', t('roles.createRole'), Permission.MANAGE_ROLES, async () => {
      if (!name || name.length > 32) throw new Error(t('serverSettings.roleNameInvalid'));
      await context.request<RolesListPayload>(MessageType.ROLE_CREATE, { name, color, isDefault, permissions }, Permission.MANAGE_ROLES);
      if (context.isCurrent()) this.hideEditor();
    });
  }

  private assignRole(userId: string, roleId: string, assign: boolean): void {
    const context = this.context;
    if (!context) return;
    void context.operations.run(`assignment:${userId}:${roleId}`, t('roles.assignedColumn'), Permission.MANAGE_ROLES, async () => {
      await context.request<RolesListPayload>(
        assign ? MessageType.ROLE_ASSIGN : MessageType.ROLE_UNASSIGN, { userId, roleId }, Permission.MANAGE_ROLES,
      );
    });
  }

  public refreshState(): void {
    const root = this.root;
    const context = this.context;
    if (!root || !context?.isCurrent()) return;
    const { store, operations } = context;
    const signature = JSON.stringify([store.roles, store.userRoles, store.serverDetails?.members, [...store.knownMembers]]);
    if (signature !== this.stateSignature && !this.draggedRoleId && !operations.isPending('role-order')) {
      this.stateSignature = signature;
      const body = root.querySelector('#roles-list tbody');
      if (body) body.innerHTML = this.renderRoleRows();
      const members = root.querySelector('#tab-panel-members > fieldset');
      if (members) members.innerHTML = new ServerMembersTab().renderHtml();
    }
    const roleId = this.editorRoleId();
    const role = roleId ? store.getRole(roleId) : undefined;
    const creating = operations.isPending('role-create');
    const pendingRole = operations.isPending(`role:${roleId}`);
    const editor = root.querySelector<HTMLElement>('#role-editor-section');
    editor?.setAttribute('aria-busy', String(creating || pendingRole));
    if (roleId && !role && !pendingRole) this.hideEditor();
    const memberSignature = `${roleId}:${signature}`;
    if (role && this.membersSignature !== memberSignature && !operations.pendingCount) {
      const panel = root.querySelector('#role-editor-members-panel');
      const search = root.querySelector<HTMLInputElement>('#role-members-search');
      const query = search?.value ?? '';
      const hadFocus = document.activeElement === search;
      if (panel) panel.innerHTML = this.renderRoleMembersEditorPanel(roleId);
      const nextSearch = root.querySelector<HTMLInputElement>('#role-members-search');
      if (nextSearch) { nextSearch.value = query; if (hadFocus) nextSearch.focus(); }
      this.filterMemberRows(root, query);
      this.membersSignature = memberSignature;
    }
    const save = root.querySelector<HTMLButtonElement>('#btn-role-save');
    if (save) { save.hidden = Boolean(roleId); save.disabled = creating; }
    const remove = root.querySelector<HTMLButtonElement>('#btn-role-delete');
    if (remove) remove.disabled = !role || pendingRole ||
      ((role.isDefault || store.isAdminRole(role)) && store.currentUser?.id !== store.ownerId);
    root.querySelectorAll<HTMLInputElement | HTMLButtonElement>('#role-editor-name, #role-editor-is-default, .role-permission-switch').forEach((input) => {
      input.disabled = creating;
    });
    this.colorPicker.setDisabled(creating || !store.hasPermission(Permission.MANAGE_ROLES));
    if (role && !pendingRole) {
      const name = root.querySelector<HTMLInputElement>('#role-editor-name');
      if (name && !this.dirtyName) { name.value = role.name; this.submittedName = name.value; }
      const auto = root.querySelector<HTMLInputElement>('#role-editor-is-default');
      if (auto) auto.checked = role.isDefault;
      this.syncColor(role.color ?? COLOR_PRESETS[0]);
      root.querySelectorAll<HTMLInputElement>('.role-permission-switch').forEach((input) => {
        input.checked = Boolean(role.permissions & Number(input.dataset.permission));
      });
      const title = root.querySelector('#role-editor-title');
      if (title) title.textContent = t('roles.editorEditTitle', { name: role.name });
    }
    root.querySelectorAll<HTMLInputElement>('.role-editor-member-switch').forEach((input) => {
      const userId = input.dataset.userId ?? '';
      const assignedRole = input.dataset.roleId ?? '';
      const pending = operations.isPending(`assignment:${userId}:${assignedRole}`) || operations.isPending(`bulk:${assignedRole}`);
      input.setAttribute('aria-busy', String(pending));
      if (!pending) input.checked = store.getUserRoleIds(userId).includes(assignedRole);
    });
  }

  /** Hides member rows that don't match the search box (#477). */
  private filterMemberRows(container: HTMLElement, query: string): void {
    const term = query.trim().toLowerCase();
    const rows = Array.from(container.querySelectorAll('.role-member-row')) as HTMLElement[];
    let shown = 0;
    rows.forEach((row) => {
      const name = row.dataset.memberName ?? '';
      const matches = term.length === 0 || name.includes(term);
      row.style.display = matches ? '' : 'none';
      if (matches) shown += 1;
    });

    const counter = container.querySelector('#role-members-count');
    if (counter) {
      counter.textContent = t('roles.membersShown', { shown, total: rows.length });
    }
  }

  /**
   * Applies one role change to every member matching the current search, so a
   * whole group can be added or removed in one go (#477).
   */
  private applyBulkRoleChange(container: HTMLElement, roleId: string, assign: boolean): void {
    const context = this.context;
    if (!context || context.operations.isPending(`bulk:${roleId}`)) return;
    const switches = (Array.from(
      container.querySelectorAll(`.role-editor-member-switch[data-role-id="${roleId}"]`)
    ) as HTMLInputElement[]).filter((input) => {
      const row = input.closest('.role-member-row') as HTMLElement | null;
      const visible = !row || row.style.display !== 'none';
      return visible && input.checked !== assign;
    });

    if (switches.length === 0) {
      void showAlert({ message: t('roles.bulkNothingToDo'), variant: 'warning' });
      return;
    }

    const userIds = switches.map((input) => input.dataset.userId).filter((id): id is string => Boolean(id));
    void context.operations.run(`bulk:${roleId}`, t(assign ? 'roles.bulkAssign' : 'roles.bulkUnassign'), Permission.MANAGE_ROLES, async () => {
      const confirmed = await showConfirm({
        title: assign ? t('roles.bulkAssign') : t('roles.bulkUnassign'),
        message: t(assign ? 'roles.bulkAssignConfirm' : 'roles.bulkUnassignConfirm', { count: userIds.length }),
        variant: assign ? 'info' : 'danger',
      });
      if (!confirmed) return;
      const errors: string[] = [];
      for (const userId of userIds) {
        context.assertAllowed(Permission.MANAGE_ROLES);
        if (context.store.getUserRoleIds(userId).includes(roleId) === assign) continue;
        try {
          await context.request<RolesListPayload>(
            assign ? MessageType.ROLE_ASSIGN : MessageType.ROLE_UNASSIGN, { userId, roleId }, Permission.MANAGE_ROLES,
          );
        } catch (error) {
          errors.push(error instanceof Error ? error.message : t('serverSettings.saveError'));
        }
      }
      if (errors.length) throw new Error(t('serverSettings.bulkFailed', { count: errors.length, error: errors[0] }));
    });
  }
}
