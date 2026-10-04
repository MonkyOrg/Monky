import { EVERYONE_ROLE_ID, Permission, MessageType, legacyRoleMask, legacyRoleRule, type Role, type RoleUpdatePayload, type RolesListPayload } from '@monky/shared';
import { serverStore } from '../../../stores/serverStore';
import { getAvatarUrl } from '../../../utils/avatar';
import { escapeHtml } from '../../../utils/html';
import { enterModal, exitModal, handlesModalKey } from '../../../utils/modalSurface';
import { removeOwnedSurfaces } from '../../../utils/surfaceMotion';
import { t } from '../../../i18n';
import type { ServerSettingsContext } from '../ServerSettingsContext';
import { ServerMembersTab } from './ServerMembersTab';
import { ColorPicker } from '../../ColorPicker';
import { COLOR_PRESETS } from '../../../utils/colors';
import { ContextMenu } from '../../ContextMenu';
import { showConfirm } from '../../Dialog';
import { showSuccessToast } from '../../CopyToast';
import '../../channelSettings.css';

interface RoleDialog {
  element: HTMLElement;
  signal: AbortSignal;
  close: (immediate?: boolean) => void;
}

interface RoleRule {
  permissions: number;
  deny: number;
}

type PermissionState = 'deny' | 'inherit' | 'allow';

const PERMISSION_STATES = [
  { value: 'deny', icon: 'close', label: 'channelPermissions.deny' },
  { value: 'inherit', icon: 'remove', label: 'channelPermissions.inherit' },
  { value: 'allow', icon: 'check', label: 'channelPermissions.allow' },
] as const;

export class ServerRolesTab {
  private draggedRoleId: string | null = null;
  private root: HTMLElement | null = null;
  private context: ServerSettingsContext | null = null;
  private cleanup: Array<() => void> = [];
  private stateSignature = '';
  private membersSignature = '';
  private dirtyName = false;
  private submittedName = '';
  private editor: RoleDialog | null = null;
  private memberPicker: RoleDialog | null = null;
  private readonly roleMenu = new ContextMenu();
  private roleDeletion: { roleId: string; controller: AbortController } | null = null;
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

        </fieldset>
      </div>
    `;
  }

  private renderEditorHtml(everyone = false): string {
    return `
          <p class="role-dialog-hint">${t(everyone ? 'roles.everyoneHint' : 'serverSettings.roleImmediateHint')}</p>
          <input type="hidden" id="role-editor-id">
          <div style="display: flex; gap: 8px; flex-wrap: wrap; border-bottom: 1px solid var(--border-color); padding-bottom: 6px;">
            ${everyone ? '' : `<button type="button" class="role-editor-tab-btn active" data-role-editor-tab="general">${t('roles.generalTab')}</button>`}
            <button type="button" class="role-editor-tab-btn${everyone ? ' active' : ''}" data-role-editor-tab="permissions">${t('roles.permissionsTab')}</button>
            ${everyone ? '' : `<button type="button" class="role-editor-tab-btn" data-role-editor-tab="members">${t('roles.membersTab')}</button>`}
          </div>
          ${everyone ? '' : `<div id="role-editor-tab-general" class="role-editor-tab-panel" style="display: flex; flex-direction: column; gap: 12px;">
            <div class="form-group" style="margin-bottom: 0;">
              <label for="role-editor-name">${t('roles.roleName')}</label>
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
            <section class="role-delete-section" hidden>
              <div>
                <h3>${t('roles.deleteRole')}</h3>
                <p class="role-dialog-hint">${t('roles.deleteHint')}</p>
              </div>
              <button type="button" id="btn-role-delete" class="btn btn-danger">${t('roles.deleteRole')}</button>
            </section>
          </div>`}
          <div id="role-editor-tab-permissions" data-settings-section="role-permissions" data-settings-label="${escapeHtml(t('roles.permissionsTab'))}" class="role-editor-tab-panel" style="display: ${everyone ? 'flex' : 'none'}; flex-direction: column; gap: 10px;">
            ${everyone ? '' : `<p class="role-dialog-hint" data-role-permission-hint>${t('roles.permissionStatesHint')}</p>`}
            ${this.renderPermissionControls(everyone)}
          </div>
          ${everyone ? '' : `<div id="role-editor-tab-members" data-settings-section="role-members" data-settings-label="${escapeHtml(t('roles.membersTab'))}" class="role-editor-tab-panel" style="display: none; flex-direction: column; gap: 10px;">
            <div id="role-editor-members-panel">${this.renderRoleMembersEditorPanel()}</div>
          </div>`}
    `;
  }

  private renderRoleRows(): string {
    const roles = serverStore.getVisibleRoles().sort((a, b) => b.position - a.position);
    const members = serverStore.getAllMembersInDisplayOrder().filter(member => !member.isBot);
    const everyone = `<tr class="role-everyone-row" data-role-id="${EVERYONE_ROLE_ID}">
      <td><div class="role-everyone-name"><span class="material-symbols-outlined md-18">groups</span>
        <span>${t('roles.everyone')}</span></div></td>
      <td>${t('roles.everyoneSummary')}</td><td>—</td>
      <td style="text-align: right;"><button type="button" class="role-actions-trigger" data-role-menu="${EVERYONE_ROLE_ID}"
        aria-label="${escapeHtml(t('roles.roleActions', { name: t('roles.everyone') }))}" aria-haspopup="menu" aria-expanded="false">
        <span class="material-symbols-outlined md-18" aria-hidden="true">more_horiz</span></button></td></tr>`;
    return everyone + roles.map((role) => `
      <tr class="role-table-row" data-role-id="${role.id}" draggable="true">
        <td><div style="display: flex; align-items: center; gap: 10px; min-width: 0;">
          <span class="material-symbols-outlined md-16" title="${t('roles.dragReorderHint')}" style="color: var(--text-muted); cursor: grab;">drag_indicator</span>
          <span style="width: 12px; height: 12px; border-radius: 50%; background: ${role.color || 'var(--text-muted)'}; flex-shrink: 0;"></span>
          <span style="font-size: 13px; font-weight: 600;">${escapeHtml(role.name)}</span>
          ${role.isDefault ? `<span class="member-badge-you">${t('roles.autoBadge')}</span>` : ''}
        </div></td>
        <td style="font-size: 12px;">${escapeHtml(this.describeRolePermissions(role))}</td>
        <td class="role-member-count" data-role-count="${role.id}">${members.filter((member) => serverStore.getUserRoleIds(member.id).includes(role.id)).length}</td>
        <td style="text-align: right;"><button type="button" class="role-actions-trigger" data-role-menu="${role.id}"
          title="${t('common.moreOptions')}" aria-label="${escapeHtml(t('roles.roleActions', { name: role.name }))}" aria-haspopup="menu" aria-expanded="false">
          <span class="material-symbols-outlined md-18" aria-hidden="true">more_horiz</span>
        </button></td>
      </tr>`).join('');
  }

  private describeRolePermissions(role: Role): string {
    if (role.permissions & Permission.ADMINISTRATOR) {
      return t('permissions.administrator');
    }
    const rule = this.roleRule(role);
    const labels = this.permissionItems().filter(item => rule.permissions & item.key).map(item => item.label);
    const denied = this.permissionItems().filter(item => rule.deny & item.key).length;
    const allowed = labels.slice(0, 3).join(', ');
    if (!denied) return allowed || t('roles.inheritsEveryone');
    const deniedLabel = t('roles.deniedCount', { count: denied });
    return allowed ? `${allowed} · ${deniedLabel}` : deniedLabel;
  }

  /** Servers before allow/deny roles send full switch masks, shown here as the equivalent rule. */
  private roleRule(role: Role): RoleRule {
    const store = this.context?.store ?? serverStore;
    return store.rolesUseDeny
      ? { permissions: role.permissions, deny: role.deny ?? 0 }
      : legacyRoleRule(role.permissions, store.everyonePermissions);
  }

  private rulePayload(roleId: string, rule: RoleRule): RoleUpdatePayload {
    const store = this.context?.store ?? serverStore;
    return store.rolesUseDeny
      ? { roleId, permissions: rule.permissions, deny: rule.deny }
      : { roleId, permissions: legacyRoleMask(rule, store.everyonePermissions) };
  }

  private permissionItems(): Array<{ key: Permission; label: string; description: string }> {
    return [
      { key: Permission.VIEW_CHANNEL, label: t('permissions.viewChannel'), description: t('permissions.viewChannelDesc') },
      { key: Permission.MANAGE_CHANNELS, label: t('permissions.manageChannels'), description: t('permissions.manageChannelsDesc') },
      { key: Permission.MANAGE_SERVER, label: t('permissions.manageServer'), description: t('permissions.manageServerDesc') },
      { key: Permission.MANAGE_EVENTS, label: t('permissions.manageEvents'), description: t('permissions.manageEventsDesc') },
      { key: Permission.EMIT_LIVE_ACTIONS, label: t('permissions.emitLiveActions'), description: t('permissions.emitLiveActionsDesc') },
      { key: Permission.VIEW_SERVER_MONITOR, label: t('permissions.viewServerMonitor'), description: t('permissions.viewServerMonitorDesc') },
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
  }

  /** Everyone is the on/off base; roles allow, inherit or deny on top of it. */
  private renderPermissionControls(everyone: boolean): string {
    return this.permissionItems().map((item) => `
      <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; border: 1px solid var(--border-color); border-radius: var(--radius-md); background: var(--bg-secondary);">
        <div style="min-width: 0;">
          <div style="font-size: 12px; font-weight: 600; color: var(--text-primary);">${item.label}</div>
          <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">${item.description}</div>
        </div>
        ${everyone ? `<label class="permission-switch" aria-label="${item.label}">
          <input type="checkbox" class="role-permission-switch" data-permission="${item.key}">
          <span class="slider"></span>
        </label>` : `<div class="permission-three-state role-permission-states" role="radiogroup" aria-label="${item.label}">
          ${PERMISSION_STATES.map(option => `<button type="button" role="radio" aria-checked="${option.value === 'inherit'}"
            tabindex="${option.value === 'inherit' ? 0 : -1}" class="${option.value === 'inherit' ? 'selected' : ''}"
            data-role-permission-bit="${item.key}" data-permission-state="${option.value}" title="${t(option.label)}" aria-label="${t(option.label)}">
            <span class="material-symbols-outlined md-18" aria-hidden="true">${option.icon}</span></button>`).join('')}
        </div>`}
      </div>
    `).join('');
  }

  private syncPermissionStates(root: HTMLElement, rule: RoleRule): void {
    root.querySelectorAll<HTMLButtonElement>('[data-role-permission-bit]').forEach((button) => {
      const bit = Number(button.dataset.rolePermissionBit);
      const state: PermissionState = rule.deny & bit ? 'deny' : rule.permissions & bit ? 'allow' : 'inherit';
      const selected = button.dataset.permissionState === state;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-checked', String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
  }

  private readPermissionStates(root: HTMLElement): RoleRule {
    const rule = { permissions: 0, deny: 0 };
    root.querySelectorAll<HTMLButtonElement>('[data-role-permission-bit].selected').forEach((button) => {
      const bit = Number(button.dataset.rolePermissionBit);
      if (button.dataset.permissionState === 'allow') rule.permissions |= bit;
      else if (button.dataset.permissionState === 'deny') rule.deny |= bit;
    });
    return rule;
  }

  private setPermissionState(root: HTMLElement, button: HTMLButtonElement): void {
    const bit = Number(button.dataset.rolePermissionBit);
    const state = button.dataset.permissionState as PermissionState;
    const current = this.readPermissionStates(root);
    const rule = {
      permissions: ((current.permissions & ~bit) | (state === 'allow' ? bit : 0)) >>> 0,
      deny: ((current.deny & ~bit) | (state === 'deny' ? bit : 0)) >>> 0,
    };
    this.syncPermissionStates(root, rule);
    root.querySelector<HTMLButtonElement>(`[data-role-permission-bit="${bit}"][data-permission-state="${state}"]`)?.focus({ preventScroll: true });
    const roleId = this.editorRoleId();
    if (roleId) this.updateRole(roleId, () => this.rulePayload(roleId, rule));
  }

  public renderRoleMembersEditorPanel(roleId?: string): string {
    if (!roleId) {
      return `
        <div style="padding: 16px; border: 1px dashed var(--border-color); border-radius: var(--radius-md); background: var(--bg-secondary); font-size: 12px; color: var(--text-muted); text-align: center;">
          ${t('roles.membersTabHint')}
        </div>
      `;
    }

    return `
      <div class="role-members-heading">
        <p class="role-dialog-hint">${t('roles.membersEditorHint')}</p>
        <button type="button" id="btn-role-add-members" class="btn btn-primary">${t('roles.addMembers')}</button>
      </div>
      ${this.renderMemberList(roleId, false)}
    `;
  }

  private renderMemberList(roleId: string, adding: boolean): string {
    const store = this.context?.store ?? serverStore;
    const members = store.getAllMembersInDisplayOrder().filter(member =>
      !member.isBot && store.getUserRoleIds(member.id).includes(roleId) !== adding);
    const searchId = adding ? 'role-add-members-search' : 'role-members-search';
    return `
      <div class="role-members-toolbar">
        <input type="search" id="${searchId}" class="role-members-search" aria-label="${t('roles.searchMembersPlaceholder')}" placeholder="${t('roles.searchMembersPlaceholder')}" autocomplete="off">
        <span data-role-members-count class="role-dialog-hint">${t('roles.membersShown', { shown: members.length, total: members.length })}</span>
      </div>
      <div class="settings-table-wrap">
        <table class="settings-data-table">
          <thead>
            <tr>
              <th>${t('roles.memberColumn')}</th>
              <th class="role-member-action-cell">${t('roles.actionsColumn')}</th>
            </tr>
          </thead>
          <tbody>
            ${members.map((member) => {
              const offline = member.status === 'DISCONNECTED';
              return `
                <tr class="role-member-row" data-member-name="${escapeHtml(member.nickname)}">
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
                  <td class="role-member-action-cell">
                    <button type="button" class="btn ${adding ? 'btn-secondary' : 'btn-danger'} role-member-action"
                      data-role-member-action="${adding ? 'add' : 'remove'}" data-user-id="${member.id}" data-role-id="${roleId}"
                      aria-label="${escapeHtml(t(adding ? 'roles.addMemberLabel' : 'roles.removeMemberLabel', { name: member.nickname }))}">
                      ${t(adding ? 'roles.addMember' : 'roles.removeMember')}
                    </button>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
      <p data-role-members-empty class="role-members-empty" ${members.length ? 'hidden' : ''}>${t(adding ? 'roles.noAvailableMembers' : 'roles.noAssignedMembers')}</p>
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
    const controller = new AbortController();
    this.cleanup.push(() => controller.abort());
    const options = { signal: controller.signal };
    this.attachControls(container, context, controller.signal);
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
    this.refreshState();
  }

  private attachControls(container: HTMLElement, context: ServerSettingsContext, signal: AbortSignal): void {
    const options = { signal };
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
      else if (target.id === 'btn-role-save') this.createRole();
      else if (target.id === 'btn-role-delete') {
        const roleId = this.editorRoleId();
        if (roleId) this.deleteRole(roleId);
      } else if (target.dataset.roleMenu) this.openRoleMenu(target, target.dataset.roleMenu);
      else if (target.dataset.roleEditorTab) {
        const tab = target.dataset.roleEditorTab;
        container.querySelectorAll<HTMLButtonElement>('.role-editor-tab-btn').forEach((button) => button.classList.toggle('active', button === target));
        container.querySelectorAll<HTMLElement>('.role-editor-tab-panel').forEach((panel) => {
          const visible = panel.id === `role-editor-tab-${tab}`;
          panel.style.display = visible ? 'flex' : 'none';
        });
      } else if (target.dataset.rolePermissionBit && target.dataset.permissionState) {
        this.setPermissionState(container, target);
      } else if (target.id === 'btn-role-add-members') {
        this.openMemberPicker();
      } else if (target.dataset.roleMemberAction && target.dataset.roleId && target.dataset.userId) {
        this.assignRole(target.dataset.userId, target.dataset.roleId, target.dataset.roleMemberAction === 'add');
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
    container.addEventListener('keydown', (event) => {
      const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-role-permission-bit]') : null;
      if (!button || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const buttons = [...button.parentElement!.querySelectorAll<HTMLButtonElement>('button')];
      const index = buttons.indexOf(button);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (event.key === 'ArrowRight' ? 1 : 2)) % 3;
      buttons[next].click();
    }, options);
    container.addEventListener('input', (event) => {
      if (event.target instanceof HTMLInputElement && event.target.classList.contains('role-members-search')) {
        this.filterMemberRows(container, event.target.value);
      }
    }, options);
    container.addEventListener('change', (event) => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement) || input.matches(':disabled')) return;
      const roleId = this.editorRoleId();
      if (roleId && input.id === 'role-editor-is-default') {
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
  }

  public detachEvents(): void {
    this.roleDeletion?.controller.abort();
    this.roleMenu.close();
    this.editor?.close(true);
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

  private canDeleteRole(role: Role): boolean {
    const store = this.context?.store ?? serverStore;
    return role.id !== EVERYONE_ROLE_ID && store.hasPermission(Permission.MANAGE_ROLES) &&
      (!(role.isDefault || store.isAdminRole(role)) || store.currentUser?.id === store.ownerId);
  }

  private openRoleMenu(anchor: HTMLButtonElement, roleId: string): void {
    const context = this.context;
    const role = this.getEditorRole(roleId);
    if (!context?.isCurrent() || !role || !context.store.hasPermission(Permission.MANAGE_ROLES)) return;
    if (this.roleMenu.isOpenFor(anchor)) {
      this.roleMenu.close();
      return;
    }
    const rect = anchor.getBoundingClientRect();
    this.roleMenu.open(rect.right, rect.bottom + 6, [
      { label: t('roles.editRole'), icon: 'edit', onClick: () => this.openEditor(role) },
      ...(roleId === EVERYONE_ROLE_ID ? [] : [{ label: t('roles.deleteRole'), icon: 'delete', danger: true,
        disabled: !this.canDeleteRole(role) || context.operations.pendingCount > 0,
        onClick: () => this.deleteRole(roleId) }]),
    ], anchor);
  }

  private deleteRole(roleId: string): void {
    const context = this.context;
    if (!context || this.roleDeletion || context.operations.pendingCount) return;
    const deletion = { roleId, controller: new AbortController() };
    this.roleDeletion = deletion;
    void context.operations.run(`role:${roleId}`, t('roles.deleteRole'), Permission.MANAGE_ROLES, async () => {
      const role = context.store.getRole(roleId);
      if (!role) throw new Error(t('serverSettings.roleUnavailable'));
      if (!this.canDeleteRole(role)) throw new Error(t('protocolError.permissionDenied'));
      const confirmed = await showConfirm({
        title: t('roles.deleteRole'),
        message: t('roles.deleteConfirm', { name: role.name }),
        confirmLabel: t('roles.deleteRole'), variant: 'danger', focusCancel: true,
        signal: deletion.controller.signal,
      });
      if (!confirmed) return;
      const latest = context.store.getRole(roleId);
      if (!latest) throw new Error(t('serverSettings.roleUnavailable'));
      if (!this.canDeleteRole(latest)) throw new Error(t('protocolError.permissionDenied'));
      await context.request<RolesListPayload>(MessageType.ROLE_DELETE, { roleId }, Permission.MANAGE_ROLES);
    }).then(() => {
      if (this.roleDeletion === deletion) this.roleDeletion = null;
    });
  }

  private editorRoleId(): string {
    return this.editor?.element.querySelector<HTMLInputElement>('#role-editor-id')?.value ?? '';
  }

  private getEditorRole(roleId: string): Role | undefined {
    const store = this.context?.store ?? serverStore;
    return roleId === EVERYONE_ROLE_ID
      ? { id: roleId, name: t('roles.everyone'), color: null, position: 0, permissions: store.everyonePermissions, isDefault: false }
      : store.getRole(roleId);
  }

  public finishEditing(): void {
    const name = this.editor?.element.querySelector<HTMLInputElement>('#role-editor-name');
    if (this.dirtyName) name?.dispatchEvent(new Event('change', { bubbles: true }));
  }

  private openEditor(role?: Role): void {
    const context = this.context;
    if (!this.root || !context?.isCurrent() || !context.store.hasPermission(Permission.MANAGE_ROLES) || this.editor) return;
    this.editor = this.openDialog('role-editor-title', role ? t('roles.editorEditTitle', { name: role.name }) : t('roles.editorNewTitle'),
      this.renderEditorHtml(role?.id === EVERYONE_ROLE_ID),
      `<button type="button" id="btn-role-save" class="btn btn-primary">${t('roles.createRole')}</button>
       ${role ? `<button type="button" class="btn btn-secondary" data-role-dialog-close>${t('common.done')}</button>` : ''}`,
      () => {
        this.memberPicker?.close(true);
        this.colorPicker.cleanup();
        this.editor = null;
        this.dirtyName = false;
        return this.root?.querySelector<HTMLElement>(role ? `[data-role-menu="${role.id}"]` : '#btn-role-create-new');
      });
    const root = this.editor.element;
    root.dataset.roleEditor = '';
    const options = { signal: this.editor.signal };
    this.attachControls(root, context, this.editor.signal);
    if (role?.id === EVERYONE_ROLE_ID) {
      root.querySelector<HTMLInputElement>('#role-editor-id')!.value = role.id;
      this.refreshState();
      root.querySelector<HTMLInputElement>('.role-permission-switch')?.focus({ preventScroll: true });
      return;
    }
    this.colorPicker.attachEvents(root, color => {
      const roleId = this.editorRoleId();
      if (roleId) this.updateRole(roleId, () => ({ roleId, color }));
      this.syncColor(color);
    });
    const id = root.querySelector<HTMLInputElement>('#role-editor-id');
    const name = root.querySelector<HTMLInputElement>('#role-editor-name');
    if (!id || !name) return;
    id.value = role?.id ?? '';
    name.value = role?.name ?? '';
    this.submittedName = name.value;
    this.dirtyName = false;
    const commitName = () => {
      const roleId = this.editorRoleId();
      if (!roleId) return;
      this.dirtyName = false;
      if (name.value === this.submittedName) return;
      this.submittedName = name.value;
      const nextName = name.value.trim();
      this.updateRole(roleId, () => ({ roleId, name: nextName }));
    };
    name.addEventListener('blur', commitName, options);
    name.addEventListener('change', commitName, options);
    name.addEventListener('input', () => { this.dirtyName = true; }, options);
    name.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); commitName(); name.blur(); }
    }, options);
    const auto = root.querySelector<HTMLInputElement>('#role-editor-is-default');
    if (auto) auto.checked = role?.isDefault ?? false;
    this.syncColor(role?.color ?? COLOR_PRESETS[0]);
    this.syncPermissionStates(root, role ? this.roleRule(role) : { permissions: 0, deny: 0 });
    const panel = root.querySelector('#role-editor-members-panel');
    if (panel) panel.innerHTML = this.renderRoleMembersEditorPanel(role?.id);
    this.membersSignature = '';
    root.querySelector<HTMLButtonElement>('[data-role-editor-tab="general"]')?.click();
    this.refreshState();
    name.focus({ preventScroll: true });
  }

  private openDialog(titleId: string, title: string, content: string, actions: string, onClose: () => HTMLElement | null | undefined | void): RoleDialog {
    const element = document.createElement('div');
    const controller = new AbortController();
    const options = { signal: controller.signal };
    element.className = 'modal-backdrop';
    element.innerHTML = `<section class="modal-card role-dialog-card" role="dialog" aria-modal="true" aria-labelledby="${titleId}">
      <header class="modal-header"><h2 class="modal-title" id="${titleId}">${escapeHtml(title)}</h2>
        <button type="button" class="modal-close-btn" data-role-dialog-close aria-label="${t('common.close')}">&times;</button></header>
      <fieldset class="role-dialog-body">${content}</fieldset>
      <div class="error-banner role-dialog-errors" role="alert" aria-live="polite"></div>
      <span class="role-dialog-status" role="status" aria-live="polite"></span>
      <footer class="modal-footer">${actions}</footer>
    </section>`;
    const close = (immediate = false) => {
      if (controller.signal.aborted) return;
      if (!immediate) {
        this.finishEditing();
        if (this.context?.operations.pendingCount) return;
      }
      controller.abort();
      const focus = onClose();
      exitModal(element, immediate);
      if (!immediate) focus?.focus({ preventScroll: true });
    };
    element.querySelectorAll('[data-role-dialog-close]').forEach(button =>
      button.addEventListener('click', () => close(), options));
    element.addEventListener('mousedown', event => { if (event.target === element) close(); }, options);
    window.addEventListener('keydown', event => {
      if (!handlesModalKey(element, event)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
      } else if (event.key === 'Tab') {
        const controls = [...element.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]')]
          .filter(control => control.getClientRects().length && !control.hidden);
        const index = controls.indexOf(document.activeElement as HTMLElement);
        if (controls.length && (event.shiftKey ? index <= 0 : index < 0 || index === controls.length - 1)) {
          event.preventDefault();
          controls[event.shiftKey ? controls.length - 1 : 0].focus({ preventScroll: true });
        }
      }
    }, { ...options, capture: true });
    document.body.append(element);
    enterModal(element);
    return { element, close, signal: controller.signal };
  }

  private openMemberPicker(): void {
    const roleId = this.editorRoleId();
    const context = this.context;
    if (!roleId || !context?.isCurrent() || this.memberPicker || !context.store.hasPermission(Permission.MANAGE_ROLES)) return;
    this.memberPicker = this.openDialog('role-add-members-title', t('roles.addMembers'),
      `<p class="role-dialog-hint">${t('roles.addMembersHint')}</p>
       <div data-role-candidates>${this.renderMemberList(roleId, true)}</div>`,
      `<button type="button" class="btn btn-secondary" data-role-dialog-close>${t('common.done')}</button>`, () => {
        this.memberPicker = null;
        return this.editor?.element.querySelector<HTMLElement>('#btn-role-add-members');
      });
    this.memberPicker.element.dataset.roleMemberPicker = '';
    this.attachControls(this.memberPicker.element, context, this.memberPicker.signal);
    this.refreshState();
    this.memberPicker.element.querySelector<HTMLInputElement>('.role-members-search')?.focus({ preventScroll: true });
  }

  private syncColor(color: string): void {
    this.colorPicker.setValue(color);
  }

  private updateRole(roleId: string, patch: (role: Role) => RoleUpdatePayload): void {
    const context = this.context;
    if (!context) return;
    void context.operations.run(`role:${roleId}`, t('roles.rolesList'), Permission.MANAGE_ROLES, async () => {
      const role = this.getEditorRole(roleId);
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
    const editor = this.editor;
    const root = editor?.element;
    if (!context || !root || this.editorRoleId() || context.operations.isPending('role-create')) return;
    const name = root.querySelector<HTMLInputElement>('#role-editor-name')?.value.trim() ?? '';
    const color = root.querySelector<HTMLButtonElement>('#role-editor-color')?.value ?? COLOR_PRESETS[0];
    const isDefault = Boolean(root.querySelector<HTMLInputElement>('#role-editor-is-default')?.checked);
    const rule = this.readPermissionStates(root);
    const permissions = context.store.rolesUseDeny ? rule : { permissions: legacyRoleMask(rule, context.store.everyonePermissions) };
    void context.operations.run('role-create', t('roles.createRole'), Permission.MANAGE_ROLES, async () => {
      if (!name || name.length > 32) throw new Error(t('serverSettings.roleNameInvalid'));
      await context.request<RolesListPayload>(MessageType.ROLE_CREATE, { name, color, isDefault, ...permissions }, Permission.MANAGE_ROLES);
    }).then(result => {
      if (result.ok && context.isCurrent() && this.editor === editor) editor?.close();
    });
  }

  private assignRole(userId: string, roleId: string, assign: boolean): void {
    const context = this.context;
    if (!context || context.operations.isPending(`assignment:${userId}:${roleId}`)) return;
    void context.operations.run(`assignment:${userId}:${roleId}`, t('roles.assignedColumn'), Permission.MANAGE_ROLES, async () => {
      const member = context.store.getAllMembersInDisplayOrder().find(member => member.id === userId);
      const role = context.store.getRole(roleId);
      if (!role) throw new Error(t('serverSettings.roleUnavailable'));
      if (!member) throw new Error(t('roles.memberUnavailable'));
      await context.request<RolesListPayload>(
        assign ? MessageType.ROLE_ASSIGN : MessageType.ROLE_UNASSIGN, { userId, roleId }, Permission.MANAGE_ROLES,
      );
      return { name: member.nickname, role: role.name };
    }).then(result => {
      if (result.ok && context.isCurrent()) {
        showSuccessToast(t(assign ? 'roles.memberAdded' : 'roles.memberRemoved', result.value));
      }
    });
  }

  public refreshState(): void {
    const root = this.root;
    const context = this.context;
    if (!root || !context) return;
    if (!context.isCurrent() || !context.store.hasPermission(Permission.MANAGE_ROLES)) {
      this.roleDeletion?.controller.abort();
      this.roleMenu.close();
      removeOwnedSurfaces(root);
      this.editor?.close(true);
      return;
    }
    const { store, operations } = context;
    if (this.roleDeletion) {
      const deletingRole = store.getRole(this.roleDeletion.roleId);
      if (!deletingRole || !this.canDeleteRole(deletingRole)) this.roleDeletion.controller.abort();
    }
    const signature = JSON.stringify([store.everyonePermissions, store.roles, store.userRoles, store.serverDetails?.members, [...store.knownMembers]]);
    if (signature !== this.stateSignature && !this.draggedRoleId && !operations.isPending('role-order')) {
      this.stateSignature = signature;
      this.roleMenu.close();
      const body = root.querySelector('#roles-list tbody');
      if (body) body.innerHTML = this.renderRoleRows();
      const members = root.querySelector('#tab-panel-members > fieldset');
      if (members) members.innerHTML = new ServerMembersTab().renderHtml();
    }
    const roleId = this.editorRoleId();
    const role = roleId ? this.getEditorRole(roleId) : undefined;
    const creating = operations.isPending('role-create');
    const pendingRole = operations.isPending(`role:${roleId}`);
    if (roleId && !role) this.editor?.close(true);
    const editor = this.editor?.element;
    if (!editor) return;
    for (const dialog of [this.editor, this.memberPicker]) {
      if (!dialog) continue;
      dialog.element.querySelectorAll<HTMLButtonElement>('[data-role-dialog-close]').forEach(button => {
        button.disabled = operations.pendingCount > 0;
      });
      const body = dialog.element.querySelector<HTMLFieldSetElement>('.role-dialog-body');
      if (body) body.disabled = creating;
      dialog.element.querySelector('.role-dialog-card')?.setAttribute('aria-busy', String(operations.pendingCount > 0));
      const status = dialog.element.querySelector('.role-dialog-status');
      if (status) status.textContent = operations.pendingCount
        ? t('serverSettings.applying', { count: operations.pendingCount }) : '';
      const errors = dialog.element.querySelector('.role-dialog-errors');
      if (errors) {
        errors.textContent = operations.failures.filter(failure =>
          failure.key === 'role-create' || failure.key === `role:${roleId}` ||
          failure.key.startsWith('assignment:') && failure.key.endsWith(`:${roleId}`))
          .map(failure => failure.message).join('\n');
        errors.classList.toggle('show', Boolean(errors.textContent));
      }
    }
    const memberSignature = `${roleId}:${signature}`;
    if (role && roleId !== EVERYONE_ROLE_ID && this.membersSignature !== memberSignature) {
      this.refreshMembers(editor, '#role-editor-members-panel', this.renderRoleMembersEditorPanel(roleId));
      if (this.memberPicker) {
        this.refreshMembers(this.memberPicker.element, '[data-role-candidates]', this.renderMemberList(roleId, true));
      }
      this.membersSignature = memberSignature;
    }
    const save = editor.querySelector<HTMLButtonElement>('#btn-role-save');
    if (save) { save.hidden = Boolean(roleId); save.disabled = creating; }
    const remove = editor.querySelector<HTMLButtonElement>('#btn-role-delete');
    if (remove) {
      const section = remove.closest<HTMLElement>('.role-delete-section');
      if (section) section.hidden = !roleId;
      remove.disabled = !role || operations.pendingCount > 0 || !this.canDeleteRole(role);
    }
    editor.querySelectorAll<HTMLInputElement | HTMLButtonElement>('#role-editor-name, #role-editor-is-default, .role-permission-switch, [data-role-permission-bit]').forEach((input) => {
      input.disabled = creating;
    });
    this.colorPicker.setDisabled(creating || !store.hasPermission(Permission.MANAGE_ROLES));
    if (role && !pendingRole) {
      const name = editor.querySelector<HTMLInputElement>('#role-editor-name');
      if (name && !this.dirtyName) { name.value = role.name; this.submittedName = name.value; }
      const auto = editor.querySelector<HTMLInputElement>('#role-editor-is-default');
      if (auto) auto.checked = role.isDefault;
      this.syncColor(role.color ?? COLOR_PRESETS[0]);
      editor.querySelectorAll<HTMLInputElement>('.role-permission-switch').forEach((input) => {
        input.checked = Boolean(role.permissions & Number(input.dataset.permission));
      });
      if (roleId !== EVERYONE_ROLE_ID) this.syncPermissionStates(editor, this.roleRule(role));
      const title = editor.querySelector('#role-editor-title');
      if (title) title.textContent = t('roles.editorEditTitle', { name: role.name });
    }
    for (const dialog of [this.editor, this.memberPicker]) {
      dialog?.element.querySelectorAll<HTMLButtonElement>('.role-member-action').forEach(button => {
        const pending = operations.isPending(`assignment:${button.dataset.userId}:${roleId}`);
        button.disabled = pending;
        button.setAttribute('aria-busy', String(pending));
      });
    }
  }

  private refreshMembers(container: HTMLElement, selector: string, html: string): void {
    const panel = container.querySelector<HTMLElement>(selector);
    if (!panel) return;
    const search = panel.querySelector<HTMLInputElement>('.role-members-search');
    const query = search?.value ?? '';
    const focused = panel.contains(document.activeElement);
    const scroll = container.querySelector('.role-dialog-body');
    const scrollTop = scroll?.scrollTop ?? 0;
    panel.innerHTML = html;
    const nextSearch = panel.querySelector<HTMLInputElement>('.role-members-search');
    if (nextSearch) {
      nextSearch.value = query;
      if (focused) nextSearch.focus({ preventScroll: true });
    }
    this.filterMemberRows(panel, query);
    if (scroll) scroll.scrollTop = scrollTop;
  }

  private filterMemberRows(container: HTMLElement, query: string): void {
    const normalize = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    const term = normalize(query.trim());
    const rows = Array.from(container.querySelectorAll('.role-member-row')) as HTMLElement[];
    let shown = 0;
    rows.forEach((row) => {
      const name = normalize(row.dataset.memberName ?? '');
      const matches = term.length === 0 || name.includes(term);
      row.style.display = matches ? '' : 'none';
      if (matches) shown += 1;
    });

    const counter = container.querySelector('[data-role-members-count]');
    if (counter) {
      counter.textContent = t('roles.membersShown', { shown, total: rows.length });
    }
    const empty = container.querySelector<HTMLElement>('[data-role-members-empty]');
    if (empty) {
      empty.hidden = shown > 0;
      empty.textContent = t(rows.length ? 'roles.noMatchingMembers'
        : container.closest('[data-role-member-picker]') ? 'roles.noAvailableMembers' : 'roles.noAssignedMembers');
    }
  }
}
