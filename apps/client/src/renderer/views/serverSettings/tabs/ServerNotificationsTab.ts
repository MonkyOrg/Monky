import { t } from '../../../i18n';
import { escapeHtml } from '../../../utils/html';

export class ServerNotificationsTab {
  public renderHtml(): string {
    return `
      <div data-settings-section="chat-sound" data-settings-label="${escapeHtml(t('serverSettings.chatSoundLabel'))}" style="background: var(--bg-card); padding: 14px; border-radius: var(--radius-md); border: 1px solid var(--border-color);">
        <label for="select-server-chat-sound" style="font-size: 13px; font-weight: 600; color: var(--text-primary); display: flex; align-items: center; gap: 6px; margin-bottom: 6px; cursor: pointer;">
          <span class="material-symbols-outlined md-18" style="color: var(--accent-primary);">notifications</span>
          <span>${t('serverSettings.chatSoundLabel')}</span>
        </label>
        <select id="select-server-chat-sound" style="width: 100%;">
          <option value="inherit">${t('chatSound.inheritGeneral')}</option>
          <option value="all">${t('chatSound.all')}</option>
          <option value="mentions">${t('chatSound.mentions')}</option>
          <option value="none">${t('chatSound.none')}</option>
        </select>
        <div style="font-size: 11px; color: var(--text-muted); margin-top: 8px;">
          ${t('serverSettings.chatSoundHint')}
        </div>
      </div>
    `;
  }
}
