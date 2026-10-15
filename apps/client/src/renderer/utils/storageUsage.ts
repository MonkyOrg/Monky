import type { BotStorageUsage } from '@monky/shared';
import { t } from '../i18n';
import { formatBytes } from './attachment';
import { escapeHtml } from './html';

/** Usage bar shared by the bot storage views, in the style of the server storage tab. */
export function storageUsageHtml(usage: BotStorageUsage, describedBy?: string): string {
  const percent = usage.maxBytes > 0 ? Math.max(0, Math.min(100, Math.round(usage.usedBytes / usage.maxBytes * 100))) : 0;
  const hint = usage.level === 'full' ? t('botStorage.full') : usage.level === 'near_full' ? t('botStorage.nearFull') : '';
  return `<div class="storage-usage" data-level="${usage.level}">
    <div class="storage-usage-labels">
      <span>${escapeHtml(t('botStorage.used', { used: formatBytes(usage.usedBytes), total: formatBytes(usage.maxBytes) }))}</span>
      <span class="storage-usage-percent">${percent}%</span>
    </div>
    <div class="storage-usage-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"
      aria-label="${escapeHtml(t('botStorage.used', { used: formatBytes(usage.usedBytes), total: formatBytes(usage.maxBytes) }))}"
      ${describedBy ? `aria-describedby="${escapeHtml(describedBy)}"` : ''}>
      <div class="storage-usage-fill" style="width: ${percent}%;"></div>
    </div>
    <div class="storage-usage-details">
      <span>${escapeHtml(t('botStorage.objects', { count: String(usage.objectCount), max: String(usage.maxObjects) }))}</span>
      ${hint ? `<span class="storage-usage-warning" role="status">${escapeHtml(hint)}</span>` : ''}
    </div>
  </div>`;
}
