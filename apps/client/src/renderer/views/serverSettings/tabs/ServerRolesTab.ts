import { Permission, Role, MessageType } from '@monky/shared';
import { serverStore } from '../../../stores/serverStore';
import { networkClient } from '../../../core/NetworkClient';
import { getAvatarUrl } from '../../../utils/avatar';
import { escapeHtml } from '../../../utils/html';
import { showAlert, showConfirm } from '../../Dialog';
import { t } from '../../../i18n';

export class ServerRolesTab {
  private draggedRoleId: string | null = null;

  public renderHtml(): string {
    const roles: Role[] = serverStore.getVisibleRoles().sort((a: Role, b: Role) => b.position - a.position);
    // Counting only live connections made the column lie about roles held by
    // people who happen to be offline (#477).
    const members = serverStore.getAllMembersInDisplayOrder();

    return `
      <div style="display: flex; flex-direction: column; gap: 16px; width: 100%;">
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
                ${roles.map((role: Role) => {
                  const assignedMembers = members.filter((member) => serverStore.getUserRoleIds(member.id).includes(role.id)).length;
                  return `
                    <tr class="role-table-row" data-role-id="${role.id}" draggable="true">
                      <td>
                        <div style="display: flex; align-items: center; gap: 10px; min-width: 0;">
                          <span class="material-symbols-outlined md-16" title="${t('roles.dragReorderHint')}" style="color: var(--text-muted); cursor: grab; flex-shrink: 0;">drag_indicator</span>
                          <span style="width: 12px; height: 12px; border-radius: 50%; background: ${role.color || 'var(--text-muted)'}; border: 1px solid rgba(255, 255, 255, 0.12); flex-shrink: 0;"></span>
                          <span style="font-size: 13px; font-weight: 600; color: var(--text-primary); min-width: 0; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(role.name)}</span>
                          ${role.isDefault ? `<span class="member-badge-you" style="background: rgba(35, 165, 90, 0.18); color: var(--success);">${t('roles.autoBadge')}</span>` : ''}
                        </div>
                      </td>
                      <td style="font-size: 12px; color: var(--text-secondary);">${escapeHtml(this.describeRolePermissions(role))}</td>
                      <td class="role-member-count" data-role-count="${role.id}" style="font-size: 12px; color: var(--text-secondary);">${assignedMembers}</td>
                      <td style="text-align: right;">
                        <button type="button" class="btn btn-secondary role-open-btn" data-role-open="${role.id}">${t('common.edit')}</button>
                      </td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
        </div>

        <div id="role-editor-section" style="display: none; background: var(--bg-card); border: 1px solid color-mix(in srgb, var(--accent-primary) 35%, var(--border-color)); border-radius: var(--radius-md); padding: 16px; flex-direction: column; gap: 14px; box-shadow: 0 12px 32px rgba(0, 0, 0, 0.25);">
          <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap;">
            <div>
              <div id="role-editor-title" style="font-size: 15px; font-weight: 700; color: var(--text-primary);">${t('roles.editorNewTitle')}</div>
              <div style="font-size: 11px; color: var(--text-muted); margin-top: 4px;">${t('roles.editorPanelHint')}</div>
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
              <div style="font-size: 12px; font-weight: 600; color: var(--text-primary);">${t('roles.roleColor')}</div>
              <div style="font-size: 11px; color: var(--text-muted);">${t('roles.colorPaletteHint')}</div>
              ${this.renderRoleColorPalette('#5865f2')}
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
            <button type="button" id="btn-role-cancel" class="btn btn-secondary">${t('common.cancel')}</button>
            <button type="button" id="btn-role-delete" class="btn btn-danger">${t('common.delete')}</button>
            <button type="button" id="btn-role-save" class="btn btn-primary">${t('roles.createRole')}</button>
          </div>
        </div>
      </div>
    `;
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
    if (role.permissions & Permission.USE_BOT_COMMANDS) labels.push(t('permissions.useBotCommands'));
    if (role.permissions & Permission.SPEAK) labels.push(t('permissions.speak'));
    return labels.slice(0, 3).join(', ') || t('roles.noPermissions');
  }

  private getRoleColorPalette(): string[] {
    return [
      '#5865f2',
      '#57f287',
      '#fee75c',
      '#eb459e',
      '#ed4245',
      '#f47b67',
      '#9b59b6',
      '#1abc9c',
      '#3498db',
      '#e91e63',
      '#95a5a6',
      '#e67e22',
    ];
  }

  private renderRoleColorPalette(selectedColor: string): string {
    return `
      <input type="hidden" id="role-editor-color" value="${selectedColor}">
      <div style="display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--border-color); border-radius: var(--radius-md); background: var(--bg-secondary); margin-bottom: 10px;">
        <span id="role-editor-color-preview" style="width: 16px; height: 16px; border-radius: 50%; background: ${selectedColor}; border: 1px solid rgba(255, 255, 255, 0.14); flex-shrink: 0;"></span>
        <span id="role-editor-color-code" style="font-size: 12px; color: var(--text-secondary); font-family: var(--font-mono);">${selectedColor}</span>
      </div>
      <div style="display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px;">
        ${this.getRoleColorPalette().map((color) => `
          <button type="button" class="role-color-swatch ${color === selectedColor ? 'active' : ''}" data-role-color="${color}" style="--role-swatch-color: ${color};" title="${color}" aria-label="${color}"></button>
        `).join('')}
      </div>
    `;
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

  public attachEvents(container: HTMLElement, onReload: () => void): void {
    if (!serverStore.hasPermission(Permission.MANAGE_ROLES)) return;

    const list = container.querySelector('#roles-list') as HTMLElement | null;
    const editorSection = container.querySelector('#role-editor-section') as HTMLElement | null;
    const editorTitle = container.querySelector('#role-editor-title') as HTMLElement | null;
    const editorMembersPanel = container.querySelector('#role-editor-members-panel') as HTMLElement | null;
    const inputId = container.querySelector('#role-editor-id') as HTMLInputElement | null;
    const inputName = container.querySelector('#role-editor-name') as HTMLInputElement | null;
    const inputColor = container.querySelector('#role-editor-color') as HTMLInputElement | null;
    const inputAutoAssign = container.querySelector('#role-editor-is-default') as HTMLInputElement | null;
    const colorPreview = container.querySelector('#role-editor-color-preview') as HTMLElement | null;
    const colorCode = container.querySelector('#role-editor-color-code') as HTMLElement | null;
    const btnCreateNew = container.querySelector('#btn-role-create-new') as HTMLButtonElement | null;
    const btnSave = container.querySelector('#btn-role-save') as HTMLButtonElement | null;
    const btnDelete = container.querySelector('#btn-role-delete') as HTMLButtonElement | null;
    const btnRoleCancel = container.querySelector('#btn-role-cancel') as HTMLButtonElement | null;
    const palette = this.getRoleColorPalette();

    const closeActionMenus = () => {
      container.querySelectorAll('.settings-action-menu.show').forEach((menu) => menu.classList.remove('show'));
      container.querySelectorAll('.settings-action-submenu-wrap.open').forEach((wrap) => wrap.classList.remove('open'));
      container.querySelectorAll('.settings-action-menu-wrap.menu-open').forEach((wrap) => wrap.classList.remove('menu-open'));
      container.querySelectorAll('tr.row-menu-open').forEach((tr) => tr.classList.remove('row-menu-open'));
    };

    const syncColorState = (selectedColor: string) => {
      if (inputColor) inputColor.value = selectedColor;
      if (colorPreview) colorPreview.style.background = selectedColor;
      if (colorCode) colorCode.textContent = selectedColor;
      container.querySelectorAll('.role-color-swatch').forEach((swatch) => {
        swatch.classList.toggle('active', (swatch as HTMLElement).dataset.roleColor === selectedColor);
      });
    };

    const switchEditorTab = (tabName: string) => {
      container.querySelectorAll('.role-editor-tab-btn').forEach((btn) => {
        btn.classList.toggle('active', (btn as HTMLElement).dataset.roleEditorTab === tabName);
      });
      container.querySelectorAll('.role-editor-tab-panel').forEach((panel) => {
        const element = panel as HTMLElement;
        element.style.display = element.id === `role-editor-tab-${tabName}` ? 'flex' : 'none';
      });
    };

    const setEditorVisible = (visible: boolean) => {
      if (editorSection) {
        editorSection.style.display = visible ? 'flex' : 'none';
        if (visible) {
          editorSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }
    };

    const resetEditor = (showEditor = false) => {
      if (inputId) inputId.value = '';
      if (inputName) inputName.value = '';
      if (inputAutoAssign) inputAutoAssign.checked = false;
      container.querySelectorAll('.role-permission-switch').forEach((checkbox) => {
        (checkbox as HTMLInputElement).checked = false;
      });
      syncColorState(palette[0]);
      if (editorTitle) editorTitle.textContent = t('roles.editorNewTitle');
      if (editorMembersPanel) editorMembersPanel.innerHTML = this.renderRoleMembersEditorPanel();
      if (btnSave) btnSave.innerText = t('roles.createRole');
      if (btnDelete) btnDelete.disabled = true;
      switchEditorTab('display');
      setEditorVisible(showEditor);
    };

    const loadRoleIntoEditor = (role: Role) => {
      setEditorVisible(true);
      if (inputId) inputId.value = role.id;
      if (inputName) inputName.value = role.name;
      if (inputAutoAssign) inputAutoAssign.checked = role.isDefault;
      syncColorState(role.color ?? palette[0]);
      container.querySelectorAll('.role-permission-switch').forEach((checkbox) => {
        const input = checkbox as HTMLInputElement;
        const permission = Number(input.dataset.permission || '0');
        input.checked = (role.permissions & permission) !== 0;
      });
      if (editorTitle) editorTitle.textContent = t('roles.editorEditTitle', { name: role.name });
      if (editorMembersPanel) editorMembersPanel.innerHTML = this.renderRoleMembersEditorPanel(role.id);
      if (btnSave) btnSave.innerText = t('roles.updateRole');
      if (btnDelete) {
        const isProtected = role.isDefault || serverStore.isAdminRole(role);
        btnDelete.disabled = isProtected && serverStore.currentUser?.id !== serverStore.ownerId;
      }
      switchEditorTab('display');
    };

    resetEditor(false);
    btnCreateNew?.addEventListener('click', () => resetEditor(true));
    btnRoleCancel?.addEventListener('click', () => resetEditor(false));

    const rolesBody = list?.querySelector('tbody') as HTMLElement | null;
    let orderAtDragStart: string[] = [];

    const currentRoleOrder = (): string[] =>
      Array.from(rolesBody?.querySelectorAll('.role-table-row') ?? []).map(
        (row) => row.getAttribute('data-role-id') ?? ''
      );

    list?.querySelectorAll('.role-table-row').forEach((rowEl) => {
      const row = rowEl as HTMLElement;

      row.addEventListener('dragstart', (e) => {
        this.draggedRoleId = row.getAttribute('data-role-id');
        orderAtDragStart = currentRoleOrder();
        const transfer = (e as DragEvent).dataTransfer;
        if (transfer) {
          transfer.effectAllowed = 'move';
          transfer.setData('text/plain', this.draggedRoleId ?? '');
        }
        setTimeout(() => row.classList.add('role-row-dragging'), 0);
      });

      row.addEventListener('dragover', (e) => {
        e.preventDefault();
        const event = e as DragEvent;
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        if (!rolesBody || !this.draggedRoleId) return;

        const dragged = rolesBody.querySelector(
          `.role-table-row[data-role-id="${this.draggedRoleId}"]`
        ) as HTMLElement | null;
        if (!dragged || dragged === row) return;

        const rect = row.getBoundingClientRect();
        const dropAfter = event.clientY > rect.top + rect.height / 2;
        const reference = dropAfter ? row.nextElementSibling : row;
        if (reference === dragged) return;

        this.animateRoleRowsWhile(rolesBody, () => rolesBody.insertBefore(dragged, reference));
      });

      row.addEventListener('drop', (e) => e.preventDefault());

      row.addEventListener('dragend', () => {
        row.classList.remove('role-row-dragging');
        this.draggedRoleId = null;

        const ordered = currentRoleOrder();
        if (ordered.join() === orderAtDragStart.join()) return;

        void (async () => {
          for (let i = 0; i < ordered.length; i += 1) {
            await networkClient.sendRequest(MessageType.ROLE_UPDATE, {
              roleId: ordered[i],
              position: ordered.length - i,
            });
          }
        })();
      });
    });

    btnSave?.addEventListener('click', async () => {
      const name = inputName?.value.trim();
      if (!name) return;
      let permissions = 0;
      container.querySelectorAll('.role-permission-switch').forEach((checkbox) => {
        const input = checkbox as HTMLInputElement;
        if (input.checked) permissions |= Number(input.dataset.permission || '0');
      });
      const roleId = inputId?.value?.trim();
      const payload = {
        name,
        color: inputColor?.value || palette[0],
        permissions,
        isDefault: Boolean(inputAutoAssign?.checked),
      };
      if (roleId) {
        await networkClient.sendRequest(MessageType.ROLE_UPDATE, {
          roleId,
          ...payload,
        });
      } else {
        await networkClient.sendRequest(MessageType.ROLE_CREATE, payload);
      }
      onReload();
    });

    btnDelete?.addEventListener('click', async () => {
      const roleId = inputId?.value?.trim();
      if (!roleId || btnDelete.disabled) return;
      await networkClient.sendRequest(MessageType.ROLE_DELETE, { roleId });
      onReload();
    });

    container.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;

      const roleOpenButton = target.closest('[data-role-open]') as HTMLElement | null;
      if (roleOpenButton) {
        const roleId = roleOpenButton.getAttribute('data-role-open');
        const role = roleId ? serverStore.getRole(roleId) : undefined;
        if (role) loadRoleIntoEditor(role);
        return;
      }

      const tabButton = target.closest('.role-editor-tab-btn') as HTMLElement | null;
      if (tabButton?.dataset.roleEditorTab) {
        switchEditorTab(tabButton.dataset.roleEditorTab);
        return;
      }

      const swatch = target.closest('.role-color-swatch') as HTMLElement | null;
      if (swatch?.dataset.roleColor) {
        syncColorState(swatch.dataset.roleColor);
        return;
      }

      const bulkButton = target.closest('.role-members-bulk') as HTMLElement | null;
      if (bulkButton) {
        const roleId = bulkButton.getAttribute('data-role-id');
        if (roleId) {
          void this.applyBulkRoleChange(container, roleId, bulkButton.getAttribute('data-bulk-assign') === 'true');
        }
        return;
      }

      const menuTrigger = target.closest('.member-actions-trigger') as HTMLElement | null;
      if (menuTrigger) {
        event.preventDefault();
        event.stopPropagation();
        const wrap = menuTrigger.closest('.settings-action-menu-wrap');
        const row = menuTrigger.closest('tr');
        const menu = wrap?.querySelector('.settings-action-menu');
        const willShow = !menu?.classList.contains('show');
        closeActionMenus();
        if (willShow) {
          menu?.classList.add('show');
          wrap?.classList.add('menu-open');
          row?.classList.add('row-menu-open');
        }
        return;
      }

      const submenuTrigger = target.closest('.settings-action-submenu-wrap > .settings-action-menu-item:not([data-member-action])') as HTMLElement | null;
      if (submenuTrigger) {
        event.preventDefault();
        event.stopPropagation();
        const wrap = submenuTrigger.closest('.settings-action-submenu-wrap');
        wrap?.classList.toggle('open');
        return;
      }

      const menuAction = target.closest('[data-member-action]') as HTMLElement | null;
      if (menuAction) {
        event.preventDefault();
        event.stopPropagation();
        if (menuAction.hasAttribute('disabled')) return;
        const userId = menuAction.getAttribute('data-user-id');
        const roleId = menuAction.getAttribute('data-role-id');
        const action = menuAction.getAttribute('data-member-action');
        if (!userId || !action) return;

        void (async () => {
          if (action === 'kick') {
            await networkClient.sendRequest(MessageType.MEMBER_KICK, { targetUserId: userId });
          }
          if (action === 'toggle-admin' || action === 'toggle-role') {
            if (!roleId) return;
            const assigned = serverStore.getUserRoleIds(userId).includes(roleId);
            await networkClient.sendRequest(assigned ? MessageType.ROLE_UNASSIGN : MessageType.ROLE_ASSIGN, { userId, roleId });
          }
          onReload();
        })();
        return;
      }

      if (!target.closest('.settings-action-menu-wrap')) {
        closeActionMenus();
      }
    });

    container.addEventListener('input', (event) => {
      const target = event.target as HTMLElement;
      if (target?.id !== 'role-members-search') return;
      this.filterMemberRows(container, (target as HTMLInputElement).value);
    });

    container.addEventListener('change', (event) => {
      const target = event.target as HTMLElement;
      if (!(target instanceof HTMLInputElement)) return;
      if (!target.classList.contains('role-editor-member-switch')) return;
      const userId = target.getAttribute('data-user-id');
      const roleId = target.getAttribute('data-role-id');
      if (!userId || !roleId) return;
      const shouldAssign = target.checked;
      target.disabled = true;
      void (async () => {
        try {
          await networkClient.sendRequest(shouldAssign ? MessageType.ROLE_ASSIGN : MessageType.ROLE_UNASSIGN, { userId, roleId });
          // Reopening the whole modal here (the old `onReload()`) collapsed the
          // editor and threw the admin back to the role list on every single
          // member, which is what made assigning several people so painful
          // (#477). The server broadcast already refreshes the store, so only
          // the member counter needs a nudge.
          this.refreshRoleMemberCount(container, roleId);
        } catch (error) {
          target.checked = !shouldAssign;
        } finally {
          target.disabled = false;
        }
      })();
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
   * Rewrites the "members" cell of a role straight from the switches on screen,
   * so the number is right without waiting for the broadcast to land (#477).
   */
  private refreshRoleMemberCount(container: HTMLElement, roleId: string): void {
    const cell = container.querySelector(`[data-role-count="${roleId}"]`);
    if (!cell) return;
    const assigned = container.querySelectorAll(
      `.role-editor-member-switch[data-role-id="${roleId}"]:checked`
    ).length;
    cell.textContent = String(assigned);
  }

  /**
   * Applies one role change to every member matching the current search, so a
   * whole group can be added or removed in one go (#477).
   */
  private async applyBulkRoleChange(container: HTMLElement, roleId: string, assign: boolean): Promise<void> {
    const switches = (Array.from(
      container.querySelectorAll(`.role-editor-member-switch[data-role-id="${roleId}"]`)
    ) as HTMLInputElement[]).filter((input) => {
      const row = input.closest('.role-member-row') as HTMLElement | null;
      const visible = !row || row.style.display !== 'none';
      return visible && input.checked !== assign;
    });

    if (switches.length === 0) {
      await showAlert({ message: t('roles.bulkNothingToDo'), variant: 'warning' });
      return;
    }

    const confirmed = await showConfirm({
      title: assign ? t('roles.bulkAssign') : t('roles.bulkUnassign'),
      message: assign
        ? t('roles.bulkAssignConfirm', { count: switches.length })
        : t('roles.bulkUnassignConfirm', { count: switches.length }),
      variant: assign ? 'info' : 'danger',
    });
    if (!confirmed) return;

    for (const input of switches) {
      const userId = input.getAttribute('data-user-id');
      if (!userId) continue;
      try {
        await networkClient.sendRequest(assign ? MessageType.ROLE_ASSIGN : MessageType.ROLE_UNASSIGN, { userId, roleId });
        input.checked = assign;
      } catch (error) {
        // A member the server refuses (the owner, a higher role) must not stop
        // the rest of the batch.
      }
    }

    this.refreshRoleMemberCount(container, roleId);
  }
}
