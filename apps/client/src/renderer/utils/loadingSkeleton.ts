import { t } from '../i18n';
import { escapeHtml } from './html';

const SKELETON_ITEMS = {
  lines: '<span class="skeleton loading-skeleton-line"></span>',
  cards: '<div class="loading-skeleton-card"><span class="skeleton loading-skeleton-thumbnail"></span><span class="skeleton loading-skeleton-line"></span></div>',
  // Avatar, name and text, shaped like a chat row so the feed does not jump when history lands.
  messages: '<div class="loading-skeleton-message"><span class="skeleton loading-skeleton-avatar"></span>'
    + '<span class="loading-skeleton-message-body"><span class="skeleton loading-skeleton-name"></span>'
    + '<span class="skeleton loading-skeleton-text"></span><span class="skeleton loading-skeleton-text"></span></span></div>',
} as const;

export function renderLoadingSkeleton(layout: keyof typeof SKELETON_ITEMS = 'lines', count = 3): string {
  const item = SKELETON_ITEMS[layout];
  return `
    <div class="loading-skeleton loading-skeleton--${layout}" role="status" aria-label="${escapeHtml(t('common.loading'))}">
      <div class="loading-skeleton-content" aria-hidden="true">${item.repeat(count)}</div>
    </div>
  `;
}

export function renderLoadingError(message: string): string {
  return `
    <div class="loading-error" role="alert">
      <p>${escapeHtml(message)}</p>
      <button type="button" class="btn btn-secondary" data-loading-retry>${t('common.retry')}</button>
    </div>
  `;
}
