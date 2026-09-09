import { t } from '../i18n';
import { escapeHtml } from '../utils/html';
import { showCopyToast } from './CopyToast';
import { showAlert } from './Dialog';

export function renderVersionCopyButton(id: string, version = ''): string {
  const label = version ? t('versionCopy.copy', { version }) : t('versionCopy.loading');
  return `<button type="button" id="${escapeHtml(id)}" class="version-copy" ${version ? '' : 'disabled'}
    title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${escapeHtml(version || '…')}</button>`;
}

export function setVersionCopyButton(button: HTMLButtonElement, version: string): void {
  button.textContent = version;
  button.disabled = !version;
  button.title = t('versionCopy.copy', { version });
  button.setAttribute('aria-label', button.title);
}

export function bindVersionCopyButton(button: HTMLButtonElement): () => void {
  let requestId = 0;
  let clearToast: (() => void) | null = null;
  const onCopy = async (): Promise<void> => {
    const version = button.textContent;
    if (button.disabled || !version) return;
    const current = ++requestId;
    clearToast?.();
    try {
      await navigator.clipboard.writeText(version);
    } catch (error) {
      console.warn('[VersionCopyButton] Could not copy version', error);
      if (current === requestId && button.isConnected) {
        void showAlert({ message: t('versionCopy.failed'), variant: 'danger' });
      }
      return;
    }
    if (current === requestId && button.isConnected) {
      clearToast = showCopyToast(t('versionCopy.copied'));
    }
  };
  button.addEventListener('click', onCopy);
  return () => {
    requestId++;
    button.removeEventListener('click', onCopy);
    clearToast?.();
    clearToast = null;
  };
}
