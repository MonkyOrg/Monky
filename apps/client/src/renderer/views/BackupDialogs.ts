import { t } from '../i18n';
import { enterModal, exitModal, handlesModalKey } from '../utils/modalSurface';
import { applyBackup, BACKUP_FILE_EXTENSION, BackupScope, collectBackup, parseBackup } from '../utils/backup';
import { withButtonLoading } from '../utils/buttonLoading';
import { showAlert, showConfirm } from './Dialog';

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
}): Promise<ScopeDialogResult | null> {
  return new Promise((resolve) => {
    const scopes: BackupScope[] = ['servers', 'settings'];
    const scopeLabel = (scope: BackupScope) =>
      scope === 'servers' ? t('backup.scopeServers') : t('backup.scopeSettings');

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.style.zIndex = '10003';
    backdrop.innerHTML = `
      <div class="modal-card dialog-card" role="dialog" aria-modal="true" style="max-width: 460px; width: min(92vw, 460px);">
        <div class="modal-header">
          <div class="modal-title" style="display: flex; align-items: center; gap: 8px;">
            <span class="material-symbols-outlined" style="color: var(--accent-primary);">${params.icon}</span>
            <span>${params.title}</span>
          </div>
          <button class="modal-close-btn" data-action="cancel">&times;</button>
        </div>
        <div id="backup-dialog-error" class="error-banner"></div>
        <div style="font-size: 12px; color: var(--text-secondary); line-height: 1.45; margin-bottom: 12px;">
          ${params.intro}
        </div>
        <div style="display: grid; gap: 10px; margin-bottom: 16px;">
          ${scopes
            .map(
              (scope) => `
            <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
              <label style="font-size: 13px; cursor: pointer;" for="backup-scope-${scope}">${scopeLabel(scope)}</label>
              <label class="toggle-switch" aria-label="${scopeLabel(scope)}">
                <input id="backup-scope-${scope}" type="checkbox" data-scope="${scope}" checked>
                <span class="toggle-slider"></span>
              </label>
            </div>`
            )
            .join('')}
        </div>
        <div class="form-group">
          <label for="backup-dialog-password">${t('backup.passwordLabel')}</label>
          <input id="backup-dialog-password" type="password" placeholder="${params.passwordHint}">
        </div>
        <div style="display: flex; gap: 8px; justify-content: flex-end;">
          <button type="button" class="btn btn-secondary" data-action="cancel">${t('common.cancel')}</button>
          <button type="button" class="btn btn-primary" data-action="confirm">${params.actionLabel}</button>
        </div>
      </div>
    `;

    const cleanup = () => {
      document.removeEventListener('keydown', onKeyDown, true);
      exitModal(backdrop);
    };

    const settle = (result: ScopeDialogResult | null) => {
      cleanup();
      resolve(result);
    };

    const errorBanner = backdrop.querySelector('#backup-dialog-error') as HTMLElement;
    const passwordInput = backdrop.querySelector('#backup-dialog-password') as HTMLInputElement;

    const showError = (message: string) => {
      errorBanner.textContent = message;
      errorBanner.classList.add('show');
    };

    const confirm = () => {
      const selected = Array.from(backdrop.querySelectorAll<HTMLInputElement>('input[data-scope]'))
        .filter((input) => input.checked)
        .map((input) => input.getAttribute('data-scope') as BackupScope);
      if (selected.length === 0) {
        showError(t('backup.pickAtLeastOne'));
        return;
      }
      if (!passwordInput.value.trim()) {
        showError(t('backup.passwordRequired'));
        return;
      }
      settle({ scopes: selected, password: passwordInput.value });
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (!handlesModalKey(backdrop, event)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        settle(null);
      }
    };

    backdrop.querySelectorAll('[data-action="cancel"]').forEach((element) => {
      element.addEventListener('click', () => settle(null));
    });
    backdrop.querySelector('[data-action="confirm"]')?.addEventListener('click', confirm);
    passwordInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        confirm();
      }
    });

    backdrop.addEventListener('mousedown', (event) => {
      if (event.target === backdrop) settle(null);
    });
    document.addEventListener('keydown', onKeyDown, true);
    document.body.appendChild(backdrop);
    enterModal(backdrop);
    passwordInput.focus();
  });
}

export async function showBackupExportDialog(trigger?: HTMLElement): Promise<void> {
  const choice = await buildScopeDialog({
    title: t('backup.exportTitle'),
    icon: 'download',
    intro: t('backup.exportIntro'),
    actionLabel: t('backup.exportAction'),
    passwordHint: t('backup.passwordPlaceholder'),
  });
  if (!choice) return;

  const sealed = await window.api.encryptBackup(JSON.stringify(collectBackup(choice.scopes)), choice.password);
  if (!sealed.success || !sealed.payload) {
    await showAlert({
      title: t('common.error'),
      message: sealed.error || t('backup.invalidFile'),
      variant: 'danger',
    });
    return;
  }

  const save = () => window.api.saveBackupFile(sealed.payload!, `monky-backup.${BACKUP_FILE_EXTENSION}`);
  const result = trigger ? await withButtonLoading(trigger, save) : await save();
  if (!result) return;
  if (result.success) {
    await showAlert({ title: t('backup.exportTitle'), message: t('backup.exportSuccess'), variant: 'success' });
  } else if (result.error) {
    await showAlert({ title: t('common.error'), message: result.error, variant: 'danger' });
  }
}

export async function showBackupImportDialog(trigger?: HTMLElement): Promise<BackupScope[] | null> {
  const open = () => window.api.openBackupFile();
  const file = trigger ? await withButtonLoading(trigger, open) : await open();
  if (!file) return null;
  if (!file.success) {
    if (file.error) await showAlert({ title: t('common.error'), message: file.error, variant: 'danger' });
    return null;
  }

  const choice = await buildScopeDialog({
    title: t('backup.importTitle'),
    icon: 'upload',
    intro: t('backup.importIntro'),
    actionLabel: t('backup.importAction'),
    passwordHint: t('backup.passwordUnlockPlaceholder'),
  });
  if (!choice) return null;

  const opened = await window.api.decryptBackup(file.contents || '', choice.password);
  if (!opened.success || !opened.contents) {
    await showAlert({
      title: t('common.error'),
      message: opened.error || t('backup.invalidFile'),
      variant: 'danger',
    });
    return null;
  }

  let backup;
  try {
    backup = parseBackup(opened.contents);
  } catch {
    await showAlert({ title: t('common.error'), message: t('backup.invalidFile'), variant: 'danger' });
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

  await showAlert({ title: t('backup.importTitle'), message: t('backup.importSuccess'), variant: 'success' });
  return applied;
}
