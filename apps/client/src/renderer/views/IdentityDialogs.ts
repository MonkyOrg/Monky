import jsQR from 'jsqr';
import QRCode from 'qrcode';
import type { DmExportMode } from '@monky/shared';
import { escapeHtml } from '../utils/html';
import { t } from '../i18n';
import { enterModal, exitModal, handlesModalKey } from '../utils/modalSurface';
import { applyBackup, BACKUP_FILE_EXTENSION, BackupScope, collectBackup, parseBackup, scopesInBackup } from '../utils/backup';
import { withButtonLoading } from '../utils/buttonLoading';

export interface IdentityInfo {
  publicKey: string;
  clientId: string;
  /** Scopes restored from the backup that travelled with the identity (#472). */
  restoredScopes?: BackupScope[];
  /** The identity came in but its attached backup could not be read. */
  extrasFailed?: boolean;
}

export async function showIdentityExportDialog(currentClientId: string): Promise<void> {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.style.zIndex = '10002';
  backdrop.innerHTML = `
    <div class="modal-card dialog-card" role="dialog" aria-modal="true" style="max-width: 520px; width: min(92vw, 520px);">
      <div class="modal-header">
        <div class="modal-title" style="display: flex; align-items: center; gap: 8px;">
          <span class="material-symbols-outlined" style="color: var(--accent-primary);">qr_code_2</span>
          <span>${t('identity.exportTitle')}</span>
        </div>
        <button class="modal-close-btn" data-action="cancel">&times;</button>
      </div>
      <div id="identity-export-error" class="error-banner"></div>
      <div style="font-size: 12px; color: var(--text-secondary); line-height: 1.45; margin-bottom: 12px;">
        ${t('identity.exportIntro')}
      </div>
      <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 10px;">
        ${t('identity.clientIdLabel')} <span style="font-family: var(--font-mono); color: var(--text-primary);">${escapeHtml(currentClientId)}</span>
      </div>
      <div class="form-group">
        <label for="identity-export-password">${t('identity.passwordLabel')}</label>
        <input id="identity-export-password" type="password" placeholder="${t('identity.passwordPlaceholder')}">
      </div>
      <div style="display: grid; gap: 10px; margin-bottom: 14px;">
        <div style="font-size: 11px; color: var(--text-muted);">${t('backup.includeLabel')}</div>
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
          <label style="font-size: 13px; cursor: pointer;" for="identity-export-include-servers">${t('backup.scopeServers')}</label>
          <label class="toggle-switch" aria-label="${t('backup.scopeServers')}">
            <input type="checkbox" id="identity-export-include-servers">
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
          <label style="font-size: 13px; cursor: pointer;" for="identity-export-include-settings">${t('backup.scopeSettings')}</label>
          <label class="toggle-switch" aria-label="${t('backup.scopeSettings')}">
            <input type="checkbox" id="identity-export-include-settings">
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
          <label style="font-size: 13px; cursor: pointer;" for="identity-export-include-friends">${t('backup.scopeFriends')}</label>
          <label class="toggle-switch" aria-label="${t('backup.scopeFriends')}">
            <input type="checkbox" id="identity-export-include-friends" checked>
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div id="identity-export-history-row" style="display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-left: 16px;">
          <div style="display: grid; gap: 2px;">
            <label style="font-size: 13px; cursor: pointer;" for="identity-export-include-history">${t('backup.scopeDmHistory')}</label>
            <span style="font-size: 11px; color: var(--text-muted);">${t('backup.scopeDmHistoryHint')}</span>
          </div>
          <label class="toggle-switch" aria-label="${t('backup.scopeDmHistory')}">
            <input type="checkbox" id="identity-export-include-history">
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>
      <div style="display: flex; gap: 8px; margin-bottom: 14px;">
        <button type="button" id="btn-run-export-identity" class="btn btn-primary" style="flex: 1;">${t('identity.exportAction')}</button>
        <button type="button" id="btn-copy-export-identity" class="btn btn-secondary" style="display: none;">${t('identity.copyCode')}</button>
        <button type="button" id="btn-file-export-identity" class="btn btn-secondary" style="display: none;">${t('backup.saveToFile')}</button>
      </div>
      <div id="identity-export-result" style="display: none;">
        <div id="identity-export-qr-wrap" style="display: flex; justify-content: center; margin-bottom: 12px;">
          <img id="identity-export-qr" alt="${t('identity.qrAlt')}" style="width: 220px; height: 220px; border-radius: 12px; background: white; padding: 8px;">
        </div>
        <div id="identity-export-qr-warning" style="display: none; font-size: 11px; color: var(--text-muted); margin-bottom: 10px;">
          ${t('backup.qrTooLarge')}
        </div>
        <div class="form-group" style="margin-bottom: 0;">
          <label for="identity-export-code">${t('identity.codeLabel')}</label>
          <textarea id="identity-export-code" readonly style="min-height: 120px; resize: vertical; font-size: 11px; font-family: var(--font-mono);"></textarea>
        </div>
      </div>
    </div>
  `;

  const cleanup = () => {
    document.removeEventListener('keydown', onKeyDown, true);
    exitModal(backdrop);
  };

  const close = () => cleanup();
  const onKeyDown = (event: KeyboardEvent) => {
    if (!handlesModalKey(backdrop, event)) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  };

  const errorBanner = backdrop.querySelector('#identity-export-error') as HTMLElement;
  const passwordInput = backdrop.querySelector('#identity-export-password') as HTMLInputElement;
  const exportButton = backdrop.querySelector('#btn-run-export-identity') as HTMLButtonElement;
  const copyButton = backdrop.querySelector('#btn-copy-export-identity') as HTMLButtonElement;
  const fileButton = backdrop.querySelector('#btn-file-export-identity') as HTMLButtonElement;
  const includeServers = backdrop.querySelector('#identity-export-include-servers') as HTMLInputElement;
  const includeSettings = backdrop.querySelector('#identity-export-include-settings') as HTMLInputElement;
  const includeFriends = backdrop.querySelector('#identity-export-include-friends') as HTMLInputElement;
  const includeHistory = backdrop.querySelector('#identity-export-include-history') as HTMLInputElement;
  const historyRow = backdrop.querySelector('#identity-export-history-row') as HTMLElement;
  // History travels with the friends list; without friends it has no owner.
  const syncHistoryRow = () => {
    includeHistory.disabled = !includeFriends.checked;
    historyRow.style.opacity = includeFriends.checked ? '1' : '0.5';
  };
  includeFriends.addEventListener('change', syncHistoryRow);
  syncHistoryRow();
  const resultWrapper = backdrop.querySelector('#identity-export-result') as HTMLElement;
  const qrImage = backdrop.querySelector('#identity-export-qr') as HTMLImageElement;
  const qrWrap = backdrop.querySelector('#identity-export-qr-wrap') as HTMLElement;
  const qrWarning = backdrop.querySelector('#identity-export-qr-warning') as HTMLElement;
  const codeTextarea = backdrop.querySelector('#identity-export-code') as HTMLTextAreaElement;

  const showError = (message: string) => {
    errorBanner.textContent = message;
    errorBanner.classList.add('show');
  };

  const clearError = () => {
    errorBanner.textContent = '';
    errorBanner.classList.remove('show');
  };

  exportButton.addEventListener('click', async () => {
    clearError();
    exportButton.disabled = true;
    exportButton.textContent = t('identity.exporting');

    try {
      const scopes: BackupScope[] = [];
      if (includeServers.checked) scopes.push('servers');
      if (includeSettings.checked) scopes.push('settings');
      const extras = scopes.length > 0 ? JSON.stringify(collectBackup(scopes)) : undefined;

      const dmMode: DmExportMode = !includeFriends.checked ? 'none' : includeHistory.checked ? 'history' : 'friends';
      const exported = await window.api.exportIdentity(passwordInput.value, extras, dmMode);
      codeTextarea.value = exported;
      resultWrapper.style.display = 'block';
      copyButton.style.display = 'inline-flex';
      fileButton.style.display = 'inline-flex';

      // A QR code tops out at a couple of kilobytes, and servers plus settings
      // blow past that easily. When it does not fit we drop the QR instead of
      // failing the whole export: the text code and the file still work.
      try {
        qrImage.src = await QRCode.toDataURL(exported, { margin: 1, width: 220 });
        qrWrap.style.display = 'flex';
        qrWarning.style.display = 'none';
      } catch {
        qrImage.removeAttribute('src');
        qrWrap.style.display = 'none';
        qrWarning.style.display = 'block';
      }
    } catch (error: any) {
      showError(error?.message || t('identity.exportError'));
    } finally {
      exportButton.disabled = false;
      exportButton.textContent = t('identity.exportAction');
    }
  });

  copyButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(codeTextarea.value);
      copyButton.textContent = t('identity.copied');
      setTimeout(() => {
        copyButton.textContent = t('identity.copyCode');
      }, 1500);
    } catch {
      codeTextarea.focus();
      codeTextarea.select();
    }
  });

  fileButton.addEventListener('click', async () => {
    const result = await withButtonLoading(fileButton, () =>
      window.api.saveBackupFile(codeTextarea.value, `monky-identidade.${BACKUP_FILE_EXTENSION}`));
    if (!result) return;
    if (!result.success && result.error) showError(result.error);
  });

  backdrop.querySelectorAll('[data-action="cancel"]').forEach((element) => {
    element.addEventListener('click', close);
  });
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) close();
  });
  document.addEventListener('keydown', onKeyDown, true);
  document.body.appendChild(backdrop);
  enterModal(backdrop);
  passwordInput.focus();
}

export async function showIdentityImportDialog(): Promise<IdentityInfo | null> {
  return await new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.style.zIndex = '10002';
    backdrop.innerHTML = `
      <div class="modal-card dialog-card" role="dialog" aria-modal="true" style="max-width: 560px; width: min(94vw, 560px);">
        <div class="modal-header">
          <div class="modal-title" style="display: flex; align-items: center; gap: 8px;">
            <span class="material-symbols-outlined" style="color: var(--accent-primary);">manage_accounts</span>
            <span>${t('identity.importTitle')}</span>
          </div>
          <button class="modal-close-btn" data-action="cancel">&times;</button>
        </div>
        <div id="identity-import-error" class="error-banner"></div>
        <div style="font-size: 12px; color: var(--text-secondary); line-height: 1.45; margin-bottom: 12px;">
          ${t('identity.importIntro')}
        </div>
        <div class="form-group">
          <label for="identity-import-code">${t('identity.codeLabel')}</label>
          <textarea id="identity-import-code" placeholder="MONKY-ID:..." style="min-height: 110px; resize: vertical; font-size: 11px; font-family: var(--font-mono);"></textarea>
        </div>
        <div class="form-group">
          <label for="identity-import-password">${t('identity.passwordLabel')}</label>
          <input id="identity-import-password" type="password" placeholder="${t('identity.passwordPlaceholder')}">
        </div>
        <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px;">
          <button type="button" id="btn-import-identity-run" class="btn btn-primary">${t('identity.importAction')}</button>
          <button type="button" id="btn-import-identity-scan" class="btn btn-secondary">${t('identity.scanQr')}</button>
          <button type="button" id="btn-import-identity-file" class="btn btn-secondary">${t('backup.loadFromFile')}</button>
        </div>
        <div id="identity-import-scan-wrap" style="display: none; border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 10px; background: var(--bg-card);">
          <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 8px;">${t('identity.scanHint')}</div>
          <video id="identity-import-video" autoplay playsinline muted style="width: 100%; max-height: 260px; border-radius: 10px; background: #000;"></video>
        </div>
      </div>
    `;

    let stream: MediaStream | null = null;
    let scanFrame: number | null = null;
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });

    const errorBanner = backdrop.querySelector('#identity-import-error') as HTMLElement;
    const codeInput = backdrop.querySelector('#identity-import-code') as HTMLTextAreaElement;
    const passwordInput = backdrop.querySelector('#identity-import-password') as HTMLInputElement;
    const importButton = backdrop.querySelector('#btn-import-identity-run') as HTMLButtonElement;
    const scanButton = backdrop.querySelector('#btn-import-identity-scan') as HTMLButtonElement;
    const fileButton = backdrop.querySelector('#btn-import-identity-file') as HTMLButtonElement;
    const scanWrap = backdrop.querySelector('#identity-import-scan-wrap') as HTMLElement;
    const video = backdrop.querySelector('#identity-import-video') as HTMLVideoElement;

    const showError = (message: string) => {
      errorBanner.textContent = message;
      errorBanner.classList.add('show');
    };

    const clearError = () => {
      errorBanner.textContent = '';
      errorBanner.classList.remove('show');
    };

    const stopScan = () => {
      if (scanFrame !== null) {
        cancelAnimationFrame(scanFrame);
        scanFrame = null;
      }
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
        stream = null;
      }
      video.srcObject = null;
      scanWrap.style.display = 'none';
      scanButton.textContent = t('identity.scanQr');
    };

    const cleanup = () => {
      stopScan();
      document.removeEventListener('keydown', onKeyDown, true);
      exitModal(backdrop);
    };

    const settle = (identity: IdentityInfo | null) => {
      cleanup();
      resolve(identity);
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
      if (result?.data?.startsWith('MONKY-ID:')) {
        codeInput.value = result.data;
        stopScan();
        clearError();
      } else {
        scanFrame = requestAnimationFrame(scanLoop);
      }
    };

    const startScan = async () => {
      clearError();
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        });
        video.srcObject = stream;
        scanWrap.style.display = 'block';
        scanButton.textContent = t('identity.stopScan');
        scanFrame = requestAnimationFrame(scanLoop);
      } catch (error: any) {
        showError(error?.message || t('identity.cameraError'));
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (!handlesModalKey(backdrop, event)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        settle(null);
      }
    };

    importButton.addEventListener('click', async () => {
      clearError();
      importButton.disabled = true;
      importButton.textContent = t('identity.importing');
      try {
        const identity = await window.api.importIdentity(codeInput.value, passwordInput.value);
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
        settle({ ...identity, restoredScopes, extrasFailed });
      } catch (error: any) {
        showError(error?.message || t('identity.importError'));
      } finally {
        importButton.disabled = false;
        importButton.textContent = t('identity.importAction');
      }
    });

    scanButton.addEventListener('click', async () => {
      if (stream) {
        stopScan();
        return;
      }
      await startScan();
    });

    fileButton.addEventListener('click', async () => {
      clearError();
      const result = await withButtonLoading(fileButton, () => window.api.openBackupFile());
      if (!result) return;
      if (!result.success) {
        if (result.error) showError(result.error);
        return;
      }
      codeInput.value = (result.contents || '').trim();
      passwordInput.focus();
    });

    backdrop.querySelectorAll('[data-action="cancel"]').forEach((element) => {
      element.addEventListener('click', () => settle(null));
    });
    backdrop.addEventListener('mousedown', (event) => {
      if (event.target === backdrop) settle(null);
    });
    document.addEventListener('keydown', onKeyDown, true);
    document.body.appendChild(backdrop);
    enterModal(backdrop);
    codeInput.focus();
  });
}
