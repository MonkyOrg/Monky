import { escapeHtml } from '../utils/html';

let clearActiveToast: (() => void) | null = null;

/** Transient feedback shares one slot; never stack toasts. */
function showToast(message: string, icon: 'check_circle' | 'info', durationMs: number): () => void {
  clearActiveToast?.();
  const toast = document.createElement('div');
  toast.className = 'chat-copy-toast';
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-atomic', 'true');
  toast.innerHTML = `
    <span class="material-symbols-outlined md-18" aria-hidden="true">${icon}</span>
    <span class="chat-copy-toast-label">${escapeHtml(message)}</span>
  `;
  document.body.appendChild(toast);
  const clear = (): void => {
    window.clearTimeout(timeout);
    toast.remove();
    if (clearActiveToast === clear) clearActiveToast = null;
  };
  const timeout = window.setTimeout(clear, durationMs);
  clearActiveToast = clear;
  return clear;
}

export function showCopyToast(message: string): () => void {
  return showToast(message, 'check_circle', 1600);
}

export function showInfoToast(message: string): () => void {
  return showToast(message, 'info', 3200);
}
