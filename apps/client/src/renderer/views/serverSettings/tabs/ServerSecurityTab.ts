import { serverStore } from '../../../stores/serverStore';
import { t } from '../../../i18n';
import { escapeHtml } from '../../../utils/html';

export class ServerSecurityTab {
  public renderHtml(): string {
    const s = serverStore.serverDetails;
    if (!s) return '';
    const hasPass = s.hasPassword;

    return `
      <div data-settings-section="server-password" data-settings-label="${escapeHtml(t('invite.passwordLabel'))}" style="display: flex; align-items: center; justify-content: space-between; background: var(--bg-card); padding: 12px 14px; border-radius: var(--radius-md); margin-bottom: 16px; border: 1px solid var(--border-color);">
        <div>
          <div style="font-size: 13px; font-weight: 600; color: var(--text-primary); display: flex; align-items: center; gap: 6px;">
            <span class="material-symbols-outlined md-18" style="color: ${hasPass ? '#f0b232' : '#23a55a'};">${hasPass ? 'lock' : 'lock_open'}</span>
            <span>${hasPass ? t('serverSettings.statusProtected') : t('serverSettings.statusOpen')}</span>
          </div>
          <div id="password-status-desc" style="font-size: 11px; color: var(--text-muted); margin-top: 2px; margin-left: 24px;">
            ${hasPass ? t('serverSettings.statusProtectedDesc') : t('serverSettings.statusOpenDesc')}
          </div>
        </div>

        ${hasPass ? `
          <button type="button" id="btn-remove-pass" class="btn btn-secondary" style="font-size: 11px; padding: 4px 10px; color: var(--danger); border-color: rgba(237, 66, 69, 0.4);">
            ${t('serverSettings.removePassword')}
          </button>
        ` : ''}
      </div>

      <div class="form-group" style="margin-bottom: 4px;">
        <label id="label-password-field">${hasPass ? t('serverSettings.changePasswordLabel') : t('serverSettings.setPasswordLabel')}</label>
        <input id="input-server-pass" type="password" placeholder="${hasPass ? t('serverSettings.changePasswordPlaceholder') : t('serverSettings.setPasswordPlaceholder')}">
      </div>
      <div id="pass-help-text" style="font-size: 11px; color: var(--text-muted); margin-top: 4px;">
        ${t('serverSettings.passwordHelp')}
      </div>
    `;
  }
}
