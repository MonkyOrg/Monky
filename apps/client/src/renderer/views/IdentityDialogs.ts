import jsQR from 'jsqr';
import QRCode from 'qrcode';
import { IDENTITY_EXPORT_PREFIX, isSecretEnvelope, type AppIdentityImportResult, type DmExportMode } from '@monky/shared';
import { escapeHtml } from '../utils/html';
import { t } from '../i18n';
import { openModal } from '../utils/modalShell';
import { setSurfaceVisible } from '../utils/surfaceVisibility';
import { showWithMotion } from '../utils/surfaceMotion';
import { copyText, errorMessage, reportError } from '../utils/feedback';
import { applyBackup, BACKUP_FILE_EXTENSION, BackupScope, collectBackup, parseBackup, scopesInBackup } from '../utils/backup';
import { isButtonLoading, setButtonLoading, withButtonLoading } from '../utils/buttonLoading';
import { showConfirm } from './Dialog';
import { acceptExportPassword, exportPasswordHint } from './exportPassword';

export interface IdentityInfo {
  publicKey: string;
  clientId: string;
  /** Scopes restored from the backup that travelled with the identity (#472). */
  restoredScopes?: BackupScope[];
  /** The identity came in but its attached backup could not be read. */
  extrasFailed?: boolean;
}

/** One "include in the code" switch; its label names the switch. */
function includeRow(id: string, label: string, options: { checked?: boolean; hint?: string } = {}): string {
  const control = `<label class="toggle-switch">
      <input type="checkbox" role="switch" id="${id}"${options.hint ? ` aria-describedby="${id}-hint"` : ''}${options.checked ? ' checked' : ''}>
      <span class="toggle-slider"></span>
    </label>`;
  const name = `<label style="font-size: 13px; cursor: pointer;" for="${id}">${escapeHtml(label)}</label>`;
  return options.hint
    ? `<div id="${id}-row" style="display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-left: 16px;">
        <div style="display: grid; gap: 2px;">${name}<span id="${id}-hint" style="font-size: 11px; color: var(--text-muted);">${escapeHtml(options.hint)}</span></div>
        ${control}
      </div>`
    : `<div style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">${name}${control}</div>`;
}

export async function showIdentityExportDialog(currentClientId: string): Promise<void> {
  const shell = openModal({
    card: `
    <div class="modal-card dialog-card" style="max-width: 520px; width: min(92vw, 520px);">
      <div class="modal-header">
        <div class="modal-title" style="display: flex; align-items: center; gap: 8px;">
          <span class="material-symbols-outlined" style="color: var(--accent-primary);" aria-hidden="true">qr_code_2</span>
          <span>${escapeHtml(t('identity.exportTitle'))}</span>
        </div>
        <button type="button" class="modal-close-btn" data-action="cancel" data-modal-close aria-label="${escapeHtml(t('common.close'))}">&times;</button>
      </div>
      <div style="font-size: 12px; color: var(--text-secondary); line-height: 1.45; margin-bottom: 12px;">
        ${escapeHtml(t('identity.exportIntro'))}
      </div>
      <p class="dialog-option-hint" id="identity-export-compatibility" style="margin: 0 0 12px;">${escapeHtml(t('identity.exportCompatibility'))}</p>
      <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 10px;">
        ${escapeHtml(t('identity.clientIdLabel'))} <span style="font-family: var(--font-mono); color: var(--text-primary);">${escapeHtml(currentClientId)}</span>
      </div>
      <div class="form-group">
        <label for="identity-export-password">${escapeHtml(t('identity.passwordLabel'))}</label>
        <input id="identity-export-password" type="password" placeholder="${escapeHtml(t('identity.passwordPlaceholder'))}" aria-describedby="identity-export-password-hint">
        <p class="dialog-option-hint" id="identity-export-password-hint">${escapeHtml(exportPasswordHint())}</p>
      </div>
      <div style="display: grid; gap: 10px; margin-bottom: 14px;">
        <div style="font-size: 11px; color: var(--text-muted);">${escapeHtml(t('backup.includeLabel'))}</div>
        ${includeRow('identity-export-include-servers', t('backup.scopeServers'))}
        ${includeRow('identity-export-include-settings', t('backup.scopeSettings'))}
        ${includeRow('identity-export-include-friends', t('backup.scopeFriends'), { checked: true })}
        ${includeRow('identity-export-include-history', t('backup.scopeDmHistory'), { hint: t('backup.scopeDmHistoryHint') })}
      </div>
      <div style="display: flex; gap: 8px; margin-bottom: 14px;">
        <button type="button" id="btn-run-export-identity" class="btn btn-primary" style="flex: 1;">${escapeHtml(t('identity.exportAction'))}</button>
        <button type="button" id="btn-copy-export-identity" class="btn btn-secondary" hidden>${escapeHtml(t('identity.copyCode'))}</button>
        <button type="button" id="btn-file-export-identity" class="btn btn-secondary" hidden>${escapeHtml(t('backup.saveToFile'))}</button>
      </div>
      <div id="identity-export-result" hidden>
        <div id="identity-export-qr-wrap" style="display: flex; justify-content: center; margin-bottom: 12px;">
          <img id="identity-export-qr" alt="${escapeHtml(t('identity.qrAlt'))}" style="width: 220px; height: 220px; border-radius: 12px; background: white; padding: 8px;">
        </div>
        <div id="identity-export-qr-warning" hidden style="font-size: 11px; color: var(--text-muted); margin-bottom: 10px;">
          ${escapeHtml(t('backup.qrTooLarge'))}
        </div>
        <div class="form-group" style="margin-bottom: 0;">
          <label for="identity-export-code">${escapeHtml(t('identity.codeLabel'))}</label>
          <textarea id="identity-export-code" readonly style="min-height: 120px; resize: vertical; font-size: 11px; font-family: var(--font-mono);"></textarea>
        </div>
      </div>
    </div>
  `,
    initialFocus: '#identity-export-password',
  });
  const card = shell.card;
  const options = { signal: shell.signal };

  const passwordInput = card.querySelector('#identity-export-password') as HTMLInputElement;
  const exportButton = card.querySelector('#btn-run-export-identity') as HTMLButtonElement;
  const copyButton = card.querySelector('#btn-copy-export-identity') as HTMLButtonElement;
  const fileButton = card.querySelector('#btn-file-export-identity') as HTMLButtonElement;
  const includeServers = card.querySelector('#identity-export-include-servers') as HTMLInputElement;
  const includeSettings = card.querySelector('#identity-export-include-settings') as HTMLInputElement;
  const includeFriends = card.querySelector('#identity-export-include-friends') as HTMLInputElement;
  const includeHistory = card.querySelector('#identity-export-include-history') as HTMLInputElement;
  const historyRow = card.querySelector('#identity-export-include-history-row') as HTMLElement;
  // History travels with the friends list; without friends it has no owner.
  const syncHistoryRow = () => {
    includeHistory.disabled = !includeFriends.checked;
    historyRow.style.opacity = includeFriends.checked ? '1' : '0.5';
  };
  includeFriends.addEventListener('change', syncHistoryRow, options);
  syncHistoryRow();
  const resultWrapper = card.querySelector('#identity-export-result') as HTMLElement;
  const qrImage = card.querySelector('#identity-export-qr') as HTMLImageElement;
  const qrWrap = card.querySelector('#identity-export-qr-wrap') as HTMLElement;
  const qrWarning = card.querySelector('#identity-export-qr-warning') as HTMLElement;
  const codeTextarea = card.querySelector('#identity-export-code') as HTMLTextAreaElement;

  passwordInput.addEventListener('input', () => passwordInput.removeAttribute('aria-invalid'), options);
  exportButton.addEventListener('click', async () => {
    if (!acceptExportPassword(passwordInput)) return;
    exportButton.disabled = true;
    exportButton.textContent = t('identity.exporting');

    try {
      const scopes: BackupScope[] = [];
      if (includeServers.checked) scopes.push('servers');
      if (includeSettings.checked) scopes.push('settings');
      const extras = scopes.length > 0 ? JSON.stringify(collectBackup(scopes)) : undefined;

      const dmMode: DmExportMode = !includeFriends.checked ? 'none' : includeHistory.checked ? 'history' : 'friends';
      const exported = await window.api.exportIdentity(passwordInput.value, extras, dmMode);
      if (shell.closed) return;
      codeTextarea.value = exported;

      // A QR code tops out at a couple of kilobytes, and servers plus settings
      // blow past that easily. When it does not fit we drop the QR instead of
      // failing the whole export: the text code and the file still work.
      let fitsQr = true;
      try {
        qrImage.src = await QRCode.toDataURL(exported, { margin: 1, width: 220 });
      } catch {
        qrImage.removeAttribute('src');
        fitsQr = false;
      }
      if (shell.closed) return;
      qrWrap.hidden = !fitsQr;
      qrWarning.hidden = fitsQr;
      for (const button of [copyButton, fileButton]) if (button.hidden) showWithMotion(button, 'notice');
      setSurfaceVisible(resultWrapper, true);
    } catch (error: unknown) {
      if (!shell.closed) reportError(errorMessage(error, t('identity.exportError')), { log: 'IDENTITY', error });
    } finally {
      exportButton.disabled = false;
      exportButton.textContent = t('identity.exportAction');
    }
  }, options);

  copyButton.addEventListener('click', async () => {
    if (await copyText(codeTextarea.value, { copied: t('identity.copied'), failed: t('identity.copyFailed') })) return;
    // Copying by hand stays one keystroke away.
    codeTextarea.focus();
    codeTextarea.select();
  }, options);

  fileButton.addEventListener('click', async () => {
    try {
      const result = await withButtonLoading(fileButton, () =>
        window.api.saveBackupFile(codeTextarea.value, `monky-identidade.${BACKUP_FILE_EXTENSION}`));
      if (result && !result.success && result.error && !shell.closed) reportError(result.error);
    } catch (error: unknown) {
      if (!shell.closed) reportError(errorMessage(error, t('identity.exportError')), { log: 'IDENTITY', error });
    }
  }, options);
}

export async function showIdentityImportDialog(): Promise<IdentityInfo | null> {
  return await new Promise((resolve) => {
    let stream: MediaStream | null = null;
    let scanFrame: number | null = null;
    // Every start and stop gets a new generation: a camera that only answers after the scan
    // was stopped or the dialog closed is switched off at once instead of staying on unseen.
    let scanGeneration = 0;
    let imported: IdentityInfo | null = null;
    const shell = openModal({
      card: `
      <div class="modal-card dialog-card" style="max-width: 560px; width: min(94vw, 560px);">
        <div class="modal-header">
          <div class="modal-title" style="display: flex; align-items: center; gap: 8px;">
            <span class="material-symbols-outlined" style="color: var(--accent-primary);" aria-hidden="true">manage_accounts</span>
            <span>${escapeHtml(t('identity.importTitle'))}</span>
          </div>
          <button type="button" class="modal-close-btn" data-action="cancel" data-modal-close aria-label="${escapeHtml(t('common.close'))}">&times;</button>
        </div>
        <div style="font-size: 12px; color: var(--text-secondary); line-height: 1.45; margin-bottom: 12px;">
          ${escapeHtml(t('identity.importIntro'))}
        </div>
        <div class="form-group">
          <label for="identity-import-code">${escapeHtml(t('identity.codeLabel'))}</label>
          <textarea id="identity-import-code" placeholder="${escapeHtml(IDENTITY_EXPORT_PREFIX)}..." style="min-height: 110px; resize: vertical; font-size: 11px; font-family: var(--font-mono);"></textarea>
        </div>
        <div class="form-group">
          <label for="identity-import-password">${escapeHtml(t('identity.passwordLabel'))}</label>
          <input id="identity-import-password" type="password" placeholder="${escapeHtml(t('identity.passwordPlaceholder'))}">
        </div>
        <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px;">
          <button type="button" id="btn-import-identity-run" class="btn btn-primary">${escapeHtml(t('identity.importAction'))}</button>
          <button type="button" id="btn-import-identity-scan" class="btn btn-secondary">${escapeHtml(t('identity.scanQr'))}</button>
          <button type="button" id="btn-import-identity-file" class="btn btn-secondary">${escapeHtml(t('backup.loadFromFile'))}</button>
        </div>
        <div id="identity-import-scan-wrap" hidden style="border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 10px; background: var(--bg-card);">
          <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 8px;">${escapeHtml(t('identity.scanHint'))}</div>
          <video id="identity-import-video" autoplay playsinline muted style="width: 100%; max-height: 260px; border-radius: 10px; background: #000;"></video>
        </div>
      </div>
    `,
      initialFocus: '#identity-import-code',
      // The camera goes off before the dialog starts to leave.
      onClose: () => {
        stopScan();
        resolve(imported);
      },
    });
    const card = shell.card;
    const options = { signal: shell.signal };
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });

    const codeInput = card.querySelector('#identity-import-code') as HTMLTextAreaElement;
    const passwordInput = card.querySelector('#identity-import-password') as HTMLInputElement;
    const importButton = card.querySelector('#btn-import-identity-run') as HTMLButtonElement;
    const scanButton = card.querySelector('#btn-import-identity-scan') as HTMLButtonElement;
    const fileButton = card.querySelector('#btn-import-identity-file') as HTMLButtonElement;
    const scanWrap = card.querySelector('#identity-import-scan-wrap') as HTMLElement;
    const video = card.querySelector('#identity-import-video') as HTMLVideoElement;

    let dismissError: (() => void) | null = null;
    const showError = (message: string, error?: unknown) => {
      if (!shell.closed) dismissError = reportError(message, { log: 'IDENTITY', error: error ?? message });
    };
    const clearError = () => {
      dismissError?.();
      dismissError = null;
    };

    function stopScan(): void {
      scanGeneration++;
      setButtonLoading(scanButton, false);
      if (scanFrame !== null) {
        cancelAnimationFrame(scanFrame);
        scanFrame = null;
      }
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
        stream = null;
      }
      video.srcObject = null;
      setSurfaceVisible(scanWrap, false);
      scanButton.textContent = t('identity.scanQr');
    }

    const settle = (identity: IdentityInfo | null) => {
      imported = identity;
      shell.close('button');
    };

    const scanLoop = () => {
      if (!stream || !context || video.readyState < HTMLMediaElement.HAVE_ENOUGH_DATA) {
        scanFrame = requestAnimationFrame(scanLoop);
        return;
      }

      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
      const result = jsQR(imageData.data, imageData.width, imageData.height);
      // Codes from before #490 (MONKY-ID:) still import, so the scanner accepts both formats.
      if (result?.data && isSecretEnvelope(result.data, 'identity')) {
        codeInput.value = result.data;
        stopScan();
        clearError();
      } else {
        scanFrame = requestAnimationFrame(scanLoop);
      }
    };

    const startScan = async () => {
      clearError();
      const generation = ++scanGeneration;
      // The camera takes a few seconds to answer; a second click must not open another one.
      setButtonLoading(scanButton, true);
      try {
        const camera = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        });
        if (generation !== scanGeneration) {
          camera.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = camera;
        video.srcObject = camera;
        setSurfaceVisible(scanWrap, true);
        scanButton.textContent = t('identity.stopScan');
        scanFrame = requestAnimationFrame(scanLoop);
      } catch (error: unknown) {
        if (generation === scanGeneration) showError(errorMessage(error, t('identity.cameraError')), error);
      } finally {
        if (generation === scanGeneration) setButtonLoading(scanButton, false);
      }
    };

    /**
     * Imports the code. A code of another identity than the one this computer
     * uses only goes in after the user confirms switching (#490); the main
     * process keeps the current identity aside when it does.
     */
    const importCode = async (): Promise<AppIdentityImportResult | null> => {
      const code = codeInput.value;
      const password = passwordInput.value;
      const outcome = await window.api.importIdentity(code, password);
      if (outcome.status === 'imported') return outcome;
      if (shell.closed) return null;
      const confirmed = await showConfirm({
        title: t('identity.importReplaceTitle'),
        message: t('identity.importReplaceMessage'),
        confirmLabel: t('identity.importAction'),
        variant: 'danger',
        focusCancel: true,
      });
      if (!confirmed || shell.closed) return null;
      const replaced = await window.api.importIdentity(code, password, outcome.publicKey);
      if (replaced.status !== 'imported') throw new Error(t('identity.importError'));
      return replaced;
    };

    importButton.addEventListener('click', async () => {
      clearError();
      importButton.disabled = true;
      importButton.textContent = t('identity.importing');
      try {
        const identity = await importCode();
        if (!identity) return;
        let restoredScopes: BackupScope[] | undefined;
        let extrasFailed = false;
        if (identity.extras) {
          // A corrupt or foreign extras blob must not cost the user the
          // identity that was already imported successfully.
          try {
            const backup = parseBackup(identity.extras);
            restoredScopes = applyBackup(backup, scopesInBackup(backup));
          } catch {
            extrasFailed = true;
          }
        }
        settle({ publicKey: identity.publicKey, clientId: identity.clientId, restoredScopes, extrasFailed });
      } catch (error: unknown) {
        showError(errorMessage(error, t('identity.importError')), error);
      } finally {
        importButton.disabled = false;
        importButton.textContent = t('identity.importAction');
      }
    }, options);

    scanButton.addEventListener('click', async () => {
      if (stream) {
        stopScan();
        return;
      }
      if (isButtonLoading(scanButton)) return;
      await startScan();
    }, options);

    fileButton.addEventListener('click', async () => {
      clearError();
      try {
        const result = await withButtonLoading(fileButton, () => window.api.openBackupFile());
        if (!result || shell.closed) return;
        if (!result.success) {
          if (result.error) showError(result.error);
          return;
        }
        codeInput.value = (result.contents || '').trim();
        passwordInput.focus();
      } catch (error: unknown) {
        showError(errorMessage(error, t('identity.importError')), error);
      }
    }, options);
  });
}
