import { t } from '../../../i18n';
import { escapeHtml } from '../../../utils/html';
import { Permission } from '@monky/shared';
import { serverStore } from '../../../stores/serverStore';

export class ServerNotificationsTab {
  public renderHtml(): string {
    return `
      <fieldset class="server-settings-fieldset" data-server-permission="${Permission.MANAGE_SERVER}">
        ${([
          { id: 'checkbox-allow-everyone-mention', label: 'serverSettings.allowEveryoneMention', description: 'serverSettings.allowEveryoneMentionDesc', enabled: serverStore.serverDetails?.allowEveryoneMention !== false },
          { id: 'checkbox-allow-message-edit', label: 'serverSettings.allowMessageEdit', description: 'serverSettings.allowMessageEditDesc', enabled: serverStore.serverDetails?.allowMessageEdit !== false },
        ] as const).map((setting) => `
          <div data-settings-section="${setting.id}" data-settings-label="${escapeHtml(t(setting.label))}" style="display: flex; align-items: center; justify-content: space-between; gap: 12px; background: var(--bg-card); padding: 14px; margin-bottom: 12px; border-radius: var(--radius-md); border: 1px solid var(--border-color);">
            <div>
              <label for="${setting.id}">${t(setting.label)}</label>
              <div style="font-size: 11px; color: var(--text-muted);">${t(setting.description)}</div>
            </div>
            <label class="toggle-switch" aria-label="${escapeHtml(t(setting.label))}">
              <input id="${setting.id}" type="checkbox" ${setting.enabled ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
          </div>
        `).join('')}
      </fieldset>
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
