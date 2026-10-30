import {
  LIMITS, MessageType, Permission,
  type ServerUpdateSettingsPayload, type ServerSettingsUpdatedPayload,
  type TurnInstallProgressPayload, type TurnInstallStage, type ClientMessageArgs,
} from '@monky/shared';
import { getActiveNetworkClient, RequestTimeoutError } from '../core/NetworkClient';
import { appEvents } from '../core/EventBus';
import { currentEventOrigin, isForegroundEvent } from '../core/sessionRouting';
import { getActiveServerStore } from '../stores/serverStore';
import { settingsStore } from '../stores/settingsStore';
import { t, type TranslationKey } from '../i18n';
import { escapeHtml } from '../utils/html';
import { openModal, type ModalShell } from '../utils/modalShell';
import { reportError } from '../utils/feedback';
import { selectChoiceCard } from '../utils/formControls';
import { setSurfaceVisible } from '../utils/surfaceVisibility';
import { getAvatarUrl } from '../utils/avatar';
import { afkChannelIdOf } from '../utils/voiceRooms';
import logoUrl from '../assets/Logo.png';
import { pickAndCropImage } from './ImageCropModal';
import { attachInputEmojiPicker } from '../utils/inputEmojiPicker';
import { showConfirm } from './Dialog';
import { ServerGeneralTab } from './serverSettings/tabs/ServerGeneralTab';
import { ServerSecurityTab } from './serverSettings/tabs/ServerSecurityTab';
import { ServerVoiceVideoTab, afkChannelName, turnBlockedReason } from './serverSettings/tabs/ServerVoiceVideoTab';
import { ServerStorageTab } from './serverSettings/tabs/ServerStorageTab';
import { ServerNotificationsTab } from './serverSettings/tabs/ServerNotificationsTab';
import { ServerMembersTab } from './serverSettings/tabs/ServerMembersTab';
import { ServerRolesTab } from './serverSettings/tabs/ServerRolesTab';
import { ServerBotsTab } from './serverSettings/tabs/ServerBotsTab';
import { ServerCommunitySettings } from './serverSettings/ServerCommunitySettings';
import { sessionManager } from '../core/SessionManager';
import { SettingsSectionNavigation } from './settings/SettingsSectionNavigation';
import { renderSettingsTabButtons, renderSettingsTabLabel, selectSettingsTab, type SettingsTabEntry } from './settings/settingsLayout';
import { ServerSettingsOperations, type ServerSettingsFailure } from './serverSettings/ServerSettingsOperations';
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
  private shell: ModalShell | null = null;
  private modalEl: HTMLElement | null = null;
  private context: ServerSettingsContext | null = null;
  private invalidated = false;
  private activeTab = 'general';
  private tabs: readonly SettingsTabEntry[] = [];
  private sectionNavigation: SettingsSectionNavigation | null = null;
  private unbind: Array<() => void> = [];
  private domEvents = new AbortController();
  private bindings: FieldBinding[] = [];
  private generalTab = new ServerGeneralTab();
  private storageTab = new ServerStorageTab();
  private rolesTab = new ServerRolesTab();
  private botsTab = new ServerBotsTab();
  private communitySettings: ServerCommunitySettings | null = null;

  public open(initialTab?: string): void {
    if (!this.close()) return;
    const store = getActiveServerStore();
    const client = getActiveNetworkClient();
    const serverId = store.serverDetails?.id;
    const sessionId = store.currentUser?.sessionId;
    const userId = store.currentUser?.id;
    if (!serverId) return;
    const community = sessionManager.getActive()?.community;
    this.communitySettings = community ? new ServerCommunitySettings(community) : null;
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
      failed: (failure) => this.showFailure(failure),
    });
    this.context = {
      client, store, operations, isCurrent, assertAllowed,
      request: <T>(message: ClientMessageArgs, permission: Permission, timeoutMs?: number) => {
        assertAllowed(permission);
        return client.sendRequest<T>(...message, undefined, timeoutMs);
      },
    };

    const tabs: Array<SettingsTabEntry & { permission: Permission | undefined; html: string }> = [
      { id: 'general', icon: 'tune', label: 'serverSettings.tabGeneral', permission: undefined, html: this.generalTab.renderHtml(this.communitySettings) },
      { id: 'security', icon: 'lock', label: 'serverSettings.tabSecurity', permission: Permission.MANAGE_SERVER, html: new ServerSecurityTab().renderHtml() },
      { id: 'voice_video', icon: 'music_note', label: 'serverSettings.tabVoiceVideo', permission: Permission.MANAGE_SERVER, html: new ServerVoiceVideoTab().renderHtml() },
      { id: 'storage', icon: 'cloud', label: 'serverSettings.tabStorage', permission: Permission.MANAGE_SERVER, html: this.storageTab.renderHtml() },
      { id: 'notifications', icon: 'notifications', label: 'serverSettings.tabNotifications', permission: undefined, html: new ServerNotificationsTab().renderHtml() },
      { id: 'members', icon: 'group', label: 'serverSettings.tabMembers', permission: Permission.MANAGE_ROLES, html: new ServerMembersTab().renderHtml() },
      { id: 'roles', icon: 'admin_panel_settings', label: 'serverSettings.tabRoles', permission: undefined, html: this.rolesTab.renderHtml() },
      { id: 'bots', icon: 'smart_toy', label: 'serverSettings.tabBots', permission: Permission.MANAGE_BOTS, html: this.botsTab.renderHtml() },
    ];
    if (!tabs.some((tab) => tab.id === this.activeTab)) this.activeTab = 'general';
    this.tabs = tabs;
    const shell = openModal({
      card: `
      <div class="modal-card settings-modal-card server-settings-modal-card" aria-label="${escapeHtml(t('serverSettings.title'))}">
        <div class="settings-sidebar">
          ${renderSettingsTabButtons(tabs, this.activeTab)}
        </div>
        <div class="settings-main-container">
          <div class="settings-content-header">
            <div id="server-settings-tab-title" class="settings-tab-title"></div>
            <button type="button" id="modal-close" class="settings-back-btn" data-modal-close title="${t('common.done')} (ESC)" aria-label="${escapeHtml(t('common.done'))}">
              <span class="material-symbols-outlined md-18">close</span><span class="esc-hint">ESC</span>
            </button>
          </div>
          <form id="form-server-settings" novalidate style="display: flex; flex-direction: column; flex: 1; min-height: 0; margin: 0;">
            <div class="settings-content-body">
              ${tabs.map((tab) => `
                <div class="settings-tab-panel" id="tab-panel-${tab.id}" ${tab.id === this.activeTab ? '' : 'hidden'}>
                  <fieldset class="server-settings-fieldset" ${tab.permission === undefined ? 'data-server-local' : `data-server-permission="${tab.permission}"`}>${tab.html}</fieldset>
                </div>`).join('')}
            </div>
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
              <button type="button" id="btn-done" class="btn btn-primary" data-modal-close>${t('common.done')}</button>
            </div>
          </form>
        </div>
      </div>`,
      initialFocus: false,
      // Closing first commits a field being typed; it waits while any edit is still being applied.
      canClose: () => {
        this.finishEditing();
        return !this.context?.operations.pendingCount;
      },
      onClose: () => this.teardown(),
    });
    this.shell = shell;
    this.modalEl = shell.element;
    this.domEvents = new AbortController();
    this.attachEvents();
    this.sectionNavigation = new SettingsSectionNavigation(this.modalEl);
    this.switchTab(this.activeTab);
    this.refreshState();
    shell.card.querySelector<HTMLElement>(`[data-tab="${this.activeTab}"]`)?.focus({ preventScroll: true });
  }

  private switchTab(tabName: string): void {
    const root = this.modalEl;
    const button = root?.querySelector<HTMLButtonElement>(`[data-tab="${tabName}"]`);
    if (!root || !button || button.hidden) return;
    this.finishEditing();
    this.activeTab = tabName;
    selectSettingsTab(root, tabName);
    root.querySelectorAll<HTMLElement>('.settings-tab-panel').forEach((panel) => {
      panel.hidden = panel.id !== `tab-panel-${tabName}`;
    });
    const title = root.querySelector('#server-settings-tab-title');
    const entry = this.tabs.find((tab) => tab.id === tabName);
    if (title && entry) title.innerHTML = renderSettingsTabLabel(entry).toString();
    this.sectionNavigation?.setTab(tabName);
  }

  private attachEvents(): void {
    const root = this.modalEl;
    const context = this.context;
    if (!root || !context) return;
    const options = { signal: this.domEvents.signal };
    if (this.communitySettings) this.unbind.push(this.communitySettings.attach(root, context));
    this.unbind.push(this.generalTab.attach(root));
    root.querySelector('#form-server-settings')?.addEventListener('submit', (event) => {
      event.preventDefault();
      this.finishEditing();
    }, options);
    root.querySelectorAll<HTMLButtonElement>('.settings-tab-btn').forEach((button) => {
      button.addEventListener('click', () => this.switchTab(button.dataset.tab ?? 'general'), options);
    });
    const details = () => context.store.serverDetails;
    const messageLimitPatch = (): ServerUpdateSettingsPayload => {
      const value = Number(root.querySelector<HTMLInputElement>('#input-message-limit')?.value);
      return { maxMessageLength: root.querySelector<HTMLInputElement>('#toggle-message-limit')?.checked
        ? value >= 1 ? value : Number.NaN : 0 };
    };
    this.bindSetting('#toggle-message-limit', 'messageLength', 'serverSettings.messageLimit',
      () => String((details()?.maxMessageLength ?? LIMITS.MAX_MESSAGE_LENGTH) > 0), messageLimitPatch);
    this.bindSetting('#input-message-limit', 'messageLength', 'serverSettings.messageLimit',
      () => String(details()?.maxMessageLength || LIMITS.MAX_MESSAGE_LENGTH), messageLimitPatch);
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
    this.bindSetting('#checkbox-recent-sounds', 'recentSounds', 'serverSettings.recentSounds',
      () => String(Boolean(details()?.recentSoundCacheEnabled)),
      (value) => ({ recentSoundCacheEnabled: value === 'true' }));
    this.bindSetting('#input-recent-sounds-limit', 'recentSoundsLimit', 'serverSettings.recentSoundsLimit',
      () => String(details()?.recentSoundCacheLimit ?? LIMITS.RECENT_SOUND_CACHE_DEFAULT_LIMIT),
      (value) => ({ recentSoundCacheLimit: Number(value) }));
    this.bindSetting('#checkbox-dm-relay-enabled', 'dmRelay', 'serverSettings.dmRelayEnabled',
      () => String(details()?.dmRelayEnabled !== false), (value) => ({ dmRelayEnabled: value === 'true' }));
    // Turning the AFK channel on creates it with the name typed below; renaming applies once it exists.
    this.bindSetting('#checkbox-afk-channel', 'afkChannel', 'serverSettings.afkChannel',
      () => String(!!afkChannelIdOf(details())),
      (value) => value === 'true' ? {
        afkChannelEnabled: true,
        afkChannelName: root.querySelector<HTMLInputElement>('#input-afk-channel-name')?.value.trim()
          || t('serverSettings.afkChannelDefaultName'),
      } : { afkChannelEnabled: false });
    this.bindSetting('#input-afk-channel-name', 'afkChannelName', 'serverSettings.afkChannelName',
      afkChannelName, (value) => afkChannelIdOf(details()) ? { afkChannelName: value.trim() } : null);
    this.bindSetting('#select-afk-timeout', 'afkTimeout', 'serverSettings.afkTimeout',
      () => String(details()?.afkTimeoutSeconds ?? LIMITS.AFK_TIMEOUT_DEFAULT_SECONDS),
      (value) => ({ afkTimeoutSeconds: Number(value) }));
    this.bindSetting('#checkbox-allow-everyone-mention', 'everyone', 'serverSettings.allowEveryoneMention',
      () => String(details()?.allowEveryoneMention !== false), (value) => ({ allowEveryoneMention: value === 'true' }));
    this.bindSetting('#checkbox-allow-message-edit', 'messageEdit', 'serverSettings.allowMessageEdit',
      () => String(details()?.allowMessageEdit !== false), (value) => ({ allowMessageEdit: value === 'true' }));
    this.bindSetting('#input-delete-undo', 'deleteUndo', 'serverSettings.deleteUndo',
      () => String(details()?.messageDeleteUndoSeconds ?? LIMITS.MESSAGE_DELETE_UNDO_SECONDS),
      value => ({ messageDeleteUndoSeconds: Number(value) }));
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
        const image = action === 'change' ? await pickAndCropImage(
          root.querySelector<HTMLElement>('#server-icon-wrapper')!,
        ) : null;
        if (action === 'change' && !image) return;
        await context.request<ServerSettingsUpdatedPayload>(
          [MessageType.SERVER_UPDATE_SETTINGS, { iconBase64: image }], Permission.MANAGE_SERVER, 11 * 60 * 1000,
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
    for (const event of ['server.updated', 'server.roles_updated', 'server.members_updated', 'session.changed', 'network.status', 'network.connected', 'settings.updated'] as const) {
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
      // Turning the AFK channel off deletes the room and drops whoever is in it.
      if (patch.afkChannelEnabled === false && afkChannelIdOf(persisted)) {
        const confirmed = await showConfirm({
          title: t('serverSettings.afkDisableTitle'),
          message: t('serverSettings.afkDisableMessage', { name: afkChannelName() }),
          confirmLabel: t('serverSettings.afkDisableConfirm'),
          cancelLabel: t('common.cancel'), variant: 'danger',
        });
        if (!confirmed) return;
      }
      const stopProgress = patch.turnEnabled && !persisted.turnAvailability?.supported
        ? this.trackInstallProgress(context) : null;
      try {
        // Another administrator can already be installing TURN in the server's
        // shared settings queue, even when this particular patch is a rename.
        await context.request<ServerSettingsUpdatedPayload>(
          [MessageType.SERVER_UPDATE_SETTINGS, patch], Permission.MANAGE_SERVER, 11 * 60 * 1000,
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
    if (status) status.textContent = this.invalidated ? t('serverSettings.sessionChanged')
      : pending ? t('serverSettings.applying', { count: operations.pendingCount })
        : t('serverSettings.immediateHint');
    // A field stays marked from its refused edit until the next attempt to apply it.
    for (const binding of this.bindings) {
      if (operations.failures.some((failure) => failure.key === binding.key)) binding.input.setAttribute('aria-invalid', 'true');
      else binding.input.removeAttribute('aria-invalid');
    }
    root.querySelectorAll<HTMLFieldSetElement>('fieldset[data-server-permission], fieldset[data-server-local]').forEach((fieldset) => {
      const permission = Number(fieldset.dataset.serverPermission);
      fieldset.disabled = this.invalidated || (!fieldset.hasAttribute('data-server-local') && !store.hasPermission(permission));
    });
    const allowSoundboard = root.querySelector<HTMLInputElement>('#checkbox-allow-soundboard')?.checked !== false;
    const recentSounds = root.querySelector<HTMLInputElement>('#checkbox-recent-sounds');
    if (recentSounds) recentSounds.disabled = pending || !allowSoundboard;
    const recentLimit = root.querySelector<HTMLInputElement>('#input-recent-sounds-limit');
    if (recentLimit) recentLimit.disabled = pending || !allowSoundboard || !recentSounds?.checked;
    for (const [tab, permission] of [['members', Permission.MANAGE_ROLES], ['roles', Permission.MANAGE_ROLES], ['bots', Permission.MANAGE_BOTS]] as const) {
      const button = root.querySelector<HTMLButtonElement>(`[data-tab="${tab}"]`);
      if (button) button.hidden = !store.hasPermission(permission) && !(tab === 'roles' && store.hasPermission(Permission.MANAGE_SERVER));
      if (button?.hidden && this.activeTab === tab) this.switchTab('general');
    }
    if (this.invalidated || !context.isCurrent()) {
      this.rolesTab.refreshState();
      return;
    }
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
    if (limitGroup) setSurfaceVisible(limitGroup, !!root.querySelector<HTMLInputElement>('#checkbox-limit-members')?.checked);
    const afkOptions = root.querySelector<HTMLElement>('#server-afk-options');
    if (afkOptions) setSurfaceVisible(afkOptions, !!root.querySelector<HTMLInputElement>('#checkbox-afk-channel')?.checked);
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
    this.communitySettings?.refreshState(root, context);
  }

  private syncVoiceCards(mode: 'p2p' | 'sfu'): void {
    const input = this.modalEl?.querySelector<HTMLInputElement>('#input-server-voice-mode');
    if (input) input.value = mode;
    const cards = this.modalEl?.querySelector<HTMLElement>('#server-voice-mode-cards');
    if (cards) selectChoiceCard(cards, 'data-mode', mode);
  }

  private showIconActionModal(hasCustomIcon: boolean): Promise<'change' | 'remove' | null> {
    return new Promise((resolve) => {
      let action: 'change' | 'remove' | null = null;
      const shell = openModal({
        card: `
        <div class="modal-card dialog-card" style="max-width: 380px;">
          <div class="modal-header"><div class="modal-title">${escapeHtml(t('serverSettings.photoDialogTitle'))}</div>
            <button type="button" class="modal-close-btn" data-action="cancel" data-modal-close aria-label="${escapeHtml(t('common.cancel'))}">&times;</button></div>
          <div class="dialog-message">${escapeHtml(t('serverSettings.photoDialogPrompt'))}</div>
          <div style="display: flex; flex-direction: column; gap: 8px;">
            <button type="button" class="btn btn-primary" data-action="change">${escapeHtml(t('settings.avatarChange'))}</button>
            ${hasCustomIcon ? `<button type="button" class="btn btn-danger" data-action="remove">${escapeHtml(t('settings.avatarRemove'))}</button>` : ''}
            <button type="button" class="btn btn-secondary" data-action="cancel" data-modal-close>${escapeHtml(t('common.cancel'))}</button>
          </div>
        </div>`,
        initialFocus: '[data-action="change"]',
        onClose: () => resolve(action),
      });
      shell.card.querySelectorAll<HTMLButtonElement>('[data-action="change"], [data-action="remove"]').forEach((button) => {
        button.addEventListener('click', () => {
          action = button.dataset.action === 'remove' ? 'remove' : 'change';
          shell.close('button');
        }, { signal: shell.signal });
      });
    });
  }

  private trackInstallProgress(context: ServerSettingsContext): () => void {
    const panel = this.modalEl?.querySelector<HTMLElement>('#turn-install-progress');
    const stage = this.modalEl?.querySelector('#turn-install-stage');
    const percent = this.modalEl?.querySelector('#turn-install-percent');
    const fill = this.modalEl?.querySelector<HTMLElement>('#turn-install-bar-fill');
    if (panel) setSurfaceVisible(panel, true);
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
    return () => { unsubscribe(); if (panel) setSurfaceVisible(panel, false); };
  }

  private finishEditing(): void {
    // Public close/reopen and Escape do not naturally blur an input. Committing
    // before checking the lock closes those otherwise easy-to-miss paths.
    for (const binding of this.bindings) if (binding.dirty) binding.commit();
    this.rolesTab.finishEditing();
    const active = document.activeElement;
    if ((active instanceof HTMLInputElement || active instanceof HTMLSelectElement || active instanceof HTMLTextAreaElement) &&
      this.modalEl?.contains(active)) active.blur();
  }

  /** Every refused edit is explained once, in the shared alert toast. */
  private showFailure(failure: ServerSettingsFailure): void {
    if (this.modalEl) reportError(`${failure.label}: ${failure.message}`);
  }

  public close(): boolean {
    return this.shell?.close('api') ?? true;
  }

  private teardown(): void {
    this.sectionNavigation?.destroy();
    this.sectionNavigation = null;
    this.domEvents.abort();
    for (const cleanup of this.unbind) cleanup();
    this.unbind = [];
    this.rolesTab.detachEvents();
    this.botsTab.detachEvents();
    this.shell = null;
    this.modalEl = null;
    this.context = null;
    this.bindings = [];
  }
}

export const serverSettingsModal = new ServerSettingsModal();
