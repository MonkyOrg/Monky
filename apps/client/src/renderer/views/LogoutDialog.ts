import { t } from '../i18n';
import { clientLog } from '../core/ClientLogService';
import { sessionManager } from '../core/SessionManager';
import { webRtcManager } from '../core/WebRtcManager';
import { connectionStore } from '../stores/connectionStore';
import { settingsStore } from '../stores/settingsStore';
import { RECENT_EMOJIS_KEY } from '../emoji/recentEmojis';
import { COMMAND_USAGE_STORAGE_KEY } from '../utils/commandCatalog';
import { escapeHtml } from '../utils/html';
import { openModal } from '../utils/modalShell';
import { reportError } from '../utils/feedback';
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
    let busy = false;
    const shell = openModal({
      card: `
      <div class="modal-card dialog-card logout-dialog" aria-labelledby="logout-dialog-title">
        <div class="modal-header">
          <div class="modal-title" style="display: flex; align-items: center; gap: 8px;">
            <span class="material-symbols-outlined" style="color: var(--danger);" aria-hidden="true">logout</span>
            <span id="logout-dialog-title">${escapeHtml(t('settings.logoutTitle'))}</span>
          </div>
        </div>
        <div class="dialog-message">${escapeHtml(t('settings.logoutMessage'))}</div>
        <div class="dialog-message logout-dialog-keeps">${escapeHtml(t('settings.logoutKeeps'))}</div>
        <div class="modal-footer logout-dialog-footer">
          <button type="button" class="btn btn-secondary" data-action="export" id="logout-dialog-export">
            <span class="material-symbols-outlined md-18" aria-hidden="true">qr_code_2</span>
            <span>${escapeHtml(t('settings.logoutExport'))}</span>
          </button>
          <span class="logout-dialog-spacer"></span>
          <button type="button" class="btn btn-secondary" data-action="cancel" id="logout-dialog-cancel" data-modal-close>${escapeHtml(t('common.cancel'))}</button>
          <button type="button" class="btn btn-danger" data-action="confirm" id="logout-dialog-confirm">${escapeHtml(t('settings.logoutConfirm'))}</button>
        </div>
      </div>
    `,
      initialFocus: '#logout-dialog-cancel',
      // While the account is being deleted, nothing dismisses the dialog.
      canClose: () => !busy,
      onClose: () => resolve(),
    });

    const buttons = [...shell.card.querySelectorAll<HTMLButtonElement>('button')];
    const confirmButton = shell.card.querySelector<HTMLButtonElement>('#logout-dialog-confirm')!;

    shell.card.querySelector('#logout-dialog-export')?.addEventListener('click', () => {
      void showIdentityExportDialog(connectionStore.clientId || '');
    }, { signal: shell.signal });
    confirmButton.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      for (const button of buttons) button.disabled = true;
      try {
        await logOut();
        // The main process relaunches Monky; keep the dialog up until it does.
      } catch (error: unknown) {
        busy = false;
        for (const button of buttons) button.disabled = false;
        const message = error instanceof Error ? error.message : String(error);
        clientLog.error('IDENTITY', 'Logout failed', { error: message });
        reportError(t('settings.logoutFailed', { error: message }));
      }
    }, { signal: shell.signal });
  });
}
