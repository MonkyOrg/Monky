import { t } from '../i18n';
import { clientLog } from '../core/ClientLogService';
import { sessionManager } from '../core/SessionManager';
import { webRtcManager } from '../core/WebRtcManager';
import { connectionStore } from '../stores/connectionStore';
import { settingsStore } from '../stores/settingsStore';
import { RECENT_EMOJIS_KEY } from '../emoji/recentEmojis';
import { COMMAND_USAGE_STORAGE_KEY } from '../utils/commandCatalog';
import { escapeHtml } from '../utils/html';
import { enterModal, exitModal, handlesModalKey } from '../utils/modalSurface';
import { showIdentityExportDialog } from './IdentityDialogs';

/** Personal activity kept outside the stores: recent emojis, command usage, per-server UI state. */
const ACCOUNT_STORAGE_KEYS = [RECENT_EMOJIS_KEY, COMMAND_USAGE_STORAGE_KEY];
const ACCOUNT_STORAGE_PREFIXES = ['monky.categories.collapsed.', '["monky-hidden-activity"'];

function clearAccountStorage(): void {
  try {
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key && (ACCOUNT_STORAGE_KEYS.includes(key) || ACCOUNT_STORAGE_PREFIXES.some(prefix => key.startsWith(prefix)))) {
        keys.push(key);
      }
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch (error: unknown) {
    clientLog.warn('IDENTITY', 'Could not clear local account activity', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Leaves every server, forgets what belongs to the identity and asks the main
 * process to delete the identity, friends and DMs. Monky then relaunches on the
 * create/import screen. Device preferences (audio, language, shortcuts) stay.
 */
export async function logOut(): Promise<void> {
  clientLog.info('IDENTITY', 'Logging out: leaving servers and deleting the local account');
  try {
    await webRtcManager.prepareForQuit();
  } catch (error: unknown) {
    clientLog.warn('IDENTITY', 'Could not release media before logging out', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  await sessionManager.removeAll();
  connectionStore.clearAccountData();
  settingsStore.clearAccountData();
  clearAccountStorage();
  const result = await window.api.logOut();
  if (!result?.success) throw new Error(result?.error || 'logout failed');
}

/** Confirmation with a shortcut to export the identity before it is deleted. */
export function showLogoutDialog(): Promise<void> {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.style.zIndex = '10001';
    backdrop.innerHTML = `
      <div class="modal-card dialog-card logout-dialog" role="dialog" aria-modal="true" aria-labelledby="logout-dialog-title">
        <div class="modal-header">
          <div class="modal-title" style="display: flex; align-items: center; gap: 8px;">
            <span class="material-symbols-outlined" style="color: var(--danger);">logout</span>
            <span id="logout-dialog-title">${escapeHtml(t('settings.logoutTitle'))}</span>
          </div>
        </div>
        <div id="logout-dialog-error" class="error-banner"></div>
        <div class="dialog-message">${escapeHtml(t('settings.logoutMessage'))}</div>
        <div class="dialog-message logout-dialog-keeps">${escapeHtml(t('settings.logoutKeeps'))}</div>
        <div class="modal-footer logout-dialog-footer">
          <button type="button" class="btn btn-secondary" data-action="export" id="logout-dialog-export">
            <span class="material-symbols-outlined md-18">qr_code_2</span>
            <span>${escapeHtml(t('settings.logoutExport'))}</span>
          </button>
          <span class="logout-dialog-spacer"></span>
          <button type="button" class="btn btn-secondary" data-action="cancel" id="logout-dialog-cancel">${escapeHtml(t('common.cancel'))}</button>
          <button type="button" class="btn btn-danger" data-action="confirm" id="logout-dialog-confirm">${escapeHtml(t('settings.logoutConfirm'))}</button>
        </div>
      </div>
    `;

    const previousFocus = document.activeElement;
    const buttons = [...backdrop.querySelectorAll<HTMLButtonElement>('button')];
    const confirmButton = backdrop.querySelector<HTMLButtonElement>('#logout-dialog-confirm')!;
    const errorBanner = backdrop.querySelector<HTMLElement>('#logout-dialog-error')!;
    let busy = false;
    let closed = false;

    const close = (): void => {
      if (closed || busy) return;
      closed = true;
      document.removeEventListener('keydown', onKeyDown, true);
      exitModal(backdrop);
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
      resolve();
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (!handlesModalKey(backdrop, event) || event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    };

    backdrop.querySelector('#logout-dialog-cancel')?.addEventListener('click', close);
    backdrop.addEventListener('mousedown', (event) => {
      if (event.target === backdrop) close();
    });
    backdrop.querySelector('#logout-dialog-export')?.addEventListener('click', () => {
      void showIdentityExportDialog(connectionStore.clientId || '');
    });
    confirmButton.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      errorBanner.classList.remove('show');
      for (const button of buttons) button.disabled = true;
      try {
        await logOut();
        // The main process relaunches Monky; keep the dialog up until it does.
      } catch (error: unknown) {
        busy = false;
        for (const button of buttons) button.disabled = false;
        const message = error instanceof Error ? error.message : String(error);
        clientLog.error('IDENTITY', 'Logout failed', { error: message });
        errorBanner.textContent = t('settings.logoutFailed', { error: message });
        errorBanner.classList.add('show');
      }
    });

    document.addEventListener('keydown', onKeyDown, true);
    document.body.appendChild(backdrop);
    enterModal(backdrop);
    backdrop.querySelector<HTMLButtonElement>('#logout-dialog-cancel')?.focus();
  });
}
