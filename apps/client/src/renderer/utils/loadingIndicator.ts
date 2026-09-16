import { escapeHtml } from './html';

export function renderLoadingIndicator(message: string): string {
  return `<span class="bot-loading-indicator"><span class="reconnect-spinner bot-loading-spinner" aria-hidden="true"></span><span>${escapeHtml(message)}</span></span>`;
}
