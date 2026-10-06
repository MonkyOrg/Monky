import { escapeHtml } from '../../../utils/html';
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
import { DM_MAX_FILE_BYTES_OPTIONS, MessageType } from '@monky/shared';
import { dmStore } from '../../../stores/dmStore';
import { formatBytes } from '../../../utils/attachment';

export class AccountTab {
  private detachEmojiPicker: (() => void) | null = null;

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

      <!-- Appear Offline (#561) -->
      <div data-settings-section="visibility" data-settings-label="${escapeHtml(t('settings.appearOfflineSection'))}" class="form-group" style="border-top: 1px solid var(--border-color); padding-top: 14px; margin-top: 14px;">
        <label style="display: flex; align-items: center; gap: 6px;">
          <span class="material-symbols-outlined md-16" style="color: var(--accent-primary);">visibility_off</span>
          ${t('settings.appearOfflineSection')}
        </label>
        <div style="display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-md);">
          <div style="flex: 1; margin-right: 12px;">
            <div style="font-size: 13px; color: var(--text-primary);">${t('settings.appearOfflineLabel')}</div>
            <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">${t('settings.appearOfflineHint')}</div>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" id="toggle-appear-offline" ${settingsStore.appearOffline ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>

      <!-- Game activity (#675) -->
      <div data-settings-section="game-activity" data-settings-label="${escapeHtml(t('settings.gameActivitySection'))}" class="form-group" style="border-top: 1px solid var(--border-color); padding-top: 14px; margin-top: 14px;">
        <label style="display: flex; align-items: center; gap: 6px;">
          <span class="material-symbols-outlined md-16" style="color: var(--accent-primary);">sports_esports</span>
          ${t('settings.gameActivitySection')}
        </label>
        <div style="display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-md);">
          <div style="flex: 1; margin-right: 12px;">
            <div style="font-size: 13px; color: var(--text-primary);">${t('settings.gameActivityLabel')}</div>
            <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">${t('settings.gameActivityHint')}</div>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" id="toggle-game-activity" ${settingsStore.shareGameActivity ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>

      <div data-settings-section="connections" data-settings-label="${escapeHtml(t('settings.connectionsSection'))}" class="form-group" style="border-top: 1px solid var(--border-color); padding-top: 14px; margin-top: 14px;">
        <label style="display: flex; align-items: center; gap: 6px;">
          <span class="material-symbols-outlined md-16" style="color: var(--accent-primary);">hub</span>
          ${t('settings.connectionsSection')}
        </label>
        <div style="display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-md);">
          <div style="flex: 1; margin-right: 12px;">
            <div style="font-size: 13px; color: var(--text-primary);">${t('settings.autoConnectServersLabel')}</div>
            <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">${t('settings.autoConnectServersHint')}</div>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" id="toggle-auto-connect-servers" ${settingsStore.autoConnectServers ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
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
      onVisibilityChanged?: (appearOffline: boolean) => void;
      onGameActivityChanged?: (enabled: boolean) => void;
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
      const nextNick = inputNickname?.value.trim();
      if (!nextNick) {
        callbacks.showError(t('protocolError.nicknameInvalid'));
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

    // Appear Offline toggle (#561)
    const toggleAppearOffline = container.querySelector<HTMLInputElement>('#toggle-appear-offline');
    toggleAppearOffline?.addEventListener('change', () => {
      settingsStore.appearOffline = toggleAppearOffline.checked;
      settingsStore.save();
      // Notify the server of the visibility change if currently connected.
      if (callbacks.onVisibilityChanged) {
        callbacks.onVisibilityChanged(toggleAppearOffline.checked);
      }
    });

    const toggleGameActivity = container.querySelector<HTMLInputElement>('#toggle-game-activity');
    toggleGameActivity?.addEventListener('change', () => {
      settingsStore.shareGameActivity = toggleGameActivity.checked;
      settingsStore.save();
      callbacks.onGameActivityChanged?.(toggleGameActivity.checked);
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
        // The imported identity brings its own friends and conversations.
        void dmStore.reload();
        const restored = imported.restoredScopes ?? [];
        const message = imported.extrasFailed
          ? `${t('identity.importSuccess')} ${t('backup.extrasRestoreFailed')}`
          : restored.length > 0
            ? `${t('identity.importSuccess')} ${t('backup.extrasRestored')}`
            : t('identity.importSuccess');
        showAlert({ title: t('identity.importTitle'), message });
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
    this.detachEmojiPicker?.();
    this.detachEmojiPicker = null;
  }
}
