import { settingsStore } from '../../../stores/settingsStore';
import { t } from '../../../i18n';
import { escapeHtml } from '../../../utils/html';
import { renderSwitch } from '../../../utils/formControls';

const CARD_STYLE = 'padding: 10px 12px; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-md);';

/** The official Discord inside Monky: its rail button and whether it runs while put away. */
export class DiscordTab {
  private unbind: AbortController | null = null;

  public renderHtml(): string {
    return `
      <div class="form-group" style="margin-bottom: 0;">
        <div class="form-group" style="${CARD_STYLE} margin-bottom: 10px;">
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
            <div>
              <label data-settings-section="discord-web" data-settings-label="${escapeHtml(t('discordWeb.settingLabel'))}" style="display: flex; align-items: center; gap: 6px; margin-bottom: 2px; cursor: pointer; font-weight: 600;" for="checkbox-discord-web">
                <span class="material-symbols-outlined md-16" style="color: var(--accent-primary);">open_in_browser</span>
                ${t('discordWeb.settingLabel')}
              </label>
              <div style="font-size: 11px; color: var(--text-muted);">
                ${t('discordWeb.settingDesc')}
              </div>
            </div>
            ${renderSwitch({ id: 'checkbox-discord-web', label: t('discordWeb.settingLabel'), checked: settingsStore.discordWebEnabled })}
          </div>
        </div>
        <div class="form-group" style="${CARD_STYLE} margin-bottom: 0;">
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
            <div>
              <label data-settings-section="discord-web-background" data-settings-label="${escapeHtml(t('discordWeb.backgroundLabel'))}" style="display: flex; align-items: center; gap: 6px; margin-bottom: 2px; cursor: pointer; font-weight: 600;" for="checkbox-discord-web-background">
                <span class="material-symbols-outlined md-16" style="color: var(--accent-primary);">energy_savings_leaf</span>
                ${t('discordWeb.backgroundLabel')}
              </label>
              <div style="font-size: 11px; color: var(--text-muted);">
                ${t('discordWeb.backgroundDesc')}
              </div>
              <ul style="font-size: 11px; color: var(--text-muted); margin: 6px 0 0; padding-left: 18px;">
                <li>${t('discordWeb.backgroundOn')}</li>
                <li>${t('discordWeb.backgroundOff')}</li>
              </ul>
            </div>
            ${renderSwitch({ id: 'checkbox-discord-web-background', label: t('discordWeb.backgroundLabel'), checked: settingsStore.discordWebBackground })}
          </div>
        </div>
      </div>
    `;
  }

  public attachEvents(container: HTMLElement): void {
    this.cleanup();
    const unbind = new AbortController();
    this.unbind = unbind;
    const enabled = container.querySelector<HTMLInputElement>('#checkbox-discord-web');
    enabled?.addEventListener('change', () => {
      settingsStore.discordWebEnabled = enabled.checked;
      settingsStore.save();
    }, { signal: unbind.signal });
    const background = container.querySelector<HTMLInputElement>('#checkbox-discord-web-background');
    background?.addEventListener('change', () => {
      settingsStore.discordWebBackground = background.checked;
      settingsStore.save();
    }, { signal: unbind.signal });
  }

  public cleanup(): void {
    this.unbind?.abort();
    this.unbind = null;
  }
}
