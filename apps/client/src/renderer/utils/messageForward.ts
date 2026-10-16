import type { MessageForward } from '@monky/shared';
import { t } from '../i18n';
import { escapeHtml } from './html';

/** The "Forwarded" line above a forwarded message: where it came from and when, never who wrote it. */
export function renderForwardedBadge(forwarded: MessageForward, formatTime: (value: number) => string): string {
  const label = forwarded.source ? t('chat.forwardedFrom', { source: forwarded.source }) : t('chat.forwarded');
  const time = forwarded.createdAt !== null
    ? `<time class="chat-forwarded-time">${escapeHtml(formatTime(forwarded.createdAt))}</time>` : '';
  return `<div class="chat-forwarded">
    <span class="material-symbols-outlined md-14" aria-hidden="true">forward</span>
    <span>${escapeHtml(label)}</span>${time}
  </div>`;
}

/** `2026-10-16` for archive names, which cannot hold the slashes of a locale date. */
export function archiveDate(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
