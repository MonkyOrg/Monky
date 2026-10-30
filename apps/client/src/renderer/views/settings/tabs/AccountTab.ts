import { escapeHtml } from '../../../utils/html';
import { renderSwitch } from '../../../utils/formControls';
import { getAvatarUrl } from '../../../utils/avatar';
import { serverStore } from '../../../stores/serverStore';
import { settingsStore } from '../../../stores/settingsStore';
import { connectionStore } from '../../../stores/connectionStore';
import { getLanguage, setLanguage, SUPPORTED_LANGUAGES, t, SupportedLanguage } from '../../../i18n';
import { pickAndCropImage } from '../../ImageCropModal';
import { showIdentityExportDialog, showIdentityImportDialog } from '../../IdentityDialogs';
import { showBackupExportDialog, showBackupImportDialog } from '../../BackupDialogs';
import { showAlert } from '../../Dialog';
import { attachInputEmojiPicker } from '../../../utils/inputEmojiPicker';
import { nicknameError } from '../../../utils/nickname';
import { DM_MAX_FILE_BYTES_OPTIONS, MessageType, normalizeNickname } from '@monky/shared';
import { dmStore } from '../../../stores/dmStore';
import { formatBytes } from '../../../utils/attachment';
import { appEvents } from '../../../core/EventBus';
import { currentPresenceStatus, sessionManager, type PresenceStatus } from '../../../core/SessionManager';
import { CustomStatusEditor } from '../../CustomStatusModal';
import { setSurfaceVisible } from '../../../utils/surfaceVisibility';
import { customStatusLabel } from '../../../utils/presenceTag';
import type { TranslationKey } from '../../../i18n';

const PRESENCE_OPTIONS: ReadonlyArray<{ status: PresenceStatus; icon: string; label: TranslationKey; description: TranslationKey }> = [
  { status: 'online', icon: 'circle', label: 'main.statusOnline', description: 'settings.presenceOnlineDesc' },
  { status: 'brb', icon: 'schedule', label: 'main.statusBrb', description: 'settings.presenceBrbDesc' },
  { status: 'invisible', icon: 'visibility_off', label: 'main.statusInvisible', description: 'settings.appearOfflineHint' },
];

export class AccountTab {
  private detachEmojiPicker: (() => void) | null = null;
  private detachPresenceSync: (() => void) | null = null;
  /**
   * The custom status editor opens inline, under the status cards. Opening it
   * as a second modal replaced the Settings card with a smaller one, which
   * read as one window blinking into another.
   */
  private customEditor: CustomStatusEditor | null = null;

  /**
   * The custom status card: picks the saved status, or opens the editor when
   * there is none. Its edit action is a corner icon inside the card, so the
   * four status cards keep the same size.
   */
  private renderCustomCard(): string {
    return `<div class="presence-custom-card" data-presence-custom>
      <button type="button" class="voice-mode-card input-mode-card" data-presence-custom-select aria-pressed="false">
        <span class="input-mode-card-title"><span class="material-symbols-outlined md-18 presence-menu-icon presence-custom-icon"
          data-presence-custom-icon aria-hidden="true">circle</span>${t('customStatus.title')}</span>
        <span class="input-mode-card-description" data-presence-custom-description></span>
      </button>
      <button type="button" class="presence-custom-edit" data-presence-custom-edit
        aria-expanded="false" aria-controls="settings-custom-status-editor">
        <span class="material-symbols-outlined md-18" aria-hidden="true">edit</span></button>
    </div>`;
  }

  private openCustomEditor(container: HTMLElement): void {
    const host = container.querySelector<HTMLElement>('[data-presence-custom-editor]');
    if (!host) return;
    if (this.customEditor) {
      this.customEditor.focus();
      return;
    }
    const editor = new CustomStatusEditor({
      idPrefix: 'settings-custom-status',
      onClose: () => this.closeCustomEditor(container),
    });
    this.customEditor = editor;
    host.innerHTML = editor.renderHtml();
    editor.mount(host);
    setSurfaceVisible(host, true, 'panel');
    container.querySelector('[data-presence-custom-edit]')?.setAttribute('aria-expanded', 'true');
    editor.focus();
  }

  private closeCustomEditor(container: HTMLElement, restoreFocus = true): void {
    const editor = this.customEditor;
    if (!editor) return;
    this.customEditor = null;
    editor.destroy();
    const host = container.querySelector<HTMLElement>('[data-presence-custom-editor]');
    const edit = container.querySelector<HTMLElement>('[data-presence-custom-edit]');
    edit?.setAttribute('aria-expanded', 'false');
    if (host) {
      // The form stays painted while it slides away, then is dropped.
      setSurfaceVisible(host, false, 'panel', undefined, () => { if (!this.customEditor) host.innerHTML = ''; });
    }
    if (restoreFocus && edit?.isConnected) edit.focus({ preventScroll: true });
  }

  /** Reflects the saved custom status in place, keeping focus on whatever was clicked. */
  private syncCustomCard(container: HTMLElement): void {
    const saved = settingsStore.customStatus;
    container.querySelector('[data-presence-custom-select]')?.setAttribute('aria-pressed', String(currentPresenceStatus() === 'custom'));
    const icon = container.querySelector<HTMLElement>('[data-presence-custom-icon]');
    if (icon) icon.style.color = saved?.color ?? '';
    const description = container.querySelector('[data-presence-custom-description]');
    if (description) description.textContent = saved ? customStatusLabel(saved) : t('customStatus.cardHint');
    const edit = container.querySelector<HTMLElement>('[data-presence-custom-edit]');
    if (edit) {
      const label = t(saved ? 'customStatus.edit' : 'customStatus.set');
      edit.setAttribute('aria-label', label);
      edit.title = label;
    }
  }

  public renderHtml(): string {
    return `
      <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 12px;">
        ${t('settings.accountIntro')}
      </div>
      <!-- Nickname & Profile -->
      <div data-settings-section="profile" data-settings-label="${escapeHtml(t('settings.tabAccount'))}" style="display: flex; gap: 16px; align-items: center; padding: 14px; background: var(--bg-card); border-radius: var(--radius-md); margin-bottom: 16px; border: 1px solid var(--border-color);">
        <button type="button" id="settings-avatar-wrapper" class="settings-avatar-wrapper" title="${t('settings.avatarTitle')}">
          <img id="settings-avatar-preview" class="settings-avatar-img" src="${connectionStore.savedAvatarBase64 ? getAvatarUrl(connectionStore.savedAvatarBase64) : getAvatarUrl(serverStore.currentUser?.avatarUrl)}" alt="Avatar" data-fallback="avatar">
          <div class="settings-avatar-overlay">
            <span class="material-symbols-outlined md-20">photo_camera</span>
          </div>
        </button>
        <div style="flex: 1;">
          <div class="form-group" style="margin-bottom: 0;">
            <label>${t('connection.nicknameLabel')}</label>
            <div style="display: flex; gap: 8px; margin-top: 6px;">
              <div class="input-with-emoji-container" style="flex: 1;">
                <input id="settings-nickname-input" type="text" value="${escapeHtml(connectionStore.savedNickname || serverStore.currentUser?.nickname || '')}" style="width: 100%; padding-right: 36px;" maxlength="32">
                <button type="button" id="btn-emoji-nickname" class="btn-input-emoji" title="${t('chat.emojiPickerTitle')}">
                  <span class="material-symbols-outlined md-18">mood</span>
                </button>
              </div>
              <button id="btn-save-nickname" class="btn btn-secondary" style="font-size: 12px; padding: 6px 12px;">${t('common.save')}</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Status: online, "Volto já" or invisible (#561, user-brb) -->
      <div data-settings-section="visibility" data-settings-label="${escapeHtml(t('settings.appearOfflineSection'))}" class="form-group" style="border-top: 1px solid var(--border-color); padding-top: 14px; margin-top: 14px;">
        <label id="settings-presence-label" style="display: flex; align-items: center; gap: 6px;">
          <span class="material-symbols-outlined md-16" style="color: var(--accent-primary);">radio_button_checked</span>
          ${t('settings.appearOfflineSection')}
        </label>
        <div class="input-mode-cards presence-cards" role="group" aria-labelledby="settings-presence-label">
          ${PRESENCE_OPTIONS.map(({ status, icon, label, description }) => `
          <button type="button" class="voice-mode-card input-mode-card" data-presence="${status}" aria-pressed="${currentPresenceStatus() === status}">
            <span class="input-mode-card-title"><span class="material-symbols-outlined md-18 presence-menu-icon presence-menu-icon--${status}" aria-hidden="true">${icon}</span>${t(label)}</span>
            <span class="input-mode-card-description">${t(description)}</span>
          </button>`).join('')}
          ${this.renderCustomCard()}
        </div>
        <div class="presence-custom-editor" id="settings-custom-status-editor" data-presence-custom-editor
          role="region" aria-label="${escapeHtml(t('customStatus.title'))}" hidden></div>
      </div>

      <!-- Game activity (#675) -->
      <div data-settings-section="game-activity" data-settings-label="${escapeHtml(t('settings.gameActivitySection'))}" class="form-group" style="border-top: 1px solid var(--border-color); padding-top: 14px; margin-top: 14px;">
        <label style="display: flex; align-items: center; gap: 6px;">
          <span class="material-symbols-outlined md-16" style="color: var(--accent-primary);">sports_esports</span>
          ${t('settings.gameActivitySection')}
        </label>
        <div style="display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-md);">
          <div style="flex: 1; margin-right: 12px;">
            <div id="game-activity-label" style="font-size: 13px; color: var(--text-primary);">${t('settings.gameActivityLabel')}</div>
            <div id="game-activity-hint" style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">${t('settings.gameActivityHint')}</div>
          </div>
          ${renderSwitch({ id: 'toggle-game-activity', labelledBy: 'game-activity-label', describedBy: 'game-activity-hint', checked: settingsStore.shareGameActivity })}
        </div>
        ${window.api?.platform === 'win32' ? `
        <div style="display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; margin-top: 8px; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-md);">
          <div style="flex: 1; margin-right: 12px;">
            <div id="game-share-suggestion-label" style="font-size: 13px; color: var(--text-primary);">${t('settings.gameShareSuggestionLabel')}</div>
            <div id="game-share-suggestion-hint" style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">${t('settings.gameShareSuggestionHint')}</div>
          </div>
          ${renderSwitch({ id: 'toggle-game-share-suggestion', labelledBy: 'game-share-suggestion-label', describedBy: 'game-share-suggestion-hint', checked: settingsStore.suggestGameShare })}
        </div>` : ''}
      </div>

      <div data-settings-section="connections" data-settings-label="${escapeHtml(t('settings.connectionsSection'))}" class="form-group" style="border-top: 1px solid var(--border-color); padding-top: 14px; margin-top: 14px;">
        <label style="display: flex; align-items: center; gap: 6px;">
          <span class="material-symbols-outlined md-16" style="color: var(--accent-primary);">hub</span>
          ${t('settings.connectionsSection')}
        </label>
        <div style="display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-md);">
          <div style="flex: 1; margin-right: 12px;">
            <div id="auto-connect-servers-label" style="font-size: 13px; color: var(--text-primary);">${t('settings.autoConnectServersLabel')}</div>
            <div id="auto-connect-servers-hint" style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">${t('settings.autoConnectServersHint')}</div>
          </div>
          ${renderSwitch({ id: 'toggle-auto-connect-servers', labelledBy: 'auto-connect-servers-label', describedBy: 'auto-connect-servers-hint', checked: settingsStore.autoConnectServers })}
        </div>
      </div>

      ${dmStore.available ? `
      <div data-settings-section="direct-messages" data-settings-label="${escapeHtml(t('settings.dmSection'))}" class="form-group" style="border-top: 1px solid var(--border-color); padding-top: 14px; margin-top: 14px;">
        <label style="display: flex; align-items: center; gap: 6px;" for="select-dm-max-file">
          <span class="material-symbols-outlined md-16" style="color: var(--accent-primary);">forum</span>
          ${t('settings.dmSection')}
        </label>
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-md);">
          <div style="flex: 1;">
            <div style="font-size: 13px; color: var(--text-primary);">${t('settings.dmMaxFileLabel')}</div>
            <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">${t('settings.dmMaxFileHint')}</div>
          </div>
          <select id="select-dm-max-file" style="width: auto; min-width: 110px;">
            ${DM_MAX_FILE_BYTES_OPTIONS.map((bytes) =>
              `<option value="${bytes}" ${bytes === dmStore.snapshot.settings.maxFileBytes ? 'selected' : ''}>${formatBytes(bytes)}</option>`
            ).join('')}
          </select>
        </div>
      </div>
      ` : ''}

      <!-- Language (#16) -->
      <div data-settings-section="language" data-settings-label="${escapeHtml(t('settings.languageSection'))}" class="form-group" style="border-top: 1px solid var(--border-color); padding-top: 14px; margin-top: 14px;">
        <label style="display: flex; align-items: center; gap: 6px;" for="select-language">
          <span class="material-symbols-outlined md-16" style="color: var(--accent-primary);">language</span>
          ${t('settings.languageSection')}
        </label>
        <select id="select-language">
          ${SUPPORTED_LANGUAGES.map(
            (lang) =>
              `<option value="${lang.code}" ${lang.code === getLanguage() ? 'selected' : ''}>${lang.label}</option>`
          ).join('')}
        </select>
        <small style="display: block; margin-top: 6px; color: var(--text-muted); font-size: 11px;">
          ${t('settings.languageHint')}
        </small>
      </div>

      <div data-settings-section="identity" data-settings-label="${escapeHtml(t('identity.sectionTitle'))}" class="form-group" style="border-top: 1px solid var(--border-color); padding-top: 14px; margin-top: 14px;">
        <label style="display: flex; align-items: center; gap: 6px;">
          <span class="material-symbols-outlined md-16" style="color: var(--accent-primary);">manage_accounts</span>
          ${t('identity.sectionTitle')}
        </label>
        <div style="padding: 12px; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-md);">
          <div style="font-size: 12px; color: var(--text-secondary); line-height: 1.45; margin-bottom: 10px;">
            ${connectionStore.hasIdentity ? t('identity.sectionReady') : t('identity.sectionMissing')}
          </div>
          <div style="display: grid; gap: 6px; margin-bottom: 12px;">
            <div style="font-size: 11px; color: var(--text-muted);">
              ${t('identity.clientIdLabel')}
              <div style="font-family: var(--font-mono); color: var(--text-primary); word-break: break-all;">${escapeHtml(connectionStore.clientId || '—')}</div>
            </div>
            <div style="font-size: 11px; color: var(--text-muted);">
              ${t('identity.publicKeyLabel')}
              <div style="font-family: var(--font-mono); color: var(--text-primary); word-break: break-all;">${escapeHtml(connectionStore.publicKey || '—')}</div>
            </div>
          </div>
          <div style="display: flex; gap: 8px; flex-wrap: wrap;">
            <button type="button" id="btn-export-identity" class="btn btn-secondary" ${connectionStore.hasIdentity ? '' : 'disabled'}>
              <span class="material-symbols-outlined md-16" style="margin-right: 4px;">qr_code_2</span>
              ${t('identity.exportAction')}
            </button>
            <button type="button" id="btn-import-identity-settings" class="btn btn-secondary">
              <span class="material-symbols-outlined md-16" style="margin-right: 4px;">qr_code_scanner</span>
              ${t('identity.importAction')}
            </button>
          </div>
        </div>
      </div>
      <div data-settings-section="backup" data-settings-label="${escapeHtml(t('backup.sectionTitle'))}" class="form-group" style="border-top: 1px solid var(--border-color); padding-top: 14px; margin-top: 14px;">
        <label style="display: flex; align-items: center; gap: 6px;">
          <span class="material-symbols-outlined md-16" style="color: var(--accent-primary);">backup</span>
          ${t('backup.sectionTitle')}
        </label>
        <div style="padding: 12px; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-md);">
          <div style="font-size: 12px; color: var(--text-secondary); line-height: 1.45; margin-bottom: 10px;">
            ${t('backup.sectionIntro')}
          </div>
          <div style="display: flex; gap: 8px; flex-wrap: wrap;">
            <button type="button" id="btn-export-backup" class="btn btn-secondary">
              <span class="material-symbols-outlined md-16" style="margin-right: 4px;">download</span>
              ${t('backup.exportAction')}
            </button>
            <button type="button" id="btn-import-backup" class="btn btn-secondary">
              <span class="material-symbols-outlined md-16" style="margin-right: 4px;">upload</span>
              ${t('backup.importAction')}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  public attachEvents(
    container: HTMLElement,
    callbacks: {
      onSaveNickname: (name: string) => Promise<void>;
      onAvatarChanged: (base64: string) => Promise<void>;
      onReloadModal: () => void;
      showError: (msg: string) => void;
      onPresenceChanged?: (status: PresenceStatus) => void;
      /** Either game setting changed: detection and what servers see follow both. */
      onGameActivityChanged?: () => void;
    }
  ): void {
    const inputNickname = container.querySelector<HTMLInputElement>('#settings-nickname-input');
    const btnSaveNickname = container.querySelector<HTMLButtonElement>('#btn-save-nickname');
    const selectLanguage = container.querySelector<HTMLSelectElement>('#select-language');
    const avatarWrapper = container.querySelector<HTMLElement>('#settings-avatar-wrapper');
    const btnExportIdentity = container.querySelector<HTMLButtonElement>('#btn-export-identity');
    const btnImportIdentity = container.querySelector<HTMLButtonElement>('#btn-import-identity-settings');

    const btnEmojiNickname = container.querySelector<HTMLElement>('#btn-emoji-nickname');
    if (btnEmojiNickname && inputNickname) {
      this.detachEmojiPicker = attachInputEmojiPicker(inputNickname, btnEmojiNickname);
    }

    btnSaveNickname?.addEventListener('click', async () => {
      // Checked before anything is applied: the name is saved locally and synced
      // to the other devices, so a refused one would break every next connection.
      const nextNick = normalizeNickname(inputNickname?.value ?? '');
      const error = nicknameError(nextNick);
      if (error) {
        callbacks.showError(error);
        return;
      }
      await callbacks.onSaveNickname(nextNick);
    });

    avatarWrapper?.addEventListener('click', async () => {
      const croppedBase64 = await pickAndCropImage(avatarWrapper);
      if (croppedBase64) {
        await callbacks.onAvatarChanged(croppedBase64);
        const preview = container.querySelector<HTMLImageElement>('#settings-avatar-preview');
        if (preview) preview.src = croppedBase64;
      }
    });

    selectLanguage?.addEventListener('change', async () => {
      const newLang = selectLanguage.value as SupportedLanguage;
      setLanguage(newLang);
      if (window.api?.setLanguage) {
        await window.api.setLanguage(newLang);
      }
      callbacks.onReloadModal();
    });

    // Status cards: online, "Volto já", custom or invisible (#561, user-brb, custom-status).
    const presenceCards = [...container.querySelectorAll<HTMLButtonElement>('[data-presence]')];
    const syncPresenceCards = () => {
      const current = currentPresenceStatus();
      for (const card of presenceCards) card.setAttribute('aria-pressed', String(card.dataset.presence === current));
      this.syncCustomCard(container);
    };
    syncPresenceCards();
    for (const card of presenceCards) {
      card.addEventListener('click', () => {
        const status = PRESENCE_OPTIONS.find(option => option.status === card.dataset.presence)?.status;
        if (!status) return;
        callbacks.onPresenceChanged?.(status);
        syncPresenceCards();
      });
    }
    // Picks the saved custom status, or opens the editor when there is none yet.
    container.querySelector('.presence-cards')?.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[data-presence-custom-edit]')) {
        if (this.customEditor) this.closeCustomEditor(container);
        else this.openCustomEditor(container);
        return;
      }
      if (!target?.closest('[data-presence-custom-select]')) return;
      if (settingsStore.customStatus) callbacks.onPresenceChanged?.('custom');
      else this.openCustomEditor(container);
    });
    // Another device or the user card's menu may change it while this is open.
    this.detachPresenceSync?.();
    this.detachPresenceSync = appEvents.on('settings.updated', syncPresenceCards);

    const toggleGameActivity = container.querySelector<HTMLInputElement>('#toggle-game-activity');
    toggleGameActivity?.addEventListener('change', () => {
      settingsStore.shareGameActivity = toggleGameActivity.checked;
      settingsStore.save();
      callbacks.onGameActivityChanged?.();
    });

    const toggleGameShareSuggestion = container.querySelector<HTMLInputElement>('#toggle-game-share-suggestion');
    toggleGameShareSuggestion?.addEventListener('change', () => {
      settingsStore.suggestGameShare = toggleGameShareSuggestion.checked;
      settingsStore.save();
      callbacks.onGameActivityChanged?.();
    });

    const toggleAutoConnect = container.querySelector<HTMLInputElement>('#toggle-auto-connect-servers');
    toggleAutoConnect?.addEventListener('change', () => {
      settingsStore.autoConnectServers = toggleAutoConnect.checked;
      settingsStore.save();
    });

    const selectDmMaxFile = container.querySelector<HTMLSelectElement>('#select-dm-max-file');
    selectDmMaxFile?.addEventListener('change', async () => {
      const previous = dmStore.snapshot.settings.maxFileBytes;
      const failure = await dmStore.updateMaxFileBytes(Number(selectDmMaxFile.value));
      if (failure) {
        selectDmMaxFile.value = String(previous);
        callbacks.showError(t('dm.errorGeneric'));
      }
    });

    btnExportIdentity?.addEventListener('click', async () => {
      await showIdentityExportDialog(connectionStore.clientId || '');
    });

    btnImportIdentity?.addEventListener('click', async () => {
      const imported = await showIdentityImportDialog();
      if (imported) {
        connectionStore.clientId = imported.clientId;
        connectionStore.publicKey = imported.publicKey;
        connectionStore.hasIdentity = true;
        // Connections already open stay signed in as before; when they reconnect, they sign in as this identity.
        for (const session of sessionManager.getAll()) session.client.adoptIdentity(imported);
        // The imported identity brings its own friends and conversations.
        void dmStore.reload();
        const restored = imported.restoredScopes ?? [];
        const message = imported.extrasFailed
          ? `${t('identity.importSuccess')} ${t('backup.extrasRestoreFailed')}`
          : restored.length > 0
            ? `${t('identity.importSuccess')} ${t('backup.extrasRestored')}`
            : t('identity.importSuccess');
        // The settings reopen only after the notice is read: reopening first would put it behind them.
        await showAlert({ title: t('identity.importTitle'), message });
        callbacks.onReloadModal();
      }
    });

    container.querySelector<HTMLButtonElement>('#btn-export-backup')?.addEventListener('click', async (event) => {
      await showBackupExportDialog(event.currentTarget as HTMLElement);
    });

    container.querySelector<HTMLButtonElement>('#btn-import-backup')?.addEventListener('click', async (event) => {
      const applied = await showBackupImportDialog(event.currentTarget as HTMLElement);
      if (applied && applied.length > 0) callbacks.onReloadModal();
    });
  }

  public cleanup(): void {
    this.customEditor?.destroy();
    this.customEditor = null;
    this.detachEmojiPicker?.();
    this.detachEmojiPicker = null;
    this.detachPresenceSync?.();
    this.detachPresenceSync = null;
  }
}
