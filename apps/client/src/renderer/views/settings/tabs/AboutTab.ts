import { settingsStore } from '../../../stores/settingsStore';
import { updateService } from '../../../core/UpdateService';
import { changelogModal } from '../../ChangelogModal';
import { t } from '../../../i18n';
import { escapeHtml } from '../../../utils/html';

const IDEAS_URL = 'https://github.com/MonkyOrg/Monky/discussions/categories/ideas';
const NEW_IDEA_URL = 'https://github.com/MonkyOrg/Monky/discussions/new?category=ideas';
const NEW_BUG_URL = 'https://github.com/MonkyOrg/Monky/discussions/new?category=bug-reports';
const DONATE_URL = 'https://buymeacoffee.com/monkyorg';

export class AboutTab {
  public renderHtml(): string {
    return `
      <!-- Updates -->
      <div class="form-group" style="margin-bottom: 16px;">
        <label data-settings-section="updates" data-settings-label="${escapeHtml(t('settings.updatesSection'))}" style="display: flex; align-items: center; gap: 6px;">
          <span class="material-symbols-outlined md-16" style="color: var(--accent-primary);">system_update</span>
          ${t('settings.updatesSection')}
        </label>
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
          <div style="flex: 1;">
            <div style="font-size: 12px; color: var(--text-secondary);">
              ${t('settings.currentVersion')} <span id="settings-app-version" style="font-family: var(--font-mono);">…</span>
            </div>
            <div id="settings-update-status" style="font-size: 11px; color: var(--text-muted); margin-top: 2px;"></div>
          </div>
          <button id="btn-check-updates" class="btn btn-secondary" style="font-size: 12px; padding: 6px 12px;">
            <span class="material-symbols-outlined md-16" style="margin-right: 4px;">refresh</span>
            ${t('settings.checkUpdates')}
          </button>
        </div>
        <div style="margin-top: 8px;">
          <button id="btn-view-changelog" class="btn btn-secondary" style="font-size: 12px; padding: 6px 12px;">
            <span class="material-symbols-outlined md-16" style="margin-right: 4px; color: var(--accent-primary);">new_releases</span>
            ${t('settings.viewChangelog')}
          </button>
        </div>
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 12px; padding-top: 12px; border-top: 1px dashed var(--border-color);">
          <div>
            <label style="display: flex; align-items: center; gap: 6px; margin-bottom: 2px; cursor: pointer; font-weight: 600;" for="checkbox-update-beta">
              <span class="material-symbols-outlined md-16" style="color: var(--accent-primary);">science</span>
              ${t('settings.betaChannel')}
            </label>
            <div style="font-size: 11px; color: var(--text-muted);">
              ${t('settings.betaChannelDesc')}
            </div>
          </div>
          <label class="toggle-switch" aria-label="${t('settings.betaChannel')}">
            <input id="checkbox-update-beta" type="checkbox" ${settingsStore.updateBetaChannel ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 12px; padding-top: 12px; border-top: 1px dashed var(--border-color);">
          <div>
            <label data-settings-section="auto-start" data-settings-label="${escapeHtml(t('settings.autoStart'))}" style="display: flex; align-items: center; gap: 6px; margin-bottom: 2px; cursor: pointer; font-weight: 600;" for="checkbox-auto-start">
              <span class="material-symbols-outlined md-16" style="color: var(--accent-primary);">power_settings_new</span>
              ${t('settings.autoStart')}
            </label>
            <div style="font-size: 11px; color: var(--text-muted);">
              ${t('settings.autoStartDesc')}
            </div>
          </div>
          <label class="toggle-switch" aria-label="${t('settings.autoStart')}">
            <input id="checkbox-auto-start" type="checkbox">
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 12px; padding-top: 12px; border-top: 1px dashed var(--border-color);">
          <div>
            <label style="display: flex; align-items: center; gap: 6px; margin-bottom: 2px; cursor: pointer; font-weight: 600;" for="checkbox-minimize-to-tray">
              <span class="material-symbols-outlined md-16" style="color: var(--accent-primary);">dock_to_bottom</span>
              ${t('settings.minimizeToTray')}
            </label>
            <div style="font-size: 11px; color: var(--text-muted);">
              ${t('settings.minimizeToTrayDesc')}
            </div>
          </div>
          <label class="toggle-switch" aria-label="${t('settings.minimizeToTray')}">
            <input id="checkbox-minimize-to-tray" type="checkbox" ${settingsStore.minimizeToTrayOnClose ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 12px; padding-top: 12px; border-top: 1px dashed var(--border-color);">
          <div>
            <label style="display: flex; align-items: center; gap: 6px; margin-bottom: 2px; cursor: pointer; font-weight: 600;" for="checkbox-ask-shutdown">
              <span class="material-symbols-outlined md-16" style="color: var(--accent-primary);">dns</span>
              ${t('settings.askShutdownOnLastLeave')}
            </label>
            <div style="font-size: 11px; color: var(--text-muted);">
              ${t('settings.askShutdownOnLastLeaveDesc')}
            </div>
          </div>
          <label class="toggle-switch" aria-label="${t('settings.askShutdownOnLastLeave')}">
            <input id="checkbox-ask-shutdown" type="checkbox" ${settingsStore.askShutdownOnLastLeave ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>

      <!-- Community -->
      <div data-settings-section="community" data-settings-label="${escapeHtml(t('settings.communitySection'))}" class="form-group" style="border-top: 1px solid var(--border-color); padding-top: 14px;">
        <label style="display: flex; align-items: center; gap: 6px;">
          <span class="material-symbols-outlined md-16" style="color: var(--accent-primary);">forum</span>
          ${t('settings.communitySection')}
        </label>
        <small style="display: block; margin-bottom: 8px; color: var(--text-muted); font-size: 11px;">
          ${t('settings.communityDesc')}
        </small>
        <div style="display: flex; gap: 8px; flex-wrap: wrap;">
          <button id="btn-support-project" class="btn btn-secondary" style="font-size: 12px; padding: 6px 12px; color: #ffdd00; border-color: rgba(255, 221, 0, 0.4); background: rgba(255, 221, 0, 0.08);">
            <span class="material-symbols-outlined md-16" style="margin-right: 4px; color: #ffdd00;">coffee</span>
            ${t('settings.supportProject')}
          </button>
          <button id="btn-suggest-idea" class="btn btn-secondary" style="font-size: 12px; padding: 6px 12px;">
            <span class="material-symbols-outlined md-16" style="margin-right: 4px;">lightbulb</span>
            ${t('settings.suggestIdea')}
          </button>
          <button id="btn-vote-ideas" class="btn btn-secondary" style="font-size: 12px; padding: 6px 12px;">
            <span class="material-symbols-outlined md-16" style="margin-right: 4px;">how_to_vote</span>
            ${t('settings.voteIdeas')}
          </button>
          <button id="btn-report-bug" class="btn btn-secondary" style="font-size: 12px; padding: 6px 12px;">
            <span class="material-symbols-outlined md-16" style="margin-right: 4px;">bug_report</span>
            ${t('settings.reportBug')}
          </button>
        </div>
      </div>
    `;
  }

  public async loadAppVersion(container: HTMLElement): Promise<void> {
    try {
      const verEl = container.querySelector<HTMLElement>('#settings-app-version');
      if (verEl && window.api?.getAppVersion) {
        const v = await window.api.getAppVersion();
        verEl.textContent = `v${v}`;
      }
    } catch {}
  }

  public attachEvents(container: HTMLElement): void {
    const btnCheckUpdates = container.querySelector<HTMLButtonElement>('#btn-check-updates');
    const btnViewChangelog = container.querySelector<HTMLButtonElement>('#btn-view-changelog');
    const updateStatus = container.querySelector<HTMLElement>('#settings-update-status');
    const checkboxBeta = container.querySelector<HTMLInputElement>('#checkbox-update-beta');
    const checkboxAutoStart = container.querySelector<HTMLInputElement>('#checkbox-auto-start');
    const checkboxMinimizeToTray = container.querySelector<HTMLInputElement>('#checkbox-minimize-to-tray');
    const checkboxAskShutdown = container.querySelector<HTMLInputElement>('#checkbox-ask-shutdown');
    const btnSupport = container.querySelector<HTMLButtonElement>('#btn-support-project');
    const btnSuggest = container.querySelector<HTMLButtonElement>('#btn-suggest-idea');
    const btnVote = container.querySelector<HTMLButtonElement>('#btn-vote-ideas');
    const btnReport = container.querySelector<HTMLButtonElement>('#btn-report-bug');

    btnCheckUpdates?.addEventListener('click', async () => {
      if (updateStatus) updateStatus.textContent = t('settings.checking');
      const res = await updateService.checkManually();
      if (updateStatus) {
        if (res.status === 'error') {
          updateStatus.textContent = t('settings.updateCheckFailed');
        } else if (res.status === 'available' && res.version) {
          updateStatus.textContent = t('settings.updateAvailable', { version: res.version });
        } else {
          updateStatus.textContent = t('settings.upToDate');
        }
      }
    });

    btnViewChangelog?.addEventListener('click', () => {
      void changelogModal.open({ celebrate: false });
    });

    checkboxBeta?.addEventListener('change', async () => {
      const allowBeta = checkboxBeta.checked;
      settingsStore.updateBetaChannel = allowBeta;
      settingsStore.save();
      if (window.api?.setUpdateChannel) {
        await window.api.setUpdateChannel(allowBeta);
      }
    });

    if (window.api?.getAutoStart && checkboxAutoStart) {
      window.api.getAutoStart().then((enabled) => {
        checkboxAutoStart.checked = enabled;
      }).catch(() => {});

      checkboxAutoStart.addEventListener('change', () => {
        window.api?.setAutoStart?.(checkboxAutoStart.checked);
      });
    }

    checkboxMinimizeToTray?.addEventListener('change', () => {
      const enabled = checkboxMinimizeToTray.checked;
      settingsStore.minimizeToTrayOnClose = enabled;
      settingsStore.save();
      if (window.api?.setMinimizeToTray) {
        window.api.setMinimizeToTray(enabled).catch(() => {});
      }
    });

    checkboxAskShutdown?.addEventListener('change', () => {
      settingsStore.askShutdownOnLastLeave = checkboxAskShutdown.checked;
      settingsStore.save();
    });

    const openInBrowser = (url: string) => {
      window.open(url, '_blank', 'noopener');
    };

    const openLink = (url: string) => {
      if (!window.api?.openExternal) {
        openInBrowser(url);
        return;
      }

      window.api.openExternal(url)
        .then((res) => {
          if (!res?.success) openInBrowser(url);
        })
        .catch(() => openInBrowser(url));
    };

    btnSupport?.addEventListener('click', () => openLink(DONATE_URL));
    btnSuggest?.addEventListener('click', () => openLink(NEW_IDEA_URL));
    btnVote?.addEventListener('click', () => openLink(IDEAS_URL));
    btnReport?.addEventListener('click', () => openLink(NEW_BUG_URL));
  }
}
