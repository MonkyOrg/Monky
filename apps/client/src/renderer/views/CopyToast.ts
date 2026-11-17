import { escapeHtml } from '../utils/html';
import { animateEnter, cancelSurfaceMotion, removeWithMotion } from '../utils/surfaceMotion';
import { t } from '../i18n';
import { haptic } from '../utils/haptics';

let clearActiveToast: (() => void) | null = null;

export interface ToastAction {
  label: string;
  run(): void;
}

/**
 * Transient feedback shares one slot; never stack toasts. Every toast can be closed before it expires,
 * since it may cover what the user wants to click; the rest of it still lets clicks through.
 */
function showToast(
  message: string,
  icon: 'check_circle' | 'info' | 'error',
  durationMs: number,
  variant: 'default' | 'danger' = 'default',
  notice?: { title: string; action?: ToastAction },
): () => void {
  clearActiveToast?.();
  for (const closing of document.querySelectorAll<HTMLElement>('.chat-copy-toast[data-ui-closing]')) {
    cancelSurfaceMotion(closing);
    closing.remove();
  }
  const toast = document.createElement('div');
  toast.className = `chat-copy-toast${variant === 'danger' ? ' chat-copy-toast--danger' : ''}${notice ? ' chat-copy-toast--notice' : ''}`;
  toast.setAttribute('role', variant === 'danger' ? 'alert' : 'status');
  toast.setAttribute('aria-atomic', 'true');
  const dismiss = escapeHtml(t('toast.dismiss'));
  const label = `<span class="chat-copy-toast-label">${escapeHtml(message)}</span>`;
  toast.innerHTML = `
    <span class="material-symbols-outlined md-18" aria-hidden="true">${icon}</span>
    ${notice ? `<span class="chat-copy-toast-text">
      <strong class="chat-copy-toast-title">${escapeHtml(notice.title)}</strong>${label}
    </span>${notice.action ? `<button type="button" class="chat-copy-toast-action">${escapeHtml(notice.action.label)}</button>` : ''}` : label}
    <button type="button" class="chat-copy-toast-close" aria-label="${dismiss}" title="${dismiss}">
      <span class="material-symbols-outlined md-16" aria-hidden="true">close</span>
    </button>
  `;
  // Closing from the keyboard returns focus to where it was when the toast appeared.
  const previousFocus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
    ? document.activeElement : null;
  document.body.appendChild(toast);
  animateEnter(toast, 'notice');
  if (variant === 'danger') haptic('error');
  let closed = false;
  const clear = (): void => {
    if (closed) return;
    closed = true;
    window.clearTimeout(timeout);
    if (toast.contains(document.activeElement) && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    removeWithMotion(toast, 'notice');
    if (clearActiveToast === clear) clearActiveToast = null;
  };
  toast.querySelector('.chat-copy-toast-close')?.addEventListener('click', clear);
  toast.querySelector('.chat-copy-toast-action')?.addEventListener('click', () => {
    clear();
    notice?.action?.run();
  });
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

export function showSuccessToast(message: string, durationMs = 3200): () => void {
  return showToast(message, 'check_circle', durationMs);
}

export function showErrorToast(message: string, durationMs = 5000): () => void {
  return showToast(message, 'error', durationMs, 'danger');
}

/**
 * A failure the person should notice without it covering what they are doing
 * (the call's stage on a phone): a titled alert toast, optionally with the
 * one action that fixes it.
 */
export function showErrorNotice(
  notice: { title: string; message: string; action?: ToastAction },
  durationMs = 10000,
): () => void {
  return showToast(notice.message, 'error', durationMs, 'danger', { title: notice.title, action: notice.action });
}
