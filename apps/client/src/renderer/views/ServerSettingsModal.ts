import {
  LIMITS, MessageType, Permission,
  type ServerUpdateSettingsPayload, type ServerSettingsUpdatedPayload,
  type TurnInstallProgressPayload, type TurnInstallStage,
} from '@monky/shared';
import { getActiveNetworkClient, RequestTimeoutError } from '../core/NetworkClient';
import { appEvents } from '../core/EventBus';
import { currentEventOrigin, isForegroundEvent } from '../core/sessionRouting';
import { getActiveServerStore } from '../stores/serverStore';
import { settingsStore } from '../stores/settingsStore';
import { t, type TranslationKey } from '../i18n';
import { enableBackdropClose } from '../utils/modal';
import { getAvatarUrl } from '../utils/avatar';
import logoUrl from '../assets/Logo.png';
import { pickAndCropImage } from './ImageCropModal';
import { attachInputEmojiPicker } from '../utils/inputEmojiPicker';
import { showConfirm } from './Dialog';
import { ServerGeneralTab } from './serverSettings/tabs/ServerGeneralTab';
import { ServerSecurityTab } from './serverSettings/tabs/ServerSecurityTab';
import { ServerVoiceVideoTab, turnBlockedReason } from './serverSettings/tabs/ServerVoiceVideoTab';
import { ServerStorageTab } from './serverSettings/tabs/ServerStorageTab';
import { ServerNotificationsTab } from './serverSettings/tabs/ServerNotificationsTab';
import { ServerMembersTab } from './serverSettings/tabs/ServerMembersTab';
import { ServerRolesTab } from './serverSettings/tabs/ServerRolesTab';
import { ServerBotsTab } from './serverSettings/tabs/ServerBotsTab';
import { SettingsSectionNavigation } from './settings/SettingsSectionNavigation';
import { ServerSettingsOperations } from './serverSettings/ServerSettingsOperations';
import type { ServerSettingsContext } from './serverSettings/ServerSettingsContext';
import { serverSettingsValidationError } from './serverSettings/serverSettingsValidation';
import './serverSettings/serverSettingsImmediate.css';

interface FieldBinding {
  input: HTMLInputElement | HTMLSelectElement;
  key: string;
  persisted: () => string;
  submitted: string;
  dirty: boolean;
  commit: () => void;
}

export class ServerSettingsModal {
  private modalEl: HTMLElement | null = null;
  private context: ServerSettingsContext | null = null;
  private invalidated = false;
  private activeTab = 'general';
  private sectionNavigation: SettingsSectionNavigation | null = null;
  private unbind: Array<() => void> = [];
  private domEvents = new AbortController();
  private bindings: FieldBinding[] = [];
  private generalTab = new ServerGeneralTab();
  private storageTab = new ServerStorageTab();
  private rolesTab = new ServerRolesTab();
  private botsTab = new ServerBotsTab();

  public open(initialTab?: string): void {
    if (!this.close()) return;
    const store = getActiveServerStore();
    const client = getActiveNetworkClient();
    const serverId = store.serverDetails?.id;
    const sessionId = store.currentUser?.sessionId;
    const userId = store.currentUser?.id;
    if (!serverId) return;
    this.invalidated = false;
    this.activeTab = initialTab ?? this.activeTab;

    const isCurrent = () => !this.invalidated && isForegroundEvent() &&
      getActiveServerStore() === store && getActiveNetworkClient() === client &&
      client.getStatus() === 'CONNECTED' &&
      store.serverDetails?.id === serverId && store.currentUser?.sessionId === sessionId && store.currentUser?.id === userId;
    const assertAllowed = (permission?: Permission) => {
      if (!isCurrent() || client.getStatus() !== 'CONNECTED') throw new Error(t('serverSettings.sessionChanged'));
      if (permission !== undefined && !store.hasPermission(permission)) throw new Error(t('protocolError.permissionDenied'));
    };
    const operations = new ServerSettingsOperations({
      validate: assertAllowed,
      changed: () => this.refreshState(),
      errorMessage: (error) => error instanceof RequestTimeoutError
        ? t('serverSettings.applyTimeout')
        : error instanceof Error && error.message.trim() ? error.message : t('serverSettings.saveError'),
    });
    this.context = {
      client, store, operations, isCurrent, assertAllowed,
      request: <T>(type: MessageType, payload: object, permission: Permission, timeoutMs?: number) => {
        assertAllowed(permission);
        return client.sendRequest<T>(type, payload, undefined, timeoutMs);
      },
    };

    const tabs = [
      { id: 'general', icon: 'tune', title: 'serverSettings.tabGeneral', permission: Permission.MANAGE_SERVER, html: this.generalTab.renderHtml() },
      { id: 'security', icon: 'lock', title: 'serverSettings.tabSecurity', permission: Permission.MANAGE_SERVER, html: new ServerSecurityTab().renderHtml() },
      { id: 'voice_video', icon: 'music_note', title: 'serverSettings.tabVoiceVideo', permission: Permission.MANAGE_SERVER, html: new ServerVoiceVideoTab().renderHtml() },
      { id: 'storage', icon: 'cloud', title: 'serverSettings.tabStorage', permission: Permission.MANAGE_SERVER, html: this.storageTab.renderHtml() },
      { id: 'notifications', icon: 'notifications', title: 'serverSettings.tabNotifications', permission: undefined, html: new ServerNotificationsTab().renderHtml() },
      { id: 'members', icon: 'group', title: 'serverSettings.tabMembers', permission: Permission.MANAGE_ROLES, html: new ServerMembersTab().renderHtml() },
      { id: 'roles', icon: 'admin_panel_settings', title: 'serverSettings.tabRoles', permission: undefined, html: this.rolesTab.renderHtml() },
      { id: 'bots', icon: 'smart_toy', title: 'serverSettings.tabBots', permission: Permission.MANAGE_BOTS, html: this.botsTab.renderHtml() },
    ] as const;
    if (!tabs.some((tab) => tab.id === this.activeTab)) this.activeTab = 'general';
    this.modalEl = document.createElement('div');
    this.modalEl.className = 'modal-backdrop';
    this.modalEl.innerHTML = `
      <div class="modal-card settings-modal-card server-settings-modal-card" role="dialog" aria-modal="true" aria-label="${t('serverSettings.title')}">
        <div class="settings-sidebar">
          <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; color: var(--text-muted); padding: 4px 10px 8px;">${t('connection.settingsTitle')}</div>
          ${tabs.map((tab) => `
            <button type="button" class="settings-tab-btn" data-tab="${tab.id}">
              <span class="material-symbols-outlined md-18">${tab.icon}</span>
              <span>${t(tab.title)}</span>
            </button>`).join('')}
        </div>
        <div class="settings-main-container">
          <div class="settings-content-header">
            <div id="server-settings-tab-title" style="font-size: 16px; font-weight: 700; display: flex; align-items: center; gap: 8px;"></div>
            <button type="button" id="modal-close" class="settings-back-btn" title="${t('common.done')} (ESC)">
              <span class="material-symbols-outlined md-18">close</span><span class="esc-hint">ESC</span>
            </button>
          </div>
          <form id="form-server-settings" novalidate style="display: flex; flex-direction: column; flex: 1; min-height: 0; margin: 0;">
            <div class="settings-content-body">
              ${tabs.map((tab) => `
                <div class="settings-tab-panel" id="tab-panel-${tab.id}">
                  <fieldset class="server-settings-fieldset" ${tab.permission === undefined ? 'data-server-local' : `data-server-permission="${tab.permission}"`}>${tab.html}</fieldset>
                </div>`).join('')}
            </div>
            <div id="server-settings-banner" class="error-banner server-settings-errors" role="alert" aria-live="polite"></div>
            <div id="turn-install-progress" class="turn-install-progress" hidden>
              <div class="turn-install-progress-head">
                <span class="material-symbols-outlined md-16">download</span>
                <span id="turn-install-stage">${t('serverSettings.turnInstallTitle')}</span>
                <span id="turn-install-percent" class="turn-install-percent">0%</span>
              </div>
              <div class="turn-install-bar"><div id="turn-install-bar-fill" class="turn-install-bar-fill" style="width: 0%;"></div></div>
              <div class="turn-install-hint">${t('serverSettings.turnInstallHint')}</div>
            </div>
            <div class="modal-footer" style="padding: 14px 24px; border-top: 1px solid var(--border-color); background: var(--bg-panel); margin-top: auto; gap: 16px;">
              <span id="server-settings-status" class="server-settings-status" role="status" aria-live="polite">${t('serverSettings.immediateHint')}</span>
              <button type="button" id="btn-done" class="btn btn-primary">${t('common.done')}</button>
            </div>
          </form>
        </div>
      </div>`;
    document.body.appendChild(this.modalEl);
    this.domEvents = new AbortController();
    this.attachEvents();
    this.sectionNavigation = new SettingsSectionNavigation(this.modalEl);
    this.switchTab(this.activeTab);
    this.refreshState();
  }

  private switchTab(tabName: string): void {
    const root = this.modalEl;
    const button = root?.querySelector<HTMLButtonElement>(`[data-tab="${tabName}"]`);
    if (!root || !button || button.hidden) return;
    this.finishEditing();
    this.activeTab = tabName;
    root.querySelectorAll<HTMLButtonElement>('.settings-tab-btn').forEach((tab) => {
      tab.classList.toggle('active', tab === button);
    });
    root.querySelectorAll<HTMLElement>('.settings-tab-panel').forEach((panel) => {
      panel.style.display = panel.id === `tab-panel-${tabName}` ? 'flex' : 'none';
    });
    const title = root.querySelector('#server-settings-tab-title');
    if (title) title.innerHTML = button.innerHTML;
    this.sectionNavigation?.setTab(tabName);
  }

  private attachEvents(): void {
    const root = this.modalEl;
    const context = this.context;
    if (!root || !context) return;
    const options = { signal: this.domEvents.signal };
    root.querySelector('#modal-close')?.addEventListener('click', () => this.close(), options);
    root.querySelector('#btn-done')?.addEventListener('click', () => this.close(), options);
    root.addEventListener('mousedown', (event) => { if (event.target === root) this.close(); }, options);
    const escape = (event: KeyboardEvent) => {
      const backdrops = document.querySelectorAll('.modal-backdrop');
      if (event.key !== 'Escape' || backdrops.item(backdrops.length - 1) !== root) return;
      if (root.querySelector('.color-picker-popover:popover-open')) return;
      event.preventDefault();
      this.close();
    };
    window.addEventListener('keydown', escape, true);
    this.unbind.push(() => window.removeEventListener('keydown', escape, true), this.generalTab.attach(root));
    root.querySelector('#form-server-settings')?.addEventListener('submit', (event) => {
      event.preventDefault();
      this.finishEditing();
    }, options);
    root.querySelectorAll<HTMLButtonElement>('.settings-tab-btn').forEach((button) => {
      button.addEventListener('click', () => this.switchTab(button.dataset.tab ?? 'general'), options);
    });
    const details = () => context.store.serverDetails;
    this.bindSetting('#input-server-name', 'name', 'serverSettings.nameLabel',
      () => details()?.name ?? '', (value) => ({ name: value.trim() }));
    this.bindSetting('#input-server-pass', 'password', 'invite.passwordLabel', () => '',
      (value) => value ? { password: value } : null);
    const memberPatch = (): ServerUpdateSettingsPayload => {
      const limited = root.querySelector<HTMLInputElement>('#checkbox-limit-members')?.checked;
      const value = Number(root.querySelector<HTMLInputElement>('#input-max-users')?.value);
      return { maxUsers: limited ? (value >= 1 ? value : Number.NaN) : LIMITS.MAX_USERS_UNLIMITED };
    };
    this.bindSetting('#checkbox-limit-members', 'maxUsers', 'serverSettings.memberLimitLabel',
      () => String((details()?.maxUsers ?? 0) > 0), memberPatch);
    this.bindSetting('#input-max-users', 'maxUsers', 'serverSettings.memberLimitLabel',
      () => String((details()?.maxUsers ?? 0) > 0 ? details()?.maxUsers : Math.max(
        context.store.knownMembers.size, LIMITS.MAX_USERS_DEFAULT,
      )), memberPatch);
    this.bindSetting('#input-attach-file-mb', 'fileLimit', 'serverSettings.limitPerFile',
      () => String((details()?.attachmentStorage?.maxFileBytes ?? LIMITS.MAX_ATTACHMENT_FILE_SIZE_DEFAULT) / (1024 * 1024)),
      (value) => ({ maxAttachmentFileBytes: Math.round(Number(value) * 1024 * 1024) }));
    this.bindSetting('#input-attach-total-mb', 'storageLimit', 'serverSettings.limitTotal',
      () => String((details()?.attachmentStorage?.maxTotalBytes ?? LIMITS.MAX_ATTACHMENT_STORAGE_TOTAL_DEFAULT) / (1024 * 1024)),
      (value) => ({ maxAttachmentStorageBytes: Math.round(Number(value) * 1024 * 1024) }));
    this.bindSetting('#checkbox-allow-soundboard', 'soundboard', 'serverSettings.allowSoundboard',
      () => String(details()?.allowSoundboard !== false), (value) => ({ allowSoundboard: value === 'true' }));
    this.bindSetting('#checkbox-allow-everyone-mention', 'everyone', 'serverSettings.allowEveryoneMention',
      () => String(details()?.allowEveryoneMention !== false), (value) => ({ allowEveryoneMention: value === 'true' }));
    this.bindSetting('#checkbox-allow-message-edit', 'messageEdit', 'serverSettings.allowMessageEdit',
      () => String(details()?.allowMessageEdit !== false), (value) => ({ allowMessageEdit: value === 'true' }));
    this.bindSetting('#checkbox-show-role-badges', 'roleBadges', 'roles.badgeVisibility',
      () => String(details()?.showRoleBadgesToEveryone !== false), (value) => ({ showRoleBadgesToEveryone: value === 'true' }));
    this.bindSetting('#checkbox-turn-enabled', 'turn', 'serverSettings.turnEnabled',
      () => String(Boolean(details()?.turnEnabled)), (value) => ({ turnEnabled: value === 'true' }));

    this.bindField('#select-server-chat-sound', 'chatSound',
      () => settingsStore.getServerChatSoundOverride(details()?.id), (value) => {
        void context.operations.run('chatSound', t('serverSettings.chatSoundLabel'), undefined, async () => {
          if (value !== 'inherit' && value !== 'all' && value !== 'mentions' && value !== 'none') {
            throw new Error(t('serverSettings.invalidValue'));
          }
          const id = details()?.id;
          if (!id) throw new Error(t('serverSettings.sessionChanged'));
          await settingsStore.setServerChatSoundOverride(id, value);
        });
      });

    const inputName = root.querySelector<HTMLInputElement>('#input-server-name');
    const emojiButton = root.querySelector<HTMLButtonElement>('#btn-emoji-server-name');
    if (inputName && emojiButton) this.unbind.push(attachInputEmojiPicker(inputName, emojiButton));
    root.querySelector('#btn-remove-pass')?.addEventListener('click', () => {
      this.applyPatch('password', t('invite.passwordLabel'), { password: null });
    }, options);
    root.querySelector('#server-icon-wrapper')?.addEventListener('click', () => {
      if (context.operations.isPending('icon')) return;
      void context.operations.run('icon', t('serverSettings.iconAlt'), Permission.MANAGE_SERVER, async () => {
        const action = await this.showIconActionModal(Boolean(details()?.iconUrl));
        if (!action) return;
        const image = action === 'change' ? await pickAndCropImage() : null;
        if (action === 'change' && !image) return;
        await context.request<ServerSettingsUpdatedPayload>(
          MessageType.SERVER_UPDATE_SETTINGS, { iconBase64: image }, Permission.MANAGE_SERVER, 11 * 60 * 1000,
        );
      });
    }, options);
    root.querySelectorAll<HTMLButtonElement>('#server-voice-mode-cards [data-mode]').forEach((card) => {
      card.addEventListener('click', () => {
        const mode = card.dataset.mode;
        if (mode !== 'p2p' && mode !== 'sfu') return;
        const current = root.querySelector<HTMLInputElement>('#input-server-voice-mode');
        if (current?.value === mode) return;
        this.applyPatch('voiceMode', t('serverSettings.voiceModeLabel'), { voiceMode: mode });
        this.syncVoiceCards(mode);
      }, options);
    });
    this.rolesTab.attachEvents(root, context);
    this.botsTab.attachEvents(root, context);
    const refresh = () => {
      if (!isForegroundEvent()) return;
      if (!context.isCurrent() || context.client.getStatus() !== 'CONNECTED') {
        if (!this.invalidated) {
          this.invalidated = true;
          context.operations.reportError('session', t('serverSettings.title'), t('serverSettings.sessionChanged'));
        }
      }
      this.refreshState();
    };
    for (const event of ['server.updated', 'server.roles_updated', 'server.members_updated', 'session.changed', 'network.status', 'network.connected', 'settings.updated']) {
      this.unbind.push(appEvents.on(event, refresh));
    }
    window.addEventListener('storage', refresh);
    this.unbind.push(() => window.removeEventListener('storage', refresh));
  }

  private bindSetting(
    selector: string, key: string, label: TranslationKey, persisted: () => string,
    patch: (value: string) => ServerUpdateSettingsPayload | null,
  ): void {
    this.bindField(selector, key, persisted, (value) => {
      const update = patch(value);
      if (update) this.applyPatch(key, t(label), update);
      else this.refreshState();
    });
  }

  private bindField(selector: string, key: string, persisted: () => string, apply: (value: string) => void): void {
    const input = this.modalEl?.querySelector<HTMLInputElement | HTMLSelectElement>(selector);
    if (!input) return;
    const options = { signal: this.domEvents.signal };
    const value = () => input instanceof HTMLInputElement && input.type === 'checkbox' ? String(input.checked) : input.value;
    const binding: FieldBinding = {
      input, key, persisted, submitted: value(), dirty: false,
      commit: () => {
        const next = value();
        binding.dirty = false;
        if (next === binding.submitted || input.matches(':disabled')) return;
        binding.submitted = next;
        apply(next);
      },
    };
    this.bindings.push(binding);
    input.addEventListener('input', () => { binding.dirty = true; }, options);
    input.addEventListener('change', binding.commit, options);
    input.addEventListener('blur', binding.commit, options);
    input.addEventListener('keydown', (event) => {
      if (event instanceof KeyboardEvent && event.key === 'Enter') {
        event.preventDefault();
        binding.commit();
        input.blur();
      }
    }, options);
  }

  private applyPatch(key: string, label: string, patch: ServerUpdateSettingsPayload): void {
    const context = this.context;
    if (!context) return;
    void context.operations.run(key, label, Permission.MANAGE_SERVER, async () => {
      const persisted = context.store.serverDetails;
      if (!persisted) throw new Error(t('serverSettings.sessionChanged'));
      const error = serverSettingsValidationError(patch, persisted, context.store.knownMembers.size);
      if (error) throw new Error(t(error));
      if (patch.voiceMode === 'p2p' && persisted.voiceMode === 'sfu') {
        const confirmed = await showConfirm({
          title: t('serverSettings.voiceModeDisconnectTitle'),
          message: t('serverSettings.voiceModeDisconnectMessage'),
          confirmLabel: t('serverSettings.voiceModeDisconnectConfirm'),
          cancelLabel: t('common.cancel'), variant: 'warning',
        });
        if (!confirmed) return;
      }
      const stopProgress = patch.turnEnabled && !persisted.turnAvailability?.supported
        ? this.trackInstallProgress(context) : null;
      try {
        // Another administrator can already be installing TURN in the server's
        // shared settings queue, even when this particular patch is a rename.
        await context.request<ServerSettingsUpdatedPayload>(
          MessageType.SERVER_UPDATE_SETTINGS, patch, Permission.MANAGE_SERVER, 11 * 60 * 1000,
        );
      } finally {
        stopProgress?.();
      }
    });
  }

  private refreshState(): void {
    const root = this.modalEl;
    const context = this.context;
    if (!root || !context) return;
    if (!this.invalidated && isForegroundEvent() &&
      (!context.isCurrent() || context.client.getStatus() !== 'CONNECTED')) {
      this.invalidated = true;
      context.operations.reportError('session', t('serverSettings.title'), t('serverSettings.sessionChanged'));
      return;
    }
    const { operations, store } = context;
    const pending = operations.pendingCount > 0;
    root.querySelectorAll<HTMLButtonElement>('#modal-close, #btn-done').forEach((button) => { button.disabled = pending; });
    root.querySelector('#form-server-settings')?.setAttribute('aria-busy', String(pending));
    const status = root.querySelector('#server-settings-status');
    if (status) status.textContent = pending
      ? t('serverSettings.applying', { count: operations.pendingCount })
      : t('serverSettings.immediateHint');
    const banner = root.querySelector('#server-settings-banner');
    if (banner) {
      banner.textContent = operations.failures.map((failure) => `${failure.label}: ${failure.message}`).join('\n');
      banner.classList.toggle('show', operations.failures.length > 0);
    }
    root.querySelectorAll<HTMLFieldSetElement>('fieldset[data-server-permission], fieldset[data-server-local]').forEach((fieldset) => {
      const permission = Number(fieldset.dataset.serverPermission);
      fieldset.disabled = this.invalidated || (!fieldset.hasAttribute('data-server-local') && !store.hasPermission(permission));
    });
    for (const [tab, permission] of [['members', Permission.MANAGE_ROLES], ['roles', Permission.MANAGE_ROLES], ['bots', Permission.MANAGE_BOTS]] as const) {
      const button = root.querySelector<HTMLButtonElement>(`[data-tab="${tab}"]`);
      if (button) button.hidden = !store.hasPermission(permission) && !(tab === 'roles' && store.hasPermission(Permission.MANAGE_SERVER));
      if (button?.hidden && this.activeTab === tab) this.switchTab('general');
    }
    if (this.invalidated || !context.isCurrent()) return;
    for (const binding of this.bindings) {
      binding.input.setAttribute('aria-busy', String(operations.isPending(binding.key)));
      if (operations.isPending(binding.key) || binding.dirty) continue;
      const value = binding.persisted();
      if (binding.input instanceof HTMLInputElement && binding.input.type === 'checkbox') binding.input.checked = value === 'true';
      else binding.input.value = value;
      binding.submitted = value;
    }
    const s = store.serverDetails;
    if (!s) return;
    const limitGroup = root.querySelector<HTMLElement>('#max-users-group');
    if (limitGroup) limitGroup.hidden = !root.querySelector<HTMLInputElement>('#checkbox-limit-members')?.checked;
    if (!operations.isPending('voiceMode')) this.syncVoiceCards(s.voiceMode ?? 'p2p');
    const voiceCards = root.querySelector('#server-voice-mode-cards');
    voiceCards?.setAttribute('aria-busy', String(operations.isPending('voiceMode')));
    const blockedTurn = turnBlockedReason();
    const turn = root.querySelector<HTMLInputElement>('#checkbox-turn-enabled');
    if (turn) turn.disabled = Boolean(blockedTurn) && !s.turnEnabled;
    const notice = root.querySelector<HTMLElement>('#server-turn-notice');
    if (notice) {
      notice.textContent = blockedTurn ?? (!s.turnAvailability?.supported && s.turnAvailability?.autoInstallable ? t('serverSettings.turnWillInstall') : '');
      notice.hidden = !notice.textContent;
    }
    const icon = root.querySelector<HTMLImageElement>('#server-icon-preview');
    if (icon) icon.src = s.iconUrl ? getAvatarUrl(s.iconUrl) : logoUrl;
    root.querySelector('#server-icon-wrapper')?.setAttribute('aria-busy', String(operations.isPending('icon')));
    const removePassword = root.querySelector<HTMLButtonElement>('#btn-remove-pass');
    if (removePassword) removePassword.hidden = !s.hasPassword;
    const passwordTitle = root.querySelector('#password-status-title');
    if (passwordTitle) passwordTitle.textContent = t(s.hasPassword ? 'serverSettings.statusProtected' : 'serverSettings.statusOpen');
    const passwordDescription = root.querySelector('#password-status-desc');
    if (passwordDescription) passwordDescription.textContent = t(s.hasPassword ? 'serverSettings.statusProtectedDesc' : 'serverSettings.statusOpenDesc');
    const passwordLabel = root.querySelector('#label-password-field');
    if (passwordLabel) passwordLabel.textContent = t(s.hasPassword ? 'serverSettings.changePasswordLabel' : 'serverSettings.setPasswordLabel');
    const password = root.querySelector<HTMLInputElement>('#input-server-pass');
    if (password) password.placeholder = t(s.hasPassword ? 'serverSettings.changePasswordPlaceholder' : 'serverSettings.setPasswordPlaceholder');
    const passwordIcon = root.querySelector<HTMLElement>('#password-status-icon');
    if (passwordIcon) {
      passwordIcon.textContent = s.hasPassword ? 'lock' : 'lock_open';
      passwordIcon.style.color = s.hasPassword ? '#f0b232' : '#23a55a';
    }
    const memberCount = root.querySelector('#server-settings-member-count');
    if (memberCount) memberCount.textContent = t('serverSettings.membersCount', { count: store.knownMembers.size });
    const memberLimitHint = root.querySelector('#server-settings-member-limit-hint');
    if (memberLimitHint) memberLimitHint.textContent = t('serverSettings.memberLimitHint', { count: store.knownMembers.size });
    const channelCount = root.querySelector('#server-settings-channel-count');
    if (channelCount) channelCount.textContent = t('serverSettings.channelsCount', { count: s.channels.length });
    this.rolesTab.refreshState();
    this.botsTab.refreshPermissions();
    this.storageTab.refreshState(root);
  }

  private syncVoiceCards(mode: 'p2p' | 'sfu'): void {
    const input = this.modalEl?.querySelector<HTMLInputElement>('#input-server-voice-mode');
    if (input) input.value = mode;
    this.modalEl?.querySelectorAll<HTMLButtonElement>('#server-voice-mode-cards [data-mode]').forEach((card) => {
      const selected = card.dataset.mode === mode;
      card.classList.toggle('selected', selected);
      card.setAttribute('aria-pressed', String(selected));
      card.style.borderColor = selected ? 'var(--accent-primary)' : 'var(--border-color)';
      card.style.background = selected ? 'rgba(88, 101, 242, 0.1)' : 'var(--bg-card-secondary)';
      const icon = card.querySelector<HTMLElement>('.material-symbols-outlined');
      if (icon) icon.style.color = selected ? 'var(--accent-primary)' : 'var(--text-muted)';
    });
  }

  private showIconActionModal(hasCustomIcon: boolean): Promise<'change' | 'remove' | null> {
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      backdrop.style.zIndex = '10001';
      backdrop.innerHTML = `
        <div class="modal-card dialog-card" role="dialog" aria-modal="true" style="max-width: 380px;">
          <div class="modal-header"><div class="modal-title">${t('serverSettings.photoDialogTitle')}</div>
            <button type="button" class="modal-close-btn" data-action="cancel" aria-label="${t('common.cancel')}">&times;</button></div>
          <div class="dialog-message">${t('serverSettings.photoDialogPrompt')}</div>
          <div style="display: flex; flex-direction: column; gap: 8px;">
            <button type="button" class="btn btn-primary" data-action="change">${t('settings.avatarChange')}</button>
            ${hasCustomIcon ? `<button type="button" class="btn btn-danger" data-action="remove">${t('settings.avatarRemove')}</button>` : ''}
            <button type="button" class="btn btn-secondary" data-action="cancel">${t('common.cancel')}</button>
          </div>
        </div>`;
      const settle = (result: 'change' | 'remove' | null) => {
        document.removeEventListener('keydown', keydown, true);
        backdrop.remove();
        resolve(result);
      };
      const keydown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') { event.stopPropagation(); settle(null); }
      };
      backdrop.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((button) => {
        button.addEventListener('click', () => {
          const action = button.dataset.action;
          settle(action === 'change' || action === 'remove' ? action : null);
        });
      });
      enableBackdropClose(backdrop, () => settle(null));
      document.addEventListener('keydown', keydown, true);
      document.body.appendChild(backdrop);
    });
  }

  private trackInstallProgress(context: ServerSettingsContext): () => void {
    const panel = this.modalEl?.querySelector<HTMLElement>('#turn-install-progress');
    const stage = this.modalEl?.querySelector('#turn-install-stage');
    const percent = this.modalEl?.querySelector('#turn-install-percent');
    const fill = this.modalEl?.querySelector<HTMLElement>('#turn-install-bar-fill');
    if (panel) panel.hidden = false;
    if (stage) stage.textContent = t('serverSettings.turnInstallTitle');
    if (percent) percent.textContent = '0%';
    if (fill) fill.style.width = '0%';
    const labels: Record<TurnInstallStage, string> = {
      refreshing: t('serverSettings.turnInstallStageRefreshing'),
      installing: t('serverSettings.turnInstallStageInstalling'),
      configuring: t('serverSettings.turnInstallStageConfiguring'),
    };
    const unsubscribe = appEvents.on(`message.${MessageType.TURN_INSTALL_PROGRESS}`, (progress: TurnInstallProgressPayload) => {
      if (!context.isCurrent() || (currentEventOrigin() && currentEventOrigin() !== context.client.sessionKey)) return;
      const value = Math.max(0, Math.min(100, progress.percent));
      if (stage) stage.textContent = labels[progress.stage];
      if (percent) percent.textContent = `${value}%`;
      if (fill) fill.style.width = `${value}%`;
    });
    return () => { unsubscribe(); if (panel) panel.hidden = true; };
  }

  private finishEditing(): void {
    // Public close/reopen and Escape do not naturally blur an input. Committing
    // before checking the lock closes those otherwise easy-to-miss paths.
    for (const binding of this.bindings) if (binding.dirty) binding.commit();
    const active = document.activeElement;
    if ((active instanceof HTMLInputElement || active instanceof HTMLSelectElement || active instanceof HTMLTextAreaElement) &&
      this.modalEl?.contains(active)) active.blur();
  }

  public close(): boolean {
    if (!this.modalEl) return true;
    this.finishEditing();
    if (this.context?.operations.pendingCount) return false;
    this.sectionNavigation?.destroy();
    this.sectionNavigation = null;
    this.domEvents.abort();
    for (const cleanup of this.unbind) cleanup();
    this.unbind = [];
    this.rolesTab.detachEvents();
    this.botsTab.detachEvents();
    this.modalEl.remove();
    this.modalEl = null;
    this.context = null;
    this.bindings = [];
    return true;
  }
}

export const serverSettingsModal = new ServerSettingsModal();
