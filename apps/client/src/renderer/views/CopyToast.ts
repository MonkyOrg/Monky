import { escapeHtml } from '../utils/html';

let clearActiveToast: (() => void) | null = null;

/** The same confirmation for message and version copies; never stack toasts. */
export function showCopyToast(message: string): () => void {
  clearActiveToast?.();
  const toast = document.createElement('div');
  toast.className = 'chat-copy-toast';
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-atomic', 'true');
  toast.innerHTML = `
    <span class="material-symbols-outlined md-18" aria-hidden="true">check_circle</span>
    <span class="chat-copy-toast-label">${escapeHtml(message)}</span>
  `;
  document.body.appendChild(toast);
  const clear = (): void => {
    window.clearTimeout(timeout);
    toast.remove();
    if (clearActiveToast === clear) clearActiveToast = null;
  };
  const timeout = window.setTimeout(clear, 1600);
  clearActiveToast = clear;
  return clear;
}
