import {
  LIMITS,
  MessageType,
  Permission,
  ServerUpdateSettingsPayload,
  TurnInstallProgressPayload,
  TurnInstallStage,
} from '@monky/shared';
import { networkClient } from '../core/NetworkClient';
import { appEvents } from '../core/EventBus';
import { setButtonLoading } from '../utils/buttonLoading';
import { serverStore } from '../stores/serverStore';
import { settingsStore, ChatSoundMode } from '../stores/settingsStore';
import { t } from '../i18n';
import { enableBackdropClose } from '../utils/modal';
import logoUrl from '../assets/Logo.png';
import { pickAndCropImage } from './ImageCropModal';
import { attachInputEmojiPicker } from '../utils/inputEmojiPicker';
import { showConfirm } from './Dialog';
import { ServerGeneralTab } from './serverSettings/tabs/ServerGeneralTab';
import { ServerSecurityTab } from './serverSettings/tabs/ServerSecurityTab';
import { ServerVoiceVideoTab } from './serverSettings/tabs/ServerVoiceVideoTab';
import { ServerStorageTab } from './serverSettings/tabs/ServerStorageTab';
import { ServerNotificationsTab } from './serverSettings/tabs/ServerNotificationsTab';
import { ServerMembersTab } from './serverSettings/tabs/ServerMembersTab';
import { ServerRolesTab } from './serverSettings/tabs/ServerRolesTab';
import { ServerBotsTab } from './serverSettings/tabs/ServerBotsTab';

export class ServerSettingsModal {
  private modalEl: HTMLElement | null = null;
  private shouldRemovePassword = false;
  private pendingIconBase64: string | null | undefined = undefined;
  private activeTab = 'general';
  /** Set while the host installs coturn, which must not be interrupted (#438). */
  private installingRelay = false;
  private detachGeneralTab: (() => void) | null = null;
  private detachEmojiPicker: (() => void) | null = null;

  private generalTab = new ServerGeneralTab();
  private securityTab = new ServerSecurityTab();
  private voiceVideoTab = new ServerVoiceVideoTab();
  private storageTab = new ServerStorageTab();
  private notificationsTab = new ServerNotificationsTab();
  private membersTab = new ServerMembersTab();
  private rolesTab = new ServerRolesTab();
  private botsTab = new ServerBotsTab();

  public open(initialTab?: string): void {
    this.close();
    this.shouldRemovePassword = false;
    this.pendingIconBase64 = undefined;
    if (initialTab) this.activeTab = initialTab;

    const s = serverStore.serverDetails;
    if (!s) return;

    const canManageServer = serverStore.hasPermission(Permission.MANAGE_SERVER);
    const canManageRoles = serverStore.hasPermission(Permission.MANAGE_ROLES);
    const canManageBots = serverStore.hasPermission(Permission.MANAGE_BOTS);

    this.modalEl = document.createElement('div');
    this.modalEl.className = 'modal-backdrop';
    this.modalEl.innerHTML = `
      <div class="modal-card settings-modal-card server-settings-modal-card">
        <!-- Sidebar Navigation -->
        <div class="settings-sidebar">
          <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.6px; color: var(--text-muted); padding: 4px 10px 8px;">
            ${t('connection.settingsTitle')}
          </div>
          <button type="button" class="settings-tab-btn ${this.activeTab === 'general' ? 'active' : ''}" data-tab="general">
            <span class="material-symbols-outlined md-18">tune</span>
            <span>${t('serverSettings.tabGeneral')}</span>
          </button>
          <button type="button" class="settings-tab-btn ${this.activeTab === 'security' ? 'active' : ''}" data-tab="security">
            <span class="material-symbols-outlined md-18">lock</span>
            <span>${t('serverSettings.tabSecurity')}</span>
          </button>
          <button type="button" class="settings-tab-btn ${this.activeTab === 'voice_video' ? 'active' : ''}" data-tab="voice_video">
            <span class="material-symbols-outlined md-18">music_note</span>
            <span>${t('serverSettings.tabVoiceVideo')}</span>
          </button>
          <button type="button" class="settings-tab-btn ${this.activeTab === 'storage' ? 'active' : ''}" data-tab="storage">
            <span class="material-symbols-outlined md-18">cloud</span>
            <span>${t('serverSettings.tabStorage')}</span>
          </button>
          <button type="button" class="settings-tab-btn ${this.activeTab === 'notifications' ? 'active' : ''}" data-tab="notifications">
            <span class="material-symbols-outlined md-18">notifications</span>
            <span>${t('serverSettings.tabNotifications')}</span>
          </button>
          ${canManageRoles ? `
          <button type="button" class="settings-tab-btn ${this.activeTab === 'members' ? 'active' : ''}" data-tab="members">
            <span class="material-symbols-outlined md-18">group</span>
            <span>${t('serverSettings.tabMembers')}</span>
          </button>
          <button type="button" class="settings-tab-btn ${this.activeTab === 'roles' ? 'active' : ''}" data-tab="roles">
            <span class="material-symbols-outlined md-18">admin_panel_settings</span>
            <span>${t('serverSettings.tabRoles')}</span>
          </button>
          ` : ''}
          ${canManageBots ? `
          <button type="button" class="settings-tab-btn ${this.activeTab === 'bots' ? 'active' : ''}" data-tab="bots">
            <span class="material-symbols-outlined md-18">smart_toy</span>
            <span>${t('serverSettings.tabBots')}</span>
          </button>
          ` : ''}
        </div>

        <!-- Main Content Area with Form -->
        <div class="settings-main-container">
          <!-- Top Header -->
          <div class="settings-content-header">
            <div id="server-settings-tab-title" style="font-size: 16px; font-weight: 700; color: var(--text-primary); display: flex; align-items: center; gap: 8px;">
              ${this.getTabHeaderTitle(this.activeTab)}
            </div>
            <button id="modal-close" class="settings-back-btn" title="${t('common.back')} (ESC)">
              <span class="material-symbols-outlined md-18">close</span>
              <span class="esc-hint">ESC</span>
            </button>
          </div>

          <!-- Form wraps body and footer -->
          <form id="form-server-settings" style="display: flex; flex-direction: column; flex: 1; min-height: 0; margin: 0;">
            <!-- Body Scroll Container -->
            <div class="settings-content-body">
              <div id="server-settings-banner" class="error-banner"></div>

              <div class="settings-tab-panel" id="tab-panel-general" style="${this.activeTab === 'general' ? '' : 'display: none;'}">
                ${this.generalTab.renderHtml(this.pendingIconBase64)}
              </div>

              <div class="settings-tab-panel" id="tab-panel-security" style="${this.activeTab === 'security' ? '' : 'display: none;'}">
                ${this.securityTab.renderHtml()}
              </div>

              <div class="settings-tab-panel" id="tab-panel-voice_video" style="${this.activeTab === 'voice_video' ? '' : 'display: none;'}">
                ${this.voiceVideoTab.renderHtml()}
              </div>

              <div class="settings-tab-panel" id="tab-panel-storage" style="${this.activeTab === 'storage' ? '' : 'display: none;'}">
                ${this.storageTab.renderHtml()}
              </div>

              <div class="settings-tab-panel" id="tab-panel-notifications" style="${this.activeTab === 'notifications' ? '' : 'display: none;'}">
                ${this.notificationsTab.renderHtml()}
              </div>

              ${canManageRoles ? `
              <div class="settings-tab-panel" id="tab-panel-members" style="${this.activeTab === 'members' ? '' : 'display: none;'}">
                ${this.membersTab.renderHtml()}
              </div>
              <div class="settings-tab-panel" id="tab-panel-roles" style="${this.activeTab === 'roles' ? '' : 'display: none;'}">
                ${this.rolesTab.renderHtml()}
              </div>
              ` : ''}
              ${canManageBots ? `
              <div class="settings-tab-panel" id="tab-panel-bots" style="${this.activeTab === 'bots' ? '' : 'display: none;'}">
                ${this.botsTab.renderHtml()}
              </div>
              ` : ''}
            </div>

            <!-- Footer Action Bar -->
            <div id="turn-install-progress" class="turn-install-progress" hidden>
              <div class="turn-install-progress-head">
                <span class="material-symbols-outlined md-16">download</span>
                <span id="turn-install-stage">${t('serverSettings.turnInstallTitle')}</span>
                <span id="turn-install-percent" class="turn-install-percent">0%</span>
              </div>
              <div class="turn-install-bar"><div id="turn-install-bar-fill" class="turn-install-bar-fill" style="width: 0%;"></div></div>
              <div class="turn-install-hint">${t('serverSettings.turnInstallHint')}</div>
            </div>
            <div class="modal-footer" style="padding: 14px 24px; border-top: 1px solid var(--border-color); background: var(--bg-panel); margin-top: auto; ${canManageServer ? '' : 'justify-content: flex-end;'}">
              <button type="button" id="btn-cancel" class="btn btn-secondary">${t('common.cancel')}</button>
              ${canManageServer ? `<button type="submit" id="btn-save" class="btn btn-primary">${t('serverSettings.save')}</button>` : ''}
            </div>
          </form>
        </div>
      </div>
    `;

    document.body.appendChild(this.modalEl);
    this.attachEvents();
  }

  private getTabHeaderTitle(tabName: string): string {
    const tabTitles: Record<string, { icon: string; title: string }> = {
      general: { icon: 'tune', title: t('serverSettings.tabGeneral') },
      security: { icon: 'lock', title: t('serverSettings.tabSecurity') },
      voice_video: { icon: 'music_note', title: t('serverSettings.tabVoiceVideo') },
      storage: { icon: 'cloud', title: t('serverSettings.tabStorage') },
      notifications: { icon: 'notifications', title: t('serverSettings.tabNotifications') },
      members: { icon: 'group', title: t('serverSettings.tabMembers') },
      roles: { icon: 'admin_panel_settings', title: t('serverSettings.tabRoles') },
      bots: { icon: 'smart_toy', title: t('serverSettings.tabBots') },
    };

    const target = tabTitles[tabName] || tabTitles.general;
    return `
      <span class="material-symbols-outlined" style="color: var(--accent-primary);">${target.icon}</span>
      <span>${target.title}</span>
    `;
  }

  private reopenPreservingTab(): void {
    const tab = this.activeTab;
    this.open(tab);
  }

  private attachEvents(): void {
    if (!this.modalEl) return;

    const btnClose = this.modalEl.querySelector('#modal-close');
    const btnCancel = this.modalEl.querySelector('#btn-cancel');
    const btnRemovePass = this.modalEl.querySelector('#btn-remove-pass') as HTMLButtonElement | null;
    const serverIconWrapper = this.modalEl.querySelector('#server-icon-wrapper');
    const form = this.modalEl.querySelector('#form-server-settings') as HTMLFormElement;
    const inputName = this.modalEl.querySelector('#input-server-name') as HTMLInputElement;
    const inputPass = this.modalEl.querySelector('#input-server-pass') as HTMLInputElement;
    const checkboxAllowSoundboard = this.modalEl.querySelector('#checkbox-allow-soundboard') as HTMLInputElement | null;
    const checkboxAllowEveryoneMention = this.modalEl.querySelector('#checkbox-allow-everyone-mention') as HTMLInputElement | null;
    const checkboxAllowMessageEdit = this.modalEl.querySelector('#checkbox-allow-message-edit') as HTMLInputElement | null;
    const checkboxShowRoleBadges = this.modalEl.querySelector('#checkbox-show-role-badges') as HTMLInputElement | null;
    const checkboxTurnEnabled = this.modalEl.querySelector('#checkbox-turn-enabled') as HTMLInputElement | null;
    const passHelpText = this.modalEl.querySelector('#pass-help-text') as HTMLElement | null;
    const statusDesc = this.modalEl.querySelector('#password-status-desc') as HTMLElement | null;
    const canManageServer = serverStore.hasPermission(Permission.MANAGE_SERVER);

    btnClose?.addEventListener('click', () => this.close());
    btnCancel?.addEventListener('click', () => this.close());
    enableBackdropClose(this.modalEl, () => { if (!this.installingRelay) this.close(); });

    this.detachGeneralTab = this.generalTab.attach(this.modalEl);

    // Close on ESC key (#243). Not while the host is installing coturn: the
    // modal is the only place showing how far it got, and closing it would
    // leave the operator guessing (#438).
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !this.installingRelay) { this.close(); }
    };
    window.addEventListener('keydown', handleEsc);
    (this.modalEl as any)._escHandler = handleEsc;

    // Tab Navigation
    const tabButtons = this.modalEl.querySelectorAll('.settings-tab-btn');
    const tabPanels = this.modalEl.querySelectorAll('.settings-tab-panel');
    const currentTabTitle = this.modalEl.querySelector('#server-settings-tab-title');

    const switchTab = (tabName: string) => {
      this.activeTab = tabName;
      tabButtons.forEach((btn) => {
        const isTarget = btn.getAttribute('data-tab') === tabName;
        btn.classList.toggle('active', isTarget);
      });
      tabPanels.forEach((panel) => {
        const isTarget = panel.id === `tab-panel-${tabName}`;
        (panel as HTMLElement).style.display = isTarget ? 'flex' : 'none';
      });
      if (currentTabTitle) {
        currentTabTitle.innerHTML = this.getTabHeaderTitle(tabName);
      }
    };

    tabButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.getAttribute('data-tab');
        if (tab) switchTab(tab);
      });
    });

    // Per-server chat-sound preference (#153).
    const selectServerChatSound = this.modalEl.querySelector('#select-server-chat-sound') as HTMLSelectElement | null;
    const serverId = serverStore.serverDetails?.id;
    if (selectServerChatSound && serverId) {
      selectServerChatSound.value = settingsStore.getServerChatSoundOverride(serverId);
      selectServerChatSound.addEventListener('change', () => {
        settingsStore.setServerChatSoundOverride(serverId, selectServerChatSound.value as ChatSoundMode);
      });
    }

    const btnEmojiServerName = this.modalEl.querySelector('#btn-emoji-server-name') as HTMLElement | null;
    if (btnEmojiServerName && inputName) {
      this.detachEmojiPicker = attachInputEmojiPicker(inputName, btnEmojiServerName);
    }

    serverIconWrapper?.addEventListener('click', async () => {
      if (!canManageServer) return;
      const s = serverStore.serverDetails;
      const currentIcon = this.pendingIconBase64 !== undefined
        ? this.pendingIconBase64
        : (s?.iconUrl || null);
      const hasCustomIcon = Boolean(currentIcon);

      const action = await this.showIconActionModal(hasCustomIcon);
      if (action === 'change') {
        const croppedIcon = await pickAndCropImage();
        if (croppedIcon) {
          this.pendingIconBase64 = croppedIcon;
          const preview = this.modalEl?.querySelector('#server-icon-preview') as HTMLImageElement | null;
          if (preview) preview.src = croppedIcon;
        }
      } else if (action === 'remove') {
        this.pendingIconBase64 = null;
        const preview = this.modalEl?.querySelector('#server-icon-preview') as HTMLImageElement | null;
        if (preview) preview.src = logoUrl;
      }
    });

    btnRemovePass?.addEventListener('click', () => {
      if (!canManageServer) return;
      this.shouldRemovePassword = true;
      if (inputPass) {
        inputPass.value = '';
        inputPass.placeholder = t('serverSettings.passwordWillBeRemoved');
      }
      if (passHelpText) {
        passHelpText.innerHTML = `<span style="color: var(--danger); font-weight: 600;">${t('serverSettings.passwordRemovalWarning')}</span>`;
      }
      if (statusDesc) {
        statusDesc.innerText = t('serverSettings.markedForRemoval');
      }
      btnRemovePass.style.display = 'none';
    });

    form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!canManageServer) return;
      const name = inputName?.value.trim();
      const passVal = inputPass?.value;
      const allowSoundboard = checkboxAllowSoundboard ? checkboxAllowSoundboard.checked : true;

      if (!name) return;

      const payload: ServerUpdateSettingsPayload = {
        name,
        allowSoundboard,
      };

      if (checkboxAllowEveryoneMention) {
        payload.allowEveryoneMention = checkboxAllowEveryoneMention.checked;
      }

      if (checkboxAllowMessageEdit) {
        payload.allowMessageEdit = checkboxAllowMessageEdit.checked;
      }

      if (checkboxShowRoleBadges) {
        payload.showRoleBadgesToEveryone = checkboxShowRoleBadges.checked;
      }

      // Only sent when the host can actually run the relay: the checkbox is
      // disabled otherwise, and submitting `false` would be indistinguishable
      // from the operator turning it off (#425).
      if (checkboxTurnEnabled && !checkboxTurnEnabled.disabled) {
        payload.turnEnabled = checkboxTurnEnabled.checked;
      }

      if (this.shouldRemovePassword) {
        payload.password = null;
      } else if (passVal && passVal.trim().length > 0) {
        payload.password = passVal;
      }

      if (this.pendingIconBase64 !== undefined) {
        payload.iconBase64 = this.pendingIconBase64;
      }

      const inputVoiceMode = (this.modalEl?.querySelector('#input-server-voice-mode') as HTMLInputElement | null) ||
        (this.modalEl?.querySelector('input[name="server-voice-mode"]:checked') as HTMLInputElement | null);
      if (inputVoiceMode) {
        payload.voiceMode = inputVoiceMode.value as 'p2p' | 'sfu';
      }

      const previousVoiceMode = serverStore.serverDetails?.voiceMode || 'p2p';
      if (previousVoiceMode === 'sfu' && payload.voiceMode === 'p2p') {
        const confirmed = await showConfirm({
          title: t('serverSettings.voiceModeDisconnectTitle'),
          message: t('serverSettings.voiceModeDisconnectMessage'),
          confirmLabel: t('serverSettings.voiceModeDisconnectConfirm'),
          cancelLabel: t('common.cancel'),
          variant: 'warning',
        });
        if (!confirmed) {
          return;
        }
      }

      // Attachment storage limits
      const inputFileMb = this.modalEl?.querySelector('#input-attach-file-mb') as HTMLInputElement | null;
      const inputTotalMb = this.modalEl?.querySelector('#input-attach-total-mb') as HTMLInputElement | null;
      const fileMbVal = parseFloat(inputFileMb?.value ?? '');
      const totalMbVal = parseFloat(inputTotalMb?.value ?? '');
      if (Number.isFinite(fileMbVal) && fileMbVal > 0) {
        payload.maxAttachmentFileBytes = Math.round(fileMbVal * 1024 * 1024);
      }
      if (Number.isFinite(totalMbVal) && totalMbVal > 0) {
        payload.maxAttachmentStorageBytes = Math.round(totalMbVal * 1024 * 1024);
      }
      if (
        payload.maxAttachmentFileBytes &&
        payload.maxAttachmentStorageBytes &&
        payload.maxAttachmentFileBytes > payload.maxAttachmentStorageBytes
      ) {
        this.showBannerError(t('serverSettings.limitError'));
        return;
      }

      // Membership cap (#403). An unchecked switch clears the limit entirely,
      // which is why 0 is sent rather than simply omitting the field.
      const toggleLimit = this.modalEl?.querySelector('#checkbox-limit-members') as HTMLInputElement | null;
      if (toggleLimit) {
        if (!toggleLimit.checked) {
          payload.maxUsers = LIMITS.MAX_USERS_UNLIMITED;
        } else {
          const inputMaxUsers = this.modalEl?.querySelector('#input-max-users') as HTMLInputElement | null;
          const maxUsersVal = parseInt(inputMaxUsers?.value ?? '', 10);
          if (!Number.isFinite(maxUsersVal) || maxUsersVal < 1) {
            this.showBannerError(t('serverSettings.memberLimitInvalid'));
            return;
          }
          payload.maxUsers = maxUsersVal;
        }
      }

      const btnSave = this.modalEl?.querySelector('#btn-save') as HTMLButtonElement;
      const btnCancel = this.modalEl?.querySelector('#btn-cancel') as HTMLButtonElement | null;
      const btnClose = this.modalEl?.querySelector('#modal-close') as HTMLButtonElement | null;
      // Switching the relay on may install coturn on the host first, which
      // takes far longer than the 8s default. Giving up early would report a
      // failure over an installation that is going fine (#431).
      const installsRelay = payload.turnEnabled === true && !serverStore.serverDetails?.turnAvailability?.supported;
      // `disabled` alone left the button looking clickable through a job that
      // can run for minutes, so it also takes the shared loading state (#438).
      setButtonLoading(btnSave, true);
      if (btnCancel) btnCancel.disabled = true;
      // Walking out mid-install would leave the operator with no idea whether
      // the host is still working on it.
      if (btnClose) btnClose.disabled = true;

      const stopProgress = installsRelay ? this.trackInstallProgress() : null;
      this.installingRelay = installsRelay;

      try {
        await networkClient.sendRequest(
          MessageType.SERVER_UPDATE_SETTINGS,
          payload,
          undefined,
          installsRelay ? 11 * 60 * 1000 : undefined
        );
        this.close();
      } catch (err: any) {
        const banner = document.getElementById('server-settings-banner');
        if (banner) {
          banner.innerText = err.message || t('serverSettings.saveError');
          banner.classList.add('show');
        }
        setButtonLoading(btnSave, false);
        if (btnCancel) btnCancel.disabled = false;
        if (btnClose) btnClose.disabled = false;
      } finally {
        this.installingRelay = false;
        stopProgress?.();
      }
    });

    this.rolesTab.attachEvents(this.modalEl, () => this.reopenPreservingTab());
    this.botsTab.attachEvents();
  }

  private showIconActionModal(hasCustomIcon: boolean): Promise<'change' | 'remove' | null> {
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      backdrop.style.zIndex = '10001';
      backdrop.innerHTML = `
        <div class="modal-card dialog-card" role="dialog" aria-modal="true" style="max-width: 380px;">
          <div class="modal-header">
            <div class="modal-title" style="display: flex; align-items: center; gap: 8px;">
              <span class="material-symbols-outlined" style="color: var(--accent-primary);">photo_camera</span>
              <span>${t('serverSettings.photoDialogTitle')}</span>
            </div>
            <button class="modal-close-btn" data-action="cancel">&times;</button>
          </div>
          <div class="dialog-message" style="margin-bottom: 20px; white-space: normal;">${t('serverSettings.photoDialogPrompt')}</div>
          <div style="display: flex; flex-direction: column; gap: 8px;">
            <button type="button" class="btn btn-primary" data-action="change" style="justify-content: center; gap: 8px; height: 38px;">
              <span class="material-symbols-outlined md-18">upload</span>
              <span>${t('settings.avatarChange')}</span>
            </button>
            ${
              hasCustomIcon
                ? `
            <button type="button" class="btn btn-danger" data-action="remove" style="justify-content: center; gap: 8px; height: 38px;">
              <span class="material-symbols-outlined md-18">delete</span>
              <span>${t('settings.avatarRemove')}</span>
            </button>
            `
                : ''
            }
            <button type="button" class="btn btn-secondary" data-action="cancel" style="justify-content: center; height: 38px;">${t('common.cancel')}</button>
          </div>
        </div>
      `;

      const settle = (result: 'change' | 'remove' | null) => {
        document.removeEventListener('keydown', onKeyDown, true);
        backdrop.remove();
        resolve(result);
      };

      const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          settle(null);
        }
      };

      backdrop.querySelectorAll('[data-action="change"]').forEach((el) => {
        el.addEventListener('click', () => settle('change'));
      });
      backdrop.querySelectorAll('[data-action="remove"]').forEach((el) => {
        el.addEventListener('click', () => settle('remove'));
      });
      backdrop.querySelectorAll('[data-action="cancel"]').forEach((el) => {
        el.addEventListener('click', () => settle(null));
      });
      backdrop.addEventListener('mousedown', (e) => {
        if (e.target === backdrop) settle(null);
      });
      document.addEventListener('keydown', onKeyDown, true);

      document.body.appendChild(backdrop);
    });
  }

  /**
   * Mirrors the host's coturn installation into the modal (#438).
   *
   * The install runs on the server and can take minutes; without this the modal
   * sat frozen and then simply closed, with no way to tell a slow install from
   * a hung one. Returns the teardown so the listener never outlives the save —
   * leaving it attached would leak a handler on every attempt.
   */
  private trackInstallProgress(): () => void {
    const panel = this.modalEl?.querySelector('#turn-install-progress') as HTMLElement | null;
    const stageEl = this.modalEl?.querySelector('#turn-install-stage') as HTMLElement | null;
    const percentEl = this.modalEl?.querySelector('#turn-install-percent') as HTMLElement | null;
    const fillEl = this.modalEl?.querySelector('#turn-install-bar-fill') as HTMLElement | null;

    if (panel) panel.hidden = false;
    if (stageEl) stageEl.innerText = t('serverSettings.turnInstallTitle');

    const stageLabels: Record<TurnInstallStage, string> = {
      refreshing: t('serverSettings.turnInstallStageRefreshing'),
      installing: t('serverSettings.turnInstallStageInstalling'),
      configuring: t('serverSettings.turnInstallStageConfiguring'),
    };

    const unsubscribe = appEvents.on(
      `message.${MessageType.TURN_INSTALL_PROGRESS}`,
      (progress: TurnInstallProgressPayload) => {
        if (stageEl) stageEl.innerText = stageLabels[progress.stage] ?? t('serverSettings.turnInstallTitle');
        if (percentEl) percentEl.innerText = `${progress.percent}%`;
        if (fillEl) fillEl.style.width = `${progress.percent}%`;
      }
    );

    return () => {
      unsubscribe();
      if (panel) panel.hidden = true;
    };
  }

  private showBannerError(message: string): void {
    const banner = document.getElementById('server-settings-banner');
    if (banner) {
      banner.innerText = message;
      banner.classList.add('show');
    }
  }

  public close(): void {
    this.detachEmojiPicker?.();
    this.detachEmojiPicker = null;
    this.botsTab.detachEvents();
    if (this.modalEl) {
      const handler = (this.modalEl as any)._escHandler;
      if (handler) window.removeEventListener('keydown', handler);
      this.detachGeneralTab?.();
      this.detachGeneralTab = null;
      this.modalEl.remove();
      this.modalEl = null;
      this.shouldRemovePassword = false;
      this.pendingIconBase64 = undefined;
    }
  }
}

export const serverSettingsModal = new ServerSettingsModal();
