import { BUG_REPORT_URL } from '@monky/shared';
import { settingsStore } from '../../../stores/settingsStore';
import { updateService } from '../../../core/UpdateService';
import { changelogModal } from '../../ChangelogModal';
import { t } from '../../../i18n';
import { escapeHtml } from '../../../utils/html';
import { renderSwitch } from '../../../utils/formControls';
import { bindVersionCopyButton, renderVersionCopyButton, setVersionCopyButton } from '../../VersionCopyButton';
import { showErrorToast } from '../../CopyToast';
import { openExternalUrl } from '../../../utils/feedback';
import licenseText from '../../../../../../../LICENSE?raw';

const SOURCE_URL = 'https://github.com/MonkyOrg/Monky';
const IDEAS_URL = 'https://github.com/MonkyOrg/Monky/discussions/categories/ideas';
const NEW_IDEA_URL = 'https://github.com/MonkyOrg/Monky/discussions/new?category=ideas';
const DONATE_URL = 'https://buymeacoffee.com/monkyorg';

export class AboutTab {
  private unbindVersionCopy: (() => void) | null = null;
  private unbindSourceLink: (() => void) | null = null;
  private unbindUpdateCheck: (() => void) | null = null;

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
              ${t('settings.currentVersion')} ${renderVersionCopyButton('settings-app-version')}
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
          ${renderSwitch({ id: 'checkbox-update-beta', label: t('settings.betaChannel'), checked: settingsStore.updateBetaChannel })}
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
          <span id="auto-start-loading" class="skeleton loading-skeleton-switch" role="status" aria-label="${escapeHtml(t('common.loading'))}"></span>
          ${renderSwitch({ id: 'checkbox-auto-start', label: t('settings.autoStart'), checked: false, disabled: true, wrapperId: 'auto-start-control', hidden: true })}
        </div>
        <p id="auto-start-load-error" class="audio-device-status" role="status" hidden></p>
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
          ${renderSwitch({ id: 'checkbox-minimize-to-tray', label: t('settings.minimizeToTray'), checked: settingsStore.minimizeToTrayOnClose })}
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
          ${renderSwitch({ id: 'checkbox-ask-shutdown', label: t('settings.askShutdownOnLastLeave'), checked: settingsStore.askShutdownOnLastLeave })}
        </div>
      </div>

      <div data-settings-section="license" data-settings-label="${escapeHtml(t('settings.licenseSection'))}" class="form-group" style="border-top: 1px solid var(--border-color); padding-top: 14px;">
        <label>${t('settings.licenseSection')}</label>
        <p style="font-size: 12px; color: var(--text-secondary);">Copyright (c) 2026 Monky Contributors</p>
        <p style="font-size: 12px; color: var(--text-secondary);">${t('settings.licenseDescription')}</p>
        <details>
          <summary style="cursor: pointer;">GNU GPL-3.0-or-later</summary>
          <pre tabindex="0" aria-label="${escapeHtml(t('settings.licenseSection'))}" style="max-height: 220px; overflow: auto; white-space: pre-wrap; font-size: 11px;">${escapeHtml(licenseText)}</pre>
        </details>
        <button id="btn-source-code" class="btn btn-secondary" style="font-size: 12px; margin-top: 8px;">${t('settings.sourceCode')}</button>
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
    const verEl = container.querySelector<HTMLButtonElement>('#settings-app-version');
    if (!verEl) return;
    try {
      if (!window.api?.getAppVersion) throw new Error('App version bridge unavailable');
      const version = await window.api.getAppVersion();
      if (!version.trim()) throw new Error('Empty app version');
      if (container.isConnected) setVersionCopyButton(verEl, `v${version}`);
    } catch (error) {
      console.warn('[AboutTab] Could not load app version', error);
      if (!container.isConnected) return;
      verEl.classList.remove('skeleton', 'loading-skeleton-value');
      verEl.setAttribute('aria-busy', 'false');
      verEl.disabled = true;
      verEl.textContent = t('versionCopy.unavailable');
      verEl.title = t('versionCopy.loadFailed');
      verEl.setAttribute('aria-label', verEl.title);
    }
  }

  public attachEvents(container: HTMLElement): void {
    this.cleanup();
    const versionButton = container.querySelector<HTMLButtonElement>('#settings-app-version');
    if (versionButton) this.unbindVersionCopy = bindVersionCopyButton(versionButton);
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
    const sourceButton = container.querySelector<HTMLButtonElement>('#btn-source-code');
    if (sourceButton) {
      const openSource = () => { void openExternalUrl(SOURCE_URL, t('settings.sourceCodeOpenFailed')); };
      sourceButton.addEventListener('click', openSource);
      this.unbindSourceLink = () => sourceButton.removeEventListener('click', openSource);
    }

    let checking = false;
    let attached = true;
    const checkUpdates = async (): Promise<void> => {
      if (checking) { await updateService.cancelCheck(); return; }
      checking = true;
      if (btnCheckUpdates) btnCheckUpdates.textContent = t('common.cancel');
      if (updateStatus) updateStatus.textContent = t('settings.checking');
      const res = await updateService.checkManually();
      checking = false;
      if (!attached || !container.isConnected) return;
      if (btnCheckUpdates) btnCheckUpdates.textContent = t('settings.checkUpdates');
      if (updateStatus) {
        if (res.status === 'error' || res.status === 'cancelled') {
          updateStatus.textContent = '';
        } else if (res.status === 'available' && res.version) {
          updateStatus.textContent = t('settings.updateAvailable', { version: res.version });
        } else {
          updateStatus.textContent = t('settings.upToDate');
        }
      }
    };
    btnCheckUpdates?.addEventListener('click', checkUpdates);
    this.unbindUpdateCheck = () => {
      attached = false;
      btnCheckUpdates?.removeEventListener('click', checkUpdates);
      if (checking) void updateService.cancelCheck();
    };

    btnViewChangelog?.addEventListener('click', () => {
      void changelogModal.open({ celebrate: false });
    });

    checkboxBeta?.addEventListener('change', async () => {
      const allowBeta = checkboxBeta.checked;
      settingsStore.updateBetaChannel = allowBeta;
      settingsStore.save();
      if (window.api?.setUpdateChannel) {
        const result = await window.api.setUpdateChannel(allowBeta);
        if (!result.ok) {
          checkboxBeta.checked = !allowBeta;
          settingsStore.updateBetaChannel = !allowBeta;
          settingsStore.save();
          showErrorToast(result.error || t('update.busy'));
        }
      }
    });

    if (checkboxAutoStart) {
      const loading = container.querySelector<HTMLElement>('#auto-start-loading');
      const control = container.querySelector<HTMLElement>('#auto-start-control');
      const failure = container.querySelector<HTMLElement>('#auto-start-load-error');
      const loadAutoStart = async (): Promise<void> => {
        try {
          if (!window.api?.getAutoStart) throw new Error('Auto-start preference bridge unavailable');
          const enabled = await window.api.getAutoStart();
          if (!container.isConnected) return;
          checkboxAutoStart.checked = enabled;
          checkboxAutoStart.disabled = false;
        } catch (error: unknown) {
          if (!container.isConnected) return;
          console.warn('[AboutTab] Could not load the auto-start preference', error);
          if (failure) { failure.textContent = t('settings.autoStartLoadFailed'); failure.hidden = false; }
        } finally {
          if (container.isConnected) {
            if (loading) loading.hidden = true;
            if (control) control.hidden = false;
          }
        }
      };
      void loadAutoStart();

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

    const openLink = (url: string) => { void openExternalUrl(url, t('settings.linkOpenFailed', { url })); };

    btnSupport?.addEventListener('click', () => openLink(DONATE_URL));
    btnSuggest?.addEventListener('click', () => openLink(NEW_IDEA_URL));
    btnVote?.addEventListener('click', () => openLink(IDEAS_URL));
    btnReport?.addEventListener('click', () => openLink(BUG_REPORT_URL));
  }

  public cleanup(): void {
    this.unbindUpdateCheck?.();
    this.unbindUpdateCheck = null;
    this.unbindSourceLink?.();
    this.unbindSourceLink = null;
    this.unbindVersionCopy?.();
    this.unbindVersionCopy = null;
  }
}
