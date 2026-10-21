import { escapeHtml } from '../utils/html';
import { t } from '../i18n';
import { animateEnter, removeWithMotion } from '../utils/surfaceMotion';
import { setSurfaceVisible } from '../utils/surfaceVisibility';
import { settingsStore } from '../stores/settingsStore';
import { changelogModal } from '../views/ChangelogModal';
import { showUpdateCompatibility } from '../views/UpdateCompatibilityDialog';
import { showErrorToast } from '../views/CopyToast';
import { appEvents } from './EventBus';

const DISMISSED_KEY = 'monky_dismissed_update';
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const INSTALLED_BANNER_MS = 15000;
const RELEASES_URL = 'https://github.com/MonkyOrg/Monky/releases/latest';

interface BannerAction {
  label: string;
  primary?: boolean;
  dismiss?: boolean;
  onClick: () => void;
}

interface ActiveRequest {
  id: string;
  cancelled: boolean;
}

/**
 * Handles the in-app auto-update flow.
 *
 * - Windows: uses electron-updater (download + install + relaunch on click).
 * - macOS: downloads the matching .dmg, opens it and closes the app, since
 *   macOS refuses to replace a bundle that is still running (#377). The user
 *   drags the new version into Applications and reopens it.
 *
 * Checks run on startup and hourly, showing a dismissible banner.
 */
class UpdateService {
  private banner: HTMLElement | null = null;
  private textEl: HTMLElement | null = null;
  private actionsEl: HTMLElement | null = null;
  private latestVersion = '';
  private bannerKind = '';
  private listenersBound = false;
  private unbindUpdateEvents: Array<() => void> = [];
  private startingDownload = false;
  private activeCheck: ActiveRequest | null = null;
  private activeDownload: ActiveRequest | null = null;
  private installing = false;

  public async init(): Promise<void> {
    if (!window.api?.checkForUpdates) {
      return;
    }

    // Tell the main process which channel (stable/beta) to use before the first
    // check runs, so detection and downloads honour the user's preference.
    try {
      await window.api.setUpdateChannel?.(settingsStore.updateBetaChannel);
    } catch {
      // Non-fatal: defaults to the stable channel.
    }

    this.bindUpdateEvents();
    void this.reportLastInstall();

    setTimeout(() => this.check(), 4000);
    setInterval(() => this.check(), CHECK_INTERVAL_MS);
  }

  /**
   * Confirms the install that ran while the app was closed (#498). Without it
   * the app just reappears and the user has to dig into Settings to find out
   * whether the update actually landed.
   */
  private async reportLastInstall(): Promise<void> {
    try {
      const outcome = await window.api.getUpdateOutcome?.();
      if (!outcome) return;

      if (outcome.status === 'failed') {
        this.setText(t('update.installFailed', { version: escapeHtml(outcome.version) }));
        this.setActions([
          {
            label: t('update.downloadManually'),
            primary: true,
            onClick: () => window.api.openExternal(RELEASES_URL),
          },
          { label: '×', dismiss: true, onClick: () => this.dismiss() },
        ]);
        return;
      }

      // Prefer the in-app changelog (#547): when it has content it opens on its
      // own and is the whole "what's new" confirmation. Set the banner text only
      // *after* that decision — otherwise it is created behind the modal and,
      // because this path returns early, is left on screen with no dismiss and
      // no auto-hide timer (#547). The banner is just the fallback for an offline
      // start (or a version with no published release), and its button re-opens
      // the same modal instead of the browser.
      const shown = await changelogModal.open({ celebrate: true, requireContent: true });
      if (shown) {
        return;
      }
      this.setText(t('update.installed', { version: escapeHtml(outcome.version) }));
      this.setActions([
        {
          label: t('update.whatsNew'),
          primary: true,
          onClick: () => {
            void changelogModal.open({ celebrate: true });
          },
        },
        { label: '×', dismiss: true, onClick: () => this.dismiss() },
      ]);
      this.bannerKind = 'installed';
      // Good news doesn't need to stay on screen: clear it unless something
      // else has taken the banner over in the meantime.
      window.setTimeout(() => {
        if (this.bannerKind === 'installed') {
          this.dismiss();
        }
      }, INSTALLED_BANNER_MS);
    } catch {
      // Non-fatal: the banner is informational only.
    }
  }

  private bindUpdateEvents(): void {
    if (this.listenersBound) return;
    this.listenersBound = true;

    const u1 = window.api.onUpdateProgress((percent) => {
      if (!this.activeDownload || this.activeDownload.cancelled || this.installing) return;
      this.setText(t('update.downloading', { percent }));
    });

    const u2 = window.api.onUpdateDownloaded((info) => {
      if (!this.activeDownload || this.activeDownload.cancelled) return;
      this.installing = true;
      if (info.manual) {
        // macOS: the .dmg is open and the app closes on its own so Finder can
        // replace the bundle (#377). Nothing left to click, same as Windows.
        this.setText(t('update.installerOpened'));
        this.setActions([]);
      } else {
        // Windows: the main process installs silently and relaunches on its own.
        this.setText(t('update.installing'));
        this.setActions([]);
      }
    });

    const u3 = window.api.onUpdateError(() => {
      if ((!this.activeDownload && !this.installing) || this.activeDownload?.cancelled) return;
      this.installing = false;
      this.setText(t('update.downloadFailed'));
      this.setActions([
        {
          label: t('update.downloadManually'),
          primary: true,
          onClick: () => window.api.openExternal(RELEASES_URL),
        },
        { label: '×', dismiss: true, onClick: () => this.dismiss() },
      ]);
    });

    this.unbindUpdateEvents.push(u1, u2, u3, appEvents.on('i18n.language_changed', () => {
      if (this.bannerKind === 'available') this.showAvailable(this.latestVersion);
    }));
  }

  private async check(): Promise<void> {
    if (this.activeCheck || this.startingDownload || this.installing) return;
    const request = { id: crypto.randomUUID(), cancelled: false };
    this.activeCheck = request;
    try {
      const result = await window.api.checkForUpdates(request.id);
      if (this.activeCheck !== request || request.cancelled || !result?.ok || !result.available || !result.version) {
        return;
      }

      if (localStorage.getItem(DISMISSED_KEY) === result.version) {
        return;
      }

      this.latestVersion = result.version;
      this.showAvailable(result.version);
    } catch {
      // Non-fatal: try again on the next interval.
    } finally {
      if (this.activeCheck === request) this.activeCheck = null;
    }
  }

  /**
   * Triggered by the "Verificar atualizações" button in Settings. Unlike the
   * automatic check, it ignores the dismissed flag and reports the outcome.
   */
  public async checkManually(): Promise<{ status: 'available' | 'latest' | 'error' | 'cancelled'; version?: string }> {
    if (!window.api?.checkForUpdates) {
      return { status: 'error' };
    }
    if (this.startingDownload || this.installing) {
      showErrorToast(t('update.busy'));
      return { status: 'cancelled' };
    }
    if (this.activeCheck) await this.cancelCheck();
    const request = { id: crypto.randomUUID(), cancelled: false };
    this.activeCheck = request;
    this.setText(t('settings.checking'));
    this.setActions(this.cancelActions(() => { void this.cancelCheck(); }));
    try {
      const result = await window.api.checkForUpdates(request.id);
      if (request.cancelled || this.activeCheck !== request) return { status: 'cancelled' };
      if (result.cancelled) { this.dismiss(false); return { status: 'cancelled' }; }
      if (!result?.ok) {
        this.dismiss(false);
        showErrorToast(t('settings.updateCheckFailed'));
        return { status: 'error' };
      }
      if (result.available && result.version) {
        this.latestVersion = result.version;
        this.showAvailable(result.version);
        return { status: 'available', version: result.version };
      }
      this.dismiss(false);
      return { status: 'latest' };
    } catch {
      if (request.cancelled || this.activeCheck !== request) return { status: 'cancelled' };
      this.dismiss(false);
      showErrorToast(t('settings.updateCheckFailed'));
      return { status: 'error' };
    } finally {
      if (this.activeCheck === request) this.activeCheck = null;
    }
  }

  public async cancelCheck(): Promise<void> {
    const request = this.activeCheck;
    if (!request) return;
    request.cancelled = true;
    this.activeCheck = null;
    this.dismiss(false);
    try {
      const result = await window.api.cancelUpdate(request.id);
      if (!result.ok) throw new Error(result.error);
    } catch (error) {
      console.warn('[UpdateService] Could not cancel update check', error);
      showErrorToast(t('update.cancelFailed'));
    }
  }

  private cancelActions(cancel: () => void): BannerAction[] {
    return [
      { label: t('common.cancel'), onClick: cancel },
      { label: '×', dismiss: true, onClick: cancel },
    ];
  }

  private showAvailable(version: string): void {
    this.ensureBanner();
    this.setText(t('update.available', { version: escapeHtml(version) }));
    this.bannerKind = 'available';
    this.setActions([
      {
        label: t('update.updateNow'),
        primary: true,
        onClick: () => { void this.downloadConfirmedVersion(version); },
      },
      { label: '×', dismiss: true, onClick: () => this.dismiss() },
    ]);
  }

  private async downloadConfirmedVersion(version: string): Promise<void> {
    if (this.startingDownload || this.installing) return;
    this.startingDownload = true;
    if (this.activeCheck) await this.cancelCheck();
    const request = { id: crypto.randomUUID(), cancelled: false };
    this.activeDownload = request;
    try {
      for (;;) {
        this.setText(t('update.checkingLocalBots'));
        this.setActions(this.cancelActions(() => { void this.cancelDownload(); }));
        const assessment = await window.api.checkUpdateCompatibility(version, request.id);
        if (request.cancelled || assessment.cancelled) { this.dismiss(false); return; }
        if (!assessment.ok) throw new Error(assessment.error);
        if (!assessment.warnings?.length) break;
        const banner = this.banner;
        if (banner) setSurfaceVisible(banner, false, 'notice');
        let choice: 'install' | 'retry' | 'cancel';
        try {
          choice = await showUpdateCompatibility(assessment.warnings);
        } finally {
          if (banner?.isConnected) {
            setSurfaceVisible(banner, true, 'notice');
            banner.querySelector<HTMLButtonElement>('.update-banner__download')?.focus();
          }
        }
        if (choice === 'retry') continue;
        if (choice === 'cancel') {
          this.showAvailable(version);
          return;
        }
        break;
      }
      this.setText(t('update.startingDownload'));
      this.setActions(this.cancelActions(() => { void this.cancelDownload(); }));
      const result = await window.api.downloadUpdate(version, request.id);
      if (result.cancelled || request.cancelled) { this.dismiss(false); return; }
      if (!result.ok) throw new Error(result.error || t('update.downloadFailed'));
    } catch (error) {
      if (request.cancelled) return;
      console.warn('[UpdateService] Update failed', error);
      showErrorToast(error instanceof Error ? error.message : t('update.downloadFailed'));
      this.installing = false;
      this.setText(t('update.downloadFailed'));
      this.setActions([
        {
          label: t('update.checkAgain'), primary: true,
          onClick: () => { void this.checkManually(); },
        },
        { label: '×', dismiss: true, onClick: () => this.dismiss() },
      ]);
    } finally {
      this.startingDownload = false;
      if (this.activeDownload === request) this.activeDownload = null;
    }
  }

  private async cancelDownload(): Promise<void> {
    const request = this.activeDownload;
    if (!request || this.installing) return;
    try {
      const result = await window.api.cancelUpdate(request.id);
      if (!result.ok) throw new Error(result.error);
      if (result.cancelled) {
        request.cancelled = true;
        if (this.activeDownload === request) this.dismiss(false);
      }
    } catch (error) {
      console.warn('[UpdateService] Could not cancel update', error);
      showErrorToast(t('update.cancelFailed'));
    }
  }

  private dismiss(remember = true): void {
    if (remember && this.latestVersion) {
      localStorage.setItem(DISMISSED_KEY, this.latestVersion);
    }
    this.bannerKind = '';
    if (this.banner) removeWithMotion(this.banner, 'notice');
    this.banner = null;
    this.textEl = null;
    this.actionsEl = null;
  }

  private ensureBanner(): void {
    if (this.banner) return;

    const banner = document.createElement('div');
    banner.className = 'update-banner';
    banner.setAttribute('role', 'status');
    banner.setAttribute('aria-live', 'polite');

    const text = document.createElement('span');
    text.className = 'update-banner__text';

    const actions = document.createElement('div');
    actions.className = 'update-banner__actions';

    banner.appendChild(text);
    banner.appendChild(actions);
    document.body.appendChild(banner);
    animateEnter(banner, 'notice');

    this.banner = banner;
    this.textEl = text;
    this.actionsEl = actions;
  }

  private setText(html: string): void {
    this.ensureBanner();
    this.bannerKind = '';
    if (this.textEl) {
      this.textEl.innerHTML = html;
    }
  }

  private setActions(actions: BannerAction[]): void {
    this.ensureBanner();
    if (!this.actionsEl) return;
    const restoreFocus = this.actionsEl.contains(document.activeElement);
    this.actionsEl.innerHTML = '';

    for (const action of actions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = action.label;
      if (action.dismiss) btn.setAttribute('aria-label', t('common.close'));
      btn.className = action.dismiss ? 'update-banner__dismiss' : 'update-banner__download';
      btn.addEventListener('click', action.onClick);
      this.actionsEl.appendChild(btn);
    }
    if (restoreFocus) this.actionsEl.querySelector<HTMLButtonElement>('button')?.focus();
  }
}

export const updateService = new UpdateService();
