import { escapeHtml } from '../utils/html';
import { animateEnter, cancelSurfaceMotion, removeWithMotion } from '../utils/surfaceMotion';

let clearActiveToast: (() => void) | null = null;

/** Transient feedback shares one slot; never stack toasts. */
function showToast(
  message: string,
  icon: 'check_circle' | 'info' | 'error',
  durationMs: number,
  variant: 'default' | 'danger' = 'default',
): () => void {
  clearActiveToast?.();
  for (const closing of document.querySelectorAll<HTMLElement>('.chat-copy-toast[data-ui-closing]')) {
    cancelSurfaceMotion(closing);
    closing.remove();
  }
  const toast = document.createElement('div');
  toast.className = `chat-copy-toast${variant === 'danger' ? ' chat-copy-toast--danger' : ''}`;
  toast.setAttribute('role', variant === 'danger' ? 'alert' : 'status');
  toast.setAttribute('aria-atomic', 'true');
  toast.innerHTML = `
    <span class="material-symbols-outlined md-18" aria-hidden="true">${icon}</span>
    <span class="chat-copy-toast-label">${escapeHtml(message)}</span>
  `;
  document.body.appendChild(toast);
  animateEnter(toast, 'notice');
  let closed = false;
  const clear = (): void => {
    if (closed) return;
    closed = true;
    window.clearTimeout(timeout);
    removeWithMotion(toast, 'notice');
    if (clearActiveToast === clear) clearActiveToast = null;
  };
  const timeout = window.setTimeout(clear, durationMs);
  clearActiveToast = clear;
  return clear;
}

export function showCopyToast(message: string): () => void {
  return showToast(message, 'check_circle', 1600);
}

export function showInfoToast(message: string, durationMs = 3200): () => void {
  return showToast(message, 'info', durationMs);
}

export function showErrorToast(message: string, durationMs = 5000): () => void {
  return showToast(message, 'error', durationMs, 'danger');
}
