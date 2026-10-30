import { t } from '../i18n';
import { escapeHtml } from '../utils/html';
import { openModal } from '../utils/modalShell';
import { errorMessage, reportError } from '../utils/feedback';
import { applyBackup, BACKUP_FILE_EXTENSION, BackupScope, collectBackup, parseBackup } from '../utils/backup';
import { withButtonLoading } from '../utils/buttonLoading';
import { recordProfileChange } from '../core/profileSync';
import { showAlert, showConfirm } from './Dialog';
import { acceptExportPassword, exportPasswordHint } from './exportPassword';

/**
 * Standalone backup of saved servers and app settings (#472), separate from the
 * identity export so it can be done at any time and with a different selection.
 *
 * The file is sealed with a password just like the identity export: the list of
 * saved servers carries the passwords of those servers, so writing it to disk as
 * plain JSON would hand them to anyone who opens the file.
 */

interface ScopeDialogResult {
  scopes: BackupScope[];
  password: string;
}

function buildScopeDialog(params: {
  title: string;
  icon: string;
  intro: string;
  actionLabel: string;
  passwordHint: string;
  /** Exporting sets a new password, which must pass the shared policy (#490). */
  createsPassword: boolean;
}): Promise<ScopeDialogResult | null> {
  return new Promise((resolve) => {
    const scopes: BackupScope[] = ['servers', 'settings'];
    const scopeLabel = (scope: BackupScope) =>
      scope === 'servers' ? t('backup.scopeServers') : t('backup.scopeSettings');

    let result: ScopeDialogResult | null = null;
    const shell = openModal({
      card: `
      <div class="modal-card dialog-card" style="max-width: 460px; width: min(92vw, 460px);">
        <div class="modal-header">
          <div class="modal-title" style="display: flex; align-items: center; gap: 8px;">
            <span class="material-symbols-outlined" style="color: var(--accent-primary);" aria-hidden="true">${params.icon}</span>
            <span>${escapeHtml(params.title)}</span>
          </div>
          <button type="button" class="modal-close-btn" data-action="cancel" data-modal-close aria-label="${escapeHtml(t('common.close'))}">&times;</button>
        </div>
        <div style="font-size: 12px; color: var(--text-secondary); line-height: 1.45; margin-bottom: 12px;">
          ${escapeHtml(params.intro)}
        </div>
        <div style="display: grid; gap: 10px; margin-bottom: 16px;">
          ${scopes
            .map(
              (scope) => `
            <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
              <label style="font-size: 13px; cursor: pointer;" for="backup-scope-${scope}">${escapeHtml(scopeLabel(scope))}</label>
              <label class="toggle-switch">
                <input id="backup-scope-${scope}" type="checkbox" role="switch" data-scope="${scope}" checked>
                <span class="toggle-slider"></span>
              </label>
            </div>`
            )
            .join('')}
        </div>
        <div class="form-group">
          <label for="backup-dialog-password">${escapeHtml(t('backup.passwordLabel'))}</label>
          <input id="backup-dialog-password" type="password" placeholder="${escapeHtml(params.passwordHint)}"${
            params.createsPassword ? ' aria-describedby="backup-dialog-password-hint"' : ''}>
          ${params.createsPassword ? `<p class="dialog-option-hint" id="backup-dialog-password-hint">${escapeHtml(exportPasswordHint())}</p>` : ''}
        </div>
        <div style="display: flex; gap: 8px; justify-content: flex-end;">
          <button type="button" class="btn btn-secondary" data-action="cancel" data-modal-close>${escapeHtml(t('common.cancel'))}</button>
          <button type="button" class="btn btn-primary" data-action="confirm">${escapeHtml(params.actionLabel)}</button>
        </div>
      </div>
    `,
      initialFocus: '#backup-dialog-password',
      onClose: () => resolve(result),
    });

    const passwordInput = shell.card.querySelector('#backup-dialog-password') as HTMLInputElement;

    const confirm = () => {
      const switches = Array.from(shell.card.querySelectorAll<HTMLInputElement>('input[data-scope]'));
      const selected = switches.filter((input) => input.checked).map((input) => input.getAttribute('data-scope') as BackupScope);
      if (selected.length === 0) {
        reportError(t('backup.pickAtLeastOne'), { field: switches[0], focus: true });
        return;
      }
      if (params.createsPassword) {
        if (!acceptExportPassword(passwordInput)) return;
      } else if (!passwordInput.value.trim()) {
        reportError(t('backup.passwordRequired'), { field: passwordInput, focus: true });
        return;
      }
      result = { scopes: selected, password: passwordInput.value };
      shell.close('button');
    };

    shell.card.querySelector('[data-action="confirm"]')?.addEventListener('click', confirm, { signal: shell.signal });
    passwordInput.addEventListener('input', () => passwordInput.removeAttribute('aria-invalid'), { signal: shell.signal });
    passwordInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        confirm();
      }
    }, { signal: shell.signal });
  });
}

/** A failed step of a backup is reported in the shared toast, with the cause in the log. */
function backupFailed(message: string | undefined, error?: unknown): void {
  reportError(message || t('backup.invalidFile'), { log: 'APP', error: error ?? message });
}

export async function showBackupExportDialog(trigger?: HTMLElement): Promise<void> {
  const choice = await buildScopeDialog({
    title: t('backup.exportTitle'),
    icon: 'download',
    intro: t('backup.exportIntro'),
    actionLabel: t('backup.exportAction'),
    passwordHint: t('backup.passwordPlaceholder'),
    createsPassword: true,
  });
  if (!choice) return;

  try {
    const sealed = await window.api.encryptBackup(JSON.stringify(collectBackup(choice.scopes)), choice.password);
    if (!sealed.success || !sealed.payload) {
      backupFailed(sealed.error);
      return;
    }
    const payload = sealed.payload;
    const save = () => window.api.saveBackupFile(payload, `monky-backup.${BACKUP_FILE_EXTENSION}`);
    const result = trigger ? await withButtonLoading(trigger, save) : await save();
    if (!result) return;
    if (result.success) {
      await showAlert({ title: t('backup.exportTitle'), message: t('backup.exportSuccess'), variant: 'success' });
    } else if (result.error) {
      backupFailed(result.error);
    }
  } catch (error: unknown) {
    backupFailed(errorMessage(error, t('backup.invalidFile')), error);
  }
}

export async function showBackupImportDialog(trigger?: HTMLElement): Promise<BackupScope[] | null> {
  try {
    const open = () => window.api.openBackupFile();
    const file = trigger ? await withButtonLoading(trigger, open) : await open();
    if (!file) return null;
    if (!file.success) {
      if (file.error) backupFailed(file.error);
      return null;
    }

    const choice = await buildScopeDialog({
      title: t('backup.importTitle'),
      icon: 'upload',
      intro: t('backup.importIntro'),
      actionLabel: t('backup.importAction'),
      passwordHint: t('backup.passwordUnlockPlaceholder'),
      createsPassword: false,
    });
    if (!choice) return null;

    const opened = await window.api.decryptBackup(file.contents || '', choice.password);
    if (!opened.success || !opened.contents) {
      backupFailed(opened.error);
      return null;
    }

    let backup;
    try {
      backup = parseBackup(opened.contents);
    } catch (error: unknown) {
      backupFailed(t('backup.invalidFile'), error);
      return null;
    }

    // Importing replaces what is already stored, so it is worth one confirmation.
    const confirmed = await showConfirm({
      title: t('backup.importTitle'),
      message: t('backup.importConfirm'),
      confirmLabel: t('backup.importAction'),
      variant: 'warning',
    });
    if (!confirmed) return null;

    // Only what the file actually carries is applied, so a switch left on for a
    // scope the backup does not have is simply a no-op.
    const applied = applyBackup(backup, choice.scopes);
    if (applied.length === 0) {
      await showAlert({ title: t('backup.importTitle'), message: t('backup.nothingToImport'), variant: 'warning' });
      return null;
    }
    if (applied.includes('settings') && (backup.settings?.nickname || backup.settings?.avatar)) {
      // Restoring is an explicit choice, so the restored profile wins on the other devices too.
      void recordProfileChange({ nickname: !!backup.settings.nickname, avatar: !!backup.settings.avatar });
    }

    await showAlert({ title: t('backup.importTitle'), message: t('backup.importSuccess'), variant: 'success' });
    return applied;
  } catch (error: unknown) {
    backupFailed(errorMessage(error, t('backup.invalidFile')), error);
    return null;
  }
}
