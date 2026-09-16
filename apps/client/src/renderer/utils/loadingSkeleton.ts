import { t } from '../i18n';
import { escapeHtml } from './html';

export function renderLoadingSkeleton(layout: 'lines' | 'cards' = 'lines', count = 3): string {
  const item = layout === 'cards'
    ? '<div class="loading-skeleton-card"><span class="skeleton loading-skeleton-thumbnail"></span><span class="skeleton loading-skeleton-line"></span></div>'
    : '<span class="skeleton loading-skeleton-line"></span>';
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
